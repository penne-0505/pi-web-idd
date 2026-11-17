import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyDecision } from '../src/ledger/write.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { questionAnsweredByNote, reviewLoopState } from '../src/ledger/review-loop.ts';
import { humanLines, triageHistory } from '../src/plan/review-loop.ts';
import { tmpDir } from './helpers/tmp.mjs';

// A question the judgement put to penne, and penne's answer to it on the stuck card, reach every later round's judgement
// and spec check as a question answered, so neither asks it again.
//
// The rows are IDD-292's own (APP-2251 bench run5), through round 6's reports. Round 4's judgement asked whether
// Get Login Bonus is recorded when the grant is accepted or when its screen is shown; penne answered on the card's note
// (the screen, as before the change). Round 6's judgement asked the same question again (2026-11-14 01:07): the note was
// handed to no later reader (cadf31509), so the answer lived only in the executor's envelope. The answer to a question
// is now recorded with the continue, as the question's answer, and only that is handed on. A note on a stop that asked
// no question (round 2's shape stop, round 5's cap stop) stays an instruction to the executor. The blind is never handed
// any of it (DEC-113-5).

const HERE = dirname(fileURLToPath(import.meta.url));
const ROWS = readFileSync(join(HERE, 'fixtures', 'review-human-lines', 'idd-292-to-round-6.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const answerAt = (round) => {
  const t = ROWS.findIndex((e) => e.event === 's2_triage_done' && e.attrs.round === round);
  return ROWS.findIndex((e, i) => i > t && e.event === 's2_review_resumed');
};
const ROUND4_ANSWER = answerAt(4);
const ROUND4_NOTE = ROWS[ROUND4_ANSWER].attrs.note;
const ROUND4_QUESTION = 'Get Login Bonus の記録時点と対象経路が変わり';
const ROUND2_NOTE = ROWS[answerAt(2)].attrs.note;
const ROUND5_NOTE = ROWS[answerAt(5)].attrs.note;
const ROUND3_BOUNDARY = ROWS[answerAt(3)].attrs.boundaries[0].text;

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE, roles: process.env.IDD_ROLES_FILE };
afterEach(() => {
  for (const [key, name] of [['state', 'IDD_STATE_DIR'], ['repos', 'IDD_REPOS_FILE'], ['roles', 'IDD_ROLES_FILE']]) {
    if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
  }
});

/** the lane as it stood when penne answered round 4's stop: its rows written to a state of its own */
function stoppedAtRound4() {
  const state = tmpDir('idd-answered-');
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: { 'Dayseum/daysai-flutter': { upstream: join(state, 'u'), work: join(state, 'w') } } }));
  writeFileSync(join(state, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  executor: { role: r }\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(state, 'repos.yaml'), IDD_ROLES_FILE: join(state, 'roles.yaml') });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-292', area: 'Dayseum/daysai-flutter', title: 'T', context: '', source_type: 'linear', parent_id: null }) + '\n');
  writeFileSync(join(state, 'lifecycle-Dayseum-daysai-flutter.jsonl'), ROWS.slice(0, ROUND4_ANSWER).map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}

/** round 4's answer as the card sends it now, followed by the lane's own rows through `upto` */
async function answeredThrough(upto) {
  stoppedAtRound4();
  assert.equal(reviewLoopState(readLifecycle()).state, 'escalated');
  const done = await applyDecision('s2_review_continue', { iddId: 'IDD-292', note: ROUND4_NOTE });
  assert.equal(done.ok, true, done.error);
  const answer = readLifecycle().at(-1);
  return { answer, rows: [...ROWS.slice(0, ROUND4_ANSWER), answer, ...ROWS.slice(ROUND4_ANSWER + 1, upto)] };
}

test('the answer to round 4\'s stop records the note as the answer to the judgement\'s question, named by it', async () => {
  const { answer } = await answeredThrough(ROUND4_ANSWER + 1);
  assert.equal(answer.attrs.note, ROUND4_NOTE, 'the note still goes to the executor as it did');
  assert.equal(answer.attrs.answers.length, 1);
  const [a] = answer.attrs.answers;
  assert.equal(a.ref, 'Q-1');
  assert.ok(a.question.includes(ROUND4_QUESTION), a.question);
  assert.equal(a.text, ROUND4_NOTE.trim());
});

