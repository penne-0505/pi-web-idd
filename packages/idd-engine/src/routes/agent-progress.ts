
import { json } from "../http.ts";
import { agentProgress } from "@idd/core";
import { authorize } from "../server/agent-auth";

export async function POST(req: Request) {
  if (!authorize(req)) return json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const result = await agentProgress({
      iddId: String(body.idd_id ?? ""),
      currentStep: String(body.current_step ?? "implementing"),
      qaStatus: Array.isArray(body.qa_status)
        ? body.qa_status.map((q: Record<string, unknown>) => ({
          qa_id: String(q.qa_id ?? ""),
          status: String(q.status ?? ""),
          ...(typeof q.evidence === "string" && q.evidence ? { evidence: q.evidence } : {}),
        }))
        : [],
      recentActivity: Array.isArray(body.recent_activity) ? body.recent_activity.map(String) : [],
    });
    return json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
