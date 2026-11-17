
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { stateDir } from "../paths.ts";
import { pipelineConcurrency, pipelineSlotDeclared, reviewPolicy } from "../config/pipeline.ts";
import { reviewBaseOf } from "../ledger/base.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { appendLifecycle, withdrawJsonl } from "../ledger/write.ts";
import { normText, reviewLaneLine } from "../plan/harness-norms.ts";
import { planReviewInputs } from "../plan/plan-review.ts";
import { writeLaneChoicesFile } from "../plan/lane-intent.ts";
import { laneRecordShape } from "../plan/record-shape.ts";
import { triageHistory } from "../plan/review-loop.ts";
import { fixBrief, envelopeInstruction, recordSession } from "../plan/exec.ts";
import { recordInjection } from "../instruction/ledger.ts";
import { pickForStage, repoOfArea } from "../instruction/store.ts";
import { headCommit } from "../worktree/ensure.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";
import { getAgentRunner, type AgentRunner, type ReviewRunStatus } from "./port.ts";

export interface OutboxRecord {
  envelope_id: string;
  idd_id: string;
  type: string;
  queued_at: string;
  delivered_at: string | null;
  abandoned_at?: string | null;
  session_id?: string;
  error?: string;
  /** the mark only a conflict-merge instruction carries: the delivery skips the one-off plan run for it */
  skip_fix_plan?: boolean;
  /** whose session the writer meant it for, when the kind alone does not say (an answer goes back to whoever asked) */
  role?: "planner" | "executor";
}

function outboxPath(): string {
  return join(stateDir(), "outbox.jsonl");
}

function readOutbox(): OutboxRecord[] {
  const path = outboxPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
    .flatMap((l) => {
      try { return [JSON.parse(l) as OutboxRecord]; } catch { return []; }
    });
}

function closedLanes(): Set<string> {
  const closed = new Set<string>();
  for (const e of readLifecycle()) {
    if (e.event === "lane_close" || e.event === "s1_defer" || e.event === "s3_defer") closed.add(e.idd_id);
  }
  return closed;
}

export function pendingEnvelopes(): OutboxRecord[] {
  const latest = new Map<string, OutboxRecord>();
  for (const rec of readOutbox()) latest.set(rec.envelope_id, { ...latest.get(rec.envelope_id), ...rec });
  const closed = closedLanes();
  return [...latest.values()]
    .filter((rec) => !rec.delivered_at && !rec.abandoned_at && !closed.has(rec.idd_id))
    .sort((a, b) => a.queued_at.localeCompare(b.queued_at));
}

export interface UndeliveredCount {
  total: number;
  failed: number;
}

export function countUndelivered(iddId?: string): UndeliveredCount {
  const recs = pendingEnvelopes().filter((rec) => !iddId || rec.idd_id === iddId);
  return { total: recs.length, failed: recs.filter((rec) => rec.error).length };
}

async function patch(envelopeId: string, fields: Partial<OutboxRecord>): Promise<void> {
  const path = outboxPath();
  if (!existsSync(path)) return;
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 40 } });
  try {
    const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const next = lines.map((line) => {
      try {
        const rec = JSON.parse(line) as OutboxRecord;
        return rec.envelope_id === envelopeId ? JSON.stringify({ ...rec, ...fields }) : line;
      } catch {
        return line;
      }
    });
    writeFileSync(path, `${next.join("\n")}\n`, "utf8");
  } finally {
    await release();
  }
}

