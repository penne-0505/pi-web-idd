import { execFileSync } from "node:child_process";

import { branchFor, readAreas } from "../config/areas.ts";
import type { AreaConfig } from "../config/areas.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { deriveStage } from "../ledger/derive.ts";
import { reviewBaseOf } from "../ledger/base.ts";
import { laneHasEnded } from "../ledger/ends.ts";
import { withLaneGate } from "../ledger/gate.ts";
import { laneRecording, recordedLaneBranch } from "../worktree/lane-branch.ts";
import { getAgentRunner } from "../agent/port.ts";
import { baseReceiptPath, custodyPath, invalidateProposal, laneLocations, submitInFlight } from "./export.ts";
import type { Custody } from "./export.ts";
import { importedCurrent, proposeImport } from "./import.ts";
import { MANIFEST_FILE, parseManifest } from "./manifest.ts";
import { attempt, clean, commitTree, git, lock, names, read, recordPath, remoteTip, save, sha } from "./git.ts";

/**
 * The public branch a lane's PR goes to (its base), and the lane that publishes that branch (its parent), if any.
 * With nothing recorded it is the area's public base. The parent is looked up by branch name each time, so a
 * parent taken in again as a new lane on the same branch is still found.
 */
export type BaseSource = "default" | "manual" | "intake" | "adopt" | "github";
export interface LaneBase {
  branch: string;
  /** the open lane publishing `branch`; null on the area's public base, or when no lane publishes it */
  parent: string | null;
  source: BaseSource;
  /** a branch that is neither the public base nor any open lane's (the parent ended, or it never was a lane) */
  external: boolean;
}

function eventsOf(iddId: string) {
  return readLifecycle().filter((e) => e.idd_id === iddId);
}

export function laneEnded(iddId: string): boolean {
  return laneHasEnded(iddId, readLifecycle());
}

function areaOf(iddId: string): { area: string; config: AreaConfig } | null {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  const config = rec ? readAreas().areas[rec.area] : undefined;
  return rec && config ? { area: rec.area, config } : null;
}

/**
 * The lane's branch in the work clone, once its worktree is cut (recorded when it is cut, before any session is
 * spawned in it); null before. The name the area gives a lane is not yet its branch: a lane taken in again for an
 * Issue is named like the ended lane, whose branch is kept, and is cut on a suffixed branch (-2) instead.
 */
export function laneWorkBranch(iddId: string): string | null {
  return recordedLaneBranch(iddId) ?? null;
}

/**
 * The branch a lane not cut yet will be cut on: the name the area gives it, unless another lane was already cut on
 * that name (the Issue taken in again). Then the name is decided when the worktree is cut, and is unknown.
 */
function plannedLaneBranch(iddId: string): string | null {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  if (!rec) return null;
  let named: string;
  try { named = branchFor(rec.area, iddId); } catch { return null; }
  return laneRecording(named, iddId) ? null : named;
}

/** why a lane cannot be stacked on yet: its branch is decided when its worktree is cut */
function unknownBranch(iddId: string): string {
  return `${iddId} の branch がまだ決まっていません（同じ Issue の前の lane の branch があるので、worktree を切るときに別の名前になります）。${iddId} の worktree ができてから積んでください`;
}

/** the branch the lane publishes to: the one it took on (custody), else its work branch, else the one it will be cut on */
export function lanePublicBranch(iddId: string): string | null {
  return read<Custody>(custodyPath(iddId))?.branch ?? laneWorkBranch(iddId) ?? plannedLaneBranch(iddId);
}

/** the open lanes of the area that publish to `branch` */
function lanesPublishing(area: string, branch: string, except: string): string[] {
  return readBacklog()
    .filter((r) => r.area === area && r.idd_id !== except && !laneEnded(r.idd_id))
    .filter((r) => lanePublicBranch(r.idd_id) === branch)
    .map((r) => r.idd_id);
}

