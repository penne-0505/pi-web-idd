/**
 * A repo's generated files (config/repos.yaml `generated_files`): files that are a pure function of the sources in the
 * same tree (a built JS a repo commits beside its source), and the command that makes them again. A landing reads the
 * declaration to make them again in the merge commit instead of sending a lane back over a conflict that holds no
 * decision (`overlay/generated.ts` is the only place that runs it).
 *
 * The declaration is kept beside the areas (like `risk_paths`) so a repo that writes one does not change any repo's
 * settings hash or the validity of a pending submit or landing, and a repo that writes nothing lands as it did.
 */

import { declaredList, declaredMinutes } from "./declared-list.ts";

export interface GeneratedFiles {
  /** the files the command writes, repo-root relative; nothing else it writes is taken */
  paths: string[];
  command: string[];
  /** the limit of one run of the command (minutes) */
  timeoutMinutes: number;
}

/** how long the command may run when the declaration names no limit: a build of the repo's MoonBit fold takes seconds */
export const DEFAULT_GENERATED_MINUTES = 5;

const FIELDS = ["paths", "command", "timeout_minutes"];

/** a path as the declaration writes it: relative to the root, forward slashes, no `.`/`..` part, not a directory */
function plainPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.endsWith("/")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * The `generated_files` list of one repo. An unknown field, a path that is not a plain repo-relative file path, a path
 * declared twice (two commands that both claim it), a missing command and a limit that is not a positive number are
 * config errors, not silent defaults: a declaration read as something else would write a file nobody declared, or
 * leave one that a lane's conflict needs made again.
 */
export function parseGeneratedFiles(where: string, raw: unknown): GeneratedFiles[] | undefined {
  const claimed = new Set<string>();
  const out = declaredList(where, raw, FIELDS, (o, i): GeneratedFiles => {
    if (!Array.isArray(o.paths) || !o.paths.length || o.paths.some((p) => typeof p !== "string" || !plainPath(p.trim()))) {
      throw new Error(`${where}[${i}].paths: repo の root からの相対の file の一覧（空でない文字列、dir や .. は不可）で書いてください`);
    }
    const paths = (o.paths as string[]).map((p) => p.trim());
    for (const path of paths) {
      if (claimed.has(path)) throw new Error(`${where}: path ${path} が 2 回書かれています`);
      claimed.add(path);
    }
    const command = typeof o.command === "string" && o.command.trim() ? ["bash", "-c", o.command] : Array.isArray(o.command) ? o.command.map(String) : [];
    if (!command.length) throw new Error(`${where}[${i}].command: 作り直すコマンドを書いてください`);
    return { paths, command, timeoutMinutes: declaredMinutes(where, i, o, DEFAULT_GENERATED_MINUTES) };
  });
  return out?.length ? out : undefined;
}
