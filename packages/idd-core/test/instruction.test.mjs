import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  SCENES, applyPartialScope, normalizePartialScope, normalizeScope, placeOfScene, sceneOfStage, scopeMatches,
} from '../src/instruction/scope.ts';
import {
  REVIEW_THRESHOLD, activeInstructions, checkReason, checkText, instructionsCopyPath, instructionsPath, pickForStage, pickInstructions,
  readInstructions, selectInstructions,
} from '../src/instruction/store.ts';
import {
  approveInstructionProposal, approveSessionProposal, openInstructionProposals, proposeInstruction, proposalsPath, rejectInstructionProposal, reviewNotice,
} from '../src/instruction/proposals.ts';
import { formatLedgerEntry, ledgerPath, ledgerStateDir, readLedger, recordInjection } from '../src/instruction/ledger.ts';
import { conversationInstructionPrompt, instructionsSection } from '../src/instruction/brief.ts';
import { renderMessage } from '../src/agent/message.ts';
import { checkoutRoot } from '../src/config/files.ts';
import { stateDir } from '../src/paths.ts';
import { tmpDir } from './helpers/tmp.mjs';

/** a dir of its own for the instructions and the state: the real `~/.config/idd` is never read or written */
function setup() {
  const root = tmpDir('idd-instruction-');
  const dir = join(root, 'instructions');
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  Object.assign(process.env, { IDD_INSTRUCTIONS_DIR: dir, IDD_STATE_DIR: state });
  return { root, dir, state };
}

const ALL = { repos: 'all', scenes: 'all', places: 'all' };

/** approve one add proposal and return the instruction it made */
function adopt(text, reason, scope) {
  const proposed = proposeInstruction({ kind: 'add', text, reason, scope, session: 's-1' });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const approved = approveInstructionProposal(proposed.proposal.id);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  return approved.instruction;
}

test('every stage the lane runs has a scene, and the review scene holds the whole review family', () => {
  for (const stage of ['plan_review', 'blind', 'final', 'confirm', 'feedback_confirm', 'device', 'map']) assert.equal(sceneOfStage(stage), 'review', stage);
  assert.equal(sceneOfStage('plan'), 'plan');
  assert.equal(sceneOfStage('exec'), 'implement');
  assert.equal(sceneOfStage('fix_plan'), 'implement');
  assert.equal(sceneOfStage('triage'), 'triage');
  assert.equal(sceneOfStage('unknown'), null);
  assert.equal(sceneOfStage(undefined), null);
  assert.equal(placeOfScene('chat'), 'conversation');
  for (const scene of SCENES.filter((s) => s !== 'chat')) assert.equal(placeOfScene(scene), 'lane');
});

test('a scope matches only when the repo, the scene and the place all match', () => {
  const scope = { repos: ['me/app'], scenes: ['review'], places: ['lane'] };
  const hit = { repo: 'me/app', scene: 'review', place: 'lane' };
  assert.equal(scopeMatches(scope, hit), true);
  // one miss on each axis, the other two matching
  assert.equal(scopeMatches(scope, { ...hit, repo: 'me/other' }), false);
  assert.equal(scopeMatches(scope, { ...hit, scene: 'plan' }), false);
  assert.equal(scopeMatches(scope, { ...hit, place: 'conversation' }), false);
  // a situation with no repo does not match a repo range, and matches "all"
  assert.equal(scopeMatches(scope, { scene: 'review', place: 'lane' }), false);
  assert.equal(scopeMatches({ ...scope, repos: 'all' }, { scene: 'review', place: 'lane' }), true);
  // the same input gives the same answer
  assert.equal(scopeMatches(scope, hit), scopeMatches(scope, hit));
});

test('the scope table: every combination of axes answers by set membership', () => {
  const repos = ['all', ['me/app']];
  const scenes = ['all', ['review']];
  const places = ['all', ['lane']];
  const situations = [
    { repo: 'me/app', scene: 'review', place: 'lane' },
    { repo: 'me/other', scene: 'review', place: 'lane' },
    { repo: 'me/app', scene: 'plan', place: 'lane' },
    { repo: 'me/app', scene: 'chat', place: 'conversation' },
  ];
  for (const r of repos) for (const s of scenes) for (const p of places) {
    for (const sit of situations) {
      const expected = (r === 'all' || r.includes(sit.repo)) && (s === 'all' || s.includes(sit.scene)) && (p === 'all' || p.includes(sit.place));
      assert.equal(scopeMatches({ repos: r, scenes: s, places: p }, sit), expected, JSON.stringify({ r, s, p, sit }));
    }
  }
});

