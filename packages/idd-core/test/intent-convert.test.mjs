import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./helpers/scratch.mjs";
import * as store from "../src/intent/store.ts";
import { parseDecisionDoc } from "../src/intent/decisions.ts";
import { pendingOps, planConversion, readLegacyRecords } from "../src/intent/convert.ts";

let savedState;
beforeEach(() => { savedState = process.env.IDD_STATE_DIR; });
afterEach(() => {
  if (savedState === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = savedState;
});

const BT = "`";
const REPO = "me/app";

function setupState() {
  const root = scratchDir("intent-convert-state-");
  const state = join(root, "state");
  mkdirSync(state);
  process.env.IDD_STATE_DIR = state;
  return state;
}

// ---- fixtures ----

function docText(decs, { created = "2026-01-02", invs = [] } = {}) {
  return ["---", `created_at: ${created}`, "---", "", "# 記録", "", "## Decisions", "", ...decs, ...invs, ""].join("\n");
}
const decSec = (id, title, fields) => [`### ${id}: ${title}`, "", ...fields, ""].join("\n");
const field = (name, ...lines) => [`- **${name}**: ${lines[0] ?? ""}`, ...lines.slice(1)].join("\n");

function docsRoot(decs, opts) {
  const root = scratchDir("intent-convert-doc-");
  mkdirSync(join(root, "_docs/intent/demo/idd-001"), { recursive: true });
  writeFileSync(join(root, "_docs/intent/demo/idd-001/decision.md"), docText(decs, opts));
  return root;
}

const purposesOf = (...entries) => entries;

function plan(root, records, { purposes = [{ id: "P-1", name: "名", statement: "S", origin: "O" }], assignment = {}, review, isDir } = {}) {
  return planConversion({ records, purposes, assignment, ...(review ? { review } : {}), ...(isDir ? { isDir } : {}) });
}

function choiceOps(p) {
  return p.ops.filter((o) => o.type === "raise_choice" || o.type === "supersede");
}

// ---- AC-001: the field mapping ----

test("AC-001: each DEC field lands in its Choice field, ids kept, multi-line bodies intact", () => {
  const dec10 = decSec("DEC-10", "題", [
    field("What", "方針"),
    field("Why", "理由", "  続きの行はそのまま"),
    field("Why not", "理由A").replace("- **Why not**", "- **Why not**（案A）"),
    field("Change freedom", "自由"),
    field("Revisit when", "あとで"),
    field("Source", "質問 Q-1"),
    field("Anchors", `${BT}a/b/c.ts${BT}`),
  ]);
  const dec11 = decSec("DEC-11", "題2", [field("What", "W2"), field("Why", "Y2"), field("Anchors", `${BT}d.ts${BT}`)]);
  const root = docsRoot([dec10, dec11]);
  const records = readLegacyRecords({ root });
  const p = plan(root, records, { assignment: { "DEC-10": "P-1", "DEC-11": "P-1" } });

  const [raise10, raise11] = choiceOps(p);
  assert.equal(raise10.id, "DEC-10");
  assert.equal(raise10.body.purpose, "P-1");
  assert.equal(raise10.body.forms.chosen, "題");
  assert.deepEqual(raise10.body.forms.rejected, [{ form: "案A", fails_because: "理由A" }]);
  assert.equal(raise10.body.why, "理由\n  続きの行はそのまま");
  assert.equal(raise10.body.free, "自由");
  assert.equal(raise10.body.revisit, "あとで");
  assert.equal(raise10.body.visibility, "private");
  assert.equal(raise10.body.status, "unconfirmed");
  assert.deepEqual(raise10.body.migration, { doc: "_docs/intent/demo/idd-001/decision.md", purpose_from: "移行時の割り当て", source: "質問 Q-1", created: "2026-01-02" });
  // the module is what the Place names, and the file it was read from rides along as its mark
  assert.deepEqual(raise10.body.place, [{ path: "a/b/", kind: "module", file: "a/b/c.ts" }]);

  assert.equal(raise11.body.forms.chosen, "題2");
  assert.equal(raise11.body.free, undefined, "a DEC without Change freedom carries no free");
  assert.equal(p.report.no_why_not, 1);
  assert.equal(p.report.choices.unconfirmed, 2);
  assert.equal(p.blocked, false, JSON.stringify(p.blockers));
});

// ---- AC-002: anchored ----

test("AC-002 / INV-100-3: anchored carries What, extra fields and INVs with headings, and every field body survives", () => {
  const dec20 = decSec("DEC-20", "題", [
    field("What", "W"),
    field("Why", "Y"),
    field("Why（題）", "WY"),
    field("更新", "U"),
    field("補足（補足の題）", "H"),
    field("Anchors", `${BT}a.ts${BT}`),
  ]);
  const root = docsRoot([dec20], { invs: ["- INV-2 (from DEC-20): 不変2", "- INV-1 (from DEC-20): 不変1"] });
  const records = readLegacyRecords({ root });
  assert.deepEqual(records.decs[0].invs.map((i) => i.id), ["INV-2", "INV-1"]);
  const p = plan(root, records, { assignment: { "DEC-20": "P-1" } });
  const body = choiceOps(p)[0].body;

  assert.equal(body.anchored, ["What: W", "更新: U", "補足（補足の題）: H", "INV-2: 不変2", "INV-1: 不変1"].join("\n\n"));
  assert.equal(body.why, ["Y", "Why（題）: WY"].join("\n\n"));
  assert.equal(body.anchored.includes("Why（題）"), false, "a Why-prefixed field goes to why, not anchored");

  const fields = ["W", "Y", "WY", "U", "H", "不変2", "不変1"];
  const all = `${body.why}\n${body.anchored}\n${body.forms.chosen}`;
  for (const text of fields) assert.ok(all.includes(text), text);

  const noInv = readLegacyRecords({ root: docsRoot([decSec("DEC-21", "題", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)])]) });
  const body2 = choiceOps(plan(root, noInv, { assignment: { "DEC-21": "P-1" } }))[0].body;
  assert.equal(body2.anchored, "What: W");
  assert.equal(p.report.invs_folded, 2);
});

