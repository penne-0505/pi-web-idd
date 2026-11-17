import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { createJiti } from "jiti";

// the route table reaches every door; a tick is never asked for here, but the flag keeps any import-time effect off
process.env.IDD_TICK_KICK = "off";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, tsconfigPaths: true, interopDefault: true });
const { routes, matchRoute } = await jiti.import("../routes.ts");
const { readLifecycle } = await jiti.import("../../../idd-core/src/ledger/read.ts");
const { approveProposal } = await jiti.import("../../../idd-core/src/intent/store.ts");
import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";

const TOKEN = "test-intent-token";
const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_REPOS_FILE;
  delete process.env.IDD_AGENT_TOKEN;
});

function setup() {
  const root = scratchDir("intent-route-");
  made.push(root);
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(root, "repos.yaml"), JSON.stringify({
    repos: { "me/app": { name: "app", upstream: join(root, "u"), work: join(root, "w"), public_base: "main" } },
  }));
  writeFileSync(join(state, "backlog.jsonl"), `${JSON.stringify({ idd_id: "IDD-1", area: "me/app", title: "T", context: "", created_at: "2026-09-24T00:00:00Z" })}\n`);
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, "repos.yaml"), IDD_AGENT_TOKEN: TOKEN });
  return { root, state };
}

/** the handler the route table carries for a method and a pattern */
function door(method, pattern) {
  const route = routes.find((r) => r.method === method && r.pattern === pattern);
  assert.ok(route, `${method} ${pattern} is in the table`);
  return route.handler;
}

const post = (body, token = TOKEN) => new Request("http://localhost/api/idd/intent", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const get = (query) => new Request(`http://localhost/api/idd/intent?${query}`, { method: "GET" });

function columnFile(state) {
  const file = readdirSync(state).find((f) => f.startsWith("intent-"));
  return file ? join(state, file) : null;
}
function columnRows(state) {
  const file = columnFile(state);
  if (!file) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("the route table carries the write and the read door for /api/idd/intent", () => {
  assert.deepEqual(
    routes.filter((r) => r.pattern === "/api/idd/intent").map((r) => r.method).sort(),
    ["GET", "POST"],
  );
  assert.deepEqual(matchRoute("/api/idd/intent", "/api/idd/intent"), {});
});

test("AC-022: the write door asks for the agent token, and a refused call leaves no row", async () => {
  const f = setup();
  const before = JSON.stringify(readLifecycle());
  const noToken = await door("POST", "/api/idd/intent")(post({ action: "raise_purpose", session: "s1", repo: "me/app", payload: { statement: "S", origin: "O" } }, null), {});
  assert.equal(noToken.status, 401);
  assert.equal(columnRows(f.state).length, 0);

  const badLane = await door("POST", "/api/idd/intent")(post({ action: "raise_purpose", idd_id: "IDD-404", payload: { statement: "S", origin: "O" } }), {});
  assert.equal(badLane.status, 400);
  assert.match(String((await badLane.json()).error), /unknown lane/);

  const badRepo = await door("POST", "/api/idd/intent")(post({ action: "raise_purpose", session: "s1", repo: "nope/nope", payload: { statement: "S", origin: "O" } }), {});
  assert.equal(badRepo.status, 400);
  assert.equal(columnRows(f.state).length, 0, "a refusal writes nothing");

  const unknown = await door("POST", "/api/idd/intent")(post({ action: "wat", session: "s1", repo: "me/app", payload: {} }), {});
  assert.equal(unknown.status, 400);
  assert.match(String((await unknown.json()).error), /未知の action/);
});

test("AC-022 / INV-099-7: a lane writes under its area, and a short repo name reaches the same column", async () => {
  const f = setup();
  const byLane = await door("POST", "/api/idd/intent")(post({ action: "raise_purpose", idd_id: "IDD-1", payload: { statement: "L", origin: "O" } }), {});
  assert.equal(byLane.status, 200, JSON.stringify(await byLane.clone().json()));
  assert.equal((await byLane.json()).status, "proposed");

  const byName = await door("POST", "/api/idd/intent")(post({ action: "raise_purpose", session: "s1", repo: "app", payload: { statement: "N", origin: "O" } }), {});
  assert.equal(byName.status, 200, JSON.stringify(await byName.clone().json()));
  const byKey = await door("POST", "/api/idd/intent")(post({ action: "raise_purpose", session: "s1", repo: "me/app", payload: { statement: "K", origin: "O" } }), {});
  assert.equal(byKey.status, 200);

  const files = readdirSync(f.state).filter((x) => x.startsWith("intent-"));
  assert.equal(files.length, 1, files.join(", "));
  assert.equal(columnRows(f.state).length, 3);
  // the lifecycle is not written by any of it
  assert.deepEqual(readLifecycle(), []);
});

test("AC-014 / INV-101-4: the check op needs no token and writes neither the column nor the lifecycle", async () => {
  const f = setup();
  // a lane's proposal never takes the overview's seat: it is P-2
  await door("POST", "/api/idd/intent")(post({ action: "raise_purpose", idd_id: "IDD-1", payload: { statement: "S", origin: "O" } }), {});
  await door("POST", "/api/idd/intent")(post({ action: "confirm_purpose", session: "s1", repo: "me/app", payload: { id: "P-2" } }), {});
  await door("POST", "/api/idd/intent")(post({
    action: "raise_choice", idd_id: "IDD-1",
    payload: { purpose: "P-2", forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "a/b.ts", kind: "file" }], why: "w", anchored: "x" },
  }), {});
  appendFileSync(join(f.state, "lifecycle-test.jsonl"), `${JSON.stringify({ event: "lane_open", idd_id: "IDD-1", at: "2026-10-01T00:00:00+09:00", attrs: {} })}\n`);
  appendFileSync(join(f.state, "lifecycle-test.jsonl"), `${JSON.stringify({ event: "s2_start", idd_id: "IDD-1", at: "2026-10-01T01:00:00+09:00", attrs: {} })}\n`);
  const column = readFileSync(columnFile(f.state), "utf8");
  const life = JSON.stringify(readLifecycle());

  const res = await door("GET", "/api/idd/intent")(get("op=check&lane=IDD-1"), {});
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.choices.length, 1);
  assert.equal(body.choices[0].mine, true);
  assert.equal(body.rounds.enteredImplementation, true);
  assert.equal(Array.isArray(body.findings), true);

  assert.equal(readFileSync(columnFile(f.state), "utf8"), column, "no check writes a row");
  assert.equal(JSON.stringify(readLifecycle()), life, "no check writes the lifecycle");
});

