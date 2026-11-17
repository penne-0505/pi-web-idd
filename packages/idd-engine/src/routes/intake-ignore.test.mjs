import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": root }, tsconfigPaths: true, interopDefault: true });
const { GET, POST } = await jiti.import(`${root}/packages/idd-engine/src/routes/intake-ignore.ts`);
const { getAgentRunner } = await jiti.import(`${root}/packages/idd-core/src/index.ts`);

let dir;
let saved;
beforeEach(() => {
  saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE, IDD_SYSTEMD_RUN_BIN: process.env.IDD_SYSTEMD_RUN_BIN, PATH: process.env.PATH };
  dir = mkdtempSync(join(tmpdir(), "idd-ignore-route-"));
  process.env.IDD_STATE_DIR = dir;
  process.env.IDD_REPOS_FILE = join(dir, "repos.yaml");
  writeFileSync(process.env.IDD_REPOS_FILE, "repos: {}\n");
  // a systemd-run that is not there: the kick is asked for (the request file is left), and no timer is started
  const bin = join(dir, "bin"); mkdirSync(bin);
  const stub = join(bin, "systemd-run");
  writeFileSync(stub, "#!/bin/sh\nexit 1\n"); chmodSync(stub, 0o755);
  process.env.IDD_SYSTEMD_RUN_BIN = stub;
  writeFileSync(join(dir, "backlog.jsonl"), JSON.stringify({
    idd_id: "IDD-001", parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null,
    gh_issue_url: "https://github.com/o/r/issues/12", pull_req_url: null, source_type: "github", context: "", title: "gh twelve", area: "demo",
  }) + "\n");
  writeFileSync(join(dir, "planner-sessions.jsonl"), JSON.stringify({ idd_id: "IDD-001", planner_session_id: "P-1", worktree_path: "/w", branch: "b" }) + "\n");
  // a run that is working now: the real runtime reads its lane record, so a fixture can make one. It names no
  // process yet, so it counts as working only inside the start grace; its start is now, not a stale date.
  mkdirSync(join(dir, "lanes", "RUN-1"), { recursive: true });
  writeFileSync(join(dir, "lanes", "RUN-1", "lane.json"), JSON.stringify({ id: "RUN-1", role: "reviewer", model: "x/y", worktree: "/w", spec: "/s.yaml", report: join(dir, "report"), status: "running", started_at: new Date().toISOString() }));
  writeFileSync(join(dir, "lifecycle-demo.jsonl"), JSON.stringify({ event: "s2_review_started", idd_id: "IDD-001", at: "2026-09-27T00:00:00Z", attrs: { run_ids: ["RUN-1"] } }) + "\n");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const post = (body) => POST(new Request("http://localhost/api/idd/intake/ignore", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));
const lifecycleText = () => (existsSync(join(dir, "lifecycle-demo.jsonl")) ? readFileSync(join(dir, "lifecycle-demo.jsonl"), "utf8") : "");

test("the lane list's ignore puts the runner in before it writes, so what is working is stopped right here", async () => {
  assert.equal(getAgentRunner(), null, "no runtime is installed when the server's first ignore lands");
  const res = await post({ action: "ignore", ref: "#12", closeLane: "IDD-001" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.lane, "IDD-001");
  assert.notEqual(getAgentRunner(), null, "the runner was put in before the write");
  assert.match(lifecycleText(), /"lane_close"/);
  const note = lifecycleText().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === "lane_work_stopped").pop();
  assert.deepEqual([note.attrs.via, note.attrs.runs], ["ignore", ["RUN-1"]]);
  assert.equal(JSON.parse(readFileSync(join(dir, "lanes", "RUN-1", "lane.json"), "utf8")).status, "stopped");
  // the session record names a session this runtime does not know: nothing is stopped for it, and it is not claimed
  assert.deepEqual(note.attrs.sessions, []);
  assert.equal(existsSync(join(dir, "intake-ignores.jsonl")), true);
});

test("a write asks for a tick (the request is left for it); a refused write asks for none", async () => {
  assert.equal((await post({ action: "ignore", ref: "#12", closeLane: "IDD-001" })).status, 200);
  assert.equal(existsSync(join(dir, "tick.again")), true, "the tick is asked for: the closed lane's worktree and work are its");
  rmSync(join(dir, "tick.again"));
  // the lane is closed now: its own ID is refused, nothing is written, and no tick is asked for
  const refused = await post({ action: "ignore", ref: "IDD-001" });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /既に閉じています/);
  assert.equal(existsSync(join(dir, "tick.again")), false);
  // reading the list records nothing, so it asks for none either
  const read = await GET(new Request("http://localhost/api/idd/intake/ignore"));
  assert.equal(read.status, 200);
  assert.equal(existsSync(join(dir, "tick.again")), false);
});

test("a lane is closed only against the confirmation the screen showed: a press that outran the read writes nothing", async () => {
  
  // the press that carries no lane (Enter before the read came back, or a read that failed): refused, and the lane to confirm is told
  const early = await post({ action: "ignore", ref: "#12" });
  assert.equal(early.status, 400);
  const earlyBody = await early.json();
  assert.equal(earlyBody.needsConfirm, "IDD-001");
  assert.match(earlyBody.error, /確認してから/);
  assert.equal(existsSync(join(dir, "lifecycle-demo.jsonl")) && lifecycleText().includes('"lane_close"'), false, "nothing is written");
  assert.equal(existsSync(join(dir, "intake-ignores.jsonl")), false);

  // a confirmation of another lane (the field was rewritten after the read) is refused too
  const stale = await post({ action: "ignore", ref: "#12", closeLane: "IDD-099" });
  assert.equal(stale.status, 400);
  assert.equal((await stale.json()).needsConfirm, "IDD-001");
  assert.equal(lifecycleText().includes('"lane_close"'), false);

  // the confirmed press closes the lane it was shown for
  const confirmed = await post({ action: "ignore", ref: "#12", closeLane: "IDD-001" });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).lane, "IDD-001");
  assert.match(lifecycleText(), /"lane_close"/);

  // the lane is closed now: the read says so, and a press that says no lane is at stake writes the list alone
  const after = await (await GET(new Request("http://localhost/api/idd/intake/ignore?ref=%2312"))).json();
  assert.equal(after.preview.closed, "IDD-001");
  const byRef = await post({ action: "ignore", ref: "#12", closeLane: null });
  assert.equal(byRef.status, 200);
  assert.equal(readFileSync(join(dir, "intake-ignores.jsonl"), "utf8").includes("#12"), true);
  // while the lane's own ID is the form that closes it: still refused, with nothing written
  const byId = await post({ action: "ignore", ref: "IDD-001", closeLane: null });
  assert.equal(byId.status, 400);
  assert.match((await byId.json()).error, /既に閉じています/);
});
