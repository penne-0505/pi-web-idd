import assert from "node:assert/strict";
import { test } from "node:test";

import { decideBashRead, decideBashWrite, decideInjection, handedOver, normalizeInjectPath, sessionStartRows } from "../src/intent/inject.ts";

/** a Choice as the lookup returns it, with only the fields the injection reads */
const choice = (id, status, place, extra = {}) => ({
  id,
  status,
  forms: { chosen: extra.chosen ?? `chosen-${id}`, rejected: [] },
  place,
  why: extra.why ?? `why-${id}`,
  free: extra.free ?? `free-${id}`,
});

const file = (path, symbols) => ({ path, kind: "file", ...(symbols ? { symbols } : {}) });
const dir = (path) => ({ path, kind: "dir" });
const root = () => ({ path: "/", kind: "root" });

const TS = [
  "export function f(x: number): number {",
  "  return x + 1;",
  "}",
  "",
  "export function g(x: number): number {",
  "  return x * 2;",
  "}",
].join("\n");

test("AC-001: a read hands over id, chosen, why and free", () => {
  const a = choice("DEC-1", "active", [file("src/a.ts")], { chosen: "A にする", why: "なぜ A か", free: "A の範囲" });
  const b = choice("DEC-2", "active", [file("src/a.ts")]);
  const r = decideInjection({ event: "read", path: "src/a.ts", choices: [a, b], rows: [] });
  assert.ok(r.text.includes("DEC-1"));
  assert.ok(r.text.includes("A にする"));
  assert.ok(r.text.includes("なぜ A か"));
  assert.ok(r.text.includes("A の範囲"));
  assert.ok(r.text.includes("DEC-2"));
  assert.ok(r.text.includes("why-DEC-2"));
  assert.ok(r.text.includes("free-DEC-2"));
  // the body is not the anchored text or the rejected forms
  assert.ok(!r.text.includes("anchored"));
  assert.deepEqual(r.rows, [{ event: "read", path: "src/a.ts", choices: [
    { id: "DEC-1", form: "body", status: "active" },
    { id: "DEC-2", form: "body", status: "active" },
  ] }]);
});

test("AC-002: the second read of the same file adds nothing", () => {
  const a = choice("DEC-1", "active", [file("src/a.ts")]);
  const first = decideInjection({ event: "read", path: "src/a.ts", choices: [a], rows: [] });
  const second = decideInjection({ event: "read", path: "src/a.ts", choices: [a], rows: first.rows });
  assert.equal(second.text, null);
  assert.deepEqual(second.rows, []);
});

test("AC-003: a Choice already handed over is one line in the next file", () => {
  const x = choice("DEC-X", "active", [file("src/a.ts"), file("src/b.ts")]);
  const y = choice("DEC-Y", "active", [file("src/b.ts")]);
  const first = decideInjection({ event: "read", path: "src/a.ts", choices: [x], rows: [] });
  const second = decideInjection({ event: "read", path: "src/b.ts", choices: [x, y], rows: first.rows });
  assert.ok(second.text.includes("DEC-X"));
  assert.ok(second.text.includes("chosen-DEC-X"));
  assert.ok(!second.text.includes("why-DEC-X"));
  assert.ok(second.text.includes("why-DEC-Y"));
});

test("AC-004: the sixth Choice keeps id and chosen, and gets its body in the next file", () => {
  const many = Array.from({ length: 7 }, (_, i) => choice(`DEC-${i + 1}`, "active", [file("src/a.ts"), file("src/b.ts")]));
  const first = decideInjection({ event: "read", path: "src/a.ts", choices: many, rows: [] });
  for (let i = 1; i <= 7; i += 1) assert.ok(first.text.includes(`DEC-${i}`));
  for (let i = 1; i <= 5; i += 1) assert.ok(first.text.includes(`why-DEC-${i}`));
  for (let i = 6; i <= 7; i += 1) assert.ok(!first.text.includes(`why-DEC-${i}`));
  const second = decideInjection({ event: "read", path: "src/b.ts", choices: many, rows: first.rows });
  assert.ok(second.text.includes("why-DEC-6"));
  assert.ok(second.text.includes("why-DEC-7"));
  assert.ok(!second.text.includes("why-DEC-1"));
});

