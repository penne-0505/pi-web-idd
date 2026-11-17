import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyDecision } from '../src/ledger/write.ts';
import { readLifecycle } from '../src/ledger/read.ts';
import { acceptedAt, fixCounts, fixScope, followupsOf, reviewLoopState, reviewRounds, shouldFixCounts, submitLeftovers, unfixedOf } from '../src/ledger/review-loop.ts';
import * as reference from '../src/ledger/review-loop-reference.ts';
import { judgementCopy, reportedSeverities, triageHistory } from '../src/plan/review-loop.ts';
import { tmpDir } from './helpers/tmp.mjs';

// What a stuck card's correction does to every later reading of the lane (Issue #224, IDD-209).
//
// The rows are IDD-205's own, cut from the real ledger (`fixtures/review-corrections/`): round 2's judgement accepted
// seven findings, penne put two of them off with a note ("F-4 と F-6 は重さを should として followup に回す"), and the
// next rounds brought both back as musts: once as the refs of the fix the judgement was told to check, once as the same
// problems worded again by the judgement. The note was free text, so no reader could tell. The input here is the same
// rows with the answer carrying the corrections penne meant. No model is called: every row is the ledger's, but the
// answer's `corrections` and the two `correction_ref` marks, which are what the judgement now writes.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'review-corrections');
const rowsOf = (name) => readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const plain = (v) => JSON.parse(JSON.stringify(v));

/** what penne meant by the real note: F-4 and F-6 are put off, as shoulds */
const CORRECTIONS = [
  { ref: '2-blind/F-4', severity: 'should', action: 'followup', reason: '書き込みの失敗の扱いは、この変更では手を入れない' },
  { ref: '2-blind/F-6', severity: 'should', action: 'followup', reason: 'TS の写しの独立は後の変更で扱う' },
];

/** the lane up to penne's answer; `corrected` puts the corrections into the answer the ledger holds */
function toAnswer(corrected) {
  const rows = rowsOf('idd-205-to-answer.jsonl');
  const answer = rows.at(-1);
  assert.equal(answer.event, 's2_review_resumed');
  assert.equal(answer.attrs.corrections, undefined, 'the real answer carried the decision in its note only');
  return corrected ? [...rows.slice(0, -1), { ...answer, attrs: { ...answer.attrs, corrections: CORRECTIONS } }] : rows;
}

/** the lane after the fix the corrected answer led to, and round 3's judgement as the ledger holds it */
function throughNextRound() {
  const answered = toAnswer(true);
  const scope = fixScope(answered);
  const fixRow = { idd_id: 'IDD-205', event: 's2_fix_sent', at: '2026-10-24T13:34:23+09:00', attrs: { round: 2, refs: scope.accepted.map((a) => a.ref) } };
  const next = rowsOf('idd-205-next-round.jsonl').map((row) => {
    if (row.event !== 's2_triage_done') return row;
    // the judgement is handed penne's corrections now; the two findings it said again carry the correction they repeat
    const cites = { 'review-loop.ts': '2-blind/F-4', 'ledger-reads-reference.ts': '2-blind/F-6' };
    const accepted = row.attrs.accepted.map((item) => {
      const hit = Object.entries(cites).find(([file]) => (item.path ?? '').endsWith(file));
      return hit && item.severity === 'must' ? { ...item, correction_ref: hit[1] } : item;
    });
    return { ...row, attrs: { ...row.attrs, accepted } };
  });
  return { events: [...answered, fixRow, ...next], scope };
}

test('the real answer with only a note sends the two put-off musts to the fix again: the failure the corrections end (AC-005)', () => {
  const evs = toAnswer(false);
  const refs = fixScope(evs).accepted.map((a) => a.ref);
  assert.ok(refs.includes('2-blind/F-4') && refs.includes('2-blind/F-6'), refs.join(', '));
});

