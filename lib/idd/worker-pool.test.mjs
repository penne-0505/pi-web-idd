import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { WorkerPool, getWorkerPool } = await jiti.import("./worker-pool.ts");

function makeDesc(overrides = {}) {
  return {
    id: "sess-1",
    role: "executor",
    status: "idle",
    model: "openrouter/deepseek/deepseek-v4-flash",
    updatedAt: "2026-08-23T10:00:00+09:00",
    ...overrides,
  };
}

test("register + get returns a clone", () => {
  const p = new WorkerPool();
  const d = makeDesc();
  p.register(d);
  const got = p.get("sess-1");
  assert.equal(got.id, "sess-1");
  got.status = "busy";
  assert.equal(p.get("sess-1").status, "idle");
});

test("update patches fields and stamps updatedAt", () => {
  const p = new WorkerPool();
  p.register(makeDesc());
  const patched = p.update("sess-1", { status: "busy" });
  assert.equal(patched.status, "busy");
  assert.notEqual(patched.updatedAt, "2026-08-23T10:00:00+09:00");
  assert.equal(p.get("sess-1").status, "busy");
});

test("update on unknown id returns undefined", () => {
  const p = new WorkerPool();
  assert.equal(p.update("missing", { status: "busy" }), undefined);
});

test("list + listByRole", () => {
  const p = new WorkerPool();
  p.register(makeDesc({ id: "a", role: "planner" }));
  p.register(makeDesc({ id: "b", role: "executor" }));
  p.register(makeDesc({ id: "c", role: "executor" }));
  assert.equal(p.list().length, 3);
  assert.equal(p.listByRole("executor").length, 2);
  assert.equal(p.listByRole("planner").length, 1);
});

test("pickIdle returns first idle worker of that role", () => {
  const p = new WorkerPool();
  p.register(makeDesc({ id: "e1", status: "busy" }));
  p.register(makeDesc({ id: "e2", status: "idle" }));
  p.register(makeDesc({ id: "e3", status: "idle" }));
  const picked = p.pickIdle("executor");
  assert.equal(picked.id, "e2");
});

test("pickIdle returns undefined when all workers of the role are busy", () => {
  const p = new WorkerPool();
  p.register(makeDesc({ id: "e1", status: "busy" }));
  p.register(makeDesc({ id: "e2", status: "starting" }));
  assert.equal(p.pickIdle("executor"), undefined);
});

test("unregister removes worker", () => {
  const p = new WorkerPool();
  p.register(makeDesc());
  p.unregister("sess-1");
  assert.equal(p.get("sess-1"), undefined);
});

test("getWorkerPool returns a singleton across calls", () => {
  const a = getWorkerPool();
  const b = getWorkerPool();
  assert.equal(a, b);
});

test("currentTask carries via update", () => {
  const p = new WorkerPool();
  p.register(makeDesc());
  p.update("sess-1", { status: "busy", currentTask: { linearIssueId: "APP-1", startedAt: "2026-08-23T11:00:00+09:00" } });
  const cur = p.get("sess-1").currentTask;
  assert.equal(cur.linearIssueId, "APP-1");
});