test('a scope is refused when it names an unknown scene, a bad repo or a scene and a place that never meet', () => {
  assert.equal(normalizeScope(ALL).ok, true);
  assert.equal(normalizeScope({ repos: 'all', scenes: ['nope'], places: 'all' }).ok, false);
  assert.equal(normalizeScope({ repos: ['not-a-repo'], scenes: 'all', places: 'all' }).ok, false);
  assert.equal(normalizeScope({ repos: 'all', scenes: ['chat'], places: ['lane'] }).ok, false);
  assert.equal(normalizeScope({ repos: 'all', scenes: ['review'], places: ['conversation'] }).ok, false);
  assert.equal(normalizeScope({ repos: 'all', scenes: [], places: 'all' }).ok, false);
  assert.equal(normalizeScope(null).ok, false);
});

test('an instruction is one sentence and a one-line reason', () => {
  assert.equal(checkText('レビューは blocker だけを挙げる。').ok, true);
  assert.equal(checkText('レビューは blocker だけを挙げる').ok, true);
  assert.equal(checkText('一つ目。二つ目。').ok, false);
  assert.equal(checkText('一行目\n二行目').ok, false);
  assert.equal(checkText('').ok, false);
  // a stop inside a quote does not end the sentence that quotes it
  assert.equal(checkText('「必ず直す。」と書かれた指摘だけを直す。').ok, true);
  assert.equal(checkText('Say "fix it. now." only when the review is a blocker.').ok, true);
  assert.equal(checkText('版は v1.2 のように書き、3.5 倍とは書かない').ok, true);
  assert.equal(checkText('迷ったら止める...そして聞く').ok, true);
  // ASCII stops end a sentence too
  assert.equal(checkText('Keep it short. Do not explain.').ok, false);
  assert.equal(checkText('Is it a blocker? Say so.').ok, false);
  assert.equal(checkText('止める！ 聞く').ok, false);
  // the stop that closes an abbreviation is part of the word, so a sentence that holds one is still one sentence
  assert.equal(checkText('Skip style nits, e.g. naming, in a review.').ok, true);
  assert.equal(checkText('Name the file, i.e. the path, in every finding.').ok, true);
  assert.equal(checkText('Ask Dr. Lee about Fig. 3 before you decide.').ok, true);
  assert.equal(checkText('Ask first. Dr. Lee decides.').ok, false);
  assert.equal(checkText('あ'.repeat(201)).ok, false);
  assert.equal(checkReason('嘘の指摘で巡が増えるから').ok, true);
  assert.equal(checkReason('一行目\n二行目').ok, false);
  assert.equal(checkReason(' ').ok, false);
});

test('a proposal changes nothing until it is approved, and then reaches only what its scope covers', () => {
  setup();
  const proposed = proposeInstruction({ kind: 'add', text: 'PR 本文は短く書く。', reason: '長い本文は読まれない', scope: { repos: ['me/app'], scenes: ['pr'], places: ['lane'] }, session: 's-1' });
  assert.equal(proposed.ok, true);
  // before the approval: nothing in force, nothing reaches any situation
  assert.deepEqual(activeInstructions(), []);
  assert.deepEqual(pickInstructions({ repo: 'me/app', scene: 'pr', place: 'lane' }), []);
  assert.equal(openInstructionProposals().length, 1);
  assert.equal(existsSync(instructionsPath()), false);

  const approved = approveInstructionProposal(proposed.proposal.id);
  assert.equal(approved.ok, true);
  assert.equal(approved.instruction.id, 'INS-1');
  assert.deepEqual(openInstructionProposals(), []);
  const picked = pickInstructions({ repo: 'me/app', scene: 'pr', place: 'lane' });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].text, 'PR 本文は短く書く。');
  assert.equal(picked[0].reason, '長い本文は読まれない');
  // out of range: another repo, another scene, a conversation
  assert.deepEqual(pickInstructions({ repo: 'me/other', scene: 'pr', place: 'lane' }), []);
  assert.deepEqual(pickInstructions({ repo: 'me/app', scene: 'plan', place: 'lane' }), []);
  assert.deepEqual(pickInstructions({ repo: 'me/app', scene: 'chat', place: 'conversation' }), []);
});

