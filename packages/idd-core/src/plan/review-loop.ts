import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { inStartOrder } from "../ledger/start-order.ts";
import { laneHeld } from "../ledger/derive.ts";
import { lastReturnToPlan, returnsToPlan } from "../ledger/replan-view.ts";
import { appendLifecycle, buildEnvelope, laneRejectedEnvelope, queueEnvelope } from "../ledger/write.ts";
import { fallbackAttrs, quotaWaitOf, recordQuotaWait } from "./quota-wait.ts";
import { getAgentRunner, type MissingMeansFinding, type ReviewExtra, type ReviewStage, type RiskRoute, type TriageDecision } from "../agent/port.ts";
import { missingMeansMarkers, pipelineConcurrency, pipelineSlotDeclared, pipelineSnapshot, reviewPolicy } from "../config/pipeline.ts";
import { convergeChecksOn, generatedFilesOf, publishes, readAreas } from "../config/areas.ts";
import type { GeneratedFiles } from "../config/generated.ts";
import { headCommit, sameTree } from "../worktree/ensure.ts";
import { clean, commitTree, git, lock, sha } from "../overlay/git.ts";
import { laneLocations } from "../overlay/export.ts";
import { readManifest, isOverlayPath } from "../overlay/manifest.ts";
import { isAncestor, laneBaseOf } from "../overlay/base.ts";
import { isLaneGateBusy, withLaneGate } from "../ledger/gate.ts";
import { zeroFixMarks, acceptedOf, answeredQuestionsOf, boundariesOf, questionAnsweredByNote, compareOrder, feedbackPassAt, feedbackTriageOf, firstBlindOfPass, judge, judgeSync, MERGE_ONLY_SKIP_EVENT, orderPositionOf, acceptedAt, correctionsOf, refKey, s4Triage, fixesNow, fixScope, oscillationsOf, passPolicy, reviewLoopState, startFailures, startRetryWaiting, START_FAILURE_LIMIT, type AcceptedItem, type BoundaryFix, type FixSource, type StuckOutcome, type FactNeed } from "../ledger/review-loop.ts";
import { roundLines, withFindingLines } from "./place-findings.ts";
import { trialMerge } from "../overlay/land.ts";
import { generatedOnlyConflict, generatedTouched, parseMergeTree, rebuildGenerated } from "../overlay/generated.ts";
import { planReviewInputs, writeLanePurposesFile } from "./plan-review.ts";
import { lanePlanDoc, type LanePlan } from "./plan-doc.ts";
import { NORM_STAGES, normText, reviewLaneLine } from "./harness-norms.ts";
import { stateDir } from "../paths.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";
import { reviewBaseOf, ORIGIN_CAUGHT_UP_EVENT } from "../ledger/base.ts";
import { behaviourChanges, conflictMerge, conflictRoundPending, lastReviewRound, laneRisk, mergedReviewBase, mergeOnlyHead, mergeSince, takenMainline, writtenFollowups } from "./review-scope.ts";
import { DEPTH_TABLE, recordedDepth, type Depth } from "./depth.ts";
import { BlindGate, blindCountOf, blindSlotSize, mapComesFirst, mapSkipReasonOf, unreadBlindCount, upcomingBlindRound } from "./blind-count.ts";
import { laneDepth } from "./depth-read.ts";
import { writeHarmExamplesFile } from "../config/harm-examples.ts";
import { acStatesForLane, criterionKey, readWorkRows, workColumnPath } from "./work-records.ts";
import { laneRecordShape } from "./record-shape.ts";
import { laneIntent, writeLaneChoicesFile } from "./lane-intent.ts";
import { deviceVerdict } from "./device-check.ts";
import { foldRows, intentColumnPath, laneStates, readRows } from "../intent/store.ts";
import { convergeStep, reviewNextStep, type StepFacts } from "../ledger/review-loop-next.ts";
import { convergeCheckLauncher, type ConvergeBasis } from "../overlay/converge-checks.ts";
import { baselinePhrase, checkReason } from "../overlay/check-reason.ts";
import { DEFAULT_CHECK_MINUTES, type GateCheck } from "../overlay/gate.ts";
import { filteredTree } from "../overlay/git.ts";
import { drivePreMerge } from "./pre-merge-step.ts";

const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
/**
 * A run, as the fold reads the runner's port's answer. The ids the run was started under come from the loop's own
 * record (the runner's status does not carry them), and a run the runner says nothing of is one that has not
 * finished (C-203-2).
 */
const runFactOf = (s: { state: string; error?: string; routes?: unknown; reportMd?: string; reportJson?: string; fallbacks?: unknown; findings?: unknown; skipped?: string } | undefined, runIds: string[] = []) => ({
  state: s?.state ?? "running",
  error: s?.state === "failed" ? String(s.error ?? "") : "",
  routes: (s?.state === "done" ? (s.routes ?? []) : []) as unknown[],
  // a report the runner did not tell of is not a report: the fold leaves the field out, as the record always did
  reportMd: s?.state === "done" ? (s.reportMd ?? null) : null,
  reportJson: s?.state === "done" ? (s.reportJson ?? null) : null,
  fallbacks: s?.state === "done" ? (fallbackAttrs(s.fallbacks as never).fallbacks ?? []) : [],
  findings: (s?.state === "done" ? (s.findings ?? []) : []) as unknown[],
  ...(s?.state === "done" && typeof s.skipped === "string" ? { skipped: s.skipped } : {}),
  runIds,
});
/** a run the loop just started, as the fold reads the start's answer */
const startedRunFact = (r: { runIds: string[]; wholeDiff?: string[]; fallbacks?: unknown; runRoles?: string[]; runLabels?: string[]; routeCount?: number; routesOverCap?: boolean; skipped?: string }) => ({
  state: "started",
  error: "",
  routes: [],
  reportMd: null,
  reportJson: null,
  fallbacks: fallbackAttrs(r.fallbacks as never).fallbacks ?? [],
  findings: [],
  ...(typeof r.skipped === "string" ? { skipped: r.skipped } : {}),
  runIds: r.runIds,
  ...(r.wholeDiff !== undefined ? { wholeDiff: r.wholeDiff } : {}),
  ...(r.runRoles !== undefined ? { runRoles: r.runRoles } : {}),
  ...(r.runLabels !== undefined ? { runLabels: r.runLabels } : {}),
  ...(r.routeCount !== undefined ? { routeCount: r.routeCount } : {}),
  ...(r.routesOverCap ? { routesOverCap: true } : {}),
});
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const EMPTY_MARK = /^(なし|無し|特になし|none|n\/a|null|-|ー|―|—)?$/i;

/** a finding the triage put to penne as undoing an earlier fix, with a position on each side */
function isReversal(d: TriageDecision): boolean {
  return d.verdict === "escalate" && !!d.reverts && !EMPTY_MARK.test(d.reverts.prior.trim()) && !EMPTY_MARK.test(d.reverts.current.trim());
}

/** which reviewer runs a judged finding came from and the weight they gave it, for measuring the reviewers later */
function origin(d: TriageDecision): Pick<TriageDecision, "from" | "reported_severity"> {
  return { ...(d.from?.length ? { from: d.from } : {}), ...(d.reported_severity ? { reported_severity: d.reported_severity } : {}) };
}

export type { BoundaryFix, FixSource };

/** a finding of a review report, as the report holds it: where, what, the reviewer's plan, and the weight they gave it */
interface ReportFinding { path: string; claim: string; how?: string; severity?: "must" | "should" | "nit" }

/**
 * A review report's findings. A report that cannot be read (a run whose directory is gone, a broken file) answers
 * none: a finding is then fixed without a plan and recorded without a reporter's weight, never with a guess.
 */
function reportFindings(laneId: string, dir: string): ReportFinding[] {
  const file = join(stateDir(), "pipeline", "review", laneId, dir, "report.json");
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { findings?: unknown[]; new_findings?: unknown[] };
    return [...(Array.isArray(raw.findings) ? raw.findings : []), ...(Array.isArray(raw.new_findings) ? raw.new_findings : [])]
      .flatMap((f) => {
        if (!f || typeof f !== "object") return [];
        const o = f as Record<string, unknown>;
        if (typeof o.claim !== "string") return [];
        const severity = (["must", "should", "nit"] as const).find((v) => v === o.severity);
        return [{
          path: String(o.path ?? ""),
          claim: o.claim,
          ...(typeof o.how === "string" && o.how.trim() ? { how: o.how.trim() } : {}),
          ...(severity ? { severity } : {}),
        }];
      });
  } catch {
    return [];
  }
}

/** a review report read for the how-to-fix a reviewer wrote beside its findings */
function reportHows(laneId: string, dir: string): { path: string; claim: string; how: string }[] {
  return reportFindings(laneId, dir).flatMap((f) => (f.how ? [{ path: f.path, claim: f.claim, how: f.how }] : []));
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[`*_#>|]/g, " ").split(/[^\p{L}\p{N}_.:/-]+/u).filter((t) => t.length >= 3));
}

/** how much of `a`'s words the other claim has: read against the whole of `a`, never against the shorter side */
function wordCoverage(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n / a.size;
}

function charBigrams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/[`*_#>|\s、。,.（）()「」]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

function bigramDice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return (2 * n) / (a.size + b.size);
}

/**
 * How alike two claims are, each side read against the calibrated line it clears: the lower of the two directions'
 * word coverage over WORD_THRESHOLD, or the character bigram dice over BIGRAM_THRESHOLD, whichever is larger. Either
 * line alone tells a reworded finding from the one it was reworded from, the way the review lane calibrated them
 * (APP-1837, `sameFinding`); a claim a judgement rewords is mostly the same characters, and Japanese claims carry no
 * word tokens at all, so the bigram line has to stand on its own. The word side still reads both directions and takes
 * the lower one: a short claim merely contained in a longer one is not the same finding, and a rejected finding beside
 * the accepted one must not be taken for it. A score of 1 is the acceptance line.
 */
function claimScore(a: { path?: string; claim: string }, b: { path?: string; claim: string }): number {
  if (a.path && b.path && a.path !== b.path) return 0;
  const aw = words(a.claim);
  const bw = words(b.claim);
  const word = Math.min(wordCoverage(aw, bw), wordCoverage(bw, aw)) / WORD_THRESHOLD;
  const bigram = bigramDice(charBigrams(a.claim), charBigrams(b.claim)) / BIGRAM_THRESHOLD;
  return Math.max(word, bigram);
}

/** the closest candidate, answering none when nothing clears a line or when the closest is a tie */
function uniqueClosest(scores: number[]): number | undefined {
  let best = -1;
  for (const x of scores) if (x > best) best = x;
  if (best < 1) return undefined;
  const top = scores.flatMap((x, i) => (x === best ? [i] : []));
  return top.length === 1 ? top[0] : undefined;
}

/**
 * Which decision each report finding belongs to, one to one: a finding binds a decision only when it is that decision's
 * closest too, and a tie binds neither. `scores[i][j]` is how alike finding i and decision j read.
 */
function bindOwners(scores: number[][]): Map<number, number> {
  const bound = new Map<number, number>();
  for (let i = 0; i < scores.length; i += 1) {
    const j = uniqueClosest(scores[i]);
    if (j === undefined) continue;
    // the decision has to have chosen this finding too: a closer finding elsewhere leaves both unbound
    if (uniqueClosest(scores.map((row) => row[j])) !== i) continue;
    bound.set(i, j);
  }
  return bound;
}

/** the two lines of `sameFinding` (APP-1837), which a claim score puts on one scale: 1 just clears one of them */
const WORD_THRESHOLD = 0.6;
const BIGRAM_THRESHOLD = 0.45;

/** a finding a judgement decided, and the report runs it named as where the finding came from */
interface JudgedClaim { dirs: string[]; path: string; claim: string; ref: string }

/**
 * Every finding the lane's judgements decided, accepted or rejected, with the report the judgement said it came from.
 * A rejected or followed-up finding is read too: it competes for its own report's finding, so the finding a
 * judgement threw away is never bound to an accepted finding of its own report that merely reads alike.
 */
function judgedClaims(events: LifecycleRecord[]): JudgedClaim[] {
  const out: JudgedClaim[] = [];
  for (const e of events) {
    if (e.event !== "s2_triage_done" || e.attrs?.failed) continue;
    for (const key of ["accepted", "rejected"] as const) {
      const list = e.attrs?.[key];
      if (!Array.isArray(list)) continue;
      for (const x of list) {
        if (!x || typeof x !== "object") continue;
        const o = x as Record<string, unknown>;
        const dirs = strs(o.from);
        if (!dirs.length) continue;
        out.push({ dirs, path: String(o.path ?? ""), claim: String(o.claim ?? ""), ref: String(o.ref ?? "") });
      }
    }
  }
  return out;
}

const bareRef = (ref: string) => ref.slice(ref.lastIndexOf("/") + 1);

/** the plans of every review report the lane kept: read only for a lane whose judgements name no report at all */
function laneReportHows(laneId: string): ReturnType<typeof reportHows> {
  const root = join(stateDir(), "pipeline", "review", laneId);
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return dirs.flatMap((dir) => reportHows(laneId, dir));
}

/** the key two decisions of one finding share: the same finding carried into a later round is decided again with its words */
const findingKey = (j: JudgedClaim) => [j.dirs.join("|"), bareRef(j.ref), j.path, j.claim].join("\u0000");

/**
 * The reviewer's how-to-fix for each finding a fix is about to carry, by ref. Each decided finding has one owner: in a
 * report, a finding the reviewer wrote is matched to at most one decision and a decision to at most one finding, with
 * a tie binding neither, so an accepted finding is handed its own reviewer's plan and never a rejected or sent-elsewhere
 * finding's plan beside it. A finding carried over from an earlier round keeps that plan (C-197-3). A report no
 * judgement named (an older lane) is read the old way: an exact path and claim, or no plan at all.
 */
function fixHows(laneId: string, accepted: AcceptedItem[], events: LifecycleRecord[]): Record<string, string> {
  const judged = judgedClaims(events);
  const reports = new Map<string, ReturnType<typeof reportHows>>();
  const reportOf = (dir: string) => {
    if (!reports.has(dir)) reports.set(dir, reportHows(laneId, dir));
    return reports.get(dir)!;
  };
  // a finding judged in more than one round is one finding: its decisions are grouped before the one-to-one matching
  const groups = new Map<string, JudgedClaim[]>();
  for (const j of judged) {
    const key = findingKey(j);
    const seen = groups.get(key);
    if (seen) seen.push(j);
    else groups.set(key, [j]);
  }
  // which report finding each decision owns; a group of the same finding shares one owner
  const ownerHow = new Map<JudgedClaim, string>();
  const all = [...groups.values()];
  for (const dir of new Set(judged.flatMap((j) => j.dirs))) {
    const findings = reportOf(dir);
    const here = all.filter((g) => g[0].dirs.includes(dir));
    const scores = findings.map((f) => here.map((g) => claimScore(f, g[0])));
    for (const [i, j] of bindOwners(scores)) for (const d of here[j]) ownerHow.set(d, findings[i].how);
  }
  const out: Record<string, string> = {};
  // a lane whose judgements named no report (older records): the plans are read by an exact path and claim, never a guess
  const lanePlans = judged.length ? [] : laneReportHows(laneId);
  for (const a of accepted) {
    if (!judged.length) {
      const how = lanePlans.find((h) => h.path === (a.path ?? "") && h.claim === a.claim)?.how;
      if (how) out[a.ref] = how;
      continue;
    }
    for (const dir of a.from ?? []) {
      const how = judged
        .filter((j) => j.dirs.includes(dir) && bareRef(j.ref) === bareRef(a.ref) && j.claim === a.claim && j.path === (a.path ?? ""))
        .map((j) => ownerHow.get(j))
        .find(Boolean);
      if (!how) continue;
      out[a.ref] = how;
      break;
    }
  }
  return out;
}

/**
 * The weight each reviewer gave a decided finding, read from the reports the decision names (`from`). A decision binds
 * to a report's finding the way a plan does (`fixHows`): one to one, by path and claim, a tie binding neither. A
 * decision made from several reports takes the heaviest weight. A decision with no report to read, or no finding it
 * binds to, has none: the record leaves the field out rather than guess. The judgement is never handed these weights,
 * so its own weight is decided from the code alone; the harness sets them beside the decision afterwards (C-209-5).
 */
export function reportedSeverities(laneId: string, decisions: { ref: string; from?: string[]; path?: string; claim: string }[]): Map<string, "must" | "should" | "nit"> {
  const order = ["must", "should", "nit"] as const;
  const found = new Map<string, "must" | "should" | "nit">();
  const dirs = new Set(decisions.flatMap((d) => d.from ?? []));
  for (const dir of dirs) {
    const findings = reportFindings(laneId, dir);
    const here = decisions.filter((d) => d.from?.includes(dir));
    const scores = findings.map((f) => here.map((d) => claimScore(f, { claim: d.claim, ...(d.path ? { path: d.path } : {}) })));
    for (const [i, j] of bindOwners(scores)) {
      const weight = findings[i].severity;
      if (!weight) continue;
      const ref = here[j].ref;
      const had = found.get(ref);
      if (!had || order.indexOf(weight) < order.indexOf(had)) found.set(ref, weight);
    }
  }
  return found;
}

/**
 * The judgement's copy of a review report: the same findings with what the reviewer wrote about weight and handling
 * dropped: the how-to-fix, the weight, the recommended action and the frequency. A judgement decides a finding's weight
 * from its claim and evidence and the harm table, so a reviewer's weight in its input would be the point it is read
 * against, and a plan for the fix would let a wrong plan become the reason a finding is accepted (C-197-2, C-209-5).
 * The copy is written in the report's own directory, so its parent name is still the run the judgement writes as the
 * finding's `from`. A report with none of these fields, and anything that is not a readable report, is read where it is.
 */
const REVIEWER_WEIGHT_FIELDS = ["how", "severity", "action", "frequency"] as const;

export function judgementCopy(path: string, round: number, kind: string): string {
  if (!path.endsWith(".json")) return path;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return path;
  }
  const out = { ...raw };
  let changed = false;
  for (const key of ["findings", "new_findings"] as const) {
    if (!Array.isArray(raw[key])) continue;
    out[key] = (raw[key] as unknown[]).map((f) => {
      if (!f || typeof f !== "object") return f;
      const o = f as Record<string, unknown>;
      if (!REVIEWER_WEIGHT_FIELDS.some((k) => k in o)) return f;
      changed = true;
      return Object.fromEntries(Object.entries(o).filter(([k]) => !(REVIEWER_WEIGHT_FIELDS as readonly string[]).includes(k)));
    });
  }
  if (!changed) return path;
  const copy = join(dirname(path), `report-for-judgement-${round}-${kind}.json`);
  writeFileSync(copy, `${JSON.stringify(out, null, 2)}\n`);
  return copy;
}

/**
 * The outbox id of the envelope that carries one round's fix. A round sends one instruction, so the id comes from the
 * lane and the round and not from the clock: a tick that comes back after a failed fold or a failed record names the
 * same envelope instead of stacking a second instruction on the executor. A lane sent back to its plan counts its
 * rounds from 1 again, so the times it went back are part of the id: the new round 1 would otherwise name the envelope
 * the first plan's round 1 already sent, and its instruction would be taken as sent and never reach the executor.
 */
