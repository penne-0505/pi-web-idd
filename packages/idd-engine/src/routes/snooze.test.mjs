import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, tsconfigPaths: true, interopDefault: true });
const { POST: snoozePost } = await jiti.import("./snooze.ts");
const { GET: stateGet } = await jiti.import("./state.ts");

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-snooze-route-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "backlog.jsonl"), JSON.stringify({
    idd_id: "IDD-1", parent_id: null, created_at: "2026-09-24T00:00:00Z", linear_issue_url: null, gh_issue_url: null,
    pull_req_url: null, source_type: "github", context: "", title: "T", area: "test-area",
  }) + "\n");
  writeFileSync(join(dir, "pending-questions.jsonl"), JSON.stringify({
    idd_id: "IDD-1", batch_id: "b1", asked_at: "2026-09-24T00:00:00Z",
    questions: [{ question_id: "q1", question: "Q", context: "", options: [{ index: 1, label: "A" }] }],
  }) + "\n");
});
afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const post = (body) => snoozePost(new Request("http://localhost/api/idd/snooze", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

test("putting a card off needs no cookie: the inbox page and a direct POST go the same way", async () => {
  const res = await post({ key: "question:IDD-1:b1" });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
});

test("a card put off is marked on the inbox read, and bringing it back clears it", async () => {
  const res = await post({ key: "question:IDD-1:b1" });
  assert.equal(res.status, 200);
  const { until } = await res.json();
  const state = await (await stateGet()).json();
  assert.equal(state.items.find((i) => i.kind === "question").snoozedUntil, until);

  assert.equal((await post({ key: "question:IDD-1:b1", wake: true })).status, 200);
  const after = await (await stateGet()).json();
  assert.equal(after.items.find((i) => i.kind === "question").snoozedUntil, undefined);
});

test("a card put to sleep is marked on the inbox read, kept asleep, and brought back", async () => {
  const res = await post({ key: "question:IDD-1:b1", sleep: true });
  assert.equal(res.status, 200);
  const slept = (await (await stateGet()).json()).items.find((i) => i.kind === "question");
  assert.ok(slept.sleptAt);
  assert.ok(Date.parse(slept.sleepNoticeAt) > Date.parse(slept.sleptAt));
  assert.equal(slept.snoozedUntil, undefined);

  assert.equal((await post({ key: "question:IDD-1:b1", keepSleeping: true })).status, 200);
  const kept = (await (await stateGet()).json()).items.find((i) => i.kind === "question");
  assert.equal(kept.sleepStep, 1);
  // keeping asleep what is not asleep is refused
  assert.equal((await post({ key: "go:IDD-9", keepSleeping: true })).status, 400);

  assert.equal((await post({ key: "question:IDD-1:b1", wake: true })).status, 200);
  const back = (await (await stateGet()).json()).items.find((i) => i.kind === "question");
  assert.equal(back.sleptAt, undefined);
});
