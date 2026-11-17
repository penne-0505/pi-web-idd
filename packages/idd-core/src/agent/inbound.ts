
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { stateDir } from "../paths.ts";
import { readBacklog, readLifecycle, readSessions, unreadableColumnOf } from "../ledger/read.ts";
import { appendLifecycle, recordAskedBatch } from "../ledger/write.ts";
import { routeOnAsk } from "./question-routing.ts";
import { planReviewInputs } from "../plan/plan-review.ts";
import { appendWorkRow, evidenceWarning, normalizeReportedItems, readWorkRows, workColumnPath, type ReportedItem } from "../plan/work-records.ts";
import { disposalProblem, findingsForPaths, foldPlaceFindings, recordFindingDisposals, type PlaceFinding } from "../plan/place-findings.ts";
import { normalizeIntentImpact, normalizePlanRecords, checkPlanRecords, planRecordsImpactRows, type PlanRecordsInput } from "./intent-impact.ts";
import { normalizeQuestions } from "./questions.ts";
import { GRANULARITY_RECORDED_EVENT, normalizeGranularity, granularityProposalOf, granularityWaiting } from "../plan/granularity.ts";
import { granularityStageOn } from "../config/pipeline.ts";
import { normalizeRiskTable, riskTableTouches } from "./risk-table.ts";
import { readAreas } from "../config/areas.ts";
import { deriveStage } from "../ledger/derive.ts";
import { isExecutorWork } from "../plan/watch.ts";
import { DEPTH_RANK, depthFloor, normalizeDepthFields, pathsMatchRisk, shallowRefusal } from "../plan/depth.ts";
import { laneRecordShape, RECORDS_SHAPE_STATE } from "../plan/record-shape.ts";
import { resultFileAttrs, resultFiles } from "./measured-files.ts";

export type { AskedOption, AskedQuestion } from "./questions.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function laneExists(iddId: string): boolean {
  return readBacklog().some((rec) => rec.idd_id === iddId);
}

async function appendJsonl(file: string, record: unknown): Promise<void> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 40 } });
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } finally {
    await release();
  }
}

export async function agentAskQuestions(input: {
  iddId: string;
  batchId: string;
  questions: unknown;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!laneExists(input.iddId)) return { ok: false, error: `unknown lane: ${input.iddId}` };
  const parsed = normalizeQuestions(input.questions);
  if (!parsed.ok) return parsed;

  // a batch the mechanism may answer is handed to the judge and written, whole, when the judge is done; the planner's
  // report is answered now either way (DEC-1203). Anything else is on record before this returns.
  const batch = { idd_id: input.iddId, batch_id: input.batchId, asked_at: nowIso(), questions: parsed.questions.map((q) => ({ ...q, context: q.context ?? "" })) };
  try {
    if (await routeOnAsk(batch)) return { ok: true };
    await recordAskedBatch(batch);
  } catch (err) {
    // the questions' column cannot be read: whether the batch is on record is not known, and a second row is never taken back
    const column = unreadableColumnOf(err);
    if (!column) throw err;
    return { ok: false, error: `${column}を読めないので質問を受けられません。読めるようになってからもう一度送ってください` };
  }
  return { ok: true };
}

/**
 * The planner's granularity proposal: whether this lane stays one lane, becomes children, or merges into an
 * existing Issue. It is sent after the survey and before the request (C-127-1), so the record carries the plan's
 * own slicing. A split or a merge leaves the lane on a person's card; a "single" judgement only leaves its reason
 * (the ready copies it), and the planner goes on to write the request. A second proposal while one is unanswered is
 * refused: the card would otherwise change under the person reading it.
 *
 * The stage can be stopped (roles.yaml `pipeline.granularity`); a lane briefed before it was stopped still sends its
 * proposal, and refusing it would leave the planner to resend or wait for an answer nobody is asked for. So the
 * proposal is taken and kept under `GRANULARITY_RECORDED_EVENT` instead, and the answer says which side the stage was
 * on as the proposal arrived: the CLI reads that and tells the planner to go on with the request. The record, not the
 * setting at read time, decides from then on, so turning the stage back on does not make these old proposals wait on
 * a person.
 */
