import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../paths.ts";
import type { CanaryTaskKind } from "./tasks.ts";

/**
 * A day's canary, on record beside the pipeline's state and never in the ledger: the ledger is a lane's truth, and
 * the canary is the harness watching its own models. One file per role under the day, written as the role finishes,
 * so a run that is cut partway still keeps what it measured. Nothing here removes a day: a later run writes its own
 * day's folder and leaves the folders before it alone.
 */

/** the most characters of an answer the record keeps (the length itself is kept in full) */
export const CANARY_OUTPUT_CHARS = 4000;

export type CanaryStructureVerdict = "ok" | "fail" | "none";

export interface CanaryTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** one question's answer and the numbers the answer is measured by */
export interface CanaryTaskRecord {
  id: string;
  kind: CanaryTaskKind;
  /** the shape of the answer; "none" when the model gave nothing to judge */
  structure: CanaryStructureVerdict;
  /** why the shape failed, when it did */
  structure_detail?: string;
  /** the answer as it was written, cut to CANARY_OUTPUT_CHARS */
  output: string;
  /** characters of the whole answer, before it was cut */
  chars: number;
  /**
   * milliseconds from asking the runner to its end: the runner's whole run, which is neither the model's own reply
   * time nor the role's agent dir preparation (the canary readies that before the question's clock starts)
   */
  total_ms: number;
  /** USD the run's own usage reported */
  usd: number;
  tokens: CanaryTokens;
  /** the model did not answer: the shape is "none" and this says why */
  error?: string;
}

/** one role's day: the model it ran on and every question's answer */
export interface CanaryRoleRecord {
  role: string;
  /** the call target the run was given */
  model: string;
  /** the model definition the call target came from; the record's file is one per role and model definition */
  model_name?: string;
  thinking: string;
  /** the JST day the record is filed under */
  day: string;
  /** when the role's record was written */
  at: string;
  /** how many times the role was tried this day: a retry asks only the questions still missing */
  attempts?: number;
  /** answers are still missing, because a question timed out, errored, or was not asked inside the tick's limit */
  partial?: boolean;
  /** the role's agent dir was readied today: the day's later tries ask straight away */
  prepared?: boolean;
  tasks: CanaryTaskRecord[];
}

export function canaryRoot(): string {
  return join(stateDir(), "pipeline", "canary");
}

export function canaryDayDir(day: string): string {
  return join(canaryRoot(), day);
}

/** a role's file name: the role's own name and the model it ran on, with what a file name cannot carry replaced */
export function canaryFileName(role: string, model?: string): string {
  const name = model ? `${role}-${model}` : role;
  return `${name.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
}

export function canaryRecordPath(day: string, role: string, model?: string): string {
  return join(canaryDayDir(day), canaryFileName(role, model));
}

/** whether the role has any record for the day (a record with answers still missing is a record too) */
export function hasCanaryRecord(day: string, role: string, model?: string): boolean {
  return existsSync(canaryRecordPath(day, role, model));
}

/**
 * One role's record for the day, or null when the day has none or the file does not read. A record marked partial is
 * read as it is: it is what the day's later tries start from. The folder the file sits under is the day, as
 * `readCanaryDay` reads it.
 */
export function readCanaryRecord(day: string, role: string, model?: string): CanaryRoleRecord | null {
  const path = canaryRecordPath(day, role, model);
  if (!existsSync(path)) return null;
  try {
    const rec = JSON.parse(readFileSync(path, "utf8")) as CanaryRoleRecord;
    if (!rec || typeof rec.role !== "string" || !Array.isArray(rec.tasks)) return null;
    return { ...rec, day };
  } catch {
    return null;
  }
}

/**
 * One day's records; a folder the run did not write, or a file that does not read, is left out. The folder a record
 * sits under is the day it is read as: a record copied into another day's folder (the way a week is compared with
 * the week before it) has to be read as the day it was put in, so the day inside the file is not the truth here.
 */
export function readCanaryDay(day: string): CanaryRoleRecord[] {
  const dir = canaryDayDir(day);
  if (!existsSync(dir)) return [];
  const out: CanaryRoleRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, name), "utf8")) as CanaryRoleRecord;
      if (rec && typeof rec.role === "string" && Array.isArray(rec.tasks)) out.push({ ...rec, day });
    } catch {
      // a half-written or foreign file is not a record
    }
  }
  return out;
}

/** the records of the days given, in day order */
export function readCanaryRecords(days: readonly string[]): CanaryRoleRecord[] {
  const out: CanaryRoleRecord[] = [];
  for (const day of [...new Set(days)].sort()) out.push(...readCanaryDay(day));
  return out;
}

/** write one role's record; the day's folder is made as it is needed, and a file already there is replaced */
export function writeCanaryRecord(record: CanaryRoleRecord): string {
  const dir = canaryDayDir(record.day);
  mkdirSync(dir, { recursive: true });
  const path = canaryRecordPath(record.day, record.role, record.model_name ?? record.model);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}

/** the JST days from `since` to `until`, both ends included */
export function daysBetween(since: string, until: string): string[] {
  const from = Date.parse(`${since}T00:00:00Z`);
  const to = Date.parse(`${until}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const out: string[] = [];
  for (let t = from; t <= to; t += 86400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * The days a weekly reading compares: the period itself, and the same number of days immediately before it (the
 * week before, for a seven-day period). A record from either window is enough to read a row.
 */
export function canaryWindows(since: string, until: string): { current: string[]; previous: string[]; previousSince: string; previousUntil: string } {
  const current = daysBetween(since, until);
  if (!current.length) return { current, previous: [], previousSince: since, previousUntil: since };
  const span = current.length;
  const from = Date.parse(`${since}T00:00:00Z`) - span * 86400_000;
  const previousUntil = new Date(Date.parse(`${since}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  const previousSince = new Date(from).toISOString().slice(0, 10);
  return { current, previous: daysBetween(previousSince, previousUntil), previousSince, previousUntil };
}
