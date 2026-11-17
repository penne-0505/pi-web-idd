import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CUT_BY_OUTPUT, CUT_BY_TIME, commandEnv, copyParent, cutCopy, describe, hideIn, prepareCopy, runLimited, type GateCheck, type Hidden, type Limited } from "./gate.ts";
import type { AreaIncrement, IncrementCount } from "../config/increments.ts";
import type { CheckPrep } from "../config/areas.ts";
import { copyName, dropCopy } from "../worktree/copies.ts";

/**
 * The increment checks of one landing: a count the repo declares (eslint's warnings, today) is measured in the
 * mainline tip and in the merge commit the landing would make, and a merge that carries more of them than the
 * mainline is stopped. The mainline tip is the merge commit's other parent, so the difference is exactly what this
 * landing adds to the mainline; a count taken against the branch point would also carry every other lane's additions.
 *
 * The two counts are written as their own rows of the landing's checks, so the card shows which check stopped it and
 * how many each side had, and the lint check's own pass / fail stays what its exit code says.
 *
 * A count that cannot be taken on either side stops the landing (DEC-746): a merge whose increase nobody measured is
 * not a merge that was checked.
 *
 * The run in the merge commit may also answer a check of the repo (a lint whose command is the same eslint): that
 * check's row is built from the same run, so the copy is not linted twice (C-224-1). The rows stay two, each under its
 * own name, so the card still tells which one stopped the landing.
 */

/** how a command's output is read as one number; a failure says why it could not be read */
export type CountReading = { count: number } | { failure: string };

/** the most spans of a mixed output tried as a JSON list before it is called unreadable */
const SPAN_TRIES = 64;

/**
 * The JSON list a command printed, when other lines (a warning that leaked to stderr, a banner) come before or after
 * it. The whole text is tried first; then every span from a line that opens a list to a line that closes one, the
 * latest first. Null when no span parses as a list. `accept` says which lists count as the one wanted: a list that
 * another line printed (`[]`, `["x"]`) is not taken for it. An empty list is taken only when it is the whole output
 * (what eslint prints for no file), never as a span of a mixed one.
 */
function jsonListIn(output: string, accept: (list: unknown[]) => boolean = () => true): unknown[] | null {
  const whole = output.trim();
  const parse = (text: string): unknown[] | null => {
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const direct = parse(whole);
  if (direct && accept(direct)) return direct;
  const lines = whole.split("\n");
  const opens: number[] = [];
  const closes: number[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("[")) opens.push(i);
    if (t.endsWith("]")) closes.push(i);
  });
  let tries = 0;
  for (const from of opens.reverse()) {
    for (const to of [...closes].reverse()) {
      if (to < from) break;
      if (++tries > SPAN_TRIES) return null;
      const found = parse(lines.slice(from, to + 1).join("\n"));
      if (found?.length && accept(found)) return found;
    }
  }
  return null;
}

/** whether a list has the shape of eslint's `-f json` results: every item a file with the path and the two counts eslint always prints */
function isEslintResults(list: unknown[]): boolean {
  return list.every((item) => {
    if (!item || typeof item !== "object") return false;
    const file = item as { filePath?: unknown; warningCount?: unknown; errorCount?: unknown };
    return typeof file.filePath === "string" && Number.isFinite(file.warningCount) && Number.isFinite(file.errorCount);
  });
}

/** `eslint-json`: eslint's `-f json` output, the warnings of every file summed; `number`: the last line of the output */
export function countOf(kind: IncrementCount, output: string): CountReading {
  if (kind === "number") {
    const last = output.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
    return /^\d+$/.test(last) ? { count: Number(last) } : { failure: "出力の最後の行が数ではありません" };
  }
  const parsed = jsonListIn(output, isEslintResults);
  if (!parsed) return { failure: "出力を JSON の一覧として読めませんでした（eslint -f json の形で出してください）" };
  let count = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const warnings = Number((item as { warningCount?: unknown }).warningCount ?? 0);
    if (Number.isFinite(warnings) && warnings > 0) count += warnings;
  }
  return { count };
}

/** the longest list of eslint's errors a check row keeps */
const ERROR_LINES = 12;

/**
 * The errors of an eslint `-f json` output as lines a card can show (`path:line:col rule message`), the copy's own
 * path taken off the front. Null when the output holds no error to show.
 */
