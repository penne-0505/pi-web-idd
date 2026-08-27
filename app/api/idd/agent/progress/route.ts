// intent: DEC-661 — agent → engine の 4 口のひとつ。executor の中間進捗を上書きする

import { NextResponse } from "next/server";
import { agentProgress } from "@idd/core";
import { authorize } from "@/lib/idd-ui/server/agent-auth";

export async function POST(req: Request) {
  if (!authorize(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const result = await agentProgress({
      iddId: String(body.idd_id ?? ""),
      currentStep: String(body.current_step ?? "implementing"),
      qaStatus: Array.isArray(body.qa_status) ? body.qa_status : [],
      recentActivity: Array.isArray(body.recent_activity) ? body.recent_activity.map(String) : [],
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
