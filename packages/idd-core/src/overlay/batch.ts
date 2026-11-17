import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { getAgentRunner } from "../agent/port.ts";
import type { LandConflictAnswer, LandConflictFile, LandConflictInput, LandConflictSide } from "../agent/port.ts";
import { publishes, readAreas, resolveAreaKey } from "../config/areas.ts";
import type { GeneratedFiles } from "../config/generated.ts";
import { deriveStage } from "../ledger/derive.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { lifecycleByLane } from "../ledger/blockers.ts";
import { appendLifecycle, transition } from "../ledger/write.ts";
import { projectionViewFor } from "../intent/store.ts";
import { landBatchContent, verifyApproval, consumeNonce } from "../passkey.ts";
import { headCommit } from "../worktree/ensure.ts";
import { laneLocations } from "./export.ts";
import type { LaneLocation } from "./export.ts";
import { blockingWhy } from "./check-reason.ts";
import { blockingCount } from "./gate.ts";
import { generatedPathsOf, generatedTouched, rebuildGenerated, type RebuildFailure } from "./generated.ts";
import {
  APPROVAL_WINDOW_MS, checkouts, closeAttrs, closeIssueAfterLand, closeLanded, conflictFiles, currentLandApproval, followLanePlaces,
  guards, landBlocker, landCloseOf, landDeclarationKey, mainlineTip, mergeMessageFor, noteLandHold, readLand, rebuildFailureWords, redrawProjections,
  reserveCheckSlot, saveLand, treeWith,
} from "./land.ts";
import type { LandClose, LandRecord } from "./land.ts";
import { landRunChecking, readLandRun, readLandRounds, startLandRun, stopLandRun } from "./land-run.ts";
import { attempt, attemptBytes, clean, commitTree, dir, git, key, lock, lockRefusal, mergeTrees, names, read, recordPath, save, tree } from "./git.ts";

/**
 * Landings laid together under one signature (C-247-1). The lanes at one work clone's mainline that wait for a landing
 * are put on one card; one signature over the lanes penne left on it (C-247-2) lets the harness lay their heads on the
 * mainline one after the other, check the last tree once (C-247-3), and move the mainline to it. A lane that cannot go
 * in (its head moved, a conflict whose resolution cannot be shown to keep what both lanes decided, a check it makes
 * fail) is left out and the rest go in (C-247-4, C-247-5). The conversions the harness made after the signature are
 * recorded on the batch and on each lane (C-247-6), and each landed lane is closed with its own records (C-247-8).
 */

/** the longest a conversion's diff is kept in a record: the card shows it, and the lane's timeline names the file */
const DIFF_LIMIT = 6000;

/** how many probe checks a failing batch may spend finding the lane that made it fail (C-247-4) */
const MAX_PROBES = 5;

/** how many times a check that ended without a result is started again before the batch stops */
const MAX_ENV_RETRIES = 2;

/** one lane the signature covers: the head and the close penne saw */
export interface BatchLaneEntry {
  iddId: string;
  head: string;
  branch: string;
  title: string;
  close?: LandClose;
  closeCard?: LandRecord["closeCard"];
}

/** why a lane is not in the batch's chain; `reason` is what the card and the lane's timeline say */
export interface BatchDrop {
  iddId: string;
  kind: "moved" | "blocked" | "conflict" | "unresolved" | "check" | "failed";
  reason: string;
  at: string;
}

/** a change the harness made to a lane's merge after the signature, and why it keeps the lane's meaning (C-247-6) */
export interface BatchConversion {
  iddId: string;
  /** `rebuilt`: a generated file made again from the sources of the merged tree (its files carry no diff: the path and the ground say it all, C-261-6) */
  kind: "resolved" | "redrawn" | "rebuilt";
  files: { path: string; diff: string }[];
  rationale: string;
  at: string;
}

/** a generated file that could not be made again in a lane's step, and whether the environment or the build is to blame; no conversion, the step went on as before (C-261-7) */
export interface BatchRebuildFailure extends RebuildFailure {
  iddId: string;
}

export interface BatchStep { iddId: string; head: string; commit: string }

export type BatchPhase = "chain" | "checking" | "probing" | "closing" | "landed" | "stopped";

/** the probe checks that find the lane a failing chain fails at: the shortest prefix that fails (C-247-4) */
export interface BatchBisect {
  /** the failing chain's lanes, in order */
  ids: string[];
  /** a prefix of this many lanes passes */
  lo: number;
  /** a prefix of this many lanes fails */
  hi: number;
  probes: number;
  /** the prefix the running probe checks */
  probe?: { count: number; commit: string };
  /** why each failing prefix failed, by its lane count */
  reasons: Record<string, string>;
  /** the prefixes are checked from the longest down: the lane found is the one the failure starts at and no later lane repairs */
  peel?: boolean;
}

export interface LandBatch {
  id: string;
  /** the work clone and its mainline branch the batch goes to */
  repo: string;
  workBase: string;
  repoName?: string;
  area: string;
  /** the lanes the signature covers, in order; never changed after the signature */
  approved: BatchLaneEntry[];
  approvedAt: string;
  /** the lanes the current chain is made over */
  lanes: string[];
  dropped: BatchDrop[];
  conversions: BatchConversion[];
  /** the rebuilds that could not be made in the chain now standing, replaced with it like the conversions; absent in a record from before */
  rebuildFailures?: BatchRebuildFailure[];
  mainTip: string;
  chain: BatchStep[];
  /** the last commit of the chain: the one tree the check reads and the mainline moves to */
  mergeCommit?: string;
  phase: BatchPhase;
  bisect?: BatchBisect;
  /**
   * The lane the prefixes pointed at while lanes after it are still in the batch. A later lane may repair what a prefix
   * showed, so it is left out of the chain but not yet dropped: it is dropped when the chain without it passes, and the
   * batch stops, nothing landed, when that chain fails too (C-247-4).
   */
  suspect?: { iddId: string; reason: string; ids: string[]; reasons: Record<string, string> };
  /** the failing chain the suspect was found in, to be checked from its end once the chain is made again with the suspect in it */
  peel?: { ids: string[]; reasons: Record<string, string> };
  /** how many times a check that ended without a result was started again */
  retries: number;
  reason?: string;
  /** the check of the last tree: its run, when it ended, and how many checks it ran */
  checked?: { runId: string; at: string; checks: number; mergeCommit: string };
  /** the landing: set when the mainline moved; the lanes still to close are those not in `done` */
  landed?: { at: string; mergeCommit: string; lanes: string[]; done: string[] };
}

/**
 * The id of the batch of one area's lanes on one work clone's mainline: the run, the check record and the batch record
 * are keyed by it. The area is part of it because the checks a landing must pass are the area's own: lanes of two areas
 * on the same mainline are not signed or checked together, so no area's required check is left unrun (C-247-3).
 */
export function batchIdOf(repo: string, workBase: string, area: string): string {
  return `batch:${key({ repo, workBase, area }).slice(0, 16)}`;
}

export const batchPath = (id: string) => recordPath("land-batch", id);
export function readBatch(id: string): LandBatch | null { return read<LandBatch>(batchPath(id)); }
function saveBatch(b: LandBatch): LandBatch { save(batchPath(b.id), b); return b; }

/** the last batch record of every mainline the areas name: what the cards read to say how a signed batch ended */
export function readBatches(): LandBatch[] {
  return batchGroupsIds().map((id) => readBatch(id)).filter((b): b is LandBatch => b !== null);
}

/** for the tests only: a batch record in the state as a given pass would have left it */
export function saveBatchForTests(b: LandBatch): LandBatch { return saveBatch(b); }

/** the lanes of one mainline that wait for a landing, with the readings the card and the signature share */
export interface BatchCandidate {
  iddId: string;
  title: string;
  branch: string;
  head: string;
  work: string;
  source: string | null;
  close?: LandClose;
  closeCard?: LandRecord["closeCard"];
}

export interface BatchGroup {
  id: string;
  repo: string;
  workBase: string;
  repoName: string;
  area: string;
  lanes: BatchCandidate[];
}

/** whether the lane is at the submit confirmation and neither closed nor put off */
const waitsAtShip = (evs: ReturnType<typeof readLifecycle>): boolean => !evs.some((e) => e.event === "lane_close" || e.event === "s3_defer") && deriveStage(evs).decision === "ship";

