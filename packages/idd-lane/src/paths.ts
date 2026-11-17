import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// a relative path, not the `@idd/core` package name: the CLI must start under plain Node, without workspace links
import { configPath } from "../../idd-core/src/config/files.ts";
import { resolvePiBin, resolveStateDir } from "../../idd-core/src/install/pointers.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** monorepo root (packages/idd-lane/src → ../../..) */
export function repoRoot(): string {
  return process.env.IDD_LANE_ROOT?.trim() || resolve(here, "..", "..", "..");
}

/**
 * config/roles.yaml. One order for every caller (@idd/core reads the same file through the same helper):
 * the environment variable, this checkout's config/, then ~/.config/idd. The cwd is not read.
 */
export function rolesPath(): string {
  return configPath("roles", { checkout: repoRoot() });
}

/** config/repos.yaml, shared with the engine; the same order as roles.yaml */
export function reposPath(): string {
  return configPath("repos", { checkout: repoRoot() });
}

/** where the runs' records are, <state>/lanes: a reader uses this one, so reading on a machine with no run creates nothing */
export function lanesRoot(): string {
  return join(resolveStateDir({ checkout: repoRoot() }), "lanes");
}

/** state for ad-hoc lanes: <state>/lanes (IDD_STATE_DIR is shared with @idd/core); a writer's door, it creates the directory */
export function laneStateDir(): string {
  const dir = lanesRoot();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function piBinary(): string {
  return resolvePiBin({ checkout: repoRoot() });
}

export function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return join(process.env.HOME ?? "", p.slice(2));
  return p;
}

export function claudeBinary(): string {
  return process.env.IDD_CLAUDE_BIN?.trim() || "claude";
}

/** systemd-run that starts a lane's scope; IDD_SYSTEMD_RUN_BIN lets a test stand in for it */
export function systemdRunBinary(): string {
  return process.env.IDD_SYSTEMD_RUN_BIN?.trim() || "systemd-run";
}

// systemctl is defined in @idd/core (install reads the same env override); re-exported so every lane caller
// keeps importing it from here. The path is relative: the CLI must start under plain Node without workspace links.
export { systemctlBinary } from "../../idd-core/src/install/records.ts";

/** busctl that moves a shared daemon a lane left out of its scope; IDD_BUSCTL_BIN lets a test stand in for it */
export function busctlBinary(): string {
  return process.env.IDD_BUSCTL_BIN?.trim() || "busctl";
}
