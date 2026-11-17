import { afterEach, beforeEach, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { emptyRepo } from "./git.ts";
import { tmpDir } from "./tmp.ts";

/** the registry this checkout ships; it is an overlay file, so a stripped copy and the public checkout do not have it */
export const SHIPPED_REPOS = resolve(import.meta.dir, "../../../../config/repos.yaml");

/**
 * A test that reads the shipped registry itself. Where the file is missing it is skipped, and the skipped name
 * carries the path that could not be read, so the run says "not checked" rather than failing or checking a stand-in.
 */
export function shippedReposTest(name: string, fn: () => void | Promise<void>): void {
  if (existsSync(SHIPPED_REPOS)) test(name, fn);
  else test.skip(`${name} (skipped: ${SHIPPED_REPOS} を読めません)`, fn);
}

/** write a registry of the test's own and point IDD_REPOS_FILE at it; the registry is read from nowhere else */
export function ownRepos(text = "repos: {}\n"): string {
  const file = join(tmpDir("idd-repos-"), "repos.yaml");
  writeFileSync(file, text);
  process.env.IDD_REPOS_FILE = file;
  return file;
}

/** `fn` runs on a registry of the given text, and the IDD_REPOS_FILE it found is put back once `fn` (or the promise it returns) is done */
export function withRepos<T>(text: string, fn: () => T): T {
  const saved = process.env.IDD_REPOS_FILE;
  const restore = (): void => {
    if (saved === undefined) delete process.env.IDD_REPOS_FILE;
    else process.env.IDD_REPOS_FILE = saved;
  };
  ownRepos(text);
  let out: T;
  try {
    out = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (out instanceof Promise) return out.finally(restore) as T;
  restore();
  return out;
}

/** `fn` runs on a registry whose one repo `id` has `upstream` as its public clone, a work repo of its own and the given pointers */
export function withPointedRepo<T>(id: string, upstream: string, conventions: Record<string, unknown>, fn: () => T, extra: Record<string, unknown> = {}): T {
  return withRepos(JSON.stringify({ repos: { [id]: { upstream, work: emptyRepo("idd-work-"), public_base: "main", conventions, ...extra } } }), fn);
}

/**
 * For a test file: every test starts on its own empty registry, and whatever IDD_REPOS_FILE a test sets is put
 * back afterwards. bun runs the files of one group in one process, so a variable left behind would reach the next file.
 */
export function isolateRepos(): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.IDD_REPOS_FILE;
    ownRepos();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.IDD_REPOS_FILE;
    else process.env.IDD_REPOS_FILE = saved;
  });
}