function envelopeBody(envelopeId: string): string | null {
  const path = join(stateDir(), "outbox", `${envelopeId}.xml`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function sessionFor(iddId: string): { sessionId: string; cwd?: string } | null {
  const executor = readSessions("executor").filter((r) => r.idd_id === iddId).pop();
  if (executor?.executor_session_id) return { sessionId: executor.executor_session_id, cwd: executor.worktree_path };
  const planner = readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  if (planner?.planner_session_id) return { sessionId: planner.planner_session_id, cwd: planner.worktree_path };
  return null;
}

/**
 * The envelope kinds that are carried by a new executor session: a fix of the PR's feedback, the review loop's
 * fix, and a send-back from the submit card. They must not reach the session that made the change.
 */
export const FIX_TYPES: ReadonlySet<string> = new Set(["review_fix", "lane_rejected"]);

/**
 * The envelope kinds that are the planner's by what they are: a rewrite of the plan, the plan review's findings, and
 * the answer to a granularity proposal. A lane sent back to its plan after it was implemented still has an executor
 * session on record, so these never take `sessionFor`'s executor-first answer. An envelope whose recipient depends on
 * who asked (an answer to a question) carries its role in the row instead.
 */
const PLANNER_TYPES: ReadonlySet<string> = new Set(["s1_revise", "s1_replan", "plan_review_findings", "granularity_answered"]);

/** where a planner-bound envelope goes: the lane's planner session and its worktree, or null when there is none */
function plannerSessionFor(iddId: string): { sessionId: string; cwd?: string } | null {
  const planner = readSessions("planner").filter((r) => r.idd_id === iddId && r.planner_session_id).pop();
  return planner?.planner_session_id ? { sessionId: planner.planner_session_id, cwd: planner.worktree_path } : null;
}

export interface DeliverResult {
  delivered: string[];
  skipped: { envelopeId: string; reason: string }[];
}

/**
 * The two records of the one-off plan run the delivery slips in before a fix reaches its new session, both keyed
 * by the envelope's id: the start (with the run's id, so the lane's budget and its stop read it) and the end (with
 * the plan's path, or the failure). New names, never the review loop's: an event the loop's state machine reads
 * would move the lane (DEC-2212).
 */
const FIX_PLAN_STARTED = "fix_plan_started";
const FIX_PLAN_DONE = "fix_plan_done";

/** what the delivery knows about one envelope's plan run, from the lifecycle alone (DEC-929: no second state file) */
type FixPlanStep = { state: "none" } | { state: "running" } | { state: "done"; plan: string } | { state: "failed" };

function planRecordsOf(envelopeId: string, events: LifecycleRecord[]): { started?: string; done?: { runId?: string; planPath?: string; failed?: boolean; error?: string } } {
  let started: string | undefined;
  let done: { runId?: string; planPath?: string; failed?: boolean; error?: string } | undefined;
  for (const e of events) {
    const a = e.attrs ?? {};
    if (a.envelope_id !== envelopeId) continue;
    if (e.event === FIX_PLAN_STARTED && typeof a.run_id === "string" && a.run_id) started = a.run_id;
    if (e.event === FIX_PLAN_DONE) {
      done = {
        ...(typeof a.run_id === "string" && a.run_id ? { runId: a.run_id } : {}),
        ...(typeof a.plan_path === "string" && a.plan_path ? { planPath: a.plan_path } : {}),
        ...(a.failed === true ? { failed: true } : {}),
        ...(a.error ? { error: String(a.error) } : {}),
      };
    }
  }
  return { ...(started ? { started } : {}), ...(done ? { done } : {}) };
}

/**
 * The runtime's word on one plan run, or null when it cannot be read: a runner that cannot answer, or a read that
 * throws. The plan helps the fix, so a status nothing can read is answered as a failed plan and never holds the
 * instruction or stops the tick's pass (DEC-121-6, INV-121-4).
 */
function planRunStatus(runner: AgentRunner, runId: string): ReviewRunStatus | null {
  try {
    return runner.reviewRunStatus?.(runId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Where one envelope's plan run stands. A run the runtime says has finished has its end recorded here, so a
 * delivery that failed afterwards does not start a second run on the next tick (DEC-121-6); a run the runtime
 * calls failed is recorded as a failed plan and the instruction goes out without one.
 */
async function fixPlanStep(rec: OutboxRecord, runner: AgentRunner, events: LifecycleRecord[]): Promise<FixPlanStep> {
  const { started, done } = planRecordsOf(rec.envelope_id, events);
  if (done) {
    if (done.failed || !done.planPath) return { state: "failed" };
    return readPlan(done.planPath);
  }
  if (!started) return { state: "none" };
  const status = planRunStatus(runner, started);
  if (status?.state === "running") return { state: "running" };
  if (status?.state === "failed") {
    await endFixPlan(rec, started, { failed: true, error: status.error });
    return { state: "failed" };
  }
  if (!status) {
    await endFixPlan(rec, started, { failed: true, error: "整理役の run の状態を読めません" });
    return { state: "failed" };
  }
  const plan = readPlan(status.reportMd);
  if (plan.state === "failed") await endFixPlan(rec, started, { failed: true, error: "案の md を読めません" });
  else await endFixPlan(rec, started, { planPath: status.reportMd });
  return plan;
}

/** the plan's words, or a failure: a plan that cannot be read is handed over as none, never as an empty section */
function readPlan(path: string): FixPlanStep {
  try {
    return { state: "done", plan: readFileSync(path, "utf8") };
  } catch {
    return { state: "failed" };
  }
}

/** the plan run's closing record; a write that fails leaves the instruction pending, not the tick stopped */
async function endFixPlan(rec: OutboxRecord, runId: string, outcome: { planPath?: string; failed?: boolean; error?: string }): Promise<void> {
  try {
    await appendLifecycle(FIX_PLAN_DONE, rec.idd_id, { envelope_id: rec.envelope_id, run_id: runId, ...(outcome.planPath ? { plan_path: outcome.planPath } : {}), ...(outcome.failed ? { failed: true } : {}), ...(outcome.error ? { error: outcome.error } : {}) });
  } catch {
    // the next tick reads the run's status again; the instruction is never held for this
  }
}

/** how many plan runs are running across every lane: started, not ended, and the runtime says still running */
function runningFixPlans(runner: AgentRunner, events: LifecycleRecord[]): number {
  const started = new Map<string, string>();
  const ended = new Set<string>();
  for (const e of events) {
    const a = e.attrs ?? {};
    const id = typeof a.envelope_id === "string" ? a.envelope_id : "";
    if (!id) continue;
    if (e.event === FIX_PLAN_STARTED && typeof a.run_id === "string" && a.run_id) started.set(id, a.run_id);
    if (e.event === FIX_PLAN_DONE) ended.add(id);
  }
  let n = 0;
  for (const [id, runId] of started) {
    if (ended.has(id)) continue;
    // a run whose status cannot be read is not counted: its own envelope is answered as a failed plan, and holding
    // the slot for a run nothing can read would starve every other lane's plan (INV-121-4)
    if (planRunStatus(runner, runId)?.state === "running") n += 1;
  }
  return n;
}

/** where the plan run reads and runs, when the lane has one: the newest executor session and the lane's row */
function fixPlanTarget(rec: OutboxRecord, runner: AgentRunner): { prev: { sessionId: string; cwd: string; branch: string }; lane: BacklogRecord } | null {
  if (!runner.spawn || !runner.startReviewRun) return null;
  const prev = executorSessionFor(rec.idd_id);
  const lane = readBacklog().find((r) => r.idd_id === rec.idd_id);
  return prev && lane ? { prev, lane } : null;
}

/**
 * Start the one-off plan run before a fix reaches its new session: write where it reads (the instruction, the
 * lane's contract, the previous rounds' fixes), start the read-only stage in the lane's worktree, and record the
 * start. Nothing here reaches past the envelope: a failure is recorded as a failed plan and answered so the tick
 * hands the instruction over without one (DEC-121-6).
 */
async function startFixPlan(rec: OutboxRecord, target: { prev: { sessionId: string; cwd: string; branch: string }; lane: BacklogRecord }, runner: AgentRunner, events: LifecycleRecord[]): Promise<{ state: "started" } | { state: "failed" }> {
  let runId: string | undefined;
  try {
    const laneEvents = events.filter((e) => e.idd_id === rec.idd_id);
    const base = reviewBaseOf(laneEvents);
    const head = headCommit(target.prev.cwd);
    // an input that cannot be built is a failed plan: the instruction still goes out, and no run is started
    if (!base || !head) throw new Error(`lane の差分を作れません（base: ${base || "なし"}、head: ${head ?? "なし"}）`);
    const dir = join(stateDir(), "pipeline", "fix-plan", rec.idd_id);
    mkdirSync(dir, { recursive: true });
    const instructionFile = join(dir, `${rec.envelope_id}-instruction.md`);
    // the plan reads the instruction, never the implementer's own orders the envelope carries (DEC-121-7). A
    // send-back that says it is work beyond the lane says so to the plan too (F-121-11); the frame's commit and
    // report orders are never added back
    const body = envelopeBody(rec.envelope_id) ?? "";
    const beyondLane = "この指示は lane の範囲を超える追加の作業である。足りない判断は契約（Choice か AC）に足してから直す。";
    const instruction = envelopeInstruction(body);
    writeFileSync(instructionFile, [
      ...(body.includes("今の lane の範囲を超える追加の作業") ? [beyondLane, ""] : []),
      instruction,
    ].join("\n"), "utf8");
    // a v2 lane's planner reads the drawn Choices and the qa, not decision.md (DEC-119-6)
    const shape = laneRecordShape(rec.idd_id, laneEvents);
    const choicesFile = shape === "state" ? writeLaneChoicesFile(target.lane, `fix-plan-${rec.envelope_id}`) : undefined;
    const contract = planReviewInputs(target.lane);
    // the lane's context document, appended to by every executor session: the plan's facts outlive the work
    // instruction, so the fix plan reads the same file the next session will (C-196-1). A lane planned before the
    // document existed names a path that is not there, and the input is left out instead of passed broken.
    const contextDoc = contract[3] ? join(target.prev.cwd, contract[3]) : undefined;
    const inputs = [
      instructionFile,
      ...(shape === "state"
        ? [...(choicesFile ? [choicesFile] : []), ...(contract[1] ? [join(target.prev.cwd, contract[1])] : [])]
        : contract.slice(0, 2).map((p) => join(target.prev.cwd, p))),
      ...(contextDoc && existsSync(contextDoc) ? [contextDoc] : []),
    ];
    // the plan must not break a fix an earlier round made. The fix this envelope carries is the newest
    // `s2_fix_sent` on record: `send_fix` queues the envelope and writes that fix in the same step, and the lane
    // waits for the new session before another round can send one (F-121-5)
    const carried = rec.type === "review_fix" ? [...laneEvents].reverse().find((e) => e.event === "s2_fix_sent") : undefined;
    const history = triageHistory(carried ? laneEvents.filter((e) => e !== carried) : laneEvents, "fix_plan");
    if (history) {
      const historyFile = join(dir, `${rec.envelope_id}-history.md`);
      writeFileSync(historyFile, history, "utf8");
      inputs.push(historyFile);
    }
    const started = await runner.startReviewRun!({
      iddId: rec.idd_id, stage: "fix_plan", round: 0, worktree: target.prev.cwd, base, head,
      inputs, norms: [reviewLaneLine(shape), normText("todo-source", shape)],
      ...(shape === "state" ? { recordsShape: "state" as const } : {}),
    });
    runId = started.runIds[0];
    if (!runId) throw new Error("整理役の run が 1 本も起きませんでした");
    await appendLifecycle(FIX_PLAN_STARTED, rec.idd_id, { envelope_id: rec.envelope_id, run_id: runId });
    return { state: "started" };
  } catch (err) {
    // the run was started but its record could not be written: stop it, or it keeps working for a plan nothing reads
    if (runId) {
      try { await runner.stopRun?.(runId); } catch { /* a run that cannot be stopped ends on its own */ }
    }
    try {
      await appendLifecycle(FIX_PLAN_DONE, rec.idd_id, { envelope_id: rec.envelope_id, ...(runId ? { run_id: runId } : {}), failed: true, error: String(err) });
    } catch {
      // even the failure record may not be writable; the plan is skipped and the instruction goes out
    }
    return { state: "failed" };
  }
}

/**
 * The one-off plan run of a fix's delivery, when its slot is declared and the instruction is not marked to skip it:
 * answers the plan's path (null when there is none to attach), and says when the instruction has to wait for the
 * run (still running, or no room under the slot's concurrency). A lane the delivery cannot reach starts nothing,
 * and a start that failed answers without a plan so the instruction is not held (DEC-121-6).
 */
async function fixPlanFor(rec: OutboxRecord, runner: AgentRunner, events: LifecycleRecord[], running: { count: number; cap: number }): Promise<{ plan: string | null; pending: boolean }> {
  try {
    const step = await fixPlanStep(rec, runner, events);
    if (step.state === "running") return { plan: null, pending: true };
    if (step.state === "done") return { plan: step.plan, pending: false };
    if (step.state === "failed") return { plan: null, pending: false };
    const target = fixPlanTarget(rec, runner);
    if (!target) return { plan: null, pending: false };
    // a full cap is not a failed plan: the instruction waits for the next tick (the plan is the only thing missing)
    if (running.count >= running.cap) return { plan: null, pending: true };
    const outcome = await startFixPlan(rec, target, runner, events);
    if (outcome.state === "failed") return { plan: null, pending: false };
    running.count += 1;
    return { plan: null, pending: true };
  } catch {
    // the plan is a help, never the condition of the fix reaching the implementer
    return { plan: null, pending: false };
  }
}

export async function deliverPending(): Promise<DeliverResult> {
  const runner = getAgentRunner();
  const result: DeliverResult = { delivered: [], skipped: [] };
  if (!runner) {
    for (const rec of pendingEnvelopes()) result.skipped.push({ envelopeId: rec.envelope_id, reason: "no runner" });
    return result;
  }

  // the one-off plan run's switch and its room: the slot's declaration turns it on, its concurrency is the cap over every lane
  const fixPlanOn = pipelineSlotDeclared("fix_plan");
  const lifecycle = fixPlanOn ? readLifecycle() : [];
  const fixPlanRunning = { count: fixPlanOn ? runningFixPlans(runner, lifecycle) : 0, cap: pipelineConcurrency("fix_plan") };
  // under the trial, a fix that already carries the reviewers' how-to-fix has its plan: the two answer the same
  // question, so a round runs one of them, not both (C-197-5). The mark is read from the envelope's own items, so a
  // fix sent before this key existed carries none and keeps the plan.
  const skipPlanForHow = reviewPolicy().fixPlanSkipWhenHow;

  for (const rec of pendingEnvelopes()) {
    const body = envelopeBody(rec.envelope_id);
    if (!body) {
      result.skipped.push({ envelopeId: rec.envelope_id, reason: "envelope body missing" });
      continue;
    }
    // a fix and a send-back go to a new executor session in the lane's worktree, not back to the session that made the change
    if (FIX_TYPES.has(rec.type)) {
      // the plan run is slipped in ahead of the new session; a conflict-merge instruction skips it (DEC-121-1), and
      // under the trial so does a fix that carries the reviewers' how-to-fix (C-197-5)
      let plan: string | null = null;
      if (fixPlanOn && !rec.skip_fix_plan && !(skipPlanForHow && body.includes("<how>"))) {
        const outcome = await fixPlanFor(rec, runner, lifecycle, fixPlanRunning);
        if (outcome.pending) {
          result.skipped.push({ envelopeId: rec.envelope_id, reason: "fix plan pending" });
          continue;
        }
        plan = outcome.plan;
      }
      await deliverToNewSession(rec, body, runner, result, plan ?? undefined);
      continue;
    }
    const seek = (rec.role ?? (PLANNER_TYPES.has(rec.type) ? "planner" : "executor")) === "planner" ? plannerSessionFor : sessionFor;
    const target = rec.session_id ? { sessionId: rec.session_id, cwd: seek(rec.idd_id)?.cwd } : seek(rec.idd_id);
    if (!target) {
      result.skipped.push({ envelopeId: rec.envelope_id, reason: "no session for lane" });
      continue;
    }
    try {
      await runner.deliver(target.sessionId, body, { cwd: target.cwd, type: rec.type });
      await patch(rec.envelope_id, { delivered_at: new Date().toISOString(), session_id: target.sessionId });
      result.delivered.push(rec.envelope_id);
    } catch (err) {
      await patch(rec.envelope_id, { error: String(err) });
      result.skipped.push({ envelopeId: rec.envelope_id, reason: String(err) });
    }
  }
  return result;
}

function sessionsFile(): string {
  return join(stateDir(), "executor-sessions.jsonl");
}

/** the lane's newest executor session, and where it works: the one a fix replaces */
function executorSessionFor(iddId: string): { sessionId: string; cwd: string; branch: string } | null {
  const executor = readSessions("executor").filter((r) => r.idd_id === iddId && r.executor_session_id).pop();
  return executor?.executor_session_id ? { sessionId: executor.executor_session_id, cwd: executor.worktree_path, branch: executor.branch } : null;
}

/**
 * Deliver a fix or a send-back to a new executor session: spawn in the lane's worktree, record the session, stop
 * the one that made the change, then hand over the brief. A start that does not go through leaves the instruction
 * pending for the next tick; a session that was spawned but not handed the brief is taken back, record and all.
 */
async function deliverToNewSession(rec: OutboxRecord, body: string, runner: AgentRunner, result: DeliverResult, plan?: string): Promise<void> {
  const prev = executorSessionFor(rec.idd_id);
  const lane = readBacklog().find((r) => r.idd_id === rec.idd_id);
  if (!prev || !lane) {
    result.skipped.push({ envelopeId: rec.envelope_id, reason: "no executor session for lane" });
    return;
  }
  if (!runner.spawn) {
    result.skipped.push({ envelopeId: rec.envelope_id, reason: "runner cannot spawn a session" });
    return;
  }
  let spawned: { sessionId: string; model?: string; harness?: string; cacheTtl?: "1h" | "5m" };
  try {
    spawned = await runner.spawn({ role: "executor", cwd: prev.cwd, laneId: rec.idd_id });
  } catch (err) {
    await patch(rec.envelope_id, { error: String(err) });
    result.skipped.push({ envelopeId: rec.envelope_id, reason: `spawn: ${String(err)}` });
    return;
  }
  // the session is recorded before the handover, so a brief that fails to go out is not left without its session
  try {
    await recordSession({
      iddId: rec.idd_id, sessionId: spawned.sessionId, worktree: prev.cwd, branch: prev.branch, kind: "fix",
      ...(spawned.model ? { model: spawned.model } : {}), ...(spawned.harness ? { harness: spawned.harness } : {}),
    });
  } catch (err) {
    await discardSpawn(runner, spawned.sessionId);
    await patch(rec.envelope_id, { error: String(err) });
    result.skipped.push({ envelopeId: rec.envelope_id, reason: `session record: ${String(err)}` });
    return;
  }
  try {
    // the session that made the change is stopped before the instruction reaches the new one
    if (runner.stopSession) await runner.stopSession(prev.sessionId);
    const picked = pickForStage("fix", repoOfArea(lane.area));
    await runner.deliver(spawned.sessionId, fixBrief(lane, prev.cwd, body, { ...(spawned.harness ? { harness: spawned.harness } : {}), ...(spawned.cacheTtl ? { cacheTtl: spawned.cacheTtl } : {}) }, plan, picked), { cwd: prev.cwd, type: rec.type });
    // the fix session has started: the ledger is written only now, so a brief that failed to go out leaves no line
    recordInjection(picked, { kind: "lane", stage: "fix", scene: "implement", lane: rec.idd_id, run: spawned.sessionId });
    await patch(rec.envelope_id, { delivered_at: new Date().toISOString(), session_id: spawned.sessionId });
    result.delivered.push(rec.envelope_id);
  } catch (err) {
    // a session that could not be handed its brief is taken back: the instruction stays pending for the next tick
    await discardSpawn(runner, spawned.sessionId);
    await takeBackSessionRow(spawned.sessionId);
    await patch(rec.envelope_id, { error: String(err) });
    result.skipped.push({ envelopeId: rec.envelope_id, reason: String(err) });
  }
}

async function discardSpawn(runner: AgentRunner, sessionId: string): Promise<void> {
  if (!runner.discard) return;
  try { await runner.discard(sessionId); } catch { /* the next tick starts another session */ }
}

/**
 * Take back the record of a session that was never handed its brief. Awaited, so the next tick does not read the row
 * as the lane's newest session; a take-back that fails is swallowed like the discard, because the cleanup of one
 * envelope must not stop the pass.
 */
async function takeBackSessionRow(sessionId: string): Promise<void> {
  try { await withdrawJsonl(sessionsFile(), (row) => String(row.executor_session_id ?? "") === sessionId); } catch { /* the next tick starts another session */ }
}
