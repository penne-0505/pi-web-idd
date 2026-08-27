// intent: DEC-686 — 中断した lane を続きから再開させる口

import { NextResponse } from "next/server";
import { runResume } from "@idd/core";
import { ensureAgentRunner } from "@/lib/idd-ui/server/agent-runner";

export async function POST(req: Request) {
  ensureAgentRunner();
  try {
    const body = await req.json().catch(() => ({}));
    const iddId = String(body.idd_id ?? body.iddId ?? "");
    if (!iddId) return NextResponse.json({ ok: false, error: "idd_id が空" }, { status: 400 });
    const result = await runResume(iddId, body.reason ? String(body.reason) : undefined);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
