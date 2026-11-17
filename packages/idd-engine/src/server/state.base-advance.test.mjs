import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");

let dir;

function state(events, extra = {}) {
  dir = mkdtempSync(join(tmpdir(), "idd-state-advance-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-1", parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: null, gh_issue_url: "https://github.com/o/r/issues/3", pull_req_url: null, source_type: "github", context: "", title: "T", area: "Demo" }) + "\n");
  writeFileSync(join(dir, "lifecycle-Demo.jsonl"), events.map(([event, attrs = {}, at = "2026-09-25T00:00:00Z"]) => JSON.stringify({ idd_id: "IDD-1", event, at, attrs })).join("\n") + "\n");
  if (extra.ignores) writeFileSync(join(dir, "intake-ignores.jsonl"), extra.ignores.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return buildState();
}

const planned = [["lane_open"], ["s1_ready"], ["s1_plan_review_skipped"]];
const advanced = (files, total = files.length, known = true) => ["s1_base_advanced", { from: "aaa", to: "bbbbbbbbbbbb", files, files_total: total, known }, "2026-09-26T09:00:00Z"];

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the GO card and the move of the work branch", () => {
  it("shows nothing when nothing was recorded", () => {
    const go = state(planned).items.find((i) => i.kind === "go");
    assert.equal(go.baseAdvance, undefined);
  });

  it("shows the recorded move, from the record alone", () => {
    const plain = state(planned).lanes[0].elapsed;
    rmSync(dir, { recursive: true, force: true });
    const s = state([...planned, advanced(["src/a.ts"]), advanced(["src/a.ts", "lib/b.ts"])]);
    const go = s.items.find((i) => i.kind === "go");
    assert.deepEqual(go.baseAdvance, { to: "bbbbbbbbbbbb", files: ["src/a.ts", "lib/b.ts"], more: 0, known: true });
    // the lane is where it was: waiting at GO, its time from the event before the record
    const row = s.lanes.find((l) => l.iddId === "IDD-1");
    assert.equal(row.group, "judge");
    assert.equal(row.decision, "go");
    assert.equal(row.stageDone, 2);
    assert.equal(row.blockedBy, undefined);
    assert.equal(row.elapsed, plain);
  });

  it("says how many files are not listed, and that any change counts when the plan names no place", () => {
    const go = state([...planned, advanced(["x.ts"], 60, false)]).items.find((i) => i.kind === "go");
    assert.deepEqual(go.baseAdvance, { to: "bbbbbbbbbbbb", files: ["x.ts"], more: 59, known: false });
  });

  it("drops a move recorded before the plan was made again", () => {
    const later = "2026-09-26T10:00:00Z";
    const go = state([...planned, advanced(["src/a.ts"]), ["s1_revise_requested", { instruction: "x" }, later], ["s1_ready", {}, later], ["s1_plan_review_skipped", {}, later]]).items.find((i) => i.kind === "go");
    assert.equal(go.baseAdvance, undefined);
  });
});

describe("which time a card came", () => {
  it("a GO card carries when the lane came to GO, which a record of the work branch does not move and a new plan does", () => {
    const came = "2026-09-25T01:00:00Z";
    const first = state([["lane_open"], ["s1_ready"], ["s1_plan_review_skipped", {}, came], advanced(["src/a.ts"])]).items.find((i) => i.kind === "go");
    assert.equal(first.appearedAt, came);
    rmSync(dir, { recursive: true, force: true });
    const later = "2026-09-26T10:00:00Z";
    const again = state([["lane_open"], ["s1_ready"], ["s1_plan_review_skipped", {}, came], ["s1_revise_requested", { instruction: "x" }, later], ["s1_ready", {}, later], ["s1_plan_review_skipped", {}, later]]).items.find((i) => i.kind === "go");
    assert.equal(again.appearedAt, later);
  });
});

describe("the ignore list in the state", () => {
  it("lists the Issues on the list, newest line deciding", () => {
    const line = (action, ref, url, at, extra = {}) => ({ action, source: "github", url, ref, title: `title ${ref}`, area: "o/r", at, at_by: "user", ...extra });
    const s = state(planned, { ignores: [
      line("ignore", "#3", "https://github.com/o/r/issues/3", "2026-09-26T09:00:00+09:00", { at_by: "s1_defer", lane: "IDD-1" }),
      line("ignore", "#4", "https://github.com/o/r/issues/4", "2026-09-26T09:01:00+09:00"),
      line("unignore", "#4", "https://github.com/o/r/issues/4", "2026-09-26T09:02:00+09:00"),
    ] });
    assert.deepEqual(s.ignores.map((i) => [i.ref, i.title, i.by, i.lane]), [["#3", "title #3", "s1_defer", "IDD-1"]]);
    // the lane of an ignored Issue is not touched
    assert.equal(s.lanes[0].decision, "go");
  });
});
