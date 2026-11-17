import { join } from "node:path";

import type { CheckPrep } from "../config/areas.ts";
import { CUT_BY_OUTPUT, CUT_BY_TIME, commandEnv, copyParent, cutCopy, hiddenOf, hideIn, runLimited, type GateCheck, type Hidden, type StructureRowKind, type StructureSide } from "./gate.ts";
import { git } from "./git.ts";
import { STRUCTURE_DECL_PATH, parseStructure, type StructureDecl } from "../config/structure.ts";
import { copyName, dropCopy } from "../worktree/copies.ts";

/**
 * The structure counts of one landing (C-243-1, C-243-5): a repo that declares `config/structure.yaml` has its tree
 * counted in the mainline tip and in the merge commit, by one run of the declared command, and a merge that carries
 * more of a blocking count than the mainline is stopped. The other counts are only written down.
 *
 * The declaration and the command are read from the mainline tip, not from the merge commit and not from the running
 * checkout: a lane that could change them in the landing they grade would grade itself. Only a landing into a mainline
 * that has no declaration yet reads the merge commit's. A repo with a declaration in neither is not measured and not
 * stopped.
 *
 * A count that cannot be taken stops the landing, as an increment does (DEC-746). Nothing here is carried over from an
 * earlier tip: the whole tree is counted, so a count taken at another tip says nothing about this merge commit.
 *
 * Both sides are counted in copies cut for the count, from the commits themselves and never prepared or checked: what a
 * setup or a check left in the checks' copy is not in the merge commit, and must not move its number.
 *
 * A merge commit that drops the declaration the mainline has, or a blocking count the mainline's names, is stopped as a
 * count that cannot be taken: removing the ratchet is not a way past it. Whoever means to remove it puts it into the
 * mainline directly.
 *
 * The rows go to the card and the same measurement goes into the round's record, so the two never disagree.
 */

/** the prefix of a row's name; the numbers beside it are a tree's counts, not eslint's (`counts` readers skip these) */
export const STRUCTURE_ROW_PREFIX = "structure/";

/** what one landing measured, as the round's record keeps it */
export interface StructureMeasure {
  /** the mainline tip both sides are compared at */
  at: string;
  /** whose declaration and command measured: the mainline tip's, or (a mainline with none) the merge commit's */
  source: "mainline" | "merged";
  /** the counts that stop a landing */
  blocking: string[];
  /** every count of the mainline tip's tree and of the merge commit's tree; a side that could not be counted is empty */
  mainline: Record<string, number>;
  merged: Record<string, number>;
  /** why the counts could not all be taken, when they could not */
  failure?: string;
}

export interface StructureInput {
  /** the clone the copies are cut from */
  repo: string;
  /** the registry key: its review_root decides where the mainline copy is cut */
  area: string;
  /** the mainline tip: the merge commit's other parent, and what this landing is compared against */
  mainTip: string;
  mergeCommit: string;
  /** a node_modules linked into the mainline copy, which the command's imports resolve through */
  deps?: string;
  /** the repo's check preparation: its `copy` files hold values that no failure may carry */
  prep: CheckPrep;
  signal?: AbortSignal;
}

export interface StructureRun {
  rows: GateCheck[];
  /** absent when the repo declares nothing: there is no round to write a measurement into */
  structure?: StructureMeasure;
}

/** what the command printed, read: the counts, or why it could not be (a count may itself be named `failure`) */
export type CountsRead = { ok: true; counts: Record<string, number> } | { ok: false; failure: string };

/** a count the command printed: one JSON object of finite numbers on the last line */
export function readCounts(output: string): CountsRead {
  const last = output.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return untaken("出力の最後の行が JSON ではありません");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return untaken("出力の最後の行が数の表ではありません");
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "number" && Number.isFinite(value)) out[name] = value;
  }
  return { ok: true, counts: out };
}

/** the declaration's text at a commit: null when the commit has none, an error when git cannot say */
function declarationAt(repo: string, commit: string): string | null {
  const listed = git(repo, ["ls-tree", commit, "--", STRUCTURE_DECL_PATH]).trim();
  return listed ? git(repo, ["show", `${commit}:${STRUCTURE_DECL_PATH}`]) : null;
}