test('a rejected proposal changes nothing and keeps its reason; the reason is required', () => {
  const { dir } = setup();
  const proposed = proposeInstruction({ kind: 'add', text: '返信は敬体で書く。', reason: '相手への礼儀', scope: ALL, session: 's-1' });
  assert.equal(rejectInstructionProposal(proposed.proposal.id, '').ok, false);
  assert.equal(openInstructionProposals().length, 1);
  assert.equal(rejectInstructionProposal(proposed.proposal.id, 'いまは要らない').ok, true);
  assert.deepEqual(openInstructionProposals(), []);
  assert.deepEqual(activeInstructions(), []);
  assert.match(readFileSync(join(dir, 'decisions.jsonl'), 'utf8'), /いまは要らない/);
  assert.equal(approveInstructionProposal(proposed.proposal.id).ok, false);
});

test('a change and a retire need an instruction that exists; a retire takes it out and its id is not reused', () => {
  setup();
  assert.equal(proposeInstruction({ kind: 'retire', target: 'INS-9', session: 's-1' }).ok, false);
  assert.equal(proposeInstruction({ kind: 'change', target: 'INS-9', text: 'x', session: 's-1' }).ok, false);
  const first = adopt('一つ目の方針。', '理由 1', ALL);
  const changed = proposeInstruction({ kind: 'change', target: first.id, text: '直した方針。', session: 's-1' });
  assert.equal(changed.ok, true);
  assert.equal(proposeInstruction({ kind: 'change', target: first.id, session: 's-1' }).ok, false, 'a change names a field');
  const done = approveInstructionProposal(changed.proposal.id);
  assert.equal(done.instruction.text, '直した方針。');
  assert.equal(done.instruction.reason, '理由 1');
  const retire = proposeInstruction({ kind: 'retire', target: first.id, session: 's-1' });
  approveInstructionProposal(retire.proposal.id);
  assert.deepEqual(activeInstructions(), []);
  const second = adopt('二つ目の方針。', '理由 2', ALL);
  assert.equal(second.id, 'INS-2');
});

test('an add needs the text, the reason and the scope; a lane session proposes nothing without a session', () => {
  setup();
  assert.equal(proposeInstruction({ kind: 'add', text: 'a。', reason: 'b', session: 's-1' }).ok, false, 'no scope');
  assert.equal(proposeInstruction({ kind: 'add', text: 'a。', scope: ALL, session: 's-1' }).ok, false, 'no reason');
  assert.equal(proposeInstruction({ kind: 'add', text: 'a。', reason: 'b', scope: ALL, session: '' }).ok, false, 'no session');
  assert.equal(proposeInstruction({ kind: 'nope', session: 's-1' }).ok, false);
  assert.equal(proposeInstruction({ kind: 'add', text: 'a。b。', reason: 'b', scope: ALL, session: 's-1' }).ok, false, 'two sentences');
});

test('the readable copy is made from the file and says what it holds', () => {
  setup();
  adopt('レビューは blocker だけを挙げる。', '嘘の指摘で巡が増えるから', { repos: ['me/app'], scenes: ['review'], places: 'all' });
  const copy = readFileSync(instructionsCopyPath(), 'utf8');
  assert.match(copy, /INS-1/);
  assert.match(copy, /レビューは blocker だけを挙げる。/);
  assert.match(copy, /嘘の指摘で巡が増えるから/);
  assert.match(copy, /me\/app/);
});

