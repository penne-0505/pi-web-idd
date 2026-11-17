
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { QUESTIONS_JSON_SHAPE, REPORT_QUESTIONS_USAGE } from "../agent/questions.ts";
import { CLI_NAME, CLOSING_LINE, callbackSection, esc, renderMessage, rules, section } from "../agent/message.ts";
import { solvingStandardNote } from "../rules/rules.ts";
import { instructionsSection } from "../instruction/brief.ts";
import { recordInjection } from "../instruction/ledger.ts";
import { pickForStage, repoOfArea, type Picked } from "../instruction/store.ts";
import { getAgentRunner, type AgentRunner, type QuotaFallback, type SpawnResult } from "../agent/port.ts";
import { areaBriefChecks, incrementsOf, readAreas } from "../config/areas.ts";
import { pipelineConcurrency } from "../config/pipeline.ts";
import { stagePick } from "../ledger/pick.ts";
import { returnsToPlan } from "../ledger/replan-view.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { inStartOrder } from "../ledger/start-order.ts";
import { fallbackAttrs, quotaWaitOf, recordQuotaWait } from "./quota-wait.ts";
import { projectBriefFor } from "./project-brief.ts";
import { EXECUTOR_CONTEXT_RULE, EXECUTOR_HOST_RULES, EXECUTOR_SKILL_RULES, EXECUTOR_WRITING_RULES, EXECUTOR_WRITING_RULES_V2, checksSection, execLaneIdExplanation, incrementsSection, structureSection, execLaneIdExplanationV2, laneNormBullets, normsLines, purposeSection, questionRules, recordsRules, recordsRulesV2, type BriefCheck, type BriefRun } from "./prompt-text.ts";
import { laneContextDoc, lanePlanDoc } from "./plan-doc.ts";
import { followupTaskId } from "./followups.ts";
import { overlapSection, overlapsForLane } from "./overlap.ts";
import { transition, withdrawJsonl, appendLifecycle } from "../ledger/write.ts";
import { transitionRefusal } from "../ledger/allowed.ts";
import { areaSegment, slugOf } from "../intent/parse.ts";
import { laneIntent, type LaneChoice } from "./lane-intent.ts";
import { commitPlannerRecords } from "./lane-records.ts";
import { readyPlanRecordsOf } from "../agent/intent-impact.ts";
import { writePlanRecords, foldRows, intentColumnPath, laneStates, readRows } from "../intent/store.ts";
import { stateDir } from "../paths.ts";
import type { BacklogRecord, LifecycleRecord, SessionRecord } from "../schema/records.ts";
import type { LaneWorktree } from "../worktree/ensure.ts";
import { ensureWorktreeStep } from "../worktree/prepare.ts";
import { driveStartSteps, skippedOf, startRunning } from "./start-step.ts";

/** config/roles.yaml pipeline.executor.concurrency (engine-owned cap, DEC-671); 1 when undeclared */
export function executorConcurrency(): number {
  return pipelineConcurrency("executor");
}

/**
 * The executor sessions that belong to the lane's present implementation. A lane sent back to its plan (the card's
 * "計画から考え直す", or "方針へ戻す" at the review) keeps its earlier sessions in the file, as history; they began before the last replan and neither
 * stand for a started executor nor hold a slot, so the new GO can start a new one. A lane never sent back keeps every row.
 */
export function currentExecutorSessions(events: readonly LifecycleRecord[]): SessionRecord[] {
  const replanAt = new Map<string, string>();
  for (const e of events) if (returnsToPlan(e)) replanAt.set(e.idd_id, e.at);
  return readSessions("executor").filter((r) => {
    const at = replanAt.get(r.idd_id);
    if (!at) return true;
    // times carry their own offset (`+09:00` against `Z`): compare the instants, not the strings. A time that does not
    // parse leaves the row in, so the mistake can only be keeping an old row, never dropping the new session.
    const began = Date.parse(r.started_at);
    const replanned = Date.parse(at);
    return Number.isNaN(began) || Number.isNaN(replanned) || began > replanned;
  });
}

export function lanesAwaitingExec(): BacklogRecord[] {
  const events = readLifecycle();
  const byLane = new Map<string, typeof events>();
  for (const e of events) {
    const list = byLane.get(e.idd_id) ?? [];
    list.push(e);
    byLane.set(e.idd_id, list);
  }
  const started = new Set(currentExecutorSessions(events).map((r) => r.idd_id));

  return inStartOrder(readBacklog()
    .filter((rec) => {
      const laneEvents = byLane.get(rec.idd_id) ?? [];
      // the stage asks its own question, at the moment it asks it (C-199-2)
      return stagePick("exec", laneEvents, { hasSession: started.has(rec.idd_id) }).pick;
    }));
}