test("AC-010: the check without a lane folds for the outside and reports the whole state's defects", async () => {
  const f = setup();
  await door("POST", "/api/idd/intent")(post({ action: "raise_purpose", idd_id: "IDD-1", payload: { statement: "S", origin: "O" } }), {});
  const before = readFileSync(columnFile(f.state), "utf8");
  const res = await door("GET", "/api/idd/intent")(get("op=check&repo=me/app"), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  // the lane's proposal is not effective for the outside, so its Choice never appears to the outside
  assert.equal(body.ok, true);
  assert.deepEqual(body.choices, []);
  assert.equal(readFileSync(columnFile(f.state), "utf8"), before);
});

test("AC-022 / INV-099-7: the read door needs no token, resolves the repo from the lane, and writes nothing", async () => {
  const f = setup();
  await door("POST", "/api/idd/intent")(post({ action: "raise_purpose", idd_id: "IDD-1", payload: { statement: "S", origin: "O" } }), {});
  const confirm = await door("POST", "/api/idd/intent")(post({ action: "confirm_purpose", session: "s1", repo: "me/app", payload: { id: "P-2" } }), {});
  assert.equal(confirm.status, 200, JSON.stringify(await confirm.clone().json()));
  await door("POST", "/api/idd/intent")(post({
    action: "raise_choice", idd_id: "IDD-1",
    payload: { purpose: "P-2", forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "a/b/c.ts", kind: "file" }], why: "w", anchored: "x" },
  }), {});
  const before = readFileSync(columnFile(f.state), "utf8");

  const res = await door("GET", "/api/idd/intent")(get("op=lookup&lane=IDD-1&path=a/b/c.ts"), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.choices.length, 1);
  assert.equal(body.choices[0].id, "C-1-1");

  const records = await door("GET", "/api/idd/intent")(get("op=records&lane=IDD-1&kind=purposes"), {});
  assert.equal((await records.json()).purposes.length, 1);
  const shown = await door("GET", "/api/idd/intent")(get("op=show&lane=IDD-1&id=P-2"), {});
  assert.equal((await shown.json()).record.status, "active");

  assert.equal(readFileSync(columnFile(f.state), "utf8"), before, "no read writes a row");
  assert.equal((await door("GET", "/api/idd/intent")(get("op=records"), {})).status, 400);
});

