
import { recordCronRunSlotWaits, runIntake, type IssueRef } from "../intake/run.ts";
import { slotWaits, type SlotWait } from "./slot-wait.ts";
import { runTrackerSync, type SyncRepoResult } from "../sync/run.ts";
import { runPrep } from "./prep.ts";
import { runExec, type ExecResult } from "./exec.ts";
import { runCheck } from "./review.ts";
import { runClose, stopDiscardedWork } from "./close.ts";
import { runMergeAccept, type AcceptResult } from "./merge-accept.ts";
import { runPlanReview } from "./plan-review.ts";
import { runAutoGo } from "./auto-go.ts";
import { runBaseAdvance } from "./base-advance.ts";
import { runReviewLoop } from "./review-loop.ts";
import { runShapeJudge } from "./shape-judge.ts";
import { runSubmitPrep } from "./submit-prep.ts";
import { runWatch } from "./watch.ts";
import { runStallWatch } from "./stall-watch.ts";
import { recordStartSkips } from "./start-skip.ts";
import { finishQuestionBatches } from "../agent/question-routing.ts";
import { runCanary, CANARY_PASS_MS, type CanaryPassOptions } from "../canary/run.ts";
import { recordStageDurations } from "./stage-durations.ts";
import { reanchorPlaceFindings } from "./place-findings.ts";
import { runPrDrafts } from "./pr-draft.ts";
import { runSubmitPush } from "./submit-push.ts";
import { runLand } from "./land.ts";
import { runBudget } from "./budget.ts";
import { runBlockerWaits } from "./blockers.ts";
import { sweepStaleTmp } from "./tmp-sweep.ts";
import { belowThreshold, sweepStorage } from "../storage/sweep.ts";
import { runPrFeedback, runPrReplies } from "./pr-feedback.ts";
import { runReviewLanes } from "../review-lane/run.ts";
import { staleHold } from "./stale-hold.ts";
import { deliverPending, type DeliverResult } from "../agent/outbox.ts";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { stateDir } from "../paths.ts";

export interface TickResult {
  intake: { added: string[]; duplicates: number; failures: number; unmatched: (number | string)[] };
  /** the Projects and Issues of an outside tracker taken in, per repo that writes a `tracker_sync` (empty when none does) */
  trackerSync: SyncRepoResult[];
  prep: { started: string[]; skipped: number };
  planReview: { started: string[]; finished: string[]; skipped: string[]; errors: number };
  /** lanes waiting at GO whose plan's places the work branch moved into, recorded on this pass (a mark only) */
  baseAdvance: { recorded: string[]; errors: { iddId: string; error: string }[] };
  reviewLoop: { advanced: { iddId: string; to: string }[]; errors: { iddId: string; error: string }[] };
  submitPrep: { submitted: string[]; errors: { iddId: string; error: string }[] };
  reviewLanes: { advanced: { id: string; to: string }[]; errors: { id: string; error: string }[] };
  exec: { started: string[]; skipped: number };
  check: { clean: string[]; conflict: string[] };
  close: { merged: string[]; retired: string[]; kept: { iddId: string; reason: string }[] };
  /** the merged lanes' receive of the public branch, their records and their close (the stage after the close pass) */
  accept: AcceptResult;
  /** the sessions and runs of lanes penne took out, stopped on this pass (a CLI ignore has no runtime of its own) */
  stoppedWork: { iddId: string; sessions: string[]; runs: string[] }[];
  deliver: { delivered: number; skipped: number };
  watch: { resumed: string[]; stalled: string[]; errors: number };
  /** the stall watch: lanes it sent a repair instruction to, lanes it halted for penne, cards it noticed */
  stallWatch: { instructed: string[]; halted: string[]; noticed: string[]; errors: number };
  /** the lanes whose stage lengths were measured and written on this pass (a stage that moves no lane) */
  durations: { recorded: string[]; errors: number };
  /** the open place findings placed again from the mainline diff (a stage that moves no lane) */
  findings: { moved: string[]; dropped: string[]; errors: number };
  prDrafts: { drafted: string[]; errors: number };
  /** submits checked and waiting for penne's approval on the card, approved pushes put on record, and those held until penne checks them again */
  submitPush: { ready: string[]; recorded: string[]; held: string[]; merged: string[]; errors: number };
  /** lanes of repos that do not publish: landings checked for the card, approved merges carried out, conflicts sent back */
  land: { prepared: string[]; merged: string[]; sentBack: string[]; held: string[]; errors: number };
  budget: { stopped: string[]; errors: number };
  prReplies: { queued: string[]; errors: number };
  prFeedback: { recorded: { iddId: string; items: number }[]; errors: number };
  /** the canary: the roles whose day's record it wrote, the ones that failed, and the ones left for a later pass */
  canary: { ran: string[]; failed: string[]; skipped: string[]; errors: number };
  /** after every stage ran: the lanes each capped stage leaves waiting for its cap */
  slotWaits: SlotWait[];
  /** the used-up files the sweep deleted on this pass, and the lanes it held back for space */
  storage: { removed: number; bytes: number; failed: number; heldLanes: string[]; reason?: string };
  /** a restart on its way with the checkout ahead: what this pass held back, for the replacement to run */
  hold?: { reason: string; intake: boolean; prep: boolean };
  /** the passes run after the first: a lane moved on, or a tick was asked for while this one ran */
  again?: TickResult[];
  /** a request was still there when the lock was let go (past the last pass): the caller books another tick */
  pending?: true;
}

