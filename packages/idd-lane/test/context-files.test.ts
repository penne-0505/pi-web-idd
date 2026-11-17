import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONTEXT_FILES_RECORD, piContextFiles, readContextSnapshots, recordContextFiles } from "../src/context-files.ts";
import { tmpDir } from "./helpers/tmp.ts";

const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};

/** the copies a record holds: the reply each was made for and the last file's text */
const kept = (dir: string) => readContextSnapshots(dir).map((s) => [s.turn, s.files.at(-1)?.content]);

describe("the context files copied into a run's record", () => {
  test("they are found the way pi finds them: the nearest name in each directory, the root-most first", () => {
    const root = tmpDir("idd-ctx-");
    write(join(root, "AGENTS.md"), "root rule");
    write(join(root, "a", "AGENTS.md"), "plain");
    write(join(root, "a", "AGENTS.override.md"), "override");
    write(join(root, "a", "b", "CLAUDE.md"), "claude");
    expect(piContextFiles(join(root, "a", "b")).map((f) => [f.path.slice(root.length), f.content])).toEqual([
      ["/AGENTS.md", "root rule"], ["/a/AGENTS.override.md", "override"], ["/a/b/CLAUDE.md", "claude"],
    ]);
  });

  test("a run that starts once keeps the latest copy; a conversation adds a copy only when the files changed", () => {
    const root = tmpDir("idd-ctx-");
    const cwd = join(root, "wt");
    const [once, conv] = [join(root, "once"), join(root, "conv")];
    for (const d of [once, conv]) mkdirSync(d);
    write(join(cwd, "AGENTS.md"), "v1");
    recordContextFiles(once, cwd);
    write(join(cwd, "AGENTS.md"), "v2");
    recordContextFiles(once, cwd);
    recordContextFiles(conv, cwd, 1);
    recordContextFiles(conv, cwd, 2);
    write(join(cwd, "AGENTS.md"), "v3");
    recordContextFiles(conv, cwd, 3);
    expect([kept(once), kept(conv)]).toEqual([[[undefined, "v2"]], [[1, "v2"], [3, "v3"]]]);
  });

  test("the norms appended to the system prompt are copied with the files, and a change in them alone adds a copy", () => {
    const root = tmpDir("idd-ctx-");
    const cwd = join(root, "wt");
    const dir = join(root, "conv");
    mkdirSync(dir);
    write(join(cwd, "AGENTS.md"), "v1");
    recordContextFiles(dir, cwd, 1, "norms 1");
    recordContextFiles(dir, cwd, 2, "norms 1");
    recordContextFiles(dir, cwd, 3, "norms 2");
    recordContextFiles(dir, cwd, 4);
    expect(readContextSnapshots(dir).map((s) => [s.turn, s.addendum])).toEqual([[1, "norms 1"], [3, "norms 2"], [4, undefined]]);
  });

  test("a record that cannot be written does not throw, and a run with none reads as no copy", () => {
    const missing = join(tmpDir("idd-ctx-"), "no-such-dir");
    recordContextFiles(missing, missing, 1);
    expect([readContextSnapshots(missing), existsSync(join(missing, CONTEXT_FILES_RECORD))]).toEqual([[], false]);
  });
});
