import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readAreas } from "../config/areas.ts";
import { areaSegment, slugOf } from "../intent/parse.ts";
import { placeOf } from "../intent/places.ts";
import { deriveStage } from "../ledger/derive.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";
import { lanePlanDoc } from "./plan-doc.ts";

/**
 * A lane waiting at GO whose plan's places were changed on the work branch since the plan was made. A mark on the
 * lane's record only: it moves no stage (derive reads past it), starts nothing and asks for no pass of the tick. The
 * GO card reads it; checking the plan again is penne's send-back.
 */
export const BASE_ADVANCED = "s1_base_advanced";

/** the most files a record lists; the rest are a count */
export const BASE_ADVANCE_FILES_MAX = 50;

function gitRaw(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
}

function git(cwd: string, args: string[]): string {
  return gitRaw(cwd, args).trim();
}

/** paths git lists with -z: NUL-separated and never quoted, so a path that is not ASCII reads as itself */
function gitPaths(cwd: string, args: string[]): string[] {
  return gitRaw(cwd, [args[0], "-z", ...args.slice(1)]).split("\0").filter(Boolean);
}

/**
 * The planner's documents of a lane, relative to its worktree. The reference is read where `parseIntent` reads it:
 * under `_docs/reference/`, else beside the decisions.
 */
export function planDocPaths(rec: BacklogRecord): { decision: string; reference: string; referenceBesideIntent: string } {
  const seg = areaSegment(rec.area);
  const slug = slugOf(rec);
  return {
    decision: `_docs/intent/${seg}/${slug}/decision.md`,
    reference: `_docs/reference/${seg}/${slug}/reference.md`,
    referenceBesideIntent: `_docs/intent/${seg}/${slug}/reference.md`,
  };
}

