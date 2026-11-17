import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { readAreas } from "../config/areas.ts";
import { commandEnv, describe, hiddenOf, hideIn, runLimited, SETUP_MINUTES } from "../overlay/gate.ts";
import { isStartHoldError } from "../storage/hold.ts";
import { ensureLaneWorktree, type LaneWorktree } from "./ensure.ts";

const MARKER = "idd-lane-prep.json";

/** what the marker of a lane's worktree holds: which setup it ran for, and whether that run went through */
interface Marker {
  /** hash of the setup commands the run was for: a declaration that changed runs again */
  setup: string;
  done: boolean;
  /** the worktree's state before the first setup that has not yet gone through; every later run is judged against this, not against what an earlier run left */
  before?: State;
}

/** the tracked and not-ignored state of a worktree: HEAD, the status, the tracked diff, and a digest of each untracked file */
interface State {
  head: string;
  ref: string;
  status: string;
  diff: string;
  files: Record<string, string>;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 60000, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** 0 when git answers yes, 1 when it answers no, and an error for anything else */
function gitYes(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 1) return false;
    throw err;
  }
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** a digest of one untracked path: a file by its content, a symlink by its target (never followed), anything else by its kind */
function digestOf(file: string): string {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) return `link:${sha(readlinkSync(file))}`;
    if (st.isFile()) return `file:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
    return "other";
  } catch {
    return "unreadable";
  }
}

function tryGit(cwd: string, args: string[]): string {
  try { return git(cwd, args).trim(); } catch { return ""; }
}

/** the tracked and not-ignored state of a worktree: a setup must leave it as it found it. Reads only. */
function stateOf(cwd: string): State {
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  let diff = "";
  try { diff = sha(git(cwd, ["diff", "HEAD", "--binary"])); } catch { /* the status alone is read */ }
  const files: Record<string, string> = {};
  for (const path of tryGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")) {
    if (path) files[path] = digestOf(join(cwd, path));
  }
  return { head: tryGit(cwd, ["rev-parse", "HEAD"]), ref: tryGit(cwd, ["symbolic-ref", "-q", "HEAD"]), status, diff, files };
}

const statusPath = (line: string) => line.slice(3);

/** what a setup moved, as lines that name a path or the HEAD and never a file's content; empty when the state is the same */
function movedBy(before: State, after: State): string[] {
  const out: string[] = [];
  if (before.head !== after.head || before.ref !== after.ref) out.push(`HEAD が動きました（${before.ref || "detached"} ${before.head.slice(0, 9)} → ${after.ref || "detached"} ${after.head.slice(0, 9)}）`);
  const was = new Set(before.status.split("\n").filter(Boolean));
  const now = new Set(after.status.split("\n").filter(Boolean));
  const paths = new Set<string>();
  for (const line of now) if (!was.has(line)) paths.add(statusPath(line));
  for (const line of was) if (!now.has(line)) paths.add(statusPath(line));
  for (const path of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    if (before.files[path] !== after.files[path]) paths.add(path);
  }
  for (const path of [...paths].slice(0, 20)) out.push(`内容が変わりました: ${path}`);
  if (!paths.size && before.diff !== after.diff) out.push(`内容が変わりました: 追跡されたファイル（status:\n${after.status.split("\n").slice(0, 20).join("\n")}）`);
  return out;
}

function readMarker(file: string): Marker | null {
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as Marker;
    return typeof m.setup === "string" && typeof m.done === "boolean" ? { ...m, before: m.before && typeof m.before === "object" ? m.before : undefined } : null;
  } catch {
    return null;
  }
}

/** the problems with the declared copy paths, each naming its path and never what the file holds */
function copyProblems(work: string, from: string, copy: string[]): string[] {
  const problems: string[] = [];
  for (const file of copy) {
    const rel = normalize(file);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel === ".git" || rel.startsWith(".git/")) {
      problems.push(`${file}: repo の中の相対パスで書いてください`);
      continue;
    }
    let source = false;
    try { source = statSync(join(from, rel)).isFile(); } catch { /* absent */ }
    if (!source) { problems.push(`${rel}: 元（${from}）にファイルがありません`); continue; }
    if (git(work, ["ls-files", "--", rel]).trim()) { problems.push(`${rel}: 追跡されているので写せません`); continue; }
    if (!gitYes(work, ["check-ignore", "-q", "--", rel])) { problems.push(`${rel}: ignore されていないので写せません（写すと lane が最初から dirty になります）`); continue; }
    // a path that is already there is kept, but only when it is a file; a broken link or a directory is not a copy of the declared file,
    // and writing through a link would put the content outside the worktree
    const dst = join(work, rel);
    let present = false;
    try { lstatSync(dst); present = true; } catch { /* absent: written later */ }
    if (!present) continue;
    let regular = false;
    try { regular = statSync(dst).isFile(); } catch { /* a link to nothing */ }
    if (!regular) problems.push(`${rel}: lane の worktree に既にありますが、通常のファイルに解決されません（壊れた symlink かディレクトリです）。消してから段を起こしてください`);
  }
  return problems;
}

export interface PrepareOptions {
  /** the limit of one setup command, in minutes (a test shortens it) */
  minutes?: number;
}

/**
 * Make a lane's worktree hold what the repo declares (`copy` and `setup` in config/repos.yaml), the way a check's copy
 * is made ready: the files from the work clone, then the setup commands. Returns why the worktree is not ready, or
 * null. Every start step runs it, so a worktree cut before the declaration, and a file that went missing, are
 * made good too; the setup runs once per worktree and declaration (the marker is in the worktree's own git dir, which
 * a lane's diff does not show). Nothing a copied file holds goes into the reason.
 */
export function prepareLaneWorktree(area: string, worktree: string, options: PrepareOptions = {}): Promise<string | null> {
  // one preparation at a time per worktree: a second request waits for the first and then reads its marker,
  // so a setup is not run twice at once in the same tree
  const key = resolve(worktree);
  const turn = (queues.get(key) ?? Promise.resolve()).then(() => prepareOnce(area, worktree, options));
  const tail = turn.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return turn;
}

/** the preparations waiting on or running in each worktree */
const queues = new Map<string, Promise<void>>();

async function prepareOnce(area: string, worktree: string, options: PrepareOptions): Promise<string | null> {
  const areas = readAreas();
  const prep = areas.checkPrep?.[area];
  const from = areas.areas[area]?.local_path;
  if (!prep || !from || (!prep.copy.length && !prep.setup.length)) return null;

  const problems = copyProblems(worktree, from, prep.copy);
  if (problems.length) return `宣言した copy を lane の worktree に満たせないので、段を始めません:\n${problems.join("\n")}`.slice(0, 1500);
  for (const file of prep.copy) {
    const rel = normalize(file);
    const dst = join(worktree, rel);
    try { lstatSync(dst); continue; } catch { /* absent: written below */ }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(from, rel), dst);
  }
  if (!prep.setup.length) return null;

  const marker = join(git(worktree, ["rev-parse", "--absolute-git-dir"]).trim(), MARKER);
  const declared = sha(JSON.stringify(prep.setup));
  const known = readMarker(marker);
  if (known?.setup === declared && known.done) return null;

  // what the work clone holds and what the lane's own copy holds: a lane's file may differ from the clone's,
  // and a setup may print either
  const hide = hiddenOf(from, prep.copy);
  const here = hiddenOf(worktree, prep.copy);
  hide.values.push(...here.values);
  for (const rel of here.opaque) if (!hide.opaque.includes(rel)) hide.opaque.push(rel);
  const fail = (detail: string) => hideIn(detail, hide.values).slice(-1500);
  const minutes = options.minutes ?? SETUP_MINUTES;
  const env = commandEnv();
  // the state before the first setup that has not gone through, kept across a failure and a changed declaration;
  // a setup that went through (done) and a declaration that changed after it start from what a lane's step left
  const before = known && !known.done && known.before ? known.before : stateOf(worktree);
  writeFileSync(marker, JSON.stringify({ setup: declared, done: false, before } satisfies Marker));
  for (const command of prep.setup) {
    const run = await runLimited(worktree, ["bash", "-c", command], minutes, env);
    if (run.code !== 0 || run.timedOut || run.overflow) return fail(`準備のコマンドが失敗しました: ${command}\n${describe(run, minutes, hide)}`);
  }
  const moved = movedBy(before, stateOf(worktree));
  if (moved.length) {
    return fail(`準備が追跡されたファイルか新しいファイルを変えたので、段を始めません（lane の差分に出ます。前の回の準備が残したものかもしれません）:\n${moved.join("\n")}`);
  }
  writeFileSync(marker, JSON.stringify({ setup: declared, done: true } satisfies Marker));
  return null;
}

/**
 * The worktree a lane's start step works in: cut or found (`ensureLaneWorktree`), then made ready from the repo's
 * declaration. A worktree that cannot be made ready stops the step with its reason; what held the cut back keeps its kind.
 */
export async function startLaneWorktree(area: string, iddId: string, options: PrepareOptions = {}): Promise<LaneWorktree | null> {
  const lane = ensureLaneWorktree(area, iddId);
  if (!lane || !existsSync(lane.path)) return lane;
  const failure = await prepareLaneWorktree(area, lane.path, options);
  if (failure) throw new Error(failure);
  return lane;
}

/**
 * The `ensure_worktree` step of the planner's and the executor's start: the worktree (`startLaneWorktree`) and the
 * answer the fold reads. A place out of space holds the lane back, which is a wait and not a failed start.
 */
export async function ensureWorktreeStep(area: string, iddId: string): Promise<{ worktree: LaneWorktree | null | undefined; answer: Record<string, unknown> }> {
  try {
    const worktree = await startLaneWorktree(area, iddId);
    return { worktree, answer: worktree ? { path: worktree.path, branch: worktree.branch } : { none: true } };
  } catch (err) {
    return { worktree: undefined, answer: isStartHoldError(err) ? { error: String(err), hold: err.hold.reason } : { error: String(err) } };
  }
}