// ---- AC-003: Why not ----

test("AC-003: Why not becomes a rejected form, a parenless one its first sentence, and an absent one a reason", () => {
  const withTwo = decSec("DEC-30", "題", [
    field("What", "W"),
    field("Why", "Y"),
    field("Why not", "括弧なしの理由。続きは形に入らない"),
    field("Why not", "理由B").replace("- **Why not**", "- **Why not**（形B）"),
    field("Anchors", `${BT}a.ts${BT}`),
  ]);
  const root = docsRoot([withTwo]);
  const records = readLegacyRecords({ root });
  const p = plan(root, records, { assignment: { "DEC-30": "P-1" } });
  const body = choiceOps(p)[0].body;
  assert.deepEqual(body.forms.rejected, [
    { form: "括弧なしの理由。", fails_because: "括弧なしの理由。続きは形に入らない" },
    { form: "形B", fails_because: "理由B" },
  ]);
  assert.equal(body.no_why_not, undefined);
  assert.equal(p.report.no_why_not, 0);

  const without = decSec("DEC-31", "題", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]);
  const p2 = plan(root, readLegacyRecords({ root: docsRoot([without]) }), { assignment: { "DEC-31": "P-1" } });
  const body2 = choiceOps(p2)[0].body;
  assert.deepEqual(body2.forms.rejected, []);
  assert.equal(body2.no_why_not, "移行: 元の DEC に Why not の欄が無い");
  assert.equal(p2.report.no_why_not, 1);
});

// ---- F-1: a Why not whose form holds nested parentheses ----

test("F-1: a nested parenthetical in a field name is read as one field, and its form comes out whole", () => {
  const dec = decSec("DEC-791", "題", [
    field("What", "W"),
    field("Why", "Y"),
    field("Why not", "一覧を広げると定時の条件まで変わる。"),
    field("Why not", "増分だけを見ると CI とずれる。").replace("- **Why not**", "- **Why not**（一覧を提出の増分（publish）にする）"),
    field("Anchors", `${BT}a.ts${BT}`),
  ]);
  const root = docsRoot([dec]);
  const records = readLegacyRecords({ root });
  assert.deepEqual(records.decs[0].whyNots.map((f) => f.name), [
    "Why not",
    "Why not（一覧を提出の増分（publish）にする）",
  ]);
  const body = choiceOps(plan(root, records, { assignment: { "DEC-791": "P-1" } }))[0].body;
  assert.deepEqual(body.forms.rejected, [
    { form: "一覧を広げると定時の条件まで変わる。", fails_because: "一覧を広げると定時の条件まで変わる。" },
    { form: "一覧を提出の増分（publish）にする", fails_because: "増分だけを見ると CI とずれる。" },
  ]);
  assert.equal(body.why, "Y", "the nested line does not fold into the field above it");
});

// ---- AC-004: Place, the same reading as the index ----

test("AC-004 / DEC-100-9: the Places read like the index, with symbols, and a directory keeps its slash", () => {
  const dec = decSec("DEC-40", "題", [
    field("What", "W"),
    field("Why", "Y"),
    field("Anchors", `${BT}packages/a/b.ts${BT}（${BT}runTick${BT}・${BT}AppTheme.primary${BT}）、${BT}dir/${BT}、${BT}src/**/*.ts${BT}、${BT}x/y.ts#L1${BT}、${BT}lib/foo.ts${BT}`),
  ]);
  const root = docsRoot([dec]);
  const text = readFileSync(join(root, "_docs/intent/demo/idd-001/decision.md"), "utf8");
  const indexPlaces = parseDecisionDoc("_docs/intent/demo/idd-001/decision.md", text, root)[0].places;

  const records = readLegacyRecords({ root });
  const p = plan(root, records, { assignment: { "DEC-40": "P-1" } });
  const places = choiceOps(p)[0].body.place;
  // each read path names its module, and the file the Anchors read keeps as the mark
  const modules = [...new Set(indexPlaces.map((path) => (path.endsWith("/") ? path : path.slice(0, path.lastIndexOf("/") + 1))))];
  assert.deepEqual(new Set(places.map((x) => x.path)), new Set(modules));
  const byFile = new Map(places.filter((x) => x.file).map((x) => [x.file, x]));
  assert.deepEqual(byFile.get("packages/a/b.ts")?.symbols, ["runTick", "AppTheme.primary"]);
  assert.equal(byFile.get("packages/a/b.ts")?.kind, "module");
  assert.equal(byFile.get("x/y.ts")?.path, "x/");
  assert.ok(byFile.has("lib/foo.ts"));
  // a dir named by the Anchors has no file to mark
  assert.ok(places.some((x) => x.kind === "module" && x.path === "dir/" && !x.file));

  // a path the tree knows as a directory becomes that dir's own module, with no file mark
  const p2 = plan(root, records, { assignment: { "DEC-40": "P-1" }, isDir: (path) => path === "lib/foo.ts" });
  const lib = choiceOps(p2)[0].body.place.find((x) => x.path === "lib/foo.ts/");
  assert.equal(lib?.kind, "module");
  assert.equal(lib?.file, undefined);
});

