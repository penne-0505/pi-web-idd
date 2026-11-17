import { json } from "../http.ts";
import { agentGranularity } from "@idd/core";
import { authorize } from "../server/agent-auth";

export async function POST(req: Request) {
  if (!authorize(req)) return json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const result = await agentGranularity({
      iddId: String(body.idd_id ?? ""),
      proposal: body.proposal,
    });
    return json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
