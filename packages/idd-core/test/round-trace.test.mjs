import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { roundTrace } from "../src/ledger/derive.ts";

/**
 * The per-round lines of a lane (C-252-2): one for each round the ledger records, built from the ledger's own fields.
 * The reading below is written again from the ledger's fields in plain JS, so the fold's answer is held against a
 * second reading of the same rows, in every prefix of every lane of the committed fixture.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "derive", "lifecycle.jsonl");

const rows = readFileSync(FIXTURE, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
const lanes = new Map();
for (const row of rows) {
  if (!lanes.has(row.idd_id)) lanes.set(row.idd_id, []);
  lanes.get(row.idd_id).push(row);
}

const row = (event, attrs) => ({ event, idd_id: "IDD-1", at: "", attrs });
/** the GO of a plan whose touch list was `scope` (a GO without it recorded none) */
const go = (scope) => row("s1_go", scope ? { plan_scope: scope } : {});
/** a result changing `files`, and a judgement of `kind` in `round` accepting `[severity, path]` pairs */
const result = (...files) => row("s2_result", { outcome: "success", changed_files: files });
const judged = (kind, round, ...accepted) => row("s2_triage_done", { kind, round, accepted: accepted.map(([severity, path]) => ({ severity, path })) });
/** the line a round is expected to be */
const lineOf = (cycle, round, kind, [must, should], named, changed, outside = []) => ({ cycle, round, kind, accepted_must: must, accepted_should: should, named_files: named, changed_files: changed, outside_scope: outside });

/**
 * The lines read from the ledger's fields: a round is a (cycle, round) pair — the cycle being the returns to the plan
 * before it — and the judgements of one round (a re-judgement, `confirm`, left out) are one line, at the first one.
 */
