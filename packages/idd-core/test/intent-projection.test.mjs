import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scratchDir } from "./helpers/scratch.mjs";
import * as store from "../src/intent/store.ts";
import { compareProjectionIds, INDEX_FILENAME, OVERVIEW_FILENAME, PROJECTION_MARK, projectRecords } from "../src/intent/projection.ts";
import { checkProjection } from "../src/intent/check.ts";
import { FREE_WHILE_WHY } from "../src/intent/records.ts";

let savedState;
beforeEach(() => { savedState = process.env.IDD_STATE_DIR; });
afterEach(() => {
  if (savedState === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = savedState;
});

const REPO = "me/app";

function setup() {
  const root = scratchDir("intent-projection-");

  const state = join(root, "state");
  mkdirSync(state);
  process.env.IDD_STATE_DIR = state;
  return { root, state };
}

/** the folded state, drawn: name -> content */
function draw(purposes, choices) {
  return Object.fromEntries(projectRecords({ purposes, choices }).map((f) => [f.name, f.content]));
}

const headings = (content) => content.split("\n").filter((l) => l.startsWith("## "));

const purpose = (over = {}) => ({
  id: "P-1", statement: "S", origin: "O", status: "active",
  raised: { by: { session: "s1" }, at: "2026-01-01T00:00:00.000Z" }, ...over,
});

const choice = (over = {}) => ({
  id: "C-a-1", purpose: "P-1",
  forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] },
  place: [{ path: "a/b.ts", kind: "file" }], why: "w", anchored: "x", free: FREE_WHILE_WHY,
  visibility: "private", status: "active", origin: { by: "agent" },
  history: [{ at: "2026-01-02T00:00:00.000Z", event: "created", by: { session: "s1" } }], waives: [],
  ...over,
});

// ---- AC-001: one file per Purpose, the Choice count matches ----

test("AC-001: a file per Purpose, the mark on the first line and the heading on the next", async () => {
  setup();
  const active = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, id: "P-1", statement: "活動中の目的", origin: "常設", name: "活動" });
  assert.equal(active.ok, true, active.error);
  const proposed = await store.raisePurpose({ repo: REPO, actor: { lane: "IDD-9" }, statement: "案の目的", origin: "lane" });
  assert.equal(proposed.status, "proposed");
  const retired = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, statement: "退いた目的", origin: "人の判断" });
  await store.retirePurpose({ repo: REPO, actor: { session: "s1" }, id: retired.id, grounds: "もう要らない" });
  const body = (chosen) => ({
    purpose: active.id,
    forms: { chosen, rejected: [{ form: "B", fails_because: "壊れる" }] },
    place: [{ path: "a/b.ts", kind: "file" }], why: "w", anchored: "x",
  });
  for (const chosen of ["C1", "C2", "C3", "C4", "C5"]) {
    const r = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: body(chosen) });
    assert.equal(r.ok, true, r.error);
  }
  const folded = store.listRecords({ repo: REPO, actor: { lane: "IDD-9" } });
  const files = projectRecords({ purposes: folded.purposes, choices: folded.choices });

  assert.equal(files.length, 3 + 2, "one file per Purpose, plus overview and index"); // 3 purposes + overview + index
  const names = files.map((f) => f.name).sort();
  assert.deepEqual(names, ["P-1.md", "P-2.md", "P-3.md", "index.md", "overview.md"]);
  for (const f of files) {
    assert.equal(f.content.split("\n")[0], PROJECTION_MARK, f.name);
    assert.equal(f.content.endsWith("\n"), true, f.name);
  }
  for (const p of folded.purposes) {
    const content = files.find((f) => f.name === `${p.id}.md`).content;
    assert.match(content, new RegExp(`^# ${p.id}: ${p.statement.split("\n")[0]}`, "m"));
    assert.match(content, new RegExp(`\\n- origin: ${p.origin}\\n`));
    assert.match(content, new RegExp(`\\n- status: ${p.status}\\n`));
    if (p.name) assert.match(content, new RegExp(`\\n- name: ${p.name}\\n`));
    else assert.doesNotMatch(content, /\n- name:/);
    const count = folded.choices.filter((c) => c.purpose === p.id).length;
    assert.equal(headings(content).length, count, p.id);
  }
  const retiredContent = files.find((f) => f.name === `${retired.id}.md`).content;
  assert.match(retiredContent, /\n- grounds: もう要らない\n/);
});

