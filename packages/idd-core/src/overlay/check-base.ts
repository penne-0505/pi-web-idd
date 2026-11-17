import { readAreas } from "../config/areas.ts";
import type { AreaCheck } from "../config/areas.ts";
import type { CheckBaseline } from "./check-reason.ts";
import { CUT_BY_OUTPUT, CUT_BY_TIME_RE, checkInCopy } from "./gate.ts";
import type { GateCheck } from "./gate.ts";
import { commitTree, filteredTree, key, read, recordPath, save } from "./git.ts";

/**
 * A required public check that fails at a submit's head is run again at the public base: the tip of the public side
 * the head's tree is built on, without the records. The card and the ledger can then tell a failure the lane made
 * from one that was there before it (run3 of APP-2251 held its push for a Flutter test that failed the same at the
 * base).
 *
 * Only a check that names its failures (`failure_id_pattern`) is compared, by the failures each run named: a check
 * read by pass / fail alone cannot see a failure the lane added to a check that was failing already, so it holds as
 * before and the card says why. A run that did not go to its end (cut, a signal, no `complete_pattern` line) names no
 * failure, and a head and a base that ended with different exit codes are not compared.
 *
 * The base's result is kept by the public base's tree and the check's definition (its name, command, limit, failure
 * rule and the repo's copy / setup): a long check (the Flutter test, 35 minutes) runs once for a tree, whichever lane
 * and whichever head asks. The base's run gets an empty list of changed files (the lane changed nothing there) and no
 * node_modules of the lane. Only a result the command itself gave to its end is kept; a base that gave none leaves
 * the head's failure holding, with why.
 *
 * The base's run is made under the repo's overlay lock the submit's checks hold, as the head's are: two long checks of
 * one repo (the Flutter test) never run side by side (out of memory, a full /tmp), a check made again of the same
 * lane waits instead of throwing 35 minutes away, and the same base is never run twice at once. The lock is held that
 * much longer only for a repo whose checks name their failures.
 */

/** one check's result at a base, as kept */
export interface BaseResult {
  area: string;
  base: string;
  tree: string;
  check: string;
  checkKey: string;
  status: "pass" | "fail";
  /** the command's exit code */
  exitCode: number | null;
  /** the failures the run named */
  failureIds?: string[];
  checkedAt: string;
}

export interface BaseContext {
  area: string;
  /** the clone the copies are cut from (the lane's worktree) */
  repo: string;
  /** the clone the files in `copy` are taken from */
  from: string;
  /** the public base commit the head's tree is built on: read only when a failure has to be compared */
  publicBase: () => string;
  /** the overlay paths kept out of the public tree */
  manifestPaths: string[];
  /**
   * compare a check that names no failures too, by whether it passes at the base: a base that passes makes the head's
   * failure the lane's (`new`), a base that fails as well cannot be told apart (`unknown`). The checks before the S2 loop
   * converges ask this; the submit does not, and holds on such a check as before
   */
  compareUnnamed?: boolean;
}

/** why a check without a failure rule is not compared */
export const NOT_COMPARABLE = "この検査は failure_id_pattern が無く識別子を比べられないので、元から落ちていても止まる";

/** what makes one check's result: changing any of it runs the base again */
export function checkKey(area: string, check: AreaCheck): string {
  const areas = readAreas();
  const prep = areas.checkPrep?.[area];
  return key({
    name: check.name,
    command: check.command,
    timeout: prep?.timeouts?.[check.name] ?? null,
    rule: areas.failureIds?.[area]?.[check.name] ?? null,
    copy: prep?.copy ?? [],
    setup: prep?.setup ?? [],
  });
}

const resultPath = (area: string, tree: string, ck: string) => recordPath("check-base", `${area}\n${tree}\n${ck}`);