test("AC-005: after a compaction the bodies are handed over again", () => {
  const a = choice("DEC-1", "active", [file("src/a.ts")]);
  const first = decideInjection({ event: "read", path: "src/a.ts", choices: [a], rows: [] });
  const compact = decideInjection({ event: "compact", rows: first.rows });
  assert.deepEqual(compact.rows, [{ event: "compact" }]);
  const after = decideInjection({ event: "read", path: "src/a.ts", choices: [a], rows: [...first.rows, ...compact.rows] });
  assert.ok(after.text.includes("why-DEC-1"));
});

test("AC-006: an unconfirmed Choice is marked, with the meaning of the mark once", () => {
  const active = choice("DEC-1", "active", [file("src/a.ts")]);
  const unconfirmed = choice("DEC-2", "unconfirmed", [file("src/a.ts")]);
  const both = decideInjection({ event: "read", path: "src/a.ts", choices: [active, unconfirmed], rows: [] });
  assert.ok(both.text.includes("DEC-2 [unconfirmed]"));
  assert.ok(!both.text.includes("DEC-1 [unconfirmed]"));
  assert.ok(both.text.includes("確認"));
  assert.ok(both.text.includes("Supersede"));
  assert.ok(both.text.includes("捨てる"));
  assert.equal((both.text.match(/確認・Supersede・捨てる/g) ?? []).length, 1);
  const onlyActive = decideInjection({ event: "read", path: "src/a.ts", choices: [active], rows: [] });
  assert.ok(!onlyActive.text.includes("確認"));
});

test("AC-007: a read does not hand over a dir's or the root's Choice", () => {
  const f = choice("DEC-F", "active", [file("src/a/b.ts")]);
  const d = choice("DEC-D", "active", [dir("src/")]);
  const r = choice("DEC-R", "active", [root()]);
  const out = decideInjection({ event: "read", path: "src/a/b.ts", choices: [f, d, r], rows: [] });
  assert.ok(out.text.includes("DEC-F"));
  assert.ok(!out.text.includes("DEC-D"));
  assert.ok(!out.text.includes("DEC-R"));
});

test("AC-008: an edit inside a symbol's range is a hit; one of several replacements is enough", () => {
  const f = choice("DEC-F", "active", [file("src/a.ts", ["f"])]);
  const hit = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], edits: [{ oldText: "return x + 1;" }], content: TS, rows: [] });
  assert.ok(hit.text.includes("DEC-F"));
  assert.ok(hit.text.includes("Supersede"));
  assert.ok(hit.text.includes("Re-anchor"));
  assert.ok(hit.text.includes("Waive"));
  const second = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], edits: [{ oldText: "return x * 2;" }, { oldText: "return x + 1;" }], content: TS, rows: [] });
  assert.ok(second.text.includes("DEC-F"));
});

test("AC-009: an edit outside the symbol's range adds nothing", () => {
  const f = choice("DEC-F", "active", [file("src/a.ts", ["f"])]);
  const out = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], edits: [{ oldText: "return x * 2;" }], content: TS, rows: [] });
  assert.equal(out.text, null);
  assert.deepEqual(out.rows, []);
});

test("AC-010: a symbol that cannot be drawn is a hit, and the row says so", () => {
  const missing = choice("DEC-M", "active", [file("src/a.ts", ["nope"])]);
  const out = decideInjection({ event: "edit", path: "src/a.ts", choices: [missing], edits: [{ oldText: "return x + 1;" }], content: TS, rows: [] });
  assert.ok(out.text.includes("DEC-M"));
  assert.equal(out.rows[0].choices[0].symbol_missing, true);
  const unreadable = decideInjection({ event: "edit", path: "src/a.ts", choices: [choice("DEC-F", "active", [file("src/a.ts", ["f"])])], edits: [{ oldText: "x" }], content: null, rows: [] });
  assert.ok(unreadable.text.includes("DEC-F"));
  assert.equal(unreadable.rows[0].choices[0].symbol_missing, true);
});

