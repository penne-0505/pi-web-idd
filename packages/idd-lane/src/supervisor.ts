import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { conversationTurns, runConversation } from "./conversation.ts";
import { liveLockOwner } from "./conversation-lock.ts";
import { DEFAULT_SHARED_DAEMONS, settleLeftovers } from "./leftovers.ts";
import { readRoles, type RolesFile } from "./roles.ts";
import { removeRunTmp } from "./run-tmp.ts";
import { executeLane, laneDir, readLane, writeLane, type LaneRecord } from "./runner.ts";
import { requestTick, type TickKick } from "./tick-kick.ts";

export interface SuperviseOptions {
  kick?: () => TickKick;
  /** what is done with the processes the lane left in its scope; returns lines for supervisor.log */
  settle?: (id: string) => Promise<string[]>;
}

/**
 * What the detached supervisor does for one lane: an ad-hoc lane (a stage of an Issue lane or a review lane) runs
 * to its end; a conversation lane is fed its queued messages. Once the lane's record is final, a tick is asked for,
 * so the next stage does not wait for the timer. A conversation supervisor that fed nothing (the queue was empty,
 * or another supervisor holds the conversation) has nothing new for a tick to read, and asks for none. A run that
 * throws is closed as a failure first (a stage lane's record would otherwise stay "running", which no tick would
 * advance), and a tick is asked for under the same rule, before the exception leaves. Both of those are best
 * effort: the lane's own exception is what the supervisor ends with. Last, the processes the lane's agent left in
 * the supervisor's scope are settled, so the scope ends with the supervisor.
 */
export async function superviseLane(id: string, opts: SuperviseOptions = {}): Promise<{ rec: LaneRecord; kick?: TickKick }> {
  let conversation = false;
  let before = 0;
  try {
    conversation = readLane(id).mode === "conversation";
    before = conversation ? conversationTurns(id).length : 0;
    const rec = conversation ? await runConversation(id) : await executeLane(id);
    if (conversation && conversationTurns(id).length === before) return { rec };
    return { rec, kick: askTick(id, opts) };
  } catch (err) {
    // the run threw. A stage lane's record that still says "running" is closed as the failure it is, so the tick
    // this asks for can read it; a conversation's failure was already recorded inside the run, and the normal
    // path's rule (something new for a tick to read) decides. Neither step may replace the run's own exception.
    if (conversation) {
      if (turnsGrew(id, before)) askTick(id, opts);
    } else {
      closeFailedStageLane(id, err);
      askTick(id, opts);
    }
    throw err;
  } finally {
    // after the record: the lane's result never waits for, or depends on, the cleanup
    let lines: string[];
    try {
      lines = await (opts.settle ?? settleLaneLeftovers)(id);
    } catch (err) {
      lines = [`[leftover] scope の後片付けに失敗: ${String(err)}`];
    }
    for (const line of lines) log(id, line);
    // a stage run's temp dir goes after the processes it left are settled, so none of them is still writing there;
    // a conversation's goes when its supervisor lets go of it (runConversation). The record is read again here: the
    // first read may have caught a record half written (writeLane does not rename into place) and taken a
    // conversation for a stage run, and a conversation another supervisor is feeding must keep its dir
    if (!conversation) {
      try {
        const fresh = readLane(id);
        if (fresh.mode !== "conversation" && liveLockOwner(laneDir(id)) === null) removeRunTmp(id, fresh.worktree);
      } catch { /* an unreadable record: the next run's sweep takes it */ }
    }
  }
}

/** whether the conversation's replies grew past `before`; an unreadable count asks for a tick, since a stage may be waiting */
function turnsGrew(id: string, before: number): boolean {
  try { return conversationTurns(id).length !== before; } catch { return true; }
}

/** ask for a tick without letting a kick's failure change what the supervisor returns; the timer's tick still comes */
function askTick(id: string, opts: SuperviseOptions): TickKick {
  let kick: TickKick;
  try {
    kick = (opts.kick ?? requestTick)();
  } catch (err) {
    kick = { outcome: "failed", detail: String(err) };
  }
  log(id, `[tick] ${kick.outcome}${kick.unit ? ` ${kick.unit}` : ""}${kick.detail ? `: ${kick.detail}` : ""}`);
  return kick;
}

/**
 * A stage lane's run threw: end a record that still says it is running, with the exception and the time. A record
 * already in an end state is left as it is (a finished run must not be rewritten as failed), and an unreadable one
 * is not recreated, since the supervisor cannot restore what it had. A failure here is only written down.
 */
function closeFailedStageLane(id: string, err: unknown): void {
  try {
    const rec = readLane(id);
    if (rec.status !== "running") return;
    rec.status = "failed";
    rec.error = `監督が異常終了した: ${String(err instanceof Error ? err.message : err)}`.slice(0, 500);
    rec.ended_at = new Date().toISOString();
    delete rec.pid;
    delete rec.supervisor_pid;
    writeLane(rec);
  } catch (e) {
    log(id, `[exception] 記録を失敗で閉じられなかった: ${String(e)}`);
  }
}

function log(id: string, line: string): void {
  try {
    appendFileSync(join(laneDir(id), "supervisor.log"), `${line}\n`);
  } catch { /* the lane's directory is gone */ }
}

/**
 * The shared daemons a lane's cleanup keeps: the list the lane was prepared with; for a lane with none on its record
 * (one from before the list was kept), config/roles.yaml now. When neither can be read, the patterns someone added are
 * unknown, so nothing is stopped: the defaults are still moved, the rest left running.
 */
export function leftoverSettings(id: string, read: () => RolesFile = () => readRoles()): { patterns: readonly string[]; stop: boolean } {
  let recorded: string[] | undefined;
  try { recorded = readLane(id).shared_daemons; } catch { /* no record */ }
  if (recorded) return { patterns: recorded, stop: true };
  try {
    return { patterns: read().defaults.sharedDaemons, stop: true };
  } catch {
    return { patterns: DEFAULT_SHARED_DAEMONS, stop: false };
  }
}

/** the cleanup of the supervisor's own scope */
export function settleLaneLeftovers(id: string): Promise<string[]> {
  return settleLeftovers({ laneId: id, ...leftoverSettings(id) });
}
