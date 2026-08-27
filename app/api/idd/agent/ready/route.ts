// intent: DEC-661 — agent → engine の 4 口のひとつ。下調べ完了を宣言する

import { NextResponse } from "next/server";
import { agentReady } from "@idd/core";
import { authorize } from "@/lib/idd-ui/server/agent-auth";

export async function POST(req: Request) {
  if (!authorize(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const result = await agentReady({
      iddId: String(body.idd_id ?? ""),
      plannerSessionId: body.planner_session_id ? String(body.planner_session_id) : undefined,
      decCount: Number(body.dec_count ?? 0),
      invCount: Number(body.inv_count ?? 0),
      qaCount: Number(body.qa_count ?? 0),
      referenceCount: Number(body.reference_count ?? 0),
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