export function eslintErrors(output: string, where: string): string | null {
  const parsed = jsonListIn(output, isEslintResults);
  if (!parsed) return null;
  const lines: string[] = [];
  let total = 0;
  let files = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const file = item as { filePath?: unknown; errorCount?: unknown; messages?: unknown };
    const errors = Number(file.errorCount ?? 0);
    if (!Number.isFinite(errors) || errors <= 0) continue;
    total += errors;
    files += 1;
    const path = String(file.filePath ?? "?");
    const rel = path.startsWith(`${where}/`) ? path.slice(where.length + 1) : path;
    for (const m of Array.isArray(file.messages) ? file.messages : []) {
      const message = m as { severity?: unknown; line?: unknown; column?: unknown; ruleId?: unknown; message?: unknown };
      if (message.severity !== 2 || lines.length >= ERROR_LINES) continue;
      lines.push(`${rel}:${message.line ?? "?"}:${message.column ?? "?"} ${message.ruleId ?? "-"} ${String(message.message ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  if (!total) return null;
  return [`eslint のエラー ${total} 件（${files} ファイル）`, ...lines, ...(total > lines.length ? ["…"] : [])].join("\n");
}

interface Measurement {
  count?: number;
  failure?: string;
  ms: number;
  /** the command's own run, when it started: a check built from the same run reads its exit code and output */
  run?: Limited;
}

/** the environment the increment command runs in: the checks' own, with the same changed-file list they get */
function incrementEnv(changed: string[]): { env: NodeJS.ProcessEnv; dir: string | null } {
  if (!changed.length) return { env: commandEnv(), dir: null };
  const dir = mkdtempSync(join(tmpdir(), "idd-increment-"));
  const list = join(dir, "changed");
  writeFileSync(list, changed.map((f) => `${f}\0`).join(""));
  return { env: commandEnv(list), dir };
}

/** one increment's count in one place, read from the command's own output; an unreadable output is a failure */
async function measure(where: string, decl: AreaIncrement, env: NodeJS.ProcessEnv, hide: Hidden, signal?: AbortSignal): Promise<Measurement> {
  const started = Date.now();
  const run = await runLimited(where, decl.command, decl.timeoutMinutes, env, signal);
  const ms = Date.now() - started;
  if (run.noTimeout) return { failure: "timeout(1) が見つからないので回せませんでした", ms, run };
  if (run.timedOut) return { failure: CUT_BY_TIME(decl.timeoutMinutes), ms, run };
  if (run.stopped) return { failure: "検査を止めました", ms, run };
  if (run.missing) return { failure: `数えるコマンドが見つかりません（${decl.command[0]}）`, ms, run };
  if (run.overflow) return { failure: CUT_BY_OUTPUT, ms, run };
  // the command's own stdout first: what leaked to stderr is not part of the data; the mixed output is the second try
  const stdout = countOf(decl.count, run.stdout);
  const read = "failure" in stdout ? countOf(decl.count, run.output) : stdout;
  if ("failure" in read) {
    // a copied file whose value could not be read out leaves nothing to redact, so its output is not kept at all
    // (the same rule the checks' own details follow): the count that cannot be read is not a reading with a value
    const body = hide.opaque.length
      ? `copy したファイル（${hide.opaque.join(", ")}）の値を含みうるので出力を省きました（exit ${run.code ?? "?"}）`
      : hideIn(run.output, hide.values).slice(-800);
    return { failure: `${read.failure}\n${body}`, ms, run };
  }
  return { count: read.count, ms, run };
}

/**
 * The row of a check that this increment's run answers, built the way `runChecks` builds one: it passes on exit 0 with
 * no cut, a command that is not there is skipped, and a failure says why. An eslint failure lists its errors, so the
 * row's detail reads as the lint check's own did.
 */
function sharedRow(share: SharedCheck, decl: AreaIncrement, merged: Measurement, where: string, hide: Hidden): GateCheck {
  const severity = share.required ? "blocking" : "non-blocking";
  const run = merged.run;
  const ms = merged.ms;
  if (!run) return { name: share.name, status: "fail", severity, ms, detail: (merged.failure ?? "回せませんでした").slice(0, 1500) };
  if (run.code === 0 && !run.timedOut && !run.overflow && !run.stopped) return { name: share.name, status: "pass", severity, ms };
  const cut = run.noTimeout || run.timedOut || run.overflow || run.stopped;
  const errors = !cut && !hide.opaque.length && decl.count === "eslint-json" ? eslintErrors(run.stdout, where) ?? eslintErrors(run.output, where) : null;
  const detail = errors ? hideIn(errors, hide.values) : run.stopped ? "検査を止めました" : describe(run, decl.timeoutMinutes, hide);
  return { name: share.name, status: run.missing ? "skipped" : "fail", severity, ms, detail: detail.slice(0, 1500) };
}

/** a check of the repo whose row is built from the run of the increment it names */
export interface SharedCheck {
  name: string;
  required: boolean;
  /** the increment whose run in the merge commit answers this check too */
  increment: string;
}

export interface IncrementInput {
  /** the clone the copies are cut from and the copied files are taken from */
  repo: string;
  /** the registry key: its review_root, copy and setup are the ones the checks run with */
  area: string;
  /** the mainline tip: the merge commit's other parent, and what this landing's count is compared against */
  mainTip: string;
  /** the copy the landing's checks already run in (the merge commit) */
  mergedCopy: string;
  increments: AreaIncrement[];
  changed: string[];
  /** a node_modules linked into the mainline copy when it has none (the same one the checks' copy gets) */
  deps?: string;
  prep: CheckPrep;
  /** the checks answered by an increment's run in the merge commit; their rows come back beside the increments' */
  shared?: SharedCheck[];
  signal?: AbortSignal;
}

/** the rows of a landing's increments, and the rows of the checks their runs answered */
export interface IncrementRun {
  increments: GateCheck[];
  shared: GateCheck[];
}

/**
 * The increment rows of a landing. The mainline side is measured in a copy of the mainline tip cut the same way the
 * checks' copy was (copied files and setup first), so both sides are the same environment; the copy is removed
 * before this returns, whether it measured anything or not.
 */
export async function incrementChecks(input: IncrementInput): Promise<GateCheck[]> {
  return (await incrementRun(input)).increments;
}

/** the increment rows of a landing and, from the same runs in the merge commit, the rows of the checks they answer */
export async function incrementRun(input: IncrementInput): Promise<IncrementRun> {
  const none: IncrementRun = { increments: [], shared: [] };
  if (!input.increments.length) return none;
  if (input.signal?.aborted) return none;
  const { env, dir } = incrementEnv(input.changed);
  let mainline: string | undefined;
  try {
    mainline = cutCopy(input.repo, input.mainTip, {
      area: input.area,
      ...(input.deps ? { deps: input.deps } : {}),
      name: copyName(copyParent(input.area)),
    });
    const ready = await prepareCopy(mainline, input.repo, input.prep, input.signal);
    const sharesOf = (decl: AreaIncrement) => (input.shared ?? []).filter((s) => s.increment === decl.name);
    const increments: GateCheck[] = [];
    const shared: GateCheck[] = [];
    if (ready.failure) {
      // the mainline side cannot be measured: a merge nobody compared is not a checked merge. A check this run answers
      // still needs its row, so the merge commit is run for those only
      for (const decl of input.increments) {
        increments.push(failureRow(decl, `本流の先端の準備ができませんでした: ${ready.failure.detail ?? "準備に失敗しました"}`));
        if (input.signal?.aborted) break;
        const shares = sharesOf(decl);
        if (!shares.length) continue;
        const merged = await measure(input.mergedCopy, decl, env, ready.hide, input.signal);
        for (const share of shares) shared.push(sharedRow(share, decl, merged, input.mergedCopy, ready.hide));
      }
      return { increments, shared };
    }
    for (const decl of input.increments) {
      if (input.signal?.aborted) break;
      const severity = decl.required ? "blocking" : "non-blocking";
      const merged = await measure(input.mergedCopy, decl, env, ready.hide, input.signal);
      for (const share of sharesOf(decl)) shared.push(sharedRow(share, decl, merged, input.mergedCopy, ready.hide));
      const base = await measure(mainline, decl, env, ready.hide, input.signal);
      const ms = merged.ms + base.ms;
      // the reason goes on a line of its own: a cut by the time limit is read from the head of a line (`CUT_BY_TIME_RE`),
      // and a prefix before it would read as a failure of the change
      if (base.count === undefined) {
        increments.push({ name: decl.name, status: "fail", severity, ms, detail: `本流の先端の数を測れませんでした:\n${base.failure ?? "読めませんでした"}`.slice(0, 1500) });
        continue;
      }
      if (merged.count === undefined) {
        increments.push({ name: decl.name, status: "fail", severity, ms, detail: `取り込む側の数を測れませんでした:\n${merged.failure ?? "読めませんでした"}`.slice(0, 1500) });
        continue;
      }
      const delta = merged.count - base.count;
      increments.push({
        name: decl.name,
        status: delta > 0 ? "fail" : "pass",
        severity,
        ms,
        // the tip the numbers belong to: a row carried over from an earlier tip keeps its own (C-193-4)
        counts: { mainline: base.count, merged: merged.count, at: input.mainTip },
        ...(delta > 0 ? { detail: `本流 ${base.count} / 取り込み ${merged.count}（+${delta}）: この取り込みで本流の数が増えます` } : {}),
      });
    }
    return { increments, shared };
  } finally {
    if (mainline) dropCopy(mainline, input.repo);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

function failureRow(decl: AreaIncrement, detail: string): GateCheck {
  return { name: decl.name, status: "fail", severity: decl.required ? "blocking" : "non-blocking", detail: detail.slice(0, 1500) };
}
