import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { tmpDir } from "./tmp.ts";

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@l", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@l", GIT_CONFIG_GLOBAL: "/dev/null" };

/** git in `cwd` as a fixed author, the output trimmed */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY } }).trim();
}

/** an empty repo on main, in a temp dir of its own */
export function emptyRepo(prefix: string, bare = false): string {
  const dir = tmpDir(prefix);
  git(dir, "init", "-q", "--initial-branch=main", ...(bare ? ["--bare"] : []));
  return dir;
}

/** write `files` (path → text) under `root` */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** commit everything in `cwd` */
export function commitAll(cwd: string, message: string): void {
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", message);
}

/** a new bare origin that `repo` pushes its main to; the origin's path is returned */
export function pushToNewOrigin(repo: string): string {
  const origin = emptyRepo("idd-origin-", true);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  return origin;
}
