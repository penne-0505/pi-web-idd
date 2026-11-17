import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { runGate } from "../src/overlay/gate.ts";
import { resolveAreaKey } from "../src/config/areas.ts";
import { tmpDir } from './helpers/tmp.mjs';

/** a clean git repo, so the gate can read its worktree state */
function repo() {
  const dir = tmpDir("idd-area-words-");
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "--initial-branch=main");
  writeFileSync(join(dir, "app.txt"), "x\n");
  git("add", "-A");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "init");
  return dir;
}

test("a repo with no checks configured says repo, not area, in the checks row it puts on the card", async () => {
  const work = repo();
  const rows = await runGate(work, { path: join(work, "overlay.manifest"), paths: [], issues: [] }, [], undefined);
  const checks = rows.find((r) => r.name === "checks");
  assert.equal(checks.detail, "repo の検査設定がありません");
  assert.equal(JSON.stringify(rows).includes("area の検査設定"), false);
});

test("an unknown repo name in the accept field lists the registered repos, not the areas", async () => {
  const { error } = resolveAreaKey("nope", { areas: { demo: {} }, names: { demo: "proj" } });
  assert.match(error, /repo "nope" はありません/);
  assert.match(error, /demo（proj）/);
  assert.equal(error.includes("area"), false);
});
