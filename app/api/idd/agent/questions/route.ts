// intent: DEC-661 — agent → engine の 4 口のひとつ。質問 batch を開く

import { NextResponse } from "next/server";
import { agentAskQuestions } from "@idd/core";
import { authorize } from "@/lib/idd-ui/server/agent-auth";

export async function POST(req: Request) {
  if (!authorize(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const result = await agentAskQuestions({
      iddId: String(body.idd_id ?? ""),
      batchId: String(body.batch_id ?? ""),
      questions: Array.isArray(body.questions) ? body.questions : [],
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
