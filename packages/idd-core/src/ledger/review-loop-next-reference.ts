import type { LifecycleRecord } from "../schema/records.ts";
import type { NextLeg, NextStep, StepFacts, StepRunFact } from "./review-loop-next.ts";
import { recordedDepthReference } from "../plan/depth-reference.ts";
import { LEGACY_MAX_FIX_ROUNDS } from "../config/pipeline.ts";
import { REVIEW_EVENTS, blindEverRan, blocking, checksSettled, convergeAttrsOf, fixScope, zeroFixMarks, feedbackPassAt, firstBlindOfPass, passPolicy, reviewLoopState } from "./review-loop-reference.ts";

/**
 * The review loop's next step, as the TypeScript read it before the MoonBit fold took the step over. It is not on
 * the running path (C-201-1): the cross-check (`packages/idd-fold/crosscheck.mjs`) holds it against the MoonBit
 * answer at every prefix of a real ledger, and the committed fixtures (`packages/idd-core/test/review-loop-next.test.mjs`)
 * hold both against each other.
 *
 * Each leg is read where the loop's record says the lane stands, and writes the record the loop's own writers wrote:
 * the legs the caller's stage-start readings used to hold back (a blind's start, a judgement's start, a confirm's
 * start, the device check) answer the leg and the action only, as C-201-8 has it, and the caller keeps the readings
 * that decide whether to run them. What the step writes comes from the lane's rows and the caller's facts alone
 * (C-201-2), so the same ledger and the same facts give the same step.
 *
 * A lane that resumed a stored state is answered by the branch that state answers with (C-201-7).
 */

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const text = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const lastOf = (events: LifecycleRecord[], name: string) => events.map((e) => e.event).lastIndexOf(name);

/** the answer of a step that writes nothing */
function nothing(leg: NextLeg): NextStep {
  return { leg, action: "nothing", attrs: {} };
}

/** the answer of a step that writes a record */
function wrote(leg: NextLeg, event: string, attrs: Record<string, unknown>): NextStep {
  return { leg, action: "write", event, attrs };
}

/** the answer of a step that starts a run */
function started(leg: NextLeg, stage: string): NextStep {
  return { leg, action: "start", attrs: {}, stage };
}

/** the answer of a step that calls a helper */
function called(leg: NextLeg): NextStep {
  return { leg, action: "call", attrs: {} };
}

/** the run's reports, under the names the record gives them: a report the runner told of none of leaves the field out */
function reportsOf(run: StepRunFact): Record<string, unknown> {
  return {
    ...(typeof run.reportMd === "string" ? { report_md: run.reportMd } : {}),
    ...(typeof run.reportJson === "string" ? { report_json: run.reportJson } : {}),
  };
}

/** the roles that stood in for the ones that were wanted: no change is the field's absence, never an empty list */
function fallbacksOf(fallbacks: unknown): Record<string, unknown> {
  return Array.isArray(fallbacks) && fallbacks.length > 0 ? { fallbacks } : {};
}

/** whether a run has finished, as the runner's port answers it: a run it says nothing of has not */
function running(run: StepRunFact | undefined): boolean {
  return !run || (run.state ?? "running") === "running";
}

/** the stage a judgement runs as: the PR's own feedback, the leftovers of an S4 confirm, or the plain triage */
function triageStage(events: LifecycleRecord[], kind: string): string {
  if (kind === "feedback") return "feedback";
  if (kind === "confirm" && feedbackPassAt(events) >= 0) return "feedback_leftovers";
  return "triage";
}

/** the label the runs of a round's spec check carry in the round's start: they are not blinds, and a round is judged on its blinds */
const SPEC_LABEL = "spec";

/** the runs of the round that are blinds, by the labels its start wrote: the spec check's runs are left out */
function blindRunsOf(events: LifecycleRecord[], runs: StepRunFact[]): StepRunFact[] {
  const started = lastOf(events, "s2_review_started");
  const labels = started < 0 ? [] : strs(events[started].attrs?.run_labels);
  return runs.filter((_, i) => labels[i] !== SPEC_LABEL);
}