// f is imported and called before it is defined: the range must start at the definition, or the hit is dropped
const TS_IMPORT = [
  'import { f } from "./f";',
  "",
  "export function g(x: number): number {",
  "  return f(x);",
  "}",
  "",
  "export function f(x: number): number {",
  "  return x + 1;",
  "}",
].join("\n");

test("the symbol's range starts at its definition, not at an earlier import or call", () => {
  const f = choice("DEC-F", "active", [file("src/a.ts", ["f"])]);
  const inside = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], edits: [{ oldText: "return x + 1;" }], content: TS_IMPORT, rows: [] });
  assert.ok(inside.text.includes("DEC-F"));
  const outside = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], edits: [{ oldText: "return f(x);" }], content: TS_IMPORT, rows: [] });
  assert.equal(outside.text, null);
});

test("a symbol that is only called, never defined, is a hit by path and is recorded as not drawn", () => {
  const onlyCall = choice("DEC-C", "active", [file("src/a.ts", ["helper"])]);
  const content = ["export function g() {", "  return helper();", "}"].join("\n");
  const out = decideInjection({ event: "edit", path: "src/a.ts", choices: [onlyCall], edits: [{ oldText: "return helper();" }], content, rows: [] });
  assert.ok(out.text.includes("DEC-C"));
  assert.equal(out.rows[0].choices[0].symbol_missing, true);
});

test("an edit whose replacements cannot be read is a hit for a symbol Place", () => {
  const f = choice("DEC-F", "active", [file("src/a.ts", ["f"])]);
  const empty = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], edits: [], content: TS, rows: [] });
  assert.ok(empty.text.includes("DEC-F"));
  assert.equal(empty.rows[0].choices[0].symbol_missing, undefined);
  const absent = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], content: TS, rows: [] });
  assert.ok(absent.text.includes("DEC-F"));
});

test("AC-011: a write is a hit for every Choice of the file", () => {
  const withSymbols = choice("DEC-F", "active", [file("src/a.ts", ["f"])]);
  const without = choice("DEC-2", "active", [file("src/a.ts")]);
  const out = decideInjection({ event: "write", path: "src/a.ts", choices: [withSymbols, without], content: null, rows: [] });
  assert.ok(out.text.includes("DEC-F"));
  assert.ok(out.text.includes("DEC-2"));
  // a write needs no symbol and no content
  assert.equal(out.rows[0].choices[0].symbol_missing, undefined);
});

test("AC-012: an edit or write under a dir hands over the dir's Choice, not the root's", () => {
  const d = choice("DEC-D", "active", [dir("a/b/")]);
  const r = choice("DEC-R", "active", [root()]);
  const write = decideInjection({ event: "write", path: "a/b/new.ts", choices: [d, r], content: null, rows: [] });
  assert.ok(write.text.includes("DEC-D"));
  assert.ok(!write.text.includes("DEC-R"));
  const edit = decideInjection({ event: "edit", path: "a/b/c/x.ts", choices: [d], edits: [{ oldText: "x" }], content: null, rows: [] });
  assert.ok(edit.text.includes("DEC-D"));
  const outside = decideInjection({ event: "edit", path: "a/other.ts", choices: [d], edits: [{ oldText: "x" }], content: null, rows: [] });
  assert.equal(outside.text, null);
});

