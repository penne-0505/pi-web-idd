import { buildMetrics, canaryWindows, readCanaryRecords } from "@idd/core";
import { conversationLane, readClaudeQuotaWindows, readConsumption, readRoles } from "@idd/lane";

import { json } from "../http.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * The first day of the week `idd metrics` reads when it is told no period: six days before the last day, so the
 * period is seven days with both ends counted. A week that ends on the day the survey is written starts on the
 * Monday the ISO week starts on, and the week before it is the seven days in front of that.
 */
function defaultSince(until: string): string {
  return new Date(Date.parse(`${until}T00:00:00Z`) - 6 * 86400_000).toISOString().slice(0, 10);
}

/**
 * GET /api/idd/metrics?since=YYYY-MM-DD&until=YYYY-MM-DD — the period's numbers, read from the ledger, the landing
 * rounds, the backlog, git and the budget's own reader. The door is read-only and writes nothing, so the CLI, the
 * screen or a person may call it as often as they like.
 *
 * The costs are read here and not in the CLI: a lane's spend includes its planner and executor sessions, which only
 * the engine's runner can read; a process without one would report every lane as free.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const until = url.searchParams.get("until")?.trim();
    const last = until || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const since = url.searchParams.get("since")?.trim() || defaultSince(last);
    // the canary's records for the period and the same number of days before it: the week's table compares the two
    const windows = canaryWindows(since, last);
    const canary = readCanaryRecords([...windows.current, ...windows.previous]);
    const consumption = readConsumption();
    const view = await buildMetrics({
      since,
      ...(until ? { until } : {}),
      consumption,
      // a reply's row names its conversation's lane, and the planner and executor sessions name their session
      conversationLaneOf: conversationLane,
      // the windows' observations are read by the lane's side, over the period the metrics resolved for itself, and only
      // the runs of the lane side's config dir (the conversation's dir can be another account's window)
      quotaWindows: (period) => readClaudeQuotaWindows(consumption, period, readRoles().defaults.claudeConfigDir),
      canary,
    });
    return json(view, { headers: NO_STORE });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 500, headers: NO_STORE });
  }
}