/** the lane's location when it lands in a work clone of its own (no publishing repo, a mainline branch to land on) */
type LocalLane = NonNullable<ReturnType<typeof laneLocations>> & { config: { local_path: string; work_base: string } };
function localLane(id: string): LocalLane | null {
  const loc = laneLocations(id);
  return loc && !publishes(loc.config) && loc.config.local_path && loc.config.work_base ? (loc as LocalLane) : null;
}

/**
 * The lanes waiting to land at each work clone's mainline, in the order their records were opened. A lane belongs
 * only when it stands at the submit confirmation, would not be refused for its own reasons (an open branch, a lane that
 * adds nothing public, a change the last review did not see, a lane with uncommitted work) and carries no signature of
 * its own already: those stay on their own card, which is the way a lane is landed alone (C-247-7).
 */
export function batchGroups(): BatchGroup[] {
  const groups = new Map<string, BatchGroup>();
  // the ledger is split by lane once: the state is built often, and a scan of the whole ledger per lane is not cheap
  const byLane = lifecycleByLane(readLifecycle());
  for (const rec of readBacklog()) {
    const evs = byLane.get(rec.idd_id) ?? [];
    const loc = waitsAtShip(evs) ? localLane(rec.idd_id) : null;
    if (!loc) continue;
    const head = headCommit(loc.work);
    if (!head) continue;
    if (currentLandApproval(evs)) continue;
    try {
      if (landBlocker(rec.idd_id, loc) ?? guards(rec.idd_id, loc)) continue;
      if (!clean(loc.work)) continue;
    } catch { continue; }
    const closes = landCloseOf(rec.idd_id, readAreas().areas[loc.area]);
    const id = batchIdOf(loc.config.local_path, loc.config.work_base, loc.area);
    const group = groups.get(id) ?? { id, repo: loc.config.local_path, workBase: loc.config.work_base, repoName: loc.config.linked_repo ?? "", area: loc.area, lanes: [] };
    group.lanes.push({
      iddId: rec.idd_id, title: rec.title, branch: loc.branch, head, work: loc.work,
      source: rec.gh_issue_url ?? rec.linear_issue_url ?? null,
      ...(closes.close ? { close: closes.close } : {}),
      ...(closes.closeCard ? { closeCard: closes.closeCard } : {}),
    });
    groups.set(id, group);
  }
  return [...groups.values()];
}

/** a group as the tick last read it, with the mainline tip of that moment (the forecast of its lanes is told against it) */
export interface BatchOfferGroup extends BatchGroup { mainTip: string | null }

const offersPath = () => recordPath("land-batch-offers", "all");

/**
 * The tick's reading of the groups the cards offer (C-247-1). Building the groups walks every waiting lane's checkout
 * with synchronous git reads, which the state's derivation must not do: the state is asked for on every change and
 * while a decision is waiting on it, so it reads this record and the tick, which can wait, writes it (C-177-6). A press
 * is not decided by it: the signature is checked against the groups read afresh (`approveBatch`).
 */
export function refreshBatchOffers(): void {
  const groups: BatchOfferGroup[] = batchGroups().map((g) => ({ ...g, mainTip: mainlineTip(g.repo, g.workBase) ?? null }));
  save(offersPath(), { at: nowIso(), groups });
}

/** the groups the tick last read; none before its first reading */
export function readBatchOffers(): BatchOfferGroup[] {
  return read<{ at: string; groups: BatchOfferGroup[] }>(offersPath())?.groups ?? [];
}

/** a batch is on offer when two or more lanes wait on the same mainline and no signed batch is still going there */
export function batchOffers(): BatchGroup[] {
  return batchGroups().filter((g) => g.lanes.length >= 2 && !batchRunning(readBatch(g.id)));
}

/** whether a signed batch has not ended yet */
export function batchRunning(b: LandBatch | null): boolean {
  return b !== null && b.phase !== "landed" && b.phase !== "stopped";
}

/** the content the signature is over for the lanes of a group that are kept (in the group's order) */
export function landBatchContentFor(group: Pick<BatchGroup, "repoName" | "workBase" | "lanes">, ids?: string[]): Record<string, unknown> {
  const kept = ids ? group.lanes.filter((l) => ids.includes(l.iddId)) : group.lanes;
  return landBatchContent({
    repo: group.repoName,
    workBase: group.workBase,
    lanes: kept.map((l) => ({ iddId: l.iddId, head: l.head, close: l.close ?? null })),
  });
}

/** the content a record already signed carries, for a reader that checks a batch against its own signature */
export function landBatchContentOf(b: Pick<LandBatch, "repoName" | "workBase" | "approved">): Record<string, unknown> {
  return landBatchContent({
    repo: b.repoName ?? "",
    workBase: b.workBase,
    lanes: b.approved.map((l) => ({ iddId: l.iddId, head: l.head, close: l.close ?? null })),
  });
}

/** the Issue close of a lane as the card showed it: what the person read and what the signature covers */
export interface BatchPressClose { repo: string; issue: number; comment: string }

/** a lane as the card showed it: the head and the close that were read to the person who pressed, and so what the signature covers */
export interface BatchPressLane { iddId: string; head: string; close: BatchPressClose | null }

/**
 * The lanes a press names, each with the head and the close the card showed; null when the press does not carry them.
 * A lane's `close` is always named: null says the card showed none, and a press that leaves it out is not one a card made.
 */
export function batchPressLanes(raw: unknown): BatchPressLane[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BatchPressLane[] = [];
  for (const l of raw) {
    const iddId = typeof (l as { iddId?: unknown })?.iddId === "string" ? (l as { iddId: string }).iddId : "";
    const head = typeof (l as { head?: unknown })?.head === "string" ? (l as { head: string }).head : "";
    if (!iddId || !head) return null;
    const c = (l as { close?: unknown }).close;
    if (c === null) { out.push({ iddId, head, close: null }); continue; }
    const repo = (c as { repo?: unknown } | undefined)?.repo;
    const issue = (c as { issue?: unknown } | undefined)?.issue;
    const comment = (c as { comment?: unknown } | undefined)?.comment;
    if (typeof repo !== "string" || typeof issue !== "number" || !Number.isInteger(issue) || typeof comment !== "string") return null;
    out.push({ iddId, head, close: { repo, issue, comment } });
  }
  return out;
}

/** whether the close the card showed is the close read now */
function sameClose(shown: BatchPressClose | null, now: LandClose | undefined): boolean {
  if (!shown || !now) return !shown && !now;
  return shown.repo === now.repo && shown.issue === now.issue && shown.comment === now.comment;
}

/**
 * The group's lanes a press names, each carrying the head and the close the card showed. The signature is over these,
 * not over what the engine reads at the press: a lane that moved, or whose Issue close was changed, since the card is
 * then still in the signed content as it was shown, and the batch drops it as a lane that changed after the signature.
 * A head or a close never shown is never signed (C-247-2). The lanes are in the group's order.
 */
export function pressedGroup<G extends Pick<BatchGroup, "lanes">>(group: G, press: BatchPressLane[] | null): { ok: true; group: G } | { ok: false; error: string } {
  if (!press) return { ok: false, error: "card に出した lane の head と close が送られていません。カードを読み直してください" };
  const named = group.lanes.filter((l) => press.some((p) => p.iddId === l.iddId));
  if (!named.length) return { ok: false, error: "取り込む lane がありません。外していない lane を 1 件以上残してください" };
  const lanes = named.map((l) => {
    const shown = press.find((p) => p.iddId === l.iddId)!;
    // the close the card showed is what is signed and what the lane is closed with: it is never filled in from the close read now
    const close: LandClose | undefined = sameClose(shown.close, l.close) ? l.close : shown.close ? { ...shown.close, url: "" } : undefined;
    const lane: typeof l = { ...l, head: shown.head };
    if (close) lane.close = close;
    else delete lane.close;
    return lane;
  });
  // every lane the card showed has changed: nothing signed could land, so the card is read again before a signature is made
  if (named.every((l, i) => l.head !== lanes[i].head || !sameClose(lanes[i].close ?? null, l.close))) return { ok: false, error: "card を出した後に lane の commit か Issue の close が変わりました。カードを読み直してください" };
  return { ok: true, group: { ...group, lanes } };
}

export type BatchApproval =
  | { ok: true; batch: LandBatch; landed: string[] }
  | { ok: false; error: string };

