import { isAbsolute } from "node:path";

import { checkoutRoot } from "../config/files.ts";
import { defaultRunner, type CommandRunner } from "./proc.ts";
import { readAppliedMigrations, systemctlBinary, writeAppliedMigrations } from "./records.ts";

/**
 * One migration: a change to the machine's side (the settings, the units, the state's shape). It must do
 * nothing on a machine that has no source to move (a fresh install). Migrations never touch a repo's records.
 */
export interface Migration {
  id: string;
  /** what the step touches; migrations stay on the machine's side */
  target: "config" | "unit" | "state";
  summary: string;
  apply(ctx: MigrationContext): { changed: boolean; detail?: string };
}

export interface MigrationContext {
  home: string;
  checkout: string;
  runner: CommandRunner;
  now: () => Date;
}

/**
 * The ordered list. Empty on purpose for now: the versions between this lane and the last have nothing to
 * move, and the first real step is expected with the rename (79). A step is added here once, and `migrate`
 * records it, so it never runs twice.
 */
export const MIGRATIONS: Migration[] = [];

export interface MigrateOptions {
  home?: string;
  checkout?: string;
  runner?: CommandRunner;
  /** the list to run; a test hands in sample steps */
  migrations?: Migration[];
  now?: () => Date;
}

export interface MigrateResult {
  ok: boolean;
  applied: string[];
  skipped: string[];
  failed?: { id: string; error: string };
  steps: string[];
  errors: string[];
}

/**
 * `idd migrate`: run the migrations this machine has not applied, in order, once each, and record each one
 * as it finishes. A failing step stops everything after it and is not recorded, so the next run retries it.
 * The record lives in `~/.config/idd/migrations.json`, apart from install.json: re-running `install` never
 * makes an applied migration run again.
 */
export function runMigrate(opts: MigrateOptions = {}): MigrateResult {
  const home = opts.home ?? process.env.HOME ?? "";
  const checkout = opts.checkout ?? checkoutRoot();
  const runner = opts.runner ?? defaultRunner;
  const now = opts.now ?? (() => new Date());
  const migrations = opts.migrations ?? MIGRATIONS;
  const result: MigrateResult = { ok: false, applied: [], skipped: [], steps: [], errors: [] };

  if (!home || !isAbsolute(home)) {
    result.errors.push(`HOME が絶対パスではありません: ${JSON.stringify(home)}`);
    return result;
  }

  const applied = readAppliedMigrations(home);
  const done = new Set(applied);
  const kept: string[] = [...applied];
  const ctx: MigrationContext = { home, checkout, runner, now };

  for (const migration of migrations) {
    if (done.has(migration.id)) {
      result.skipped.push(migration.id);
      continue;
    }
    try {
      const outcome = migration.apply(ctx);
      done.add(migration.id);
      kept.push(migration.id);
      writeAppliedMigrations(kept, home);
      result.applied.push(migration.id);
      result.steps.push(`${migration.id}（${migration.target}）: ${outcome.detail ?? (outcome.changed ? "移しました" : "移すものがありませんでした")}`);
    } catch (err) {
      result.failed = { id: migration.id, error: err instanceof Error ? err.message : String(err) };
      result.errors.push(`移行 ${migration.id} で止まりました: ${result.failed.error}`);
      return result;
    }
  }

  result.ok = true;
  return result;
}

/** reload the user manager after a step rewrote a unit (the same call install makes) */
export function daemonReload(runner: CommandRunner): void {
  runner.run(systemctlBinary(), ["--user", "daemon-reload"]);
}