/** how many runs finished */
function doneCount(runs: StepRunFact[]): number {
  return runs.filter((run) => run.state === "done").length;
}

/** the routes the whole-diff blind left unread: a route whose own run did not finish, and no whole-diff run stood in */
function unreadRoutes(events: LifecycleRecord[], runs: StepRunFact[], whole: unknown): string[] {
  const started = lastOf(events, "s2_review_started");
  if (started < 0) return [];
  const wholeIds = strs(whole);
  const labels = strs(events[started].attrs?.run_labels);
  const out: string[] = [];
  runs.forEach((run, i) => {
    if (run.state === "done" || wholeIds.includes(strs(run.runIds)[0]) || labels[i] === SPEC_LABEL) return;
    out.push(labels[i] || strs(run.runIds)[0]);
  });
  return out;
}

/** the blind's findings: the files the finished runs wrote, the runs that did not finish, and the routes left unread */
function blindFindings(events: LifecycleRecord[], runs: StepRunFact[], kind: string, round: number): Record<string, unknown> {
  const files = runs.filter((run) => run.state === "done").map((run) => run.reportJson).filter((path): path is string => typeof path === "string");
  const fallbacks = runs.filter((run) => run.state === "done").flatMap((run) => (Array.isArray(run.fallbacks) ? run.fallbacks : []));
  const whole = events[lastOf(events, "s2_review_started")]?.attrs?.whole_run_ids;
  const unread = Array.isArray(whole) ? unreadRoutes(events, runs, whole) : [];
  return {
    kind,
    round,
    files,
    failed_runs: runs.length - doneCount(runs),
    ...(unread.length ? { unread_routes: unread } : {}),
    ...fallbacksOf(fallbacks),
  };
}

/** the confirm's record: what it left open, what it did not report on, and what it found */
function confirmDone(events: LifecycleRecord[], facts: StepFacts, run: StepRunFact, round: number): Record<string, unknown> {
  const severity = new Map((facts.severities ?? []).map((pair) => [pair.ref, pair.severity]));
  const severitiesOf = (ref: string) => severity.get(ref) ?? "should";
  const open = [...(facts.unresolved ?? []), ...(facts.missing ?? [])];
  const feedback = feedbackPassAt(events) >= 0;
  const requests = new Set(strs(facts.scopeRefs));
  const files = [...(typeof run.reportJson === "string" ? [run.reportJson] : []), ...(typeof facts.missingFile === "string" ? [facts.missingFile] : [])];
  return {
    round,
    ...(files.length ? { files } : {}),
    ...(typeof run.reportMd === "string" ? { report_md: run.reportMd } : {}),
    ...fallbacksOf(run.fallbacks),
    unresolved_must: open.filter((ref) => severitiesOf(ref) === "must").length,
    unresolved_should: open.filter((ref) => severitiesOf(ref) === "should").length,
    new_blocking: blocking((run.findings as { severity: string }[] | undefined) ?? []),
    unresolved_refs: open,
    ...((facts.boundaryRefs ?? []).length ? { unresolved_boundaries: open.filter((ref) => (facts.boundaryRefs ?? []).includes(ref)).length } : {}),
    ...(feedback
      ? {
        unresolved_requests: open.filter((ref) => requests.has(ref)).length,
        unresolved_nit: open.filter((ref) => severitiesOf(ref) === "nit").length,
        ...((facts.missing ?? []).length ? { missing_refs: facts.missing } : {}),
      }
      : {}),
  };
}

/** the device check's record: what it found and what it read */
function deviceDone(facts: StepFacts, run: StepRunFact, round: number): Record<string, unknown> {
  const human = facts.judge === "human";
  return {
    round,
    blocking: blocking((run.findings as { severity: string }[] | undefined) ?? []),
    ...(typeof run.reportJson === "string" ? { files: [run.reportJson] } : {}),
    ...(facts.judge ? { judge: facts.judge } : {}),
    ...(human ? { findings: facts.deviceFindings ?? [] } : {}),
    ...(facts.staleReason ? { stale_reason: facts.staleReason } : {}),
    ...(typeof run.reportMd === "string" ? { report_md: run.reportMd } : {}),
    ...(typeof run.skipped === "string" ? { skipped_reason: run.skipped } : {}),
    ...fallbacksOf(run.fallbacks),
  };
}

