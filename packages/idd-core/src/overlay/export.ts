import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readAreas, publishes } from "../config/areas.ts";
import type { AreaConfig } from "../config/areas.ts";
import { readBacklog, readSessions, readLifecycle } from "../ledger/read.ts";
import { describeReferences, overlayReferences, readManifest, splitByManifest } from "./manifest.ts";
import { blockingCount, blockingSummary, checkInCopy, runGate, runChecks } from "./gate.ts";
import type { GateCheck } from "./gate.ts";
import { git, isLockRefusal, sha, tree, filteredTree, mergeTrees, commitTree, names, clean, key, recordPath, read, save, lock, remoteTip, fetchPublic, destination, cloneIdentity, refuseOverlap } from "./git.ts";
import type { Identity } from "./git.ts";
import { compareChecks } from "./check-reason.ts";
import { withBaseComparison } from "./check-base.ts";
import { keepResults, readKeptResults } from "./check-results.ts";
import { heavyLockOrRefuse } from "./heavy-lock.ts";
import { convergeChecksOn } from "../config/areas.ts";
import { draftedConventions, readConventions, recentMergedTitles, type ConventionReading } from "./conventions-read.ts";
import { commitMessageFor } from "../config/lane-names.ts";
import { laneHasEnded } from "../ledger/ends.ts";
import { approvedCommitMessage, PRECEDENT_LIMIT } from "../plan/vocab.ts";
import { isLaneGateBusy, LANE_GATE_BUSY_MESSAGE, withLaneGate } from "../ledger/gate.ts";
import { approvalGateOpen, shipContent, SignatureRefusedError } from "../passkey.ts";

export interface LaneLocation { work: string; upstream: string; branch: string; area: string; config: AreaConfig }
export interface Custody {
  branch: string; publicTip: string; workTree: string; workHead: string; prUrl?: string;
  /** the tip of the lane's base that its public branch has merged in, and that tip's work-side counterpart */
  base?: { branch: string; tip: string; workHead: string };
}
export interface ProposeView {
  iddId: string; branch: string; base: string; work: string; upstream: string;
  publish: string[]; held: string[]; commits: string[]; checks: GateCheck[]; blocking: number;
  token: string; expiresAt: string; head: string; target: string; targetTip: string | null;
  mode: "publish" | "local"; destination: { fingerprint: string; label: string }; pr: { title: string; body: string }; diff: string;
  /**
   * the published commit's author (the upstream clone's identity), shown and approved with the rest, and its message:
   * the repo's form of it until penne approves one on the card, then the one approved. Absent when nothing is published
   */
  commitMessage?: string; author?: Identity;
  /** the subjects of the recent public commits, read for a repo that declares a commit form: the card tells when they disagree with it */
  precedents?: string[];
  /** the sections of the repo's rules it points at (config/repos.yaml `conventions`), as the public base had them at this check: where they are and a hash, never their words */
  conventions?: ConventionReading[];
  /** the titles of the recent merged PRs, read for a repo that declares a commit form: the card tells when they disagree with it */
  mergedTitles?: string[];
  /** the repo declares a commit form but GitHub could not be asked for the merged PRs: the card says the practice was not checked */
  mergedTitlesUnread?: true;
  /** when the checks of this record finished (ISO): a check run again at the same head shows its time even when the result did not change */
  checkedAt?: string;
  /**
   * what the check before this one found when it was of the same head: when it ran, and whether the result changed
   * (`changes` names the checks whose status moved). Absent for the first check of a head. The card says it, so a check
   * run again that finds the same thing is not silent
   */
  sinceLast?: { at?: string; changed: boolean; changes: string[] };
}
export interface ProposeRecord extends ProposeView {
  configKey: string; manifestKey: string; publicTree: string; workTree: string;
  status: "prepared" | "pushed" | "complete"; outputCommit?: string; prUrl?: string;
  /** the repo (owner/name) and the work side's mainline branch, part of a local completion's signed content */
  repo?: string; workBase?: string;
  /** checked while the lane's public branch was gone (`GoneBranch`): it goes out as a new branch over the public base */
  branchGone?: GoneBranch;
}
/**
 * The lane's public branch is gone from the remote, and GitHub said why (the caller asked). `merged`: its PR was
 * merged at the commit the lane last pushed (`tip`), so the public base carries it and only what came after goes
 * out; or, with `mergedAt`, at an earlier push of the lane, with the lane's pushes after the merge on record: the
 * public base then carries the branch only up to `mergedAt`, and the branch's commits after it go out again together
 * with what came after `tip`. Otherwise its PR was closed unmerged, or it never had one: nothing of it reached the
 * public base, and the lane's whole change goes out over the public base again. Either way as a new push, on
 * penne's approval.
 */
