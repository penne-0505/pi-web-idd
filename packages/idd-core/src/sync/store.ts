import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "../instruction/store.ts";
import { stateDir } from "../paths.ts";
import { emptyBaseline, type Baseline, type BaselinePatch, type ConflictProposal } from "./types.ts";

/**
 * The sync's own files, under the state directory: the baseline (the last synced copy) of each repo and the conflicts
 * that are open. They are neither a record of intent nor a document of the repo, so they are written nowhere in a
 * worktree and nothing under `_docs/` shows them; they stay across an engine restart because the state directory does.
 */

/** where the sync's files are; reading never makes the directory, only a write does */
export function syncDir(): string {
  return join(stateDir(), "sync");
}

/**
 * a repo key as a file name, one name for one key: every character outside `A-Za-z0-9.-` (the `_` too) becomes
 * `_<hex code point>_`, so `owner/name` is `owner_2f_name` and no two keys share a file
 */
export function slug(repo: string): string {
  return Array.from(repo, (c) => (/[A-Za-z0-9.-]/.test(c) ? c : `_${c.codePointAt(0)?.toString(16)}_`)).join("");
}

function baselinePath(repo: string): string {
  return join(syncDir(), `${slug(repo)}.baseline.json`);
}

function conflictsPath(repo: string): string {
  return join(syncDir(), `${slug(repo)}.conflicts.json`);
}

/**
 * A field of the file that is a map of one kind of value. A version 1 baseline always has every map, so a field that is
 * not there, or is there with another shape (a list, a string, a value of the wrong type), is an error: read as empty, a
 * deleted body would look like the outside's change and the outside's older text would be written over propter's.
 */
function readMap<T>(raw: Record<string, unknown>, field: string, ok: (value: unknown) => value is T, what: string): Record<string, T> {
  const value = raw[field];
  if (value === undefined) throw new Error(`${field} がありません`);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} が object ではありません`);
  const out: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!ok(entry)) throw new Error(`${field}.${key} が${what}ではありません`);
    out[key] = entry;
  }
  return out;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";


/**
 * The repo's baseline. A file that is not there is an empty baseline (the first sync); a file that is there and cannot be
 * read, is not version 1, or lacks one of its maps is an error, never an empty baseline: read as empty, every
 * difference would look like the outside's change and propter's own text would be overwritten by it.
 */
export function readBaseline(repo: string): Baseline {
  const path = baselinePath(repo);
  if (!existsSync(path)) return emptyBaseline();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("JSON の object ではありません");
    if (raw.version !== 1) throw new Error(`version が 1 ではありません（${JSON.stringify(raw.version) ?? "なし"}）`);
    if (raw.repo !== undefined && typeof raw.repo !== "string") throw new Error("repo が文字列ではありません");
    if (typeof raw.repo === "string" && raw.repo !== repo) throw new Error(`別の repo（${raw.repo}）の基準です`);
    if (raw.lastRunAt !== undefined && typeof raw.lastRunAt !== "string") throw new Error("lastRunAt が文字列ではありません");
    return {
      version: 1,
      repo,
      ...(typeof raw.lastRunAt === "string" ? { lastRunAt: raw.lastRunAt } : {}),
      links: readMap(raw, "links", isString, "文字列"),
      projectBody: readMap(raw, "projectBody", isString, "文字列"),
      issueProject: readMap(raw, "issueProject", isString, "文字列"),
      issueClosed: readMap(raw, "issueClosed", isBoolean, "真偽値"),
    };
  } catch (err) {
    throw new Error(`${repo} の同期の基準を読めません（${path}）: ${err instanceof Error ? err.message : String(err)}。同期は止めています。ファイルを直すか、退避して取り直してください`);
  }
}

export function writeBaseline(repo: string, base: Baseline): void {
  writeJsonAtomic(baselinePath(repo), { ...base, repo });
}

export function applyPatch(base: Baseline, patch: BaselinePatch): void {
  switch (patch.unit) {
    case "projectBody": base.projectBody[patch.key] = patch.value; break;
    case "issueProject": base.issueProject[patch.key] = patch.value; break;
    case "issueClosed": base.issueClosed[patch.key] = patch.value; break;
    case "link": base.links[patch.key] = patch.value; break;
    case "unlink":
      delete base.links[patch.key];
      delete base.projectBody[patch.key];
      for (const [ref, project] of Object.entries(base.issueProject)) if (project === patch.key) delete base.issueProject[ref];
      break;
  }
}

/** apply patches to the repo's stored baseline in one read and one write */
export function patchBaseline(repo: string, patches: readonly BaselinePatch[], extra?: Partial<Pick<Baseline, "lastRunAt">>): Baseline {
  const base = readBaseline(repo);
  for (const p of patches) applyPatch(base, p);
  if (extra?.lastRunAt) base.lastRunAt = extra.lastRunAt;
  writeBaseline(repo, base);
  return base;
}

// ---- the conflicts that are open ----

export interface ConflictRecord extends ConflictProposal {
  repo: string;
  raisedAt: string;
}

function isConflictRecord(v: unknown, repo: string): v is ConflictRecord {
  if (v === null || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (c.unit === "project_body" || c.unit === "issue_project")
    && ["id", "subject", "label", "external", "base", "propter", "raisedAt"].every((k) => typeof c[k] === "string")
    && c.repo === repo;
}

/** the open conflicts of one repo; a file that is there and cannot be read is an error, the same as the baseline */
export function readConflicts(repo: string): ConflictRecord[] {
  const path = conflictsPath(repo);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error("JSON の配列ではありません");
    return raw.map((c, i) => {
      if (!isConflictRecord(c, repo)) throw new Error(`${i} 番目の形が違います`);
      return c;
    });
  } catch (err) {
    throw new Error(`${repo} のぶつかりの記録を読めません（${path}）: ${err instanceof Error ? err.message : String(err)}。同期は止めています。ファイルを直すか、退避して取り直してください`);
  }
}

export function writeConflicts(repo: string, list: readonly ConflictRecord[]): void {
  writeJsonAtomic(conflictsPath(repo), list);
}

/** the open conflicts of the repos given, for the inbox: a repo whose file cannot be read shows none (the sync itself reports it) */
export function openConflicts(repos: readonly string[]): ConflictRecord[] {
  return repos.flatMap((repo) => {
    try { return readConflicts(repo); } catch { return []; }
  }).sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || a.id.localeCompare(b.id));
}