/**
 * penne's signature over a batch card (`batch` is the card's id): the lanes left on it (`lanes`, a part or all of what
 * the card offered, each with the head and the Issue close the card showed) are checked against what is signed, and the
 * batch is recorded as signed at those heads and closes. The
 * chain, its one check and the landing are done by the tick from here on (`driveBatch`); this does the first step so
 * the check starts at the press. A lane whose head moved or whose Issue close changed since the card is signed as the card
 * showed it and dropped as a lane that changed after the signature, so a head or a close penne did not see is never
 * landed; when every lane changed the press is
 * refused and the card is read again. The nonce is used up whatever the outcome.
 */
export async function approveBatch(input: { batch: string; lanes: BatchPressLane[] | null; nonce?: string; assertion?: unknown; pinProof?: unknown }): Promise<BatchApproval> {
  try {
    const id = input.batch;
    const group = batchGroups().find((g) => g.id === id);
    if (!group) return { ok: false, error: "この本流に取り込みを待つ lane がありません。画面を読み直してください" };
    const pressed = pressedGroup(group, input.lanes);
    if (!pressed.ok) return pressed;
    const kept = pressed.group.lanes;
    const existing = readBatch(id);
    if (batchRunning(existing)) return { ok: false, error: "この本流のまとめた取り込みが進んでいます。終わってからやり直してください" };
    const verified = await verifyApproval({ nonce: input.nonce, assertion: input.assertion, pinProof: input.pinProof, content: landBatchContentFor(pressed.group) });
    if (!verified.ok) return { ok: false, error: verified.reason };
    const batch: LandBatch = {
      id, repo: group.repo, workBase: group.workBase, repoName: group.repoName || undefined, area: group.area,
      approved: kept.map((l) => ({ iddId: l.iddId, head: l.head, branch: l.branch, title: l.title, close: l.close, closeCard: l.closeCard })),
      approvedAt: new Date().toISOString(),
      lanes: kept.map((l) => l.iddId),
      dropped: [], conversions: [], rebuildFailures: [], mainTip: "", chain: [], phase: "chain", retries: 0,
    };
    saveBatch(batch);
    const driven = await driveBatch(id);
    return { ok: true, batch: readBatch(id) ?? batch, landed: driven.landed };
  } finally {
    consumeNonce(input.nonce);
  }
}

/** what one pass over a batch did: the lanes it landed in this pass, and why it is waiting if it is */
export interface BatchPass { landed: string[]; held?: string; error?: string }

const driving = new Map<string, Promise<BatchPass>>();

/** one pass over every signed batch that has not ended: the tick's step (C-247-1) */
export async function driveBatches(): Promise<Map<string, BatchPass>> {
  const out = new Map<string, BatchPass>();
  for (const id of batchGroupsIds()) {
    const b = readBatch(id);
    if (!batchRunning(b)) continue;
    out.set(id, await driveBatch(id));
  }
  return out;
}

/**
 * The ids of the batches the state holds, read from the records the batch writes and not derived from the areas as
 * configured now: a signed batch whose work_base was changed after the signature is still found, and its lanes whose
 * destination changed are left out by the pass (`standing`), the rest going on.
 */
function batchGroupsIds(): string[] {
  let names: string[];
  try { names = readdirSync(dir("land-batch")); } catch { return []; }
  const ids = new Set<string>();
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const rec = read<LandBatch>(join(dir("land-batch"), name));
    if (rec?.id) ids.add(rec.id);
  }
  return [...ids];
}

/** one pass over one batch, never two at once */
export function driveBatch(id: string): Promise<BatchPass> {
  const going = driving.get(id);
  if (going) return going;
  const pass = step(id).catch((e): BatchPass => ({ landed: [], error: String((e as Error).message ?? e).slice(0, 400) })).finally(() => driving.delete(id));
  driving.set(id, pass);
  return pass;
}

const nowIso = () => new Date().toISOString();

/** the lane stands where the signature left it, or why it no longer does */
function standing(entry: BatchLaneEntry, b: LandBatch): { loc: LaneLocation } | { drop: BatchDrop } {
  const drop = (kind: BatchDrop["kind"], reason: string) => ({ drop: { iddId: entry.iddId, kind, reason, at: nowIso() } });
  const evs = readLifecycle().filter((e) => e.idd_id === entry.iddId);
  if (evs.some((e) => e.event === "lane_close" || e.event === "s3_defer")) return drop("moved", "lane は閉じられました");
  if (deriveStage(evs).decision !== "ship") return drop("moved", "提出前確認の段にない lane です");
  const loc = laneLocations(entry.iddId);
  if (!loc || loc.config.local_path !== b.repo || loc.config.work_base !== b.workBase || loc.area !== b.area) return drop("moved", "取り込み先が署名のときと変わりました");
  const head = headCommit(loc.work);
  if (head !== entry.head) return drop("moved", "card に出した（署名した）head の後に lane の commit が進みました。この lane は次の card に残ります");
  const closes = landCloseOf(entry.iddId, readAreas().areas[loc.area]);
  if (key(closes.close ?? null) !== key(entry.close ?? null)) return drop("moved", "署名の後に Issue の close の宛先か一言が変わりました");
  const blocked = landBlocker(entry.iddId, loc) ?? guards(entry.iddId, loc);
  if (blocked) return drop("blocked", blocked);
  if (!clean(loc.work)) return drop("blocked", "lane に commit していない変更があります");
  return { loc };
}

/** the signed entry of a lane of the batch, and whether the lane still stands where the signature left it */
function standingOf(b: LandBatch, lane: string): { entry: BatchLaneEntry; state: ReturnType<typeof standing> } {
  const entry = b.approved.find((l) => l.iddId === lane)!;
  return { entry, state: standing(entry, b) };
}

/** a lane taken out of the chain: recorded on the batch, on the lane's timeline and as the reason its card shows */
async function dropLane(b: LandBatch, d: BatchDrop): Promise<void> {
  if (b.dropped.some((x) => x.iddId === d.iddId)) return;
  b.dropped.push(d);
  b.lanes = b.lanes.filter((l) => l !== d.iddId);
  const entry = b.approved.find((l) => l.iddId === d.iddId);
  try {
    await appendLifecycle("s4_land_batch_dropped", d.iddId, { batch: b.id, kind: d.kind, reason: d.reason, ...(entry ? { head: entry.head } : {}) });
    if (entry) await noteLandHold(d.iddId, entry.head, `まとめた取り込みから外れました: ${d.reason}`);
  } catch { /* the batch record carries the drop whatever the timeline could write */ }
}

async function step(id: string): Promise<BatchPass> {
  const b = readBatch(id);
  if (!b || !batchRunning(b)) return { landed: [] };
  if (b.phase === "closing") {
    if (landedOnMainline(b)) return finishClosing(b);
    // recorded as landing and then cut before the fast-forward moved the mainline: the landing is made again
    delete b.landed;
    b.phase = "checking";
    saveBatch(b);
  }
  // 1. every lane still in the chain has to stand where the signature left it (C-247-2)
  let changed = false;
  for (const lane of [...b.lanes]) {
    const { state } = standingOf(b, lane);
    if ("drop" in state) { await dropLane(b, state.drop); changed = true; }
  }
  if (!b.lanes.length) return stop(b, b.dropped.length ? `取り込める lane が残りませんでした（${b.dropped.map((d) => `${d.iddId}: ${d.reason}`).join(" / ")}）` : "取り込む lane がありません");
  const main = b.repo;
  const tip = mainlineTip(main, b.workBase);
  if (!tip) return stop(b, "本流の先端を読めません");
  // 2. a chain over other lanes or another tip is made again; the signature stays (C-247-2)
  const chainIds = b.chain.map((s) => s.iddId);
  const sameChain = !changed && b.chain.length > 0 && b.mainTip === tip && key(chainIds) === key(b.lanes)
    && b.chain.every((s) => b.approved.find((l) => l.iddId === s.iddId)?.head === s.head);
  if (!sameChain) {
    // the suspect was found against the tip of that time: with the tip moved it is judged again with the rest
    if (b.suspect && b.mainTip !== tip) restoreSuspect(b, false);
    if (landRunChecking(b.id)) stopLandRun(landRunChecking(b.id)!, "検査する tree（lane の組か本流の先端）が変わりました");
    return rebuild(b, tip);
  }
  // 3. the check of the last tree (or of the probe a failing one is narrowed with)
  const commit = b.bisect?.probe?.commit ?? b.mergeCommit!;
  const result = checkResult(b, commit);
  if (result.state === "running") return { landed: [], held: "まとめた取り込みの検査が走っています" };
  if (result.state === "none" || result.state === "ended") {
    if (result.state === "ended" && b.retries >= MAX_ENV_RETRIES) return stop(b, `検査が結果を出さずに終わりました（${result.reason}）。まとめた取り込みを止めました`);
    if (result.state === "ended") { b.retries += 1; saveBatch(b); }
    return startCheck(b, commit, b.bisect?.probe?.count ?? b.chain.length);
  }
  const record = result.record;
  // a records check that failed for one lane's records names that lane: it is left out without a search (C-247-4)
  const owned = recordsFailures(b, record);
  if (owned.size) return dropOwners(b, owned);
  if (b.bisect?.probe) return probeResult(b, record);
  if (record.blocking === 0) {
    if (b.suspect) await confirmSuspect(b);
    return land(b);
  }
  if (b.suspect) {
    // leaving the suspect out did not make the last tree pass: the prefixes blamed a lane a later lane may repair.
    // The suspect goes back in and the failing chain is checked from its end, which names the lane the failure starts at.
    restoreSuspect(b, true);
    b.chain = [];
    b.mergeCommit = undefined;
    saveBatch(b);
    return step(b.id);
  }
  return startBisect(b, record);
}