// ---- AC-005: broken Anchors and root ----

test("AC-005 / DEC-100-9: broken Anchors are repaired first, and only then does a DEC fall to root", () => {
  const mk = (id, anchors) => decSec(id, "題", [field("What", "W"), field("Why", "Y"), ...(anchors === null ? [] : [field("Anchors", anchors)])]);
  const root = docsRoot([
    mk("DEC-50", "a/b.ts、c/d.ts"),
    mk("DEC-51", "e/f.ts・g/h.ts"),
    mk("DEC-52", "a/b.ts:10-20"),
    mk("DEC-53", "これは散文です"),
    mk("DEC-54", "None（理由）"),
    mk("DEC-55", null),
  ]);
  const records = readLegacyRecords({ root });
  const p = plan(root, records, { assignment: Object.fromEntries(["DEC-50", "DEC-51", "DEC-52", "DEC-53", "DEC-54", "DEC-55"].map((id) => [id, "P-1"])) });
  const byId = new Map(choiceOps(p).map((o) => [o.id, o.body.place]));

  assert.deepEqual(byId.get("DEC-50").map((x) => [x.path, x.file]), [["a/", "a/b.ts"], ["c/", "c/d.ts"]]);
  assert.deepEqual(byId.get("DEC-51").map((x) => [x.path, x.file]), [["e/", "e/f.ts"], ["g/", "g/h.ts"]]);
  assert.deepEqual(byId.get("DEC-52").map((x) => [x.path, x.file]), [["a/", "a/b.ts"]]);
  for (const id of ["DEC-53", "DEC-54", "DEC-55"]) assert.deepEqual(byId.get(id), [{ path: "/", kind: "root" }], id);

  assert.deepEqual(p.report.anchors_fixed, ["DEC-50", "DEC-51", "DEC-52"]);
  assert.deepEqual(p.report.anchors_unreadable, ["DEC-53", "DEC-55"]);
  assert.deepEqual(p.report.anchors_none, ["DEC-54"]);
});

// ---- AC-006: parentless INV ----

test("AC-006: a parentless INV becomes a root, unconfirmed Choice, and one without an assignment blocks", () => {
  const dec = decSec("DEC-60", "題", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]);
  const root = docsRoot([dec], { invs: ["- INV-1 (from DEC-60): 親あり", "- INV-2 (from DEC-999): 親なし", "- INV-3: 括弧なし"] });
  const records = readLegacyRecords({ root });
  assert.deepEqual(records.orphanInvs.map((i) => i.id), ["INV-2", "INV-3"]);

  const p = plan(root, records, { assignment: { "DEC-60": "P-1", "INV-2": "P-1", "INV-3": "P-1" } });
  const orphans = choiceOps(p).filter((o) => o.id.startsWith("INV-"));
  assert.deepEqual(orphans.map((o) => o.id), ["INV-2", "INV-3"]);
  for (const op of orphans) {
    assert.deepEqual(op.body.place, [{ path: "/", kind: "root" }]);
    assert.equal(op.body.status, "unconfirmed");
    assert.equal(op.body.purpose, "P-1");
    assert.equal(op.body.forms.chosen, op.body.anchored);
  }
  assert.equal(choiceOps(p).some((o) => o.id === "INV-1"), false, "a parented INV is folded, not raised on its own");
  assert.equal(p.report.invs_orphan, 2);

  const missing = plan(root, records, { assignment: { "DEC-60": "P-1", "INV-2": "P-1" } });
  assert.equal(missing.blocked, true);
  assert.deepEqual(missing.blockers.find((b) => b.reason === "missing_assignment").ids, ["INV-3"]);
});

// ---- AC-007: Purpose list ----

test("AC-007: the Purpose raises come in numeric id order, and a bad entry blocks the run", () => {
  const dec = decSec("DEC-70", "題", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]);
  const root = docsRoot([dec]);
  const records = readLegacyRecords({ root });
  const purposes = purposesOf(
    { id: "P-10", name: "十", statement: "S10", origin: "O" },
    { id: "P-2", name: "二", statement: "S2", origin: "O" },
    { id: "P-1", name: "一", statement: "S1", origin: "O" },
  );
  const p = plan(root, records, { purposes, assignment: { "DEC-70": "P-2" } });
  assert.deepEqual(p.ops.filter((o) => o.type === "raise_purpose").map((o) => o.id), ["P-1", "P-2", "P-10"]);
  assert.deepEqual(p.ops[0], { type: "raise_purpose", id: "P-1", name: "一", statement: "S1", origin: "O" });
  assert.equal(p.report.purposes, 3);

  const bad = plan(root, records, {
    purposes: purposesOf({ id: "P-1", name: "一", statement: "S1", origin: "O" }, { id: "P-1", name: "重", statement: "S", origin: "O" }, { id: "P-x", name: "形", statement: "S", origin: "O" }, { id: "P-3", name: "欠", statement: "S" }),
    assignment: { "DEC-70": "P-1" },
  });
  assert.equal(bad.blocked, true);
  const ids = bad.blockers.flatMap((b) => b.ids);
  assert.ok(ids.includes("P-x"));
  assert.ok(ids.includes("P-3"));
  assert.ok(ids.includes("P-1"), "a duplicated P-1 is reported");
});

