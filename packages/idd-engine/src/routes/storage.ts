import { json } from "../http.ts";
import { buildStorageView } from "@idd/core";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/idd/storage — the sizes, the free space, the next candidates and what was kept. It runs the same
 * judgment the sweep runs, and deletes nothing: only a tick holding its lock sweeps.
 */
export async function GET(): Promise<Response> {
  try {
    return json(await buildStorageView(), { headers: NO_STORE });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 500, headers: NO_STORE });
  }
}
