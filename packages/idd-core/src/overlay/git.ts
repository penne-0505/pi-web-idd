import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { stateDir } from "../paths.ts";
import { isOverlayPath } from "./manifest.ts";

export function git(cwd: string, args: string[], input?: string | Buffer, env?: Record<string, string | undefined>): string {
  return execFileSync("git", args, { cwd, input, env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] });
}
export function attempt(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}
/** a git command's stdout as the bytes it wrote, or null when it failed: a reader that must not take a blob through a string */
export function attemptBytes(cwd: string, args: string[]): Buffer | null {
  try { return execFileSync("git", args, { cwd, env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" }, maxBuffer: 64 * 1024 * 1024, timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] }); } catch { return null; }
}
export function sha(cwd: string, ref = "HEAD"): string { return git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]).trim(); }
export function clean(cwd: string): boolean { return git(cwd, ["status", "--porcelain", "--untracked-files=all"]).trim() === ""; }
/**
 * The paths that keep a checkout from being clean, in git's order. An untracked dir is one path (`.next/`) and its files are
 * not listed: `clean` counts every file, but a sentence that names the cause must not carry thousands of them. A rename is
 * named by its new path. `--untracked-files=normal` is passed on purpose: a user's `status.showUntrackedFiles` (`all`, `no`)
 * must not change whether a dir is one path.
 */
export function dirtyPaths(cwd: string): string[] {
  const fields = git(cwd, ["status", "--porcelain", "-z", "--untracked-files=normal"]).split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // a rename or a copy is followed by the path it came from, which is not another change
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") i++;
  }
  return paths;
}
export function key(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function dir(name: string): string { const p = join(stateDir(), "overlay", name); mkdirSync(p, { recursive: true }); return p; }
export function recordPath(kind: string, id: string): string { return join(dir(kind), `${key(id)}.json`); }
export function read<T>(path: string): T | null { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } }
export function save(path: string, value: unknown): void { const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(value, null, 2)); renameSync(temp, path); }
/** a lock refusal that is due to the checks running: told apart by `lockRefusal` wherever it is met */
export const LOCK_CHECKING = "検査が走っています。終わってからやり直してください";
/** a lock refusal by any other holder (or by a holder whose process is gone) */
export const LOCK_BUSY = "overlay 処理中です。中断した処理の場合は";

/**
 * The repo's overlay lock, taken without waiting. A holder that is about to run the repo's checks
 * (`options.checks`) writes that on the lock, so an operation that meets it can be told the checks are
 * running rather than prompted to look for a stopped process. The refusal is an `OverlayLockRefusedError`.
 */
export interface LockOptions { checks?: boolean }
export class OverlayLockRefusedError extends Error {
  readonly overlayLock = true;
  readonly why: "busy" | "checks";
  readonly code?: string;
  constructor(why: "busy" | "checks", message: string, code?: string) {
    super(message);
    this.name = "OverlayLockRefusedError";
    this.why = why;
    this.code = code;
  }
}

/** whether the holder of `path` is a live process that is running the checks (only they may say so) */
function holderIsChecking(path: string): boolean {
  let owner: { pid?: unknown; checks?: unknown };
  try { owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid?: unknown; checks?: unknown }; } catch { return false; }
  if (owner.checks !== true || typeof owner.pid !== "number") return false;
  try { process.kill(owner.pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function lock(cwd: string, options: LockOptions = {}): () => void {
  const common = resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim());
  const path = join(common, "idd-overlay.lock");
  // the mkdir's code goes with the error: EEXIST is another holder, anything else is not a lock at all
  try { mkdirSync(path); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // a live holder that is running the checks says so; a lock with no live holder is prompted as a stopped process
    const why = code === "EEXIST" && holderIsChecking(path) ? "checks" : "busy";
    throw new OverlayLockRefusedError(why, why === "checks" ? LOCK_CHECKING : `${LOCK_BUSY} ${path} の owner.json を確認してください`, code);
  }
  writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...(options.checks ? { checks: true } : {}) }));
  return () => { unlinkSync(join(path, "owner.json")); rmdirSync(path); };
}

/**
 * The overlay lock's refusal read back from an error or a message, or null for another failure. The one
 * place that decides what a refusal is: every caller treats both messages the same way (a wait), whatever
 * the holder wrote.
 */
export function lockRefusal(value: unknown): "busy" | "checks" | null {
  if (value instanceof OverlayLockRefusedError) return value.why;
  const message = typeof value === "string" ? value : value instanceof Error ? value.message : "";
  if (message.startsWith(LOCK_CHECKING)) return "checks";
  if (message.startsWith(LOCK_BUSY)) return "busy";
  return null;
}
export function isLockRefusal(value: unknown): boolean { return lockRefusal(value) !== null; }

/**
 * Whether the overlay's own checks hold the repo at `cwd` now: the lock is held by a live process that wrote
 * `checks: true` (the submit's and the import's hold, and the landing preparation's brief one). A landing check no
 * longer holds the lock while it runs, so the whole question (“is a check running at this repo now?”) is
 * `landChecksRunning` in `overlay/land-run.ts`, which asks this and then the run records. The sweep asks that one
 * before deleting a build output of an open lane's worktree, so a check that started after the candidate was listed
 * keeps the output. A worktree git cannot read answers false: there is no lock to be running there.
 */
export function checksRunning(cwd: string): boolean {
  try {
    const common = resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim());
    return holderIsChecking(join(common, "idd-overlay.lock"));
  } catch {
    return false;
  }
}
export function names(cwd: string, from: string, to: string): string[] { return git(cwd, ["diff", "--no-renames", "--name-only", "-z", from, to]).split("\0").filter(Boolean); }
export function tree(cwd: string, ref: string): string { return git(cwd, ["rev-parse", `${ref}^{tree}`]).trim(); }
/**
 * The tree a throwaway index makes: the index holds `ref`, `edit` changes it through `run` (a git command on that index),
 * and the tree it ends as is returned. The index is removed whether `edit` threw or not.
 */