/** the lanes in the batch whose own records a required records check failed on, with why */
function recordsFailures(b: LandBatch, record: LandRecord): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of record.checks) {
    if (!c.lane || !b.lanes.includes(c.lane) || blockingCount([c]) === 0) continue;
    out.set(c.lane, [out.get(c.lane), `${c.name}: ${c.detail ?? c.status}`].filter(Boolean).join(" / "));
  }
  return out;
}

/** the lanes a records check failed for are left out, and the rest are made into a chain again and checked */
async function dropOwners(b: LandBatch, owned: Map<string, string>): Promise<BatchPass> {
  // the suspect was named by prefixes of a chain that failed for a reason now known: it is judged again with the rest
  if (b.suspect) restoreSuspect(b, false);
  delete b.bisect;
  delete b.peel;
  b.retries = 0;
  for (const [iddId, reason] of owned) {
    await dropLane(b, { iddId, kind: "check", reason: `この lane の記録を読む検査が落ちました。${reason.slice(0, 600)}`, at: nowIso() });
  }
  if (!b.lanes.length) return stop(b, `検査を通る lane が残りませんでした（${[...owned].map(([l, r]) => `${l}: ${r}`).join(" / ").slice(0, 400)}）`);
  b.chain = [];
  b.mergeCommit = undefined;
  saveBatch(b);
  return step(b.id);
}

/** the suspect, left out of the chain, is dropped: the chain without it passed the check */
async function confirmSuspect(b: LandBatch): Promise<void> {
  const suspect = b.suspect!;
  delete b.suspect;
  await dropLane(b, { iddId: suspect.iddId, kind: "check", reason: `この lane を重ねた tree で検査が落ちました。${suspect.reason}`, at: nowIso() });
}

/** the suspect goes back into the batch in the order it was signed in */
function restoreSuspect(b: LandBatch, peel: boolean): void {
  const { iddId, ids, reasons } = b.suspect!;
  delete b.suspect;
  b.lanes = b.approved.map((l) => l.iddId).filter((l) => l === iddId || b.lanes.includes(l));
  if (peel) b.peel = { ids, reasons };
}

async function stop(b: LandBatch, reason: string): Promise<BatchPass> {
  delete b.suspect;
  delete b.peel;
  b.phase = "stopped";
  b.reason = reason;
  saveBatch(b);
  return { landed: [], error: reason };
}

/**
 * Whether the check's record was made under the settings and declarations in force now. A check that began before the
 * repo's checks were changed (a check added, an increment, a preparation) has no result for the changed ones, so it is
 * not the answer for this tree (C-193-7).
 */
function checkedUnderOther(b: LandBatch, record: LandRecord): string | null {
  const first = b.chain[0]?.iddId ?? b.lanes[0];
  const loc = first ? laneLocations(first) : null;
  if (!loc) return null;
  if (record.configKey !== key(loc.config)) return "repo の設定が検査の後に変わりました";
  if (!record.declaredKey || record.declaredKey !== landDeclarationKey(b.area)) return "検査の宣言（increments・checkPrep）が検査の後に変わりました";
  return null;
}

/** the check's result for exactly this commit and tip: still running, ended without one, done, or never started */
function checkResult(b: LandBatch, commit: string):
  | { state: "none" }
  | { state: "running" }
  | { state: "ended"; reason: string }
  | { state: "done"; record: LandRecord } {
  const going = landRunChecking(b.id);
  if (going) {
    if (going.mergeCommit === commit && going.mainTip === b.mainTip) return { state: "running" };
    stopLandRun(going, "検査する tree が変わりました");
    return { state: "none" };
  }
  const record = readLand(b.id);
  if (record && record.mergeCommit === commit && record.mainTip === b.mainTip && !record.reason) {
    // a result made under other declarations is not taken: the tree is checked again under the ones in force now
    return checkedUnderOther(b, record) ? { state: "none" } : { state: "done", record };
  }
  const run = readLandRun(b.id);
  if (run && run.mergeCommit === commit && run.mainTip === b.mainTip && (run.status === "failed" || run.status === "stopped" || run.status === "done")) {
    return { state: "ended", reason: run.error ?? record?.reason ?? "結果が書かれませんでした" };
  }
  return { state: "none" };
}

/**
 * Start the one check of a tree. The slot is asked for as a signed check (C-144-5), and the repo's lock is held while
 * the run is started, as a single landing's preparation does, so the run cuts its copy of a tree no other operation is
 * writing around.
 */
async function startCheck(b: LandBatch, commit: string, count: number): Promise<BatchPass> {
  const full = reserveCheckSlot(b.id, true);
  if (full) return { landed: [], held: full };
  const lanes = b.chain.slice(0, count).map((s) => s.iddId);
  const loc = laneLocations(lanes[0] ?? b.lanes[0]);
  if (!loc) return stop(b, "lane の場所を読めません");
  let release: (() => void) | undefined;
  try {
    release = lock(b.repo, { checks: true });
    const areas = readAreas();
    const area = areas.areas[b.area];
    const increments = areas.increments?.[b.area] ?? [];
    const run = startLandRun({
      lane: b.id,
      signed: true,
      spec: {
        repo: b.repo, area: b.area, checks: area?.checks ?? [],
        ...(increments.length ? { increments } : {}),
        changed: names(b.repo, b.mainTip, commit),
        deps: join(b.repo, "node_modules"),
        head: key(b.chain.slice(0, count).map((s) => s.head)),
        mainTip: b.mainTip, mergeCommit: commit,
        branch: `batch ${lanes.join("+")}`, workBase: b.workBase, configKey: key(loc.config),
        declaredKey: landDeclarationKey(b.area, areas),
        ...(b.repoName ? { repoName: b.repoName } : {}),
        token: randomBytes(24).toString("base64url"),
        expiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString(),
        batch: lanes,
      },
    });
    b.phase = b.bisect?.probe ? "probing" : "checking";
    if (!b.bisect?.probe) b.checked = { runId: run.id, at: "", checks: 0, mergeCommit: commit };
    saveBatch(b);
    return { landed: [], held: "まとめた取り込みの検査を始めました" };
  } catch (e) {
    if (lockRefusal(e)) return { landed: [], held: "別の overlay の処理が動いています。次の tick が検査を始めます" };
    throw e;
  } finally { release?.(); }
}

/** a probe's result narrows the failing chain to the lane it fails at (C-247-4) */
async function probeResult(b: LandBatch, record: LandRecord): Promise<BatchPass> {
  const bisect = b.bisect!;
  const probe = bisect.probe!;
  if (record.blocking === 0) bisect.lo = probe.count;
  else { bisect.hi = probe.count; bisect.reasons[String(probe.count)] = blockingWhy(record.blocking, record.checks); }
  delete bisect.probe;
  return narrow(b);
}

/** the failing last tree: find the lane to leave out, or the next prefix to check */
async function startBisect(b: LandBatch, record: LandRecord): Promise<BatchPass> {
  b.bisect = { ids: b.chain.map((s) => s.iddId), lo: 0, hi: b.chain.length, probes: 0, reasons: { [String(b.chain.length)]: blockingWhy(record.blocking, record.checks) } };
  return narrow(b);
}

