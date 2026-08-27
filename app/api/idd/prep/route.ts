// intent: DEC-671 — 下調べの起動口。session を持つこのプロセスでのみ起きる

import { NextResponse } from "next/server";
import { lanesAwaitingPrep, plannerConcurrency, runPrep, runningPlanners } from "@idd/core";
import { ensureAgentRunner } from "@/lib/idd-ui/server/agent-runner";

export async function GET() {
  return NextResponse.json({
    waiting: lanesAwaitingPrep().map((rec) => ({ iddId: rec.idd_id, title: rec.title, area: rec.area })),
    running: runningPlanners(),
    concurrency: plannerConcurrency(),
  });
}

export async function POST() {
  ensureAgentRunner();
  try {
    return NextResponse.json({ ok: true, ...(await runPrep()) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
