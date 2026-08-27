// intent: DEC-701 — 記号の採番は engine が lane ごとに帯で割り当てる。並列 planner に最大値を数えさせない

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { readAreas } from "../config/areas.ts";
import { lanesRoot } from "../worktree/ensure.ts";

const ID_RE = /\b(DEC|INV|AC)-(\d+)\b/g;

function scanDir(dir: string, out: Map<string, number>, depth = 0): void {
  if (depth > 6 || !existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === ".next") continue;
    const path = join(dir, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.isDirectory()) {
      scanDir(path, out, depth + 1);
    } else if (name.endsWith(".md")) {
      const src = readFileSync(path, "utf8");
      for (const m of src.matchAll(ID_RE)) {
        const kind = m[1];
        const n = Number(m[2]);
        if (n > (out.get(kind) ?? 0)) out.set(kind, n);
      }
    }
  }
}

// intent: DEC-701 — 未 commit の lane worktree も走査する。そこの採番も衝突の対象
export function highestIds(area: string): { DEC: number; INV: number; AC: number } {
  const cfg = readAreas().areas[area];
  const max = new Map<string, number>();
  if (cfg?.local_path) {
    scanDir(join(cfg.local_path, "_docs"), max);
  }
  const root = lanesRoot(area);
  if (root && existsSync(root)) {
    for (const lane of readdirSync(root)) {
      scanDir(join(root, lane, "_docs"), max);
    }
  }
  return { DEC: max.get("DEC") ?? 0, INV: max.get("INV") ?? 0, AC: max.get("AC") ?? 0 };
}

export const BLOCK = 20;

// intent: DEC-701 — 帯の幅を空けて、同時に走る lane 同士が重ならないようにする
export function allocateBlock(area: string, taken: number[] = []): { dec: number; inv: number } {
  const high = highestIds(area);
  const ceiling = Math.max(high.DEC, ...taken, 0);
  const start = Math.floor(ceiling / BLOCK) * BLOCK + BLOCK + 1;
  return { dec: start, inv: Math.max(high.INV, 0) + 1 };
}

export function gitTracked(repo: string, pattern: string): string[] {
  try {
    return execFileSync("git", ["ls-files", pattern], { cwd: repo, encoding: "utf8" })
      .split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