test("AC-013: a notice carries the body while it has not been handed over", () => {
  const f = choice("DEC-F", "active", [file("src/a.ts", ["f"])]);
  const fresh = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], edits: [{ oldText: "return x + 1;" }], content: TS, rows: [] });
  assert.ok(fresh.text.includes("why-DEC-F"));
  assert.ok(fresh.text.includes("free-DEC-F"));
  const read = decideInjection({ event: "read", path: "src/a.ts", choices: [f], rows: [] });
  const after = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], edits: [{ oldText: "return x + 1;" }], content: TS, rows: read.rows });
  assert.ok(after.text.includes("DEC-F"));
  assert.ok(!after.text.includes("why-DEC-F"));
  // a Choice shrunk to one line in a read still gets its body at the notice
  const many = Array.from({ length: 6 }, (_, i) => choice(`DEC-${i + 1}`, "active", [file("src/a.ts", ["f"])]));
  const first = decideInjection({ event: "read", path: "src/a.ts", choices: many, rows: [] });
  const shrunk = decideInjection({ event: "edit", path: "src/a.ts", choices: many, edits: [{ oldText: "return x + 1;" }], content: TS, rows: first.rows });
  assert.ok(shrunk.text.includes("why-DEC-6"));
});

test("AC-014: a hit is told once per session, and again after a compaction", () => {
  const f = choice("DEC-F", "active", [file("src/a.ts", ["f"])]);
  const first = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], edits: [{ oldText: "return x + 1;" }], content: TS, rows: [] });
  const second = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], edits: [{ oldText: "return x + 1;" }], content: TS, rows: first.rows });
  assert.equal(second.text, null);
  const afterCompact = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], edits: [{ oldText: "return x + 1;" }], content: TS, rows: [...first.rows, { event: "compact" }] });
  assert.ok(afterCompact.text.includes("DEC-F"));
});

test("a notice shrunk by the body limit still hands its body over at the next hit", () => {
  const many = Array.from({ length: 6 }, (_, i) => choice(`DEC-${i + 1}`, "active", [file("src/a.ts", ["f"])]));
  const edits = [{ oldText: "return x + 1;" }];
  const first = decideInjection({ event: "edit", path: "src/a.ts", choices: many, edits, content: TS, rows: [] });
  assert.ok(first.text.includes("why-DEC-5"));
  assert.ok(!first.text.includes("why-DEC-6"));
  const shrunk = first.rows[0].choices.find((c) => c.id === "DEC-6");
  assert.equal(shrunk.form, "notice");
  assert.equal(shrunk.body, undefined);
  const second = decideInjection({ event: "edit", path: "src/a.ts", choices: many, edits, content: TS, rows: first.rows });
  assert.ok(second.text.includes("why-DEC-6"));
  assert.ok(!second.text.includes("why-DEC-1"));
  assert.ok(!second.text.includes("DEC-1"));
});

test("AC-031: a path with a backslash or a leading ./ still meets the Place", () => {
  const a = choice("DEC-1", "active", [file("src/foo.ts")]);
  for (const p of ["src\\foo.ts", "./src/foo.ts"]) {
    const out = decideInjection({ event: "read", path: p, choices: [a], rows: [] });
    assert.ok(out.text.includes("DEC-1"), p);
    assert.deepEqual(out.rows[0].path, "src/foo.ts");
  }
  assert.equal(normalizeInjectPath("src\\foo.ts"), "src/foo.ts");
});

test("AC-025: a new session is told how to look a Choice up; a resume is not; a compact start writes the row", () => {
  const start = sessionStartRows("startup");
  assert.ok(start.text.includes("idd intent lookup"));
  assert.deepEqual(start.rows, []);
  assert.equal(sessionStartRows("resume").text, null);
  const compact = sessionStartRows("compact");
  assert.deepEqual(compact.rows, [{ event: "compact" }]);
  assert.ok(compact.text.includes("idd intent lookup"));
});