// ---- AC-008: blockers ----

test("AC-008 / INV-100-1: an unsettled record blocks the run but the other records' ops are still built", () => {
  const mk = (id) => decSec(id, "題", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]);
  const root = docsRoot([mk("DEC-80"), mk("DEC-81"), mk("DEC-82"), mk("DEC-83")]);
  const records = readLegacyRecords({ root });

  const missing = plan(root, records, { assignment: { "DEC-80": "P-1" } });
  assert.equal(missing.blocked, true);
  assert.deepEqual(missing.blockers.find((b) => b.reason === "missing_assignment").ids, ["DEC-81", "DEC-82", "DEC-83"]);
  assert.equal(choiceOps(missing).some((o) => o.id === "DEC-80"), true, "the assigned DEC still gets an op");
  assert.equal(choiceOps(missing).filter((o) => o.id !== "DEC-80").length, 0);

  const unknown = plan(root, records, { assignment: { "DEC-80": "P-1", "DEC-81": "P-404", "DEC-82": "P-1", "DEC-83": "P-1" } });
  assert.deepEqual(unknown.blockers.find((b) => b.reason === "unknown_purpose").ids, ["DEC-81"]);

  const dup = docsRoot([mk("DEC-84"), mk("DEC-84")]);
  const dupPlan = plan(dup, readLegacyRecords({ root: dup }), { assignment: { "DEC-84": "P-1" } });
  assert.deepEqual(dupPlan.blockers.find((b) => b.reason === "duplicate_id").ids, ["DEC-84"]);
  assert.equal(dupPlan.report.decs, 2);
});

test("AC-008 / DEC-100-1: a Purpose the state holds differently, or holds not active, blocks the run", () => {
  const mk = (id) => decSec(id, "題", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]);
  const root = docsRoot([mk("DEC-85")]);
  const records = readLegacyRecords({ root });
  const p = plan(root, records, { assignment: { "DEC-85": "P-1" } });

  const otherStatement = pendingOps({ plan: p, state: { purposes: [{ id: "P-1", statement: "別の目的", origin: "O", status: "active" }], choices: [] } });
  assert.equal(otherStatement.blocked, true);
  assert.ok(otherStatement.blockers.some((b) => b.reason === "state_purpose_conflict" && b.ids.includes("P-1")));

  const retired = { purposes: [{ id: "P-1", statement: "S", origin: "O", status: "retired" }], choices: [] };
  assert.equal(pendingOps({ plan: p, state: retired }).blocked, true);
  const proposed = { purposes: [{ id: "P-1", statement: "S", origin: "O", status: "proposed" }], choices: [] };
  assert.equal(pendingOps({ plan: p, state: proposed }).blocked, true);
});

// ---- AC-009: status from the review ----

test("AC-009 / DEC-100-8: only a reviewed DEC is active or dropped", () => {
  const mk = (id) => decSec(id, "題", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]);
  const root = docsRoot([mk("DEC-90"), mk("DEC-91"), mk("DEC-92"), mk("DEC-93"), mk("DEC-94")]);
  const records = readLegacyRecords({ root });
  const p = plan(root, records, {
    assignment: { "DEC-90": "P-1", "DEC-91": "P-1", "DEC-92": "P-1", "DEC-93": "P-1", "DEC-94": "P-1" },
    review: {
      "DEC-90": { alive: "alive", purpose: "P-1", rejected: { mode: "keep" } },
      "DEC-91": { alive: "alive", purpose: "__undecided__", rejected: { mode: "none" } },
      "DEC-92": { alive: "dead", purpose: "P-1", rejected: { mode: "keep", note: "現物と違う" } },
      "DEC-94": { alive: "alive", purpose: "P-1", rejected: { mode: "keep", note: "" } },
    },
  });
  const byId = new Map(choiceOps(p).map((o) => [o.id, o]));
  assert.equal(byId.get("DEC-90").body.status, "active");
  assert.equal(byId.get("DEC-90").body.migration.purpose_from, "人の見直し");
  assert.equal(byId.get("DEC-91").body.status, "unconfirmed");
  assert.equal(byId.get("DEC-91").body.purpose, "P-1");
  assert.equal(byId.get("DEC-92").body.status, "unconfirmed");
  assert.equal(byId.get("DEC-93").body.status, "unconfirmed");
  assert.equal(byId.get("DEC-93").body.migration.purpose_from, "移行時の割り当て");
  assert.equal(byId.get("DEC-94").body.status, "active");

  const drops = p.ops.filter((o) => o.type === "drop_choice");
  assert.deepEqual(drops.map((o) => o.id), ["DEC-92"]);
  assert.match(drops[0].grounds, /死んでいる/);
  assert.match(drops[0].grounds, /現物と違う/);
  assert.deepEqual(p.report.choices, { unconfirmed: 2, active: 2, dropped: 1 });

  const bad = plan(root, records, { assignment: { "DEC-93": "P-1" }, review: { "DEC-93": { alive: "superseded-missing", purpose: "P-1", rejected: { mode: "keep" } } } });
  assert.ok(bad.blockers.some((b) => b.reason === "unknown_review_value" && b.ids.includes("DEC-93")));
  const badMode = plan(root, records, { assignment: { "DEC-93": "P-1" }, review: { "DEC-93": { alive: "alive", purpose: "P-1", rejected: { mode: "add" } } } });
  assert.ok(badMode.blockers.some((b) => b.reason === "unknown_review_value" && b.ids.includes("DEC-93")));
});

