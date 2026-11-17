import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The checkout the running code sits in: the same root as `templateRoot()` (packages/idd-core/src/config →
 * ../../..), resolved from this module's own place so it does not depend on the caller's cwd.
 */
export function checkoutRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/** the machine's IDD place: `~/.config/idd`, where `idd install` puts the settings and its records */
export function userConfigDir(home?: string): string {
  const base = home ?? process.env.HOME ?? homedir();
  return join(base, ".config", "idd");
}

export type ConfigName = "repos" | "roles" | "modes";

/** the environment variable that overrides a settings file (IDD_REPOS_FILE / IDD_ROLES_FILE / IDD_MODES_FILE) */
export function configEnvVar(name: ConfigName): string {
  return `IDD_${name.toUpperCase()}_FILE`;
}

/**
 * Where a settings file is read from, all callers sharing this one order:
 * the environment variable, then the running checkout's `config/<name>.yaml`, then `~/.config/idd/<name>.yaml`.
 * The cwd is never read: a repo the CLI happens to sit in must not lend its own `config/` to IDD.
 */
export function configPath(name: ConfigName, opts: { home?: string; checkout?: string } = {}): string {
  const explicit = process.env[configEnvVar(name)]?.trim();
  if (explicit) return explicit;
  const fromCheckout = join(opts.checkout ?? checkoutRoot(), "config", `${name}.yaml`);
  if (existsSync(fromCheckout)) return fromCheckout;
  return join(userConfigDir(opts.home), `${name}.yaml`);
}
