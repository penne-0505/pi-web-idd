import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { systemctlBinary } from "@idd/core";
import { repoRoot } from "@idd/lane";
import type { EngineStaleView, OpenConversationView, WaitingRequestView } from "../../../../lib/idd-ui/types.ts";
import { engineStaleView, readStaleness, setOpenConversations, setReloadHold, setReloadWaitSince, setWaitingRequests, type StaleRead } from "./staleness.ts";
import { closeAllConversations, openConversationSummaries, type OpenConversationSummary } from "./conversations.ts";

/**
 * Replacing the running engine with the code the checkout now holds.
 *
 * The engine is a systemd user unit; the process cannot replace itself, so it asks systemd for a restart and then
 * keeps serving until the restart lands. The rules that keep that safe:
 *
 * - only a process the unit started asks: its main process, or that process's direct child (a launcher can stay as
 *   the main process and run the engine as its child). A hand-started engine, or an engine a lane's agent started
 *   deep under this one, that asked would stop and never come back (or would stop the resident unit instead);
 * - only when no conversation is open and no request is being answered (the restart kills the whole cgroup). A
 *   request whose peer has already left still holds the restart while its handler runs, because that handler can be
 *   the landing or the approval; once the handler returns, a request nobody is reading no longer holds it back;
 * - only when the head's code has been shown to start (a code that cannot start would leave the engine down);
 * - while the restart is on its way, requests are refused with a mark the CLI retries on, rather than accepted and
 *   cut halfway.
 *
 * Everything the judgment reads (git, systemd, the child check, the clock) is replaceable, so a test never asks the
 * real systemd or builds the real bundle.
 */

/** how a systemd or build command is run; a test stands in for the real shell */
export type CommandRunner = (cmd: string, args: string[], timeoutMs?: number) => { status: number | null; stdout?: string; stderr?: string; error?: Error };

const defaultRunner: CommandRunner = (cmd, args, timeoutMs = 10_000) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) };
};

let runner: CommandRunner = defaultRunner;

/** put a stand-in in for systemd and the build command (a test) */
export function setReloadRunner(next: CommandRunner): void {
  runner = next;
}

/** the parent pid the judgment compares against the unit's main process; a test puts a fixed value in */
let parentPid: () => number = () => process.ppid;

/** put a stand-in in for the parent pid (a test) */
export function setParentPid(next: () => number): void {
  parentPid = next;
}

/** the env the judgment reads; a test sets these rather than touching the machine */
function autoReloadOff(): boolean {
  return process.env.IDD_RELOAD?.trim().toLowerCase() === "off";
}

export function engineUnit(): string {
  return process.env.IDD_ENGINE_UNIT?.trim() || "idd-engine.service";
}

