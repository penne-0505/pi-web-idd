import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { convergeChecksOn, readAreas } from "../config/areas.ts";
import type { AreaCheck } from "../config/areas.ts";
import { blockingCount, copyParent, cutCopy, describeMutation, runChecksInCopy } from "./gate.ts";
import type { GateCheck } from "./gate.ts";
import { incrementRun, type SharedCheck } from "./increment.ts";
import { STRUCTURE_ROW_PREFIX, structureRun, type StructureMeasure } from "./structure.ts";
import { appendLandRound, cpuReading, cpuSecondsBetween, readLandRun, roundWallSeconds, saveLandRun, type CpuReading, type LandCheckRun, type LandCheckSpec } from "./land-run.ts";
import { compareChecks } from "./check-reason.ts";
import { earlierFailedOf, withFailedTests } from "./failed-tests.ts";
import { landPath, readLand, type LandRecord } from "./land.ts";
import { copyName, dropCopy } from "../worktree/copies.ts";
import { clean, git, lock, lockRefusal, save, tree } from "./git.ts";
import { takeHeavyLock } from "./heavy-lock.ts";
import { DEFAULT_CHECK_MINUTES } from "./gate.ts";

/**
 * One landing check, as its own detached process (C-144-1). The tick, the card and the CLI start it and return; this
 * process cuts the copy under the repo's lock (C-144-2), runs the checks, writes the result into the land record, and
 * closes its own run record. It is the only writer of either, so no caller waits on it.
 *
 * A run that a newer one replaced writes nothing (C-144-1: the later check's record is not overwritten), and a run
 * that was stopped from outside keeps no result and no done record: it closes its record as stopped and removes its
 * copy, so a partial read is never taken as checked (C-144-5, AC-007). Its copy goes when it ends, and the reader
 * removes it when the run died without ending (C-144-7).
 */

/** how long the run waits for the repo's lock to cut its copy: the preparation may still be letting it go */
const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 200;

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** how often a run waiting for the repo's heavy checks looks again */
const HEAVY_RETRY_MS = 5_000;

/**
 * How long a landing check waits for the repo's heavy checks (the checks before an S2 loop converges, a submit's, an
 * import's, another landing's) before it ends as a run that could not run: its checks' limits and 30 minutes, as the
 * loop waits. `IDD_HEAVY_WAIT_MS` stands in for it in a test.
 */
function heavyWaitMs(spec: LandCheckSpec): number {
  const given = Number(process.env.IDD_HEAVY_WAIT_MS);
  if (Number.isFinite(given) && given >= 0 && process.env.IDD_HEAVY_WAIT_MS !== undefined && process.env.IDD_HEAVY_WAIT_MS !== "") return given;
  const timeouts = readAreas().checkPrep?.[spec.area]?.timeouts ?? {};
  return (spec.checks.reduce((sum, c) => sum + (timeouts[c.name] ?? DEFAULT_CHECK_MINUTES), 0) + 30) * 60_000;
}

/**
 * The repo's overlay lock (to cut the copy) and its heavy-checks lock (held for the run's whole life), taken in that
 * order, as every holder of both takes them: overlay → heavy. The heavy lock is asked for while the overlay lock is
 * held, never the other way round; while it is taken the overlay lock is let go and the run waits, so no other overlay
 * operation waits on this one. Null for the overlay lock not taken, a string for the heavy one not taken in time.
 */
async function locksWaiting(spec: LandCheckSpec, signal: AbortSignal): Promise<{ overlay: () => void; heavy: () => void } | null | string> {
  // only a repo that runs its checks before the S2 loop converges has a heavy check to stay apart from: in any other the
  // landing checks of one repo still run side by side up to the limit (C-144). A config that cannot be read takes the lock
  let apart = true;
  try { apart = convergeChecksOn(spec.area); } catch { apart = true; }
  if (!apart) {
    const overlay = await lockWaiting(spec.repo, Date.now() + LOCK_WAIT_MS, signal);
    return overlay ? { overlay, heavy: () => undefined } : null;
  }
  const deadline = Date.now() + heavyWaitMs(spec);
  for (;;) {
    const overlay = await lockWaiting(spec.repo, Date.now() + LOCK_WAIT_MS, signal);
    if (!overlay) return null;
    const heavy = takeHeavyLock(spec.repo, spec.runId);
    if (heavy) return { overlay, heavy };
    overlay();
    if (Date.now() >= deadline) return "repo の重い検査の lock が空かないので、取り込みの検査を回せませんでした";
    if (signal.aborted) return null;
    await sleep(Math.min(HEAVY_RETRY_MS, Math.max(50, deadline - Date.now())));
  }
}