/**
 * Left in the state by a lane that finished (or by a tick that found the lock busy) to ask for another pass.
 * A tick removes it before each pass, so one that is there after a pass was left while the pass ran.
 */
export const TICK_AGAIN_FILE = "tick.again";

/**
 * Left beside it by a tick with the intake that found the lock busy (the timer's tick): what it would have taken in.
 * The tick holding the lock, or the one booked after it, runs a pass with the intake for it.
 */
export const TICK_AGAIN_INTAKE_FILE = "tick.again.intake";

/**
 * Left in the state by a pass that held its intake and its planner starts while a restart was on its way: the ask
 * the replacement runs, with the reason it was held. It is deliberately not `tick.again`: the running engine must
 * not book another tick or add passes for it, and `withLeftIntake` takes it (with the ask) so the first tick after
 * the restart runs the intake without waiting for the timer. `pickUpLeftTick` books one for it at the engine's start.
 */
export const TICK_HOLD_FILE = "tick.hold";

/** how many passes a tick runs after its first, however many lanes move or finish meanwhile */
export const MAX_AGAIN = 5;

/** `intakeAll` with named Issues: take every Issue the intake filter takes in as well as the named ones */
export type TickOptions = { intake?: boolean; issueNumbers?: number[]; issueRefs?: IssueRef[]; intakeAll?: boolean; forState?: string; canary?: CanaryPassOptions };

/** an intake asked for: every Issue (all), the named ones, or both */
type IntakeAsk = { all?: boolean; issueNumbers?: number[]; issueRefs?: IssueRef[] };

function named(a: IntakeAsk): boolean {
  return Boolean(a.issueRefs?.length || a.issueNumbers?.length);
}

function askOf(o: TickOptions): IntakeAsk | null {
  if (o.intake === false) return null;
  if (!o.issueRefs?.length && !o.issueNumbers?.length) return { all: true };
  return {
    ...(o.intakeAll ? { all: true } : {}),
    ...(o.issueNumbers?.length ? { issueNumbers: o.issueNumbers } : {}),
    ...(o.issueRefs?.length ? { issueRefs: o.issueRefs } : {}),
  };
}

/**
 * Two asks as one. Taking every Issue in does not cover the named ones: a named Issue is read by itself and skips
 * the intake filter, so the filtered run would leave it out.
 */
function joinAsks(a: IntakeAsk | null, b: IntakeAsk | null): IntakeAsk | null {
  if (!a || !b) return a ?? b;
  const nums = [...(a.issueNumbers ?? []), ...(b.issueNumbers ?? [])];
  const refs = [...(a.issueRefs ?? []), ...(b.issueRefs ?? [])];
  const all = Boolean(a.all || b.all) || (!named(a) || !named(b));
  return { ...(all ? { all: true } : {}), ...(nums.length ? { issueNumbers: nums } : {}), ...(refs.length ? { issueRefs: refs } : {}) };
}

function readAskFile(dir: string, name: string): IntakeAsk | null {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as IntakeAsk;
    if (!v || typeof v !== "object") return { all: true };
    // an ask that names nothing asked for every Issue
    return named(v) ? v : { ...v, all: true };
  } catch {
    // a request that cannot be read still asked for an intake
    return { all: true };
  }
}

