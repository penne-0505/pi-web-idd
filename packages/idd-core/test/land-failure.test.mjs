import assert from "node:assert/strict";
import { test } from "node:test";

import { landFailureCause } from "../src/overlay/land.ts";
import { landFailureCauseReference } from "../src/overlay/land-failure-reference.ts";
import { CUT_BY_OUTPUT, CUT_BY_TIME } from "../src/overlay/gate.ts";
import { LOCK_CHECKING } from "../src/overlay/git.ts";

// The cause of a failed landing check, as the running tick and the card read it. The answer is the MoonBit fold's
// (`packages/idd-fold/land_failure.mbt`); this holds it against the TypeScript reading over the records and runs the
// stage keeps, so the words a check's detail carries cannot come to mean two things (C-202-1).

const fail = (name, detail) => ({ name, status: "fail", severity: "blocking", detail });
const pass = (name) => ({ name, status: "pass", severity: "blocking" });
const skipped = (name, detail) => ({ name, status: "skipped", severity: "blocking", detail });
const rec = (checks, extra = {}) => ({ head: "h", mainTip: "m", blocking: checks.filter((c) => c.severity === "blocking" && c.status !== "pass" && c.status !== "not-applicable").length, checks, ...extra });
const row = (kind, detail, extra = {}) => ({ name: "structure/duplicate-tokens", status: "fail", severity: "blocking", detail, structure: { kind, ...extra } });
// a failed test row as the landing run writes it: the summary test-entry ends with, and the names read from it
const named = (name, ...tests) => ({ ...fail(name, `ℹ fail ${tests.length}\n[test-entry] 組 ${name} が落ちました: 落ちたテスト ${tests.length} 件\n${tests.map((t) => `  - ${t}`).join("\n")}\n`), failedTests: tests });
const earlier = (name, ...tests) => ({ earlierFailed: [{ name, tests }] });
const run = (extra = {}) => ({ head: "h", mainTip: "m", status: "failed", error: "", ...extra });

// a record of a landing that could not be rebuilt: no merge commit, no check, the failure and when it was taken
const unbuilt = (cause) => ({ head: "h", mainTip: "m", blocking: 0, checks: [], reason: "x", rebuildFailure: { cause, reason: "gen.txt を作り直すコマンドが失敗しました:\nboom", paths: ["gen.txt", "gen2.txt"], at: "2026-11-06T10:00:00.000Z" } });

const pair = (a, b) => ({ earlierFailed: [{ name: "test:lane", tests: a }, { name: "test", tests: b }] });
const structureNamed = (kind, extra, ...tests) => ({ ...row(kind, "x", extra), failedTests: tests });
const long = "あ".repeat(200);
// the tests that failed against the round before it, of the same head and tip: [where, record, the cause's kind, whether the tree's]
const byNames = [
  ["tests that moved to others", rec([named("test:lane", "b")], earlier("test:lane", "a")), "environment"],
  ["tests that moved to others, many names", rec([named("test:lane", "a", "b", "c", "d", "e")], earlier("test:lane", "x", "y", "z", "w")), "environment"],
  ["tests that moved in two checks", rec([named("test:lane", "b"), named("test", "d")], pair(["a"], ["c"])), "environment"],
  ["the same test again", rec([named("test:lane", "a")], earlier("test:lane", "a")), "real"],
  ["one test in common among others", rec([named("test:lane", "a", "b")], earlier("test:lane", "b", "c")), "real"],
  ["tests that moved in one check and stayed in the other", rec([named("test:lane", "b"), named("test", "c")], pair(["a"], ["c"])), "real"],
  ["a long name that shares a start with the round before's", rec([named("test:lane", `${long} 2`)], earlier("test:lane", `${long} 1`)), "environment"],
  // a round with no names to compare is the change's failure, as it was
  ["no round before", rec([named("test:lane", "a")]), "real"],
  ["a round before that named no test", rec([named("test:lane", "a")], { earlierFailed: [] }), "real"],
  ["a round before that failed another check", rec([named("test:lane", "a")], earlier("test", "b")), "real"],
  ["names the row does not carry", rec([fail("test:lane", "✖ a")], earlier("test:lane", "b")), "real"],
  ["tests that moved beside a failure of the change", rec([named("test:lane", "b"), fail("lint", "1 error")], earlier("test:lane", "a")), "real"],
  ["tests that moved beside a cut check", rec([named("test:lane", "b"), fail("test", CUT_BY_TIME(5))], earlier("test:lane", "a")), "environment"],
  // a structure row says its kind: the tests its detail names do not move it
  ["tests that moved beside a count that grew", rec([named("test:lane", "b"), row("increase", "+2")], earlier("test:lane", "a")), "real", true],
  ["a structure row that names tests the round before did not", rec([structureNamed("unmeasured", { sides: ["merged"] }, "b")], earlier("structure/duplicate-tokens", "a")), "real"],
  ["a count that grew, named", rec([structureNamed("increase", {}, "new")], earlier("structure/duplicate-tokens", "old")), "real", true],
  ["a declaration that holds less, named", rec([structureNamed("weakened", {}, "new")], earlier("structure/duplicate-tokens", "old")), "real", true],
];