async function narrow(b: LandBatch): Promise<BatchPass> {
  const bisect = b.bisect!;
  if (bisect.hi - bisect.lo <= 1) {
    const culprit = bisect.ids[bisect.hi - 1];
    const reason = bisect.reasons[String(bisect.hi)] ?? "検査が落ちました";
    const last = bisect.peel || bisect.hi === bisect.ids.length;
    delete b.bisect;
    b.retries = 0;
    if (last) {
      // no lane comes after it to repair what the prefix showed
      await dropLane(b, { iddId: culprit, kind: "check", reason: `この lane を重ねた tree で検査が落ちました。${reason}`, at: nowIso() });
    } else {
      b.suspect = { iddId: culprit, reason, ids: bisect.ids, reasons: bisect.reasons };
      b.lanes = b.lanes.filter((l) => l !== culprit);
    }
    if (!b.lanes.length) return stop(b, `検査を通る lane が残りませんでした（${culprit}: ${reason}）`);
    b.chain = [];
    b.mergeCommit = undefined;
    saveBatch(b);
    return step(b.id);
  }
  if (bisect.probes >= MAX_PROBES) {
    delete b.bisect;
    return stop(b, `検査が落ちた原因の lane を ${MAX_PROBES} 回の検査で絞れませんでした。本流は進めていません`);
  }
  const count = bisect.peel ? bisect.hi - 1 : Math.floor((bisect.lo + bisect.hi) / 2);
  bisect.probes += 1;
  bisect.probe = { count, commit: b.chain[count - 1].commit };
  saveBatch(b);
  return startCheck(b, bisect.probe.commit, count);
}

/** the parts of a unified diff a record keeps */
function trimmed(text: string): string {
  return text.length > DIFF_LIMIT ? `${text.slice(0, DIFF_LIMIT)}\n…（${text.length - DIFF_LIMIT} 文字を省きました）` : text;
}

function blobAt(cwd: string, ref: string, path: string): string | null {
  return attempt(cwd, ["show", `${ref}:${path}`]);
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A blob read as the bytes it holds. It is text only when those bytes are valid UTF-8 without a NUL and writing the text
 * back gives the same bytes; anything else is binary, which a judge reading words cannot decide and a string would alter.
 * `null` is a path the ref does not hold.
 */
function textBlobAt(cwd: string, ref: string, path: string): { text: string } | { binary: true } | null {
  const bytes = attemptBytes(cwd, ["show", `${ref}:${path}`]);
  if (bytes === null) return null;
  if (bytes.includes(0)) return { binary: true };
  try {
    const text = UTF8.decode(bytes);
    return Buffer.from(text, "utf8").equals(bytes) ? { text } : { binary: true };
  } catch { return { binary: true }; }
}

/**
 * Where a lane's decisions are written: the plan (moved to the archive before the submit, so a lane that reached the
 * landing holds it there), the qa with the acceptance criteria, and the intent records' drawing.
 */
const DECIDED_DIRS = ["_docs/plan", "_docs/archives/plan", "_docs/qa", "_docs/intent"];

/** the most a side's decided texts add up to: the judge reads them with the files, in one message */
const DECIDED_TOTAL = 60_000;

/**
 * The plan, the acceptance criteria and the intent a lane wrote, as the judge's material for what that side decided.
 * `whole` is false when anything of it is not in the material (a text cut at the limits, a list that could not be
 * read, a decision text whose head blob could not be read, named in `missing`): a judge that has not been shown every decision cannot show a resolution keeps them.
 */
function decidedOf(main: string, base: string, head: string, limit = 20_000): { decided: { path: string; text: string }[]; whole: boolean; missing: string[] } {
  const listed = attempt(main, ["diff", "--no-renames", "--name-only", "-z", base, head, "--", ...DECIDED_DIRS]);
  const out: { path: string; text: string }[] = [];
  // the decision texts the lane changed whose head blob cannot be read (deleted, unreadable): they are not in the material
  const missing: string[] = [];
  if (listed === null) return { decided: out, whole: false, missing };
  let total = 0;
  let whole = true;
  // the total cap cuts the last kind first: the plan and the criteria are read before the intent's drawing
  const rank = (path: string) => DECIDED_DIRS.findIndex((d) => path.startsWith(`${d}/`));
  const paths = listed.split("\0").filter((p) => p.endsWith(".md")).sort((a, b) => rank(a) - rank(b));
  for (const path of paths) {
    const text = blobAt(main, head, path);
    if (text === null) { missing.push(path); whole = false; continue; }
    const kept = text.slice(0, Math.min(limit, Math.max(0, DECIDED_TOTAL - total)));
    if (kept.length < text.length) whole = false;
    if (!kept) continue;
    total += kept.length;
    out.push({ path, text: kept });
  }
  return { decided: out, whole, missing };
}

/** the Git modes of a regular file: the only kinds a resolution of text is written as */
const REGULAR_MODES = new Set(["100644", "100755"]);

/** the mode Git holds a path at in a tree-ish, or null when the path is not there */
function modeAt(cwd: string, ref: string, path: string): string | null {
  const out = attempt(cwd, ["ls-tree", ref, "--", path]);
  return out?.trim().split(/\s+/)[0] || null;
}

const MARKER = /^(<{7}|>{7})( |$)/m;

/** runs a wait with the repo's lock let go, and takes the lock again after it; the lock being taken by another operation meanwhile throws its refusal */
type Unlocked = <T>(wait: () => Promise<T>) => Promise<T>;

/** the answers the judge gave, by what it was asked: a chain made again after a refused lock does not ask the same again */
const answers = new Map<string, LandConflictAnswer>();
const ANSWERS_KEPT = 32;

/** for the tests only: the judge's remembered answers are forgotten, so a test is not answered by an earlier one with the same conflict */
export function forgetAnswersForTests(): void { answers.clear(); }

/**
 * What a question is remembered by. git labels the conflict markers with the names of the temporary commits the merge
 * was made over, and those commits are made again with every chain; the same conflict asked again must find its answer.
 */
function answerKey(input: LandConflictInput): string {
  const unlabelled = (text: string) => text.replace(/^([<>|]{7}) [0-9a-f]{7,64}$/gm, "$1");
  return key({ ...input, files: input.files.map((f) => ({ ...f, marked: unlabelled(f.marked) })) });
}

/** the answer is kept as soon as it arrives, inside the wait: the lock being refused when it is taken again must not lose it */
async function answered(input: LandConflictInput, ask: () => Promise<LandConflictAnswer>, unlocked: Unlocked): Promise<LandConflictAnswer> {
  const id = answerKey(input);
  const kept = answers.get(id);
  if (kept) return kept;
  return unlocked(async () => {
    const got = await ask();
    answers.set(id, got);
    if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value!);
    return got;
  });
}

type JudgedConflict = { tree: string; conversion: BatchConversion; conversionWithout: (skip: Set<string>) => BatchConversion | undefined };

type ChainStep =
  | { kind: "ok"; commit: string; conversions: BatchConversion[]; rebuildFailure?: RebuildFailure }
  | { kind: "drop"; drop: BatchDrop };

/**
 * Lay one lane's head on the tip: the merge of the three trees with the projection drawn again into it (C-129-1,
 * C-129-2), the way a single landing makes its merge commit. A conflict that is only projection files is resolved by
 * the redrawing; any other conflict is handed to the judge, and the resolution is taken only when it shows it keeps
 * what both lanes decided (C-247-5). Anything else leaves the lane out.
 */