export async function agentGranularity(input: {
  iddId: string;
  proposal: unknown;
}): Promise<{ ok: true; stage: "on" | "off" } | { ok: false; error: string }> {
  if (!laneExists(input.iddId)) return { ok: false, error: `unknown lane: ${input.iddId}` };
  const events = readLifecycle().filter((e) => e.idd_id === input.iddId);
  if (granularityWaiting(events)) {
    return { ok: false, error: "粒度の分割・合流の案に、まだ人の答えがありません。答えを受けてから送り直してください" };
  }
  const parsed = normalizeGranularity(input.proposal);
  if (!parsed.ok) return parsed;
  const stageOn = granularityStageOn();
  await appendLifecycle(stageOn ? "s1_granularity_proposed" : GRANULARITY_RECORDED_EVENT, input.iddId, {
    kind: parsed.proposal.kind,
    reason: parsed.proposal.reason,
    ...(parsed.proposal.children ? { children: parsed.proposal.children } : {}),
    ...(parsed.proposal.mergeTarget ? { merge_target: parsed.proposal.mergeTarget } : {}),
  });
  return { ok: true, stage: stageOn ? "on" : "off" };
}

/** the planner's three plain lines on a ready: how things stand, what the lane does, what it makes better */
export interface ReadySummary {
  situation: string;
  action: string;
  outcome: string;
}

const SUMMARY_LINE_MAX = 200;

/** a line kept to the length in characters (not UTF-16 units, so none is split), marked when it was cut */
function cutLine(s: string): string {
  const chars = Array.from(s);
  return chars.length > SUMMARY_LINE_MAX ? `${chars.slice(0, SUMMARY_LINE_MAX - 1).join("")}…` : s;
}

/**
 * The three lines as the planner sent them (an object, or a list of three in that order), or undefined when
 * any is missing or empty. A ready without them is still a ready: the lines are an aid to penne, not a gate.
 */
export function readySummary(raw: unknown): ReadySummary | undefined {
  const lines = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? [(raw as Record<string, unknown>).situation, (raw as Record<string, unknown>).action, (raw as Record<string, unknown>).outcome]
      : [];
  if (lines.length !== 3) return undefined;
  const text = lines.map((l) => (typeof l === "string" ? cutLine(l.replace(/\s+/g, " ").trim()) : ""));
  if (text.some((t) => !t)) return undefined;
  return { situation: text[0], action: text[1], outcome: text[2] };
}

/** the three lines of the lane's last ready; none when that ready came without them (they could be stale) */
export function readySummaryOf(events: { event: string; attrs?: Record<string, unknown> }[]): ReadySummary | undefined {
  const last = [...events].reverse().find((e) => e.event === "s1_ready");
  return last ? readySummary(last.attrs?.summary) : undefined;
}

/**
 * The `risk:` of the lane's qa, read from the worktree its planner ran in (the executor's copy can be gone on a
 * redo, which would keep refusing a report against a qa nobody can see). Null when there is no worktree or qa.
 */
function qaRiskOf(iddId: string): string | null {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  if (!rec) return null;
  const sessions = readSessions("planner").filter((s) => s.idd_id === iddId);
  const fallback = readSessions("executor").filter((s) => s.idd_id === iddId);
  // the planner's worktree comes first: a redo can leave an older executor session pointing at a qa nobody can see
  const worktree = sessions.at(-1)?.worktree_path ?? fallback.at(-1)?.worktree_path;
  if (!worktree) return null;
  try {
    const qa = join(worktree, planReviewInputs(rec)[1]);
    if (!existsSync(qa)) return null;
    const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(qa, "utf8"))?.[1] ?? "";
    return /^risk:\s*["']?([A-Za-z]+)/m.exec(front)?.[1] ?? null;
  } catch {
    return null;
  }
}

const HIGH_RISK = new Set(["High", "Critical"]);

/** the worktree the lane's planner wrote in, where its records and the repo's are read */
function plannerWorktree(iddId: string): string | undefined {
  const sessions = readSessions("planner").filter((s) => s.idd_id === iddId);
  return sessions.at(-1)?.worktree_path ?? readSessions("executor").filter((s) => s.idd_id === iddId).at(-1)?.worktree_path;
}