// ---- AC-010 / AC-011: supersede ----

test("AC-010 / DEC-100-6: the replaced DEC is raised before its successor, which carries the supersede", () => {
  const mk = (id, sup) => decSec(id, "題", [field("What", "W"), field("Why", "Y"), ...(sup ? [field("Superseded by", sup)] : []), field("Anchors", `${BT}a.ts${BT}`)]);
  const root = docsRoot([mk("DEC-1001", "DEC-1002"), mk("DEC-1002", "DEC-1003"), mk("DEC-1003", null)]);
  const records = readLegacyRecords({ root });
  const p = plan(root, records, { assignment: { "DEC-1001": "P-1", "DEC-1002": "P-1", "DEC-1003": "P-1" } });
  const ids = p.ops.filter((o) => o.type === "raise_choice" || o.type === "supersede").map((o) => o.id);
  assert.deepEqual(ids, ["DEC-1001", "DEC-1002", "DEC-1003"]);
  const b = p.ops.find((o) => o.id === "DEC-1002");
  assert.equal(b.type, "supersede");
  assert.deepEqual(b.ids, ["DEC-1001"]);
  assert.ok(b.grounds.length > 0);
  const c = p.ops.find((o) => o.id === "DEC-1003");
  assert.equal(c.type, "supersede");
  assert.deepEqual(c.ids, ["DEC-1002"]);
  assert.deepEqual(p.report.superseded, [{ successor: "DEC-1002", ids: ["DEC-1001"] }, { successor: "DEC-1003", ids: ["DEC-1002"] }]);
});

test("AC-011 / INV-100-5: a successor no document holds is reported, and a cycle is broken and reported", () => {
  const mk = (id, sup) => decSec(id, "題", [field("What", "W"), field("Why", "Y"), ...(sup === null ? [] : [field("Superseded by", sup)]), field("Anchors", `${BT}a.ts${BT}`)]);
  const root = docsRoot([mk("DEC-2001", "DEC-999"), mk("DEC-2002", "散文だけ"), mk("DEC-2003", "DEC-2004、DEC-2005"), mk("DEC-2004", null), mk("DEC-2005", null)]);
  const records = readLegacyRecords({ root });
  const p = plan(root, records, { assignment: Object.fromEntries(["DEC-2001", "DEC-2002", "DEC-2003", "DEC-2004", "DEC-2005"].map((id) => [id, "P-1"])) });
  assert.equal(p.ops.find((o) => o.id === "DEC-2001").type, "raise_choice");
  assert.equal(p.ops.find((o) => o.id === "DEC-2002").type, "raise_choice");
  assert.deepEqual(p.report.successor_missing.sort(), ["DEC-2001", "DEC-2002"]);
  assert.equal(p.ops.find((o) => o.id === "DEC-2003").type, "raise_choice");
  assert.equal(p.ops.find((o) => o.id === "DEC-2004").type, "supersede");
  assert.deepEqual(p.ops.find((o) => o.id === "DEC-2004").ids, ["DEC-2003"]);
  assert.deepEqual(p.report.successor_extra, ["DEC-2005"]);

  const cycle = docsRoot([mk("DEC-3001", "DEC-3002"), mk("DEC-3002", "DEC-3001")]);
  const cp = plan(cycle, readLegacyRecords({ root: cycle }), { assignment: { "DEC-3001": "P-1", "DEC-3002": "P-1" } });
  assert.equal(cp.blocked, false);
  assert.equal(cp.ops.filter((o) => o.id === "DEC-3001" || o.id === "DEC-3002").length, 2);
  assert.equal(cp.report.cycles.length, 1);
});

// ---- the supersedes the state has already settled (AC-001..AC-004, AC-006) ----

async function stateWith(seedDocs, assignment, opts) {
  setupState();
  const seed = docsRoot(seedDocs);
  const p = plan(seed, readLegacyRecords({ root: seed }), { assignment, ...(opts ?? {}) });
  await runOps(REPO, p.ops);
  return stateOf(REPO);
}

