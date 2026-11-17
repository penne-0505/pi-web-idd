
import { json } from "../http.ts";
import { lanesAwaitingPrep, plannerConcurrency, runPrep, runningPlanners } from "@idd/core";
import { ensureAgentRunner } from "../server/agent-runner";
import { intakeHold } from "../server/reload.ts";

export async function GET() {
  return json({
    waiting: lanesAwaitingPrep().map((rec) => ({ iddId: rec.idd_id, title: rec.title, area: rec.area })),
    running: runningPlanners(),
    concurrency: plannerConcurrency(),
  });
}

export async function POST() {
  ensureAgentRunner();
  try {
    // a straight start of the planners holds too: the same judgment the tick uses, read now
    const hold = intakeHold();
    return json({ ok: true, ...(await runPrep(hold.hold && hold.reason ? { hold: hold.reason } : {})) });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
