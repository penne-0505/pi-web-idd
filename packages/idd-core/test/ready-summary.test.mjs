import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentReady, readySummary, readySummaryOf } from '../src/agent/inbound.ts';
import { plannerBrief } from '../src/plan/prep.ts';
import { planReviewEnvelope } from '../src/plan/plan-review.ts';
import { resumeBrief } from '../src/plan/resume.ts';
import { applyDecision, buildEnvelope, questionAnsweredEnvelope } from '../src/ledger/write.ts';
import { INTENT_IMPACT_RULE } from '../src/agent/intent-impact.ts';

const made = [];
const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved.state === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved.state;
  if (saved.repos === undefined) delete process.env.IDD_REPOS_FILE; else process.env.IDD_REPOS_FILE = saved.repos;
});

const rec = { idd_id: 'IDD-1', area: 'me/app', title: 'T', context: '', gh_issue_url: 'https://github.com/me/app/issues/1', created_at: '2026-09-24T00:00:00Z' };

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'idd-ready-summary-'));
  made.push(root);
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main' } } }));
  writeFileSync(join(state, 'backlog.jsonl'), JSON.stringify(rec) + '\n');
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  return state;
}

/** the six-kind table with no kind touched */
const allClear = [
  { kind: 'auth', touches: false, reason: '認証を変えない。' },
  { kind: 'authz', touches: false, reason: '認可を変えない。' },
  { kind: 'billing', touches: false, reason: '課金を変えない。' },
  { kind: 'permission', touches: false, reason: '権限を変えない。' },
  { kind: 'data_loss', touches: false, reason: 'データを消さない。' },
  { kind: 'secret', touches: false, reason: '秘密を扱わない。' },
];

/** the six-kind table with `auth` touched */
const touching = allClear.map((r) => (r.kind === 'auth' ? { ...r, touches: true, reason: 'passkey の検証を変える。' } : r));

const counts = { iddId: 'IDD-1', decCount: 2, invCount: 1, qaCount: 3, referenceCount: 4, size: 'L', harm: 1, depth: 'deep', riskTable: allClear, intentImpact: { paths: [], decisions: [] } };
const three = { situation: '購入の途中で残高が増えて見え、失敗しても戻らない。', action: '残高を増やすのを購入が確定した後にする。', outcome: '失敗した購入で残高が狂わなくなる。' };

/** put a qa of the given risk in a planner worktree for IDD-1, and record the planner session that points at it */
function withQa(state, risk) {
  const worktree = join(state, 'planner-wt');
  const qa = join(worktree, '_docs/qa/app/idd-1/qa.md');
  mkdirSync(join(worktree, '_docs/qa/app/idd-1'), { recursive: true });
  writeFileSync(qa, `---\nrisk: ${risk}\n---\n\nbody\n`);
  writeFileSync(join(state, 'planner-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', planner_session_id: 'p1', started_at: '2026-09-25T00:00:00Z', worktree_path: worktree, branch: 'idd/idd-1' }) + '\n');
  return worktree;
}