test('a missing, unreadable or broken file is no instructions and a write never overwrites it with an empty one', () => {
  const { dir } = setup();
  assert.equal(readInstructions().state, 'missing');
  assert.deepEqual(activeInstructions(), []);
  mkdirSync(dir, { recursive: true });
  writeFileSync(instructionsPath(), '{ not json');
  assert.equal(readInstructions().state, 'broken');
  assert.deepEqual(pickForStage('blind', 'me/app'), [], 'a lane goes on with no instructions');
  const proposed = proposeInstruction({ kind: 'add', text: '一文。', reason: '理由', scope: ALL, session: 's-1' });
  assert.equal(proposed.ok, true, 'a proposal does not touch the broken file');
  const refused = approveInstructionProposal(proposed.proposal.id);
  assert.equal(refused.ok, false);
  // the broken bytes survive under another name, and the proposal is still waiting
  const aside = readdirSync(dir).filter((n) => n.startsWith('instructions.json.broken-'));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), '{ not json');
  assert.equal(openInstructionProposals().length, 1);
  // the retry starts from no file and lands
  assert.equal(approveInstructionProposal(proposed.proposal.id).ok, true);
  assert.equal(activeInstructions().length, 1);
});

test('an entry that is not an instruction is skipped and the rest of the file still reads', () => {
  const { dir } = setup();
  mkdirSync(dir, { recursive: true });
  writeFileSync(instructionsPath(), JSON.stringify({
    version: 1, next: 3,
    instructions: [
      { id: 'INS-1', text: '良い方針。', reason: '理由', scope: ALL, created_at: 'a', updated_at: 'a' },
      { id: 'INS-2', text: '二つ。の文。', reason: '理由', scope: ALL, created_at: 'a', updated_at: 'a' },
      { id: 'oops' },
    ],
  }));
  const read = readInstructions();
  assert.equal(read.state, 'ok');
  assert.deepEqual(read.file.instructions.map((i) => i.id), ['INS-1']);
});

test('a session adds an instruction out of scope and excludes one in scope; the file and other sessions are untouched', () => {
  setup();
  const review = adopt('レビューは短く書く。', '読まれないから', { repos: 'all', scenes: ['review'], places: ['lane'] });
  const chat = adopt('会話は丁寧に答える。', '雑に読まれるから', { repos: 'all', scenes: ['chat'], places: ['conversation'] });
  const all = activeInstructions();
  const sit = { repo: 'me/app', scene: 'chat', place: 'conversation' };
  assert.deepEqual(selectInstructions(all, sit).map((p) => p.id), [chat.id]);
  // the session's own exceptions: add the review one (out of its scope), exclude the chat one (in scope)
  const own = selectInstructions(all, sit, { add: [review.id], exclude: [chat.id] });
  assert.deepEqual(own.map((p) => [p.id, p.via]), [[review.id, 'session']]);
  // another session with no exceptions is as it was
  assert.deepEqual(selectInstructions(all, sit).map((p) => [p.id, p.via]), [[chat.id, 'scope']]);
  // an added one that is also in scope is told as the session's own
  assert.deepEqual(selectInstructions(all, sit, { add: [chat.id] }).map((p) => p.via), ['session']);
  // the file did not change
  assert.equal(activeInstructions().length, 2);
});

test('the same input gives the same selection every time', () => {
  setup();
  adopt('一つ目の方針。', '理由 1', { repos: ['me/app'], scenes: ['review', 'plan'], places: 'all' });
  adopt('二つ目の方針。', '理由 2', ALL);
  const sit = { repo: 'me/app', scene: 'review', place: 'lane' };
  const a = JSON.stringify(pickInstructions(sit));
  const b = JSON.stringify(pickInstructions(sit));
  assert.equal(a, b);
  assert.equal(JSON.parse(a).length, 2);
});

test('the review scene reaches the plan review, the blind, the last review and the confirmations', () => {
  setup();
  const ins = adopt('レビューは blocker だけを挙げる。', '嘘の指摘を減らす', { repos: 'all', scenes: ['review'], places: 'all' });
  for (const stage of ['plan_review', 'blind', 'final', 'confirm', 'feedback_confirm', 'device']) {
    assert.deepEqual(pickForStage(stage, 'me/app').map((p) => p.id), [ins.id], stage);
  }
  for (const stage of ['plan', 'exec', 'fix_plan', 'triage', undefined]) assert.deepEqual(pickForStage(stage, 'me/app'), [], String(stage));
});