test("AC-007: one Bash command's bodies share the limit across its files", () => {
  const a = Array.from({ length: 4 }, (_, i) => choice(`DEC-A${i + 1}`, "active", [file("src/a.ts")]));
  const b = Array.from({ length: 4 }, (_, i) => choice(`DEC-B${i + 1}`, "active", [file("src/b.ts")]));
  const out = decideBashRead({ paths: ["src/a.ts", "src/b.ts"], choices: [...a, ...b], rows: [] });
  for (let i = 1; i <= 4; i += 1) assert.ok(out.text.includes(`DEC-A${i}`), `DEC-A${i}`);
  for (let i = 1; i <= 4; i += 1) assert.ok(out.text.includes(`DEC-B${i}`), `DEC-B${i}`);
  const bodies = (out.text.match(/  why:/g) ?? []).length;
  assert.equal(bodies, 5);
  const lines = out.text.split("\n").filter((l) => l.startsWith("- ") && l.includes("本文は渡し済み"));
  assert.equal(lines.length, 3);
  assert.deepEqual(out.rows.map((r) => r.event), ["bash-read", "bash-read"]);
  // four bodies in the first file leaves one for the second
  assert.equal(out.rows[0].choices.filter((c) => c.form === "body").length, 4);
  assert.equal(out.rows[1].choices.filter((c) => c.form === "body").length, 1);
});

test("a Bash read and a Read share what was opened", () => {
  const a = choice("DEC-1", "active", [file("src/a.ts")]);
  const bash = decideBashRead({ paths: ["src/a.ts"], choices: [a], rows: [] });
  assert.ok(bash.text.includes("why-DEC-1"));
  const read = decideInjection({ event: "read", path: "src/a.ts", choices: [a], rows: bash.rows });
  assert.equal(read.text, null);
  // and the other way around
  const readFirst = decideInjection({ event: "read", path: "src/a.ts", choices: [a], rows: [] });
  const bashAfter = decideBashRead({ paths: ["src/a.ts"], choices: [a], rows: readFirst.rows });
  assert.equal(bashAfter.text, null);
});

test("AC-022: a blocked Bash write does not count as handed over", () => {
  const f = choice("DEC-F", "active", [file("src/a.ts", ["f"])]);
  const rows = [{ event: "bash-write", path: "src/a.ts", blocked: true }];
  const edit = decideInjection({ event: "edit", path: "src/a.ts", choices: [f], edits: [{ oldText: "return x + 1;" }], content: TS, rows });
  assert.ok(edit.text.includes("why-DEC-F"));
  assert.ok(edit.text.includes("free-DEC-F"));
  const read = decideInjection({ event: "read", path: "src/a.ts", choices: [f], rows });
  assert.ok(read.text.includes("why-DEC-F"));
  assert.deepEqual(handedOver(rows).blockedPaths, new Set(["src/a.ts"]));
});

test("a Bash write that is let through gets a row whether or not a Choice meets it", () => {
  const f = choice("DEC-F", "active", [file("src/a.ts")]);
  const none = decideBashWrite({ paths: ["src/other.ts"], choices: [f], rows: [] });
  assert.equal(none.text, null);
  assert.deepEqual(none.rows, [{ event: "bash-write", path: "src/other.ts" }]);
  const hit = decideBashWrite({ paths: ["src/a.ts"], choices: [f], rows: [] });
  assert.ok(hit.text.includes("why-DEC-F"));
  assert.deepEqual(hit.rows, [{ event: "bash-write", path: "src/a.ts", choices: [{ id: "DEC-F", form: "notice", status: "active", body: true }] }]);
});

test("AC-004: a body carries the Purpose's id and want, never the whole statement", () => {
  const named = (id, purpose, statement, place = [file("src/a.ts")]) => ({ ...choice(id, "active", place), purpose, purpose_statement: statement });
  const a = named("DEC-1", "P-28", "目的の want。二つ目の文は入らない。");
  const r = decideInjection({ event: "read", path: "src/a.ts", choices: [a], rows: [] });
  assert.ok(r.text.includes("purpose: P-28 目的の want。"));
  assert.ok(!r.text.includes("二つ目の文は入らない"), "the whole statement is not injected");
  // a Choice whose row names no Purpose keeps the body it had
  const b = choice("DEC-2", "active", [file("src/a.ts")]);
  const r2 = decideInjection({ event: "read", path: "src/a.ts", choices: [b], rows: [] });
  assert.ok(!r2.text.includes("purpose:"));
  // the body budget still counts bodies: six Choices with Purposes hand five bodies over, and all six ids stay
  const many = Array.from({ length: 6 }, (_, i) => named(`DEC-${i + 10}`, "P-1", "want。", [file("src/b.ts")]));
  const out = decideInjection({ event: "read", path: "src/b.ts", choices: many, rows: [] });
  assert.equal((out.text.match(/  why:/g) ?? []).length, 5);
  assert.equal((out.text.match(/  purpose: /g) ?? []).length, 5);
  for (let i = 10; i <= 15; i += 1) assert.ok(out.text.includes(`DEC-${i}`), `DEC-${i}`);
});

