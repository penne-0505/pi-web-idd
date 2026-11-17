import assert from 'node:assert/strict';
import { test } from 'node:test';

import { internalTerms } from '../src/plan/vocab.ts';

test('words of the records workflow are found in text meant for the public side', () => {
  assert.deepEqual(internalTerms('validator との非互換は本 lane では解消しない'), ['本 lane']);
  assert.deepEqual(internalTerms('see DEC-034 and the records'), ['DEC-034', 'records']);
  assert.deepEqual(internalTerms('Move the usage guide to docs/usage.md'), []);
});

test('a repo can allow a word it uses in its own sense', () => {
  assert.deepEqual(internalTerms('each swim lane gets a planner', ['lane', 'planner']), []);
  assert.deepEqual(internalTerms('the lane runner and DEC-1', ['lane']), ['DEC-1']);
});

test('a commit message is stopped only by an ID of the records or a Japanese word of the workflow; an English word is a warning', async () => {
  const { commitMessageProblem, commitVocabulary } = await import('../src/plan/vocab.ts');
  // commits of the repos themselves, which use these words in their own sense
  assert.equal(commitMessageProblem('feat(IllustCrop): overlay の位置を直す'), null);
  assert.equal(commitMessageProblem('fix: record focused view state before the handoff'), null);
  assert.equal(commitMessageProblem('fix: keep the intent of each lane in the records'), null);
  for (const id of ['DEC-001', 'INV-1', 'AC-1', 'IDD-12']) assert.match(commitMessageProblem(`fix: ${id} の対応を入れる`) ?? '', new RegExp(id), id);
  assert.match(commitMessageProblem('fix: 本 lane の範囲を直す') ?? '', /本 lane/);
  assert.match(commitMessageProblem('fix: 記録側の参照を消す') ?? '', /記録側/);
  // the English words stay found, as warnings shown on the card
  assert.deepEqual(commitVocabulary('feat: DEC-001 と overlay の records'), { blocking: ['DEC-001'], warning: ['overlay', 'records'] });
  assert.deepEqual(commitVocabulary('feat: 本 lane と記録側'), { blocking: ['本 lane', '記録側'], warning: [] });
  assert.deepEqual(commitVocabulary('feat: overlay の DEC-1', ['overlay', 'DEC-1']), { blocking: [], warning: [] });
});

test('the PR text is still warned of every word, English ones included', () => {
  assert.deepEqual(internalTerms('feat: overlay の位置を直す'), ['overlay']);
  assert.deepEqual(internalTerms('record focused view state'), ['record']);
});

// --- blind of 2026-09-26: the forms that slipped through, and the words that stopped too much ---

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('本 lane is found with any spaces between, full-width ones included', async () => {
  const { commitVocabulary } = await import('../src/plan/vocab.ts');
  for (const word of ['本lane', '本 lane', '本　lane', '本  lane', '本　 lane']) {
    assert.deepEqual(internalTerms(`validator との非互換は${word}では解消しない`), [word], JSON.stringify(word));
    assert.deepEqual(commitVocabulary(`fix: ${word}の範囲を直す`), { blocking: [word], warning: [] }, JSON.stringify(word));
  }
});

test('an ID of the records stops a commit message in every form it is written: a TODO ID, a question ID, no hyphen, an underscore, a Unicode hyphen', async () => {
  const { commitMessageProblem, commitVocabulary } = await import('../src/plan/vocab.ts');
  for (const id of ['IddCore-Enhance-69', 'Docs-Chore-10', 'Q-001', 'DEC001', 'DEC_001', 'DEC‐001', 'DEC–001', 'INV‑002', 'DEC－001']) {
    assert.match(commitMessageProblem(`fix: ${id} の対応を入れる`) ?? '', new RegExp(escape(id)), JSON.stringify(id));
    assert.deepEqual(commitVocabulary(`fix: ${id} の対応を入れる`), { blocking: [id], warning: [] }, JSON.stringify(id));
  }
});

test('IDD and Intent Delta, names of the workflow, stop a commit message; R2, also a plain name (Cloudflare R2), is a warning', async () => {
  const { commitVocabulary } = await import('../src/plan/vocab.ts');
  assert.deepEqual(commitVocabulary('fix: IDD の手順に合わせる'), { blocking: ['IDD'], warning: [] });
  assert.deepEqual(commitVocabulary('docs: Intent Delta を書く'), { blocking: ['Intent Delta'], warning: [] });
  assert.deepEqual(commitVocabulary('feat: upload to R2'), { blocking: [], warning: ['R2'] });
  // the PR text finds Intent Delta as one word, not its first half
  assert.deepEqual(internalTerms('the Intent Delta of the round'), ['Intent Delta']);
});

