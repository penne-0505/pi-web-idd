import type { LifecycleRecord } from "../schema/records.ts";
import { laneHeld, planReviewPhase } from "../ledger/derive-reference.ts";

/**
 * The startup stages' next step, as the TypeScript read it before the MoonBit fold took the stages over. It is not on
 * the running path (C-205-1): the cross-check (`packages/idd-fold/crosscheck.mjs`) holds it against the MoonBit
 * answer at every prefix of a real ledger over a set of observations, and the committed fixture test
 * (`packages/idd-core/test/start-steps.test.mjs`) holds both against each other.
 *
 * The steps are read from the lane's rows and the observations alone, so the same ledger and the same answers give
 * the same steps (C-199-3). A helper's answer is read back under the fact the step named; the readings of the lane's
 * own plan review and of whether the lane is held are the TypeScript readings of the same ledger.
 */

type Facts = Record<string, unknown>;

function given(facts: Facts, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(facts, id);
}

function valueOf(facts: Facts, id: string): unknown {
  return given(facts, id) ? facts[id] : null;
}

function jsString(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined).map(jsString).join(",");
  return "[object Object]";
}

/** the text of a fact, or the empty string where it holds nothing */
function textOf(value: unknown): string {
  return value === null || value === undefined ? "" : jsString(value);
}

/** whether a fact reads as a yes: the fold reads a false and a missing answer the same way */
function yesOf(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  return true;
}

/** a whole number a fact holds, or zero: a value that is not a whole number reads as nothing */
function intOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

const objOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const arrOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const text = (facts: Facts, id: string): string => textOf(valueOf(facts, id));
const yes = (facts: Facts, id: string): boolean => yesOf(valueOf(facts, id));
const int = (facts: Facts, id: string): number => intOf(valueOf(facts, id));

/** a helper's answer, when the caller has already run it */
function answerOf(facts: Facts, helper: string, site: string): Record<string, unknown> {
  return objOf(objOf(valueOf(facts, `call|${helper}|${site}`)).result);
}

const called = (facts: Facts, helper: string, site: string): boolean => given(facts, `call|${helper}|${site}`);

const writeStep = (event: string, attrs: unknown) => ({ do: "write", event, attrs });
const callStep = (helper: string, site: string, args: unknown, fatal: boolean) => ({
  do: "call",
  helper,
  site,
  fact: `call|${helper}|${site}`,
  keep: null,
  args,
  fatal,
});
const action = (name: string) => ({ do: "action", action: name });
const actionReason = (name: string, reason: string) => ({ do: "action", action: name, reason });
/** a stage that waits rather than fails says so itself; the caller reads no words for it */
const actionWait = (reason: string) => ({ do: "action", action: "skipped", reason, wait: true });
const actionError = (name: string, error: string) => ({ do: "action", action: name, error });
const steps = (list: unknown[]) => ({ steps: list });

/** the rows of one lane, in the order they were written */
const rowsOf = (rows: LifecycleRecord[], lane: string): LifecycleRecord[] => rows.filter((row) => row.idd_id === lane);
const has = (rows: LifecycleRecord[], event: string): boolean => rows.some((row) => row.event === event);
const countOf = (rows: LifecycleRecord[], event: string): number => rows.filter((row) => row.event === event).length;

/** the lanes the rows name, once each, in the order they first appear */
function lanesOf(rows: LifecycleRecord[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    if (seen.has(row.idd_id)) continue;
    seen.add(row.idd_id);
    out.push(row.idd_id);
  }
  return out;
}

/** whether a lane is closed or put on hold: its startup stage leaves it alone */
const closed = (rows: LifecycleRecord[]): boolean => has(rows, "lane_close") || has(rows, "s1_defer");

const capacityOf = (limit: number, running: number): number => Math.max(0, limit - running);

const lastIndexOfEvent = (rows: LifecycleRecord[], event: string): number => {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].event === event) return i;
  return -1;
};