export interface GoneBranch { tip: string; merged: boolean; pr?: number; mergedAt?: string }
/**
 * Why a lane whose public branch is gone is not put out again over the public base: GitHub did not say that its PR
 * was merged at what the lane last pushed, nor that it closed unmerged (merged at another commit, say)
 */
export function goneUnknownReason(branch: string): string {
  return `公開 branch ${branch} が公開先から消えています。この lane が最後に push した commit で PR が merge されたとも、PR が merge されずに閉じたとも確かめられないので、公開本流の上に出し直しません（branch を戻すか、PR の状態を確かめてください）`;
}
/** how long a checked submit waits for penne's approval on the card before it has to be checked again */
const APPROVAL_WINDOW_MS = 24 * 60 * 60_000;
/** a refusal that trying again does not lift: the destination, or the PR on it, has to change first */
export class PermanentSubmitError extends Error {}
export const proposalPath = (id: string) => recordPath("proposals", id);
export const custodyPath = (id: string) => recordPath("custody", id);
export function readProposal(id: string): ProposeRecord | null { return read<ProposeRecord>(proposalPath(id)); }
/** where a lane's receive of its base is recorded (written by receiveBase) */
export const baseReceiptPath = (id: string) => recordPath("base-receipts", id);
/**
 * Why the submit cannot yet be made for this lane: the submit still targets the area's public base and puts out a
 * single-parent commit, so it cannot carry a base. Until the submit side of a lane's base is in, a lane on another
 * base, and a lane that has ever received its base (recorded on the ledger or in a receipt, whatever its state),
 * are not submitted at all. Stopping too much is undone with the submit side.
 */
export function stackedSubmitBlocker(iddId: string, loc: LaneLocation): string | null {
  const events = readLifecycle().filter(e => e.idd_id === iddId);
  const set = events.filter(e => e.event === "lane_base_set").pop();
  const branch = set?.attrs?.branch;
  if (typeof branch === "string" && branch && branch !== loc.config.public_base) return `base が ${branch} の lane（積み重ねた PR）の提出は、提出の側の対応（plan の段 2）の実装待ちです`;
  if (events.some(e => e.event === "lane_base_received") || existsSync(baseReceiptPath(iddId))) {
    return "base と同期した lane の提出は、提出の側の対応（plan の段 2）の実装待ちです";
  }
  return null;
}
/**
 * Why a submit of the lane is in progress, or null: pushed with its PR not made yet, or prepared with its output
 * commit made (the push may have gone out; the card or the tick finds out by the public tip). Either goes on with
 * the token it was checked with, so the lane's branch and base must stay as they were checked until then.
 */
export function submitInFlight(iddId: string): string | null {
  const saved = readProposal(iddId);
  if (saved?.status === "pushed") return "push 済みで PR の作成が済んでいない提出があります。提出前確認のカードで PR まで済ませてから";
  if (saved?.status === "prepared" && saved.outputCommit) return "push したかもしれない提出（出力 commit を作った後の prepared）があります。提出前確認のカードか tick が push の有無を確かめて記録してから";
  return null;
}
export function laneLocations(iddId: string): LaneLocation | null {
  const rec = readBacklog().find(r => r.idd_id === iddId);
  if (!rec) return null;
  const config = readAreas().areas[rec.area];
  const session = readSessions("executor").filter(r => r.idd_id === iddId).pop() ?? readSessions("planner").filter(r => r.idd_id === iddId).pop();
  if (!config?.local_path || !config.upstream_path || !config.work_base || !config.public_base || !session?.worktree_path) return null;
  const custody = read<Custody>(custodyPath(iddId));
  return { work: session.worktree_path, upstream: config.upstream_path, branch: custody?.branch ?? session.branch, area: rec.area, config };
}
export function invalidateProposal(iddId: string): void {
  const saved = readProposal(iddId);
  if (saved && saved.status === "prepared") save(proposalPath(iddId), { ...saved, expiresAt: new Date(0).toISOString() });
}
/**
 * Why a saved submit no longer matches where the lane submits (the Git destination, the area's settings, the lane's
 * branch): its token cannot be used, and the submit is checked again under the settings as they are now. Null while
 * it matches. Reads only the local clone's configuration, not the remote.
 */
export function outdatedReason(saved: ProposeRecord, loc: LaneLocation): string | null {
  if (destination(loc.upstream).fingerprint !== saved.destination.fingerprint) return "Git の公開先が変更されました";
  if (key(loc.config) !== saved.configKey || loc.work !== saved.work || loc.upstream !== saved.upstream || loc.branch !== saved.branch) return "提出先の設定が変更されました";
  return null;
}
/**
 * For the tests only: the submit's checks, saved whatever stage the lane is at. The card and the tick save a submit
 * through `proposeAdmitted`, which asks the stage inside the lane gate; the package does not export this one.
 * `gone`: the lane's public branch is gone from the remote, and why (`GoneBranch`, the caller asked GitHub). The next
 * change then goes out on the branch again, over the public base: after a merge at what the lane last pushed, what
 * came after it; after a PR closed unmerged (or none), the lane's whole change.
 */
