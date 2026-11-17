import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";
register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState, buildLaneDetail } = await import("./state.ts");

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const ev = (iddId, event, attrs = {}) => ({ idd_id: iddId, event, at: "2026-09-25T00:00:00Z", attrs });
let root;

afterEach(() => {
  for (const [k, v] of [["IDD_STATE_DIR", saved.state], ["IDD_REPOS_FILE", saved.repos]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

/** a lane waiting at GO, its planner worktree holding the record documents the card reads titles from */
function laneAtGo(readyAttrs = {}) {
  root = scratchDir("state-impact-");
  const state = join(root, "state");
  const worktree = join(root, "wt");
  mkdirSync(state);
  mkdirSync(worktree);
  put(join(worktree, "_docs/intent/other/lane/decision.md"), "# other\n\n## Decisions\n\n### DEC-500: 保存の前に確認を挟む\n\n- **Why**: 取り消せない削除を防ぐため。\n- **Anchors**: `src/save.ts`\n\n### DEC-501: 表示の値を丸める\n\n- **Why**: 端の値を安定させるため。\n- **Anchors**: `src/view.ts`\n");
  const repos = join(root, "repos.yaml");
  put(repos, JSON.stringify({ repos: { Demo: { github: "test/project", upstream: join(root, "u"), work: join(root, "w"), public_base: "main", lanes_root: join(root, "lanes"), publish: false } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos });
  writeFileSync(join(state, "backlog.jsonl"), jsonl([{ idd_id: "IDD-1", created_at: "2026-09-25T00:00:00Z", source_type: "github", context: "", title: "T", area: "Demo" }]));
  writeFileSync(join(state, "planner-sessions.jsonl"), jsonl([{ idd_id: "IDD-1", planner_session_id: "P-1", started_at: "2026-09-25T00:00:00Z", worktree_path: worktree, branch: "idd/IDD-1" }]));
  writeFileSync(join(state, "lifecycle-Demo.jsonl"), jsonl([ev("IDD-1", "lane_open"), ev("IDD-1", "s1_ready", readyAttrs), ev("IDD-1", "s1_plan_review_skipped", { reason: "no slot" })]));
  return { state, worktree };
}

const go = () => buildState().items.find((i) => i.kind === "go" && i.iddId === "IDD-1");

describe("the impact on existing intent on the GO card and the lane detail", () => {
  it("shows the rows with their titles read from the records, and the candidate count (AC-009)", async () => {
    laneAtGo({
      intent_impact: {
        paths: ["src/save.ts", "src/view.ts"],
        candidate_count: 2,
        rows: [
          { id: "DEC-500", effect: "change_why", reason: "確認を外すので Why を更新する。" },
          { id: "DEC-501", effect: "keep", reason: "丸めの意図は変えない。" },
          { id: "DEC-777", effect: "keep", reason: "Anchors に無いが関係する。", outside_candidates: true },
        ],
      },
    });
    const item = go();
    assert.ok(item);
    assert.equal(item.intentImpact.count, 2);
    assert.equal(item.intentImpact.rows.length, 3);
    assert.equal(item.intentImpact.rows[0].title, "保存の前に確認を挟む");
    assert.equal(item.intentImpact.rows[0].effect, "change_why");
    assert.equal(item.intentImpact.rows[1].title, "表示の値を丸める");
    assert.equal(item.intentImpact.rows[2].title, undefined, "a DEC no document holds keeps its number alone");
    assert.equal(item.intentImpact.rows[2].outsideCandidates, true);
    const detail = await buildLaneDetail("IDD-1");
    assert.deepEqual(detail.intentImpact, item.intentImpact);
  });

  it("shows an empty list with its count, rather than nothing, when the planner judged none (AC-009)", () => {
    laneAtGo({ intent_impact: { paths: [], candidate_count: 0, rows: [] } });
    const item = go();
    assert.deepEqual(item.intentImpact, { count: 0, paths: [], rows: [] });
  });

  it("shows no field at all on a ready that came without one (AC-010)", async () => {
    laneAtGo({});
    const item = go();
    assert.ok(item);
    assert.equal(item.intentImpact, undefined);
    assert.equal((await buildLaneDetail("IDD-1")).intentImpact, undefined);
  });
});
