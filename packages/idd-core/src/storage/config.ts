import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The pieces of propter's state a lane's work can pile up in, as `config/repos.yaml`'s `storage` section
 * names them. The names are the file's own: nothing is derived from a file name or an age on disk.
 */
export const STORAGE_PLACES = ["review_copies", "run_records", "stage_files", "outbox", "cron_runs", "build_outputs"] as const;

export type StoragePlace = (typeof STORAGE_PLACES)[number];

/** what each name means, for a person reading the settings */
export const STORAGE_PLACE_LABELS: Record<StoragePlace, string> = {
  review_copies: "レビューの複製",
  run_records: "役の実行の記録",
  stage_files: "段の入出力",
  outbox: "outbox の本文",
  cron_runs: "cron の実行の記録",
  build_outputs: "ビルド出力",
};

/** one place's settings: whether this place is swept, and how long a used-up item is kept */
export interface PlaceSettings {
  cleanup: boolean;
  keepMs: number;
}

export interface StorageConfig {
  /** the whole sweep is on; absent settings leave it off (nothing is deleted) */
  cleanup: boolean;
  /** the free space below which the sweep skips the keep period (the conditions are not relaxed) */
  minFreeGb: number;
  /** where the run records and stage files are written before they are deleted; absent: no archive */
  archiveDir?: string;
  places: Record<StoragePlace, PlaceSettings>;
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** the plan's table: a used-up item is kept this long unless the settings move it */
const DEFAULT_KEEP_MS: Record<StoragePlace, number> = {
  review_copies: 0,
  run_records: 7 * DAY,
  stage_files: 7 * DAY,
  outbox: 7 * DAY,
  cron_runs: 7 * DAY,
  build_outputs: 6 * HOUR,
};

const DEFAULT_MIN_FREE_GB = 10;

/**
 * The threshold may be pinned by the environment (`PROPTER_DISK_MIN_FREE_GB`): a test process must not depend on
 * the machine's disk. It is read only when the settings file does not write `min_free_gb`.
 */
function minFreeGbFromEnv(): number | undefined {
  const raw = process.env.PROPTER_DISK_MIN_FREE_GB?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function defaults(): StorageConfig {
  return {
    cleanup: false,
    minFreeGb: minFreeGbFromEnv() ?? DEFAULT_MIN_FREE_GB,
    places: Object.fromEntries(STORAGE_PLACES.map((p) => [p, { cleanup: true, keepMs: DEFAULT_KEEP_MS[p] }])) as Record<StoragePlace, PlaceSettings>,
  };
}

/** the settings a caller gets when the file has no `storage` section: everything off */
export function defaultStorageConfig(): StorageConfig {
  return defaults();
}

const isPlace = (key: string): key is StoragePlace => (STORAGE_PLACES as readonly string[]).includes(key);

const STORAGE_FIELDS = ["cleanup", "min_free_gb", "archive_dir", "places"];
const PLACE_FIELDS = ["cleanup", "keep_days", "keep_hours"];

function home(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** a place's settings: an unknown key, a wrong type and a negative period are errors, not silent defaults */
function parsePlace(where: string, raw: unknown, base: PlaceSettings): PlaceSettings {
  if (raw === undefined || raw === null) return base;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: 表で書いてください`);
  const v = raw as Record<string, unknown>;
  const unknown = Object.keys(v).filter((k) => !PLACE_FIELDS.includes(k));
  if (unknown.length) throw new Error(`${where}: 知らない欄 ${unknown.join(", ")}（使える欄: ${PLACE_FIELDS.join(", ")}）`);
  let cleanup = base.cleanup;
  if (v.cleanup !== undefined) {
    if (typeof v.cleanup !== "boolean") throw new Error(`${where}.cleanup: true か false で書いてください`);
    cleanup = v.cleanup;
  }
  let keepMs = base.keepMs;
  if (v.keep_days !== undefined && v.keep_hours !== undefined) throw new Error(`${where}: keep_days と keep_hours はどちらか一方だけ書いてください`);
  if (v.keep_days !== undefined) {
    const n = v.keep_days;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`${where}.keep_days: 0 以上の数（日）で書いてください`);
    keepMs = n * DAY;
  }
  if (v.keep_hours !== undefined) {
    const n = v.keep_hours;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`${where}.keep_hours: 0 以上の数（時間）で書いてください`);
    keepMs = n * HOUR;
  }
  return { cleanup, keepMs };
}

/**
 * `config/repos.yaml`'s top-level `storage`. Absent settings come back off with the plan's defaults. An unknown
 * key, a wrong type, a negative period and a relative archive dir are config errors (AC-022): the sweep is about
 * deleting files, so a misspelt setting must not quietly fall back to a default that deletes.
 */
export function parseStorage(raw: unknown): StorageConfig {
  const out = defaults();
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("storage: 表で書いてください");
  const v = raw as Record<string, unknown>;
  const unknown = Object.keys(v).filter((k) => !STORAGE_FIELDS.includes(k));
  if (unknown.length) throw new Error(`storage: 知らない欄 ${unknown.join(", ")}（使える欄: ${STORAGE_FIELDS.join(", ")}）`);
  if (v.cleanup !== undefined) {
    if (typeof v.cleanup !== "boolean") throw new Error("storage.cleanup: true か false で書いてください");
    out.cleanup = v.cleanup;
  }
  if (v.min_free_gb !== undefined) {
    const n = v.min_free_gb;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error("storage.min_free_gb: 0 以上の数（GB）で書いてください");
    out.minFreeGb = n;
  }
  if (v.archive_dir !== undefined) {
    if (typeof v.archive_dir !== "string" || !v.archive_dir.trim()) throw new Error("storage.archive_dir: dir の path を書いてください");
    const raw = home(v.archive_dir.trim());
    if (!isAbsolute(raw)) throw new Error(`storage.archive_dir: 絶対 path で書いてください（${v.archive_dir}）`);
    out.archiveDir = resolve(raw);
  }
  if (v.places !== undefined) {
    if (typeof v.places !== "object" || v.places === null || Array.isArray(v.places)) throw new Error("storage.places: 表で書いてください");
    for (const [key, value] of Object.entries(v.places as Record<string, unknown>)) {
      if (!isPlace(key)) throw new Error(`storage.places.${key}: 知らない置き場です（使える名前: ${STORAGE_PLACES.join(", ")}）`);
      out.places[key] = parsePlace(`storage.places.${key}`, value, out.places[key]);
    }
  }
  return out;
}

/**
 * `repos.<key>.build_outputs`: the repo's declaration of build output, relative to a worktree's root. An absolute
 * path and a path escaping the root with `..` are config errors: the declaration is what lets the sweep delete a
 * directory inside a lane's worktree, so a bad one must not be taken as a name to delete.
 */
export function parseBuildOutputs(where: string, raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== "string" || !p.trim())) {
    throw new Error(`${where}: 文字列の一覧（worktree の root からの相対 path）で書いてください`);
  }
  const paths = (raw as string[]).map((p) => p.trim());
  for (const p of paths) {
    if (isAbsolute(home(p))) throw new Error(`${where}: 絶対 path は書けません（${p}）`);
    const parts = p.replaceAll("\\", "/").split("/");
    if (parts.includes("..")) throw new Error(`${where}: worktree の外へ出る path は書けません（${p}）`);
  }
  return paths.length ? paths : undefined;
}
