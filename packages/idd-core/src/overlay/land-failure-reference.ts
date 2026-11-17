import type { LandFailureCause, LandRecord } from "./land.ts";
import type { LandCheckRun } from "./land-run.ts";
import { CUT_BY_OUTPUT, CUT_BY_TIME_RE } from "./gate.ts";
import { LOCK_CHECKING } from "./git.ts";
import type { GateCheck } from "./gate.ts";

/**
 * Why a landing check failed, as the TypeScript read it before the MoonBit fold took the reading over. It is not on
 * the running path (C-202-1): `packages/idd-core/test/land-check-retry.test.mjs` holds the fold against it over the
 * records the stage keeps (the fixture part of the cross-check).
 */

/** the detail a blocking check is skipped with after the copy's setup failed: a consequence, not a failure of its own */
const SKIPPED_AFTER_SETUP = "準備に失敗したので回していません";

/** whether the row is a count that grew or a declaration that holds less: what the merge commit's own tree decides */
const isStructural = (check: GateCheck): boolean => check.structure?.kind === "increase" || check.structure?.kind === "weakened";

/**
 * why a check's detail says the environment, not the command, stopped it; null when the command itself failed. A
 * structure row is read from the sides it says it lacked, never from its words: the mainline tip's tree holds none of
 * the lane's change, so a count missing there is not the change's
 */
function environmentReasonOf(check: GateCheck): string | null {
  if (check.structure) {
    return check.structure.kind === "unmeasured" && check.structure.sides.includes("mainline") ? `${check.name} の本流の先端の数を測れませんでした` : null;
  }
  const detail = check.detail ?? "";
  if (CUT_BY_TIME_RE.test(detail)) return `${check.name} が時間の上限で打ち切られました`;
  if (detail.includes(CUT_BY_OUTPUT)) return `${check.name} の出力が上限を超えました`;
  if (detail.includes("lockRefused") || detail.includes(LOCK_CHECKING)) return `${check.name} が並走する検査の lock に当たりました`;
  return null;
}

/** the first names of a list, and how many were left out */
function someNames(names: readonly string[]): string {
  const shown = names.slice(0, 3).join("、");
  return names.length > 3 ? `${shown} ほか ${names.length - 3} 件` : shown;
}

/**
 * why a failed check did not fail on the same tests as the round before it: both rounds name the tests they failed on
 * and share none. A round that names no test says nothing of the kind, and the failure stays the change's
 */
function movedTestsReasonOf(saved: LandRecord, check: GateCheck): string | null {
  const now = check.failedTests ?? [];
  const earlier = saved.earlierFailed?.find((e) => e.name === check.name)?.tests ?? [];
  if (!now.length || !earlier.length || now.some((n) => earlier.includes(n))) return null;
  return `${check.name} の落ちたテストが前の回と重なりません（今回: ${someNames(now)} / 前の回: ${someNames(earlier)}）`;
}

/** the cause of a failed landing, as the TypeScript read it */
export function landFailureCauseReference(
  saved: LandRecord | null,
  run: Pick<LandCheckRun, "head" | "mainTip" | "status" | "error" | "started_at"> | null,
): LandFailureCause | null {
  const runOfGroup = run && (!saved || (run.head === saved.head && run.mainTip === saved.mainTip)) ? run : null;
  const unbuilt = !!saved && !saved.mergeCommit && !saved.conflict?.length && !!saved.rebuildFailure;
  // a record of a landing that could not be rebuilt is newer than a run of the same group that began before it: that run ended without a result for an earlier try, and does not stand for this one. A run that says no start does not win
  const started = Date.parse(runOfGroup?.started_at ?? "");
  const taken = Date.parse(saved?.rebuildFailure?.at ?? "");
  const runAfterRecord = !unbuilt || (!Number.isNaN(started) && !Number.isNaN(taken) && started > taken);
  if (runOfGroup && runAfterRecord && (runOfGroup.status === "failed" || runOfGroup.status === "stopped")) {
    return { kind: "environment", reason: runOfGroup.error ?? "検査の run が結果を残さずに終わりました", noResult: true };
  }
  if (saved && !saved.mergeCommit && !saved.conflict?.length && saved.rebuildFailure) {
    const failure = saved.rebuildFailure;
    if (failure.cause === "environment") return { kind: "environment", reason: `生成物（${failure.paths.join(", ")}）をこの環境では作り直せませんでした`, rebuild: failure };
    return { kind: "real", checks: [], rebuild: failure };
  }
  if (!saved || saved.blocking === 0) return null;
  const failing = saved.checks.filter((c) => c.severity === "blocking" && c.status !== "pass" && c.status !== "not-applicable");
  if (!failing.length) return null;
  const reasons = failing.map((c) => (c.status === "fail" ? (c.structure ? environmentReasonOf(c) : environmentReasonOf(c) ?? movedTestsReasonOf(saved, c)) : c.status === "skipped" && c.detail === SKIPPED_AFTER_SETUP ? "" : null));
  if (reasons.every((r) => r !== null) && reasons.some((r) => r)) {
    return { kind: "environment", reason: reasons.filter(Boolean).join("、") };
  }
  return { kind: "real", checks: failing, ...(failing.some(isStructural) ? { structural: true as const } : {}) };
}
