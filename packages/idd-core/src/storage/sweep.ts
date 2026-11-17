import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { readStorageConfig } from "../config/areas.ts";
import { readLifecycle } from "../ledger/read.ts";
import { FINAL_ENDS } from "../plan/close.ts";
import { listReviewLanes } from "../review-lane/store.ts";
import { reviewLaneState } from "../review-lane/state.ts";
import { stateDir } from "../paths.ts";
import { archiveLane } from "./archive.ts";
import { Judge, buildOutputStillFree, isRealDir, withinReal } from "./judge.ts";
import { SizeCache, stateSpace } from "./measure.ts";
import type { Candidate, Kept } from "./types.ts";

export interface SweepOptions {
  now?: number;
  /** the tick's lock is held; a caller without it never deletes (the API reads only) */
  underLock?: boolean;
  /** the state's filesystem is below the threshold: the keep period is skipped (the guards are not) */
  lowSpace?: boolean;
  /** the most time one sweep may take; the rest waits for the next pass */
  timeLimitMs?: number;
  sizes?: SizeCache;
}

export interface Swept {
  place: string;
  path: string;
  bytes: number;
  lane?: string;
}

export interface SweepResult {
  swept: boolean;
  reason?: string;
  removed: Swept[];
  failed: { place: string; path: string; reason: string }[];
  keptReason: Kept[];
  lowSpace: boolean;
}

const DEFAULT_TIME_LIMIT_MS = 10 * 60 * 1000;

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10 * 60 * 1000, stdio: ["ignore", "pipe", "pipe"] });
}

/** remove a linked worktree; a copy git refuses is removed as a directory and its registration pruned (copies.ts' way) */
function removeCopy(candidate: Candidate): void {
  const clone = candidate.clone;
  if (clone) {
    try {
      git(clone, ["worktree", "remove", "--force", "--force", candidate.path]);
    } catch {
      rmSync(candidate.path, { recursive: true, force: true });
      try { git(clone, ["worktree", "prune"]); } catch { /* a stale entry is pruned by git later */ }
    }
  } else {
    rmSync(candidate.path, { recursive: true, force: true });
  }
  // the meta beside the copy no longer names anything
  const sidecar = join(dirname(candidate.path), `${basename(candidate.path)}.json`);
  try { if (existsSync(sidecar)) unlinkSync(sidecar); } catch { /* left for the next pass */ }
}

/** empty a directory child by child, then its evidence, then the directory itself (a symlink is only unlinked) */
function removeContentsThenEvidence(dir: string, evidencePath: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p === evidencePath) continue;
    rmSync(p, { recursive: true, force: true });
  }
  rmSync(evidencePath, { force: true });
  rmSync(dir, { recursive: true, force: true });
}

function writeEvidence(candidate: Candidate): void {
  if (candidate.evidence.kind !== "review-run") return;
  try {
    const meta = JSON.parse(readFileSync(candidate.evidence.path, "utf8")) as Record<string, unknown>;
    writeFileSync(candidate.evidence.path, `${JSON.stringify({ ...meta, cleaned: true }, null, 2)}\n`);
  } catch {
    // the record could not be marked: the copy is gone, and the next pass leaves the record as it is
  }
}

/** read a JSON file, or null when it is missing or unreadable (one bad record must not stop a pass) */
function readJsonSafe<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
}

/**
 * The guard a single item is checked against right before its deletion. Any read it cannot make is that one
 * item's failure: the caller records it and goes on, so a record that went missing or went bad between the
 * listing and here does not stop the whole pass (and the pass is still recorded).
 */
export async function stillDeletable(candidate: Candidate): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    return await stillDeletableUnsafe(candidate);
  } catch (err) {
    return { ok: false, reason: `消さない条件を確かめられません: ${String(err).slice(0, 200)}` };
  }
}