/** the device check's step: it is skipped when the slot is not declared, and the verdict decides the rest */
function deviceStep(facts: StepFacts, round: number): NextStep {
  if (!facts.deviceOn) return wrote("device", "s2_device_skipped", { reason: "pipeline.device_check が未宣言" });
  const verdict = facts.verdict;
  if (!verdict) return nothing("device");
  if (verdict.action === "skip") return wrote("device", "s2_device_skipped", { reason: text(verdict.reason) });
  if (verdict.action === "must") {
    return wrote("device", "s2_device_done", {
      round,
      blocking: 1,
      judge: "viewer",
      pictures: num(facts.pictures),
      ...(typeof facts.reportPath === "string" ? { files: [facts.reportPath] } : {}),
      findings: [{ severity: "must", claim: text(verdict.reason) }],
    });
  }
  const run = (facts.runs ?? [])[0];
  if (!run) return started("device", "device");
  return wrote("device", "s2_device_started", {
    round,
    run_id: text(strs(run.runIds)[0]),
    judge: text(facts.judge),
    ...(facts.pictures !== undefined ? { pictures: num(facts.pictures) } : {}),
    ...(facts.staleReason ? { stale_reason: facts.staleReason } : {}),
    ...fallbacksOf(run.fallbacks),
  });
}

/** the run's own state: a run the runner says nothing of has not finished */
function stateOf(run: StepRunFact): string {
  return typeof run.state === "string" ? run.state : "running";
}

/** the routes the round is shown: the map's, when this round is one the map is read for */
function routesOf(mapped: boolean, map: { routes?: unknown[] } | undefined): unknown[] {
  return mapped && Array.isArray(map?.routes) ? map.routes : [];
}

/** whether a run's label names a map route (`r1`, `r12`) */
function isRouteLabel(label: string): boolean {
  return /^r\d+$/.test(label);
}

