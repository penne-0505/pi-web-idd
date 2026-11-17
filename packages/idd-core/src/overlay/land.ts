import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { getAgentRunner } from "../agent/port.ts";
import { readAreas, publishes, closesOnLand, resolveAreaKey } from "../config/areas.ts";
import type { AreaCheck, AreaConfig } from "../config/areas.ts";
import type { GeneratedFiles } from "../config/generated.ts";
import { PROJECTION_MARK } from "../intent/projection.ts";
import { parseRenameDiff, placeMovesOf, type PlaceMove } from "../intent/rename.ts";
import { projectionViewFor, recordPlaceMoves, recordPlacesModule, type ProjectionView } from "../intent/store.ts";
import { linearIdentifierOf } from "../config/lane-names.ts";
import { deriveStage } from "../ledger/derive.ts";
import { laneAnswer } from "../intent/moonbit-fold.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { laneCriteria } from "../ledger/criteria.ts";
import { laneIntent } from "../plan/lane-intent.ts";
import { acStatesForLane, allCriteriaVerified, readWorkRows, workColumnPath } from "../plan/work-records.ts";
import { appendLifecycle, buildEnvelope, laneRejectedEnvelope, queueEnvelope, transition } from "../ledger/write.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";
import { isRecordPath } from "../plan/review-scope.ts";
import { consumeNonce, landContent, verifyApproval } from "../passkey.ts";
import { unreviewedChange } from "../plan/reviewed-head.ts";
import { driveLandSteps } from "../plan/land-step.ts";
import type { LandObserver, LandStep } from "../plan/land-step.ts";
import { custodyPath, laneLocations, readProposal, stackedSubmitBlocker, invalidateProposal } from "./export.ts";
import type { Custody, LaneLocation } from "./export.ts";
import { blockingWhy } from "./check-reason.ts";
import { generatedOnlyConflict, generatedPathsOf, generatedTouched, parseMergeTree, rebuildGenerated, type RebuildFailure } from "./generated.ts";
import type { CheckChange } from "./check-reason.ts";
import type { GateCheck } from "./gate.ts";
import { landCheckLimit, landRunChecking, runningLandRuns, startLandRun, stopLandRun } from "./land-run.ts";
import type { LandCheckRun } from "./land-run.ts";
import { readManifest } from "./manifest.ts";
import { STRUCTURE_ROW_PREFIX } from "./structure.ts";
import { attempt, clean, commitTree, dirtyPaths, filteredTree, git, key, lock, lockRefusal, mergeTrees, names, read, recordPath, save, sha, tree, treeFromIndex } from "./git.ts";

/**
 * The record of one lane's landing into the work side's mainline. A repo that writes `publish: false` is not
 * pushed: its lane's change (code and records) is merged into the work branch with a merge commit whose parents
 * are the mainline tip and the lane's head, the merge is checked in a detached copy, and penne approves the merge
 * on the submit card. The record carries the checked merge commit and the checks, so the card can show them and the
 * approval can go to the merge it saw.
 */
export interface LandRecord {
  iddId: string;
  branch: string;
  head: string;
  workBase: string;
  /** the repo the merge goes to (owner/name), part of the content penne's signature covers */
  repo?: string;
  mainTip: string;
  /** the checked merge commit (two parents: mainTip and head); absent when the merge could not be made */
  mergeCommit?: string;
  checks: GateCheck[];
  blocking: number;
  token: string;
  expiresAt: string;
  configKey: string;
  /**
   * the fingerprint of the declarations a check's answer depends on that are not in the settings hash: the repo's
   * `increments` and `checkPrep` of this area. A record checked under other declarations has no result for a check
   * they added, so nothing is taken over and the whole group is checked again (C-193-1).
   */
  declaredKey?: string;
  status: "prepared" | "merged" | "complete";
  /** why the land cannot be made now (a dirty checkout, an open branch, a broken manifest); shown on the card */
  reason?: string;
  /** the files the lane and the mainline both changed, when the merge conflicts */
  conflict?: string[];
  /**
   * why the generated files could not be made again for this landing, and whether the environment or the build is to
   * blame. A record that carries it has no merge commit and a `reason`: the landing is not checked and not
   * approved as one that was rebuilt. The tick reads it as the failure of this group — tried again for the environment,
   * sent back once for the build — and the card reads it to say what to mend.
   */
  rebuildFailure?: RebuildFailure;
  /**
   * the checked results this record's tree took over from a check at an earlier mainline tip, and the tip they were
   * really run at. Present only when the mainline's change since then met the lane's change nowhere (C-193-1). The
   * carried checks say the same in their own detail, so the card reads it without a field of its own (C-193-5).
   */
  inherit?: LandInherit;
  /**
   * the GitHub Issue this landing's approval closes: the destination and the one-liner the signature covers. Absent
   * when the close goes elsewhere (the repo's land.close_issue is false) or when nothing is closed (a Linear lane).
   */
  close?: LandClose;
  /** the lane's GitHub Issue whose close goes to an outbound card instead (land.close_issue is false) */
  closeCard?: { repo: string; issue: number; url: string };
  /**
   * when the checks of this record ran, and whether they found what the checks of the same head before them found
   * (compared by the submit's rule). Written only by a run that ran checks: a refusal before any check carries neither,
   * and a record from before them has none, which the new screen's card reads as no line (C-219-5).
   */
  checkedAt?: string;
  sinceLast?: CheckChange;
  /**
   * the tests the checks of the round before this one failed on, by check, when that round checked the same head at the
   * same mainline tip under the same check config and declaration. A round that left no names (it was cut, the first, or of another group) leaves none, and the
   * reader takes that as no earlier round to compare with.
   */
  earlierFailed?: { name: string; tests: string[] }[];
  /**
   * the batch this lane landed in, when it went in with others under one signature and one check (C-247-8): the batch's
   * id, the one merge commit its run checked, the run, and the commit of this lane's own step in the chain. The lane's
   * `mergeCommit` is that step, whose tree is a prefix of the tree the run checked.
   */
  batch?: { id: string; mergeCommit: string; runId?: string; checkedAt?: string };
}

/**
 * The checked results a fresh landing check takes over from a check at an earlier mainline tip: the tip and merge
 * commit they were run at, and the checks (each carrying that tip in its detail). Only the code side's checks are
 * carried: the records checks read `_docs/`, which moves at every landing, so they run again (C-193-4).
 */
export interface LandInherit {
  /** the mainline tip the carried results were really run at (the first of a run of handovers, not the latest) */
  mainTip: string;
  /** the merge commit those results were checked in */
  mergeCommit?: string;
  /** the checks whose results carry over */
  checks: GateCheck[];
}

/**
 * What a fresh landing at a moved mainline tip takes over from the record of an earlier tip: the carried checks, the
 * checks to run again (the repo's `scope: records` ones), and the token and window the record keeps (C-193-2).
 */
export interface LandHandover {
  inherit: LandInherit;
  /** the checks to run at the new merge commit: the repo's records scope ones */
  run: AreaCheck[];
  /** the approval token an open card holds: a rebuilt one would refuse that card's approval */
  token: string;
  expiresAt: string;
}

/** the GitHub Issue a landing closes with the same approval, and the one-liner posted with the close */
export interface LandClose {
  repo: string;
  issue: number;
  url: string;
  comment: string;
}

export const landPath = (id: string) => recordPath("land", id);
export function readLand(id: string): LandRecord | null { return read<LandRecord>(landPath(id)); }

/**
 * The changed files and trial merges of the lanes that share a work clone, kept between ticks so a card is not built
 * from a fresh trial merge every time. The mainline tip and every card's head are kept with it, so a stale forecast is
 * not shown.
 */
export interface LandForecastGroup {
  /** the work clone the mainline and the lanes are read in */
  repo: string;
  workBase: string;
  /** the work mainline's tip the forecast was taken at */
  mainTip: string;
  /** each card's lane head at that moment */
  heads: Record<string, string>;
  /** each lane's changed files from the mainline (a rename kept as a delete and an add) */
  files: Record<string, string[]>;
  /** each lane's trial merge against the mainline tip */
  mainline: Record<string, { conflict: boolean; files: string[] }>;
  /** only the pairs whose changed files overlap; the key is `pairKey` */
  pairs: Record<string, { conflict: boolean; files: string[] }>;
}

/** one lane's conflict forecast: the mainline as it is, and the cards that would conflict if they landed first */
export interface LandForecast {
  mainline: { conflict: boolean; files: string[] };
  others: { lane: string; conflict: boolean; files: string[] }[];
}

/** the key of a pair of lanes in a forecast group, order-independent */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("\u0000");
}

/** how many trial merges and changed-file reads the forecasts of this process took (the tests count them) */
export const landForecastCounts = { merges: 0, files: 0 };

export function forecastPath(repo: string): string { return recordPath("land-forecast", repo); }
export function readLandForecast(repo: string): LandForecastGroup | null { return read<LandForecastGroup>(forecastPath(repo)); }
export function saveLandForecast(group: LandForecastGroup): void { save(forecastPath(group.repo), group); }
export function clearLandForecast(repo: string): void { rmSync(forecastPath(repo), { force: true }); }

/** the work mainline's tip, read from the branch's ref without touching any checkout */
export function mainlineTip(work: string, workBase: string): string | null {
  const out = attempt(work, ["rev-parse", `refs/heads/${workBase}`]);
  return out ? out.trim() : null;
}

/** the files a lane changed from the mainline, read-only (a rename kept as a delete and an add) */
export function laneChangedFiles(work: string, mainTip: string, head: string): string[] | null {
  landForecastCounts.files += 1;
  const out = attempt(work, ["diff", "--no-renames", "--name-only", "-z", `${mainTip}...${head}`]);
  return out === null ? null : out.split("\0").filter(Boolean);
}

