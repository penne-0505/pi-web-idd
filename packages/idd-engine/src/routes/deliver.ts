
import { json } from "../http.ts";
import { deliverPending, pendingEnvelopes } from "@idd/core";
import { ensureAgentRunner } from "../server/agent-runner";

export async function GET() {
  return json({ pending: pendingEnvelopes() });
}

export async function POST() {
  ensureAgentRunner();
  try {
    return json({ ok: true, ...(await deliverPending()) });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
