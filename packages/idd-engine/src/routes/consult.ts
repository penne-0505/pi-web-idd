import { json } from "../http.ts";
import { openConsult } from "../server/consult.ts";
import { ConversationRefused } from "../server/refusal.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** the same refusal shape the conversation doors use, so a caller reads every door the same way */
function failure(err: unknown): Response {
  if (err instanceof ConversationRefused) return json({ ok: false, error: err.message, ...err.body }, { status: err.status, headers: NO_STORE });
  return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 500, headers: NO_STORE });
}

/**
 * POST /api/idd/consult — open (or answer) the consult for one card. The card's kind and the key that names it
 * ride in the body, so a new kind of card needs no new path and the question card keeps its two-part key.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const parsed = await req.json().catch(() => ({}));
    const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";
    const iddId = typeof body.iddId === "string" ? body.iddId.trim() : "";
    const batchId = typeof body.batchId === "string" ? body.batchId.trim() : "";
    if (!kind) return json({ ok: false, error: "kind が必要です" }, { status: 400, headers: NO_STORE });
    if (!iddId) return json({ ok: false, error: "iddId が必要です" }, { status: 400, headers: NO_STORE });
    if (!batchId) return json({ ok: false, error: "batchId が必要です" }, { status: 400, headers: NO_STORE });
    const result = await openConsult({ kind, iddId, batchId });
    return json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}
