import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import lockfile from "proper-lockfile";

import type { QuotaFallback, QuotaWindowPeak, QuotaWindowReading, QuotaWindows } from "@idd/core";

import { jstDayOf, type ConsumptionRow } from "./consumption.ts";
import { laneStateDir } from "./paths.ts";

export type { QuotaFallback };

/** one window of the subscription: utilization 0..1 and when it resets (UNIX seconds) */
export interface ClaudeQuotaWindow {
  utilization: number;
  resets_at?: number;
}

/** the subscription's windows as a `rate_limit_event` of `claude -p --output-format stream-json` reports them */
export interface ClaudeQuota {
  /** allowed / allowed_warning / rejected (the last is read as "cannot run") */
  status: string;
  /** the window the event is about, and its reset */
  rate_limit_type?: string;
  resets_at?: number;
  /** keyed by window: five_hour, seven_day, ... */
  windows: Record<string, ClaudeQuotaWindow>;
}

export interface ClaudeQuotaObservation extends ClaudeQuota {
  observed_at: string;
  /** the lane whose run reported it */
  lane?: string;
  /** the config dir (the account) the run ran in; absent on what was kept before the run's record named it */
  config_dir?: string;
}

export const DEFAULT_CLAUDE_QUOTA_STOP: Record<string, number> = { five_hour: 0.9, seven_day: 0.95 };

/** the windows Claude Code reports, and how long each lasts: a reset nobody reported is at most this far from the observation */
export const CLAUDE_QUOTA_WINDOWS: Record<string, number> = { five_hour: 5 * 3600, seven_day: 7 * 24 * 3600 };

/**
 * A Claude Code lane not started because of the subscription's windows. It is a wait, not a failure: the
 * caller tries again later, and `resetsAt` (UNIX seconds) says from when it can.
 */
export class ClaudeQuotaBlocked extends Error {
  readonly code = "claude_quota";
  readonly resetsAt?: number;
  constructor(message: string, resetsAt?: number) {
    super(message);
    this.name = "ClaudeQuotaBlocked";
    if (resetsAt !== undefined) this.resetsAt = resetsAt;
  }
}

/**
 * A Claude Code role refused for the windows, and the role (roles.yaml `fallback`) that ran in its place: on the
 * run's record, and handed to the engine (the shape is the engine's port), which puts it on the lane's history.
 */
export function quotaFallbackOf(role: string, fallback: string, err: ClaudeQuotaBlocked, extra: { kind?: QuotaFallback["kind"]; provider?: string } = {}): QuotaFallback {
  return {
    role,
    fallback,
    reason: err.message,
    ...(err.resetsAt !== undefined ? { resets_at: err.resetsAt } : {}),
    ...(extra.kind ? { kind: extra.kind } : {}),
    ...(extra.provider ? { provider: extra.provider } : {}),
  };
}

/** Refuse penne's own config dirs, and a lane config dir nobody has logged in to (with the command that does). */
export function checkClaudeConfigDir(configDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const own = [join(process.env.HOME ?? "", ".claude"), env.CLAUDE_CONFIG_DIR].filter(Boolean).map((p) => resolve(String(p)));
  if (own.includes(resolve(configDir))) throw new Error(`lane の Claude Code の設定置き場が penne 個人の置き場を指しています: ${configDir}（defaults.claude_config_dir か IDD_CLAUDE_CONFIG_DIR を lane 専用の場所にする）`);
  if (env.CLAUDE_CODE_OAUTH_TOKEN || existsSync(join(configDir, ".credentials.json"))) return;
  throw new Error(`lane 用の Claude Code にログインしていません。端末で次を実行し、/login でログインしてから lane をやり直す: CLAUDE_CONFIG_DIR=${configDir} claude`);
}

/** the same wait, when the fallback that would have stood in cannot start either */
export function fallbackCannotStart(err: ClaudeQuotaBlocked, fallback: string, cause: unknown): ClaudeQuotaBlocked {
  return new ClaudeQuotaBlocked(`${err.message}（代わりの ${fallback} も起動できない: ${cause instanceof Error ? cause.message : String(cause)}）`, err.resetsAt);
}

/** told by its code, so a caller across a module boundary (the engine behind the runner port) can tell it too */
export function isClaudeQuotaBlocked(err: unknown): err is ClaudeQuotaBlocked {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "claude_quota";
}

