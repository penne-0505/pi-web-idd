import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  listLedgerFiles,
  readRepoLedger,
  readAllLedgers,
  readAllLanes,
  filterLifecycleEvents,
} = await jiti.import("./ledger-io.ts");

async function makeState(files) {
  const dir = await mkdtemp(join(tmpdir(), "idd-ledger-io-"));
  await mkdir(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents, "utf-8");
  }
  return dir;
}

function line(obj) {
  return JSON.stringify(obj) + "\n";
}

test("listLedgerFiles: missing dir returns empty", async () => {
  const files = await listLedgerFiles("/nonexistent/idd-io-test");
  assert.deepEqual(files, []);
});

test("listLedgerFiles: filters + parses repo alias from filename, sorted", async () => {
  const dir = await makeState({
    "ledger-server.jsonl": "",
    "ledger-flutter.jsonl": "",
    "ledger-web.jsonl": "",
    "not-a-ledger.txt": "",
    "ledger-.jsonl": "",
  });
  try {
    const found = await listLedgerFiles(dir);
    assert.deepEqual(found.map((f) => f.repo), ["flutter", "server", "web"]);
    assert.ok(found[0].path.endsWith("ledger-flutter.jsonl"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readRepoLedger: missing file returns empty events", async () => {
  const r = await readRepoLedger("/nonexistent/x.jsonl", "flutter");
  assert.deepEqual(r.events, []);
  assert.equal(r.repo, "flutter");
});

test("readRepoLedger: parses valid, silently skips malformed", async () => {
  const dir = await makeState({
    "ledger-flutter.jsonl":
      line({ ts: "2026-08-23T09:00:00+09:00", repo: "flutter", type: "lifecycle_lane_open", linear_issue_id: "APP-1", worktree_branch: "feature/x", worker: "w" }) +
      "{ not valid json\n" +
      "\n" +
      line({ ts: "2026-08-23T09:01:00+09:00", repo: "flutter", type: "import", head: "abc" }),
  });
  try {
    const r = await readRepoLedger(join(dir, "ledger-flutter.jsonl"), "flutter");
    assert.equal(r.events.length, 2);
    assert.equal(r.events[0].type, "lifecycle_lane_open");
    assert.equal(r.events[1].type, "import");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readAllLedgers: reads every ledger in the dir", async () => {
  const dir = await makeState({
    "ledger-flutter.jsonl": line({ ts: "T", repo: "flutter", type: "import", head: "a" }),
    "ledger-server.jsonl": line({ ts: "T", repo: "server", type: "import", head: "b" }),
  });
  try {
    const ledgers = await readAllLedgers(dir);
    assert.equal(ledgers.length, 2);
    assert.deepEqual(ledgers.map((l) => l.repo).sort(), ["flutter", "server"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readAllLanes: cross-repo fold with retire semantics", async () => {
  const dir = await makeState({
    "ledger-flutter.jsonl":
      line({ ts: "2026-08-23T09:00:00+09:00", repo: "flutter", type: "lifecycle_lane_open", linear_issue_id: "APP-1", worktree_branch: "feature/x", worker: "w1" }) +
      line({ ts: "2026-08-23T09:30:00+09:00", repo: "flutter", type: "lifecycle_s2_start", linear_issue_id: "APP-1", worker: "w2" }),
    "ledger-server.jsonl":
      line({ ts: "2026-08-23T09:10:00+09:00", repo: "server", type: "lifecycle_lane_open", linear_issue_id: "BAC-9", worktree_branch: "feat/x", worker: "w" }) +
      line({ ts: "2026-08-23T09:20:00+09:00", repo: "server", type: "lifecycle_lane_close", linear_issue_id: "BAC-9", close_reason: "delete" }),
  });
  try {
    const active = await readAllLanes(dir);
    assert.equal(active.length, 1);
    assert.equal(active[0].linearIssueId, "APP-1");
    assert.equal(active[0].repo, "flutter");
    assert.equal(active[0].stage, "s2-implementing");
    assert.equal(active[0].worker, "w2");

    const full = await readAllLanes(dir, { includeRetired: true });
    assert.equal(full.length, 2);
    const bac = full.find((l) => l.linearIssueId === "BAC-9");
    assert.equal(bac.stage, "lane-close");
    assert.equal(bac.repo, "server");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readAllLanes: sorted by since descending", async () => {
  const dir = await makeState({
    "ledger-flutter.jsonl":
      line({ ts: "2026-08-23T08:00:00+09:00", repo: "flutter", type: "lifecycle_lane_open", linear_issue_id: "APP-1", worktree_branch: "x", worker: "w" }) +
      line({ ts: "2026-08-23T12:00:00+09:00", repo: "flutter", type: "lifecycle_lane_open", linear_issue_id: "APP-2", worktree_branch: "y", worker: "w" }),
  });
  try {
    const lanes = await readAllLanes(dir);
    assert.deepEqual(lanes.map((l) => l.linearIssueId), ["APP-2", "APP-1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("filterLifecycleEvents: drops non-lifecycle and malformed", () => {
  const filtered = filterLifecycleEvents([
    { ts: "T", repo: "x", type: "lifecycle_lane_open", linear_issue_id: "APP-1" },
    { ts: "T", repo: "x", type: "import" },
    null,
    "str",
    { type: "lifecycle_lane_open", linear_issue_id: "" },
  ]);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].linear_issue_id, "APP-1");
});