test("AC-016 / AC-017: the door keeps a session's migration mark and a Purpose name, and refuses a lane's migration mark", async () => {
  const f = setup();
  await door("POST", "/api/idd/intent")(post({ action: "raise_purpose", session: "s1", repo: "me/app", payload: { statement: "S", origin: "O", id: "P-1", name: "名前" } }), {});
  const migration = { doc: "_docs/intent/demo/idd-001/decision.md", purpose_from: "人の見直し", source: "質問 Q-1", created: "2026-01-02" };
  const choice = { purpose: "P-1", id: "DEC-500", status: "unconfirmed", migration, forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "a/b/c.ts", kind: "file" }], why: "w", anchored: "x" };
  const bySession = await door("POST", "/api/idd/intent")(post({ action: "raise_choice", session: "s1", repo: "me/app", payload: choice }), {});
  assert.equal(bySession.status, 200, JSON.stringify(await bySession.clone().json()));

  const shown = await door("GET", "/api/idd/intent")(get("op=show&repo=me/app&id=DEC-500"), {});
  const rec = (await shown.json()).record;
  assert.deepEqual(rec.origin.migrated, migration);
  assert.equal(rec.history[0].at, "2026-01-02");

  const purposes = await door("GET", "/api/idd/intent")(get("op=records&repo=me/app&kind=purposes"), {});
  assert.equal((await purposes.json()).purposes[0].name, "名前");

  const byLane = await door("POST", "/api/idd/intent")(post({
    action: "raise_choice", idd_id: "IDD-1",
    payload: { ...choice, id: undefined, status: undefined },
  }), {});
  assert.equal(byLane.status, 400);
  assert.match(String((await byLane.json()).error), /移行の出どころ/);
});

test("AC-038 / AC-039 / AC-040 / INV-112-5: the risk op returns the declaration and the approved examples, and writes nothing", async () => {
  const f = setup();
  // a second repo with no declaration of its own
  writeFileSync(join(f.root, "repos.yaml"), JSON.stringify({
    repos: {
      "me/app": { name: "app", upstream: join(f.root, "u"), work: join(f.root, "w"), public_base: "main", risk_paths: { authz: ["lib/authz/"] } },
      "me/bare": { name: "bare", upstream: join(f.root, "u2"), work: join(f.root, "w2"), public_base: "main" },
    },
  }));

  const read = () => door("GET", "/api/idd/intent")(get("op=risk&repo=me/app"), {});
  // a repo with neither a declaration nor an example answers both empty
  const empty = await door("GET", "/api/idd/intent")(get("op=risk&repo=me/bare"), {});
  assert.deepEqual(await empty.json(), { ok: true, risk_paths: {}, harm_examples: [] });

  const columnText = () => { const file = columnFile(f.state); return file ? readFileSync(file, "utf8") : ""; };
  const column = columnText();
  const life = JSON.stringify(readLifecycle());
  // no example yet: the declaration comes back, the list is empty
  assert.deepEqual(await (await read()).json(), { ok: true, risk_paths: { authz: ["lib/authz/"] }, harm_examples: [] });

  const raised = await door("POST", "/api/idd/intent")(post({ action: "propose", session: "s1", repo: "me/app", payload: { kind: "harm_example", reason: "r", body: { statement: "戻せない", harm: 2 } } }), {});
  assert.equal(raised.status, 200, JSON.stringify(await raised.clone().json()));
  const approved = await approveProposal({ repo: "me/app", proposal: "PROP-1", approver: { session: "inbox" } });
  assert.equal(approved.ok, true, approved.error);

  const body = await (await read()).json();
  assert.deepEqual(body.risk_paths, { authz: ["lib/authz/"] });
  assert.equal(body.harm_examples.length, 1);
  assert.equal(body.harm_examples[0].statement, "戻せない");

  // the read door asks for no token and writes nothing
  const after = columnText();
  assert.equal(after.split("\n").filter(Boolean).length, column.split("\n").filter(Boolean).length + 2, "only the propose and the approval added rows");
  const lifeAfter = JSON.stringify(readLifecycle());
  await read();
  assert.equal(columnText(), after);
  assert.equal(JSON.stringify(readLifecycle()), lifeAfter);
  assert.equal(lifeAfter, life);
});

