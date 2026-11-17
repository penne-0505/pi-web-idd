import { json } from "../http.ts";
import { closeAndReload } from "../server/reload.ts";

/**
 * POST /api/idd/reload — penne's "close and replace": close the open conversations the engine is waiting on, then
 * let the reload's judgment ask systemd for the restart. It carries no lane and writes nothing to the records; the
 * reload's own check waits for the in-flight requests (this one included) before it asks.
 */
export async function POST() {
  try {
    const { closed } = await closeAndReload();
    return json({ ok: true, closed }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