export async function proposeForTests(iddId: string, pr?: { title: string; body: string }, opts: { gone?: GoneBranch } = {}): Promise<ProposeView | { error: string }> {
  const loc = laneLocations(iddId);
  if (!loc) return { error: "lane と repo に作業本流・公開先を設定してください" };
  let release: (() => void) | undefined;
  try {
    // the lock is held across the checks and marks them (DEC-2325 / DEC-2327)
    release = lock(loc.work, { checks: true });
    const checked = await checkSubmit(iddId, loc, pr, opts);
    if ("kept" in checked) return checked.kept;
    save(proposalPath(iddId), checked.fresh);
    return checked.fresh;
  } catch (e) { return { error: (e as Error).message }; } finally { release?.(); }
}
/**
 * The submit's checks (`checkSubmit`, under the overlay lock), with a new submit saved only when `admit`, asked inside
 * the lane gate after the checks, finds nothing against it: a lane sent back while the checks ran (they take minutes)
 * gets no submit its old card could approve. `notSaved` says why nothing was saved: `admit` refused it, or the gate
 * stayed busy. `gone` is as for `proposeForTests`. The only way the card and the tick save a submit.
 */
export async function proposeAdmitted(iddId: string, pr: { title: string; body: string } | undefined, opts: { gone?: GoneBranch; admit: () => string | null }): Promise<ProposeView | { error: string; notSaved?: "refused" | "busy"; lockRefused?: true }> {
  const loc = laneLocations(iddId);
  if (!loc) return { error: "lane と repo に作業本流・公開先を設定してください" };
  let release: (() => void) | undefined;
  try {
    // the lock is held across the checks and marks them (DEC-2325 / DEC-2327)
    release = lock(loc.work, { checks: true });
    const checked = await checkSubmit(iddId, loc, pr, opts);
    if ("kept" in checked) return checked.kept;
    return await withLaneGate(async () => {
      const refusal = opts.admit();
      if (refusal) return { error: refusal, notSaved: "refused" as const };
      save(proposalPath(iddId), checked.fresh);
      return checked.fresh;
    });
  } catch (e) {
    if (isLaneGateBusy(e)) return { error: LANE_GATE_BUSY_MESSAGE, notSaved: "busy" };
    return { error: (e as Error).message, ...(isLockRefusal(e) ? { lockRefused: true as const } : {}) };
  } finally { release?.(); }
}
/** the tree a submit of a lane's head checks and puts out, and what it is built over (`submitTreeOf`) */
export interface SubmitTree {
  /** the lane's base on the work side: the custody's, or the merge-base with the work side's mainline */
  base: string;
  /** the lane's public branch's tip, null when it has none */
  targetTip: string | null;
  /** the public commit the tree is merged over and the publish is read against */
  target: string;
  /** the head's tree without the records */
  workTree: string;
  /** the head's tree merged over `target`, without the records */
  tree: string;
  /** the lane's public branch is gone, and why (as the caller passed it) */
  gone?: GoneBranch;
}
/**
 * The tree a submit of the lane's `head` checks and puts out, and what it is built over: the head's tree without the
 * records, merged over the public side (the lane's public branch when it has one, the public base's tip otherwise)
 * from the lane's base. The submit's checks run on `tree`, and so do the checks before the S2 loop converges
 * (`converge-check-run.ts`), so a result the one kept is the other's while the public side stays where it was. Fetches
 * the public side (into `refs/idd/<refSpace>/`, `public` unless the caller names another). Throws what stops the submit (a public branch to adopt or receive first, a gone branch GitHub did
 * not explain, a public side tracking a record's path, a conflict).
 */
