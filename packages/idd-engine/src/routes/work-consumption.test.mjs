import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { CONSUMPTION } = await jiti.import("./work.ts");
import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";

const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.IDD_STATE_DIR;
});

const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

function setup() {
  const root = scratchDir("work-consumption-");
  made.push(root);
  const state = join(root, "state");
  mkdirSync(state);
  process.env.IDD_STATE_DIR = state;
  put(join(state, "pipeline", "consumption.jsonl"), [
    { at: "2026-10-14T03:00:00.000Z", unit: "attempt", lane: "L1", role: "deep", contract: "openrouter", provider: "together", cost: 0.004, input: 10, output: 2, failure: "provider" },
    { at: "2026-10-14T04:00:00.000Z", unit: "reply", lane: "L1", role: "planner-claude", contract: "claude", harness: "claude", cost: 0.5, input: 30, output: 5 },
    // 2026-10-13T10:00Z is 19:00 JST on the 13th, so a since of the 14th leaves it out
    { at: "2026-10-13T10:00:00.000Z", unit: "attempt", lane: "L2", contract: "ollama-cloud", cost: 0.2, failure: "timeout" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { state };
}

test("the consumption door sums what each contract used, by provider and failure kind, and filters by lane and day", async () => {
  setup();
  const res = CONSUMPTION(new Request("http://localhost/x"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const body = await res.json();
  assert.equal(body.summary.units, 3);
  assert.equal(Math.round(body.summary.cost * 1000) / 1000, 0.704);
  // a bucket is one contract and provider, with the units and failure kinds it spent there
  assert.deepEqual(body.summary.buckets.map((b) => [b.contract, b.provider ?? null, b.attempts, b.replies]), [
    ["claude", null, 0, 1],
    ["ollama-cloud", null, 1, 0],
    ["openrouter", "together", 1, 0],
  ]);
  assert.deepEqual(body.summary.failures, { provider: 1, timeout: 1 });
  assert.equal(body.rows.length, 3);

  const one = await CONSUMPTION(new Request("http://localhost/x?lane=L1")).json();
  assert.equal(one.summary.units, 2);
  assert.deepEqual(one.rows.map((r) => r.contract), ["openrouter", "claude"]);

  const since = await CONSUMPTION(new Request("http://localhost/x?since=2026-10-14")).json();
  assert.equal(since.summary.units, 2);
  assert.deepEqual(since.rows.map((r) => r.lane), ["L1", "L1"]);
});

test("the consumption door writes nothing: the rows it read are the rows on disk", async () => {
  const { state } = setup();
  const before = readFileSync(join(state, "pipeline", "consumption.jsonl"), "utf8");
  await (await Promise.resolve(CONSUMPTION(new Request("http://localhost/x")))).json();
  assert.equal(readFileSync(join(state, "pipeline", "consumption.jsonl"), "utf8"), before);
  assert.deepEqual(readdirSync(join(state, "pipeline")), ["consumption.jsonl"]);
});