test('the brief section holds the text and the reason, and nothing when nothing applies', () => {
  setup();
  assert.equal(instructionsSection([]), null);
  const ins = adopt('レビューは blocker だけを挙げる。', '嘘の指摘を減らす <か> &', ALL);
  const section = instructionsSection(pickForStage('blind', 'me/app'));
  const text = renderMessage([section]);
  assert.match(text, /<instructions>/);
  assert.match(text, /レビューは blocker だけを挙げる。（理由: 嘘の指摘を減らす &lt;か&gt; &amp;）/);
  assert.equal(ins.id, 'INS-1');
  const chat = conversationInstructionPrompt(pickInstructions({ scene: 'chat', place: 'conversation' }));
  assert.match(chat, /レビューは blocker だけを挙げる。/);
  assert.match(chat, /instruction propose add/);
  // a conversation with nothing that applies still learns how to propose
  assert.match(conversationInstructionPrompt([]), /instruction propose add/);
});

test('the ledger appends, keeps what was delivered, and a later edit does not change an earlier line', () => {
  setup();
  const ins = adopt('レビューは短く書く。', '読まれないから', ALL);
  recordInjection(pickForStage('blind', 'me/app'), { kind: 'lane', stage: 'blind', scene: 'review', lane: 'IDD-1' }, new Date('2026-10-25T01:00:00Z'));
  const change = proposeInstruction({ kind: 'change', target: ins.id, text: '直した方針。', session: 's-1' });
  approveInstructionProposal(change.proposal.id);
  recordInjection(pickInstructions({ scene: 'chat', place: 'conversation' }), { kind: 'conversation', session: 'c-9', scene: 'chat' }, new Date('2026-10-25T02:00:00Z'));
  recordInjection(pickForStage('final', 'me/app'), { kind: 'lane', stage: 'final', scene: 'review', lane: 'IDD-1' }, new Date('2026-10-25T03:00:00Z'));

  const all = readLedger();
  assert.equal(all.length, 3);
  // the first line still holds the text it delivered
  assert.equal(all[0].text, 'レビューは短く書く。');
  assert.equal(all[0].at, '2026-10-25T01:00:00.000Z');
  assert.deepEqual(all[0].to, { kind: 'lane', stage: 'blind', scene: 'review', lane: 'IDD-1' });
  assert.equal(all[1].text, '直した方針。');
  // read by lane, by session, by instruction
  assert.equal(readLedger({ lane: 'IDD-1' }).length, 2);
  assert.equal(readLedger({ session: 'c-9' }).length, 1);
  assert.equal(readLedger({ instruction: ins.id }).length, 3);
  assert.equal(readLedger({ lane: 'IDD-1', stage: 'final' }).length, 1);
  assert.equal(readLedger({ limit: 1 })[0].to.stage, 'final');
  // appended only: the file's earlier bytes are a prefix of its later bytes
  const before = readFileSync(ledgerPath(), 'utf8');
  recordInjection(pickForStage('blind', 'me/app'), { kind: 'lane', stage: 'blind', scene: 'review', lane: 'IDD-2' });
  assert.ok(readFileSync(ledgerPath(), 'utf8').startsWith(before));
  // a delivery of nothing writes nothing
  recordInjection([], { kind: 'lane', stage: 'blind', scene: 'review' });
  assert.equal(readLedger().length, 4);
});

test('a one-shot writer names the lane it wrote for, so that lane, stage and the printed line reach it', () => {
  setup();
  adopt('下書きは短く書く。', '読まれないから', ALL);
  const picked = pickInstructions({ repo: 'me/app', scene: 'pr', place: 'lane' });
  recordInjection(picked, { kind: 'writer', stage: 'pr_draft', scene: 'pr', lane: 'IDD-7', repo: 'me/app' });
  recordInjection(picked, { kind: 'writer', stage: 'reply_draft', scene: 'reply', repo: 'me/app' });
  const mine = readLedger({ lane: 'IDD-7' });
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0].to, { kind: 'writer', stage: 'pr_draft', scene: 'pr', lane: 'IDD-7', repo: 'me/app' });
  assert.equal(readLedger({ lane: 'IDD-7', stage: 'pr_draft' }).length, 1);
  // a lane's own stage and its one-shot writer are read together under that lane's id
  recordInjection(picked, { kind: 'lane', stage: 'blind', scene: 'review', lane: 'IDD-7' });
  assert.deepEqual(readLedger({ lane: 'IDD-7' }).map((e) => e.to.kind), ['writer', 'lane']);
  assert.equal(readLedger({ stage: 'reply_draft' }).length, 1);
  assert.match(formatLedgerEntry(mine[0]), /lane IDD-7 の pr_draft/);
  // a draft with no lane is printed without a lane that does not exist
  const loose = formatLedgerEntry(readLedger({ stage: 'reply_draft' })[0]);
  assert.doesNotMatch(loose, /lane -/);
  assert.match(loose, /reply_draft（me\/app）/);
});