const untaken = (failure: string): CountsRead => ({ ok: false, failure });

/** one tree counted by the declaration's command, run from the tree the declaration was read in */
async function count(from: string, target: string, decl: StructureDecl, hide: Hidden, signal?: AbortSignal): Promise<CountsRead> {
  const env = { ...commandEnv(), IDD_STRUCTURE_ROOT: target, IDD_STRUCTURE_DECL: join(from, STRUCTURE_DECL_PATH) };
  const run = await runLimited(from, decl.command, decl.timeoutMinutes, env, signal);
  // the reason goes on a line of its own: a cut by the time limit is read from the head of a line (`CUT_BY_TIME_RE`)
  if (run.noTimeout) return untaken("timeout(1) が見つからないので回せませんでした");
  if (run.timedOut) return untaken(CUT_BY_TIME(decl.timeoutMinutes));
  if (run.stopped) return untaken("検査を止めました");
  if (run.missing) return untaken(`数えるコマンドが見つかりません（${decl.command[0]}）`);
  if (run.overflow) return untaken(CUT_BY_OUTPUT);
  // what the command printed may hold a copied file's value: it is kept out of the failure, or left out when it cannot be told apart
  const printed = hide.opaque.length
    ? `copy したファイル（${hide.opaque.join(", ")}）の値を含みうるので出力を省きました`
    : hideIn(run.output, hide.values).slice(-800);
  if (run.code !== 0) return untaken(`数えるコマンドが失敗しました（exit ${run.code ?? "?"}）\n${printed}`);
  const read = readCounts(run.stdout);
  return read.ok ? read : untaken(`${read.failure}\n${printed}`);
}

function failed(name: string, detail: string, structure: StructureRowKind): GateCheck {
  return { name, status: "fail", severity: "blocking", detail: detail.slice(0, 1500), structure };
}

/** why the merge commit's declaration no longer holds the ratchet the mainline's does, or null when it does */
function weakened(main: StructureDecl, mergedText: string | null): string | null {
  if (mergedText === null) return "取り込む側の tree から構造の宣言（config/structure.yaml）が消えています";
  let merged: StructureDecl;
  try {
    merged = parseStructure(mergedText);
  } catch (e) {
    return `取り込む側の構造の宣言を読めません: ${(e as Error).message}`;
  }
  const lost = main.blocking.filter((name) => !merged.blocking.includes(name));
  return lost.length ? `取り込む側の宣言から止める数（${lost.join(", ")}）が外れています` : null;
}

/** the declaration's command as a row may carry it: the values of the repo's copied files are taken out, or the whole command is left out when they cannot be told apart */
function shownCommand(repo: string, copy: string[], command: string[]): string[] {
  try {
    const hide = hiddenOf(repo, copy);
    return hide.opaque.length ? [] : command.map((word) => hideIn(word, hide.values));
  } catch {
    return [];
  }
}

/**
 * The rows of the blocking counts: a count missing on either side is a failure, an increase is a failure. A row says
 * itself which kind it is and, for a count that could not be taken, which sides lacked it: `thrown` names the sides
 * the measurement itself broke on, whose counts are empty without a command having printed less.
 */
function rowsOf(measure: StructureMeasure, ms: number, command: string[], thrown: StructureSide[]): GateCheck[] {
  const rows: GateCheck[] = [];
  const withCommand = command.length ? { command } : {};
  const unmeasured = (name: string): StructureRowKind => ({
    kind: "unmeasured",
    sides: (["mainline", "merged"] as const).filter((side) => thrown.includes(side) || measure[side][name] === undefined),
    ...withCommand,
  });
  for (const name of measure.blocking) {
    const row = `${STRUCTURE_ROW_PREFIX}${name}`;
    if (measure.failure && (measure.mainline[name] === undefined || measure.merged[name] === undefined)) {
      rows.push(failed(row, measure.failure, unmeasured(name)));
      continue;
    }
    const base = measure.mainline[name];
    const merged = measure.merged[name];
    if (base === undefined) { rows.push(failed(row, `本流の先端の数 ${name} が出てきませんでした`, unmeasured(name))); continue; }
    if (merged === undefined) { rows.push(failed(row, `取り込む側の数 ${name} が出てきませんでした`, unmeasured(name))); continue; }
    const delta = merged - base;
    rows.push({
      name: row,
      status: delta > 0 ? "fail" : "pass",
      severity: "blocking",
      ms,
      counts: { mainline: base, merged, at: measure.at },
      ...(delta > 0 ? { detail: `本流 ${base} / 取り込み ${merged}（+${delta}）: この取り込みで本流の ${name} が増えます`, structure: { kind: "increase", ...withCommand } } : {}),
    });
  }
  return rows;
}