for (const round of [5, 6]) {
  test(`round ${round}'s judgement is handed round 4's question with penne's answer, and no note of a stop that asked none`, async () => {
    // the rows as they stood when the loop started that round's judgement, which is handed this history
    const t = ROWS.findIndex((e) => e.event === 's2_triage_started' && e.attrs.round === round);
    const { rows } = await answeredThrough(t);
    assert.equal(reviewLoopState(rows).state, 'start_triage');
    const history = triageHistory(rows);
    assert.ok(history);
    assert.match(history, /## penne が答えた判定の問い\n\n- 4-blind\/Q-1/);
    assert.ok(history.includes(ROUND4_QUESTION));
    assert.ok(history.includes(ROUND4_NOTE.trim()));
    assert.match(history, /答えた問いと同じことを尋ねる問いを escalate にしない/);
    // the answer reaches only as far as its question, on either side
    assert.match(history, /問いの外の部分は答えとして読まない。答えを、それ以外の指摘を受理する根拠にも棄却する根拠にもしない/);
    // a note on a stop that asked no question is an instruction to the executor (cadf31509)
    for (const note of [ROUND2_NOTE, ROUND5_NOTE]) assert.ok(!history.includes(note.trim()), note);
    // the boundary of round 3's reversal is still penne's decision, as it was
    assert.ok(history.includes(ROUND3_BOUNDARY));
    // the fix planner reads the same answer
    assert.ok((triageHistory(rows, 'fix_plan') ?? '').includes(ROUND4_NOTE.trim()));
  });

  test(`round ${round}'s spec check is handed round 4's question with penne's answer as the lane's spec`, async () => {
    const t = ROWS.findIndex((e) => e.event === 's2_review_started' && e.attrs.round === round);
    const { rows } = await answeredThrough(t);
    const lines = humanLines(rows);
    assert.ok(lines);
    assert.match(lines, /## 人が答えた判定の問い\n\n- 4-blind\/Q-1/);
    assert.ok(lines.includes(ROUND4_QUESTION));
    assert.ok(lines.includes(ROUND4_NOTE.trim()));
    assert.match(lines, /問いの外の部分は答えとして読まない。答えを、それ以外の指摘を出す根拠にも出さない根拠にもしない/);
    for (const note of [ROUND2_NOTE, ROUND5_NOTE]) assert.ok(!lines.includes(note.trim()), note);
  });
}

test('the lane\'s own rows, written before the answer was recorded as one, read as they did: no question answered', () => {
  const rows = ROWS.slice(0, ROWS.findIndex((e) => e.event === 's2_triage_done' && e.attrs.round === 6));
  const history = triageHistory(rows) ?? '';
  assert.doesNotMatch(history, /答えた判定の問い/);
  assert.ok(!history.includes(ROUND4_NOTE.trim()));
  assert.doesNotMatch(humanLines(rows) ?? '', /答えた判定の問い/);
});

test('a note on a stop whose judgement asked no question records no answer', async () => {
  stoppedAtRound4();
  // round 5's cap stop: its judgement asked penne nothing
  const t5 = ROWS.findIndex((e) => e.event === 's2_triage_done' && e.attrs.round === 5);
  assert.deepEqual(ROWS[t5].attrs.escalated_claims, []);
  writeFileSync(join(process.env.IDD_STATE_DIR, 'lifecycle-Dayseum-daysai-flutter.jsonl'), ROWS.slice(0, answerAt(5)).map((e) => JSON.stringify(e)).join('\n') + '\n');
  const done = await applyDecision('s2_review_continue', { iddId: 'IDD-292', note: ROUND5_NOTE });
  assert.equal(done.ok, true, done.error);
  assert.equal('answers' in readLifecycle().at(-1).attrs, false);
});

test('a continue without a note answers nothing, and taking the code by hand records no answer', async () => {
  stoppedAtRound4();
  assert.equal((await applyDecision('s2_review_continue', { iddId: 'IDD-292', note: '' })).ok, true);
  assert.equal('answers' in readLifecycle().at(-1).attrs, false);
  stoppedAtRound4();
  assert.equal((await applyDecision('s2_review_hand_fix', { iddId: 'IDD-292', note: ROUND4_NOTE })).ok, true);
  assert.equal('answers' in readLifecycle().at(-1).attrs, false);
});

test('accepting with a note answers the question too', async () => {
  stoppedAtRound4();
  assert.equal((await applyDecision('s2_review_accept', { iddId: 'IDD-292', note: ROUND4_NOTE })).ok, true);
  assert.equal(readLifecycle().at(-1).attrs.answers?.[0]?.ref, 'Q-1');
});

/** round 4's stop with its judgement changed by `edit` (a copy: the fixture's rows stay as they are) */
function stoppedWith(edit) {
  stoppedAtRound4();
  const rows = ROWS.slice(0, ROUND4_ANSWER).map((e) => JSON.parse(JSON.stringify(e)));
  edit(rows, rows.findLastIndex((e) => e.event === 's2_triage_done'));
  writeFileSync(join(process.env.IDD_STATE_DIR, 'lifecycle-Dayseum-daysai-flutter.jsonl'), rows.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return rows;
}

test('the stop asks its question only while one question stands alone: two questions or a reversal beside it record no answer, until the card asks each on a line of its own', async () => {
  assert.equal(questionAnsweredByNote(ROWS.slice(0, ROUND4_ANSWER)).length, 1, 'round 4\'s stop asks its one question');
  const two = stoppedWith((rows, t) => { rows[t].attrs.escalated_claims = [...rows[t].attrs.escalated_claims, '二つ目の問い']; });
  assert.deepEqual(questionAnsweredByNote(two), []);
  assert.equal((await applyDecision('s2_review_continue', { iddId: 'IDD-292', note: '答え' })).ok, true);
  assert.equal('answers' in readLifecycle().at(-1).attrs, false);
  // nor do the readers take an answer written there by hand: they read the stop as the write does
  const forged = [...two, { event: 's2_review_resumed', idd_id: 'IDD-292', at: '2026-11-13T23:51:16+09:00', attrs: { decision: 'continue', note: '答え', answers: [{ ref: 'Q-1', question: 'q', text: '答え' }], at_by: 'user' } }];
  assert.doesNotMatch(triageHistory(forged) ?? '', /答えた判定の問い/);
  const reversal = { ref: 'F-9', severity: 'should', claim: '往復', prior_ref: '1-blind/F-1', prior: '前', current: '今' };
  stoppedWith((rows, t) => { rows[t].attrs.oscillations = [reversal]; });
  assert.equal((await applyDecision('s2_review_continue', { iddId: 'IDD-292', note: '答え' })).ok, true);
  const answer = readLifecycle().at(-1);
  assert.equal('answers' in answer.attrs, false, 'the note is the reversal\'s boundary, not the question\'s answer');
  assert.deepEqual(answer.attrs.boundaries, [{ ref: 'F-9', choice: 'custom', text: '答え' }]);
});

/** a stop over a stage that failed after round 4's judgement, before penne answered its question */
const RETRY = { event: 's2_review_escalated', idd_id: 'IDD-292', at: '2026-11-13T23:51:00+09:00', attrs: { reason: '段が落ちた', retry_state: { state: 'send_fix', round: 4 } } };

test('a continue on a stop that only retries a stage records no answer, and the readers take none written there', async () => {
  const rows = stoppedWith((r) => r.push(RETRY));
  assert.equal(reviewLoopState(rows).retry?.state, 'send_fix');
  assert.equal((await applyDecision('s2_review_continue', { iddId: 'IDD-292', note: ROUND4_NOTE })).ok, true);
  assert.equal('answers' in readLifecycle().at(-1).attrs, false);
  // an answer written there by hand is not read: the write, the card and the readers read the stop alike
  const forged = [...rows, { event: 's2_review_resumed', idd_id: 'IDD-292', at: RETRY.at, attrs: { decision: 'continue', note: ROUND4_NOTE, answers: [{ ref: 'Q-1', question: 'q', text: ROUND4_NOTE }], at_by: 'user' } }];
  assert.doesNotMatch(triageHistory(forged) ?? '', /答えた判定の問い/);
  assert.doesNotMatch(humanLines(forged) ?? '', /答えた判定の問い/);
});

test('an answer on a stop with no judgement of the plan as it stands is not read', () => {
  // the lane went back to its plan after round 4's judgement, and an answer was written before any new judgement
  const rows = [...ROWS.slice(0, ROUND4_ANSWER),
    { event: 's1_replan_requested', idd_id: 'IDD-292', at: '2026-11-14T02:00:00+09:00', attrs: { rounds: 4, at_by: 'user' } },
    { event: 's2_review_resumed', idd_id: 'IDD-292', at: '2026-11-14T02:01:00+09:00', attrs: { decision: 'continue', note: 'n', answers: [{ ref: 'Q-1', question: 'q', text: 'n' }], at_by: 'user' } }];
  assert.doesNotMatch(triageHistory(rows) ?? '', /答えた判定の問い/);
  assert.equal(humanLines(rows), null);
});

test('a question and an answer of several lines stay inside their list item', async () => {
  stoppedAtRound4();
  assert.equal((await applyDecision('s2_review_continue', { iddId: 'IDD-292', note: '一行目\n二行目' })).ok, true);
  const answer = readLifecycle().at(-1);
  const t = ROWS.findIndex((e) => e.event === 's2_triage_started' && e.attrs.round === 5);
  const rows = [...ROWS.slice(0, ROUND4_ANSWER), answer, ...ROWS.slice(ROUND4_ANSWER + 1, t)];
  // the question was recorded with the answer; the history reads the recorded pair
  const recorded = rows.map((e) => (e === answer ? { ...e, attrs: { ...e.attrs, answers: [{ ...e.attrs.answers[0], question: '問いの一行目\n問いの二行目' }] } } : e));
  const history = triageHistory(recorded);
  assert.ok(history.includes('- 4-blind/Q-1: 問いの一行目\n  問いの二行目\n  - 答え: 一行目\n    二行目'), history);
});

test('after a return to the plan, the answered question binds no later round (P0)', async () => {
  const { rows } = await answeredThrough(ROUND4_ANSWER + 1);
  const replanned = [...rows, { event: 's1_replan_requested', idd_id: 'IDD-292', at: '2026-11-14T02:00:00+09:00', attrs: { rounds: 4, at_by: 'user' } }];
  assert.doesNotMatch(triageHistory(replanned) ?? '', /答えた判定の問い/);
  assert.equal(humanLines(replanned), null);
});
