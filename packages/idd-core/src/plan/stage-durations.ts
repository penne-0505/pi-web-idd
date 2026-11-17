/**
 * The usual lengths of the machine stages, measured once per closed lane and kept in one file under the state.
 * The tick's recording stage writes it; the forecast reads it and never writes (INV-104-4). A row carries the
 * split's version, so a lane measured under an older split is measured again (DEC-104-5), and the samples skip
 * every lane penne took out without its work (DEC-104-4).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pipelineSlotDeclared } from "../config/pipeline.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { laneDurations, STAGE_RULE_VERSION, type StageKey, type StageSplitContext } from "../ledger/stage-spans.ts";
import { currentLandApproval } from "../overlay/land.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";
import { stateDir } from "../paths.ts";

export const STAGE_DURATIONS_FILE = "stage-durations.jsonl";

/** the machine stages with a length of their own; `fix` is measured one round at a time and is not here */
export const DURATION_STAGES: StageKey[] = ["plan", "plan_review", "impl", "review", "checks", "land"];

export function stageDurationsPath(): string {
  return join(stateDir(), STAGE_DURATIONS_FILE);
}

export interface StageDurationsRow {
  rule: number;
  idd_id: string;
  area: string;
  closed_at: string;
  stages: Partial<Record<StageKey, number>>;
  fix_rounds: number[];
  changed_files: number;
  risk: string | null;
  /** the estimate's field: empty until a source for it exists */
  est: number | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** the rows of the file, malformed lines and entries left out (the file is append-only and hand-readable) */
export function readStageDurations(): StageDurationsRow[] {
  const path = stageDurationsPath();
  let text: string;
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return [];
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").map((l) => l.trim()).filter(Boolean).flatMap((line) => {
    try {
      const v = JSON.parse(line) as Partial<StageDurationsRow>;
      if (!v || typeof v !== "object" || typeof v.idd_id !== "string" || !v.idd_id) return [];
      const rule = typeof v.rule === "number" ? v.rule : 0;
      const raw = v.stages && typeof v.stages === "object" ? (v.stages as Partial<Record<StageKey | "r2", number>>) : {};
      // a row written while the stage after convergence was keyed `r2` (R2 ran in it until 2026-10-22) reads as `checks`
      const { r2, ...rest } = raw;
      const stages: Partial<Record<StageKey, number>> = r2 !== undefined && rest.checks === undefined ? { ...rest, checks: r2 } : rest;
      return [{
        rule,
        idd_id: v.idd_id,
        area: typeof v.area === "string" ? v.area : "",
        closed_at: typeof v.closed_at === "string" ? v.closed_at : "",
        stages,
        fix_rounds: Array.isArray(v.fix_rounds) ? v.fix_rounds.filter((x): x is number => typeof x === "number") : [],
        changed_files: typeof v.changed_files === "number" ? v.changed_files : 0,
        risk: typeof v.risk === "string" ? v.risk : null,
        est: typeof v.est === "number" ? v.est : null,
      }];
    } catch {
      return [];
    }
  });
}

/** a lane whose work ended in the mainline: only these are samples (DEC-104-4) */
function eligible(events: LifecycleRecord[]): boolean {
  const close = [...events].reverse().find((e) => e.event === "lane_close");
  return close?.attrs?.outcome === "merged" || close?.attrs?.outcome === "local";
}

/** the last of an event, or undefined */
function lastOf(events: LifecycleRecord[], name: string): LifecycleRecord | undefined {
  return [...events].reverse().find((e) => e.event === name);
}

function changedFiles(events: LifecycleRecord[]): number {
  const files = new Set<string>();
  for (const e of events) {
    if (e.event !== "s2_result") continue;
    const list = e.attrs?.changed_files;
    if (Array.isArray(list)) for (const f of list) files.add(String(f));
  }
  return files.size;
}

function riskOf(events: LifecycleRecord[]): string | null {
  for (const e of events) {
    if (e.event !== "s2_review_started") continue;
    const r = e.attrs?.risk;
    if (typeof r === "string" && r) return r;
  }
  return null;
}

function rowFor(rec: BacklogRecord, events: LifecycleRecord[], ctx: StageSplitContext): StageDurationsRow {
  const d = laneDurations(events, ctx);
  const stages: Partial<Record<StageKey, number>> = {};
  for (const key of DURATION_STAGES) {
    const v = d.stages[key];
    if (typeof v === "number") stages[key] = round1(v);
  }
  return {
    rule: STAGE_RULE_VERSION,
    idd_id: rec.idd_id,
    area: rec.area,
    closed_at: lastOf(events, "lane_close")?.at ?? "",
    stages,
    fix_rounds: d.fixRounds.map(round1),
    changed_files: changedFiles(events),
    risk: riskOf(events),
    est: null,
  };
}

function writeRows(rows: StageDurationsRow[]): void {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = stageDurationsPath();
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* the write already failed; the next pass tries again */ }
    throw err;
  }
}

export interface StageRecordResult {
  /** the lanes measured and written on this pass */
  recorded: string[];
  errors: { iddId: string; error: string }[];
}

/**
 * Measure the lanes that landed and are not on record yet, and write them once. A lane's row of an older split is
 * dropped and measured again; a row of the current split is left as it is, so a second pass adds nothing. The
 * writes go to a temporary file and are renamed into place. Nothing here throws: the tick's stage must not stop
 * the tick, and a state that cannot be written leaves the lanes for the next pass (DEC-104-5).
 */
