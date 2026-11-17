import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { GET } = await jiti.import("./storage.ts");
import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";

const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_REPOS_FILE;
});

const at = (s) => `2026-09-20T${s}:00+09:00`;

function setup() {
  const root = scratchDir("storage-route-");
  made.push(root);
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(root, "repos.yaml"), JSON.stringify({
    storage: { cleanup: true, min_free_gb: 10, places: { run_records: { cleanup: true, keep_days: 7 } } },
    repos: {},
  }));
  writeFileSync(join(state, "lifecycle-demo.jsonl"), [
    { event: "lane_open", idd_id: "IDD-1", at: at("00:00"), attrs: {} },
    { event: "lane_close", idd_id: "IDD-1", at: at("12:00"), attrs: { outcome: "merged" } },
  ].map((e) => `${JSON.stringify(e)}\n`).join(""));
  const run = join(state, "lanes", "2026-09-18-000000-executor");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "lane.json"), JSON.stringify({ id: "x", status: "done", idd_id: "IDD-1", started_at: at("10:00"), ended_at: at("11:00") }));
  writeFileSync(join(run, "turns.jsonl"), "x".repeat(100));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, "repos.yaml") });
  return { root, state, run };
}

test("the response carries each place's size and the filesystem's free space (AC-024)", async () => {
  setup();
  const res = await GET();
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.measuredAt, "string");
  assert.ok(body.filesystems.length >= 1);
  assert.equal(typeof body.filesystems[0].freeBytes, "number");
  assert.equal(typeof body.filesystems[0].totalBytes, "number");
  assert.equal(typeof body.filesystems[0].mount, "string");
  const place = body.places.find((p) => p.place === "run_records");
  assert.ok(place, "the run records place is listed");
  assert.equal(place.count, 1);
  assert.ok(place.bytes >= 100);
  assert.equal(place.cleanup, true);
});

test("the response carries the candidates (path, size, due time) and the kept ones with their reasons (AC-025)", async () => {
  setup();
  const res = await GET();
  const body = await res.json();
  const c = body.candidates.find((x) => x.place === "run_records");
  assert.ok(c);
  assert.ok(c.path.endsWith("2026-09-18-000000-executor"));
  assert.ok(c.bytes >= 100);
  assert.equal(c.dueAt, new Date(Date.parse(at("12:00")) + 7 * 24 * 60 * 60 * 1000).toISOString());
  assert.equal(c.lane, "IDD-1");
  assert.ok(Array.isArray(body.kept));
});