/** the sessions that still hold a slot of the stage: the lane's rows do not end them yet */
function runningSessions(rows: LifecycleRecord[], facts: Facts, stage: string): number {
  const ended = stage === "executor" ? ["s2_result", "lane_close"] : ["s1_ready", "s1_defer", "lane_close"];
  let n = 0;
  for (const item of arrOf(valueOf(facts, "sessions"))) {
    const session = objOf(item);
    // a session spawned to carry a fix is not a lane's implementation slot
    if (stage === "executor" && textOf(session.kind) === "fix") continue;
    const id = textOf(session.idd_id);
    if (id === "") continue;
    const laneRows = rowsOf(rows, id);
    if (ended.some((event) => has(laneRows, event))) continue;
    n += 1;
  }
  return n;
}

/** how many lanes are at the stage now: the sessions that still hold a slot, or the plan reviews still running */
export function startRunningReference(rows: LifecycleRecord[], facts: Facts, stage: string): number {
  if (stage !== "plan_review") return runningSessions(rows, facts, stage);
  let n = 0;
  for (const lane of lanesOf(rows)) {
    const laneRows = rowsOf(rows, lane);
    if (closed(laneRows)) continue;
    if (planReviewPhase(laneRows).phase === "running") n += 1;
  }
  return n;
}

/** the answer of the running count, as the fold gives it */
export function startCountsReference(rows: LifecycleRecord[], facts: Facts): { running: number } {
  return { running: startRunningReference(rows, facts, textOf(valueOf(facts, "stage"))) };
}

/** the shape the lane's last ready was planned under */
function readyShape(rows: LifecycleRecord[]): string {
  const at = lastIndexOfEvent(rows, "s1_ready");
  if (at < 0) return "docs";
  return textOf((rows[at].attrs ?? {}).records_shape) === "state" ? "state" : "docs";
}

/** the plan records a lane's last ready carries, or nothing when it carries none */
function planRecords(rows: LifecycleRecord[]): unknown {
  const at = lastIndexOfEvent(rows, "s1_ready");
  if (at < 0) return null;
  const records = (rows[at].attrs ?? {}).plan_records;
  return records !== null && typeof records === "object" && !Array.isArray(records) ? records : null;
}

/** the worktree the stage starts in: a place out of space holds the lane back, a repo with no place has none */
function worktreeStep(facts: Facts, list: unknown[], site: string): boolean {
  if (!called(facts, "ensure_worktree", site)) {
    list.push(callStep("ensure_worktree", site, null, false));
    return false;
  }
  const work = answerOf(facts, "ensure_worktree", site);
  if (yesOf(work.none)) {
    list.push(actionReason("skipped", "area has no local_path"));
    return false;
  }
  const error = textOf(work.error);
  if (error !== "") {
    const held = textOf(work.hold);
    list.push(held !== "" ? actionWait(held) : actionReason("skipped", `worktree: ${error}`));
    return false;
  }
  return true;
}

/** the wait a Claude Code window's refusal leaves, as the start records it */
function quotaStep(facts: Facts, list: unknown[], answer: Record<string, unknown>, site: string): boolean {
  const quota = answer.quota;
  if (!yesOf(quota)) return false;
  if (!called(facts, "record_quota_wait", site)) {
    list.push(callStep("record_quota_wait", site, null, false));
    return true;
  }
  list.push(actionReason("skipped", `claude quota: ${textOf(objOf(quota).reason)}`));
  return true;
}