const WINDOW_LABEL: Record<string, string> = { five_hour: "5 時間の枠", seven_day: "週上限" };

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function windowOf(raw: unknown): ClaudeQuotaWindow | null {
  const w = (raw ?? {}) as Record<string, unknown>;
  const utilization = num(w.utilization);
  if (utilization === undefined) return null;
  const resetsAt = num(w.resetsAt);
  return { utilization, ...(resetsAt !== undefined ? { resets_at: resetsAt } : {}) };
}

/** The windows of one stream-json `rate_limit_event`, or null when it carries none we can read. */
export function quotaFromEvent(ev: Record<string, unknown>): ClaudeQuota | null {
  const info = ev.rate_limit_info as Record<string, unknown> | undefined;
  if (!info || typeof info !== "object" || typeof info.status !== "string") return null;
  const windows: Record<string, ClaudeQuotaWindow> = {};
  const unified = info.unifiedWindows as Record<string, unknown> | undefined;
  if (unified && typeof unified === "object") {
    for (const [name, raw] of Object.entries(unified)) {
      const w = windowOf(raw);
      if (w) windows[name] = w;
    }
  }
  const type = typeof info.rateLimitType === "string" ? info.rateLimitType : undefined;
  if (type && !windows[type]) {
    const w = windowOf(info);
    if (w) windows[type] = w;
  }
  const resetsAt = num(info.resetsAt);
  return { status: info.status, ...(type ? { rate_limit_type: type } : {}), ...(resetsAt !== undefined ? { resets_at: resetsAt } : {}), windows };
}

/** <state>/pipeline/claude-quota.json: the last observation per CLAUDE_CONFIG_DIR (one account each) */
export function claudeQuotaPath(): string {
  return join(laneStateDir(), "..", "pipeline", "claude-quota.json");
}

/** the file as it is; records are checked one by one when read, so one bad record does not lose the others */
function readAll(): Record<string, unknown> {
  const p = claudeQuotaPath();
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { accounts?: unknown };
    return raw.accounts && typeof raw.accounts === "object" && !Array.isArray(raw.accounts) ? (raw.accounts as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** a record of the file, or null when it is not one we can judge on (hand-edited, or written by something else) */
function observationOf(raw: unknown): ClaudeQuotaObservation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.status !== "string" || typeof r.observed_at !== "string" || Number.isNaN(Date.parse(r.observed_at))) return null;
  if (!r.windows || typeof r.windows !== "object" || Array.isArray(r.windows)) return null;
  const windows: Record<string, ClaudeQuotaWindow> = {};
  for (const [name, w] of Object.entries(r.windows as Record<string, unknown>)) {
    const u = (w as { utilization?: unknown } | null)?.utilization;
    const at = (w as { resets_at?: unknown } | null)?.resets_at;
    if (num(u) === undefined || (at !== undefined && num(at) === undefined)) return null;
    windows[name] = { utilization: u as number, ...(at !== undefined ? { resets_at: at as number } : {}) };
  }
  if (r.resets_at !== undefined && num(r.resets_at) === undefined) return null;
  return {
    status: r.status,
    ...(typeof r.rate_limit_type === "string" ? { rate_limit_type: r.rate_limit_type } : {}),
    ...(r.resets_at !== undefined ? { resets_at: r.resets_at as number } : {}),
    windows,
    observed_at: r.observed_at,
    ...(typeof r.lane === "string" ? { lane: r.lane } : {}),
    ...(typeof r.config_dir === "string" ? { config_dir: r.config_dir } : {}),
  };
}

export function readClaudeQuota(configDir: string): ClaudeQuotaObservation | null {
  return observationOf(readAll()[resolve(configDir)]);
}

/** how long a write waits for another lane's write of the file before it gives up on the shared record */
const QUOTA_LOCK_WAIT_MS = 2000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `update` holding the file's lock, so lanes ending at the same moment do not write back what each read
 * before the other wrote. Synchronous, as the lane's record is written right after; false when the lock was
 * not had in time.
 */
function underQuotaLock(p: string, update: () => void): boolean {
  const deadline = Date.now() + QUOTA_LOCK_WAIT_MS;
  for (;;) {
    let release: () => void;
    try {
      release = lockfile.lockSync(p, { realpath: false });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() > deadline) return false;
      sleepSync(20);
      continue;
    }
    try {
      update();
      return true;
    } finally {
      release();
    }
  }
}

/**
 * Keep the last observation for the account of `configDir`, unless the account already has a later one (a
 * lane that ended later but saw its windows earlier does not put back the older figures). The lane keeps its
 * own observation either way. Written through a rename, so a reader never sees half a file.
 */