export function treeFromIndex(cwd: string, ref: string, edit: (run: (args: string[], input?: string) => string) => void): string {
  const temp = mkdtempSync(join(dir("indexes"), "index-"));
  const env = { GIT_INDEX_FILE: join(temp, "index") };
  const run = (args: string[], input?: string): string => git(cwd, args, input, env);
  try {
    run(["read-tree", ref]);
    edit(run);
    return run(["write-tree"]).trim();
  } finally { try { unlinkSync(env.GIT_INDEX_FILE); rmdirSync(temp); } catch { /* 失敗時の index は診断用に残る */ } }
}
export function filteredTree(cwd: string, ref: string, paths: string[]): string {
  return treeFromIndex(cwd, ref, (run) => {
    const held = run(["ls-files", "-z"]).split("\0").filter(f => f && isOverlayPath(paths, f));
    if (held.length) run(["update-index", "--force-remove", "-z", "--stdin"], held.join("\0") + "\0");
  });
}
export interface Identity { name: string; email: string }
/** the author of the commits that stay on this machine (the merge scaffolding, the work branch's receive commits) */
const IDD_IDENTITY: Identity = { name: "IDD", email: "idd@localhost" };
export function commitTree(cwd: string, treeId: string, parents: string[], message: string, who: Identity = IDD_IDENTITY): string {
  return git(cwd, ["commit-tree", treeId, ...parents.flatMap(p => ["-p", p])], message, { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email }).trim();
}
/** the git identity the clone commits under (its own config, then the user's), which the published commit carries */
export function cloneIdentity(cwd: string): Identity {
  const get = (k: string) => { try { return git(cwd, ["config", "--get", k]).trim(); } catch { return ""; } };
  const name = get("user.name"), email = get("user.email");
  if (!name || !email) throw new Error(`公開用の clone（${cwd}）に git の user.name と user.email を設定してください。公開する commit の作者に使います`);
  return { name, email };
}
/** paths the tree at ref tracks that the manifest keeps private */
export function trackedOverlay(cwd: string, ref: string, paths: string[]): string[] {
  return git(cwd, ["ls-tree", "-r", "--name-only", "-z", ref]).split("\0").filter(f => f && isOverlayPath(paths, f));
}
/**
 * Refuse to go on when the public side tracks a path the manifest keeps private: the submit would delete
 * the public file, and an import would silently keep the private one over it.
 */
export function refuseOverlap(cwd: string, ref: string, paths: string[], side: string, action: string): void {
  const found = trackedOverlay(cwd, ref, paths);
  if (!found.length) return;
  const shown = found.slice(0, 10).join(", ") + (found.length > 10 ? ` ほか ${found.length - 10} 件` : "");
  throw new Error(`公開側（${side}）で追跡しているファイルが overlay.manifest の対象に当たるので、${action}を止めました: ${shown}。公開側のファイルを消したり隠したりしないよう、公開側から外すか、manifest から外してください`);
}
export function mergeTrees(cwd: string, base: string, local: string, incoming: string): { tree: string; conflict: boolean; localCommit: string; incomingCommit: string } {
  const ancestor = commitTree(cwd, base, [], "merge base");
  const left = commitTree(cwd, local, [ancestor], "local changes");
  const right = commitTree(cwd, incoming, [ancestor], "external changes");
  try { return { tree: git(cwd, ["merge-tree", "--write-tree", left, right]).split("\n")[0], conflict: false, localCommit: left, incomingCommit: right }; }
  catch (e) {
    const result = String((e as { stdout?: string }).stdout ?? "").split("\n")[0];
    if (!/^[0-9a-f]{40,64}$/.test(result)) throw e;
    return { tree: result, conflict: true, localCommit: left, incomingCommit: right };
  }
}
export function remoteTip(upstream: string, branch: string): string | null {
  git(upstream, ["check-ref-format", `refs/heads/${branch}`]);
  const result = git(upstream, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).trim();
  return result ? result.split(/\s+/)[0] : null;
}
/**
 * Fetch the public side's `branch` into the upstream clone and then into the work clone, and return its tip. The ref
 * it lands in is `refs/idd/<space>/<key>`: the submit, the import and the drafts use `public`; the checks before the S2
 * loop converges, which hold no overlay lock, fetch into a space of their own (`converge`) so their fetch never takes
 * the lock of a ref the others move
 */
export function fetchPublic(work: string, upstream: string, branch: string, space = "public"): string {
  if (!/^[a-z][a-z0-9-]*$/.test(space)) throw new Error(`公開側を取る ref の名前空間が不正です: ${space}`);
  const ref = `refs/idd/${space}/${key(branch)}`;
  git(upstream, ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:${ref}`]);
  git(work, ["fetch", "--no-tags", upstream, `+${ref}:${ref}`]);
  return sha(work, ref);
}

export function destination(upstream: string): { fingerprint: string; label: string } {
  const fetch = git(upstream, ["remote", "get-url", "--all", "origin"]).trim().split("\n");
  const push = git(upstream, ["remote", "get-url", "--push", "--all", "origin"]).trim().split("\n");
  if (fetch.length !== 1 || push.length !== 1 || fetch[0] !== push[0]) throw new Error("公開 clone の fetch 先と push 先を一つの同じ宛先に揃えてください");
  let label = push[0];
  try { const url = new URL(label); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; label = url.toString(); } catch { /* ローカルまたは SSH のパス */ }
  return { fingerprint: key({ fetch, push }), label };
}