function recorded(state) {
  const file = readdirSync(state).find((f) => f.startsWith('lifecycle-'));
  if (!file) return [];
  return readFileSync(join(state, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 's1_ready');
}

test('the three plain lines are kept with the ready', async () => {
  const state = setup();
  assert.deepEqual(await agentReady({ ...counts, summary: three }), { ok: true });
  const [ready] = recorded(state);
  assert.deepEqual(ready.attrs.summary, three);
  assert.equal(ready.attrs.dec_count, 2);
});

test('a ready without them (the older form) is still accepted, and records none', async () => {
  const state = setup();
  assert.deepEqual(await agentReady(counts), { ok: true });
  const [ready] = recorded(state);
  assert.equal(ready.attrs.summary, undefined);
});

test('lines that are missing, empty or not text are not kept, and the ready still goes through', async () => {
  const state = setup();
  const a = await agentReady({ ...counts, summary: { situation: 'a', action: '', outcome: 'c' } });
  const b = await agentReady({ ...counts, summary: 'ひとつの文' });
  for (const r of [a, b]) {
    assert.equal(r.ok, true);
    // the planner is told the lines were dropped
    assert.match(r.warning, /summary/);
  }
  for (const ready of recorded(state)) {
    assert.equal(ready.attrs.summary, undefined);
    // and the record says they came malformed and were dropped
    assert.equal(ready.attrs.summary_dropped, true);
  }
});

test('a ready that sent no lines at all is not marked as dropping any', async () => {
  const state = setup();
  const r = await agentReady(counts);
  assert.equal(r.warning, undefined);
  assert.equal(recorded(state)[0].attrs.summary_dropped, undefined);
});

test('the envelopes that send the planner back to ready name the report CLI', async () => {
  const state = setup();
  const review = planReviewEnvelope('IDD-1', [{ severity: 'must', path: 'a', claim: 'c', evidence: '' }], ['r']);
  assert.match(review.split('<callback>')[1].split('</callback>')[0], /idd report plan/);
  assert.match(review, /summary/);
  // s1_revise needs a GO card: a ready and a skipped plan review
  writeFileSync(join(state, 'lifecycle-me_app.jsonl'), [
    { idd_id: 'IDD-1', event: 's1_ready', at: '2026-09-25T00:00:00Z', attrs: {} },
    { idd_id: 'IDD-1', event: 's1_plan_review_skipped', at: '2026-09-25T00:00:00Z', attrs: { reason: 'x' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const revise = await applyDecision('s1_revise', { iddId: 'IDD-1', instruction: 'AC を直す' });
  assert.equal(revise.ok, true, revise.error);
  const xml = readFileSync(join(state, 'outbox', `${revise.envelopeId}.xml`), 'utf8');
  assert.match(xml, /idd report plan/);
  assert.match(xml, /idd report questions/);
  assert.match(xml, /summary/);
});

test('the lines are trimmed and kept short; three lines in a list are read in order', () => {
  assert.deepEqual(readySummary({ situation: '  状況  ', action: 'やること', outcome: '結果', extra: 'x' }), { situation: '状況', action: 'やること', outcome: '結果' });
  assert.deepEqual(readySummary(['状況', 'やること', '結果']), { situation: '状況', action: 'やること', outcome: '結果' });
  assert.equal(readySummary(['状況', 'やること']), undefined);
  assert.equal(readySummary(null), undefined);
  const cut = readySummary({ situation: 'x'.repeat(400), action: 'a', outcome: 'b' }).situation;
  assert.equal([...cut].length, 200);
  // a cut line says it was cut, and never splits a character in two
  assert.ok(cut.endsWith('…'));
  const emoji = readySummary({ situation: '😀'.repeat(300), action: 'a', outcome: 'b' }).situation;
  assert.equal([...emoji].length, 200);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test('the lane shows the lines of its last ready: a re-ready without them shows none, not the older ones', () => {
  const ev = (attrs) => ({ idd_id: 'IDD-1', event: 's1_ready', at: '2026-09-25T00:00:00Z', attrs });
  const next = { situation: '直した状況', action: '直したやること', outcome: '直した結果' };
  assert.deepEqual(readySummaryOf([ev({ summary: three }), ev({ summary: next })]), next);
  assert.equal(readySummaryOf([ev({ summary: three }), ev({})]), undefined);
  assert.equal(readySummaryOf([ev({ summary: { situation: 'a' } })]), undefined);
  assert.equal(readySummaryOf([ev({}), { idd_id: 'IDD-1', event: 's1_go', at: 'x', attrs: { summary: three } }]), undefined);
});

test('the planner brief asks for the three lines in Japanese, without the code\'s words', () => {
  setup();
  const brief = plannerBrief(rec);
  assert.match(brief, /idd report plan --dec-count/);
  const block = brief.split('<plan>')[1].split('</plan>')[0];
  assert.match(block, /日本語/);
  assert.match(block, /関数名・フィールド名/);
  assert.match(block, /situation/);
  assert.match(block, /action/);
  assert.match(block, /outcome/);
});

test('the planner brief carries the same host knowledge about heavy tests', () => {
  setup();
  const brief = plannerBrief(rec);
  const rules = brief.split('<host-rules>')[1].split('</host-rules>')[0];
  assert.match(rules, /重いテストや検証（Flutter の全体テストなど）/);
  assert.equal((brief.match(/<host-rules>/g) ?? []).length, 1);
});

test('the planner brief asks for the six-kind table, its keys and where the definitions live', () => {
  setup();
  const block = plannerBrief(rec).split('<plan>')[1].split('</plan>')[0];
  assert.match(block, /--risk-table/);
  for (const key of ['auth', 'authz', 'billing', 'permission', 'data_loss', 'secret']) assert.match(block, new RegExp(key));
  assert.match(block, /workflow\.md/);
});

test('the table is kept with the ready', async () => {
  const state = setup();
  withQa(state, 'High');
  assert.deepEqual(await agentReady({ ...counts, riskTable: touching }), { ok: true });
  const [ready] = recorded(state);
  assert.deepEqual(ready.attrs.risk_table, touching);
});

test('a report without the table, with a kind missing, or with an unknown kind is refused, and writes no ready', async () => {
  const state = setup();
  const missing = await agentReady({ ...counts, riskTable: allClear.slice(0, 5) });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /authz|billing|permission|data_loss|secret/);
  const unknown = await agentReady({ ...counts, riskTable: [...allClear.slice(0, 5), { kind: 'biling', touches: false, reason: 'x' }] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /biling/);
  const none = await agentReady({ ...counts, riskTable: undefined });
  assert.equal(none.ok, false);
  assert.equal(recorded(state).length, 0);
});

test('a row with an empty reason is refused, even for a not-touching kind', async () => {
  const state = setup();
  const blank = allClear.map((r, i) => (i === 0 ? { ...r, reason: '   ' } : r));
  const r = await agentReady({ ...counts, riskTable: blank });
  assert.equal(r.ok, false);
  assert.match(r.error, /reason/);
  assert.equal(recorded(state).length, 0);
});

test('a touching table needs a High (or Critical) qa; Medium and an unreadable qa are refused', async () => {
  const state = setup();
  const wt = withQa(state, 'Medium');
  const medium = await agentReady({ ...counts, riskTable: touching });
  assert.equal(medium.ok, false);
  assert.match(medium.error, /Medium/);
  assert.match(medium.error, /High/);
  assert.equal(recorded(state).length, 0);
  // a lower-case value is not the record check's value
  writeFileSync(join(wt, '_docs/qa/app/idd-1/qa.md'), '---\nrisk: high\n---\n');
  assert.equal((await agentReady({ ...counts, riskTable: touching })).ok, false);
  // no qa at all
  rmSync(join(wt, '_docs/qa/app/idd-1/qa.md'));
  assert.equal((await agentReady({ ...counts, riskTable: touching })).ok, false);
});

test('a touching table with a High or Critical qa is accepted; all-clear needs no High', async () => {
  const state = setup();
  withQa(state, 'High');
  assert.deepEqual(await agentReady({ ...counts, riskTable: touching }), { ok: true });
  assert.equal(recorded(state).length, 1);
  // all-clear passes even with a Medium qa (and no qa)
  rmSync(join(state, 'planner-sessions.jsonl'));
  assert.deepEqual(await agentReady({ ...counts, riskTable: allClear }), { ok: true });
});

test('the qa is read from the planner worktree, not from an older executor worktree', async () => {
  const state = setup();
  withQa(state, 'High');
  // a redo leaves an executor session pointing at a worktree whose qa is gone
  writeFileSync(join(state, 'executor-sessions.jsonl'), JSON.stringify({ idd_id: 'IDD-1', executor_session_id: 'e1', worktree_path: join(state, 'gone-wt') }) + '\n');
  assert.deepEqual(await agentReady({ ...counts, riskTable: touching }), { ok: true });
});

test('every send-back that asks for a ready tells the planner to attach the impact report (AC-028)', async () => {
  const state = setup();
  const planLine = (xml) => (xml.split('<plan>')[1] ?? '').split('</plan>')[0];
  // 1. the plan review's send-back
  assert.ok(planLine(planReviewEnvelope('IDD-1', [], [])).includes(INTENT_IMPACT_RULE));
  // 2. the resume of a planner session
  assert.ok(planLine(resumeBrief({ iddId: 'IDD-1', role: 'planner', sessionId: 'p1', worktree: '/w' }, 'x')).includes(INTENT_IMPACT_RULE));
  // 3 and 4. the answered-questions envelope, for a planner and for a session whose role is not known
  const pair = { questionId: 'q1', question: 'Q', selection: { label: 'A' } };
  assert.ok(planLine(questionAnsweredEnvelope('IDD-1', 'b1', [pair], 'planner')).includes(INTENT_IMPACT_RULE));
  assert.ok(planLine(questionAnsweredEnvelope('IDD-1', 'b1', [pair])).includes(INTENT_IMPACT_RULE));
  // 5 and 6. the GO send-back and the interjection
  writeFileSync(join(state, 'lifecycle-me_app.jsonl'), [
    { idd_id: 'IDD-1', event: 's1_ready', at: '2026-09-25T00:00:00Z', attrs: {} },
    { idd_id: 'IDD-1', event: 's1_plan_review_skipped', at: '2026-09-25T00:00:00Z', attrs: { reason: 'x' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const revise = await applyDecision('s1_revise', { iddId: 'IDD-1', instruction: '直す' });
  assert.equal(revise.ok, true, revise.error);
  assert.ok(planLine(readFileSync(join(state, 'outbox', `${revise.envelopeId}.xml`), 'utf8')).includes(INTENT_IMPACT_RULE));
  const speak = await applyDecision('speak', { iddId: 'IDD-1', message: '伝言' });
  assert.equal(speak.ok, true, speak.error);
  assert.ok(planLine(readFileSync(join(state, 'outbox', `${speak.envelopeId}.xml`), 'utf8')).includes(INTENT_IMPACT_RULE));
});