/** a read-only trial merge of two commits: whether it conflicts and the files it could not take */
export function trialMerge(work: string, left: string, right: string): { conflict: boolean; files: string[] } | null {
  landForecastCounts.merges += 1;
  try {
    git(work, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", left, right]);
  } catch (e) {
    const found = parseMergeTree(String((e as { stdout?: string }).stdout ?? ""));
    return found ? { conflict: true, files: found.files } : null;
  }
  return { conflict: false, files: [] };
}

/** the generated files the repo cloned at `repo` declares for its work branch: the declaration a saved forecast is read against */
function generatedOfRepo(repo: string, workBase: string): GeneratedFiles[] {
  const declared = readAreas();
  return Object.entries(declared.areas)
    .filter(([, area]) => area.local_path === repo && area.work_base === workBase && !publishes(area))
    .flatMap(([name]) => declared.generatedFiles?.[name] ?? []);
}

/**
 * A trial merge as the card shows it: a conflict on declared generated files alone is none, because the landing makes
 * them again from the merged sources (C-266-3). It is read here, on the way out, so a forecast saved before the
 * declaration was read this way (or before it was written) shows the same as one taken now.
 */
function shown(merge: { conflict: boolean; files: string[] } | undefined, generated: GeneratedFiles[]): { conflict: boolean; files: string[] } {
  if (!merge) return { conflict: false, files: [] };
  return merge.conflict && generatedOnlyConflict(merge.files, generated) ? { conflict: false, files: [] } : merge;
}

/** the saved forecast of a lane, when it was taken at exactly this head and mainline tip (else undefined) */
export function landForecastFor(group: LandForecastGroup, iddId: string, head: string, mainTip: string, declared?: GeneratedFiles[]): LandForecast | undefined {
  if (group.mainTip !== mainTip) return undefined;
  if (group.heads[iddId] !== head) return undefined;
  const lanes = Object.keys(group.heads);
  if (lanes.length < 2) return undefined;
  // the lane's own mainline result is the one taken at this tip: without it the saved forecast is not shown
  // (a missing pair result, by contrast, is a pair whose files do not overlap: no conflict) (DEC-2401)
  const mainline = group.mainline[iddId];
  if (!mainline) return undefined;
  const generated = declared ?? generatedOfRepo(group.repo, group.workBase);
  return {
    mainline: shown(mainline, generated),
    others: lanes.filter((l) => l !== iddId).map((lane) => ({ lane, ...shown(group.pairs[pairKey(iddId, lane)], generated) })),
  };
}

/**
 * The content penne's signature is over for a landing: the lane, the repo, the work side's mainline branch, the
 * checked lane head and the Issue close it carries. The challenge the page signs and the approval both build it
 * here, so a signature cannot carry another lane, another repo or another head.
 */
export function landContentFor(saved: LandRecord): Record<string, unknown> {
  return landContent({
    iddId: saved.iddId, repo: saved.repo ?? "", workBase: saved.workBase, head: saved.head,
    close: saved.close ? { repo: saved.close.repo, issue: saved.close.issue, comment: saved.close.comment } : null,
  });
}

/** the saved land when it was checked for exactly the lane head and mainline tip as they are now, or null */
export function landCheckedAt(iddId: string, loc: LaneLocation): LandRecord | null {
  const saved = landOfHead(iddId, loc);
  return saved && saved.mainTip === mainlineTip(loc.config.local_path!, loc.config.work_base!) ? saved : null;
}

/**
 * The saved land of exactly this lane head and these declarations, whatever mainline tip it was checked at, when it
 * stands for a check that was not set aside: it is what a record that fell at an earlier tip still says about the head.
 */
function landOfHead(iddId: string, loc: LaneLocation): LandRecord | null {
  const saved = readLand(iddId);
  if (saved?.status !== "prepared" || !(saved.mergeCommit || unbuilt(saved))) return null;
  // a record from before the failure was kept apart carries a merge commit made from sources that were not rebuilt: it
  // stands for no check, so the tick plans the group again as it is read now
  if (carriesOldRebuildFailure(saved)) return null;
  if (saved.head !== sha(loc.work) || key(loc.config) !== saved.configKey) return null;
  // a record checked under other declarations (an increment or a checkPrep added since) is not the check this group
  // needs: the tick checks the whole group again (C-193-1). A record from before the fingerprint is not taken as one
  if (!saved.declaredKey || saved.declaredKey !== landDeclarationKey(loc.area)) return null;
  return saved;
}

/**
 * Whether the record stands for a landing whose generated files could not be made again: it has the failure and no merge
 * commit, so nothing was checked and nothing can be approved. A conflict record is no such landing.
 */
function unbuilt(saved: LandRecord): boolean {
  return !!saved.rebuildFailure && !saved.mergeCommit && !saved.conflict?.length;
}

/**
 * Whether the record is one written before a failure to rebuild was kept apart: it has the failure and a merge commit
 * that was checked as it was, though its generated files were never made again. Nothing writes this shape now, but one
 * inside its approval window must not be approved, handed over or merged: it is planned and checked again.
 */
function carriesOldRebuildFailure(saved: LandRecord): boolean {
  return !!saved.rebuildFailure && !!saved.mergeCommit;
}

/**
 * The saved land of this lane head when the mainline has moved since it was checked: it no longer fits the tip, so
 * `landCheckedAt` has none, but a count that grew in the head's tree is still the head's (C-253-2).
 */
export function landBehindAt(iddId: string, loc: LaneLocation): LandRecord | null {
  const saved = landOfHead(iddId, loc);
  if (!saved) return null;
  // the tip is the work_base ref `landCheckedAt` reads, so a checkout left on another branch moves neither of them, and
  // a mainline wound back behind the record's tip is no tip the record fell behind
  const main = loc.config.local_path!;
  const tip = mainlineTip(main, loc.config.work_base!);
  if (!tip || saved.mainTip === tip) return null;
  return attempt(main, ["merge-base", "--is-ancestor", saved.mainTip, tip]) !== null ? saved : null;
}

/**
 * The fingerprint of the declarations of one area that a check's answer depends on but the settings hash does not carry:
 * the counts a landing may not increase (`increments`) and how a copy is made ready (`checkPrep`). A check added to
 * either is a check no earlier record has a result for, so the handover and the reuse of a checked group both read it
 * (C-193-1). The fingerprint is one value, so the card, the record and the tick read the same answer.
 */
export function landDeclarationKey(area: string, areas: ReturnType<typeof readAreas> = readAreas()): string {
  // the checks an increment's run answers are part of the fingerprint only when there are some: an area that declares
  // none keeps the key it had, and a record made before a share changed is no result for the checks the share now names
  const shares = areas.incrementShares?.[area];
  return key({ increments: areas.increments?.[area] ?? [], prep: areas.checkPrep?.[area] ?? null, ...(shares && Object.keys(shares).length ? { shares } : {}) });
}

/** a checked land that passes and still waits for penne's approval on the card */
export function landReadyAt(iddId: string, loc: LaneLocation): LandRecord | null {
  const saved = landCheckedAt(iddId, loc);
  return saved && !saved.reason && saved.blocking === 0 && !saved.rebuildFailure && Date.parse(saved.expiresAt) > Date.now() ? saved : null;
}

/**
 * The line an inherited check carries in its detail: which earlier mainline tip its result was taken at. The one place
 * the mark is written, so the card's check list, the record and the lifecycle say the same (C-193-5).
 */
export function inheritMarkOf(mainTip: string, mergeCommit?: string): string {
  return `前回の本流 ${mainTip.slice(0, 7)}${mergeCommit ? `（merge ${mergeCommit.slice(0, 7)}）` : ""} の結果を引き継ぎました`;
}

/** a check whose detail starts with the mark: what it found is kept after it */
function markedCheck(check: GateCheck, mark: string): GateCheck {
  return { ...check, detail: [mark, check.detail].filter(Boolean).join("\n") };
}

/** the place a changed path at the top of the tree belongs to: the root is one place, not one per file */
export const ROOT_PLACE = "./";

/**
 * The place a changed path is judged by, for whether the mainline's change meets the lane's (C-193-3): a package, a
 * top-level dir, or the root (a file at the top of the tree is judged with the root, so a lane's `app.txt` and the
 * mainline's `main.txt` meet there). A `_docs/` path has no place: the records move at every landing whatever the code
 * does, and the records checks run again instead.
 */
export function landPlaceOf(path: string): string | null {
  if (path === "_docs" || path.startsWith("_docs/")) return null;
  const parts = path.split("/");
  if (parts.length === 1) return ROOT_PLACE;
  if (parts[0] === "packages" && parts.length > 2) return `packages/${parts[1]}/`;
  return `${parts[0]}/`;
}

/** the place of the dir the packages sit in: a file directly under it belongs to no one package */
const PACKAGES_PLACE = "packages/";

/** whether one place of the right side meets any place of the left side; a file under `packages/` meets every package */
function placeMeets(places: Set<string>, place: string): boolean {
  if (places.has(place)) return true;
  if (place === PACKAGES_PLACE) return [...places].some((p) => p.startsWith(PACKAGES_PLACE));
  return place.startsWith(PACKAGES_PLACE) && places.has(PACKAGES_PLACE);
}

/** whether the two sides' changed files share a place; a side whose paths are all `_docs/` shares none */
function placesMeet(left: string[], right: string[]): boolean {
  const places = new Set(left.map(landPlaceOf).filter((p): p is string => p !== null));
  return right.some((path) => {
    const place = landPlaceOf(path);
    return place !== null && placeMeets(places, place);
  });
}

/**
 * Whether a change reaches a root file that is not a record: a `tsconfig.json`, a `package.json`, a lint config or a
 * lockfile at the top of the tree is what the checks of the code side read wherever they run, so a mainline change to
 * one of them meets every place of the lane's change however far apart the two diff files are (C-193-3). A record at
 * the root (the TODO, a Markdown file) is read by the records checks only, which run again at the new tip.
 */
function rootSettingTouched(files: string[]): boolean {
  return files.some((path) => landPlaceOf(path) === ROOT_PLACE && !isRecordPath(path));
}

/**
 * The files the checks of the code side read wherever they run, whichever place the two sides changed: a root
 * `package.json` and its lockfiles, a `tsconfig`, an eslint config, `config/repos.yaml` (the checks' own definition) and
 * `packages/idd-lane/` (the runner that runs them). A change to one of them on either side meets every place of the
 * other side, because what a code check answers can change without a file near the lane's change being touched
 * (C-193-3). Only these names count on the lane's side: its own arbitrary root file is not a setting.
 */
const SHARED_SETTING = /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|bun\.lock|bun\.lockb|yarn\.lock|pnpm-lock\.yaml|tsconfig[^/]*\.json|eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.[^/]+)?|\.eslintignore|config\/repos\.yaml|packages\/idd-lane\/)/;

function sharedSettingTouched(files: string[]): boolean {
  return files.some((path) => SHARED_SETTING.test(path));
}

/** one place as a revision holds it: the name it declares (a place without a `package.json` declares none) and the `@idd/*` places it depends on */
interface PlaceEntry { name?: string; deps: string[] }

/**
 * The places of one revision that name themselves and declare `@idd/*` dependencies — the root (its `package.json`) and
 * every `packages/<name>/` — by the place they are: null when the tree cannot be read (an unreadable `package.json`
 * may hold the edge the question turns on, so it is taken as meeting). The root is read too, so a dependency declared
 * at the top of the tree counts as a read of the package it names.
 */
function iddPackagesAt(main: string, rev: string): Map<string, PlaceEntry> | null {
  const out = new Map<string, PlaceEntry>();
  const readOne = (place: string, path: string): boolean => {
    // a place without a `package.json` declares nothing
    if (attempt(main, ["cat-file", "-e", path]) === null) { out.set(place, { deps: [] }); return true; }
    const text = attempt(main, ["show", path]);
    if (text === null) return false;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return false; }
    const pkg = (parsed ?? {}) as { name?: unknown; dependencies?: unknown };
    const declared = pkg.dependencies && typeof pkg.dependencies === "object" ? Object.keys(pkg.dependencies) : [];
    out.set(place, { ...(typeof pkg.name === "string" ? { name: pkg.name } : {}), deps: declared.filter((d) => d.startsWith("@idd/")) });
    return true;
  };
  if (!readOne(ROOT_PLACE, `${rev}:package.json`)) return null;
  // `ls-tree` of a path the revision does not have is empty, not a failure: a revision without packages declares none
  const listed = attempt(main, ["ls-tree", "-z", "--name-only", rev, PACKAGES_PLACE]);
  if (listed === null) return null;
  const dirs = listed.split("\0").filter(Boolean).map((p) => p.slice(PACKAGES_PLACE.length)).filter((p) => p && !p.includes("/"));
  for (const dirName of dirs) {
    if (!readOne(`packages/${dirName}/`, `${rev}:${PACKAGES_PLACE}${dirName}/package.json`)) return null;
  }
  return out;
}

/** one alias a `tsconfig` declares: the specifier it starts (`*` for the rest), and where the rest lands from the tree's top */
interface PathAlias { prefix: string; target: string; dir: string; exact: boolean }

/** a specifier as one `git grep` alternative: the characters of a regex the alias may hold are taken literally */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** where an `extends` of one tsconfig reads its base from, as a path in the tree, or null when the base cannot be read */
function aliasBaseAt(main: string, rev: string, from: string, spec: string): string | null {
  // a base read from a package is not in the tree (node_modules is not committed): taken as unread, so the sides meet
  if (!spec.startsWith(".")) return null;
  const base = posix.normalize(posix.join(from, spec));
  if (base === ".." || base.startsWith("../") || posix.isAbsolute(base)) return null;
  for (const path of [base, `${base}.json`, posix.join(base, "tsconfig.json")]) {
    if (attempt(main, ["cat-file", "-e", `${rev}:${path}`]) !== null) return path;
  }
  return null;
}

/**
 * The aliases a revision's root `tsconfig.json` declares (`compilerOptions.paths`, through the `extends` chain it takes
 * them from), each as the specifier it starts and where the rest lands from the tree's top: the shape `@/components/x`
 * that names `components/` rather than a relative path (C-193-3). A revision without a root tsconfig aliases nothing;
 * a tsconfig that cannot be read, an `extends` its base cannot be read from, or a `paths` shape this reading does not
 * model is null, so the sides are taken as meeting.
 */
function pathAliasesAt(main: string, rev: string): PathAlias[] | null {
  const seen = new Set<string>();
  const readOne = (path: string, depth: number): PathAlias[] | null => {
    if (depth > 8 || seen.has(path)) return [];
    seen.add(path);
    const text = attempt(main, ["show", `${rev}:${path}`]);
    if (text === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return null; }
    const doc = (parsed ?? {}) as { compilerOptions?: unknown; extends?: unknown };
    const options = (doc.compilerOptions && typeof doc.compilerOptions === "object" ? doc.compilerOptions : {}) as { baseUrl?: unknown; paths?: unknown };
    const dir = posix.dirname(path);
    // the chain first: this file's own `paths` are set over the base it takes them from
    const out = new Map<string, PathAlias>();
    const bases = typeof doc.extends === "string" ? [doc.extends] : Array.isArray(doc.extends) ? doc.extends : [];
    for (const extend of bases) {
      if (typeof extend !== "string") return null;
      const base = aliasBaseAt(main, rev, dir, extend);
      if (base === null) return null;
      const inherited = readOne(base, depth + 1);
      if (inherited === null) return null;
      for (const alias of inherited) out.set(`${alias.prefix}${alias.exact ? "" : "*"}`, alias);
    }
    // `paths` are resolved from `baseUrl` when it is given, from the tsconfig's own dir otherwise
    const base = typeof options.baseUrl === "string" ? posix.join(dir, options.baseUrl) : dir;
    const paths = options.paths && typeof options.paths === "object" ? options.paths as Record<string, unknown> : {};
    for (const [pattern, targets] of Object.entries(paths)) {
      const target = Array.isArray(targets) ? targets[0] : targets;
      if (typeof target !== "string") return null;
      const star = pattern.indexOf("*");
      // only a prefix of a specifier is modelled; another shape is one this reading cannot follow
      if (star !== -1 && star !== pattern.length - 1) return null;
      const prefix = star === -1 ? pattern : pattern.slice(0, -1);
      if (!prefix || prefix.includes("*")) return null;
      out.set(pattern, { prefix, target, dir: base, exact: star === -1 });
    }
    return [...out.values()];
  };
  // a revision without a root tsconfig aliases nothing (it is not an unreadable one)
  if (attempt(main, ["cat-file", "-e", `${rev}:tsconfig.json`]) === null) return [];
  return readOne("tsconfig.json", 0);
}