/** the decision document of this lane, which its own report must not count as an existing DEC */
function ownDecisionDoc(iddId: string): string | undefined {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  return rec ? planReviewInputs(rec)[0] : undefined;
}

/** the refusal when a path the plan touches holds an open finding the report did not dispose of */
function findingsRefusal(open: PlaceFinding[]): string {
  const list = open.map((f) => `- ${f.id} ${f.lines ? `${f.path}:${f.lines[0]}${f.lines[1] !== f.lines[0] ? `-${f.lines[1]}` : ""}` : f.path}: ${f.claim}`).join("\n");
  return [
    "触る見込みのファイルに open な指摘がありますが、処置（fix / drop）がありません:",
    list,
    '計画の報告に findings を足してください: {"findings":[{"id":"F-098-1","action":"fix"},{"id":"F-098-2","action":"drop","reason":"..."}]}。',
    "引き直すには `idd work findings <path>...`。",
  ].join("\n");
}

export async function agentReady(input: {
  iddId: string;
  plannerSessionId?: string;
  decCount: number;
  invCount: number;
  qaCount: number;
  referenceCount: number;
  size?: unknown;
  harm?: unknown;
  depth?: unknown;
  summary?: unknown;
  riskTable?: unknown;
  intentImpact?: unknown;
  findings?: unknown;
  /** the "1本" reason; required once the lane has a granularity proposal (the brief asks every lane for one) */
  granularityReason?: unknown;
}): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
  if (!laneExists(input.iddId)) return { ok: false, error: `unknown lane: ${input.iddId}` };
  const summary = readySummary(input.summary);
  // the depth's three fields are required, and the engine raises a declaration that is shallower than what it reads
  const depthFields = normalizeDepthFields({ size: input.size, harm: input.harm, depth: input.depth });
  if ("error" in depthFields) return { ok: false, error: depthFields.error };
  // the table is required: it is what tells a hard-to-undo change from a hard one (DEC-2566)
  const table = normalizeRiskTable(input.riskTable);
  if ("error" in table) return { ok: false, error: table.error };
  // the impact on existing intent is required too: an omitted field cannot be told from a planner that read
  // nothing, and an empty list is an assertion that can be wrong (DEC-2803). The shape of that report follows the
  // lane's record shape: a v1 lane sends DECs, a v2 lane sends Choice drafts and disposals.
  const laneEvents = readLifecycle().filter((e) => e.idd_id === input.iddId);
  const shape = laneRecordShape(input.iddId, laneEvents);
  // the lane's granularity judgement: a person's answer still owed stops the request, and a lane that made a
  // proposal must say why it settled on one lane. A lane from a brief older than this rule made no proposal, and
  // is left alone (its brief has no field for the reason).
  const granularity = granularityProposalOf(laneEvents);
  if (granularity && granularityWaiting(laneEvents)) {
    return { ok: false, error: "粒度の分割・合流の案に、まだ人の答えがありません。答えを受けてから計画の報告を送ってください" };
  }
  const askedReason = typeof input.granularityReason === "string" ? input.granularityReason.trim() : "";
  const granularityReason = granularity ? (askedReason || (granularity.kind === "single" ? granularity.reason : "")) : "";
  if (granularity && !granularityReason) {
    return { ok: false, error: "「1本」の理由を 1 文で送ってください（`idd report plan --granularity-reason \"...\"`）。分けずに 1 本とした理由が、後から切り方の見立てを確かめる材料になります" };
  }
  const worktree = plannerWorktree(input.iddId);
  const ownDoc = ownDecisionDoc(input.iddId);
  let paths: string[];
  let intentImpact: Record<string, unknown>;
  let planRecords: PlanRecordsInput | undefined;
  if (shape === "state") {
    const repo = repoOfLane(input.iddId);
    const normalized = normalizePlanRecords(input.intentImpact);
    if ("error" in normalized) return { ok: false, error: normalized.error };
    if (!repo) return { ok: false, error: "lane の repo を引けないので、意図の記録を確かめられません" };
    const checked = checkPlanRecords({ lane: input.iddId, repo, ...normalized.report });
    if ("error" in checked) return { ok: false, error: checked.error };
    paths = checked.report.paths;
    intentImpact = { paths: checked.report.paths, candidate_count: checked.report.candidate_count, rows: planRecordsImpactRows(checked.report.existing) };
    planRecords = { paths: checked.report.paths, choices: checked.report.choices, existing: checked.report.existing };
  } else {
    const impact = normalizeIntentImpact(input.intentImpact, {
      ...(worktree ? { source: { root: worktree }, root: worktree } : {}),
      ...(ownDoc ? { excludeDocs: [ownDoc] } : {}),
    });
    if ("error" in impact) return { ok: false, error: impact.error };
    paths = impact.report.paths;
    intentImpact = impact.report as unknown as Record<string, unknown>;
  }
  // the open place findings of the paths this plan touches must each be disposed of; an id that is not open is ignored,
  // and a drop with no reason or an unknown action is refused
  const disposals = disposalProblem(input.findings);
  if ("error" in disposals) return { ok: false, error: disposals.error };
  const repo = repoOfLane(input.iddId);
  if (repo) {
    const rows = readWorkRows(workColumnPath(repo));
    const events = readLifecycle();
    const open = findingsForPaths({ rows, events, paths, viewLane: input.iddId });
    const disposed = new Set(disposals.value.map((d) => d.id));
    const missing = open.filter((f) => !disposed.has(f.id));
    if (missing.length) return { ok: false, error: findingsRefusal(missing) };
    // an id this plan was handed can be disposed of: the open findings of its paths, and the findings the same
    // lane dropped earlier, so a lane that changed its mind can send a fix and reopen one. An id no lane handed
    // this plan is ignored.
    const known = new Set(open.map((f) => f.id));
    for (const f of foldPlaceFindings(rows, events, input.iddId)) {
      if (f.status === "dropped" && f.disposedBy === input.iddId) known.add(f.id);
    }
    const effective = disposals.value.filter((d) => known.has(d.id));
    if (effective.length) {
      const recorded = await recordFindingDisposals({ repo, lane: input.iddId, disposals: effective });
      if (!recorded.ok) return { ok: false, error: `指摘の処置を記録できませんでした: ${recorded.error}` };
    }
  }
  // a lane that touches a kind of harm must come with a High or Critical qa, read with the record check's exact values
  if (riskTableTouches(table.table)) {
    const risk = qaRiskOf(input.iddId);
    if (!risk) return { ok: false, error: "該当表に「触れる」がありますが、qa の risk: を読めません。qa.md の frontmatter に risk: High（または Critical）を書いてください" };
    if (!HIGH_RISK.has(risk)) return { ok: false, error: `該当表に「触れる」がありますが、qa の risk: は ${risk} です。risk: High 以上（High / Critical）に直して送り直してください` };
  }
  // the floor: what the engine can read about this change. A shallower declaration is refused; a deeper one stands
  const declaredRisk = (() => { try { return readAreas().riskPaths?.[repoOfLane(input.iddId) ?? ""]; } catch { return undefined; } })();
  const risk = qaRiskOf(input.iddId);
  const floor = depthFloor({
    size: depthFields.size,
    harm: depthFields.harm,
    touchesTable: riskTableTouches(table.table),
    riskHigh: !!risk && HIGH_RISK.has(risk),
    matchedPaths: pathsMatchRisk(paths, declaredRisk),
  });
  if ((DEPTH_RANK[depthFields.depth] ?? 0) < DEPTH_RANK[floor]) return { ok: false, error: shallowRefusal(depthFields.depth, floor) };
  // lines that came malformed are dropped, but not silently: the record keeps a mark and the planner is told
  const dropped = !summary && input.summary !== undefined && input.summary !== null;
  await appendLifecycle("s1_ready", input.iddId, {
    planner_session_id: input.plannerSessionId,
    dec_count: input.decCount,
    inv_count: input.invCount,
    qa_count: input.qaCount,
    reference_count: input.referenceCount,
    size: depthFields.size,
    harm: depthFields.harm,
    depth: depthFields.depth,
    risk_table: table.table,
    intent_impact: intentImpact,
    ...(granularityReason ? { granularity_reason: granularityReason, granularity_kind: granularity?.kind } : {}),
    ...(planRecords ? { records_shape: RECORDS_SHAPE_STATE, plan_records: { choices: planRecords.choices, existing: planRecords.existing } } : {}),
    ...(summary ? { summary } : {}),
    ...(dropped ? { summary_dropped: true } : {}),
  });
  return dropped
    ? { ok: true, warning: 'summary は {"situation","action","outcome"} の 3 行がそろっていないので捨てました。ready は受け付けています。3 行をそろえて `idd report plan` を呼び直してください' }
    : { ok: true };
}

