import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");
const { GET: stateGet } = await import("../routes/state.ts");
const { rememberEngineStart, readStaleness, resetStaleness } = await import("./staleness.ts");

let dir;
let repo;

function setup() {
  dir = mkdtempSync(join(tmpdir(), "idd-state-engine-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "roles.yaml"), "roles:\n  r: { model: x/y }\n");
  process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
  repo = mkdtempSync(join(tmpdir(), "idd-state-engine-repo-"));
  const g = (...args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  const write = (path, text) => {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    g("add", "-A");
    g("commit", "-q", "-m", path);
  };
  return { g, write };
}

afterEach(() => {
  resetStaleness();
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_ROLES_FILE;
  for (const d of [dir, repo]) if (d) rmSync(d, { recursive: true, force: true });
  dir = undefined;
  repo = undefined;
});

describe("the state door's answer on the running engine", () => {
  it("carries the start commit and whether the engine is behind it", async () => {
    const { write } = setup();
    write("packages/a.ts", "a");
    rememberEngineStart({ root: repo, now: Date.UTC(2026, 9, 5, 1, 2) });

    const fresh = buildState();
    assert.equal(fresh.engine.stale, false);
    assert.ok(fresh.engine.startCommit);
    assert.equal(fresh.engine.startedAt.slice(11, 16), "01:02");

    // a change the engine reads again: it is behind, and the numbers say what came in
    write("packages/idd-engine/src/server/state.ts", "b");
    readStaleness({ root: repo });
    const stale = buildState();
    assert.equal(stale.engine.stale, true);
    assert.equal(stale.engine.commits, 1);
    assert.equal(stale.engine.landings, 0);
    assert.notEqual(stale.engine.head, stale.engine.startCommit);
  });

  it("is on an empty answer too, so the screen does not lose it when no lane waits", async () => {
    const { write } = setup();
    write("packages/a.ts", "a");
    rememberEngineStart({ root: repo });
    write("packages/b.ts", "b");
    readStaleness({ root: repo });
    const empty = buildState();
    // no backlog and no card: the answer is the empty one, and the staleness column must still be there
    assert.equal(empty.source, "empty");
    assert.equal(empty.engine.stale, true);
    assert.equal(empty.gui.stale, false);

    const res = await stateGet();
    const body = await res.json();
    assert.equal(body.engine.stale, true);
    assert.ok(body.engine.startCommit);
  });

  it("answers unknown, never stale, where git cannot read a commit", () => {
    setup();
    rememberEngineStart({ root: dir });
    const state = buildState();
    assert.equal(state.engine.unknown, true);
    assert.equal(state.engine.stale, false);
  });
});