/** the planner's start: the slot it waits for, its worktree, the session, its record, the brief it is handed */
export function startPrepReference(rows: LifecycleRecord[], facts: Facts): unknown {
  const running = runningSessions(rows, facts, "planner");
  const capacity = capacityOf(int(facts, "limit"), running);
  const list: unknown[] = [];
  const hold = text(facts, "hold");
  if (hold !== "") return steps([actionWait(hold)]);
  if (!yes(facts, "runner")) return steps([actionReason("skipped", "no runner")]);
  if (int(facts, "started") >= capacity) return steps([actionWait("concurrency cap")]);
  if (!worktreeStep(facts, list, "prep")) return steps(list);
  if (!called(facts, "spawn", "prep")) {
    list.push(callStep("spawn", "prep", null, false));
    return steps(list);
  }
  const spawned = answerOf(facts, "spawn", "prep");
  if (textOf(spawned.error) !== "") {
    if (!quotaStep(facts, list, spawned, "prep")) list.push(actionReason("skipped", textOf(spawned.error)));
    return steps(list);
  }
  for (const helper of ["record_session", "record_quota_fallbacks", "deliver"]) {
    if (!called(facts, helper, "prep")) {
      list.push(callStep(helper, "prep", null, false));
      return steps(list);
    }
    const answered = answerOf(facts, helper, "prep");
    if (textOf(answered.error) !== "") {
      if (!quotaStep(facts, list, answered, "prep")) list.push(actionReason("skipped", textOf(answered.error)));
      return steps(list);
    }
  }
  list.push(action("started"));
  return steps(list);
}

/** the executor's start: the start it may write, its worktree, the plan records, the session, its record, the brief */
export function startExecReference(rows: LifecycleRecord[], facts: Facts): unknown {
  const lane = text(facts, "lane");
  const laneRows = rowsOf(rows, lane);
  const running = runningSessions(rows, facts, "executor");
  const capacity = capacityOf(int(facts, "limit"), running);
  const list: unknown[] = [];
  if (!yes(facts, "runner")) return steps([actionReason("skipped", "no runner")]);
  if (int(facts, "started") >= capacity) return steps([actionWait("concurrency cap")]);
  // the lane may have been aborted or sent back since the list was read: nothing is made or spawned for it
  if (!called(facts, "transition_refusal", "s2_start")) {
    list.push(callStep("transition_refusal", "s2_start", null, false));
    return steps(list);
  }
  const refusal = answerOf(facts, "transition_refusal", "s2_start");
  const refused = textOf(refusal.reason);
  if (refused !== "") return steps([actionReason("skipped", `s2_start: ${refused}`)]);
  if (!worktreeStep(facts, list, "exec")) return steps(list);
  // a v2 lane writes its plan report's drafts and disposals to the column before its executor starts
  const shapeState = readyShape(laneRows) === "state" || text(facts, "sessionShape") === "state";
  if (shapeState && !has(laneRows, "s2_plan_written")) {
    if (planRecords(laneRows) === null) {
      return steps([actionReason("skipped", "plan records: s1_ready か plan_records がありません")]);
    }
    if (!called(facts, "write_plan_records", "exec")) {
      list.push(callStep("write_plan_records", "exec", null, false));
      return steps(list);
    }
    const wrote = answerOf(facts, "write_plan_records", "exec");
    const error = textOf(wrote.error);
    if (error !== "") return steps([actionReason("skipped", `plan records: ${error}`)]);
    if (!yesOf(wrote.ok)) return steps([actionReason("skipped", `plan records: ${error}`)]);
    if (!yesOf(wrote.done)) return steps([actionReason("skipped", "plan records: 書き終えていません")]);
    return steps([writeStep("s2_plan_written", wrapped(wrote.attrs))]);
  }
  // a lane whose records hold no decision but do hold a condition still has a contract to implement
  if (!called(facts, "read_contract", "exec")) {
    list.push(callStep("read_contract", "exec", null, true));
    return steps(list);
  }
  if (yesOf(answerOf(facts, "read_contract", "exec").empty)) {
    return steps([actionReason("skipped", "contract is empty")]);
  }
  // the planner's records are committed before the executor moves: they are not in the published diff
  if (!called(facts, "commit_records", "exec")) {
    list.push(callStep("commit_records", "exec", null, false));
    return steps(list);
  }
  const committed = answerOf(facts, "commit_records", "exec");
  if (textOf(committed.error) !== "") return steps([actionReason("skipped", textOf(committed.error))]);
  // the spawn runs outside the lane gate: the start is checked inside it afterwards
  if (!called(facts, "spawn", "exec")) {
    list.push(callStep("spawn", "exec", null, false));
    return steps(list);
  }
  const spawned = answerOf(facts, "spawn", "exec");
  if (textOf(spawned.error) !== "") {
    if (!quotaStep(facts, list, spawned, "exec")) list.push(actionReason("skipped", textOf(spawned.error)));
    return steps(list);
  }
  // the start's record: the session is recorded first, and a start that did not go through takes it back
  if (!called(facts, "write_start", "exec")) {
    list.push(callStep("write_start", "exec", null, false));
    return steps(list);
  }
  const started = answerOf(facts, "write_start", "exec");
  const startError = textOf(started.error);
  const startRefused = textOf(started.reason);
  const failed = startError !== "" ? startError : startRefused;
  if (failed !== "") {
    if (!called(facts, "discard_session", "exec")) {
      list.push(callStep("discard_session", "exec", null, false));
      return steps(list);
    }
    const discarded = answerOf(facts, "discard_session", "exec");
    return steps([actionReason("skipped", `s2_start: ${failed}${textOf(discarded.left)}`)]);
  }
  if (!called(facts, "deliver", "exec")) {
    list.push(callStep("deliver", "exec", null, false));
    return steps(list);
  }
  const delivered = answerOf(facts, "deliver", "exec");
  if (textOf(delivered.error) !== "") return steps([actionReason("skipped", textOf(delivered.error))]);
  list.push(action("started"));
  return steps(list);
}