/** the backlog key of a lane's repo, where its work column lives */
function repoOfLane(iddId: string): string | undefined {
  return readBacklog().find((r) => r.idd_id === iddId)?.area;
}

/**
 * Append a report's AC states to the repo's work column. A failure here is not a failure of the report: the
 * lane goes on, and the warning is the report's own answer (the report itself is never refused for it).
 */
async function recordAcReported(iddId: string, source: "progress" | "result", items: ReportedItem[]): Promise<string | undefined> {
  if (!items.length) return undefined;
  const repo = repoOfLane(iddId);
  if (!repo) return undefined;
  try {
    await appendWorkRow(repo, { event: "ac_reported", lane: iddId, source, items });
  } catch (err) {
    return `AC の状態を記録できませんでした（lane は進みます）: ${String((err as Error).message ?? err).slice(0, 200)}`;
  }
  return undefined;
}

export async function agentProgress(input: {
  iddId: string;
  currentStep: string;
  qaStatus: { qa_id: string; status: string; verified_at?: string; evidence?: string }[];
  recentActivity: string[];
}): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
  if (!laneExists(input.iddId)) return { ok: false, error: `unknown lane: ${input.iddId}` };
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `executor-progress-${input.iddId}.json`), JSON.stringify({
    idd_id: input.iddId,
    updated_at: nowIso(),
    current_step: input.currentStep,
    qa_status: input.qaStatus,
    recent_activity: input.recentActivity.slice(-10),
  }, null, 2), "utf8");
  const { items, dropped } = normalizeReportedItems(input.qaStatus.map((q) => ({ id: q.qa_id, status: q.status, ...(q.evidence ? { evidence: q.evidence } : {}) })));
  const writeWarning = await recordAcReported(input.iddId, "progress", items);
  const warning = evidenceWarning(dropped) ?? writeWarning;
  return { ok: true, ...(warning ? { warning } : {}) };
}

