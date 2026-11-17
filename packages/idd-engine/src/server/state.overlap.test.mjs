import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";
register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const at = "2026-10-27T00:00:00Z";
const ev = (iddId, event, attrs = {}) => ({ idd_id: iddId, event, at, attrs });
const ready = (id, paths) => [ev(id, "lane_open"), ev(id, "s1_ready", { depth: "standard", intent_impact: { paths, candidate_count: 0, rows: [] } }), ev(id, "s1_plan_review_skipped", { reason: "no slot" })];
let root;

afterEach(() => {
  for (const [k, v] of [["IDD_STATE_DIR", saved.state], ["IDD_REPOS_FILE", saved.repos]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

/** lanes by id: their ready's declared paths (or the events as given), written as the state the engine reads */
function lanes(spec) {
  root = scratchDir("state-overlap-");
  mkdirSync(join(root, "w"));
  const state = join(root, "state");
  mkdirSync(state);
  const repos = join(root, "repos.yaml");
  mkdirSync(dirname(repos), { recursive: true });
  writeFileSync(repos, JSON.stringify({ repos: { Demo: { github: "test/project", upstream: join(root, "u"), work: join(root, "w"), public_base: "main", lanes_root: join(root, "lanes"), publish: false } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos });
  const rows = Object.entries(spec);
  writeFileSync(join(state, "backlog.jsonl"), jsonl(rows.map(([id, s]) => ({ idd_id: id, created_at: at, source_type: "github", context: s.context ?? "", title: `${id} の題`, area: s.area ?? "Demo" }))));
  const sessions = rows.map(([id]) => {
    const worktree = join(root, `wt-${id}`);
    mkdirSync(worktree);
    for (const f of spec[id].own ?? []) {
      mkdirSync(dirname(join(worktree, f)), { recursive: true });
      writeFileSync(join(worktree, f), "");
    }
    return { idd_id: id, planner_session_id: `P-${id}`, started_at: at, worktree_path: worktree, branch: `idd/${id}` };
  });
  writeFileSync(join(state, "planner-sessions.jsonl"), jsonl(sessions));
  writeFileSync(join(state, "lifecycle-Demo.jsonl"), jsonl(rows.flatMap(([id, s]) => s.events ?? ready(id, s.paths ?? []))));
  return buildState();
}

const goOf = (s, id) => s.items.find((i) => i.kind === "go" && i.iddId === id);

describe("the GO card and the open lanes that declared the same place", () => {
  it("shows the other lane and the shared path on both lanes' cards (AC-001, AC-002)", () => {
    const s = lanes({ "IDD-1": { paths: ["a/x.ts", "a/y.ts"] }, "IDD-2": { paths: ["a/x.ts"] } });
    const first = goOf(s, "IDD-1");
    const second = goOf(s, "IDD-2");
    assert.deepEqual(first.overlaps, [{ lane: "IDD-2", title: "IDD-2 の題", provisional: false, hits: [{ path: "a/x.ts", other: "a/x.ts", kind: "same" }], more: 0 }]);
    assert.deepEqual(second.overlaps, [{ lane: "IDD-1", title: "IDD-1 の題", provisional: false, hits: [{ path: "a/x.ts", other: "a/x.ts", kind: "same" }], more: 0 }]);
  });

  it("shows a dir against a path inside it, and two files in one dir (AC-004)", () => {
    const s = lanes({ "IDD-1": { paths: ["lib/"] }, "IDD-2": { paths: ["lib/x.ts", "docs/new-a.md"] }, "IDD-3": { paths: ["docs/new-b.md"] } });
    assert.deepEqual(goOf(s, "IDD-1").overlaps.map((o) => [o.lane, o.hits[0].kind]), [["IDD-2", "nested"]]);
    assert.deepEqual(goOf(s, "IDD-2").overlaps.map((o) => [o.lane, o.hits.map((h) => h.kind)]), [["IDD-1", ["nested"]], ["IDD-3", ["sibling"]]]);
  });

  it("tells a sibling to both lanes whatever a lane's own worktree or the mainline holds", () => {
    const s = lanes({ "IDD-1": { paths: ["docs/new-a.md"], own: ["docs/new-a.md"] }, "IDD-2": { paths: ["docs/new-b.md"] } });
    assert.deepEqual(goOf(s, "IDD-1").overlaps.map((o) => [o.lane, o.hits.map((h) => h.kind)]), [["IDD-2", ["sibling"]]]);
    assert.deepEqual(goOf(s, "IDD-2").overlaps.map((o) => [o.lane, o.hits.map((h) => h.kind)]), [["IDD-1", ["sibling"]]]);
  });

  it("does not compare lanes of another area (F-1)", () => {
    const s = lanes({ "IDD-1": { paths: ["README.md"] }, "IDD-2": { paths: ["README.md"], area: "Other" } });
    assert.equal("overlaps" in goOf(s, "IDD-1"), false);
    assert.equal("overlaps" in goOf(s, "IDD-2"), false);
  });

  it("marks a pair provisional when a lane declared nothing and its Issue names the path (AC-003)", () => {
    const s = lanes({ "IDD-1": { paths: ["a/x.ts"] }, "IDD-2": { paths: [], context: "`a/x.ts` を直す" } });
    assert.equal(goOf(s, "IDD-1").overlaps[0].provisional, true);
  });

  it("reads a top-level file an Issue names for a lane with no declaration (F-2)", () => {
    const s = lanes({ "IDD-1": { paths: ["README.md"] }, "IDD-2": { paths: [], context: "`README.md` を直す" } });
    assert.deepEqual(goOf(s, "IDD-1").overlaps.map((o) => [o.lane, o.provisional]), [["IDD-2", true]]);
  });

  it("shows nothing for a closed lane's declaration, or when no place is shared (AC-005)", () => {
    const closed = [...ready("IDD-2", ["a/x.ts"]), ev("IDD-2", "lane_close", { outcome: "merged" })];
    const s = lanes({ "IDD-1": { paths: ["a/x.ts"] }, "IDD-2": { events: closed }, "IDD-3": { paths: ["c/z.ts"] } });
    assert.equal("overlaps" in goOf(s, "IDD-1"), false);
    assert.equal("overlaps" in goOf(s, "IDD-3"), false);
  });

  it("changes no stage, order, GO or auto-GO verdict against the same lanes with no overlap (AC-006)", () => {
    const shape = (s) => ({
      lanes: s.lanes.map((l) => [l.iddId, l.group, l.decision, l.stageDone, l.blockedBy]),
      go: s.items.filter((i) => i.kind === "go").map((i) => [i.iddId, i.depth, i.notAuto, i.blockedBy]),
    });
    const withOverlap = shape(lanes({ "IDD-1": { paths: ["a/x.ts"] }, "IDD-2": { paths: ["a/x.ts"] } }));
    rmSync(root, { recursive: true, force: true });
    const without = shape(lanes({ "IDD-1": { paths: ["a/x.ts"] }, "IDD-2": { paths: ["b/y.ts"] } }));
    assert.deepEqual(withOverlap, without);
  });
});