test("AC-001 / AC-004 / C-131-1: a supersede the state has already settled is left off, and the successor stands", async () => {
  const state = await stateWith(
    [
      decSec("DEC-5101", "A", [field("What", "W"), field("Why", "Y"), field("Superseded by", "DEC-5102"), field("Anchors", `${BT}a.ts${BT}`)]),
      decSec("DEC-5102", "B", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}b.ts${BT}`)]),
      decSec("DEC-5104", "D", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}d.ts${BT}`)]),
    ],
    { "DEC-5101": "P-1", "DEC-5102": "P-1", "DEC-5104": "P-1" },
  );
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-5101" }).record.status, "superseded");

  // the document names new successors for the already-superseded DEC-5101 and the still-open DEC-5104
  const root = docsRoot([
    decSec("DEC-5101", "A", [field("What", "W"), field("Why", "Y"), field("Superseded by", "DEC-5103"), field("Anchors", `${BT}a.ts${BT}`)]),
    decSec("DEC-5103", "C", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}c.ts${BT}`)]),
    decSec("DEC-5104", "D", [field("What", "W"), field("Why", "Y"), field("Superseded by", "DEC-5105"), field("Anchors", `${BT}d.ts${BT}`)]),
    decSec("DEC-5105", "E", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}e.ts${BT}`)]),
  ]);
  const p = plan(root, readLegacyRecords({ root }), {
    assignment: { "DEC-5101": "P-1", "DEC-5103": "P-1", "DEC-5104": "P-1", "DEC-5105": "P-1" },
    review: { "DEC-5103": { alive: "alive", purpose: "P-1", rejected: { mode: "keep" } } },
  });
  const pending = pendingOps({ plan: p, state });

  const successor3 = pending.ops.find((o) => o.id === "DEC-5103");
  assert.equal(successor3.type, "raise_choice", "the successor stands without the settled replacement");
  assert.equal(successor3.body.status, "active", "the document's successor keeps the review's own status");
  const successor5 = pending.ops.find((o) => o.id === "DEC-5105");
  assert.equal(successor5.type, "supersede", "a still-open replaced Choice keeps its replacement");
  assert.deepEqual(successor5.ids, ["DEC-5104"]);
  assert.equal(successor5.body.status, "unconfirmed", "an unreviewed successor stands unconfirmed");
  assert.deepEqual(pending.superseded, [{ successor: "DEC-5105", ids: ["DEC-5104"] }], "only the sent replacement is reported");
  assert.deepEqual(pending.supersede_skipped, [
    { id: "DEC-5101", status: "superseded", state_successor: "DEC-5102", document_successor: "DEC-5103" },
  ], "both ids are readable: the state's successor and the document's successor");

  // sent through the store, every call succeeds; DEC-5101 keeps the successor the state gave it
  await runOps(REPO, pending.ops);
  const old = store.showRecord({ repo: REPO, actor: null, id: "DEC-5101" }).record;
  assert.equal(old.status, "superseded");
  assert.equal(old.history.at(-1).successor, "DEC-5102");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-5103" }).record.status, "active");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-5104" }).record.status, "superseded");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-5104" }).record.history.at(-1).successor, "DEC-5105");

  // a rerun after the skipped run sends no call and adds no row (AC-006)
  const mid = columnText(REPO);
  const rerun = pendingOps({ plan: p, state: stateOf(REPO) });
  assert.deepEqual(rerun.ops, []);
  assert.deepEqual(rerun.superseded, []);
  assert.equal(rerun.blocked, false);
  await runOps(REPO, rerun.ops);
  assert.equal(columnText(REPO), mid, "the rerun adds no row");
});

test("AC-002 / C-131-1: a supersede whose replaced Choice is dropped in the state is left off and reported", async () => {
  const state = await stateWith(
    [decSec("DEC-5201", "A", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)])],
    { "DEC-5201": "P-1" },
    { review: { "DEC-5201": { alive: "dead", purpose: "P-1", rejected: { mode: "none" } } } },
  );
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-5201" }).record.status, "dropped");

  const root = docsRoot([
    decSec("DEC-5201", "A", [field("What", "W"), field("Why", "Y"), field("Superseded by", "DEC-5202"), field("Anchors", `${BT}a.ts${BT}`)]),
    decSec("DEC-5202", "B", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}b.ts${BT}`)]),
  ]);
  const p = plan(root, readLegacyRecords({ root }), { assignment: { "DEC-5201": "P-1", "DEC-5202": "P-1" } });
  const pending = pendingOps({ plan: p, state });
  const op = pending.ops.find((o) => o.id === "DEC-5202");
  assert.equal(op.type, "raise_choice");
  assert.deepEqual(pending.supersede_skipped, [{ id: "DEC-5201", status: "dropped", document_successor: "DEC-5202" }]);
  assert.equal("state_successor" in pending.supersede_skipped[0], false, "a dropped Choice has no successor");

  await runOps(REPO, pending.ops);
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-5202" }).record.status, "unconfirmed");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-5201" }).record.status, "dropped");
});

test("AC-003 / C-131-1: only the still-open replaced Choices ride on the supersede, the settled ones are reported", async () => {
  const state = await stateWith(
    [
      decSec("DEC-5301", "A", [field("What", "W"), field("Why", "Y"), field("Superseded by", "DEC-5302"), field("Anchors", `${BT}a.ts${BT}`)]),
      decSec("DEC-5302", "B", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}b.ts${BT}`)]),
      decSec("DEC-5304", "D", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}d.ts${BT}`)]),
    ],
    { "DEC-5301": "P-1", "DEC-5302": "P-1", "DEC-5304": "P-1" },
  );

  // one successor replaces both: DEC-5301 is already superseded, DEC-5304 is still open
  const root = docsRoot([
    decSec("DEC-5301", "A", [field("What", "W"), field("Why", "Y"), field("Superseded by", "DEC-5305"), field("Anchors", `${BT}a.ts${BT}`)]),
    decSec("DEC-5304", "D", [field("What", "W"), field("Why", "Y"), field("Superseded by", "DEC-5305"), field("Anchors", `${BT}d.ts${BT}`)]),
    decSec("DEC-5305", "E", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}e.ts${BT}`)]),
  ]);
  const p = plan(root, readLegacyRecords({ root }), { assignment: { "DEC-5301": "P-1", "DEC-5304": "P-1", "DEC-5305": "P-1" } });
  const pending = pendingOps({ plan: p, state });
  const op = pending.ops.find((o) => o.id === "DEC-5305");
  assert.equal(op.type, "supersede");
  assert.deepEqual(op.ids, ["DEC-5304"], "only the still-open replaced Choice rides on the call");
  assert.deepEqual(pending.superseded, [{ successor: "DEC-5305", ids: ["DEC-5304"] }]);
  assert.deepEqual(pending.supersede_skipped, [
    { id: "DEC-5301", status: "superseded", state_successor: "DEC-5302", document_successor: "DEC-5305" },
  ]);

  await runOps(REPO, pending.ops);
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-5304" }).record.status, "superseded");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-5304" }).record.history.at(-1).successor, "DEC-5305");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-5305" }).record.status, "unconfirmed");
});