interface BaseRecord { branch: string; parent?: string | null; source?: BaseSource; previous?: string }

function recordedBase(iddId: string): BaseRecord | null {
  const last = eventsOf(iddId).filter((e) => e.event === "lane_base_set").pop();
  const branch = last?.attrs?.branch;
  return typeof branch === "string" && branch ? (last!.attrs as unknown as BaseRecord) : null;
}

export function laneBaseOf(iddId: string): LaneBase | { error: string } {
  const at = areaOf(iddId);
  if (!at) return { error: "lane か repo がありません" };
  const publicBase = at.config.public_base;
  if (!publicBase) return { error: "repo に public_base がありません" };
  const set = recordedBase(iddId);
  const source = set?.source ?? "default";
  if (!set || set.branch === publicBase) return { branch: publicBase, parent: null, source, external: false };
  const owners = lanesPublishing(at.area, set.branch, iddId);
  if (owners.length > 1) return { error: `base の branch ${set.branch} を公開する lane が複数あります: ${owners.join(", ")}` };
  return { branch: set.branch, parent: owners[0] ?? null, source, external: owners.length === 0 };
}

/**
 * The work-side point of the ended parent a lane was put on (its base no open lane publishes now): its last
 * published work (custody's work-side counterpart of the public tip), else the tip of its branch, which its end
 * keeps. Null when neither is in the work clone.
 */
function endedParentWork(iddId: string, cfg: AreaConfig): string | null {
  const parent = recordedBase(iddId)?.parent;
  if (!parent || !cfg.local_path) return null;
  const custody = read<Custody>(custodyPath(parent));
  if (custody?.workHead && attempt(cfg.local_path, ["cat-file", "-e", `${custody.workHead}^{commit}`]) !== null) return custody.workHead;
  const branch = recordedLaneBranch(parent);
  if (branch && attempt(cfg.local_path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]) !== null) return `refs/heads/${branch}`;
  return null;
}

/**
 * The work-clone ref the lane's own changes are measured from: the parent lane's work branch, or the area's
 * work branch. Once the parent has ended, its last published work or its branch (`endedParentWork`), never the
 * work branch, where the parent's changes would be counted as the lane's. Null when that cannot be read
 * (`laneBaseMissing` says why), or while the parent's branch is not cut yet.
 */
export function laneBaseWorkRef(iddId: string): string | null {
  const at = areaOf(iddId);
  if (!at?.config.work_base) return null;
  const base = laneBaseOf(iddId);
  if (!("error" in base) && base.parent) {
    const branch = laneWorkBranch(base.parent);
    return branch ? `refs/heads/${branch}` : null;
  }
  if (!("error" in base) && base.external) return endedParentWork(iddId, at.config);
  return `refs/heads/${at.config.work_base}`;
}

/** whether the lane's area has a work branch to follow: a lane without one has no mainline, as against one whose mainline cannot be read */
export function laneHasMainline(iddId: string): boolean {
  return Boolean(areaOf(iddId)?.config.work_base);
}

/**
 * Why the lane's own changes cannot be measured, or null: its parent ended and left neither its published work nor
 * its branch in the work clone. The screen says so instead of counting from the work branch.
 */
export function laneBaseMissing(iddId: string): string | null {
  const at = areaOf(iddId);
  if (!at?.config.work_base) return null;
  const base = laneBaseOf(iddId);
  if ("error" in base || !base.external || endedParentWork(iddId, at.config)) return null;
  const parent = recordedBase(iddId)?.parent;
  return `親の lane${parent ? ` ${parent}` : ""}（base ${base.branch}）が終わり、その公開済みの状態も branch も作業 clone に無いので、この lane の変更を数える基準がありません`;
}

/**
 * Where a new lane's work branch starts: on a parent lane, its published work (custody), or its branch while it
 * has published nothing; otherwise the area's work branch.
 */
