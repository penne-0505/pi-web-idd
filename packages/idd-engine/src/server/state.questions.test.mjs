import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");

let dir;

const lane = {
  idd_id: "IDD-1",
  parent_id: null,
  created_at: "2026-09-24T00:00:00Z",
  linear_issue_url: null,
  gh_issue_url: null,
  pull_req_url: null,
  source_type: "github",
  context: "",
  title: "IDD-1 の題名",
  area: "test-area",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-state-q-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "backlog.jsonl"), JSON.stringify(lane) + "\n", "utf8");
  writeFileSync(join(dir, "pending-questions.jsonl"), JSON.stringify({
    idd_id: "IDD-1",
    batch_id: "b1",
    asked_at: "2026-09-24T00:00:00Z",
    questions: [{
      question_id: "q1",
      question: "どちらにしますか",
      context: "",
      options: [
        { index: 1, label: "A", description: "A を選ぶとこうなる。", recommendation: "recommended", rationale: "README と一致する。" },
        { index: 2, label: "B", recommendation: "not_recommended", rationale: "CI で落ちる。" },
        { index: 3, label: "C", description: "C を選ぶとこうなる。" },
      ],
    }],
  }) + "\n", "utf8");
});

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("question card options", () => {
  it("carry the description, level and rationale the agent gave, and nothing for the older form", () => {
    const card = buildState().items.find((i) => i.kind === "question");
    assert.ok(card);
    assert.deepEqual(card.open[0].options, [
      { index: 1, label: "A", description: "A を選ぶとこうなる。", recommendation: "recommended", rationale: "README と一致する。" },
      { index: 2, label: "B", recommendation: "not_recommended", rationale: "CI で落ちる。" },
      { index: 3, label: "C", description: "C を選ぶとこうなる。" },
    ]);
  });
});