export function recordClaudeQuota(configDir: string, quota: ClaudeQuota, lane?: string, now = new Date()): ClaudeQuotaObservation {
  const obs: ClaudeQuotaObservation = { ...quota, observed_at: now.toISOString(), ...(lane ? { lane } : {}) };
  const account = resolve(configDir);
  const p = claudeQuotaPath();
  mkdirSync(join(p, ".."), { recursive: true });
  const kept = underQuotaLock(p, () => {
    const all = readAll();
    const last = observationOf(all[account]);
    if (last && Date.parse(last.observed_at) > now.getTime()) return;
    all[account] = obs;
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ accounts: all }, null, 2)}\n`);
    renameSync(tmp, p);
  });
  if (!kept) console.warn(`[idd-lane] ${lane ?? account}: claude-quota.json の lock を ${QUOTA_LOCK_WAIT_MS}ms 待っても取れなかったので、この観測は lane の記録にだけ残します`);
  return obs;
}

/** UNIX seconds as a Japan time a person reads: 2026-09-24 16:00 JST */
export function formatJst(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ")} JST`;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

const SHORTEST_WINDOW = Math.min(...Object.values(CLAUDE_QUOTA_WINDOWS));

/**
 * Why a Claude Code lane should not start on this observation and from when it may, or null when it may now.
 * A window counts only until it resets. A reset nobody reported is taken as the window's own length from the
 * observation (a window resets within its length), so no observation stops lanes for good. A window with no
 * threshold is not judged, and no observation never stops a lane.
 */
export function quotaBlockOf(obs: ClaudeQuotaObservation | null, stop: Record<string, number>, now = Date.now()): { reason: string; resetsAt: number } | null {
  if (!obs) return null;
  const nowSec = now / 1000;
  const seenAt = Date.parse(obs.observed_at) / 1000;
  const seen = `（最後の観測 ${formatJst(seenAt)}${obs.lane ? `、${obs.lane}` : ""}）`;
  const resetOf = (name: string | undefined, w?: ClaudeQuotaWindow): { at: number; told: boolean } => {
    if (w?.resets_at !== undefined) return { at: w.resets_at, told: true };
    return { at: seenAt + (name && CLAUDE_QUOTA_WINDOWS[name] ? CLAUDE_QUOTA_WINDOWS[name] : SHORTEST_WINDOW), told: false };
  };
  const when = (r: { at: number; told: boolean }) => (r.told ? `リセット ${formatJst(r.at)}` : `リセットの時刻が不明なので ${formatJst(r.at)} まで待つ`);
  // a rejection is about one window; with no reset on the event, the reset of the window it names
  if (obs.status === "rejected") {
    const type = obs.rate_limit_type;
    const r = obs.resets_at !== undefined ? { at: obs.resets_at, told: true } : resetOf(type, type ? obs.windows[type] : undefined);
    if (r.at > nowSec) return { reason: `Claude の枠を使い切っている（status: rejected${type ? `、${WINDOW_LABEL[type] ?? type}` : ""}）ので lane を起動しません: ${when(r)}${seen}`, resetsAt: r.at };
  }
  const over = Object.entries(obs.windows)
    .map(([name, w]) => ({ name, w, r: resetOf(name, w) }))
    .filter(({ name, w, r }) => stop[name] !== undefined && w.utilization >= stop[name] && r.at > nowSec);
  if (!over.length) return null;
  const text = over.map(({ name, w, r }) => `${WINDOW_LABEL[name] ?? name} ${pct(w.utilization)}（閾値 ${pct(stop[name])}、${when(r)}）`);
  return { reason: `Claude の枠が止める閾値に達しているので lane を起動しません: ${text.join("、")}${seen}。閾値は roles.yaml の defaults.claude_quota_stop`, resetsAt: Math.max(...over.map((o) => o.r.at)) };
}

export function claudeQuotaBlock(obs: ClaudeQuotaObservation | null, stop: Record<string, number>, now = Date.now()): string | null {
  return quotaBlockOf(obs, stop, now)?.reason ?? null;
}

/** Throws a ClaudeQuotaBlocked when a Claude Code lane on `configDir` should not start now. */
export function checkClaudeQuota(configDir: string, stop: Record<string, number>, now = Date.now()): void {
  const block = quotaBlockOf(readClaudeQuota(configDir), stop, now);
  if (block) throw new ClaudeQuotaBlocked(block.reason, block.resetsAt);
}