test("AC-001: an empty state draws nothing", () => {
  assert.deepEqual(projectRecords({ purposes: [], choices: [] }), []);
});

// ---- AC-002: the field order and what each field holds ----

test("AC-002: the fields come in the fixed order, with the migration source and the question on origin", () => {
  const full = choice({
    id: "DEC-500", status: "unconfirmed",
    forms: { chosen: "選んだ形", rejected: [{ form: "捨てた形", fails_because: "理由の1行目\n理由の2行目" }] },
    place: [
      { path: "a/b.ts", kind: "file", symbols: ["runTick", "Thing.x"] },
      { path: "a/", kind: "dir" },
      { path: "/", kind: "root" },
    ],
    why: "なぜ", anchored: "錨", free: "自由の幅", revisit: "見直す条件",
    origin: { by: "human", question: "Q-42", migrated: { doc: "_docs/intent/x/idd-001/decision.md", purpose_from: "人の見直し", source: "質問 Q-7" } },
    history: [
      { at: "2026-01-02", event: "created", by: { session: "s1" } },
      { at: "2026-01-03", event: "re-anchored", by: { session: "s1" } },
      { at: "2026-01-04", event: "confirmed", by: { session: "s1" } },
    ],
  });
  const content = draw([purpose()], [full])["P-1.md"];
  const section = content.slice(content.indexOf("\n## DEC-500"));
  const order = ["- Place:", "- Why:", "- Why not:", "- Anchored:", "- Free:", "- Revisit:", "- origin:", "- history:"];
  const positions = order.map((label) => section.indexOf(`\n${label}`));
  for (const [i, p] of positions.entries()) assert.ok(p >= 0, order[i]);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "the fields come in the fixed order");
  assert.match(content, /- Place:\n {2}- `a\/b\.ts` \(file, symbols: `runTick`, `Thing\.x`\)\n {2}- `a\/` \(dir\)\n {2}- `\/` \(root\)/);
  assert.match(content, /- Why not:\n {2}- 捨てた形: 理由の1行目\n {4}理由の2行目/);
  assert.match(content, /- Free: 自由の幅/);
  assert.match(content, /- Revisit: 見直す条件/);
  assert.match(content, /- origin: human（質問 Q-42）（移行: `_docs\/intent\/x\/idd-001\/decision\.md` \/ 人の見直し \/ Source: 質問 Q-7）（visibility: private）/);
  assert.match(content, /- history:\n {2}- 2026-01-02 created（session s1）\n {2}- 2026-01-03 re-anchored（session s1）\n {2}- 2026-01-04 confirmed（session s1）/);
  assert.match(content, /^## DEC-500: 選んだ形 \[unconfirmed\]$/m);
  assert.doesNotMatch(section, /\n- What:/);
});

test("AC-002: no rejected form shows the no-why-not reason, and no free shows the constant", () => {
  const waived = choice({
    id: "C-a-1", forms: { chosen: "A", rejected: [] }, waives: [{ reason: "捨てた形は無い", by: { session: "s1" }, at: "2026-01-02" }],
    free: undefined,
  });
  const content = draw([purpose()], [waived])["P-1.md"];
  assert.match(content, /- Why not: 捨てた形は無い/);
  assert.match(content, new RegExp(`- Free: ${FREE_WHILE_WHY}`));
  assert.doesNotMatch(content, /- Revisit:/);
});

// ---- AC-003 / INV-106-3: the status is in the heading ----

