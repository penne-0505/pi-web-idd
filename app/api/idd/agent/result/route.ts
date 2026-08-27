// intent: DEC-661 — agent → engine の 4 口のひとつ。実装完了を記録する

import { NextResponse } from "next/server";
import { agentResult } from "@idd/core";
import { authorize } from "@/lib/idd-ui/server/agent-auth";

export async function POST(req: Request) {
  if (!authorize(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const result = await agentResult({
      iddId: String(body.idd_id ?? ""),
      outcome: body.outcome === "failed" || body.outcome === "partial" ? body.outcome : "success",
      changedFiles: Array.isArray(body.changed_files) ? body.changed_files.map(String) : [],
      commitCount: Number(body.commit_count ?? 0),
      qaVerified: Array.isArray(body.qa_verified) ? body.qa_verified.map(String) : [],
      qaUnverified: Array.isArray(body.qa_unverified) ? body.qa_unverified.map(String) : [],
      sideFindings: Array.isArray(body.side_findings) ? body.side_findings.map(String) : [],
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
