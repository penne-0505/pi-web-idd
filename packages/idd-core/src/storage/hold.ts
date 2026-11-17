import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { readAreas } from "../config/areas.ts";
import { stateDir } from "../paths.ts";
import { fsSpace } from "./measure.ts";

/** what the start hold found: the reason shown on the lane's row, and the numbers behind it */
export interface StartHold {
  reason: string;
  freeBytes: number;
  minFreeBytes: number;
  path: string;
}

/** the place a lane's new worktree would be cut into: the repo's lanes_root, else beside its work clone */
export function lanePlace(area: string): string | undefined {
  const cfg = readAreas().areas[area];
  if (!cfg?.local_path) return undefined;
  return cfg.lanes_root || join(dirname(cfg.local_path), `${basename(cfg.local_path)}-lanes`);
}

/**
 * Whether cutting a new worktree for this lane would run the place out of space. The check is the same for the
 * survey's start and the implementation's start, and works however the sweep is turned on: a write that fails
 * halfway leaves a half-made worktree, and the lack of space is not the lane's fault. A place that does not exist
 * yet is measured at its parent.
 */
export function laneStartHold(area: string): StartHold | null {
  const place = lanePlace(area);
  if (!place) return null;
  const cfg = readAreas();
  const minFreeBytes = (cfg.storage?.minFreeGb ?? 10) * 1024 ** 3;
  const path = existsSync(place) ? place : dirname(place);
  const existing = existsSync(path) ? path : stateDir();
  let freeBytes: number;
  try {
    freeBytes = fsSpace(existing).freeBytes;
  } catch {
    // a place whose space cannot be read is not held back: the sweep is the safe side, not this check
    return null;
  }
  if (freeBytes >= minFreeBytes) return null;
  return {
    reason: `空きが足りないので始めていません（${formatGb(freeBytes)} / しきい値 ${formatGb(minFreeBytes)}）`,
    freeBytes,
    minFreeBytes,
    path: existing,
  };
}

function formatGb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)}G`;
}

/** an error that says the lane was held back for space, not that the start failed */
export class LaneStartHeldError extends Error {
  readonly hold: StartHold;

  constructor(hold: StartHold) {
    super(hold.reason);
    this.name = "LaneStartHeldError";
    this.hold = hold;
  }
}

export function isStartHoldError(e: unknown): e is LaneStartHeldError {
  return e instanceof LaneStartHeldError;
}
