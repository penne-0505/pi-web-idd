import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readAreas, readStorageConfig } from "../config/areas.ts";
import { stateDir } from "../paths.ts";
import { judge } from "./judge.ts";
import { fsSpace, stateSpace, SizeCache } from "./measure.ts";
import type { Candidate, FsSpace, Judgement, Kept, PlaceUsage } from "./types.ts";

/** one measurement shared by the reads (the API and the CLI in one engine process) */
const cache = new SizeCache();

/**
 * The last judgment, kept for display only: the state's card is built synchronously and cannot run the sweep's
 * judgment (which measures sizes). Its numbers are a hint, never the ground the sweep deletes on.
 */
let lastJudgement: { at: number; value: Judgement } | null = null;
const JUDGEMENT_TTL_MS = 15 * 60 * 1000;

export function rememberJudgement(value: Judgement, now = Date.now()): void {
  lastJudgement = { at: now, value };
}

export function rememberedJudgement(now = Date.now()): Judgement | null {
  return lastJudgement && now - lastJudgement.at <= JUDGEMENT_TTL_MS ? lastJudgement.value : null;
}

export interface SweepRecordView {
  at: string;
  lowSpace: boolean;
  removed: { place: string; path: string; bytes: number; lane?: string }[];
  failed: { place: string; path: string; reason: string }[];
}

export interface StorageView {
  ok: true;
  measuredAt: string;
  cleanup: boolean;
  minFreeGb: number;
  archive: { dir: string; visible: boolean } | null;
  filesystems: (FsSpace & { label?: string })[];
  places: PlaceUsage[];
  candidates: Candidate[];
  kept: Kept[];
  lastSweep: SweepRecordView | null;
  /** lanes the start hold is keeping from cutting a worktree, from the last tick's result if one is on record */
  heldLanes: string[];
}

function lastSweep(): SweepRecordView | null {
  try {
    const lines = readFileSync(join(stateDir(), "storage-sweeps.jsonl"), "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]) as { at?: string; low_space?: boolean; removed?: unknown[]; failed?: unknown[] };
    return {
      at: String(last.at ?? ""),
      lowSpace: Boolean(last.low_space),
      removed: (last.removed ?? []) as SweepRecordView["removed"],
      failed: (last.failed ?? []) as SweepRecordView["failed"],
    };
  } catch {
    return null;
  }
}

/** the cheap, synchronous part of the view: the free space and the settings, for the state's card */
export interface StorageStatus {
  freeBytes: number;
  totalBytes: number;
  minFreeGb: number;
  minFreeBytes: number;
  belowThreshold: boolean;
  cleanup: boolean;
  archive: { dir: string; visible: boolean } | null;
  lastSweep: SweepRecordView | null;
  /** the last judgment, when one is fresh: the card's sizes are a hint, not the sweep's ground */
  judgement: Judgement | null;
}

export function storageStatus(): StorageStatus {
  const config = readStorageConfig();
  const space = stateSpace();
  const minFreeBytes = config.minFreeGb * 1024 ** 3;
  return {
    freeBytes: space.freeBytes,
    totalBytes: space.totalBytes,
    minFreeGb: config.minFreeGb,
    minFreeBytes,
    belowThreshold: space.freeBytes < minFreeBytes,
    cleanup: config.cleanup,
    archive: config.archiveDir ? { dir: config.archiveDir, visible: existsSync(config.archiveDir) } : null,
    lastSweep: lastSweep(),
    judgement: rememberedJudgement(),
  };
}

/**
 * The read-only view the API and the CLI answer: the sizes, the free space, the next candidates and what was kept.
 * It runs the judgment (the same one the sweep runs), and never deletes anything.
 */
export async function buildStorageView(opts: { now?: number } = {}): Promise<StorageView> {
  const now = opts.now ?? Date.now();
  const areas = readAreas();
  const config = areas.storage;
  const verdicts: Judgement = await judge({ now, sizes: cache, measure: true });
  rememberJudgement(verdicts, now);

  const mountPoints = new Set<string>([stateDir()]);
  for (const area of Object.values(areas.areas)) {
    if (area.lanes_root) mountPoints.add(area.lanes_root);
    if (area.local_path) mountPoints.add(area.local_path);
  }
  for (const root of Object.values(areas.reviewRoots ?? {})) mountPoints.add(root);

  const seen = new Map<string, FsSpace & { label?: string }>();
  const minFreeBytes = (config?.minFreeGb ?? 10) * 1024 ** 3;
  for (const p of mountPoints) {
    let space;
    try { space = fsSpace(existsSync(p) ? p : stateDir()); } catch { continue; }
    if (seen.has(space.mount)) continue;
    seen.set(space.mount, { ...space, belowThreshold: space.freeBytes < minFreeBytes, label: space.mount === fsSpace(stateDir()).mount ? "state" : undefined });
  }

  return {
    ok: true,
    measuredAt: new Date(now).toISOString(),
    cleanup: config?.cleanup ?? false,
    minFreeGb: config?.minFreeGb ?? 10,
    archive: config?.archiveDir ? { dir: config.archiveDir, visible: existsSync(config.archiveDir) } : null,
    filesystems: [...seen.values()],
    places: verdicts.places,
    candidates: verdicts.candidates,
    kept: verdicts.kept,
    lastSweep: lastSweep(),
    heldLanes: [],
  };
}