async function chainStep(b: LandBatch, entry: BatchLaneEntry, loc: LaneLocation, tip: string, before: BatchStep[], repoKey: string, generated: GeneratedFiles[], unlocked: Unlocked): Promise<ChainStep> {
  const main = b.repo;
  const drop = (kind: BatchDrop["kind"], reason: string): ChainStep => ({ kind: "drop", drop: { iddId: entry.iddId, kind, reason, at: nowIso() } });
  const rec = readBacklog().find((r) => r.idd_id === entry.iddId);
  if (!rec) return drop("blocked", "lane がありません");
  const base = git(main, ["merge-base", tip, entry.head]).trim();
  const followed = await followLanePlaces(repoKey, entry.iddId, main, base, entry.head);
  if (followed) return drop("blocked", followed);
  const merged = mergeTrees(main, tree(main, base), tree(main, tip), tree(main, entry.head));
  const conflicts = merged.conflict ? conflictFiles(main, tip, entry.head) : [];
  const view = projectionViewFor(repoKey, entry.iddId, { mergedLanes: before.map((s) => s.iddId) });
  const drawingOn = view.projections.includes("A");
  if (merged.conflict && !conflicts.length) return drop("conflict", "本流と衝突します（衝突した file を読めませんでした）");
  // a conflict on a generated file holds no decision, so the judge is not asked about it: the file is made again from the
  // merged sources below (C-261-5). Only when that cannot be done does the judge answer for it, as it did (C-261-7)
  const generatedSet = generatedPathsOf(generated);
  const generatedConflicts = conflicts.filter((p) => generatedSet.has(p));
  const codeConflicts = conflicts.filter((p) => !generatedSet.has(p));
  let judgedWithSources = false;
  let askedAgain: string[] = [];
  let first: JudgedConflict | undefined;
  if (merged.conflict) {
    // the files that are not projections are the ones a judge has to answer for
    let unresolved = codeConflicts;
    if (drawingOn) {
      const probe = redrawProjections({ cwd: main, tree: merged.tree, conflicts: codeConflicts, sides: [tip, entry.head], view });
      if ("reason" in probe) return drop("blocked", probe.reason);
      unresolved = probe.unresolved;
    }
    if (unresolved.length) {
      // the judge is asked about the sources only: a generated file that conflicts beside them is made again below, so an
      // answer that is right for the sources is not turned away for want of an answer on a file it need not decide (C-261-5).
      // If the file cannot be made again, the judge is asked again for the whole set, the one the old landing had (C-261-7)
      askedAgain = [...unresolved, ...generatedConflicts];
      judgedWithSources = true;
      const judged = await judge(b, entry, main, base, tip, before, merged.tree, unresolved, unlocked);
      if ("drop" in judged) return { kind: "drop", drop: judged.drop };
      first = judged;
    }
  }
  // the tree of the step: the merge with what the judge wrote (when it was asked) and the projection drawn again into it
  const lay = (judged: JudgedConflict | undefined, because?: RebuildFailure): ChainStep | { tree: string; conversions: BatchConversion[]; once?: { at: number; without: (skip: Set<string>) => BatchConversion | undefined } } => {
    const list: BatchConversion[] = [];
    let tree = merged.tree;
    let once: { at: number; without: (skip: Set<string>) => BatchConversion | undefined } | undefined;
    if (judged) {
      tree = judged.tree;
      once = { at: 0, without: judged.conversionWithout };
      list.push(because ? { ...judged.conversion, rationale: `${rebuildFailureWords(because)}\n${judged.conversion.rationale}` } : judged.conversion);
    }
    if (drawingOn) {
      const projectionConflicts = merged.conflict ? codeConflicts.filter((p) => !list.some((c) => c.files.some((x) => x.path === p))) : [];
      const drew = redrawProjections({ cwd: main, tree, conflicts: projectionConflicts, sides: [tip, entry.head], view });
      if ("reason" in drew) return drop("blocked", drew.reason);
      if (drew.unresolved.length) return drop("conflict", `本流と衝突します（${drew.unresolved.join(", ")}）`);
      if (projectionConflicts.length) {
        list.push({
          iddId: entry.iddId, kind: "redrawn", at: nowIso(),
          files: projectionConflicts.map((path) => ({ path, diff: trimmed(attempt(main, ["diff", "--no-color", tree, drew.tree, "--", path]) ?? "") })),
          rationale: "写し（_docs の投影）は記録の状態から決まる文面なので、衝突した file は状態から描き直した。lane の記録の中身は変えていない",
        });
      }
      tree = drew.tree;
    }
    return { tree, conversions: list, ...(once ? { once } : {}) };
  };
  const laid = lay(first);
  if ("kind" in laid) return laid;
  let { tree: mergeTree, conversions, once: judgedOnce } = laid;
  // the generated files are made again from the sources of this step's tree, the way a single landing does (C-261-4)
  let failure: RebuildFailure | undefined;
  if (generated.length && (generatedConflicts.length || generatedTouched(main, base, tip, entry.head, generated))) {
    const rebuilt = await rebuildGenerated({ cwd: main, tree: mergeTree, outputs: generated, deps: join(main, "node_modules") });
    if ("failure" in rebuilt) {
      failure = rebuilt.failure;
      if (generatedConflicts.length && judgedWithSources) {
        // the sources and the generated file conflict together, and the file could not be made again: the judge answered
        // before the failure existed, so it is asked again for the same set with the failure beside it, and this answer
        // is the one taken (C-261-8). The first answer is not kept, in the tree or in the record
        const again = await judge(b, entry, main, base, tip, before, merged.tree, askedAgain, unlocked, failure);
        if ("drop" in again) return { kind: "drop", drop: { ...again.drop, reason: `${again.drop.reason}\n${rebuildFailureWords(failure)}` } };
        const second = lay(again, failure);
        if ("kind" in second) return second;
        ({ tree: mergeTree, conversions, once: judgedOnce } = second);
      } else if (generatedConflicts.length) {
        // only generated files conflict and they could not be made again: no text a judge writes is taken for them, as no
        // source of theirs vouches for it. The lane goes back as it did before this change (C-261-7), with the failure in the reason
        return drop("conflict", `本流と衝突します（${generatedConflicts.join(", ")}）。生成物だけが衝突し、作り直せなかったので、この lane は外しました\n${rebuildFailureWords(failure)}`);
      }
    } else {
      mergeTree = rebuilt.tree;
      // what the judge wrote for a generated file is not in the tree now, so its diff and its ground leave the record:
      // the file is read as a rebuilt one, by its path and why it was made again (C-261-6)
      const overwritten = judgedOnce ? generatedConflicts : [];
      if (judgedOnce && overwritten.length) {
        const kept = judgedOnce.without(new Set(overwritten));
        if (kept) conversions[judgedOnce.at] = kept;
        else conversions.splice(judgedOnce.at, 1);
      }
      const made = [...new Set([...rebuilt.changed, ...overwritten])];
      if (made.length) {
        conversions.push({
          iddId: entry.iddId, kind: "rebuilt", at: nowIso(),
          files: made.map((path) => ({ path, diff: "" })),
          rationale: "生成物は源から決まる文面なので、この merge の tree の源から repo の宣言（generated_files）のコマンドで作り直した。"
            + (overwritten.length ? "判定役の解決の文面は作り直した物で置き換えた。" : "")
            + "lane の源は変えていない",
        });
      }
    }
  }
  const commit = commitTree(main, mergeTree, [tip, entry.head], mergeMessageFor(rec, entry.branch));
  return { kind: "ok", commit, conversions, ...(failure ? { rebuildFailure: failure } : {}) };
}