test('a correction puts a finding off in the one record: the fix, the leftovers and the follow-ups all read it (AC-001, AC-002)', () => {
  const evs = toAnswer(true);
  const t = evs.findLastIndex((e) => e.event === 's2_triage_done');
  const read = acceptedAt(evs, t).filter((a) => a.corrected);
  assert.deepEqual(read.map((a) => [a.ref, a.severity, a.action, a.correction_reason]), CORRECTIONS.map((c) => [c.ref, 'should', 'followup', c.reason]));
  // the fix is sent for what is still fixed now, and neither put-off finding is among it
  const refs = fixScope(evs).accepted.map((a) => a.ref);
  assert.deepEqual(refs.filter((r) => r.endsWith('/F-4') || r.endsWith('/F-6')), []);
  assert.ok(refs.includes('2-blind/F-1') && refs.includes('2-blind/F-2'));
  // the two musts that stay are counted as musts; the put-off ones are not
  assert.equal(fixCounts(acceptedAt(evs, t)).must, 2);
  // the leftovers of the submit card do not count them either, and they wait as follow-ups with the weight penne gave
  const left = unfixedOf(evs, t, undefined, '', false).accepted.map((a) => a.ref);
  assert.ok(!left.includes('2-blind/F-4') && !left.includes('2-blind/F-6'), left.join(', '));
  const followups = followupsOf(evs);
  const waiting = (start) => followups.filter((f) => f.claim.startsWith(start));
  assert.deepEqual(waiting('lifecycle の書き込みに失敗').map((f) => f.severity), ['should']);
  assert.deepEqual(waiting('終了イベントの比較用 TS 写し').map((f) => f.severity), ['should']);
});

test('the two put-off findings come back in no later reading: not in the fix, not as an unresolved must (AC-005)', () => {
  const { events: evs, scope } = throughNextRound();
  const t = evs.findLastIndex((e) => e.event === 's2_triage_done');
  assert.equal(evs[t].attrs.round, 3);
  // round 3's judgement still carries `prior` with both refs unresolved, and said both findings again as musts
  assert.ok(evs[t].attrs.prior.some((p) => p.ref === '2-blind/F-4' && !p.resolved));
  assert.ok(evs[t].attrs.prior.some((p) => p.ref === '2-blind/F-6' && !p.resolved));
  // what the earlier fix sent is not added back, and the two said again are read with penne's weight and handling
  const accepted = acceptedAt(evs, t);
  assert.ok(!accepted.some((a) => a.ref.startsWith('2-blind/')), 'no ref of the earlier fix comes back');
  const again = accepted.filter((a) => a.correction_ref);
  assert.deepEqual(again.map((a) => [a.correction_ref, a.severity, a.action]), [['2-blind/F-4', 'should', 'followup'], ['2-blind/F-6', 'should', 'followup']]);
  // the next fix: neither the refs of the fix before nor the two said again; the musts that are new
  const next = fixScope(evs).accepted.map((a) => a.ref);
  assert.deepEqual(next, ['3-blind/F-1', '3-blind/F-4']);
  assert.ok(scope.accepted.length > 0);
  // no unresolved must is left from the put-off findings, and the follow-ups name them once each
  const left = unfixedOf(evs, t, undefined, '', false).accepted.map((a) => a.ref);
  assert.deepEqual(left, ['3-blind/F-1', '3-blind/F-4'], 'only what this round accepted to fix is left');
  const putOff = followupsOf(evs).filter((f) => f.path?.endsWith('ledger-reads-reference.ts'));
  assert.equal(putOff.length, 1, 'the problem worded again is not a second follow-up');
  assert.equal(followupsOf(evs).filter((f) => f.path?.endsWith('review-loop.ts') && f.claim.includes('永続化') && f.severity === 'must').length, 0, 'the other put-off finding is not a must either');
  // the lane goes on to fix what is new: the put-off ones neither hold the round open nor stop the lane
  assert.equal(reviewLoopState(evs).state, 'send_fix');
});