export function submitTreeOf(iddId: string, loc: LaneLocation, head: string, manifestPaths: string[], opts: { gone?: GoneBranch; refSpace?: string } = {}): SubmitTree {
  const recorded = read<Custody>(custodyPath(iddId));
  const targetTip = remoteTip(loc.upstream, loc.branch);
  if (targetTip && !recorded) throw new Error("既存の公開 branch です。先に adopt で確認して接続してください");
  // a branch gone from the remote goes out again over the public base (a receive cannot fetch it). After a merge at
  // what the lane last pushed, the change since; after a PR closed unmerged or none, the whole change, as if the lane
  // had never pushed: its custody no longer says what the public side carries
  const gone = recorded && !targetTip && opts.gone && opts.gone.tip === recorded.publicTip ? opts.gone : undefined;
  if (recorded && !targetTip && !gone) throw new Error(goneUnknownReason(loc.branch));
  const custody = gone && !gone.merged ? null : recorded;
  const base = custody?.workHead ?? git(loc.work, ["merge-base", head, `refs/heads/${loc.config.work_base}`]).trim();
  if (custody && targetTip && targetTip !== custody.publicTip) throw new Error("公開 branch が更新されています。receive で未公開修正を保持して受け入れてください");
  const targetBranch = targetTip ? loc.branch : loc.config.public_base!;
  const target = fetchPublic(loc.work, loc.upstream, targetBranch, opts.refSpace);
  refuseOverlap(loc.work, target, manifestPaths, targetBranch, "提出");
  const workTree = filteredTree(loc.work, head, manifestPaths);
  const baseTree = custody?.workTree ?? filteredTree(loc.work, base, manifestPaths);
  let incoming = filteredTree(loc.work, target, manifestPaths);
  // merged at an earlier push than the lane's last (the lane pushed again after the merge): the public base carries
  // the branch only up to the merge, so the branch's commits after it go over the public base first
  if (gone?.merged && gone.mergedAt && gone.mergedAt !== gone.tip) {
    const after = mergeTrees(loc.work, filteredTree(loc.work, gone.mergedAt, manifestPaths), filteredTree(loc.work, gone.tip, manifestPaths), incoming);
    if (after.conflict) throw new Error("merge の後に push した変更が公開本流と衝突します。公開本流を受け入れて衝突を解消し、再確認してください");
    incoming = after.tree;
  }
  const merged = mergeTrees(loc.work, baseTree, workTree, incoming);
  if (merged.conflict) throw new Error("公開先と衝突します。receive で衝突を解消し、再確認してください");
  return { base, targetTip, target, workTree, tree: merged.tree, ...(gone ? { gone } : {}) };
}
/**
 * What the checks of a submit tree are told and compared with: the public base's tip the tree is built on (the target
 * itself, or under an existing branch the tip of the base it goes to; fetched), and the files the PR changes against
 * it, as CI sees them (on an existing branch, all of them, not only this increment; deletions left out).
 */