// ---- the store round-trip (AC-010, AC-013, AC-014, AC-015) ----

async function runOps(repo, ops) {
  for (const op of ops) {
    const actor = { session: "s1" };
    if (op.type === "raise_purpose") {
      const r = await store.raisePurpose({ repo, actor, id: op.id, name: op.name, statement: op.statement, origin: op.origin });
      assert.equal(r.ok, true, r.error);
    } else if (op.type === "raise_choice") {
      const r = await store.raiseChoice({ repo, actor, body: op.body });
      assert.equal(r.ok, true, `${op.id}: ${r.error}`);
    } else if (op.type === "supersede") {
      const r = await store.supersede({ repo, actor, ids: op.ids, grounds: op.grounds, body: op.body });
      assert.equal(r.ok, true, `${op.id}: ${r.error}`);
    } else {
      const r = await store.dropChoice({ repo, actor, id: op.id, grounds: op.grounds });
      assert.equal(r.ok, true, `${op.id}: ${r.error}`);
    }
  }
}

function stateOf(repo) {
  const listed = store.listRecords({ repo, actor: null });
  return { purposes: listed.purposes, choices: listed.choices };
}

function columnText(repo) {
  const path = store.intentColumnPath(repo);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

test("AC-010 / DEC-100-6: sent through the store, the old Choice is superseded and names its successor", async () => {
  setupState();
  const root = docsRoot([decSec("DEC-1001", "A", [field("What", "W"), field("Why", "Y"), field("Superseded by", "DEC-1002"), field("Anchors", `${BT}a.ts${BT}`)]), decSec("DEC-1002", "B", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)])]);
  const p = plan(root, readLegacyRecords({ root }), { assignment: { "DEC-1001": "P-1", "DEC-1002": "P-1" } });
  await runOps(REPO, p.ops);
  const a = store.showRecord({ repo: REPO, actor: null, id: "DEC-1001" }).record;
  assert.equal(a.status, "superseded");
  assert.equal(a.history.at(-1).successor, "DEC-1002");
});

test("AC-009 / AC-010: a dead DEC replaced by a live successor is dropped, and the skipped supersede is reported", async () => {
  const mk = (id, sup) => decSec(id, "題", [field("What", "W"), field("Why", "Y"), ...(sup ? [field("Superseded by", sup)] : []), field("Anchors", `${BT}a.ts${BT}`)]);
  const root = docsRoot([mk("DEC-4001", "DEC-4002"), mk("DEC-4002", "DEC-4003"), mk("DEC-4003", null)]);
  const assignment = { "DEC-4001": "P-1", "DEC-4002": "P-1", "DEC-4003": "P-1" };
  const p = plan(root, readLegacyRecords({ root }), { assignment, review: { "DEC-4001": { alive: "dead", purpose: "P-1", rejected: { mode: "none" } } } });

  // the dead DEC is raised and dropped; the successor it would have replaced is raised plainly, so the door
  // never sees a supersede naming a dropped Choice
  assert.equal(p.blocked, false, JSON.stringify(p.blockers));
  assert.deepEqual(p.ops.map((o) => `${o.type}:${o.id}`), [
    "raise_purpose:P-1",
    "raise_choice:DEC-4001",
    "drop_choice:DEC-4001",
    "raise_choice:DEC-4002",
    "supersede:DEC-4003",
  ]);
  assert.deepEqual(p.report.superseded, [{ successor: "DEC-4003", ids: ["DEC-4002"] }]);
  assert.deepEqual(p.report.successor_dropped, [{ successor: "DEC-4002", ids: ["DEC-4001"] }]);
  assert.deepEqual(p.report.successor_missing, []);

  setupState();
  await runOps(REPO, p.ops);
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-4001" }).record.status, "dropped");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-4002" }).record.status, "superseded");
  assert.equal(store.showRecord({ repo: REPO, actor: null, id: "DEC-4003" }).record.status, "unconfirmed");
  const after = pendingOps({ plan: p, state: stateOf(REPO) });
  assert.deepEqual(after.ops, []);
  assert.equal(after.blocked, false);
});