export function laneStartPoint(iddId: string): string | null {
  const at = areaOf(iddId);
  if (!at?.config.work_base) return null;
  const base = laneBaseOf(iddId);
  if ("error" in base) throw new Error(base.error);
  if (base.external) throw new Error(`base の branch ${base.branch} を公開する lane がありません（親の lane が終わっています。idd stack ${iddId} --default で既定の base に戻すと worktree を切れます）`);
  if (!base.parent) return at.config.work_base;
  const custody = read<Custody>(custodyPath(base.parent));
  if (custody?.workHead) return custody.workHead;
  // a parent not cut yet has no branch of its own (a branch of its name may be an ended lane's)
  const branch = laneWorkBranch(base.parent);
  const ref = branch ? `refs/heads/${branch}` : null;
  if (!ref || !at.config.local_path || attempt(at.config.local_path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) === null) {
    throw new Error(`親の lane ${base.parent} の worktree がまだありません。親の worktree ができるまで、この lane の worktree は作りません`);
  }
  return ref;
}

/**
 * Why the lane's work branch, once cut, does not stand on the new base: the commits it took from its current base
 * must all be in the new base's work branch, or its own changes are no longer measured from the new base (and a
 * submit to that base would carry the old base's commits). The branch is not cut again (it may hold the plan and
 * the work); a lane not cut yet (no cut of its branch recorded, or the branch is not there) takes any base.
 */
function branchMisfit(iddId: string, cfg: AreaConfig, parent: string | null): string | null {
  const repo = cfg.local_path;
  const own = laneWorkBranch(iddId);
  if (!repo || !own || !cfg.work_base) return null;
  const head = attempt(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${own}^{commit}`])?.trim();
  if (!head) return null;
  let target = `refs/heads/${cfg.work_base}`;
  if (parent) {
    const branch = laneWorkBranch(parent);
    target = `refs/heads/${branch}`;
    if (!branch || attempt(repo, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`]) === null) return `親の lane ${parent} の branch がまだありません。lane の branch ${own} は切られているので、親の branch ができてから積んでください`;
  }
  const current = laneBaseWorkRef(iddId);
  if (current === target) return null;
  if (!current) return `今の base の作業側を読めないので（${laneBaseMissing(iddId) ?? "親の lane の branch がまだありません"}）、lane の branch ${own} が新しい base の上の差分になるかを確かめられません。この base には変えられません`;
  const taken = attempt(repo, ["merge-base", head, current])?.trim();
  if (!taken || !isAncestor(repo, taken, target)) {
    return `lane の branch ${own} は、今の base から入った commit${taken ? `（${taken.slice(0, 9)} まで）` : ""}のうち新しい base に無いものを含んでいます。branch を切り直さない限り新しい base の上の差分にならないので、この base には変えられません（worktree を切る前に積んでください）`;
  }
  return null;
}

/** whether the lane's work branch has been cut in the work clone (its cut was recorded, and the branch is there) */
function laneBranchCut(iddId: string, cfg: AreaConfig): boolean {
  const own = laneWorkBranch(iddId);
  if (!cfg.local_path || !own) return false;
  return attempt(cfg.local_path, ["rev-parse", "--verify", "--quiet", `refs/heads/${own}^{commit}`]) !== null;
}

function parentChainHas(start: string, target: string): boolean {
  const seen = new Set<string>();
  let cur: string | null = start;
  while (cur && !seen.has(cur)) {
    if (cur === target) return true;
    seen.add(cur);
    const b = laneBaseOf(cur);
    cur = "error" in b ? null : b.parent;
  }
  return false;
}

/**
 * Record the lane's base: another open lane of the same area (by id), or a branch (the public base, or an open
 * lane's public branch). A branch no lane publishes is refused. Once the lane has published, only adopt and the
 * following of GitHub change it; a person's change then goes through the retarget card.
 */
