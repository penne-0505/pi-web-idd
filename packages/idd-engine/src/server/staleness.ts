import { spawnSync } from "node:child_process";
import { effectsOf } from "../../../../lib/idd-ui/stale-paths.ts";
import type { EngineStaleView, GuiStaleFailure, GuiStaleView, OpenConversationView, WaitingRequestView } from "../../../../lib/idd-ui/types.ts";

/**
 * Whether the code a long-lived process loaded still matches the checkout under it.
 *
 * The engine reads the checkout once, when it starts (`bin/idd-engine` execs `main.ts`). Every landing advances the
 * work side's mainline and rewrites those files, but the running process keeps its old module graph. So the engine
 * remembers the commit and the time it started, reads the checkout's head from time to time, and answers whether the
 * paths that changed between the two commits are ones it would read again. The screen reads that answer; the reload
 * module uses it to decide whether a restart is worth asking for.
 *
 * The judgment of "effective" is deliberately lopsided: only paths known not to be read again are called
 * ineffective, and everything else counts as effective. Missing an effective change leaves stale code running (the
 * bug this guards against); counting an ineffective one costs one quiet restart.
 */

/** how git is run; a test stands in for the real command with its own reader */
export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type GitRunner = (root: string, args: string[]) => GitResult;

const gitRun: GitRunner = (root, args) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

// ---- which changes count ----
// the classifier lives in `lib/idd-ui/stale-paths.ts`, shared with the build command; re-exported here so the
// engine's callers keep one import
export { pathEffect, effectsOf } from "../../../../lib/idd-ui/stale-paths.ts";

// ---- the memory the state door reads ----

export interface StaleRead {
  /** when the checkout was read (ISO) */
  at: string;
  /** false when git could not answer; the caller must treat that as "unknown" */
  readable: boolean;
  startCommit?: string;
  head?: string;
  changed: string[];
  engine: boolean;
  gui: boolean;
  /** first-parent merges taken in since the start */
  landings: number;
  /** commits that are not merges, also first-parent */
  commits: number;
}

let memory: { startedAt: string; startCommit?: string; readable: boolean } | null = null;
let lastRead: StaleRead | null = null;
let root: string | null = null;
let git: GitRunner = gitRun;
/** why a replacement is not being asked for (set by the reload module) */
let hold: string | null = null;
/** the screen's build and the commit it answers with (set by the build module) */
let guiRunningCommit: string | null | undefined;
let guiBuildCommit: string | null | undefined;
let guiBuilding = false;
let guiBuildFailed: GuiStaleFailure | null = null;
let guiStale = false;
/** the open conversations the reload waits on, for the limit card (set by the reload module) */
let openConversationProvider: () => OpenConversationView[] = () => [];

export interface StartOptions {
  root?: string;
  now?: number;
  git?: GitRunner;
}

/**
 * Remember where and when this process started; called from the engine's entry, never from a module's import. Tests
 * call it to put a fixture's commit in before asking the state door. A git that cannot answer leaves the start
 * unknown, and nothing is replaced then.
 */
export function rememberEngineStart(opts: StartOptions = {}): void {
  root = opts.root ?? root ?? process.cwd();
  git = opts.git ?? git;
  const head = git(root, ["rev-parse", "HEAD"]);
  const commit = head.ok ? head.stdout.trim() : "";
  memory = {
    startedAt: new Date(opts.now ?? Date.now()).toISOString(),
    ...(commit ? { startCommit: commit } : {}),
    readable: Boolean(commit),
  };
  lastRead = null;
}

export interface ReadOptions {
  root?: string;
  git?: GitRunner;
  now?: number;
}

/**
 * Read the checkout's head and the paths that changed since the start. Reads the diff only when the head moved, so a
 * watch that ticks on every interval costs one `git rev-parse` until a landing lands. Never throws: a git failure
 * comes back as `readable: false`.
 */
