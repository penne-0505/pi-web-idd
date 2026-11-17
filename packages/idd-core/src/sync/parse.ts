import { rejectUnknownFields, tableEntries } from "../config/table.ts";
import type { Tracker, TrackerSyncConfig } from "./types.ts";

/** minutes between two syncs of one repo when the config does not say; the tick runs every 15 */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 15;

/** how late the tick timer may start after its mark (`RandomizedDelaySec` of `idd-tick.timer`, which a test keeps equal to this) */
export const TICK_TIMER_RANDOM_DELAY_SEC = 60;

const FIELDS = ["target", "linear_team", "interval_minutes"];

/**
 * config/repos.yaml's `tracker_sync` for one repo: which tracker its Projects and Issues are read from, and how often
 * the tick reads it. A repo that writes no `tracker_sync` reads no outside. Anything misspelt is a config error: a
 * dropped field would otherwise turn a narrow setting into a silent default (`write` is one: the sync writes nothing).
 */
export function parseTrackerSync(key: string, raw: unknown): TrackerSyncConfig | undefined {
  const where = `repos.${key}.tracker_sync`;
  const entries = tableEntries(where, raw);
  if (!entries) return undefined;
  const o = Object.fromEntries(entries);
  rejectUnknownFields(where, o, FIELDS);
  if (o.target !== "github" && o.target !== "linear") throw new Error(`${where}.target: github か linear で書いてください`);
  const target: Tracker = o.target;
  let linearTeam: string | undefined;
  if (o.linear_team !== undefined && o.linear_team !== null) {
    if (typeof o.linear_team !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(o.linear_team.trim())) throw new Error(`${where}.linear_team: Linear のチームの key（APP など）で書いてください`);
    linearTeam = o.linear_team.trim().toUpperCase();
  }
  if (target === "linear" && !linearTeam) throw new Error(`${where}.linear_team: target が linear のときは Linear のチームの key が要ります`);
  let intervalMinutes = DEFAULT_SYNC_INTERVAL_MINUTES;
  if (o.interval_minutes !== undefined && o.interval_minutes !== null) {
    if (typeof o.interval_minutes !== "number" || !Number.isFinite(o.interval_minutes) || o.interval_minutes <= 0) throw new Error(`${where}.interval_minutes: 正の数（分）で書いてください`);
    intervalMinutes = o.interval_minutes;
  }
  return { target, ...(linearTeam ? { linearTeam } : {}), intervalMinutes };
}
