
import { laneCommittedFiles, laneForkPoint } from "../plan/review.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { lastReturnToPlan } from "../ledger/replan-view.ts";
import { laneBaseMissing } from "../overlay/base.ts";
import { resolveWorktree } from "../worktree/changed-files.ts";
import { laneBranchSource } from "../worktree/ensure.ts";

/** the files a result record names as the lane's, and where that list came from */
export interface ResultFiles {
  files: string[];
  /** the harness measured the list from the lane's fork point; false when the executor's own list stands in */
  measured: boolean;
  /** why the list could not be measured (set only when `measured` is false) */
  unmeasured?: string;
  /** the part of `files` the lane changed since its latest start after a return to the plan; set only for such a lane, and only when it could be measured */
  cycleFiles?: string[];
}

/** where the lane's commits can be read: its worktree (HEAD) or, when that was retired, its branch */
interface MeasureSite {
  iddId: string;
  cwd: string;
  head: string;
}

function measureSite(iddId: string): MeasureSite | { unmeasured: string } {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  if (!rec) return { unmeasured: "lane の記録が読めません" };
  // the lane's last session that has a worktree: its executor's, else its planner's
  const session = (["executor", "planner"] as const).map((role) => readSessions(role).filter((s) => s.idd_id === iddId).pop()).find((s) => s?.worktree_path);
  const worktree = session?.worktree_path;
  if (!session || !worktree) return { unmeasured: "lane の worktree が記録に無い" };
  const baseMissing = laneBaseMissing(iddId);
  if (baseMissing) return { unmeasured: baseMissing };
  const tree = resolveWorktree(worktree);
  const branch = tree ? undefined : laneBranchSource(rec.area, worktree, session.branch);
  const [cwd, head] = tree ? [tree, "HEAD"] : branch ? [branch.repo, branch.ref] : [null, ""];
  if (!cwd) return { unmeasured: "lane の worktree も branch も読めない" };
  return { iddId, cwd, head };
}

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 120);

/**
 * The files the lane changed, measured from its fork point (merge-base with its base's work branch) to HEAD: what a
 * mainline merged into the lane brought in sits on the merge-base side and is not counted. A lane whose worktree was
 * retired is read from its branch. Edits not yet committed are not in HEAD, so they are not in the list.
 */
function measureLaneFiles(site: MeasureSite): { files: string[] } | { unmeasured: string } {
  const fork = laneForkPoint(site.iddId, site.cwd, site.head);
  if (!fork) return { unmeasured: "lane の fork point（base の work branch との merge-base）が読めない" };
  try {
    return { files: laneCommittedFiles(site.cwd, fork, site.head) };
  } catch (e) {
    return { unmeasured: `fork point からの差分を git が返さなかった: ${firstLine(e)}` };
  }
}

/** the commit the lane's latest start after its last return to the plan began from; undefined for a lane that never returned to its plan */
function cycleStartOf(iddId: string): string | undefined {
  const rows = readLifecycle().filter((e) => e.idd_id === iddId);
  const returned = lastReturnToPlan(rows);
  if (returned < 0) return undefined;
  const start = rows.slice(returned + 1).reverse().find((e) => e.event === "s2_start");
  const from = start?.attrs?.started_from_commit;
  return typeof from === "string" && from ? from : undefined;
}

/**
 * What of the lane's files the lane changed in its current cycle (since it last went back to its plan): the lane's
 * files that also differ between that cycle's start and HEAD, so a mainline merged in during the cycle, which the
 * lane's files leave out, is not counted. Not read from the review base: a round's review base is a different
 * question and moves with the reviewer's reading. Undefined when the lane never returned to its plan or the start
 * cannot be read, and the fold then reads the whole list.
 */
function measureCycleFiles(site: MeasureSite, laneFiles: string[]): string[] | undefined {
  const start = cycleStartOf(site.iddId);
  if (!start) return undefined;
  try {
    const since = new Set(laneCommittedFiles(site.cwd, start, site.head));
    return laneFiles.filter((f) => since.has(f));
  } catch {
    // a start git cannot read leaves the whole list, which is no worse than before the field existed
    return undefined;
  }
}

/** the list a result record carries: the harness's measurement, else the executor's own list with the reason it could not be measured */
export function resultFiles(iddId: string, reported: string[]): ResultFiles {
  const site = measureSite(iddId);
  if ("unmeasured" in site) return { files: reported, measured: false, unmeasured: site.unmeasured };
  const m = measureLaneFiles(site);
  if ("unmeasured" in m) return { files: reported, measured: false, unmeasured: m.unmeasured };
  const cycleFiles = measureCycleFiles(site, m.files);
  return { files: m.files, measured: true, ...(cycleFiles ? { cycleFiles } : {}) };
}

/**
 * The fields of the `s2_result` row that carry the list: the list, where it came from, why it could not be measured
 * (only then), and the current cycle's part of it (only for a lane that went back to its plan, and only when it could
 * be measured: the round lines count that part).
 */
export function resultFileAttrs(files: ResultFiles): Record<string, unknown> {
  const attrs: Record<string, unknown> = { changed_files: files.files, changed_files_source: files.measured ? "fork_point" : "reported" };
  if (files.unmeasured) attrs.changed_files_unmeasured = files.unmeasured;
  if (files.cycleFiles) attrs.cycle_files = files.cycleFiles;
  return attrs;
}