export function readStaleness(opts: ReadOptions = {}): StaleRead | null {
  if (!memory) return null;
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const readGit = opts.git ?? git;
  const useRoot = opts.root ?? root ?? process.cwd();
  const unknown = (startCommit?: string): StaleRead => {
    lastRead = { at, readable: false, changed: [], engine: false, gui: false, landings: 0, commits: 0, ...(startCommit ? { startCommit } : {}) };
    return lastRead;
  };
  if (!memory.readable || !memory.startCommit) return unknown();
  const startCommit = memory.startCommit;

  const head = readGit(useRoot, ["rev-parse", "HEAD"]);
  const current = head.ok ? head.stdout.trim() : "";
  if (!current) return unknown(startCommit);
  // the head has not moved since the last read: the answer is the one already held
  if (lastRead?.readable && lastRead.head === current) return lastRead;

  let changed: string[] = [];
  if (current !== startCommit) {
    const diff = readGit(useRoot, ["diff", "--name-only", `${startCommit}..${current}`]);
    if (!diff.ok) return unknown(startCommit);
    changed = diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  const effects = effectsOf(changed);
  const countOf = (flag: string): number => {
    const r = readGit(useRoot, ["rev-list", "--first-parent", flag, "--count", `${startCommit}..${current}`]);
    const n = r.ok ? Number(r.stdout.trim()) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  lastRead = {
    at,
    readable: true,
    startCommit,
    head: current,
    changed,
    engine: effects.engine,
    gui: effects.gui,
    landings: countOf("--merges"),
    commits: countOf("--no-merges"),
  };
  return lastRead;
}

/** the paths that changed between two commits, with the git runner the start used; never throws */
export function changedPathsBetween(from: string, to: string, opts: ReadOptions = {}): { ok: boolean; changed: string[] } {
  const readGit = opts.git ?? git;
  const useRoot = opts.root ?? root ?? process.cwd();
  try {
    const diff = readGit(useRoot, ["diff", "--name-only", `${from}..${to}`]);
    if (!diff.ok) return { ok: false, changed: [] };
    return { ok: true, changed: diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean) };
  } catch {
    return { ok: false, changed: [] };
  }
}

/**
 * Whether the screen's build (the commit it answers with) is behind the checkout. The diff is taken from that commit
 * to the head, not from the engine's start: a screen rebuilt while this engine ran is newer than the start. A commit
 * that cannot be known, or a diff git cannot read, counts as stale.
 */
export function guiStaleForCommit(runningCommit: string | null | undefined, opts: ReadOptions = {}): boolean {
  const head = lastRead?.head ?? memory?.startCommit;
  if (!head) return true;
  if (runningCommit === undefined) return true;
  if (runningCommit === null) return true;
  if (runningCommit === head) return false;
  const diff = changedPathsBetween(runningCommit, head, opts);
  if (!diff.ok) return true;
  return effectsOf(diff.changed).gui;
}

/** the answer of "may this bundle be served": ok, or the one reason it may not */
export type GuiBundleVerdict = { ok: true } | { ok: false; reason: string };

let verdictMemo: { key: string; verdict: GuiBundleVerdict } | null = null;

const shortCommit = (commit: string): string => commit.slice(0, 8);

/**
 * Whether the screen's bundle was made from the commit this engine runs. The engine's API and the screen are one
 * piece of code at one commit, so a bundle from another commit is not served. Equal commits are the plain case; a
 * different one still counts as the same code when the paths between the two are ones the side that is behind does
 * not read again: a bundle older than the engine may differ only in paths neither side reads, and a bundle newer
 * than the engine (the screen rebuilt while the engine kept running) may differ in the screen's own paths. A commit
 * that cannot be told, or that git cannot relate to the engine's, is not served. The answer is kept for the pair of
 * commits, since every request for the screen asks.
 */
export function guiBundleVerdict(bundle: string | null | undefined, opts: ReadOptions = {}): GuiBundleVerdict {
  const engine = memory?.startCommit;
  if (!engine) return { ok: false, reason: "engine が自分の commit を読めていないので、bundle が同じ commit のものか確かめられません" };
  if (!bundle) return { ok: false, reason: "bundle に build の commit がありません。作り直してください" };
  if (bundle === engine) return { ok: true };
  const key = `${bundle}..${engine}`;
  if (verdictMemo?.key === key) return verdictMemo.verdict;
  const verdict = judgeBundle(bundle, engine, opts);
  verdictMemo = { key, verdict };
  return verdict;
}

function judgeBundle(bundle: string, engine: string, opts: ReadOptions): GuiBundleVerdict {
  const readGit = opts.git ?? git;
  const useRoot = opts.root ?? root ?? process.cwd();
  const base = readGit(useRoot, ["merge-base", bundle, engine]);
  const common = base.ok ? base.stdout.trim() : "";
  const behind = `bundle は ${shortCommit(bundle)}、engine は ${shortCommit(engine)} の commit です`;
  if (!common) return { ok: false, reason: `${behind}。2 つの commit の関係を git で読めません` };
  const diff = changedPathsBetween(bundle, engine, opts);
  if (!diff.ok) return { ok: false, reason: `${behind}。間の変更を git で読めません` };
  const effects = effectsOf(diff.changed);
  if (common === bundle) {
    // the bundle is older than the engine: any path either side reads again makes it a different screen
    if (!effects.engine && !effects.gui) return { ok: true };
    return { ok: false, reason: `${behind}。間に ${effects.engine ? "engine" : "画面"} が読み直す変更があります` };
  }
  if (common === engine) {
    // the bundle is newer than the engine: the engine's own paths must be the same, the screen's may have moved
    if (!effects.engine) return { ok: true };
    return { ok: false, reason: `${behind}。engine が読み直す変更が bundle の側にあるので、engine の入れ替えを待ちます` };
  }
  return { ok: false, reason: `${behind}。どちらも他方の祖先ではありません` };
}

const watchHooks = new Set<() => void>();

/** run `fn` after each watch tick; the reload and build modules put their own checks on it */
export function onWatchTick(fn: () => void): () => void {
  watchHooks.add(fn);
  return () => { watchHooks.delete(fn); };
}

export interface WatchOptions extends ReadOptions {
  intervalMs?: number;
}

/** how often the checkout is read; the reload module's own checks ride the same tick */
export function stalenessWatchMs(): number {
  const raw = Number(process.env.IDD_STALE_WATCH_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/**
 * Start the watch. Called from the engine's entry, never from `startEngine` (a test's engine must not start a timer
 * that reads a real checkout). The timer is unref'd: it never keeps the process alive on its own.
 */
export function startCodeWatch(opts: WatchOptions = {}): () => void {
  const interval = opts.intervalMs ?? stalenessWatchMs();
  const tick = (): void => {
    try {
      readStaleness(opts);
    } catch {
      // a read failure is remembered as unknown by readStaleness; the watch never dies on it
    }
    for (const fn of watchHooks) {
      try {
        fn();
      } catch {
        // one hook's failure never stops the watch or the other hooks
      }
    }
  };
  tick();
  const timer = setInterval(tick, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** set (or clear, with null) why a replacement is not being asked for right now */
export function setReloadHold(reason: string | null): void {
  hold = reason;
}

export function reloadHold(): string | null {
  return hold;
}

/** how the state door reads the engine's own staleness: synchronous, from the memory and the last read only */
export function engineStaleView(): EngineStaleView {
  const startedAt = memory?.startedAt ?? new Date(0).toISOString();
  if (!memory) return { startedAt, stale: false };
  if (!memory.readable || !memory.startCommit) return { startedAt, stale: false, unknown: true };
  const read = lastRead;
  return {
    startedAt,
    startCommit: memory.startCommit,
    ...(read?.head ? { head: read.head } : {}),
    stale: Boolean(read?.readable && read.engine),
    landings: read?.landings ?? 0,
    commits: read?.commits ?? 0,
    ...(read && !read.readable ? { unknown: true } : {}),
    ...(hold ? { hold } : {}),
  };
}

/** forget everything; a test that ran rememberEngineStart uses it between cases */
export function resetStaleness(): void {
  memory = null;
  lastRead = null;
  hold = null;
  guiRunningCommit = undefined;
  guiBuildCommit = undefined;
  guiBuilding = false;
  guiBuildFailed = null;
  guiStale = false;
  verdictMemo = null;
  openConversationProvider = () => [];
  reloadWaitSince = null;
  waitingRequests = [];
}

// ---- the screen's side of the same question (the build module fills these) ----

/** the commit the served screen was built from; null when its bundle carries none, undefined when not read yet */
export function setGuiRunningCommit(commit: string | null): void {
  guiRunningCommit = commit;
}

export function guiRunningCommitValue(): string | null | undefined {
  return guiRunningCommit;
}

/** the commit the bundle on disk was made from (its build stamp carries it); null when it carries none */
export function setGuiBuildCommit(commit: string | null): void {
  guiBuildCommit = commit;
}

export function guiBuildCommitValue(): string | null | undefined {
  return guiBuildCommit;
}

export function setGuiBuilding(on: boolean): void {
  guiBuilding = on;
}

export function guiBuildingValue(): boolean {
  return guiBuilding;
}

export function setGuiBuildFailure(failure: GuiStaleFailure | null): void {
  guiBuildFailed = failure;
}

export function guiBuildFailureValue(): GuiStaleFailure | null {
  return guiBuildFailed;
}

// ---- the open conversations the reload waits on ----

export function setOpenConversations(fn: () => OpenConversationView[]): void {
  openConversationProvider = fn;
}

export function openConversationsView(): OpenConversationView[] {
  return openConversationProvider();
}

/** when the reload began waiting on open conversations (ms since epoch), or null while it is not waiting */
let reloadWaitSince: number | null = null;

export function setReloadWaitSince(since: number | null): void {
  reloadWaitSince = since;
}

export function reloadWaitSinceValue(): number | null {
  return reloadWaitSince;
}

// ---- the requests the reload waits on ----

/** the requests still being answered, published by the judgment for the limit card */
let waitingRequests: WaitingRequestView[] = [];

export function setWaitingRequests(list: WaitingRequestView[]): void {
  waitingRequests = list;
}

export function waitingRequestsView(): WaitingRequestView[] {
  return waitingRequests;
}

/** how long the reload waits for open conversations before the card is put up (a test shortens it) */
export function reloadWaitLimitMs(): number {
  const raw = Number(process.env.IDD_RELOAD_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000;
}

/** the screen's staleness as the build module last judged it */
export function setGuiStale(stale: boolean): void {
  guiStale = stale;
}

/** the screen's staleness: whether the bundle that is served is not the head's, or cannot be known */
export function guiStaleView(): GuiStaleView {
  return {
    stale: guiStale,
    ...(guiRunningCommit ? { runningCommit: guiRunningCommit } : {}),
    ...(guiBuildCommit ? { buildCommit: guiBuildCommit } : {}),
    ...(guiBuilding ? { building: true } : {}),
    ...(guiBuildFailed ? { failed: guiBuildFailed } : {}),
  };
}