export function fixEnvelopeId(iddId: string, round: number, replans = 0): string {
  return replans > 0 ? `fix-${iddId}-p${replans}-r${round}` : `fix-${iddId}-r${round}`;
}

export function reviewFixEnvelope(iddId: string, round: number, accepted: AcceptedItem[], note?: string, source: FixSource = "review", boundaries: BoundaryFix[] = [], shape: "docs" | "state" = "docs", hows: Record<string, string> = {}): string {
  const recordWord = shape === "state" ? "記録（Choice など）" : "記録（decision.md など）";
  const lead = {
    pr: "提出した PR にレビュアーから届いた指摘のうち、判定が fix にしたもの（CI の失敗を含む）。",
    pr_leftovers: "提出した PR にレビュアーから届いた指摘のうち、確認で直っていなかったもので、判定が fix にしたもの（確認で見つかった問題を含む）。",
    review: `レビュー（${round} 巡目）で受理された指摘。`,
    checks: "レビューの巡を収束させる前に回した repo の必須の検査のうち、比べた base（公開 base の先端。取れなかったときは lane の分岐元）では落ちないのに head で落ちたもの。既存のテスト・検査を落とす変更は直す（検査そのものを緩めて通さない）。",
  }[source];
  const anyHow = accepted.some((a) => hows[a.ref]);
  return buildEnvelope("review_fix", iddId, [
    "  <task>",
    `    ${lead}各項目の fix は「何を満たすべきか」で書いてある。手段は自分で現物を読んで決める。`,
    ...(anyHow ? ["    how は、その指摘を出したレビューが書いた直し方。従う。外れると判断したときは、外れた理由を result の side_findings に書く。"] : []),
    "    直したら commit し、`idd report result` を呼び直す。直さないと判断したものは、理由を result の side_findings に書く。",
    ...(boundaries.length ? [`    boundaries は、前の巡の修正と今回の指摘が逆向きになった箇所。penne が決めた境目（decision、空なら user-note）に、コードと${recordWord}を揃える。`] : []),
    // the list is the scope penne's answer decided; her note rides beside it and never narrows or widens it
    ...(note ? ["    accepted がこの変更で直す範囲。user-note は penne の補足・理由で、範囲は決めない。user-note が accepted と食い違って読めても accepted に従い、食い違いを result の side_findings に書く。"] : []),
    "  </task>",
    "  <accepted>",
    ...accepted.map((a) => `    <item ref="${esc(a.ref)}" severity="${esc(a.severity)}" path="${esc(a.path ?? "")}"><claim>${esc(a.claim)}</claim>${a.impact ? `<impact>${esc(a.impact)}</impact>` : ""}<fix>${esc(a.fix ?? "")}</fix>${hows[a.ref] ? `<how>${esc(hows[a.ref])}</how>` : ""}</item>`),
    "  </accepted>",
    ...(boundaries.length ? [
      "  <boundaries>",
      ...boundaries.map((b) => `    <boundary ref="${esc(b.ref)}" reverts="${esc(b.prior_ref)}" path="${esc(b.path ?? "")}"><claim>${esc(b.claim)}</claim><prior>${esc(b.prior)}</prior><current>${esc(b.current)}</current><decision>${esc(b.decision)}</decision></boundary>`),
      "  </boundaries>",
    ] : []),
    ...(note ? [`  <user-note>${esc(note)}</user-note>`] : []),
  ].join("\n"));
}

export interface ReviewLoopResult {
  advanced: { iddId: string; to: string }[];
  errors: { iddId: string; error: string }[];
}

function lastOf(events: LifecycleRecord[], name: string): LifecycleRecord | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === name) return events[i];
  return undefined;
}

/**
 * What the confirm of an S4 pass checks: every request the feedback's triage accepted and sent to this change's fix,
 * each time (a later fix must not undo one), then what the last fix was sent beyond them. A followup or a skip is
 * answered by its reply, not by the fix, so it is not checked here.
 */
export function feedbackConfirmScope(events: LifecycleRecord[], feedback: LifecycleRecord): AcceptedItem[] {
  const scope = acceptedOf(feedback.attrs).filter(fixesNow);
  const fix = lastOf(events, "s2_fix_sent");
  const triage = lastOf(events, "s2_triage_done");
  if (fix && triage && triage !== feedback && events.indexOf(fix) > events.indexOf(feedback)) {
    const sent = new Set(strs(fix.attrs?.refs));
    for (const a of acceptedOf(triage.attrs)) if (sent.has(a.ref) && !scope.some((x) => x.ref === a.ref)) scope.push(a);
  }
  return scope;
}

/** the boundaries the last fix was sent toward, each with what penne decided */
function sentBoundaries(events: LifecycleRecord[]): (AcceptedItem & { decision: string; prior_ref: string })[] {
  const fix = lastOf(events, "s2_fix_sent");
  const list = Array.isArray(fix?.attrs?.boundaries) ? (fix.attrs.boundaries as Record<string, unknown>[]) : [];
  return list.filter((b) => b && typeof b.ref === "string").map((b) => ({
    ref: String(b.ref), severity: String(b.severity ?? "should") || "should", claim: String(b.claim ?? ""), ...(b.path ? { path: String(b.path) } : {}),
    prior_ref: String(b.prior_ref ?? ""), decision: String(b.decision ?? ""),
  }));
}

/** what the confirm checks a boundary fix against: each reversal and the boundary penne decided for it */
function writeBoundaryList(iddId: string, round: number, bounds: ReturnType<typeof sentBoundaries>, shape: "docs" | "state" = "docs"): string {
  const file = join(stateDir(), "pipeline", "review", iddId, `boundaries-${round}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    `# penne が決めた境目（${round} 巡目）`,
    "",
    `前の巡の修正と逆向きになった指摘と、penne が決めた境目。コードと記録（${shape === "state" ? "Choice など" : "decision.md など"}）がこの境目に揃ったかを、ref ごとに確かめる。`,
    "",
    ...bounds.flatMap((b) => [`- ${b.ref}（${b.severity}）${b.path ?? ""}: ${b.claim}${b.prior_ref ? `（${b.prior_ref} と往復）` : ""}`, `  - 境目: ${b.decision || "（補足を参照）"}`]),
    "",
  ].join("\n"));
  return file;
}

/**
 * The AC states of the lane, written where a judgement reads its inputs: each criterion's statement with the state
 * the reports left it in (confirmed / covered / planned / deferred). The judgement checks the main paths against
 * these, so a criterion the change does not meet is a must whatever its frequency (F-113-10 / AC-037).
 */
export function writeAcStatesFile(rec: BacklogRecord, round: number, kind: string, evs: LifecycleRecord[]): string | undefined {
  // the ACs live in the lane's qa.md, which is only in its worktree until the lane merges
  const worktree = laneWorktreePath(rec.idd_id);
  const criteria = laneIntent(rec, { events: evs, ...(worktree ? { root: worktree } : {}) }).criteria;
  if (!criteria.length) return undefined;
  const states = acStatesForLane({ lane: rec.idd_id, rows: readWorkRows(workColumnPath(rec.area)), events: evs });
  const byId = new Map(states.map((s) => [criterionKey(s.id), s]));
  const file = join(stateDir(), "pipeline", "review", rec.idd_id, `ac-states-${rec.idd_id}-${round}-${kind}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    `# ${rec.idd_id} の受け入れ条件の状態（${round} 巡目）`,
    "",
    "主な経路でこれらの条件を満たしているかを確かめ、満たさない指摘は頻度に関わらず must にする。",
    "",
    ...criteria.map((c) => {
      const s = byId.get(criterionKey(c.id));
      return `- ${c.id} [${s?.status ?? "planned"}]: ${c.text}${s?.evidence ? ` — ${s.evidence}` : ""}`;
    }),
    "",
  ].join("\n"));
  return file;
}

/**
 * The ids of every record this lane's agents wrote: every stage run the lifecycle names (a review round's runs, a map,
 * a judgement, a confirm), the plan review's runs, and the lane's own conversations (the planner's and executor's,
 * fixes and send-backs included). A run is named by its lane id and a conversation by its session id; which is which
 * is resolved where the records are read.
 */
function laneRecordIds(rec: BacklogRecord, evs: LifecycleRecord[]): string[] {
  const ids = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v) ids.add(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && x) ids.add(x);
  };
  for (const e of evs) {
    for (const key of ["run_id", "run_ids", "whole_run_ids"]) add(e.attrs?.[key]);
    // the plan review writes its runs as objects with their role
    if (Array.isArray(e.attrs?.runs)) for (const r of e.attrs.runs) if (r && typeof r === "object") add((r as { run_id?: unknown }).run_id);
  }
  for (const kind of ["planner", "executor"] as const) {
    try {
      for (const s of readSessions(kind)) {
        if (s.idd_id !== rec.idd_id) continue;
        add(kind === "planner" ? s.planner_session_id : s.executor_session_id);
      }
    } catch { /* no session record: nothing to read */ }
  }
  return [...ids];
}

/** how one detection is told from another for "passed once": the run, the tool call it came from, and the mark */
function meansKey(m: MissingMeansFinding): string {
  return `${m.run}\u0000${m.call}\u0000${m.marker}`;
}

/** the detections earlier judgements were handed, read back from their own starting records */
function pastMissingMeans(evs: LifecycleRecord[]): MissingMeansFinding[] {
  const out: MissingMeansFinding[] = [];
  for (const e of evs) {
    if (!Array.isArray(e.attrs?.missing_means)) continue;
    for (const x of e.attrs!.missing_means as unknown[]) if (x && typeof x === "object") out.push(x as MissingMeansFinding);
  }
  return out;
}

/**
 * The marks this lane's own records show of a tool refusing the agent the means to look at something, for the
 * judgement about to start. A detection already handed to an earlier judgement is left out, so it is passed once.
 * A runtime that cannot read records, or a record that cannot be read, leaves the answer empty: the judgement starts.
 */
export function laneMissingMeans(rec: BacklogRecord, evs: LifecycleRecord[]): MissingMeansFinding[] {
  const runner = getAgentRunner();
  if (!runner?.missingMeans) return [];
  const ids = laneRecordIds(rec, evs);
  if (!ids.length) return [];
  let found: MissingMeansFinding[];
  try {
    found = runner.missingMeans({ ids, markers: missingMeansMarkers() });
  } catch {
    return [];
  }
  const seen = new Set(pastMissingMeans(evs).map(meansKey));
  return found.filter((m) => !seen.has(meansKey(m)));
}

/**
 * How a judgement weighs a detection. A lane that wrote its check as unverified is not doing the harm these marks
 * describe (writing that it saw what it did not), and a role with no means cannot be sent back to fix it; so a
 * detection meeting an unverified report is not a must. A judgement a detected run made about an image is not
 * evidence that anyone looked at it.
 */
const MISSING_MEANS_RULES = [
  "以下は、この lane の記録から Harness が機械で拾った検出である。道具が「その手段が無い」と断った、その道具自身の返事だけを拾っており、印の文を含む文書を読んだだけの結果は検出にならない。",
  "この lane の結果の報告がその確かめを未確認と書いている（確かめていない・報告の outcome が partial・残した気づき）なら、それに当たる検出を must にしない。正直に未確認と書いた lane は「見ていないものを見たと書く」害を出しておらず、見る手段の無い役に直させても直せない。",
  "検出に当たる run が出した絵（画像）についての判断は、見た根拠として扱わない。",
  "検出の path は場所に付いた指摘に使える（その file は run の作業場所の中にあり、repo からの相対 path である）。",
].join("\n");

/** the file a judgement reads the detections from, or undefined when there is nothing to hand over */
export function writeMissingMeansFile(iddId: string, round: number, kind: string, found: MissingMeansFinding[]): string | undefined {
  if (!found.length) return undefined;
  const file = join(stateDir(), "pipeline", "review", iddId, `missing-means-${round}-${kind}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    `# Harness が見つけた「手段が無い」（${round} 巡目、${kind}）`,
    "",
    MISSING_MEANS_RULES,
    "",
    ...found.map((m) => `- ${m.run}${m.role ? `（${m.role}）` : ""}${m.path ? ` ${m.path}` : ""}: ${m.tool} が ${m.marker} を断った — ${m.note}`),
    "",
  ].join("\n"));
  return file;
}

/** the findings a person's lane keeps on the record for their submit card: severity, claim and where */
function deviceFindings(findings: { severity: string; path?: string; claim: string }[]): { severity: string; claim: string; path?: string }[] {
  return findings.filter((f) => f.severity === "must" || f.severity === "should").map((f) => ({ severity: f.severity, claim: f.claim, ...(f.path ? { path: f.path } : {}) }));
}

/**
 * The file the picture-viewing role reads first: the lane's overall statement, the judge, and the pictures to open.
 * Written where the stage reads its inputs, so the role sees the same statement and the same set of pictures the
 * stage decided from (the pictures are named absolute, since a copy of the head is the role's worktree).
 */
function writeDeviceStatement(iddId: string, round: number, v: { judge: "viewer" | "human"; statement: string; pictures: string[]; stale?: string }): string {
  const file = join(stateDir(), "pipeline", "review", iddId, `device-${round}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    `# この lane の全体 1 文（判定者: ${v.judge === "human" ? "人" : "絵を見る役"}）`,
    "",
    v.statement || "（qa.md に全体 1 文がありません）",
    "",
    "compare/ の絵（実装の絵と prototype の絵）を read で開いて、全体 1 文と見比べる。",
    ...(v.stale ? ["", `注意: ${v.stale}。この絵は今の head の画面を撮ったものとは言えない。`] : []),
    "",
    ...v.pictures.map((p) => `- ${p}`),
    "",
  ].join("\n"));
  return file;
}

/**
 * The review-format report of a must the stage writes itself, when the pictures that are the judging input are
 * missing or cannot be said to be of the head's screen. It is handed to the judgement like any other finding, so
 * the lane is sent to a fix instead of being passed with nothing looked at.
 */
function writeDeviceMust(iddId: string, round: number, claim: string): string {
  const dir = join(stateDir(), "pipeline", "review", iddId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `device-must-${round}.json`);
  writeFileSync(file, `${JSON.stringify({ findings: [{ severity: "must", path: "", line: null, claim, evidence: "", is_guess: false }] }, null, 2)}\n`);
  return file;
}

/** a list of refs next to the batch of feedback the pass began with (next to the lane's reviews in an S2 pass) */
function writeRefList(events: LifecycleRecord[], iddId: string, name: string, title: string, items: AcceptedItem[]): string {
  const received = feedbackPassAt(events) >= 0 ? lastOf(events, "s4_review_comment_received") : undefined;
  const first = strs(received?.attrs?.files)[0];
  const dir = first ? dirname(first) : join(stateDir(), "pipeline", received ? "feedback" : "review", iddId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, [
    `# ${title}`,
    "",
    ...items.map((a) => `- ${a.ref}（${a.severity}）${a.path ? ` ${a.path}` : ""}: ${a.claim}`),
    "",
  ].join("\n"));
  return file;
}

const TRIAGE_LABEL: Record<string, string> = {
  blind: "レビューの判定", final: "最後のレビューの判定", confirm: "確認の残りの判定", feedback: "PR の指摘の判定", device: "絵の見比べの判定",
};

/** who reads the list of the fixes earlier rounds sent: the judgement that writes `prior` by ref, or the fix planner */
export type TriageHistoryFor = "triage" | "fix_plan";

/**
 * What the earlier judgements sent to the fix, and what penne decided when a finding reversed one of those
 * fixes: the triage reads it to tell such a reversal and to judge by penne's boundary. Each entry is named
 * `<round>-<kind>/<ref>`, so a reversal can point back at it. Nothing to hand over gives null.
 *
 * The fix planner reads the same list for another purpose: it must not break a fix an earlier round made, and its
 * own fix is not among those yet. Its heading says so and never mentions `reverts`, which is the judgement's word.
 */
export function triageHistory(events: LifecycleRecord[], audience: TriageHistoryFor = "triage"): string | null {
  const { triages, idOf } = triageIds(events);
  const fixed: string[] = [];
  for (const [n, i] of triages.entries()) {
    const a = events[i].attrs ?? {};
    const round = Number(a.round ?? 0) || 0;
    const kind = String(a.kind ?? "blind");
    const id = idOf.get(i) ?? `${round}-${kind}`;
    const fix = events.slice(i + 1, triages[n + 1] ?? events.length).find((e) => e.event === "s2_fix_sent");
    if (!fix) continue;
    // what the fix carried; a record from before the refs were written falls back to what that triage fixes.
    // A depth-bearing round scopes its refs by this judgement's round and kind, as the fix does
    const refs = Array.isArray(fix.attrs?.refs) ? new Set(strs(fix.attrs.refs)) : undefined;
    const all = s4Triage(events, i);
    const deep = passPolicy(events, i).depth !== undefined;
    const carried = (x: { ref: string }) => (deep ? refKey(x.ref, { round, kind }) : x.ref);
    const sent = acceptedOf(a).filter((x) => (refs ? refs.has(carried(x)) : all ? fixesNow(x) : x.severity !== "nit" && fixesNow(x)));
    if (!sent.length) continue;
    fixed.push(`## ${id}（${round} 巡目、${TRIAGE_LABEL[kind] ?? kind}）`, "");
    for (const x of sent) {
      fixed.push(`- ${deep ? refKey(x.ref, { round, kind }) : `${id}/${x.ref}`}（${x.severity}）${x.path ?? ""}: ${x.claim}`);
      if (x.fix) fixed.push(`  - 修正の指示: ${x.fix}`);
    }
    fixed.push("");
  }
  const { decided, corrected, answered } = penneAnswers(events, triages, idOf);
  if (!fixed.length && !decided.length && !corrected.length && !answered.length) return null;
  const correctedSection = corrected.length ? ["## penne の訂正", "", ...corrected.map((c) => c.line), ""] : [];
  const answeredSection = answered.length ? ["## penne が答えた判定の問い", "", ...answered, ""] : [];
  if (audience === "fix_plan") {
    return [
      "# 前の巡までに修正に回した指摘と penne の決定",
      "",
      "今回の直しが、これらの直しと penne の決めた境目を崩さないようにする。後に回す・見送ると訂正された指摘は、この直しで手を入れない。",
      "",
      ...fixed,
      ...(decided.length ? ["## penne の決定", "", ...decided, ""] : []),
      ...correctedSection,
      ...answeredSection,
    ].join("\n");
  }
  return [
    "# これまでの判定で修正に回した指摘と penne の決定",
    "",
    "今回の指摘が、ここにある指摘と同じ箇所・同じ性質で逆向きの要求なら、修正の往復として reverts に ref（例: 2-final/F-1）を書く。",
    "「penne の訂正」にある指摘と同じ性質の指摘は、人が重さと対応を決めた指摘である。受理せず rejected に入れ、reason に訂正の ref を引く。往復と訂正が食い違うときは訂正に従う。",
    "訂正済みの指摘を受理に残す場合は、その指摘の correction_ref に訂正の ref を書く（その訂正の重さと対応で数えられる）。",
    ...(answered.length ? [`「penne が答えた判定の問い」は、前の判定が escalate で人に尋ね、人が答えた問いである。答えた問いと同じことを尋ねる問いを escalate にしない。答えをこの lane の仕様として、受理か棄却かを決める（答えと食い違う実装への指摘は受理し、答えどおりの実装に答えと逆を求める指摘は棄却して reason に問いの ref を引く）。${ANSWER_SCOPE}答えを、それ以外の指摘を受理する根拠にも棄却する根拠にもしない。`] : []),
    "",
    ...fixed,
    ...(decided.length ? ["## penne の決定", "", ...decided, ""] : []),
    ...correctedSection,
    ...answeredSection,
  ].join("\n");
}

