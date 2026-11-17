import type { AreaCheck } from "../config/areas.ts";
import { checkKey } from "./check-base.ts";
import { CUT_BY_OUTPUT, CUT_BY_TIME_RE } from "./gate.ts";
import type { GateCheck } from "./gate.ts";
import { key, read, recordPath, save } from "./git.ts";

/**
 * A required public check's result, kept by what makes it: the repo, the tree it ran on (without the records), the
 * check's definition (`checkKey`: its command, limit, failure rule and the repo's copy / setup) and the files it was
 * told were changed (IDD_CHANGED_FILES, which a check such as the Flutter format reads). The checks before the S2 loop
 * converges keep their results here, and the submit's checks read them, so a tree the loop already checked is not
 * checked again for 35 minutes when nothing that makes the result changed (and the other way round).
 *
 * Only a result the command itself gave to its end is kept: a run cut by its limit or its output, ended by a signal,
 * or of a copy whose preparation failed or that a check changed is the machine's, not the tree's, and is run again.
 */

/** one check's result as kept */
export interface KeptResult {
  area: string;
  tree: string;
  check: string;
  checkKey: string;
  changedKey: string;
  row: GateCheck;
  checkedAt: string;
  /** who ran it: the checks before the S2 loop converged, or a submit's checks */
  by?: "converge" | "submit";
}

const changedKeyOf = (changed: readonly string[]) => key([...changed].sort());
const resultPath = (area: string, tree: string, ck: string, changedKey: string) => recordPath("check-results", `${area}\n${tree}\n${ck}\n${changedKey}`);

/** a row without what a comparison wrote on it: the reader compares again against its own base */
function withoutBaseline(row: GateCheck): GateCheck {
  const plain: GateCheck = { ...row };
  delete plain.baseline;
  return plain;
}

/** whether a row is the tree's own result: it passed, or the command failed by itself and went to its end */
export function keepable(row: GateCheck): boolean {
  if (row.status === "pass") return true;
  if (row.status !== "fail") return false;
  if (row.failureIdsUnread) return false;
  if (typeof row.exitCode !== "number" || row.exitCode >= 128) return false;
  const detail = row.detail ?? "";
  return !CUT_BY_TIME_RE.test(detail) && !detail.includes(CUT_BY_OUTPUT);
}

/**
 * The kept results of these checks for the tree and the changed files, by check name. A kept row comes back as it was,
 * with when it was checked (`reused`) and without what a comparison wrote on it (the caller compares again).
 */
export function readKeptResults(area: string, tree: string, checks: readonly AreaCheck[], changed: readonly string[]): Map<string, GateCheck> {
  const out = new Map<string, GateCheck>();
  const ck = changedKeyOf(changed);
  for (const check of checks) {
    let kept: KeptResult | null = null;
    try { kept = read<KeptResult>(resultPath(area, tree, checkKey(area, check), ck)); } catch { kept = null; }
    if (!kept || kept.row?.name !== check.name) continue;
    // the card's row says whose result it shows; its last line stays the check's own (the reason a card reads)
    const said = kept.by === "converge" ? `S2 の検査の結果を使った（${kept.checkedAt}）` : `前の提出の検査の結果を使った（${kept.checkedAt}）`;
    const plain = withoutBaseline(kept.row);
    out.set(check.name, { ...plain, detail: plain.detail ? `${said}\n${plain.detail}` : said, reused: { at: kept.checkedAt } });
  }
  return out;
}

/**
 * Keep the rows of a run of these checks on the tree. Nothing is kept from a run whose copy could not be prepared or
 * that a check changed: its rows are not the tree's.
 */
export function keepResults(area: string, tree: string, checks: readonly AreaCheck[], changed: readonly string[], rows: readonly GateCheck[], by: "converge" | "submit"): void {
  if (rows.some((r) => r.name === "setup" || r.name === "check-mutation")) return;
  const ck = changedKeyOf(changed);
  const at = new Date().toISOString();
  for (const check of checks) {
    const row = rows.find((r) => r.name === check.name);
    if (!row || row.reused || !keepable(row)) continue;
    const kept: KeptResult = { area, tree, check: check.name, checkKey: checkKey(area, check), changedKey: ck, row: withoutBaseline(row), checkedAt: at, by };
    try { save(resultPath(area, tree, kept.checkKey, ck), kept); } catch { /* a result not kept is run again, nothing more */ }
  }
}
