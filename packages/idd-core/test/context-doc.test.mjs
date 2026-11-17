import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { executorBrief, fixBrief } from '../src/plan/exec.ts';
import { laneRecordDirs } from '../src/plan/lane-records.ts';
import { laneContextPath } from '../src/plan/plan-doc.ts';
import { plannerBrief } from '../src/plan/prep.ts';
import { CONTEXT_DOC_RULE, EXECUTOR_CONTEXT_RULE, WORK_INSTRUCTION_RULE } from '../src/plan/prompt-text.ts';
import { buildEnvelope } from '../src/ledger/write.ts';
import { esc } from '../src/agent/message.ts';
import { tmpDir } from './helpers/tmp.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const rec = { idd_id: 'IDD-1', area: 'me/app', title: 'T', context: '', gh_issue_url: 'https://github.com/me/app/issues/1' };

function setup(area = {}) {
  const root = tmpDir('idd-context-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main', ...area } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  const wt = join(root, 'wt'); mkdirSync(wt, { recursive: true });
  return { root, state, wt };
}

/** the document as the planner writes it, in the fixture worktree */
function putContextDoc(wt, text = '# 事実\n\n- 計画役が知った事実\n') {
  const rel = laneContextPath(rec);
  const dir = join(wt, '_docs/context/app/idd-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'context.md'), text);
  return rel;
}

test('AC-001: the planner is asked for the context document, and the plan keeps only its place', () => {
  const { wt } = setup({ work_instruction: 'plan' });
  const brief = plannerBrief(rec, undefined, wt);
  assert.match(brief, /<context path="_docs\/context\/app\/idd-1\/context\.md" template="[^"]*templates\/context\.md"\/>/);
  assert.match(brief, /<plan path="_docs\/plan\/app\/idd-1\/plan\.md"/);
  assert.ok(brief.includes(CONTEXT_DOC_RULE), 'the planner is told what the document holds');
  assert.ok(brief.includes(WORK_INSTRUCTION_RULE), 'the plan section points at the document');
  // the rule itself sends the facts to the document; no clause asks for them in the section
  assert.doesNotMatch(WORK_INSTRUCTION_RULE, /重要なコンテクストに書く/);
  assert.match(WORK_INSTRUCTION_RULE, /コンテクストの文書に書く/);
  // the section's place and the document's place are the same, and the facts go in one of them
  const standard = readFileSync(join(ROOT, '_docs/standards/brief.md'), 'utf8');
  assert.match(standard, /欄は lane のコンテクスト文書（`_docs\/context\/<Area>\/<slug>\/context\.md`）の所在だけを指す/);
  assert.match(standard, /実装役は、実装中に知った同じ 3 条件の事実を、session の終わりにその文書へ追記して commit する/);
  const template = readFileSync(join(ROOT, '_docs/standards/templates/plan.md'), 'utf8');
  assert.match(template, /重要なコンテクストの文書: `_docs\/context\/<Area>\/<slug>\/context\.md`/);
  // a repo that asks for no plan is asked for neither the document nor its rule
  const { wt: plain } = setup();
  const without = plannerBrief(rec, undefined, plain);
  assert.doesNotMatch(without, /<context path=/);
  assert.ok(!without.includes(CONTEXT_DOC_RULE));
});

test('AC-005: the context document is a lane record, so the harness commits it and the published side leaves it out', () => {
  const { wt } = setup();
  const rel = laneContextPath(rec);
  assert.equal(rel, '_docs/context/app/idd-1/context.md');
  // a lane whose planner wrote no document names no record directory for it
  assert.deepEqual(laneRecordDirs(rec, wt), []);
  putContextDoc(wt);
  assert.deepEqual(laneRecordDirs(rec, wt), ['_docs/context/app/idd-1']);
  const manifest = readFileSync(join(ROOT, 'overlay.manifest'), 'utf8');
  assert.match(manifest, /^_docs\/context\/$/m);
  // the contract says the document is not moved with the plan
  const contracts = readFileSync(join(ROOT, '_docs/standards/document_contracts.md'), 'utf8');
  assert.match(contracts, /_docs\/context\/<Area>\/<slug>\/context\.md/);
  assert.match(contracts, /plan\.md を archive へ移した後も worktree に残る/);
});

test('AC-006: what an executor appends is the file the next brief and the fix plan name', () => {
  const { wt } = setup();
  const rel = putContextDoc(wt);
  // the first session is told to append to the contract's document
  const first = executorBrief(rec, wt);
  assert.match(first, /<lane-context>_docs\/context\/app\/idd-1\/context\.md<\/lane-context>/);
  assert.ok(first.includes(esc(EXECUTOR_CONTEXT_RULE)));
  // a later session appends instead of rewriting, as the rule says
  appendFileSync(join(wt, rel), '\n## 実装中に足した事実\n\n- 実装役が知った事実\n');
  const fix = fixBrief(rec, wt, buildEnvelope('review_fix', 'IDD-1', '  <task>直す</task>'));
  for (const [name, brief] of [['first', executorBrief(rec, wt)], ['fix', fix]]) {
    assert.match(brief, /<lane-context>_docs\/context\/app\/idd-1\/context\.md<\/lane-context>/, `${name}: the same document`);
    assert.ok(brief.includes(esc(EXECUTOR_CONTEXT_RULE)), `${name}: the append rule`);
  }
  const text = readFileSync(join(wt, rel), 'utf8');
  assert.match(text, /計画役が知った事実/, 'the first round keeps its facts');
  assert.match(text, /実装役が知った事実/, 'the appended fact is there');
});

test('a lane planned before the document existed keeps its brief as it was', () => {
  const { wt } = setup();
  for (const brief of [executorBrief(rec, wt), fixBrief(rec, wt, buildEnvelope('review_fix', 'IDD-1', '  <task>直す</task>'))]) {
    assert.doesNotMatch(brief, /<lane-context>/);
    assert.ok(!brief.includes(esc(EXECUTOR_CONTEXT_RULE)));
  }
});