function readIntakeAsk(dir: string): IntakeAsk | null {
  return readAskFile(dir, TICK_AGAIN_INTAKE_FILE);
}

/** a held request: why it was held, and the intake ask the replacement runs (null when none was asked) */
interface HeldRequest {
  reason: string;
  ask: IntakeAsk | null;
}

function readHold(dir: string): HeldRequest | null {
  const p = join(dir, TICK_HOLD_FILE);
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as Partial<HeldRequest>;
    const ask = v?.ask && typeof v.ask === "object" ? (v.ask as IntakeAsk) : null;
    return { reason: typeof v?.reason === "string" ? v.reason : "", ask };
  } catch {
    return { reason: "", ask: null };
  }
}

/** take the held request out of the state (a pass folds its ask in, or the tick that runs it takes it) */
function takeHold(dir: string): HeldRequest | null {
  const held = readHold(dir);
  if (held) rmSync(join(dir, TICK_HOLD_FILE), { force: true });
  return held;
}

/** leave the request the replacement runs, without asking this engine for another pass or another tick */
function leaveHoldRequest(dir: string, reason: string, ask: IntakeAsk | null): void {
  writeFileSync(join(dir, TICK_HOLD_FILE), JSON.stringify({ reason, ask }));
}

/** leave a request for the tick that holds the lock (and, with an intake, what to take in) */
function leaveRequest(dir: string, ask: IntakeAsk | null): void {
  writeFileSync(join(dir, TICK_AGAIN_FILE), new Date().toISOString());
  if (ask) writeFileSync(join(dir, TICK_AGAIN_INTAKE_FILE), JSON.stringify(joinAsks(readIntakeAsk(dir), ask)));
}

function requestLeft(dir: string): boolean {
  return existsSync(join(dir, TICK_AGAIN_FILE)) || existsSync(join(dir, TICK_AGAIN_INTAKE_FILE));
}

/**
 * The pass's options with a left intake request folded in (taken, so it runs once). A held request is taken too,
 * without its ask turning a no-intake pass into an intake one: the marker still has to leave the state.
 */
function withLeftIntake(dir: string, o: TickOptions): TickOptions {
  const held = takeHold(dir);
  const left = joinAsks(readIntakeAsk(dir), held?.ask ?? null);
  if (!left) return o;
  rmSync(join(dir, TICK_AGAIN_INTAKE_FILE), { force: true });
  const ask = joinAsks(askOf(o), left);
  if (!ask || !named(ask)) return { intake: true };
  return {
    intake: true,
    ...(ask.all ? { intakeAll: true } : {}),
    ...(ask.issueNumbers?.length ? { issueNumbers: ask.issueNumbers } : {}),
    ...(ask.issueRefs?.length ? { issueRefs: ask.issueRefs } : {}),
  };
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(a) === real(b);
}

/** a pass that moved a lane on may have made the next step of that lane startable */
function moved(r: TickResult): boolean {
  return r.reviewLoop.advanced.length > 0
    || r.reviewLanes.advanced.length > 0
    || r.submitPrep.submitted.length > 0
    || r.planReview.finished.length > 0
    || r.prFeedback.recorded.length > 0
    || r.submitPush.recorded.length > 0
    || r.submitPush.merged.length > 0
    || r.land.merged.length > 0
    || r.land.prepared.length > 0;
}

/**
 * The tick's lock, taken without waiting. Whoever finds it held leaves a request instead (with the intake it
 * asked for), so the tick that holds it makes another pass for what the caller would have started.
 */
async function takeTickLock(ask: IntakeAsk | null = null): Promise<(() => Promise<void>) | null> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lockTarget = join(dir, "tick.lock");
  if (!existsSync(lockTarget)) writeFileSync(lockTarget, "");
  try {
    return await lockfile.lock(lockTarget, { retries: 0, stale: 30 * 60 * 1000 });
  } catch {
    leaveRequest(dir, ask);
    return null;
  }
}

/**
 * The canary's one deadline for a tick. It is made when the tick first reaches the stage, not when the lock is taken:
 * the stages before the canary can run for minutes, and a deadline made at the lock would already be spent by then.
 * The first call makes it, every later call of the same tick reads the same instant, so the extra passes a tick runs
 * cannot add a second wall: the tick's canary ends inside one limit, and what is left goes to the next tick.
 */