export function submitCheckBasis(loc: LaneLocation, built: SubmitTree, refSpace?: string): { publicBase: string; changed: string[] } {
  const publicBase = built.targetTip ? fetchPublic(loc.work, loc.upstream, loc.config.public_base!, refSpace) : built.target;
  const since = built.targetTip ? git(loc.work, ["merge-base", built.target, publicBase]).trim() : built.target;
  const changed = git(loc.work, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=d", since, built.tree]).split("\0").filter(Boolean);
  return { publicBase, changed };
}
/**
 * The checks of a submit, under the overlay lock the caller holds: the pushed submit kept as it is (`kept`), or the
 * new one, not saved yet (`fresh`). Throws what stops the submit.
 */
async function checkSubmit(iddId: string, loc: LaneLocation, pr: { title: string; body: string } | undefined, opts: { gone?: GoneBranch }): Promise<{ kept: ProposeRecord } | { fresh: ProposeRecord }> {
  if (laneHasEnded(iddId, readLifecycle())) throw new Error("終了した lane は提出できません");
  // the bottom-most refusal: a lane of a repo that does not publish never becomes a push and a PR, whatever entry
  // reached here (the card, the CLI, the tick). It is landed into the work side's mainline instead
  if (!publishes(loc.config)) throw new Error("公開しない repo の lane です。提出前確認の「work 側の本流へ merge する」から merge してください");
  const stacked = stackedSubmitBlocker(iddId, loc);
  if (stacked) throw new Error(stacked);
  const previous = readProposal(iddId);
  // a push waiting for its PR stays as it is on the same head: checking it again must not turn it into a new (local)
  // submit. Unless the destination or the settings changed since: its token is refused, and it is checked again.
  // Nor when its branch is gone: its push can take no PR, and the lane goes out again as a new push, or, when
  // GitHub did not say why it is gone, the check says why it does not (below) instead of handing the push back
  if (previous?.status === "pushed" && previous.head === sha(loc.work) && clean(loc.work) && !outdatedReason(previous, loc) && !opts.gone && remoteTip(loc.upstream, loc.branch) !== null) return { kept: previous };
  // a push waiting for its PR may be superseded by the next revision, once the push is the lane's received public tip
  if (previous?.status === "pushed" && read<Custody>(custodyPath(iddId))?.publicTip !== previous.outputCommit) throw new Error("push 済みの提出が残っています。同じ token で PR 処理を再試行してください");
  const manifest = readManifest(loc.work);
  if (manifest.issues.length) throw new Error(manifest.issues.map(i => i.reason).join(" / "));
  if (!clean(loc.work)) throw new Error("lane に未 commit の変更があります");
  const endpoint = destination(loc.upstream);
  const rec = readBacklog().find(r => r.idd_id === iddId)!;
  const prText = pr ?? { title: rec.title, body: "" };
  const head = sha(loc.work);
  const built = submitTreeOf(iddId, loc, head, manifest.paths, opts);
  const { base, targetTip, target, workTree, gone } = built;
  const publish = names(loc.work, target, built.tree);
  // a branch already on the public side carries its change until it is merged: nothing new over the branch is
  // still a submit while the branch differs from the public base (its open PR takes it as its revision, or a new PR does)
  const unmerged = !publish.length && targetTip ? names(loc.work, fetchPublic(loc.work, loc.upstream, loc.config.public_base!), built.tree) : [];
  // only a published commit has an author and a message on the public side; a local completion needs neither. The
  // message here is the repo's form of it, which the card starts from; the commit carries the one penne approves
  const published = publish.length ? { author: cloneIdentity(loc.upstream), commitMessage: commitMessageFor(loc.config.commit_message, iddId, rec, prText.title) } : {};
  const held = splitByManifest(manifest.paths, names(loc.work, base, head)).overlay;
  const checks = await runGate(loc.work, manifest, publish, []);
  const refs = overlayReferences(loc.work, built.tree, manifest.paths);
  checks.push({ name: "overlay-references", status: refs.length ? "fail" : "pass", severity: "non-blocking", ...(refs.length ? { detail: `公開側のファイルが記録側のパスを参照しています: ${describeReferences(refs)}` } : {}) });
  if (!loc.config.checks) checks.push({ name: "checks", status: "skipped", severity: "blocking", detail: "repo の検査設定がありません" });
  else {
    // the repo's heavy checks run one at a time: the submit takes the heavy-checks lock inside the overlay lock it holds
    // (overlay → heavy), from its first check to its last. The checks before the S2 loop converges take the heavy lock
    // alone and never the overlay lock, so neither waits for the other in a ring. A heavy lock another holds is a wait,
    // refused as a held overlay lock is. It is taken only when a check runs here (a submit whose public checks are all
    // kept passes takes none)
    let heavyRelease: (() => void) | undefined;
    const heavy = () => { heavyRelease ??= heavyLockOrRefuse(loc.work, `submit-${iddId}`); };
    try {
      const prep = readAreas().checkPrep?.[loc.area];
      const recordsChecks = loc.config.checks.filter(c => c.scope === "records");
      if (recordsChecks.length) heavy();
      checks.push(...await runChecks(loc.work, recordsChecks, { timeouts: prep?.timeouts, laneId: iddId }));
      const publicChecks = loc.config.checks.filter(c => c.scope !== "records");
      if (publish.length && publicChecks.length) {
        const { publicBase, changed } = submitCheckBasis(loc, built);
        // in a repo that runs its checks before the S2 loop converges, a check of this tree, definition and changed files
        // kept already (by those checks, or an earlier submit) is read, not run again: the Flutter test is 35 minutes. Only
        // what is missing runs, and is kept. A check of a head this submit already checked is penne's (or the tick's) ask
        // to check again: everything runs
        const reuse = convergeChecksOn(loc.area) && !(previous && previous.head === head);
        const kept = reuse ? readKeptResults(loc.area, built.tree, publicChecks, changed) : new Map<string, GateCheck>();
        const missing = publicChecks.filter((c) => !kept.has(c.name));
        if (missing.length || [...kept.values()].some((r) => r.status === "fail")) heavy();
        {
          let ran: GateCheck[] = [];
          if (missing.length) {
            const commit = commitTree(loc.work, built.tree, [], "submission checks");
            ran = await checkInCopy(loc.work, commit, missing, { area: loc.area, from: loc.config.local_path!, deps: join(loc.work, "node_modules"), changed });
            keepResults(loc.area, built.tree, missing, changed, ran, "submit");
          }
          const rows = [
            ...publicChecks.map((c) => kept.get(c.name) ?? ran.find((r) => r.name === c.name)).filter((r): r is GateCheck => !!r),
            ...ran.filter((r) => !publicChecks.some((c) => c.name === r.name)),
          ];
          // a required check that failed here is run again at the public base's tip without the records, still under the
          // overlay and heavy locks: two long checks of one repo (the Flutter test) never run side by side, so the card
          // tells the lane's failure from one it found there
          checks.push(...await withBaseComparison(rows, publicChecks, { area: loc.area, repo: loc.work, from: loc.config.local_path!, publicBase: () => publicBase, manifestPaths: manifest.paths }));
        }
      } else if (!publish.length) checks.push(...publicChecks.map(c => ({ name: c.name, status: "not-applicable" as const, severity: c.required ? "blocking" as const : "non-blocking" as const, detail: "公開差分なし" })));
    } finally { heavyRelease?.(); }
  }
  if (sha(loc.work) !== head || !clean(loc.work)) throw new Error("検査中に lane が変更されました");
  const commits = git(loc.work, ["log", "--reverse", "--format=%s", `${base}..${head}`]).trim().split("\n").filter(Boolean);
  // the practice the repo's declared commit form is read against: what the public side's recent commits look like
  const sinceLast = previous && previous.head === head ? compareChecks(previous, checks) : undefined;
  const precedents = publish.length && readAreas().commitConvention?.[loc.area] ? recentSubjects(loc.work, target) : undefined;
  // the rules the repo points at, as its public base has them (not as any working tree has them)
  const areas = readAreas();
  const pointers = areas.conventions?.[loc.area];
  const conventions = pointers ? readConventions(loc.work, fetchPublic(loc.work, loc.upstream, loc.config.public_base!), pointers, previous, head, draftedConventions(readLifecycle().filter((e) => e.idd_id === iddId), head)) : undefined;
  // asked whenever the submit is a publish: a branch that carries its change already has nothing new to publish and is still read against the practice
  const askedTitles = (publish.length || unmerged.length) && areas.commitConvention?.[loc.area];
  const mergedTitles = askedTitles ? await recentMergedTitles(loc.upstream, loc.config.linked_repo) : undefined;
  const record: ProposeRecord = {
    iddId, branch: loc.branch, base, work: loc.work, upstream: loc.upstream,
    repo: loc.config.linked_repo, workBase: loc.config.work_base ?? "",
    publish, held, commits, checks, blocking: blockingCount(checks), token: randomBytes(24).toString("base64url"),
    expiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString(), head, target, targetTip,
    destination: endpoint, mode: publish.length || unmerged.length ? "publish" : "local", pr: prText, ...published,
    ...(precedents ? { precedents } : {}),
    ...(conventions ? { conventions } : {}),
    ...(mergedTitles ? { mergedTitles } : {}),
    ...(askedTitles && !mergedTitles ? { mergedTitlesUnread: true as const } : {}),
    checkedAt: new Date().toISOString(), ...(sinceLast ? { sinceLast } : {}),
    ...(gone ? { branchGone: gone } : {}),
    diff: git(loc.work, ["diff", "--no-ext-diff", "--no-renames", target, built.tree]),
    configKey: key(loc.config), manifestKey: key(readFileSync(join(loc.work, "overlay.manifest"), "utf8")),
    publicTree: built.tree, workTree, status: "prepared",
  };
  return { fresh: record };
}
/** the subjects of the last public commits up to `tip` (merges left out), or none when they cannot be read */
function recentSubjects(cwd: string, tip: string): string[] {
  try {
    return git(cwd, ["log", "--no-merges", "-n", String(PRECEDENT_LIMIT), "--format=%s", tip]).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}
export function validateProposal(iddId: string, token: string): { saved: ProposeRecord; loc: LaneLocation } {
  const saved = readProposal(iddId);
  const loc = laneLocations(iddId);
  if (!saved || !loc || saved.token !== token) throw new Error("承認 token が一致しません。提出内容を再確認してください");
  if (saved.status === "complete") return { saved, loc };
  if (laneHasEnded(iddId, readLifecycle())) throw new Error("終了した lane は提出できません");
  const outdated = outdatedReason(saved, loc);
  if (outdated) throw new PermanentSubmitError(`${outdated}。提出前確認で検査し直してください`);
  // a lane on another base, or one that received its base, is not submitted (the card's approval and runShip come here)
  const stacked = saved.status === "prepared" ? stackedSubmitBlocker(iddId, loc) : null;
  if (stacked) throw new Error(stacked);
  if (saved.status === "prepared" && Date.parse(saved.expiresAt) < Date.now() && (!saved.outputCommit || remoteTip(loc.upstream, saved.branch) !== saved.outputCommit)) throw new Error("承認の期限が切れています");
  if (key(readFileSync(join(loc.work, "overlay.manifest"), "utf8")) !== saved.manifestKey || sha(loc.work) !== saved.head || !clean(loc.work)) throw new Error("承認対象が変更されました。再確認してください");
  if (saved.blocking || blockingCount(saved.checks)) throw new Error(`必須検査が完了していません: ${blockingSummary(saved.checks)}`);
  return { saved, loc };
}
/**
 * A prepared submit whose push reached the public branch (its commit is the branch's tip) but was not saved, and
 * whose token can no longer finish it (the lane's head moved, or the destination or the settings changed): the push
 * is put on record the way the export saves it, the custody first (it names the branch's tip) and then the record as
 * `pushed`, so the next check goes on from the push. A custody already at the push (a receive took it in) is kept.
 * Null when the record is not such a push any more. Throws when the lock is held (`overlay 処理中です`).
 */
export function settleUnsavedPush(iddId: string): ProposeRecord | null {
  const first = readProposal(iddId);
  if (first?.status !== "prepared" || !first.outputCommit) return null;
  const release = lock(first.work);
  try {
    const saved = readProposal(iddId);
    if (saved?.status !== "prepared" || !saved.outputCommit || remoteTip(saved.upstream, saved.branch) !== saved.outputCommit) return null;
    if (read<Custody>(custodyPath(iddId))?.publicTip !== saved.outputCommit) {
      save(custodyPath(iddId), { branch: saved.branch, publicTip: saved.outputCommit, workTree: saved.workTree, workHead: saved.head } satisfies Custody);
    }
    saved.status = "pushed";
    save(proposalPath(iddId), saved);
    return saved;
  } finally { release(); }
}
/** the public branch already carries exactly the checked tree (a fix only in the records): putting it on record pushes nothing */
export function carriesAlready(saved: ProposeRecord): boolean {
  return Boolean(saved.targetTip) && saved.status === "prepared" && tree(saved.work, saved.target) === saved.publicTree;
}
/**
 * The checks the export makes before a prepared submit goes out, on the public side as it is now: the destination, and
 * the branch (or, for a new branch, the public base) still where the check found it. Answers the branch's tip; a push
 * of this submit that already reached the branch passes. Throws why the submit has to be checked again. The export
 * makes them under the upstream's lock; the card's approval makes them first, so that it records only a push that
 * gets past them.
 */
export function pushTargetTip(saved: ProposeRecord, loc: LaneLocation): string | null {
  if (destination(loc.upstream).fingerprint !== saved.destination.fingerprint) throw new Error("Git の公開先が変更されました");
  const tip = remoteTip(loc.upstream, saved.branch);
  if (saved.outputCommit && tip === saved.outputCommit) return tip;
  if (tip !== saved.targetTip) throw new Error("公開 branch の先端が変わりました。再確認してください");
  // the check read the branch's tip and the fetched target at two moments: a branch that moved between them and came back
  // leaves a target that is not the tip, and a commit over the target would then replace the branch
  if (saved.targetTip && saved.targetTip !== saved.target) throw new Error("確認した公開 branch の先端と取得した先端が食い違っています。再確認してください");
  if (!tip && remoteTip(loc.upstream, loc.config.public_base!) !== saved.target) throw new Error("公開本流が更新されました。再確認してください");
  return tip;
}
/**
 * Push the submit's commit as it is: one commit over the public base for a branch's first push, and over the previous
 * push's tip after it. Never forced: a reviewer reads a review round as the difference from the head they saw, and a
 * replaced branch loses that. A branch whose tip has moved since the check, or a commit that does not sit on the
 * checked target, is not pushed.
 */
function pushIncrement(upstream: string, saved: ProposeRecord): void {
  const parents = git(upstream, ["rev-list", "--parents", "-n", "1", saved.outputCommit!]).trim().split(" ").slice(1);
  if (parents.length !== 1 || parents[0] !== saved.target) throw new Error("push する commit が確認した公開側の先端の上の 1 commit ではありません。再確認してください");
  if (remoteTip(upstream, saved.branch) !== (saved.targetTip ?? null)) throw new Error("公開 branch の先端が前回の push から動いています。押さずに止めました。再確認してください");
  // the lease's expected value is the commit's parent (empty: the branch must not exist yet), so the branch at the moment
  // of the push is the parent or the push is refused: what goes out is always a fast-forward, never a replacement. The
  // checked tip and the parent are read at two moments, so a branch that moved away and back must still be the parent.
  if (saved.targetTip && saved.targetTip !== saved.target) throw new Error("確認した公開 branch の先端と取得した先端が食い違っています。押さずに止めました。再確認してください");
  git(upstream, ["push", `--force-with-lease=refs/heads/${saved.branch}:${saved.targetTip ? saved.target : ""}`, "origin", `${saved.outputCommit}:refs/heads/${saved.branch}`]);
}
export interface ExportResult { ok: boolean; branch?: string; files?: number; commit?: string; error?: string; local?: boolean; /** the refusal was the signature's, not a failure of the push */ signature?: boolean }
/** what penne approved on the card for a push: without it, nothing new is pushed */
export interface PushApproved {
  message: string;
  /** a new PR's title and body, so the push's gate can rebuild what the same signature covered */
  pr?: { title: string; body: string };
  /** the one approval's signature: the gate rebuilds the content and compares it to what this nonce was verified for */
  nonce?: string;
}
/** what a submit card's approval carries into the content a signature is over */
export interface ShipApprovalContent { commitMessage?: string; pr?: { title: string; body: string } }
/**
 * The content a submit card's signature is over, built the same way by the challenge the page signs and by each gate
 * that is about to write (the push, the PR, and the posting): the lane, the destination, the checked public tree,
 * the commit message as the commit carries it, and a new PR's text.
 */
export function shipContentFor(iddId: string, saved: ProposeRecord, loc: LaneLocation, approval: ShipApprovalContent): Record<string, unknown> {
  return shipContent({
    iddId,
    repo: loc.config.linked_repo,
    branch: saved.branch,
    base: loc.config.public_base ?? "",
    publicTree: saved.publicTree,
    commitMessage: approvedCommitMessage(approval.commitMessage),
    pr: approval.pr ? { title: approval.pr.title, body: approval.pr.body } : null,
  });
}
/**
 * Push the checked submit, or finish one already out. `approved` carries the commit message penne approved on the
 * card; without it only a push that already reached the branch (or a branch that already carries the tree) is put
 * on record, and a submit that still needs a push is refused before anything is written.
 */
export function exportUnderWorkLock(iddId: string, token: string, approved?: PushApproved): ExportResult {
  let release: (() => void) | undefined;
  try {
    const { saved, loc } = validateProposal(iddId, token);
    // the same refusal at the export itself: a token cannot push a lane of a repo that does not publish
    if (!publishes(loc.config)) throw new Error("公開しない repo の lane は push しません。merge で本流へ入れます");
    if (saved.mode === "local") return { ok: false, error: "公開差分なし。local-complete を使ってください" };
    release = lock(loc.upstream);
    if (destination(loc.upstream).fingerprint !== saved.destination.fingerprint) throw new Error("Git の公開先が変更されました");
    if (saved.status === "complete") return { ok: true, branch: saved.branch, files: saved.publish.length, commit: saved.outputCommit };
    if (saved.status === "pushed") {
      save(custodyPath(iddId), { branch: saved.branch, publicTip: saved.outputCommit!, workTree: saved.workTree, workHead: saved.head } satisfies Custody);
      return { ok: true, branch: saved.branch, files: saved.publish.length, commit: saved.outputCommit };
    }
    const tip = pushTargetTip(saved, loc);
    if (saved.outputCommit && tip === saved.outputCommit) {
      saved.status = "pushed";
    } else {
      // the branch already carries exactly this tree (pushed before its PR): nothing to push, the tip is the submit
      if (tip && tree(loc.work, saved.target) === saved.publicTree) saved.outputCommit = tip;
      else {
        // a new commit on the public side goes out only with the commit message penne approved on the card
        const message = approvedCommitMessage(approved?.message);
        if (!message) throw new Error("承認なしの push はしません。提出前確認のカードで commit message を承認してください");
        // the gate: the push goes out only when the signature this approval carried was verified for exactly this
        // content. Rebuilt from what is about to be written, so no other entrance can push something else
        const gate = approvalGateOpen(approved?.nonce, shipContentFor(iddId, saved, loc, { commitMessage: message, pr: approved?.pr }));
        if (!gate.ok) throw new SignatureRefusedError(gate.reason);
        // a proposal saved before the author was part of what was approved is checked again
        if (!saved.author) throw new Error("この提出の確認は公開する commit の作者を含まない前の形です。再確認してください");
        // made again for this approval: an earlier commit that never reached the branch may carry another message
        saved.outputCommit = commitTree(loc.work, saved.publicTree, [saved.target], message, saved.author);
        saved.commitMessage = message;
      }
      save(proposalPath(iddId), saved);
      git(loc.upstream, ["fetch", "--no-tags", loc.work, saved.outputCommit]);
      const leaked = splitByManifest(readManifest(loc.work).paths, git(loc.upstream, ["ls-tree", "-r", "--name-only", "-z", saved.outputCommit]).split("\0").filter(Boolean)).overlay;
      if (leaked.length) throw new Error(`公開 tree に overlay が含まれます: ${leaked.join(", ")}`);
      if (saved.outputCommit !== tip) pushIncrement(loc.upstream, saved);
      saved.status = "pushed";
    }
    save(proposalPath(iddId), saved);
    save(custodyPath(iddId), { branch: saved.branch, publicTip: saved.outputCommit!, workTree: saved.workTree, workHead: saved.head } satisfies Custody);
    return { ok: true, branch: saved.branch, files: saved.publish.length, commit: saved.outputCommit };
  } catch (e) { return { ok: false, error: (e as Error).message, ...(e instanceof SignatureRefusedError ? { signature: true } : {}) }; } finally { release?.(); }
}

export function exportLane(iddId: string, token: string, approved?: PushApproved): ExportResult {
  let release: (() => void) | undefined;
  try {
    const loc = laneLocations(iddId);
    if (!loc) throw new Error("lane がありません");
    release = lock(loc.work);
    return exportUnderWorkLock(iddId, token, approved);
  } catch (e) { return { ok: false, error: (e as Error).message }; } finally { release?.(); }
}
