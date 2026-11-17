import { json } from "../http.ts";
import { moveInStartOrder, setUrgent, startOrderView, type StartOrderResult } from "@idd/core";
import { kickTickAfterRecord } from "../server/tick-kick";

/**
 * The start order: which lane each capped stage starts first. `GET` is the reader the Work screen's "next in"
 * column takes; `POST` moves a lane, or marks it urgent / takes the mark off. The door is a person's (no agent
 * token, like the ignore list and the decisions), it writes nothing to GitHub or Linear, and it starts or stops
 * no session.
 */
export async function GET() {
  try {
    return json(startOrderView(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}

const bad = (error: string): Response => json({ ok: false, error }, { status: 400 });

/**
 * { action: "move" | "urgent" | "unurgent", idd_id, before?, after?, position? }. A body that is not a JSON object,
 * an unknown action, a missing id, or a field of the wrong type is refused before the core is asked, so the door
 * never hands core a value of a different type than its own check allows. A write asks for a tick.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("JSON を読めません");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return bad("body は object にしてください");
  const fields = body as Record<string, unknown>;
  const action = fields.action;
  if (action !== "move" && action !== "urgent" && action !== "unurgent") return bad("action は move・urgent・unurgent のどれかにしてください");
  if (typeof fields.idd_id !== "string" || !fields.idd_id.trim()) return bad("idd_id が要ります");
  for (const key of ["before", "after"]) {
    if (fields[key] !== undefined && typeof fields[key] !== "string") return bad(`${key} は文字列にしてください`);
  }
  if (fields.position !== undefined && typeof fields.position !== "number") return bad("position は数にしてください");

  try {
    const res: StartOrderResult = action === "move"
      ? await moveInStartOrder({
        idd_id: fields.idd_id,
        ...(fields.before !== undefined ? { before: fields.before } : {}),
        ...(fields.after !== undefined ? { after: fields.after } : {}),
        ...(fields.position !== undefined ? { position: fields.position } : {}),
      })
      : await setUrgent({ idd_id: fields.idd_id, urgent: action === "urgent" });
    // only a write asks for a tick: the reader above never does, and a lane that moved may free a stage's slot
    if (res.ok) kickTickAfterRecord();
    return json(res, { status: res.ok ? 200 : 400 });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