test('a ledger that cannot be written does not throw, and a line that is not an entry is skipped when reading', () => {
  const { state } = setup();
  writeFileSync(join(state, 'instruction-ledger.jsonl'), 'garbage\n');
  appendFileSync(join(state, 'instruction-ledger.jsonl'), `${JSON.stringify({ at: 'x', instruction: 'INS-1', text: 't', reason: 'r', scope: ALL, via: 'scope', to: { kind: 'lane', stage: 'blind', scene: 'review' } })}\n`);
  assert.equal(readLedger().length, 1);
});

test('the add card asks for a review once the list is long, and still lets the user approve it', () => {
  setup();
  for (let n = 0; n < REVIEW_THRESHOLD - 1; n += 1) adopt(`方針 ${n} 番目。`, '理由', ALL);
  const below = proposeInstruction({ kind: 'add', text: '足りる方針。', reason: '理由', scope: ALL, session: 's-1' });
  assert.equal(reviewNotice(below.proposal), null);
  approveInstructionProposal(below.proposal.id);
  assert.equal(activeInstructions().length, REVIEW_THRESHOLD);
  const over = proposeInstruction({ kind: 'add', text: 'あふれる方針。', reason: '理由', scope: ALL, session: 's-1' });
  assert.equal(over.ok, true, 'an add is never refused for the count');
  assert.match(reviewNotice(over.proposal), /引退/);
  assert.equal(reviewNotice({ ...over.proposal, kind: 'retire' }), null);
  assert.equal(approveInstructionProposal(over.proposal.id).ok, true);
  assert.equal(activeInstructions().length, REVIEW_THRESHOLD + 1);
});

test('too many open proposals are refused so a stuck agent cannot bury the Inbox', () => {
  setup();
  for (let n = 0; n < 20; n += 1) assert.equal(proposeInstruction({ kind: 'add', text: `方針 ${n}。`, reason: 'r', scope: ALL, session: 's-1' }).ok, true);
  assert.equal(proposeInstruction({ kind: 'add', text: '21 番目。', reason: 'r', scope: ALL, session: 's-1' }).ok, false);
  assert.equal(existsSync(proposalsPath()), true);
});

test('an approval retried after the proposal could not be cleared makes the instruction once', () => {
  setup();
  const proposed = proposeInstruction({ kind: 'add', text: '会話では結論から答える。', reason: '前置きが長いと読まれないから', scope: ALL, session: 's-1' });
  assert.equal(proposed.ok, true);
  const open = readFileSync(proposalsPath(), 'utf8');
  const first = approveInstructionProposal(proposed.proposal.id);
  assert.equal(first.ok, true);
  // the failure between the write and the clearing leaves the proposal in the open file
  writeFileSync(proposalsPath(), open, 'utf8');
  const again = approveInstructionProposal(proposed.proposal.id);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.replayed, true);
  assert.equal(again.instruction.id, first.instruction.id);
  assert.deepEqual(activeInstructions().map((i) => i.id), [first.instruction.id]);
  assert.deepEqual(openInstructionProposals(), []);
  // a later proposal is a new one: it makes a second instruction
  const next = adopt('レビューは blocker だけを挙げる。', '嘘の指摘で巡が増えるから', ALL);
  assert.notEqual(next.id, first.instruction.id);
  assert.equal(activeInstructions().length, 2);
  // a proposal that reuses an id after its file was lost is not taken for the one already applied
  rmSync(proposalsPath());
  const reused = proposeInstruction({ kind: 'add', text: '返信は短く書く。', reason: '長い返信は読まれないから', scope: ALL, session: 's-1' }, new Date(Date.now() + 60_000));
  assert.equal(reused.proposal.id, 'INP-1');
  const made = approveInstructionProposal('INP-1', new Date(Date.now() + 5000));
  assert.equal(made.ok, true);
  assert.notEqual(made.replayed, true);
  assert.equal(activeInstructions().length, 3);
});

