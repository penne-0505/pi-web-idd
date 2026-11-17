import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": root }, tsconfigPaths: true, interopDefault: true });
const { GET, POST } = await jiti.import(`${root}/packages/idd-engine/src/routes/order.ts`);

let dir;
let saved;
beforeEach(() => {
  saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, PATH: process.env.PATH };
  dir = mkdtempSync(join(tmpdir(), "idd-order-route-"));
  process.env.IDD_STATE_DIR = dir;
  // a systemd-run that is not there: the kick is asked for (the request file is left), and no timer is started
  const bin = join(dir, "bin"); mkdirSync(bin);
  const stub = join(bin, "systemd-run");
  writeFileSync(stub, "#!/bin/sh\nexit 1\n"); chmodSync(stub, 0o755);
  process.env.IDD_SYSTEMD_RUN_BIN = stub;
  const lane = (id, i) => JSON.stringify({
    idd_id: id, parent_id: null, created_at: `2026-09-25T0${i}:00:00Z`, linear_issue_url: null,
    gh_issue_url: `https://github.com/o/r/issues/${i + 1}`, pull_req_url: null, source_type: "github",
    context: "", title: `T ${id}`, area: "demo",
  });
  writeFileSync(join(dir, "backlog.jsonl"), [lane("IDD-001", 0), lane("IDD-002", 1), lane("IDD-003", 2)].join("\n") + "\n");
  writeFileSync(join(dir, "lifecycle-demo.jsonl"), "");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete process.env.IDD_SYSTEMD_RUN_BIN;
  rmSync(dir, { recursive: true, force: true });
});

const post = (body) => POST(new Request("http://localhost/api/idd/order", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));
const read = () => GET(new Request("http://localhost/api/idd/order"));
const ids = (body) => body.lanes.map((l) => l.idd_id);

test("AC-015: GET returns the order, and POST moves, marks urgent and clears it", async () => {
  const got = await read();
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("cache-control"), "no-store");
  assert.deepEqual(ids(await got.json()), ["IDD-001", "IDD-002", "IDD-003"]);

  const moved = await post({ action: "move", idd_id: "IDD-003", position: 1 });
  assert.equal(moved.status, 200);
  const movedBody = await moved.json();
  assert.equal(movedBody.ok, true);
  assert.deepEqual(ids(movedBody), ["IDD-003", "IDD-001", "IDD-002"]);

  const urgent = await post({ action: "urgent", idd_id: "IDD-002" });
  assert.equal(urgent.status, 200);
  assert.deepEqual(ids(await urgent.json()), ["IDD-002", "IDD-003", "IDD-001"]);
  assert.equal((await read().then((r) => r.json())).lanes[0].urgent, true);

  const plain = await post({ action: "unurgent", idd_id: "IDD-002" });
  assert.equal(plain.status, 200);
  assert.deepEqual(ids(await plain.json()), ["IDD-003", "IDD-001", "IDD-002"]);
});

test("AC-015: a body that cannot be honoured is 400, and no exception escapes", async () => {
  for (const [label, body, status] of [
    ["unknown action", { action: "jump", idd_id: "IDD-001" }, 400],
    ["missing action", { idd_id: "IDD-001" }, 400],
    ["missing id", { action: "urgent" }, 400],
    ["blank id", { action: "urgent", idd_id: "  " }, 400],
    ["id not a string", { action: "urgent", idd_id: 7 }, 400],
    ["before not a string", { action: "move", idd_id: "IDD-001", before: 3 }, 400],
    ["position not a number", { action: "move", idd_id: "IDD-001", position: "1" }, 400],
    ["null body", "null", 400],
    ["array body", "[]", 400],
    ["string body", "\"x\"", 400],
    ["number body", "5", 400],
    ["not JSON", "not json", 400],
    ["refused by core", { action: "move", idd_id: "IDD-999", position: 1 }, 400],
  ]) {
    const res = await post(body);
    assert.equal(res.status, status, label);
    const parsed = await res.json();
    assert.equal(parsed.ok, false, label);
    assert.ok(parsed.error, label);
  }
  assert.equal(existsSync(join(dir, "start-order.jsonl")) ? readFileSync(join(dir, "start-order.jsonl"), "utf8").trim() : "", "", "a refused write appends no line");
});

test("AC-015: a write asks for a tick; the reader asks for none", async () => {
  await read();
  assert.equal(existsSync(join(dir, "tick.again")), false, "the reader asks for no tick");
  const res = await post({ action: "move", idd_id: "IDD-002", position: 1 });
  assert.equal(res.status, 200);
  assert.equal(existsSync(join(dir, "tick.again")), true, "the write asks for a tick");
  assert.match(readFileSync(join(dir, "start-order.jsonl"), "utf8"), /"op":"move"/);
});