/** hand the conflicted files to the judge; the answer is taken only when it shows both lanes' decisions kept */
async function judge(b: LandBatch, entry: BatchLaneEntry, main: string, base: string, tip: string, before: BatchStep[], marked: string, files: string[], unlocked: Unlocked, failure?: RebuildFailure):
  Promise<{ tree: string; conversion: BatchConversion; conversionWithout: (skip: Set<string>) => BatchConversion | undefined } | { drop: BatchDrop }> {
  const drop = (kind: BatchDrop["kind"], reason: string) => ({ drop: { iddId: entry.iddId, kind, reason, at: nowIso() } });
  const where = files.join(", ");
  const runner = getAgentRunner();
  if (!runner?.resolveLandConflict) {
    return drop("unresolved", `本流と衝突します（${where}）。意味を変えない解決を示す役が使えないので、この lane は外しました`);
  }
  // the judge reads words: a conflicted file that is not text on every side (an image, bytes a string would change) is not handed to it
  const inputs: LandConflictFile[] = [];
  for (const path of files) {
    const sides = [textBlobAt(main, base, path), textBlobAt(main, tip, path), textBlobAt(main, entry.head, path), textBlobAt(main, marked, path)];
    if (sides.some((x) => x !== null && "binary" in x)) {
      return drop("unresolved", `本流と衝突します（${path}）。binary か文字列に直すと bytes が変わる file で、中身を言葉で判断できないので、この lane は外しました`);
    }
    const [b0, o, t, m] = sides.map((x) => (x && "text" in x ? x.text : null));
    inputs.push({ path, base: b0, ours: o, theirs: t, marked: m ?? "" });
  }
  const wholeness: string[] = [];
  const sideOf = (lane: string, title: string, from: string, head: string): LandConflictSide => {
    const read = decidedOf(main, from, head);
    if (!read.whole) wholeness.push(read.missing.length ? `${lane}（読めない: ${read.missing.join(", ")}）` : lane);
    return { lane, title, decided: read.decided };
  };
  // each earlier lane is read as its own change, from where it branched off the chain's start: read from the tip itself, whatever the mainline
  // moved since would show as the lane undoing it, and the judge would take that for the lane's decision
  const earlier: LandConflictSide[] = [];
  const unread: string[] = [];
  for (const s of before) {
    const from = attempt(main, ["merge-base", b.mainTip, s.head])?.trim();
    if (!from) { unread.push(s.iddId); continue; }
    const e = b.approved.find((l) => l.iddId === s.iddId);
    earlier.push(sideOf(s.iddId, e?.title ?? s.iddId, from, s.head));
  }
  if (unread.length) {
    return drop("unresolved", `本流と衝突します（${where}）。${unread.join(", ")} の分岐点を読めず、計画・受け入れ条件・意図を判定役に渡せないので、この lane は外しました`);
  }
  const input: LandConflictInput = {
    files: inputs, incoming: sideOf(entry.iddId, entry.title, base, entry.head), earlier,
    ...(failure ? { rebuildFailure: { cause: failure.cause, paths: failure.paths, reason: failure.reason } } : {}),
  };
  // a resolution is shown to keep what both lanes decided only against everything they decided: with part of it left out, the lane waits
  if (wholeness.length) {
    return drop("unresolved", `本流と衝突します（${where}）。${[...new Set(wholeness)].join(", ")} の計画・受け入れ条件・意図を判定役に全部は渡せないので、この lane は外しました`);
  }
  // a resolution is written back with the mode the path has on both sides: a mode that differs, or a path that is not a regular file, is not decided by a judge that reads text
  const modes = new Map<string, string>();
  for (const path of files) {
    const sides = [modeAt(main, tip, path), modeAt(main, entry.head, path)].filter((m): m is string => m !== null);
    const mode = sides[0];
    if (!mode || sides.some((m) => m !== mode) || !REGULAR_MODES.has(mode) || (modeAt(main, marked, path) ?? mode) !== mode) {
      return drop("unresolved", `本流と衝突します（${path}）。file の種類か実行属性（mode）が両側で食い違うか通常の file でないので、この lane は外しました`);
    }
    modes.set(path, mode);
  }
  let answer;
  try {
    // the judge's answer takes minutes: the repo's lock is let go while it is awaited, so another operation on the clone is not refused for that long
    answer = await answered(input, () => runner.resolveLandConflict!(input), unlocked);
  } catch (e) {
    // the lock could not be taken again after the wait: nothing is dropped and no chain is made, the next tick makes it again
    if (lockRefusal(e)) throw e;
    return drop("unresolved", `本流と衝突します（${where}）。解決の判定を得られませんでした: ${String((e as Error).message ?? e).slice(0, 200)}`);
  }
  if (answer.decision !== "keeps") return drop("conflict", `本流と衝突します（${where}）。両方の lane の決めたことを変えずには解けません: ${answer.reason}`);
  // one resolution per conflicted path, each with its ground: a path answered twice is not read as either of the two
  const covers = answer.files.every((f) => files.includes(f.path)) && files.every((path) => {
    const own = answer.files.filter((f) => f.path === path);
    return own.length === 1 && own[0]!.why.trim() !== "";
  });
  if (!answer.rationale.trim() || !covers) return drop("unresolved", `本流と衝突します（${where}）。解決の根拠が file ごとに示されなかったので、この lane は外しました`);
  if (answer.files.some((f) => files.includes(f.path) && MARKER.test(f.content))) return drop("unresolved", `本流と衝突します（${where}）。解決に衝突の印が残っていました`);
  const writes = answer.files.filter((f) => files.includes(f.path)).map((f) => ({ path: f.path, content: f.content, mode: modes.get(f.path)! }));
  const resolved = treeWith(main, marked, writes, []);
  const conversionWithout = (skip: Set<string>): BatchConversion | undefined => {
    const own = writes.filter((w) => !skip.has(w.path));
    if (!own.length) return undefined;
    return {
      iddId: entry.iddId, kind: "resolved", at: nowIso(),
      files: own.map((w) => ({ path: w.path, diff: trimmed(attempt(main, ["diff", "--no-color", marked, resolved, "--", w.path]) ?? "") })),
      rationale: [answer.rationale.trim(), ...answer.files.filter((f) => files.includes(f.path) && !skip.has(f.path)).map((f) => `${f.path}: ${f.why.trim()}`)].join("\n"),
    };
  };
  return { tree: resolved, conversion: conversionWithout(new Set())!, conversionWithout };
}

/**
 * Make the chain again over the lanes that stand, on the tip as it is now, and start the one check of its last tree
 * (C-247-3). The commits are objects only: the mainline does not move here. The repo's lock is held while they are
 * made (C-144-2).
 */
async function rebuild(b: LandBatch, tip: string): Promise<BatchPass> {
  let release: (() => void) | undefined;
  try {
    release = lock(b.repo, { checks: true });
  } catch (e) {
    if (lockRefusal(e)) return { landed: [], held: "別の overlay の処理が動いています。次の tick がまとめます" };
    throw e;
  }
  // a wait the chain's making needs (the judge) is done with the lock let go and taken again, so it is not held for the wait
  const unlocked: Unlocked = async (wait) => {
    release?.();
    release = undefined;
    try { return await wait(); } finally { release = lock(b.repo, { checks: true }); }
  };
  try {
    const areas = readAreas();
    const keyed = resolveAreaKey(b.area, areas);
    const repoKey = "error" in keyed ? b.area : keyed.key;
    const generated = areas.generatedFiles?.[b.area] ?? [];
    // the tip the chain starts at: what each side decided is read as the change from here (the judge's material)
    b.mainTip = tip;
    let at = tip;
    const chain: BatchStep[] = [];
    const conversions: BatchConversion[] = [];
    const rebuildFailures: BatchRebuildFailure[] = [];
    for (const lane of [...b.lanes]) {
      const { entry, state } = standingOf(b, lane);
      if ("drop" in state) { await dropLane(b, state.drop); continue; }
      const made = await chainStep(b, entry, state.loc, at, chain, repoKey, generated, unlocked);
      if (made.kind === "drop") { await dropLane(b, made.drop); continue; }
      chain.push({ iddId: lane, head: entry.head, commit: made.commit });
      conversions.push(...made.conversions);
      if (made.rebuildFailure) rebuildFailures.push({ iddId: lane, ...made.rebuildFailure });
      at = made.commit;
    }
    if (!chain.length) return stop(b, `取り込める lane が残りませんでした（${b.dropped.map((d) => `${d.iddId}: ${d.reason}`).join(" / ")}）`);
    b.mainTip = tip;
    b.chain = chain;
    b.mergeCommit = at;
    b.lanes = chain.map((s) => s.iddId);
    // the conversions of the chain now standing replace those of an earlier one; each is also on its lane's timeline
    const fresh = conversions.filter((c) => !b.conversions.some((o) => key(o.files) === key(c.files) && o.iddId === c.iddId && o.rationale === c.rationale));
    b.conversions = conversions;
    b.rebuildFailures = rebuildFailures;
    delete b.bisect;
    b.phase = "chain";
    // the chain is the failing one again: its prefixes are checked from the end, and its last tree is not checked a second time
    const peel = b.peel;
    delete b.peel;
    if (peel && key(peel.ids) === key(b.lanes)) {
      b.bisect = { ids: peel.ids, lo: 0, hi: peel.ids.length, probes: 0, reasons: peel.reasons, peel: true };
    }
    saveBatch(b);
    for (const c of fresh) {
      try { await appendLifecycle("s4_land_batch_converted", c.iddId, { batch: b.id, kind: c.kind, files: c.files.map((f) => f.path), diff: c.files.map((f) => f.diff).join("\n").slice(0, DIFF_LIMIT), rationale: c.rationale }); } catch { /* the batch record carries it */ }
    }
  } catch (e) {
    // the lock could not be taken again after a wait: the chain is made again by the next tick
    if (lockRefusal(e)) return { landed: [], held: "別の overlay の処理が動いています。次の tick がまとめます" };
    throw e;
  } finally { release?.(); }
  if (b.bisect) return narrow(b);
  return startCheck(b, b.mergeCommit!, b.chain.length);
}