test('the MoonBit reading and the TypeScript copy answer the same at every prefix of the real lane (AC-001)', () => {
  const { events: evs } = throughNextRound();
  for (let n = 1; n <= evs.length; n += 1) {
    const prefix = evs.slice(0, n);
    for (let i = 0; i < prefix.length; i += 1) {
      if (prefix[i].event !== 's2_triage_done') continue;
      assert.deepEqual(plain(acceptedAt(prefix, i)), plain(reference.acceptedAt(prefix, i)), `${n} 行目までで、${i} 行目の受理`);
      const fix = reference.fixAfter(prefix, i);
      for (const note of ['', '補足']) {
        assert.deepEqual(plain(unfixedOf(prefix, i, fix, note, false)), plain(reference.unfixedOf(prefix, i, fix, note, false)), `${n} 行目までで残件`);
      }
    }
    assert.deepEqual(plain(fixScope(prefix)), plain(reference.fixScope(prefix)), `${n} 行目までで修正の範囲`);
    assert.deepEqual(plain(followupsOf(prefix)), plain(reference.followupsOf(prefix)), `${n} 行目までで後続`);
    assert.deepEqual(plain(shouldFixCounts(prefix)), plain(reference.shouldFixCounts(prefix)), `${n} 行目で should の数`);
    assert.deepEqual(plain(submitLeftovers(prefix)), plain(reference.submitLeftovers(prefix)), `${n} 行目で提出前確認の残件`);
    assert.deepEqual(plain(reviewRounds(prefix)), plain(reference.reviewRounds(prefix)), `${n} 行目で巡の数`);
  }
});

test('an unknown ref, a bad weight, or a must put off is not a correction the reader takes', () => {
  const answered = toAnswer(false);
  const bad = [
    { ref: '2-blind/F-4', severity: 'must', action: 'followup' },
    { ref: '2-blind/F-5', severity: 'blocker', action: 'fix' },
    { ref: '2-blind/F-6', severity: 'should', action: 'later' },
    { severity: 'should', action: 'followup' },
    'x',
  ];
  const evs = [...answered.slice(0, -1), { ...answered.at(-1), attrs: { ...answered.at(-1).attrs, corrections: bad } }];
  const t = evs.findLastIndex((e) => e.event === 's2_triage_done');
  assert.ok(acceptedAt(evs, t).every((a) => !a.corrected), 'nothing is read as corrected');
});

// ---- the stuck card's answer: the one record the corrections ride in (AC-001) ----

const rec = { idd_id: 'IDD-1', area: 'me/app', title: 'T', context: '', source_type: 'github', gh_issue_url: 'https://github.com/me/app/issues/1' };
const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE, roles: process.env.IDD_ROLES_FILE };
afterEach(() => {
  for (const [key, name] of [['state', 'IDD_STATE_DIR'], ['repos', 'IDD_REPOS_FILE'], ['roles', 'IDD_ROLES_FILE']]) {
    if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
  }
});

