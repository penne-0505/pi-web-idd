/**
 * The mechanism that answers a planner's questions the records decide: what the engine checks of the judge's quotes
 * (AC-003), what it never lets through (AC-004), what happens when the judge cannot be used (AC-005), and the close of
 * a batch the mechanism answered (AC-001).
 */
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAutoGo } from "../src/plan/auto-go.ts";
import { runResume } from "../src/plan/resume.ts";
import { withLaneGate } from "../src/ledger/gate.ts";
import { setAgentRunner } from "../src/agent/port.ts";
import { agentAskQuestions } from "../src/agent/inbound.ts";
import { RouteFailed, routeOnAsk, basisOf, buildRoutingMaterial, MATERIAL_BYTES_MAX, RECLOSE_LONG_MS, renderedBytes, evidenceHolds, finishQuestionBatches, inPlanning, judgeRouting, parseRouterOutput, routedDecisions, settleQuestionRouting } from "../src/agent/question-routing.ts";
import * as intentStore from "../src/intent/store.ts";
import { clearCostCache, laneCost } from "../src/plan/budget.ts";
import { AnswerColumnUnreadable, readAnswers, readLifecycle, readQuestionBatches, unreadableAnswerColumns } from "../src/ledger/read.ts";
import { appendAnswer, applyDecision, answerResultOf, closeAnsweredBatch, finishAnsweredBatches, recordAskedBatch, recordRoutedBatch, transition } from "../src/ledger/write.ts";
import { deriveStage } from "../src/ledger/derive.ts";
import { heldBatches, holdBatch, routingHoldPath, routingHoldReason } from "../src/ledger/routing-hold.ts";
import { goBlockedReason } from "../src/ledger/blockers.ts";
import { readRoutedDecisions } from "../src/ledger/routed-answers.ts";
import { readOpenQuestions } from "../src/plan/ledger-reads.ts";

const made = [];
const ENV_KEYS = ["IDD_STATE_DIR", "IDD_REPOS_FILE", "IDD_LANE_GATE_WAIT_MS"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  setAgentRunner(null);
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ISSUE = "依頼: 質問の振り分けを足す。件名は type(scope): 一文 の形で書く。範囲は計画役の質問だけにする。";
const NORM = "# 規範\n\n件名は `<type>(<scope>): <一文>` の形で書く。\n判断の理由は本文へ書く。\n";
const QUOTE = "件名は type(scope): 一文 の形で書く";
const T0 = "2026-10-28T00:00:00Z";

const rec = { idd_id: "IDD-1", area: "me/app", title: "質問の振り分け", context: ISSUE, gh_issue_url: "https://github.com/me/app/issues/1", created_at: T0 };

const question = (id, over = {}) => ({
  question_id: id,
  question: `質問 ${id}`,
  context: "",
  options: [{ index: 1, label: "案 A" }, { index: 2, label: "案 B" }],
  ...over,
});

const jl = (row) => `${JSON.stringify(row)}\n`;
/** append one row to a file of the state dir */
const put = (state, file, row) => appendFileSync(join(state, file), jl(row));
const session = (worktree, key, id) => ({ idd_id: "IDD-1", [key]: id, started_at: T0, worktree_path: worktree, branch: "idd/idd-1" });

function setup({ batchAsks = [["q1", "q2"]], events = ["lane_open"], executor = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "idd-qrouting-"));
  made.push(root);
  const state = join(root, "state");
  const worktree = join(root, "wt");
  for (const d of [state, join(worktree, "_docs", "standards")]) mkdirSync(d, { recursive: true });
  const files = {
    [join(worktree, "_docs", "standards", "commit.md")]: NORM,
    [join(worktree, "OUTSIDE.md")]: "規範の外のファイルの文は、ここにだけ在る。",
    [join(root, "repos.yaml")]: JSON.stringify({ repos: { "me/app": { upstream: join(root, "u"), work: join(root, "w"), public_base: "main" } } }),
    [join(state, "backlog.jsonl")]: jl(rec),
    [join(state, "planner-sessions.jsonl")]: jl(session(worktree, "planner_session_id", "p1")),
    ...(executor ? { [join(state, "executor-sessions.jsonl")]: jl(session(worktree, "executor_session_id", "e1")) } : {}),
  };
  for (const [file, text] of Object.entries(files)) writeFileSync(file, text);
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, "repos.yaml") });
  let tick = 0;
  const at = () => `2026-10-28T01:${String(tick++).padStart(2, "0")}:00.000Z`;
  const seed = (event, attrs = {}) => put(state, "lifecycle-test.jsonl", { idd_id: "IDD-1", event, at: at(), attrs });
  for (const e of events) seed(e);
  batchAsks.forEach((ids, i) => {
    seed("question_batch_asked", { batch_id: `B-${i + 1}` });
    put(state, "pending-questions.jsonl", { idd_id: "IDD-1", batch_id: `B-${i + 1}`, asked_at: at(), questions: ids.map((id) => question(id)) });
  });
  return { root, state, worktree, seed };
}

const material = (worktree, extra = {}) => ({
  choices: [{ id: "C-1-1", chosen: "件名は type(scope) の形にする", why: "履歴を引きやすくするため", anchored: "件名は type(scope): 一文 の形で書く。", free: "本文の長さは自由。" }],
  issue: ISSUE,
  worktree,
  ...extra,
});

const batchOf = (...ids) => ({ idd_id: "IDD-1", batch_id: "B-1", asked_at: "2026-10-28T01:00:00Z", questions: ids.map((id) => question(id)) });

const verdict = (id, over = {}) => ({
  questionId: id,
  decider: "self",
  kind: "settled",
  optionIndex: 1,
  reason: "記録で決まる",
  evidence: [{ source: "issue", ref: "", quote: QUOTE }],
  ...over,
});

const BY = { role: "question-router", model: "x/y" };

/** a quote the way the judge names it */
const cite = (source, ref, quote) => ({ source, ref, quote });
/** the verdicts of the judge over a batch, said to be all a person's */
const allPerson = (verdicts, batch, m) => judgeRouting(verdicts, batch, m, BY).every((o) => "person" in o);
/** the material of a fresh lane */
const freshMaterial = (extra) => material(setup().worktree, extra);

test("AC-003: a quote in one field of a Choice the material holds, in the Issue, or in a norm under _docs/standards/ is found", () => {
  const m = freshMaterial();
  assert.deepEqual(basisOf(cite("choice", "C-1-1", "履歴を引きやすくするため"), m), { source: "choice", ref: "C-1-1", field: "why", quote: "履歴を引きやすくするため" });
  for (const [c, key, want] of [
    [cite("choice", "C-1-1", "件名は type(scope): 一文 の形で書く。"), "field", "anchored"],
    [cite("issue", "", "範囲は計画役の質問だけにする"), "source", "issue"],
    [cite("norm", "_docs/standards/commit.md", "判断の理由は本文へ書く。"), "ref", "_docs/standards/commit.md"],
  ]) assert.equal(basisOf(c, m)?.[key], want);
});

test("AC-003: evidenceHolds says whether a quote is found", () => {
  const m = freshMaterial();
  assert.equal(evidenceHolds(cite("issue", "", "範囲は計画役の質問だけにする"), m), true);
  assert.equal(evidenceHolds(cite("issue", "", "Issue にない長めの引用の文章です"), m), false);
});

test("AC-003: whitespace is folded, so a quote across a line break of one field is found", () => {
  assert.ok(basisOf(cite("issue", "", QUOTE), freshMaterial({ issue: "依頼: 件名は type(scope):\n   一文 の形で書く" })));
});

test("AC-003: a Choice the material does not hold, a quote over two fields, and a quote that is not there are not found", () => {
  const m = freshMaterial();
  assert.equal(basisOf(cite("choice", "C-9-9", "履歴を引きやすくするため"), m), null, "a Choice the material does not hold");
  // the end of `chosen` and the start of `why`, each real, joined as one string
  assert.equal(basisOf(cite("choice", "C-1-1", "件名は type(scope) の形にする 履歴を引きやすくするため"), m), null, "a quote over two fields");
  for (const [why, quote] of [["a quote that is not there", "どこにも書かれていない長めの文である"], ["a quote of the Issue named as a Choice's", "範囲は計画役の質問だけにする"]]) assert.equal(basisOf(cite("choice", "C-1-1", quote), m), null, why);
});

test("AC-003: a norm outside _docs/standards/, a path that climbs out, an absolute path, a symlink and a short quote are not found", () => {
  const { worktree, root } = setup();
  const m = material(worktree);
  writeFileSync(join(root, "secret.md"), "worktree の外の文は、ここにだけ在る。");
  symlinkSync(join(root, "secret.md"), join(worktree, "_docs", "standards", "link.md"));
  const outside = "規範の外のファイルの文は、ここにだけ在る";
  for (const [why, ref] of [["outside the norms", "OUTSIDE.md"], ["a path that climbs out", "_docs/standards/../../OUTSIDE.md"]]) assert.equal(basisOf(cite("norm", ref, outside), m), null, why);
  const normQuote = "判断の理由は本文へ書く。";
  assert.equal(basisOf(cite("norm", join(worktree, "_docs/standards/commit.md"), normQuote), m), null, "an absolute path");
  assert.equal(basisOf(cite("norm", "_docs/standards/link.md", "worktree の外の文は、ここにだけ在る"), m), null, "a symlink");
  assert.equal(basisOf(cite("norm", "_docs/standards/commit.md", "本文へ書く"), m), null, "a quote under the minimum length proves nothing");
});

test("AC-003: a verdict whose quote is not found, or whose option the question does not have, goes to a person", () => {
  const m = freshMaterial();
  const out = judgeRouting([
    verdict("q1", { evidence: [cite("issue", "", "Issue のどこにも無い長めの引用の文")] }),
    verdict("q2", { optionIndex: 3 }),
    verdict("q3", { evidence: [] }),
  ], batchOf("q1", "q2", "q3"), m, BY);
  assert.ok(out.every((o) => "person" in o), JSON.stringify(out));
  out.forEach((o, i) => assert.match(o.person, [/引用を確かめられなかった/, /選択肢/, /根拠が無い/][i]));
});