test('a prefix of an ID is an ID only with a number after it: plain words that start like one are not found', async () => {
  const { commitVocabulary } = await import('../src/plan/vocab.ts');
  assert.deepEqual(commitVocabulary('fix: QA-friendly な AC-DC の設定を Dec-2025 版にする'), { blocking: [], warning: [] });
  assert.deepEqual(internalTerms('QA-friendly AC-DC Dec-2025'), []);
  assert.deepEqual(commitVocabulary('fix: QA-12 と AC-3 を直す'), { blocking: ['QA-12', 'AC-3'], warning: [] });
  // a package name of the repo's own (idd-core) is not an ID either: the lowercase word is a warning, only IDD stops
  assert.deepEqual(commitVocabulary('fix(idd-core): 直す'), { blocking: [], warning: ['idd'] });
});

test('lane and hand-written IDs are found whole, not cut at the bare prefix (AC-024)', () => {
  assert.deepEqual(internalTerms('DEC-088-1 INV-088-1 DEC-IddCore-2 IddCore-Bug-088-1'), [
    'DEC-088-1',
    'INV-088-1',
    'DEC-IddCore-2',
    'IddCore-Bug-088-1',
  ]);
  // a bare number never stands for the lane ID's head
  assert.deepEqual(internalTerms('DEC-088 と DEC-088-1'), ['DEC-088', 'DEC-088-1']);
});

test('the current records\' IDs are found: a Choice stops a commit like a DEC, a Purpose is a warning only', async () => {
  const { commitVocabulary } = await import('../src/plan/vocab.ts');
  assert.deepEqual(internalTerms('see C-184-1 and C-claude-desktop-supervisor-20261018-8'), ['C-184-1', 'C-claude-desktop-supervisor-20261018-8']);
  assert.deepEqual(commitVocabulary('fix: C-184-1 の対応を入れる'), { blocking: ['C-184-1'], warning: [] });
  // a PR feedback's bare ref is not a Choice
  assert.deepEqual(internalTerms('C-3 に返信する'), []);
  // a Purpose's ID is the same shape as a plain name (the P-256 curve), so it warns and never stops a commit
  assert.deepEqual(commitVocabulary('feat: P-12 と P-256'), { blocking: [], warning: ['P-12', 'P-256'] });
});

test('the current records\' words are warnings: Waive in any case, Choice and Purpose as capitalized names', async () => {
  const { commitVocabulary } = await import('../src/plan/vocab.ts');
  assert.deepEqual(internalTerms('Waive を宣言し、Choice と Purpose を書く'), ['Waive', 'Choice', 'Purpose']);
  // the plain English words stay out
  assert.deepEqual(internalTerms('the choice of purpose'), []);
  assert.deepEqual(commitVocabulary('docs: Choice を足す'), { blocking: [], warning: ['Choice'] });
});

test('only the lane shape of a Choice ID stops a commit; a session-shaped one warns, and a word that merely looks like one is none', async () => {
  const { commitVocabulary, commitMessageProblem } = await import('../src/plan/vocab.ts');
  // the session key is any name, so its shape is a warning only
  assert.deepEqual(commitVocabulary('fix: C-claude-desktop-supervisor-20261018-8 の続き'), { blocking: [], warning: ['C-claude-desktop-supervisor-20261018-8'] });
  // words that are not Choice IDs: an upper-case name, a part of a longer token on either side
  for (const text of ['fix: C-API-2 の呼び先を直す', 'build: x-C-184-1 を足す', 'fix: C-184-1a', 'fix: v.C-184-1', 'fix: C-184-1-rc']) {
    assert.equal(commitMessageProblem(text), null, text);
    assert.deepEqual(commitVocabulary(text).blocking, [], text);
  }
  assert.match(commitMessageProblem('fix: (C-184-1) を直す') ?? '', /C-184-1/);
});

test('an English repo writes Choice and Purpose as plain words; their IDs are still found', async () => {
  const { commitVocabulary, publicVocabularyAllow } = await import('../src/plan/vocab.ts');
  const en = publicVocabularyAllow({ public_language: 'en', public_vocabulary_allow: ['lane'] });
  assert.deepEqual(commitVocabulary('feat: Choice of the default model', en), { blocking: [], warning: [] });
  assert.deepEqual(internalTerms('The Purposes of a lane', en), []);
  assert.deepEqual(commitVocabulary('fix: C-184-1 and P-2', en), { blocking: ['C-184-1'], warning: ['P-2'] });
  // a Japanese repo (the default) keeps the warning
  assert.deepEqual(publicVocabularyAllow({}), []);
  assert.deepEqual(commitVocabulary('feat: Choice を足す', publicVocabularyAllow({ public_language: 'ja' })).warning, ['Choice']);
});