export async function agentResult(input: {
  iddId: string;
  outcome: "success" | "partial" | "failed";
  changedFiles: string[];
  commitCount: number;
  qaVerified: string[];
  qaUnverified: string[];
  qaEvidence?: Record<string, string>;
  sideFindings?: string[];
}): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
  if (!laneExists(input.iddId)) return { ok: false, error: `unknown lane: ${input.iddId}` };
  const rawEvidence = input.qaEvidence && typeof input.qaEvidence === "object" ? input.qaEvidence : {};
  const evidence: Record<string, string> = {};
  for (const [id, value] of Object.entries(rawEvidence)) {
    if (typeof value === "string" && value.trim()) evidence[id] = value.trim();
  }
  const reported = [
    ...input.qaVerified.map((id) => ({ id, status: "verified", ...(evidence[id] ? { evidence: evidence[id] } : {}) })),
    ...input.qaUnverified.map((id) => ({ id, status: "planned" })),
  ];
  const { items, dropped } = normalizeReportedItems(reported);
  const writeWarning = await recordAcReported(input.iddId, "result", items);
  // the list is the harness's, measured from the lane's fork point; the executor's own stands in only when it cannot be
  // measured, and the same row says which one it is (a mainline the executor merged in is not the lane's change)
  const files = resultFiles(input.iddId, input.changedFiles);
  await appendLifecycle("s2_result", input.iddId, {
    outcome: input.outcome,
    ...resultFileAttrs(files),
    commit_count: input.commitCount,
    qa_verified: input.qaVerified,
    qa_unverified: input.qaUnverified,
    ...(Object.keys(evidence).length ? { qa_evidence: evidence } : {}),
    side_findings: input.sideFindings ?? [],
  });
  const warning = evidenceWarning(dropped) ?? writeWarning;
  return { ok: true, ...(warning ? { warning } : {}) };
}

