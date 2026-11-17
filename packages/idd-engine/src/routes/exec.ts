
import { json } from "../http.ts";
import { executorConcurrency, lanesAwaitingExec, runExec, runningExecutors } from "@idd/core";
import { ensureAgentRunner } from "../server/agent-runner";

export async function GET() {
  return json({
    waiting: lanesAwaitingExec().map((rec) => ({ iddId: rec.idd_id, title: rec.title })),
    running: runningExecutors(),
    concurrency: executorConcurrency(),
  });
}

export async function POST() {
  ensureAgentRunner();
  try {
    return json({ ok: true, ...(await runExec()) });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
