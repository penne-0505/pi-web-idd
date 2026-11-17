import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openReviewLane, readReviewLane, appendReviewEvent } from '../src/review-lane/store.ts';
import { reviewLaneState, reviewLaneLabel, renderReviewDraft } from '../src/review-lane/state.ts';
import { runReviewLanes } from '../src/review-lane/run.ts';
import { resolveGithubAreaKey } from '../src/config/areas.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { tmpDir } from './helpers/tmp.mjs';

function setup() {
  const state = tmpDir('idd-rev-');
  process.env.IDD_STATE_DIR = state;
  writeFileSync(join(state, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  review_blind: { roles: [r, r] }\n  triage: { role: r }\n  confirm: { role: r }\n');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
}

test('the stage words name someone else\'s PR as a PR review, kept apart from the S2 loop\'s review and from 送出', () => {
  assert.equal(reviewLaneLabel({ state: 'prepare' }), 'PR を準備中');
  assert.equal(reviewLaneLabel({ state: 'running_blind', round: 1, runIds: [] }), 'PR レビュー中');
  assert.equal(reviewLaneLabel({ state: 'running_blind', round: 2, runIds: [] }), 'PR レビューをやり直し中');
  assert.equal(reviewLaneLabel({ state: 'awaiting_penne', round: 1, outboundId: 'OUT-1' }), '投稿カードの確認待ち');
  assert.doesNotMatch(JSON.stringify([
    reviewLaneLabel({ state: 'prepare' }),
    reviewLaneLabel({ state: 'running_blind', round: 1, runIds: [] }),
    reviewLaneLabel({ state: 'awaiting_penne', round: 1, outboundId: 'OUT-1' }),
  ]), /送出|取り込|再レビュー/);
});

test('each finding is one numbered item, its evidence paragraph inside it, and no request is written', () => {
  const d = renderReviewDraft([
    { severity: 'must', claim: '購読が残る', path: 'a.dart', reason: '画面を閉じても listener が生きている', fix: '閉じたら止まること' },
    { severity: 'should', claim: '順序が逆', path: 'b.dart', reason: '依存が逆', report: true },
    { severity: 'should', claim: '報告しない指摘', reason: 'r' },
    { severity: 'nit', claim: '命名' },
  ]);
  assert.equal(d.event, 'request-changes');
  assert.match(d.body, /## must\n\n1\. \*\*購読が残る\*\*（`a\.dart`）\n\n   画面を閉じても listener が生きている/);
  assert.match(d.body, /## should\n\n1\. \*\*順序が逆\*\*（`b\.dart`）\n\n   依存が逆/);
  assert.doesNotMatch(d.body, /報告しない指摘/, 'a should the judgement did not report stays off the body');
  assert.doesNotMatch(d.body, /提案:|推奨の対応:|## nit/, 'no request and no nit reach the author');
  assert.doesNotMatch(d.body, /^\s*- /m, 'no bullet that reads as a finding of its own');
});

test('without a blocker the draft suggests an approve with the reported shoulds; nothing to say is an approve without a body', () => {
  const d = renderReviewDraft([{ severity: 'should', claim: 'x', report: true }, { severity: 'nit', claim: 'y' }, { severity: 'should', claim: 'z' }]);
  assert.equal(d.event, 'approve');
  assert.match(d.body, /^blocker は無いので Approve します。\n\n## should/);
  assert.doesNotMatch(d.body, /\*\*z\*\*/);
  assert.doesNotMatch(renderReviewDraft([{ severity: 'must', claim: 'z' }]).body, /Approve します/);
  assert.deepEqual(renderReviewDraft([]), { body: '', event: 'approve' });
});

test('a redraft sends the lane back to drafting from the same triage', () => {
  const at = '2026-09-24T05:30:00Z';
  const rec = { id: 'REV-1', repo: 'o/r', pr: 1, created_at: at, history: [
    { event: 'r_opened', at, attrs: {} }, { event: 'r_triage_done', at, attrs: { round: 1, accepted: [] } },
    { event: 'r_drafted', at, attrs: { round: 1, outbound_id: 'OUT-1' } },
  ] };
  assert.equal(reviewLaneState(rec).state, 'awaiting_penne');
  rec.history.push({ event: 'r_redraft_requested', at, attrs: { round: 1, previous: 'OUT-1' } });
  assert.deepEqual(reviewLaneState(rec), { state: 'draft', round: 1 });
});

test('one PR, one open lane', () => {
  setup();
  const a = openReviewLane({ repo: 'o/r', pr: 5 });
  assert.equal(openReviewLane({ repo: 'o/r', pr: 5 }).id, a.id);
  assert.notEqual(openReviewLane({ repo: 'o/r', pr: 6 }).id, a.id);
});

test('a full cycle: review, draft, penne posts a comment, the author pushes, re-review, approve closes', async () => {
  setup();
  const rec = openReviewLane({ repo: 'o/r', pr: 5 });
  let head = 'h1';
  const status = {};
  const outbox = {};
  const removed = [];
  const stages = [];
  // someone else's PR is not made in an Issue lane: the harness's rules over the repo's are not handed to its stages
  const normed = [];
  setAgentRunner({
    deliver: async () => {},
    prStatus: () => ({ head, state: 'OPEN', title: 'PR title', url: 'u' }),
    preparePrWorktree: async () => ({ path: '/wt/rev', head: 'h1', base: 'b0' }),
    movePrWorktree: () => ({ head, base: 'b0' }),
    removePrWorktree: ({ path }) => removed.push(path),
    fetchPrContext: () => ({ files: ['/ctx/body.md'] }),
    startReviewRun: async (o) => { stages.push(`${o.stage}:${o.base}..${o.head}`); if (o.norms !== undefined) normed.push(o.stage); const ids = o.stage === 'blind' ? [`${o.stage}${o.round}a`, `${o.stage}${o.round}b`] : [`${o.stage}${o.round}`]; for (const i of ids) status[i] = { state: 'running' }; return { runIds: ids }; },
    reviewRunStatus: (id) => status[id],
    queueOutbound: async (o) => { const id = `OUT-${Object.keys(outbox).length + 1}`; outbox[id] = { ...o, status: 'ready' }; return { id }; },
    outboundStatus: (id) => outbox[id] ? { status: outbox[id].status, event: outbox[id].event } : null,
  });
  const step = () => runReviewLanes();
  const st = () => reviewLaneState(readReviewLane(rec.id)).state;
  await step(); assert.equal(st(), 'start_blind');
  await step(); assert.equal(st(), 'running_blind');
  status.blind1a = { state: 'done', reportJson: '/a.json', reportMd: '/a.md', findings: [] };
  status.blind1b = { state: 'done', reportJson: '/b.json', reportMd: '/b.md', findings: [] };
  await step(); assert.equal(st(), 'start_triage');
  await step(); assert.equal(st(), 'running_triage');
  status.triage1 = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [
    { ref: 'F-1', verdict: 'accept', severity: 'should', claim: 'テストが検出しない', path: 'a_test.dart', reason: '変異で緑', fix: '退行で赤になること', report: true },
    { ref: 'F-2', verdict: 'reject', severity: 'nit', claim: '既出', reason: '既出' },
  ] };
  await step(); assert.equal(st(), 'draft');
  await step(); assert.equal(st(), 'awaiting_penne');
  const draft = outbox['OUT-1'];
  assert.equal(draft.target.event, 'approve', 'no must: the comments go on an approve unless penne picks otherwise');
  assert.equal(draft.target.expectHead, 'h1');
  assert.match(draft.body, /テストが検出しない/);
  await step(); assert.equal(st(), 'awaiting_penne', 'nothing is posted until penne acts on the card');
  outbox['OUT-1'].status = 'posted'; outbox['OUT-1'].event = 'comment';
  await step(); assert.equal(st(), 'awaiting_author');
  await step(); assert.equal(st(), 'awaiting_author', 'the same head: keep waiting');
  head = 'h2';
  await step(); assert.equal(st(), 'start_confirm');
  await step(); assert.equal(st(), 'running_confirm');
  status.confirm2 = { state: 'done', reportJson: '/c.json', reportMd: '/c.md', findings: [], items: [{ ref: 'F-1', resolved: true }] };
  await step(); assert.equal(st(), 'start_blind');
  await step(); assert.equal(st(), 'running_blind');
  status.blind2a = { state: 'done', reportJson: '/a2.json', reportMd: '/a2.md', findings: [] };
  status.blind2b = { state: 'done', reportJson: '/b2.json', reportMd: '/b2.md', findings: [] };
  await step(); await step();
  assert.equal(st(), 'running_triage');
  status.triage2 = { state: 'done', reportJson: '/t2.json', reportMd: '/t2.md', decisions: [] };
  await step(); await step();
  assert.equal(outbox['OUT-2'].target.event, 'approve');
  assert.equal(outbox['OUT-2'].body, '');
  outbox['OUT-2'].status = 'posted'; outbox['OUT-2'].event = 'approve';
  await step(); assert.equal(st(), 'closed');
  assert.deepEqual(removed, ['/wt/rev']);
  assert.deepEqual(stages, ['blind:b0..h1', 'triage:b0..h1', 'confirm:h1..h2', 'blind:h1..h2', 'triage:h1..h2']);
  assert.deepEqual(normed, []);
  setAgentRunner(null);
});

test('a redraft whose old card is still on the inbox waits for it to go, so the PR never gets two cards', async () => {
  setup();
  const rec = openReviewLane({ repo: 'o/r', pr: 6 });
  const status = {};
  const outbox = {};
  setAgentRunner({
    deliver: async () => {},
    prStatus: () => ({ head: 'h1', state: 'OPEN', title: 'PR title', url: 'u' }),
    preparePrWorktree: async () => ({ path: '/wt/rev6', head: 'h1', base: 'b0' }),
    fetchPrContext: () => ({ files: [] }),
    startReviewRun: async (o) => { const ids = o.stage === 'blind' ? ['b1', 'b2'] : ['t1']; for (const i of ids) status[i] = { state: 'running' }; return { runIds: ids }; },
    reviewRunStatus: (id) => status[id],
    queueOutbound: async (o) => { const id = `OUT-${Object.keys(outbox).length + 1}`; outbox[id] = { ...o, status: 'ready' }; return { id }; },
    outboundStatus: (id) => outbox[id] ? { status: outbox[id].status } : null,
  });
  const step = () => runReviewLanes();
  const st = () => reviewLaneState(readReviewLane(rec.id)).state;
  await step(); await step();
  status.b1 = { state: 'done', reportJson: '/a.json', reportMd: '/a.md', findings: [] };
  status.b2 = { state: 'done', reportJson: '/b.json', reportMd: '/b.md', findings: [] };
  await step(); await step();
  status.t1 = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [] };
  await step(); await step();
  assert.equal(st(), 'awaiting_penne');
  appendReviewEvent(rec.id, 'r_redraft_requested', { round: 1, previous: 'OUT-1' });
  await step();
  assert.equal(st(), 'draft', 'the old card could not be discarded: wait');
  assert.deepEqual(Object.keys(outbox), ['OUT-1']);
  outbox['OUT-1'].status = 'discarded';
  await step();
  assert.equal(st(), 'awaiting_penne');
  assert.deepEqual(Object.keys(outbox), ['OUT-1', 'OUT-2']);
  appendReviewEvent(rec.id, 'r_redraft_requested', { round: 1, previous: 'OUT-2' });
  outbox['OUT-2'].status = 'posted';
  await step();
  assert.equal(st(), 'awaiting_author', 'penne posted the old card after all: that review stands');
  assert.deepEqual(Object.keys(outbox), ['OUT-1', 'OUT-2']);
  setAgentRunner(null);
});

test('a failed triage stops at penne, and resume retries the triage', async () => {
  setup();
  const rec = openReviewLane({ repo: 'o/r', pr: 7 });
  for (const [e, a] of [['r_wt_ready', { path: '/wt', head: 'h', base: 'b' }], ['r_blind_started', { round: 1, run_ids: ['x'], head: 'h' }], ['r_findings', { round: 1, files: ['/a.json'] }], ['r_triage_started', { round: 1, run_id: 't' }]]) appendReviewEvent(rec.id, e, a);
  setAgentRunner({ deliver: async () => {}, reviewRunStatus: () => ({ state: 'failed', error: 'timeout' }) });
  await runReviewLanes();
  assert.equal(reviewLaneState(readReviewLane(rec.id)).state, 'stuck');
  appendReviewEvent(rec.id, 'r_resumed', {});
  assert.equal(reviewLaneState(readReviewLane(rec.id)).state, 'start_triage');
  setAgentRunner(null);
});

test('only as many review lanes run their blind reviews at once as review_blind allows', async () => {
  setup();
  writeFileSync(process.env.IDD_ROLES_FILE, 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  review_blind: { roles: [r, r], concurrency: 2 }\n  triage: { role: r }\n  confirm: { role: r }\n');
  const lanes = [5, 6, 7].map((pr) => openReviewLane({ repo: 'o/r', pr }));
  const status = {};
  let started = 0;
  setAgentRunner({
    deliver: async () => {},
    prStatus: () => ({ head: 'h1', state: 'OPEN', title: 'T', url: 'u' }),
    preparePrWorktree: async ({ pr }) => ({ path: `/wt/${pr}`, head: 'h1', base: 'b0' }),
    fetchPrContext: () => ({ files: [] }),
    startReviewRun: async (o) => { if (o.stage === 'blind') started += 1; const ids = o.stage === 'blind' ? [`${o.iddId}a`, `${o.iddId}b`] : [`${o.iddId}-${o.stage}`]; for (const i of ids) status[i] = { state: 'running' }; return { runIds: ids }; },
    reviewRunStatus: (id) => status[id],
  });
  await runReviewLanes();
  await runReviewLanes();
  const states = () => lanes.map((l) => reviewLaneState(readReviewLane(l.id)).state);
  assert.equal(started, 2, 'the third waits: each lane runs two copies with their own setup and tests');
  assert.deepEqual(states().sort(), ['running_blind', 'running_blind', 'start_blind']);
  // one finishes its blind reviews, and the waiting lane starts
  const done = lanes.find((l) => reviewLaneState(readReviewLane(l.id)).state === 'running_blind');
  status[`${done.id}a`] = { state: 'done', reportJson: '/a.json', reportMd: '/a.md', findings: [] };
  status[`${done.id}b`] = { state: 'done', reportJson: '/b.json', reportMd: '/b.md', findings: [] };
  // the waiting lane starts in the same tick or the next, whichever order the lanes are read in
  await runReviewLanes();
  await runReviewLanes();
  assert.equal(started, 3);
  setAgentRunner(null);
});

test('an approve takes down the copy the lane recorded, by its name; a copy that cannot go is written on the posted record, not swallowed', async () => {
  setup();
  const rec = openReviewLane({ repo: 'o/r', pr: 8 });
  const copy = '/old-root/REV-8';
  for (const [e, a] of [['r_wt_ready', { path: copy, head: 'h', base: 'b' }], ['r_triage_done', { round: 1, accepted: [] }], ['r_drafted', { round: 1, outbound_id: 'OUT-1', head: 'h' }]]) appendReviewEvent(rec.id, e, a);
  const asked = [];
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  setAgentRunner({
    deliver: async () => {},
    removePrWorktree: (o) => { asked.push(o); throw new Error(`reviewRoot 配下ではありません: ${o.path}`); },
    outboundStatus: () => ({ status: 'posted', event: 'approve', url: 'u' }),
  });
  try {
    const r = await runReviewLanes();
    assert.deepEqual(r.errors, []);
    assert.deepEqual(asked, [{ repo: 'o/r', pr: 8, path: copy, name: rec.id }]);
    const after = readReviewLane(rec.id);
    assert.equal(reviewLaneState(after).state, 'closed', 'the review was posted: the lane still ends');
    const posted = after.history.at(-1);
    assert.equal(posted.event, 'r_posted');
    assert.deepEqual(posted.attrs.copy_left, { path: copy, reason: `reviewRoot 配下ではありません: ${copy}` });
    assert.equal(warned.length, 1);
    assert.match(warned[0], /REV-8|old-root/);
  } finally {
    console.warn = warn;
    setAgentRunner(null);
  }
});

test('a PR closed while the lane waits for its author takes down the recorded copy, and a failure is written on the closing record', async () => {
  setup();
  const rec = openReviewLane({ repo: 'o/r', pr: 9 });
  const copy = '/old-root/REV-9';
  for (const [e, a] of [['r_wt_ready', { path: copy, head: 'h', base: 'b' }], ['r_posted', { round: 1, event: 'comment', head: 'h' }]]) appendReviewEvent(rec.id, e, a);
  const asked = [];
  const warn = console.warn;
  console.warn = () => {};
  setAgentRunner({
    deliver: async () => {},
    prStatus: () => ({ head: 'h', state: 'MERGED', title: 'T', url: 'u' }),
    movePrWorktree: () => ({ head: 'h', base: 'b' }),
    removePrWorktree: (o) => { asked.push(o); throw new Error('worktree が dirty です'); },
  });
  try {
    await runReviewLanes();
    assert.deepEqual(asked, [{ repo: 'o/r', pr: 9, path: copy, name: rec.id }]);
    const closed = readReviewLane(rec.id).history.at(-1);
    assert.equal(closed.event, 'r_closed');
    assert.deepEqual(closed.attrs.copy_left, { path: copy, reason: 'worktree が dirty です' });
  } finally {
    console.warn = warn;
    setAgentRunner(null);
  }
});

test('a push from the author moves the copy the lane recorded, by its name', async () => {
  setup();
  const rec = openReviewLane({ repo: 'o/r', pr: 10 });
  const copy = '/old-root/REV-10';
  for (const [e, a] of [['r_wt_ready', { path: copy, head: 'h', base: 'b' }], ['r_posted', { round: 1, event: 'comment', head: 'h' }]]) appendReviewEvent(rec.id, e, a);
  const asked = [];
  setAgentRunner({
    deliver: async () => {},
    prStatus: () => ({ head: 'h2', state: 'OPEN', title: 'T', url: 'u' }),
    movePrWorktree: (o) => { asked.push(o); return { head: 'h2', base: 'b' }; },
  });
  try {
    await runReviewLanes();
    assert.deepEqual(asked, [{ repo: 'o/r', pr: 10, path: copy, name: rec.id }]);
    assert.equal(reviewLaneState(readReviewLane(rec.id)).state, 'start_confirm');
  } finally {
    setAgentRunner(null);
  }
});

test('a follow-up should stays off the body even when the judgement reported it; a fix should goes on', () => {
  const d = renderReviewDraft([
    { severity: 'should', claim: 'まれな穴が残る', path: 'a.dart', fix: '条件を満たすこと', action: 'followup', report: true },
    { severity: 'should', claim: '境界の検査が抜けている', path: 'c.dart', report: true },
    { severity: 'must', claim: '購読が残る', path: 'b.dart', action: 'fix' },
  ]);
  assert.match(d.body, /境界の検査が抜けている/);
  assert.doesNotMatch(d.body, /まれな穴が残る/, 'a should sent to another Issue is not asked of the author');
  // a must still asks for changes; the recommendation does not turn it into an approve
  assert.equal(d.event, 'request-changes');
});

test('the judgement records which should reaches the author', async () => {
  setup();
  const rec = openReviewLane({ repo: 'o/r', pr: 9 });
  const status = {};
  setAgentRunner({
    deliver: async () => {},
    prStatus: () => ({ head: 'h1', state: 'OPEN', title: 'T', url: 'u' }),
    preparePrWorktree: async () => ({ path: '/wt/rev9', head: 'h1', base: 'b0' }),
    fetchPrContext: () => ({ files: [] }),
    startReviewRun: async (o) => { const ids = o.stage === 'blind' ? ['b1', 'b2'] : ['t1']; for (const i of ids) status[i] = { state: 'running' }; return { runIds: ids }; },
    reviewRunStatus: (id) => status[id],
    queueOutbound: async () => ({ id: 'OUT-1' }),
  });
  const step = () => runReviewLanes();
  await step(); await step();
  status.b1 = { state: 'done', reportJson: '/a.json', reportMd: '/a.md', findings: [] };
  status.b2 = { state: 'done', reportJson: '/b.json', reportMd: '/b.md', findings: [] };
  await step(); await step();
  status.t1 = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [
    { ref: 'F-1', verdict: 'accept', severity: 'should', claim: '伝える', report: true },
    { ref: 'F-2', verdict: 'accept', severity: 'should', claim: '伝えない' },
  ] };
  await step();
  const accepted = readReviewLane(rec.id).history.find((e) => e.event === 'r_triage_done').attrs.accepted;
  assert.equal(accepted[0].report, true, 'a reported should keeps the mark');
  assert.equal(accepted[1].report, undefined, 'a should without the mark stays on record only');
  setAgentRunner(null);
});

// a review lane's judgement over two blind reports; the reports sit where the runs wrote them, under the lane's id
async function judgeTwoReports({ declared, key = 'o/r', github, prRepo = 'o/r' }) {
  setup();
  const state = process.env.IDD_STATE_DIR;
  const savedRepos = process.env.IDD_REPOS_FILE;
  writeFileSync(join(state, 'repos.yaml'), JSON.stringify({ repos: { [key]: declared ? { upstream: join(state, 'u'), work: join(state, 'w'), ...(github ? { github } : {}), harm_examples: [{ harm: 3, example: 'secret が漏れる' }] } : { upstream: join(state, 'u'), work: join(state, 'w'), ...(github ? { github } : {}) } } }));
  process.env.IDD_REPOS_FILE = join(state, 'repos.yaml');
  try {
    const rec = openReviewLane({ repo: prRepo, pr: 11 });
    const report = (dir, findings) => {
      mkdirSync(join(state, 'pipeline', 'review', rec.id, dir), { recursive: true });
      const file = join(state, 'pipeline', 'review', rec.id, dir, 'report.json');
      writeFileSync(file, JSON.stringify({ findings, verdict: 'request-changes' }));
      return file;
    };
    const a = report('blind-aaa', [
      { severity: 'must', action: 'fix', frequency: '常時', how: '直し方', path: 'a.ts', line: 3, claim: '指摘 1', evidence: '根拠 1', is_guess: false },
      { severity: 'should', action: 'followup', frequency: 'まれ', path: 'b.ts', line: 9, claim: '指摘 2', evidence: '根拠 2', is_guess: false },
    ]);
    const b = report('blind-bbb', [{ severity: 'nit', path: 'c.ts', line: 1, claim: '指摘 3', evidence: '根拠 3', is_guess: false }]);
    const status = {};
    let triage;
    setAgentRunner({
      deliver: async () => {},
      prStatus: () => ({ head: 'h1', state: 'OPEN', title: 'T', url: 'u' }),
      preparePrWorktree: async () => ({ path: '/wt/rev11', head: 'h1', base: 'b0' }),
      fetchPrContext: () => ({ files: ['/ctx/body.md'] }),
      startReviewRun: async (o) => {
        if (o.stage === 'triage') triage = o;
        const ids = o.stage === 'blind' ? ['b1', 'b2'] : ['t1'];
        for (const i of ids) status[i] = { state: 'running' };
        return { runIds: ids };
      },
      reviewRunStatus: (id) => status[id],
      queueOutbound: async () => ({ id: 'OUT-1' }),
    });
    const step = () => runReviewLanes();
    await step(); await step();
    status.b1 = { state: 'done', reportJson: a, reportMd: '/a.md', findings: [] };
    status.b2 = { state: 'done', reportJson: b, reportMd: '/b.md', findings: [] };
    await step(); await step();
    // the judgement writes a weight of its own on the first decision: it was never handed one, so it is not the reporter's
    status.t1 = { state: 'done', reportJson: '/t.json', reportMd: '/t.md', decisions: [
      { ref: 'F-1', verdict: 'accept', severity: 'should', claim: '指摘 1', path: 'a.ts', from: ['blind-aaa'], reported_severity: 'nit', impact: '影響', action: 'fix', report: true },
      { ref: 'F-2', verdict: 'reject', severity: 'nit', claim: '指摘 2', path: 'b.ts', reason: '既出', from: ['blind-aaa'] },
      { ref: 'F-3', verdict: 'accept', severity: 'nit', claim: '指摘 3', path: 'c.ts', from: ['blind-zzz'], reported_severity: 'must', action: 'skip' },
      { ref: 'F-4', verdict: 'reject', severity: 'nit', claim: '書き換えた指摘', path: 'c.ts', reason: '誤り', from: ['blind-bbb'] },
    ] };
    await step();
    const done = readReviewLane(rec.id).history.find((e) => e.event === 'r_triage_done').attrs;
    setAgentRunner(null);
    return { triage, done };
  } finally {
    if (savedRepos === undefined) delete process.env.IDD_REPOS_FILE; else process.env.IDD_REPOS_FILE = savedRepos;
  }
}

test('the judgement of a review lane is handed the findings without the reviewer\'s weight, action, frequency and plan', async () => {
  const { triage } = await judgeTwoReports({ declared: false });
  const copies = triage.inputs.filter((p) => p.endsWith('.json'));
  assert.equal(copies.length, 2);
  for (const file of copies) {
    for (const f of JSON.parse(readFileSync(file, 'utf8')).findings) {
      for (const dropped of ['severity', 'action', 'frequency', 'how']) assert.equal(dropped in f, false, `${dropped} stays out of the judgement's input`);
      // what the judgement checks a finding against stays
      for (const kept of ['claim', 'evidence', 'path']) assert.equal(typeof f[kept], 'string', `${kept} is still handed`);
    }
  }
  // the copy sits in the report's own directory, so the parent name is still what the judgement writes as `from`
  assert.match(copies[0], /blind-aaa\/[^/]+\.json$/);
  assert.ok(triage.inputs.includes('/ctx/body.md'), 'the PR context is still handed');
});

test('only a repo that declared harm examples hands them to the review lane\'s judgement', async () => {
  const withExamples = await judgeTwoReports({ declared: true });
  const examples = withExamples.triage.inputs.filter((p) => /harm-examples/.test(p));
  assert.equal(examples.length, 1);
  assert.match(readFileSync(examples[0], 'utf8'), /害 3: secret が漏れる/);
  const without = await judgeTwoReports({ declared: false });
  assert.deepEqual(without.triage.inputs.filter((p) => /harm-examples/.test(p)), []);
});

test('a repo registered under another key than the PR\'s owner/name still hands its declared examples', async () => {
  const { triage } = await judgeTwoReports({ declared: true, key: 'work/o-r', github: 'o/r' });
  const examples = triage.inputs.filter((p) => /harm-examples/.test(p));
  assert.equal(examples.length, 1);
  assert.match(readFileSync(examples[0], 'utf8'), /害 3: secret が漏れる/);
  // a PR of a repo nothing registers gets no examples, and never another repo's
  const other = await judgeTwoReports({ declared: true, key: 'work/o-x', github: 'o/x' });
  assert.deepEqual(other.triage.inputs.filter((p) => /harm-examples/.test(p)), []);
});

test('a registration spelled with other capitals than GitHub\'s owner/name still hands its declared examples', async () => {
  for (const [key, github, prRepo] of [['o/r', undefined, 'O/R'], ['Org/Repo', undefined, 'org/repo'], ['work/o-r', 'O/R', 'o/r']]) {
    const { triage } = await judgeTwoReports({ declared: true, key, github, prRepo });
    const examples = triage.inputs.filter((p) => /harm-examples/.test(p));
    assert.equal(examples.length, 1, `${key} / ${github} for ${prRepo}`);
    assert.match(readFileSync(examples[0], 'utf8'), /害 3: secret が漏れる/);
  }
  const other = await judgeTwoReports({ declared: true, key: 'o/x', prRepo: 'O/R' });
  assert.deepEqual(other.triage.inputs.filter((p) => /harm-examples/.test(p)), []);
});

test('two registrations that differ only in capitals hand no examples for a PR neither spells exactly', () => {
  const areas = { 'o/r': { linked_repo: 'o/r' }, 'O/R': { linked_repo: 'O/R' } };
  assert.deepEqual(resolveGithubAreaKey('o/r', { areas }), { key: 'o/r' });
  assert.ok('error' in resolveGithubAreaKey('O/r', { areas }));
});

test('the judgement\'s record keeps which report each finding came from and the weight it had there; a finding it cannot trace has none', async () => {
  const { done } = await judgeTwoReports({ declared: false });
  const [one, three] = done.accepted;
  assert.deepEqual(one.from, ['blind-aaa']);
  assert.equal(one.reported_severity, 'must', 'the weight is the report\'s, not the one the judgement wrote');
  assert.equal(one.severity, 'should', 'the judged weight stays beside it');
  assert.deepEqual(three.from, ['blind-zzz']);
  assert.equal('reported_severity' in three, false, 'no report to read: the field is left out, not guessed');
  const [two, four] = done.rejected;
  assert.deepEqual(two.from, ['blind-aaa']);
  assert.equal(two.reported_severity, 'should');
  assert.equal(two.claim, '指摘 2', 'what the record already had is unchanged');
  assert.deepEqual(four.from, ['blind-bbb']);
  assert.equal('reported_severity' in four, false, 'a claim the judgement reworded binds to no finding');
});