/** the repo's lock, waited for: another overlay operation holding it briefly is a wait, not a failure */
async function lockWaiting(cwd: string, deadline: number, signal?: AbortSignal): Promise<(() => void) | null> {
  for (;;) {
    if (signal?.aborted) return null;
    try {
      return lock(cwd, { checks: true });
    } catch (e) {
      if (!lockRefusal(e) || Date.now() >= deadline) return null;
      await sleep(LOCK_RETRY_MS);
    }
  }
}

/**
 * What an externally stopped run leaves behind (C-144-5, AC-007): no checked result and no done record, its copy
 * gone, and no running mark. The record is closed as stopped so a reader sees where the run ended; a reason the
 * launcher already wrote (the run it was stopped for) is kept. The record is left alone when a newer run owns it.
 */
function leaveStopped(rec: LandCheckRun, spec: LandCheckSpec, copy?: string, cpuBefore?: CpuReading | null): number {
  if (copy) dropCopy(copy, spec.repo);
  const now = readLandRun(spec.lane);
  closeRun(rec, spec, "stopped", now?.error ? {} : { error: "検査を外から止められました" });
  recordRound(spec, rec, "stopped", [], { error: now?.error ?? "検査を外から止められました", cpuBefore });
  return 5;
}

function note(text: string): void {
  try { process.stderr.write(text.endsWith("\n") ? text : `${text}\n`); } catch { /* nothing more can be said */ }
}

/** the record of this run while it is still the lane's newest and still running, or null */
function mine(spec: LandCheckSpec): LandCheckRun | null {
  const now = readLandRun(spec.lane);
  return now && now.id === spec.runId && now.status === "running" ? now : null;
}

/** whether the record before checked the same group as this run: head, mainline tip, check config and declaration */
function sameGroup(before: LandRecord | null | undefined, spec: LandCheckSpec): before is LandRecord {
  return !!before && !!before.checkedAt && before.head === spec.head && before.mainTip === spec.mainTip
    && before.configKey === spec.configKey && (before.declaredKey ?? "") === (spec.declaredKey ?? "");
}

/**
 * Write the result of the check as the lane's land record, but only while this run is still the lane's newest: a run
 * the tick replaced (the head or the mainline moved) leaves the newer record alone (C-144-1, C-144-6). A run that
 * could not make its copy ready saves no merge commit, so the tick asks for the landing again rather than reading it
 * as checked (the same shape a blocked preparation saves).
 */
function writeResult(spec: LandCheckSpec, ran: LandRecord["checks"], reason?: string): void {
  // the names of the failed tests are read from each row once, here, so the reader compares names it is handed
  const checks = withFailedTests(ran);
  // a run that ran no check (the copy could not be made ready) has no time to show; a record that did not run checks
  // either (a refusal) is not a check to compare with, so the first check after it reads as a first
  const before = readLand(spec.lane);
  const sinceLast = !reason && before?.head === spec.head && before.checkedAt ? compareChecks(before, checks) : undefined;
  // the round before is the same group only when it checked the same head at the same mainline tip under the same
  // declaration: another set of checks or increments runs other tests, so its failures say nothing about this one
  const earlierFailed = !reason && sameGroup(before, spec) ? earlierFailedOf(before.checks) : [];
  const record: LandRecord = {
    iddId: spec.lane,
    branch: spec.branch,
    head: spec.head,
    workBase: spec.workBase,
    ...(spec.repoName ? { repo: spec.repoName } : {}),
    mainTip: spec.mainTip,
    ...(reason ? {} : { mergeCommit: spec.mergeCommit }),
    checks,
    blocking: blockingCount(checks),
    token: spec.token,
    expiresAt: spec.expiresAt,
    configKey: spec.configKey,
    ...(spec.declaredKey ? { declaredKey: spec.declaredKey } : {}),
    status: "prepared",
    ...(reason ? { reason } : {}),
    ...(spec.inherit ? { inherit: spec.inherit } : {}),
    ...(spec.close ? { close: spec.close } : {}),
    ...(spec.closeCard ? { closeCard: spec.closeCard } : {}),
    ...(reason ? {} : { checkedAt: new Date().toISOString(), ...(sinceLast ? { sinceLast } : {}) }),
    ...(earlierFailed.length ? { earlierFailed } : {}),
  };
  save(landPath(spec.lane), record);
}

