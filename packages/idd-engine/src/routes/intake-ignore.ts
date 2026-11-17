import { json } from "../http.ts";
import { ignoreByRef, ignorePreview, listIgnored } from "@idd/core";
import { ensureAgentRunner } from "../server/agent-runner";
import { kickTickAfterRecord } from "../server/tick-kick";


/**
 * The Issues intake leaves out. With `?ref=`, what an ignore of that ref would do (from the state alone, no intake
 * read): the screen asks this before it presses, so closing a lane's work is said first. What it says is what the
 * write does: a lane's own ID that is closed already is refused, an Issue's ref with every lane closed only puts
 * the Issue on the list.
 */
export async function GET(req: Request) {
  try {
    const ref = new URL(req.url).searchParams.get("ref")?.trim() ?? "";
    if (ref) return json({ ok: true, preview: ignorePreview(ref) }, { headers: { "Cache-Control": "no-store" } });
    return json({ ok: true, ignores: listIgnored() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}

/**
 * { action: "ignore" | "unignore", ref, closeLane }}: put an Issue on the list or take it off, from the lane list's
 * screen. `closeLane` is the lane the screen's check showed penne (null when it showed none): the lane is closed
 * only when the ref resolves to that same lane.
 * An ignore of an Issue whose lane is open closes that lane first and stops its sessions and runs right here (the
 * runner is put in before the write), so the screen's ignore does the same as the card's. Nothing is written to
 * GitHub or Linear. A tick is asked for once the write went through: a lane was closed, and what follows it (the
 * worktree's retirement, the next stage of an unignored Issue) is the tick's.
 */
export async function POST(req: Request) {
  let body: { action?: unknown; ref?: unknown; closeLane?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON を読めません" }, { status: 400 });
  }
  const action = body.action === "ignore" || body.action === "unignore" ? body.action : null;
  const ref = typeof body.ref === "string" ? body.ref.trim() : "";
  if (!action || !ref) return json({ ok: false, error: "action（ignore / unignore）と ref が要ります" }, { status: 400 });
  // a lane is closed only against the confirmation the screen showed: `closeLane` names the lane the caller was
  // told about, null means it was told no lane is at stake. A request that says neither is refused with the lane
  // to confirm, so a press that outran the screen's check (Enter before the preview, a rewritten ref, a preview
  // that failed) writes nothing.
  const closeLane = typeof body.closeLane === "string" ? body.closeLane : null;
  try {
    ensureAgentRunner();
    const res = await ignoreByRef(action, ref, action === "ignore" ? { confirmedLane: closeLane } : {});
    if (res.ok) kickTickAfterRecord();
    return json(res, { status: res.ok ? 200 : 400 });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
