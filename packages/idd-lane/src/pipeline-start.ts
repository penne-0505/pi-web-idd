import type { QuotaFallback } from "./claude-quota.ts";
import { conversationLane, discardConversation, isConversation, openConversation } from "./conversation.ts";
import { cacheTtlOf, readLane, stopLane } from "./runner.ts";
import { pipelinePlanFor, removePipelineSession } from "./pipeline-spawn.ts";
import { resolveRoute } from "./route.ts";
import { readRoles, resolvePipelineRole, type RolePreset } from "./roles.ts";

export interface PipelineSessionStart {
  sessionId: string;
  model: string;
  harness: "pi" | "claude";
  /** the run's resolved prompt cache hold, for the brief builder (a 5-minute run wraps its long checks) */
  cacheTtl: "1h" | "5m";
  fallbacks?: QuotaFallback[];
}

/**
 * The runtime's spawn for a pipeline slot (planner / executor). Every harness runs as a conversation lane under
 * the lane supervisor, outside the caller's process: this only claims the session id, and the first deliver
 * starts the supervisor. The slot's whole candidate order is drawn here (DEC-110-1): a role refused for the
 * windows is skipped for the next candidate (a pi role or another Claude role), and the whole conversation
 * stays on what ran. With no candidate that can start, the refusal is thrown on and the slot waits. A
 * conversation only switches at spawn: a reply that fails mid-conversation is left to resume and judgment.
 */
export async function spawnPipelineSession(
  slotName: string,
  cwd: string,
  opts: { checkStartable?: (role: RolePreset) => void; iddId?: string } = {},
): Promise<PipelineSessionStart> {
  const file = readRoles();
  const { role } = resolvePipelineRole(slotName, file);
  const route = resolveRoute(role, file, opts.checkStartable ? { checkStartable: opts.checkStartable } : {});
  const plan = pipelinePlanFor(slotName, route.candidate.role, opts);
  const quotaFallback = route.fallback;
  const planned = quotaFallback ? { ...plan, quotaFallback } : plan;
  const { sessionId, laneId } = openConversation(planned, cwd, opts.iddId ? { iddId: opts.iddId } : {});
  // the hold is read back from the conversation's own record: every conversation lane resolves it at env time, so
  // reporting the plain run default here would call a 1-hour planner / executor a 5-minute run and wrap its checks
  return {
    sessionId, model: plan.model, harness: plan.harness, cacheTtl: cacheTtlOf(readLane(laneId)),
    ...(quotaFallback ? { fallbacks: [quotaFallback] } : {}),
  };
}

/**
 * Stop a session the pipeline started, where it stands. Every harness runs as a conversation lane under the lane
 * supervisor, so the stop is that lane's own, as a person stops it: its supervisor is told, and the watch does not
 * take the end for an interruption and start it again. A session that is no conversation lane of ours (an old pi
 * session loaded in this process, say) is stopped with `stopPi`. Used when a lane is taken out (ignored, redone):
 * the session's record is left as it is, unlike `discardPipelineSession`, which takes back a session that never ran.
 */
export async function stopPipelineSession(sessionId: string, stopPi: (sessionId: string) => Promise<void> | void): Promise<void> {
  const laneId = conversationLane(sessionId);
  if (laneId) {
    stopLane(laneId);
    return;
  }
  await stopPi(sessionId);
}

/**
 * Take back a session spawnPipelineSession started, for a start the engine then refused: a claude conversation is
 * unclaimed (it never ran), a pi session is stopped with `stopPi` and its record for resume removed.
 * Take back a session spawnPipelineSession started, for a start the engine then refused: a conversation that was
 * never given a message is unclaimed (nothing feeds it), and any leftover spawn record goes.
 */
export function discardPipelineSession(sessionId: string): void {
  if (isConversation(sessionId)) {
    discardConversation(sessionId);
    return;
  }
  removePipelineSession(sessionId);
}
