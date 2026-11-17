import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

const { pathEffect, effectsOf, rememberEngineStart, readStaleness, engineStaleView, resetStaleness, setReloadHold } = await import("./staleness.ts");

let dir;

/** a temp git repo: the checkout the engine loaded, which landings advance under it */
function repo() {
  dir = mkdtempSync(join(tmpdir(), "idd-stale-"));
  const g = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  const write = (path, text) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  const commit = (message) => {
    g("add", "-A");
    g("commit", "-q", "-m", message);
  };
  return { g, write, commit };
}

/** the engine starts on `files`, then each later pair is a commit made under it */
function startThen(...commits) {
  const r = repo();
  r.write("README.md", "base");
  r.commit("base");
  rememberEngineStart({ root: dir, now: Date.UTC(2026, 9, 5, 1, 2) });
  for (const [path, text] of commits) {
    r.write(path, text);
    r.commit(`change ${path}`);
    readStaleness({ root: dir });
  }
  return r;
}

afterEach(() => {
  resetStaleness();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("which changed paths count", () => {
  it("calls records, tests and re-read settings ineffective for both sides", () => {
    for (const path of ["_docs/plan/a/b.md", "_meta/scratch/x", "TODO.md", "config/roles.yaml", "packages/idd-core/test/a.test.mjs", "lib/foo.test.ts", "components/idd/x.test.mjs"]) {
      assert.deepEqual(pathEffect(path), { engine: false, gui: false }, path);
    }
  });

  it("calls the screen's own places ineffective for the engine, and bin/ ineffective for the screen", () => {
    for (const path of ["packages/idd-gui/src/main.tsx", "packages/idd-gui/src/inbox/deck.ts", "packages/idd-gui/build.ts"]) {
      assert.deepEqual(pathEffect(path), { engine: false, gui: true }, path);
    }
    assert.deepEqual(pathEffect("bin/idd-engine"), { engine: true, gui: false });
  });

  it("calls shared code and unknown places effective for both", () => {
    for (const path of ["lib/idd-ui/types.ts", "packages/idd-engine/src/main.ts", "somewhere-new/x.ts", "README.md"]) {
      assert.deepEqual(pathEffect(path), { engine: true, gui: true }, path);
    }
    assert.deepEqual(effectsOf(["packages/idd-gui/src/a.tsx", "bin/idd"]), { engine: true, gui: true });
  });
});

describe("the engine's staleness against its checkout", () => {
  it("is not stale while the head stands still", () => {
    const r = repo();
    r.write("packages/a.ts", "a");
    r.commit("base");
    rememberEngineStart({ root: dir, now: Date.UTC(2026, 9, 5, 1, 2) });
    const read = readStaleness({ root: dir });
    assert.equal(read.readable, true);
    const view = engineStaleView();
    assert.equal(view.stale, false);
    assert.equal(view.startCommit, read.head);
    assert.equal(view.landings, 0);
    assert.equal(view.commits, 0);
    assert.equal(view.startedAt.slice(11, 16), "01:02");
  });

  it("counts a record-only change as stale for neither side", () => {
    startThen(["_docs/x.md", "x"]);
    const read = readStaleness({ root: dir });
    assert.equal(read.engine, false);
    assert.equal(read.gui, false);
    const view = engineStaleView();
    assert.equal(view.stale, false);
    assert.equal(view.commits, 1);
    assert.notEqual(view.startCommit, view.head);
  });

  it("calls a change under the screen's package stale for the screen alone", () => {
    startThen(["packages/idd-gui/src/main.tsx", "x"]);
    const read = readStaleness({ root: dir });
    assert.deepEqual([read.engine, read.gui], [false, true]);
  });

  it("calls a bin-only change stale for the engine alone", () => {
    startThen(["bin/idd-engine", "x"]);
    const read = readStaleness({ root: dir });
    assert.deepEqual([read.engine, read.gui], [true, false]);
    assert.equal(engineStaleView().stale, true);
  });

  it("calls shared code and a new directory stale for both", () => {
    for (const path of ["packages/idd-engine/src/server/state.ts", "lib/idd-ui/types.ts", "brand-new-dir/x.ts"]) {
      startThen([path, "x"]);
      const read = readStaleness({ root: dir });
      assert.deepEqual([read.engine, read.gui], [true, true], path);
      resetStaleness();
    }
  });

  it("counts first-parent merges as landings and other commits apart", () => {
    const r = repo();
    r.write("packages/a.ts", "a");
    r.commit("base");
    rememberEngineStart({ root: dir });
    r.write("packages/a.ts", "a2");
    r.commit("plain");
    r.g("checkout", "-q", "-b", "side");
    r.write("packages/b.ts", "b");
    r.commit("side");
    r.g("checkout", "-q", "main");
    r.g("merge", "-q", "--no-ff", "-m", "Merge side", "side");
    r.write("packages/a.ts", "a3");
    r.commit("after");
    const read = readStaleness({ root: dir });
    assert.equal(read.landings, 1);
    assert.equal(read.commits, 2);
    const view = engineStaleView();
    assert.equal(view.landings, 1);
    assert.equal(view.commits, 2);
  });

  it("reads the diff again only once the head moves", () => {
    startThen(["packages/a.ts", "x"]);
    const first = readStaleness({ root: dir });
    let calls = 0;
    const counting = (root, args) => {
      calls += 1;
      const stdout = execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true, stdout, stderr: "" };
    };
    const again = readStaleness({ root: dir, git: counting });
    assert.equal(again, first);
    assert.equal(calls, 1, "only git rev-parse runs when the head has not moved");
  });

  it("answers unknown, and never stale, where git cannot read a commit", () => {
    dir = mkdtempSync(join(tmpdir(), "idd-stale-nogit-"));
    rememberEngineStart({ root: dir });
    const view = engineStaleView();
    assert.equal(view.stale, false);
    assert.equal(view.unknown, true);
    assert.equal(view.startCommit, undefined);
    const read = readStaleness({ root: dir, now: Date.UTC(2026, 9, 5) });
    assert.equal(read.readable, false);
    assert.equal(engineStaleView().unknown, true);
  });

  it("carries why a replacement is not being asked for", () => {
    startThen(["packages/a.ts", "x"]);
    setReloadHold("開いている会話を待っています");
    assert.equal(engineStaleView().hold, "開いている会話を待っています");
    setReloadHold(null);
    assert.equal(engineStaleView().hold, undefined);
  });
});