/** the record a round's start writes: the runs it started, the diff it reads, and the pass's shape */
function reviewStartedAttrs(
  events: LifecycleRecord[],
  facts: StepFacts,
  kind: string,
  round: number,
  at: { head: string },
  map: { routes?: unknown[] } | undefined,
  mapped: boolean,
  allowHighFallback: boolean,
  run: StepRunFact,
): Record<string, unknown> {
  const policy = facts.policy ?? {};
  const extras = facts.extras ?? [];
  const newHigh = policy.highRiskWhen === "last" && num(policy.extras?.high_risk) > 0;
  const fields: Record<string, unknown> = {
    kind,
    round,
    run_ids: strs(run.runIds),
    head: at.head,
  };
  if (strs(run.runRoles).length) fields.run_roles = strs(run.runRoles);
  if (strs(run.runLabels).length) fields.run_labels = strs(run.runLabels);
  if (newHigh && extras.includes("high_risk") && allowHighFallback) fields.high_allowed = true;
  const routes = routesOf(mapped, map);
  if (routes.length) {
    // a runner that named no labels narrowed none of its runs by a route
    fields.mapped_routes = run.runLabels === undefined ? routes.length : strs(run.runLabels).filter(isRouteLabel).length;
    fields.route_count = run.routeCount ?? routes.length;
    if (run.routesOverCap) fields.routes_over_cap = true;
    fields.whole_run_ids = run.wholeDiff ?? run.runIds ?? [];
  }
  if (typeof facts.mapSkipped === "string" && facts.mapSkipped.length) fields.map_skipped = facts.mapSkipped;
  if (extras.length) fields.extras = extras;
  if (kind === "final" && policy.finalScope === "increment" && !facts.wholeForUnread) {
    const since = facts.since;
    if (since && since.head !== at.head) {
      fields.diff_base = since.head;
      if (facts.mergeSince) fields.merge = facts.mergeSince.merge;
      fields.diff_scope = "increment";
    }
  }
  if (kind === "blind" && policy.afterMerge === "conflict" && facts.since) {
    const merge = facts.conflictMerge;
    if (merge) {
      if (facts.reviewBase !== undefined) fields.review_base = facts.reviewBase;
      fields.merge = merge.merge;
      if (merge.recordOnly) fields.diff_scope = "conflict";
    }
  }
  // a depth-bearing lane's first blind records the depth the pass runs under
  if (kind === "blind" && firstBlindOfPass(events) && recordedDepthReference(events) !== undefined) {
    if (facts.roundDepth) {
      fields.depth = facts.roundDepth;
      if (facts.depthFixRounds !== undefined) fields.max_fix_rounds = facts.depthFixRounds;
      fields.close_on = "must";
    }
  }
  // a pass with no depth closes the way the config says, recorded when the pass begins
  if (kind === "blind" && passPolicy(events).depth === undefined && !(recordedDepthReference(events) !== undefined && firstBlindOfPass(events))) {
    if (policy.maxFixRounds !== undefined && policy.maxFixRounds !== LEGACY_MAX_FIX_ROUNDS) fields.max_fix_rounds = policy.maxFixRounds;
    if (policy.shouldDefault === "followup") fields.close_on = "must";
    if (policy.shouldDefault === "triage") {
      fields.close_on = "must_and_fix";
      if (policy.maxShouldFix !== undefined) fields.max_should_fix = policy.maxShouldFix;
    }
  }
  if (facts.risk) {
    fields.risk = facts.risk.risk;
    if (Array.isArray(facts.risk.hits)) fields.risk_match = { hits: facts.risk.hits };
  }
  // the final review a continue with nothing left to fix started: the record says the loop came here without a fix
  if (kind === "final") {
    const marks = zeroFixMarks(events);
    if (marks) {
      fields.after_zero_fix = true;
      fields.after_zero_fix_reason = marks.reason;
    }
  }
  Object.assign(fields, fallbacksOf(run.fallbacks));
  return fields;
}

/**
 * Whether the round about to start comes right after a fix (the loop's last row is the fix, and the executor's result
 * is in) and the head is the one the last round read: the fix changed nothing a review has not read. A lane whose last
 * round has no head on record is never read as unmoved.
 */
function unmovedAfterFix(events: LifecycleRecord[], head: string): boolean {
  if (!head) return false;
  const last = [...events].reverse().find((e) => (REVIEW_EVENTS as readonly string[]).includes(e.event));
  if (last?.event !== "s2_fix_sent") return false;
  const started = [...events].reverse().find((e) => e.event === "s2_review_started" && (e.attrs?.kind ?? "blind") !== "device");
  return typeof started?.attrs?.head === "string" && started.attrs.head === head;
}

/**
 * The blind's start: whether the mainline's map runs first, the round a moved head is drawn again for, the review a
 * slot nobody declared is skipped for, and the record the start writes.
 */