export async function setLaneBase(iddId: string, target: { lane?: string; branch?: string }, source: Exclude<BaseSource, "default">): Promise<LaneBase | { error: string }> {
  const at = areaOf(iddId);
  if (!at) return { error: "lane か repo がありません" };
  if (laneEnded(iddId)) return { error: "終了した lane の base は変えられません" };
  const publicBase = at.config.public_base;
  if (!publicBase) return { error: "repo に public_base がありません" };
  if (source === "manual" || source === "intake") {
    if (read<Custody>(custodyPath(iddId))) return { error: "提出済みの lane の base は、ここでは変えられません（PR の base の付け替えの経路で変えます）" };
  }
  // a submit that may have pushed is retried as it was checked, adopt included (an adopt meanwhile would void it)
  if (source !== "github") {
    const inFlight = submitInFlight(iddId);
    if (inFlight) return { error: `${inFlight} base を変えてください` };
  }
  let branch: string;
  let parent: string | null = null;
  if (target.lane) {
    if (target.lane === iddId) return { error: "自分自身には積めません" };
    const other = readBacklog().find((r) => r.idd_id === target.lane);
    if (!other || other.area !== at.area) return { error: `${target.lane} は同じ repo の lane ではありません` };
    if (laneEnded(target.lane)) return { error: `${target.lane} は終了しています` };
    const published = lanePublicBranch(target.lane);
    if (!published) return { error: unknownBranch(target.lane) };
    branch = published;
    parent = target.lane;
  } else if (target.branch) {
    branch = target.branch;
    if (branch !== publicBase) {
      const owners = lanesPublishing(at.area, branch, iddId);
      if (owners.length !== 1) return { error: owners.length ? `${branch} を公開する lane が複数あります: ${owners.join(", ")}` : `${branch} を公開する lane がありません（lane でない branch には積めません）` };
      parent = owners[0];
    }
  } else return { error: "積む先の lane か branch を指定してください" };
  if (parent && parentChainHas(parent, iddId)) return { error: `${parent} は ${iddId} の上に積まれているので、循環します` };
  if (source === "manual" || source === "intake") {
    // with its parent ended, a lane whose branch is cut holds the parent's commits, and whether it takes them on is
    // the retarget's. A lane not cut yet holds nothing of the parent, and cannot be cut on an ended parent: going
    // back to the area's public base by hand is its way out (another lane is still refused here)
    const current = laneBaseOf(iddId);
    if (!("error" in current) && current.external) {
      const back = parent === null && branch === publicBase && !laneBranchCut(iddId, at.config);
      if (!back) return { error: `親の lane（base ${current.branch}）が終わっているので、base はここでは変えられません（worktree を切る前の lane は既定の base に戻せます。切った後の lane が親の変更を引き継ぐかどうかは、親の終わりの扱いで決めます）` };
    }
  }
  // an adopt too: a branch cut from its parent must not take the PR's base (the public base, say) with the parent's
  // commits in it, or the submit toward that base carries them as the lane's own
  if (source !== "github") {
    const misfit = branchMisfit(iddId, at.config, parent);
    if (misfit) return { error: misfit };
  }
  const before = laneBaseOf(iddId);
  const previous = "error" in before ? undefined : before.branch;
  if (previous === branch && !("error" in before) && before.parent === parent) return before;
  await appendLifecycle("lane_base_set", iddId, { branch, parent, source, ...(previous ? { previous } : {}) });
  return laneBaseOf(iddId);
}

/**
 * The base the adopted branch's open PR asks for, read without recording it: the base of its open PR decides the
 * lane's base (GitHub is the truth). The public base keeps the default, an open lane's branch makes it the parent.
 * No PR, or no gh to ask, leaves the base as it is (the adopt goes on as before) with a note; a base no lane
 * publishes stops the adopt.
 */
