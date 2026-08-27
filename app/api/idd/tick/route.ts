// intent: DEC-700 — cron と手動の入口。session を持つこのプロセスでのみ一巡できる

import { NextResponse } from "next/server";
import { runTick } from "@idd/core";
import { ensureAgentRunner } from "@/lib/idd-ui/server/agent-runner";

export async function POST(req: Request) {
  ensureAgentRunner();
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ ok: true, ...(await runTick({ intake: body.intake !== false })) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