/** close the run's own record with where it ended, unless a newer run owns the record now */
function closeRun(rec: LandCheckRun, spec: LandCheckSpec, status: LandCheckRun["status"], extra: Partial<LandCheckRun> = {}): void {
  const now = readLandRun(spec.lane);
  if (now && now.id !== spec.runId) return;
  saveLandRun({ ...(now ?? rec), ...extra, status, ended_at: new Date().toISOString() });
}

/**
 * Append this round to the lane's history (C-184-3): the group it checked, every check's result and time, the wall
 * time of the round, its CPU and the lines the merge changed. A stopped round carries no checks: what it was reading
 * when it was cut is not a checked merge.
 */
function recordRound(spec: LandCheckSpec, rec: LandCheckRun, status: "done" | "failed" | "stopped", checks: GateCheck[], opts: { error?: string; cpuBefore?: CpuReading | null; structure?: StructureMeasure } = {}): void {
  const endedAt = new Date().toISOString();
  const after = cpuReading();
  const cpu = cpuSecondsBetween(opts.cpuBefore ?? null, after);
  const lines = diffLines(spec);
  appendLandRound({
    id: spec.runId,
    lane: spec.lane,
    status,
    started_at: rec.started_at,
    ended_at: endedAt,
    wall_seconds: roundWallSeconds(rec.started_at, endedAt),
    ...(cpu === null || !after ? {} : { cpu_seconds: cpu, cpu_source: after.source }),
    head: spec.head,
    mainTip: spec.mainTip,
    mergeCommit: spec.mergeCommit,
    signed: rec.signed,
    repo: spec.repo,
    ...(lines === null ? {} : { diff_lines: lines }),
    ...(spec.inherit
      ? { inherit: { mainTip: spec.inherit.mainTip, ...(spec.inherit.mergeCommit ? { mergeCommit: spec.inherit.mergeCommit } : {}), checks: spec.inherit.checks.map((c) => c.name) } }
      : {}),
    checks: status === "stopped" ? [] : checks,
    blocking: status === "stopped" ? 0 : blockingCount(checks),
    ...(opts.structure && status === "done" ? { structure: opts.structure } : {}),
    ...(opts.error ? { error: opts.error.slice(0, 400) } : {}),
  });
}