describe("a batch the mechanism answered in part", () => {
  const two = (rows) => {
    const batch = JSON.parse(readFileSync(join(dir, "pending-questions.jsonl"), "utf8"));
    batch.questions.push({ question_id: "q2", question: "もう 1 つ", context: "", options: [{ index: 1, label: "X" }, { index: 2, label: "Y" }] });
    writeFileSync(join(dir, "pending-questions.jsonl"), JSON.stringify(batch) + "\n");
    writeFileSync(join(dir, "pending-answers.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  };
  const routed = (id) => ({
    idd_id: "IDD-1", batch_id: "b1", question_id: id, answered_at: "2026-09-24T00:01:00Z", selection: { index: 1, label: "A" }, reason: "r", notes: null,
    answered_by: "router", router: { role: "question-router", model: "x/y" }, basis: [{ source: "issue", ref: "", quote: "引用の文を写す" }],
  });

  it("AC-002: the card asks only the question left", () => {
    two([routed("q1")]);
    const card = buildState().items.find((i) => i.kind === "question");
    assert.deepEqual(card.open.map((q) => q.questionId), ["q2"]);
    assert.equal(card.answeredCount, 1);
    assert.equal(card.askedTotal, 2);
  });

  it("AC-001: no card is made once the mechanism answered every question", () => {
    two([routed("q1"), routed("q2")]);
    assert.equal(buildState().items.some((i) => i.kind === "question"), false);
  });
});

describe("a column of the answers or the questions that cannot be read", () => {
  const questionCards = () => buildState().items.filter((i) => i.kind === "question");
  const answered = { idd_id: "IDD-1", batch_id: "b1", question_id: "q1", answered_at: "2026-09-24T00:01:00Z", selection: { index: 1, label: "A" }, reason: null, notes: null };

  it("lists no answered question as open, still answers with the lanes, and lists the batch again once the column can be read", () => {
    writeFileSync(join(dir, "pending-answers.jsonl"), JSON.stringify(answered) + "\n");
    assert.equal(questionCards().length, 0, "answered before the column broke: no card");
    rmSync(join(dir, "pending-answers.jsonl"));
    mkdirSync(join(dir, "pending-answers.jsonl"));
    const state = buildState();
    assert.equal(state.lanes.some((l) => l.iddId === "IDD-1"), true, "the lanes are still answered");
    assert.equal(state.items.some((i) => i.kind === "question"), false, "and the batch is not read as open on no answers");
    rmSync(join(dir, "pending-answers.jsonl"), { recursive: true });
    assert.deepEqual(questionCards().map((c) => c.open.map((q) => q.questionId)), [["q1"]], "readable again: the question with no answer is listed");
  });

  it("answers with the lanes while the questions' column cannot be read, and lists the batch again once it can", () => {
    const rows = readFileSync(join(dir, "pending-questions.jsonl"), "utf8");
    rmSync(join(dir, "pending-questions.jsonl"));
    mkdirSync(join(dir, "pending-questions.jsonl"));
    const state = buildState();
    assert.equal(state.lanes.some((l) => l.iddId === "IDD-1"), true);
    assert.equal(state.items.some((i) => i.kind === "question"), false);
    rmSync(join(dir, "pending-questions.jsonl"), { recursive: true });
    writeFileSync(join(dir, "pending-questions.jsonl"), rows);
    assert.equal(questionCards().length, 1);
  });

  it("names the unreadable column on the state and on the lane in the question stage, and says nothing once it can be read", () => {
    writeFileSync(join(dir, "lifecycle-test.jsonl"), JSON.stringify({ idd_id: "IDD-1", event: "question_batch_asked", at: "2026-09-24T00:00:01.000Z", attrs: { batch_id: "b1", question_ids: ["q1"] } }) + "\n");
    const row = (state) => state.lanes.find((l) => l.iddId === "IDD-1");
    assert.deepEqual(buildState().unreadableColumns, []);
    assert.equal(row(buildState()).decision, "question");
    assert.doesNotMatch(row(buildState()).blockedBy ?? "", /読めない/);
    for (const [file, column] of [["pending-answers.jsonl", "答えの列"], ["pending-questions.jsonl", "質問の列"]]) {
      const had = existsSync(join(dir, file));
      const rows = had ? readFileSync(join(dir, file), "utf8") : "";
      if (had) rmSync(join(dir, file));
      mkdirSync(join(dir, file));
      const state = buildState();
      assert.deepEqual(state.unreadableColumns, [column]);
      assert.match(row(state).blockedBy ?? "", new RegExp(`${column}を読めない`), "the lane says why it shows no question");
      rmSync(join(dir, file), { recursive: true });
      if (had) writeFileSync(join(dir, file), rows);
    }
    assert.deepEqual(buildState().unreadableColumns, []);
    assert.equal(buildState().items.filter((i) => i.kind === "question").length, 1);
  });

  it("names a column that is a link to nothing as unreadable, with the same reading behind the lane's note and the list", () => {
    const path = join(dir, "pending-answers.jsonl");
    const had = existsSync(path);
    const rows = had ? readFileSync(path, "utf8") : "";
    if (had) rmSync(path);
    symlinkSync(join(dir, "nowhere.jsonl"), path);
    const state = buildState();
    assert.deepEqual(state.unreadableColumns, ["答えの列"]);
    assert.equal(state.items.some((i) => i.kind === "question"), false, "and the list leaves the batch out");
    rmSync(path);
    if (had) writeFileSync(path, rows);
    assert.deepEqual(buildState().unreadableColumns, []);
  });

  it("is not a fault when the column is not there yet or is empty: the state is as before", () => {
    rmSync(join(dir, "pending-questions.jsonl"));
    assert.equal(buildState().items.some((i) => i.kind === "question"), false);
    writeFileSync(join(dir, "pending-answers.jsonl"), "");
    assert.equal(buildState().lanes.some((l) => l.iddId === "IDD-1"), true);
  });
});