/** a depth-bearing pass stopped at penne after a judgement that accepted two musts and a should */
function stuckLane() {
  const state = tmpDir('idd-corr-');
  mkdirSync(join(state, 'wt'), { recursive: true });
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(state, 'u'), work: join(state, 'w'), public_base: 'main' } } }));
  writeFileSync(join(state, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  executor: { role: r }\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(state, 'repos.yaml'), IDD_ROLES_FILE: join(state, 'roles.yaml') });
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify(rec) + '\n');
  const ev = (event, attrs = {}) => ({ idd_id: 'IDD-1', event, at: '2026-10-01T00:00:00Z', attrs });
  const events = [
    ev('lane_open'), ev('s1_go'), ev('s2_start'), ev('s2_result'),
    ev('s2_review_started', { kind: 'blind', round: 1, run_ids: ['b1'], depth: 'deep', max_fix_rounds: 3, close_on: 'must' }),
    ev('s2_review_findings', { kind: 'blind', round: 1, files: [] }),
    ev('s2_triage_done', { kind: 'blind', round: 1, accepted: [
      { ref: 'F-1', severity: 'must', claim: '直す', action: 'fix', path: 'a.ts' },
      { ref: 'F-2', severity: 'must', claim: '後に回す', action: 'fix', path: 'b.ts' },
      { ref: 'F-3', severity: 'should', claim: '小さく直せる', action: 'fix', path: 'c.ts', impact: 'x' },
    ] }),
    ev('s2_review_escalated', { reason: '修正が 3 巡に達した' }),
  ];
  writeFileSync(join(state, 'lifecycle-me-app.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return state;
}
const lane = () => readLifecycle().filter((e) => e.idd_id === 'IDD-1');
const answerOf = () => lane().filter((e) => e.event === 's2_review_resumed').at(-1);

test('the answer records the corrections that change a finding, and the fix that follows is sent without the one put off (AC-001, AC-002)', async () => {
  stuckLane();
  const done = await applyDecision('s2_review_continue', {
    iddId: 'IDD-1', note: '',
    corrections: [
      { ref: '1-blind/F-2', severity: 'should', action: 'followup', reason: ' 後で ' },
      { ref: '1-blind/F-1', severity: 'must', action: 'fix' },
      { ref: '1-blind/F-3', severity: 'should', action: 'fix' },
    ],
  });
  assert.equal(done.ok, true, done.error);
  // only the finding that changed is recorded, with its reason trimmed; the two left as they were are not
  assert.deepEqual(answerOf().attrs.corrections, [{ ref: '1-blind/F-2', severity: 'should', action: 'followup', reason: '後で' }]);
  assert.deepEqual(fixScope(lane()).accepted.map((a) => a.ref), ['1-blind/F-1', '1-blind/F-3']);
  assert.equal(reviewLoopState(lane()).state, 'send_fix');
});

test('an answer with no corrections is the answer the card always sent', async () => {
  stuckLane();
  const done = await applyDecision('s2_review_continue', { iddId: 'IDD-1', note: '続ける' });
  assert.equal(done.ok, true, done.error);
  assert.equal('corrections' in answerOf().attrs, false);
  assert.deepEqual(fixScope(lane()).accepted.map((a) => a.ref), ['1-blind/F-1', '1-blind/F-2', '1-blind/F-3']);
});

test('a must put off, an unknown ref and a bad weight are refused, and nothing is recorded (AC-001)', async () => {
  stuckLane();
  const before = lane().length;
  for (const [corrections, message] of [
    [[{ ref: '1-blind/F-1', severity: 'must', action: 'followup' }], /must のまま後に回す/],
    [[{ ref: '1-blind/F-9', severity: 'should', action: 'followup' }], /見つかりません/],
    [[{ ref: '1-blind/F-1', severity: 'blocker', action: 'fix' }], /must \/ should \/ nit/],
    [[{ ref: '1-blind/F-2', severity: 'should', action: 'later' }], /fix \/ followup \/ skip/],
    ['x', /配列/],
  ]) {
    const refused = await applyDecision('s2_review_continue', { iddId: 'IDD-1', note: '', corrections });
    assert.equal(refused.ok, false);
    assert.match(refused.error, message);
  }
  assert.equal(lane().length, before, 'a refused answer writes nothing');
});

test('going on as it is takes the corrections too, and taking the code by hand takes none (AC-001)', async () => {
  stuckLane();
  const hand = await applyDecision('s2_review_hand_fix', { iddId: 'IDD-1', corrections: [{ ref: '1-blind/F-2', severity: 'should', action: 'followup' }] });
  assert.equal(hand.ok, true, hand.error);
  assert.equal('corrections' in answerOf().attrs, false, 'a hand fix decides nothing about the findings');
  stuckLane();
  const accept = await applyDecision('s2_review_accept', { iddId: 'IDD-1', note: '', corrections: [{ ref: '1-blind/F-2', severity: 'nit', action: 'skip', reason: '見送る' }] });
  assert.equal(accept.ok, true, accept.error);
  assert.deepEqual(answerOf().attrs.corrections, [{ ref: '1-blind/F-2', severity: 'nit', action: 'skip', reason: '見送る' }]);
  // a finding set aside is neither sent to the fix nor a follow-up, but the submit card lists it as penne decided it
  const evs = lane();
  const t = evs.findLastIndex((e) => e.event === 's2_triage_done');
  assert.ok(!unfixedOf(evs, t, undefined, '', false).accepted.some((a) => a.ref === '1-blind/F-2'));
  assert.ok(!followupsOf(evs).some((f) => f.path === 'b.ts'));
  assert.ok(!fixScope(evs).accepted.some((a) => a.ref === '1-blind/F-2'));
  const aside = submitLeftovers(evs).filter((l) => l.path === 'b.ts');
  // F-2 was a must the judgement wanted fixed: the card lists it with the weight the judgement gave beside the one set
  assert.deepEqual(plain(aside), [{ severity: 'nit', judgedSeverity: 'must', claim: aside[0].claim, path: 'b.ts', action: 'skip' }]);
  assert.deepEqual(plain(reference.submitLeftovers(evs)), plain(submitLeftovers(evs)));
});

// ---- what the judgement is handed, and what the record keeps of the reviewers (AC-003) ----

test('the judgement is handed penne\'s corrections beside the fixes, with the reason and the handling', () => {
  const evs = toAnswer(true);
  const history = triageHistory(evs);
  assert.match(history, /## penne の訂正/);
  assert.match(history, /2-blind\/F-4（should、後に回す（follow-up））/);
  assert.match(history, /理由: 書き込みの失敗の扱いは、この変更では手を入れない/);
  assert.match(history, /2-blind\/F-6（should、後に回す（follow-up））/);
  // the judgement is told what to do with them
  assert.match(history, /訂正に従う/);
  assert.match(history, /correction_ref/);
  // the fix planner reads the same list for another purpose: it must not touch what penne put off
  assert.match(triageHistory(evs, 'fix_plan'), /後に回す・見送ると訂正された指摘は、この直しで手を入れない/);
  // a lane with no corrections hands none
  assert.doesNotMatch(triageHistory(toAnswer(false)), /## penne の訂正/);
});

test('the copy handed to the judgement has no reviewer weight, action, frequency or plan, and the claims stay (AC-003)', () => {
  const state = tmpDir('idd-corr-copy-');
  const dir = join(state, 'pipeline', 'review', 'IDD-1', '2-blind-blind-reviewer-a1');
  mkdirSync(dir, { recursive: true });
  const report = join(dir, 'report.json');
  const finding = { severity: 'must', action: 'fix', frequency: '常時', how: 'こう直す', path: 'a.ts', line: 3, claim: '壊れる', evidence: 'e', is_guess: false };
  writeFileSync(report, JSON.stringify({ findings: [finding], new_findings: [{ ...finding, claim: '別' }], verdict: 'request-changes' }));
  const copy = judgementCopy(report, 2, 'blind');
  assert.notEqual(copy, report);
  assert.equal(dirname(copy), dir, 'the copy sits in the report\'s directory, so its parent name is still the run');
  const read = JSON.parse(readFileSync(copy, 'utf8'));
  for (const f of [...read.findings, ...read.new_findings]) {
    for (const key of ['severity', 'action', 'frequency', 'how']) assert.ok(!(key in f), `${key} is dropped`);
    assert.deepEqual(Object.keys(f).sort(), ['claim', 'evidence', 'is_guess', 'line', 'path']);
  }
  assert.deepEqual(read.findings.map((f) => f.claim), ['壊れる']);
  // the report itself is untouched: the record reads the weight back from it
  assert.equal(JSON.parse(readFileSync(report, 'utf8')).findings[0].severity, 'must');
  // a report with none of those fields, and a file that is not a report, are read where they are
  const clean = join(dir, 'clean.json');
  writeFileSync(clean, JSON.stringify({ findings: [{ path: 'a.ts', claim: 'c' }] }));
  assert.equal(judgementCopy(clean, 2, 'blind'), clean);
  assert.equal(judgementCopy(join(dir, 'report.md'), 2, 'blind'), join(dir, 'report.md'));
});

test('the record reads each reviewer\'s weight from the reports the decision names: the heaviest, none when not found (AC-003)', () => {
  const state = tmpDir('idd-corr-sev-');
  process.env.IDD_STATE_DIR = state;
  const put = (dir, findings) => {
    mkdirSync(join(state, 'pipeline', 'review', 'IDD-1', dir), { recursive: true });
    writeFileSync(join(state, 'pipeline', 'review', 'IDD-1', dir, 'report.json'), JSON.stringify({ findings }));
  };
  put('1-blind-a', [
    { severity: 'should', path: 'a.ts', claim: 'データが黙って欠ける経路がある' },
    { severity: 'nit', path: 'b.ts', claim: '名前が紛らわしい' },
  ]);
  put('1-blind-b', [{ severity: 'must', path: 'a.ts', claim: 'データが黙って欠ける経路がある', how: 'x' }]);
  const found = reportedSeverities('IDD-1', [
    { ref: 'F-1', from: ['1-blind-a', '1-blind-b'], path: 'a.ts', claim: 'データが黙って欠ける経路がある' },
    { ref: 'F-2', from: ['1-blind-a'], path: 'b.ts', claim: '名前が紛らわしい' },
    { ref: 'F-3', from: ['1-blind-a'], path: 'z.ts', claim: 'どの report にも無い指摘' },
    { ref: 'F-4', path: 'a.ts', claim: 'from の無い判定' },
    { ref: 'F-5', from: ['1-blind-gone'], path: 'a.ts', claim: '消えた report' },
  ]);
  assert.equal(found.get('F-1'), 'must', 'a finding merged from two reports takes the heaviest');
  assert.equal(found.get('F-2'), 'nit');
  assert.equal(found.has('F-3'), false, 'a decision that binds no finding has none');
  assert.equal(found.has('F-4'), false);
  assert.equal(found.has('F-5'), false, 'a report that is gone has none');
});

test('a nit penne corrected to fix is sent to the fix and held against the close; a nit left alone is neither', () => {
  const row = (event, minute, attrs) => ({ idd_id: 'IDD-1', event, at: `2026-10-01T00:${String(minute).padStart(2, '0')}:00.000Z`, attrs });
  const evs = [
    row('s2_start', 0, { started_from_commit: 'c0' }),
    row('s2_result', 1, { outcome: 'success' }),
    row('s2_review_started', 2, { kind: 'blind', round: 2, run_ids: ['b'], head: 'aaaa', depth: 'standard' }),
    row('s2_triage_done', 3, {
      kind: 'blind',
      round: 2,
      accepted: [
        { ref: 'F-1', severity: 'should', claim: 'one', path: 'a.mbt', action: 'followup' },
        { ref: 'F-2', severity: 'nit', claim: 'two', path: 'b.ts', action: 'fix' },
      ],
    }),
    row('s2_review_escalated', 4, { reason: 'x' }),
    row('s2_review_resumed', 5, { decision: 'continue', note: 'n', at_by: 'user', corrections: [{ ref: '2-blind/F-1', severity: 'nit', action: 'fix' }] }),
  ];
  assert.deepEqual(fixScope(evs).accepted.map((a) => a.ref), ['2-blind/F-1']);
  assert.deepEqual(plain(fixScope(evs)), plain(reference.fixScope(evs)));
  assert.equal(fixCounts(acceptedAt(evs, 3)).must, 1);
  assert.deepEqual(fixCounts(acceptedAt(evs, 3)), reference.fixCounts(acceptedAt(evs, 3)));
});