// ---- Issue #181: the file's mark is the body, the module is the heading ----

const mod = (path, marked) => ({ path, kind: "module", ...(marked ? { file: marked } : {}) });

test("AC-004: a read hands over the file's own Choice as a body, and the same module's as headings", () => {
  const own = choice("C-1", "active", [mod("src/", "src/a.ts")]);
  const siblings = Array.from({ length: 13 }, (_, i) => choice(`C-s${i}`, "active", [mod("src/", `src/f${i}.ts`)]));
  const other = choice("C-other", "active", [mod("lib/", "lib/z.ts")]);
  const r = decideInjection({ event: "read", path: "src/a.ts", choices: [own, ...siblings, other], rows: [] });
  assert.ok(r.text.includes("why-C-1"), "the file's own Choice carries its body");
  assert.ok(!r.text.includes("why-C-s0"), "a Choice of the same module is a heading, not a body");
  assert.ok(r.text.includes("C-s0 chosen-C-s0"));
  assert.ok(!r.text.includes("C-other"), "another module's Choice is not handed over");
  // ten headings, then one line with the rest and how to pull them
  assert.equal((r.text.match(/^- C-s\d+ /gm) ?? []).length, 10);
  assert.ok(r.text.includes("ほか 3 件"), r.text);
  assert.ok(r.text.includes("idd intent lookup src/a.ts"));
  // the heading rows carry the ids without claiming a body was handed over
  assert.deepEqual(r.rows[0].choices.filter((c) => c.form === "line").map((c) => c.id), Array.from({ length: 10 }, (_, i) => `C-s${i}`));
  assert.equal(r.rows[0].choices.some((c) => c.form === "body" && c.id.startsWith("C-s")), false);
});

test("AC-004: a file with no Choice of its own still gets its module's headings", () => {
  const sibling = choice("C-1", "active", [mod("src/", "src/b.ts")]);
  const r = decideInjection({ event: "read", path: "src/a.ts", choices: [sibling], rows: [] });
  assert.ok(r.text.includes("同じ module（src/）の Choice"));
  assert.ok(r.text.includes("C-1 chosen-C-1"));
  // and a dir's own Choice of that module is a heading too
  const onDir = choice("C-2", "active", [mod("src/")]);
  const both = decideInjection({ event: "read", path: "src/a.ts", choices: [sibling, onDir], rows: [] });
  assert.ok(both.text.includes("C-2"));
});

test("AC-004: an edit meets the module of a file it names, and a dir's own Place", () => {
  const marked = choice("C-1", "active", [mod("src/", "src/a.ts")]);
  const dirChoice = choice("C-2", "active", [mod("src/sub/")]);
  const other = choice("C-3", "active", [mod("src/", "src/b.ts")]);
  const edited = decideInjection({ event: "edit", path: "src/a.ts", choices: [marked, dirChoice, other], rows: [], edits: [{ oldText: "x" }], content: "x\n" });
  assert.ok(edited.text.includes("C-1"));
  assert.ok(!edited.text.includes("C-3"), "another file's mark is not met by this edit");
  const inDir = decideInjection({ event: "write", path: "src/sub/new.ts", choices: [marked, dirChoice], rows: [] });
  assert.ok(inDir.text.includes("C-2"));
  // the root is never handed over
  const rooted = decideInjection({ event: "write", path: "src/sub/new.ts", choices: [root()], rows: [] });
  assert.equal(rooted.text, null);
});
