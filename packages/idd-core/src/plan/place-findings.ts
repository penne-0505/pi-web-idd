import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { readAreas } from "../config/areas.ts";
import { laneStates, type LaneState } from "../intent/store.ts";
import { placeMatches } from "../intent/places.ts";
import { readLifecycle } from "../ledger/read.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import { appendWorkRow, readWorkRows, workColumnPath, type WorkRow } from "./work-records.ts";

/** one place-attached finding, as it stands after folding the column */
export interface PlaceFinding {
  id: string;
  lane: string;
  round?: number;
  path: string;
  lines: [number, number] | null;
  commit: string;
  severity: string;
  claim: string;
  status: "open" | "dropped";
  reason?: string;
  /** the lane that declared "fix"; the finding stays open until its lines are rewritten */
  fixLane?: string;
  /** the lane whose "drop" decision took effect */
  disposedBy?: string;
}

/** a finding still to be written: everything but the id, which the column numbers */
export interface PendingFinding {
  lane: string;
  round?: number;
  path: string;
  lines: [number, number] | null;
  commit: string;
  severity: string;
  claim: string;
}

/** the report's finding fields a place finding can take a line from */
export interface RawFinding {
  path?: unknown;
  claim?: unknown;
  line?: unknown;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** the lane's number, the prefix of its finding ids */
export function laneNumberOf(lane: string): string {
  return /^IDD-(\d+)$/.exec(lane)?.[1] ?? lane;
}

/** the next `F-<lane number>-<n>` over the whole column for the lane */
export function nextFindingId(rows: WorkRow[], lane: string): string {
  const prefix = `F-${laneNumberOf(lane)}-`;
  let max = 0;
  for (const row of rows) {
    const id = text(row.id);
    if (!id || !id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${prefix}${max + 1}`;
}

/** the head a round looked at, from the review it began with */
export function roundHead(events: LifecycleRecord[], round: number): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.event === "s2_review_started" && Number(e.attrs?.round ?? -1) === round) return text(e.attrs?.head) ?? "";
  }
  return "";
}

/**
 * Read the findings out of the review reports of a round, so a judgement's line can be told. The triage names its
 * accepted items by path and claim, so that is the key read here; a finding it reworded is not matched and gets no
 * line (the place finding still records it, without a range).
 */
export function findingsInReports(files: unknown[]): RawFinding[] {
  const out: RawFinding[] = [];
  for (const file of files) {
    if (typeof file !== "string" || !file) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { findings?: unknown; new_findings?: unknown };
      for (const list of [raw.findings, raw.new_findings]) {
        if (Array.isArray(list)) out.push(...(list as RawFinding[]));
      }
    } catch {
      // an unreadable report gives no line, never a failure
    }
  }
  return out;
}

export interface FindingLine {
  path: string;
  claim: string;
  line: number | null;
}

/** the path-and-claim key a finding's line is told by */
function findingKey(path: unknown, claim: unknown): string {
  return `${text(path) ?? ""}\u0000${text(claim) ?? ""}`;
}

export function linesOfFindings(findings: RawFinding[]): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const f of findings) {
    const claim = text(f.claim);
    if (!claim) continue;
    map.set(findingKey(f.path, claim), num(f.line));
  }
  return map;
}

/** the review findings of the last round a lane read before its judgement, as path/claim to line */
export function roundLines(events: LifecycleRecord[]): Map<string, number | null> {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.event !== "s2_review_findings") continue;
    return linesOfFindings(findingsInReports(Array.isArray(e.attrs?.files) ? (e.attrs!.files as unknown[]) : []));
  }
  return new Map();
}

/** attach the line a judgement's finding had, where it can be told; an item with no match is left as it is */
export function withFindingLines<T extends { path?: string; claim: string; line?: number | null }>(items: T[], lines: Map<string, number | null>): T[] {
  return items.map((item) => {
    const line = lines.get(findingKey(item.path, item.claim));
    if (line === undefined) return item;
    return { ...item, line };
  });
}

/** the path and the line a finding's own text names (`a.ts:12` -> `a.ts`, 12), so the place is a real path */
function normalizePath(raw: string, line: number | null | undefined): { path: string; lines: [number, number] | null } {
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(raw.trim());
  const path = (m?.[1] ?? raw).trim();
  const fromPath = m?.[2] !== undefined ? Number(m[2]) : null;
  const to = m?.[3] !== undefined ? Number(m[3]) : null;
  const from = typeof line === "number" ? line : fromPath;
  if (from === null) return { path, lines: null };
  return { path, lines: [from, to !== null && fromPath !== null ? to : from] };
}

/** the follow-up items a place finding is made from: a path, and a should or a nit that is not an R2's (a lane from before R2 was removed) */
export interface PlaceableFollowup {
  severity: string;
  claim: string;
  path?: string;
  line?: number | null;
  round?: number;
  source?: "unsent" | "r2";
}

/** a follow-up that cannot be placed because the round it came from names no commit to anchor its line to */
export interface HeldFinding {
  path: string;
  claim: string;
  reason: string;
}

/**
 * The place findings to write for a lane's follow-ups: the should / nit items with a path, a past R2's findings left
 * out and musts left to the card. One item per lane, path and claim already on the column is not written again.
 * An item whose round names no head has no commit to anchor its line to; it is held instead of placed, so a
 * commitless finding never points at a line the tick cannot re-place (DEC-105-5).
 */
export function placeFindingsFrom(input: { lane: string; events: LifecycleRecord[]; followups: PlaceableFollowup[]; rows: WorkRow[] }): { pending: PendingFinding[]; held: HeldFinding[] } {
  const seen = new Set(
    input.rows.filter((r) => r.event === "finding_placed" && r.lane === input.lane).map((r) => findingKey(r.path, r.claim)),
  );
  const pending: PendingFinding[] = [];
  const held: HeldFinding[] = [];
  for (const f of input.followups) {
    if (!f.path) continue;
    if (f.severity !== "should" && f.severity !== "nit") continue;
    if (f.source === "r2") continue;
    const where = normalizePath(f.path, f.line);
    const key = findingKey(where.path, f.claim);
    if (seen.has(key)) continue;
    seen.add(key);
    const round = typeof f.round === "number" ? f.round : undefined;
    const commit = round !== undefined ? roundHead(input.events, round) : "";
    if (!commit) {
      held.push({ path: where.path, claim: f.claim, reason: "巡の head を特定できないため、行の基準にできる commit がありません" });
      continue;
    }
    pending.push({
      lane: input.lane,
      ...(round !== undefined ? { round } : {}),
      path: where.path,
      lines: where.lines,
      commit,
      severity: f.severity,
      claim: f.claim,
    });
  }
  return { pending, held };
}

/**
 * Write a lane's place findings into its repo's work column. A failure here is reported, never thrown: the
 * caller (the submit prep) keeps going, so a finding is not lost to a broken write and the submit is not held.
 */
export async function recordPlaceFindings(input: { repo: string; lane: string; events: LifecycleRecord[]; followups: PlaceableFollowup[] }): Promise<{ ok: true; placed: number; held: number } | { ok: false; error: string }> {
  try {
    const rows = readWorkRows(workColumnPath(input.repo));
    const { pending, held } = placeFindingsFrom({ lane: input.lane, events: input.events, followups: input.followups, rows });
    if (held.length) {
      console.warn(`[findings] ${held.length} 件の指摘は commit を持てないため場所に付けません（lane の記録の follow-up のまま残ります）: ${held.map((h) => `${h.path}: ${h.claim}`).join(" / ")}`);
    }
    let serial = Number(nextFindingId(rows, input.lane).slice(`F-${laneNumberOf(input.lane)}-`.length));
    let placed = 0;
    for (const p of pending) {
      await appendWorkRow(input.repo, { event: "finding_placed", id: `F-${laneNumberOf(input.lane)}-${serial}`, ...p });
      placed += 1;
      serial += 1;
    }
    return { ok: true, placed, held: held.length };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err).slice(0, 300) };
  }
}

function linesOf(raw: unknown): [number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const a = num(raw[0]);
  const b = num(raw[1]);
  return a !== null && b !== null ? [a, b] : null;
}

/**
 * Fold the `finding_*` rows of the work column into each finding's current state. A moved row shifts the range and
 * the commit; a dropped row closes it; a `drop` disposal only takes effect once the writing lane has merged (or
 * for the writing lane itself), while a `fix` declaration leaves the finding open and names the lane. Dispositions
 * are read in order, and a lane's later disposition overrides its own earlier one: a `fix` after a `drop` reopens
 * the finding, and a `drop` after a `fix` closes it and clears the declaration.
 */
export function foldPlaceFindings(rows: WorkRow[], events: LifecycleRecord[], viewLane?: string | null): PlaceFinding[] {
  const states: Map<string, LaneState> = laneStates(events);
  const byId = new Map<string, PlaceFinding>();
  const order: string[] = [];
  const merged = (lane: string): boolean => Boolean(states.get(lane)?.mergedAt);
  for (const row of rows) {
    const id = text(row.id);
    if (!id) continue;
    switch (row.event) {
      case "finding_placed": {
        const path = text(row.path);
        if (!path) break;
        if (typeof row.repo !== "string") break;
        byId.set(id, {
          id,
          lane: text(row.lane) ?? "",
          ...(num(row.round) !== null ? { round: num(row.round) as number } : {}),
          path,
          lines: linesOf(row.lines),
          commit: text(row.commit) ?? "",
          severity: text(row.severity) ?? "should",
          claim: text(row.claim) ?? "",
          status: "open",
        });
        order.push(id);
        break;
      }
      case "finding_moved": {
        const f = byId.get(id);
        if (!f) break;
        f.lines = linesOf(row.lines);
        f.commit = text(row.commit) ?? f.commit;
        break;
      }
      case "finding_dropped": {
        const f = byId.get(id);
        if (!f) break;
        f.status = "dropped";
        const reason = text(row.reason);
        if (reason) f.reason = reason;
        break;
      }
      case "finding_disposed": {
        const f = byId.get(id);
        if (!f) break;
        const by = text(row.lane) ?? "";
        if (row.action === "drop") {
          if (viewLane === by || merged(by)) {
            f.status = "dropped";
            f.disposedBy = by;
            const reason = text(row.reason);
            if (reason) f.reason = reason;
            // the same lane's earlier "fix" is taken back
            if (f.fixLane === by) delete f.fixLane;
          }
        } else if (row.action === "fix") {
          // a lane's later "fix" reopens what its own earlier "drop" closed
          if (f.disposedBy === by) {
            f.status = "open";
            delete f.disposedBy;
            delete f.reason;
          }
          f.fixLane = by;
        }
        break;
      }
      default:
        break;
    }
  }
  return order.map((id) => byId.get(id)!);
}

/**
 * The open findings that hold one of the paths. A finding still in a lane that has not merged reaches nobody but
 * that lane; once the lane merged (or finished locally) its findings are delivered with the lane's name.
 */
export function findingsForPaths(input: { rows: WorkRow[]; events: LifecycleRecord[]; paths: string[]; viewLane?: string | null }): PlaceFinding[] {
  const states = laneStates(input.events);
  const viewer = input.viewLane ?? null;
  const paths = input.paths.map((p) => p.replace(/^\.\//, "")).filter(Boolean);
  const out: PlaceFinding[] = [];
  for (const f of foldPlaceFindings(input.rows, input.events, viewer)) {
    if (f.status !== "open") continue;
    if (!paths.some((p) => placeMatches(p, f.path))) continue;
    if (f.lane !== viewer && !states.get(f.lane)?.mergedAt) continue;
    out.push(f);
  }
  return out;
}

/** the open findings a lane itself has placed, whether or not it has merged */
export function findingsOfLane(input: { rows: WorkRow[]; events: LifecycleRecord[]; lane: string }): PlaceFinding[] {
  return foldPlaceFindings(input.rows, input.events, input.lane).filter((f) => f.lane === input.lane);
}

/** one finding-disposal item of a planning report */
export interface FindingDisposal {
  id: string;
  action: "fix" | "drop";
  reason?: string;
}

/** the shape each disposal must have to be accepted */
export function disposalProblem(disposals: unknown): { ok: true; value: FindingDisposal[] } | { ok: false; error: string } {
  if (disposals === undefined || disposals === null) return { ok: true, value: [] };
  if (!Array.isArray(disposals)) return { ok: false, error: "findings は一覧にしてください" };
  const value: FindingDisposal[] = [];
  for (const raw of disposals) {
    if (raw === null || typeof raw !== "object") return { ok: false, error: "findings の各項は { id, action, reason? } の形にしてください" };
    const item = raw as Record<string, unknown>;
    const id = text(item.id);
    if (!id) return { ok: false, error: "findings の各項には id が要ります" };
    if (item.action !== "fix" && item.action !== "drop") return { ok: false, error: `findings の action は fix か drop にしてください: ${String(item.action)}` };
    const reason = text(item.reason);
    if (item.action === "drop" && !reason) return { ok: false, error: `「直さない」には理由が要ります: ${id}` };
    value.push({ id, action: item.action, ...(reason ? { reason } : {}) });
  }
  return { ok: true, value };
}

/** write a planning lane's dispositions of the findings it was handed */
export async function recordFindingDisposals(input: { repo: string; lane: string; disposals: FindingDisposal[] }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    for (const d of input.disposals) {
      await appendWorkRow(input.repo, { event: "finding_disposed", id: d.id, lane: input.lane, action: d.action, ...(d.reason ? { reason: d.reason } : {}) });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err).slice(0, 300) };
  }
}

/** one hunk of a `-U0` diff: the old lines it removes and the new lines it puts in their place */
export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** the hunks of a `git diff -U0` output; anything else in the text is ignored */
export function parseHunks(diff: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff))) {
    out.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return out;
}

/** where one surviving old line lands after the diff, or null when a hunk replaced it */
function newLineOf(line: number, hunks: DiffHunk[]): number | null {
  let offset = 0;
  for (const h of hunks) {
    if (h.oldCount === 0) {
      // a pure insertion names the old line it comes after, so only the lines behind it move
      if (h.oldStart < line) offset += h.newCount;
      continue;
    }
    if (h.oldStart + h.oldCount - 1 < line) {
      offset += h.newCount - h.oldCount;
      continue;
    }
    if (h.oldStart <= line) return null;
  }
  return line + offset;
}

/**
 * Where a line range ends up after the diff, or null when every line of it is gone. Each line is mapped through the
 * hunks on its own, so a hunk that overlaps the range's start or sits inside it moves the lines behind it by its
 * own addition or removal. The result spans the first surviving line to the last.
 */
export function reanchorRange(range: [number, number], hunks: DiffHunk[]): [number, number] | null {
  const [a, b] = range;
  let first: number | null = null;
  let last: number | null = null;
  for (let line = a; line <= b; line += 1) {
    const moved = newLineOf(line, hunks);
    if (moved === null) continue;
    if (first === null) first = moved;
    last = moved;
  }
  if (first === null || last === null) return null;
  return [first, last];
}

export type ReanchorOutcome =
  | { kind: "unchanged" }
  | { kind: "moved"; lines: [number, number] }
  | { kind: "dropped"; reason: string };

/** the stdout of a git call, or null when it fails (an unreadable place never changes anything) */
function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/**
 * Where a place finding stands at the mainline tip. The diff runs from the commit its line was placed at to the tip;
 * a line that is still there is placed at its new number, one that is wholly gone is dropped, and one whose diff
 * cannot be read is left as it is. A finding with no line points at the whole file and is dropped only when the
 * file is gone from the tip.
 */
export function reanchorFinding(input: { cwd: string; commit: string; tip: string; path: string; lines: [number, number] | null }): ReanchorOutcome {
  if (input.lines === null) {
    if (input.tip) {
      const shown = gitOut(input.cwd, ["cat-file", "-e", `${input.tip}:${input.path}`]);
      if (shown === null) return { kind: "dropped", reason: "ファイルが本流に無い" };
    }
    return { kind: "unchanged" };
  }
  const diff = gitOut(input.cwd, ["diff", "-U0", "--no-color", input.commit, input.tip, "--", input.path]);
  if (diff === null) return { kind: "unchanged" };
  const range = reanchorRange(input.lines, parseHunks(diff));
  if (!range) return { kind: "dropped", reason: "指す行が本流で書き換わった" };
  return { kind: "moved", lines: range };
}

export interface ReanchorTickResult {
  moved: string[];
  dropped: string[];
  errors: number;
}

/**
 * The tick's finding stage: for every repo that declares a work branch, each open finding of a merged lane whose
 * commit is not the mainline tip is placed again from the diff, and a line that is wholly gone drops it. A repo or
 * a git call that cannot be read changes nothing. It moves no lane, and a failure is counted, never thrown.
 */
export async function reanchorPlaceFindings(): Promise<ReanchorTickResult> {
  const out: ReanchorTickResult = { moved: [], dropped: [], errors: 0 };
  const events = readLifecycle();
  const states = laneStates(events);
  let areas: Record<string, { local_path?: string; work_base?: string }>;
  try {
    areas = readAreas().areas;
  } catch (err) {
    console.warn(`[findings] リポジトリの設定を読めませんでした: ${String(err).slice(0, 300)}`);
    return { ...out, errors: 1 };
  }
  for (const [repo, cfg] of Object.entries(areas)) {
    const cwd = cfg.local_path;
    if (!cwd || !cfg.work_base) continue;
    const tip = gitOut(cwd, ["rev-parse", `refs/heads/${cfg.work_base}`])?.trim();
    if (!tip) continue;
    const rows = readWorkRows(workColumnPath(repo));
    const findings = foldPlaceFindings(rows, events).filter((f) =>
      f.status === "open" && Boolean(states.get(f.lane)?.mergedAt) && Boolean(f.commit) && f.commit !== tip);
    for (const f of findings) {
      try {
        const outcome = reanchorFinding({ cwd, commit: f.commit, tip, path: f.path, lines: f.lines });
        if (outcome.kind === "moved") {
          await appendWorkRow(repo, { event: "finding_moved", id: f.id, lines: outcome.lines, commit: tip });
          out.moved.push(f.id);
        } else if (outcome.kind === "dropped") {
          await appendWorkRow(repo, { event: "finding_dropped", id: f.id, reason: outcome.reason, by: "engine" });
          out.dropped.push(f.id);
        }
      } catch (err) {
        out.errors += 1;
        console.warn(`[findings] ${f.id} を付け直せませんでした: ${String(err).slice(0, 300)}`);
      }
    }
  }
  return out;
}