test("AC-012 / INV-112-3: no intent-door action changes the overview's statement or the harm examples", async () => {
  const f = setup();
  const columnText = () => { const file = columnFile(f.state); return file ? readFileSync(file, "utf8") : ""; };
  const before = columnText();
  // P-1 is the overview, raised and confirmed by the outside
  await door("POST", "/api/idd/intent")(post({ action: "raise_purpose", session: "s1", repo: "me/app", payload: { statement: "概要", origin: "O", id: "P-1" } }), {});
  await door("POST", "/api/idd/intent")(post({ action: "confirm_purpose", session: "s1", repo: "me/app", payload: { id: "P-1" } }), {});
  const proposals = [
    { action: "propose", idd_id: "IDD-1", payload: { kind: "overview", reason: "r", body: { statement: "新しい概要" } } },
    { action: "propose", idd_id: "IDD-1", payload: { kind: "harm_example", reason: "r", body: { statement: "戻せない", harm: 3 } } },
    { action: "propose", session: "s1", repo: "me/app", payload: { kind: "overview", reason: "r", body: { statement: "セッションの概要" } } },
    { action: "propose", session: "s1", repo: "me/app", payload: { kind: "harm_example", reason: "r", body: { statement: "これも", harm: 1 } } },
  ];
  for (const p of proposals) {
    const res = await door("POST", "/api/idd/intent")(post(p), {});
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  }
  const purposes = await (await door("GET", "/api/idd/intent")(get("op=records&repo=me/app&kind=purposes"), {})).json();
  assert.equal(purposes.purposes.find((p) => p.id === "P-1").statement, "概要");
  const risk = await (await door("GET", "/api/idd/intent")(get("op=risk&repo=me/app"), {})).json();
  assert.deepEqual(risk.harm_examples, []);
  assert.notEqual(columnText(), before);
});

test("AC-010: the projection op returns the drawn text with no token, folds for the caller, and writes nothing", async () => {
  const f = setup();
  await door("POST", "/api/idd/intent")(post({ action: "raise_purpose", session: "s1", repo: "me/app", payload: { statement: "S", origin: "O", name: "名前", id: "P-1" } }), {});
  await door("POST", "/api/idd/intent")(post({
    action: "raise_choice", idd_id: "IDD-1",
    payload: { purpose: "P-1", forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "a/b.ts", kind: "file" }], why: "w", anchored: "x" },
  }), {});
  const before = readFileSync(columnFile(f.state), "utf8");
  const life = JSON.stringify(readLifecycle());

  const res = await door("GET", "/api/idd/intent")(get("op=projection&lane=IDD-1"), {});
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.repo, "me/app");
  assert.equal(body.project, "app");
  assert.equal(body.dir, "_docs/intent/app/");
  assert.deepEqual(body.projections, ["A"]);
  const laneFiles = Object.fromEntries(body.files.map((x) => [x.name, x.content]));
  assert.ok(laneFiles["P-1.md"], "the lane's own file is drawn");
  assert.match(laneFiles["P-1.md"], /^## C-1-1: A$/m);
  assert.match(laneFiles["P-1.md"], /^- name: 名前$/m);
  assert.ok(laneFiles["overview.md"] && laneFiles["index.md"]);

  const outside = await door("GET", "/api/idd/intent")(get("op=projection&repo=me/app"), {});
  const outsideFiles = Object.fromEntries((await outside.json()).files.map((x) => [x.name, x.content]));
  assert.match(outsideFiles["P-1.md"], /^# P-1: S$/m);
  assert.doesNotMatch(outsideFiles["P-1.md"], /C-1-1/, "a lane's unmerged Choice is not in the outside's text");

  // a read op writes nothing and asks for no token
  assert.equal(readFileSync(columnFile(f.state), "utf8"), before);
  assert.equal(JSON.stringify(readLifecycle()), life);

  const unknown = await door("GET", "/api/idd/intent")(get("op=projection&repo=nope/nope"), {});
  assert.equal(unknown.status, 400);
});