test("AC-003: only a non-active Choice carries its status in the heading", () => {
  const active = choice({ id: "C-a-1" });
  const unconfirmed = choice({ id: "C-a-2", status: "unconfirmed" });
  const superseded = choice({
    id: "C-a-3", status: "superseded",
    history: [
      { at: "2026-01-02", event: "created", by: { session: "s1" } },
      { at: "2026-01-05", event: "superseded", by: { session: "s1" }, grounds: "置き換えた理由", successor: "C-a-4" },
    ],
  });
  const dropped = choice({
    id: "C-a-4", status: "dropped",
    history: [
      { at: "2026-01-02", event: "created", by: { session: "s1" } },
      { at: "2026-01-06", event: "dropped", by: { session: "s1" }, grounds: "現物と違う" },
    ],
  });
  const content = draw([purpose()], [active, unconfirmed, superseded, dropped])["P-1.md"];
  assert.match(content, /^## C-a-1: A$/m);
  assert.match(content, /^## C-a-2: A \[unconfirmed\]$/m);
  assert.match(content, /^## C-a-3: A \[superseded → C-a-4\]$/m);
  assert.match(content, /^## C-a-4: A \[dropped\]$/m);
  assert.match(content, /- 2026-01-05 superseded（session s1） \/ 後継 C-a-4 \/ Grounds: 置き換えた理由/);
  assert.match(content, /- 2026-01-06 dropped（session s1） \/ Grounds: 現物と違う/);
});

// ---- AC-002: a replacement that points at a standing Choice draws the same way ----

test("AC-002: a Choice closed by pointing at a standing successor keeps its body and names the successor", async () => {
  setup();
  const purpose = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, id: "P-1", statement: "S", origin: "O" });
  assert.equal(purpose.ok, true, purpose.error);
  const body = (over) => ({
    purpose: purpose.id,
    forms: { chosen: "形", rejected: [{ form: "捨てた形", fails_because: "理由" }] },
    place: [{ path: "a/b.ts", kind: "file" }], why: "残る why", anchored: "残る anchored",
    ...over,
  });
  const successor = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: body({ why: "後継の why" }) });
  const old = await store.raiseChoice({ repo: REPO, actor: { session: "s1" }, body: body({}) });
  const done = await store.supersede({ repo: REPO, actor: { session: "s1" }, ids: [old.id], grounds: "R2 を外した", by: successor.id });
  assert.equal(done.ok, true, done.error);

  const rows = store.readRows(store.intentColumnPath(REPO));
  const folded = store.foldRows(rows, null, store.laneStates([]));
  const files = draw(folded.purposes, folded.choices);
  const content = files["P-1.md"];
  assert.match(content, new RegExp(`^## ${old.id}: 形 \\[superseded → ${successor.id}\\]$`, "m"));
  assert.match(content, /- Why: 残る why/);
  assert.match(content, /- Why not:\n  - 捨てた形: 理由/);
  assert.match(content, /- Anchored: 残る anchored/);
  assert.match(content, new RegExp(`superseded（.+?） / 後継 ${successor.id} / Grounds: R2 を外した`));
  // the successor keeps its own body, unchanged
  assert.match(content, new RegExp(`^## ${successor.id}: 形$`, "m"));
  assert.match(content, /- Why: 後継の why/);
  // the index lists only the live one
  const index = files[INDEX_FILENAME];
  assert.doesNotMatch(index, new RegExp(old.id));
  assert.match(index, new RegExp(`\\[${successor.id}\\]`));
});

// ---- AC-004: the non-active Choices go to the tail, in id order ----

test("AC-004: active and unconfirmed first, then superseded, then dropped, each by id", () => {
  const mk = (id, status, over = {}) => choice({ id, status, ...over });
  const state = [
    mk("DEC-10", "unconfirmed"),
    mk("C-099-1", "unconfirmed"),
    mk("DEC-9", "unconfirmed"),
    mk("DEC-088-2", "unconfirmed"),
    mk("C-z-1", "superseded", { history: [{ at: "2026-01-05", event: "superseded", by: { session: "s1" }, successor: "C-z-2" }] }),
    mk("C-y-1", "dropped", { history: [{ at: "2026-01-06", event: "dropped", by: { session: "s1" } }] }),
  ];
  const content = draw([purpose()], state)["P-1.md"];
  assert.deepEqual(
    headings(content).map((h) => h.slice(3).split(":")[0]),
    ["C-099-1", "DEC-9", "DEC-10", "DEC-088-2", "C-z-1", "C-y-1"],
  );
});

const filed = (fields) => draw([purpose({ origin: "lane", ...fields })], [])[`${fields.id}.md`];

