
import { json } from "../http.ts";
import { lanesAwaitingMerge, runClose } from "@idd/core";

export async function GET() {
  return json({
    waiting: lanesAwaitingMerge().map((x) => ({ iddId: x.rec.idd_id, prUrl: x.prUrl })),
  });
}

export async function POST() {
  try {
    return json({ ok: true, results: await runClose() });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