function startBlindReference(
  events: LifecycleRecord[],
  state: { kind: string; round: number; map?: { routes?: unknown[]; head?: string }; allowHighFallback?: boolean },
  facts: StepFacts,
): NextStep {
  if (state.kind === "kept") return wrote("converge", "s2_review_converged", { kept_skipped: "守られたかの確かめ（R2）を外した" });
  if (!facts.reviewOn && !blindEverRan(events)) return wrote("blind", "s2_review_skipped", { reason: "pipeline.review_blind が未宣言" });
  const at = facts.at;
  // the fix the last round sent left the head where that round read it: the round would read the same code again, so
  // penne decides (a continue sends the fix again, an accept closes the review) rather than the loop reviewing it twice
  if (at && state.kind === "blind" && unmovedAfterFix(events, at.head)) {
    return wrote("escalate", "s2_review_escalated", {
      reason: `手直しで head が変わらなかった（${at.head}）。同じ head をもう一度レビューしない。続ける（手直しを送り直す）か、受け入れるか、自分で直すかを決めてください`,
      head: at.head,
    });
  }
  // the head the map was drawn at moved: the map is drawn again before the round reads the diff
  if (at && state.kind === "blind") {
    const head = typeof state.map?.head === "string" && state.map.head ? state.map.head : undefined;
    if (head && head !== at.head) {
      return wrote("blind", "s2_map_head_moved", { kind: state.kind, round: state.round, map_head: head, head: at.head });
    }
  }
  if (!facts.blindFits) return nothing("blind");
  // without the lane's own revs the start readings cannot be taken: the start is named, and the caller's read fails the stage
  if (!at) return started("blind", state.kind === "final" ? "final" : "blind");
  // the map run this step started answers the map's own record
  const mapRun = facts.mapRun;
  if (mapRun) {
    if (stateOf(mapRun) === "failed") {
      return wrote("blind", "s2_map_done", {
        kind: state.kind, round: state.round, failed: true, error: text(mapRun.error), routes: [],
      });
    }
    if (strs(mapRun.runIds).length) {
      return wrote("blind", "s2_map_started", {
        kind: state.kind,
        round: state.round,
        run_id: text(strs(mapRun.runIds)[0]),
        head: at.head,
        ...fallbacksOf(mapRun.fallbacks),
      });
    }
  }
  const conflict = Boolean(facts.conflictMerge?.recordOnly);
  const mapped = state.kind === "blind" && !conflict && firstBlindOfPass(events);
  const skippedMap = typeof facts.mapSkipped === "string" && facts.mapSkipped.length > 0;
  if (mapped && !state.map && facts.mapOn && !facts.mapTried && !skippedMap) {
    if (!facts.mapFits) return nothing("blind");
    return started("blind", "map");
  }
  const routes = routesOf(mapped, state.map);
  if (routes.length && !facts.routeBlindFits) return nothing("blind");
  const run = (facts.runs ?? [])[0];
  if (run) {
    return wrote("blind", "s2_review_started", reviewStartedAttrs(events, facts, state.kind, state.round, at, state.map, mapped, Boolean(state.allowHighFallback), run));
  }
  return started("blind", state.kind === "final" ? "final" : "blind");
}
/** how many failures of one check the checks' record keeps */
const CHECK_FAILURES_KEPT = 20;

/** one check's row as the checks' record keeps it: its name and status, what the comparison found, and why it failed */
function checkRowRecord(row: Record<string, unknown>): Record<string, unknown> {
  const failures = strs(row.failures).slice(0, CHECK_FAILURES_KEPT);
  return {
    name: text(row.name),
    status: text(row.status),
    ...(typeof row.verdict === "string" && row.verdict ? { verdict: row.verdict } : {}),
    ...(typeof row.phrase === "string" && row.phrase ? { phrase: row.phrase } : {}),
    ...(failures.length ? { failures } : {}),
    ...(row.status !== "pass" && typeof row.tree_note === "string" && row.tree_note ? { tree_note: row.tree_note } : {}),
    ...(row.status !== "pass" && typeof row.tail === "string" && row.tail ? { tail: row.tail } : {}),
  };
}

/** a failure the lane made, as a must the fix carries: what failed and how, and the tail of the check's output */
function checkFinding(row: Record<string, unknown>): Record<string, unknown> {
  const name = text(row.name);
  const failures = strs(row.failures).slice(0, CHECK_FAILURES_KEPT);
  const phrase = typeof row.phrase === "string" && row.phrase ? row.phrase : "この lane で新しく落ちた";
  const lines = [`必須の検査 ${name} が通るように直す（比べた base では落ちない失敗だけが対象。比べた base は公開 base の先端で、取れなかったときは lane の分岐元）。`];
  // the run checked the head merged with the public base's tip: what failed may come from that tip's commits
  if (typeof row.tree_note === "string" && row.tree_note) lines.push(`${row.tree_note}。`);
  if (failures.length) lines.push(`落ちたもの: ${failures.join(" / ")}`);
  if (typeof row.tail === "string" && row.tail) lines.push(`出力の末尾:\n${row.tail}`);
  return {
    ref: `checks/${name}`,
    severity: "must",
    claim: `収束の前の必須の検査 ${name} が落ちた: ${phrase}`,
    impact: "既存の検査・テストを落とす（提出の検査で止まる）",
    fix: lines.join("\n"),
    action: "fix",
  };
}