function readDoc(root: string, rel: string): string | null {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function backquoted(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/**
 * The paths a line of the reference names: those that open a list item (`- \`a\` / \`b\` — why`), or the first cell
 * of a table row. What the line says after them (why it was read) is not read.
 */
function referenceTokens(line: string): string[] {
  const item = line.match(/^\s*[-*]\s+((?:`[^`]+`[\s/,、・]*)+)/);
  if (item) return backquoted(item[1]);
  const row = line.match(/^\s*\|([^|]*)\|/);
  return row ? backquoted(row[1]) : [];
}

/**
 * The places a plan says it touches: every path in the Anchors of its decisions, and every file its reference read
 * (what the plan stands on). Read from the lane's files alone, without git. `known` is false only when neither
 * names a place at all, and then any change of the work branch counts.
 */
export function planTouchedPaths(rec: BacklogRecord, root: string | undefined): { known: boolean; paths: string[] } {
  if (!root) return { known: false, paths: [] };
  const docs = planDocPaths(rec);
  const places = new Set<string>();
  const add = (tokens: string[]) => {
    for (const tok of tokens) {
      const p = placeOf(tok, root);
      if (p) places.add(p);
    }
  };
  const decision = readDoc(root, docs.decision);
  if (decision !== null) {
    let inAnchors = false;
    for (const line of decision.split("\n")) {
      if (/\*\*Anchors\*\*/.test(line)) {
        inAnchors = true;
        add(backquoted(line));
        continue;
      }
      // an Anchors written as an indented list goes on until the next item of the decision or a heading
      if (inAnchors && /^\s+\S/.test(line)) add(backquoted(line));
      else inAnchors = false;
    }
  }
  const reference = readDoc(root, docs.reference) ?? readDoc(root, docs.referenceBesideIntent);
  if (reference !== null) {
    for (const line of reference.split("\n")) add(referenceTokens(line));
  }
  // the work instruction holds the places most closely; with DECs fewer, reading it keeps the list from narrowing (DEC-2645)
  const plan = lanePlanDoc(rec, root);
  if (plan) {
    const planText = readDoc(root, plan.rel);
    if (planText !== null) {
      for (const line of planText.split("\n")) add(referenceTokens(line));
    }
  }
  const paths = [...places].sort();
  return { known: paths.length > 0, paths };
}

/** the worktree the lane's planner wrote its plan in */
export function laneWorktreeOf(iddId: string): string | undefined {
  const rec = readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  return rec?.worktree_path || undefined;
}

export interface BaseAdvance {
  /** where the plan stands: the lane's fork from the work branch */
  from: string;
  /** the work branch now */
  to: string;
  /** the changed files among the places the plan touches (every changed file when the plan names none) */
  hits: string[];
  /** the plan names its places */
  known: boolean;
}

function touches(file: string, place: string): boolean {
  return place.endsWith("/") ? file.startsWith(place) : file === place || file.startsWith(`${place}/`);
}

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function attrsOf(adv: BaseAdvance): Record<string, unknown> {
  return { from: adv.from, to: adv.to, files: adv.hits.slice(0, BASE_ADVANCE_FILES_MAX), files_total: adv.hits.length, known: adv.known };
}

/** a record as the stage reads it back; `cut` when it lists only the head of its files */
interface Seen { from: string; to: string; files: string[]; total: number; cut: boolean; known: boolean }

function seenOf(e: LifecycleRecord): Seen {
  const files = listOf(e.attrs?.files);
  const total = Number(e.attrs?.files_total ?? files.length);
  return { from: String(e.attrs?.from ?? ""), to: String(e.attrs?.to ?? ""), files, total, cut: total > files.length, known: e.attrs?.known !== false };
}

/**
 * What the lane's current plan is judged against. `current` is the last record after the plan's last ready: what its
 * GO card shows. With none, `prior` is the last record before that ready: a move the plan was made again after
 * (penne saw it on the card), which the new plan is not shown again. `plan` names the plan's version.
 */
function recordsOf(events: LifecycleRecord[]): { current?: Seen; prior?: Seen; plan: string } {
  const ready = events.map((e) => e.event).lastIndexOf("s1_ready");
  let current: Seen | undefined;
  let prior: Seen | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event !== BASE_ADVANCED) continue;
    if (i > ready) {
      current ??= seenOf(events[i]);
      continue;
    }
    prior = seenOf(events[i]);
    break;
  }
  return { ...(current ? { current } : {}), ...(prior ? { prior } : {}), plan: ready >= 0 ? `${ready} ${events[ready].at}` : "" };
}

/** git's answer to a yes-or-no question: 0 is yes, 1 is no, and a commit it cannot find (128) is no too */
function gitYes(cwd: string, args: string[]): boolean {
  try {
    gitRaw(cwd, args);
    return true;
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    if (status === 1 || status === 128) return false;
    throw err;
  }
}

/**
 * Where the lane was last looked at: its plan's version, its HEAD and the work branch, and the plan's places. While
 * they stay, the stage runs no git past the one rev-parse that reads them. Kept in this process only: a stage that
 * starts afresh looks each lane over once, and a record with the same fork and work branch stops it before the diff.
 */
const checked = new Map<string, string>();

/** start the stage afresh, as a new process would (for tests) */
export function forgetBaseAdvanceChecks(): void {
  checked.clear();
}

type Judged = { record: BaseAdvance | null; mark: string; key: string } | { error: string } | null;

/**
 * How the work branch moved since the plan's fork, and whether that is a move the lane's record does not say yet.
 * A move into the plan's places is recorded when it holds a change made after what the lane's record already says:
 * after the current plan's record (what its card shows), or else after the record the plan was made again after.
 * The record the plan was made again after says only the files it lists: a plan made again may name new places,
 * so that record stands for the move only when every changed file of the new plan's places is on its list, and
 * never when its list was cut to its head. A move penne already saw is so not shown again within the plan or on
 * the plan made after it, and neither a later commit into the same files nor a change to a place the new plan
 * added is hidden. With no change of the plan's places left, a current record with files is
 * cleared once (a record with none). A plan that names no place counts every change of the work branch, so its
 * files grow with each move: it is recorded once for each plan. Null when there is nothing to read (the repo names no
 * work branch, the lane has no worktree); an error when git could not tell.
 */
function judgeBaseAdvance(rec: BacklogRecord, worktree: string | undefined, events: LifecycleRecord[]): Judged {
  const workBase = readAreas().areas[rec.area]?.work_base;
  if (!workBase || !worktree || !existsSync(worktree)) return null;
  try {
    const [head, to] = git(worktree, ["rev-parse", "HEAD^{commit}", `refs/heads/${workBase}^{commit}`]).split("\n");
    if (!head || !to) throw new Error("rev-parse が commit を返しませんでした");
    const touched = planTouchedPaths(rec, worktree);
    const { current, prior, plan } = recordsOf(events);
    const key = `${worktree}\n${rec.idd_id}`;
    const mark = [plan, head, to, touched.known, ...touched.paths].join("\n");
    if (checked.get(key) === mark) return { record: null, mark, key };
    const none = { record: null, mark, key };

    const from = git(worktree, ["merge-base", head, to]);
    if (current && current.from === from && current.to === to) return none;
    const known = touched.known;
    const inPlan = (files: string[]) => (known ? files.filter((f) => touched.paths.some((p) => touches(f, p))) : files);
    const hits = from === to ? [] : inPlan(gitPaths(worktree, ["diff", "--name-only", "--no-renames", from, to])).sort();
    const record = { record: { from, to, hits, known }, mark, key };
    /** every changed file of the plan's places is on the list of `seen` */
    const listed = (seen: Seen): boolean => !seen.cut && hits.every((f) => seen.files.includes(f));
    /** a change of the plan's places made after what `seen` says */
    const changedSince = (seen: Seen): boolean => {
      const base = seen.from === from || gitYes(worktree, ["merge-base", "--is-ancestor", from, seen.to]) ? seen.to : from;
      if (base === to) return false;
      if (base === from) return hits.length > 0;
      return inPlan(gitPaths(worktree, ["diff", "--name-only", "--no-renames", base, to])).length > 0;
    };

    if (current) {
      if (!known && !current.known) return none;
      if (!hits.length) return current.total > 0 ? record : none;
      if (known !== current.known || current.from !== from) return record;
      return changedSince(current) ? record : none;
    }
    if (!hits.length) return none;
    if (prior && listed(prior) && !changedSince(prior)) return none;
    return record;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { error: `作業本流 ${workBase} の進みを確かめられませんでした: ${String(e.stderr || e.message || err).trim().slice(0, 300)}` };
  }
}

export interface BaseAdvanceView {
  to: string;
  files: string[];
  /** files the record counts but does not list */
  more: number;
  known: boolean;
}

/**
 * What the GO card shows: the latest record made for the current plan (after its last ready). A plan made again
 * after a send-back starts with none, so a move penne already sent the plan back for is not shown again. A record
 * with no file (no change of the plan's places is left between the fork and the work branch) shows nothing.
 */
export function currentBaseAdvance(events: LifecycleRecord[]): BaseAdvanceView | null {
  const ready = events.map((e) => e.event).lastIndexOf("s1_ready");
  for (let i = events.length - 1; i > ready; i -= 1) {
    const e = events[i];
    if (e.event !== BASE_ADVANCED) continue;
    const files = listOf(e.attrs?.files);
    const total = Number(e.attrs?.files_total ?? files.length);
    if (total === 0) return null;
    return { to: String(e.attrs?.to ?? ""), files, more: Math.max(0, total - files.length), known: e.attrs?.known !== false };
  }
  return null;
}

function laneEvents(iddId: string): LifecycleRecord[] {
  return readLifecycle().filter((e) => e.idd_id === iddId);
}

/**
 * The tick's stage: for each lane waiting at GO, read how the work branch moved since the plan's fork, and record a
 * move the lane's record does not say yet (see `judgeBaseAdvance`). A lane that has moved on, or been recorded,
 * while git ran is left for the next tick. Nothing else is read or written, and a failure of one lane does not stop
 * the others: it is returned with its reason.
 */
export async function runBaseAdvance(): Promise<{ recorded: string[]; errors: { iddId: string; error: string }[] }> {
  const recorded: string[] = [];
  const errors: { iddId: string; error: string }[] = [];
  const events = readLifecycle();
  const looked = new Set<string>();
  for (const rec of readBacklog()) {
    const evs = events.filter((e) => e.idd_id === rec.idd_id);
    if (deriveStage(evs).decision !== "go") continue;
    try {
      const judged = judgeBaseAdvance(rec, laneWorktreeOf(rec.idd_id), evs);
      if (!judged) continue;
      if ("error" in judged) {
        errors.push({ iddId: rec.idd_id, error: judged.error });
        continue;
      }
      looked.add(judged.key);
      if (!judged.record) {
        checked.set(judged.key, judged.mark);
        continue;
      }
      const now = laneEvents(rec.idd_id);
      if (deriveStage(now).decision !== "go" || JSON.stringify(recordsOf(now)) !== JSON.stringify(recordsOf(evs))) continue;
      await appendLifecycle(BASE_ADVANCED, rec.idd_id, attrsOf(judged.record));
      checked.set(judged.key, judged.mark);
      recorded.push(rec.idd_id);
    } catch (err) {
      errors.push({ iddId: rec.idd_id, error: String(err).slice(0, 300) });
    }
  }
  for (const key of [...checked.keys()]) if (!looked.has(key)) checked.delete(key);
  return { recorded, errors };
}