/**
 * The places one revision's code reads other places from, over the whole tree: a relative module specifier that resolves
 * into another place, an `@idd/*` module specifier that names a place, and a specifier a root `tsconfig` aliases into
 * another place (`@/components/x` naming `components/`) (C-193-3). Read in one `git grep`, so a file outside `packages/`
 * that reads a package is a read of that package too: the edge the places alone cannot see. Null when the tree cannot be
 * read, so the sides are taken as meeting.
 */
function packageReadEdgesAt(main: string, rev: string, placeOfDep: (dep: string) => string | undefined, aliases: PathAlias[]): { from: string; to: string }[] | null {
  // the shape of every specifier this reading resolves: the tree's own paths, an `@idd` name, and the aliases' prefixes
  const prefixes = [...new Set(aliases.map((a) => a.prefix))].sort((a, b) => b.length - a.length);
  const shapes = ["\\.\\.?/", "@idd/", ...prefixes.map(escapeRe)].join("|");
  let out: string;
  try {
    // every module specifier of any of those shapes, in one read (`./...` and `../...` as code writes them)
    out = git(main, ["-c", "core.quotePath=false", "grep", "-n", "-I", "-o", "-E", `['"](${shapes})[^'"]*['"]`, rev]);
  } catch (e) {
    // git grep exits 1 when nothing matches: a tree with no read across places, not a tree that cannot be read
    if ((e as { status?: number }).status === 1) return [];
    return null;
  }
  const edges: { from: string; to: string }[] = [];
  for (const line of out.split("\n")) {
    // `<rev>:<path>:<line>:<match>`
    const row = /^([^:]+):([^:]+):\d+:(.*)$/.exec(line);
    if (!row) continue;
    const path = row[2];
    const from = landPlaceOf(path);
    if (from === null) continue;
    const spec = /['"]([^'"]+)['"]/.exec(row[3])?.[1];
    if (!spec) continue;
    const alias = aliases.find((a) => (a.exact ? spec === a.prefix : spec.startsWith(a.prefix)));
    let to: string | null;
    if (alias) {
      // the rest of the specifier lands where the alias puts it, from the tree's top
      const rest = alias.exact ? "" : spec.slice(alias.prefix.length);
      const landed = posix.normalize(posix.join(alias.dir, alias.target.replace("*", rest)));
      to = landed === ".." || landed.startsWith("../") || posix.isAbsolute(landed) ? null : landPlaceOf(landed);
    } else if (spec.startsWith("@idd/")) {
      to = placeOfDep(spec) ?? null;
    } else if (spec.startsWith("./") || spec.startsWith("../")) {
      // the import resolves from the importing file's dir (no extension to add); a specifier that climbs out of the
      // tree reads nothing in it
      const landed = posix.normalize(posix.join(posix.dirname(path), spec));
      to = landed === ".." || landed.startsWith("../") || posix.isAbsolute(landed) ? null : landPlaceOf(landed);
    } else {
      to = null;
    }
    if (to === null || to === from) continue;
    edges.push({ from, to });
  }
  return edges;
}

/**
 * Whether the mainline's change and the lane's change reach each other through the places they depend on: a place the
 * mainline changed is read by every place that declares a dependency on it or imports it, so a lane changing one of
 * those is checked again (C-193-3, the direction the places alone cannot see). The edges are the `@idd/*` dependencies
 * (of every `packages/<name>/` and of the root) and the module specifiers the tree's code reads, both from and to a
 * place, read at every tip the question turns on (the tip the record was taken at, the tip the mainline has now, the
 * lane head) and walked as one undirected graph: a change to either end of an edge meets a change to the other.
 * Reading the tips together means an edge the mainline added since the last check still counts, a name resolved at
 * any of them still finds the place that holds it, and a `tsconfig` alias declared at any of them still resolves the
 * specifier it names. An alias read from a tsconfig that cannot be read is a question this reading cannot answer, so
 * the sides are taken as meeting.
 */
