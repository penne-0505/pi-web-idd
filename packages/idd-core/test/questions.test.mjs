import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeQuestions, OPTION_LABEL_MAX } from '../src/agent/questions.ts';
import { agentAskQuestions } from '../src/agent/inbound.ts';
import { plannerBrief } from '../src/plan/prep.ts';
import { executorBrief } from '../src/plan/exec.ts';
import { questionAnsweredEnvelope } from '../src/ledger/write.ts';

const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'idd-questions-'));
  made.push(root);
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main' } } }));
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify(rec) + '\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  return { root, state };
}

const rec = { idd_id: 'IDD-1', area: 'me/app', title: 'T', context: '', gh_issue_url: 'https://github.com/me/app/issues/1', created_at: '2026-09-24T00:00:00Z' };

const question = (options) => ({ question_id: 'q1', question: 'どちらにしますか', context: 'c', options });

test('options without a recommendation (the older form) are still accepted as they were', () => {
  const r = normalizeQuestions([question([{ index: 1, label: 'A' }, { index: 2, label: 'B', description: 'd' }])]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.questions[0].options, [{ index: 1, label: 'A' }, { index: 2, label: 'B', description: 'd' }]);
});

test('an option keeps its description whether or not it carries a level', () => {
  const r = normalizeQuestions([question([{ index: 1, label: 'A', description: 'A を選ぶとこうなる。' }, { index: 2, label: 'B', description: 'B を選ぶとこうなる。', recommendation: 'acceptable', rationale: 'r' }])]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.questions[0].options, [
    { index: 1, label: 'A', description: 'A を選ぶとこうなる。' },
    { index: 2, label: 'B', description: 'B を選ぶとこうなる。', recommendation: 'acceptable', rationale: 'r' },
  ]);
});

test('a label longer than the limit is refused with the question, the option and the length', () => {
  const long = 'あ'.repeat(OPTION_LABEL_MAX + 1);
  const r = normalizeQuestions([question([{ index: 1, label: 'A' }, { index: 2, label: long }])]);
  assert.equal(r.ok, false);
  assert.match(r.error, /questions\[0\]\.options\[1\]/);
  assert.match(r.error, /41 文字/);
});

test('a label of exactly the limit passes, counted in characters not UTF-16 units, after trimming the edges', () => {
  const atLimit = 'あ'.repeat(OPTION_LABEL_MAX);
  assert.equal(normalizeQuestions([question([{ index: 1, label: atLimit }])]).ok, true);
  // an emoji is 2 UTF-16 units but 1 character: 40 of them must pass
  const emoji = '😀'.repeat(OPTION_LABEL_MAX);
  assert.equal(emoji.length, OPTION_LABEL_MAX * 2);
  assert.equal(normalizeQuestions([question([{ index: 1, label: emoji }])]).ok, true);
  // the length is counted after the edges are trimmed
  assert.equal(normalizeQuestions([question([{ index: 1, label: `  ${atLimit}  ` }])]).ok, true);
});

test('each option keeps its recommendation level and rationale', () => {
  const r = normalizeQuestions([question([
    { index: 1, label: 'A', recommendation: 'recommended', rationale: 'README の手順と一致する。' },
    { index: 2, label: 'B', recommendation: 'acceptable', rationale: '動くが手順が 1 つ増える。' },
    { index: 3, label: 'C', recommendation: 'not_recommended', rationale: 'CI の検査で落ちる。' },
  ])]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.questions[0].options.map((o) => [o.recommendation, o.rationale]), [
    ['recommended', 'README の手順と一致する。'],
    ['acceptable', '動くが手順が 1 つ増える。'],
    ['not_recommended', 'CI の検査で落ちる。'],
  ]);
});

test('the words of the UI are read as the same levels', () => {
  const r = normalizeQuestions([question([
    { index: 1, label: 'A', recommendation: '推奨', rationale: 'r' },
    { index: 2, label: 'B', recommendation: '可', rationale: 'r' },
    { index: 3, label: 'C', recommendation: '非推奨', rationale: 'r' },
  ])]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.questions[0].options.map((o) => o.recommendation), ['recommended', 'acceptable', 'not_recommended']);
});

test('an unknown level or a level without a rationale is refused with where it is', () => {
  const unknown = normalizeQuestions([question([{ index: 1, label: 'A', recommendation: 'maybe', rationale: 'r' }])]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /questions\[0\]\.options\[0\].*recommendation/);
  const bare = normalizeQuestions([question([{ index: 1, label: 'A', recommendation: 'recommended' }])]);
  assert.equal(bare.ok, false);
  assert.match(bare.error, /rationale/);
});