export function runningExecutors(): number {
  // a session spawned to carry a fix is not a lane's implementation slot: it does not hold one of the capacity
  return startRunning("executor", currentExecutorSessions(readLifecycle()).map((rec) => ({ idd_id: rec.idd_id, ...(rec.kind ? { kind: rec.kind } : {}) })));
}

function sessionsPath(): string {
  return join(stateDir(), "executor-sessions.jsonl");
}

export async function recordSession(rec: {
  iddId: string;
  sessionId: string;
  worktree: string;
  branch: string;
  model?: string;
  harness?: string;
  /** the session carries a fix of the PR's feedback or a send-back, not the lane's implementation */
  kind?: "fix";
  /** the slot's role was refused for Claude's windows and the session runs its fallback */
  fallbacks?: QuotaFallback[];
}): Promise<void> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = sessionsPath();
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 40 } });
  try {
    appendFileSync(path, `${JSON.stringify({
      idd_id: rec.iddId,
      executor_session_id: rec.sessionId,
      started_at: new Date().toISOString(),
      worktree_path: rec.worktree,
      branch: rec.branch,
      ...(rec.kind ? { kind: rec.kind } : {}),
      model: rec.model,
      ...(rec.harness ? { harness: rec.harness } : {}),
      ...fallbackAttrs(rec.fallbacks),
    })}\n`, "utf8");
  } finally {
    await release();
  }
}

/** what the previous session already did, told to a fix session that starts without its conversation */
export interface PrevResult { changed: string[]; commits: number; verified: string[]; unverified: string[]; sideFindings: string[]; evidence?: Record<string, string> }

/** the parts a fix brief gets instead of the initial task: the stage's task and the instruction it answers */
export interface FixBriefParts { task: string[]; instruction: string; prev?: PrevResult; /** the one-off plan run's advice, attached as its own section (DEC-121-3) */ plan?: string }

/** the previous result of the lane's last session, as the brief tells it; undefined when no result is on record */
export function prevResultOf(iddId: string): PrevResult | undefined {
  const ev = readLifecycle().filter((e) => e.idd_id === iddId && e.event === "s2_result").pop();
  if (!ev) return undefined;
  const a = ev.attrs ?? {};
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const evidence = a.qa_evidence && typeof a.qa_evidence === "object" ? (a.qa_evidence as Record<string, unknown>) : {};
  const kept: Record<string, string> = {};
  for (const [id, value] of Object.entries(evidence)) if (typeof value === "string" && value.trim()) kept[id] = value.trim();
  return { changed: arr(a.changed_files), commits: Number(a.commit_count ?? 0) || 0, verified: arr(a.qa_verified), unverified: arr(a.qa_unverified), sideFindings: arr(a.side_findings), ...(Object.keys(kept).length ? { evidence: kept } : {}) };
}

/**
 * The lane's Purposes, once each, for the Purposes its own Choices name. The statements and the statuses come from
 * the intent column folded for this lane — the same reading that gives the Choices their own fields. `laneIntent`
 * hands the Choices over but not the Purpose's status, and that file is left alone (C-159-1).
 */
export function lanePurposes(rec: BacklogRecord, choices: LaneChoice[]): { id: string; statement: string; status: string }[] {
  const ids = [...new Set(choices.map((c) => c.purpose).filter((p): p is string => Boolean(p)))];
  if (!ids.length) return [];
  const events = readLifecycle().filter((e) => e.idd_id === rec.idd_id);
  const folded = foldRows(readRows(intentColumnPath(rec.area)), rec.idd_id, laneStates(events));
  const byId = new Map(folded.purposes.map((p) => [p.id, p]));
  return ids.flatMap((id) => {
    const p = byId.get(id);
    return p ? [{ id, statement: p.statement, status: p.status }] : [];
  });
}

