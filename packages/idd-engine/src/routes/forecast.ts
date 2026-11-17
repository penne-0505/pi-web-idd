import { buildForecast } from "@idd/core";

import { json } from "../http.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/idd/forecast — every open lane's stage, elapsed time, anomaly and finish, and the usual stage lengths
 * behind them. Read-only: the state is not touched, and the closed lanes' rows are written by the tick alone.
 */
export async function GET(): Promise<Response> {
  try {
    return json(buildForecast(), { headers: NO_STORE });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 500, headers: NO_STORE });
  }
}
