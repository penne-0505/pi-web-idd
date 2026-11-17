
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, isAbsolute, resolve } from "node:path";

import { getAgentRunner } from "../agent/port.ts";
import { stopLaneWork } from "../agent/stop.ts";
import { laneLocations, custodyPath, readProposal } from "../overlay/export.ts";
import type { Custody } from "../overlay/export.ts";
import { readManifest, splitByManifest } from "../overlay/manifest.ts";
import { attempt, clean, filteredTree, git, isLockRefusal, lock, names, read, recordPath, sha } from "../overlay/git.ts";
import { lanesRoot } from "../worktree/ensure.ts";
import { importedCurrent } from "../overlay/import.ts";
import { reclaimLane } from "../overlay/reclaim.ts";
import { readAreas } from "../config/areas.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { awaitingMerge, finalEndEvents, laneEnds, retireKept, retirePick } from "./ledger-reads.ts";
import { acceptHold, answerMark } from "./merge-hold.ts";
import { laneCriteria } from "../ledger/criteria.ts";
import { appendLifecycle, transition } from "../ledger/write.ts";
import type { BacklogRecord } from "../schema/records.ts";

function tryRun(cmd: string, args: string[], cwd?: string, timeout = 30000): string | null {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

export function lanesAwaitingMerge(): { rec: BacklogRecord; prNumber: number; prUrl: string }[] {
  const events = readLifecycle();
  const out: { rec: BacklogRecord; prNumber: number; prUrl: string }[] = [];
  for (const rec of readBacklog()) {
    // the lane waits on its PR, or its PR was found merged at the submit card (a fix only in the records);
    // the fold answers whether it does, from the lane's rows alone
    const waiting = awaitingMerge(events.filter((e) => e.idd_id === rec.idd_id));
    if (!waiting.waiting || waiting.prNumber === undefined) continue;
    out.push({ rec, prNumber: waiting.prNumber, prUrl: waiting.prUrl ?? "" });
  }
  return out;
}

export interface CloseResult {
  iddId: string;
  /** closed: a lane that had already ended, whose worktree the pass tried to retire */
  outcome: "merged" | "open" | "unknown" | "closed";
  prUrl?: string;
  worktreeRemoved?: boolean;
  worktreeKept?: string;
  /** the lane is merged and not closed because of this, and a person can fix it (the merge acceptance raises a card for it) */
  stopped?: string;
  /** where a conflict in the records reclaim is resolved (the recovery worktree), when that is what stopped the lane */
  recovery?: string;
}

/** what a close pass may leave alone or try again */
export interface CloseOptions {
  /**
   * Leave the lanes the merge acceptance holds a card for (acceptHold): a card up for penne is not a step to try again
   * under it. Without it every merged lane is tried, as a person running `idd sync` wants.
   */
  keepHeld?: boolean;
  /** lanes held by a card that are tried anyway: the acceptance found the cause gone */
  retry?: ReadonlySet<string>;
}

function durationHours(iddId: string): number | undefined {
  const events = readLifecycle().filter((e) => e.idd_id === iddId);
  const open = events.find((e) => e.event === "lane_open")?.at;
  if (!open) return undefined;
  const hours = (Date.now() - new Date(open).getTime()) / 3_600_000;
  return Math.round(hours * 10) / 10;
}

export function laneHasUnpublished(iddId: string): boolean {
  const loc = laneLocations(iddId);
  if (!loc) return true;
  const manifest = readManifest(loc.work);
  if (manifest.issues.length) return true;
  const custody = read<Custody>(custodyPath(iddId));
  const proposal = readProposal(iddId);
  const baseline = custody?.workTree ?? (proposal?.status === "complete" && proposal.mode === "local" ? proposal.workTree : null);
  return !baseline || filteredTree(loc.work, "HEAD", manifest.paths) !== baseline;
}

export function removeLaneWorktree(iddId: string): { removed: boolean; kept?: string } {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  const session = readSessions("executor").filter((r) => r.idd_id === iddId).pop()
    ?? readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  const repo = rec ? readAreas().areas[rec.area]?.local_path : undefined;
  const path = session?.worktree_path;
  if (!repo || !path || !existsSync(path)) return { removed: false };

  const dirty = tryRun("git", ["status", "--porcelain"], path);
  if (dirty === null || dirty.trim() !== "") return { removed: false, kept: path };

  if (laneHasUnpublished(iddId)) return { removed: false, kept: path };
  if (!reclaimLane(iddId).ok) return { removed: false, kept: path };

  const done = tryRun("git", ["worktree", "remove", path], repo);
  return done === null ? { removed: false, kept: path } : { removed: true };
}

/**
 * The ends after which a lane's worktree is retired: lane_close (merged, completed locally, aborted, dropped) and the
 * stop at GO. s3_defer ("保留") is left out here: its name says the lane may be taken up again, so its worktree stays
 * (the wider list of ended lanes, which intake and the branch owner read, is LANE_ENDED_EVENTS). Taking the Issue in
 * again opens a new lane with its own worktree; when the branch name comes from the Issue it is the same name with a
 * suffix (-2, -3 ...), cut from the work branch anew, so the ended lane's branch is left as it was.
 */
export const FINAL_ENDS: readonly string[] = finalEndEvents();

/** whether a lane's lifecycle holds one of the ends after which its worktree is retired */
export function laneFinallyEnded(iddId: string, events: { idd_id: string; event: string; at?: string; attrs?: Record<string, unknown> }[]): boolean {
  return laneEnds(events.filter((e) => e.idd_id === iddId) as never).finally;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** a lane penne ended without its work: aborted, dropped, started over, or stopped at GO */
function discarded(evs: { idd_id?: string; event: string; at?: string; attrs?: Record<string, unknown> }[]): boolean {
  return laneEnds(evs as never).discarded;
}

export interface StopDiscardedResult {
  iddId: string;
  sessions: string[];
  runs: string[];
  failed: { id: string; reason: string }[];
}

/**
 * The sessions and runs of lanes penne took out (ignore, the drop at the card, a redo) are stopped here. `idd
 * ignore` and `lane redo` stop them where they stand when the screen does it, but a CLI ignore runs in a process
 * with no runtime, and a run that started just after the close would be missed: this pass catches both up. A lane
 * closed by a merge or by hand is not touched: only the lanes penne took out are left with nothing to finish.
 */
export async function stopDiscardedWork(): Promise<StopDiscardedResult[]> {
  const runner = getAgentRunner();
  if (!runner?.stopSession && !runner?.stopRun) return [];
  const events = readLifecycle();
  const results: StopDiscardedResult[] = [];
  for (const rec of readBacklog()) {
    const evs = events.filter((e) => e.idd_id === rec.idd_id);
    if (!discarded(evs)) continue;
    const r = await stopLaneWork(rec.idd_id, { via: "tick" });
    if (!r.sessions.length && !r.runs.length && !r.failed.length) continue;
    results.push({ iddId: rec.idd_id, sessions: r.sessions, runs: r.runs, failed: r.failed });
  }
  return results;
}

/** a worktree the size of a Flutter checkout takes a while to delete */
const REMOVE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * What the removal of an ended lane's worktree would lose, or null when nothing. The branch is kept, so the
 * question is what lives only in this checkout: files not committed and a HEAD off the lane's branch. A lane that
 * finished (merged, completed locally) must also have its records on the work branch and no fix left unpushed;
 * a discarded lane's records and fixes were given up with it, and its commits stay on the branch.
 */
function retireBlocker(iddId: string, path: string, branch: string, work: { local_path: string; work_base: string }, given_up: boolean): string | null {
  if (!clean(path)) return "作業ツリーに commit していない変更があります";
  if (git(path, ["branch", "--show-current"]).trim() !== branch) return `HEAD が lane の branch（${branch}）にありません`;
  if (given_up) return null;
  const lane = readManifest(path), main = readManifest(work.local_path);
  if (lane.issues.length || main.issues.length) return "overlay manifest が不正です";
  const head = sha(path), target = sha(path, `refs/heads/${work.work_base}`);
  const base = git(path, ["merge-base", head, target]).trim();

  // the records are told apart as reclaimLane does, by both manifests
  const done = read<{ laneHead: string; workHead: string }>(recordPath("reclaimed", iddId));
  const reclaimed = done?.laneHead === head && attempt(path, ["merge-base", "--is-ancestor", done.workHead, target]) !== null;
  if (!reclaimed) {
    const held = splitByManifest([...new Set([...main.paths, ...lane.paths])], names(path, base, head)).overlay;
    if (held.length && git(path, ["diff", "--name-only", target, head, "--", ...held]).trim() !== "") {
      return `作業本流へ回収していない記録があります（idd reclaim ${iddId} で回収すると、次の走査で退役します）`;
    }
  }

  // the code as laneHasUnpublished and the export measure it, by the lane's own manifest
  const custody = read<Custody>(custodyPath(iddId));
  const proposal = readProposal(iddId);
  // a lane never exported is measured against where it started: code changed since then was never pushed
  const baseline = custody?.workTree ?? (proposal?.status === "complete" && proposal.mode === "local" ? proposal.workTree : null) ?? filteredTree(path, base, lane.paths);
  if (filteredTree(path, "HEAD", lane.paths) !== baseline) return `push していない修正があります（commit は branch ${branch} に残っています）`;
  return null;
}

/** why the lane's agents may still use the checkout, or null when every session of it has stopped */
async function sessionsBusy(runner: NonNullable<ReturnType<typeof getAgentRunner>>, ids: string[], path: string): Promise<string | null> {
  for (const id of ids) {
    const st = await runner.sessionStatus!(id);
    if (st.state === "running") return "lane の session がまだ動いています";
    if (st.state !== "stopped") return `lane の session が止まったと確かめられません（${st.state}）`;
  }
  if (runner.cwdBusy?.(path)) return "この worktree で動いている session があります";
  return null;
}

/**
 * Retire the worktrees of lanes that have ended for good, when nothing would be lost; the branch stays. The
 * files git does not track because they are ignored (a copied .env, build output, _meta/scratch/) go with the
 * worktree, without a grace period: nothing made by hand is kept in a lane's worktree. A worktree kept says why
 * in the ledger, once per reason. It runs only beside the agent runtime: without it a session still working in
 * the checkout cannot be told from one that stopped.
 */
export async function retireEndedLanes(): Promise<CloseResult[]> {
  const runner = getAgentRunner();
  if (!runner?.sessionStatus) return [];
  const results: CloseResult[] = [];
  const events = readLifecycle();
  const planners = readSessions("planner");
  const executors = readSessions("executor");

  for (const rec of readBacklog()) {
    const evs = events.filter((e) => e.idd_id === rec.idd_id);
    const own = [...planners, ...executors].filter((s) => s.idd_id === rec.idd_id);
    // the same worktree removeLaneWorktree and the overlay steps use
    const session = executors.filter((r) => r.idd_id === rec.idd_id).pop() ?? planners.filter((r) => r.idd_id === rec.idd_id).pop();
    const area = readAreas().areas[rec.area];
    const path = session?.worktree_path && area?.local_path ? resolve(area.local_path, session.worktree_path) : "";
    // the fold answers whether the lane's worktree is due to be retired, from its rows and these facts
    if (!retirePick(evs, {
      hasWorktreePath: Boolean(session?.worktree_path),
      hasLocalPath: Boolean(area?.local_path),
      hasWorkBase: Boolean(area?.work_base),
      exists: Boolean(path) && existsSync(path),
    })) continue;
    // the fold's answer already required these facts: they are read once here for the rest of the pass
    const areaLocal = area!.local_path!;
    const areaBase = area!.work_base!;

    let reason: string | null = null;
    let release: (() => void) | undefined;
    try {
      const root = lanesRoot(rec.area);
      if (!root || !inside(resolve(root), path)) reason = "lane の置き場の外にある worktree です";
      if (!reason) {
        const ids = own.flatMap((s) => [s.planner_session_id, s.executor_session_id]).filter((x): x is string => Boolean(x));
        reason = await sessionsBusy(runner, ids, path);
      }
      if (!reason) {
        try { release = lock(path); } catch (e) {
          if (!isLockRefusal(e)) throw e;
          // an overlay step holds the repo: the next pass looks again
          results.push({ iddId: rec.idd_id, outcome: "closed", worktreeKept: "overlay の処理中です" });
          continue;
        }
        // another pass may have removed it while this one waited
        if (!existsSync(path)) continue;
        reason = retireBlocker(rec.idd_id, path, session!.branch, { local_path: areaLocal, work_base: areaBase }, discarded(evs));
        if (!reason && tryRun("git", ["worktree", "remove", path], areaLocal, REMOVE_TIMEOUT_MS) === null) {
          // a removal cut off part way leaves the registration behind the files it did delete
          tryRun("git", ["worktree", "prune"], areaLocal);
          if (existsSync(path)) reason = "git worktree remove が失敗しました";
        }
      }
    } catch (e) {
      reason = `退役の確認に失敗しました: ${(e as Error).message.split("\n")[0].slice(0, 160)}`;
    } finally { release?.(); }

    if (!reason) {
      await appendLifecycle("lane_worktree_retired", rec.idd_id, { path, branch: session!.branch });
      results.push({ iddId: rec.idd_id, outcome: "closed", worktreeRemoved: true });
      continue;
    }
    if (retireKept(evs, { path, reason })) {
      await appendLifecycle("lane_worktree_kept", rec.idd_id, { path, reason });
    }
    results.push({ iddId: rec.idd_id, outcome: "closed", worktreeRemoved: false, worktreeKept: reason });
  }
  return results;
}

export async function runClose(opts: CloseOptions = {}): Promise<CloseResult[]> {
  const results: CloseResult[] = [];

  for (const { rec, prNumber, prUrl } of lanesAwaitingMerge()) {
    const read = readLifecycle().filter((e) => e.idd_id === rec.idd_id);
    if (opts.keepHeld && acceptHold(read) && !opts.retry?.has(rec.idd_id)) continue;
    const mark = answerMark(read);
    const area = readAreas().areas[rec.area];
    const repo = area?.linked_repo;
    if (!repo) {
      results.push({ iddId: rec.idd_id, outcome: "unknown" });
      continue;
    }

    const json = tryRun("gh", ["pr", "view", String(prNumber), "--repo", repo, "--json", "state,mergedAt,mergedBy"]);
    if (!json) {
      results.push({ iddId: rec.idd_id, outcome: "unknown", prUrl });
      continue;
    }
    const pr = JSON.parse(json) as { state: string; mergedAt?: string; mergedBy?: { login?: string } };
    if (pr.state !== "MERGED") {
      results.push({ iddId: rec.idd_id, outcome: "open", prUrl });
      continue;
    }

    // the lane may wait for the import over several ticks; the merge itself is recorded once
    const names = readLifecycle().filter((e) => e.idd_id === rec.idd_id).map((e) => e.event);
    if (names.lastIndexOf("s4_merged") < names.lastIndexOf("s4_pr_created")) {
      await appendLifecycle("s4_merged", rec.idd_id, {
        merged_at: pr.mergedAt,
        merged_by: pr.mergedBy?.login,
      });
    }
    if (!importedCurrent(rec.area)) {
      results.push({ iddId: rec.idd_id, outcome: "merged", prUrl, worktreeKept: "公開本流を import で確認・受け入れ後に終了します" });
      continue;
    }
    if (laneHasUnpublished(rec.idd_id)) {
      const why = "lane に未提出の変更があります";
      results.push({ iddId: rec.idd_id, outcome: "merged", prUrl, worktreeKept: why, stopped: why });
      continue;
    }
    const recovery = reclaimLane(rec.idd_id);
    if (!recovery.ok) {
      // a refused lock is a wait; the rest is a stop a person has to look at
      results.push({ iddId: rec.idd_id, outcome: "merged", prUrl, worktreeKept: recovery.error, ...(recovery.error && !isLockRefusal(recovery.error) ? { stopped: `記録を作業本流へ回収できません: ${recovery.error}`, ...(recovery.recovery ? { recovery: recovery.recovery } : {}) } : {}) });
      continue;
    }
    const verified = laneCriteria(rec.idd_id).verifiedIds();
    // through the gate: a lane penne closed meanwhile is not closed twice, and a busy gate leaves it for the next tick
    const closed = await transition(rec.idd_id, "lane_close", {
      outcome: "merged",
      merged_pr_url: prUrl,
      total_duration_hours: durationHours(rec.idd_id),
      final_qa_verified: verified,
    }, {
      // penne answered the lane's card while this pass worked: the close waits for the next pass to read the answer
      require: (lane) => (answerMark(lane) === mark ? null : "penne が lane に答えたので、次の巡で読み直します"),
    });
    if (!closed.ok) {
      results.push({ iddId: rec.idd_id, outcome: "merged", prUrl, worktreeKept: closed.reason });
      continue;
    }

    const wt = removeLaneWorktree(rec.idd_id);
    results.push({
      iddId: rec.idd_id,
      outcome: "merged",
      prUrl,
      worktreeRemoved: wt.removed,
      worktreeKept: wt.kept,
    });
  }
  // lanes that ended without a merge, and merged ones whose worktree was kept at their close, in the same pass
  results.push(...await retireEndedLanes());
  return results;
}