/** how long the engine waits with no request after the count reaches 0 before it checks */
export function reloadQuietMs(): number {
  const raw = Number(process.env.IDD_RELOAD_QUIET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_000;
}

/** how often the judgment runs while nothing triggers it */
export function reloadIntervalMs(): number {
  const raw = Number(process.env.IDD_RELOAD_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/** how long the child that shows the head's code can start is given */
export function startupCheckTimeoutMs(): number {
  const raw = Number(process.env.IDD_RELOAD_CHECK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * How long the engine keeps refusing requests after asking for the restart. systemd stops this process within
 * seconds; if it is still alive after this, the restart did not come, and refusing every request any longer would
 * leave the engine unusable. The window is dropped and the failure is shown instead.
 */
export function reloadWindowMs(): number {
  const raw = Number(process.env.IDD_RELOAD_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** how long after a restart that never came before the engine tries to ask again (a window would refuse again) */
export function reloadRetryMs(): number {
  const raw = Number(process.env.IDD_RELOAD_RETRY_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60_000;
}

// ---- the in-flight requests and the reloading window ----

/**
 * One request the count holds. A handler returning a `Response` has not sent it yet, so the record stays until the
 * answer is really out: its body was read to the end, the peer left, or there was no body to send. `method` and
 * `path` are the destination a replacement names while it waits; a count started without a request (a test) carries
 * neither. The query is never kept.
 */
export interface RequestRecord {
  method: string | null;
  path: string | null;
  startedAt: number;
  /** the handler has returned; its answer is on its way */
  handlerDone: boolean;
  /** the peer's signal, so a peer that leaves before reading can be heard after the handler returns */
  signal: AbortSignal | null;
  /** true once the count was handed back; the record left the list at the same moment */
  released: boolean;
}

let requests: RequestRecord[] = [];
let reloading = false;
let quietTimer: ReturnType<typeof setTimeout> | null = null;
let waitSince: number | null = null;
let lastFailure: string | null = null;
/** until this moment, a restart was already asked for and did not come: do not ask again, and say so */
let retryNotBefore: number | null = null;
/** the head whose restart could not be asked for: the intake and the planners hold again once the head moves past it */
let askFailedHead: string | null = null;
/** the timer that drops the "reloading" window if the process is still alive when it should have been replaced */
let reloadWindowTimer: ReturnType<typeof setTimeout> | null = null;

export function requestCount(): number {
  return requests.length;
}

export function isReloading(): boolean {
  return reloading;
}

/** hold the "reloading" window open (a test) or drop it */
export function setReloading(on: boolean): void {
  reloading = on;
  if (!on && reloadWindowTimer) {
    clearTimeout(reloadWindowTimer);
    reloadWindowTimer = null;
  }
}

/** the answer a request gets while the restart is on its way: a 503 the CLI recognizes and retries */
export function reloadRefusal(): Response {
  return Response.json(
    { ok: false, error: "engine を入れ替えています。少し待って、もう一度送ってください。", reloading: true },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

/** start (or restart) the window that drops "reloading" when the restart does not land */
function armReloadWindow(now: number): void {
  if (reloadWindowTimer) clearTimeout(reloadWindowTimer);
  reloadWindowTimer = setTimeout(() => {
    reloadWindowTimer = null;
    abandonReload(Date.now());
  }, Math.max(1, reloadWindowMs()));
  reloadWindowTimer.unref?.();
  // the retry's own clock is measured from the ask, not from the process's start
  retryNotBefore = now + reloadWindowMs() + reloadRetryMs();
}

/**
 * The restart was asked for but this process is still here after the window: the replacement did not come. Stop
 * refusing requests (or the engine would refuse every one forever) and show why, then try again after a while.
 */
function abandonReload(now: number): void {
  reloading = false;
  lastFailure = "再起動を頼みましたが、入れ替えが来ませんでした";
  retryNotBefore = now + reloadRetryMs();
  setReloadHold(reloadRetryHold(now));
}

/** the reason shown while a restart is not asked again after one that never landed */
function reloadRetryHold(now: number): string {
  const left = retryNotBefore === null ? 0 : Math.max(0, retryNotBefore - now);
  const minutes = Math.ceil(left / 60_000);
  return `${lastFailure ?? "再起動が来ませんでした"}（${minutes} 分後に試し直します）`;
}

/**
 * Start answering a request and return the count record for it; null means the restart is on its way and the caller
 * must refuse instead. A request that begins cancels the quiet timer: the count went back up, so the moment to check
 * is not now.
 */
export function beginTrackedRequest(req: Request): RequestRecord | null {
  const record: RequestRecord = {
    method: req.method,
    // the pathname alone: a query can carry a value that must not reach the state or the card
    path: new URL(req.url).pathname,
    startedAt: Date.now(),
    handlerDone: false,
    signal: req.signal,
    released: false,
  };
  return startRecord(record) ? record : null;
}

/**
 * Start answering a request. False means the restart is on its way and the caller must refuse instead. The no-arg
 * form (a test) starts a count whose destination is unknown.
 */
export function beginRequest(req?: Request): boolean {
  if (req) return beginTrackedRequest(req) !== null;
  return startRecord({ method: null, path: null, startedAt: Date.now(), handlerDone: false, signal: null, released: false });
}

/** put one request's record into the count, unless the restart is on its way and the caller must refuse instead */
function startRecord(record: RequestRecord): boolean {
  if (reloading) return false;
  if (quietTimer) {
    clearTimeout(quietTimer);
    quietTimer = null;
  }
  requests.push(record);
  return true;
}

/** hand one count back; the record leaves the list, and reaching 0 starts the quiet timer */
function finishRequest(record: RequestRecord): void {
  if (record.released) return;
  record.released = true;
  const at = requests.indexOf(record);
  if (at >= 0) requests.splice(at, 1);
  if (requests.length === 0) scheduleQuietCheck();
}

/**
 * One request is fully answered: its body was read to the end, its peer left, or its answer carries no body. The
 * no-arg form (a test) settles the newest count started without a request, else the newest record left.
 */
export function endRequest(): void {
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    if (requests[i].method === null) return finishRequest(requests[i]);
  }
  if (requests.length > 0) finishRequest(requests[requests.length - 1]);
}

/** the oldest request still being answered, or null when none */
function oldestRequest(): RequestRecord | null {
  let oldest: RequestRecord | null = null;
  for (const record of requests) if (!oldest || record.startedAt < oldest.startedAt) oldest = record;
  return oldest;
}

/** the requests as the state door's card lists them; a count without a destination (a test) is left out */
function waitingRequestViews(): WaitingRequestView[] {
  return requests.flatMap((record) =>
    record.method !== null && record.path !== null
      ? [{ method: record.method, path: record.path, startedAt: new Date(record.startedAt).toISOString(), sending: record.handlerDone }]
      : [],
  );
}

/** why a replacement is waiting on requests, with the oldest destination and how long it has been held */
function requestHoldReason(now: number): string {
  const oldest = oldestRequest();
  if (!oldest || oldest.method === null || oldest.path === null) return `処理中の要求 ${requests.length} 件を待っています`;
  const minutes = Math.max(0, Math.floor((now - oldest.startedAt) / 60_000));
  return `処理中の要求 ${requests.length} 件を待っています（最も古いもの: ${oldest.method} ${oldest.path}、${minutes} 分）`;
}

/**
 * Count a response down when its answer is really out. A handler returning a Response has not sent it yet: a request
 * counted until then would race a restart that cuts the socket mid-body, and the sender would see a failure it
 * cannot tell from a delivered request. Bun reads the body of an answer nobody is reading only once and never calls
 * cancel, so two cases would otherwise hold the count forever: a peer that left before the answer (its signal is
 * aborted), and a HEAD answer (no body is sent at all). Both are let go once the handler has returned; HEAD is told
 * apart by the method, because its signal is never aborted. A body that never comes (a 204) is counted down at once.
 */
export function trackResponse(res: Response, record: RequestRecord): Response {
  record.handlerDone = true;
  const finish = (): void => {
    if (record.signal) record.signal.removeEventListener("abort", finish);
    finishRequest(record);
  };
  // no body is sent for a HEAD: the answer is out the moment the handler returns
  if (record.method === "HEAD") {
    finish();
    return res;
  }
  const body = res.body;
  // an event stream stays open for as long as the conversation does: counting it would hold the restart back forever.
  // The conversations' own count is what keeps a reload off while one is open, so this stream is not counted.
  const isEventStream = res.headers.get("content-type")?.includes("text/event-stream") ?? false;
  if (!body || isEventStream) {
    finish();
    return res;
  }
  // the peer may already be gone; if it leaves later, the abort is the one sign that it never read the answer
  if (record.signal?.aborted) {
    finish();
    return res;
  }
  record.signal?.addEventListener("abort", finish, { once: true });
  const reader = body.getReader();
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      void reader.cancel(reason).catch(() => { /* the sender is gone; nothing left to cancel */ });
    },
  });
  return new Response(wrapped, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// ---- the judgment ----

export interface ReloadOutcome {
  action: "reload" | "hold" | "fresh" | "off";
  reason?: string;
}

/** a stand-in for the "does the head's code start" question (a test) */
export type StartupCheck = (head: string) => { ok: boolean; detail?: string };

export function bunBinary(): string {
  return process.env.IDD_BUN_BIN?.trim() || "bun";
}

/**
 * Whether the checkout's code can start at all: bundle the engine's entry with bun, which resolves the whole import
 * graph and parses every module. It runs in a child with a time limit and leaves nothing resident. This is not a
 * promise that the code runs well, only that it starts rather than crashing the unit into a restart loop.
 */
const defaultStartupCheck: StartupCheck = () => {
  const root = repoRoot();
  const entry = join(root, "packages", "idd-engine", "src", "main.ts");
  const dir = mkdtempSync(join(tmpdir(), "idd-engine-check-"));
  try {
    const r = runner(bunBinary(), ["build", "--target=bun", entry, "--outfile", join(dir, "engine.js")], startupCheckTimeoutMs());
    if (r.error) return { ok: false, detail: String(r.error).slice(0, 200) };
    if (r.status !== 0) return { ok: false, detail: (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 200) };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err).slice(0, 200) };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover temp dir never fails the check */ }
  }
};

let startupCheck: StartupCheck = defaultStartupCheck;
let checkedHead: string | null = null;
let checkedResult: { ok: boolean; detail?: string } | null = null;

/** put a stand-in in for the startup check (a test) */
export function setStartupCheck(next: StartupCheck): void {
  startupCheck = next;
}

/** the check already made for this head, or a fresh one; a head is never checked twice */
function ensureStartupCheck(head: string): { ok: boolean; detail?: string } {
  if (checkedHead === head && checkedResult) return checkedResult;
  const result = startupCheck(head);
  checkedHead = head;
  checkedResult = result;
  return result;
}

/** how the judgment lists the conversations it waits on; a test puts its own in */
let conversations: () => OpenConversationSummary[] = openConversationSummaries;

export function setConversationProvider(next: () => OpenConversationSummary[]): void {
  conversations = next;
}

/** what the close-and-reload door closes; a test puts its own in */
let closeConversations: () => Promise<string[]> = closeAllConversations;

export function setCloseConversations(next: () => Promise<string[]>): void {
  closeConversations = next;
}

const toView = (c: OpenConversationSummary): OpenConversationView => ({
  sessionId: c.sessionId,
  title: c.title,
  ...(c.mode ? { mode: c.mode } : {}),
});

/** the unit's main process id, or null when systemd cannot be asked */
function mainProcessId(): number | null {
  let r: ReturnType<CommandRunner>;
  try {
    r = runner(systemctlBinary(), ["--user", "show", "-p", "MainPID", "--value", engineUnit()]);
  } catch {
    return null;
  }
  if (r.status !== 0 || r.error) return null;
  const pid = Number((r.stdout ?? "").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Whether this process is one the unit started: the unit's main process itself, or that process's direct child.
 * A version manager's shim stays as the main process and runs the real runtime as its child, so the child must be
 * accepted; a lane's agent runs deeper under the engine and must not be. The main process is read from systemd, the
 * parent from the process itself; neither is guessed.
 */
export interface UnitEngineStanding {
  enginePid: number;
  parentPid: number | null;
  mainPid: number | null;
  accepted: boolean;
}

export function unitEngineStanding(): UnitEngineStanding {
  const mainPid = mainProcessId();
  const rawParent = parentPid();
  const parent = Number.isInteger(rawParent) && rawParent > 0 ? rawParent : null;
  const accepted = mainPid !== null && (mainPid === process.pid || (parent !== null && mainPid === parent));
  return { enginePid: process.pid, parentPid: parent, mainPid, accepted };
}

function setWait(now: number): void {
  if (waitSince === null) waitSince = now;
  setReloadWaitSince(waitSince);
}

function clearWait(): void {
  waitSince = null;
  setReloadWaitSince(null);
}

const hold = (reason: string): ReloadOutcome => {
  setReloadHold(reason);
  return { action: "hold", reason };
};

/**
 * Run the judgment once: is the engine behind its checkout, and may it be replaced right now? The order is the
 * order of the things that can stop it, cheapest and safest first. Nothing here throws: a systemd that cannot be
 * asked, or a check that fails, comes back as a hold and the engine keeps serving.
 */
export async function evaluate(now = Date.now()): Promise<ReloadOutcome> {
  // publish the conversations so the state door's card can list them (whether or not the engine is replaceable)
  setOpenConversations(() => conversations().map(toView));
  // the published requests are rebuilt on every judgment: only a request hold below fills them
  setWaitingRequests([]);

  if (autoReloadOff()) {
    clearWait();
    return hold("自動の入れ替えは切られています（IDD_RELOAD=off）");
  }
  // a restart is already on its way: asking again would only reset the window that drops it if it never lands
  if (reloading) return { action: "hold", reason: "入れ替えを待っています" };
  const view: EngineStaleView = engineStaleView();
  if (view.unknown) {
    clearWait();
    return hold("起動時の commit を読めないため入れ替えません");
  }
  if (!view.stale) {
    clearWait();
    retryNotBefore = null;
    setReloadHold(null);
    return { action: "fresh" };
  }
  // a restart was asked for but never landed: keep serving, and only ask again once the retry's clock has passed
  if (retryNotBefore !== null) {
    if (now < retryNotBefore) return hold(reloadRetryHold(now));
    retryNotBefore = null;
    lastFailure = null;
  }
  const standing = unitEngineStanding();
  if (standing.mainPid === null) {
    clearWait();
    return hold("unit の主 process かを確かめられないため入れ替えません");
  }
  if (!standing.accepted) {
    clearWait();
    const parent = standing.parentPid === null ? "読めません" : String(standing.parentPid);
    return hold(`この process は unit の主 process でも、その直の子でもありません（pid ${standing.enginePid}、親 ${parent}、MainPID ${standing.mainPid}）`);
  }
  const head = view.head ?? view.startCommit ?? "";
  const check = ensureStartupCheck(head);
  if (!check.ok) {
    clearWait();
    return hold(`起動の確かめに失敗したため入れ替えません${check.detail ? `（${check.detail}）` : ""}`);
  }
  const open = conversations();
  if (open.length > 0) {
    setWait(now);
    return hold(`開いている会話 ${open.length} 本を待っています`);
  }
  clearWait();
  if (requestCount() > 0) {
    setWaitingRequests(waitingRequestViews());
    return hold(requestHoldReason(now));
  }

  let r: ReturnType<CommandRunner>;
  try {
    r = runner(systemctlBinary(), ["--user", "restart", "--no-block", engineUnit()]);
  } catch (err) {
    lastFailure = String(err).slice(0, 200);
    askFailedHead = head;
    setReloadHold(`再起動を頼めませんでした（${lastFailure}）`);
    return { action: "hold", reason: `再起動を頼めませんでした（${lastFailure}）` };
  }
  if (r.status === 0 && !r.error) {
    reloading = true;
    askFailedHead = null;
    armReloadWindow(now);
    clearWait();
    setReloadHold(null);
    return { action: "reload" };
  }
  lastFailure = (r.error ? String(r.error) : `exit ${r.status}${r.stderr ? `: ${r.stderr.trim()}` : ""}`).slice(0, 200);
  askFailedHead = head;
  setReloadHold(`再起動を頼めませんでした（${lastFailure}）`);
  return { action: "hold", reason: `再起動を頼めませんでした（${lastFailure}）` };
}

/** the last reason a restart could not be asked for (empty when none) */
export function reloadFailure(): string | null {
  return lastFailure;
}

/** the reason a held pass shows while the replacement is on its way */
export const INTAKE_HOLD_REASON = "engine を入れ替えるので、取り込みと計画役の起動を入れ替えの後に回します";

export interface IntakeHold {
  hold: boolean;
  reason?: string;
}

/**
 * Whether the core stages must hold: the checkout's head now holds an engine-effective change and a restart is
 * really on its way. The head is read now, not from the watch's last read, so a landing made since the last judgment
 * (even by the pass asking) counts. A case where the restart will not come reads as no hold: the engine goes on with
 * the code it has rather than stopping the intake and the planners for a replacement that never arrives.
 */
export function intakeHold(now = Date.now()): IntakeHold {
  if (autoReloadOff()) return { hold: false };
  const read = readStaleness({ now });
  if (!read || !read.readable || !read.startCommit || !read.engine) return { hold: false };
  return reloadComing(now, read) ? { hold: true, reason: INTAKE_HOLD_REASON } : { hold: false };
}

/** whether a restart is really on its way for the stale read's head */
function reloadComing(now: number, read: StaleRead): boolean {
  // already asked: the window is open until this process is replaced
  if (reloading) return true;
  // the head's restart was asked for and could not be: it holds again once the head moves past it
  const head = read.head ?? read.startCommit ?? "";
  if (askFailedHead !== null && askFailedHead === head) return false;
  // asked for and never landed: the retry's clock has to pass before it is asked again, so nothing is on its way
  if (retryNotBefore !== null && now < retryNotBefore) return false;
  // only a process the unit started can be replaced; anything else has no replacement to wait for
  const standing = unitEngineStanding();
  if (standing.mainPid === null || !standing.accepted) return false;
  // the head's code has to be shown to start; a head not checked yet counts as coming (the judgment checks it soon)
  if (checkedHead === head && checkedResult && !checkedResult.ok) return false;
  return true;
}

/** schedule a judgment for the quiet moment (no request in flight) */
export function scheduleQuietCheck(): void {
  if (requestCount() > 0 || quietTimer) return;
  quietTimer = setTimeout(() => {
    quietTimer = null;
    void evaluate().catch(() => { /* the next tick tries again */ });
  }, reloadQuietMs());
  quietTimer.unref?.();
}

/** run the check now, awaiting it (a test, and the close-and-reload door) */
export async function checkNow(now = Date.now()): Promise<ReloadOutcome> {
  return evaluate(now);
}

/** ask for a check once the answer to the current request is on its way */
export function requestReloadCheck(): void {
  scheduleQuietCheck();
}

/**
 * The close-and-reload door's work: close the open conversations with the usual close, then let the judgment ask for
 * the restart. Through the server this request is still in flight here, so the judgment waits for the answer to be
 * sent; called directly (a test) nothing is in flight and the check runs now.
 */
export async function closeAndReload(now = Date.now()): Promise<{ closed: string[] }> {
  const closed = await closeConversations();
  if (requestCount() === 0) await checkNow(now);
  else scheduleQuietCheck();
  return { closed };
}

/** start the interval that keeps the judgment running while nothing else triggers it */
export function startReloadWatcher(opts: { intervalMs?: number } = {}): () => void {
  const timer = setInterval(() => {
    void evaluate().catch(() => { /* one check's failure never stops the next */ });
  }, opts.intervalMs ?? reloadIntervalMs());
  timer.unref?.();
  return () => clearInterval(timer);
}

/** forget everything; a test uses it between cases */
export function resetReload(): void {
  requests = [];
  reloading = false;
  if (quietTimer) {
    clearTimeout(quietTimer);
    quietTimer = null;
  }
  if (reloadWindowTimer) {
    clearTimeout(reloadWindowTimer);
    reloadWindowTimer = null;
  }
  waitSince = null;
  lastFailure = null;
  retryNotBefore = null;
  askFailedHead = null;
  checkedHead = null;
  checkedResult = null;
  runner = defaultRunner;
  parentPid = () => process.ppid;
  startupCheck = defaultStartupCheck;
  conversations = openConversationSummaries;
  closeConversations = closeAllConversations;
}
