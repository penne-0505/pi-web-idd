import { json } from "../http.ts";
import { searchConversations } from "../server/conversation-search.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/conversation-search?q=<語>&mode=<mode> — search pi's own session records. The records are read on
 * every call and pi is never started; an empty query is refused.
 */
export function GET(req: Request): Response {
  try {
    const url = new URL(req.url);
    const query = (url.searchParams.get("q") ?? "").trim();
    if (!query) return json({ ok: false, error: "q が必要です" }, { status: 400, headers: NO_STORE });
    const mode = url.searchParams.get("mode")?.trim() || undefined;
    const result = searchConversations(query, { ...(mode ? { mode } : {}) });
    return json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 500, headers: NO_STORE });
  }
}