export function canaryDeadlineOf(passMs?: number): () => number {
  let deadline: number | undefined;
  return () => {
    if (deadline === undefined) deadline = Date.now() + Math.max(1_000, passMs ?? CANARY_PASS_MS);
    return deadline;
  };
}

/**
 * One tick at a time, across the server and the CLI: two ticks starting the same stage would start
 * its runs twice, and the copy of the one that is not recorded would never be cleaned up. A tick that
 * finds the lock busy leaves a request instead, and the running tick makes another pass for it.
 * After its first pass, a tick runs again without the intake while a pass moved a lane on or a request
 * was left during it (at most MAX_AGAIN times), so a finished stage does not wait for the next tick. An intake
 * that was asked for meanwhile is folded into the next pass. A request still there once the lock is let go
 * comes back as `pending`, and the caller books another tick for it. A lane whose stage could not start is not
 * tried again by the later passes of the same tick.
 * A tick asked for another state (a kick from a process that works on other records) does nothing.
 */
export async function runTick(opts: TickOptions = {}): Promise<TickResult | { skipped: "another tick is running" | "the tick was asked for another state" }> {
  const dir = stateDir();
  if (opts.forState !== undefined && !samePath(opts.forState, dir)) return { skipped: "the tick was asked for another state" };
  const again = join(dir, TICK_AGAIN_FILE);
  const release = await takeTickLock(askOf(opts));
  if (!release) return { skipped: "another tick is running" };
  const tickStartedAt = Date.now();
  sweepStaleTmp();
  let result: TickResult;
  const canaryDeadline = canaryDeadlineOf(opts.canary?.passMs);
  try {
    const failedStarts = new Set<string>();
    const pass = async (o: TickOptions) => {
      rmSync(again, { force: true });
      const r = await tickOnce(withLeftIntake(dir, o), failedStarts, opts.canary, canaryDeadline, tickStartedAt);
      for (const e of r.reviewLoop.errors) failedStarts.add(e.iddId);
      return r;
    };
    const first = await pass(opts);
    const more: TickResult[] = [];
    let last = first;
    while (more.length < MAX_AGAIN && (moved(last) || requestLeft(dir))) {
      last = await pass({ intake: false });
      more.push(last);
    }
    result = more.length ? { ...first, again: more } : first;
  } finally {
    await release();
  }
  return requestLeft(dir) ? { ...result, pending: true } : result;
}

export interface AfterDecision {
  started?: ExecResult | { error: string };
  delivery?: DeliverResult | { error: string };
  /** a tick held the lock: it runs these on a later pass, or the tick booked after it does; nothing was started here */
  deferred?: string;
  /** a request was left while this held the lock: the caller books a tick for it */
  pending?: true;
}

/**
 * What a decision starts right away: the executor after a GO, and the envelopes it queued. These are the tick's
 * own stages, so they run under the tick's lock: a GO that met a tick starting the same executor spawned two.
 * When a tick holds the lock, the request left for it makes the tick run them on a later pass; a tick past its
 * last pass hands the request back as pending, and its caller books another tick. A request that ticks left while
 * this held the lock is handed back the same way.
 */
export async function runAfterDecision(opts: { exec: boolean }): Promise<AfterDecision> {
  const dir = stateDir();
  const release = await takeTickLock();
  if (!release) return { deferred: "tick が動いているので、executor の起動と配信は、その tick の残りの巡か、その後の tick（30 秒ほど後に予約）で行います" };
  let result: AfterDecision;
  try {
    const started = opts.exec ? await runExec().catch((err) => ({ error: String(err) })) : undefined;
    // the reasons of the lanes this start did not start are put on their rows here too, so a GO that could not start
    // its executor reads on the lane at once (the key is the tick's: the next tick's same reason adds no row)
    if (started && "skipped" in started) await recordStartSkips("executor", started.skipped);
    const delivery = await deliverPending().catch((err) => ({ error: String(err) }));
    result = { ...(started ? { started } : {}), delivery };
  } finally {
    await release();
  }
  return requestLeft(dir) ? { ...result, pending: true } : result;
}

/** why a held pass shows, when the engine's own answer carries no wording */
const HOLD_REASON = "engine を入れ替えるので、取り込みと計画役の起動を入れ替えの後に回します";

/** a stage's failure is a warning of the tick, never a failed tick */
function warnFailed(what: string, err: unknown): void {
  console.warn(`[tick] ${what}: ${String(err).slice(0, 400)}`);
}