/**
 * What a run of the checks found, as the fold reads it: a failure the lane made (`new`) goes to the fix; a row that is
 * neither passed, not applicable nor failing the same at the lane's base (a failure not compared, a check that did not
 * run, a copy that could not be prepared) is `unknown`; nothing else holds the loop.
 */
function checksOutcome(rows: Record<string, unknown>[]): "new" | "unknown" | "pass" {
  if (rows.some((r) => r.status === "fail" && r.verdict === "new")) return "new";
  if (rows.some((r) => r.status !== "pass" && r.status !== "not-applicable" && !(r.status === "fail" && r.verdict === "preexisting"))) return "unknown";
  return "pass";
}

/**
 * The convergence's step: a repo that runs its checks before the loop converges runs them at the head unless they
 * already spoke for it (passed, or penne accepted after them); the convergence is written once they have. The step the
 * convergence state answers with, and the one a final the loop skipped asks for (`convergeAttrs`: what it would write).
 */
export function convergeStepReference(events: LifecycleRecord[], facts: StepFacts = {}): NextStep {
  const attrs = convergeAttrsOf(events, facts.convergeAttrs);
  if (!facts.checksOn) return wrote("converge", "s2_review_converged", attrs);
  const at = facts.at;
  if (!at) return started("checks", "checks");
  if (checksSettled(events, at.head)) return wrote("converge", "s2_review_converged", attrs);
  const run = (facts.runs ?? [])[0];
  if (!run) return started("checks", "checks");
  return wrote("checks", "s2_checks_started", {
    run_id: text(strs(run.runIds)[0]),
    head: at.head,
    ...(Object.keys(attrs).length ? { converge: attrs } : {}),
    ...(facts.resumeState ? { resume_state: facts.resumeState } : {}),
  });
}

/** the step of the checks' run: wait while it runs, start again a run the repo's checks kept out, and record what it found */
function checksRunStep(state: { runId: string; head: string }, facts: StepFacts): NextStep {
  const run = (facts.runs ?? [])[0];
  if (!run || (run.state ?? "running") === "running") return nothing("checks");
  // a run the repo's heavy checks kept out past its wait's limit is put to penne as a run that could not run
  if (run.state === "busy" && facts.checkWaitOver) return wrote("checks", "s2_checks_done", { run_id: state.runId, head: state.head, failed: true, error: facts.checkWaitOver });
  if (run.state === "busy") return started("checks", "checks");
  if (run.state === "failed") return wrote("checks", "s2_checks_done", { run_id: state.runId, head: state.head, failed: true, error: text(run.error) });
  const rows = (facts.checkRows ?? []) as Record<string, unknown>[];
  const outcome = checksOutcome(rows);
  const found = rows.filter((r) => r.status === "fail" && r.verdict === "new");
  return wrote("checks", "s2_checks_done", {
    run_id: state.runId,
    head: state.head,
    outcome,
    checks: rows.map(checkRowRecord),
    ...(typeof facts.checkBase === "string" && facts.checkBase ? { base: facts.checkBase } : {}),
    ...(found.length ? { findings: found.map(checkFinding) } : {}),
  });
}

export function nextStepReference(events: LifecycleRecord[], facts: StepFacts = {}): NextStep {
  return nextStepForState(reviewLoopState(events), events, facts);
}

