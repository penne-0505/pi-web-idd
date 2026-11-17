import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers.mjs";
import { fakeFetch, settle } from "./fake.mjs";

const { WorkStore, needsDetail, detailToRead, jstDay } = await load("./src/work/store.ts");

const NOW = Date.parse("2026-10-05T12:00:00Z");
const lane = (over = {}) => ({ kind: "issue", id: "IDD-1", repo: "p", title: "t", bundle: "running", spans: [], waitsFor: [], ...over });
const snapshot = (lanes = [lane()]) => ({ now: new Date(NOW).toISOString(), repos: [], lanes, done: [], holds: [] });
const forecast = (lanes = []) => ({ ok: true, generatedAt: new Date(NOW).toISOString(), usual: [], lanes });

/** a finished row as the Work column returns it: an Issue lane by its github ref, a PR review by its pr ref */
const done = (id, ref) => ({ id, repo: "p", ref, title: id, closedAt: new Date(NOW).toISOString(), outcome: "local", decisions: 0 });
const doneIssue = (id) => done(id, { kind: "github", label: "x#9" });
const doneReview = (id) => done(id, { kind: "pr", label: "x#9" });

/** the consumption door's answer: the sidebar's 今日 reads only the summary's cost */
const consumption = (cost = 0, units = 0) => ({ rows: [], summary: { cost, units, buckets: [], failures: {} } });
const consumptionPath = (now) => `/api/idd/work/consumption?since=${jstDay(now)}`;

/** answer the consumption read the sidebar draws from; its path carries the JST day */
function answerConsumption(f, body = consumption()) {
  const call = f.calls.filter((c) => c.path.startsWith("/api/idd/work/consumption")).at(-1);
  if (call) call.respond(200, body);
  return call?.path;
}

/** answer one full read: the forecast and today's spend are the reads made beside the Work column */
function answerRead(f, workBody = snapshot(), forecastBody = forecast(), consumptionBody = consumption()) {
  f.of("/api/idd/work").at(-1).respond(200, workBody);
  f.of("/api/idd/forecast").at(-1).respond(200, forecastBody);
  answerConsumption(f, consumptionBody);
}

const detailBodies = (f) => {
  for (const call of f.calls.filter((c) => c.path.startsWith("/api/idd/lane/") || c.path.startsWith("/api/idd/work/lanes/"))) {
    call.respond(
      200,
      call.path.endsWith("/decisions")
        ? { lane: "IDD-1", own: [], existing: [], dropped: 0, paths: [] }
        : call.path.endsWith("/record")
          ? { lane: "IDD-1", acceptance: [], log: [], findings: { placed: [], delivered: [], disposals: [] } }
          : { iddId: "IDD-1", title: "t", group: "impl", phaseLabel: "", branch: "b", area: "p", since: "", contract: { decisions: [], criteria: [] }, timeline: [], agents: [], undelivered: { total: 0, failed: 0 } },
    );
  }
};

test("AC-030: only an Issue lane is read further", () => {
  assert.equal(needsDetail("issue"), true);
  assert.equal(needsDetail("hold"), false);
  assert.equal(needsDetail("review"), false);

  // the row the screen reads is named by `detailToRead`: a live Issue lane, or a finished one with a non-pr ref
  const s = {
    ...snapshot([lane({ id: "L1" }), lane({ id: "H1", kind: "hold" }), lane({ id: "R1", kind: "review" })]),
    done: [doneIssue("D1"), doneReview("REV-1")],
  };
  assert.equal(detailToRead(s, "L1"), "L1");
  assert.equal(detailToRead(s, "H1"), null, "a hold row keeps only the Work column");
  assert.equal(detailToRead(s, "R1"), null, "a PR review lane keeps only the Work column");
  assert.equal(detailToRead(s, "D1"), "D1", "a finished Issue lane has detail, DECs and a record");
  assert.equal(detailToRead(s, "REV-1"), null, "a finished PR review lane keeps only the Work column");
  assert.equal(detailToRead(s, null), null);
  assert.equal(detailToRead(s, "gone"), null);
  assert.equal(detailToRead(null, "L1"), null);
});