async function stillDeletableUnsafe(candidate: Candidate): Promise<{ ok: true } | { ok: false; reason: string }> {
  const path = candidate.path;
  if (!existsSync(path)) return { ok: false, reason: "すでにありません" };
  const events = readLifecycle();
  if (candidate.place === "review_run_copies") {
    const lane = candidate.evidence.kind === "review-run"
      ? JSON.parse(readFileSync(candidate.evidence.path, "utf8")) as { lane_id?: string; cleaned?: boolean }
      : null;
    if (lane?.cleaned) return { ok: false, reason: "記録が cleaned です" };
    if (lane?.lane_id) {
      const rec = readFileSync(join(stateDir(), "lanes", lane.lane_id, "lane.json"), "utf8");
      const status = (JSON.parse(rec) as { status?: string }).status;
      if (status === "running") return { ok: false, reason: "run が動き出しました" };
    }
    return { ok: true };
  }
  if (candidate.place === "review_lane_copies") {
    const rec = candidate.lane ? listReviewLanes().find((r) => r.id === candidate.lane) : undefined;
    if (!rec || reviewLaneState(rec).state !== "closed") return { ok: false, reason: "レビュー lane が開きました" };
    return { ok: true };
  }
  if (candidate.place === "run_records" || candidate.place === "stage_files" || candidate.place === "outbox") {
    const laneId = candidate.lane;
    // an ad-hoc run has no lane: it became a candidate on its own end, so the same ground (ended, not running)
    // lets it go. stage_files and outbox only ever carry a lane.
    if (!laneId) {
      if (candidate.place !== "run_records") return { ok: false, reason: "属する lane が分かりません" };
    } else if (laneId.startsWith("IDD-") && !events.some((e) => e.idd_id === laneId && FINAL_ENDS.includes(e.event))) {
      return { ok: false, reason: "lane が開きました" };
    }
    if (candidate.place === "run_records") {
      // the path may have become a symlink since the listing: emptying it would empty the link's target
      if (!isRealDir(path)) return { ok: false, reason: "symlink か dir ではありません" };
      const laneJson = join(path, "lane.json");
      if (existsSync(laneJson)) {
        const status = (JSON.parse(readFileSync(laneJson, "utf8")) as { status?: string }).status;
        if (status === "running") return { ok: false, reason: "実行が動き出しました" };
      }
    }
    // the same containment the listing applied: a record that names a body outside the place is not deletable
    if (candidate.place === "outbox" && !withinReal(path, join(stateDir(), "outbox"))) {
      return { ok: false, reason: "置き場の外です" };
    }
    return { ok: true };
  }
  if (candidate.place === "cron_runs") {
    const files = readdirSync(stateDir()).filter((f) => f.startsWith("cron-run-") && f.endsWith(".json"));
    const newest = files.sort((a, b) => {
      const t = (f: string) => { try { return statSync(join(stateDir(), f)).mtimeMs; } catch { return 0; } };
      return t(b) - t(a);
    })[0];
    if (newest && join(stateDir(), newest) === path) return { ok: false, reason: "最新の 1 個になりました" };
    // the record itself must still say the run closed: the same ground the candidate was listed on
    const rec = readJsonSafe<{ cron_run_id?: string; completed_at?: string }>(path);
    const closed = rec?.completed_at;
    if (!rec || typeof rec.cron_run_id !== "string" || !rec.cron_run_id || typeof closed !== "string" || Number.isNaN(Date.parse(closed))) {
      return { ok: false, reason: "実行の終わりが記録にありません" };
    }
    return { ok: true };
  }
  if (candidate.place === "build_outputs") {
    // the same judgement that listed it, asked again: the lane, the sessions, any check, the tracked files and
    // the symlink are all re-read, so something that changed since the listing keeps the output
    return buildOutputStillFree(candidate);
  }
  return { ok: true };
}

function remove(candidate: Candidate): void {
  switch (candidate.removal) {
    case "git-worktree":
      removeCopy(candidate);
      writeEvidence(candidate);
      break;
    case "contents-then-evidence":
      removeContentsThenEvidence(candidate.path, candidate.evidence.kind === "lane-json" ? candidate.evidence.path : join(candidate.path, "lane.json"));
      break;
    case "dir":
      rmSync(candidate.path, { recursive: true, force: true });
      break;
    case "file":
      rmSync(candidate.path, { force: true });
      break;
  }
}

/** the path -> reason of the last sweep's failures, so the same reason is not written again and again */
function lastFailedReasons(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const lines = readFileSync(join(stateDir(), "storage-sweeps.jsonl"), "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]) as { failed?: { path?: string; reason?: string }[] };
    for (const f of last.failed ?? []) if (typeof f.path === "string" && typeof f.reason === "string") out.set(f.path, f.reason);
  } catch {
    // no record yet
  }
  return out;
}

function record(result: SweepResult): void {
  if (!result.removed.length && !result.failed.length) return;
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    low_space: result.lowSpace,
    removed: result.removed.map((r) => ({ place: r.place, path: r.path, bytes: r.bytes, ...(r.lane ? { lane: r.lane } : {}) })),
    failed: result.failed,
  });
  appendFileSync(join(dir, "storage-sweeps.jsonl"), `${line}\n`, "utf8");
}

/**
 * Delete the used-up items whose place is on and whose time has come. The judgment is one function (judge); the
 * keep period is the only thing the free space moves (a low disk deletes an item before its due time, and never
 * relaxes a guard). Nothing runs without the tick's lock.
 */