const cases = [
  ["no record", null, null],
  ["a record that did not fail", rec([pass("typecheck")]), null],
  ["no blocking check", { ...rec([]), checks: [{ name: "x", status: "fail", severity: "non-blocking", detail: "boom" }], blocking: 0 }, null],
  ["cut by time", rec([pass("typecheck"), fail("test", `${CUT_BY_TIME(5)}\n[test-entry] 組 test が止まりました`)]), null],
  ["cut by output", rec([fail("test", `${CUT_BY_OUTPUT}\n...`)]), null],
  ["the overlay lock", rec([fail("test", `✖ x\n  error: ${LOCK_CHECKING}\n`)]), null],
  ["lockRefused", rec([fail("test:lane", '{ error: "...", lockRefused: true }')]), null],
  ["skipped after the setup failed", rec([fail("setup", CUT_BY_TIME(5)), skipped("test", "準備に失敗したので回していません")]), null],
  ["skipped after a real failure", rec([fail("setup", "boom"), skipped("test", "準備に失敗したので回していません")]), null],
  ["a check the change failed", rec([fail("typecheck", "src/a.ts(1,2): error TS2304: Cannot find name")]), null],
  ["one real failure beside an environment one", rec([fail("test", CUT_BY_TIME(5)), fail("lint", "1 error")]), null],
  // a structure row says its own kind: the words of its detail do not (C-253-1)
  ["a count that grew", rec([row("increase", "本流 10 / 取り込み 12（+2）", { command: ["node", "count.mjs"] })]), null],
  ["a count that grew beside an environment failure", rec([row("increase", "本流 10 / 取り込み 12（+2）"), fail("test", CUT_BY_TIME(5))]), null],
  ["a declaration that holds less", rec([row("weakened", "取り込む側の宣言から止める数（duplicate-tokens）が外れています")]), null],
  ["a count the mainline's tree could not give", rec([row("unmeasured", "本流の先端の数を測れませんでした", { sides: ["mainline"] })]), null],
  ["a count neither tree could give", rec([row("unmeasured", "構造の宣言を読めませんでした", { sides: ["mainline", "merged"] })]), null],
  ["a count only the merge commit's tree could not give", rec([row("unmeasured", "取り込む側の数を測れませんでした", { sides: ["merged"] })]), null],
  ["a count only the merge commit could not give, cut by time", rec([row("unmeasured", CUT_BY_TIME(5), { sides: ["merged"] })]), null],
  ["a count the mainline could not give, in words that look like a failure", rec([row("unmeasured", "✖ error TS2304", { sides: ["mainline"] })]), null],
  ["a count the mainline could not give beside a failure of the change", rec([row("unmeasured", "本流の先端の数を測れませんでした", { sides: ["mainline"] }), fail("lint", "1 error")]), null],
  ["a structure row from before the kinds", rec([fail("structure/duplicate-tokens", "本流 10 / 取り込み 12（+2）")]), null],
  ["a run that ended without a result", rec([pass("typecheck")]), run()],
  ["a run of another group", rec([pass("typecheck")]), run({ head: "other" })],
  ["a run that is still going", rec([pass("typecheck")]), run({ status: "running" })],
  ["a run with no error text", rec([pass("typecheck")]), run({ error: null })],
  // a landing whose generated files could not be made again ran no check: the failure is the record's own
  ["a rebuild the environment could not make", unbuilt("environment"), null],
  ["a rebuild the build refused", unbuilt("build"), null],
  ["a rebuild the build refused, the run of another group", unbuilt("build"), run({ head: "other" })],
  ["a rebuild that could not be made beside a run that died", unbuilt("build"), run()],
  // a run of the same group that began before the record was taken belongs to an earlier try: the record is the newer fact
  ...[
    ["build", "the build refused", "a run that began before it", { started_at: "2026-11-06T09:00:00.000Z" }],
    ["build", "the build refused", "a stopped run that began before it", { status: "stopped", started_at: "2026-11-06T09:59:59.000Z" }],
    ["build", "the build refused", "a run that began after it", { started_at: "2026-11-06T10:00:01.000Z" }],
    ["build", "the build refused", "a run with no start", { started_at: undefined }],
    ["build", "the build refused", "a run whose start is not a time", { started_at: "not a time" }],
    ["environment", "the environment could not make", "a run that began before it", { started_at: "2026-11-06T09:00:00.000Z" }],
    ["environment", "the environment could not make", "a run that began after it", { started_at: "2026-11-06T10:00:01.000Z" }],
  ].map(([cause, said, beside, extra]) => [`a rebuild ${said}, beside ${beside}`, unbuilt(cause), run(extra)]),
  ["a record from before, with a merge commit and the failure", { ...unbuilt("environment"), mergeCommit: "x", blocking: 0, checks: [pass("typecheck")] }, null],
  ["a conflict record that carries the failure", { ...unbuilt("environment"), conflict: ["gen.txt"] }, null],
];