test("AC-005 (project): the door writes a Project, attaches Issues, and the read ops answer with the candidate; a lane cannot close or record a close", async () => {
  const f = setup();
  const write = async (action, payload, who = { session: "s1", repo: "me/app" }) => {
    const res = await door("POST", "/api/idd/intent")(post({ action, ...who, payload }), {});
    return { status: res.status, body: await res.json() };
  };
  const purpose = await write("raise_purpose", { statement: "S", origin: "O", id: "P-1" });
  assert.equal(purpose.body.ok, true);
  const raised = await write("project_raise", { name: "まとまり", purpose: "P-1", done_when: "完了を一覧で確かめられる" });
  assert.deepEqual([raised.status, raised.body.id], [200, "PRJ-1"]);
  const attached = await write("project_attach", { id: "PRJ-1", issues: ["#234", "me/app#235"] });
  assert.deepEqual(attached.body.attached, ["me/app#234", "me/app#235"]);

  const read = async (query) => (await door("GET", "/api/idd/intent")(get(query), {})).json();
  const listed = await read("op=projects&repo=me/app");
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.projects.map((p) => [p.id, p.state, p.issues, p.completionCandidate]), [["PRJ-1", "planned", ["me/app#234", "me/app#235"], false]]);

  // the lane's outside records both closes: the Project reads as a candidate and its state does not move
  for (const issue of ["#234", "#235"]) assert.equal((await write("project_issue_state", { issue, closed: true })).status, 200);
  const candidate = await read("op=project&repo=me/app&id=PRJ-1");
  assert.equal(candidate.project.completionCandidate, true);
  assert.equal(candidate.project.state, "planned");

  // a lane neither records a close nor closes a Project, and a refused call leaves no row
  const rowsBefore = columnRows(f.state).length;
  const laneRecord = await write("project_issue_state", { issue: "#234", closed: false }, { idd_id: "IDD-1" });
  assert.equal(laneRecord.status, 400);
  const laneClose = await write("project_update", { id: "PRJ-1", patch: { state: "completed" } }, { idd_id: "IDD-1" });
  assert.equal(laneClose.status, 400);
  assert.match(laneClose.body.error, /lane の外/);
  assert.equal(columnRows(f.state).length, rowsBefore);
  assert.equal((await read("op=project&repo=me/app&id=PRJ-9")).ok, false);

  // the person's word closes it
  assert.equal((await write("project_update", { id: "PRJ-1", patch: { state: "completed" } })).status, 200);
  assert.equal((await read("op=projects&repo=me/app")).projects[0].completionCandidate, false);
});

test("AC-001 (project): the check op names a Project whose Purpose is not active, and the projection op draws the Project's file", async () => {
  const f = setup();
  const write = async (action, payload) => (await door("POST", "/api/idd/intent")(post({ action, session: "s1", repo: "me/app", payload }), {})).json();
  await write("raise_purpose", { statement: "S", origin: "O", id: "P-1" });
  await write("project_raise", { name: "まとまり", purpose: "P-1", done_when: "d" });
  await write("retire_purpose", { id: "P-1", grounds: "役目を終えた" });
  const checked = await (await door("GET", "/api/idd/intent")(get("op=check&repo=me/app"), {})).json();
  assert.deepEqual(checked.findings.filter((x) => x.rule === "project-purpose").map((x) => [x.weight, x.id]), [["error", "PRJ-1"]]);
  const drawn = await (await door("GET", "/api/idd/intent")(get("op=projection&repo=me/app"), {})).json();
  assert.ok(drawn.files.some((x) => x.name === "PRJ-1.md"));
  assert.equal(columnRows(f.state).length, 3, "the reads wrote nothing");
});
