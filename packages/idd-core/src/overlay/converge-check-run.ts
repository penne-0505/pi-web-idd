import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { publishes } from "../config/areas.ts";

import { withBaseComparison } from "./check-base.ts";
import { keepResults } from "./check-results.ts";
import { readConvergeRun, saveConvergeRun, type ConvergeBasis, type ConvergeCheckRun, type ConvergeCheckSpec } from "./converge-checks.ts";
import { laneLocations, stackedSubmitBlocker, submitCheckBasis, submitTreeOf } from "./export.ts";
import { takeHeavyLock } from "./heavy-lock.ts";
import { checkInCopy } from "./gate.ts";
import type { GateCheck } from "./gate.ts";
import { commitTree, filteredTree, names } from "./git.ts";

/**
 * One run of the checks before the S2 loop converges, as its own detached process (converge-checks.ts). It takes the
 * repo's heavy-checks lock for its whole life and never the overlay lock (a run that finds the heavy lock taken waits as
 * `busy` and changes nothing), runs the checks
 * in a detached copy of the tree the submit would check now (`publicTree`), keeps their results for the submit,
 * compares each failure with the public base's tip that tree is built on, and writes the rows into its record. It is
 * the only writer of the record while the record is its own.
 */

function note(text: string): void {
  try { process.stderr.write(text.endsWith("\n") ? text : `${text}\n`); } catch { /* nothing more can be said */ }
}

/** the record while this run is still the lane's newest */
function mine(spec: ConvergeCheckSpec): ConvergeCheckRun | null {
  const now = readConvergeRun(spec.lane);
  return now && now.id === spec.runId ? now : null;
}

function close(spec: ConvergeCheckSpec, fields: Partial<ConvergeCheckRun>): void {
  const now = mine(spec);
  if (now) saveConvergeRun({ ...now, ...fields, ended_at: new Date().toISOString() });
}

/** the ref space the run fetches the public side into (`refs/idd/converge/…`), apart from the submit's and the import's */
export const CONVERGE_REFS = "converge";

/** the tree the checks run on, the files they are told were changed, and the commit a failure is compared with */
interface CheckBasis { tree: string; changed: string[]; base: string; basis: ConvergeBasis; note?: string }

/** the head's tree without the records, against the lane's base: the checks' tree when the submit's cannot be built */
function laneBasis(spec: ConvergeCheckSpec, note: string): CheckBasis {
  return { tree: filteredTree(spec.repo, spec.head, spec.manifestPaths), changed: spec.changed, base: spec.base, basis: "lane", note };
}

/**
 * The tree the submit would check if the lane were submitted now, built by the submit's own functions
 * (`submitTreeOf` / `submitCheckBasis`): the head merged over the public side's tip it fetches now, the files the PR
 * changes against the public base's tip, and that tip to compare a failure with. While the public side stays where it
 * is, the submit reads the results kept here for the tree, the check's definition and the changed files, and the
 * public base's results kept for its tree, and runs nothing again (run 4 of the APP-2251 bench ran the Flutter test
 * four times, the head and the base at S2 and at S4, because the two compared with different bases).
 *
 * The head's own tree against the lane's base, as before, when that tree cannot be had: the public side cannot be
 * reached (no network, a fetch the submit's fetch held), the head conflicts with it (the S3 checks and the mainline
 * merge take a conflict; the S2 checks still see what the lane's own change breaks), the submit itself would refuse
 * (a stacked lane, a public branch to adopt or receive, a repo that does not publish), or the head changes nothing on
 * the public side. The submit then checks its tree on its own, as it did before the checks moved here. Never throws.
 */