/** what a lane's agent asked the harness to take in hand at the boundary: one line per hold, read by the status door */
export interface HoldRecord {
  id: string;
  idd_id: string;
  kind: "push" | "pr-create";
  at: string;
  /** a PR's title and body, when the agent gave them */
  title?: string;
  body?: string;
}

export const HOLDS_FILE = "boundary-holds.jsonl";

/** the holds on record for one lane, oldest first; a line that cannot be read is skipped */
export function readHolds(iddId: string): HoldRecord[] {
  const path = join(stateDir(), HOLDS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const rec = JSON.parse(line) as HoldRecord;
      return rec.idd_id === iddId ? [rec] : [];
    } catch { return []; }
  });
}

/**
 * The PR text the lane's agent handed over last, or null. The drafting stage asks for it in place of a writer: that
 * stage runs once the submit card is due, after the submit has started, and a draft recorded earlier would be read as
 * the draft of a submit that is already over (`prDraftOf` takes only a draft written after the last start).
 * A hold is the text of one submit: once a draft has been recorded after it, that draft was the answer to it, and a
 * later submit (the lane's PR closed, the work sent again) is drafted by the writer unless the agent held a new text.
 */
export function heldPrText(iddId: string): { title: string; body: string } | null {
  const held = readHolds(iddId).filter((h) => h.kind === "pr-create" && h.title).pop();
  if (!held?.title) return null;
  // the lifecycle writes whole seconds and a hold is stamped to the millisecond: compared in whole seconds, a hold
  // that shares a second with a draft counts as answered by it, which is the side that never reuses an old text
  const heldAt = Math.floor(Date.parse(held.at) / 1000) * 1000;
  const answered = readLifecycle().some((e) => e.idd_id === iddId && e.event === "s4_pr_drafted" && Date.parse(e.at) >= heldAt);
  return answered ? null : { title: held.title, body: held.body ?? "" };
}

/**
 * Take a lane's push or PR creation in hand. Nothing leaves the machine. A push is the executor's report: the lane
 * goes on to review and the submit card the way it does after `idd report result`, and only when no result is owed
 * yet is one written, so a second hold does not start a second round. A PR's title and body are kept for the drafting
 * stage (`heldPrText`). Refused for a lane that has not begun its implementation or has ended: there is no submit
 * to hand the work to.
 */
export async function agentHold(input: {
  iddId: string;
  kind: "push" | "pr-create";
  title?: string;
  body?: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const rec = readBacklog().find((r) => r.idd_id === input.iddId);
  if (!rec) return { ok: false, error: `unknown lane: ${input.iddId}` };
  const events = readLifecycle().filter((e) => e.idd_id === input.iddId);
  const names = events.map((e) => e.event);
  if (!names.includes("s2_start")) return { ok: false, error: "この lane はまだ実装の段に入っていません" };
  if (deriveStage(events).group === "closed") return { ok: false, error: "この lane は終わっています" };
  const title = input.kind === "pr-create" ? input.title?.trim() : undefined;
  const resultOwed = Math.max(-1, ...events.flatMap((e, i) => (isExecutorWork(e) ? [i] : []))) > names.lastIndexOf("s2_result");
  if (resultOwed) {
    const reported = await agentResult({ iddId: input.iddId, outcome: "success", changedFiles: [], commitCount: 0, qaVerified: [], qaUnverified: [], sideFindings: [] });
    if (!reported.ok) return reported;
  }
  const at = nowIso();
  const hold: HoldRecord = {
    id: `HOLD-${at.replace(/[-:]/g, "").replace(/\..+$/, "")}-${Math.random().toString(16).slice(2, 6)}`,
    idd_id: input.iddId,
    kind: input.kind,
    at,
    ...(title ? { title, body: input.body ?? "" } : {}),
  };
  await appendJsonl(HOLDS_FILE, hold);
  return { ok: true, id: hold.id };
}