/** the lines the merge changed from the mainline tip (added + deleted), or null when git cannot read them */
function diffLines(spec: LandCheckSpec): number | null {
  try {
    const out = git(spec.repo, ["diff", "--numstat", spec.mainTip, spec.mergeCommit]);
    let total = 0;
    for (const line of out.split("\n")) {
      const [added, deleted] = line.split("\t");
      if (/^\d+$/.test(added ?? "")) total += Number(added);
      if (/^\d+$/.test(deleted ?? "")) total += Number(deleted);
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * The checks of this run that an increment's run answers too (config/repos.yaml `land_from_increment`): only a check
 * the run was given and an increment it was given count, so a handover (records checks only, no increments) and a
 * declaration that names something this run does not hold leave every check running as it was.
 */
function sharedChecks(spec: LandCheckSpec): SharedCheck[] {
  const declared = readAreas().incrementShares?.[spec.area] ?? {};
  const out: SharedCheck[] = [];
  for (const check of spec.checks) {
    const increment = declared[check.name];
    if (increment && check.command?.length && spec.increments?.some((i) => i.name === increment)) out.push({ name: check.name, required: check.required, increment });
  }
  return out;
}

/**
 * The rows in the order the checks were declared: a check answered by an increment's run takes the place its own run
 * would have had, ahead of the rows no declaration names (the preparation's, the mutation check's). A check the run
 * already has a row for (skipped after a failed preparation) keeps that row.
 */
function inDeclaredOrder(declared: AreaCheck[], own: GateCheck[], shared: GateCheck[]): GateCheck[] {
  const order = new Map(declared.map((c, i) => [c.name, i]));
  const out = [...own];
  for (const row of shared) {
    if (out.some((r) => r.name === row.name)) continue;
    const at = order.get(row.name) ?? Infinity;
    const before = out.findIndex((r) => (order.get(r.name) ?? Infinity) > at);
    out.splice(before < 0 ? out.length : before, 0, row);
  }
  return out;
}

/**
 * Run one landing check to the end. `specPath` names the spec the launcher wrote.
 */
export async function runLandCheck(specPath: string): Promise<number> {
  let spec: LandCheckSpec;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8")) as LandCheckSpec;
    // the spec is read once: it is the run's own working copy (it holds the approval token and the close's text),
    // and the run record is where the CLI and the card read the run from afterwards
    try { rmSync(specPath, { force: true }); } catch { /* left for the next sweep */ }
  } catch (e) {
    note(`[land-check] 仕様を読めません: ${String((e as Error).message).slice(0, 200)}`);
    return 2;
  }
  const rec = readLandRun(spec.lane);
  if (!rec || rec.id !== spec.runId) return 3;
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  // name itself at once: a record naming no process is taken as starting only for the grace, and a check stopped
  // from outside has to be reachable by its real pid
  saveLandRun({ ...rec, pid: process.pid });
  let copy: string | undefined;
  let heavyRelease: (() => void) | undefined;
  const cpuBefore = cpuReading();
  try {
    // the copy is cut under the repo's lock, as the merge commit was: the place the checks read is made ready
    // without another overlay operation writing the repo meanwhile (C-144-2). The heavy-checks lock is taken inside it
    // and held to the run's end: two heavy checks of one repo never run side by side (the checks before an S2 loop
    // converges hold it alone)
    const locks = await locksWaiting(spec, controller.signal);
    if (!locks || typeof locks === "string") {
      if (controller.signal.aborted) return leaveStopped(rec, spec, undefined, cpuBefore);
      const error = locks ?? "検査の複製を作るための lock を取れませんでした";
      closeRun(rec, spec, "failed", { error });
      recordRound(spec, rec, "failed", [], { error, cpuBefore });
      return 4;
    }
    heavyRelease = locks.heavy;
    try {
      // the copy is named after this run's process: it is kept while the run lives and swept once it is gone (C-144-7)
      copy = cutCopy(spec.repo, spec.mergeCommit, { area: spec.area, ...(spec.deps ? { deps: spec.deps } : {}), copyPid: process.pid, name: copyName(copyParent(spec.area), process.pid) });
    } finally { locks.overlay(); }
    if (mine(spec)) saveLandRun({ ...(readLandRun(spec.lane) ?? rec), copy });
    const shared = sharedChecks(spec);
    // a batch's run is named by the batch's id, which no lane's records answer to: its records checks run once for each lane the tree holds
    const own = await runChecksInCopy(copy, spec.repo, spec.mergeCommit, spec.checks, {
      area: spec.area, from: spec.repo, changed: spec.changed, ...(spec.batch?.length ? { laneIds: spec.batch } : { laneId: spec.lane }), signal: controller.signal,
      elsewhere: shared.map((s) => s.name),
    });
    // a run that was stopped from outside keeps no result and no done record (C-144-5, AC-007): what it was
    // checking is not what the lane waits on, and a partial read must never be taken as checked
    if (controller.signal.aborted) return leaveStopped(rec, spec, copy, cpuBefore);
    // the counts the repo says a landing may not increase are measured after the checks, in the same copy: the
    // mainline side is a second copy, cut and prepared the same way, and removed here (C-184-1). The run in the
    // merge commit also answers the checks named in `shared`, so that copy is not linted a second time (C-224-1)
    const measured = spec.increments?.length
      ? await incrementRun({
        repo: spec.repo, area: spec.area, mainTip: spec.mainTip, mergedCopy: copy, increments: spec.increments,
        changed: spec.changed, ...(spec.deps ? { deps: spec.deps } : {}),
        prep: readAreas().checkPrep?.[spec.area] ?? { copy: [], setup: [], timeouts: {} },
        ...(shared.length ? { shared } : {}),
        ...(controller.signal ? { signal: controller.signal } : {}),
      })
      : { increments: [], shared: [] };
    const increments = measured.increments;
    // the structure counts are of this merge commit's tree whatever the checks took over: a handover carries the code
    // checks' results, but a count of the whole tree at another tip says nothing about this one (C-243-5)
    const structure = await structureRun({
      repo: spec.repo, area: spec.area, mainTip: spec.mainTip, mergeCommit: spec.mergeCommit,
      prep: readAreas().checkPrep?.[spec.area] ?? { copy: [], setup: [], timeouts: {} },
      ...(spec.deps ? { deps: spec.deps } : {}),
      ...(controller.signal ? { signal: controller.signal } : {}),
    });
    const checks = inDeclaredOrder(spec.checks, own, measured.shared);
    // the run that answered a check may have written into the merge copy after the mutation reading above was taken:
    // the reading is taken again, so a result made in a changed copy is not the merge commit's result
    if (measured.shared.length && !checks.some((c) => c.name === "check-mutation") && (tree(spec.repo, spec.mergeCommit) !== tree(copy, "HEAD") || !clean(copy))) {
      checks.push({ name: "check-mutation", status: "fail", severity: "blocking", detail: describeMutation(copy, spec.mergeCommit) });
    }
    if (controller.signal.aborted) return leaveStopped(rec, spec, copy, cpuBefore);
    // the checks the record's record took over from an earlier tip come first: they are part of the group's result,
    // and the record and the card read them beside the checks this run made (C-193-4, C-193-5). A name this run made
    // itself (the copy's own reading) is the fresh one: the carried row would speak of another copy
    // a structure row is never carried: it counts the whole tree, and the rows of this merge commit's tree are below
    const carried = (spec.inherit?.checks ?? []).filter((c) => !c.name.startsWith(STRUCTURE_ROW_PREFIX) && !checks.some((own) => own.name === c.name));
    const all: GateCheck[] = [...carried, ...checks, ...increments, ...structure.rows];
    // a run a newer one replaced keeps no result either (C-144-1): it ends as a round that was not a check, so the
    // lane's rounds tell what happened to every run that was started
    if (!mine(spec)) { dropCopy(copy, spec.repo); recordRound(spec, rec, "stopped", [], { error: "より新しい検査に置き換えられました", cpuBefore }); return 5; }
    writeResult(spec, all);
    closeRun(rec, spec, "done", {
      result: { blocking: blockingCount(all), checks: all.map((c) => ({ name: c.name, status: c.status })) },
      copy,
    });
    recordRound(spec, rec, "done", all, { cpuBefore, ...(structure.structure ? { structure: structure.structure } : {}) });
    dropCopy(copy, spec.repo);
    return 0;
  } catch (err) {
    const reason = `検査を回せませんでした: ${String((err as Error).message ?? err).slice(0, 300)}`;
    note(`[land-check] ${reason}`);
    // a run stopped from outside writes no failure either: an interrupted read is not a check that ran (AC-007)
    if (controller.signal.aborted) return leaveStopped(rec, spec, copy, cpuBefore);
    if (mine(spec)) {
      writeResult(spec, [], reason);
      closeRun(rec, spec, "failed", { error: reason, ...(copy ? { copy } : {}) });
      recordRound(spec, rec, "failed", [], { error: reason, cpuBefore });
    }
    if (copy) dropCopy(copy, spec.repo);
    return 1;
  } finally {
    heavyRelease?.();
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

/** the spec the launcher wrote: the first argument, or the environment a test may set */
function specFromArgv(argv: string[]): string | null {
  return argv[0]?.trim() || process.env.IDD_LAND_CHECK_SPEC?.trim() || null;
}

const specPath = specFromArgv(process.argv.slice(2));
const runDirectly = process.argv[1] && existsSync(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runDirectly && specPath) {
  runLandCheck(specPath).then((code) => { process.exitCode = code; }, (err) => {
    note(`[land-check] ${String((err as Error).message ?? err).slice(0, 300)}`);
    process.exitCode = 1;
  });
}
