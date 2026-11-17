import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { GET } = await jiti.import("./forecast.ts");
import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";

const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_REPOS_FILE;
  delete process.env.IDD_ROLES_FILE;
});

const at = (m) => new Date(Date.parse("2026-10-13T00:00:00Z") + m * 60_000).toISOString();
const ev = (idd, event, m, attrs = {}) => ({ idd_id: idd, event, at: at(m), attrs });

/** two repos, each with an open lane and a landed one */
function setup() {
  const root = scratchDir("forecast-route-");
  made.push(root);
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(root, "repos.yaml"), JSON.stringify({ repos: {} }));
  writeFileSync(join(root, "roles.yaml"), "");
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, "repos.yaml"), IDD_ROLES_FILE: join(root, "roles.yaml") });
  writeFileSync(join(state, "backlog.jsonl"), [
    { idd_id: "IDD-1", area: "one/repo", title: "open one", context: "", created_at: at(0) },
    { idd_id: "IDD-2", area: "two/repo", title: "open two", context: "", created_at: at(0) },
    { idd_id: "IDD-3", area: "one/repo", title: "closed", context: "", created_at: at(0) },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(state, "lifecycle-one-repo.jsonl"), [
    ev("IDD-1", "lane_open", 0),
    ev("IDD-3", "lane_open", 0), ev("IDD-3", "lane_close", 5, { outcome: "local" }),
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(state, "lifecycle-two-repo.jsonl"), JSON.stringify(ev("IDD-2", "lane_open", 0)) + "\n");
  return { root, state };
}

function snapshot(dir) {
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    try { out[name] = readFileSync(path, "utf8"); } catch { out[name] = null; }
  }
  return out;
}

test("the door answers with the usual table per repo and every open lane (AC-026)", async () => {
  setup();
  const res = await GET();
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.usual.length, 2, "one usual table per repo with an open lane");
  assert.deepEqual(body.usual.map((u) => u.area).sort(), ["one/repo", "two/repo"]);
  for (const table of body.usual) {
    assert.ok(Object.keys(table.stages).length >= 7, "the plan, review, fix, R2 and landing stages are all there");
    assert.equal(typeof table.stages.impl.median, "number");
  }
  assert.deepEqual(body.lanes.map((l) => l.iddId).sort(), ["IDD-1", "IDD-2"]);
  assert.equal(body.lanes.some((l) => l.iddId === "IDD-3"), false, "a closed lane is not forecast");
});

test("the door writes nothing in the state (AC-027)", async () => {
  const { state } = setup();
  const before = snapshot(state);
  const res = await GET();
  assert.equal(res.status, 200);
  await res.json();
  assert.deepEqual(snapshot(state), before, "the files and their contents are untouched");
});