test('a retire retried after the proposal could not be cleared is not refused for its target being gone', () => {
  setup();
  const target = adopt('会話では結論から答える。', '前置きが長いと読まれないから', ALL);
  const retire = proposeInstruction({ kind: 'retire', target: target.id, session: 's-1' });
  const open = readFileSync(proposalsPath(), 'utf8');
  assert.equal(approveInstructionProposal(retire.proposal.id).ok, true);
  writeFileSync(proposalsPath(), open, 'utf8');
  const again = approveInstructionProposal(retire.proposal.id);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(openInstructionProposals(), []);
  assert.deepEqual(activeInstructions(), []);
});

test('a session proposal names the conversation and the instruction, changes no instruction, and is applied by the caller', () => {
  setup();
  const target = adopt('会話では結論から答える。', '前置きが長いと読まれないから', ALL);
  const refused = [
    { kind: 'session', op: 'add', target: 'INS-99', forSession: 'conv-1', session: 'conv-1' },
    { kind: 'session', op: 'swap', target: target.id, forSession: 'conv-1', session: 'conv-1' },
    { kind: 'session', op: 'add', target: target.id, session: 'conv-1' },
    { kind: 'session', op: 'add', session: 'conv-1', forSession: 'conv-1' },
  ];
  for (const input of refused) assert.equal(proposeInstruction(input).ok, false, JSON.stringify(input));
  assert.equal(proposeInstruction({ kind: 'session', op: 'clear', target: 'INS-99', forSession: 'conv-1', session: 'conv-1' }).ok, true);
  const filed = proposeInstruction({ kind: 'session', op: 'exclude', target: target.id, forSession: 'conv-1', session: 'conv-1' });
  assert.equal(filed.ok, true);
  assert.equal(filed.proposal.for_session, 'conv-1');
  // the instruction approval refuses it: only the engine, which owns the marks, can apply it
  assert.equal(approveInstructionProposal(filed.proposal.id).ok, false);
  const applied = [];
  const failed = approveSessionProposal(filed.proposal.id, () => ({ ok: false, error: '会話がありません' }));
  assert.equal(failed.ok, false);
  assert.equal(openInstructionProposals().some((p) => p.id === filed.proposal.id), true);
  const done = approveSessionProposal(filed.proposal.id, (p) => { applied.push(`${p.op} ${p.target} ${p.for_session}`); return { ok: true }; });
  assert.equal(done.ok, true);
  assert.deepEqual(applied, [`exclude ${target.id} conv-1`]);
  assert.equal(openInstructionProposals().some((p) => p.id === filed.proposal.id), false);
  assert.equal(activeInstructions().length, 1);
});

test('a write keeps an entry that did not read, and the id it names is not handed out again', () => {
  const { dir } = setup();
  mkdirSync(dir, { recursive: true });
  const stale = { id: 'INS-2', text: '二つ。の文。', reason: '理由', scope: ALL, created_at: 'a', updated_at: 'a' };
  writeFileSync(instructionsPath(), JSON.stringify({
    version: 1, next: 2,
    instructions: [{ id: 'INS-1', text: '良い方針。', reason: '理由', scope: ALL, created_at: 'a', updated_at: 'a' }, stale, { id: 'oops' }],
  }));
  const made = adopt('別の方針。', '別の理由', ALL);
  assert.equal(made.id, 'INS-3', 'the id of the set-aside entry is not reused');
  const file = JSON.parse(readFileSync(instructionsPath(), 'utf8'));
  assert.deepEqual(file.instructions.map((i) => i.id), ['INS-1', 'INS-3']);
  assert.deepEqual(file.rejected, [stale, { id: 'oops' }], 'the entries are kept as they were written');
  assert.match(readFileSync(instructionsCopyPath(), 'utf8'), /2 件/);
  // a second write does not drop them or write them twice
  adopt('三つ目の方針。', '三つ目の理由', ALL);
  assert.equal(JSON.parse(readFileSync(instructionsPath(), 'utf8')).rejected.length, 2);
  assert.deepEqual(activeInstructions().map((i) => i.id), ['INS-1', 'INS-3', 'INS-4']);
});