/** a value the fold hands to a write as it read it: a missing one is the JSON null */
function wrapped(value: unknown): unknown {
  return value === undefined ? null : value;
}

/** the runs a started record names: the ids it lists, or its one id when it lists none */
function runIdsOf(started: Record<string, unknown>): string[] {
  const ids = arrOf(started.run_ids)
    .map((item) => jsString(item))
    .filter((id) => id !== "");
  if (ids.length > 0) return ids;
  const one = textOf(started.run_id);
  return one !== "" ? [one] : [];
}

/** the runs a started record lists, by id: the role and the model each read as */
function runMetaOf(started: Record<string, unknown>, ids: string[]): Record<string, unknown>[] {
  const listed = arrOf(started.runs).map(objOf);
  return ids.map((id) => {
    let role = "";
    let model = "";
    let shape = false;
    for (const row of listed) {
      if (textOf(row.run_id) === id) {
        role = textOf(row.role);
        model = textOf(row.model);
        shape = yesOf(row.shape);
      }
    }
    if (model === "" && ids.length === 1) model = textOf(started.model);
    const out: Record<string, unknown> = { run_id: id };
    if (role !== "") out.role = role;
    if (model !== "") out.model = model;
    if (shape) out.shape = true;
    return out;
  });
}

/** the name a run reads as: a role run by more than one model keeps both, so a finding is traceable to its run */
function runLabelOf(run: Record<string, unknown>, index: number, roleRuns: Map<string, number>): string {
  const role = textOf(run.role);
  const model = textOf(run.model);
  if (role !== "") {
    const same = roleRuns.get(role) ?? 0;
    return same > 1 && model !== "" ? `${role}/${model}` : role;
  }
  return model !== "" ? model : `run-${index + 1}`;
}

const severityCount = (findings: unknown[], severity: string): number =>
  findings.filter((item) => textOf(objOf(item).severity) === severity).length;

/** a run's own attrs: its id, the role and the model it read as */
function runFieldsOf(run: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { run_id: textOf(run.run_id) };
  const role = textOf(run.role);
  if (role !== "") out.role = role;
  const model = textOf(run.model);
  if (model !== "") out.model = model;
  if (yesOf(run.shape)) out.shape = true;
  return out;
}

