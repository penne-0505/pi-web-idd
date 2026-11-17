import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");
const { setAgentRunner, agentAskQuestions, settleQuestionRouting } = await import("@idd/core");

let dir;
let worktree;
const now = () => new Date().toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-state-route-"));
  process.env.IDD_STATE_DIR = dir;
  worktree = join(dir, "wt");
  mkdirSync(worktree);
  writeFileSync(join(dir, "backlog.jsonl"), JSON.stringify({
    idd_id: "IDD-1", parent_id: null, created_at: "2026-09-24T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null,
    source_type: "github", context: "件名は type(scope): 一文 の形で書く。", title: "IDD-1 の題名", area: "test-area",
  }) + "\n", "utf8");
  writeFileSync(join(dir, "planner-sessions.jsonl"), JSON.stringify({ idd_id: "IDD-1", planner_session_id: "p1", started_at: now(), worktree_path: worktree, branch: "idd/idd-1" }) + "\n", "utf8");
  writeFileSync(join(dir, "lifecycle-test.jsonl"), JSON.stringify({ idd_id: "IDD-1", event: "lane_open", at: now() }) + "\n", "utf8");
});

afterEach(() => {
  setAgentRunner(null);
  delete process.env.IDD_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const question = (id) => ({ question_id: id, question: `質問 ${id}`, context: "", options: [{ index: 1, label: "A" }, { index: 2, label: "B" }] });
const cards = () => buildState().items.filter((i) => i.kind === "question");
const verdict = (id, decider) => ({ question_id: id, decider, kind: decider === "self" ? "settled" : "scope", option_index: 1, reason: "r", evidence: decider === "self" ? [{ source: "issue", ref: "", quote: "件名は type(scope): 一文 の形で書く" }] : [] });

describe("the question card of a batch the judge reads (C-256-8)", () => {
  it("has no card while the judge reads, and one for the question the records do not decide once it is done", async () => {
    let during = null;
    setAgentRunner({
      deliver: async () => {},
      questionRouting: () => ({ role: "question-router", model: "x/y" }),
      routeQuestions: async () => {
        during = cards().length;
        return { text: JSON.stringify({ answers: [verdict("q1", "self"), verdict("q2", "human")] }), role: "question-router", model: "x/y" };
      },
      kickTick: () => {},
    });
    assert.deepEqual(await agentAskQuestions({ iddId: "IDD-1", batchId: "b1", questions: [question("q1"), question("q2")] }), { ok: true });
    assert.equal(cards().length, 0, "right after the report");
    await settleQuestionRouting();
    assert.equal(during, 0, "while the judge reads");
    const after = cards();
    assert.equal(after.length, 1);
    assert.deepEqual(after[0].open.map((q) => q.questionId), ["q2"], "only the question a person decides");
  });

  it("comes out whole when the judge fails, and at once when the judge is off", async () => {
    setAgentRunner({ deliver: async () => {}, questionRouting: () => ({ role: "r", model: "m" }), routeQuestions: async () => { throw new Error("pi が起動できない"); } });
    await agentAskQuestions({ iddId: "IDD-1", batchId: "b1", questions: [question("q1"), question("q2")] });
    await settleQuestionRouting();
    assert.deepEqual(cards()[0].open.map((q) => q.questionId), ["q1", "q2"]);

    rmSync(join(dir, "pending-questions.jsonl"));
    setAgentRunner({ deliver: async () => {}, questionRouting: () => null });
    await agentAskQuestions({ iddId: "IDD-1", batchId: "b2", questions: [question("q3")] });
    assert.equal(cards().some((c) => c.open.some((q) => q.questionId === "q3")), true);
  });
});