/** the observations the replies of a conversation lane kept on its turn log (`turns.jsonl`), one per reply; none for a run */
function replyObservations(lane: string, dir: string): ClaudeQuotaObservation[] {
  const p = join(dir, "turns.jsonl");
  if (!existsSync(p)) return [];
  const out: ClaudeQuotaObservation[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const turn = JSON.parse(line) as { ended_at?: unknown; claude_quota?: unknown };
      const obs = turn.claude_quota && typeof turn.claude_quota === "object" ? observationOf({ ...(turn.claude_quota as object), observed_at: turn.ended_at, lane }) : null;
      if (obs) out.push(obs);
    } catch {
      // a partial line is one reply fewer
    }
  }
  return out;
}

/**
 * The windows' rise over a period, from the observations the period's runs left on their own records (and a conversation's replies on its turn log). This is the one
 * place that reads the observations and cuts them into windows (the core reads no state file and knows no window
 * length): a window is the observations that share a reset time, and it started one window length before it.
 *
 * Only the runs the period's subscription rows name are read, not every run of the state. A run keeps the one
 * observation it ended on, the account's other users (penne's own conversations) leave none here, and a window's rise
 * includes what they used, so it is a reading of the window and not a share of propter's.
 *
 * Only the runs of the lane side's config dir (`configDir`) are counted: the conversation's dir can be another
 * account's window. An observation that names no dir was kept by a run that ran in the lane's dir (nothing else wrote
 * one to a lane's record before the dir was named), so it is the lane side's too.
 */
export function readClaudeQuotaWindows(rows: readonly ConsumptionRow[], period: { since: string; until: string }, configDir: string): QuotaWindows {
  const account = resolve(configDir);
  const inPeriod = (at: string): boolean => {
    const day = jstDayOf(at);
    return Boolean(day) && day >= period.since && day <= period.until;
  };
  const runs = [...new Set(rows.filter((r) => (r.contract || r.harness) === "claude" && r.lane && inPeriod(r.at)).map((r) => r.lane as string))].sort();
  const seen: ClaudeQuotaObservation[] = [];
  const ofThisAccount = (obs: ClaudeQuotaObservation): boolean => inPeriod(obs.observed_at) && (!obs.config_dir || resolve(obs.config_dir) === account);
  for (const run of runs) {
    const dir = join(laneStateDir(), run);
    // a conversation lane's replies each kept the windows they reported (its record keeps only the last): each is a point
    const replies = replyObservations(run, dir).filter(ofThisAccount);
    seen.push(...replies);
    const p = join(dir, "lane.json");
    if (!existsSync(p)) continue;
    try {
      const obs = observationOf((JSON.parse(readFileSync(p, "utf8")) as { claude_quota?: unknown }).claude_quota);
      // the record's observation is the last reply's when a reply kept the same windows: one measurement, not two
      if (obs && ofThisAccount(obs) && !replies.some((r) => JSON.stringify(r.windows) === JSON.stringify(obs.windows))) seen.push(obs);
    } catch {
      // a record that does not read is one observation fewer, not a reason to lose the others
    }
  }
  const windows = Object.entries(CLAUDE_QUOTA_WINDOWS).map(([name, length]): QuotaWindowReading => {
    const held = seen.flatMap((obs) => (obs.windows[name] ? [{ at: obs.observed_at, ...obs.windows[name] }] : []));
    const placed = held.filter((w): w is { at: string; utilization: number; resets_at: number } => w.resets_at !== undefined);
    const byReset = new Map<number, typeof placed>();
    for (const w of placed) byReset.set(w.resets_at, [...(byReset.get(w.resets_at) ?? []), w]);
    let peak: QuotaWindowPeak | undefined;
    for (const [reset, list] of byReset) {
      const ordered = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const candidate: QuotaWindowPeak = {
        start: new Date((reset - length) * 1000).toISOString(),
        end: new Date(reset * 1000).toISOString(),
        first_at: first.at,
        last_at: last.at,
        from: first.utilization,
        to: last.utilization,
        rise: last.utilization - first.utilization,
        observations: ordered.length,
      };
      // the window that rose the most; a tie goes to the later window, so the same records give the same one
      if (!peak || candidate.rise > peak.rise || (candidate.rise === peak.rise && candidate.end > peak.end)) peak = candidate;
    }
    return { window: name, label: WINDOW_LABEL[name] ?? name, observations: held.length, unplaced: held.length - placed.length, ...(peak ? { peak } : {}) };
  });
  return { windows };
}
