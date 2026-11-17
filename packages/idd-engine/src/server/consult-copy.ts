import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { stateDir } from "@idd/core";

/*
 * The working copy a consult branch runs in. A consult must see the lane's uncommitted documents, but the lane's
 * agent keeps working in the same worktree while the person talks to the consultant, so the copy may not share
 * the lane's refs, index or stash: `git worktree add` would, and a stray `git stash` in the copy would move the
 * lane's stash. An independent `git clone --shared` reads the lane's objects but keeps its own refs and index;
 * the lane's tracked changes and its untracked files are laid on top afterwards.
 *
 * The copy is written under the engine's own state, one dir per consult id, so it is never mistaken for the
 * lane's worktree and the branch sweeper can remove it with the branch. Every git call has a time limit: a
 * repository that cannot be cloned in the window fails the open instead of holding the door.
 */

/** how long one git call may take before it is killed (a test shortens it through the environment) */
export function consultGitTimeoutMs(): number {
  const raw = Number(process.env.IDD_CONSULT_GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

/** the one place consult working copies live; removed with the consult, never shared with a lane */
export function consultCopiesDir(): string {
  return join(stateDir(), "pipeline", "consult");
}

export function consultCopyPath(id: string): string {
  return join(consultCopiesDir(), id);
}

interface GitOptions {
  input?: Buffer | string;
  timeoutMs?: number;
}

/** run git and answer its stdout; a non-zero exit or the timeout rejects with git's own stderr */
function runGit(args: string[], cwd: string, opts: GitOptions = {}): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? consultGitTimeoutMs();
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    let settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; fn(); };
    const child = spawn("git", args, {
      cwd,
      // never let a read-only call refresh the lane's index: the lane's agent is working in the same worktree
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(() => rejectPromise(new Error(`git ${args[0]} が時間内に終わりませんでした`)));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      done(() => rejectPromise(error));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done(() => resolvePromise(Buffer.concat(out)));
      else done(() => rejectPromise(new Error(`git ${args[0]} が失敗しました（${code}）: ${Buffer.concat(err).toString("utf8").slice(0, 500)}`)));
    });
    child.stdin.on("error", () => { /* the child can close its stdin first */ });
    child.stdin.end(opts.input);
  });
}

export interface CreateConsultCopyInput {
  id: string;
  /** the lane's worktree; only read, never written */
  from: string;
}

/**
 * Make one consult's working copy and answer its path. The copy is a standalone clone of the lane's HEAD with
 * the lane's own refs and no remote, overlaid with the lane's tracked uncommitted changes and its untracked,
 * not-ignored files. Any failure removes the half-made dir and rethrows, so a refused open leaves nothing.
 */
export async function createConsultCopy(input: CreateConsultCopyInput): Promise<string> {
  const from = resolve(input.from);
  const copy = consultCopyPath(input.id);
  mkdirSync(consultCopiesDir(), { recursive: true });
  removeConsultCopyPath(copy);
  try {
    const head = (await runGit(["rev-parse", "HEAD"], from)).toString("utf8").trim();
    await runGit(["clone", "--shared", "--no-checkout", from, copy], consultCopiesDir());
    await runGit(["checkout", "--detach", head], copy);
    // the copy must not be able to push to the lane's repo; the objects stay readable through the alternates
    try { await runGit(["remote", "remove", "origin"], copy); } catch { /* a clone that already has none */ }
    // the lane's tracked changes (staged and not) as one patch; a binary diff is applied as it is
    const diff = await runGit(["diff", "--binary", "HEAD"], from);
    if (diff.length && diff.toString("utf8").trim()) {
      await runGit(["apply", "--binary", "--whitespace=nowarn"], copy, { input: diff });
    }
    // the lane's untracked files; an ignored one is left out, the way the lane sees its own tree
    const untracked = (await runGit(["ls-files", "--others", "--exclude-standard", "-z"], from))
      .toString("utf8").split("\0").filter(Boolean);
    for (const rel of untracked) {
      const source = resolve(from, rel);
      if (source !== from && !source.startsWith(`${from}${sep}`)) continue;
      const target = join(copy, rel);
      mkdirSync(dirname(target), { recursive: true });
      try { copyFileSync(source, target); } catch { /* a file that went away between the listing and the copy */ }
    }
    return copy;
  } catch (error) {
    removeConsultCopyPath(copy);
    throw error;
  }
}

/**
 * Remove one copy, refusing a path that is not a direct child of the consult store. The guard is what keeps a
 * bad record from deleting an unrelated dir; everything under the store is the engine's own to remove.
 */
export function removeConsultCopyPath(path: string): void {
  const store = resolve(consultCopiesDir());
  const target = resolve(path);
  if (dirname(target) !== store) return;
  rmSync(target, { recursive: true, force: true });
}

/** remove every copy no record points at; the branch sweeper calls it with the live consult ids */
export function sweepConsultCopies(keep: Set<string>): string[] {
  const store = consultCopiesDir();
  let names: string[];
  try { names = readdirSync(store); } catch { return []; }
  const removed: string[] = [];
  for (const name of names) {
    if (keep.has(name)) continue;
    const target = join(store, name);
    try {
      if (!statSync(target).isDirectory()) continue;
    } catch { continue; }
    rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