/**
 * The structure rows of a landing and the measurement they come from. Each side is counted in a copy cut from its
 * commit, removed before this returns; the command runs from the copy that holds the declaration.
 */
export async function structureRun(input: StructureInput): Promise<StructureRun> {
  if (input.signal?.aborted) return { rows: [] };
  let mainDecl: string | null;
  let mergedDecl: string | null;
  try {
    mainDecl = declarationAt(input.repo, input.mainTip);
    mergedDecl = declarationAt(input.repo, input.mergeCommit);
  } catch (e) {
    return { rows: [failed("structure", `構造の宣言を読めませんでした: ${String((e as Error).message).split("\n")[0]}`, { kind: "unmeasured", sides: ["mainline", "merged"] })] };
  }
  const text = mainDecl ?? mergedDecl;
  if (text === null) return { rows: [] };
  const source = mainDecl === null ? "merged" : "mainline";
  const started = Date.now();
  let decl: StructureDecl;
  try {
    decl = parseStructure(text);
  } catch (e) {
    const detail = `構造の宣言を読めませんでした（${source === "mainline" ? "本流の先端" : "取り込む側"}）: ${(e as Error).message}`;
    return { rows: [failed("structure", detail, { kind: "unmeasured", sides: [source] })], structure: { at: input.mainTip, source, blocking: [], mainline: {}, merged: {}, failure: detail } };
  }
  const measure: StructureMeasure = { at: input.mainTip, source, blocking: decl.blocking, mainline: {}, merged: {} };
  if (mainDecl !== null) {
    const why = weakened(decl, mergedDecl);
    const shown = why ? shownCommand(input.repo, input.prep.copy, decl.command) : [];
    if (why) return { rows: [failed("structure", why, { kind: "weakened", ...(shown.length ? { command: shown } : {}) })], structure: { ...measure, failure: why } };
  }
  const copies: string[] = [];
  const thrown: StructureSide[] = [];
  try {
    // each side is its own commit's tree, cut here: the command runs from the copy that holds the declaration
    const cut = (commit: string): string => {
      const copy = cutCopy(input.repo, commit, { area: input.area, name: copyName(copyParent(input.area)), deps: input.deps });
      copies.push(copy);
      return copy;
    };
    const mainline = cut(input.mainTip);
    const merged = cut(input.mergeCommit);
    const from = source === "mainline" ? mainline : merged;
    const hide = hiddenOf(input.repo, input.prep.copy);
    const base = await count(from, mainline, decl, hide, input.signal);
    if (input.signal?.aborted) return { rows: [] };
    const head = await count(from, merged, decl, hide, input.signal);
    if (input.signal?.aborted) return { rows: [] };
    if (base.ok) measure.mainline = base.counts;
    if (head.ok) measure.merged = head.counts;
    const why = [
      !base.ok ? `本流の先端の数を測れませんでした:\n${base.failure}` : "",
      !head.ok ? `取り込む側の数を測れませんでした:\n${head.failure}` : "",
    ].filter(Boolean).join("\n");
    if (why) measure.failure = why;
  } catch (e) {
    measure.failure = `構造の数を測れませんでした: ${String((e as Error).message ?? e).split("\n")[0]}`;
    // the throw does not say which side it broke on: neither side's count is taken as measured
    thrown.push("mainline", "merged");
  } finally {
    for (const copy of copies) dropCopy(copy, input.repo);
  }
  return { rows: rowsOf(measure, Date.now() - started, shownCommand(input.repo, input.prep.copy, decl.command), thrown), structure: measure };
}