/** the judgements of the loop in order, each named `<round>-<kind>` (a second one of the same round and kind `#2`) */
function triageIds(events: LifecycleRecord[]): { triages: number[]; idOf: Map<number, string> } {
  const triages = events.flatMap((e, i) => (e.event === "s2_triage_done" && !e.attrs?.failed ? [i] : []));
  const idOf = new Map<number, string>();
  for (const i of triages) {
    const a = events[i].attrs ?? {};
    const round = Number(a.round ?? 0) || 0;
    const kind = String(a.kind ?? "blind");
    let id = `${round}-${kind}`;
    for (let k = 2; [...idOf.values()].includes(id); k += 1) id = `${round}-${kind}#${k}`;
    idOf.set(i, id);
  }
  return { triages, idOf };
}

/** how far an answer reaches, said to every reader of the answers: the part that answers its question, nothing beyond */
const ANSWER_SCOPE = "答えは、その問いに答えた部分だけを読み、問いの外の部分は答えとして読まない。";

/** a text laid on a list line: each line after its first is indented under the item, so a line break stays inside it */
const underItem = (text: string, indent: string): string => text.replace(/\r?\n/g, `\n${indent}`);

/**
 * What penne decided on the loop's stuck cards, each named by the judgement whose stop it answered: the boundaries set
 * on reversals and the weight and handling set on a finding. Only the answers after the lane's last return to its plan
 * count: a plan written again is judged on its own rounds, and a line drawn on the plan it replaced does not bind them.
 * The note written with an answer is not one of these: it was an instruction to the executor (cadf31509). Only where the
 * stop's judgement had put a question to penne is the note that question's answer, and the answer is read from the
 * structured record the card wrote for it (`answers`, each with its question), never from the note.
 */
function penneAnswers(events: LifecycleRecord[], triages: number[], idOf: Map<number, string>): { decided: string[]; corrected: { line: string; action: string }[]; answered: string[] } {
  const decided: string[] = [];
  const corrected: { line: string; action: string }[] = [];
  const answered: string[] = [];
  const from = lastReturnToPlan(events);
  for (let i = from + 1; i < events.length; i += 1) {
    if (events[i].event !== "s2_review_resumed") continue;
    const t = triages.filter((j) => j > from && j < i).pop();
    const id = t === undefined ? "" : idOf.get(t) ?? "";
    // the weight and handling penne set on a finding of the stuck card: they stand for the rest of the plan's rounds, so
    // the judgement does not accept the same finding again and the fix does not take a finding penne put off
    if (t !== undefined) {
      for (const c of correctionsOf(events[i].attrs)) {
        const item = acceptedAt(events, t).find((x) => x.ref === c.ref);
        const handling = c.action === "fix" ? "この変更で直す" : c.action === "followup" ? "後に回す（follow-up）" : "見送る";
        corrected.push({ action: c.action, line: `- ${c.ref}（${c.severity}、${handling}）${item?.path ?? ""}: ${item?.claim ?? ""}${c.reason ? `\n  - 理由: ${c.reason}` : ""}` });
      }
    }
    // a continue after a failure only retried a stage: it decided nothing
    const prior = reviewLoopState(events.slice(0, i));
    if (prior.state !== "escalated" || prior.retry) continue;
    // only the boundaries penne set on reversals bind later judgements; any other note was an instruction to the executor
    const reversals = t === undefined ? [] : oscillationsOf(events[t].attrs);
    for (const b of boundariesOf(events[i].attrs)) {
      const o = reversals.find((r) => r.ref === b.ref);
      decided.push(`- ${id}/${b.ref}${o ? `（${o.prior_ref} を打ち消す指摘: ${o.claim}）` : ""}: ${b.text}`);
    }
    // the question the judgement put to penne, with the answer she gave on the card: only where the stop asked it, read
    // as the write and the card read it (no judgement of the plan as it stands, a retry, two questions or a reversal
    // asked none), so a hand-written answer elsewhere is not taken
    if (t === undefined) continue;
    const asked = questionAnsweredByNote(events.slice(0, i), prior);
    for (const a of answeredQuestionsOf(events[i].attrs)) {
      if (!asked.some((q) => q.ref === a.ref)) continue;
      answered.push(`- ${id}/${a.ref}: ${underItem(a.question, "  ")}\n  - 答え: ${underItem(a.text, "    ")}`);
    }
  }
  return { decided, corrected, answered };
}

/**
 * The lines penne drew on the loop's stuck cards, for the spec check of every later round of the same plan: the
 * boundaries set on reversals, and the findings penne put off or skipped (ref, claim, reason). The spec check is still
 * not told what an earlier round found or fixed (C-223-2): a finding penne closed is the lane's scope, decided by a
 * person, and a check that does not know it asks for the same thing again (IDD-290's rounds 4 and 5). A correction
 * that sends a finding to the fix draws no line, and the free note of an answer is not handed on (cadf31509). The
 * questions a judgement put to penne are, with the answers the card recorded for them: they are the lane's spec decided
 * by a person, and a check that does not know them asks penne the same question again (IDD-292's rounds 4 and 6). The
 * blind is never handed this (DEC-113-5); the judgement holds the line for it. Nothing penne decided gives null.
 */
export function humanLines(events: LifecycleRecord[]): string | null {
  const { triages, idOf } = triageIds(events);
  const { decided, corrected, answered } = penneAnswers(events, triages, idOf);
  const closed = corrected.filter((c) => c.action === "skip" || c.action === "followup").map((c) => c.line);
  if (!decided.length && !closed.length && !answered.length) return null;
  return [
    "# 人が決めた線引き",
    "",
    "この lane の巡が止まったとき、人が card で決めたこと。計画と受け入れ条件と同じく、この lane の仕様として読む。",
    "- 人が見送る・後に回すと決めた指摘と同じ性質のもの（場所や語が違っても、同じ問題を言っているもの）は、再び指摘にしない。指摘しても判定は受理しない。",
    "- 境目は、前の巡の修正を打ち消す指摘に人が決めた立場である。それと逆を求める指摘を出さない。",
    ...(answered.length ? [`- 答えた判定の問いは、判定が人に尋ね、人が答えた仕様の判断である。答えをこの lane の仕様として読み、答えと逆を求める指摘や、答えた問いと同じことを人に尋ねる指摘を出さない。${ANSWER_SCOPE}答えを、それ以外の指摘を出す根拠にも出さない根拠にもしない。`] : []),
    "- これは前の巡の指摘の一覧ではない。ここに無い所は、この巡の差分だけから判断する。",
    "",
    ...(decided.length ? ["## 境目（修正の往復への決定）", "", ...decided, ""] : []),
    ...(closed.length ? ["## 見送る・後に回すと決めた指摘", "", ...closed, ""] : []),
    ...(answered.length ? ["## 人が答えた判定の問い", "", ...answered, ""] : []),
  ].join("\n");
}

/** the lane's worktree, the commit its work started from, and its head now: what every stage of the loop reads */
export function laneRevs(iddId: string, events: LifecycleRecord[]): { worktree: string; base: string; head: string } {
  const worktree = readSessions("executor").filter((r) => r.idd_id === iddId).pop()?.worktree_path;
  // where S2 started, moved on by the base received since (the base's changes are not the lane's)
  const base = reviewBaseOf(events);
  if (!worktree || !base) throw new Error("executor の worktree か開始 commit が記録にありません");
  const head = headCommit(worktree);
  if (!head) throw new Error(`worktree の HEAD を読めません: ${worktree}`);
  return { worktree, base, head };
}

/**
 * The repo's overview: the top-level Purpose's statement, handed to a diff reviewer so it knows what the repo is
 * about without being pulled toward any one Choice (DEC-113-5). Undefined when the repo has no such Purpose.
 */
