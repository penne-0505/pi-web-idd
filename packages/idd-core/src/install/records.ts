import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { userConfigDir } from "../config/files.ts";
import type { CommandRunner } from "./proc.ts";

/** install.json: what `idd install` put on this machine. A re-run rewrites it; the migration record is separate */
export interface InstallRecord {
  schema: 1;
  /** the checkout the CLI and the engine run from */
  checkout: string;
  /** the release tag the checkout sits on, else the short commit */
  version: string;
  installed_at: string;
  updated_at?: string;
  /** the state the units and the wrapper carry, as an absolute path; the one place that decides it */
  state_dir?: string;
  /** the pi the units and the wrapper carry, as an absolute path */
  pi_bin?: string;
  /** the commit that first carried the pointers above; `idd upgrade --to` does not go to a tag without it */
  pointers_commit?: string;
}

/** the line a unit or the wrapper carries to say `idd install` wrote it (a hand-written file has none) */
export const MANAGED_MARKER = "# idd-install: managed";

/** systemctl that reloads the user manager; IDD_SYSTEMCTL_BIN lets a test stand in for it */
export function systemctlBinary(): string {
  return process.env.IDD_SYSTEMCTL_BIN?.trim() || "systemctl";
}

/** the machine's IDD place; `idd install` creates it (mode 700) */
export function installDir(home?: string): string {
  return userConfigDir(home);
}

export function installRecordPath(home?: string): string {
  return join(installDir(home), "install.json");
}

export function migrationsRecordPath(home?: string): string {
  return join(installDir(home), "migrations.json");
}

export function systemdUserDir(home?: string): string {
  const base = home ?? process.env.HOME ?? homedir();
  return join(base, ".config", "systemd", "user");
}

export function localBinDir(home?: string): string {
  const base = home ?? process.env.HOME ?? homedir();
  return join(base, ".local", "bin");
}

export function readInstallRecord(home?: string): InstallRecord | null {
  const path = installRecordPath(home);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<InstallRecord>;
    if (typeof raw?.checkout !== "string" || !raw.checkout) return null;
    const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
    const stateDir = text(raw.state_dir);
    const piBin = text(raw.pi_bin);
    const pointersCommit = text(raw.pointers_commit);
    return {
      schema: 1,
      checkout: raw.checkout,
      version: String(raw.version ?? "unknown"),
      installed_at: String(raw.installed_at ?? ""),
      ...(raw.updated_at ? { updated_at: String(raw.updated_at) } : {}),
      ...(stateDir ? { state_dir: stateDir } : {}),
      ...(piBin ? { pi_bin: piBin } : {}),
      ...(pointersCommit ? { pointers_commit: pointersCommit } : {}),
    };
  } catch {
    return null;
  }
}

export function writeInstallRecord(record: InstallRecord, home?: string): void {
  const dir = installDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(installRecordPath(home), `${JSON.stringify(record, null, 2)}\n`);
}

/** the migration ids that already ran on this machine, in the order they ran */
export function readAppliedMigrations(home?: string): string[] {
  const path = migrationsRecordPath(home);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { applied?: unknown };
    if (!Array.isArray(raw?.applied)) return [];
    return raw.applied.map((x) => String(x));
  } catch {
    return [];
  }
}

export function writeAppliedMigrations(applied: string[], home?: string): void {
  const dir = installDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(migrationsRecordPath(home), `${JSON.stringify({ schema: 1, applied }, null, 2)}\n`);
}

/** the tag HEAD sits on, else the short commit: what install.json records as the version */
export function checkoutVersion(checkout: string, runner: CommandRunner): { version: string; commit: string; tag?: string } {
  const commit = runner.capture("git", ["rev-parse", "--short", "HEAD"], { cwd: checkout });
  const sha = commit.ok ? commit.stdout.trim() : "";
  const tag = runner.capture("git", ["describe", "--tags", "--exact-match", "HEAD"], { cwd: checkout });
  if (tag.ok && tag.stdout.trim()) return { version: tag.stdout.trim(), commit: sha, tag: tag.stdout.trim() };
  return { version: sha || "unknown", commit: sha };
}

/** the full commit HEAD points at; null when git cannot say */
export function headCommit(checkout: string, runner: CommandRunner): string | null {
  const res = runner.capture("git", ["rev-parse", "HEAD"], { cwd: checkout });
  const sha = res.ok ? res.stdout.trim() : "";
  return sha || null;
}

/** the file whose arrival marks the pointers mechanism; rename or delete it only together with `pointersOrigin` */
export const POINTERS_MARKER = "bin/gateway-env.sh";

/**
 * the commit that first added the pointers mechanism in this checkout's history: the floor for `idd upgrade --to`.
 * Null when git cannot say, or when a shallow clone's boundary commit would look like the addition; no floor is
 * better than a wrong one, because upgrade stops at "below-floor" and asks for a re-install.
 */
export function pointersOrigin(checkout: string, runner: CommandRunner): string | null {
  const shallow = runner.capture("git", ["rev-parse", "--is-shallow-repository"], { cwd: checkout });
  if (!shallow.ok || shallow.stdout.trim() !== "false") return null;
  const res = runner.capture("git", ["log", "--diff-filter=A", "--reverse", "--format=%H", "--", POINTERS_MARKER], { cwd: checkout });
  const first = res.ok ? res.stdout.split("\n").map((line) => line.trim()).find(Boolean) : "";
  return first || null;
}

/** whether a file was written by `idd install` (and so may be rewritten) */
export function isManaged(text: string): boolean {
  return text.includes(MANAGED_MARKER);
}
