import { json } from "../http.ts";
import { agentHold, checkLaneHoldToken } from "@idd/core";
import { kickTickAfterRecord } from "../server/tick-kick";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    // the credential is the lane's own: the shared agent token names no lane, so it opens nothing here, and a body that
    // names another lane than the credential's is turned away before anything is written
    const header = req.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!checkLaneHoldToken(typeof body.idd_id === "string" ? body.idd_id : "", presented)) return json({ ok: false, error: "unauthorized" }, { status: 401 });
    if (body.kind !== "push" && body.kind !== "pr-create") return json({ ok: false, error: "kind は push か pr-create です" }, { status: 400 });
    const result = await agentHold({
      iddId: String(body.idd_id ?? ""),
      kind: body.kind,
      title: typeof body.title === "string" ? body.title : undefined,
      body: typeof body.body === "string" ? body.body : undefined,
    });
    if (result.ok) kickTickAfterRecord();
    return json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