/** the runs that did not finish, each named by its label and the error it ended with */
function failedParts(perRun: unknown[], roleRuns: Map<string, number>): string[] {
  return perRun.flatMap((run, index) => (yesOf(objOf(run).failed) ? [`${runLabelOf(objOf(run), index, roleRuns)}: ${textOf(objOf(run).error)}`] : []));
}

/** one object's fields copied with one key replaced */
function withTextField(value: unknown, key: string, fieldText: string): Record<string, unknown> {
  return { ...objOf(value), [key]: fieldText };
}

/** the started record: the runs, the attempt, the roles that did not start, and the ones that stood in */
function startedAttrs(answer: Record<string, unknown>, attempt: number): Record<string, unknown> {
  const ids: string[] = [];
  const runs: unknown[] = [];
  for (const item of arrOf(answer.runs)) {
    const run = objOf(item);
    const id = textOf(run.runId);
    ids.push(id);
    const fields: Record<string, unknown> = { run_id: id };
    const role = textOf(run.role);
    if (role !== "") fields.role = role;
    const model = textOf(run.model);
    if (model !== "") fields.model = model;
    if (yesOf(run.shape)) fields.shape = true;
    runs.push(fields);
  }
  const out: Record<string, unknown> = {
    run_ids: ids,
    runs,
    attempt,
  };
  const failed = answer.failed;
  if (Array.isArray(failed) && failed.length > 0) out.start_failed = failed;
  const fallbacks = answer.fallbacks;
  if (Array.isArray(fallbacks) && fallbacks.length > 0) out.fallbacks = fallbacks;
  return out;
}

/** the record a review that could not start leaves: never a block on the GO */
const reviewFailedStep = (error: string) => writeStep("s1_plan_review_done", { failed: true, error });

/** a lane whose review has not started: the slot it waits for, the planner's worktree, the runs */
function planReviewWaiting(rows: LifecycleRecord[], laneRows: LifecycleRecord[], facts: Facts): unknown {
  const list: unknown[] = [];
  if (!yes(facts, "declared")) {
    // the plan this ready carries was already recorded as skipped: the record says it once, and the ticks after wait
    // for the slot without writing it again (a phase that reads the skip as the review's end never gets here; this stays
    // so a phase that waits again cannot write it twice)
    if (lastIndexOfEvent(laneRows, "s1_plan_review_skipped") > lastIndexOfEvent(laneRows, "s1_ready")) {
      return steps([action("waiting")]);
    }
    list.push(writeStep("s1_plan_review_skipped", { reason: "pipeline.plan_review が未宣言" }));
    list.push(action("skipped"));
    return steps(list);
  }
  const running = startRunningReference(rows, facts, "plan_review");
  // the lanes this pass already started hold slots too: the rows the caller handed in do not carry them
  if (!yes(facts, "runnerStart") || running + int(facts, "started") >= int(facts, "limit")) {
    return steps([action("waiting")]);
  }
  if (!called(facts, "planner_worktree", "start")) return steps([callStep("planner_worktree", "start", null, false)]);
  const planner = answerOf(facts, "planner_worktree", "start");
  if (yesOf(planner.none)) {
    const error = "planner の worktree が記録にありません";
    list.push(reviewFailedStep(error));
    list.push(actionError("error", error));
    return steps(list);
  }
  if (!called(facts, "start_runs", "start")) return steps([callStep("start_runs", "start", null, false)]);
  const started = answerOf(facts, "start_runs", "start");
  // waiting for Claude Code's windows is not a failed review: the lane waits and the next tick tries again
  if (yesOf(started.quota)) {
    if (!called(facts, "record_quota_wait", "start")) return steps([callStep("record_quota_wait", "start", null, false)]);
    return steps([action("waiting")]);
  }
  const error = textOf(started.error);
  if (error !== "") {
    list.push(reviewFailedStep(error));
    list.push(actionError("error", error));
    return steps(list);
  }
  const attempt = countOf(laneRows, "s1_plan_review_started") + 1;
  list.push(writeStep("s1_plan_review_started", startedAttrs(started, attempt)));
  list.push(action("started"));
  return steps(list);
}