export function planAdoptBase(iddId: string, branch: string): { branch?: string; pr: number | null; prUrl?: string; note?: string } | { error: string } {
  const at = areaOf(iddId);
  if (!at) return { error: "lane か repo がありません" };
  let prs: { number: number; baseRefName: string; url?: string }[];
  try {
    prs = JSON.parse(execFileSync("gh", ["pr", "list", "--repo", at.config.linked_repo, "--head", branch, "--state", "open", "--json", "number,baseRefName,url"], { cwd: at.config.upstream_path, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    return { pr: null, note: `gh で PR の base を読めないので、base は変えずに adopt します: ${(e as Error).message.split("\n")[0].slice(0, 160)}` };
  }
  if (prs.length > 1) return { error: `${branch} に開いている PR が複数あります` };
  const pr = prs[0];
  if (!pr) return { pr: null };
  if (pr.baseRefName !== at.config.public_base) {
    const owners = lanesPublishing(at.area, pr.baseRefName, iddId);
    if (owners.length !== 1) return { error: `PR #${pr.number} の base ${pr.baseRefName} を公開する lane が${owners.length ? "複数あります" : "ありません"}。base の branch を持つ lane を先に adopt してください` };
  }
  return { branch: pr.baseRefName, pr: pr.number, ...(pr.url ? { prUrl: pr.url } : {}) };
}

/** read the adopted branch's PR base and record it at once (the CLI's adopt records it after the receive is prepared) */
export async function adoptBaseFromPr(iddId: string, branch: string): Promise<{ base: LaneBase; pr: number | null; prUrl?: string; note?: string } | { error: string }> {
  const plan = planAdoptBase(iddId, branch);
  if ("error" in plan) return plan;
  if (!plan.branch) {
    const base = laneBaseOf(iddId);
    return "error" in base ? base : { base, pr: null, ...(plan.note ? { note: plan.note } : {}) };
  }
  const base = await setLaneBase(iddId, { branch: plan.branch }, "adopt");
  if ("error" in base) return { error: `PR #${plan.pr} の base ${plan.branch}: ${base.error}` };
  return { base, pr: plan.pr, ...(plan.prUrl ? { prUrl: plan.prUrl } : {}) };
}

/** whether `ancestor` is in the history of `commit` (a missing object counts as no) */
export function isAncestor(cwd: string, ancestor: string, commit: string): boolean {
  return attempt(cwd, ["merge-base", "--is-ancestor", ancestor, commit]) !== null;
}

/** where the base's current state is on the work side, and the public tip it stands for */
export interface BaseCounterpart {
  branch: string;
  parent: string | null;
  publicTip: string;
  workCommit: string;
}

/**
 * The work-side commit of the base's published state: the parent lane's published work (its custody), or the
 * work branch's import of the public base. A parent that has not taken in its own public branch, or a work
 * branch behind the public base, stops the receive until that is done first.
 */
export function baseCounterpart(iddId: string): BaseCounterpart | { error: string } {
  const at = areaOf(iddId);
  if (!at?.config.local_path || !at.config.work_base || !at.config.upstream_path) return { error: "repo の作業本流・公開先が未設定です" };
  const base = laneBaseOf(iddId);
  if ("error" in base) return base;
  if (base.external) return { error: `base の branch ${base.branch} を公開する lane がありません（lane でない branch からは同期しません）` };
  if (!base.parent) {
    const mark = read<{ last_import: string; work_head: string }>(recordPath("imports", `${at.config.local_path}:${at.config.work_base}`));
    if (!mark || !importedCurrent(at.area)) return { error: `作業本流が公開本流 ${base.branch} の今の先端と同期していません。先に idd sync を回してください` };
    return { branch: base.branch, parent: null, publicTip: mark.last_import, workCommit: mark.work_head };
  }
  const custody = read<Custody>(custodyPath(base.parent));
  if (!custody) return { error: `親の lane ${base.parent} がまだ提出していません（子は親の公開済みの状態だけを同期します）` };
  if (remoteTip(at.config.upstream_path, custody.branch) !== custody.publicTip) {
    return { error: `親の lane ${base.parent} の公開 branch ${custody.branch} が、親の受け入れた先端から動いています。親で receive を先に行ってください` };
  }
  return { branch: base.branch, parent: base.parent, publicTip: custody.publicTip, workCommit: custody.workHead };
}

export interface BaseReceipt extends BaseCounterpart {
  from: string;
  result: string;
  reviewBase?: string;
  reviewBaseFallback?: boolean;
  status: "applying" | "done";
  at: string;
}
export function readBaseReceipt(iddId: string): BaseReceipt | null {
  return read<BaseReceipt>(baseReceiptPath(iddId));
}

export type ReceiveBaseResult =
  | { ok: true; changed: false; reason: string }
  | { ok: true; changed: true; branch: string; tip: string; from: string; result: string; files: string[] }
  | { ok: false; error: string; conflict?: string[] };

/** the stages at which nothing works in the lane's checkout: a card waits for penne, or the PR for its reviewers */
const QUIET_GROUPS = ["judge", "waiting"];

async function finishReceive(iddId: string, receipt: BaseReceipt): Promise<void> {
  await appendLifecycle("lane_base_received", iddId, {
    branch: receipt.branch, parent: receipt.parent, tip: receipt.publicTip, work_commit: receipt.workCommit, from: receipt.from, result: receipt.result,
    ...(receipt.reviewBase ? { review_base: receipt.reviewBase } : {}), ...(receipt.reviewBaseFallback ? { review_base_fallback: true } : {}),
  });
  save(baseReceiptPath(iddId), { ...receipt, status: "done" } satisfies BaseReceipt);
  invalidateProposal(iddId);
}

/**
 * Take the base's published state into the lane: a real merge of its work-side commit into the lane's branch, made
 * without a checkout (merge-tree) and moved on by a fast-forward. Nothing leaves the machine, so no approval; a
 * conflict, a broken manifest, uncommitted changes, a lane whose agents may be at work (or no agent runtime to
 * ask), a submit in progress, a lane that has published or is on the public base (until the submit side is in), or
 * a base not ready stops it with the branch unchanged. The next submit carries the base's tip as the second parent (the submit side).
 */
export async function receiveBase(iddId: string): Promise<ReceiveBaseResult> {
  let release: (() => void) | undefined;
  try {
    if (laneEnded(iddId)) throw new Error("終了した lane には同期しません");
    const loc = laneLocations(iddId);
    if (!loc) throw new Error("lane の worktree か repo の設定がありません");
    const quiet = () => {
      const stage = deriveStage(eventsOf(iddId));
      if (!QUIET_GROUPS.includes(stage.group)) throw new Error(`lane の agent が作業しうる段です（${stage.group}${stage.blockedBy ? `: ${stage.blockedBy}` : ""}）。段が止まってから同期します`);
      // without the agent runtime (the CLI) a session at work in the checkout cannot be told apart, as for the retire
      const runner = getAgentRunner();
      if (!runner?.cwdBusy) throw new Error("agent の runtime が無いので、この worktree で session が動いていないか確かめられません（同期は web の UI から行います）");
      if (runner.cwdBusy(loc.work)) throw new Error("この worktree で動いている session があります");
      // a published lane measures its unpublished work from custody.workTree: a receive would leave it unpublished
      // for good, since its submit is stopped, and the merged PR could neither close nor retire it
      if (read<Custody>(custodyPath(iddId)) || eventsOf(iddId).some((e) => e.event === "s4_pr_created")) {
        throw new Error("提出済み（PR 待ち）の lane の base の同期は、提出の側の対応（plan の段 2）が入るまで行いません（同期すると PR の merge 後に close も退役もできなくなります）");
      }
      // a submit that may have pushed is retried as it was approved; moving the branch would void it
      const inFlight = submitInFlight(iddId);
      if (inFlight) throw new Error(`${inFlight}同期してください`);
    };
    quiet();
    // until the submit side carries the base (段 2), a received base stops the lane's submit; a lane on the public
    // base is submitted onto it as it is, so taking it in would only stop that lane
    const on = laneBaseOf(iddId);
    if (!("error" in on) && !on.parent && !on.external) {
      throw new Error(`base が公開本流（${on.branch}）の lane には、提出の側の対応（plan の段 2）が入るまで同期しません（同期すると、段 2 が入るまでこの lane を提出できなくなります）`);
    }
    release = lock(loc.work);
    if (!clean(loc.work)) throw new Error("lane に未 commit の変更があります");
    const branch = laneWorkBranch(iddId);
    if (git(loc.work, ["branch", "--show-current"]).trim() !== branch) throw new Error("lane の worktree が lane の branch にありません");
    const counter = baseCounterpart(iddId);
    if ("error" in counter) throw new Error(counter.error);
    const head = sha(loc.work);

    if (isAncestor(loc.work, counter.workCommit, head)) {
      // a receive that moved the branch but stopped before its records: write them now
      const pending = readBaseReceipt(iddId);
      if (pending?.status === "applying" && pending.workCommit === counter.workCommit && isAncestor(loc.work, pending.result, head)) await finishReceive(iddId, pending);
      return { ok: true, changed: false, reason: "base の今の状態は同期済みです" };
    }

    let out: string;
    let conflict = false;
    try {
      out = git(loc.work, ["merge-tree", "--write-tree", "--name-only", "--no-messages", head, counter.workCommit]);
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? "");
      if (!/^[0-9a-f]{40,64}$/.test(out.split("\n")[0].trim())) throw e;
      conflict = true;
    }
    const [treeLine, ...rest] = out.split("\n");
    if (conflict) {
      const files = [...new Set(rest.map((l) => l.trim()).filter(Boolean))];
      await appendLifecycle("lane_base_conflict", iddId, { branch: counter.branch, parent: counter.parent, tip: counter.publicTip, work_commit: counter.workCommit, head, files });
      return { ok: false, error: `base（${counter.branch}）の同期が衝突します: ${files.join(", ")}`, conflict: files };
    }
    const merged = treeLine.trim();
    const manifestText = attempt(loc.work, ["show", `${merged}:${MANIFEST_FILE}`]);
    if (manifestText === null) throw new Error("同期の結果に overlay.manifest がありません");
    const manifest = parseManifest(MANIFEST_FILE, manifestText);
    if (manifest.issues.length) throw new Error(`同期の結果の manifest が不正です: ${manifest.issues.map((i) => i.reason).join(" / ")}`);

    const result = commitTree(loc.work, merged, [head, counter.workCommit], `chore: receive base ${counter.branch}`);
    // the review range goes on from the same start with the base's new work in it (read from the ledger as it is now)
    const prior = reviewBaseOf(eventsOf(iddId));
    let reviewBase: string | undefined;
    let reviewBaseFallback = false;
    if (prior) {
      const combined = attempt(loc.work, ["merge-tree", "--write-tree", "--no-messages", prior, counter.workCommit]);
      if (combined) reviewBase = commitTree(loc.work, combined.split("\n")[0].trim(), [prior, counter.workCommit], "review base");
      else { reviewBase = counter.workCommit; reviewBaseFallback = true; }
      // a commit made only for the ledger is kept from gc by a ref
      git(loc.work, ["update-ref", `refs/idd/review-base/${iddId}`, reviewBase]);
    }
    // the stage and the checkout are read again and the branch is moved while the lane gate is held: a stage change
    // (the tick starting an executor goes through the gate) lands before the check or after the move, never between
    return await withLaneGate(async (): Promise<ReceiveBaseResult> => {
      quiet();
      const receipt: BaseReceipt = { ...counter, from: head, result, ...(reviewBase ? { reviewBase } : {}), ...(reviewBaseFallback ? { reviewBaseFallback } : {}), status: "applying", at: new Date().toISOString() };
      save(baseReceiptPath(iddId), receipt);
      if (sha(loc.work) !== head || !clean(loc.work)) throw new Error("同期の間に lane が変わりました");
      git(loc.work, ["merge", "--ff-only", result]);
      await finishReceive(iddId, receipt);
      return { ok: true, changed: true, branch: counter.branch, tip: counter.publicTip, from: head, result, files: names(loc.work, head, result) };
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally { release?.(); }
}

/**
 * Adopt a public branch into the lane. The base its open PR asks for is checked first and recorded only once the
 * receive is prepared, so a failed adopt leaves the base as it was. A receive still prepared for another branch
 * stops the adopt: the base is never recorded against a branch other than the one being taken in.
 */
export async function adoptLane(iddId: string, branch: string): Promise<Record<string, unknown> & { error?: string; baseNote?: string; baseError?: string }> {
  // a submit that may have pushed is retried as it was checked: an adopt meanwhile would take its branch away
  const inFlight = submitInFlight(iddId);
  if (inFlight) return { error: `${inFlight} adopt してください` };
  const plan = planAdoptBase(iddId, branch);
  if ("error" in plan) return plan;
  const loc = laneLocations(iddId);
  if (!loc) return { error: "lane がありません" };
  // the base the PR asks for is checked before anything is prepared: a branch cut from its parent does not go onto it
  if (plan.branch) {
    const parent = plan.branch === loc.config.public_base ? null : lanesPublishing(loc.area, plan.branch, iddId)[0] ?? null;
    const misfit = branchMisfit(iddId, loc.config, parent);
    if (misfit) return { error: `PR #${plan.pr} の base ${plan.branch}: ${misfit}` };
  }
  const view = proposeImport(loc.area, { laneId: iddId, branch });
  if ("error" in view) return view;
  // a receive still prepared for another branch is what comes back: its custody and this PR's base would disagree
  if (view.remoteBranch !== branch) {
    return { error: `前の受け入れの準備（${view.remoteBranch}）が残っているので、${branch} は adopt しません。その準備を受け入れる（idd review-receive ${iddId} の後に accept-receive）か、取り消して（idd cancel-receive ${iddId}）から adopt し直してください` };
  }
  if (!plan.branch) {
    const base = laneBaseOf(iddId);
    return { ...view, ...("error" in base ? { baseError: base.error } : { base }), pr: null, ...(plan.note ? { baseNote: plan.note } : {}) };
  }
  const base = await setLaneBase(iddId, { branch: plan.branch }, "adopt");
  return { ...view, ...("error" in base ? { baseError: base.error } : { base }), pr: plan.pr };
}

/**
 * Whether a lane can be put on this target at all, before anything is taken in: an open lane, or a branch that is
 * an area's public base or exactly one open lane's public branch.
 */
export function validateStackTarget(target: { lane?: string; branch?: string }): { error?: string } {
  if (target.lane) {
    if (!readBacklog().some((r) => r.idd_id === target.lane)) return { error: `${target.lane} という lane はありません` };
    if (laneEnded(target.lane)) return { error: `${target.lane} は終了しています` };
    if (!lanePublicBranch(target.lane)) return { error: unknownBranch(target.lane) };
    return {};
  }
  if (!target.branch) return { error: "積む先の lane か branch を指定してください" };
  const areas = readAreas().areas;
  if (Object.values(areas).some((c) => c.public_base === target.branch)) return {};
  const owners = Object.keys(areas).flatMap((area) => lanesPublishing(area, target.branch!, ""));
  if (owners.length !== 1) return { error: `${target.branch} を公開する lane が${owners.length ? "複数あります" : "ありません"}` };
  return {};
}