/** why a failed row names no failure, in words, for the side that ran it (head / 公開 base) */
function unreadReason(row: GateCheck, side: string): string {
  const detail = row.detail ?? "";
  switch (row.failureIdsUnread) {
    case "cut":
      if (CUT_BY_TIME_RE.test(detail)) return `${side} の検査が時間の上限で打ち切られました`;
      if (detail.includes(CUT_BY_OUTPUT)) return `${side} の検査の出力が上限を超えました`;
      return `${side} の検査が最後まで走りませんでした`;
    case "signal": return `${side} の検査が signal で終わりました（exit ${row.exitCode ?? "なし"}）`;
    case "incomplete": return `${side} の出力に最後まで走った印（complete_pattern）がありません`;
    case "hidden": return `${side} の出力を残していません（複製に写したファイルの値を読み出せない）`;
    default: return `${side} の出力に失敗の識別子がありません`;
  }
}

/** whether a failed row was cut by its limit or its output, as its detail says */
function cutRow(row: GateCheck): boolean {
  const detail = row.detail ?? "";
  return CUT_BY_TIME_RE.test(detail) || detail.includes(CUT_BY_OUTPUT);
}

/** what the head's failure is against the base's result of the same check */
export function compareWithBase(head: GateCheck, base: BaseResult): CheckBaseline {
  const at = { commit: base.base };
  const now = head.failureIds ?? [];
  if (base.status === "pass") return { ...at, verdict: "new", added: now };
  if ((head.exitCode ?? null) !== base.exitCode) {
    return { ...at, verdict: "unknown", reason: `終了コードが head（${head.exitCode ?? "なし"}）と公開 base（${base.exitCode ?? "なし"}）で違う` };
  }
  const then = base.failureIds ?? [];
  if (!then.length) return { ...at, verdict: "unknown", reason: "公開 base の出力に失敗の識別子がありません" };
  const known = new Set(then);
  const added = now.filter((id) => !known.has(id));
  const shared = now.length - added.length;
  return added.length ? { ...at, verdict: "new", added, shared } : { ...at, verdict: "preexisting", shared };
}

/**
 * The submit's check rows, with each required public check that failed at the head marked with what the public base
 * says of it. A row the comparison could not reach (git, the copy) is marked unknown and keeps holding; nothing here
 * throws. A repo none of whose checks names its failures compares nothing and says nothing of it.
 */
export async function withBaseComparison(rows: GateCheck[], checks: AreaCheck[], ctx: BaseContext): Promise<GateCheck[]> {
  const required = (r: GateCheck) => r.severity === "blocking" && r.status === "fail" && checks.some((c) => c.name === r.name && c.required && c.scope !== "records");
  const failing = rows.filter(required);
  if (!failing.length) return rows;
  const rules = readAreas().failureIds?.[ctx.area] ?? {};
  if (!Object.keys(rules).length && !ctx.compareUnnamed) return rows;
  const found = new Map<string, CheckBaseline>();
  const compared: GateCheck[] = [];
  for (const r of failing) {
    if (!rules[r.name]) {
      if (!ctx.compareUnnamed) found.set(r.name, { verdict: "unknown", reason: NOT_COMPARABLE });
      // only a failure the command gave by itself says the tree fails: a run cut or ended by a signal is the machine's
      else if (cutRow(r)) found.set(r.name, { verdict: "unknown", reason: unreadReason({ ...r, failureIdsUnread: "cut" }, "head") });
      else if (typeof r.exitCode !== "number" || r.exitCode >= 128) found.set(r.name, { verdict: "unknown", reason: unreadReason({ ...r, failureIdsUnread: "signal" }, "head") });
      else compared.push(r);
    }
    else if (!r.failureIds?.length) found.set(r.name, { verdict: "unknown", reason: unreadReason(r, "head") });
    else compared.push(r);
  }
  if (compared.length) {
    try {
      for (const [name, b] of await baselines(compared, checks, ctx)) found.set(name, b);
    } catch (e) {
      const reason = `公開 base の検査を回せませんでした: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`;
      for (const r of compared) found.set(r.name, { verdict: "unknown", reason });
    }
  }
  return rows.map((r) => (found.has(r.name) ? { ...r, baseline: found.get(r.name)! } : r));
}