/** a lane whose review runs: the runs' states, the counts the closing record keeps, and the send-back it opens */
function planReviewRunning(laneRows: LifecycleRecord[], facts: Facts): unknown {
  if (!yes(facts, "runnerStatus")) return steps([action("waiting")]);
  const at = lastIndexOfEvent(laneRows, "s1_plan_review_started");
  const started = at < 0
    ? {}
    : {
        run_ids: wrapped((laneRows[at].attrs ?? {}).run_ids),
        run_id: wrapped((laneRows[at].attrs ?? {}).run_id),
        runs: wrapped((laneRows[at].attrs ?? {}).runs),
        start_failed: wrapped((laneRows[at].attrs ?? {}).start_failed),
        model: wrapped((laneRows[at].attrs ?? {}).model),
      };
  const ids = runIdsOf(started);
  // a run still answering leaves the lane where it is
  for (const id of ids) {
    if (!called(facts, "run_status", id)) return steps([callStep("run_status", id, { runId: id }, false)]);
    if (textOf(answerOf(facts, "run_status", id).state) === "running") return steps([action("waiting")]);
  }
  const meta = runMetaOf(started, ids);
  const roleRuns = new Map<string, number>();
  for (const run of meta) {
    const role = textOf(run.role);
    if (role !== "") roleRuns.set(role, (roleRuns.get(role) ?? 0) + 1);
  }
  // the run each finished list belongs to, and the runs that did not finish
  const perRun: unknown[] = [];
  const done: number[] = [];
  // the shape judge is a condition of its own: its run is counted apart from the reviewers' (C-252-5)
  let shapeRuns = 0;
  let shapeDone = 0;
  let failed = 0;
  meta.forEach((run, index) => {
    const status = answerOf(facts, "run_status", textOf(run.run_id));
    const fields = runFieldsOf(run);
    if (textOf(status.state) === "done") {
      const findings = arrOf(status.findings);
      fields.must = severityCount(findings, "must");
      fields.should = severityCount(findings, "should");
      fields.nit = severityCount(findings, "nit");
      if (typeof status.reportMd === "string") fields.report_md = status.reportMd;
      done.push(index);
      if (yesOf(run.shape)) {
        shapeRuns += 1;
        shapeDone += 1;
      }
    } else {
      if (yesOf(run.shape)) shapeRuns += 1;
      fields.failed = true;
      fields.error = textOf(status.error);
      failed += 1;
    }
    perRun.push(fields);
  });
  for (const item of arrOf(started.start_failed)) {
    const run = objOf(item);
    const fields: Record<string, unknown> = {};
    const role = textOf(run.role);
    if (role !== "") fields.role = role;
    const model = textOf(run.model);
    if (model !== "") fields.model = model;
    if (yesOf(run.shape)) {
      fields.shape = true;
      shapeRuns += 1;
    }
    fields.failed = true;
    fields.error = textOf(run.error);
    perRun.push(fields);
    failed += 1;
  }
  const list: unknown[] = [];
  // no reviewer finished, whatever the shape judge did: the review is a failure, which never blocks GO. A judge that
  // finished does not stand in for a reviewer that did not, nor the other way round.
  if (done.length - shapeDone === 0) {
    const parts = failedParts(perRun, roleRuns);
    const error = parts.length > 0 ? parts.join(" / ") : "査読の run が記録にありません";
    list.push(writeStep("s1_plan_review_done", { run_ids: ids, failed: true, error, runs: perRun }));
    list.push(action("finished"));
    return steps(list);
  }
  // the finished runs' findings, each named by the run that read it; one run folds nothing
  if (!called(facts, "merge_findings", "review")) {
    const lists = done.map((index) => {
      const run = meta[index];
      const status = answerOf(facts, "run_status", textOf(run.run_id));
      const source = runLabelOf(run, index, roleRuns);
      return arrOf(status.findings).map((finding) =>
        textOf(objOf(finding).source) !== "" ? finding : withTextField(finding, "source", source),
      );
    });
    return steps([callStep("merge_findings", "review", { lists }, true)]);
  }
  const findings = arrOf(answerOf(facts, "merge_findings", "review").findings);
  // a send-back needs the plan the planner is told to correct: the reading stays with the caller
  if (!called(facts, "has_plan", "review")) return steps([callStep("has_plan", "review", null, true)]);
  const sentBack = severityCount(findings, "must") > 0;
  // the reports, in the runs' order, and the fallbacks they took
  const reports: unknown[] = [];
  const reportMd: unknown[] = [];
  const fallbacks: unknown[] = [];
  for (const index of done) {
    const run = meta[index];
    const status = answerOf(facts, "run_status", textOf(run.run_id));
    const fields: Record<string, unknown> = { role: runLabelOf(run, index, roleRuns) };
    const model = textOf(run.model);
    if (model !== "") fields.model = model;
    if (typeof status.reportMd === "string") {
      fields.report_md = status.reportMd;
      reportMd.push(status.reportMd);
    } else {
      reportMd.push(null);
    }
    reports.push(fields);
    for (const fallback of arrOf(status.fallbacks)) fallbacks.push(fallback);
  }
  const kept: unknown[] = [];
  for (const finding of findings) {
    if (kept.length >= 12) break;
    const item = objOf(finding);
    const fields: Record<string, unknown> = {
      severity: wrapped(item.severity),
      path: wrapped(item.path),
      claim: wrapped(item.claim),
    };
    if (typeof item.source === "string") fields.source = item.source;
    kept.push(fields);
  }
  const attrs: Record<string, unknown> = {
    run_ids: ids,
    must: severityCount(findings, "must"),
    should: severityCount(findings, "should"),
    nit: severityCount(findings, "nit"),
    sent_back: sentBack,
    reports,
    runs: perRun,
    findings: kept,
  };
  const first = meta[done[0]] ?? {};
  const firstStatus = answerOf(facts, "run_status", textOf(first.run_id));
  if (typeof firstStatus.reportMd === "string") attrs.report_md = firstStatus.reportMd;
  if (failed > 0) attrs.failed_runs = failed;
  if (fallbacks.length > 0) attrs.fallbacks = fallbacks;
  // a shape judge that was asked for and did not finish leaves a review that did not answer in full. A plan sent back
  // is reviewed again before the GO, so the failure is recorded only when nothing sends it back.
  if (shapeRuns > 0 && shapeDone === 0 && !sentBack) {
    attrs.failed = true;
    attrs.error = `形の判断が走り切れなかった: ${failedParts(perRun, roleRuns).join(" / ")}`;
  }
  list.push(writeStep("s1_plan_review_done", attrs));
  if (sentBack) {
    list.push(
      callStep(
        "queue_envelope",
        "review",
        { findings, reports: reportMd, hasPlan: yesOf(answerOf(facts, "has_plan", "review").hasPlan) },
        true,
      ),
    );
  }
  list.push(action("finished"));
  return steps(list);
}

/** whether a lane's plan review starts, waits, is skipped, or reports the runs' end */
export function startPlanReviewReference(rows: LifecycleRecord[], facts: Facts): unknown {
  const laneRows = rowsOf(rows, text(facts, "lane"));
  if (closed(laneRows) || laneHeld(laneRows)) return steps([action("none")]);
  const phase = planReviewPhase(laneRows).phase;
  if (phase === "waiting") return planReviewWaiting(rows, laneRows, facts);
  if (phase === "running") return planReviewRunning(laneRows, facts);
  return steps([action("none")]);
}