function publicTree(spec: ConvergeCheckSpec): CheckBasis {
  try {
    const loc = laneLocations(spec.lane);
    if (!loc) return laneBasis(spec, "lane の提出先（作業本流・公開先）の設定が読めない");
    if (resolve(loc.work) !== resolve(spec.repo)) return laneBasis(spec, "提出が読む lane の作業ツリーが検査の run のものと違う");
    if (!publishes(loc.config)) return laneBasis(spec, "公開しない repo");
    const stacked = stackedSubmitBlocker(spec.lane, loc);
    if (stacked) return laneBasis(spec, stacked);
    // fetched into a ref space of its own: this run holds no overlay lock, and the refs the submit and the import
    // fetch into move only under it
    const built = submitTreeOf(spec.lane, loc, spec.head, spec.manifestPaths, { refSpace: CONVERGE_REFS });
    if (!names(loc.work, built.target, built.tree).length) return laneBasis(spec, "公開側に出す差分が無い");
    const { publicBase, changed } = submitCheckBasis(loc, built, CONVERGE_REFS);
    return { tree: built.tree, changed, base: publicBase, basis: "public" };
  } catch (err) {
    const said = String((err as Error).message ?? err).split("\n")[0].slice(0, 200);
    return laneBasis(spec, /衝突/.test(said) ? `公開側の先端と衝突する: ${said}` : `公開側の先端と合わせた tree を作れない: ${said}`);
  }
}

/**
 * The checks, run in a copy of the tree without the records, and kept for the submit. A kept result is not read
 * here: the loop runs the checks once a head, and a run of a head again is penne's ask to run them again (a continue on
 * a stop over them).
 */
async function checkTree(spec: ConvergeCheckSpec, at: CheckBasis): Promise<GateCheck[]> {
  const commit = commitTree(spec.repo, at.tree, [], "checks before the review converges");
  const rows = await checkInCopy(spec.repo, commit, spec.checks, { area: spec.area, from: spec.from, changed: at.changed, ...(spec.deps ? { deps: spec.deps } : {}) });
  keepResults(spec.area, at.tree, spec.checks, at.changed, rows, "converge");
  return rows;
}

export async function runConvergeCheck(specPath: string): Promise<number> {
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as ConvergeCheckSpec;
  try { rmSync(specPath, { force: true }); } catch { /* the record names the run, the spec is not read again */ }
  const rec = mine(spec);
  if (!rec || rec.status !== "running") return 0;
  saveConvergeRun({ ...rec, pid: process.pid });
  const release = takeHeavyLock(spec.repo, spec.runId);
  if (!release) {
    close(spec, { status: "busy", error: "repo の重い検査が走っているので、空いてから回します", waiting_since: rec.waiting_since ?? new Date().toISOString() });
    return 0;
  }
  const onSignal = () => {
    release();
    close(spec, { status: "failed", error: "検査の run を外から止められました" });
    process.exit(5);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    // the tree is built under the heavy-checks lock, so the public side's tip is read as late as it can be before the
    // checks (a run the lock kept out fetches nothing)
    const at = publicTree(spec);
    if (at.note) note(`[converge-check] 公開側の先端と合わせた tree ではなく head の tree で回します: ${at.note}`);
    const rows = await checkTree(spec, at);
    // a failure is compared with the base the tree is built on (the public base's tip, or the lane's base), by the
    // submit's own comparison; a check that names no failures is compared by whether it passes there
    const compared = await withBaseComparison(rows, spec.checks, {
      area: spec.area, repo: spec.repo, from: spec.from, publicBase: () => at.base, manifestPaths: spec.manifestPaths, compareUnnamed: true,
    });
    close(spec, { status: "done", rows: compared, base: at.base, tree: at.tree, basis: at.basis, ...(at.note ? { basis_note: at.note } : {}) });
    return 0;
  } catch (err) {
    const reason = `検査を回せませんでした: ${String((err as Error).message ?? err).slice(0, 300)}`;
    note(`[converge-check] ${reason}`);
    close(spec, { status: "failed", error: reason });
    return 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    release();
  }
}

const specPath = process.argv.slice(2)[0]?.trim() || null;
const runDirectly = process.argv[1] && existsSync(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runDirectly && specPath) {
  runConvergeCheck(specPath).then((code) => { process.exitCode = code; }, (err) => {
    note(`[converge-check] ${String((err as Error).message ?? err).slice(0, 300)}`);
    process.exitCode = 1;
  });
}
