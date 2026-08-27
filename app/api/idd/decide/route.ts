// intent: DEC-605 — 書けなければ ok:false。UI は押した状態にしない

import { NextResponse } from "next/server";
import { applyDecision } from "@/lib/idd-ui/server/write";

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
    return NextResponse.json(result, {
      status: result.ok ? 200 : 400,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
