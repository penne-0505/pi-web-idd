import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/*
 * The context files (AGENTS.md and the like) a pi run starts with, copied into the run's own record when pi is
 * started. pi puts them in its system prompt whole, but a record that does not carry the system prompt (an older pi,
 * a stream cut short) leaves a reader with no way to say which of the workdir's rules reached the model. The copy is
 * what the reader shows for them. It is written by the process that starts pi, never by a reader.
 *
 * The files are found the way pi finds them: the nearest of the five names in each directory from the cwd up, the
 * root-most first, and a linked worktree's own file shadows the main repo's file of the same scope. The lane's agent
 * dir carries no context file of the user's (it removes them), so that one is not looked for.
 */

export const CONTEXT_FILES_RECORD = "context-files.json";

export interface ContextFile {
  path: string;
  content: string;
}

/** the files as they were when a reply (a conversation's turn) started; a run that has no turns has the one */
export interface ContextSnapshot {
  turn?: number;
  files: ContextFile[];
  /** the package's norms appended to the system prompt for this reply (a planner's reply has them, the other stages none) */
  addendum?: string;
}

const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function contextFileIn(dir: string): ContextFile | null {
  for (const name of CANDIDATES) {
    const path = join(dir, name);
    try {
      if (existsSync(path) && statSync(path).isFile()) return { path, content: readFileSync(path, "utf8") };
    } catch { /* a file that cannot be read is not given to the model either */ }
  }
  return null;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/** the nearest `.git` above a cwd: the worktree's root and the repo's common git dir (null when there is none) */
function gitPaths(cwd: string): { repoDir: string; commonGitDir: string } | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const git = join(dir, ".git");
    try {
      if (existsSync(git)) {
        if (statSync(git).isDirectory()) return existsSync(join(git, "HEAD")) ? { repoDir: dir, commonGitDir: git } : null;
        const text = readFileSync(git, "utf8").trim();
        if (text.startsWith("gitdir: ")) {
          const gitDir = resolve(dir, text.slice(8).trim());
          if (!existsSync(join(gitDir, "HEAD"))) return null;
          const common = join(gitDir, "commondir");
          return { repoDir: dir, commonGitDir: existsSync(common) ? resolve(gitDir, readFileSync(common, "utf8").trim()) : gitDir };
        }
      }
    } catch {
      return null;
    }
    if (dirname(dir) === dir) return null;
  }
}

/** the main repo's context file that a nested linked worktree's own file stands in for (both are one repo's scope) */
function shadowedBy(cwd: string): string | undefined {
  const git = gitPaths(cwd);
  if (!git) return undefined;
  const common = real(git.commonGitDir);
  const root = real(git.repoDir);
  const main = dirname(common);
  if (!root.startsWith(`${main}${sep}`) || real(join(main, ".git")) !== common) return undefined;
  const own = contextFileIn(root);
  return own ? join(main, basename(own.path)) : undefined;
}

/** the context files pi loads for a cwd, in the order it puts them in the system prompt */
export function piContextFiles(cwd: string): ContextFile[] {
  const start = resolve(cwd);
  const shadowed = shadowedBy(start);
  const out: ContextFile[] = [];
  const seen = new Set<string>();
  for (let dir = start; ; dir = dirname(dir)) {
    const file = contextFileIn(dir);
    if (file && !seen.has(file.path) && !(shadowed !== undefined && real(file.path) === shadowed)) {
      out.unshift(file);
      seen.add(file.path);
    }
    if (dirname(dir) === dir) break;
  }
  return out;
}

export function readContextSnapshots(runDir: string): ContextSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(runDir, CONTEXT_FILES_RECORD), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is ContextSnapshot => !!s && typeof s === "object" && Array.isArray((s as ContextSnapshot).files));
  } catch {
    return [];
  }
}

const same = (a: ContextSnapshot, b: ContextSnapshot) =>
  a.files.length === b.files.length && a.files.every((f, i) => f.path === b.files[i].path && f.content === b.files[i].content) && (a.addendum ?? "") === (b.addendum ?? "");

/**
 * Copy the files pi is about to load, and the norms appended to its system prompt, into the run's record. A run that starts once (no turn) keeps the one copy; a
 * conversation's reply adds a copy only when the files differ from the last one, so an unchanged rule is not kept
 * for every turn. Best effort: a record that cannot be written never keeps pi from starting.
 */
export function recordContextFiles(runDir: string, cwd: string, turn?: number, addendum?: string): void {
  try {
    const snap: ContextSnapshot = { ...(turn !== undefined ? { turn } : {}), files: piContextFiles(cwd), ...(addendum ? { addendum } : {}) };
    const kept = turn === undefined ? [] : readContextSnapshots(runDir);
    if (kept.length && same(kept[kept.length - 1], snap)) return;
    const next: ContextSnapshot[] = [...kept, snap];
    const tmp = join(runDir, `.${CONTEXT_FILES_RECORD}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(next)}\n`);
    renameSync(tmp, join(runDir, CONTEXT_FILES_RECORD));
  } catch { /* the record is a reading aid, not part of the run */ }
}