export async function recordStageDurations(): Promise<StageRecordResult> {
  const result: StageRecordResult = { recorded: [], errors: [] };
  try {
    const backlog = readBacklog();
    const lifecycle = readLifecycle();
    const byId = new Map<string, LifecycleRecord[]>();
    for (const e of lifecycle) {
      const list = byId.get(e.idd_id);
      if (list) list.push(e);
      else byId.set(e.idd_id, [e]);
    }
    const rows = readStageDurations();
    const current = rows.filter((r) => r.rule === STAGE_RULE_VERSION);
    const known = new Set(current.map((r) => r.idd_id).filter((id) => eligible(byId.get(id) ?? [])));
    const next = current.filter((r) => eligible(byId.get(r.idd_id) ?? []));
    const ctx: StageSplitContext = { landApproved: currentLandApproval };
    const measured: string[] = [];
    for (const rec of backlog) {
      const events = byId.get(rec.idd_id) ?? [];
      if (!events.length || !eligible(events) || known.has(rec.idd_id)) continue;
      try {
        next.push(rowFor(rec, events, ctx));
        measured.push(rec.idd_id);
      } catch (err) {
        result.errors.push({ iddId: rec.idd_id, error: String(err instanceof Error ? err.message : err) });
      }
    }
    // nothing new and nothing old to drop: leave the file alone. The lanes are reported as recorded only once the
    // file was written, so a failed write leaves them for the next pass
    if (measured.length > 0 || next.length !== rows.length) {
      writeRows(next);
      result.recorded = measured;
    }
  } catch (err) {
    result.errors.push({ iddId: "", error: String(err instanceof Error ? err.message : err) });
  }
  return result;
}

export type StatBasis = "repo" | "mixed" | "initial";

export interface StageStat {
  median: number;
  p75: number;
  /** the anomaly line: twice the p75, never below the floor (DEC-104-3) */
  threshold: number;
  samples: number;
  basis: StatBasis;
}

export interface StageUsual {
  area: string;
  /** the lanes the window held */
  lanes: number;
  stages: Record<StageKey, StageStat>;
}

/** the code's own values, for a stage with too few samples to give a usual (DEC-104-4) */
export const INITIAL_STAGE_STATS: Record<StageKey, { median: number; p75: number }> = {
  plan: { median: 10, p75: 16 },
  plan_review: { median: 25, p75: 34 },
  impl: { median: 39, p75: 70 },
  review: { median: 16, p75: 20 },
  fix: { median: 34, p75: 46 },
  checks: { median: 2, p75: 3 },
  land: { median: 0, p75: 7 },
};

/** the lanes a repo's usual is taken from: the same repo's newest 20, then other repos' newest to fill (DEC-104-4) */
export const SAMPLE_WINDOW = 20;
export const MIN_SAMPLES = 8;
export const THRESHOLD_FLOOR_MINUTES = 10;

export function thresholdOf(p75: number): number {
  return round1(Math.max(2 * p75, THRESHOLD_FLOOR_MINUTES));
}

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const value = sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  return round1(value);
}

function newestFirst(a: StageDurationsRow, b: StageDurationsRow): number {
  const at = Date.parse(a.closed_at);
  const bt = Date.parse(b.closed_at);
  if (Number.isFinite(at) && Number.isFinite(bt)) return bt - at;
  return a.closed_at < b.closed_at ? 1 : a.closed_at > b.closed_at ? -1 : 0;
}

function samplesFor(rows: StageDurationsRow[], stage: StageKey): number[] {
  if (stage === "fix") return rows.flatMap((r) => r.fix_rounds);
  return rows.map((r) => r.stages[stage]).filter((v): v is number => typeof v === "number");
}

/**
 * One repo's usual, from the newest closed lanes of the same repo and, when there are fewer than 20, from other
 * repos' newest ones. A stage measured fewer than 8 times takes the code's initial value. A stage with no sample
 * at all (a repo whose lanes never took it) takes it too. The basis says which of the three the value is.
 */
export function usualFor(area: string, rows: StageDurationsRow[]): StageUsual {
  const current = rows.filter((r) => r.rule === STAGE_RULE_VERSION);
  const same = current.filter((r) => r.area === area).sort(newestFirst);
  const window = same.slice(0, SAMPLE_WINDOW);
  let mixed = false;
  if (window.length < SAMPLE_WINDOW) {
    const fill = current.filter((r) => r.area !== area).sort(newestFirst).slice(0, SAMPLE_WINDOW - window.length);
    window.push(...fill);
    mixed = fill.length > 0;
  }
  const stages = {} as Record<StageKey, StageStat>;
  for (const stage of [...DURATION_STAGES, "fix"] as StageKey[]) {
    const samples = samplesFor(window, stage);
    if (samples.length < MIN_SAMPLES) {
      const initial = INITIAL_STAGE_STATS[stage];
      stages[stage] = { median: initial.median, p75: initial.p75, threshold: thresholdOf(initial.p75), samples: samples.length, basis: "initial" };
      continue;
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p75 = quantile(sorted, 0.75);
    stages[stage] = { median: quantile(sorted, 0.5), p75, threshold: thresholdOf(p75), samples: samples.length, basis: mixed ? "mixed" : "repo" };
  }
  return { area, lanes: window.length, stages };
}

/** whether the pipeline declares the plan review (the plan's forecast only adds it when it does) */
export function planReviewDeclared(): boolean {
  return pipelineSlotDeclared("plan_review");
}