test("AC-003: options are numbered from 1 and the answer names the option the question has", () => {
  const m = freshMaterial();
  const [o] = judgeRouting([verdict("q1", { optionIndex: 2 })], batchOf("q1"), m, BY);
  assert.deepEqual(o.answer.selection, { index: 2, label: "案 B" });
  assert.equal(o.answer.basis[0].source, "issue");
  assert.deepEqual(o.answer.by, BY);
  const [zero] = judgeRouting([verdict("q1", { optionIndex: 0 })], batchOf("q1"), m, BY);
  assert.ok("person" in zero, "an index the question does not have is not an answer");
});

test("AC-004: a kind a person keeps, or a judge that doubts, is a person's even when the quote is real", () => {
  const m = freshMaterial();
  const judged = (over) => judgeRouting([verdict("q1", over)], batchOf("q1"), m, BY)[0];
  for (const kind of ["scope", "priority", "visible", "irreversible", "against_decision", "signature"]) assert.ok("person" in judged({ kind }), `${kind} goes to a person`);
  assert.deepEqual(judged({ decider: "human", reason: "迷う" }), { questionId: "q1", person: "迷う" });
  assert.ok("answer" in judged({}));
});

test("AC-004: no word of the question's own text decides the kind; only the judge's kind and decider do", () => {
  const batch = { ...batchOf("q1"), questions: [question("q1", { question: "データを削除して公開しますか", options: [{ index: 1, label: "削除する" }, { index: 2, label: "しない" }] })] };
  // the engine reads no words: the judge named it settled with a real quote, so it is answered, and the card shows it for a person to turn back
  const [o] = judgeRouting([verdict("q1")], batch, freshMaterial(), BY);
  assert.ok("answer" in o);
});

test("AC-005: an output that is unreadable, or does not match the batch one to one, answers nothing", () => {
  const m = freshMaterial();
  for (const [why, verdicts] of [
    ["unreadable", null],
    ["a missing verdict", [verdict("q1")]],
    ["a repeated verdict", [verdict("q1"), verdict("q1")]],
    ["an extra verdict", [verdict("q1"), verdict("q2"), verdict("q3")]],
  ]) assert.ok(allPerson(verdicts, batchOf("q1", "q2"), m), why);
});

/** one row of the judge's JSON for a question the judge settled */
const row = (id, over = {}) => ({ question_id: id, decider: "self", kind: "settled", option_index: 1, reason: "r", evidence: [cite("issue", "", "引用の文を写す")], ...over });
const rowsJson = (...rows) => JSON.stringify({ answers: rows });

test("AC-005: the judge's JSON is read through a code fence, and a text that is not the shape is null", () => {
  const body = rowsJson(row("q1"));
  assert.equal(parseRouterOutput(`\`\`\`json\n${body}\n\`\`\``)?.[0].questionId, "q1");
  assert.equal(parseRouterOutput("前置き\n" + body)?.[0].kind, "settled");
  assert.equal(parseRouterOutput("not json"), null);
  assert.equal(parseRouterOutput(rowsJson(row("q1", { kind: "whatever" }))), null);
  assert.equal(parseRouterOutput(rowsJson(row("q1", { evidence: [{ source: "policy", quote: "x" }] }))), null, "a source outside the three is no output");
});

test("AC-005: one malformed verdict makes the whole output no judgement, so no verdict of it answers", () => {
  const out = (second) => parseRouterOutput(rowsJson(row("q1"), row("q2", second)));
  assert.equal(out({})?.length, 2, "the whole shape is read");
  for (const [why, over] of [
    ["evidence that is not a list", { evidence: "not a list" }],
    ["an evidence item that is not an object", { evidence: [null] }],
    ["a quote that is not text", { evidence: [{ source: "issue", quote: 3 }] }],
    ["a ref that is not text", { evidence: [{ source: "choice", ref: 7, quote: "引用の文を写す" }] }],
    ["a self verdict without evidence", { evidence: [] }],
    ["an option that is not a number", { option_index: "1" }],
    ["a reason that is not text", { reason: 5 }],
  ]) assert.equal(out(over), null, why);
  // a human row may leave the option and the evidence out
  const humanRow = { question_id: "q2", decider: "human", kind: "scope" };
  assert.equal(parseRouterOutput(rowsJson(row("q1"), { ...humanRow, reason: "範囲" }))?.length, 2);
  assert.equal(parseRouterOutput(rowsJson(row("q1"), { ...humanRow, evidence: "x" })), null, "a human row's evidence is still a list when it is given");
  // so a batch of two whose second verdict is malformed answers neither
  assert.ok(allPerson(out({ evidence: "x" }), batchOf("q1", "q2"), freshMaterial()));
});

test("the material fits the judge's command line: a long Issue is cut and the Choices fill what is left", () => {
  setup();
  writeFileSync(join(process.env.IDD_STATE_DIR, "backlog.jsonl"), jl({ ...rec, context: "あ".repeat(150_000) }));
  const m = buildRoutingMaterial("IDD-1", batchOf("q1", "q2"));
  assert.ok(m);
  assert.ok(Array.from(m.issue).length <= 6000, "the Issue is cut");
  assert.ok(renderedBytes(batchOf("q1", "q2").questions) + renderedBytes(m.issue) + m.choices.reduce((n, c) => n + renderedBytes(c) + 32, 0) <= MATERIAL_BYTES_MAX);
  // questions that alone fill the budget leave the batch to a person
  const huge = batchOf("q1");
  huge.questions[0].context = "い".repeat(MATERIAL_BYTES_MAX);
  assert.equal(buildRoutingMaterial("IDD-1", huge), null);
});

const JUDGE_ROLE = { role: "question-router", model: "x/y" };

/** a runner whose judge runs `routeQuestions`; `extra` replaces any other part of it */
function runnerWith(routeQuestions, calls = [], extra = {}) {
  setAgentRunner({
    deliver: async () => {},
    questionRouting: () => JUDGE_ROLE,
    routeQuestions: async (call) => { calls.push(call); return routeQuestions(call); },
    kickTick: () => { calls.kicks = (calls.kicks ?? 0) + 1; },
    ...extra,
  });
  return calls;
}

/** a runner whose judge says what the test gives it */
const runnerSaying = (text, calls = [], usage = undefined) =>
  runnerWith(async (call) => ({ text: typeof text === "function" ? text(call) : text, ...JUDGE_ROLE, ...(usage ? { usage } : {}) }), calls);

const answersJson = (...rows) => rowsJson(...rows.map(({ id, option, ...over }) => row(id, { ...(option ? { option_index: option } : {}), ...over, evidence: over.evidence ?? [cite("issue", "", QUOTE)], reason: over.reason ?? "記録で決まる" })));