test("AC-002: selecting a finished Issue lane reads its detail, DECs and record; a finished PR review reads none", async () => {
  const f = fakeFetch();
  const s = new WorkStore(f.fetchFn, () => NOW);
  const read = s.read();
  answerRead(f, { ...snapshot(), done: [doneIssue("IDD-9"), doneReview("REV-9")] });
  await read;
  await settle();

  // the Work screen's effect, for a selection the URL named on open
  const before = f.calls.length;
  s.followSelection(s.state.snapshot, "IDD-9");
  detailBodies(f);
  await settle();
  assert.deepEqual(
    f.calls.slice(before).map((c) => c.path),
    ["/api/idd/lane/IDD-9", "/api/idd/work/lanes/IDD-9/decisions", "/api/idd/work/lanes/IDD-9/record"],
    "the finished Issue lane's own three doors are read",
  );
  assert.equal(s.state.detailFor, "IDD-9");

  // the same selection on a later poll reads nothing again, so the tabs do not flicker
  const settled = f.calls.length;
  s.followSelection(s.state.snapshot, "IDD-9");
  await settle();
  assert.equal(f.calls.length, settled);

  // a finished PR review lane keeps only the Work column
  s.followSelection(s.state.snapshot, "REV-9");
  await settle();
  assert.equal(f.calls.length, settled);
  assert.equal(s.state.detail, null);
  assert.equal(s.state.detailFor, null);
});

test("AC-036: a full pass of the screen's reads sends GETs and nothing else", async () => {
  const f = fakeFetch();
  const s = new WorkStore(f.fetchFn, () => NOW);
  const read = s.read();
  answerRead(f);
  await read;
  const detail = s.readDetail("IDD-1");
  detailBodies(f);
  await detail;
  await settle();
  assert.ok(f.calls.length >= 6, "the Work column, the forecast, today's spend, the lane, its decisions and its record");
  for (const call of f.calls) assert.equal(call.init?.method, undefined, `${call.path} must be a GET`);
  assert.deepEqual(
    [...new Set(f.calls.map((c) => c.path))],
    [
      "/api/idd/work",
      "/api/idd/forecast",
      consumptionPath(NOW),
      "/api/idd/lane/IDD-1",
      "/api/idd/work/lanes/IDD-1/decisions",
      "/api/idd/work/lanes/IDD-1/record",
    ],
  );
});

test("C-130-3: the sidebar's 今日 is the consumption door's total for the JST day, and empty when it cannot be read", async () => {
  const f = fakeFetch();
  const s = new WorkStore(f.fetchFn, () => NOW);
  const read = s.read();
  answerRead(f, snapshot(), forecast(), consumption(8.76, 3));
  await read;
  await settle();
  assert.equal(f.of(consumptionPath(NOW)).length, 1, "the door is asked for the JST day, not for every row");
  assert.equal(s.state.consumption.cost, 8.76, "the summary is what the screen draws");

  // an unreadable door leaves no number, so the place goes empty rather than showing a stale one (DEC-103-2)
  const again = s.read();
  f.of("/api/idd/work").at(-1).respond(200, snapshot());
  f.of("/api/idd/forecast").at(-1).respond(200, forecast());
  f.calls.filter((c) => c.path.startsWith("/api/idd/work/consumption")).at(-1).respond(500, { error: "boom" });
  await again;
  await settle();
  assert.equal(s.state.consumption, null);
  assert.equal(s.state.connection, "ok", "the Work column still reads");
});