export async function sweepStorage(opts: SweepOptions = {}): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const sizes = opts.sizes ?? new SizeCache();
  const config = readStorageConfig();
  const lowSpace = opts.lowSpace ?? belowThreshold(now);
  const empty: SweepResult = { swept: false, removed: [], failed: [], keptReason: [], lowSpace };
  if (!config.cleanup) return { ...empty, reason: "片づけは OFF です" };
  if (!opts.underLock) return { ...empty, reason: "tick の lock を持っていません" };

  const verdicts = await new Judge({ now, sizes, measure: false }).judge();
  const settings = config.places;
  const due = verdicts.candidates.filter((c) => {
    const key = placeKey(c.place);
    if (!key || !settings[key].cleanup) return false;
    return lowSpace || Date.parse(c.dueAt) <= now;
  });
  // candidates that are used up but not due are shown as kept, with the reason the sweep left them
  const keptReason = verdicts.candidates
    .filter((c) => !due.includes(c))
    .map((c) => ({ place: c.place, path: c.path, ...(c.lane ? { lane: c.lane } : {}), reason: "まだ残す期間の中です" }));

  const result: SweepResult = { ...empty, swept: true, keptReason };
  const limit = opts.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
  const startedAt = Date.now();

  const archiveDir = config.archiveDir;
  const archiveKeys = new Map<string, Candidate[]>();
  const keyOf = (c: Candidate): string => c.lane ?? `run-${basename(c.path)}`;
  if (archiveDir) {
    for (const c of verdicts.candidates) {
      if (c.place !== "run_records" && c.place !== "stage_files") continue;
      const k = keyOf(c);
      archiveKeys.set(k, [...(archiveKeys.get(k) ?? []), c]);
    }
  }
  const archived = new Map<string, { ok: boolean; reason?: string }>();
  const lastFailed = lastFailedReasons();

  for (const candidate of due) {
    if (Date.now() - startedAt > limit) { result.reason = "時間の上限で次の回に回します"; break; }
    if (archiveDir && (candidate.place === "run_records" || candidate.place === "stage_files")) {
      const k = keyOf(candidate);
      let a = archived.get(k);
      if (!a) {
        const members = (archiveKeys.get(k) ?? [candidate]).map((c) => ({ abs: c.path, rel: relative(stateDir(), c.path) }));
        const r = await archiveLane({ archiveDir, stateRoot: stateDir(), lane: k, members });
        a = r.ok ? { ok: true } : { ok: false, reason: r.reason };
        archived.set(k, a);
      }
      if (!a.ok) {
        // the same reason is not written again and again (lane_worktree_kept's handling)
        if (lastFailed.get(candidate.path) !== a.reason) result.failed.push({ place: candidate.place, path: candidate.path, reason: a.reason as string });
        continue;
      }
    }
    // the guard is asked inside its own try: a single bad record is that one item's failure, and the pass goes on
    let guard: { ok: true } | { ok: false; reason: string };
    try {
      guard = await stillDeletable(candidate);
    } catch (err) {
      result.failed.push({ place: candidate.place, path: candidate.path, reason: `消さない条件を確かめられません: ${String(err).slice(0, 200)}` });
      continue;
    }
    if (!guard.ok) { result.failed.push({ place: candidate.place, path: candidate.path, reason: guard.reason }); continue; }
    try {
      // the size is read just before the delete: the record shows what was really removed, not a display cache
      const bytes = await sizes.sizeOf(candidate.path, now);
      remove(candidate);
      result.removed.push({ place: candidate.place, path: candidate.path, bytes, ...(candidate.lane ? { lane: candidate.lane } : {}) });
    } catch (err) {
      result.failed.push({ place: candidate.place, path: candidate.path, reason: String(err).slice(0, 300) });
    }
  }
  record(result);
  return result;
}

/** the settings key a place belongs to; the review run and the review lane copies share one */
export function placeKey(place: Candidate["place"]): "review_copies" | "run_records" | "stage_files" | "outbox" | "cron_runs" | "build_outputs" | null {
  switch (place) {
    case "review_run_copies":
    case "review_lane_copies":
      return "review_copies";
    case "run_records": return "run_records";
    case "stage_files": return "stage_files";
    case "outbox": return "outbox";
    case "cron_runs": return "cron_runs";
    case "build_outputs": return "build_outputs";
    default: return null;
  }
}

/** whether the state's filesystem is below the configured threshold */
export function belowThreshold(now = Date.now()): boolean {
  const config = readStorageConfig();
  const space = stateSpace();
  void now;
  return space.freeBytes < config.minFreeGb * 1024 ** 3;
}
