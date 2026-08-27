// intent: DEC-605 — 書けなければ ok:false。UI は押した状態にしない

import { NextResponse } from "next/server";
import { applyDecision, deliverPending } from "@idd/core";
import { ensureAgentRunner } from "@/lib/idd-ui/server/agent-runner";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { action?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON を読めません" }, { status: 400 });
  }
  if (!body.action) return NextResponse.json({ ok: false, error: "action が空" }, { status: 400 });

  try {
    const result = await applyDecision(body.action, body.payload ?? {});
    // intent: DEC-676 — 記録が済んだら即座に配信を試みる。失敗しても記録は成功のまま (未達は outbox に残る)
    let delivery: Awaited<ReturnType<typeof deliverPending>> | { error: string } | undefined;
    if (result.ok) {
      ensureAgentRunner();
      delivery = await deliverPending().catch((err) => ({ error: String(err) }));
    }
    return NextResponse.json({ ...result, delivery }, {
      status: result.ok ? 200 : 400,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
