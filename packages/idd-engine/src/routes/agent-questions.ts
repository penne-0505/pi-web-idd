
import { json } from "../http.ts";
import { agentAskQuestions } from "@idd/core";
import { authorize } from "../server/agent-auth";

export async function POST(req: Request) {
  if (!authorize(req)) return json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const result = await agentAskQuestions({
      iddId: String(body.idd_id ?? ""),
      batchId: String(body.batch_id ?? ""),
      questions: Array.isArray(body.questions) ? body.questions : [],
    });
    return json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
