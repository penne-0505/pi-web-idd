import { execFile } from "node:child_process";
import { existsSync, statfsSync, statSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";

import { stateDir } from "../paths.ts";

/** the default interval between two measurements of one path (tick ごとに大きい dir を測らない) */
export const MEASURE_INTERVAL_MS = 30 * 60 * 1000;

export interface FsSpaceValue {
  mount: string;
  freeBytes: number;
  totalBytes: number;
}

/** the mount a path sits on: walk up until the device changes (a path itself when nothing is above it) */
export function mountOf(path: string): string {
  let cur = resolve(path);
  let dev: number;
  try { dev = statSync(cur).dev; } catch { return cur; }
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) return cur;
    try {
      if (statSync(parent).dev !== dev) return cur;
    } catch {
      return cur;
    }
    cur = parent;
  }
}

/** the free and total space of the filesystem a path sits on */
export function fsSpace(path: string): FsSpaceValue {
  const mount = mountOf(path);
  const st = statfsSync(mount);
  const unit = Number(st.bsize);
  return { mount, freeBytes: Number(st.bavail) * unit, totalBytes: Number(st.blocks) * unit };
}

/** `du -sb` for one path: bytes and, for a directory, nothing that follows a symlink out of it */
export function dirSize(path: string): Promise<number> {
  return new Promise((done) => {
    execFile("du", ["-sb", "--", path], { encoding: "utf8", timeout: 120_000 }, (err, stdout) => {
      if (err) { done(0); return; }
      const n = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
      done(Number.isFinite(n) ? n : 0);
    });
  });
}

/**
 * The size of the paths the sweep shows, measured at intervals. The cache is for display only: whether an item is
 * deleted is decided from the records, never from these numbers.
 */
export class SizeCache {
  private at = 0;
  private sizes = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly measure: (path: string) => Promise<number>;

  constructor(intervalMs = MEASURE_INTERVAL_MS, measure: (path: string) => Promise<number> = dirSize) {
    this.intervalMs = intervalMs;
    this.measure = measure;
  }

  /** true when the cache is older than the interval and the next reads measure again */
  stale(now = Date.now()): boolean {
    return now - this.at > this.intervalMs;
  }

  async sizeOf(path: string, now = Date.now()): Promise<number> {
    if (this.stale(now)) { this.sizes.clear(); this.at = now; }
    if (this.sizes.has(path)) return this.sizes.get(path) as number;
    const n = existsSync(path) ? await this.measure(path) : 0;
    this.sizes.set(path, n);
    return n;
  }

  /** the size the cache has, without measuring (undefined when it was never measured) */
  cached(path: string): number | undefined {
    return this.sizes.get(path);
  }

  reset(): void {
    this.at = 0;
    this.sizes.clear();
  }
}

/** the state's own filesystem, for the start hold and the card */
export function stateSpace(path: string = stateDir()): FsSpaceValue {
  try {
    return fsSpace(path);
  } catch {
    return { mount: dirname(resolve(path)), freeBytes: Number.MAX_SAFE_INTEGER, totalBytes: Number.MAX_SAFE_INTEGER };
  }
}
