import { publishes } from "../config/areas.ts";
import { landOrder, stagePick } from "../ledger/pick.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { driveLandSteps } from "./land-step.ts";
import type { LandObserver, LandStep } from "./land-step.ts";
export { LAND_RECHECK_INTERVAL_MS, LAND_RECHECK_MAX } from "./land-step.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import { laneLocations, stackedSubmitBlocker } from "../overlay/export.ts";
import { deriveStage } from "../ledger/derive.ts";
import { landBehindAt, landCheckedAt, prepareLand, recheckApprovedLand, sendBackLandCheckFailureFrom, sendBackLandConflict, clearLandForecast, laneChangedFiles, mainlineTip, pairKey, readLandForecast, saveLandForecast, trialMerge } from "../overlay/land.ts";
import type { LandForecastGroup, LandInherit } from "../overlay/land.ts";
import { landRunChecking, readLandRun } from "../overlay/land-run.ts";
import { lockRefusal } from "../overlay/git.ts";
import { driveBatches, refreshBatchOffers } from "../overlay/batch.ts";
import type { LaneLocation } from "../overlay/export.ts";
import { headCommit } from "../worktree/ensure.ts";
import { unreviewedChange } from "./reviewed-head.ts";

export interface LandStageResult {
  /** lands checked and left for penne's approval on the card */
  prepared: string[];
  /** lanes whose landing check a run of its own is reading now (started in this pass or already going) */
  checking: string[];
  /** lanes whose merge went into the mainline on this pass (an approval the tick carried out) */
  merged: string[];
  /** lanes sent back because their head and the mainline conflict */
  sentBack: string[];
  /**
   * lanes whose check this pass took checked results over from an earlier mainline tip: the tip they were run at and
   * the checks carried. Read from the same record the card and the CLI read (C-193-5).
   */
  inherited: { iddId: string; from: string; checks: string[] }[];
  held: { iddId: string; reason: string }[];
  errors: { iddId: string; error: string }[];
}

/** the stage's reading of one handover: the same tip and check names the record carries */
function inheritedEntry(iddId: string, inherit: LandInherit): { iddId: string; from: string; checks: string[] } {
  return { iddId, from: inherit.mainTip, checks: inherit.checks.map((c) => c.name) };
}

interface ForecastLane { iddId: string; work: string; head: string }

/**
 * The card lanes of every repo that does not publish: every lane at the submit confirmation, checked, approved and
 * held ones included (they still carry a card). Grouped by the work clone their landings share.
 */
function forecastLanes(): Map<string, { repo: string; workBase: string; lanes: ForecastLane[] }> {
  const groups = new Map<string, { repo: string; workBase: string; lanes: ForecastLane[] }>();
  for (const rec of readBacklog()) {
    const evs = readLifecycle().filter((e) => e.idd_id === rec.idd_id);
    if (evs.some((e) => e.event === "lane_close" || e.event === "s3_defer")) continue;
    if (deriveStage(evs).decision !== "ship") continue;
    const loc = laneLocations(rec.idd_id);
    if (!loc || publishes(loc.config) || !loc.config.local_path || !loc.config.work_base) continue;
    const head = headCommit(loc.work);
    if (!head) continue;
    const group = groups.get(loc.config.local_path) ?? { repo: loc.config.local_path, workBase: loc.config.work_base, lanes: [] };
    group.lanes.push({ iddId: rec.idd_id, work: loc.work, head });
    groups.set(loc.config.local_path, group);
  }
  return groups;
}