function prevResultSection(p: PrevResult): string {
  return [
    "  <previous-result>",
    `    <changed-files>${esc(p.changed.join(", "))}</changed-files>`,
    `    <commits>${esc(String(p.commits))}</commits>`,
    ...(p.verified.length ? [`    <verified>${esc(p.verified.join(", "))}</verified>`] : []),
    ...(p.unverified.length ? [`    <unverified>${esc(p.unverified.join(", "))}</unverified>`] : []),
    ...(p.evidence && Object.keys(p.evidence).length
      ? [`    <evidence>${esc(Object.entries(p.evidence).map(([id, text]) => `${id}: ${text}`).join(" / "))}</evidence>`]
      : []),
    ...(p.sideFindings.length ? [`    <side-findings>${esc(p.sideFindings.join(" / "))}</side-findings>`] : []),
    "  </previous-result>",
  ].join("\n");
}

/**
 * The plan the delivery's one-off run wrote, with how the implementer treats it: the plan is advice and the record
 * of what was decided, never the contract. The body is escaped line by line: it is the run's own text, and an `&`
 * or `<` in it must not break the brief's XML.
 */
function fixPlanSection(plan: string): string {
  return [
    "  <fix-plan>",
    ...plan.split("\n").map((l) => `    ${esc(l)}`),
    "  </fix-plan>",
    "  <fix-plan-guidance>",
    `    案に従う。外れるときは、理由を \`${CLI_NAME} report result\` の side_findings に書く。`,
    "    案と人の文（instruction・user-note）が食い違えば、人の文に従う。",
    "  </fix-plan-guidance>",
  ].join("\n");
}

/** the principle is named by number only: its body is `_docs/standards/solving.md`, opened from the tree; only where the record goes, and how it is reported, is told here */
function executorSolvingRule(v2: boolean, worktree: string): string {
  // a tree without the standard (an adopted repo keeps none) is told where the package's original is; the principles stay in solving.md
  const place = solvingStandardNote(worktree);
  return "    課題の解き方は `_docs/standards/solving.md` に従う。適用する規則は R1・R3・R9・R11、根拠は P1・P4・P5・P7 である。"
    + "範囲を広げたときは、広げた場所と理由を結果の side_findings に書く（R11）。"
    + (v2
      ? `旧い形を残すなら、応急処置の Choice に記録し、その revisit が指す後続の Issue の案を \`${CLI_NAME} out draft --kind gh-issue\` で起こす（R9）。投稿は人だけが行う。起こした案は結果の side_findings に書く。`
      : `旧い形を残すなら、この lane の記録は decision.md の形で新しい DEC も Choice も取らないので、後続の Issue の案を \`${CLI_NAME} out draft --kind gh-issue\` で起こし、その本文に R9 の記録を書く。投稿は人だけが行う。場所に付いた指摘を後続の Issue の代わりにせず、起こした案は結果の side_findings に書く。`)
    + "完了の報告は R5 に従い、AC と evidence で示す（`work.md`）。"
    + (place ?? "");
}