test("a structure row is read from its kind, not from the words of its detail", () => {
  const read = (checks) => landFailureCause(rec(checks), null);
  assert.equal(read([row("unmeasured", CUT_BY_TIME(5), { sides: ["merged"] })]).kind, "real", "only the merge commit lacked the count: the change's, whatever the detail says");
  assert.equal(read([row("unmeasured", "✖ error TS2304", { sides: ["mainline"] })]).kind, "environment", "the mainline lacked it: not the change's, whatever the detail says");
  assert.equal(read([row("increase", CUT_BY_TIME(5))]).kind, "real");
  const structural = (checks) => read(checks).structural;
  assert.equal(structural([row("increase", "+2")]), true, "a count that grew is the tree's");
  assert.equal(structural([row("weakened", "x")]), true);
  assert.equal(structural([row("unmeasured", "x", { sides: ["merged"] })]), undefined, "a count that could not be taken may still be the load of a run");
  assert.equal(structural([fail("test", "✖ boom")]), undefined);
});

test("a rebuild that could not be made is the environment's or the change's by what the failure says, and no check is read", () => {
  const environment = landFailureCause(unbuilt("environment"), null);
  assert.equal(environment.kind, "environment");
  assert.equal(environment.noResult, undefined);
  assert.match(environment.reason, /生成物（gen\.txt, gen2\.txt）をこの環境では作り直せませんでした/);
  assert.equal(environment.rebuild.at, "2026-11-06T10:00:00.000Z", "the tick waits from the time of the failure");
  const build = landFailureCause(unbuilt("build"), null);
  assert.equal(build.kind, "real");
  assert.deepEqual(build.checks, []);
  assert.deepEqual(build.rebuild.paths, ["gen.txt", "gen2.txt"]);
  assert.match(build.rebuild.reason, /boom/, "the build's output rides along for the send-back");
  assert.equal(build.structural, undefined, "the merged sources decide it, not the head's tree: a mainline that moved is a new group");
  // a record with a merge commit was checked as it was, and is read as its checks say
  assert.equal(landFailureCause({ ...unbuilt("build"), mergeCommit: "x" }, null), null);
});

test("a failure is read by the tests it names against the round before's", () => {
  for (const [where, saved, kind, structural] of byNames) {
    const cause = landFailureCause(saved, null);
    assert.equal(cause.kind, kind, where);
    assert.equal(cause.structural, structural, where);
  }
});

test("a failure on tests that are not the round before's names the tests, and the checks of one in common", () => {
  const read = (checks, extra) => landFailureCause(rec(checks, extra), null);
  const moved = read([named("test:lane", "wait-run 1", "steer")], earlier("test:lane", "50 ms"));
  assert.match(moved.reason, /test:lane の落ちたテストが前の回と重なりません/);
  assert.match(moved.reason, /今回: wait-run 1、steer/);
  assert.match(moved.reason, /前の回: 50 ms/);
  assert.equal(moved.noResult, undefined);
  assert.match(read([named("test:lane", "a", "b", "c", "d", "e")], earlier("test:lane", "z")).reason, /今回: a、b、c ほか 2 件/);
  assert.deepEqual(read([named("test:lane", "a", "b")], earlier("test:lane", "b", "c")).checks.map((c) => c.name), ["test:lane"]);
});

test("a run that ended without a result beside a record of a rebuild is read only when it began after the record", () => {
  const earlier = landFailureCause(unbuilt("build"), run({ started_at: "2026-11-06T09:00:00.000Z" }));
  assert.equal(earlier.kind, "real", "the run belongs to an earlier try: the build's failure is the record's, and is sent back");
  assert.equal(earlier.noResult, undefined);
  assert.deepEqual(earlier.rebuild.paths, ["gen.txt", "gen2.txt"]);
  const later = landFailureCause(unbuilt("build"), run({ started_at: "2026-11-06T10:00:01.000Z" }));
  assert.equal(later.kind, "environment", "a run that began after the record died without a result: the group is tried again");
  assert.equal(later.noResult, true);
  assert.equal(landFailureCause(unbuilt("build"), run({ started_at: undefined })).kind, "real", "a run that says no start does not win over the record");
  // a record that ran its checks is read after its run, as it was
  assert.equal(landFailureCause(rec([pass("typecheck")]), run({ started_at: "2026-11-06T09:00:00.000Z" })).noResult, true);
});

test("the fold answers the failure's cause the TypeScript reading gives, over the same records and runs", () => {
  for (const [where, saved, checked] of [...cases, ...byNames.map(([w, saved]) => [w, saved, null])]) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(landFailureCause(saved, checked))),
      JSON.parse(JSON.stringify(landFailureCauseReference(saved, checked))),
      where,
    );
  }
});
