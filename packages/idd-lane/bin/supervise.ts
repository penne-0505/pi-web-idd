// Detached supervisor for one ad-hoc lane: starts pi, waits for it, finalizes lane.json.
// A conversation lane (an Issue lane's planner / executor on Claude Code) is fed its queued messages instead.
// Once the lane's record is final, it asks for a tick so the next stage does not wait for the timer.
// Last, it settles the processes the lane's agent left in its scope (shared daemons are moved out, the rest stopped).
import { superviseLane } from "../src/supervisor.ts";

const id = process.argv[2];
if (!id) { process.stderr.write("usage: supervise.ts LANE_ID\n"); process.exit(2); }
superviseLane(id).then(({ rec }) => process.exit(rec.mode === "conversation" || rec.status === "done" ? 0 : 1)).catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
