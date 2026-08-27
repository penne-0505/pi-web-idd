// intent: DEC-659 — 配信は pi session を所有するこのプロセスでのみ起きる。cron はここを叩く

import { NextResponse } from "next/server";
import { deliverPending, pendingEnvelopes } from "@idd/core";
import { ensureAgentRunner } from "@/lib/idd-ui/server/agent-runner";

export async function GET() {
  return NextResponse.json({ pending: pendingEnvelopes() });
}

export async function POST() {
  ensureAgentRunner();
  try {
    return NextResponse.json({ ok: true, ...(await deliverPending()) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
