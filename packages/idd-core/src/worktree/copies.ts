import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Detached copies cut for one check and removed right after it (the submission snapshot). Their names start with the pid of the process that cut them, so the copies a
 * process left when it died mid-check can be told apart and swept.
 */

/**
 * A fresh name under `parent` for a copy. The name carries the pid whose life the copy belongs to: the process that
 * runs the check, which is not always the process that cuts the copy (a landing's check runs in a detached run,
 * DEC-2325 の後継). A copy named after the run is kept while that run lives and swept once it is gone.
 */
export function copyName(parent: string, pid: number = process.pid): string {
  return join(parent, `${pid}-${randomBytes(8).toString("hex")}`);
}

/** a copy's name: the process that cut it, then a random part */
const COPY_NAME = /^(\d+)-[0-9a-f]+$/;
/** a copy whose name does not say its process is taken as left behind after this long */
const STALE_COPY_MS = 24 * 60 * 60 * 1000;

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** git for the repo a copy was cut from (its .git file names it), else `fallback`'s */
function copyGit(copy: string, fallback: string): string[] {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(copy, ".git"), "utf8"))?.[1]?.trim();
    if (gitdir) return ["--git-dir", resolve(copy, gitdir, "..", "..")];
  } catch {
    // no .git file: the copy never got that far
  }
  return ["-C", fallback];
}

/**
 * Remove a copy and its registration, even when the check locked it or the directory is half made. It never
 * throws: a copy it cannot remove is left for the next sweep, and the record goes on.
 */
export function dropCopy(copy: string, fallback: string): void {
  const via = copyGit(copy, fallback);
  const run = (args: string[]) => execFileSync("git", [...via, ...args], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  try {
    // twice: a copy the check locked is removed too
    run(["worktree", "remove", "--force", "--force", copy]);
  } catch {
    try {
      rmSync(copy, { recursive: true, force: true });
    } catch {
      // left for the next sweep
    }
    try {
      run(["worktree", "unlock", copy]);
    } catch {
      // not locked, or already gone
    }
    try {
      run(["worktree", "prune"]);
    } catch {
      // a stale entry is pruned by git later
    }
  }
}

/**
 * The copies under `parent` a process left when it died mid-check (the tick's process stopped with the UI,
 * or was killed): those of a process that is gone, and any not named after its process once a day old.
 */
export function sweepCopies(parent: string, fallback: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(parent, name);
    const pid = COPY_NAME.exec(name)?.[1];
    let stale = false;
    if (pid) stale = Number(pid) !== process.pid && !alive(Number(pid));
    else {
      try {
        stale = now - statSync(path).mtimeMs > STALE_COPY_MS;
      } catch {
        stale = false;
      }
    }
    if (stale) dropCopy(path, fallback);
  }
}
