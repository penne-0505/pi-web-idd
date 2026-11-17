
import { json } from "../http.ts";
import { lanesAwaitingCheck, runCheck } from "@idd/core";

export async function GET() {
  return json({ waiting: lanesAwaitingCheck().map((r) => ({ iddId: r.idd_id, title: r.title })) });
}

export async function POST() {
  try {
    return json({ ok: true, results: await runCheck() });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