function laneOverview(area: string): string | undefined {
  try {
    const folded = foldRows(readRows(intentColumnPath(area)), null, laneStates(readLifecycle()));
    const top = folded.purposes.find((p) => p.id === "P-1" && p.status === "active");
    return top?.statement?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** the lane's worktree, or undefined before an executor session has run */
function laneWorktreePath(iddId: string): string | undefined {
  return readSessions("executor").filter((r) => r.idd_id === iddId).pop()?.worktree_path;
}

/** the lane's work instruction as its worktree holds it, read by the stages that take their shape from its presence (DEC-2647) */
function lanePlanOf(iddId: string, rec: BacklogRecord): LanePlan | undefined {
  const worktree = laneWorktreePath(iddId);
  return worktree ? lanePlanDoc(rec, worktree) : undefined;
}

/**
 * Whether the lane has not begun its review yet: no map, no blind, and no skip. The mainline merge before the review
 * is done only there; a later round's start (the final review, the round after a conflict send-back) is left alone.
 */
function beforeFirstReview(events: LifecycleRecord[]): boolean {
  return !events.some((e) => e.event === "s2_review_started" || e.event === "s2_map_started" || e.event === "s2_review_skipped");
}

type PreMergeAction = "none" | "proceed" | "busy" | "awaiting" | "merged";
interface PreMergeResult { action: PreMergeAction; records: LifecycleRecord[]; error?: string }

/** a record this module appended, mirrored onto the caller's snapshot so the rest of the tick reads the new state */
const preMergeRecord = (iddId: string, event: string, attrs: Record<string, unknown>): LifecycleRecord => ({ event, idd_id: iddId, at: new Date().toISOString(), attrs });

/** the mark a lane writes while it waits for the executor's work to stop, before a review stage its result began */
export const EXECUTOR_WAIT_EVENT = "s2_executor_waiting";

/** the mark of the first look that found the executor stopped after a wait: the stall clock starts counting from it */
export const EXECUTOR_WAIT_END_EVENT = "s2_executor_wait_ended";

/**
 * The time the lane's head last changed for the executor's own work: the head commit's own time, or the head the
 * lane held before a harness merge the record names. The harness's own pre-review merge is not the executor moving
 * on, so reading its commit time would restart the wait on the harness's act (Issue #159).
 */
function headWorkTime(worktree: string, head: string, events: LifecycleRecord[]): number | undefined {
  let target = head;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.event !== "s2_review_base_merged") continue;
    if (e.attrs?.by === "harness" && String(e.attrs?.merge_commit ?? "") === head) target = String(e.attrs?.head ?? head);
    break;
  }
  try {
    const n = Number(git(worktree, ["log", "-1", "--format=%ct", target]).trim());
    return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why a review stage the executor's result began has to wait, or undefined when it may start: the executor's
 * conversation in the lane's worktree is still answering, or the lane's head has not held still for the policy's
 * seconds. The clock is the later of the result's own time and the head's own change, so a commit or a fresh report
 * while waiting starts it over. A runtime that cannot say whether a conversation is answering waits on the head
 * alone; a worktree that cannot be read does not wait (the stage then fails the step as it always did).
 */
export function executorWait(iddId: string, events: LifecycleRecord[], stillSeconds: number, tickNow: number): { reason: string; head: string } | undefined {
  if (stillSeconds <= 0) return undefined;
  let at: { worktree: string; head: string };
  try { at = laneRevs(iddId, events); } catch { return undefined; }
  const runner = getAgentRunner();
  if (runner?.cwdBusy) {
    try { if (runner.cwdBusy(at.worktree)) return { reason: "実装役の会話が応答中", head: at.head }; } catch { /* cannot tell: the head still decides */ }
  }
  const result = [...events].reverse().find((e) => e.event === "s2_result");
  const resultAt = result ? Date.parse(result.at) : NaN;
  const lastChange = Math.max(Number.isFinite(resultAt) ? resultAt : 0, headWorkTime(at.worktree, at.head, events) ?? 0);
  if (lastChange && tickNow - lastChange < stillSeconds * 1000) return { reason: "実装役の head がまだ動いている", head: at.head };
  return undefined;
}

/** whether the lane's last wait mark has no end after it: the executor was last seen working and not yet seen stopped */
function waitIsOpen(events: LifecycleRecord[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event === EXECUTOR_WAIT_END_EVENT) return false;
    if (events[i].event === EXECUTOR_WAIT_EVENT) return true;
  }
  return false;
}

/**
 * record a wait once per head and reason, so a lane held across ticks leaves one mark and not a row per tick. A wait
 * that came after an end is a new one and is marked even when it reads the same, so the end it follows is not left as
 * the last word on a lane that is working again.
 */
async function recordExecutorWait(iddId: string, events: LifecycleRecord[], wait: { reason: string; head: string }): Promise<void> {
  const prev = [...events].reverse().find((e) => e.event === EXECUTOR_WAIT_EVENT);
  if (waitIsOpen(events) && prev?.attrs?.reason === wait.reason && prev.attrs?.head === wait.head) return;
  const attrs: Record<string, unknown> = { reason: wait.reason, head: wait.head };
  await appendLifecycle(EXECUTOR_WAIT_EVENT, iddId, attrs);
  events.push(preMergeRecord(iddId, EXECUTOR_WAIT_EVENT, attrs));
}

/**
 * Mark the first look that found the executor stopped after a wait the lane recorded. The wait mark's time is where
 * the wait began, so the stall clock counts from this one (the executor's own time is not the engine's). Once per
 * wait: nothing is written for a lane with no open wait.
 */
async function recordExecutorWaitEnd(iddId: string, events: LifecycleRecord[]): Promise<void> {
  if (!waitIsOpen(events)) return;
  const last = [...events].reverse().find((e) => e.event === EXECUTOR_WAIT_EVENT);
  const attrs: Record<string, unknown> = { head: String(last?.attrs?.head ?? "") };
  await appendLifecycle(EXECUTOR_WAIT_END_EVENT, iddId, attrs);
  events.push(preMergeRecord(iddId, EXECUTOR_WAIT_END_EVENT, attrs));
}

/** the reason the pre-review merge's own wait is marked with: the end it gets is only for a wait of this reason */
const PRE_MERGE_WAIT_REASON = "レビュー前の merge が実装役の会話の応答を待っている";

/**
 * Mark what the pre-review merge found of the executor. A merge held back because the executor's conversation is at
 * work in the worktree is a wait like the stage's own, so the stall clock must not count it: it is marked, and the first
 * look that finds the executor no longer at work gives the wait its end. Only a wait this merge marked is ended here;
 * the stage's own wait is ended by the stage.
 */
async function markPreMergeWait(iddId: string, events: LifecycleRecord[], action: PreMergeAction): Promise<void> {
  if (action === "busy") {
    let head = "";
    try { head = laneRevs(iddId, events).head; } catch { /* the mark goes without the head */ }
    await recordExecutorWait(iddId, events, { reason: PRE_MERGE_WAIT_REASON, head });
    return;
  }
  const last = [...events].reverse().find((e) => e.event === EXECUTOR_WAIT_EVENT);
  if (last?.attrs?.reason === PRE_MERGE_WAIT_REASON) await recordExecutorWaitEnd(iddId, events);
}

/**
 * Hold a stage that reads the executor's head while the executor is still working: the wait is marked and the answer is
 * true. When the executor has stopped the answer is false and the wait the lane recorded (if any) gets its end, so
 * every stage gated by the wait ends it by the same call.
 */
async function holdOnExecutor(iddId: string, events: LifecycleRecord[], stillSeconds: number, tickNow: number): Promise<boolean> {
  const wait = executorWait(iddId, events, stillSeconds, tickNow);
  if (wait) {
    await recordExecutorWait(iddId, events, wait);
    return true;
  }
  await recordExecutorWaitEnd(iddId, events);
  return false;
}

/**
 * Whether a merge that did not conflict has a declared generated file to make again: one changed on either side since
 * the merge base. A declaration with no such change makes nothing again; a base git cannot give counts as touched, and
 * the rebuild that follows falls back by itself when it cannot be made.
 */
function touchesGenerated(work: string, head: string, mainTip: string, outputs: Parameters<typeof generatedTouched>[4]): boolean {
  if (!outputs.length) return false;
  try { return generatedTouched(work, git(work, ["merge-base", head, mainTip]).trim(), mainTip, head, outputs); } catch { return true; }
}

/**
 * Take the work mainline into a lane before its first review, the way the base receive does: no checkout, a merge-tree
 * whose result is made a commit with the lane's head and the mainline tip as parents and moved on by a fast-forward.
 * The head is left alone when it already carries the mainline; the review origin is still advanced unless it already
 * carries it. A conflict is put to the executor once (the send-back's words), and the lane waits for its result; a
 * later look that still conflicts only records it and lets the review begin. Anything that keeps the merge from being
 * made is recorded and the review goes on: this merge forwards conflicts, it does not hold the review. A session at
 * work in the lane's worktree is waited out, but only while a merge is actually needed. Read-only for the lane when
 * nothing is needed; only a repo that does not publish and a lane on the work branch are touched.
 */
async function preReviewMerge(iddId: string, events: LifecycleRecord[]): Promise<PreMergeResult> {
  // the lane's place and base: the fold reads these as facts, so a repo that publishes, a lane with no place or work
  // base, a base that is a parent or an external copy, and a lane without a review origin decide the same way here
  // as they did in this function (C-205-5)
  let loc: ReturnType<typeof laneLocations> | undefined;
  try { loc = laneLocations(iddId); } catch { loc = undefined; }
  let base: ReturnType<typeof laneBaseOf> | undefined;
  try { base = loc ? laneBaseOf(iddId) : undefined; } catch { base = undefined; }
  const priorBase = reviewBaseOf(events);
  const runner = getAgentRunner();
  const workBase = loc?.config.work_base ?? "";
  const main = loc?.config.local_path ?? "";
  let head = "";
  let mainTip = "";
  let release: (() => void) | undefined;
  const records: LifecycleRecord[] = [];
  const facts: Record<string, unknown> = {};

  /** the readings of the outside world: git, the runner, and the lane's own place */
  const observer = (need: FactNeed, put: (id: string, value: unknown) => void): unknown => {
    if (!loc) return false;
    const place = loc;
    switch (need.kind) {
      case "hasLocation": return true;
      case "publishes": return publishes(place.config);
      case "hasLocalPath": return Boolean(place.config.local_path);
      case "hasWorkBase": return Boolean(place.config.work_base);
      case "baseReadable":
        return Boolean(base) && !("error" in (base as object))
          && !(base as { parent?: unknown }).parent && !(base as { external?: unknown }).external;
      case "hasReviewBase": return Boolean(priorBase);
      case "head": {
        // both commits are read in one try, as they were: one failure carries one text
        try {
          head = sha(place.work);
          mainTip = git(main, ["rev-parse", `refs/heads/${workBase}`]).trim();
          put("mainTip||", mainTip);
          return head;
        } catch (err) {
          put("readError||", String((err as Error).message).slice(0, 200));
          put("mainTip||", "");
          return "";
        }
      }
      case "mainTip": return "";
      case "ancestor": {
        try {
          return { headHas: isAncestor(place.work, mainTip, head), baseHas: isAncestor(place.work, mainTip, priorBase) };
        } catch (err) {
          put("ancestorError||", String((err as Error).message).slice(0, 200));
          return null;
        }
      }
      case "runnerPresent": return Boolean(runner?.cwdBusy);
      case "busy": {
        try {
          return Boolean(runner?.cwdBusy?.(place.work));
        } catch (err) {
          put("busyError||", String((err as Error).message).slice(0, 200));
          return null;
        }
      }
      default: return null;
    }
  };

  const slice = (err: unknown) => String((err as Error).message ?? err).slice(0, 200);

  /** the review origin's move, past a mainline commit the lane's head already carries (DEC-2404) */
  const advanceOrigin = async (): Promise<unknown> => {
    let mainline: string;
    try { mainline = git(loc!.work, ["merge-base", head, mainTip]).trim(); } catch { return null; }
    if (!mainline || mainline === head) return null;
    try { if (isAncestor(loc!.work, mainline, priorBase)) return null; } catch { return null; }
    let reviewBase: string;
    try { reviewBase = mergedReviewBase(loc!.work, iddId, priorBase, mainline); } catch { return null; }
    const attrs: Record<string, unknown> = { head, mainline, merge_base: priorBase, review_base: reviewBase, by: "executor" };
    try {
      await withLaneGate(async () => { if (sha(loc!.work) !== head) throw new Error("lane の head が変わりました"); await appendLifecycle("s2_review_base_merged", iddId, attrs); });
    } catch { return null; }
    records.push(preMergeRecord(iddId, "s2_review_base_merged", attrs));
    return null;
  };

  const outcome = await drivePreMerge(events, facts, observer, {
    write: async (event, attrs) => {
      // the merge's own record is written as it was: a record that cannot be written leaves the review going on
      try { await appendLifecycle(event, iddId, attrs); } catch { /* the answer goes on; the next tick looks again */ }
      const row = preMergeRecord(iddId, event, attrs);
      records.push(row);
      return row;
    },
    call: async (step) => {
      try {
        switch (`${step.helper}|${step.site}`) {
          case "lock_lane|merge": {
            try { release = lock(loc!.work); return { held: true }; } catch (err) { return { held: false, error: slice(err) }; }
          }
          case "read_merge_state|merge": {
            const isClean = clean(loc!.work);
            const onBranch = git(loc!.work, ["branch", "--show-current"]).trim() === loc!.branch;
            const headStill = sha(loc!.work) === head;
            // the merged tree is kept whether or not git called it a conflict: the generated files are made again from it
            let out: string;
            let conflict = false;
            try {
              out = git(loc!.work, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", head, mainTip]);
            } catch (err) {
              out = String((err as { stdout?: string }).stdout ?? "");
              if (!parseMergeTree(out)) return { clean: isClean, onBranch, headStill, unreadable: true, mergeError: slice(err) };
              conflict = true;
            }
            const merged = parseMergeTree(out);
            if (!merged) return { clean: isClean, onBranch, headStill, unreadable: true, mergeError: "merge-tree の出力を読めません" };
            // the declaration is read here once for this pass: the classification below and the rebuild that follows both
            // go by these files, and the fold hands them back to the rebuild, so a declaration that changes in between
            // cannot make a tree with conflict markers in it pass for a rebuilt one
            const outputs = generatedFilesOf(loc!.area);
            if (conflict) {
              return { clean: isClean, onBranch, headStill, conflict: true, files: merged.files, tree: merged.tree, outputs, generatedOnly: generatedOnlyConflict(merged.files, outputs) };
            }
            return { clean: isClean, onBranch, headStill, conflict: false, files: [], tree: merged.tree, outputs, rebuild: touchesGenerated(loc!.work, head, mainTip, outputs) };
          }
          case "rebuild_generated|merge": {
            // made from the merged tree's own sources, in a worktree of its own; the dependencies are the work clone's.
            // The files are the ones the classification went by: an answer without them is no rebuild, not an empty one
            try {
              const outputs = step.args?.outputs;
              if (!Array.isArray(outputs) || outputs.length === 0 || !outputs.every((o) => o && Array.isArray(o.paths) && Array.isArray(o.command))) {
                return { failure: { cause: "environment", reason: "作り直す生成物の宣言が渡されませんでした", paths: [] } };
              }
              const rebuilt = await rebuildGenerated({ cwd: main, tree: String(step.args?.tree ?? ""), outputs: outputs as GeneratedFiles[], deps: join(main, "node_modules") });
              return "failure" in rebuilt ? { failure: rebuilt.failure } : { tree: rebuilt.tree, changed: rebuilt.changed };
            } catch (err) { return { failure: { cause: "environment", reason: slice(err), paths: [] } }; }
          }
          case "advance_origin|skip":
          case "advance_origin|conflict":
            return await advanceOrigin();
          case "review_base|head_has":
          case "review_base|merge": {
            try { return { reviewBase: mergedReviewBase(loc!.work, iddId, priorBase, mainTip) }; } catch (err) { return { error: slice(err) }; }
          }
          case "record_executor_merge|head_has": {
            // the executor merged the mainline itself: only the review origin moves
            const attrs: Record<string, unknown> = { head, mainline: mainTip, merge_base: priorBase, review_base: step.args?.reviewBase, by: "executor" };
            try {
              await withLaneGate(async () => { if (sha(loc!.work) !== head) throw new Error("lane の head が変わりました"); await appendLifecycle("s2_review_base_merged", iddId, attrs); });
            } catch (err) { return { error: slice(err) }; }
            records.push(preMergeRecord(iddId, "s2_review_base_merged", attrs));
            return { ok: true };
          }
          case "conflict_envelope|conflict": {
            // the instruction is sent once per lane: the executor is handed the merge to resolve, and the review waits
            const files = Array.isArray(step.args?.files) ? (step.args.files as string[]) : [];
            const instruction = `work 側の本流（${workBase}）を lane に merge して衝突を解き、commit してください。rebase は使わないでください。衝突したファイル: ${files.length ? files.join(", ") : "（本流の merge で確かめてください）"}`;
            try {
              await queueEnvelope(iddId, "lane_rejected", laneRejectedEnvelope(iddId, instruction, false), { skipFixPlan: true });
            } catch (err) { return { error: slice(err) }; }
            return { ok: true };
          }
          case "merge_mainline|merge": {
            const reviewBase = String(step.args?.reviewBase ?? "");
            const mergeCommit = commitTree(loc!.work, String(step.args?.tree ?? ""), [head, mainTip], "chore: merge mainline before review");
            const attrs: Record<string, unknown> = { head, mainline: mainTip, merge_base: priorBase, merge_commit: mergeCommit, review_base: reviewBase, by: "harness", ...(step.args?.rebuildFailure ? { rebuild_failure: step.args.rebuildFailure } : {}) };
            try {
              await withLaneGate(async () => {
                if (sha(loc!.work) !== head || !clean(loc!.work)) throw new Error("merge の間に lane が変わりました");
                git(loc!.work, ["merge", "--ff-only", mergeCommit]);
                await appendLifecycle("s2_review_base_merged", iddId, attrs);
              });
            } catch (err) { return { error: slice(err) }; }
            records.push(preMergeRecord(iddId, "s2_review_base_merged", attrs));
            return { ok: true };
          }
          default: return { error: `知らない helper: ${String(step.helper)}` };
        }
      } finally {
        release = release ?? undefined;
      }
    },
    done: () => { release?.(); release = undefined; },
  });
  return { action: outcome.action, records, ...(outcome.error ? { error: outcome.error } : {}) };
}

/**
 * Move the review origin past a mainline commit the lane's head took in since the origin was last set, before the
 * round that reads it starts. The executor may merge the mainline between rounds; without this the origin stays where
 * the first review left it, and what the mainline brought is read as the lane's change. The origin goes to the commit
 * the head carries (never the mainline's tip), is built as every other origin move is, and is recorded under a name of
 * its own, so every reader of the origin reads the same one. Nothing is written when the origin already carries it.
 * The answer is what the caller needs to start the round or not: "carried" when the origin has it (written now or
 * before), "failed" when it cannot be told that it does (a git answer missing, the head moved, the record not written),
 * and the round is not started on an origin that may lack what the head took in; the next look tries again.
 */
async function catchUpReviewBase(iddId: string, events: LifecycleRecord[]): Promise<"carried" | "failed"> {
  try {
    const at = laneRevs(iddId, events);
    const taken = takenMainline(at.worktree, iddId, at.base, at.head);
    if (taken.kind === "unknown") return "failed";
    if (taken.kind === "carried") return "carried";
    const mainline = taken.mainline;
    const reviewBase = mergedReviewBase(at.worktree, iddId, at.base, mainline);
    const attrs: Record<string, unknown> = { head: at.head, mainline, merge_base: at.base, review_base: reviewBase, by: "executor" };
    await withLaneGate(async () => {
      if (sha(at.worktree) !== at.head) throw new Error("lane の head が変わりました");
      await appendLifecycle(ORIGIN_CAUGHT_UP_EVENT, iddId, attrs);
    });
    events.push(preMergeRecord(iddId, ORIGIN_CAUGHT_UP_EVENT, attrs));
    return "carried";
  } catch {
    return "failed";
  }
}

/** One note a stage reads, written under the lane's review directory; the name and the lines are the caller's. */
function writeReviewNote(iddId: string, name: string, lines: string[]): string {
  const file = join(stateDir(), "pipeline", "review", iddId, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n"));
  return file;
}

/**
 * The written follow-ups a conflict scope round's judgement is handed: same words on the same file are
 * counted as already reported, whatever their wording differs from the finding. Written where the stage reads it.
 */
function writeExistingFollowups(iddId: string, round: number, kind: string, items: { severity: string; claim: string; path?: string }[]): string {
  return writeReviewNote(iddId, `existing-followups-${round}-${kind}.md`, [
    `# 既に TODO に書いた follow-up（${round} 巡目）`,
    "",
    "この一覧と同じ内容の指摘は、既出として扱い、follow-up にしない。",
    "",
    ...items.map((i) => `- ${i.severity} ${i.path ?? ""}: ${i.claim}`),
    "",
  ]);
}

/**
 * The follow-up Issue drafts this lane raised, written where the judgement reads them. The file is written even when
 * there are none, and says so: a judgement that finds no list cannot tell "no draft" from "no list was handed", and
 * must not take an old form as recorded on the strength of a pointer to a draft nobody can see.
 */
function writeLaneFollowupDrafts(iddId: string, round: number, kind: string, drafts: { id: string; title: string; body: string; status: string; url?: string }[]): string {
  return writeReviewNote(iddId, `followup-issues-${round}-${kind}.md`, [
    `# この lane が起こした後続の Issue の案（${round} 巡目）`,
    "",
    "投稿の前の案を含み、破棄された案は含まない。後続の Issue の案が実在するかは、この一覧だけで決める。案の本文に R9 の記録を求めるのは、記録の形が docs の lane だけ。",
    "",
    ...(drafts.length
      ? drafts.flatMap((d) => [`## ${d.id} ${d.title}（${d.status}${d.url ? ` ${d.url}` : ""}）`, "", d.body.trim(), ""])
      : ["なし（この lane が起こした後続の Issue の案は 1 件も無い）", ""]),
  ]);
}

/**
 * What the stuck card's buttons do, from the transition the loop then runs: continue as it is, continue with a
 * note (a note goes with a fix), and go on as it is. Undefined when the lane is not waiting for penne in the loop.
 *
 * The four choices come out of one answer from the fold: the same rows and the same observations, read once, so
 * the card and the loop read the same answer (C-200-3). The lane's head is read only by an answer that reaches the
 * final review, and its Risk only when the fold says it cannot decide without it: a lane the loop stopped at
 * elsewhere costs no git and no Risk.
 */
export function stuckOutcomes(lane: string | BacklogRecord, events: LifecycleRecord[]): { continue: StuckOutcome; continueWithNote: StuckOutcome; accept: StuckOutcome; handFix: StuckOutcome; replan: StuckOutcome } | undefined {
  const iddId = typeof lane === "string" ? lane : lane.idd_id;
  // the card reads the lane's Risk as the loop does (it decides whether the final review may be skipped)
  const rec = typeof lane === "string" ? readBacklog().find((r) => r.idd_id === lane) : lane;
  const policy = reviewPolicy();
  const newHigh = policy.highRiskWhen === "last" && policy.extras.high_risk > 0;
  // a worktree the loop cannot read makes it fail the step, never skip the final review; it is read on the first
  // fact that needs it, so a lane the answer never takes to the final reads no git at all
  let at: { worktree: string; base: string; head: string } | undefined;
  let looked = false;
  const look = () => {
    if (!looked) {
      looked = true;
      try { at = laneRevs(iddId, events); } catch { at = undefined; }
    }
    return at;
  };
  const answer = judgeSync<{ continue?: StuckOutcome; continueWithNote?: StuckOutcome; accept?: StuckOutcome; handFix?: StuckOutcome; replan?: StuckOutcome }>(
    "stuck_outcomes",
    events,
    { policy, deviceOn: pipelineSlotDeclared("device_check") },
    (need) => {
      const revs = look();
      // an unreadable lane answers with no head rather than an error: the fold then keeps the final review
      if (need.kind === "head") return revs?.head ?? "";
      if (!revs) throw new Error(`lane の head が読めません: ${need.kind}`);
      if (need.kind === "sameTree") return sameTree(revs.worktree, need.a, need.b);
      if (need.kind === "behaviour") return behaviourChanges(revs.worktree, need.a, need.b);
      if (need.kind === "risk") return newHigh && rec ? laneRisk(rec, revs.worktree, revs.base).high : false;
      throw new Error(`知らない事実です: ${need.kind}`);
    },
  );
  const plain = answer.continue;
  const noted = answer.continueWithNote;
  const accept = answer.accept;
  const handFix = answer.handFix;
  const replan = answer.replan;
  return plain && noted && accept && handFix && replan ? { continue: plain, continueWithNote: noted, accept, handFix, replan } : undefined;
}

/** whether a lane is one the order check watches: a repo that does not publish, and a lane on the work branch, not stacked */
function orderScope(iddId: string): boolean {
  try {
    const loc = laneLocations(iddId);
    if (!loc || publishes(loc.config) || !loc.config.local_path || !loc.config.work_base) return false;
    const base = laneBaseOf(iddId);
    return !("error" in base) && !base.parent && !base.external;
  } catch {
    return false;
  }
}

/** a lane's head, or null when its worktree cannot be read (the trial merge then has no answer) */
function laneHeadOf(iddId: string): string | null {
  try {
    const worktree = readSessions("executor").filter((r) => r.idd_id === iddId).pop()?.worktree_path;
    return worktree ? headCommit(worktree) : null;
  } catch {
    return null;
  }
}

/**
 * The lanes that have gone ahead of this one: not closed, and holding an order position earlier than this lane's.
 * A waiting lane is an opponent too, so a lane that comes later waits behind it (the wait can chain). A lane with
 * no position yet (still implementing) is not an opponent. A lane whose head cannot be read is not an opponent
 * either; it is returned apart, so the reason the trial merge had no answer can be kept once.
 */
function priorOrderLanes(backlog: BacklogRecord[], byLane: Map<string, LifecycleRecord[]>, iddId: string, now: number): { prior: { lane: string; head: string }[]; unreadable: { lane: string }[] } {
  const rec = backlog.find((r) => r.idd_id === iddId);
  const prior: { lane: string; head: string }[] = [];
  const unreadable: { lane: string }[] = [];
  if (!rec) return { prior, unreadable };
  // a lane that has not been judged yet takes the tick's time as its position: it is the order it would get if this
  // judgement is where it first arrives
  const own = orderPositionOf(byLane.get(iddId) ?? []) ?? { at: now, lane: iddId };
  for (const other of backlog) {
    if (other.idd_id === iddId || other.area !== rec.area) continue;
    const oevs = byLane.get(other.idd_id) ?? [];
    if (oevs.some((e) => e.event === "lane_close" || e.event === "s3_defer")) continue;
    const pos = orderPositionOf(oevs);
    if (!pos || compareOrder(pos, own) >= 0) continue;
    if (!orderScope(other.idd_id)) continue;
    const head = laneHeadOf(other.idd_id);
    if (head) prior.push({ lane: other.idd_id, head });
    else unreadable.push({ lane: other.idd_id });
  }
  return { prior, unreadable };
}

interface OrderGateResult { wait: boolean; records: LifecycleRecord[]; error?: string }

/**
 * The order check before a lane's first review: a read-only trial merge against the lanes that have gone ahead.
 * A conflict on a file that is not excluded makes the lane wait for those lanes to land; no conflict, an
 * unanswerable merge, and the wait's own limit let the review begin.
 *
 * The waiting is decided by the fold: the lane's own head, the trial merges and the lane's place in the order are
 * read here, and the fold says whether the lane waits and which records it leaves (C-200-1). The records are
 * written here, in the order the fold gives them.
 */
async function orderGate(iddId: string, evs: LifecycleRecord[], prior: { lane: string; head: string }[], unreadable: { lane: string }[] = [], now = Date.now()): Promise<OrderGateResult> {
  const records: LifecycleRecord[] = [];
  const policy = reviewPolicy();
  let loc: ReturnType<typeof laneLocations> | undefined;
  try { loc = laneLocations(iddId); } catch { loc = undefined; }
  const answer = await judge<{ wait?: boolean; steps?: { event: string; attrs: Record<string, unknown> }[] }>(
    "order_gate",
    evs,
    {
      policy,
      now,
      orderAt: orderPositionOf(evs)?.at ?? now,
      inScope: orderScope(iddId),
      prior,
      unreadable: unreadable.map((u) => u.lane),
    },
    async (need) => {
      if (need.kind === "head") {
        if (!loc) return "";
        try { return sha(loc.work); } catch { return ""; }
      }
      if (need.kind === "trialMerge") {
        const work = loc?.config.local_path ?? "";
        const merge = trialMerge(work, need.a, need.b);
        return merge ? { conflict: merge.conflict, files: merge.files } : null;
      }
      throw new Error(`知らない事実です: ${need.kind}`);
    },
  );
  for (const step of answer.steps ?? []) {
    await appendLifecycle(step.event, iddId, step.attrs);
    records.push(preMergeRecord(iddId, step.event, step.attrs));
  }
  return { wait: !!answer.wait, records };
}

/**
 * One error of the lane's records check, as the CLI prints it: `error <rule> <id>: <reason>`. Notes and marks
 * do not fail the check, so only errors are read out.
 */
export interface RecordsFinding { rule: string; id: string; reason: string }

export type RecordsCheckResult =
  | { outcome: "clean" }
  | { outcome: "errors"; findings: RecordsFinding[] }
  | { outcome: "unavailable"; reason: string };

export interface RecordsCheckInput { lane: string; worktree: string; command: string[]; timeoutMinutes: number }

/** one step of the records check's answer: a record to write, the envelope to send, or the verdict to stand after */
export interface RecordsStep {
  kind: "record" | "envelope" | "verdict" | "merge_skip";
  event?: string;
  attrs?: Record<string, unknown>;
  findings?: RecordsFinding[];
  head?: string;
  skip?: Record<string, unknown>;
  sinceHead?: string;
}

/**
 * How the lane's records check is run. The default runs the repo's own `intent` records check in the lane's
 * worktree, as the merge's records check does; a test may hand a fake one, so the loop's handling of its answers is
 * fixed without a real engine (nothing else reads this).
 */
let recordsCheckRunner: ((input: RecordsCheckInput) => Promise<RecordsCheckResult>) | null = null;

export function setRecordsCheckRunner(next: ((input: RecordsCheckInput) => Promise<RecordsCheckResult>) | null): void {
  recordsCheckRunner = next;
}

/**
 * The records check named `intent` in the lane's repo, or null when the repo declares none: that repo's merge does
 * not run intent either, so no defect is handed back early. The command and its time limit are the repo's own.
 */
function intentCheckOf(iddId: string): RecordsCheckInput | null {
  let loc: ReturnType<typeof laneLocations>;
  try { loc = laneLocations(iddId); } catch { return null; }
  if (!loc) return null;
  const check = (loc.config.checks ?? []).find((c) => c.scope === "records" && c.name === "intent");
  if (!check?.command?.length) return null;
  const timeouts = readAreas().checkPrep?.[loc.area]?.timeouts ?? {};
  // the merge's records check default when the repo declares no limit (gate.ts's DEFAULT_CHECK_MINUTES)
  return { lane: iddId, worktree: loc.work, command: trunkCommand(check.command, loc.config.local_path), timeoutMinutes: timeouts[check.name] ?? 5 };
}

/** a word of a shell line that names a program by a relative path (`bin/idd`, `./x`): resolved against the trunk */
function relativeProgram(word: string): boolean {
  return word.includes("/") && !isAbsolute(word) && /^[\w./+@%,:-]+$/.test(word);
}

/**
 * The records check's argv with a program named by a relative path resolved against the trunk (the work clone,
 * `local_path`). The lane's worktree stays the cwd, so the tree the check reads is the lane's; only the program is
 * the trunk's. A lane whose head is older than the trunk otherwise runs its own older CLI over the trunk's rules
 * and reports errors the landing (which checks a copy merged with the trunk, whose CLI is the trunk's) would not:
 * IDD-174 was sent 57 such errors and its fix plan was about to confirm Choices to satisfy them. The repo's one shell
 * line arrives as
 * `bash -c <line>` (areas.ts), so the line's first word is the one resolved; an argv's own head likewise. An
 * absolute path, a command found on PATH (`bash`, `node`) and a line whose first word is not a plain path (quoted,
 * an assignment) are left as they are. Without a trunk path nothing is resolved.
 */
export function trunkCommand(command: string[], trunk: string | undefined): string[] {
  if (!trunk) return command;
  if (command.length === 3 && command[0] === "bash" && command[1] === "-c") {
    const m = /^(\s*)(\S+)([\s\S]*)$/.exec(command[2]);
    if (!m || !relativeProgram(m[2])) return command;
    // single-quoted for sh, so a space or a $ in the trunk's path stays literal
    const quoted = `'${resolve(trunk, m[2]).replace(/'/g, `'\\''`)}'`;
    return [command[0], command[1], `${m[1]}${quoted}${m[3]}`];
  }
  if (command.length && relativeProgram(command[0])) return [resolve(trunk, command[0]), ...command.slice(1)];
  return command;
}

/** the errors the CLI's text output holds: `error <rule> <id>: <reason>`; notes and marks are left out */
function findingsIn(output: string): RecordsFinding[] {
  const out: RecordsFinding[] = [];
  for (const line of output.split("\n")) {
    const m = /^error (\S+) (\S*): (.*)$/.exec(line.trim());
    if (m) out.push({ rule: m[1], id: m[2], reason: m[3] });
  }
  return out;
}

/**
 * The repo's own records check, run as `runChecks` runs a records check: in the lane's worktree, argv (its program
 * the trunk's, see `trunkCommand`) with `timeout(1)` around it, the lane's id in `IDD_ID`, and the engine's own
 * secrets out of the environment. The exit
 * code tells an unanswerable check (2 and over, a time limit, a missing command) from one that found errors (1).
 */
function runRecordsCommand(input: RecordsCheckInput): Promise<RecordsCheckResult> {
  const seconds = Math.max(1, Math.ceil(input.timeoutMinutes * 60));
  const env = { ...process.env };
  delete env.LINEAR_API_KEY;
  delete env.IDD_CHANGED_FILES;
  delete env.IDD_RISK_PATHS;
  env.IDD_ID = input.lane;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("timeout", ["--kill-after=30", String(seconds), ...input.command], { cwd: input.worktree, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      resolve({ outcome: "unavailable", reason: String((err as Error).message ?? err).slice(0, 300) });
      return;
    }
    let output = "";
    let done = false;
    let timedOut = false;
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, (seconds + 60) * 1000);
    // a check that prints without end must not grow this process's memory: the tail is all the reason needs
    const keep = (chunk: Buffer | string) => { if (output.length < 1_000_000) output += chunk.toString(); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const finish = (code: number | null, errorCode?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const text = output.trim().slice(-1500);
      if (code === 0) { resolve({ outcome: "clean" }); return; }
      const findings = findingsIn(output);
      if (code === 1 && findings.length) { resolve({ outcome: "errors", findings }); return; }
      const reason = errorCode === "ENOENT" || (code === 127 && /timeout: failed to run command/m.test(output))
        ? "timeout(1) または検査コマンドが見つからないので回せませんでした"
        : code === 124 || code === 137 || timedOut ? `時間の上限（${input.timeoutMinutes} 分）で打ち切りました`
          : `検査が答えませんでした（exit ${code ?? "?"}）`;
      resolve({ outcome: "unavailable", reason: `${reason}${text ? `: ${text.slice(0, 300)}` : ""}` });
    };
    child.on("error", (err) => finish(null, (err as NodeJS.ErrnoException).code));
    child.on("close", (code) => finish(code));
  });
}

async function runRecordsCheck(input: RecordsCheckInput): Promise<RecordsCheckResult> {
  if (recordsCheckRunner) {
    try { return await recordsCheckRunner(input); } catch (err) { return { outcome: "unavailable", reason: String((err as Error).message ?? err).slice(0, 300) }; }
  }
  return runRecordsCommand(input);
}





/** the files the lane changed between two heads that lie outside the records place, or null when git cannot answer */
function outsideRecordsChanged(worktree: string, from: string, to: string): string[] | null {
  if (!from || !to) return null;
  if (from === to) return [];
  let names: string[];
  try {
    names = git(worktree, ["diff", "--name-only", from, to]).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
  const paths = readManifest(worktree).paths;
  return names.filter((n) => !isOverlayPath(paths, n));
}

/** the envelope the records check sends the executor: the errors, and that the round it opens needs a record too */
function recordsFixEnvelope(iddId: string, findings: RecordsFinding[]): string {
  return buildEnvelope("lane_rejected", iddId, [
    "  <task>",
    "    レビューの巡を終えた後の記録の検査（`bin/idd intent check`）が error を返した。lane の worktree で検査を回し直し、error が消えるように記録を直して commit する。code は検査が指しているのでなければ変えない。",
    "    - この差し戻しで開いた巡にも、Choice の新設・Re-anchor・Supersede・Waive のどれかを残す。",
    "    - 直したら `idd report result` を呼び直す。この差し戻しは修正の巡の上限を使わない。",
    "  </task>",
    "  <errors>",
    ...findings.map((f) => `    <error rule="${esc(f.rule)}" id="${esc(f.id)}">${esc(f.reason)}</error>`),
    "  </errors>",
  ].join("\n"));
}


/**
 * The records check between the review's end and S3. A clean or unanswerable check leaves the loop done. An error
 * sends the lane back to the executor once for the convergence, with the errors it found; the same errors a
 * send-back already carried are not sent again, so an error the lane cannot fix does not loop. A repo whose records
 * checks have no `intent`, or a lane whose worktree cannot be read, is left as it is.
 *
 * The fold decides what the check's answer means: the records it leaves and whether the lane goes back (C-200-1).
 * The check itself is a process, and it runs here.
 */
async function checkRecordsBeforeS3(rec: BacklogRecord, evs: LifecycleRecord[], afterVerdict?: () => Promise<boolean>): Promise<void> {
  // the skip of the round stands after the verdict: a skip that cannot be written opens the round rather than closing
  // the check that never said the head is clean
  const verdictDone = async (head?: string) => {
    if (!afterVerdict) return;
    if (await afterVerdict()) return;
    await appendLifecycle("s2_records_reopened", rec.idd_id, { ...(head ? { head } : {}), reason: "巡を省いた記録を書けませんでした" });
  };
  const check = intentCheckOf(rec.idd_id);
  // the lane's own head or origin cannot be read: the check cannot run, and the lane goes on (C-161-6)
  let at: { worktree: string; base: string; head: string } = { worktree: "", base: "", head: "" };
  let headError = "";
  try { at = laneRevs(rec.idd_id, evs); } catch (err) { headError = String((err as Error).message).slice(0, 200); }
  const answer = await judge<{ steps?: RecordsStep[] }>(
    "records_check",
    evs,
    { head: at.head, headError, hasCheck: !!check },
    async (need) => {
      if (need.kind === "recordsCheck") {
        if (!check) return { outcome: "unavailable", reason: "" };
        return await runRecordsCheck(check);
      }
      throw new Error(`知らない事実です: ${need.kind}`);
    },
  );
  for (const step of answer.steps ?? []) {
    if (step.kind === "record" && step.event) {
      await appendLifecycle(step.event, rec.idd_id, step.attrs ?? {});
    } else if (step.kind === "envelope") {
      const findings = (step.findings ?? []) as RecordsFinding[];
      try {
        // the fix planner is slipped in ahead of the new session, as for every fix instruction (DEC-121-1)
        await queueEnvelope(rec.idd_id, "lane_rejected", recordsFixEnvelope(rec.idd_id, findings));
      } catch {
        // the wait is recorded but the instruction did not go out: the lane waits, and the next tick tries again (DEC-2402)
        return;
      }
    } else if (step.kind === "verdict") {
      await verdictDone(step.head || undefined);
    }
  }
}

/** what a head that is only the mainline merged in stands for, as the round skipped for it records it */
interface MergeOnlySkip {
  head: string;
  reviewed_head: string;
  merge: string;
  mainline: string;
  review_base: string;
}

/**
 * Read whether the head since the last review round is only the mainline merged in, and where the review origin moves
 * for it. Nothing is written and nothing moves here: the record is written after the records check has run, so a
 * check that throws leaves the lane where the next tick runs it again.
 *
 * Undefined when the head is not only that merge, when the origin cannot be moved, or when git cannot answer; the
 * round then runs as it always did.
 */
function mergeOnlySkipOf(rec: BacklogRecord, at: { worktree: string; base: string; head: string }, from: string): MergeOnlySkip | undefined {
  const read = mergeOnlyHead(at.worktree, rec.idd_id, from, at.head);
  if ("refusal" in read) return undefined;
  let reviewBase: string;
  try { reviewBase = mergedReviewBase(at.worktree, rec.idd_id, at.base, read.mainline); } catch { return undefined; }
  return { head: at.head, reviewed_head: from, merge: read.merge, mainline: read.mainline, review_base: reviewBase };
}

/**
 * Record the round a head that is only the mainline merged in does not need: the head the review last read, the merge
 * it is, and the review origin moved past that mainline, so the submit does not read what the mainline brought as
 * the lane's change. The name is its own (`s2_review_skipped` is a blind that never ran), so the state machine and the
 * submit's gate can read the head a skipped round stood for. False when the record cannot be written.
 *
 * The picture comparison is left out for this head, and the head says so: the comparison ran for an earlier head, and
 * the submit card must not show that result as this head's. The card reads the last of the two records, so the head's
 * own record is the one that stands for it.
 */
async function writeMergeOnlySkip(rec: BacklogRecord, evs: LifecycleRecord[], decided: MergeOnlySkip): Promise<boolean> {
  // one record per head and merge: a tick that looks again reads the record it already wrote
  if (evs.some((e) => e.event === MERGE_ONLY_SKIP_EVENT && e.attrs?.head === decided.head && e.attrs?.merge === decided.merge)) return true;
  const device: Record<string, unknown> = {
    head: decided.head,
    reason: "本流の merge だけで巡を省いたので、この head では絵の見比べを回していない",
  };
  try { await appendLifecycle("s2_device_skipped", rec.idd_id, device); } catch { /* the card falls back to the round's end */ }
  evs.push(preMergeRecord(rec.idd_id, "s2_device_skipped", device));
  const attrs: Record<string, unknown> = {
    ...decided,
    reason: `本流の merge だけで、レビューしていない差分が無い（merge ${decided.merge.slice(0, 9)}）`,
  };
  try { await appendLifecycle(MERGE_ONLY_SKIP_EVENT, rec.idd_id, attrs); } catch { return false; }
  evs.push(preMergeRecord(rec.idd_id, MERGE_ONLY_SKIP_EVENT, attrs));
  return true;
}

/**
 * The step after the executor answered the records send-back: only records changed, so the check runs again without
 * a review round; code outside the records place changed, so the review's rounds run again. A head that carries only
 * the mainline merged in is not code a review has to read, so the check runs again for it: the merge brought records
 * too, and the verdict before it spoke for the head before the merge. An unreadable answer is treated as a code
 * change, because a review that did not read the change must not be skipped.
 *
 * The fold decides what the answer means: the records it leaves and whether the lane goes back (C-200-1).
 */
async function recheckRecords(rec: BacklogRecord, evs: LifecycleRecord[]): Promise<boolean> {
  let at: { worktree: string; base: string; head: string } = { worktree: "", base: "", head: "" };
  let headError = "";
  try { at = laneRevs(rec.idd_id, evs); } catch (err) { headError = String((err as Error).message).slice(0, 200); }
  // a head that is only the mainline merged in since the last round goes on without a round: in a repo that runs its
  // checks before the convergence, they run first at that head, and the recheck runs again once they spoke for it. A
  // head that only the records changed keeps the public tree the checks already read, so nothing is run for it
  // (the config is read only for such a head: a recheck of records alone reads none, as before)
  if (!headError) {
    const since = lastReviewRound(evs);
    let skip: MergeOnlySkip | undefined;
    try { skip = since ? mergeOnlySkipOf(rec, at, since.head) : undefined; } catch { skip = undefined; }
    if (skip && await checksHold(rec, evs, at, reviewLoopState(evs) as unknown as Record<string, unknown>)) return false;
  }
  const check = intentCheckOf(rec.idd_id);
  const answer = await judge<{ steps?: RecordsStep[] }>(
    "records_recheck",
    evs,
    { head: at.head, headError, hasCheck: !!check },
    async (need) => {
      if (need.kind === "outsideRecords") return outsideRecordsChanged(at.worktree, need.a, need.b);
      if (need.kind === "mergeOnlySkip") {
        const since = lastReviewRound(evs);
        const skip = since ? mergeOnlySkipOf(rec, at, since.head) : undefined;
        return skip ?? null;
      }
      if (need.kind === "recordsCheck") {
        if (!check) return { outcome: "unavailable", reason: "" };
        return await runRecordsCheck(check);
      }
      throw new Error(`知らない事実です: ${need.kind}`);
    },
  );
  for (const step of answer.steps ?? []) {
    if (step.kind === "record" && step.event) {
      await appendLifecycle(step.event, rec.idd_id, step.attrs ?? {});
    } else if (step.kind === "envelope") {
      const findings = (step.findings ?? []) as RecordsFinding[];
      try {
        await queueEnvelope(rec.idd_id, "lane_rejected", recordsFixEnvelope(rec.idd_id, findings));
      } catch {
        // the wait is recorded but the instruction did not go out: the lane waits, and the next tick tries again (DEC-2402)
        return true;
      }
    } else if (step.kind === "merge_skip" && step.skip) {
      const skip = step.skip as unknown as MergeOnlySkip;
      if (!(await writeMergeOnlySkip(rec, evs, skip))) {
        await appendLifecycle("s2_records_reopened", rec.idd_id, { since_head: String(step.sinceHead ?? ""), head: at.head, reason: "巡を省いた記録を書けませんでした" });
      }
    }
  }
  return true;
}

/**
 * What the spec check of a round reads: the work instruction, the qa, the lane's own Choices and Purposes. The lane's
 * overview goes with the stage's start. A v1 lane (decision.md) reads its decision where a v2 lane reads the Choices.
 * No earlier round's findings and no list of earlier fixes are among them (C-223-2); the boundaries and the findings
 * penne put off on the stuck cards are, since they are the lane's scope decided by a person (`humanLines`).
 */
function specInputs(rec: BacklogRecord, evs: LifecycleRecord[], round: number, kind: string): string[] {
  const shape = laneRecordShape(rec.idd_id, evs);
  const documents = planReviewInputs(rec);
  const plan = lanePlanOf(rec.idd_id, rec);
  const label = `spec-${round}-${kind}`;
  const intent = shape === "state"
    ? [writeLaneChoicesFile(rec, label), writeLanePurposesFile(rec, label, "仕様の照合の入力")]
    : [documents[0]];
  const lines = humanLines(evs);
  const linesFile = lines ? writeReviewNote(rec.idd_id, `human-lines-${round}-${kind}.md`, [lines, ""]) : undefined;
  return [...(plan ? [plan.rel] : []), documents[1], ...intent, linesFile].filter((x): x is string => !!x);
}

/**
 * Write a stop of the loop (`s2_review_escalated`) from the lane's rows as they are at the moment it is written, not
 * as the tick read them at its start. A person's answer on the card is a row that moves the loop, and it can come in
 * while the tick runs; a stop written after it would be read as the loop's last word and the answer would be lost
 * with an `ok: true` on the person's side. The reading and the write sit under the lane gate the answers write under,
 * so of an answer and a stop the answer comes first and the stop sees it. `build` gives the stop from the fresh rows
 * (or null); a lane the loop is no more in the state the tick saw it in gets none.
 */
async function appendStopIfUnmoved(
  iddId: string,
  seen: LifecycleRecord[],
  build: (fresh: LifecycleRecord[]) => { event: string; attrs: Record<string, unknown> } | null,
): Promise<boolean> {
  try {
    return await withLaneGate(async () => {
      const fresh = readLifecycle().filter((e) => e.idd_id === iddId);
      if (JSON.stringify(reviewLoopState(fresh)) !== JSON.stringify(reviewLoopState(seen))) return false;
      const stop = build(fresh);
      if (!stop) return false;
      await appendLifecycle(stop.event, iddId, stop.attrs);
      return true;
    });
  } catch (err) {
    // a busy gate is another writer at the lane: the next tick reads the lane again and decides then
    if (isLaneGateBusy(err)) return false;
    throw err;
  }
}

/** how much of a failed check's output the checks' record keeps (the submit's record keeps the same) */
const CHECK_TAIL = 1500;

/**
 * What a failure of a run that checked the head merged with the public base's tip means for the fix: the tip may carry
 * commits the lane's worktree does not, so a failure that does not reproduce there is checked after taking the tip (or
 * the work side's mainline) into the lane.
 */
export function publicTreeNote(base?: string): string {
  const at = base ? `公開 base の先端 ${base.slice(0, 9)}` : "公開 base の先端";
  return `head を${at} と合わせた tree で落ちた。その先端には lane の作業ツリーに無い commit がありうるので、再現しないときは公開 base の先端（または作業本流）を lane に取り込んで確かめる`;
}

/**
 * The checks' rows as the fold reads them: each check's name and status, what the comparison with the base found (in
 * words that name the base the run compared with: the public base's tip, or the lane's base when the run checked the
 * head's own tree; a run's record from before the basis was kept is read as the lane's base), its failures, and the
 * tail of its output.
 */
export function checkRowsFact(rows: readonly GateCheck[], basis: ConvergeBasis = "lane", base?: string): NonNullable<StepFacts["checkRows"]> {
  // the public base's tip has commits the lane's worktree may not have: a failure the executor cannot reproduce there
  // may be theirs, and the fix and the stop say so
  const treeNote = basis === "public" ? publicTreeNote(base) : "";
  return rows.map((r) => {
    const said = r.baseline ? baselinePhrase(r.baseline) : r.status === "pass" || r.status === "not-applicable" ? "" : checkReason(r.detail, r.status);
    const phrase = basis === "public" ? said : said.split("公開 base の先端").join("lane の分岐元").split("公開 base").join("lane の分岐元");
    return {
      name: r.name,
      status: r.status,
      ...(r.baseline?.verdict ? { verdict: r.baseline.verdict } : {}),
      ...(phrase ? { phrase } : {}),
      ...(r.failureIds?.length ? { failures: r.failureIds } : {}),
      ...(treeNote && r.status === "fail" ? { tree_note: treeNote } : {}),
      ...(r.status !== "pass" && r.detail ? { tail: r.detail.slice(-CHECK_TAIL) } : {}),
    };
  });
}

/**
 * Start the repo's required public checks at the lane's head (a run of their own). The run builds, under the repo's
 * heavy-checks lock, the tree the submit would check (the head merged over the public base's tip it fetches then) and
 * compares a failure with that tip; what is handed here is what it falls back to when it cannot: the files the lane
 * changed against its base, and the lane's base (the merge-base with the work side's mainline). The tick fetches
 * nothing. Null when the repo's checks are taken now.
 */
function startConvergeChecks(rec: BacklogRecord, at: { worktree: string; base: string; head: string }): { id: string } | null {
  const config = readAreas().areas[rec.area];
  if (!config) throw new Error(`repo ${rec.area} の設定がありません`);
  const checks = (config.checks ?? []).filter((c) => c.required && c.scope !== "records");
  const manifestPaths = readManifest(at.worktree).paths;
  let base = at.base;
  if (config.work_base) {
    try { base = git(at.worktree, ["merge-base", at.head, `refs/heads/${config.work_base}`]).trim() || at.base; } catch { base = at.base; }
  }
  const changed = git(at.worktree, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=d", filteredTree(at.worktree, base, manifestPaths), filteredTree(at.worktree, at.head, manifestPaths)]).split("\0").filter(Boolean);
  return convergeCheckLauncher().start({
    lane: rec.idd_id, area: rec.area, repo: at.worktree, from: config.local_path ?? at.worktree,
    head: at.head, base, checks, changed, manifestPaths, deps: join(at.worktree, "node_modules"),
  });
}

/**
 * The convergence, or the checks before it in a repo that runs them (`checks_before_converge`): the fold decides which
 * (C-201-1). `convergeAttrs` is what a convergence the caller decided writes (a final it skipped); the checks carry it
 * past their run. A start the repo's checks keep out waits for a later tick.
 */
async function convergeOrCheck(rec: BacklogRecord, evs: LifecycleRecord[], revs: () => { worktree: string; base: string; head: string }, note: (to: string) => void, convergeAttrs?: Record<string, unknown>, done = "converged"): Promise<void> {
  const on = convergeChecksOn(rec.area);
  const at = on ? revs() : undefined;
  const facts: StepFacts = { checksOn: on, ...(at ? { at } : {}), ...(convergeAttrs ? { convergeAttrs } : {}) };
  const step = convergeStep(evs, facts);
  if (step.action === "write") {
    await appendLifecycle(String(step.event), rec.idd_id, step.attrs);
    note(step.event === "s2_review_converged" ? done : String(step.event));
    return;
  }
  if (step.action !== "start" || !at) return;
  const run = startConvergeChecks(rec, at);
  // the repo's checks are taken: nothing moved, so the tick does not go round again for it
  if (!run) return;
  const started = convergeStep(evs, { ...facts, runs: [{ state: "running", runIds: [run.id] }] });
  if (started.action === "write") await appendLifecycle(String(started.event), rec.idd_id, started.attrs);
  note("checks started");
}

/**
 * Whether the checks before the convergence hold the lane back at a step that goes on without a review round (a head
 * that is only the mainline merged in): in a repo that runs them, and they have not spoken for the head, they are started
 * (or wait for the repo's heavy checks) carrying `resume`, the state the loop comes back to once they did. False when
 * the step may go on. The fold decides it with the convergence's own step (C-201-1).
 */
async function checksHold(rec: BacklogRecord, evs: LifecycleRecord[], at: { worktree: string; base: string; head: string }, resume: Record<string, unknown>): Promise<boolean> {
  if (!convergeChecksOn(rec.area)) return false;
  const facts: StepFacts = { checksOn: true, at, resumeState: resume };
  const step = convergeStep(evs, facts);
  if (step.action !== "start") return false;
  const run = startConvergeChecks(rec, at);
  if (!run) return true;
  const started = convergeStep(evs, { ...facts, runs: [{ state: "running", runIds: [run.id] }] });
  if (started.action === "write") await appendLifecycle(String(started.event), rec.idd_id, started.attrs);
  return true;
}

/** the minutes a run of the checks before the convergence may wait for the repo's heavy checks: their limits and 30 */
export function checksWaitLimitMinutes(area: string): number {
  const config = readAreas().areas[area];
  const timeouts = readAreas().checkPrep?.[area]?.timeouts ?? {};
  const checks = (config?.checks ?? []).filter((c) => c.required && c.scope !== "records");
  return checks.reduce((sum, c) => sum + (timeouts[c.name] ?? DEFAULT_CHECK_MINUTES), 0) + 30;
}

/**
 * Advance every lane's S2 review loop by at most one step. The state lives in the lifecycle
 * (derive/review-loop.ts); this only starts runs, reads their results and records the next event.
 * A lane in `skip` (its stage failed to start earlier in the same tick) is left alone, and a lane whose last
 * start failed less than START_RETRY_MS ago waits, so the failures counted toward penne are minutes apart.
 */
export async function runReviewLoop(opts: { skip?: ReadonlySet<string> } = {}): Promise<ReviewLoopResult> {
  const result: ReviewLoopResult = { advanced: [], errors: [] };
  // the one clock this tick reads: lanes first judged in the same tick share it, so their order is broken by number
  const tickNow = Date.now();
  const all = readLifecycle();
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of all) byLane.set(e.idd_id, [...(byLane.get(e.idd_id) ?? []), e]);
  const runner = getAgentRunner();
  const reviewOn = pipelineSlotDeclared("review_blind");
  const deviceOn = pipelineSlotDeclared("device_check");
  const mapOn = pipelineSlotDeclared("risk_map");
  const cap = pipelineConcurrency("review_blind");
  const mapCap = pipelineConcurrency("risk_map");
  const closed = (evs: LifecycleRecord[]) => evs.some((e) => e.event === "lane_close" || e.event === "s3_defer");
  const runningOf = (state: string) => [...byLane.values()].filter((evs) => !closed(evs) && reviewLoopState(evs).state === state).length;
  // the blind cap counts copies: a usual round cuts one per role, a mapped round one per place and a generic one.
  // With usual rounds only this is the old count of lanes; a round larger than the cap starts only when nothing else runs
  // a depth-bearing round starts its spec check beside its blinds, and the check holds a copy of its own. The wait list
  // reads the same counts (blind-count.ts), so the lanes it shows as waiting are the ones this holds back
  const pipe = pipelineSnapshot();
  const blindSize = blindSlotSize(pipe);
  // the gate also holds the lanes that run at once, so a shallow round that adds fewer copies does not let more lanes in than `concurrency` says
  const running = [...byLane.values()].flatMap((evs) => {
    const s = closed(evs) ? null : reviewLoopState(evs);
    return s?.state === "running_blind" ? [s.runIds.length] : [];
  });
  const gate = new BlindGate(cap, blindSize, running.reduce((n, runs) => n + runs, 0), running.length);
  // a lane stopped for penne does not hold a map slot: it would keep every other lane's map waiting
  let mapRunning = [...byLane.values()].filter((evs) => !closed(evs) && !laneHeld(evs) && reviewLoopState(evs).state === "running_map").length;
  let triageRunning = runningOf("running_triage");
  let confirmRunning = runningOf("running_confirm");
  const triageCap = pipelineConcurrency("triage");
  const confirmCap = pipelineConcurrency("confirm");

  const backlog = readBacklog();
  for (const rec of inStartOrder(backlog)) {
    const evs = byLane.get(rec.idd_id) ?? [];
    if (closed(evs) || laneHeld(evs)) continue;
    if (opts.skip?.has(rec.idd_id) || startRetryWaiting(evs)) continue;
    let st = reviewLoopState(evs);
    // a High role held for Claude's windows: the loop tries the final again on each tick, without penne (DEC-2766)
    if (st.state === "escalated" && st.quotaWait && st.retry) st = st.retry;
    const note = (to: string) => result.advanced.push({ iddId: rec.idd_id, to });
    // the order check runs once per lane, before the first review; an undeclared review slot is not ordered
    if (reviewOn && (st.state === "awaiting_order" || (st.state === "start_blind" && st.kind === "blind" && beforeFirstReview(evs)))) {
      let gate: OrderGateResult;
      try {
        const op = priorOrderLanes(backlog, byLane, rec.idd_id, tickNow);
        gate = await orderGate(rec.idd_id, evs, op.prior, op.unreadable, tickNow);
      } catch (err) {
        // the judgement is the only thing that decides the wait: a fold that cannot answer leaves the lane where it
        // is, and the next tick asks again (never a waitless review the judgement did not give)
        result.errors.push({ iddId: rec.idd_id, error: String((err as Error).message ?? err) });
        continue;
      }
      if (gate.records.length) evs.push(...gate.records);
      if (gate.error) result.errors.push({ iddId: rec.idd_id, error: gate.error });
      if (gate.wait) { note("order wait"); continue; }
      st = reviewLoopState(evs);
    }
    let starting: ReviewStage | undefined;
    // this start is a High lane's final waiting for the High role's windows (the loop escalates instead of recording a wait)
    let startingHigh = false;
    const revs = () => laneRevs(rec.idd_id, evs);
    const start = async (stage: ReviewStage, round: number, inputs: string[], routes?: RiskRoute[], at?: ReturnType<typeof revs>, shown: { extras?: ReviewExtra[]; scope?: "increment" | "conflict"; merge?: string; laneBase?: string; shouldDefault?: "followup"; existingFollowups?: boolean; noFallbackRoles?: string[]; hasPlan?: boolean; answers?: string; overview?: string; roleCount?: number; onlyHighRisk?: boolean; spec?: { count: number; inputs: string[] } } = {}) => {
      starting = stage;
      if (!runner?.startReviewRun) throw new Error("review を起動する runner がありません");
      return runner.startReviewRun({
        iddId: rec.idd_id, stage, round, ...(at ?? revs()), inputs,
        ...(routes?.length ? { routes } : {}),
        ...(shown.extras?.length ? { extras: shown.extras } : {}),
        ...(shown.scope ? { scope: shown.scope } : {}),
        ...(shown.merge ? { merge: shown.merge } : {}),
        ...(shown.laneBase ? { laneBase: shown.laneBase } : {}),
        ...(shown.shouldDefault ? { shouldDefault: shown.shouldDefault } : {}),
        ...(shown.existingFollowups ? { existingFollowups: true } : {}),
        ...(shown.noFallbackRoles?.length ? { noFallbackRoles: shown.noFallbackRoles } : {}),
        ...(shown.hasPlan ? { hasPlan: true } : {}),
        ...(shown.answers ? { answers: shown.answers } : {}),
        ...(shown.overview ? { overview: shown.overview } : {}),
        ...(typeof shown.roleCount === "number" ? { roleCount: shown.roleCount } : {}),
        ...(shown.onlyHighRisk ? { onlyHighRisk: true } : {}),
        ...(shown.spec ? { spec: shown.spec } : {}),
        // the lane's planner and executor followed the harness where it overrides the repo, and the IDD norms
        // hold whatever the target repo carries. Both are told as the lane's identifier line plus the harness's own points.
        ...(NORM_STAGES.has(stage) ? { norms: [reviewLaneLine(laneRecordShape(rec.idd_id, evs)), normText("todo-source", laneRecordShape(rec.idd_id, evs))] } : {}),
        recordsShape: laneRecordShape(rec.idd_id, evs),
      });
    };

    try {
      switch (st.state) {
        case "start_blind": {
          // the kept check (守られたかの確かめ) went with R2 (2026-10-22): no depth asks for it any more, and a kept start
          // a stored state still names (a retry written before the removal) converges as an undeclared check did
          if (st.kind === "kept") {
            const kept = reviewNextStep(evs, {});
            if (kept.action === "write") await appendLifecycle(String(kept.event), rec.idd_id, kept.attrs);
            note("kept skipped");
            break;
          }
          // the first review reads the mainline of the moment: the harness merges it in before the round is even skipped
          if (st.kind === "blind" && beforeFirstReview(evs)) {
            const pre = await preReviewMerge(rec.idd_id, evs);
            if (pre.records.length) evs.push(...pre.records);
            // an instruction that could not be queued is a failure of this tick only: the lane waits, and the next tick tries again (DEC-2402)
            if (pre.error) result.errors.push({ iddId: rec.idd_id, error: pre.error });
            await markPreMergeWait(rec.idd_id, evs, pre.action);
            if (pre.action === "busy" || pre.action === "awaiting") break;
          }
          // the review slot nobody declared skips the round: the fold answers it from the rows and the one fact
          {
            const skip = reviewNextStep(evs, { reviewOn });
            if (skip.event === "s2_review_skipped") {
              await appendLifecycle(String(skip.event), rec.idd_id, skip.attrs);
              note("skipped");
              break;
            }
          }
          const policy = reviewPolicy();
          const newHigh = policy.highRiskWhen === "last" && policy.extras.high_risk > 0;
          // the executor's result does not begin a review stage until its work has stopped (Issue #159): the stage
          // waits out a conversation still answering and a head still moving, and the routes are dropped when the
          // head moved out from under the map that drew them
          let earlyAt: ReturnType<typeof revs> | undefined;
          try { earlyAt = revs(); } catch { earlyAt = undefined; }
          if (st.kind === "blind") {
            if (await holdOnExecutor(rec.idd_id, evs, policy.executorStillSeconds, tickNow)) { note("executor wait"); break; }
          }
          // the head the map was drawn at, and the blind's copies: the step that draws the map again, or waits for a
          // copy, is the fold's answer. The map slot is left free here: the round's own step decides it below
          const early = earlyAt ? upcomingBlindRound(rec, evs, st, earlyAt) : undefined;
          // a lane the map is drawn for first needs no blind copy to get that far: the blind's cap is not asked of it (the
          // map's own cap is, below, once the round is read)
          const mapFirstEarly = mapComesFirst(runner, mapOn, !!st.map, early?.mapped, earlyAt);
          const held = reviewNextStep(evs, {
            reviewOn, mapOn, mapFits: true, blindFits: mapFirstEarly || gate.fits(early ? blindCountOf(pipe, early, blindSize) : unreadBlindCount(blindSize)), routeBlindFits: true,
            ...(earlyAt ? { at: earlyAt } : {}),
          });
          if (held.event === "s2_map_head_moved") {
            await appendLifecycle(String(held.event), rec.idd_id, held.attrs);
            note("map redrawn (head moved)");
            break;
          }
          // the fix left the head where the last round read it: the same code is not reviewed again, penne decides
          if (held.event === "s2_review_escalated") {
            await appendLifecycle(String(held.event), rec.idd_id, held.attrs);
            note("escalated (head unchanged by the fix)");
            break;
          }
          // a head that is only the mainline merged in since the last round carries nothing a review has not read:
          // the round a conflict send-back opened is skipped, and the lane goes on to S3 and the submit. It is judged
          // on the head the executor's work has stopped at, and needs no blind slot. The round would have counted from
          // the last head a review read, so that is where the merge is measured from (on the records check's way the
          // recheck decides the same thing a step earlier). The records check runs for the head the skip stands for:
          // the merge brought records too, and the verdict before it spoke for the head before the merge
          if (st.kind === "blind" && conflictRoundPending(evs)) {
            const since = lastReviewRound(evs);
            const skipped = since && earlyAt ? mergeOnlySkipOf(rec, earlyAt, since.head) : undefined;
            if (skipped) {
              // in a repo that runs its checks before the convergence, they run first at this head (the merge brought
              // code the lane's checks have not read); once they spoke for it the round comes back here and is skipped
              if (earlyAt && await checksHold(rec, evs, earlyAt, st as unknown as Record<string, unknown>)) {
                note("checks started");
                break;
              }
              // the check runs first, and the skip is recorded after its verdict: a check that throws leaves the lane
              // where the next tick runs it again, rather than reading the skip as a review that closed
              await checkRecordsBeforeS3(rec, evs, () => writeMergeOnlySkip(rec, evs, skipped));
              note("review skipped (mainline merge only)");
              break;
            }
          }
          // the executor may have taken the mainline in since the origin was set: the origin catches up before the round
          // reads it, so every stage of the round (and the slot wait) reads the same one
          // (before the first review the harness's own merge does this, and that path stays as it was)
          // an origin that may lack what the head took in does not start the round: it is looked at again on the next tick
          if ((st.kind === "blind" || st.kind === "final") && !beforeFirstReview(evs) && await catchUpReviewBase(rec.idd_id, evs) === "failed") {
            note("review origin not caught up (retry next tick)");
            break;
          }
          if (held.action === "nothing") break;
          // the head the harness just merged the mainline into is the one the round reads
          let at = revs();
          // the lane's own origin before this round narrows what it is shown (an increment final moves `at.base` to
          // the last round's head): the declaration is matched against the lane's whole change, not the shown one
          const laneBase = at.base;
          let matchBase = laneBase;
          let risk: ReturnType<typeof laneRisk> | undefined;
          // under `high_risk_when: last` the round reads the lane's Risk whatever extras it adds, and a final reads
          // it before deciding whether it may be skipped
          if (newHigh) risk = laneRisk(rec, at.worktree, matchBase);
          // the worktree is the same for every read of the lane's Risk: only the base the round is read on moves
          const riskWorktree = at.worktree;
          const high = () => (risk ??= laneRisk(rec, riskWorktree, matchBase)).high;
          // the final blind of code a whole-diff blind already read, and judged within the limit, would look at it again
          // the fold decides it: the tree a whole-diff blind read, or the behaviour files that did not change
          let finalAnswer: { skip?: { kind: string; settled?: string; since?: string; reason: string } | null; wholeForUnread?: boolean } = { skip: null, wholeForUnread: false };
          if (st.kind === "final") {
            const atFinal = at;
            finalAnswer = await judge<{ skip?: { kind: string; settled?: string; since?: string; reason: string } | null; wholeForUnread?: boolean }>(
              "final_review",
              evs,
              { policy, head: atFinal.head },
              async (need) => {
                if (need.kind === "sameTree") return sameTree(atFinal.worktree, need.a, need.b);
                if (need.kind === "behaviour") return behaviourChanges(atFinal.worktree, need.a, need.b);
                if (need.kind === "risk") return high();
                throw new Error(`知らない事実です: ${need.kind}`);
              },
            );
            if (finalAnswer.skip) {
              // a continue with nothing left to fix that ends here says so on the convergence it writes
              const attrs: Record<string, unknown> = { final_skipped: finalAnswer.skip.reason, head: atFinal.head, ...(zeroFixMarks(evs) ?? {}) };
              if (finalAnswer.skip.settled) attrs.settled_head = finalAnswer.skip.settled;
              if (finalAnswer.skip.since) attrs.since_head = finalAnswer.skip.since;
              // a repo that runs its checks before the convergence runs them first, and the convergence carries this
              await convergeOrCheck(rec, evs, () => atFinal, note, attrs, "converged (final skipped)");
              break;
            }
          }
          // what the round is shown: the whole diff, the fixes since the last review (a final under scope increment),
          // or the hunks a mainline merge resolved (the first round after a conflict, under after_merge conflict)
          const shown: { extras?: ReviewExtra[]; scope?: "increment" | "conflict"; merge?: string; laneBase?: string; overview?: string } = {};
          // a diff reviewer is told what the repo is about (the top-level Purpose), never the Choice records
          if (st.kind === "blind" || st.kind === "final") {
            const overview = laneOverview(rec.area);
            if (overview) shown.overview = overview;
          }
          const since = lastReviewRound(evs);
          // the merge the round is shown from, and the conflict it reads: the fold writes the diff's own fields from them
          let diffMerge: string | undefined;
          let conflictRead: { mainline: string; merge: string; recordOnly: boolean } | undefined;
          let reviewBase: string | undefined;
          if (st.kind === "final" && policy.finalScope === "increment" && since && since.head !== at.head) {
            // under `high_risk_when: last` the increment is only shown when the round it starts from was read by the
            // High role; otherwise the earlier changes have not been seen and the whole diff is shown instead
            const wholeForUnread = !!finalAnswer.wholeForUnread;
            if (!wholeForUnread) {
              // the fixes since the last round; the lane's whole change stays nameable, and a mainline merge among the
              // fixes is shown by its resolution rather than by everything it took in
              const m = mergeSince(at.worktree, since.head, at.head);
              shown.scope = "increment";
              shown.laneBase = at.base;
              if (m) { shown.merge = m.merge; diffMerge = m.merge; }
              at = { ...at, base: since.head };
            }
          }
          let conflict = false;
          if (st.kind === "blind" && policy.afterMerge === "conflict" && since) {
            const m = conflictMerge(at.worktree, evs, since, at.head);
            if (m) {
              // the mainline the lane merged is not the lane's change: the base takes it in, for this round and every later one
              reviewBase = mergedReviewBase(at.worktree, rec.idd_id, at.base, m.mainline);
              at = { ...at, base: reviewBase };
              // a conflict round takes the mainline it merged in into its base, so the matching starts there too
              matchBase = at.base;
              conflictRead = { mainline: m.mainline, merge: m.merge, recordOnly: m.recordOnly };
              // a merge with other commits next to it is not all of what changed: the round reads the whole diff on the new base
              if (m.recordOnly) {
                conflict = true;
                shown.scope = "conflict";
                shown.merge = m.merge;
              }
            }
          }
          if (newHigh && !risk) risk = laneRisk(rec, at.worktree, matchBase);
          // the round's depth: a depth-bearing pass records it at its first blind and reads it back afterwards, and a
          // pass that begins after PR feedback records it too, even though the feedback pass is still the latest pass
          // event on record (F-113-11). A lane with no declared depth keeps the configured behaviour (DEC-113-1).
          let roundDepth: Depth | undefined;
          if (st.kind === "blind" || st.kind === "final") {
            roundDepth = passPolicy(evs).depth;
            // the map that ran before this blind is not the blind: the blind that follows still begins the pass (F-113-12)
            if (st.kind === "blind" && firstBlindOfPass(evs) && recordedDepth(evs) !== undefined) {
              roundDepth = laneDepth(rec, at.worktree, laneBase);
            }
          }
          // the fold decides which extra roles the round adds; the lane's Risk is read only when it needs it
          const extrasAnswer = await judge<{ extras?: ReviewExtra[] }>(
            "round_extras",
            evs,
            { policy, kind: st.kind, conflict },
            async (need) => {
              if (need.kind === "risk") return high();
              throw new Error(`知らない事実です: ${need.kind}`);
            },
          );
          let extras: ReviewExtra[] = extrasAnswer.extras ?? [];
          if (roundDepth !== undefined) {
            // the depth's table decides the round's roles: no first-round extra on a blind, and the senior role alone
            // on the last review (DEC-113-2, DEC-113-9)
            extras = st.kind === "final" ? ["high_risk"] : [];
          }
          if (extras.length) shown.extras = extras;
          // a large diff is mapped first; below the threshold, or when the map cannot start, the round runs as it always did.
          // The map runs only before the pass's first blind (C-152-5): a later blind, the final and a conflict round read the
          // whole diff without one. The map reads the request, so it can cut the route (C-152-3)
          const mapped = st.kind === "blind" && !conflict && firstBlindOfPass(evs);
          // whether the diff is large enough is asked first: a small one does not wait for a map slot it will not use
          let mapSkipped = !st.map && mapOn && mapped ? mapSkipReasonOf(runner, at) : undefined;
          // the map is asked for once on a head: a start that named no run does not hold the round back
          let mapTried = false;
          const routes = mapped ? st.map?.routes ?? [] : [];
          /**
           * The facts this round's step reads. The fold decides whether the map runs, what the round's record says,
           * and whether the round waits; the loop only gathers what the ledger does not hold (C-203-1).
           */
          const count = blindCountOf(pipe, { kind: st.kind === "final" ? "final" : "blind", conflict, ...(roundDepth ? { depth: roundDepth } : {}), extras, routes: routes.length }, blindSize);
          // the map drawn first holds none of the blind's copies: until it has been tried on this head (and for the records
          // of the map's own start), the blind's cap is not asked, and the fold goes on to the map's own cap. Once the map
          // named no run, the blind is judged by its cap
          const mapFirst = !!runner?.startReviewRun && mapOn && !st.map && mapped && !mapSkipped;
          const blindFacts = (extra: Partial<StepFacts> = {}): StepFacts => ({
            policy,
            reviewOn,
            mapOn,
            blindFits: (mapFirst && (!mapTried || !!extra.mapRun)) || gate.fits(count),
            mapFits: mapRunning < mapCap,
            routeBlindFits: gate.fitsRouted(count),
            at,
            wholeForUnread: !!finalAnswer.wholeForUnread,
            ...(mapSkipped ? { mapSkipped } : {}),
            ...(since ? { since } : {}),
            ...(roundDepth ? { roundDepth, ...(DEPTH_TABLE[roundDepth] ? { depthFixRounds: DEPTH_TABLE[roundDepth].fixRounds } : {}) } : {}),
            ...(extras.length ? { extras } : {}),
            ...(risk ? { risk: { risk: risk.risk, high: risk.high, ...(risk.match ? { hits: risk.match.hits } : {}) } } : {}),
            ...(st.allowHighFallback ? { allowHighFallback: true } : {}),
            ...(since && diffMerge !== undefined ? { mergeSince: { merge: diffMerge } } : {}),
            ...(conflictRead ? { conflictMerge: conflictRead, ...(reviewBase ? { reviewBase } : {}) } : {}),
            ...(mapTried ? { mapTried: true } : {}),
            ...extra,
          });
          let step = reviewNextStep(evs, blindFacts());
          if (step.action === "start" && step.stage === "map") {
            mapTried = true;
            const mapPlan = lanePlanOf(rec.idd_id, rec);
            const mapInputs = [...(mapPlan ? [mapPlan.rel] : []), planReviewInputs(rec)[1]].filter((x): x is string => !!x);
            let map: Awaited<ReturnType<typeof start>> | undefined;
            try {
              map = await start("map", st.round, mapInputs, undefined, at);
            } catch (err) {
              if (quotaWaitOf(err)) throw err;
              // a map that could not start leaves the round to run as it always did, and the record says so
              const failed = reviewNextStep(evs, blindFacts({ mapRun: { state: "failed", error: String(err).slice(0, 400) } }));
              if (failed.action === "write") await appendLifecycle(String(failed.event), rec.idd_id, failed.attrs);
              note("map failed");
            }
            if (map?.runIds.length) {
              const started = reviewNextStep(evs, blindFacts({ mapRun: startedRunFact(map) }));
              if (started.action === "write") await appendLifecycle(String(started.event), rec.idd_id, started.attrs);
              mapRunning += 1;
              note("map started");
              break;
            }
            mapSkipped = map?.skipped;
            // the map named no run: the round starts in this tick, and the map is not asked for again on this head
            step = reviewNextStep(evs, blindFacts());
          }
          if (step.action !== "start") break;
          const highExtras = extras.includes("high_risk");
          // a High lane's final waits for the High role's windows unless penne let the fallback run (DEC-2765/2766)
          const noFallback = newHigh && highExtras && !st.allowHighFallback ? policy.extraRoles.high_risk : undefined;
          startingHigh = !!noFallback?.length;
          // a depth-bearing round runs the table's roles: the blind takes that many, the last review the senior role alone
          const depthRoles = roundDepth === undefined ? {} : st.kind === "final" ? { onlyHighRisk: true } : { roleCount: DEPTH_TABLE[roundDepth].blind };
          // the spec check reads the lane against its plan beside the blinds: its count is the depth table's, and it is
          // handed the plan, the criteria, the lane's Choices and Purposes, never an earlier round's findings or fixes
          const specCount = roundDepth === undefined ? 0 : DEPTH_TABLE[roundDepth].spec;
          const spec = specCount > 0 ? { count: specCount, inputs: specInputs(rec, evs, st.round, String(st.kind)) } : undefined;
          const startedRun = await start(st.kind === "final" ? "final" : "blind", st.round, [], routes, at, { ...shown, ...depthRoles, ...(spec ? { spec } : {}), ...(noFallback?.length ? { noFallbackRoles: noFallback } : {}) });
          const startedStep = reviewNextStep(evs, blindFacts({ runs: [startedRunFact(startedRun)] }));
          if (startedStep.action === "write") await appendLifecycle(String(startedStep.event), rec.idd_id, startedStep.attrs);
          gate.took(startedRun.runIds.length);
          note(`${st.kind} started`);
          break;
        }
        case "awaiting_merge": {
          // the conflict is waiting for the executor's resolution: the instruction is re-sent each tick until it is
          // on record, and never after (DEC-2402). A missing recorded instruction is a queue that did not go out
          if (evs.some((e) => e.event === "s2_review_base_instructed")) break;
          const pre = await preReviewMerge(rec.idd_id, evs);
          if (pre.records.length) evs.push(...pre.records);
          if (pre.error) result.errors.push({ iddId: rec.idd_id, error: pre.error });
          await markPreMergeWait(rec.idd_id, evs, pre.action);
          break;
        }
        case "awaiting_order": {
          // the gate above answers this state; reaching here means the review slot was undeclared
          const step = reviewNextStep(evs, {});
          if (step.action === "write") await appendLifecycle(String(step.event), rec.idd_id, step.attrs);
          note("order released");
          break;
        }
        case "awaiting_records_fix": {
          // the instruction went out with the send-back; the lane waits for the executor's result. If it did not go
          // out (the queue failed), the lane is not the executor's yet and the next tick tries again (DEC-2402).
          // A later send-back is told from an earlier one by which of the two records came last, which the fold reads
          const held = reviewNextStep(evs, { queued: false });
          if (held.action !== "call") break;
          const conflict = lastOf(evs, "s2_records_conflict");
          const findings = Array.isArray(conflict?.attrs?.errors) ? (conflict.attrs.errors as RecordsFinding[]) : [];
          try {
            await queueEnvelope(rec.idd_id, "lane_rejected", recordsFixEnvelope(rec.idd_id, findings));
          } catch {
            break;
          }
          const sent = reviewNextStep(evs, { queued: true, recordsHead: String(conflict?.attrs?.head ?? ""), recordsErrors: findings });
          if (sent.action === "write") await appendLifecycle(String(sent.event), rec.idd_id, sent.attrs);
          note("records instructed");
          break;
        }
        case "recheck_intent": {
          // the recheck is a stage the executor's result began: it decides on the head its work has stopped at (Issue #159)
          if (await holdOnExecutor(rec.idd_id, evs, reviewPolicy().executorStillSeconds, tickNow)) { note("executor wait"); break; }
          note(await recheckRecords(rec, evs) ? "records rechecked" : "checks started");
          break;
        }
        case "running_map": {
          const s = runner?.reviewRunStatus?.(st.runId);
          if (!s || s.state === "running") break;
          // the run's own id goes with its answer: the fold labels a run by it, and an answer without one would be
          // read as a run that was never named (F-201-1)
          const step = reviewNextStep(evs, { runs: [runFactOf(s, [st.runId])] });
          if (step.action === "write") await appendLifecycle(String(step.event), rec.idd_id, step.attrs);
          mapRunning -= 1;
          note("map done");
          break;
        }
        case "running_blind": {
          if (!runner?.reviewRunStatus) break;
          const states = st.runIds.map((id) => runner.reviewRunStatus!(id));
          if (states.some((s) => s.state === "running")) break;
          // its copies are done with: a lane later in this tick may use them
          gate.released(st.runIds.length);
          // the round's closing record is the fold's: the runs it waits for are the ones it named at its start
          const step = reviewNextStep(evs, {
            runs: states.map((s, i) => runFactOf(s, [st.runIds[i]])),
            policy: reviewPolicy(),
          });
          if (step.action === "write") {
            await appendLifecycle(String(step.event), rec.idd_id, step.attrs);
            note(step.event === "s2_review_findings" ? "findings" : step.event === "s2_map_dropped" ? "map dropped" : "escalated");
          }
          break;
        }
        case "running_device": {
          const s = runner?.reviewRunStatus?.(st.runId);
          if (!s || s.state === "running") break;
          const started = lastOf(evs, "s2_device_started");
          const judge = String(started?.attrs?.judge ?? "");
          const step = reviewNextStep(evs, {
            runs: [runFactOf(s, [st.runId])],
            judge,
            // a person's lane keeps the role's findings on the record for their submit card (they are never fixed)
            deviceFindings: deviceFindings(((s as { findings?: { severity: string; path?: string; claim: string }[] }).findings) ?? []),
            ...(started?.attrs?.stale_reason ? { staleReason: String(started.attrs.stale_reason) } : {}),
          });
          if (step.action === "write") {
            await appendLifecycle(String(step.event), rec.idd_id, step.attrs);
            // the review's rounds are over once the device check concludes without a fix to make: the records
            // check runs here, before S3 (C-161-2)
            if (step.event === "s2_device_done" && step.attrs.failed !== true && (judge === "human" || Number(step.attrs.blocking ?? 0) === 0)) {
              await checkRecordsBeforeS3(rec, evs);
            }
          }
          note("device done");
          break;
        }
        case "start_triage": {
          // whether the round may start, and which judgement it runs as, is the fold's answer
          const held = reviewNextStep(evs, { triageFits: triageRunning < triageCap });
          if (held.action !== "start") break;
          const stage = held.stage as ReviewStage;
          // the triage judges against the lane's own instructions; after a confirm it also needs what was asked
          const prior = st.kind === "confirm" ? lastOf(evs, "s2_triage_done")?.attrs?.report_md : undefined;
          // the leftovers of an S4 confirm are the reviewer's requests still open, so they are judged the PR's way
          const leftovers = stage === "feedback_leftovers";
          const requests = leftovers ? feedbackTriageOf(evs)?.attrs?.report_md : undefined;
          const reports = [prior, requests].filter(Boolean).map(String).filter((p, i, all) => all.indexOf(p) === i);
          // every judgement sees what earlier rounds fixed, so a finding that undoes one of those fixes is told apart
          const history = triageHistory(evs);
          if (history) {
            const file = join(stateDir(), "pipeline", "review", rec.idd_id, `triage-history-${st.round}-${st.kind}.md`);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, history);
            reports.push(file);
          }
          // a pass that closes on musts alone has its judgement leave shoulds for a follow-up by default, as its blind recorded
          const shouldDefault = stage === "triage" && passPolicy(evs).closeOnMust ? { shouldDefault: "followup" as const } : {};
          // a conflict scope round's judgement is handed the follow-ups already written, so it does not report them again
          const existing = st.kind === "blind" && lastOf(evs, "s2_review_started")?.attrs?.diff_scope === "conflict" ? writtenFollowups(evs) : [];
          const existingFile = existing.length ? writeExistingFollowups(rec.idd_id, st.round, st.kind, existing) : undefined;
          if (existingFile) reports.push(existingFile);
          // the Issue lane's judgement is handed the follow-up Issue drafts the lane raised, so a stopgap is taken as
          // recorded only when its draft exists; a runner that cannot read them hands none (and the judgement rejects nothing on a pointer)
          const followupDrafts = !leftovers && runner?.laneFollowupDrafts ? runner.laneFollowupDrafts(rec.idd_id) : undefined;
          if (followupDrafts) reports.push(writeLaneFollowupDrafts(rec.idd_id, st.round, String(st.kind), followupDrafts));
          // the judgement is handed the lane's AC states, so it can check the criteria on the main paths (F-113-10)
          const acFile = writeAcStatesFile(rec, st.round, String(st.kind), evs);
          if (acFile) reports.push(acFile);
          // the judgement is handed the marks of the lane's own records that show a tool refusing the means (Issue #143)
          const means = laneMissingMeans(rec, evs);
          const meansFile = writeMissingMeansFile(rec.idd_id, st.round, String(st.kind), means);
          if (meansFile) reports.push(meansFile);
          // the judgement is handed the repo's own examples of what harm is there; a blind never is (DEC-113-10)
          const harms = writeHarmExamplesFile(rec.area, `${rec.idd_id}-${st.round}-judge`);
          if (harms) reports.push(harms);
          // the judgement reads the work instruction when the lane has one, next to the decision and the qa
          const plan = lanePlanOf(rec.idd_id, rec);
          // a v2 lane's judgement reads the drawn Choices instead of decision.md, next to the qa
          const judgeShape = laneRecordShape(rec.idd_id, evs);
          const judgeChoices = judgeShape === "state" ? writeLaneChoicesFile(rec, `judge-${st.round}-${st.kind}`) : undefined;
          const intentInputs = judgeShape === "state"
            ? [judgeChoices, planReviewInputs(rec)[1]].filter((x): x is string => !!x)
            : planReviewInputs(rec).slice(0, 2);
          // the findings the judgement decides are handed without the reviewer's plan, weight, action or frequency (C-197-2, C-209-5)
          const findings = st.inputs.map((p) => judgementCopy(p, st.round, String(st.kind)));
          const startedRun = await start(stage, st.round, [...findings, ...reports, ...intentInputs, ...(plan ? [plan.rel] : [])], undefined, undefined, { ...shouldDefault, ...(existingFile ? { existingFollowups: true } : {}), ...(plan ? { hasPlan: true } : {}) });
          triageRunning += 1;
          const started = reviewNextStep(evs, { triageFits: true, runs: [startedRunFact(startedRun)], ...(means.length ? { means } : {}) });
          if (started.action === "write") await appendLifecycle(String(started.event), rec.idd_id, started.attrs);
          note("triage started");
          break;
        }
        case "running_triage": {
          const s = runner?.reviewRunStatus?.(st.runId);
          if (!s || s.state === "running") break;
          if (s.state === "failed") {
            const step = reviewNextStep(evs, { runs: [runFactOf(s, [st.runId])] });
            if (step.action === "write") await appendLifecycle(String(step.event), rec.idd_id, step.attrs);
          } else {
            // a finding that undoes an earlier fix is neither accepted nor rejected: it waits for penne's boundary.
            // Only an escalated one with both positions is such a finding; a mark on any other verdict is ignored
            // the weight each reviewer gave a finding is the harness's reading of the report the decision names; the
            // judgement was never handed it, so a value it wrote anyway is not the reporter's (C-209-5)
            const reported = reportedSeverities(rec.idd_id, s.decisions ?? []);
            const decisions = (s.decisions ?? []).map((x) => ({ ...x, reported_severity: reported.get(x.ref) }));
            const reversals = decisions.filter(isReversal);
            const d = decisions.filter((x) => !isReversal(x));
            // the `triage` value reads a should recommended for fixing without the basis or the harm back as a follow-up,
            // keeping on record that the judgement wrote fix. Only the judgements of the review loop, never the PR feedback's
            const pass = passPolicy(evs);
            const readback = pass.closeOnFix && (st.kind === "blind" || st.kind === "final" || st.kind === "confirm" || st.kind === "device" || st.kind === "kept");
            // a depth-bearing round reads a should fix that names no harm back as a placed finding: whether a should is
            // small enough to fix is the judgement's reading of the change's intent, not where the file sits
            const newOrder = pass.depth !== undefined;
            // the line each finding had in the round's own reports, told by its path and claim (a reworded one gets none)
            const roundFindingLines = roundLines(evs);
            const acceptedOfDecision = (x: TriageDecision) => {
              const asFollowup = newOrder
                ? x.severity === "should" && x.action === "fix" && (!x.impact || !x.impact.trim())
                : readback && x.severity === "should" && x.action === "fix" && (!x.fix_basis || !x.impact || !x.impact.trim());
              const action = asFollowup ? "followup" : x.action;
              return withFindingLines([{
                ref: x.ref, severity: x.severity, claim: x.claim, path: x.path, fix: x.fix,
                ...(x.impact ? { impact: x.impact } : {}), ...(x.reason ? { reason: x.reason } : {}),
                ...(action ? { action } : {}), ...(x.fix_basis ? { fix_basis: x.fix_basis } : {}), ...(asFollowup ? { claimed_action: "fix" } : {}),
                ...(x.correction_ref ? { correction_ref: x.correction_ref } : {}),
                ...origin(x),
              }], roundFindingLines)[0];
            };
            // the judgement's decisions are the facts the fold writes from: what it accepted, rejected, put to penne,
            // and the reversals it left for the boundary
            const step = reviewNextStep(evs, {
              runs: [runFactOf(s, [st.runId])],
              accepted: d.filter((x) => x.verdict === "accept").map(acceptedOfDecision),
              rejected: d.filter((x) => x.verdict === "reject").map((x) => ({ ref: x.ref, severity: x.severity, claim: x.claim, reason: x.reason, ...(x.followup ? { followup: true } : {}), ...(x.no_request ? { no_request: true } : {}), ...origin(x) })),
              escalatedClaims: d.filter((x) => x.verdict === "escalate").map((x) => `${x.claim}${x.reason ? `（${x.reason}）` : ""}`),
              ...(reversals.length ? {
                oscillations: reversals.map((x) => ({ ref: x.ref, severity: x.severity, claim: x.claim, ...(x.path ? { path: x.path } : {}), ...(x.reason ? { reason: x.reason } : {}), prior_ref: x.reverts!.prior_ref, prior: x.reverts!.prior, current: x.reverts!.current })),
              } : {}),
            });
            if (step.action === "write") await appendLifecycle(String(step.event), rec.idd_id, step.attrs);
          }
          note("triage done");
          break;
        }
        case "send_fix": {
          // only must / should are fixed; accepted nits stay on record as leftovers for the submit card.
          // A reviewer's request on the PR is fixed whatever its severity, and so is what a confirm found left of it.
          // A reversal goes back with the boundary penne decided on the stuck card
          const { source, accepted, note: userNote, boundaries } = fixScope(evs);
          // the reviewer's how-to-fix rides only the findings this fix is sent for; the others' plans are never read
          const hows = fixHows(rec.idd_id, accepted, evs);
          // the round names the envelope before anything is written, so a fold that cannot be read leaves no instruction
          // behind and a tick that comes back sends the same one rather than a second (the record follows the queue)
          const envelopeId = fixEnvelopeId(rec.idd_id, st.round, evs.filter(returnsToPlan).length);
          const step = reviewNextStep(evs, {
            envelopeId,
            hows: Object.keys(hows),
            acceptedRefs: accepted.map((a) => a.ref),
            boundaryRefs: boundaries.map((b) => b.ref),
            boundaryItems: boundaries.map((b) => ({ ref: b.ref, severity: b.severity, claim: b.claim, ...(b.path ? { path: b.path } : {}), prior_ref: b.prior_ref, decision: b.decision })),
          });
          if (step.action === "write") {
            await queueEnvelope(rec.idd_id, "review_fix", reviewFixEnvelope(rec.idd_id, st.round, accepted, userNote || undefined, source, boundaries, laneRecordShape(rec.idd_id, evs), hows), { envelopeId });
            await appendLifecycle(String(step.event), rec.idd_id, step.attrs);
          }
          note("fix sent");
          break;
        }
        case "start_confirm": {
          // whether the round may start, and which confirm it runs as, is the fold's answer
          const held = reviewNextStep(evs, { confirmFits: confirmRunning < confirmCap });
          if (held.action !== "start") break;
          // the confirm is a review stage the fix's result began: its work has to have stopped first (Issue #159)
          if (await holdOnExecutor(rec.idd_id, evs, reviewPolicy().executorStillSeconds, tickNow)) { note("executor wait"); break; }
          confirmRunning += 1;
          const triage = lastOf(evs, "s2_triage_done");
          const reports = [triage?.attrs?.report_md].filter(Boolean).map(String);
          // a fix sent toward penne's boundaries is checked against them, by their refs
          const bounds = sentBoundaries(evs);
          const boundaryFile = bounds.length ? writeBoundaryList(rec.idd_id, st.round, bounds, laneRecordShape(rec.idd_id, evs)) : undefined;
          const feedback = feedbackTriageOf(evs);
          if (feedback) {
            // an S4 pass: every accepted request whose action is fix is checked by its ref, from a list the confirm is handed
            const scope = feedbackConfirmScope(evs, feedback);
            for (const b of bounds) if (!scope.some((x) => x.ref === b.ref)) scope.push(b);
            const file = writeRefList(evs, rec.idd_id, `confirm-${st.round}.md`, `確かめる指摘（${st.round} 巡目）`, scope);
            const inputs = [file, ...(boundaryFile ? [boundaryFile] : []), ...[feedback.attrs?.report_md].filter(Boolean).map(String)];
            for (const r of reports) if (!inputs.includes(r)) inputs.push(r);
            const startedRun = await start(held.stage as ReviewStage, st.round, inputs);
            const started = reviewNextStep(evs, {
              confirmFits: true,
              runs: [startedRunFact(startedRun)],
              scopeRefs: scope.map((a) => a.ref),
              scopeRefsGiven: true,
              ...(bounds.length ? { boundaryRefs: bounds.map((b) => b.ref) } : {}),
            });
            if (started.action === "write") await appendLifecycle(String(started.event), rec.idd_id, started.attrs);
            note("confirm started");
            break;
          }
          // what the fix was actually sent to fix; the confirm judges by these refs, not by everything the judgement accepted
          const accepted = acceptedOf(triage?.attrs);
          const fix = lastOf(evs, "s2_fix_sent");
          const sentRefs = Array.isArray(fix?.attrs?.refs) ? strs(fix.attrs.refs) : accepted.filter((a) => a.severity !== "nit" && fixesNow(a)).map((a) => a.ref);
          const scope = accepted.filter((a) => sentRefs.includes(a.ref));
          const scopeFile = scope.length ? writeRefList(evs, rec.idd_id, `confirm-${st.round}.md`, `確かめる指摘（${st.round} 巡目）`, scope) : undefined;
          const startedRun = await start(held.stage as ReviewStage, st.round, [...(scopeFile ? [scopeFile] : []), ...reports, ...(boundaryFile ? [boundaryFile] : [])]);
          const started = reviewNextStep(evs, {
            confirmFits: true,
            runs: [startedRunFact(startedRun)],
            scopeRefs: scope.map((a) => a.ref),
            ...(bounds.length ? { boundaryRefs: bounds.map((b) => b.ref) } : {}),
          });
          if (started.action === "write") await appendLifecycle(String(started.event), rec.idd_id, started.attrs);
          note("confirm started");
          break;
        }
        case "running_confirm": {
          const s = runner?.reviewRunStatus?.(st.runId);
          if (!s || s.state === "running") break;
          if (s.state === "failed") {
            const step = reviewNextStep(evs, { runs: [runFactOf(s, [st.runId])] });
            if (step.action === "write") await appendLifecycle(String(step.event), rec.idd_id, step.attrs);
          } else {
            const feedback = feedbackTriageOf(evs);
            const requests = acceptedOf(feedback?.attrs).filter(fixesNow);
            const bounds = sentBoundaries(evs);
            const triageAccepted = acceptedOf(lastOf(evs, "s2_triage_done")?.attrs);
            const accepted = [...triageAccepted, ...requests, ...bounds];
            const items = s.items ?? [];
            // in an S4 pass a listed ref the confirm did not report on is not confirmed, so it is not fixed either;
            // nor, in any pass, is a boundary penne decided
            const started = lastOf(evs, "s2_confirm_started");
            // the refs the confirm was handed: the fix's refs in an S2 pass, the feedback pass's own list otherwise.
            // A record from before the list was written falls back to what that judgement sent to the fix
            const listed = strs(started?.attrs?.scope_refs);
            const fallback = feedback ? requests.map((a) => a.ref) : triageAccepted.filter((a) => a.severity !== "nit" && fixesNow(a)).map((a) => a.ref);
            const boundaryRefs = strs(started?.attrs?.boundary_refs);
            const expected = [...(listed.length ? listed : fallback), ...boundaryRefs].filter((ref, i, all) => all.indexOf(ref) === i);
            // only a ref the confirm was handed is this stage's to report unresolved
            const unresolved = items.filter((i) => !i.resolved && expected.includes(i.ref)).map((i) => i.ref);
            const missing = expected.filter((ref) => !items.some((i) => i.ref === ref));
            // the triage of the leftovers reads the report, which says nothing of what it left out: hand it the list
            const byRef = new Map(accepted.map((a) => [a.ref, a]));
            const missingFile = missing.length
              ? writeRefList(evs, rec.idd_id, `confirm-${st.round}-missing.md`, `確認が報告しなかった指摘（${st.round} 巡目、解消を確かめていない）`, missing.map((ref) => byRef.get(ref) ?? { ref, severity: "should", claim: "" }))
              : undefined;
            // the refs the confirm left open, and the severities of every ref it knew of: the fold writes the counts
            const step = reviewNextStep(evs, {
              runs: [runFactOf(s, [st.runId])],
              unresolved,
              missing,
              severities: [...new Map(accepted.map((a) => [a.ref, a.severity])).entries()].map(([ref, severity]) => ({ ref, severity })),
              scopeRefs: feedback ? requests.map((a) => a.ref) : [],
              boundaryRefs,
              ...(missingFile ? { missingFile } : {}),
            });
            if (step.action === "write") await appendLifecycle(String(step.event), rec.idd_id, step.attrs);
          }
          note("confirm done");
          break;
        }
        case "converge": {
          await convergeOrCheck(rec, evs, revs, note);
          break;
        }
        case "running_checks": {
          const launcher = convergeCheckLauncher();
          const run = launcher.status(rec.idd_id, st.runId);
          // a run the lane's record no longer names (the state was cleared, the engine moved) is read as one that died
          // a run that waited for the repo's heavy checks past its limit is put to penne, with who holds them
          const limit = checksWaitLimitMinutes(rec.area);
          const waited = run?.status === "busy" && run.waitingSince ? (tickNow - Date.parse(run.waitingSince)) / 60_000 : 0;
          const waitOver = waited > limit ? `repo の重い検査の lock が ${Math.round(waited)} 分空かない（待ちの上限 ${limit} 分、持ち主: ${run?.holder ?? "不明"}）` : undefined;
          const facts: StepFacts = run
            ? { runs: [{ state: run.status, ...(run.error ? { error: run.error } : {}) }], checkRows: checkRowsFact(run.rows ?? [], run.basis, run.base), ...(run.base ? { checkBase: run.base } : {}), ...(waitOver ? { checkWaitOver: waitOver } : {}) }
            : { runs: [{ state: "failed", error: "検査の run の記録がありません" }] };
          const step = reviewNextStep(evs, facts);
          if (step.action === "write") {
            await appendLifecycle(String(step.event), rec.idd_id, step.attrs);
            note(step.attrs.outcome ? `checks ${String(step.attrs.outcome)}` : "checks failed");
          } else if (step.action === "start") {
            // the repo's checks kept the run out: it starts again as the same run once they are free (nothing new on
            // the ledger, the lane still reads as checking)
            if (launcher.restart(rec.idd_id, st.runId)) note("checks started");
          }
          break;
        }
        case "start_device": {
          // an undeclared device slot skips the check, and the review's rounds are over
          if (!deviceOn) {
            const undeclared = reviewNextStep(evs, { deviceOn: false });
            if (undeclared.action === "write") await appendLifecycle(String(undeclared.event), rec.idd_id, undeclared.attrs);
            // the review's rounds are over: the records check runs before S3 (C-161-2)
            await checkRecordsBeforeS3(rec, evs);
            note("device skipped");
            break;
          }
          const at = revs();
          // who judges is the lane's own declaration (qa.md の全体の行); the pictures in compare/ are the judging input
          const verdict = deviceVerdict(rec, at);
          // a picture set that is missing, or one that cannot be said to be of this head's screen, is a must the
          // stage writes itself: the lane is sent to a fix rather than passed with nothing looked at
          const report = verdict.action === "must" ? writeDeviceMust(rec.idd_id, st.round, verdict.reason) : undefined;
          const ran = verdict.action === "run" ? verdict : undefined;
          const facts: StepFacts = {
            deviceOn: true,
            verdict: verdict as unknown as StepFacts["verdict"],
            ...(ran ? { judge: ran.judge, ...(ran.stale ? { staleReason: ran.stale } : {}) } : {}),
            pictures: "pictures" in verdict ? verdict.pictures.length : 0,
            ...(report ? { reportPath: report } : {}),
          };
          const held = reviewNextStep(evs, facts);
          if (held.action === "nothing") break;
          if (held.action === "write") {
            await appendLifecycle(String(held.event), rec.idd_id, held.attrs);
            // the review's rounds are over: the records check runs before S3 (C-161-2)
            if (held.event === "s2_device_skipped") await checkRecordsBeforeS3(rec, evs);
            note(held.event === "s2_device_done" ? "device must" : "device skipped");
            break;
          }
          if (!ran) break;
          const statement = writeDeviceStatement(rec.idd_id, st.round, ran);
          const startedRun = await start("device", st.round, [statement, ...ran.pictures.map((p) => join(at.worktree, p))], undefined, at);
          const started = reviewNextStep(evs, { ...facts, runs: [startedRunFact(startedRun)] });
          if (started.action === "write") await appendLifecycle(String(started.event), rec.idd_id, started.attrs);
          note("device started");
          break;
        }
        case "escalated": {
          const wrote = await appendStopIfUnmoved(rec.idd_id, evs, (fresh) => {
            const step = reviewNextStep(fresh, {});
            return step.action === "write" ? { event: String(step.event), attrs: step.attrs } : null;
          });
          if (wrote) note("escalated");
          break;
        }
        default:
          break;
      }
    } catch (err) {
      // waiting for Claude Code's windows is not a start that failed: nothing is counted, the next tick tries again.
      // A High lane's final is put to penne as a retry instead (DEC-2766): the loop tries it again each tick, and a
      // continue lets the fallback run it
      const wait = quotaWaitOf(err);
      if (wait) {
        if (startingHigh) {
          const policy = reviewPolicy();
          const role = policy.extraRoles.high_risk.join(", ");
          const when = wait.resetsAt !== undefined ? `（${new Date(wait.resetsAt * 1000).toISOString()} に再開予定）` : "";
          // a stop with a retry state is a stop of its own: it is counted apart from the loop's plain stop
          await appendStopIfUnmoved(rec.idd_id, evs, (fresh) => fresh.some((e) => e.event === "s2_review_escalated" && e.attrs?.quota_wait && e.attrs?.retry_state) ? null : {
            event: "s2_review_escalated",
            attrs: {
              reason: `High の最後のレビューが Claude の枠待ちです（${role}${when}）。枠が空くと自動で再開し、penne は要判断のカードから代わりの role で進められます: ${wait.reason.slice(0, 200)}`,
              retry_state: { state: "start_blind", kind: "final", round: st.state === "start_blind" ? st.round : 0 },
              quota_wait: { ...(role ? { role } : {}), ...(wait.resetsAt !== undefined ? { resets_at: wait.resetsAt } : {}), reason: wait.reason.slice(0, 400) },
            },
          });
        } else {
          await recordQuotaWait(rec.idd_id, evs, starting ?? st.state, wait);
        }
        continue;
      }
      // a stage that cannot start is recorded, and after a few attempts penne is asked instead of retrying silently
      result.errors.push({ iddId: rec.idd_id, error: String(err) });
      await appendLifecycle("s2_review_run_failed", rec.idd_id, { state: st.state, error: String(err).slice(0, 400) });
      if (startFailures([...evs, { event: "s2_review_run_failed", idd_id: rec.idd_id, at: "", attrs: {} }]) >= START_FAILURE_LIMIT) {
        await appendStopIfUnmoved(rec.idd_id, evs, () => ({ event: "s2_review_escalated", attrs: { reason: `レビューの段を起動できない: ${String(err).slice(0, 200)}`, retry_state: st } }));
      }
    }
  }
  return result;
}