test("AC-013 / INV-100-2: after the plan is sent, no op is left and a second run adds no row", async () => {
  setupState();
  const root = docsRoot([
    decSec("DEC-1001", "A", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]),
    decSec("DEC-1002", "B", [field("What", "W"), field("Why", "Y"), field("Superseded by", "DEC-1001"), field("Anchors", `${BT}a.ts${BT}`)]),
  ]);
  const p = plan(root, readLegacyRecords({ root }), { assignment: { "DEC-1001": "P-1", "DEC-1002": "P-1" } });
  await runOps(REPO, p.ops);
  const before = columnText(REPO);
  const after = pendingOps({ plan: p, state: stateOf(REPO) });
  assert.deepEqual(after.ops, []);
  assert.equal(after.blocked, false);
  assert.equal(columnText(REPO), before, "no second run touches the column");
});

test("AC-014 / DEC-100-5: an existing record is left alone, and only a body difference is reported", async () => {
  setupState();
  const before = decSec("DEC-1001", "A", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]);
  const other = decSec("DEC-1002", "B", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]);
  const noFree = decSec("DEC-1003", "C", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]);
  const root = docsRoot([before, other, noFree]);
  const records = readLegacyRecords({ root });
  const p = plan(root, records, { assignment: { "DEC-1001": "P-1", "DEC-1002": "P-1", "DEC-1003": "P-1" } });
  await runOps(REPO, p.ops);

  // one Choice is re-anchored, one is confirmed (its body stays as it was)
  assert.equal((await store.confirmChoice({ repo: REPO, actor: { session: "s1" }, id: "DEC-1001" })).ok, true);
  assert.equal((await store.confirmChoice({ repo: REPO, actor: { session: "s1" }, id: "DEC-1002" })).ok, true);
  const re = await store.reanchor({ repo: REPO, actor: { session: "s1" }, id: "DEC-1001", place: [{ path: "z/", kind: "dir" }] });
  assert.equal(re.ok, true, re.error);
  const after = pendingOps({ plan: p, state: stateOf(REPO) });
  assert.deepEqual(after.ops, []);
  assert.ok(after.differing.includes("DEC-1001"));
  assert.equal(after.differing.includes("DEC-1002"), false);
  assert.equal(after.differing.includes("DEC-1003"), false, "a Choice with no free of its own is not reported");

  // a document whose Why changed: the state keeps the old body, and the difference is reported
  const edited = docsRoot([decSec("DEC-1001", "A", [field("What", "W"), field("Why", "書き換えた理由"), field("Anchors", `${BT}a.ts${BT}`)]), other, noFree]);
  const p2 = plan(edited, readLegacyRecords({ root: edited }), { assignment: { "DEC-1001": "P-1", "DEC-1002": "P-1", "DEC-1003": "P-1" } });
  const diff = pendingOps({ plan: p2, state: stateOf(REPO) });
  assert.deepEqual(diff.ops, []);
  assert.ok(diff.differing.includes("DEC-1001"));

  // a Purpose that only differs in name or origin does not block; it is reported
  const p3 = plan(root, records, { purposes: [{ id: "P-1", name: "別の名", statement: "S", origin: "別" }], assignment: { "DEC-1001": "P-1", "DEC-1002": "P-1", "DEC-1003": "P-1" } });
  const named = pendingOps({ plan: p3, state: stateOf(REPO) });
  assert.equal(named.blocked, false);
  assert.ok(named.differing.includes("P-1"));
});

test("AC-015 / DEC-100-5: a half-sent plan continues from where it stopped, and a raised-but-not-dropped one only drops", async () => {
  setupState();
  const root = docsRoot([
    decSec("DEC-1001", "A", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]),
    decSec("DEC-1002", "B", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]),
    decSec("DEC-1003", "C", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)]),
  ]);
  const p = plan(root, readLegacyRecords({ root }), { assignment: { "DEC-1001": "P-1", "DEC-1002": "P-1", "DEC-1003": "P-1" } });
  const half = Math.floor(p.ops.length / 2);
  await runOps(REPO, p.ops.slice(0, half));
  const rest = pendingOps({ plan: p, state: stateOf(REPO) });
  assert.deepEqual(rest.ops.map((o) => `${o.type}:${o.id}`), p.ops.slice(half).map((o) => `${o.type}:${o.id}`));

  const dead = docsRoot([decSec("DEC-1004", "D", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)])]);
  const dp = plan(dead, readLegacyRecords({ root: dead }), { assignment: { "DEC-1004": "P-1" }, review: { "DEC-1004": { alive: "dead", purpose: "P-1", rejected: { mode: "none" } } } });
  setupState();
  await runOps(REPO, dp.ops.slice(0, 2)); // the Purpose and the raise, not the drop
  const left = pendingOps({ plan: dp, state: stateOf(REPO) });
  assert.deepEqual(left.ops.map((o) => o.type), ["drop_choice"]);
  assert.equal(left.ops[0].id, "DEC-1004");
});

test("AC-015 / INV-100-2: a run that stopped after the Purpose continues with the Choices, not the Purpose", async () => {
  setupState();
  const root = docsRoot([decSec("DEC-1001", "A", [field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`)])]);
  const p = plan(root, readLegacyRecords({ root }), { assignment: { "DEC-1001": "P-1" } });
  await runOps(REPO, p.ops.slice(0, 1)); // only the Purpose raise
  const rest = pendingOps({ plan: p, state: stateOf(REPO) });
  assert.deepEqual(rest.ops.map((o) => o.type), ["raise_choice"]);
});