async function baselines(failing: GateCheck[], checks: AreaCheck[], ctx: BaseContext): Promise<Map<string, CheckBaseline>> {
  const commit = ctx.publicBase();
  const tree = filteredTree(ctx.repo, commit, ctx.manifestPaths);
  const wanted = failing.map((row) => {
    const check = checks.find((c) => c.name === row.name)!;
    const ck = checkKey(ctx.area, check);
    return { row, check, ck, path: resultPath(ctx.area, tree, ck) };
  });
  const kept = new Map<string, BaseResult>();
  for (const w of wanted) {
    const saved = read<BaseResult>(w.path);
    if (saved) kept.set(w.row.name, saved);
  }
  const refused = new Map<string, string>();
  const missing = wanted.filter((w) => !kept.has(w.row.name));
  if (missing.length) {
    const base = commitTree(ctx.repo, tree, [], "public base checks");
    const ran = await checkInCopy(ctx.repo, base, missing.map((w) => w.check), { area: ctx.area, from: ctx.from, changed: [] });
    // a copy that could not be prepared, or that a check changed, gave no result of the base
    const spoiled = ran.find((r) => r.name === "setup" || r.name === "check-mutation");
    for (const w of missing) {
      const row = ran.find((r) => r.name === w.row.name);
      // a check that names no failures (compared only for the checks before the S2 loop converges) and fails at the base
      // as well cannot be told apart from the head's failure
      const unnamed = !readAreas().failureIds?.[ctx.area]?.[w.row.name];
      const why = spoiled ? (spoiled.name === "setup" ? "公開 base の複製の準備が失敗しました" : "公開 base の検査が複製を変えました")
        : !row ? "公開 base の結果がありません"
          : row.status === "skipped" ? "公開 base で検査を回せませんでした（未実行）"
            : row.status === "fail" && unnamed && !cutRow(row) && typeof row.exitCode === "number" && row.exitCode < 128 ? "公開 base でも落ちる（失敗の識別子を読まない検査なので、同じ失敗かを比べられない）"
              : row.status === "fail" && (row.failureIdsUnread || !row.failureIds) ? unreadReason(unnamed && cutRow(row) ? { ...row, failureIdsUnread: "cut" } : row, "公開 base")
                : null;
      if (why || !row) { refused.set(w.row.name, why ?? "公開 base の結果がありません"); continue; }
      const result: BaseResult = {
        area: ctx.area, base: commit, tree, check: w.row.name, checkKey: w.ck,
        status: row.status === "pass" ? "pass" : "fail",
        exitCode: row.status === "pass" ? 0 : (row.exitCode ?? null),
        ...(row.failureIds ? { failureIds: row.failureIds } : {}),
        checkedAt: new Date().toISOString(),
      };
      save(w.path, result);
      kept.set(w.row.name, result);
    }
  }
  const out = new Map<string, CheckBaseline>();
  for (const w of wanted) {
    const base = kept.get(w.row.name);
    out.set(w.row.name, base ? compareWithBase(w.row, base) : { commit, verdict: "unknown", reason: refused.get(w.row.name) ?? "公開 base の結果がありません" });
  }
  return out;
}

/** how many failure names one ledger row keeps of a check */
const IDS_KEPT = 20;

/**
 * The failures a push goes out with because the public base has them as well, as the approval's row on the ledger
 * keeps them: which check, at which public base commit, and which failures. Empty when there are none.
 */
export function failingAtBaseOnRecord(checks: readonly GateCheck[]): { check: string; base: string; failures: string[] }[] {
  return checks
    .filter((c) => c.status === "fail" && c.baseline?.verdict === "preexisting")
    .map((c) => ({ check: c.name, base: c.baseline!.commit ?? "", failures: (c.failureIds ?? []).slice(0, IDS_KEPT) }));
}
