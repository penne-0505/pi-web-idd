import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { scratchDir } from "../../../idd-core/test/helpers/scratch.mjs";
register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE, roles: process.env.IDD_ROLES_FILE };
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const ev = (iddId, event, attrs = {}) => ({ idd_id: iddId, event, at: "2026-09-25T00:00:00Z", attrs });
const riskRows = (touches) => ["auth", "authz", "billing", "permission", "data_loss", "secret"].map((kind) => ({ kind, touches, reason: `${kind} の根拠。` }));
let root;

afterEach(() => {
  for (const [k, v] of [["IDD_STATE_DIR", saved.state], ["IDD_REPOS_FILE", saved.repos], ["IDD_ROLES_FILE", saved.roles]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

/** the registered repo, the lane's backlog row and its lifecycle; a planner worktree when asked for */
function setup({ ready = {}, planner = true, qaRisk = "Low", extraEvents = [], intentRows } = {}) {
  root = scratchDir("state-review-cards-");
  const state = join(root, "state");
  const worktree = join(root, "wt");
  mkdirSync(state);
  mkdirSync(worktree);
  put(join(worktree, "_docs/qa/Demo/idd-1/qa.md"), `---\nrisk: ${qaRisk}\n---\n\nbody\n`);
  const repos = join(root, "repos.yaml");
  put(repos, JSON.stringify({ repos: { Demo: { github: "test/project", upstream: join(root, "u"), work: join(root, "w"), public_base: "main", lanes_root: join(root, "lanes"), publish: false } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos });
  writeFileSync(join(state, "roles.yaml"), "roles:\n  r: { model: x/y }\npipeline:\n  review_blind: { roles: [r] }\n  triage: { role: r }\n");
  process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
  writeFileSync(join(state, "backlog.jsonl"), jsonl([{ idd_id: "IDD-1", created_at: "2026-09-25T00:00:00Z", source_type: "github", context: "", title: "T", area: "Demo" }]));
  if (planner) writeFileSync(join(state, "planner-sessions.jsonl"), jsonl([{ idd_id: "IDD-1", planner_session_id: "P-1", started_at: "2026-09-25T00:00:00Z", worktree_path: worktree, branch: "idd/IDD-1" }]));
  if (intentRows) writeFileSync(join(state, "intent-Demo.jsonl"), jsonl(intentRows));
  writeFileSync(join(state, "lifecycle-Demo.jsonl"), jsonl([ev("IDD-1", "lane_open"), ev("IDD-1", "s1_ready", ready), ev("IDD-1", "s1_plan_review_skipped", { reason: "no slot" }), ...extraEvents]));
  return { state, worktree };
}

const go = () => buildState().items.find((i) => i.kind === "go" && i.iddId === "IDD-1");

describe("the GO card's depth", () => {
  it("AC-009: is read the way the auto GO reads it, so a High lane declared shallow comes out deep", () => {
    setup({ ready: { depth: "shallow", risk_table: riskRows(false) }, qaRisk: "High" });
    const item = go();
    assert.ok(item);
    assert.equal(item.depth, "deep", "the lane's own Risk raises the depth");
    assert.equal(item.notAuto, undefined, "the engine does not hand a deep lane to a person");
  });

  it("AC-009: falls back to the recorded depth when the planner left no worktree", () => {
    setup({ ready: { depth: "shallow", risk_table: riskRows(false) }, planner: false });
    const item = go();
    assert.ok(item);
    assert.equal(item.depth, "shallow");
    assert.match(item.notAuto, /査読/, "the shallow lane is handed to a person with the reason");
  });
});

describe("the stuck card's open list", () => {
  it("AC-010: lists what the last judgement accepted by ref, and does not bring back a fix the judgement left unconfirmed", () => {
    setup({
      extraEvents: [
        ev("IDD-1", "s2_start"), ev("IDD-1", "s2_result", { outcome: "success" }),
        ev("IDD-1", "s2_review_started", { kind: "blind", round: 1, run_ids: ["b"], depth: "shallow", max_fix_rounds: 1, close_on: "must" }),
        ev("IDD-1", "s2_review_findings", { kind: "blind", round: 1, files: [] }),
        ev("IDD-1", "s2_triage_done", { kind: "blind", round: 1, accepted: [{ ref: "F-1", severity: "must", claim: "購読が残る", path: "a.ts", fix: "f" }] }),
        ev("IDD-1", "s2_fix_sent", { round: 1, refs: ["1-blind/F-1"] }),
        ev("IDD-1", "s2_result", { outcome: "success" }),
        ev("IDD-1", "s2_review_started", { kind: "blind", round: 2, run_ids: ["b2"] }),
        ev("IDD-1", "s2_review_findings", { kind: "blind", round: 2, files: [] }),
        ev("IDD-1", "s2_triage_done", { kind: "blind", round: 2, accepted: [{ ref: "F-2", severity: "must", claim: "2 件目", path: "b.ts", fix: "g" }], prior: [{ ref: "1-blind/F-1" }] }),
      ],
    });
    const card = buildState().items.find((i) => i.kind === "stuck");
    assert.ok(card);
    assert.match(card.reason, /上限/);
    assert.deepEqual(card.open.map((o) => [o.ref, o.claim]), [["2-blind/F-2", "2 件目"]]);
  });

  it("AC-001: reads penne's earlier correction in place, so a finding she put off is not listed again", () => {
    setup({
      extraEvents: [
        ev("IDD-1", "s2_start"), ev("IDD-1", "s2_result", { outcome: "success" }),
        ev("IDD-1", "s2_review_started", { kind: "blind", round: 1, run_ids: ["b"], depth: "shallow", max_fix_rounds: 1, close_on: "must" }),
        ev("IDD-1", "s2_review_findings", { kind: "blind", round: 1, files: [] }),
        ev("IDD-1", "s2_triage_done", { kind: "blind", round: 1, accepted: [
          { ref: "F-1", severity: "must", claim: "直す", path: "a.ts", fix: "f", action: "fix" },
          { ref: "F-2", severity: "must", claim: "後に回す", path: "b.ts", fix: "g", action: "fix" },
        ] }),
        ev("IDD-1", "s2_review_escalated", { reason: "x" }),
        ev("IDD-1", "s2_review_resumed", { decision: "continue", note: "", corrections: [{ ref: "1-blind/F-2", severity: "should", action: "followup", reason: "後の変更で扱う" }] }),
        ev("IDD-1", "s2_fix_sent", { round: 1, refs: ["1-blind/F-1"] }),
        ev("IDD-1", "s2_result", { outcome: "success" }),
        ev("IDD-1", "s2_review_started", { kind: "blind", round: 2, run_ids: ["b2"] }),
        ev("IDD-1", "s2_review_findings", { kind: "blind", round: 2, files: [] }),
        ev("IDD-1", "s2_triage_done", { kind: "blind", round: 2, accepted: [
          { ref: "F-3", severity: "must", claim: "同じ指摘の言い直し", path: "b.ts", fix: "g", action: "fix", correction_ref: "1-blind/F-2" },
          { ref: "F-4", severity: "must", claim: "新しい指摘", path: "c.ts", fix: "h", action: "fix" },
        ] }),
      ],
    });
    const card = buildState().items.find((i) => i.kind === "stuck");
    assert.ok(card);
    assert.deepEqual(card.open.map((o) => [o.ref, o.claim]), [["2-blind/F-4", "新しい指摘"]]);
  });
});

describe("the GO card's impact rows", () => {
  it("AC-012: a v2 Choice's title comes from the lane's own view of the state", () => {
    setup({
      ready: { intent_impact: { paths: ["lib/a.ts"], candidate_count: 1, rows: [{ id: "C-1-1", effect: "keep", reason: "購読の意図は変えない。" }] } },
      intentRows: [{
        event: "choice_raised", at: "2026-09-25T00:00:00Z", repo: "Demo", by: { lane: "IDD-1" },
        id: "C-1-1", purpose: "P-1", forms: { chosen: "購読は画面を離れたら止める", rejected: [] },
        place: [{ path: "lib/a.ts", kind: "file" }], why: "w", anchored: "a", status: "active",
      }],
    });
    const item = go();
    assert.ok(item);
    assert.equal(item.intentImpact.rows[0].title, "購読は画面を離れたら止める");
  });
});