/**
 * The landing: every condition the single landing's advance reads, read again under the lock, then a per-lane approval
 * event for each lane (C-247-8), the mainline moved to the checked tree by a fast-forward, and each lane closed with
 * its own records. A tip that moved since the check is met by checking again, not by asking for another signature
 * (C-247-2).
 */
async function land(b: LandBatch): Promise<BatchPass> {
  const main = b.repo;
  let release: (() => void) | undefined;
  try {
    release = lock(main);
  } catch (e) {
    if (lockRefusal(e)) return { landed: [], held: "別の overlay の処理が動いています。次の tick が取り込みます" };
    throw e;
  }
  let commit: string;
  try {
    const now = mainlineTip(main, b.workBase);
    if (now !== b.mainTip) return { landed: [], held: "本流が進みました。次の tick が検査し直して取り込みます" };
    const locs = new Map<string, LaneLocation>();
    for (const s of b.chain) {
      const entry = b.approved.find((l) => l.iddId === s.iddId)!;
      const state = standing(entry, b);
      if ("drop" in state) { await dropLane(b, state.drop); return { landed: [], held: `${s.iddId} を外して作り直します: ${state.drop.reason}` }; }
      locs.set(s.iddId, state.loc);
    }
    // the check's result must be for the declarations in force at this moment: a change made while a slow check ran
    // sends the chain to be made and checked again, with the signature kept and the tip read again
    const checked = readLand(b.id);
    const other = checked ? checkedUnderOther(b, checked) : "検査の記録がありません";
    if (other) {
      b.chain = [];
      b.mergeCommit = undefined;
      delete b.checked;
      saveBatch(b);
      return { landed: [], held: `${other}。署名はそのままで、組み直して検査し直します` };
    }
    const first = locs.get(b.chain[0].iddId)!;
    const bad = checkouts(b.chain[0].iddId, first);
    if (bad) {
      for (const s of b.chain) await noteLandHold(s.iddId, s.head, bad);
      return { landed: [], held: bad };
    }
    // each lane's approval event, signed by the batch's signature: the lane's gates read it (C-247-8)
    for (const s of b.chain) {
      const entry = b.approved.find((l) => l.iddId === s.iddId)!;
      const written = await transition(s.iddId, "s4_land_approved", { head: s.head, merge_commit: s.commit, signed: true, batch: b.id, ...closeAttrs(entry) });
      if (!written.ok) {
        await dropLane(b, { iddId: s.iddId, kind: "moved", reason: `承認を記録できませんでした: ${written.reason}`, at: nowIso() });
        return { landed: [], held: `${s.iddId} を外して作り直します: ${written.reason}` };
      }
    }
    commit = b.mergeCommit!;
    // the batch is recorded as landing before the mainline moves: a pass cut between the fast-forward and the record would
    // otherwise find the lanes already on the mainline and take them for lanes that carry nothing
    const before = { phase: b.phase, checked: b.checked };
    b.phase = "closing";
    b.landed = { at: nowIso(), mergeCommit: commit, lanes: b.chain.map((s) => s.iddId), done: [] };
    const run = readLandRun(b.id);
    b.checked = { runId: run?.id ?? b.checked?.runId ?? "", at: readLand(b.id)?.checkedAt ?? nowIso(), checks: readLand(b.id)?.checks.length ?? 0, mergeCommit: commit };
    saveBatch(b);
    const merged = attempt(main, ["merge", "--ff-only", commit]);
    if (merged === null) {
      b.phase = before.phase;
      b.checked = before.checked;
      delete b.landed;
      saveBatch(b);
      return { landed: [], error: "本流を merge できませんでした（作業ツリーを確認してください）" };
    }
  } finally { release(); }
  return finishClosing(b);
}

/** whether the mainline holds the commit the batch recorded as landed */
function landedOnMainline(b: LandBatch): boolean {
  return b.landed !== undefined && attempt(b.repo, ["merge-base", "--is-ancestor", b.landed.mergeCommit, `refs/heads/${b.workBase}`]) !== null;
}

/** the events a lane's Issue close leaves once it was tried: posted, failed, or queued as an outbound card */
const ISSUE_CLOSE_EVENTS = new Set(["s4_land_issue_close_posted", "s4_land_issue_close_failed", "s4_land_issue_close_queued"]);

/**
 * Close each landed lane with its own records and its own Issue close. The pass can be cut anywhere (the engine
 * stops between a lane's close and the batch record that says so), so what each step already did is read from the
 * lane's own timeline and not from the batch record alone: a lane that is closed is not closed again (its approval no
 * longer stands, so the gate would refuse it for good), and an Issue close that left its event is not posted twice.
 * Each lane is saved as done before the next one is begun. A lane that cannot be closed now is closed next pass.
 */
async function finishClosing(b: LandBatch): Promise<BatchPass> {
  const landed = b.landed!;
  const record = readLand(b.id);
  const closedNow: string[] = [];
  let failed: string | undefined;
  for (const s of b.chain) {
    if (landed.done.includes(s.iddId)) continue;
    const loc = laneLocations(s.iddId);
    const entry = b.approved.find((l) => l.iddId === s.iddId)!;
    const timeline = () => readLifecycle().filter((e) => e.idd_id === s.iddId);
    const alreadyClosed = timeline().some((e) => e.event === "lane_close");
    if (!loc && !alreadyClosed) { failed = `${s.iddId}: lane の場所を読めません`; continue; }
    const own: LandRecord = {
      iddId: s.iddId, branch: entry.branch, head: s.head, workBase: b.workBase, repo: b.repoName || undefined,
      mainTip: b.mainTip, mergeCommit: s.commit, checks: (record?.checks ?? []).filter((c) => !c.lane || c.lane === s.iddId), blocking: 0,
      token: randomBytes(24).toString("base64url"), expiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString(),
      configKey: loc ? key(loc.config) : "", ...(record?.declaredKey ? { declaredKey: record.declaredKey } : {}),
      status: "merged", ...(entry.close ? { close: entry.close } : {}), ...(entry.closeCard ? { closeCard: entry.closeCard } : {}),
      ...(record?.checkedAt ? { checkedAt: record.checkedAt } : {}),
      batch: { id: b.id, mergeCommit: landed.mergeCommit, ...(b.checked?.runId ? { runId: b.checked.runId } : {}), ...(b.checked?.at ? { checkedAt: b.checked.at } : {}) },
    };
    if (!alreadyClosed) {
      saveLand(own);
      const closed = await closeLanded(s.iddId, loc!, s.commit);
      if (!closed.ok) { failed = `${s.iddId}: ${closed.reason ?? "lane を閉じられませんでした"}`; continue; }
    }
    saveLand({ ...own, status: "complete" });
    const evs = timeline();
    if (!evs.some((e) => e.event === "s4_land_batch_landed" && e.attrs?.batch === b.id && e.attrs?.merge_commit === landed.mergeCommit)) {
      try {
        await appendLifecycle("s4_land_batch_landed", s.iddId, {
          batch: b.id, merge_commit: landed.mergeCommit, step_commit: s.commit, lanes: landed.lanes,
          run: b.checked?.runId ?? "", checked_at: b.checked?.at ?? "", checks: own.checks.map((c) => c.name),
          conversions: b.conversions.filter((c) => c.iddId === s.iddId).map((c) => ({ kind: c.kind, files: c.files.map((f) => f.path), rationale: c.rationale })),
        });
      } catch { /* the lane's close and the batch record carry it */ }
    }
    // the Issue close is tried once: an attempt that left its event on the timeline is not made again
    if (!evs.some((e) => ISSUE_CLOSE_EVENTS.has(e.event))) await closeIssueAfterLand(s.iddId, entry.close);
    landed.done.push(s.iddId);
    closedNow.push(s.iddId);
    saveBatch(b);
  }
  if (landed.done.length === b.chain.length) { b.phase = "landed"; delete b.reason; }
  else b.reason = failed;
  saveBatch(b);
  return failed ? { landed: closedNow, held: `本流は進めましたが、閉じられない lane があります: ${failed}。次の tick が閉じます` } : { landed: closedNow };
}

/**
 * What the batch's check ran, for a reader that has to say it ran once: the rounds the batch's id wrote. Every probe
 * a failing chain was narrowed with is a round too, so a batch that passed at once has exactly one.
 */
export function batchRounds(id: string) { return readLandRounds(id); }

/** the files a conversion changed, for the card's line */
export function conversionFiles(b: LandBatch): string[] {
  return [...new Set(b.conversions.flatMap((c) => c.files.map((f) => f.path)))];
}