test("AC-037: a failing read keeps the last picture and shows the band", async () => {
  const f = fakeFetch();
  const s = new WorkStore(f.fetchFn, () => NOW);
  const ok = s.read();
  answerRead(f, snapshot([lane({ id: "IDD-1" })]));
  await ok;
  assert.equal(s.state.connection, "ok");
  assert.equal(s.state.snapshot.lanes.length, 1);

  const five = s.read();
  f.of("/api/idd/work").at(-1).respond(500, { error: "boom" });
  f.of("/api/idd/forecast").at(-1).respond(200, forecast());
  answerConsumption(f);
  await five;
  await settle();
  assert.equal(s.state.connection, "down");
  assert.equal(s.state.attempt, 1);
  assert.equal(s.state.snapshot.lanes[0].id, "IDD-1", "the last display stays");

  const net = s.read();
  f.of("/api/idd/work").at(-1).reject(new Error("offline"));
  f.of("/api/idd/forecast").at(-1).reject(new Error("offline"));
  f.calls.filter((c) => c.path.startsWith("/api/idd/work/consumption")).at(-1).reject(new Error("offline"));
  await net;
  await settle();
  assert.equal(s.state.connection, "down");
  assert.equal(s.state.snapshot.lanes.length, 1);
});

test("C-130-1: the forecast is read beside the Work column, and an unreadable one clears the values", async () => {
  const f = fakeFetch();
  const s = new WorkStore(f.fetchFn, () => NOW);
  const body = forecast([
    { iddId: "IDD-1", area: "p", now: { kind: "stage", stage: "impl", since: new Date(NOW).toISOString(), elapsedMin: 3 }, anomaly: true, eta: { at: new Date(NOW + 3600_000).toISOString(), stopsAt: "sign", remaining: [] } },
  ]);
  const read = s.read();
  answerRead(f, snapshot(), body);
  await read;
  assert.equal(s.state.forecast.lanes.length, 1);
  assert.equal(s.state.forecast.lanes[0].iddId, "IDD-1");

  const again = s.read();
  f.of("/api/idd/work").at(-1).respond(200, snapshot());
  f.of("/api/idd/forecast").at(-1).respond(500, { error: "boom" });
  answerConsumption(f);
  await again;
  await settle();
  assert.equal(s.state.forecast, null, "no forecast means the finish and the usual length stay empty (DEC-103-2)");
  assert.equal(s.state.snapshot.lanes.length, 1, "the Work column keeps its last picture");
});

test("AC-037: a detail failure is kept at the detail and does not bring the whole screen down", async () => {
  const f = fakeFetch();
  const s = new WorkStore(f.fetchFn, () => NOW);
  const d = s.readDetail("IDD-1");
  for (const call of f.calls) call.respond(404, { error: "not found" });
  await d;
  await settle();
  assert.equal(s.state.detail?.error, "not-found");
  assert.equal(s.state.connection, "ok");
});

test("AC-002: the record is read with the detail and lands beside it", async () => {
  const f = fakeFetch();
  const s = new WorkStore(f.fetchFn, () => NOW);
  const d = s.readDetail("IDD-1");
  const record = { lane: "IDD-1", acceptance: [{ id: "AC-001", statement: "s", status: "verified" }], log: [], findings: { placed: [], delivered: [], disposals: [] } };
  for (const call of f.calls) {
    if (call.path.endsWith("/record")) call.respond(200, record);
    else if (call.path.endsWith("/decisions")) call.respond(200, { lane: "IDD-1", own: [], existing: [], dropped: 0, paths: [] });
    else call.respond(200, { iddId: "IDD-1", title: "t", group: "impl", phaseLabel: "", branch: "b", area: "p", since: "", contract: { decisions: [], criteria: [] }, timeline: [], agents: [], undelivered: { total: 0, failed: 0 } });
  }
  await d;
  await settle();
  assert.equal(s.state.detail.record.findings.placed.length, 0);
  assert.equal(s.state.detail.record.acceptance[0].id, "AC-001");
  assert.equal(s.state.detail.error, null);
});