const lifecycle = () => readLifecycle().filter((e) => e.idd_id === "IDD-1");
const eventCount = (name) => lifecycle().filter((e) => e.event === name).length;
const outbox = (state) => (existsSync(join(state, "outbox.jsonl")) ? readFileSync(join(state, "outbox.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
/** how many times the planner was told a batch is answered */
const toldCount = (state) => outbox(state).filter((o) => o.type === "question_batch_answered").length;
/** the number of questions on each card */
const cards = () => readOpenQuestions().map((b) => b.questions.length);
/** nothing was answered and the cards are as many as the questions asked */
const allOnCards = (...counts) => {
  assert.deepEqual(readAnswers(), []);
  assert.deepEqual(cards(), counts);
};
/** the lane's cost as the budget reads it, counted again from the files */
async function costNow() {
  clearCostCache();
  return laneCost("IDD-1", lifecycle());
}
/** the cost carries `total`, as the one part "質問の振り分け" */
const assertJudgeCost = (cost, total, why) => {
  assert.equal(cost.total, total, why);
  assert.deepEqual(cost.parts.filter((p) => p.cost > 0), [{ label: "質問の振り分け", cost: total }]);
};
const GO = ["s1_ready", "s1_plan_review_done", "s1_go"];
const seedGo = (seed, events = GO) => { for (const e of events) seed(e, e === "s1_plan_review_done" ? { must: 0, should: 0, nit: 0 } : {}); };
/** the planner's ask, as the report door takes it */
const ask = (ids = ["q1", "q2"], batchId = "B-1") => agentAskQuestions({ iddId: "IDD-1", batchId, questions: ids.map((id) => question(id)) });
/** a fresh lane whose planner asks, and whose judge says `say`, to the end of the routing */
async function judged(say, doAsk = ask) {
  setup({ batchAsks: [] });
  const calls = runnerSaying(say);
  await doAsk();
  await settleQuestionRouting();
  return calls;
}
/** nothing of the batch is on record or on a card */
const unseen = () => readQuestionBatches().length === 0 && readOpenQuestions().length === 0 && eventCount("question_batch_asked") === 0 && readAnswers().length === 0;
/** the rows of a batch whose questions the mechanism answered, written to the answers' file */
const putAnswers = (state, ids, over = {}) => { for (const id of ids) put(state, "pending-answers.jsonl", { idd_id: "IDD-1", batch_id: "B-1", question_id: id, answered_at: "2026-10-28T02:00:00Z", selection: { index: 1, label: "案 A" }, ...over }); };
/** a batch whose row and answers landed and whose asked event did not */
const putAnsweredNoAsk = (state) => {
  put(state, "pending-questions.jsonl", batchOf("q1", "q2"));
  putAnswers(state, ["q1", "q2"], routerRows);
};
/** the same, with the batch's close on record (its word to the planner not yet queued) */
const putClosedNoAsk = (state) => {
  putAnsweredNoAsk(state);
  put(state, "lifecycle-test.jsonl", { idd_id: "IDD-1", event: "question_batch_answered", at: "2026-10-28T02:30:00.000Z", attrs: { batch_id: "B-1", answered_by: "router" } });
};
/** the judge's verdict on q1 as the write takes it */
const routedOf = (index, label) => ({ questionId: "q1", selection: { index, label }, by: BY, basis: [cite("issue", "", "x")], reason: "r" });
const routerRows = { answered_by: "router", router: BY, basis: [cite("issue", "", "x")], reason: "r" };

test("AC-001: a batch every question of which the records decide shows no card, is answered, closed with the mark, and the lane leaves the question stage", async () => {
  const { state } = setup({ batchAsks: [] });
  let during;
  const calls = runnerSaying(() => {
    during = unseen();
    return answersJson({ id: "q1" }, { id: "q2", option: 2, evidence: [cite("norm", "_docs/standards/commit.md", "判断の理由は本文へ書く。")] });
  });
  // the report returns at once, and nothing is on record while the judge reads (no tick ran either)
  assert.deepEqual(await ask(), { ok: true });
  assert.ok(unseen(), "right after the ask");
  await settleQuestionRouting();
  assert.equal(during, true, "while the judge read");
  assert.equal(calls.length, 1);
  assert.equal(calls.kicks, 1, "the planner's word is delivered without waiting for a timer");
  const rows = readAnswers();
  assert.deepEqual(rows.map((r) => [r.question_id, r.selection.index, r.answered_by, r.router.role]), [["q1", 1, "router", "question-router"], ["q2", 2, "router", "question-router"]]);
  assert.equal(rows[1].basis[0].ref, "_docs/standards/commit.md");
  assert.deepEqual(readOpenQuestions(), [], "no card");
  assert.deepEqual(lifecycle().map((e) => e.event).filter((e) => e.startsWith("question_batch")), ["question_batch_asked", "question_batch_answered"]);
  assert.deepEqual(lifecycle().find((e) => e.event === "question_batch_answered").attrs, { batch_id: "B-1", answered_by: "router" });
  const sent = outbox(state).filter((o) => o.type === "question_batch_answered");
  assert.equal(sent.length, 1, "the planner is told once");
  assert.match(readFileSync(join(state, "outbox", `${sent[0].envelope_id}.xml`), "utf8"), /仕組みが/);
  // the tick's re-close finds nothing left to do
  assert.deepEqual(await finishAnsweredBatches(), []);
});

test("AC-002: a batch with a question the person keeps shows only that question, and the mechanism's answer reads back with its record", async () => {
  await judged(answersJson({ id: "q1" }, { id: "q2", decider: "human", kind: "scope", reason: "範囲の判断" }));
  const decided = routedDecisions("IDD-1");
  assert.equal(decided.length, 1);
  assert.deepEqual([decided[0].question, decided[0].answer, decided[0].basis[0].quote, decided[0].answeredBy.role], ["質問 q1", "案 A", QUOTE, "question-router"]);
  assert.deepEqual(readOpenQuestions().map((b) => b.questions.map((q) => q.question_id)), [["q1", "q2"]], "the batch is whole in the questions' file");
  assert.deepEqual(readAnswers().map((a) => a.question_id), ["q1"], "and q1 has its answer, so only q2 is left for the card");
  assert.equal(eventCount("question_batch_answered"), 0, "a batch with a question left is not closed");
  assert.equal(eventCount("question_batch_asked"), 1);
});

test("AC-005: a judge that throws, a text off the shape and a batch too large for the judge put every question on a card", async () => {
  const oneVerdictMalformed = rowsJson(row("q1", { evidence: [cite("issue", "", QUOTE)], reason: undefined }), row("q2", { evidence: "x", reason: undefined }));
  for (const say of [() => { throw new Error("pi が起動できない"); }, "これは JSON ではない", oneVerdictMalformed]) {
    await judged(say);
    allOnCards(2);
    assert.equal(eventCount("question_batch_asked"), 1);
  }
  // questions that alone fill the judge's prompt leave no material: the judge is not run and the batch is the person's
  const calls = await judged(answersJson({ id: "q1" }), () => agentAskQuestions({ iddId: "IDD-1", batchId: "B-1", questions: [question("q1", { context: "い".repeat(MATERIAL_BYTES_MAX) })] }));
  assert.equal(calls.length, 0);
  assert.deepEqual(cards(), [1]);
});

test("AC-005: a key left out, a lane after its GO and a lane with an executor write the batch at once and never wake the judge", async () => {
  // the key left out
  setup({ batchAsks: [] });
  runnerWith(() => { throw new Error("must not run"); }, [], { questionRouting: () => null });
  await ask();
  assert.deepEqual(cards(), [2], "on record when the report returns");
  allOnCards(2);

  // no runner at all
  setup({ batchAsks: [] });
  await ask();
  assert.deepEqual(cards(), [2]);

  // after the lane's GO, whether or not an executor session has started
  for (const events of [GO, [...GO, "s2_start"]]) {
    const { seed } = setup({ batchAsks: [], executor: events.includes("s2_start") });
    seedGo(seed, events);
    const calls = runnerSaying(answersJson({ id: "q1" }, { id: "q2" }));
    await ask();
    assert.equal(calls.length, 0, `the judge is not woken after ${events.at(-1)}`);
    allOnCards(2);
    assert.equal(inPlanning("IDD-1"), false);
  }
  setup({ batchAsks: [] });
  assert.equal(inPlanning("IDD-1"), true);
});

test("AC-004: a lane given its GO while the judge reads gets the whole batch as a person's, whatever the judge answered", async () => {
  const { seed } = setup({ batchAsks: [] });
  runnerSaying(() => { seedGo(seed); return answersJson({ id: "q1" }, { id: "q2" }); });
  await ask();
  await settleQuestionRouting();
  allOnCards(2);
});

test("AC-002, AC-006: a result that returns after the lane closed writes nothing, and what the judge spent stays on the lane's cost", async () => {
  const { state, seed } = setup({ batchAsks: [] });
  runnerWith(async () => {
    seed("lane_close");
    return { text: answersJson({ id: "q1" }, { id: "q2" }), ...JUDGE_ROLE, usage: { input: 900, output: 80, cost: { total: 0.004 } } };
  });
  await ask();
  await settleQuestionRouting();
  assert.ok(unseen(), "no row, no event, no answer");
  assert.equal(outbox(state).length, 0);
  clearCostCache();
  assert.equal((await laneCost("IDD-1", lifecycle())).total, 0.004);
});

test("the judge's cost is a part of the lane's cost, on the day it was spent, and a run without usage adds nothing", async () => {
  const { state } = setup({ batchAsks: [] });
  runnerSaying(answersJson({ id: "q1" }, { id: "q2" }), [], { input: 1000, output: 50, cacheRead: 5, cacheWrite: 0, cost: { total: 0.0125 } });
  await ask();
  await settleQuestionRouting();
  const cost = await costNow();
  assertJudgeCost(cost, 0.0125, "the budget counts it");
  assert.equal(cost.daily.length, 1);
  assert.equal(cost.daily[0].budget, 0.0125);
  const line = JSON.parse(readFileSync(join(state, "question-routing-cost.jsonl"), "utf8").trim());
  assert.deepEqual([line.idd_id, line.batch_id, line.role, line.model, line.input, line.output, line.cache_read], ["IDD-1", "B-1", "question-router", "x/y", 1000, 50, 5]);
  // another lane's cost does not include it
  assert.equal((await laneCost("IDD-2", [])).total, 0);

  // a run that reported nothing writes no line
  await judged(answersJson({ id: "q1" }, { id: "q2" }));
  assert.equal(existsSync(join(process.env.IDD_STATE_DIR, "question-routing-cost.jsonl")), false);
});

test("a resend of a batch the judge is reading does not run the judge twice, and the batch is written once", async () => {
  setup({ batchAsks: [] });
  const calls = runnerSaying(answersJson({ id: "q1" }, { id: "q2" }));
  assert.deepEqual(await ask(), { ok: true });
  assert.deepEqual(await ask(), { ok: true });
  await settleQuestionRouting();
  assert.equal(calls.length, 1);
  assert.equal(readQuestionBatches().length, 1);
  assert.equal(eventCount("question_batch_asked"), 1);
  assert.equal(readAnswers().length, 2);
});

test("the tick's stage closes a batch left with all its answers, starts no judge and writes nothing for a batch being committed", async () => {
  const { state } = setup();
  const calls = runnerSaying(answersJson({ id: "q1" }, { id: "q2" }));
  // the answers landed, the close did not
  putAnswers(state, ["q1", "q2"]);
  finishQuestionBatches();
  await settleQuestionRouting();
  assert.equal(calls.length, 0, "the stage never wakes the judge");
  assert.equal(eventCount("question_batch_answered"), 1);
  assert.equal(toldCount(state), 1);
});

test("C-256-3: a second answer to a question is not written, whoever gives it", async () => {
  setup();
  const answer = (index, label) => ({ iddId: "IDD-1", batchId: "B-1", questionId: "q1", selection: { index, label } });
  assert.ok(await appendAnswer(answer(1, "案 A")));
  assert.equal(await appendAnswer(answer(2, "案 B")), null);
  const routed = await recordRoutedBatch(batchOf("q1"), [routedOf(2, "案 B")]);
  assert.deepEqual(routed.written, []);
  assert.equal(readAnswers().filter((a) => a.question_id === "q1").length, 1);
  const again = await applyDecision("answer", { iddId: "IDD-1", batchId: "B-1", questionId: "q1", selection: { index: 2 } });
  assert.equal(again.ok, false);
  assert.match(again.error, /すでに答えが付いています/);
});

test("C-256-3: a batch whose answers are all on record but whose close did not land is closed again, once", async () => {
  const { state } = setup();
  // the answers land, then the close does not: write the rows alone
  putAnswers(state, ["q1", "q2"], routerRows);
  assert.equal(eventCount("question_batch_answered"), 0);
  assert.deepEqual(await finishAnsweredBatches(), ["IDD-1/B-1"]);
  // run again: nothing is closed twice
  assert.deepEqual(await finishAnsweredBatches(), []);
  assert.equal(eventCount("question_batch_answered"), 1);
  assert.equal(toldCount(state), 1);
});

test("C-256-3: a close missing its word to the planner is finished, and a later batch the lane asked does not hide it", async () => {
  const { state, seed } = setup({ batchAsks: [["q1"]] });
  putAnswers(state, ["q1"]);
  seed("question_batch_answered", { batch_id: "B-1" });
  // the lane then asked a second batch, which is open
  seed("question_batch_asked", { batch_id: "B-2" });
  put(state, "pending-questions.jsonl", { idd_id: "IDD-1", batch_id: "B-2", asked_at: "2026-10-28T03:00:00Z", questions: [question("q9")] });
  assert.equal(outbox(state).length, 0);
  assert.deepEqual(await finishAnsweredBatches(), ["IDD-1/B-1"]);
  assert.equal(toldCount(state), 1);
  assert.equal(eventCount("question_batch_answered"), 1, "the close that was on record is not written again");
  assert.deepEqual(await finishAnsweredBatches(), []);
});

test("AC-006 (records): a close the person made carries no mark", async () => {
  setup({ batchAsks: [["q1"]] });
  const answered = await applyDecision("answer", { iddId: "IDD-1", batchId: "B-1", questionId: "q1", selection: { index: 1 } });
  assert.equal(answered.ok, true);
  assert.deepEqual(lifecycle().find((e) => e.event === "question_batch_answered").attrs, { batch_id: "B-1" });
});

test("C-256-1: an unconfirmed Choice is not in the material, so a quote of it is no basis and the question goes to a person", async () => {
  setup();
  writeFileSync(join(process.env.IDD_STATE_DIR, "backlog.jsonl"), jl({ ...rec, context: `${ISSUE} 触る場所は \`a/b/c.ts\` だ。` }));
  const actor = { session: "s1" };
  const p = await intentStore.raisePurpose({ repo: "me/app", actor, statement: "S", origin: "O" });
  const raise = (over) => intentStore.raiseChoice({ repo: "me/app", actor, body: { purpose: p.id, forms: { chosen: "A", rejected: [{ form: "B", fails_because: "壊れる" }] }, place: [{ path: "a/b/c.ts", kind: "file" }], why: "w", anchored: "x", ...over } });
  const live = await raise({ why: "確定した理由として履歴を引きやすくする文です" });
  const draft = await raise({ id: "DEC-77", status: "unconfirmed", why: "草案にしか書かれていない理由として履歴を引きやすくする文です" });
  for (const r of [live, draft]) assert.equal(r.ok, true, r.error);
  assert.equal(intentStore.lookupChoices({ repo: "me/app", actor: null, paths: ["a/b/c.ts"] }).some((c) => c.id === draft.id), true, "the lookup itself returns the draft");
  const m = buildRoutingMaterial("IDD-1", batchOf("q1"));
  assert.deepEqual(m.choices.map((c) => c.id), [live.id]);
  const quote = cite("choice", draft.id, "草案にしか書かれていない理由として履歴を引きやすくする文です");
  assert.equal(basisOf(quote, m), null);
  assert.ok(allPerson([verdict("q1", { evidence: [quote] })], batchOf("q1"), m));
  assert.ok(basisOf(cite("choice", live.id, "確定した理由として履歴を引きやすくする文です"), m));
});

test("C-256-3: a batch with every answer but no asked event is closed again, with the asked event first and the row once", async () => {
  const { state } = setup({ batchAsks: [] });
  // the answers and the batch's row landed; the asked event did not
  putAnsweredNoAsk(state);
  assert.deepEqual(await finishAnsweredBatches(), ["IDD-1/B-1"]);
  assert.deepEqual(lifecycle().map((e) => e.event).filter((e) => e.startsWith("question_batch")), ["question_batch_asked", "question_batch_answered"]);
  assert.equal(toldCount(state), 1);
  assert.deepEqual(await finishAnsweredBatches(), []);
});

test("C-256-3: recording an asked batch twice writes its row and its event once", async () => {
  const recordedTwice = async () => {
    await recordAskedBatch(batchOf("q1"));
    assert.equal(readQuestionBatches().length, 1);
    assert.equal(eventCount("question_batch_asked"), 1);
  };
  setup({ batchAsks: [] });
  await recordAskedBatch(batchOf("q1"));
  await recordedTwice();
  // a half that failed is finished by the retry: the row is there, the event is not
  const { state } = setup({ batchAsks: [] });
  put(state, "pending-questions.jsonl", batchOf("q1"));
  await recordedTwice();
});

test("a judge that failed after spending still puts its usage on the lane's cost, and every question goes to a person", async () => {
  await judged(() => { throw new RouteFailed("時間の上限で止まった", { text: "", ...JUDGE_ROLE, usage: { input: 700, output: 30, cost: { total: 0.009 } } }); });
  allOnCards(2);
  assertJudgeCost(await costNow(), 0.009, "the budget counts what the failed run used");

  // a failure that spent nothing writes no line
  await judged(() => { throw new RouteFailed("起動できない"); });
  assert.equal(existsSync(join(process.env.IDD_STATE_DIR, "question-routing-cost.jsonl")), false);
});

test("an automatic GO does not pass a shallow lane while the judge holds its batch, and decides once the result is on record", async () => {
  // a shallow lane reviewed with no finding left: nothing but the held batch keeps its GO from the engine
  laneAtGo();
  let release;
  const gate = new Promise((r) => { release = r; });
  runnerWith(async () => { await gate; return { text: answersJson({ id: "q1", decider: "human", kind: "scope", reason: "範囲の判断" }, { id: "q2" }), ...JUDGE_ROLE }; });
  await ask();
  const held = await runAutoGo();
  assert.deepEqual(held.recorded, [], "no GO while the judge reads");
  assert.equal(eventCount("s1_go"), 0);
  release();
  await settleQuestionRouting();
  // the result is on record: a question is left for the person, so the pick itself leaves the GO to them
  const after = await runAutoGo();
  assert.deepEqual(after.recorded, []);
  assert.equal(eventCount("s1_go"), 0);
});

test("C-256-3: a batch whose close is on record but whose asked event is missing gets no asked event after the close", async () => {
  const { state } = setup({ batchAsks: [] });
  putClosedNoAsk(state);
  const finished = await finishAnsweredBatches();
  assert.deepEqual(finished, ["IDD-1/B-1"]);
  assert.equal(eventCount("question_batch_asked"), 0, "no asked event follows the close");
  assert.equal(toldCount(state), 1, "the planner is told once");
  assert.notEqual(deriveStage(lifecycle()).decision, "question");
  assert.deepEqual(await finishAnsweredBatches(), []);
});

/** a Choice whose place is the repo's root, raised by the lane's own actor */
async function raiseRoot(over = {}) {
  const actor = { session: "s1" };
  const p = await intentStore.raisePurpose({ repo: "me/app", actor, statement: "S", origin: "O" });
  const r = await intentStore.raiseChoice({ repo: "me/app", actor, body: { purpose: p.id, forms: { chosen: "A", rejected: [{ form: "B", fails_because: "壊れる" }] }, place: [{ path: "/", kind: "root" }], why: "w", anchored: "x", ...over } });
  assert.equal(r.ok, true, r.error);
  return r;
}

test("C-256-1: a question that names no path still meets the repo's root Choices, and a root Choice that does not fit sends the batch to a person", async () => {
  setup();
  const root = await raiseRoot({ why: "どの path にも掛かる決めとして履歴を引きやすくする文です" });
  const draft = await raiseRoot({ id: "DEC-78", status: "unconfirmed", why: "草案の root の決めとして履歴を引きやすくする文です" });
  const m = buildRoutingMaterial("IDD-1", batchOf("q1"));
  assert.deepEqual(m.choices.map((c) => c.id), [root.id], "the active root Choice is in the material, the unconfirmed one is not");
  assert.ok(basisOf(cite("choice", root.id, "どの path にも掛かる決めとして履歴を引きやすくする文です"), m));
  assert.equal(basisOf(cite("choice", draft.id, "草案の root の決めとして履歴を引きやすくする文です"), m), null);
  // a root Choice the byte budget cannot hold is not left out: the batch is a person's
  const big = batchOf("q1");
  big.questions[0].context = "い".repeat(MATERIAL_BYTES_MAX - 4000);
  assert.equal(buildRoutingMaterial("IDD-1", big), null);
});

test("C-256-8: while the judge holds a batch a person's GO is refused, and the hold goes when the result is on record", async () => {
  const { seed } = setup({ batchAsks: [], events: ["lane_open"] });
  seed("s1_ready", { depth: "deep" });
  seed("s1_plan_review_done", { must: 0, should: 0, nit: 0 });
  let release;
  const gate = new Promise((r) => { release = r; });
  runnerWith(async () => { await gate; return { text: answersJson({ id: "q1", decider: "human", kind: "scope", reason: "範囲の判断" }, { id: "q2" }), ...JUDGE_ROLE }; });
  await ask();
  assert.equal(heldBatches("IDD-1").length, 1);
  const refused = await applyDecision("s1_go", { iddId: "IDD-1" });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /振り分けている最中/);
  assert.equal(eventCount("s1_go"), 0);
  release();
  await settleQuestionRouting();
  assert.equal(heldBatches("IDD-1").length, 0);
  assert.equal(goBlockedReason("IDD-1"), null);
});

test("C-256-9: a GO checked while the planner's ask arrives never leaves a hold on a lane that has its GO", async () => {
  const { seed } = setup({ batchAsks: [], events: ["lane_open"] });
  seed("s1_ready", { depth: "deep" });
  seed("s1_plan_review_done", { must: 0, should: 0, nit: 0 });
  const calls = runnerSaying(answersJson({ id: "q1" }, { id: "q2" }));
  let trigger;
  const started = new Promise((r) => { trigger = r; });
  // the ask is a call from outside the gate, as the planner's report is
  const asked = (async () => { await started; return ask(); })();
  // the GO's own gate and own check (`goBlockedReason`); `before` is the window between its check and its write
  const go = await transition("IDD-1", "s1_go", {}, {
    require: () => goBlockedReason("IDD-1"),
    before: async () => { trigger(); await new Promise((r) => setTimeout(r, 150)); },
  });
  assert.deepEqual(await asked, { ok: true });
  await settleQuestionRouting();
  assert.ok(go.ok, "no hold was there when the GO checked");
  assert.equal(eventCount("s1_go"), 1);
  assert.equal(heldBatches("IDD-1").length, 0, "no hold stays on a lane that has its GO");
  assert.equal(calls.length, 0, "the judge is not woken for a batch asked after the GO");
  assert.equal(readQuestionBatches().length, 1, "the batch is on record as a person's");
  assert.deepEqual(readAnswers(), []);
  assert.deepEqual(cards(), [2]);
});

test("C-256-8: a batch the judge held when its process died is written as a person's on the next tick, and a batch being judged is left alone", async () => {
  setup({ batchAsks: [] });
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = runnerWith(async () => { await gate; return { text: answersJson({ id: "q1" }, { id: "q2" }), ...JUDGE_ROLE }; });
  await ask();
  finishQuestionBatches();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(unseen(), "a judge running in this process is not recovered");
  release();
  await settleQuestionRouting();
  assert.equal(readAnswers().length, 2);
  // the engine died with a batch held: only the hold is on disk, no judge is running
  setAgentRunner(null);
  holdBatch({ ...batchOf("q3", "q4"), batch_id: "B-2" });
  assert.equal(heldBatches("IDD-1").length, 1);
  assert.match(goBlockedReason("IDD-1") ?? "", /振り分けている最中/);
  finishQuestionBatches();
  await settleQuestionRouting();
  assert.equal(heldBatches("IDD-1").length, 0);
  assert.equal(goBlockedReason("IDD-1"), null);
  const b2 = readQuestionBatches().find((b) => b.batch_id === "B-2");
  assert.deepEqual(b2.questions.map((q) => q.question_id), ["q3", "q4"]);
  assert.equal(readAnswers().filter((a) => a.batch_id === "B-2").length, 0, "no answer is added for a batch the judge never finished");
  assert.equal(calls.length, 1, "the recovery never wakes the judge");
  // a second tick writes nothing more
  finishQuestionBatches();
  await settleQuestionRouting();
  assert.equal(readQuestionBatches().filter((b) => b.batch_id === "B-2").length, 1);
});

test("C-256-8: a hold of a lane that has ended blocks nothing and is not written back", async () => {
  const { seed } = setup({ batchAsks: [] });
  holdBatch(batchOf("q1"));
  seed("lane_close");
  assert.equal(heldBatches("IDD-1").length, 0);
  finishQuestionBatches();
  await settleQuestionRouting();
  assert.ok(unseen());
});

/** a runner whose delivery waits until the test lets it through, and whose judge is counted */
function runnerHoldingDelivery() {
  let release;
  const delivery = new Promise((r) => { release = r; });
  const calls = runnerWith(async () => ({ text: answersJson({ id: "q1" }, { id: "q2" }), ...JUDGE_ROLE }), [], { deliver: () => delivery });
  return { calls, release };
}
const recoveryAttempts = () => lifecycle().filter((e) => e.event.endsWith("_recovery_attempt")).length;

test("C-263-1: a resume still being delivered when the wait runs out leaves no hold, so the batch is a person's and the judge is not woken", async () => {
  setup({ batchAsks: [] });
  process.env.IDD_LANE_GATE_WAIT_MS = "100";
  const { calls, release } = runnerHoldingDelivery();
  const resumed = runResume("IDD-1", "test", { unlessHeld: true });
  assert.equal(await routeOnAsk(batchOf("q1", "q2")), false);
  assert.equal(heldBatches("IDD-1").length, 0, "no hold sits before a delivery that is still under way");
  assert.equal(calls.length, 0);
  assert.equal(recoveryAttempts(), 0);
  release();
  assert.deepEqual(await resumed, { ok: true, role: "planner", sessionId: "p1" });
  assert.equal(recoveryAttempts(), 1);
  assert.equal(heldBatches("IDD-1").length, 0);
});

test("C-263-1: a resume that begins while the hold's maker waits for the gate is not followed by a hold", async () => {
  setup({ batchAsks: [] });
  const { calls, release } = runnerHoldingDelivery();
  let letGo;
  let entered;
  const inside = new Promise((r) => { entered = r; });
  const other = withLaneGate(() => new Promise((r) => { letGo = r; entered(); }));
  await inside;
  const routing = routeOnAsk(batchOf("q1", "q2"));
  await new Promise((r) => setTimeout(r, 50));
  // the wait for resumes was over before this one began
  const resumed = runResume("IDD-1", "test", { unlessHeld: true });
  letGo();
  await other;
  assert.equal(await routing, false);
  assert.equal(heldBatches("IDD-1").length, 0);
  assert.equal(calls.length, 0);
  release();
  assert.equal((await resumed).ok, true);
  assert.equal(recoveryAttempts(), 1);
});

test("AC-002: a batch with its close releases its hold even when its asked event is missing, and a batch with neither is still held", async () => {
  const { state } = setup({ batchAsks: [] });
  putClosedNoAsk(state);
  holdBatch(batchOf("q1", "q2"));
  assert.equal(heldBatches("IDD-1").length, 0, "the close is the batch's last record");
  assert.equal(routingHoldReason("IDD-1"), null);
  holdBatch({ ...batchOf("q7"), batch_id: "B-2" });
  assert.deepEqual(heldBatches("IDD-1").map((b) => b.batch_id), ["B-2"]);
});

// ---------------------------------------------------------------- C-264-1: a column that cannot be read is not "none"

/** a shallow lane waiting at its GO (reviewed, its qa.md Low risk) with the planner's questions closed */
function laneAtGo() {
  const s = setup({ batchAsks: [], events: ["lane_open"] });
  mkdirSync(join(s.worktree, "_docs", "qa", "app", "idd-1"), { recursive: true });
  writeFileSync(join(s.worktree, "_docs", "qa", "app", "idd-1", "qa.md"), "---\nrisk: Low\n---\n\nbody\n");
  s.seed("s1_plan_review_started", { run_ids: ["r"] });
  s.seed("s1_ready", { depth: "shallow" });
  s.seed("s1_plan_review_done", { must: 0 });
  return s;
}

/** the GO is refused for `column` by the check, by a person's press and by the engine's own GO, and no GO is written */
async function assertGoRefused(column) {
  assert.match(goBlockedReason("IDD-1") ?? "", column);
  const refused = await applyDecision("s1_go", { iddId: "IDD-1" });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", column);
  assert.deepEqual((await runAutoGo()).recorded, [], "the engine's GO waits too");
  assert.equal(eventCount("s1_go"), 0);
}

test("AC-001: a column or a row that cannot be read refuses a person's GO and the engine's, names what, and the GO passes again once it can be read", async () => {
  const { state } = laneAtGo();
  assert.equal(goBlockedReason("IDD-1"), null, "no column at all is none, not a fault");
  // the answers' column cannot be opened as the column it is
  mkdirSync(join(state, "pending-answers.jsonl"));
  await assertGoRefused(/確認が済んでいない.*答えの列/);
  // the questions' column too, named by itself
  rmSync(join(state, "pending-answers.jsonl"), { recursive: true });
  mkdirSync(join(state, "pending-questions.jsonl"));
  await assertGoRefused(/質問の列/);
  assert.doesNotMatch(goBlockedReason("IDD-1"), /答えの列/);
  rmSync(join(state, "pending-questions.jsonl"), { recursive: true });
  // a mechanism's row that cannot be shaped into a decision (no selection) is named, not thrown, and another lane's bad row is not this lane's
  put(state, "pending-answers.jsonl", { idd_id: "IDD-1", batch_id: "B-1", question_id: "q1", answered_at: T0, ...routerRows });
  put(state, "pending-answers.jsonl", { idd_id: "IDD-2", batch_id: "B-1", question_id: "q1", answered_at: T0, ...routerRows });
  assert.deepEqual(readRoutedDecisions("IDD-1").decisions, []);
  await assertGoRefused(/B-1\/q1 の答えか引いた記録の形が不正/);
  assert.equal(goBlockedReason("IDD-3"), null);
  rmSync(join(state, "pending-answers.jsonl"));
  // a row that says the mechanism answered but lacks its router or its basis is unconfirmed, not left out; a person's older row (no answered_by) is not
  const sel = { index: 1, label: "案 A" };
  for (const [why, lacking] of [["no router", { answered_by: "router", basis: routerRows.basis }], ["no basis", { answered_by: "router", router: BY }], ["an empty basis", { answered_by: "router", router: BY, basis: [] }]]) {
    put(state, "pending-answers.jsonl", { idd_id: "IDD-1", batch_id: "B-1", question_id: "q1", answered_at: T0, selection: sel, ...lacking });
    assert.deepEqual(readRoutedDecisions("IDD-1").decisions, [], why);
    await assertGoRefused(/B-1\/q1 は仕組みの答えだが、router か basis が欠けている/);
    assert.equal(goBlockedReason("IDD-3"), null, why);
    rmSync(join(state, "pending-answers.jsonl"));
  }
  // a quote of the basis that is not a decision (null, or no quote) is unconfirmed too: the card is not stopped by it, and the GO is refused
  for (const basis of [[null], [{ source: "choice", ref: "C-1-1" }], [{ source: "other", ref: "", quote: "x" }]]) {
    put(state, "pending-answers.jsonl", { idd_id: "IDD-1", batch_id: "B-1", question_id: "q1", answered_at: T0, selection: sel, answered_by: "router", router: BY, basis });
    assert.deepEqual(readRoutedDecisions("IDD-1").decisions, [], JSON.stringify(basis));
    await assertGoRefused(/B-1\/q1 の答えか引いた記録の形が不正/);
    rmSync(join(state, "pending-answers.jsonl"));
  }
  // an answer whose question's words are not on record (no row for its batch, or none for its question) is unconfirmed until they can be read
  put(state, "pending-answers.jsonl", { idd_id: "IDD-1", batch_id: "B-1", question_id: "q1", answered_at: T0, selection: sel, ...routerRows });
  assert.deepEqual(readRoutedDecisions("IDD-1").decisions, []);
  await assertGoRefused(/質問の列（B-1\/q1 の質問の文が見つからない）/);
  put(state, "pending-questions.jsonl", { idd_id: "IDD-1", batch_id: "B-1", asked_at: T0, questions: [question("q9")] });
  await assertGoRefused(/B-1\/q1 の質問の文が見つからない/);
  rmSync(join(state, "pending-questions.jsonl"));
  put(state, "pending-questions.jsonl", { idd_id: "IDD-1", batch_id: "B-1", asked_at: T0, questions: [question("q1")] });
  assert.deepEqual(readRoutedDecisions("IDD-1").unreadable, []);
  assert.equal(readRoutedDecisions("IDD-1").decisions[0].question, "質問 q1", "the question's own words, not its id");
  rmSync(join(state, "pending-questions.jsonl"));
  rmSync(join(state, "pending-answers.jsonl"));
  put(state, "pending-answers.jsonl", { idd_id: "IDD-1", batch_id: "B-1", question_id: "q1", answered_at: T0, selection: sel });
  assert.deepEqual(readRoutedDecisions("IDD-1").unreadable, []);
  // readable again: the lane is as it was before
  rmSync(join(state, "pending-answers.jsonl"));
  assert.equal(goBlockedReason("IDD-1"), null);
  const go = await applyDecision("s1_go", { iddId: "IDD-1" });
  assert.deepEqual([go.ok, eventCount("s1_go")], [true, 1]);
});

test("AC-001: a column whose state cannot be looked at is unreadable, and one that is not there is not", () => {
  const { state } = laneAtGo();
  put(state, "pending-questions.jsonl", { idd_id: "IDD-1", batch_id: "B-1", asked_at: T0, questions: [question("q1")] });
  put(state, "pending-answers.jsonl", { idd_id: "IDD-1", batch_id: "B-1", question_id: "q1", answered_at: T0, selection: { index: 1, label: "案 A" }, ...routerRows });
  assert.deepEqual(readRoutedDecisions("IDD-1").unreadable, []);
  assert.equal(readRoutedDecisions("IDD-1").decisions.length, 1);
  assert.equal(routedDecisions("IDD-1").length, 1);
  // a stat that fails (not "no such file") counts as unreadable; skipped where the user can read anything
  if (process.getuid?.() !== 0) {
    chmodSync(state, 0o000);
    try {
      const read = readRoutedDecisions("IDD-1");
      assert.deepEqual(read.unreadable, ["答えの列", "質問の列"]);
      assert.throws(() => routedDecisions("IDD-1"), /読めません/);
    } finally {
      chmodSync(state, 0o755);
    }
  }
  assert.deepEqual(readRoutedDecisions("IDD-1").unreadable, []);
});

// ---------------------------------------------------------------- C-264-3 / C-256-8: the end of a lane, in the same hold as the write

test("AC-002: a close that comes in while the result waits for the gate is seen, and the result is not written after it", async () => {
  const { state } = setup({ batchAsks: [] });
  let trigger;
  const started = new Promise((r) => { trigger = r; });
  // the judge returns while the close holds the gate: the result's read of the lane must come after the close
  runnerWith(async () => { await started; return { text: answersJson({ id: "q1" }, { id: "q2" }), ...JUDGE_ROLE }; });
  await ask();
  const closing = transition("IDD-1", "lane_close", {}, { before: async () => { trigger(); await new Promise((r) => setTimeout(r, 150)); } });
  await settleQuestionRouting();
  assert.ok((await closing).ok);
  assert.ok(unseen(), "nothing of the result is on record after the lane's end");
  assert.equal(outbox(state).length, 0);
});

test("AC-002: the write of a routed result and the recovery of a hold leave a closed lane as it was", async () => {
  const { seed } = setup({ batchAsks: [] });
  seed("lane_close");
  const done = await recordRoutedBatch(batchOf("q1", "q2"), [routedOf(1, "案 A")]);
  assert.deepEqual(done, { written: [], closed: false });
  assert.ok(unseen());
});

test("AC-002: a recovery never adds an asked event after the batch's close, and still writes one to a batch not closed", async () => {
  const { state } = setup({ batchAsks: [] });
  // the row, the answers and the close landed; the asked event did not, and the hold is still there
  putClosedNoAsk(state);
  await recordRoutedBatch(batchOf("q1", "q2"), []);
  assert.equal(eventCount("question_batch_asked"), 0, "no asked event follows the close");
  // a batch that is not closed gets its asked event as before
  await recordRoutedBatch({ ...batchOf("q7"), batch_id: "B-2" }, []);
  assert.equal(eventCount("question_batch_asked"), 1);
});

// ---------------------------------------------------------------- C-264-2: the envelope names the batch

const CLOSE_NEW = "2026-11-03T01:00:00.000Z";
const CLOSE_NEW_2 = "2026-11-03T02:00:00.000Z";
/** a batch with answers on record for both of its questions, and a close at `at` */
function putClosedBatch(state, batchId, at, qid = "q1") {
  put(state, "pending-questions.jsonl", { idd_id: "IDD-1", batch_id: batchId, asked_at: T0, questions: [question(qid)] });
  put(state, "pending-answers.jsonl", { idd_id: "IDD-1", batch_id: batchId, question_id: qid, answered_at: at, selection: { index: 1, label: "案 A" } });
  put(state, "lifecycle-test.jsonl", { idd_id: "IDD-1", event: "question_batch_asked", at: T0, attrs: { batch_id: batchId } });
  put(state, "lifecycle-test.jsonl", { idd_id: "IDD-1", event: "question_batch_answered", at, attrs: { batch_id: batchId } });
}
const putEnvelope = (state, envelopeId, queuedAt) => put(state, "outbox.jsonl", { envelope_id: envelopeId, idd_id: "IDD-1", type: "question_batch_answered", queued_at: queuedAt, delivered_at: null });

test("AC-003: an envelope that names the neighbouring batch is not the mark of this one, and this one's answers are sent", async () => {
  const { state } = setup({ batchAsks: [] });
  putClosedBatch(state, "B-1", CLOSE_NEW, "q1");
  putClosedBatch(state, "B-2", CLOSE_NEW_2, "q2");
  // the neighbour's envelope was queued (after both closes); B-1's was not
  putEnvelope(state, "answered-IDD-1-B-2", "2026-11-03T02:00:05.000Z");
  assert.deepEqual(await finishAnsweredBatches(), ["IDD-1/B-1"]);
  assert.deepEqual(outbox(state).map((o) => o.envelope_id), ["answered-IDD-1-B-2", "answered-IDD-1-B-1"]);
  assert.deepEqual(await finishAnsweredBatches(), [], "each batch has its own now");
});

test("AC-003: a batch whose own envelope is queued is not sent again", async () => {
  const { state } = setup({ batchAsks: [] });
  putClosedBatch(state, "B-1", CLOSE_NEW);
  putEnvelope(state, "answered-IDD-1-B-1", "2026-11-03T01:00:05.000Z");
  assert.deepEqual(await finishAnsweredBatches(), []);
  assert.equal(toldCount(state), 1);
});

test("AC-004: an envelope that names no batch marks only a batch closed before the named form, never one closed after it", async () => {
  const { state } = setup({ batchAsks: [] });
  // closed before the envelope carried the batch's id: the old envelope of the window is its mark, as it was
  putClosedBatch(state, "B-1", "2026-10-28T02:00:00.000Z", "q1");
  putEnvelope(state, "1761613250000-IDD-1", "2026-10-28T02:00:05.000Z");
  // closed after: the same kind of row, queued after its close, is not its mark
  putClosedBatch(state, "B-2", CLOSE_NEW, "q2");
  putEnvelope(state, "1762131600000-IDD-1", "2026-11-03T01:00:05.000Z");
  assert.deepEqual(await finishAnsweredBatches(), ["IDD-1/B-2"], "only the new batch is sent");
  assert.ok(outbox(state).some((o) => o.envelope_id === "answered-IDD-1-B-2"));
  assert.equal(outbox(state).some((o) => o.envelope_id === "answered-IDD-1-B-1"), false, "the old batch is read as delivered");
});

test("AC-004: an old batch whose window holds no envelope is sent, with its own name", async () => {
  const { state } = setup({ batchAsks: [] });
  putClosedBatch(state, "B-1", "2026-10-28T02:00:00.000Z");
  assert.deepEqual(await finishAnsweredBatches(), ["IDD-1/B-1"]);
  assert.deepEqual(outbox(state).map((o) => o.envelope_id), ["answered-IDD-1-B-1"]);
});

// ---------------------------------------------------------------- the tick's re-close and the gate

/** take the lane gate from outside and keep it; the returned function lets it go */
async function holdGate() {
  let letGo;
  let entered;
  const inside = new Promise((r) => { entered = r; });
  const held = withLaneGate(() => new Promise((r) => { letGo = r; entered(); }));
  await inside;
  return async () => { letGo(); await held; };
}

/** the warnings said while `fn` runs, each with the time it was said; `fn` is handed the list as it grows */
async function warningsOf(fn) {
  const said = [];
  const warn = console.warn;
  console.warn = (...args) => { said.push({ text: args.map(String).join(" "), at: Date.now() }); };
  try {
    await fn(said);
  } finally {
    console.warn = warn;
  }
  return said;
}

/** the re-close's warnings, as the tick's log shows them */
const recloseWarnings = (said) => said.filter((w) => w.text.includes("閉じ直せ"));

/**
 * Start a re-close while the gate is held, make `change` while it waits, then let the gate go. The list of batches is
 * made before the first wait, so what `change` writes is seen only by the reading in the gate. Returns what the
 * re-close closed and how many rows it added after `change`.
 */
async function recloseAcross(state, change) {
  const rows = () => ({ lifecycle: readLifecycle().length, outbox: outbox(state).length });
  const letGo = await holdGate();
  let run;
  let before;
  try {
    run = finishAnsweredBatches();
    change();
    before = rows();
  } finally {
    await letGo();
  }
  const finished = await run;
  const after = rows();
  return { finished, added: { lifecycle: after.lifecycle - before.lifecycle, outbox: after.outbox - before.outbox } };
}

test("a batch of a closed lane is passed before the gate: the re-close neither waits for a held gate nor says it is busy", async () => {
  const { state, seed } = setup();
  putAnswers(state, ["q1", "q2"]);
  seed("lane_close");
  process.env.IDD_LANE_GATE_WAIT_MS = "300";
  const letGo = await holdGate();
  let finished;
  let said;
  try {
    said = await warningsOf(async () => { finished = await finishAnsweredBatches(); });
  } finally {
    await letGo();
  }
  assert.deepEqual(finished, []);
  assert.deepEqual(recloseWarnings(said), [], "the gate was never asked for");
  assert.equal(eventCount("question_batch_answered"), 0, "nothing is written to a closed lane");
  assert.equal(toldCount(state), 0);
});

test("a batch whose close and word to the planner are both on record is passed before the gate, and a batch with a half missing still goes to it", async () => {
  const { state } = setup({ batchAsks: [] });
  // closed before the named form, with the old envelope of its window; and closed after it, with its own envelope
  putClosedBatch(state, "B-1", "2026-10-28T02:00:00.000Z", "q1");
  putEnvelope(state, "1761613250000-IDD-1", "2026-10-28T02:00:05.000Z");
  putClosedBatch(state, "B-2", CLOSE_NEW, "q2");
  putEnvelope(state, "answered-IDD-1-B-2", "2026-11-03T01:00:05.000Z");
  process.env.IDD_LANE_GATE_WAIT_MS = "300";
  let letGo = await holdGate();
  let said;
  try {
    said = await warningsOf(async () => assert.deepEqual(await finishAnsweredBatches(), []));
  } finally {
    await letGo();
  }
  assert.deepEqual(recloseWarnings(said), [], "the gate was never asked for");
  // a third batch has every answer and no close: that one is the gate's to read
  put(state, "pending-questions.jsonl", { idd_id: "IDD-1", batch_id: "B-3", asked_at: T0, questions: [question("q3")] });
  put(state, "pending-answers.jsonl", { idd_id: "IDD-1", batch_id: "B-3", question_id: "q3", answered_at: CLOSE_NEW_2, selection: { index: 1, label: "案 A" } });
  put(state, "lifecycle-test.jsonl", { idd_id: "IDD-1", event: "question_batch_asked", at: T0, attrs: { batch_id: "B-3" } });
  letGo = await holdGate();
  try {
    said = await warningsOf(async () => assert.deepEqual(await finishAnsweredBatches(), []));
  } finally {
    await letGo();
  }
  assert.deepEqual(recloseWarnings(said).map((w) => w.text.includes("IDD-1/B-3")), [true], "only the batch with a half missing waited for the gate");
  assert.deepEqual(await finishAnsweredBatches(), ["IDD-1/B-3"]);
});

test("a lane closed while the re-close waits for the gate is read again in the gate, and nothing is written to it", async () => {
  const { state, seed } = setup({ batchAsks: [] });
  // the batch has no asked event: a write in the gate that missed the lane's close would add one
  putAnsweredNoAsk(state);
  assert.deepEqual(await recloseAcross(state, () => seed("lane_close")), { finished: [], added: { lifecycle: 0, outbox: 0 } });
});

test("a close that lands while the re-close waits for the gate is read again in the gate, and the batch is not closed twice", async () => {
  const { state, seed } = setup();
  putAnswers(state, ["q1", "q2"]);
  // a person's close lands in between, with its word to the planner
  const landed = () => {
    seed("question_batch_answered", { batch_id: "B-1" });
    putEnvelope(state, "answered-IDD-1-B-1", new Date().toISOString());
  };
  assert.deepEqual(await recloseAcross(state, landed), { finished: [], added: { lifecycle: 0, outbox: 0 } });
});

test("a re-close asked for while one runs does not run beside it, and runs once after it ends", async () => {
  const { state } = setup();
  putAnswers(state, ["q1", "q2"]);
  process.env.IDD_LANE_GATE_WAIT_MS = "300";
  // the gate stays held: every pass waits out the wait and says so, so the warnings count the passes and time them
  let letGo = await holdGate();
  let said;
  try {
    said = await warningsOf(async () => {
      // three ticks in a row while the first pass waits for the gate
      finishQuestionBatches();
      finishQuestionBatches();
      finishQuestionBatches();
      await settleQuestionRouting();
    });
  } finally {
    await letGo();
  }
  const passes = recloseWarnings(said);
  assert.equal(passes.length, 2, "the first pass, and one pass for the two calls that met it");
  assert.ok(passes[1].at - passes[0].at >= 250, "the second pass began its wait only after the first one ended");
  assert.equal(eventCount("question_batch_answered"), 0);

  // a call that met a pass is not lost: the gate is free before the pass after it asks, and that pass closes the batch
  process.env.IDD_LANE_GATE_WAIT_MS = "1000";
  letGo = await holdGate();
  said = await warningsOf(async (saying) => {
    try {
      finishQuestionBatches();
      finishQuestionBatches();
      while (!recloseWarnings(saying).length) await new Promise((r) => setTimeout(r, 10));
    } finally {
      await letGo();
    }
    await settleQuestionRouting();
  });
  assert.equal(recloseWarnings(said).length, 1, "only the first pass gave up on the gate");
  assert.equal(eventCount("question_batch_answered"), 1, "the pass after it closed the batch");
  assert.equal(toldCount(state), 1);
});

test("a call that meets a re-close running past its limit says so once, and starts nothing beside it", async () => {
  const { state } = setup();
  putAnswers(state, ["q1", "q2"]);
  const letGo = await holdGate();
  const said = await warningsOf(async () => {
    try {
      finishQuestionBatches();
      // the clock is moved past the limit only for the calls that meet the running pass; nothing else runs in between
      mock.timers.enable({ apis: ["Date"], now: Date.now() + RECLOSE_LONG_MS + 1000 });
      try {
        finishQuestionBatches();
        finishQuestionBatches();
      } finally {
        mock.timers.reset();
      }
    } finally {
      await letGo();
    }
    await settleQuestionRouting();
  });
  assert.equal(said.filter((w) => w.text.includes("分を超えて")).length, 1, "said once for the pass");
  assert.deepEqual(recloseWarnings(said), [], "the gate was let go before any pass gave up on it");
  assert.equal(eventCount("question_batch_answered"), 1);
  assert.equal(toldCount(state), 1, "the calls folded into one pass close nothing twice");
});

/** a column that cannot be read: its file set aside and a directory in its place; the returned function puts it back */
function breakColumn(state, file) {
  const path = join(state, file);
  const aside = `${path}.aside`;
  const had = existsSync(path);
  if (had) renameSync(path, aside);
  mkdirSync(path);
  return () => {
    rmSync(path, { recursive: true });
    if (had) renameSync(aside, path);
  };
}
const ANSWERS = "pending-answers.jsonl";
const QUESTIONS = "pending-questions.jsonl";
const personAnswer = (id) => ({ idd_id: "IDD-1", batch_id: "B-1", question_id: id, answered_at: T0, selection: { index: 1, label: "案 A" }, reason: null, notes: null });

test("a column that is not there, or is empty, reads as no rows, and one that is there and cannot be read is not an empty list", () => {
  const { state } = setup({ batchAsks: [], events: [] });
  assert.deepEqual([readAnswers(), readQuestionBatches(), readOpenQuestions()], [[], [], []], "no column at all holds nothing");
  writeFileSync(join(state, ANSWERS), "");
  writeFileSync(join(state, QUESTIONS), "");
  assert.deepEqual([readAnswers(), readQuestionBatches(), unreadableAnswerColumns()], [[], [], []], "an empty column holds nothing");
  rmSync(join(state, ANSWERS));
  rmSync(join(state, QUESTIONS));
  for (const [file, column] of [[ANSWERS, "答えの列"], [QUESTIONS, "質問の列"]]) {
    const restore = breakColumn(state, file);
    assert.throws(() => (file === ANSWERS ? readAnswers() : readQuestionBatches()), (e) => e instanceof AnswerColumnUnreadable && e.column === column);
    assert.throws(() => readOpenQuestions(), AnswerColumnUnreadable);
    assert.deepEqual(unreadableAnswerColumns(), [column]);
    restore();
    assert.deepEqual(unreadableAnswerColumns(), []);
  }
});

test("while either column cannot be read, no close, no answer, no question and no envelope is written, and the next tick closes the batch as before", async () => {
  const { state } = setup({ batchAsks: [["q1", "q2"]] });
  put(state, ANSWERS, personAnswer("q1"));
  put(state, ANSWERS, personAnswer("q2"));
  for (const file of [ANSWERS, QUESTIONS]) {
    const restore = breakColumn(state, file);
    assert.deepEqual(await finishAnsweredBatches(), [], `${file}: nothing is closed`);
    const pressed = await applyDecision("answer", { iddId: "IDD-1", batchId: "B-1", questionId: "q1", selection: { index: 2 } });
    assert.equal(pressed.ok, false, `${file}: a press is refused`);
    assert.equal(eventCount("question_batch_answered"), 0, `${file}: no close event`);
    assert.equal(toldCount(state), 0, `${file}: no envelope to the planner`);
    restore();
  }
  assert.equal(readAnswers().length, 2, "the refused presses added no answer row");
  assert.deepEqual(await finishAnsweredBatches(), ["IDD-1/B-1"]);
  assert.equal(eventCount("question_batch_answered"), 1);
  assert.equal(toldCount(state), 1);
  assert.deepEqual(await finishAnsweredBatches(), [], "once");
});

test("a close asked for directly while a column cannot be read answers with an error and writes nothing", async () => {
  const { state } = setup({ batchAsks: [["q1"]] });
  put(state, ANSWERS, personAnswer("q1"));
  const restore = breakColumn(state, QUESTIONS);
  const r = await closeAnsweredBatch("IDD-1", "B-1", []);
  assert.match(r.error ?? "", /質問の列/);
  assert.equal(r.unreadableColumn, "質問の列", "the error names the column that could not be read");
  assert.equal(eventCount("question_batch_answered"), 0);
  assert.equal(toldCount(state), 0);
  restore();
  assert.ok("envelopeId" in (await closeAnsweredBatch("IDD-1", "B-1", [])));
});

test("an answer saved whose close could not read a column is a recorded press with a warning, and any other close error still fails the press", () => {
  const wrote = ["answers.jsonl"];
  const unread = answerResultOf({ error: "x", unreadableColumn: "答えの列" }, wrote);
  assert.equal(unread.ok, true);
  assert.equal(unread.error, undefined);
  assert.match(unread.warning ?? "", /答えは記録しました。答えの列を読めない/);
  assert.deepEqual(unread.wrote, wrote);
  assert.deepEqual(answerResultOf({ error: "gate busy" }, wrote), { ok: false, wrote, error: "gate busy" });
  assert.deepEqual(answerResultOf({ remaining: 1 }, wrote), { ok: true, wrote, remaining: 1 });
  assert.deepEqual(answerResultOf({ envelopeId: "e" }, wrote), { ok: true, wrote, envelopeId: "e" });
});

test("a person's press while the questions' column cannot be read writes no answer and keeps no default, and the same press afterwards records the chosen label", async () => {
  const { state } = setup({ batchAsks: [["q1", "q2"]] });
  const press = () => applyDecision("answer", { iddId: "IDD-1", batchId: "B-1", questionId: "q2", selection: { index: 2 } });
  const restore = breakColumn(state, QUESTIONS);
  const refused = await press();
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /質問の列/);
  assert.equal(existsSync(join(state, ANSWERS)), false, "no answers file, so no row, was made");
  restore();
  const done = await press();
  assert.equal(done.ok, true);
  assert.deepEqual(readAnswers().map((a) => [a.question_id, a.selection.label]), [["q2", "案 B"]]);
});

// the resend after a column could be read again lands the question row and its asked event once
const resendLandsOnce = async () => {
  assert.deepEqual(await ask(["q1"]), { ok: true });
  await settleQuestionRouting();
  assert.equal(readQuestionBatches().length, 1, "the question row is written once");
  assert.equal(eventCount("question_batch_asked"), 1);
};

test("the planner's ask while either column cannot be read is refused, writes no row and no asked event, and the resend is recorded once", async () => {
  const { state } = setup({ batchAsks: [], events: ["lane_open"] });
  for (const [file, name] of [[QUESTIONS, /質問の列/], [ANSWERS, /答えの列/]]) {
    const restore = breakColumn(state, file);
    const refused = await ask(["q1"]);
    assert.equal(refused.ok, false, `${file}: refused`);
    assert.match(refused.error, name);
    assert.equal(eventCount("question_batch_asked"), 0, `${file}: no asked event`);
    restore();
    assert.equal(readQuestionBatches().length, 0, `${file}: no question row was written`);
  }
  await resendLandsOnce();
  assert.deepEqual(await ask(["q1"]), { ok: true });
  assert.equal(readQuestionBatches().length, 1);
});

test("the planner's ask is refused when a column lost its permission after a read, or is a link to nothing, and writes nothing until it can be read", { skip: process.getuid?.() === 0 }, async () => {
  const { state } = setup({ batchAsks: [], events: ["lane_open"] });
  for (const file of [QUESTIONS, ANSWERS]) {
    const path = join(state, file);
    writeFileSync(path, "");
    readAnswers(); readQuestionBatches();
    chmodSync(path, 0o000);
    const refused = await ask(["q1"]);
    chmodSync(path, 0o644);
    assert.equal(refused.ok, false, `${file}: a warm copy does not make a column that cannot be opened readable`);
    assert.equal(eventCount("question_batch_asked"), 0, `${file}: no asked event`);
    assert.equal(readQuestionBatches().length, 0, `${file}: no question row`);
    rmSync(path);
    symlinkSync(join(state, "nowhere.jsonl"), path);
    const dangling = await ask(["q1"]);
    rmSync(path);
    assert.equal(dangling.ok, false, `${file}: a link to nothing is not a column not made yet`);
    assert.equal(eventCount("question_batch_asked"), 0);
  }
  await resendLandsOnce();
});

test("a hold is kept while the questions' column cannot be read, the refusal names the column, and the tick writes nothing until it can be read", async () => {
  const { state } = setup({ batchAsks: [["q1", "q2"]] });
  // B-1 has landed (its row and its asked event), so its hold is released; B-2 never landed
  holdBatch(batchOf("q1", "q2"));
  holdBatch({ ...batchOf("q3"), batch_id: "B-2" });
  assert.deepEqual(heldBatches("IDD-1").map((b) => b.batch_id), ["B-2"]);
  const restore = breakColumn(state, QUESTIONS);
  assert.deepEqual(heldBatches("IDD-1").map((b) => b.batch_id).sort(), ["B-1", "B-2"], "no row can be seen, so no hold is released by one");
  assert.match(routingHoldReason("IDD-1") ?? "", /質問の列を読めない/);
  assert.doesNotMatch(routingHoldReason("IDD-1") ?? "", /振り分けている最中/);
  assert.match(goBlockedReason("IDD-1") ?? "", /質問の列/);
  finishQuestionBatches();
  await settleQuestionRouting();
  assert.equal(eventCount("question_batch_asked"), 1, "the tick added no asked event");
  assert.equal(heldBatches("IDD-1").length, 2, "and released no hold");
  restore();
  assert.deepEqual(heldBatches("IDD-1").map((b) => b.batch_id), ["B-2"]);
  finishQuestionBatches();
  await settleQuestionRouting();
  assert.equal(heldBatches("IDD-1").length, 0, "the batch the judge never finished is recovered as a person's");
  assert.deepEqual(readQuestionBatches().map((b) => b.batch_id).sort(), ["B-1", "B-2"], "B-1's row was not written a second time");
  assert.equal(goBlockedReason("IDD-1"), null);
});

test("with the judge on, the planner's ask while only the answers' column cannot be read is refused with no hold, and the resend lands once", async () => {
  const { state, seed } = setup({ batchAsks: [], events: ["lane_open"] });
  seed("s1_ready", { depth: "deep" });
  seed("s1_plan_review_done", { must: 0, should: 0, nit: 0 });
  runnerSaying(answersJson({ id: "q1", decider: "human", kind: "scope", reason: "範囲の判断" }));
  const restore = breakColumn(state, ANSWERS);
  const refused = await ask(["q1"]);
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /答えの列/);
  assert.equal(existsSync(routingHoldPath()), false, "no hold was made for a batch nobody can land");
  assert.equal(heldBatches("IDD-1").length, 0);
  assert.equal(eventCount("question_batch_asked"), 0);
  assert.equal(readQuestionBatches().length, 0);
  restore();
  await resendLandsOnce();
  assert.equal(heldBatches("IDD-1").length, 0, "the hold is released by the landing");
});

