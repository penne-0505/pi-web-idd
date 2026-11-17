import type { CacheTtl } from "./roles.ts";

/*
 * Counting prompt-cache rewrites from a Claude Code run's stream. A run's requests come from `assistant` lines,
 * each carrying the tokens the request sent, read from the cache and wrote into it. The same message is written
 * to several lines of a stream, so a request is counted once by its message id. The reading and the counting are
 * kept apart from where the lines come from, so the same count serves a single run and the whole state.
 */

/** how long a gap between two requests makes Claude Code drop the prompt cache it wrote (the 5m hold) */
export const CACHE_GAP_MS = 5 * 60 * 1000;

/** one request of a run: the usage of one assistant message */
export interface CacheRequest {
  /** the message id, so the several lines that repeat one message are counted once */
  id: string;
  /** when the request was sent, in ms; null when the line carried no readable time */
  at: number | null;
  /** the tokens sent that were not cached */
  input: number;
  /** the tokens read from the cache */
  read: number;
  /** the tokens written into the cache */
  write: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The requests of a Claude Code stream, in the order they appear (a single run's stream is in order; a
 * conversation's replies are read turn by turn). A message written to several lines counts once, by its id.
 */
export function claudeRequests(lines: string[]): CacheRequest[] {
  const seen = new Map<string, CacheRequest>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (ev.type !== "assistant") continue;
    const m = ev.message as { id?: unknown; usage?: Record<string, unknown> } | undefined;
    const id = typeof m?.id === "string" ? m.id : "";
    if (!id || seen.has(id)) continue;
    const u = m?.usage ?? {};
    const at = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : Number.NaN;
    seen.set(id, { id, at: Number.isNaN(at) ? null : at, input: num(u.input_tokens), read: num(u.cache_read_input_tokens), write: num(u.cache_creation_input_tokens) });
  }
  return [...seen.values()];
}

/** a conversation's turn files in reply order: `turns/<n>.jsonl` by number, not by name */
export function orderedTurnFiles(names: string[]): string[] {
  return names.filter((n) => /^\d+\.jsonl$/.test(n)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

export interface CacheRunStats {
  requests: number;
  /** requests from the second on that read less than half of what the request before them had written */
  rewrites: number;
  /** what those requests had to write again: the tokens the request before them had written */
  rewriteTokens: number;
  /** requests that came more than `gapMs` after the one before them */
  overGap: number;
  /** the longest gap between two requests, in ms */
  maxGapMs: number;
  /** the earlier definition (TODO IddCore-Enhance-324 AC-006): cache_read below half of the request's context */
  contextRewrites: number;
  /** the tokens written into the cache over the run */
  writeTokens: number;
}

/**
 * One run's cache figures. A rewrite is a request from the second on whose read fell below half of what the
 * request before it wrote: the cache it was meant to read was gone. A request that merely read a large new
 * difference has a small read against a large context, and is counted by `contextRewrites` instead, which is
 * the earlier definition the two are meant to be read side by side. The first request reads nothing there is to
 * read yet, so it is no rewrite.
 */
export function cacheRunStats(requests: CacheRequest[], gapMs = CACHE_GAP_MS): CacheRunStats {
  const out: CacheRunStats = { requests: 0, rewrites: 0, rewriteTokens: 0, overGap: 0, maxGapMs: 0, contextRewrites: 0, writeTokens: 0 };
  let prev: CacheRequest | null = null;
  for (const r of requests) {
    out.requests += 1;
    out.writeTokens += r.write;
    const context = r.input + r.read + r.write;
    if (context > 0 && r.read < context / 2) out.contextRewrites += 1;
    if (prev) {
      if (r.read < prev.write / 2) {
        out.rewrites += 1;
        out.rewriteTokens += prev.write;
      }
      if (prev.at !== null && r.at !== null) {
        const gap = r.at - prev.at;
        if (gap > gapMs) out.overGap += 1;
        if (gap > out.maxGapMs) out.maxGapMs = gap;
      }
    }
    prev = r;
  }
  return out;
}

/** one run handed to the report: its role, its cache hold, and its requests */
export interface CacheRunInput {
  role: string;
  ttl: CacheTtl;
  requests: CacheRequest[];
}

export interface CacheReportRow extends CacheRunStats {
  role: string;
  ttl: CacheTtl;
  /** runs whose role and hold this row sums */
  runs: number;
}

/** the runs summed by role and cache hold, most rewrites first, then by role and hold */
export function cacheReport(runs: CacheRunInput[], gapMs = CACHE_GAP_MS): CacheReportRow[] {
  const byKey = new Map<string, CacheReportRow>();
  for (const run of runs) {
    const key = `${run.role}\t${run.ttl}`;
    const row = byKey.get(key) ?? { role: run.role, ttl: run.ttl, runs: 0, requests: 0, rewrites: 0, rewriteTokens: 0, overGap: 0, maxGapMs: 0, contextRewrites: 0, writeTokens: 0 };
    const stats = cacheRunStats(run.requests, gapMs);
    row.runs += 1;
    row.requests += stats.requests;
    row.rewrites += stats.rewrites;
    row.rewriteTokens += stats.rewriteTokens;
    row.overGap += stats.overGap;
    row.contextRewrites += stats.contextRewrites;
    row.writeTokens += stats.writeTokens;
    row.maxGapMs = Math.max(row.maxGapMs, stats.maxGapMs);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.rewrites - a.rewrites || a.role.localeCompare(b.role) || a.ttl.localeCompare(b.ttl));
}