/** the step of one state of the loop: the leg it steps on, and the record that leg writes */
function nextStepForState(state: ReturnType<typeof reviewLoopState>, events: LifecycleRecord[], facts: StepFacts): NextStep {
  const runs = facts.runs ?? [];
  switch (state.state) {
    case "idle":
    case "done":
    case "fixing":
    case "awaiting_hand_fix":
      return nothing("wait");
    // a continue that left nothing to fix converges with its reason on record; any other convergence writes none. A
    // repo that runs its checks before the convergence runs them first
    case "converge":
      return convergeStepReference(events, facts);
    case "running_checks":
      return checksRunStep(state, facts);
    case "escalated": {
      // a High role's window wait is tried again on each tick, without penne (DEC-2766): the state it stopped in is
      // the state it steps in, and the same reader answers it
      if (state.quotaWait && state.retry) return nextStepForState(state.retry, events, facts);
      // the stop is on record already: the lane waits for penne, the loop does not write it twice. A row that only
      // notes something on the lane (a judge's note, a window wait) does not move the loop, so it is no new stop
      const lastLoopEvent = [...events].reverse().find((e) => (REVIEW_EVENTS as readonly string[]).includes(e.event));
      if (lastLoopEvent?.event === "s2_review_escalated") return nothing("escalate");
      return wrote("escalate", "s2_review_escalated", {
        reason: state.reason,
        ...(state.retry ? { retry_state: state.retry } : {}),
      });
    }
    // the order check: the gate answers this state, and reaching it means the review slot is undeclared
    case "awaiting_order":
      return wrote("blind", "s2_order_released", { reason: "pipeline.review_blind が未宣言" });
    case "awaiting_merge":
      return called("helper");
    case "recheck_intent":
      return called("helper");
    case "awaiting_records_fix": {
      // the instruction went out with the send-back; a later send-back is told from an earlier one by which of the
      // two records came last, and a queue that did not go out leaves the lane to try again
      const conflict = lastOf(events, "s2_records_conflict");
      const instructed = lastOf(events, "s2_records_instructed");
      if (conflict < 0 || (instructed >= 0 && instructed > conflict)) return nothing("helper");
      if (!facts.queued) return called("helper");
      return wrote("helper", "s2_records_instructed", { head: facts.recordsHead ?? "", errors: facts.recordsErrors ?? [] });
    }
    case "running_map": {
      const run = runs[0];
      if (running(run)) return nothing("map");
      const fields: Record<string, unknown> = { kind: state.kind, round: state.round };
      if (run.state === "failed") {
        fields.failed = true;
        fields.error = text(run.error);
        fields.routes = [];
      } else {
        fields.routes = run.routes ?? [];
        Object.assign(fields, reportsOf(run));
      }
      if (state.head) fields.head = state.head;
      if (run.state === "done") Object.assign(fields, fallbacksOf(run.fallbacks));
      return wrote("map", "s2_map_done", fields);
    }
    case "running_blind": {
      if (runs.some((run) => (run.state ?? "running") === "running")) return nothing("blind");
      const started0 = events[lastOf(events, "s2_review_started")];
      const whole = started0?.attrs?.whole_run_ids;
      // a routed round is judged when the whole-diff blind finished: a route blind that failed leaves its route unread
      if (Array.isArray(whole)) {
        const wholeIds = strs(whole);
        const wholeDone = runs.some((run) => run.state === "done" && wholeIds.includes(strs(run.runIds)[0]));
        if (!wholeDone) {
          return wrote("blind", "s2_map_dropped", {
            kind: state.kind,
            round: state.round,
            reason: "差分全体を読む blind が終わらなかったので、地図なしで起こし直す",
          });
        }
      }
      // a done run the runner told of no report for is a run that finished: only a round with no done run is all failed
      // (a spec check that finished does not stand in for blinds that did not)
      const blinds = blindRunsOf(events, runs);
      if (doneCount(blinds) === 0) {
        const errors = blinds.map((run) => (run.state === "failed" ? text(run.error) : "")).filter(Boolean).join(" / ");
        return wrote("blind", "s2_review_escalated", {
          reason: `レビューがすべて失敗: ${errors}`,
          retry_state: { state: "start_blind", kind: state.kind === "final" ? "final" : state.kind === "kept" ? "kept" : "blind", round: state.round },
        });
      }
      // under `high_risk_when: last` a High lane's final is judged only when the High role ran to the end
      const policy = facts.policy;
      if (state.kind === "final" && policy?.highRiskWhen === "last" && num(policy.extras?.high_risk) > 0 && started0?.attrs?.high_allowed !== true) {
        const highRoles = new Set(policy.extraRoles?.high_risk ?? []);
        const at = strs(started0?.attrs?.run_roles).map((role, i) => (highRoles.has(role) ? i : -1)).filter((i) => i >= 0);
        if (at.length && at.some((i) => runs[i]?.state !== "done")) {
          return wrote("blind", "s2_review_escalated", {
            reason: `High のレビュー（${[...highRoles].join(", ")}）が完走しなかったので、巡を判定に回さない`,
            retry_state: { state: "start_blind", kind: "final", round: state.round },
          });
        }
      }
      return wrote("blind", "s2_review_findings", blindFindings(events, runs, state.kind, state.round));
    }
    case "running_triage": {
      const run = runs[0];
      if (running(run)) return nothing("triage");
      if (run.state === "failed") {
        return wrote("triage", "s2_triage_done", { kind: state.kind, round: state.round, failed: true, error: text(run.error) });
      }
      return wrote("triage", "s2_triage_done", {
        kind: state.kind,
        round: state.round,
        ...(typeof run.reportMd === "string" ? { report_md: run.reportMd } : {}),
        ...fallbacksOf(run.fallbacks),
        accepted: facts.accepted ?? [],
        rejected: facts.rejected ?? [],
        escalated_claims: facts.escalatedClaims ?? [],
        ...((facts.oscillations ?? []).length ? { oscillations: facts.oscillations } : {}),
      });
    }
    case "running_confirm": {
      const run = runs[0];
      if (running(run)) return nothing("confirm");
      if (run.state === "failed") return wrote("confirm", "s2_confirm_done", { round: state.round, failed: true, error: text(run.error) });
      return wrote("confirm", "s2_confirm_done", confirmDone(events, facts, run, state.round));
    }
    case "running_device": {
      const run = runs[0];
      if (running(run)) return nothing("device");
      if (run.state === "failed") return wrote("device", "s2_device_done", { round: state.round, failed: true, error: text(run.error) });
      return wrote("device", "s2_device_done", deviceDone(facts, run, state.round));
    }
    case "start_triage": {
      if (!facts.triageFits) return nothing("triage");
      const run = runs[0];
      if (!run) return started("triage", triageStage(events, state.kind));
      return wrote("triage", "s2_triage_started", {
        kind: state.kind,
        round: state.round,
        run_id: text(strs(run.runIds)[0]),
        ...((facts.means ?? []).length ? { missing_means: facts.means } : {}),
        ...fallbacksOf(run.fallbacks),
      });
    }
    case "start_confirm": {
      if (!facts.confirmFits) return nothing("confirm");
      const run = runs[0];
      if (!run) return started("confirm", feedbackPassAt(events) >= 0 ? "feedback_confirm" : "confirm");
      return wrote("confirm", "s2_confirm_started", {
        round: state.round,
        run_id: text(strs(run.runIds)[0]),
        ...(facts.scopeRefsGiven || (facts.scopeRefs ?? []).length ? { scope_refs: facts.scopeRefs ?? [] } : {}),
        ...((facts.boundaryRefs ?? []).length ? { boundary_refs: facts.boundaryRefs } : {}),
        ...fallbacksOf(run.fallbacks),
      });
    }
    case "start_device":
      return deviceStep(facts, state.round);
    case "send_fix": {
      // the envelope the fix went out as: the caller queues it first, and its answer is the step's record
      if (!facts.envelopeId) return called("send_fix");
      return wrote("send_fix", "s2_fix_sent", {
        round: state.round,
        refs: facts.acceptedRefs ?? [],
        envelope_id: facts.envelopeId,
        how_refs: facts.hows ?? [],
        ...((facts.boundaryRefs ?? []).length ? { boundary_refs: facts.boundaryRefs, boundaries: facts.boundaryItems ?? [] } : {}),
        // a fix of the checks' failures says so: no confirm reads it, the next round reviews the whole diff
        ...(fixScope(events).source === "checks" ? { source: "checks" } : {}),
      });
    }
    case "start_blind":
      return startBlindReference(events, state, facts);
  }
}