test("the refusal of a GO names the answers' column too when a held batch cannot be known to be judged", () => {
  const { state } = setup({ batchAsks: [] });
  holdBatch(batchOf("q1"));
  const restore = breakColumn(state, ANSWERS);
  assert.match(routingHoldReason("IDD-1") ?? "", /答えの列を読めない/);
  assert.match(goBlockedReason("IDD-1") ?? "", /答えの列/);
  restore();
  assert.match(routingHoldReason("IDD-1") ?? "", /振り分けている最中/);
});

test("a routed result is not written while a column cannot be read: no answer without its batch", async () => {
  const { state } = setup({ batchAsks: [] });
  const restore = breakColumn(state, QUESTIONS);
  await assert.rejects(recordRoutedBatch(batchOf("q1", "q2"), [{ questionId: "q1", selection: { index: 1, label: "案 A" }, by: BY, basis: [cite("issue", "", QUOTE)], reason: "r" }]), AnswerColumnUnreadable);
  assert.equal(existsSync(join(state, ANSWERS)), false);
  assert.equal(eventCount("question_batch_asked"), 0);
  restore();
});

test("while the answers' column cannot be read the open list names no batch, and it lists only the questions without an answer once it can", () => {
  const { state } = setup({ batchAsks: [["q1", "q2"]] });
  put(state, ANSWERS, personAnswer("q1"));
  const restore = breakColumn(state, ANSWERS);
  assert.throws(() => readOpenQuestions(), AnswerColumnUnreadable);
  restore();
  assert.deepEqual(readOpenQuestions().map((b) => b.questions.length), [2], "the batch is open while one question has no answer");
  put(state, ANSWERS, personAnswer("q2"));
  assert.deepEqual(readOpenQuestions(), []);
});