export function executorBrief(rec: BacklogRecord, worktree: string, extra: { fix?: FixBriefParts; run?: BriefRun; instructions?: readonly Picked[] } = {}): string {
  const area = readAreas().areas[rec.area];
  // the instructions of the implement scene for this repo; a delivery passes the list it records, a preview reads them itself
  const instruction = instructionsSection(extra.instructions ?? pickForStage(extra.fix ? "fix" : "exec", repoOfArea(rec.area)));
  const seg = areaSegment(rec.area);
  const slug = slugOf(rec);
  const intent = laneIntent(rec, { root: worktree });
  const v2 = intent.shape === "state";
  // the number every identifier this lane writes takes as its prefix, taken from the lane's own id
  const laneNumber = /^IDD-(\d+)$/.exec(rec.idd_id)?.[1] ?? rec.idd_id;
  // only a Claude Code run that holds the cache 5 minutes needs its long checks wrapped; a pi or 1-hour run does not
  const wrappedChecks = extra.run?.harness === "claude" && extra.run.cacheTtl === "5m" ? checksSection(areaBriefChecks(rec.area) as BriefCheck[]) : null;
  // the lane decides its shape from the plan's presence, not the repo's setting: a lane keeps the shape it was planned under (DEC-2647)
  const plan = lanePlanDoc(rec, worktree);
  // the facts the plan's 重要なコンテクスト section points at: the one document every session appends to, so a fix
  // session that starts without the first session's conversation still reads what that session learned (C-196-3)
  const contextDoc = laneContextDoc(rec, worktree);
  // the counts the landing compares against the mainline (C-184-1): told with the mainline the lane lands on, so the
  // executor compares them itself before it reports instead of learning the increase from a send-back
  const mainline = area?.work_base ?? area?.public_base ?? "main";
  const setup = readAreas().checkPrep?.[rec.area]?.setup ?? [];
  const increments = incrementsSection(incrementsOf(rec.area), mainline, setup);
  // the structure counts the landing compares the same way, told when the worktree holds a declaration: the executor
  // counts them in a mainline copy of its own (not prepared, as the landing's) before it reports, and learns which files a copy raised them in
  const structure = structureSection(worktree, mainline);
  // the TODO task the intake named, read the same way the follow-ups' write target is, so the executor deletes the task it also writes follow-ups to
  const sourceTodo = followupTaskId({ title: rec.title, context: rec.context ?? "" });
  // the open lanes that declared a place this lane declared: told, never waited on (no stage reads it)
  const overlaps = overlapsForLane(rec, readBacklog(), readLifecycle());
  const list = (rows: { id: string; text: string }[]) =>
    rows.map((r) => `      <item id="${esc(r.id)}">${esc(r.text)}</item>`).join("\n");
  // a v2 lane's Choices, as the contract's own `<choices>` (id, its Purpose's id, forms.chosen, why, anchored, free)
  const choiceList = (rows: LaneChoice[]) => rows.map((c) => [
    `      <choice id="${esc(c.id)}">`,
    ...(c.purpose ? [`        <purpose>${esc(c.purpose)}</purpose>`] : []),
    `        <chosen>${esc(c.text)}</chosen>`,
    `        <why>${esc(c.why)}</why>`,
    `        <anchored>${esc(c.anchored ?? "")}</anchored>`,
    ...(c.free ? [`        <free>${esc(c.free)}</free>`] : []),
    ...(c.revisit ? [`        <revisit>${esc(c.revisit)}</revisit>`] : []),
    `      </choice>`,
  ].join("\n")).join("\n");
  // the Purposes the lane's Choices name, once each, with the status the column folds; the Choice keeps the id (C-159-1)
  const purposes = v2 ? lanePurposes(rec, intent.decisions) : [];
  const purposeList = (rows: { id: string; statement: string; status: string }[]) =>
    rows.map((p) => `      <purpose id="${esc(p.id)}" status="${esc(p.status)}">${esc(p.statement)}</purpose>`).join("\n");
  // what the plan's write could not put in the column: the executor is told to dispose of it itself
  const planWritten = [...readLifecycle().filter((e) => e.idd_id === rec.idd_id)].reverse().find((e) => e.event === "s2_plan_written");
  const unwritten = v2 && Array.isArray(planWritten?.attrs?.skipped) ? (planWritten.attrs.skipped as { op?: unknown; reason?: unknown; draft?: unknown; existing?: unknown }[]) : [];
  const placeLine = (place: unknown): string => (Array.isArray(place) ? (place as { path?: unknown; kind?: unknown; file?: unknown }[]) : []).map((p) => `${String(p.path ?? "")}（${String(p.kind ?? "")}${p.file ? `, file: ${String(p.file)}` : ""}）`).join(", ");
  // an operation the plan could not write carries its own body: the executor makes the disposal or raises the draft itself
  const unwrittenLines = unwritten.flatMap((u) => {
    const op = esc(String(u.op ?? ""));
    const reason = esc(String(u.reason ?? ""));
    const draft = u.draft && typeof u.draft === "object" ? (u.draft as Record<string, unknown>) : undefined;
    const existing = u.existing && typeof u.existing === "object" ? (u.existing as Record<string, unknown>) : undefined;
    if (draft) {
      const forms = (draft.forms && typeof draft.forms === "object" ? draft.forms : {}) as { chosen?: unknown };
      return [
        `      <item op="${op}" reason="${reason}">`,
        `        <chosen>${esc(String(forms.chosen ?? ""))}</chosen>`,
        `        <purpose>${esc(String(draft.purpose ?? ""))}</purpose>`,
        `        <place>${esc(placeLine(draft.place))}</place>`,
        `        <why>${esc(String(draft.why ?? ""))}</why>`,
        `        <anchored>${esc(String(draft.anchored ?? ""))}</anchored>`,
        ...(typeof draft.free === "string" && draft.free ? [`        <free>${esc(draft.free)}</free>`] : []),
        ...(typeof draft.revisit === "string" && draft.revisit ? [`        <revisit>${esc(draft.revisit)}</revisit>`] : []),
        `        <how>${esc(`\`${CLI_NAME} intent raise choice --file\` で立て直すか、立てない理由を \`${CLI_NAME} report result\` の side_findings に書く。`)}</how>`,
        "      </item>",
      ];
    }
    if (existing) {
      return [
        `      <item op="${op}" reason="${reason}">`,
        `        <id>${esc(String(existing.id ?? ""))}</id>`,
        `        <effect>${esc(String(existing.effect ?? ""))}</effect>`,
        ...(typeof existing.grounds === "string" && existing.grounds ? [`        <grounds>${esc(existing.grounds)}</grounds>`] : []),
        `        <how>${esc("自分で確認・捨てる・Supersede のどれかにし直す。")}</how>`,
        "      </item>",
      ];
    }
    return [`      <item op="${op}">${reason}</item>`];
  });

  return renderMessage([
    section("norms", [
      "  <norms>",
      ...normsLines(`あなたはこの lane の"実装"を担う。`, [
        "作業ディレクトリは対象 repo の worktree で、この lane 専用である。段同士のbridgeはハーネスが行うため、あなたの管轄外である。",
      ], laneNormBullets(intent.shape)).map((l) => `    ${esc(l)}`),
      "  </norms>",
    ].join("\n")),
    purposeSection(),
    section("task", extra.fix ? [
      "  <task>",
      ...extra.fix.task.map((l) => `    ${esc(l)}`),
      "    実装は前の session が worktree に commit 済みで、最初からやり直さない。",
      executorSolvingRule(v2, worktree),
      ...(contextDoc ? [`    ${esc(EXECUTOR_CONTEXT_RULE)}`] : []),
      "  </task>",
    ].join("\n") : [
      "  <task>",
      `    ${esc(plan
        ? `作業指示（plan）に沿って実装し、条件（AC）を自分で検証する。依頼の裁量（触る範囲・自由・守ること）に従い、依頼に書かれていない所の変更は最小に留める。${v2 ? "Choice" : "DEC"} は、この変更が守る契約である。作業指示に無い判断が要るときは、${v2 ? "Choice" : "DEC"} の why から意図を推論して実装方法を決める。`
        : `決定された契約（${v2 ? "Choice" : "DEC"}）を実装し、条件（AC）を自分で検証する。なぜそうするのかが読み取れないときは、${v2 ? "Choice" : "DEC"} の why から意図を推論して実装方法を決める。`)}`,
      executorSolvingRule(v2, worktree),
      `    契約が誤っている・足りない・不明瞭である、または質問すべきことがあると判断したら、道具 \`ask\` があればそれで尋ね、答えを待って続ける。無ければ実装を中断し、\`${CLI_NAME} report questions\` で尋ねる。`,
      "    変更は commit する。message は repo の commit 規約に従い、規約が無ければ `<type>(<scope>): <一文>` とし、判断の理由は本文へ書く。",
      ...(contextDoc ? [`    ${esc(EXECUTOR_CONTEXT_RULE)}`] : []),
      "  </task>",
    ].join("\n")),
    section("completion", [
      "  <completion>",
      `    configured-checks の検査がすべて通り、変更が commit され、\`${CLI_NAME} report result\` を送っていること。`,
      ...(v2 ? [`    \`${CLI_NAME} intent check\` も通っていること。`] : []),
      ...(increments ? ["    increments の数が本流より増えていないこと（数え方は increments 節）。"] : []),
      ...(structure ? ["    構造の数（宣言の blocking）が本流より増えていないこと（数え方は structure 節）。"] : []),
      "  </completion>",
    ].join("\n")),
    rules("skill-rules", EXECUTOR_SKILL_RULES.map(esc)),
    rules("records-rules", (v2 ? recordsRulesV2() : recordsRules()).map(esc)),
    rules("writing-rules", (v2 ? EXECUTOR_WRITING_RULES_V2 : EXECUTOR_WRITING_RULES).map(esc)),
    rules("question-rules", questionRules().map(esc)),
    rules("host-rules", EXECUTOR_HOST_RULES.map(esc)),
    ...(instruction ? [instruction] : []),
    callbackSection([
      `    報告は \`${CLI_NAME}\` の CLI で送る。lane の id と token はハーネスが渡すので、引数では指定しない。`,
      `    <progress>節目ごとに送る: ${CLI_NAME} report progress --current-step "..." --ac AC-001=verified --evidence 'AC-001=<テストの名前か、実行した命令と結果>' --recent "..."。--ac の状態は verified / covered / planned / deferred / not-applicable（今までの in_progress / todo も可）。</progress>`,
      `    <result>最後に 1 回送る: ${CLI_NAME} report result --outcome success|partial|failed --changed-file path --commit-count N --verified AC-001 --evidence 'AC-001=<テストの名前か、実行した命令と結果>' --unverified AC-002 --side-finding "..."</result>`,
      `    evidence の無い verified は確認済みにならない。evidence はテストの名前か、実行した命令と結果である。`,
      `    <questions>${esc(REPORT_QUESTIONS_USAGE)} — 読む JSON は ${esc(QUESTIONS_JSON_SHAPE)}</questions>`,
    ]),
    section("context", [
      "  <lane>",
      `    <title>${esc(rec.title)}</title>`,
      `    <repo>${esc(area?.linked_repo ?? rec.area)}</repo>`,
      `    <source-url>${esc(rec.gh_issue_url ?? rec.linear_issue_url ?? "")}</source-url>`,
      ...(sourceTodo ? [`    <source-todo>${esc(sourceTodo)}</source-todo>`] : []),
      `    <lane-number>${esc(laneNumber)}</lane-number>`,
      ...(v2 ? execLaneIdExplanationV2(laneNumber) : execLaneIdExplanation(laneNumber)).map(esc),
      ...overlapSection(overlaps, "executor", esc),
      ...(unwritten.length ? [
        "    <unwritten-records>",
        "      計画の後に書けなかった処置である。",
        ...unwrittenLines,
        "    </unwritten-records>",
      ] : []),
      // the Project the lane's Issue belongs to, in the first round and in every fix round (the same brief), whatever the record shape
      ...projectBriefFor(rec, "executor"),
      "  </lane>",
      "  <contract>",
      ...(v2 ? [] : [`    <intent>_docs/intent/${seg}/${slug}/decision.md</intent>`]),
      `    <qa>_docs/qa/${seg}/${slug}/qa.md</qa>`,
      ...(plan ? [`    <plan>${esc(plan.rel)}</plan>`] : []),
      ...(contextDoc ? [`    <lane-context>${esc(contextDoc)}</lane-context>`] : []),
      ...(v2 ? [
        ...(purposes.length ? [
          "    <purposes>",
          "      lane の Choice が属する Purpose。id・全文（want となぜなら）・status を Purpose ごとに 1 回持つ。",
          purposeList(purposes),
          "    </purposes>",
        ] : []),
        "    <choices>",
        "      Choice は後から変える agent のために残す契約。chosen（選んだ形）・why・anchored を持ち、実装はこれを守る。",
        ...(intent.decisions.length ? [choiceList(intent.decisions)] : []),
        "    </choices>",
      ] : [
        "    <decisions>",
        "      DEC は後から変える agent のために残す契約。What / Why / Change freedom を持ち、実装はこれを守る。",
        ...(intent.decisions.length ? [list(intent.decisions)] : []),
        "    </decisions>",
      ]),
      "    <criteria>",
      "      AC は受け入れ条件。観測できる形で書かれ、実装後に自分で確かめ、result で verified / unverified を報告する。",
      list(intent.criteria),
      "    </criteria>",
      ...(!v2 && intent.invariants.length ? [
        "    <invariants>",
        "      INV は DEC から導かれ、この変更の後も常に成り立つべき性質。実装で壊してはいけない。",
        list(intent.invariants),
        "    </invariants>",
      ] : []),
      "  </contract>",
      ...(wrappedChecks ? [] : [`  <configured-checks>${esc(JSON.stringify(readAreas().areas[rec.area]?.checks ?? []))}</configured-checks>`]),
    ].join("\n")),
    ...(wrappedChecks ? [wrappedChecks] : []),
    ...(increments ? [increments] : []),
    ...(structure ? [structure] : []),
    ...(extra.fix ? [
      ...(extra.fix.prev ? [section("context", prevResultSection(extra.fix.prev))] : []),
      ...(extra.fix.plan ? [section("context", fixPlanSection(extra.fix.plan))] : []),
      section("context", extra.fix.instruction),
    ] : []),
  ]);
}