test('a malformed batch is refused rather than stored', () => {
  assert.equal(normalizeQuestions([]).ok, false);
  assert.equal(normalizeQuestions([{ question: 'x', options: [] }]).ok, false);
  assert.equal(normalizeQuestions([question([{ label: 'A' }])]).ok, false);
});

test('the write-back records the levels in pending-questions and refuses a bad batch without writing', async () => {
  const { state } = setup();
  const ok = await agentAskQuestions({ iddId: 'IDD-1', batchId: 'b1', questions: [question([
    { index: 1, label: 'A', description: 'A の説明。', recommendation: 'recommended', rationale: '確かめた。', extra: 'dropped' },
    { index: 2, label: 'B' },
  ])] });
  assert.deepEqual(ok, { ok: true });
  const stored = readFileSync(join(state, 'pending-questions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].questions[0].options, [
    { index: 1, label: 'A', description: 'A の説明。', recommendation: 'recommended', rationale: '確かめた。' },
    { index: 2, label: 'B' },
  ]);

  const bad = await agentAskQuestions({ iddId: 'IDD-1', batchId: 'b2', questions: [question([{ index: 1, label: 'A', recommendation: 'x', rationale: 'r' }])] });
  assert.equal(bad.ok, false);
  assert.equal(readFileSync(join(state, 'pending-questions.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('C-264-3: a report with two questions of one id is refused with the id and the place of the first, and writes nothing', async () => {
  const { state } = setup();
  const two = [question([{ index: 1, label: 'A' }]), { ...question([{ index: 1, label: 'B' }]), question: '別の質問' }];
  const r = normalizeQuestions(two);
  assert.equal(r.ok, false);
  assert.match(r.error, /questions\[1\]/);
  assert.match(r.error, /q1/);
  assert.match(r.error, /questions\[0\]/);
  const bad = await agentAskQuestions({ iddId: 'IDD-1', batchId: 'b1', questions: two });
  assert.equal(bad.ok, false);
  assert.equal(existsSync(join(state, 'pending-questions.jsonl')), false);
  // told apart by id, the same two questions are taken, and each has its own answer to give
  const ok = normalizeQuestions(two.map((q, i) => ({ ...q, question_id: `q${i + 1}` })));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.questions.map((q) => q.question_id), ['q1', 'q2']);
});

test('C-264-3: an id that differs only by the spaces around it is the same id', () => {
  const r = normalizeQuestions([question([{ index: 1, label: 'A' }]), { ...question([{ index: 1, label: 'A' }]), question_id: ' q1 ' }]);
  assert.equal(r.ok, false);
});

test('a batch with a label over the limit writes nothing', async () => {
  const { state } = setup();
  const long = 'あ'.repeat(OPTION_LABEL_MAX + 1);
  const bad = await agentAskQuestions({ iddId: 'IDD-1', batchId: 'b1', questions: [question([{ index: 1, label: long }])] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /40 文字まで/);
  assert.equal(existsSync(join(state, 'pending-questions.jsonl')), false);
});

test('the planner and executor briefs ask for a description, a level and a rationale on every option', () => {
  setup();
  const planner = plannerBrief(rec);
  const executor = executorBrief(rec, join(tmpdir(), 'none'));
  for (const brief of [planner, executor]) {
    assert.match(brief, /"label","description","recommendation":"recommended\|acceptable\|not_recommended","rationale"/);
    assert.match(brief, /rationale は、検証済み事実/);
    assert.match(brief, /recommended は原則 1 つ/);
  }
});

test('the planner and executor question-rules are the same EX-01 lines, with description and no stale rationale line', () => {
  setup();
  const planner = plannerBrief(rec);
  const executor = executorBrief(rec, join(tmpdir(), 'none'));
  const rulesOf = (brief) => brief.split('<question-rules>')[1].split('</question-rules>')[0].split('\n').map((l) => l.trim()).filter(Boolean);
  const plannerRules = rulesOf(planner);
  const executorRules = rulesOf(executor);
  assert.deepEqual(plannerRules, executorRules);
  assert.equal(plannerRules.length, 5);
  assert.match(plannerRules[0], /。$/);
  assert.match(plannerRules[1], /description に書く/);
  assert.doesNotMatch(plannerRules[1], /rationaleに書く/);
});

test('AC-020: the question rules and the executor task name the ask tool and the CLI, and the catalog carries the same lines', () => {
  setup();
  const planner = plannerBrief(rec);
  const executor = executorBrief(rec, join(tmpdir(), 'none'));
  const first = (brief) => brief.split('<question-rules>')[1].split('</question-rules>')[0].split('\n').map((l) => l.trim()).filter(Boolean)[0];
  for (const brief of [planner, executor]) {
    assert.match(first(brief), /道具 `ask` があればそれで尋ね、答えを待って続ける/);
    assert.match(first(brief), /`idd report questions` で尋ねる/);
  }
  const task = executor.split('<task>')[1].split('</task>')[0];
  assert.match(task, /道具 `ask` があればそれで尋ね、答えを待って続ける/);
  assert.match(task, /無ければ実装を中断し、`idd report questions` で尋ねる/);
  // the catalog is written with the future CLI name, so the shared words are what must line up
  const c01 = readFileSync(new URL('../../../_meta/prompt-catalog/01-planner.md', import.meta.url), 'utf8');
  const c03 = readFileSync(new URL('../../../_meta/prompt-catalog/03-executor.md', import.meta.url), 'utf8');
  for (const catalog of [c01, c03]) {
    assert.match(catalog, /道具 `ask` があればそれで尋ね、答えを待って続ける。`ask` が無ければ応答を止めて `propter report questions` で尋ねる/);
  }
  assert.match(c03, /道具 `ask` があればそれで尋ね、答えを待って続ける。無ければ実装を中断し、`propter report questions` で尋ねる/);
});

test('the answered envelope carries the question, the selection and the reason, and does not echo the options', () => {
  setup();
  const xml = questionAnsweredEnvelope('IDD-1', 'b1', [{
    questionId: 'q1', question: 'Q',
    selection: { index: 1, label: 'A' },
    reason: '根拠。', notes: '補足。',
  }]);
  const pair = xml.split('<qa-pair question-id="q1">')[1].split('</qa-pair>')[0];
  const children = [...pair.matchAll(/<(\w+)[ >]/g)].map((m) => m[1]);
  assert.deepEqual(children, ['question', 'selection', 'reason', 'notes']);
});

test('an envelope for an answer without a reason or a note has only the two elements', () => {
  setup();
  const xml = questionAnsweredEnvelope('IDD-1', 'b1', [{ questionId: 'q1', question: 'Q', selection: { label: 'その他' } }]);
  const pair = xml.split('<qa-pair question-id="q1">')[1].split('</qa-pair>')[0];
  const children = [...pair.matchAll(/<(\w+)[ >]/g)].map((m) => m[1]);
  assert.deepEqual(children, ['question', 'selection']);
});

test('the answered envelope drops the selected option\'s description, level and rationale', () => {
  setup();
  const xml = questionAnsweredEnvelope('IDD-1', 'b1', [{
    questionId: 'q1', question: 'Q',
    selection: { index: 1, label: 'A' },
    reason: 'R & S',
  }]);
  assert.match(xml, /<question>Q<\/question>/);
  assert.match(xml, /<selection index="1">A<\/selection>/);
  assert.match(xml, /<reason>R &amp; S<\/reason>/);
  assert.doesNotMatch(xml, /description/);
  assert.doesNotMatch(xml, /<recommendation>/);
  assert.doesNotMatch(xml, /<rationale>/);
});

test('names that live on every object are not taken for a level', () => {
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const r = normalizeQuestions([question([{ index: 1, label: 'A', recommendation: name, rationale: 'r' }])]);
    assert.equal(r.ok, false, name);
    assert.match(r.error, /recommendation/);
  }
});

test('more than one recommended option is refused, so the card shows at most one filled chip', () => {
  const r = normalizeQuestions([question([
    { index: 1, label: 'A', recommendation: 'recommended', rationale: 'r' },
    { index: 2, label: 'B', recommendation: '推奨', rationale: 'r' },
  ])]);
  assert.equal(r.ok, false);
  assert.match(r.error, /questions\[0\]: at most 1 option may be recommended/);
  const one = normalizeQuestions([question([
    { index: 1, label: 'A', recommendation: 'recommended', rationale: 'r' },
    { index: 2, label: 'B', recommendation: 'acceptable', rationale: 'r' },
  ])]);
  assert.equal(one.ok, true);
});

test('a stored option with a level that is not text still makes an envelope', () => {
  setup();
  const xml = questionAnsweredEnvelope('IDD-1', 'b1', [{
    questionId: 'q1', question: 'Q',
    selection: { index: 1, label: 'A' },
  }]);
  assert.match(xml, /<qa-pair question-id="q1">/);
  assert.match(xml, /<selection index="1">A<\/selection>/);
});

test('AC-015: the answered envelope asks for the causal Why and how to mark a guess', () => {
  setup();
  const xml = questionAnsweredEnvelope('IDD-1', 'b1', [{ questionId: 'q1', question: 'Q', selection: { label: 'A' } }]);
  const task = xml.split('<task>')[1].split('</task>')[0];
  assert.match(task, /答えが plan の内容を変えるなら、decision\.md の該当する DEC の Why に因果を残す。reason が因果ならそれを使う。reason が空か出所だけのときは、因果を推測して「推測」と明示する/);
  assert.match(task, /（「質問 qN の回答」のような出典は見出しに混ぜない）。/);
});
