import { getAgentRunner, type AgentRunner } from "./port.ts";
import { readLifecycle, readSessions } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { laneRunIds } from "../plan/budget.ts";

/** which way a lane was taken out: the stop the caller does right here (`ignore`, `redo`) or the tick's later pass */
export type StopWorkVia = "ignore" | "redo" | "tick";

export interface StopWorkResult {
  /** the session ids the runtime was told to stop */
  sessions: string[];
  /** the run ids the runtime was told to stop */
  runs: string[];
  /** the ones it could not stop, with why */
  failed: { id: string; reason: string }[];
}

/** the planner and executor sessions a lane recorded, in the order they were recorded */
export function laneSessionIds(iddId: string): string[] {
  const ids: string[] = [];
  for (const s of readSessions("planner")) if (s.idd_id === iddId && s.planner_session_id) ids.push(s.planner_session_id);
  for (const s of readSessions("executor")) if (s.idd_id === iddId && s.executor_session_id) ids.push(s.executor_session_id);
  return [...new Set(ids)];
}

/**
 * The ad-hoc runs a lane's stages started, as the lifecycle recorded them: the singles (`run_id`) and lists
 * (`run_ids`) `laneRunIds` collects, and the whole-diff runs a mapped round recorded beside its place's own.
 */
export function laneRunIdList(events: { attrs?: Record<string, unknown> }[]): string[] {
  const ids = new Set(laneRunIds(events));
  for (const e of events) {
    const whole = e.attrs?.whole_run_ids;
    if (Array.isArray(whole)) for (const id of whole) if (typeof id === "string" && id) ids.add(id);
  }
  return [...ids];
}

/** whether the runtime says this session is working now; without a status port, it is taken as running */
async function sessionRunning(runner: AgentRunner, id: string): Promise<boolean> {
  try {
    const st = await runner.sessionStatus?.(id);
    return st ? st.state === "running" : true;
  } catch {
    return false;
  }
}

/** whether the runtime says this run is working now; without a status port, it is taken as running */
function runRunning(runner: AgentRunner, id: string): boolean {
  try {
    const st = runner.reviewRunStatus?.(id);
    return st ? st.state === "running" : true;
  } catch {
    return false;
  }
}

const why = (err: unknown): string => String((err as Error)?.message ?? err).slice(0, 200);

/**
 * Stop a lane's planner / executor sessions and the runs its stages started, right where the caller stands. Only
 * what the runtime says is working now is stopped: a session or run that has ended is left as it is, its record
 * (status, ended_at) is not rewritten, and it does not reach the lane's note either. The status is asked first for
 * a second reason: `stopLane` sends its signal to whatever the record names, and a record left from a session that
 * ended can name a process number that another process (another lane's agent) now has.
 *
 * The runtime's own stop is used, so a Claude conversation is stopped as a person stops it (nothing resumes it) and
 * a pi session is shut down in this process. Every stop is kept in the lifecycle as a note: an event that moves no
 * stage, so the lane's stage stays where it is.
 */
export async function stopLaneWork(iddId: string, opts: { via: StopWorkVia }): Promise<StopWorkResult> {
  const runner = getAgentRunner();
  const events = readLifecycle().filter((e) => e.idd_id === iddId);
  const sessions = laneSessionIds(iddId);
  const runs = laneRunIdList(events);
  const out: StopWorkResult = { sessions: [], runs: [], failed: [] };
  if (!runner) return out;

  const stopSession = runner.stopSession?.bind(runner);
  for (const id of sessions) {
    if (!(await sessionRunning(runner, id))) continue;
    if (!stopSession) { out.failed.push({ id, reason: "runner に session を止める口がありません" }); continue; }
    try {
      await stopSession(id);
      out.sessions.push(id);
    } catch (err) {
      out.failed.push({ id, reason: why(err) });
    }
  }

  const stopRun = runner.stopRun?.bind(runner);
  for (const id of runs) {
    if (!runRunning(runner, id)) continue;
    if (!stopRun) { out.failed.push({ id, reason: "runner に run を止める口がありません" }); continue; }
    try {
      await stopRun(id);
      out.runs.push(id);
    } catch (err) {
      out.failed.push({ id, reason: why(err) });
    }
  }

  if (out.sessions.length || out.runs.length || out.failed.length) {
    await appendLifecycle("lane_work_stopped", iddId, {
      via: opts.via,
      sessions: out.sessions,
      runs: out.runs,
      ...(out.failed.length ? { failed: out.failed } : {}),
    });
  }
  return out;
}
