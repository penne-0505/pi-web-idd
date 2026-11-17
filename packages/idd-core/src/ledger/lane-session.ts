import { readLifecycle, readSessions } from "./read.ts";
import { laneSessionRole } from "./replan-view.ts";

export interface LaneSession {
  iddId: string;
  role: "planner" | "executor";
  sessionId: string;
  worktree: string;
}

/**
 * The newest session of the role that holds the lane's work now (`laneSessionRole`), or null when the lane has none
 * on record. The role is read from the lane's rows through the view of a return to the plan, so a lane sent back to
 * its plan gets its planner's session though an executor's is still on record; a lane whose role has no session is
 * not answered with the other role's, because that one is not the agent the lane waits on.
 */
export function laneSession(iddId: string): LaneSession | null {
  const role = laneSessionRole(readLifecycle().filter((e) => e.idd_id === iddId));
  const rec = readSessions(role).filter((r) => r.idd_id === iddId).pop();
  const sessionId = role === "executor" ? rec?.executor_session_id : rec?.planner_session_id;
  return rec && sessionId ? { iddId, role, sessionId, worktree: rec.worktree_path } : null;
}