function dependencyMeets(main: string, mainChanged: string[], laneChanged: string[], revisions: string[]): boolean {
  const lanePlaces = new Set(laneChanged.map(landPlaceOf).filter((p): p is string => p !== null));
  const mainPlaces = new Set(mainChanged.map(landPlaceOf).filter((p): p is string => p !== null));
  if (!lanePlaces.size || !mainPlaces.size) return false;
  const tips = [...new Set(revisions)];
  const graphs = tips.map((rev) => iddPackagesAt(main, rev));
  if (graphs.some((g) => g === null)) return true;
  const known = graphs as Map<string, PlaceEntry>[];
  // a dependency's name to the place that holds it, by the name a place declares and by the dir's own name
  const placeOfDep = (dep: string): string | undefined => {
    for (const g of known) for (const [place, entry] of g) if (entry.name === dep) return place;
    const bare = dep.slice("@idd/".length);
    for (const g of known) {
      for (const place of [`packages/${bare}/`, `packages/idd-${bare}/`]) if (g.has(place)) return place;
    }
    return undefined;
  };
  // the aliases of every tip, read together: a specifier any of them resolves is a read of the place it names there
  const aliasLists = tips.map((rev) => pathAliasesAt(main, rev));
  if (aliasLists.some((a) => a === null)) return true;
  const aliases = new Map<string, PathAlias>();
  for (const list of aliasLists as PathAlias[][]) for (const alias of list) aliases.set(`${alias.prefix}${alias.exact ? "" : "*"}|${alias.dir}|${alias.target}`, alias);
  const knownAliases = [...aliases.values()];
  const reads = tips.map((rev) => packageReadEdgesAt(main, rev, placeOfDep, knownAliases));
  if (reads.some((r) => r === null)) return true;
  const edges = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const set = edges.get(from) ?? new Set<string>();
      set.add(to);
      edges.set(from, set);
    }
  };
  for (const g of known) for (const [place, entry] of g) for (const dep of entry.deps) {
    const to = placeOfDep(dep);
    if (to !== undefined && to !== place) link(place, to);
  }
  for (const list of reads as { from: string; to: string }[][]) for (const edge of list) link(edge.from, edge.to);
  const seen = new Set(lanePlaces);
  const queue = [...lanePlaces];
  while (queue.length) {
    const at = queue.shift()!;
    for (const next of edges.get(at) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return [...mainPlaces].some((p) => seen.has(p));
}

/** the files a diff names (two commits, or one three-dot range), or null when git cannot answer */
function diffNames(cwd: string, range: string[]): string[] | null {
  const out = attempt(cwd, ["diff", "--no-renames", "--name-only", "-z", ...range]);
  return out === null ? null : out.split("\0").filter(Boolean);
}

/**
 * What a landing at the mainline tip as it is now may take over from the lane's last checked record, or null when it
 * may take nothing over: the record has to be of this lane head, these settings and these declarations (the repo's
 * `increments` and `checkPrep`), it has to have a result for every check of the code side the repo declares now, it has
 * to have passed and still be inside its approval window, and the mainline's change from the tip it was taken at has to
 * meet the lane's change nowhere (C-193-1, C-193-3). A record that is not read (no record, a failed one, an expired one,
 * another head, settings or declarations, a tip git cannot walk) is no handover at all: every check runs again. A
 * mainline change to a root setting meets every place, because it can change what every code check answers; a mainline
 * change to a root record alone does not, because only the records checks read it and those run again at the new tip.
 * Two changes meet as well when the places they touch depend on or import each other, read at the tip the record was
 * taken at, the mainline tip and the lane head so an edge the mainline added since still counts, or when either side
 * touches a setting the code checks share (C-193-3): a check whose answer a change can move is run again rather than
 * taken over.
 */
export function landHandover(iddId: string, loc: LaneLocation, head: string, mainTip: string): LandHandover | null {
  const saved = readLand(iddId);
  if (!saved || saved.status !== "prepared" || !saved.mergeCommit || carriesOldRebuildFailure(saved)) return null;
  if (saved.head !== head || saved.configKey !== key(loc.config)) return null;
  const areas = readAreas();
  // the declarations the results were run under: one added since is a check the record has no result for, so nothing
  // is taken over and the whole group is checked again (C-193-1). A record from before the fingerprint is not taken
  if (!saved.declaredKey || saved.declaredKey !== landDeclarationKey(loc.area, areas)) return null;
  if (saved.reason || saved.blocking > 0) return null;
  if (!(Date.parse(saved.expiresAt) > Date.now())) return null;
  // the same group is the record itself and needs no handover (the rule that does not check twice at one tip)
  if (!saved.mainTip || saved.mainTip === mainTip) return null;
  const main = loc.config.local_path!;
  // the mainline only moves forward: a tip the record was taken at has to be behind the tip it has now
  if (attempt(main, ["merge-base", "--is-ancestor", saved.mainTip, mainTip]) === null) return null;
  // both sides of the question are read every time: a tip that moved twice is still judged from the tip the record
  // was taken at, so no stretch of the mainline's change escapes the question (C-193-1)
  const mainChanged = diffNames(main, [saved.mainTip, mainTip]);
  if (mainChanged === null) return null;
  const laneChanged = diffNames(main, [`${mainTip}...${head}`]);
  if (laneChanged === null) return null;
  if (placesMeet(mainChanged, laneChanged)) return null;
  if (rootSettingTouched(mainChanged)) return null;
  if (sharedSettingTouched(mainChanged) || sharedSettingTouched(laneChanged)) return null;
  if (dependencyMeets(main, mainChanged, laneChanged, [saved.mainTip, mainTip, head])) return null;
  const area = areas.areas[loc.area];
  const increments = areas.increments?.[loc.area] ?? [];
  const run = (area?.checks ?? []).filter((c) => c.scope === "records");
  // what a check of the code side is: the repo's public checks and its increments, both of which are results of the
  // tree the mainline and the lane make together. Anything else on the record (the copy's own reading) is not carried
  const code = new Set([
    ...(area?.checks ?? []).filter((c) => c.scope !== "records").map((c) => c.name),
    ...increments.map((i) => i.name),
  ]);
  const carried = saved.checks.filter((c) => code.has(c.name));
  // nothing of the code side on the record (a repo checked by its records alone): there is nothing to take over
  if (!carried.length) return null;
  // every check of the code side declared now has to have a result on the record: one the declarations added after the
  // check ran is run again with the whole group, not taken over with the others (C-193-1)
  const have = new Set(carried.map((c) => c.name));
  if ([...code].some((name) => !have.has(name))) return null;
  // the tip the results were really run at: a record that itself took results over keeps naming the first tip, so the
  // mark does not move to a tip nothing was run at, and the detail does not grow a line per handover
  const origin = saved.inherit ?? { mainTip: saved.mainTip, ...(saved.mergeCommit ? { mergeCommit: saved.mergeCommit } : {}) };
  const mark = inheritMarkOf(origin.mainTip, origin.mergeCommit);
  return {
    inherit: {
      mainTip: origin.mainTip,
      ...(origin.mergeCommit ? { mergeCommit: origin.mergeCommit } : {}),
      checks: saved.inherit ? carried : carried.map((c) => markedCheck(c, mark)),
    },
    run,
    token: saved.token,
    expiresAt: saved.expiresAt,
  };
}

/**
 * One lifecycle line for the group whose checks a fresh check took over, once per lane head and mainline tip. It is
 * written as the landing's check being done again at this tip (the name the timeline already knows), with the pair it
 * names in its attrs and the carried checks in the reason text and in `inherit` (C-193-5).
 */
async function noteLandInherit(iddId: string, head: string, mainTip: string, handover: LandHandover): Promise<void> {
  const seen = readLifecycle().some((e) => e.idd_id === iddId && e.event === "s4_land_recheck" && e.attrs?.head === head && e.attrs?.main_tip === mainTip && e.attrs?.inherit !== undefined);
  if (seen) return;
  const carried = handover.inherit.checks.map((c) => c.name);
  const ran = handover.run.map((c) => c.name);
  await appendLifecycle("s4_land_recheck", iddId, {
    head,
    main_tip: mainTip,
    reason: `前回の本流 ${handover.inherit.mainTip.slice(0, 7)} の結果を引き継ぎ、${ran.length ? `記録の検査（${ran.join(", ")}）だけを` : "検査を"}回します`,
    inherit: {
      from_main_tip: handover.inherit.mainTip,
      ...(handover.inherit.mergeCommit ? { from_merge_commit: handover.inherit.mergeCommit } : {}),
      inherited: carried,
      ran,
    },
  });
}

export function saveLand(rec: LandRecord): LandRecord { save(landPath(rec.iddId), rec); return rec; }

/** how long a checked land waits for penne's approval (the same day the submit's check waits) */
export const APPROVAL_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The reason the tick owes an approved landing, or null: why the merge or the close could not be made. Written once
 * per lane head and reason, so a cause that stands (a dirty checkout) does not fill the lifecycle and the timeline;
 * the card reads it to say what the landing waits on.
 */
export async function noteLandHold(iddId: string, head: string, reason: string): Promise<void> {
  const last = readLifecycle().filter((e) => e.idd_id === iddId && e.event === "s4_land_hold").pop();
  if (last && last.attrs?.head === head && last.attrs?.reason === reason) return;
  await appendLifecycle("s4_land_hold", iddId, { head, reason });
}

/** why the approved landing has not gone in yet, read by the card (`landPending`), or "" */
export function lastLandHold(events: LifecycleRecord[]): string {
  return laneAnswer<string>("land_hold", events);
}

/**
 * The approval in force for a lane: the last `s4_land_approved`, valid only while nothing after it took it back and
 * while the lane still stands at the head it approved. A lane sent back (by penne, or by the harness on a conflict)
 * has no approval, so the tick does not carry the merge out for a head penne took back. The answer is folded by the
 * MoonBit fold with the card's, the tick's and the submit's other readings of this lane, so the card cannot offer a
 * signature for a head the tick refuses (C-195-1); `at` is the approval's place in the column handed over.
 */
export function currentLandApproval(events: LifecycleRecord[]): { head: string; at: number; close?: LandClose } | null {
  return laneAnswer<{ head: string; at: number; close?: LandClose } | null>("land_approval", events);
}

/** the close an approval records with its signature: the destination and the one-liner the tick runs later */
export function closeAttrs(saved: Pick<LandRecord, "close">): Record<string, unknown> {
  return saved.close
    ? { close: { repo: saved.close.repo, issue: saved.close.issue, url: saved.close.url, comment: saved.close.comment } }
    : {};
}

/**
 * Why a lane whose executor came back without finishing, and that adds nothing public, is not merged, and what to do
 * with it instead. Both ways on are named, since the card offers only the send-back and the lane's own operations.
 */
export const RECORDS_ONLY_REASON = "実装役が作業を終えずに戻った lane は merge できません（実装役の最後の結果が成功でないか、確かめていない受け入れ条件が残り、本流との差分が overlay.manifest の記録だけです）。前提待ちで戻った lane なら前提の着地後に差し戻して実装させ、実装の要らない lane なら無視して閉じてください";

/**
 * Whether the lane adds nothing to the mainline's public side: the tree of the lane's head with the manifest's
 * paths removed is the tree of its merge base with the mainline, with the same paths removed. The merge base, not
 * the tip, is what the lane is compared with: a mainline that moved on (other lanes landed) differs from a lane
 * that changed nothing, and that difference is not the lane's. A lane that only carries records (the plan, the qa,
 * the reference) is what an executor leaves when it comes back without implementing (a landing of it closes the
 * Issue with nothing done), and also what a survey lane leaves as its work: `cameBackUnfinished` tells the two
 * apart. Null when the question cannot be answered (no mainline, no merge base): the landing then goes on to its
 * other guards rather than refuse on a reading it does not have.
 */
export function recordsOnlyLane(loc: LaneLocation): boolean | null {
  const main = loc.config.local_path;
  const workBase = loc.config.work_base;
  if (!main || !workBase) return null;
  const mainTip = mainlineTip(main, workBase);
  if (!mainTip) return null;
  const head = sha(loc.work);
  const base = attempt(loc.work, ["merge-base", mainTip, head])?.trim();
  if (!base) return null;
  const paths = readManifest(loc.work).paths;
  // the two trees are immutable objects, so the answer for a head, a base and a manifest is remembered: the card is
  // built on every read of the state, and the same lane is asked about again and again while nothing moved
  const remembered = key({ work: loc.work, head, base, paths });
  const known = recordsOnlyAnswers.get(remembered);
  if (known !== undefined) return known;
  const answer = filteredTree(loc.work, head, paths) === filteredTree(loc.work, base, paths);
  if (recordsOnlyAnswers.size >= 256) recordsOnlyAnswers.clear();
  recordsOnlyAnswers.set(remembered, answer);
  return answer;
}
const recordsOnlyAnswers = new Map<string, boolean>();

/**
 * Whether the executor came back without finishing the lane: its last result is not a success, or the plan's
 * criteria are not all verified with evidence (read as the submit card reads them: the lane's own reports folded
 * oldest first, so a fix round that reports a few criteria does not hide one left open before it). A lane with no
 * result, no backlog row or no criteria at all is read as unfinished. This is the cause the records-only refusal
 * guards against (2026-10-18, IDD-172 / IDD-182: an executor that returned on a blocker, its records signed in, its
 * Issue closed); a lane whose records are the work itself (a survey, a spike's report) finishes with every criterion
 * verified and is not refused for having no public change.
 */
export function cameBackUnfinished(iddId: string, loc: LaneLocation, events: LifecycleRecord[]): boolean {
  const last = events.filter((e) => e.event === "s2_result").pop();
  if (!last || last.attrs?.outcome !== "success") return true;
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  if (!rec) return true;
  const criteria = laneIntent(rec, { root: loc.work, events }).criteria;
  const states = acStatesForLane({ lane: iddId, rows: readWorkRows(workColumnPath(rec.area)), events });
  return !allCriteriaVerified(criteria, states);
}

/**
 * The refusal a lane meets at the preparation and at the approval when its executor came back unfinished and it adds
 * nothing public, or null. A reading that fails is a refusal too, so the card and the approval answer alike (the
 * card offers no signature the approval would then throw on).
 */
export function recordsOnlyRefusal(iddId: string, loc: LaneLocation, events?: LifecycleRecord[]): string | null {
  try {
    if (recordsOnlyLane(loc) !== true) return null;
    const evs = events ?? readLifecycle().filter((e) => e.idd_id === iddId);
    return cameBackUnfinished(iddId, loc, evs) ? RECORDS_ONLY_REASON : null;
  } catch (err) {
    return `記録だけの lane かどうかを読めませんでした: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * The protections a push has, read for a landing too: a broken overlay.manifest, a lane that adds nothing public
 * (records only), and a public change the last review did not see. Checked inside the whole preparation and again
 * at the approval, so the card, the API, the CLI and the tick all meet the same guards.
 */
export function guards(iddId: string, loc: LaneLocation): string | null {
  for (const root of new Set([loc.work, loc.config.local_path!])) {
    const manifest = readManifest(root);
    if (manifest.issues.length) return `overlay.manifest が不正です（${root === loc.work ? "lane" : "work 側の本流"}）: ${manifest.issues.map((i) => `${i.path}: ${i.reason}`).join(" / ")}`;
  }
  // a lane whose executor came back unfinished and whose public side is the mainline's lands nothing: approving it
  // would close its Issue over records alone (2026-10-18, IDD-172 / IDD-182), so the refusal stands before the
  // signature as it does at the preparation
  const evs = readLifecycle().filter((e) => e.idd_id === iddId);
  const recordsOnly = recordsOnlyRefusal(iddId, loc, evs);
  if (recordsOnly) return recordsOnly;
  const unreviewed = unreviewedChange(evs, loc.work, sha(loc.work));
  if (unreviewed) return unreviewed.reason;
  return null;
}

/** a lane of a repo that does not publish and holds no public branch or stacked base: why the landing cannot be made */
export function landBlocker(iddId: string, loc: LaneLocation): string | null {
  if (publishes(loc.config)) return "公開する repo の lane は merge の対象ではありません（提出前確認で push と PR を出します）";
  const stacked = stackedSubmitBlocker(iddId, loc);
  if (stacked) return stacked;
  if (read<Custody>(custodyPath(iddId))) return "公開 branch（custody）を持つ lane は merge できません。開いた PR か、答えのない公開 branch が残ります";
  const proposal = readProposal(iddId);
  if (proposal?.mode === "publish") return "公開の提出をした lane は merge できません（merge で閉じると PR が残ります）";
  const evs = readLifecycle().filter((e) => e.idd_id === iddId);
  if (evs.some((e) => e.event === "s4_pr_created") && !evs.some((e) => e.event === "lane_close")) return "PR を作った lane は merge できません（開いた PR が残ります）";
  return null;
}

/**
 * The files the lane and the mainline really conflict on: a detached worktree of the mainline is made and the lane's
 * head merged into it (`--no-commit`), and git's unmerged paths are read. Only what git could not merge is listed,
 * so the send-back names the files the executor has to resolve. The names are read NUL-separated, so a path with
 * non-ASCII characters stays the raw repo-root path and matches a declared generated path as it is.
 */
export function conflictFiles(main: string, mainTip: string, head: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "idd-land-conflict-"));
  try {
    git(main, ["worktree", "add", "--detach", dir, mainTip]);
    attempt(dir, ["-c", "user.name=IDD", "-c", "user.email=idd@localhost", "merge", "--no-commit", "--no-ff", head]);
    return git(dir, ["diff", "--name-only", "-z", "--diff-filter=U"]).split("\0").filter(Boolean);
  } catch {
    // the worktree could not be made or read: the send-back names the branch instead of the files
    return [];
  } finally {
    attempt(main, ["worktree", "remove", "--force", dir]);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 診断用に残る */ }
  }
}

/** the lane and the work-side checkout are where a landing may be made from, or why not */
export function checkouts(iddId: string, loc: LaneLocation): string | null {
  const main = loc.config.local_path!;
  if (git(main, ["branch", "--show-current"]).trim() !== loc.config.work_base) return `work 側の checkout を本流 ${loc.config.work_base} にしてください`;
  if (!clean(main)) return dirtyStop(main, "work 側の checkout に commit していない変更があります", "。clean にしてから merge します");
  if (!clean(loc.work)) return dirtyStop(loc.work, "lane に commit していない変更があります");
  return null;
}

/** how many paths a stop names at most before the rest is a count */
const NAMED_DIRTY_PATHS = 5;

/** the timeline cuts a hold's reason at this many characters (`events-display.ts`), so a sentence that must be read whole fits in it */
const REASON_LIMIT = 120;

/** the least of a path that is still worth naming when one path alone would push the sentence past the limit */
const MIN_PATH_ROOM = 12;

/**
 * A stop's sentence with the paths that keep a checkout from being clean named right after its first words, up to five. The whole
 * sentence, the next step in `tail` included, stays within what the timeline shows: a path that would not fit is left to the count
 * (`ほか N 件`), and a single path longer than the room keeps its end. A path git cannot list leaves the sentence without names.
 */
function dirtyStop(cwd: string, head: string, tail = ""): string {
  let paths: string[];
  try { paths = dirtyPaths(cwd); } catch { return `${head}${tail}`; }
  if (paths.length === 0) return `${head}${tail}`;
  const wrap = (named: string[], total: number) => {
    const rest = total - named.length;
    return `${head}（${named.join("、")}${rest > 0 ? `、ほか ${rest} 件` : ""}）${tail}`;
  };
  const named: string[] = [];
  for (const path of paths.slice(0, NAMED_DIRTY_PATHS)) {
    if (named.length > 0 && wrap([...named, path], paths.length).length > REASON_LIMIT) break;
    named.push(path);
  }
  if (named.length === 1 && wrap(named, paths.length).length > REASON_LIMIT) {
    const room = Math.max(MIN_PATH_ROOM, named[0].length - (wrap(named, paths.length).length - REASON_LIMIT));
    named[0] = `…${named[0].slice(-(room - 1))}`;
  }
  return wrap(named, paths.length);
}

export function mergeMessageFor(rec: BacklogRecord, branch: string): string {
  const n = rec.source_type === "github" ? /\/issues\/(\d+)/.exec(rec.gh_issue_url ?? "")?.[1] : undefined;
  const issue = n ? `Issue #${n}` : rec.source_type === "linear" ? (linearIdentifierOf(rec.linear_issue_url ?? "") ?? "Issue") : "Issue";
  return `Merge branch '${branch}'（${issue}: ${rec.title}）`;
}

/** the first line of a body, as the mark check reads it */
function firstLineOf(text: string): string {
  return text.split("\n")[0] ?? "";
}

/** one entry of a tree, as `ls-tree` reports it (a blob, a tree, or a symlink blob) */
interface TreeEntry { mode: string; type: string; oid: string; path: string }

/** the entries directly under a path in a tree; a missing path answers with none */
function treeEntries(cwd: string, ref: string, path: string): TreeEntry[] {
  return git(cwd, ["ls-tree", "-z", ref, "--", path]).split("\0").filter(Boolean).flatMap((line) => {
    const tab = line.indexOf("\t");
    if (tab < 0) return [];
    const [mode, type, oid] = line.slice(0, tab).split(" ");
    return mode && type && oid ? [{ mode, type, oid, path: line.slice(tab + 1) }] : [];
  });
}

/** a blob's text, whatever it holds */
function blobText(cwd: string, oid: string): string {
  return git(cwd, ["cat-file", "blob", oid]);
}

/**
 * A tree that is `ref` with the given files written (mode 100644) and the given paths removed. Nothing else moves:
 * a path neither list names keeps whatever the tree held, including a symlink or a directory.
 */
export function treeWith(cwd: string, ref: string, writes: { path: string; content: string; mode?: string }[], removes: string[]): string {
  return treeFromIndex(cwd, ref, (run) => {
    for (const path of removes) run(["update-index", "--force-remove", "--", path]);
    for (const w of writes) {
      const oid = run(["hash-object", "-w", "--stdin"], w.content).trim();
      run(["update-index", "--add", "--cacheinfo", `${w.mode ?? "100644"},${oid},${w.path}`]);
    }
  });
}

/** the markdown name a path has directly at the projection place, or null when it is elsewhere or not a name */
function nameAtPlace(place: string, path: string): string | null {
  if (!path.startsWith(place)) return null;
  const rest = path.slice(place.length);
  if (!rest || rest.includes("/") || !rest.endsWith(".md")) return null;
  return rest;
}

/** whether a side of the merge holds the path as a file carrying the projection mark (a symlink or a missing path does not) */
function markedIn(cwd: string, ref: string, path: string): boolean {
  const out = attempt(cwd, ["show", `${ref}:${path}`]);
  return out !== null && firstLineOf(out) === PROJECTION_MARK;
}

/**
 * Whether a path the merge could not take is a projection file: one directly at the place, a markdown name, that
 * the state draws now or that either side held as a file with the mark. A conflict on anything else is code.
 */
function isProjectionConflict(cwd: string, path: string, place: string, drawn: Set<string>, sides: string[]): boolean {
  const name = nameAtPlace(place, path);
  if (!name) return false;
  if (drawn.has(name)) return true;
  return sides.some((side) => markedIn(cwd, side, path));
}

/**
 * The tree of a landing with the A projection drawn again from the merged state: the same files the read door hands
 * over, written at the repo's fixed place. A conflicting projection file is resolved by the redrawing itself, so a
 * conflict that is all projections does not send the lane back; a conflict on anything else is left unresolved for
 * the caller to send back.
 *
 * Nothing a person wrote is touched: a name the drawing does not claim keeps whatever the merge left, and a name to
 * be drawn that the tree holds as something else (an unmarked file, a symlink, a directory) stops the landing with
 * a reason rather than overwrite it.
 */
export function redrawProjections(input: {
  cwd: string;
  tree: string;
  conflicts: string[];
  sides: string[];
  view: ProjectionView;
}): { tree: string; unresolved: string[] } | { reason: string } {
  const { cwd, view } = input;
  const place = view.dir.endsWith("/") ? view.dir : `${view.dir}/`;
  // a place the tree holds as something other than a directory cannot take the drawing; a person's file there stays
  const placeKind = attempt(cwd, ["cat-file", "-t", `${input.tree}:${place.replace(/\/$/, "")}`]);
  if (placeKind !== null && placeKind.trim() !== "tree") return { reason: `写しの場所 ${place.replace(/\/$/, "")} が写しの置き場ではありません` };
  const drawn = new Map(view.files.map((f) => [f.name, f]));
  const unresolved = input.conflicts.filter((path) => !isProjectionConflict(cwd, path, place, new Set(drawn.keys()), input.sides));
  if (unresolved.length) return { tree: input.tree, unresolved };
  const writes: { path: string; content: string }[] = [];
  const removes: string[] = [];
  for (const e of treeEntries(cwd, input.tree, place)) {
    const name = nameAtPlace(place, e.path);
    if (!name) continue;
    const conflictHere = input.conflicts.includes(e.path);
    if (!drawn.has(name)) {
      // a leftover: only a marked file (or a projection conflict) is ours to remove; a symlink or a directory stays
      if (e.type !== "blob" || e.mode === "120000") continue;
      if (firstLineOf(blobText(cwd, e.oid)) === PROJECTION_MARK || conflictHere) removes.push(e.path);
      continue;
    }
    if (e.type !== "blob" || e.mode === "120000") {
      const kind = e.type === "blob" ? "symlink" : "directory";
      return { reason: `写しの場所 ${e.path} に写しでないもの（${kind}）があるので、写しを描き直せません` };
    }
    if (!conflictHere && firstLineOf(blobText(cwd, e.oid)) !== PROJECTION_MARK) {
      return { reason: `写しの場所 ${e.path} に印の無いファイルがあるので、写しを描き直せません` };
    }
  }
  for (const f of view.files) writes.push({ path: `${place}${f.name}`, content: f.content });
  return { tree: treeWith(cwd, input.tree, writes, removes), unresolved: [] };
}

/**
 * The renames the lane made, read from git's own diff of the lane's base against its head, with the dir moves the
 * file moves add up to. A dir counts as moved when every file that left it went to one and the same dir and the old
 * dir no longer stands at the lane's head.
 */
export function lanePlaceMoves(main: string, base: string, head: string): PlaceMove[] {
  const raw = attempt(main, ["diff", "-M", "--name-status", "-z", base, head]) ?? "";
  const files = parseRenameDiff(raw);
  if (!files.length) return [];
  const dirExists = (path: string): boolean => {
    const at = attempt(main, ["cat-file", "-t", `${head}:${path.replace(/\/$/, "")}`]);
    return at !== null && at.trim() === "tree";
  };
  return placeMovesOf(files, dirExists);
}

/**
 * The state a landing writes before its merge commit is made: the lane's conversion of the older Places and the follow
 * of the files it moved. Both are rows of this lane and take effect for everyone at the landing (C-179-4, C-179-8).
 * Returns why a row could not be written, or null; the batch makes the same writes for each lane it chains.
 */
export async function followLanePlaces(repoKey: string, iddId: string, main: string, base: string, head: string): Promise<string | null> {
  try {
    const converted = await recordPlacesModule(repoKey, iddId);
    if (!converted.ok) return `既存の Place の変換を書けませんでした: ${converted.error}`;
    const moves = lanePlaceMoves(main, base, head);
    if (moves.length) {
      const followed = await recordPlaceMoves(repoKey, iddId, moves);
      if (!followed.ok) return `移った file の追従を書けませんでした: ${followed.error}`;
    }
  } catch (e) {
    return `意図の Place の追従を書けませんでした: ${String((e as Error).message ?? e).slice(0, 300)}`;
  }
  return null;
}

/**
 * The merge a landing would make now: the merge commit and the files the checks read. No check runs here (C-144-1):
 * the checks run in a detached run of their own, in a copy of this merge commit.
 */
export type LandPlan =
  | { kind: "blocked"; reason: string }
  | { kind: "conflict"; files: string[] }
  /** the generated files could not be made again from the merged sources: there is no tree to check */
  | { kind: "unbuilt"; head: string; mainTip: string; failure: RebuildFailure }
  | { kind: "planned"; head: string; mainTip: string; mergeCommit: string; changed: string[] };

/**
 * The landing of a lane at the work side's mainline as it is now: the merge of the lane's head and the mainline tip
 * (both parents of the merge commit), and the projection drawn again into it. Only the local clones are read. The
 * merge commit is made on the main clone but the mainline ref is not moved here: the caller approves or the tick
 * retries it. The checks of the merge are not run here: they run in a copy of it, in a run of their own (C-144-1).
 */
export async function computeLand(iddId: string, loc: LaneLocation): Promise<LandPlan> {
  const blocked = landBlocker(iddId, loc) ?? guards(iddId, loc);
  if (blocked) return { kind: "blocked", reason: blocked };
  const bad = checkouts(iddId, loc);
  if (bad) return { kind: "blocked", reason: bad };
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  if (!rec) return { kind: "blocked", reason: "lane がありません" };
  const areas = readAreas();
  const area = areas.areas[loc.area];
  if (!area) return { kind: "blocked", reason: "repo の設定がありません" };
  const main = loc.config.local_path!;
  const head = sha(loc.work);
  const mainTip = sha(main);
  const base = git(main, ["merge-base", mainTip, head]).trim();
  const merged = mergeTrees(main, tree(main, base), tree(main, mainTip), tree(main, head));
  const conflicts = merged.conflict ? conflictFiles(main, mainTip, head) : [];
  const keyed = resolveAreaKey(loc.area, areas);
  const repoKey = "error" in keyed ? loc.area : keyed.key;
  // the state the landing writes first: the lane's conversion of the older Places, and the follow of the files it
  // moved. Both are rows of this lane and take effect for everyone at this landing (C-179-4, C-179-8), and both are
  // written before the merge commit is made, so the copy the checks read is drawn from the followed Places. A row
  // that cannot be written stops the landing with its reason rather than land a copy that disagrees with the state
  const followed = await followLanePlaces(repoKey, iddId, main, base, head);
  if (followed) return { kind: "blocked", reason: followed };
  // the A projection is drawn again from the state the lane sees, into the tree the landing is checked as: the
  // mainline carries a drawing that matches the state it lands with, and a conflict that is all projections is
  // resolved by the redrawing rather than by sending the lane back (C-129-1, C-129-2, C-129-3)
  const view = projectionViewFor(repoKey, iddId);
  const drawingOn = view.projections.includes("A");
  // a conflict on a generated file holds no decision: it is made again from the merged sources below, so only the other
  // files decide whether the lane goes back (C-261-1). When it cannot be made again the landing is unbuilt, not a conflict
  const generated = areas.generatedFiles?.[loc.area] ?? [];
  const generatedSet = generatedPathsOf(generated);
  const generatedConflicts = conflicts.filter((p) => generatedSet.has(p));
  const codeConflicts = conflicts.filter((p) => !generatedSet.has(p));
  if (merged.conflict && !conflicts.length) return { kind: "conflict", files: conflicts };
  if (merged.conflict && !drawingOn && codeConflicts.length) return { kind: "conflict", files: conflicts };
  let mergeTree = merged.tree;
  if (drawingOn) {
    const drew = redrawProjections({ cwd: main, tree: mergeTree, conflicts: codeConflicts, sides: [mainTip, head], view });
    if ("reason" in drew) return { kind: "blocked", reason: drew.reason };
    if (drew.unresolved.length) return { kind: "conflict", files: conflicts };
    mergeTree = drew.tree;
  }
  // the generated files are made again from the sources of the tree the mainline will take, whether or not git called them
  // a conflict (C-261-4); a landing that touches none of them keeps its tree as the merge made it
  if (generated.length && (generatedConflicts.length || generatedTouched(main, base, mainTip, head, generated))) {
    const rebuilt = await rebuildGenerated({ cwd: main, tree: mergeTree, outputs: generated, deps: join(main, "node_modules") });
    // a tree whose generated files are not the build of its sources is neither checked nor taken: the failure is the
    // landing's answer, whether git called the files a conflict or not
    if ("failure" in rebuilt) return { kind: "unbuilt", head, mainTip, failure: rebuilt.failure };
    mergeTree = rebuilt.tree;
  }
  const mergeCommit = commitTree(main, mergeTree, [mainTip, head], mergeMessageFor(rec, loc.branch));
  return { kind: "planned", head, mainTip, mergeCommit, changed: names(main, mainTip, mergeCommit) };
}

/**
 * A landing whose checks are running in a run of their own: nothing is checked yet, so the card asks for no approval
 * and the tick does not read this as checked (C-144-1, C-144-3). `waiting` says why no run was started for this ask.
 */
export interface LandChecking {
  checking: true;
  lane: string;
  head: string;
  mainTip: string;
  mergeCommit: string;
  /** the run reading this group, when one was started or was already going */
  runId?: string;
  /** why no run was started for this ask (the limit is full); the next tick asks again (C-144-4) */
  waiting?: string;
  /** the checked results this check took over from an earlier mainline tip, when it took any over */
  inherit?: LandInherit;
}

/** the answer an ask for a landing whose checks are running gets */
function checkingOf(run: Pick<LandCheckRun, "lane" | "head" | "mainTip" | "mergeCommit" | "id">, inherit?: LandInherit): LandChecking {
  return { checking: true, lane: run.lane, head: run.head, mainTip: run.mainTip, mergeCommit: run.mergeCommit, runId: run.id, ...(inherit ? { inherit } : {}) };
}

/** the landing check started for a planned merge: the run makes the same merge in a copy and writes the record (C-144-1) */
function startRunFor(iddId: string, loc: LaneLocation, plan: { head: string; mainTip: string; mergeCommit: string; changed: string[] }, unsigned: boolean, handover: LandHandover | null): LandCheckRun {
  const main = loc.config.local_path!;
  const areas = readAreas();
  const area = areas.areas[loc.area];
  const increments = areas.increments?.[loc.area] ?? [];
  const close = landCloseOf(iddId, area);
  return startLandRun({
    lane: iddId,
    signed: !unsigned,
    spec: {
      repo: main,
      area: loc.area,
      // a handover runs only the records checks: the code side's results are carried over, and so are the increments
      checks: handover ? handover.run : (area?.checks ?? []),
      ...(handover || !increments.length ? {} : { increments }),
      ...(handover ? { inherit: handover.inherit } : {}),
      changed: plan.changed,
      deps: join(main, "node_modules"),
      head: plan.head,
      mainTip: plan.mainTip,
      mergeCommit: plan.mergeCommit,
      branch: loc.branch,
      workBase: loc.config.work_base!,
      configKey: key(loc.config),
      // the declarations the checks were started under: a record they write is no reuse of a group under other ones
      declaredKey: landDeclarationKey(loc.area, areas),
      ...(loc.config.linked_repo ? { repoName: loc.config.linked_repo } : {}),
      // the token and window of a handover are the ones an open card already holds (C-193-2)
      token: handover ? handover.token : randomBytes(24).toString("base64url"),
      expiresAt: handover ? handover.expiresAt : new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString(),
      ...close,
    },
  });
}

/**
 * The slot a landing check needs: the limit among the other lanes' runs (C-144-4), and — for a check an approval
 * waits on — one unsigned run stopped to make room (C-144-5). Returns why no run may be started, or null.
 */
export function reserveCheckSlot(lane: string, signed: boolean): string | null {
  const others = runningLandRuns().filter((r) => r.lane !== lane);
  if (others.length < landCheckLimit()) return null;
  const victim = signed ? others.find((r) => !r.signed) : undefined;
  if (!victim) return "検査の同時数が上限です。空きができると次の tick が検査します";
  stopLandRun(victim);
  return null;
}

/**
 * Prepare (or re-prepare) the landing of a lane at the mainline as it is now: plan it under the repo's lock, then
 * start the check as a run of its own and answer with what the card reads while it runs (C-144-1, C-144-2). The lock
 * is held while the merge commit is made (and the run takes it again to cut its copy), not while the checks run. A
 * check at a moved tip takes the code side's results over from the lane's last checked record when the mainline's
 * change meets the lane's change nowhere, and runs only the records checks (C-193-1, C-193-4).
 *
 * `signed` marks a check an approval is waiting on: only that check takes a slot over by stopping an unsigned one.
 */
export async function prepareLand(iddId: string, opts: { signed?: boolean } = {}): Promise<LandRecord | LandChecking | { error: string; lockRefused?: true }> {
  const loc = laneLocations(iddId);
  if (!loc) return { error: "lane と repo に作業本流・公開先を設定してください" };
  let release: (() => void) | undefined;
  try {
    // the lock is held while the merge commit is made and marked, so an operation that meets it is told the checks
    // are running instead of being prompted about a stopped process (DEC-2327). It is let go before the checks: a
    // checked merge commit is an immutable object, and the record keeps the group it was checked at (C-144-2)
    release = lock(loc.work, { checks: true });
    const main = loc.config.local_path!;
    const head = sha(loc.work);
    const mainTip = sha(main);
    // a run reading exactly this head and tip is the check this ask wants: one run per group, and a second ask is
    // answered with what the first is doing (C-144-3). A run of another group can never be used, so it is stopped
    const going = landRunChecking(iddId);
    if (going) {
      const same = going.head === head && going.mainTip === mainTip ? going : null;
      if (same) return checkingOf(same);
      stopLandRun(going, "検査する組（lane の head か本流の先端）が変わりました");
    }
    const close = landCloseOf(iddId, readAreas().areas[loc.area]);
    const planned = await computeLand(iddId, loc);
    if (planned.kind === "blocked" || planned.kind === "conflict" || planned.kind === "unbuilt") {
      // none of the three has a merge commit or a run: nothing is checked, and an approval finds no commit to take.
      // An unbuilt one keeps the failure and the time it was taken, so the tick tries the same group again after the
      // checks' own wait or sends the lane back, and the card says which
      const why: Partial<LandRecord> = planned.kind === "blocked" ? { reason: planned.reason }
        : planned.kind === "conflict" ? { reason: "work 側の本流と衝突します", conflict: planned.files }
        : { declaredKey: landDeclarationKey(loc.area), reason: unbuiltWords(planned.failure), rebuildFailure: { ...planned.failure, at: new Date().toISOString() } };
      const rec: LandRecord = {
        iddId, branch: loc.branch, head, workBase: loc.config.work_base!, repo: loc.config.linked_repo, mainTip,
        checks: [], blocking: 0, token: randomBytes(24).toString("base64url"),
        expiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString(), configKey: key(loc.config), status: "prepared",
        ...why, ...close,
      } as LandRecord;
      saveLand(rec);
      return rec;
    }
    const full = reserveCheckSlot(iddId, opts.signed === true);
    if (full) return { checking: true, lane: iddId, head: planned.head, mainTip: planned.mainTip, mergeCommit: planned.mergeCommit, waiting: full };
    // a check at a moved mainline tip takes over the code side's results of the lane's last checked record when the
    // mainline's change since then meets the lane's change nowhere (C-193-1). Only the records checks run then, and a
    // repo with none of them gets a run that reads no check: the run is the one door the record is written through
    // (C-144-1), so the tick, the card and the CLI read the check it makes the same way
    const handover = landHandover(iddId, loc, planned.head, planned.mainTip);
    if (handover) await noteLandInherit(iddId, planned.head, planned.mainTip, handover);
    // the run is started while the lock is held: the plan it was made from belongs to this head and tip, and two
    // asks never start two runs for the same group
    return checkingOf(startRunFor(iddId, loc, planned, opts.signed !== true, handover), handover?.inherit);
  } catch (e) {
    // the repo's lock held for its checks is a wait, not a failure: marked so the tick skips the lane and tries again
    // on its next pass (DEC-2328)
    return { error: String((e as Error).message ?? e).slice(0, 400), ...(lockRefusal(e) ? { lockRefused: true as const } : {}) };
  } finally { release?.(); }
}

/** The checked land a token names, as it is now, or why its approval is refused. */
export function validateLand(iddId: string, token: string): { record: LandRecord; loc: LaneLocation } | { error: string; held?: boolean } {
  const saved = readLand(iddId);
  const loc = laneLocations(iddId);
  if (!saved || !loc || saved.token !== token) return { error: "承認 token が一致しません。検査し直してください" };
  if (saved.status === "complete") return { error: "既に merge 済みです" };
  // the same guards the preparation made, read again at the approval: a public change the last review did not see,
  // a broken manifest, an open branch
  const blocked = landBlocker(iddId, loc) ?? guards(iddId, loc);
  if (blocked) return { error: blocked };
  if (key(loc.config) !== saved.configKey) return { error: "設定が変わりました。検査し直してください" };
  // an increment or a checkPrep added after the check ran is a check this record has no result for: it is refused
  // rather than merged past a declaration the checks never read (C-193-1)
  if (!saved.declaredKey || saved.declaredKey !== landDeclarationKey(loc.area)) return { error: "検査の宣言（increments・checkPrep）が変わりました。検査し直してください" };
  if (saved.head !== sha(loc.work) || !clean(loc.work)) return { error: "検査の後に lane の commit が進みました。検査し直してください" };
  if (!(Date.parse(saved.expiresAt) > Date.now())) return { error: "承認の期限が切れました。検査し直してください" };
  // a failure to rebuild the generated files is no landing to approve, whether the record has a merge commit or not
  if (saved.rebuildFailure) return { error: unbuiltWords(saved.rebuildFailure) };
  if (!saved.mergeCommit || saved.blocking > 0) return { error: saved.reason && saved.blocking === 0 ? saved.reason : blockingWhy(saved.blocking, saved.checks) };
  const main = loc.config.local_path!;
  const bad = checkouts(iddId, loc);
  if (bad) return { error: bad, held: true };
  if (sha(main) !== saved.mainTip) return { error: "本流が進みました。次の tick が検査し直して merge します", held: true };
  return { record: saved, loc };
}

/** what a failed rebuild of the generated files asks of whoever reads it: the environment is mended, or the sources are */
export function rebuildFailureWords(failure: RebuildFailure): string {
  const ask = failure.cause === "environment"
    ? "この環境では作り直せませんでした（道具・時間）。源の誤りではないので、環境を直すまで待つか、宣言のコマンドを手元で回して生成物を作り直し、commit してください"
    : "merge した源が build を通りませんでした。lane で源を直してください";
  return `生成物（${failure.paths.join(", ")}）を作り直せませんでした。${ask}。\n${failure.reason}`;
}

/**
 * What a landing that could not be rebuilt says on its card and in its hold: which files, which side is to blame, and
 * what happens next. The same words the tick's reading and the card share.
 */
export function unbuiltWords(failure: RebuildFailure): string {
  const next = failure.cause === "environment"
    ? "この環境では作り直せませんでした（道具・時間）。源の誤りではないので、次の tick が同じ head と本流の先端で試し直します"
    : "merge した源が build を通らないか、宣言した path を書きませんでした。lane の変更の失敗として差し戻します";
  return `生成物（${failure.paths.join(", ")}）を作り直せないので、検査も承認もしていません。${next}。\n${failure.reason}`;
}

/**
 * A conflict between the lane and the mainline sends the lane back (never a rebase: the lane's history and the
 * records that read its head stay). The same record and envelope the submit's "直させる" uses, with the mainline
 * branch and the files as the instruction.
 */
export async function sendBackLandConflict(iddId: string, branch: string, files: string[], head: string, mainTip: string): Promise<boolean> {
  // the same conflict for the same head and mainline tip is told once: a tick that looks again writes no second
  // envelope, so the executor does not get the same instruction again on every pass
  const seen = readLifecycle().filter((e) => e.idd_id === iddId && e.event === "s4_land_conflict")
    .some((e) => e.attrs?.head === head && e.attrs?.main_tip === mainTip);
  if (seen) return false;
  const instruction = `work 側の本流（${branch}）を lane に merge して衝突を解き、commit してください。rebase は使わないでください。衝突したファイル: ${files.length ? files.join(", ") : "（本流の merge で確かめてください）"}`;
  const written = await transition(iddId, "s4_verify_user_judgment_answered", { outcome: "revise", instruction, by: "harness", conflict_files: files });
  if (!written.ok) return false;
  invalidateProposal(iddId);
  await appendLifecycle("s4_land_conflict", iddId, { branch, conflict_files: files, head, main_tip: mainTip });
  await queueEnvelope(iddId, "lane_rejected", laneRejectedEnvelope(iddId, instruction, false), { skipFixPlan: true });
  return true;
}

/**
 * Why a landing check failed, as far as the record and the run that wrote it tell: a failure of the environment the
 * check ran in (the harness cut it by time or output, the test met the overlay lock of a check running beside it, or
 * the run itself died before it wrote a result), or a failure of the change (a check that ran and failed). The tick
 * runs the first kind again by itself and sends the second kind back to the executor; a person is asked only to sign.
 * Null for a record that did not fail.
 */
export type LandFailureCause =
  /** `noResult`: the run ended before it wrote a result (its process died or was stopped), so no check was read at all */
  | { kind: "environment"; reason: string; noResult?: true; rebuild?: RebuildFailure }
  /**
   * `structural`: a structure count grew, or the merge commit's declaration holds less: the head's tree decides it, so it is not checked again.
   * `rebuild`: the generated files could not be made from the merged sources (no check ran): the same group builds the same way, so it is
   * sent back without a second try, and a mainline that moved is a new group
   */
  | { kind: "real"; checks: GateCheck[]; structural?: true; rebuild?: RebuildFailure };

/**
 * Why a landing check failed, as far as the record and the run that wrote it tell: the MoonBit fold answers it
 * (`packages/idd-fold/land_failure.mbt`), so the tick's re-check and the card's wording read one reading (C-202-1).
 */
export function landFailureCause(saved: LandRecord | null, run: Pick<LandCheckRun, "head" | "mainTip" | "status" | "error" | "started_at"> | null): LandFailureCause | null {
  return laneAnswer<LandFailureCause | null>("land_failure", [], { saved, run });
}

/** a line of a check's output that names a failure: node's ✖, bun's (fail), tsc's error TS */
const FAIL_LINE = /^\s*(?:✖|\(fail\)|.*\berror TS\d+\b)/;

/** the first lines of a detail that name a failure, at most `max`; the detail's last lines when none does */
export function failLines(detail: string, max = 10): string[] {
  const lines = detail.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
  const named = lines.filter((l) => FAIL_LINE.test(l));
  return (named.length ? named : lines.slice(-max)).slice(0, max);
}

/**
 * The instruction a landing whose generated files could not be made sends the executor: the declared paths, the build's
 * own output, and what to mend. Only the sources can be mended, so the generated files are not edited by hand.
 */
export function rebuildFailureInstruction(branch: string, failure: RebuildFailure): string {
  return [
    `取り込みで、宣言された生成物（${failure.paths.join(", ")}）を、merge した源から作り直せませんでした。本流（${branch}）を lane に merge し（rebase は使わないでください）、宣言のコマンドが源から通り、宣言した path を書くように直して commit し、結果を報告してください。生成物を手で書き換えて済ませないでください。`,
    "",
    "作り直しのコマンドの出力:",
    failure.reason,
  ].join("\n");
}

/** the instruction a failed landing check sends the executor: the checks that fell, their first failure lines, and what to do */
export function landCheckFailureInstruction(branch: string, checks: GateCheck[], area?: string): string {
  const names = checks.map((c) => c.name).join(", ");
  const lines = [
    `取り込みの検査が落ちました（落ちた検査: ${names}）。本流（${branch}）を lane に merge し（rebase は使わないでください）、落ちた検査を直して commit し、結果を報告してください。`,
  ];
  for (const c of checks) {
    if (c.status !== "fail" || !c.detail) continue;
    lines.push("", `[${c.name}] 出力の fail 行（最大 10 行）:`, ...failLines(c.detail).map((l) => l.slice(0, 300)));
    lines.push(...structureLines(c, area));
  }
  return lines.join("\n");
}

/** a word of a command, quoted for a shell when it holds anything but plain characters */
const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/**
 * What a structure row adds to the instruction, by the kind the row itself carries: where the graded declaration is
 * (every kind, also when the row left the command out), the command when the row carries it, and what to fix for that
 * kind. Only a count that grew is asked to come down; a weakened declaration is put back and a count that could not
 * be taken is made takeable on the merged side only: one the mainline could not give is no fix of the change's, so a
 * number is never lowered for a row that has none to lower (C-253-4). Nothing for a
 * row that is not a structure row.
 */
function structureLines(c: GateCheck, area?: string): string[] {
  if (!c.structure) return [];
  const lines: string[] = [];
  const counted = c.counts;
  const kind = c.structure.kind;
  if (kind === "increase" && counted?.mainline !== undefined && counted.merged !== undefined) {
    const name = c.name.startsWith(STRUCTURE_ROW_PREFIX) ? c.name.slice(STRUCTURE_ROW_PREFIX.length) : c.name;
    const at = counted.at ? ` ${counted.at.slice(0, 7)}` : "";
    lines.push(`数えた数: ${name} / 本流の先端${at} の数 ${counted.mainline} / 取り込みの数 ${counted.merged}（+${counted.merged - counted.mainline}）`);
  }
  // copied files' values may sit in the command, so a row may leave it out: where it is declared is told either way
  const declared = `本流の先端の config/structure.yaml の command 欄`;
  lines.push(`採点した宣言の場所: ${area ? `config/repos.yaml の ${area}（repo）、` : ""}${declared}`);
  const command = c.structure.command;
  if (command?.length) lines.push(`採点した宣言の command: ${command.map(shellWord).join(" ").slice(0, 800)}`);
  if (kind === "increase") {
    lines.push("数える tree を IDD_STRUCTURE_ROOT に、宣言の file を IDD_STRUCTURE_DECL に渡して回します。本流の先端と lane の tree を同じ command で数え直し、取り込みの数が本流の数以下になってから報告してください。");
  } else if (kind === "weakened") {
    lines.push("止める数は下げないでください。取り込む側の config/structure.yaml から外れた止める数・許可を、本流の先端の宣言に戻してから報告してください。");
  } else if (c.structure.kind === "unmeasured" && c.structure.sides.includes("mainline")) {
    // the mainline tip's tree holds none of the lane's change, so the change cannot mend what lacked there (C-253-3)
    const also = c.structure.sides.includes("merged") ? "取り込む側でも測れていません。" : "";
    lines.push(`止める数は下げないでください。本流の先端の tree で数を測れませんでした。${also}lane の変更では直せないので、この行のために取り込む側の command を直さないでください。ほかに落ちた検査があればそれを直して報告してください。`);
  } else {
    lines.push("止める数は下げないでください。数えるコマンドが取り込む側の tree で数を出すように（command の不在・exit が 0 でない・最後の行が JSON でない・数の名前の欠け）直してから報告してください。");
  }
  return lines;
}

/**
 * A landing check the change itself failed sends the lane back, as a conflict does: the same record and envelope
 * penne's "直させる" writes, with the failed checks as the instruction. Once per lane head: a second failure at the
 * same head stays on the card for a person, so an executor that does not fix it is not sent the same instruction
 * again (DEC-10003).
 */
export async function sendBackLandCheckFailure(iddId: string, branch: string, checks: GateCheck[], head: string, mainTip: string, rebuild?: RebuildFailure): Promise<boolean> {
  const seen = readLifecycle().some((e) => e.idd_id === iddId && e.event === "s4_land_check_sent_back" && e.attrs?.head === head);
  if (seen) return false;
  const instruction = rebuild ? rebuildFailureInstruction(branch, rebuild) : landCheckFailureInstruction(branch, checks, laneLocations(iddId)?.area);
  const names = rebuild ? [`生成物の作り直し（${rebuild.paths.join(", ")}）`] : checks.map((c) => c.name);
  const written = await transition(iddId, "s4_verify_user_judgment_answered", { outcome: "revise", instruction, by: "harness", failed_checks: names });
  if (!written.ok) return false;
  invalidateProposal(iddId);
  invalidateLand(iddId);
  await appendLifecycle("s4_land_check_sent_back", iddId, { branch, checks: names, blocking: rebuild ? 1 : checks.length, head, main_tip: mainTip, ...(rebuild ? { rebuild_cause: rebuild.cause, rebuild_paths: rebuild.paths } : {}) });
  await queueEnvelope(iddId, "lane_rejected", laneRejectedEnvelope(iddId, instruction, false));
  return true;
}

/** the send-back of a failed check or rebuild, from the arguments the step carries */
export function sendBackLandCheckFailureFrom(iddId: string, args: Record<string, unknown>): Promise<boolean> {
  return sendBackLandCheckFailure(iddId, String(args.branch), (args.checks ?? []) as GateCheck[], String(args.head), String(args.mainTip), args.rebuild ? (args.rebuild as RebuildFailure) : undefined);
}

/**
 * The lane's records are closed after its head went into the work side's mainline: the record and lane_close in one
 * gate. Inside the gate, right before the records are written, the approval still in force, the lane still at the
 * submit card, and the lane's head really in the work_base branch are all checked again: a lane penne took back
 * while the merge was being made, or a checkout that moved off the branch, is not closed as if it had landed.
 */
export async function closeLanded(iddId: string, loc: LaneLocation, mergeCommit: string): Promise<{ ok: boolean; reason?: string }> {
  const verified = laneCriteria(iddId).verifiedIds();
  const main = loc.config.local_path!;
  const workBase = loc.config.work_base!;
  const head = readLand(iddId)?.head;
  const closed = await transition(iddId, "lane_close", {
    outcome: "local",
    merged_commit: mergeCommit,
    landed_branch: loc.branch,
    final_qa_verified: verified,
  }, {
    require: (lane) => {
      const approval = currentLandApproval(lane);
      if (!approval) return "merge の承認が効いていません（差し戻しなどで無くなりました）";
      if (deriveStage(lane).decision !== "ship") return "提出前確認の段にない lane です";
      if (attempt(main, ["merge-base", "--is-ancestor", approval.head, `refs/heads/${workBase}`]) === null) {
        return `work 側の本流（${workBase}）に lane の head（${approval.head.slice(0, 7)}）が入っていないので、merge として閉じません`;
      }
      if (head && approval.head !== head) return "merge の承認が別の head のものです";
      return null;
    },
    before: () => appendLifecycle("s4_land_merged", iddId, { merge_commit: mergeCommit, branch: loc.branch }),
  });
  return closed.ok ? { ok: true } : { ok: false, reason: closed.reason };
}

/** the number and URL of the lane's Issue, for the close one-liner; null for a Linear lane (nothing is written there) */
function githubIssue(rec: BacklogRecord): { repo: string; issue: number; url: string } | null {
  if (rec.source_type !== "github" || !rec.gh_issue_url) return null;
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/.exec(rec.gh_issue_url);
  return m ? { repo: m[1], issue: Number(m[2]), url: rec.gh_issue_url } : null;
}

/** the one-liner that closes a landed lane's Issue: the same text the outbound card has always posted */
function issueCloseComment(issue: number): string {
  return [
    `work 側の本流へ merge しました（merge で lane を閉じました）。`,
    `#${issue} を完了として閉じます。`,
  ].join("\n");
}

/**
 * The Issue this landing closes, and where its close goes: the approval's own close when the repo leaves it ON, the
 * outbound card when the repo wrote `land.close_issue: false`. A Linear lane closes nothing (Linear's GitHub link
 * follows its own Issues), and so does a lane whose URL cannot be read.
 */
export function landCloseOf(iddId: string, cfg: AreaConfig | undefined): { close?: LandClose; closeCard?: LandRecord["closeCard"] } {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  const issue = rec ? githubIssue(rec) : null;
  if (!issue) return {};
  if (!closesOnLand(cfg)) return { closeCard: { repo: issue.repo, issue: issue.issue, url: issue.url } };
  return { close: { repo: issue.repo, issue: issue.issue, url: issue.url, comment: issueCloseComment(issue.issue) } };
}

/**
 * Queue the one-liner that closes the lane's GitHub Issue, once. The post goes out only on penne's approval of the
 * outbound card (`approveOutbound`); a Linear lane gets no draft (nothing is written to Linear). This is the path for
 * a repo that turned the signed close off, and for an approval recorded before the close was part of the signature.
 */
export async function queueIssueClose(iddId: string): Promise<void> {
  const evs = readLifecycle().filter((e) => e.idd_id === iddId);
  if (evs.some((e) => e.event === "s4_land_issue_close_queued")) return;
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  const issue = rec ? githubIssue(rec) : null;
  const runner = getAgentRunner();
  if (!rec || !issue || !runner?.queueOutbound) return;
  const title = `Issue #${issue.issue} を閉じる`;
  const body = issueCloseComment(issue.issue);
  const queued = await runner.queueOutbound({ kind: "gh-issue-close", target: { repo: issue.repo, issue: issue.issue }, title, body, source: iddId });
  await appendLifecycle("s4_land_issue_close_queued", iddId, { outbound_id: queued.id, issue: issue.url });
}

/**
 * The Issue's close as the last step of a landing. A close the approval signed is posted through the outbound record
 * at once, so the one-liner goes out without a second card; an approval without one keeps the outbound card. Whatever
 * fails here (the post, the record's write, the lifecycle write, the door itself) is caught: the merge and the lane's
 * close stay, and the failure is left on the timeline, and on the card where the record could be written.
 */
export async function closeIssueAfterLand(iddId: string, close: LandClose | undefined): Promise<void> {
  try {
    if (close && getAgentRunner()?.postOutbound) {
      await postSignedClose(iddId, close);
      return;
    }
    await queueIssueClose(iddId);
  } catch (err) {
    const reason = String((err as Error).message ?? err).slice(0, 300);
    // the failure is recorded as far as it can be; a broken state is not allowed to take the approval down with it
    try {
      const rec = readBacklog().find((r) => r.idd_id === iddId);
      const url = close?.url || (rec ? githubIssue(rec)?.url : undefined);
      await appendLifecycle("s4_land_issue_close_failed", iddId, { ...(url ? { issue: url } : {}), reason });
    } catch { /* nothing more can be written */ }
  }
}

/** post the close the landing's approval signed, and put its outcome on the timeline */
async function postSignedClose(iddId: string, close: LandClose): Promise<void> {
  const runner = getAgentRunner()!;
  const title = `Issue #${close.issue} を閉じる`;
  const posted = await runner.postOutbound!({ kind: "gh-issue-close", target: { repo: close.repo, issue: close.issue }, title, body: close.comment, source: iddId });
  if (posted.status === "posted") {
    await appendLifecycle("s4_land_issue_close_posted", iddId, { outbound_id: posted.id, issue: close.url });
    return;
  }
  await appendLifecycle("s4_land_issue_close_failed", iddId, { outbound_id: posted.id, issue: close.url, reason: posted.error ?? "投稿に失敗しました" });
}

export interface LandResult {
  ok: boolean;
  /** the merge commit the mainline was advanced to */
  committed?: string;
  /** the land waits for the next tick (the mainline moved, or the checkout is not clean) */
  held?: string;
  /** the landing is being checked in a run of its own: no result yet (C-144-1) */
  checking?: string;
  /** the checked results this landing's check took over from an earlier mainline tip, when it took any over */
  inherit?: LandInherit;
  error?: string;
}

/**
 * Advance the mainline to the checked merge commit, then close the lane. The merge is made only on a work-side
 * checkout that is on work_base and clean (checked again under the lock, at the moment of the merge), and only while
 * the approval penne gave still stands: a lane sent back while the checks ran is not merged. The lock being held is
 * a wait, not a failure: the approval stays and the tick does the merge next time.
 */
async function advance(iddId: string, loc: LaneLocation, mergeCommit: string, mainTip: string, head: string): Promise<LandResult> {
  const main = loc.config.local_path!;
  let release: (() => void) | undefined;
  let approvalClose: LandClose | undefined;
  try {
    release = lock(main);
  } catch (err) {
    // a refusal by the overlay lock is a wait, not a failure: the approval stays and the tick merges next time
    const refusal = lockRefusal(err);
    const reason = refusal === "checks" ? "検査が走っています。終わってからやり直します"
      : refusal === "busy" ? "別の overlay の処理が動いています。次の tick が merge し直します"
      : `本流の lock が取れませんでした: ${String((err as Error).message ?? err).slice(0, 200)}`;
    await noteLandHold(iddId, head, reason);
    return { ok: true, held: reason };
  }
  try {
    // the approval is read again at the moment the mainline is moved: a send-back that came while the checks ran
    // takes it back, and nothing is merged then
    const laneNow = () => readLifecycle().filter((e) => e.idd_id === iddId);
    const approval = currentLandApproval(laneNow());
    if (!approval || approval.head !== head) {
      return { ok: false, error: "merge の承認が効かなくなりました（差し戻しなど）。本流は進めません" };
    }
    // the close the signature covered rides along: the tick runs it after the lane is closed
    approvalClose = approval.close;
    if (deriveStage(laneNow()).decision !== "ship") return { ok: false, error: "提出前確認の段にない lane です" };
    const bad = checkouts(iddId, loc);
    if (bad) {
      await noteLandHold(iddId, head, bad);
      return { ok: true, held: bad };
    }
    // the mainline moved since the merge was checked: the tick checks it again at the new tip
    if (sha(main) !== mainTip) {
      const reason = "本流が進みました。次の tick が検査し直して merge します";
      await noteLandHold(iddId, head, reason);
      return { ok: true, held: reason };
    }
    const merged = attempt(main, ["merge", "--ff-only", mergeCommit]);
    if (merged === null) return { ok: false, error: "本流を merge できませんでした（作業ツリーを確認してください）" };
    const saved = readLand(iddId);
    if (saved) saveLand({ ...saved, status: "merged", mergeCommit, mainTip });
  } finally { release(); }
  // the record and the close are written in one gate. A close that did not get written leaves the record at
  // `merged` (not `complete`), so the next tick closes the lane without a second merge and the card does not say it
  // landed: nothing that assumes the lane is closed is done here
  const closed = await closeLanded(iddId, loc, mergeCommit);
  if (!closed.ok) return { ok: false, error: `本流は進めましたが、lane を閉じられませんでした: ${closed.reason ?? ""}。次の tick が閉じます`, committed: mergeCommit };
  const saved = readLand(iddId);
  if (saved) saveLand({ ...saved, status: "complete" });
  await closeIssueAfterLand(iddId, approvalClose);
  return { ok: true, committed: mergeCommit };
}

/**
 * penne's approval on the submit card of a lane of a repo that does not publish: the checked merge commit goes in
 * the mainline as it was checked, and the lane closes. When the mainline moved since the check, nothing is merged
 * here; the approval stays and the next tick checks the merge again at the new tip.
 */
export async function approveLand(iddId: string, token: string, approval: { nonce?: string; assertion?: unknown; pinProof?: unknown } = {}): Promise<LandResult> {
  // the nonce is used up whatever this approval's outcome: a refusal here (a token that does not match, a check
  // that blocks, a signature over other content, an exception while the merge is made) must not leave it for a
  // second try, the way the push's approval answers
  try {
    const checked = validateLand(iddId, token);
    // a refusal the token or the checks caused is answered before the signature: nothing to sign over, nothing
    // written, and no approval recorded for a lane whose checked land is not this token's
    if ("error" in checked && !checked.held) return { ok: false, error: checked.error };
    const saved = readLand(iddId);
    if (!saved) return { ok: false, error: "承認 token が一致しません。検査し直してください" };
    // the signature over what this approval lands, checked before s4_land_approved is written: a record that is there is what the tick merges, so an unverified approval must leave none (even
    // when the merge itself waits for the next tick)
    const verified = await verifyApproval({ nonce: approval.nonce, assertion: approval.assertion, pinProof: approval.pinProof, content: landContentFor(saved) });
    if (!verified.ok) return { ok: false, error: verified.reason };
    if ("error" in checked) {
      const head = saved.head ?? sha(laneLocations(iddId)!.work);
      const recorded = await transition(iddId, "s4_land_approved", { head, reason: checked.error, signed: true, ...closeAttrs(saved) });
      if (!recorded.ok) return { ok: false, error: recorded.reason };
      await noteLandHold(iddId, head, checked.error);
      return { ok: true, held: checked.error };
    }
    const { record, loc } = checked;
    // the signature's mark says this approval may be merged: an s4_land_approved without it (one written before
    // the signature was required) is not carried out by the tick
    const approved = await transition(iddId, "s4_land_approved", { head: record.head, merge_commit: record.mergeCommit, signed: true, ...closeAttrs(saved) });
    if (!approved.ok) return { ok: false, error: approved.reason };
    return advance(iddId, loc, record.mergeCommit!, record.mainTip, record.head);
  } finally {
    consumeNonce(approval.nonce);
  }
}

/**
 * A lane whose landing penne approved and whose merge the tick now makes (the mainline moved at the approval, or a
 * merge that could not be written). A saved check for exactly the approved head and the mainline as it is now is
 * used as it is: the mainline goes to the merge commit it made, without the checks being run again. Otherwise the
 * landing is re-checked at the mainline as it is now. A conflict drops the approval and sends the lane back; a
 * failing required check drops the approval and leaves it on the card; otherwise the merge goes in and the lane
 * closes. A mainline that already carries the lane's head writes the records and the close without a second merge.
 */
export async function recheckApprovedLand(iddId: string): Promise<LandResult | null> {
  let rows = readLifecycle().filter((e) => e.idd_id === iddId);
  const location = memoLaneLocation(iddId);
  const results: LandStep[] = [];
  await driveLandSteps("carry", rows, {}, observeCarry(iddId, location), {
    write: (event, attrs) => appendLifecycle(event, iddId, attrs).then(() => undefined),
    call: (step) => callCarry(iddId, location(), step),
    result: (step) => { results.push(step); },
    reload: () => (rows = readLifecycle().filter((e) => e.idd_id === iddId)),
    lockRefused: (err) => Boolean(lockRefusal(err)),
  });
  let outcome: LandResult | null = null;
  let inherited: LandInherit | undefined;
  for (const step of results) {
    if (step.field === "merged") outcome = { ok: true, ...(step.committed ? { committed: step.committed } : {}) };
    else if (step.field === "checking") outcome = { ok: true, checking: step.checking ?? "" };
    else if (step.field === "held") outcome = { ok: true, held: step.reason ?? "" };
    else if (step.field === "errors") outcome = { ok: false, error: step.error ?? "" };
    else if (step.field === "inherited") inherited = step.inherit as unknown as LandInherit;
  }
  if (outcome && inherited) outcome = { ...outcome, inherit: inherited };
  return outcome;
}

/** the lane's place, read once per answer: the fold asks for several readings of the same lane */
function memoLaneLocation(iddId: string): () => LaneLocation | null {
  let remembered: LaneLocation | null | undefined;
  return () => {
    if (remembered === undefined) remembered = laneLocations(iddId);
    return remembered;
  };
}

/**
 * The observations an approval's next step is asked for: git's answers about the lane and the mainline, the saved
 * record, and the approval the ledger holds. None of them decides anything; the fold reads them (C-202-3).
 */
function observeCarry(iddId: string, location: () => LaneLocation | null): LandObserver {
  const laneRows = (): LifecycleRecord[] => readLifecycle().filter((e) => e.idd_id === iddId);
  const carries = (commit: string, loc: LaneLocation | null): boolean => {
    const main = loc?.config.local_path;
    const workBase = loc?.config.work_base;
    if (!main || !workBase) return false;
    return attempt(main, ["merge-base", "--is-ancestor", commit, `refs/heads/${workBase}`]) !== null;
  };
  return (need) => {
    const loc = location();
    switch (need.kind) {
      case "approval": return currentLandApproval(laneRows());
      case "location": return Boolean(loc);
      case "cur": return loc ? sha(loc.work) : "";
      case "mainTip": return loc?.config.local_path ? sha(loc.config.local_path) : "";
      case "branch": return loc?.config.work_base ?? "";
      case "ancestor": {
        const approval = currentLandApproval(laneRows());
        return approval ? carries(approval.head, loc) : false;
      }
      case "mergeCommitCarried": {
        const saved = readLand(iddId);
        return saved?.mergeCommit ? carries(saved.mergeCommit, loc) : false;
      }
      case "checkouts": return loc ? checkouts(iddId, loc) : null;
      case "ready": return loc ? landReadyAt(iddId, loc) : null;
      case "saved": return readLand(iddId);
      case "now": return Date.now();
      case "blocked": return loc ? landBlocker(iddId, loc) ?? guards(iddId, loc) : null;
      default: return null;
    }
  };
}

/** the helpers an approval's steps call: the merge, the close, the records, and the checks */
async function callCarry(iddId: string, loc: LaneLocation | null, step: LandStep): Promise<unknown> {
  const args = step.args ?? {};
  switch (step.helper) {
    case "note_land_hold":
      await noteLandHold(iddId, String(args.head), String(args.reason));
      return null;
    case "close_landed":
      if (!loc) throw new Error("lane が見つかりません");
      return closeCarriedLand(iddId, loc, String(args.commit));
    case "advance_land":
      if (!loc) throw new Error("lane が見つかりません");
      return advance(iddId, loc, String(args.mergeCommit), String(args.mainTip), String(args.head));
    case "invalidate_land":
      invalidateLand(iddId);
      return null;
    case "send_back_land_conflict":
      await sendBackLandConflict(iddId, String(args.branch), (args.files ?? []) as string[], String(args.head), String(args.mainTip));
      return true;
    case "send_back_land_check_failure":
      return sendBackLandCheckFailureFrom(iddId, args);
    case "prepare_land":
      return prepareLand(iddId, { signed: args.signed === true });
    default:
      throw new Error(`知らない helper: ${step.helper}`);
  }
}

/**
 * The records and the close of a lane whose head the work_base branch already carries (a merge that was not written
 * down): the lane closes over the commit the approval's check made, and no second merge is written.
 */
async function closeCarriedLand(iddId: string, loc: LaneLocation, commit: string): Promise<{ ok: boolean; reason?: string; committed?: string }> {
  const closed = await closeLanded(iddId, loc, commit);
  if (!closed.ok) return { ok: false, reason: closed.reason ?? "lane を閉じられませんでした" };
  const now = readLand(iddId);
  if (now) saveLand({ ...now, status: "complete", mergeCommit: commit });
  const approval = currentLandApproval(readLifecycle().filter((e) => e.idd_id === iddId));
  await closeIssueAfterLand(iddId, approval?.close);
  return { ok: true, committed: commit };
}

/** forget a checked land (a lane sent back, or an approval the checks dropped) */
export function invalidateLand(iddId: string): void {
  const saved = readLand(iddId);
  if (saved && saved.status === "prepared") saveLand({ ...saved, expiresAt: new Date(0).toISOString() });
}