/**
 * What a fix's envelope asks beyond the implementer's own task and callback: the accepted items, the boundaries,
 * the person's note or the send-back's instruction. The brief hands this to the implementer, and the delivery's
 * one-off plan reads the same text: the plan gets the instruction, never the orders the envelope keeps for the
 * implementer alone (commit, report result), and the person's words stay as written (DEC-121-4, DEC-121-7).
 */
export function envelopeInstruction(envelopeBody: string): string {
  return envelopeBody
    .replace(/^[\s\S]*?<task>[\s\S]*?<\/task>\s*/, "")
    .replace(/\s*<callback>[\s\S]*?<\/callback>\s*/, "")
    .replace(/<\/?propter-system-message>/g, "")
    .split("\n").filter((l) => l.trim() !== CLOSING_LINE).join("\n")
    .trim();
}

/**
 * The brief a fix session gets: the executor's frame (norms, contract, checks, band, callback) with the stage's
 * task and the envelope's instruction. The fix session starts without the implementing session's conversation,
 * so the brief carries what that session had already done.
 */
export function fixBrief(rec: BacklogRecord, worktree: string, envelopeBody: string, run?: BriefRun, plan?: string, instructions?: readonly Picked[]): string {
  const taskMatch = /<task>([\s\S]*?)<\/task>/.exec(envelopeBody);
  const task = (taskMatch?.[1] ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const instruction = envelopeInstruction(envelopeBody);
  return executorBrief(rec, worktree, {
    fix: { task: task.length ? task : ["指示に沿って直し、commit する。"], instruction, prev: prevResultOf(rec.idd_id), ...(plan ? { plan } : {}) },
    ...(run ? { run } : {}),
    ...(instructions ? { instructions } : {}),
  });
}

export interface ExecResult {
  started: { iddId: string; sessionId: string; worktree: string }[];
  skipped: { iddId: string; reason: string; wait?: boolean }[];
  capacity: number;
}

/**
 * A session spawned for a start that did not go through is taken back; the words to add to the lane's skip (empty
 * when it was). A runner that cannot take it back leaves it running, and the skip says so.
 */
async function discardSpawned(runner: AgentRunner, sessionId: string): Promise<string> {
  if (!runner.discard) return `（runner が session を片付けられないので、起動した session ${sessionId} が残っています）`;
  try {
    await runner.discard(sessionId);
    return "";
  } catch (err) {
    return `（起動した session ${sessionId} を片付けられず、残っています: ${String(err).slice(0, 200)}）`;
  }
}

export async function runExec(): Promise<ExecResult> {
  const runner = getAgentRunner();
  const cap = executorConcurrency();
  const result: ExecResult = { started: [], skipped: [], capacity: Math.max(0, cap - runningExecutors()) };
  const events = readLifecycle();
  const sessions = currentExecutorSessions(events).map((rec) => ({ idd_id: rec.idd_id, ...(rec.kind ? { kind: rec.kind } : {}) }));
  // a lane's readings are kept here: the helper's answers are values, and the fold decides when they are read
  let worktree: LaneWorktree | null | undefined;
  let spawned: SpawnResult | undefined;
  let wait: ReturnType<typeof quotaWaitOf>;
  let base = "";

  for (const rec of lanesAwaitingExec()) {
    worktree = undefined;
    spawned = undefined;
    wait = null;
    base = "";
    const laneEvents = () => events.filter((e) => e.idd_id === rec.idd_id);
    const outcome = await driveStartSteps("start_exec", events, {
      lane: rec.idd_id,
      area: rec.area,
      limit: cap,
      started: result.started.length,
      runner: Boolean(runner?.spawn),
      sessions,
      // a lane planned under the state shape writes its plan records before its executor starts
      sessionShape: readSessions("planner").filter((s) => s.idd_id === rec.idd_id).pop()?.records_shape ?? "",
    }, {
      write: async (event, attrs) => {
        await appendLifecycle(event, rec.idd_id, attrs);
      },
      call: async (step) => {
        switch (step.helper) {
          case "transition_refusal": {
            // the lane may have been aborted or sent back since the list was read: nothing is made or spawned for it
            const before = transitionRefusal("s2_start", laneEvents());
            return before ? { reason: before } : {};
          }
          case "ensure_worktree": {
            const made = await ensureWorktreeStep(rec.area, rec.idd_id);
            worktree = made.worktree;
            return made.answer;
          }
          case "write_plan_records": {
            // a v2 lane writes its plan report's drafts and disposals to the column before its executor starts,
            // inside the column's own lock; a write that could not happen leaves the lane for the next tick (INV-119-4)
            const evs = laneEvents();
            const ready = [...evs].reverse().find((e) => e.event === "s1_ready");
            const records = readyPlanRecordsOf(evs);
            if (!ready || !records) return { ok: false, error: "s1_ready か plan_records がありません" };
            try {
              const written = await writePlanRecords({ repo: rec.area, lane: rec.idd_id, readyAt: ready.at, choices: records.choices, existing: records.existing });
              if (!written.ok) return { ok: false, error: written.error };
              return { ok: true, done: written.done, attrs: { ready_at: ready.at, written: written.written, skipped: written.skipped } };
            } catch (err) {
              return { ok: false, error: String((err as Error).message ?? err).slice(0, 300) };
            }
          }
          case "read_contract": {
            const contract = laneIntent(rec, { root: worktree!.path });
            // a lane whose records hold no decision but do hold a condition still has a contract to implement
            return { empty: !contract.decisions.length && !contract.criteria.length };
          }
          case "commit_records": {
            // the harness commits the planner's records before the executor moves: they are not in the published
            // diff, and the head before that commit is the review's base
            const records = commitPlannerRecords(rec, worktree!.path);
            if ("error" in records) return { error: records.error };
            base = records.base;
            return { base: records.base };
          }
          case "spawn": {
            try {
              if (!runner?.spawn) throw new Error("no runner");
              const answer = await runner.spawn({ role: "executor", cwd: worktree!.path, laneId: rec.idd_id });
              spawned = answer;
              return {
                sessionId: answer.sessionId,
                ...(answer.model ? { model: answer.model } : {}),
                ...(answer.harness ? { harness: answer.harness } : {}),
                ...(answer.cacheTtl ? { cacheTtl: answer.cacheTtl } : {}),
                ...(fallbackAttrs(answer.fallbacks).fallbacks ? { fallbacks: fallbackAttrs(answer.fallbacks).fallbacks } : {}),
              };
            } catch (err) {
              // an executor on Claude Code over the subscription's windows waits: the lane stays queued for the next tick
              wait = quotaWaitOf(err);
              return { error: String(err), ...(wait ? { quota: { reason: wait.reason } } : {}) };
            }
          }
          case "write_start": {
            // a lane aborted or sent back while the session was spawning starts nothing: the session is recorded only
            // with its start, and one whose start did not go through is taken back at once
            try {
              const started = await transition(rec.idd_id, "s2_start", {
                executor_session_id: spawned!.sessionId,
                ...(spawned!.model ? { model: spawned!.model } : {}),
                ...(spawned!.harness ? { harness: spawned!.harness } : {}),
                started_from_worktree: worktree!.path,
                started_from_commit: base,
                ...fallbackAttrs(spawned!.fallbacks),
              }, {
                before: () => recordSession({
                  iddId: rec.idd_id,
                  sessionId: spawned!.sessionId,
                  worktree: worktree!.path,
                  branch: worktree!.branch,
                  ...(spawned!.model ? { model: spawned!.model } : {}),
                  ...(spawned!.harness ? { harness: spawned!.harness } : {}),
                  ...(spawned!.fallbacks?.length ? { fallbacks: spawned!.fallbacks } : {}),
                }),
                undo: () => withdrawJsonl(sessionsPath(), (row) => row.idd_id === rec.idd_id && row.executor_session_id === spawned!.sessionId),
              });
              return started.ok ? { ok: true } : { reason: started.reason };
            } catch (err) {
              return { error: String(err).slice(0, 400) };
            }
          }
          case "discard_session": {
            return { left: await discardSpawned(runner!, spawned!.sessionId) };
          }
          case "deliver": {
            try {
              const picked = pickForStage("exec", repoOfArea(rec.area));
              await runner!.deliver(spawned!.sessionId, executorBrief(rec, worktree!.path, { run: { ...(spawned!.harness ? { harness: spawned!.harness } : {}), ...(spawned!.cacheTtl ? { cacheTtl: spawned!.cacheTtl } : {}) }, instructions: picked }), { cwd: worktree!.path, type: "s2_start" });
              // the run has started: the ledger is written only now, so a delivery that failed leaves no line
              recordInjection(picked, { kind: "lane", stage: "exec", scene: "implement", lane: rec.idd_id, run: spawned!.sessionId });
              return { ok: true };
            } catch (err) {
              wait = quotaWaitOf(err);
              return { error: String(err), ...(wait ? { quota: { reason: wait.reason } } : {}) };
            }
          }
          case "record_quota_wait": {
            if (wait) await recordQuotaWait(rec.idd_id, laneEvents(), "executor", wait);
            return { ok: true };
          }
          default: return { error: `知らない helper: ${String(step.helper)}` };
        }
      },
    });
    if (outcome.action === "started") {
      result.started.push({ iddId: rec.idd_id, sessionId: spawned!.sessionId, worktree: worktree!.path });
    } else if (outcome.action === "skipped") {
      result.skipped.push(skippedOf(rec.idd_id, outcome));
    }
  }
  return result;
}
