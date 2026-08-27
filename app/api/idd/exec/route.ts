// intent: DEC-685 — 実装の起動口。session を持つこのプロセスでのみ起きる

import { NextResponse } from "next/server";
import { executorConcurrency, lanesAwaitingExec, runExec, runningExecutors } from "@idd/core";
import { ensureAgentRunner } from "@/lib/idd-ui/server/agent-runner";

export async function GET() {
  return NextResponse.json({
    waiting: lanesAwaitingExec().map((rec) => ({ iddId: rec.idd_id, title: rec.title })),
    running: runningExecutors(),
    concurrency: executorConcurrency(),
  });
}

export async function POST() {
  ensureAgentRunner();
  try {
    return NextResponse.json({ ok: true, ...(await runExec()) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