test('a change names the scope axes it changes and keeps the others as the instruction has them', () => {
  setup();
  const ins = adopt('一つ目の方針。', '理由', { repos: ['me/app'], scenes: ['review'], places: ['lane'] });
  const proposed = proposeInstruction({ kind: 'change', target: ins.id, scope: { scenes: ['plan', 'review'] }, session: 's-1' });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  assert.deepEqual(proposed.proposal.scope, { scenes: ['plan', 'review'] }, 'an axis left out stays out of the proposal');
  const done = approveInstructionProposal(proposed.proposal.id);
  assert.deepEqual(done.instruction.scope, { repos: ['me/app'], scenes: ['plan', 'review'], places: ['lane'] });
  // the axis named "all" is all; the ones left out are not
  const widened = approveInstructionProposal(proposeInstruction({ kind: 'change', target: ins.id, scope: { repos: 'all' }, session: 's-1' }).proposal.id);
  assert.deepEqual(widened.instruction.scope, { repos: 'all', scenes: ['plan', 'review'], places: ['lane'] });
  // a named axis that cannot meet the one kept is refused when proposed
  assert.equal(proposeInstruction({ kind: 'change', target: ins.id, scope: { places: ['conversation'] }, session: 's-1' }).ok, false);
  assert.equal(proposeInstruction({ kind: 'change', target: ins.id, scope: {}, session: 's-1' }).ok, false, 'a change names an axis');
  assert.equal(proposeInstruction({ kind: 'add', text: '一文。', reason: '理由', scope: { repos: 'all' }, session: 's-1' }).ok, false, 'an add declares all three');
  assert.equal(normalizePartialScope({ repos: ['not a repo'] }).ok, false);
  assert.equal(applyPartialScope(ALL, { scenes: ['chat'] }).ok, true);
});

test('the ledger sits in IDD_STATE_DIR, else in the checkout\'s state, and a changed cwd does not move it', () => {
  const { state } = setup();
  assert.equal(ledgerPath(), join(state, 'instruction-ledger.jsonl'));
  const saved = process.env.IDD_STATE_DIR;
  const cwd = process.cwd();
  try {
    delete process.env.IDD_STATE_DIR;
    const here = ledgerPath();
    assert.equal(here, join(checkoutRoot(), 'state', 'instruction-ledger.jsonl'));
    process.chdir(tmpDir('idd-instruction-cwd-'));
    assert.equal(ledgerPath(), here);
    assert.equal(ledgerStateDir(), resolve(checkoutRoot(), 'state'));
  } finally {
    process.chdir(cwd);
    process.env.IDD_STATE_DIR = saved;
  }
});

test('a relative IDD_STATE_DIR is read against the cwd as every other reader does, so the ledger and stateDir() agree', () => {
  setup();
  const saved = process.env.IDD_STATE_DIR;
  const cwd = process.cwd();
  try {
    process.env.IDD_STATE_DIR = 'rel-state';
    assert.equal(ledgerStateDir(), stateDir());
    assert.equal(ledgerPath(), join(resolve(cwd, 'rel-state'), 'instruction-ledger.jsonl'));
  } finally {
    process.chdir(cwd);
    process.env.IDD_STATE_DIR = saved;
  }
});

test('a ledger limit of 0 reads nothing, and only a limit that was not given reads everything', () => {
  setup();
  adopt('レビューは短く書く。', '読まれないから', ALL);
  const picked = pickForStage('blind', 'me/app');
  recordInjection(picked, { kind: 'lane', stage: 'blind', scene: 'review', lane: 'IDD-1' });
  recordInjection(picked, { kind: 'lane', stage: 'blind', scene: 'review', lane: 'IDD-1' });
  assert.deepEqual(readLedger({ limit: 0 }), []);
  assert.deepEqual(readLedger({ lane: 'IDD-1', limit: 0 }), []);
  assert.equal(readLedger({ limit: 1 }).length, 1);
  assert.equal(readLedger({ limit: 5 }).length, 2);
  assert.equal(readLedger().length, 2);
  assert.equal(readLedger({}).length, 2);
});