function expectedLines(events) {
  const lines = [];
  const at = new Map();
  let changed = [];
  let cycle = 0;
  // the scope of the last GO before the round: what that GO recorded, nothing when it recorded none
  let scope = [];
  const globRe = (glob) => new RegExp(`^${glob.split("**").map((part) => part.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);
  const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : null);
  const isTest = (file) => {
    const parts = file.split("/");
    const name = parts[parts.length - 1];
    return parts.slice(0, -1).some((p) => ["test", "tests", "__tests__"].includes(p)) || /\.(test|spec)\./.test(name) || /(_test\.mbt|_wbtest\.mbt|_test\.go)$/.test(name);
  };
  // a file entry names its module (the directory it sits in), whose own files are inside; a test is inside anywhere
  const inScope = (file) =>
    isTest(file) ||
    scope.some((s) => {
      if (s.includes("*")) return globRe(s.endsWith("/") ? `${s}**` : s).test(file);
      if (s.endsWith("/")) return file.startsWith(s);
      // an entry that is the tail of another entry is the same file written from the repo root, and names no module
      const alias = scope.some((o) => o !== s && !o.includes("*") && o.endsWith(`/${s}`));
      return file === s || (!alias && dirOf(s) !== null && dirOf(file) === dirOf(s));
    });
  for (const e of events) {
    if (e.event === "s1_go") {
      scope = Array.isArray(e.attrs?.plan_scope) ? e.attrs.plan_scope.map(String) : [];
      continue;
    }
    if (e.event === "s1_replan_requested") {
      cycle += 1;
      continue;
    }
    if (e.event === "s2_result") {
      // a result of a lane that went back to its plan names the cycle's own files beside the whole list
      const listed = Array.isArray(e.attrs?.cycle_files) ? e.attrs.cycle_files : e.attrs?.changed_files;
      changed = [...new Set((Array.isArray(listed) ? listed : []).map(String))].sort();
      continue;
    }
    if (e.event !== "s2_triage_done" || (e.attrs?.kind ?? "blind") === "confirm") continue;
    const accepted = (Array.isArray(e.attrs?.accepted) ? e.attrs.accepted : []).filter((a) => a?.severity === "must" || a?.severity === "should");
    const named = accepted.map((a) => a.path).filter((p) => typeof p === "string" && p !== "");
    // a round number the ledger does not hold as a number reads as 0 (the fold's own reading of the field)
    const round = Number.isFinite(Number(e.attrs?.round)) ? Number(e.attrs.round) : 0;
    const key = `${cycle}:${round}`;
    const must = accepted.filter((a) => a.severity === "must").length;
    const should = accepted.filter((a) => a.severity === "should").length;
    if (at.has(key)) {
      const line = lines[at.get(key)];
      line.accepted_must += must;
      line.accepted_should += should;
      line.named_files = [...new Set([...line.named_files, ...named])].sort();
      continue;
    }
    at.set(key, lines.length);
    lines.push({
      cycle,
      round,
      kind: String(e.attrs?.kind ?? "blind"),
      accepted_must: must,
      accepted_should: should,
      named_files: [...new Set(named)].sort(),
      changed_files: changed.length,
      outside_scope: scope.length ? changed.filter((f) => !inScope(f)) : [],
    });
  }
  return lines;
}

/** the number of rounds the ledger records: the distinct (cycle, round) pairs of its judgements, `confirm` left out */
function roundsOf(events) {
  const keys = new Set();
  let cycle = 0;
  for (const e of events) {
    if (e.event === "s1_replan_requested") cycle += 1;
    if (e.event === "s2_triage_done" && (e.attrs?.kind ?? "blind") !== "confirm") keys.add(`${cycle}:${Number.isFinite(Number(e.attrs?.round)) ? Number(e.attrs.round) : 0}`);
  }
  return keys.size;
}

test("AC-005: every prefix of every lane has one line for each round, from the ledger's own fields", () => {
  let checked = 0;
  for (const [lane, events] of lanes) {
    for (let n = 1; n <= events.length; n += 1) {
      const prefix = events.slice(0, n);
      const lines = roundTrace(prefix);
      assert.deepEqual(lines, expectedLines(prefix), `${lane} の先頭 ${n} 行`);
      assert.equal(lines.length, roundsOf(prefix), `${lane} の先頭 ${n} 行の巡の数`);
      checked += 1;
    }
  }
  assert.ok(checked > 100, "fixture の prefix が少なすぎます");
  // the fixture holds a round that accepted a must or a should: the lines are not all empty
  const all = [...lanes.values()].flatMap((events) => roundTrace(events));
  assert.ok(all.some((line) => line.accepted_must + line.accepted_should > 0));
});

test("AC-005: the lines hold the accepted must / should counts, the named files, the changed count and the files outside the plan's scope", () => {
  const lane = [
    go(["a/", "b/y.ts"]),
    row("s2_start", {}),
    result("a/x.ts", "b/y.ts"),
    judged("blind", 1, ["must", "a/x.ts"], ["should", "b/y.ts"], ["nit", "c.ts"]),
    judged("confirm", 1, ["should", "a/x.ts"]),
    result("z/out.ts"),
    judged("blind", 2, ["should", "a/x.ts"]),
  ];
  assert.deepEqual(roundTrace(lane), [
    lineOf(0, 1, "blind", [1, 1], ["a/x.ts", "b/y.ts"], 2),
    lineOf(0, 2, "blind", [0, 1], ["a/x.ts"], 1, ["z/out.ts"]),
  ]);
  // a GO that recorded no scope puts no file outside it; the lines are the same otherwise
  const unscoped = lane.map((e) => (e.event === "s1_go" ? go() : e));
  assert.deepEqual(roundTrace(unscoped).map((line) => line.outside_scope), [[], []]);
  const withoutOutside = (lines) => lines.map((line) => ({ ...line, outside_scope: [] }));
  assert.deepEqual(roundTrace(unscoped), withoutOutside(roundTrace(lane)));
  assert.deepEqual(roundTrace(lane), expectedLines(lane));
});

test("AC-004: a line holds only values the ledger holds: nothing of a row's text or a number the ledger lacks", () => {
  const lane = [
    row("s2_triage_done", { kind: "blind", round: 3, accepted: [{ severity: "must", path: "a.ts", claim: "text the trace must not carry", line: 99 }] }),
  ];
  const [line] = roundTrace(lane);
  assert.deepEqual(Object.keys(line).sort(), ["accepted_must", "accepted_should", "changed_files", "cycle", "kind", "named_files", "outside_scope", "round"]);
  assert.equal(JSON.stringify(line).includes("the trace must not carry"), false);
  assert.equal(line.changed_files, 0, "a round before any result reports no changed file");
});

test("AC-006: the same ledger gives the same lines, and the lines are as many as the rounds", () => {
  for (const [lane, events] of lanes) {
    const copy = JSON.parse(JSON.stringify(events));
    assert.deepEqual(roundTrace(events), roundTrace(copy), lane);
    assert.equal(JSON.stringify(roundTrace(events)), JSON.stringify(roundTrace(copy)), lane);
  }
});

test("AC-005: the judgements of one round are one line, and a replan numbers its rounds apart from the old ones", () => {
  // round 1 holds a feedback, a confirm and a device judgement; after the replan the rounds are numbered from 1 again
  const lane = [
    go(["a/", "n/"]),
    row("s2_start", {}),
    result("a/x.ts", "b/y.ts"),
    judged("feedback", 1, ["must", "a/x.ts"]),
    judged("confirm", 1, ["must", "q.ts"]),
    result("z/out.ts"),
    judged("device", 1, ["should", "b/y.ts"], ["should", "a/x.ts"]),
    row("s1_replan_requested", {}),
    result("n/new.ts"),
    judged("blind", 1, ["should", "n.ts"]),
  ];
  const lines = roundTrace(lane);
  assert.deepEqual(lines, [
    lineOf(0, 1, "feedback", [1, 2], ["a/x.ts", "b/y.ts"], 2, ["b/y.ts"]),
    lineOf(1, 1, "blind", [0, 1], ["n.ts"], 1),
  ]);
  assert.equal(lines.length, roundsOf(lane), "as many lines as rounds");
  assert.deepEqual(lines, expectedLines(lane));
  // the lane's own fixture holds a round with a feedback and a device judgement: it too is one line per round
  const folded = [...lanes.values()].some((events) => {
    const judged = events.filter((e) => e.event === "s2_triage_done" && (e.attrs?.kind ?? "blind") !== "confirm").length;
    return judged > roundTrace(events).length;
  });
  assert.ok(folded, "the fixture holds a lane whose round has more than one judgement");
});

test("AC-005: a round is measured against the plan of the GO it ran under, so a replan's second GO moves no earlier line", () => {
  // the same changed files in both cycles: the first plan holds a/, the plan after the replan holds z/
  const lane = [
    go(["a/"]),
    result("a/x.ts", "z/out.ts"),
    judged("blind", 1, ["must", "a/x.ts"]),
    row("s1_replan_requested", {}),
    go(["z/"]),
    result("a/x.ts", "z/out.ts"),
    judged("blind", 1, ["must", "z/out.ts"]),
  ];
  const lines = roundTrace(lane);
  assert.deepEqual(lines.map((l) => [l.cycle, l.outside_scope]), [[0, ["z/out.ts"]], [1, ["a/x.ts"]]]);
  assert.deepEqual(lines, expectedLines(lane));
  // the rows up to the replan read the same whether or not the lane went on: a later GO changes no earlier line
  assert.deepEqual(roundTrace(lane.slice(0, 4)), lines.slice(0, 1));
});

test("AC-006: a GO that recorded no scope puts no file outside the plan, and the plan is never read back for it", () => {
  const lane = [go(), result("a.ts", "b.ts"), judged("blind", 1, ["must", "a.ts"])];
  assert.deepEqual(roundTrace(lane).map((l) => l.outside_scope), [[]]);
  // an empty record and a record that is not a list read as none
  for (const bad of [[], "a.ts", 3, null]) {
    const l = [row("s1_go", { plan_scope: bad }), result("a.ts"), judged("blind", 1, ["must", "a.ts"])];
    assert.deepEqual(roundTrace(l).map((x) => x.outside_scope), [[]], JSON.stringify(bad));
  }
});

test("AC-005: a scope entry with a star matches inside one segment, two stars across them, and a slash holds the directory", () => {
  const files = ["packages/core/test/a/b.mjs", "packages/core/src/c.ts", "packages/tool/d.mjs", "lib/p/q/x.ts", "lib/x.ts", "docs/a.md", "docs/sub/a.md", "src/exact.ts", "src/sub/exact.ts"];
  const lane = [
    go(["packages/*/test/", "lib/**/x.ts", "docs/*.md", "src/exact.ts"]),
    result(...files),
    judged("blind", 1, ["must", "src/exact.ts"]),
  ];
  const [line] = roundTrace(lane);
  assert.deepEqual(line.outside_scope, ["docs/sub/a.md", "lib/x.ts", "packages/core/src/c.ts", "packages/tool/d.mjs", "src/sub/exact.ts"]);
  assert.deepEqual([line], expectedLines(lane));
});

test("AC-001 AC-002 AC-003 AC-004: a file beside a named file and a test file are inside the plan, another module and another root file are outside", () => {
  const outsideOf = (scope, ...files) => {
    const lane = [go(scope), result(...files), judged("blind", 1, ["must", files[0]])];
    const [line] = roundTrace(lane);
    assert.deepEqual([line], expectedLines(lane));
    return line.outside_scope;
  };
  // AC-001: a new file of the module the plan named
  assert.deepEqual(outsideOf(["packages/x/a.ts"], "packages/x/b.ts"), []);
  // AC-002: a module the plan did not name stays outside
  assert.deepEqual(outsideOf(["packages/x/a.ts"], "packages/y/b.ts"), ["packages/y/b.ts"]);
  // AC-003: a test file under a module the plan did not name
  assert.deepEqual(outsideOf(["packages/x/a.ts"], "packages/z/test/a.test.mjs", "packages/z/b.test.ts", "packages/z/b_wbtest.mbt"), []);
  // AC-004: a root file has no module, so another root file is outside
  assert.deepEqual(outsideOf(["a.ts"], "b.ts"), ["b.ts"]);
});

test("a root-relative alias of a named file names the file, not a module", () => {
  const lane = [go(["packages/x/src/a.ts", "src/a.ts"]), result("packages/x/src/b.ts", "src/a.ts", "src/unrelated.ts"), judged("blind", 1, ["must", "src/a.ts"])];
  const [line] = roundTrace(lane);
  assert.deepEqual(line.outside_scope, ["src/unrelated.ts"]);
  assert.deepEqual([line], expectedLines(lane));
});

test("AC-005: a lane that recorded its GO before this reading is read the same, and its GO row keeps its plan_scope", () => {
  const goRow = go(["packages/x/a.ts"]);
  const before = JSON.stringify(goRow);
  const lane = [goRow, result("packages/x/b.ts", "packages/x/test/c.test.mjs", "packages/y/d.ts"), judged("blind", 1, ["must", "packages/x/b.ts"])];
  assert.deepEqual(roundTrace(lane)[0].outside_scope, ["packages/y/d.ts"]);
  assert.equal(JSON.stringify(goRow), before);
  assert.deepEqual(goRow.attrs.plan_scope, ["packages/x/a.ts"]);
});
