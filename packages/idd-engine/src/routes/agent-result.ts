
import { json } from "../http.ts";
import { agentResult } from "@idd/core";
import { authorize } from "../server/agent-auth";
import { kickTickAfterRecord } from "../server/tick-kick";

export async function POST(req: Request) {
  if (!authorize(req)) return json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const result = await agentResult({
      iddId: String(body.idd_id ?? ""),
      outcome: body.outcome === "failed" || body.outcome === "partial" ? body.outcome : "success",
      changedFiles: Array.isArray(body.changed_files) ? body.changed_files.map(String) : [],
      commitCount: Number(body.commit_count ?? 0),
      qaVerified: Array.isArray(body.qa_verified) ? body.qa_verified.map(String) : [],
      qaUnverified: Array.isArray(body.qa_unverified) ? body.qa_unverified.map(String) : [],
      qaEvidence: body.qa_evidence && typeof body.qa_evidence === "object" && !Array.isArray(body.qa_evidence)
        ? (body.qa_evidence as Record<string, string>)
        : undefined,
      sideFindings: Array.isArray(body.side_findings) ? body.side_findings.map(String) : [],
    });
    if (result.ok) kickTickAfterRecord();
    return json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