/** the lanes a stage could not move, named one by one */
function warnLaneErrors(what: string, errors: { iddId: string; error: string }[]): void {
  if (errors.length) console.warn(`[tick] ${what}: ${errors.map((e) => `${e.iddId}: ${e.error}`).join(" / ").slice(0, 400)}`);
}

async function tickOnce(opts: TickOptions, failedStarts: ReadonlySet<string> = new Set(), canaryOptions?: CanaryPassOptions, canaryDeadline?: () => number, tickStartedAt = Date.now()): Promise<TickResult> {
  const dir = stateDir();
  // a restart on its way with an engine-effective change ahead of this process: take nothing in here. The read is
  // now, so a landing made since the last judgment (even by an earlier pass of this tick) is seen.
  const holdAtIntake = staleHold();
  const intakeAsk = askOf(opts);
  const heldIntake = Boolean(holdAtIntake.hold && intakeAsk);
  const intakeReason = holdAtIntake.reason || HOLD_REASON;
  if (heldIntake && intakeAsk) leaveHoldRequest(dir, intakeReason, intakeAsk);
  const intake = heldIntake || opts.intake === false
    ? { startedAt: undefined, added: [], duplicates: [], failures: [], unmatched: [] }
    : await runIntake({ issueNumbers: opts.issueNumbers, issueRefs: opts.issueRefs, all: opts.intakeAll });

  // the outside tracker's changes to Projects and Issues, taken in right after the intake that reads the same outside.
  // A repo that writes no `tracker_sync` costs nothing, one that does is read at most once an interval, and a failure
  // here stays here: every other stage below runs as before
  const trackerSync = heldIntake || opts.intake === false
    ? []
    : await runTrackerSync().catch((err): SyncRepoResult[] => {
      console.warn(`[tick] 外の Project と Issue を取り込めませんでした: ${String(err).slice(0, 400)}`);
      return [{ repo: "", error: String(err).slice(0, 400), intaken: 0, conflicts: 0, notes: [] }];
    });

  // the lanes penne took out (ignore, redo): what is still running for them is stopped before the worktrees are
  // retired, so a pass that took a lane out from the CLI is caught up here
  const stoppedWork = await stopDiscardedWork().catch((err) => {
    console.warn(`[tick] 外した lane の session を止められませんでした: ${String(err).slice(0, 400)}`);
    return [];
  });
  // a merged lane under a card of the acceptance is left to it: the stage below reads whether the cause is gone
  const close = await runClose({ keepHeld: true });
  // the receive of the public branch for the repos that have a merged lane waiting, and the close it unblocks (a stage
  // that never fails the tick: a stop is a card on the lane, and the rest waits for the next pass)
  const accept = await runMergeAccept(close, tickStartedAt).catch((err): AcceptResult => {
    console.warn(`[tick] 公開本流の受け入れを進められませんでした: ${String(err).slice(0, 400)}`);
    return { tried: [], closed: [], stopped: [], waiting: [], errors: 1 };
  });
  // the used-up files the records and the places give up: it runs under this tick's lock so it can never race the
  // stage that cuts a copy and writes its record. A failure here does not stop the other stages (runBaseAdvance's handling)
  const storage = await sweepStorage({ underLock: true, lowSpace: belowThreshold() }).catch((err) => {
    console.warn(`[tick] 片づけを回せませんでした: ${String(err).slice(0, 400)}`);
    return null;
  });
  // the replies to the last batch of PR feedback are drafted before a new batch is taken in
  const prReplies = await runPrReplies();
  const prFeedback = await runPrFeedback();
  // a lane past its budget stops before any stage below starts more work for it. It comes after the PR's
  // feedback is taken in: a lane waiting on its PR is not judged, and the feedback makes it work again
  const budget = await runBudget();
  // a lane whose executor returned for a blocker waits here, and is sent back once the blocker landed (plan/blockers.ts)
  await runBlockerWaits().then((r) => warnLaneErrors("blocker 待ちを進められませんでした", r.errors)).catch((err) => warnFailed("blocker 待ちを見られませんでした", err));
  // the shape judge reads the rounds before the loop moves them: a lane waiting for its judge is left where it is for this pass.
  // A judge that fails is not a failed tick (the card then carries no recommendation, C-252-6)
  const shapeHold = await runShapeJudge().then((r) => { warnLaneErrors("形の判断を進められませんでした", r.errors); return r.hold; }).catch((err) => { warnFailed("形の判断を回せませんでした", err); return new Set<string>(); });
  const reviewLoop = await runReviewLoop({ skip: shapeHold.size ? new Set([...failedStarts, ...shapeHold]) : failedStarts });
  const check = await runCheck();
  const submitPrep = await runSubmitPrep();
  const prDrafts = await runPrDrafts();
  // after the draft: a new PR's card starts from the drafted title and body. It only checks and drafts the commit
  // message; the push waits for penne's approval on the card
  const submitPush = await runSubmitPush();
  // after the push stage: a lane of a repo that does not publish is landed into the work side's mainline instead of
  // pushed, and an approved land whose merge the last pass could not write is finished here
  const land = await runLand();
  const reviewLanes = await runReviewLanes();
  const exec = await runExec();
  // the planner's brief is built from this process's modules: read the hold again after the landing stages, so the
  // pass that landed a merge does not brief a planner with the code it loaded. What is held keeps its ask for the
  // replacement, and the stall watch is told, so a lane waiting for its planner is not counted as stopped.
  const holdAtPrep = staleHold();
  const prepHeld = holdAtPrep.hold;
  const prepReason = holdAtPrep.reason || HOLD_REASON;
  if (prepHeld) leaveHoldRequest(dir, prepReason, heldIntake ? intakeAsk : null);
  const prep = prepHeld ? await runPrep({ hold: prepReason }) : await runPrep();
  // the reasons the two start stages gave for the lanes they did not start, put on the lanes' own records: the counts
  // below say how many, only the lane's rows say why (the stall watch below reads them for its card)
  await recordStartSkips("executor", exec.skipped);
  await recordStartSkips("planner", prep.skipped);
  // a batch whose answers are on record but whose close did not land is closed again. The judge is started where the
  // planner asks (agentAskQuestions), never here; this never waits, and a failure of it leaves the stages below going on
  try {
    finishQuestionBatches();
  } catch (err) {
    console.warn(`[tick] 質問の batch を閉じ直せませんでした: ${String(err).slice(0, 400)}`);
  }
  const planReview = await runPlanReview();
  // a shallow lane whose plan asks no judgement of a person goes on without one (the plan review is above)
  const autoGo = await runAutoGo();
  if (autoGo.errors.length) console.warn(`[tick] 自動の GO を記録できませんでした: ${autoGo.errors.map((e) => e.error).join(" / ").slice(0, 300)}`);
  // a mark on the lanes waiting at GO: it starts nothing, so it is not a move that runs another pass
  const baseAdvance = await runBaseAdvance().catch((err) => {
    console.warn(`[tick] 本流の進みを確かめられませんでした: ${String(err).slice(0, 400)}`);
    return { recorded: [] as string[], errors: [{ iddId: "", error: String(err) }] };
  });
  // the capped stages' waits as the tick leaves them: read here so the stall watch and the cron record share one read
  let waits: SlotWait[] = [];
  try {
    waits = slotWaits();
  } catch (err) {
    console.warn(`[tick] 上限待ちを数えられませんでした: ${String(err).slice(0, 400)}`);
  }
  // the lanes the engine owns and does not move (IDD-091): a known cause gets one instruction, anything else a card
  const stallWatch = await runStallWatch({
    submitPrep: submitPrep.errors,
    reviewLoop: reviewLoop.errors,
    land: land.errors,
    landHeld: land.held,
    submitPush: submitPush.errors,
    slotWaits: waits,
    ...(prepHeld ? { reloadHold: prepReason } : {}),
  }).catch((err) => {
    console.warn(`[tick] 止まった lane を見られませんでした: ${String(err).slice(0, 400)}`);
    return { instructed: [] as string[], halted: [] as string[], noticed: [] as string[], errors: 1 };
  });
  // the closed lanes' stage lengths, kept for the forecast: a stage that moves no lane, and one whose failure
  // never stops the tick (the runStallWatch handling)
  const durations = await recordStageDurations().catch((err) => {
    console.warn(`[tick] 段の長さを記録できませんでした: ${String(err).slice(0, 400)}`);
    return { recorded: [] as string[], errors: [{ iddId: "", error: String(err) }] };
  });
  // the place findings of merged lanes placed again from the mainline diff: a stage that moves no lane, and one
  // whose failure never stops the tick (the recordStageDurations handling)
  const findings = await reanchorPlaceFindings().catch((err) => {
    console.warn(`[tick] 指摘を付け直せませんでした: ${String(err).slice(0, 400)}`);
    return { moved: [] as string[], dropped: [] as string[], errors: 1 };
  });
  // the canary: a few of the pipeline's pi roles are asked their day's questions, with the tick's own wall limit. It
  // moves no lane and writes only its own record, and a failure stays inside this stage (runCanary keeps it there)
  const canary = await runCanary({
    ...(canaryOptions ?? {}),
    ...(canaryDeadline ? { deadline: canaryDeadline() } : {}),
  }).catch((err) => {
    console.warn(`[tick] canary を回せませんでした: ${String(err).slice(0, 400)}`);
    return { ran: [] as string[], failed: [] as string[], skipped: [] as string[], errors: [{ role: "", error: String(err) }] };
  });
  const deliver = await deliverPending();
  const watch = await runWatch();
  // the run that took Issues in has its own record; a tick without the intake leaves only this result
  try {
    if (intake.startedAt) recordCronRunSlotWaits(intake.startedAt, waits);
  } catch (err) {
    console.warn(`[tick] 上限待ちを記録できませんでした: ${String(err).slice(0, 400)}`);
  }

  return {
    intake: { added: intake.added, duplicates: intake.duplicates.length, failures: intake.failures.length, unmatched: intake.unmatched },
    trackerSync,
    prep: { started: prep.started.map((s) => s.iddId), skipped: prep.skipped.length },
    ...(heldIntake || prepHeld
      ? { hold: { reason: prepHeld ? prepReason : intakeReason, intake: heldIntake, prep: prepHeld } }
      : {}),
    reviewLoop,
    submitPrep,
    reviewLanes,
    planReview: { started: planReview.started, finished: planReview.finished, skipped: planReview.skipped, errors: planReview.errors.length },
    baseAdvance: { recorded: baseAdvance.recorded, errors: baseAdvance.errors },
    exec: { started: exec.started.map((s) => s.iddId), skipped: exec.skipped.length },
    check: {
      clean: check.filter((c) => c.outcome === "clean").map((c) => c.iddId),
      conflict: check.filter((c) => c.outcome === "conflict").map((c) => c.iddId),
    },
    close: {
      merged: close.filter((c) => c.outcome === "merged").map((c) => c.iddId),
      retired: close.filter((c) => c.outcome === "closed" && c.worktreeRemoved).map((c) => c.iddId),
      kept: close.filter((c) => c.outcome === "closed" && c.worktreeKept).map((c) => ({ iddId: c.iddId, reason: c.worktreeKept! })),
    },
    accept,
    stoppedWork: stoppedWork.map((s) => ({ iddId: s.iddId, sessions: s.sessions, runs: s.runs })),
    deliver: { delivered: deliver.delivered.length, skipped: deliver.skipped.length },
    watch: { resumed: watch.resumed, stalled: watch.stalled, errors: watch.errors.length },
    stallWatch,
    durations: { recorded: durations.recorded, errors: durations.errors.length },
    findings,
    canary: { ran: canary.ran, failed: canary.failed, skipped: canary.skipped, errors: canary.errors.length },
    prDrafts: { drafted: prDrafts.drafted, errors: prDrafts.errors.length },
    submitPush: { ready: submitPush.ready, recorded: submitPush.recorded, held: submitPush.held, merged: submitPush.merged, errors: submitPush.errors.length },
    land: { prepared: land.prepared, merged: land.merged, sentBack: land.sentBack, held: land.held.map((h) => h.iddId), errors: land.errors.length },
    budget: { stopped: budget.stopped, errors: budget.errors.length },
    prReplies: { queued: prReplies.queued.map((q) => q.iddId), errors: prReplies.errors.length },
    prFeedback: { recorded: prFeedback.recorded, errors: prFeedback.errors.length },
    slotWaits: waits,
    storage: {
      removed: storage?.removed.length ?? 0,
      bytes: storage?.removed.reduce((n, r) => n + r.bytes, 0) ?? 0,
      failed: storage?.failed.length ?? 0,
      heldLanes: [...new Set([...prep.skipped, ...exec.skipped].filter((s) => s.reason.startsWith("空きが足りない")).map((s) => s.iddId))],
      ...(storage?.reason ? { reason: storage.reason } : {}),
    },
  };
}