test("AC-002 / AC-003: a rewritten proposal keeps the planner's sentence, and a withdrawn one shows its grounds", () => {
  const cases = [
    [{ id: "P-4", statement: "人の文", status: "proposed", raised_statement: "計画役の文" }, /\n- status: proposed\n- raised_statement: 計画役の文\n/],
    [{ id: "P-5", statement: "案", status: "withdrawn", grounds: "出典に無い" }, /\n- status: withdrawn\n- grounds: 出典に無い\n/],
  ];
  for (const [fields, heading] of cases) assert.match(filed(fields), heading);
  const retired = filed({ id: "P-6", statement: "退いた", origin: "人の判断", status: "retired", grounds: "もう要らない" });
  assert.match(retired, /\n- grounds: もう要らない\n/);
  assert.doesNotMatch(retired, /raised_statement/);
});

test("AC-002: a sentence put back to the planner's own is not repeated as raised_statement", () => {
  for (const raised of ["計画役の文", " 計画役の文\n"]) {
    assert.doesNotMatch(filed({ id: "P-4", statement: "計画役の文", status: "proposed", raised_statement: raised }), /raised_statement/);
  }
});

// ---- AC-005: overview ----

test("AC-005: overview holds the three sections, the summary escaped and the active Purposes listed", () => {
  const p1 = purpose({ id: "P-1", statement: "概要の文\n## 組まれ方", name: "概要", origin: "常設" });
  const p2 = purpose({ id: "P-2", statement: "別の目的", origin: "移行", status: "proposed" });
  const p3 = purpose({ id: "P-3", statement: "退いた目的", origin: "人の判断", status: "retired" });
  const rooted = choice({ id: "C-a-1", purpose: "P-1", place: [{ path: "/", kind: "root" }], why: "root の why", anchored: "root の錨" });
  const rootedUnconfirmed = choice({ id: "C-a-2", purpose: "P-1", status: "unconfirmed", place: [{ path: "/", kind: "root" }] });
  const away = choice({ id: "C-a-3", purpose: "P-1", place: [{ path: "a/", kind: "dir" }] });
  const gone = choice({ id: "C-a-4", purpose: "P-1", status: "dropped" });
  const content = draw([p1, p2, p3], [rooted, rootedUnconfirmed, away, gone])[OVERVIEW_FILENAME];

  const sections = content.split("\n## ").slice(1).map((s) => `## ${s}`);
  assert.equal(sections.length, 3);
  assert.match(sections[0], /^## 概要\n概要の文\n\\## 組まれ方\n$/);
  assert.equal(headings(content).length, 3, "only the three section headings start with `## `");
  assert.match(sections[1], /### C-a-1: A\n/);
  assert.match(sections[1], /- Why: root の why/);
  assert.match(sections[1], /- Anchored: root の錨/);
  assert.match(sections[1], /- Purpose: \[P-1\]\(P-1\.md\)/);
  assert.match(sections[1], /### C-a-2: A \[unconfirmed\]\n/);
  assert.doesNotMatch(sections[1], /C-a-3|C-a-4/, "only root Choices, and only the live ones");
  assert.match(sections[2], /^- \[P-1\]\(P-1\.md\) 概要: 概要の文 — origin: 常設 \/ 有効な Choice: 3 件$/m);
  assert.doesNotMatch(sections[2], /P-2|P-3/, "only active Purposes");
});

test("AC-005: without an active P-1 the summary says so", () => {
  const content = draw([purpose({ id: "P-2", statement: "別" })], [])[OVERVIEW_FILENAME];
  assert.match(content, /^## 概要\n概要の Purpose（P-1）がまだありません\n/m);
});

test("AC-002: a P-1 a person names on a column that held only a lane's proposal becomes the overview", async () => {
  setup();
  const lane = { repo: REPO, actor: { lane: "IDD-9" }, statement: "Issue 1 件の目的", origin: "lane" };
  assert.equal((await store.raisePurpose(lane)).id, "P-2");
  const overview = (actor) => {
    const folded = store.listRecords({ repo: REPO, actor });
    return draw(folded.purposes, folded.choices)[OVERVIEW_FILENAME];
  };
  assert.match(overview({ lane: "IDD-9" }), /^## 概要\n概要の Purpose（P-1）がまだありません\n/m);
  const named = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, id: "P-1", statement: "repo の概要", origin: "人" });
  assert.equal(named.ok, true, named.error);
  assert.match(overview(null), /^## 概要\nrepo の概要\n/m);
});

// ---- AC-006: index ----

test("AC-006: index draws valid Choices per Place, root first, dir not spread to files", () => {
  const file = choice({ id: "C-a-1", place: [{ path: "a/b.ts", kind: "file", symbols: ["runTick"] }] });
  const dir = choice({ id: "C-a-2", place: [{ path: "a/", kind: "dir" }] });
  const root = choice({ id: "C-a-3", place: [{ path: "/", kind: "root" }] });
  const both = choice({ id: "C-a-4", place: [{ path: "a/b.ts", kind: "file" }, { path: "a/", kind: "dir" }], status: "unconfirmed" });
  const gone = choice({ id: "C-a-5", purpose: "P-1", status: "superseded", place: [{ path: "a/b.ts", kind: "file" }] });
  const content = draw([purpose()], [file, dir, root, both, gone])[INDEX_FILENAME];

  assert.deepEqual(headings(content), ["## `/`", "## `a/`", "## `a/b.ts`"]);
  const rootSection = content.split("## `a/`")[0];
  assert.match(rootSection, /- \[C-a-3\]\(P-1\.md\): A/);
  const dirSection = content.split("## `a/`")[1].split("## `a/b.ts`")[0];
  assert.match(dirSection, /- \[C-a-2\]\(P-1\.md\): A\n/);
  assert.match(dirSection, /- \[C-a-4\]\(P-1\.md\): A \[unconfirmed\]/);
  const fileSection = content.split("## `a/b.ts`")[1];
  assert.match(fileSection, /- \[C-a-1\]\(P-1\.md\): A symbols: `runTick`/);
  assert.doesNotMatch(content, /C-a-5/, "superseded Choices stay out");
});

// ---- AC-007 / INV-106-1: determinism ----

test("AC-007: the same folded state draws the same bytes, whatever order the arrays came in", () => {
  const purposes = [purpose({ id: "P-2", statement: "2" }), purpose({ id: "P-1", statement: "1" }), purpose({ id: "P-10", statement: "10" })];
  const choices = [choice({ id: "C-b-1" }), choice({ id: "C-a-1" }), choice({ id: "C-a-2" })];
  const first = projectRecords({ purposes, choices });
  const second = projectRecords({ purposes: [...purposes].reverse(), choices: [...choices].reverse() });
  assert.deepEqual(first, second);
  for (const f of first) {
    assert.equal(f.content.endsWith("\n"), true, f.name);
    assert.equal(f.content.endsWith("\n\n"), false, f.name);
    assert.equal(f.content.includes("\r"), false, f.name);
  }
});

test("AC-007: an order that only leading zeros or a long digit run can tell apart stays distinct", () => {
  assert.notEqual(compareProjectionIds("P-01", "P-1"), 0);
  assert.notEqual(compareProjectionIds("DEC-007", "DEC-7"), 0);
  assert.notEqual(compareProjectionIds("DEC-9007199254740992", "DEC-9007199254740993"), 0);
  assert.ok(compareProjectionIds("DEC-9007199254740992", "DEC-9007199254740993") < 0, "a long run keeps its number order");
  assert.ok(compareProjectionIds("DEC-9", "DEC-10") < 0);
  assert.ok(compareProjectionIds("DEC-088-2", "DEC-10") > 0);
  assert.equal(compareProjectionIds("P-1", "P-1"), 0);

  const purposes = [purpose({ id: "P-1", statement: "one" }), purpose({ id: "P-01", statement: "zero one" })];
  const choices = [
    choice({ id: "DEC-9007199254740993", purpose: "P-1", status: "unconfirmed" }),
    choice({ id: "DEC-9007199254740992", purpose: "P-1", status: "unconfirmed" }),
  ];
  const forward = projectRecords({ purposes, choices });
  const backward = projectRecords({ purposes: [...purposes].reverse(), choices: [...choices].reverse() });
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward.map((f) => f.name), ["P-01.md", "P-1.md", "index.md", "overview.md"]);
  const content = forward.find((f) => f.name === "P-1.md").content;
  assert.deepEqual(
    headings(content).map((h) => h.slice(3).split(":")[0]),
    ["DEC-9007199254740992", "DEC-9007199254740993"],
  );
});

test("AC-007: the drawing carries no run date and no lane id of its own", () => {
  const state = [purpose()];
  const choices = [choice({ id: "C-a-1", origin: { by: "agent" }, history: [{ at: "2021-05-06T00:00:00.000Z", event: "created", by: { session: "s1" } }] })];
  const content = Object.values(draw(state, choices)).join("\n");
  assert.match(content, /2021-05-06/, "the state's own date is kept");
  assert.doesNotMatch(content, /IDD-999/);
  const today = new Date().toISOString().slice(0, 10);
  if (!"2021-05-06".includes(today)) assert.doesNotMatch(content, new RegExp(today));

  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/intent/projection.ts"), "utf8");
  assert.doesNotMatch(source, /node:fs/);
  assert.doesNotMatch(source, /\bDate\b/);
});

// ---- AC-008 / INV-106-4: free text makes no heading line ----

test("AC-008: a body line that looks like a heading is indented, and index.md only has a heading per path", () => {
  const p = purpose({ id: "P-1", statement: "1行目\n## 偽の Choice" });
  const c = choice({
    id: "C-a-1",
    forms: { chosen: "見出し\n## 偽の見出し", rejected: [{ form: "捨て", fails_because: "# 題\n- **Why**: 偽の欄" }] },
    why: "why の1行目\n## 偽の見出し",
    anchored: "# 題\n## 偽の見出し",
    place: [{ path: "a/b.ts", kind: "file" }],
  });
  const content = draw([p], [c])["P-1.md"];
  assert.equal(headings(content).length, 1);
  assert.match(content, /^# P-1: 1行目$/m);
  assert.match(content, /^## C-a-1: 見出し ## 偽の見出し$/m);
  assert.match(content, /\n {2}## 偽の見出し/);
  assert.match(content, /\n {2}## 偽の Choice/);
  // the original line is recoverable by dropping the indentation
  const lines = content.split("\n").map((l) => (l.startsWith("  ") ? l.slice(2) : l));
  assert.ok(lines.includes("## 偽の見出し"));
  assert.equal(content.split("\n").some((l) => l.startsWith("# 題") || l.startsWith("## 偽の見出し")), false);

  const index = draw([p], [c])[INDEX_FILENAME];
  assert.equal(headings(index).length, 1);
});

test("AC-008: a name, origin, Grounds or symbol with a heading stays on one line", () => {
  const p = purpose({ id: "P-1", name: "名\n## 偽", origin: "由来\n## 偽", status: "retired", grounds: "理由\n## 偽" });
  const c = choice({ place: [{ path: "a/b.ts", kind: "file", symbols: ["s\n## 偽"] }] });
  const content = draw([p], [c])["P-1.md"];
  assert.equal(headings(content).length, 1);
  assert.match(content, /^## C-a-1: A$/m);
  for (const label of ["name", "origin", "grounds"]) {
    const line = content.split("\n").find((l) => l.startsWith(`- ${label}: `));
    assert.ok(line && !line.includes("\n"), label);
    assert.match(line, /## 偽/);
  }
  assert.match(content, /symbols: `s ## 偽`/);
});

// ---- AC-009 / INV-106-6: the path is the id alone ----

test("AC-009: the file name is the id, whatever the name and origin are", () => {
  const named = purpose({ id: "P-1", name: "名前", origin: "常設" });
  const unnamed = purpose({ id: "P-2", statement: "S" });
  const inherited = purpose({ id: "P-3", origin: "継承（上流の推定）" });
  assert.deepEqual(Object.keys(draw([named, unnamed, inherited], [])).sort(), ["P-1.md", "P-2.md", "P-3.md", "index.md", "overview.md"]);

  // renaming a Purpose and re-drawing does not change the set of file names
  const renamed = { ...named, name: "別の名前", origin: "別の由来" };
  assert.deepEqual(Object.keys(draw([renamed, unnamed, inherited], [])).sort(), Object.keys(draw([named, unnamed, inherited], [])).sort());

  // two Purposes with the same name stay two files
  const sameA = purpose({ id: "P-4", name: "同じ" });
  const sameB = purpose({ id: "P-5", name: "同じ" });
  assert.deepEqual(Object.keys(draw([sameA, sameB], [])).sort(), ["P-4.md", "P-5.md", "index.md", "overview.md"]);
});

test("AC-001: a Choice whose Purpose is not in the state still gets a file", () => {
  const orphan = choice({ id: "C-a-1", purpose: "P-404" });
  const content = draw([], [orphan])["P-404.md"];
  assert.match(content, /^# P-404: Purpose が状態にありません$/m);
  assert.equal(headings(content).length, 1);
});

// ---- AC-017: the projection rules (core) ----

const ruleIds = (findings) => findings.map((f) => f.id).sort();

test("AC-017: a match is no finding, and each of the four defects is an error named by the file", () => {
  const file = { name: "P-1.md", content: `${PROJECTION_MARK}\n# P-1: S\n` };
  const list = (entries) => () => entries;
  const read = (content) => () => content;

  assert.deepEqual(checkProjection({ files: [file], list: list([{ name: "P-1.md", kind: "file" }]), read: read(file.content) }), []);

  const changed = checkProjection({ files: [file], list: list([{ name: "P-1.md", kind: "file" }]), read: read(`${PROJECTION_MARK}\n# P-1: edited\n`) });
  assert.deepEqual(ruleIds(changed), ["P-1.md"]);
  assert.equal(changed[0].weight, "error");
  assert.match(changed[0].reason, /写しが直されています/);
  assert.match(changed[0].reason, /idd intent draw/);

  const missing = checkProjection({ files: [file], list: list([]), read: read(null) });
  assert.deepEqual(ruleIds(missing), ["P-1.md"]);

  const extra = checkProjection({
    files: [file],
    list: list([{ name: "P-1.md", kind: "file" }, { name: "P-99.md", kind: "file" }]),
    read: (name) => (name === "P-99.md" ? `${PROJECTION_MARK}\nold\n` : file.content),
  });
  assert.deepEqual(ruleIds(extra), ["P-99.md"]);

  const unmarked = checkProjection({ files: [file], list: list([{ name: "P-1.md", kind: "file" }]), read: read("# 人が書いた\n") });
  assert.deepEqual(ruleIds(unmarked), ["P-1.md"]);
  assert.match(unmarked[0].reason, /写しでないファイル/);

  const symlink = checkProjection({ files: [file], list: list([{ name: "P-1.md", kind: "symlink" }]), read: read(null) });
  assert.deepEqual(ruleIds(symlink), ["P-1.md"]);
  assert.match(symlink[0].reason, /symlink/);

  // a file the drawing does not name, and that carries no mark, is not a defect
  const notes = checkProjection({
    files: [file],
    list: list([{ name: "P-1.md", kind: "file" }, { name: "notes.md", kind: "file" }]),
    read: (name) => (name === "notes.md" ? "人が書いたメモ\n" : file.content),
  });
  assert.deepEqual(notes, []);

  // a symlink on the way: one finding, and nothing is read
  const blocked = checkProjection({ files: [file], list: list([]), read: read(null), blocked: "_docs/intent が symlink です" });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].weight, "error");
  assert.equal(blocked[0].id, "");
  assert.match(blocked[0].reason, /idd intent draw/);
});

test("AC-041: an approved overview proposal is drawn with its new statement, and the same bytes come out twice", async () => {
  setup();
  const p = await store.raisePurpose({ repo: REPO, actor: { session: "s1" }, id: "P-1", statement: "古い概要", origin: "O" });
  assert.equal(p.id, "P-1");
  const r = await store.raiseProposal({ repo: REPO, actor: { session: "s1" }, kind: "overview", reason: "r", body: { statement: "新しい概要" } });
  assert.equal(r.ok, true, r.error);
  const a = await store.approveProposal({ repo: REPO, proposal: r.id, approver: { session: "inbox" } });
  assert.equal(a.ok, true, a.error);
  const folded = store.listRecords({ repo: REPO, actor: null });
  const first = draw(folded.purposes, folded.choices);
  const second = draw(folded.purposes, folded.choices);
  assert.deepEqual(first, second, "the drawing is a function of the state alone");
  assert.match(first[OVERVIEW_FILENAME], /^## 概要\n新しい概要$/m);
  assert.doesNotMatch(first[OVERVIEW_FILENAME], /古い概要/);
});
