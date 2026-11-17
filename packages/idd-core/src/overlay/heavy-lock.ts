import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import { alive } from "../worktree/copies.ts";
import { git, LOCK_CHECKING, OverlayLockRefusedError } from "./git.ts";

/**
 * The repo's lock for its heavy checks (the Flutter test: 35 minutes, out of memory and a full /tmp when two run side
 * by side), kept apart from the overlay lock. The checks the S2 loop runs before it converges hold this one alone, so
 * an executor's start, a mainline merge, a submit's preparation and an import of the repo are not held up by them. The
 * submit's checks take it inside the overlay lock, only while they run the repo's public checks.
 *
 * The order is always overlay → heavy: the submit holds the overlay lock and then takes this one, and the checks
 * before the convergence take this one and never the overlay lock. No holder of this lock waits for the overlay lock,
 * so the two never wait on each other in a ring.
 *
 * Whoever meets the lock sweeps it first, whatever the lanes' records say: a holder whose process is gone (`kill -0`)
 * left it behind, and a lock with no owner written for longer than `OWNERLESS_MS` was left by a process that died
 * between making it and naming itself.
 */

/** how long a lock with no owner written is taken as being made */
export const OWNERLESS_MS = 2 * 60_000;

export interface HeavyOwner { pid: number; run: string; at: string }

/** the repo's heavy-checks lock (one per clone's common git dir, as the overlay lock is) */
export function heavyLockPath(repo: string): string {
  return join(resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]).trim()), "idd-heavy-checks.lock");
}

/** the owner the lock names, or null when it names none (or cannot be read) */
export function heavyOwner(repo: string): HeavyOwner | null {
  try {
    const owner = JSON.parse(readFileSync(join(heavyLockPath(repo), "owner.json"), "utf8")) as Partial<HeavyOwner>;
    return typeof owner.pid === "number" ? { pid: owner.pid, run: String(owner.run ?? ""), at: String(owner.at ?? "") } : null;
  } catch { return null; }
}

function drop(path: string): void {
  try { unlinkSync(join(path, "owner.json")); } catch { /* no owner written */ }
  try { rmdirSync(path); } catch { /* another sweeper let it go */ }
}

/**
 * Let go of a lock its holder left behind: the process it names is gone, or it names none and was made more than
 * `OWNERLESS_MS` ago. A live holder's lock, and one being made, stay.
 *
 * The lock found stale is first moved aside, and only the one that was found stale (the same directory, by its inode)
 * is removed: two sweepers at once, or a sweeper and a taker that made the lock again right after another sweeper
 * removed it, never remove a lock that was just taken. A lock moved aside by mistake is put back.
 */
export function sweepHeavyLock(repo: string, opts: { now?: number; isAlive?: (pid: number) => boolean; /** a test's hook between the reading and the move */ between?: () => void } = {}): void {
  let path: string;
  try { path = heavyLockPath(repo); } catch { return; }
  let seen: { ino: number; mtimeMs: number };
  try { seen = statSync(path); } catch { return; }
  const stale = (owner: HeavyOwner | null, made: number) => (owner ? !(opts.isAlive ?? alive)(owner.pid) : (opts.now ?? Date.now()) - made > OWNERLESS_MS);
  if (!stale(heavyOwner(repo), seen.mtimeMs)) return;
  opts.between?.();
  const aside = `${path}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try { renameSync(path, aside); } catch { return; }
  let moved: { ino: number } | undefined;
  try { moved = statSync(aside); } catch { return; }
  if (moved.ino === seen.ino) { drop(aside); return; }
  // another sweeper removed the stale lock and a taker made a new one between the reading and the move: put it back
  try { renameSync(aside, path); } catch { /* a third holder came; the moved lock's holder lets it go by its own path check */ }
}

/** whether the repo's heavy checks are held now, after the sweep */
export function heavyLockHeld(repo: string): boolean {
  sweepHeavyLock(repo);
  try { statSync(heavyLockPath(repo)); return true; } catch { return false; }
}

/**
 * Take the repo's heavy-checks lock for `run` (the owner is this process), after sweeping what a dead holder left. Null
 * when a live holder has it.
 */
export function takeHeavyLock(repo: string, run: string): (() => void) | null {
  sweepHeavyLock(repo);
  const path = heavyLockPath(repo);
  try { mkdirSync(path); } catch { return null; }
  const owner: HeavyOwner = { pid: process.pid, run, at: new Date().toISOString() };
  writeFileSync(join(path, "owner.json"), JSON.stringify(owner));
  return () => {
    // only the holder's own lock is let go: a lock a sweeper gave to another meanwhile is that one's
    const now = heavyOwner(repo);
    if (now && (now.pid !== owner.pid || now.run !== owner.run)) return;
    drop(path);
  };
}

/**
 * The heavy-checks lock for a holder of the overlay lock (a submit's or an import's checks), taken without waiting: a
 * lock another holds is refused as a held overlay lock is (`検査が走っています`), so every caller already waits on it
 * the way it waits on the overlay lock. Taken after the overlay lock, never before it.
 */
export function heavyLockOrRefuse(repo: string, run: string): () => void {
  const release = takeHeavyLock(repo, run);
  if (release) return release;
  const owner = heavyOwner(repo);
  throw new OverlayLockRefusedError("checks", `${LOCK_CHECKING}（repo の重い検査: ${owner ? `run ${owner.run || "なし"}・pid ${owner.pid}` : "持ち主の書かれていない lock"}）`, "EEXIST");
}