function sameHeads(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/**
 * The conflict forecast of one repo as its mainline and heads are now: the saved one when neither moved, otherwise a
 * read-only trial merge per lane against the mainline tip, and one per pair whose changed files overlap. A repo with
 * one card has no forecast, and its saved one is dropped.
 */
function refreshForecast(group: { repo: string; workBase: string; lanes: ForecastLane[] }): LandForecastGroup | null {
  const mainTip = mainlineTip(group.repo, group.workBase);
  // a read git could not answer leaves no forecast at all: this tick saves none, and a saved one is dropped, so
  // no card is told "no conflict" off a result that was never taken (DEC-2401)
  if (!mainTip) { clearLandForecast(group.repo); return null; }
  const heads = Object.fromEntries(group.lanes.map((l) => [l.iddId, l.head]));
  const saved = readLandForecast(group.repo);
  if (saved && saved.mainTip === mainTip && sameHeads(saved.heads, heads)) return saved;
  if (group.lanes.length < 2) {
    clearLandForecast(group.repo);
    return null;
  }
  const drop = () => { clearLandForecast(group.repo); return null; };
  const files: Record<string, string[]> = {};
  for (const l of group.lanes) {
    const changed = laneChangedFiles(l.work, mainTip, l.head);
    if (changed === null) return drop();
    files[l.iddId] = changed;
  }
  const mainline: LandForecastGroup["mainline"] = {};
  for (const l of group.lanes) {
    const merge = trialMerge(l.work, mainTip, l.head);
    if (merge === null) return drop();
    mainline[l.iddId] = merge;
  }
  const pairs: LandForecastGroup["pairs"] = {};
  for (let i = 0; i < group.lanes.length; i += 1) {
    for (let j = i + 1; j < group.lanes.length; j += 1) {
      const a = group.lanes[i];
      const b = group.lanes[j];
      if (!files[a.iddId].some((f) => files[b.iddId].includes(f))) continue;
      const merge = trialMerge(a.work, a.head, b.head);
      if (merge === null) return drop();
      pairs[pairKey(a.iddId, b.iddId)] = merge;
    }
  }
  const forecast: LandForecastGroup = { repo: group.repo, workBase: group.workBase, mainTip, heads, files, mainline, pairs };
  saveLandForecast(forecast);
  return forecast;
}

/**
 * Take the conflict forecast of every repo that holds two or more landing cards. Read-only, and never a failure the
 * tick has to answer: a repo whose forecast cannot be taken is left with none.
 */
export function computeLandForecasts(): void {
  for (const group of forecastLanes().values()) refreshForecast(group);
}

/**
 * The tick's landing stage, after the push stage: a lane of a repo that does not publish is checked against the work
 * side's mainline and left for penne's approval on the card; a lane penne approved whose merge the tick still owes
 * (the mainline moved, the merge could not be written) is checked again at the mainline as it is now and merged, or
 * sent back when it conflicts. Nothing is pushed and no PR is made. The checks run once for a lane head and mainline
 * tip: a tick that finds the same pair already checked does not run them again.
 */
export async function runLand(): Promise<LandStageResult> {
  const result: LandStageResult = { prepared: [], checking: [], merged: [], sentBack: [], inherited: [], held: [], errors: [] };
  // the forecast is a hint outside the per-lane loop: it is read-only, and a failure to take it never fails the tick
  try {
    computeLandForecasts();
  } catch { /* 見込みは求められなくても取り込みは進む */ }
  // an approval still in force is carried out before the next lane's checks begin, and tried once per lane per
  // pass: a merge moves the mainline, and a check run before it would be for a tip the mainline no longer has
  // (DEC-10121, DEC-10124). The order is the approvals' order in the lifecycle: the whole read is scanned once
  // and the last approval of each lane is taken at its position. Two approvals in the same second keep their
  // append order in one repo, which is the signature order there (DEC-10123)
  const attempted = new Set<string>();
  const carryApproved = async (): Promise<void> => {
    const all = readLifecycle();
    const order = landOrder(all);
    for (const iddId of order) {
      if (attempted.has(iddId)) continue;
      const evs = all.filter((e) => e.idd_id === iddId);
      // the same lanes the per-lane scan leaves out: a held lane, a closed lane, and a lane of a repo that
      // publishes (it becomes a push and a PR instead). The ledger alone answers the first three, so where the
      // lane lives (a file per lane) is read only for the lanes left (C-202-5)
      if (!stagePick("land_carry_ledger", evs).pick) continue;
      const loc = laneLocations(iddId);
      if (!stagePick("land_carry", evs, { hasLocation: Boolean(loc), publishes: loc ? publishes(loc.config) : false }).pick) continue;
      attempted.add(iddId);
      try {
        const res = await recheckApprovedLand(iddId);
        if (!res) continue;
        if (res.inherit) result.inherited.push(inheritedEntry(iddId, res.inherit));
        if (res.checking) result.checking.push(iddId);
        else if (res.held) result.held.push({ iddId, reason: res.held });
        else if (res.ok) result.merged.push(iddId);
        else if (res.error) result.errors.push({ iddId, error: res.error });
      } catch (err) {
        result.errors.push({ iddId, error: String((err as Error).message ?? err).slice(0, 300) });
      }
    }
  };
  // the groups the batch cards offer are read here, where git may be waited on, and the state only reads them back
  const offers = (): void => {
    try { refreshBatchOffers(); } catch { /* the cards keep the last reading */ }
  };
  offers();
  // a batch a signature covers is carried before the lanes signed one by one: its landing moves the mainline once for
  // all of its lanes, and a lane signed alone is then checked at the tip the batch left (C-247-7)
  try {
    for (const [id, pass] of await driveBatches()) {
      result.merged.push(...pass.landed);
      if (pass.held) result.held.push({ iddId: id, reason: pass.held });
      if (pass.error) result.errors.push({ iddId: id, error: pass.error });
    }
  } catch (err) {
    result.errors.push({ iddId: "batch", error: String((err as Error).message ?? err).slice(0, 300) });
  }
  await carryApproved();
  for (const rec of readBacklog()) {
    const evs = readLifecycle().filter((e) => e.idd_id === rec.idd_id);
    // the ledger alone first: a held or a closed lane, a lane whose signature is in force, and a lane not at the
    // submit confirmation cost nothing to leave, and where the lane lives is a file per lane (C-202-5)
    if (!stagePick("land_ledger", evs).pick) continue;
    const loc = laneLocations(rec.idd_id);
    // the stage asks its own question, at the moment it asks it (C-199-2)
    if (!stagePick("land", evs, { hasLocation: Boolean(loc), publishes: loc ? publishes(loc.config) : false }).pick) continue;
    if (!loc) continue;
    try {
      // what this lane needs — a failed check settled, or a check started — is the fold's answer (C-202-1): the
      // observations below are read as its answer names them, and the steps it gives run in their order (C-202-2)
      await driveLandSteps("scan", evs, { [`branch|${rec.idd_id}|`]: loc.config.work_base ?? "" }, observeLand(rec.idd_id, loc, evs, attempted), {
        write: (event, attrs) => appendLifecycle(event, rec.idd_id, attrs).then(() => undefined),
        call: (step) => callLand(rec.idd_id, loc, step, carryApproved),
        result: (step) => pushLandResult(result, step),
        reload: () => readLifecycle().filter((e) => e.idd_id === rec.idd_id),
        lockRefused: (err) => Boolean(lockRefusal(err)),
      });
    } catch (err) {
      result.errors.push({ iddId: rec.idd_id, error: String((err as Error).message ?? err).slice(0, 300) });
    }
  }
  // a signature that arrived while the last lane was being checked goes in before this pass ends (DEC-10121)
  await carryApproved();
  offers();
  return result;
}

/** the lane's newest landing run, when it read exactly this head and mainline tip and ended without a result */
function landRunEndedWithout(iddId: string, loc: LaneLocation): boolean {
  const run = readLandRun(iddId);
  if (!run || (run.status !== "failed" && run.status !== "stopped")) return false;
  return run.head === headCommit(loc.work) && run.mainTip === mainlineTip(loc.config.local_path!, loc.config.work_base!);
}

/**
 * The observations a lane's card reading is asked for: git's answers about the lane and the mainline, the records
 * the stage keeps, and whether this pass already tried the lane as an approved landing. None of them decides
 * anything; the fold reads them (C-202-3).
 */
function observeLand(iddId: string, loc: LaneLocation, rows: LifecycleRecord[], attempted: Set<string>): LandObserver {
  return (need) => {
    switch (need.kind) {
      case "checked": return landCheckedAt(iddId, loc);
      case "behind": return landBehindAt(iddId, loc);
      case "runEnded": return landRunEndedWithout(iddId, loc);
      case "stacked": return stackedSubmitBlocker(iddId, loc);
      case "head": return headCommit(loc.work) ?? "";
      case "unreviewed": {
        const head = headCommit(loc.work);
        return head ? unreviewedChange(rows, loc.work, head) : null;
      }
      case "branch": return loc.config.work_base ?? "";
      case "now": return Date.now();
      case "runChecking": return Boolean(landRunChecking(iddId));
      case "run": return readLandRun(iddId);
      case "attempted": return attempted.has(iddId);
      default: return null;
    }
  };
}

/** the helpers a lane's card steps call: the approval sweep, the check, and the send-backs */
async function callLand(iddId: string, loc: LaneLocation, step: LandStep, sweep: () => Promise<void>): Promise<unknown> {
  const args = step.args ?? {};
  switch (step.helper) {
    // a signature that arrived meanwhile goes in first, as before a fresh check or a settle (DEC-10121)
    case "carry_sweep":
      await sweep();
      return null;
    case "prepare_land":
      return prepareLand(iddId, { signed: args.signed === true });
    case "send_back_land_conflict":
      await sendBackLandConflict(iddId, String(args.branch), (args.files ?? []) as string[], String(args.head), String(args.mainTip));
      return true;
    case "send_back_land_check_failure":
      return sendBackLandCheckFailureFrom(iddId, args);
    default:
      throw new Error(`知らない helper: ${step.helper}`);
  }
}

/** what the step's answer adds to the tick's result: the lists the screen and the record read */
function pushLandResult(result: LandStageResult, step: LandStep): void {
  const id = String(step.id);
  if (step.field === "prepared") result.prepared.push(id);
  else if (step.field === "checking") result.checking.push(id);
  else if (step.field === "inherited" && step.inherit) result.inherited.push(inheritedEntry(id, step.inherit as unknown as LandInherit));
  else if (step.field === "held") result.held.push({ iddId: id, reason: String(step.reason ?? "") });
  else if (step.field === "sentBack") result.sentBack.push(id);
  else if (step.field === "errors") result.errors.push({ iddId: id, error: String(step.error ?? "") });
  else if (step.field === "merged") result.merged.push(id);
}
