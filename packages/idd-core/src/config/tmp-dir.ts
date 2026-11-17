import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * config/repos.yaml's `tmp_dir`: where the repo's lane runs keep their temp files (each run gets a dir of its own
 * under it, handed to its agent as TMPDIR / TEMP / TMP). An absolute path or a home path; a relative path, the root
 * itself and anything that is not a non-empty string are config errors, and so is a field left empty (`tmp_dir:`, or
 * a bare `~`, which YAML reads as null): it says a place was meant, so it is not read as no setting. A missing field is
 * undefined, and such a repo's runs keep the engine's own temp dir.
 */
export function parseTmpDir(where: string, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${where}: 絶対 path（~/ も可）の文字列で書いてください`);
  const value = raw.trim();
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expanded)) throw new Error(`${where}: 絶対 path（~/ も可）で書いてください: ${value}`);
  const path = resolve(expanded);
  if (path === "/") throw new Error(`${where}: / そのものは置き場にできません`);
  return path;
}
