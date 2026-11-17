import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseIntent } from '../src/intent/parse.ts';
import { decisionIndex, decisionIndexLine, decisionRecord, decisionRecords, parseDecisionDoc, renderDecisionIndex } from '../src/intent/decisions.ts';

// the reader looks under IDD_INTENT_DIR/<area segment>/<slug>/decision.md
function setup(src) {
  const root = mkdtempSync(join(tmpdir(), 'idd-intent-decisions-'));
  mkdirSync(join(root, 'demo', 'idd-001'), { recursive: true });
  writeFileSync(join(root, 'demo', 'idd-001', 'decision.md'), src);
  process.env.IDD_INTENT_DIR = root;
  return root;
}

const read = (src) => {
  setup(src);
  return parseIntent('demo', 'idd-001').decisions;
};

test('AC-001: each decision comes back with its title, Why and Source', () => {
  const decisions = read([
    '# T',
    '',
    '## Decisions',
    '',
    '### DEC-1: 一つ目',
    '',
    '- **What**: 方針',
    '- **Why**: 一行目の理由',
    '  続きの行はそのまま',
    '- **Source**: 質問 Q-1',
    '- **Change freedom**: 自由',
    '',
  ].join('\n'));
  assert.deepEqual(decisions, [{ id: 'DEC-1', text: '一つ目', why: '一行目の理由\n  続きの行はそのまま', source: '質問 Q-1' }]);
});

test('AC-002: nothing is trimmed or summarised, and a missing Source is empty', () => {
  const decisions = read([
    '## Decisions',
    '',
    '### DEC-1: 整形しない',
    '',
    '- **What**: 方針',
    '- **Why**: `code` と **強調** を含む理由',
    '- **Why not**（採用しなかった案）: これは Why に取り込まない',
    '- **Change freedom**: 自由',
    '',
    '### DEC-2: 欄が無い',
    '',
    '- **What**: 方針',
    '- **Change freedom**: 自由',
    '',
  ].join('\n'));
  assert.deepEqual(decisions[0].why, '`code` と **強調** を含む理由');
  assert.equal(decisions[0].source, '');
  assert.equal(decisions[1].why, '');
  assert.equal(decisions[1].source, '');
});

test('AC-002: a Why before Change freedom / Revisit when / Source ends at that field', () => {
  const decisions = read([
    '## Decisions',
    '',
    '### DEC-1: 続き',
    '',
    '- **Why**: 理由の本体',
    '  続きの段落',
    '- **Change freedom**: これも Why では無い',
    '',
    '### DEC-2: 出所',
    '',
    '- **Why**: 本体',
    '- **Source**: 出所',
    '- **Revisit when**: これも',
    '',
  ].join('\n'));
  assert.equal(decisions[0].why, '理由の本体\n  続きの段落');
  assert.equal(decisions[1].why, '本体');
  assert.equal(decisions[1].source, '出所');
});

test('AC-001: the older `## DEC-… —` heading form carries Why and Source too', () => {
  const decisions = read([
    '# T',
    '',
    '## DEC-9 — 古い形',
    '',
    '- **Why**: 古い形の理由',
    '- **Source**: AC-001',
    '',
    '## Consequences / Impact',
    '',
    '- 影響',
    '',
  ].join('\n'));
  assert.deepEqual(decisions, [{ id: 'DEC-9', text: '古い形', why: '古い形の理由', source: 'AC-001' }]);
});

test('AC-002: a decision.md without decisions, and a lane without one, come back empty', () => {
  setup('# T\n\n## Context\n\n- 背景\n');
  assert.deepEqual(parseIntent('demo', 'idd-001').decisions, []);
  process.env.IDD_INTENT_DIR = join(tmpdir(), 'idd-intent-missing-dir');
  assert.deepEqual(parseIntent('demo', 'idd-001').decisions, []);
});

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };

/** a record root with decision documents written under `_docs/intent/<area>/<lane>/decision.md` */
function recordRoot(docs) {
  const root = temp('idd-dec-');
  for (const [rel, text] of Object.entries(docs)) {
    const p = join(root, '_docs/intent', rel, 'decision.md');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

const doc = (title, body) => `---\ntitle: ${title}\n---\n\n# ${title}\n\n## Decisions\n\n${body}\n`;

test('a path resolves to the DECs whose Anchors hold it, with number, title, document and file', () => {
  const root = recordRoot({
    'app/one': doc('one', '### DEC-101: 保存の前に確認を挟む\n\n- **What**: a\n- **Why**: b\n- **Anchors**: `src/save.ts`\n'),
    'app/two': doc('two', '### DEC-102: 表示の値を丸める\n\n- **What**: a\n- **Why**: b\n- **Anchors**: `src/view.ts`\n'),
  });
  const hit = decisionIndex({ source: { root }, root, paths: ['src/save.ts'] });
  assert.equal(hit.count, 1);
  assert.deepEqual(hit.candidates.map((c) => c.id), ['DEC-101']);
  assert.equal(hit.candidates[0].title, '保存の前に確認を挟む');
  assert.equal(hit.candidates[0].doc, '_docs/intent/app/one/decision.md');
  assert.deepEqual(hit.candidates[0].files, ['src/save.ts']);
  // a path no Anchors names answers empty
  assert.deepEqual(decisionIndex({ source: { root }, root, paths: ['src/none.ts'] }), { count: 0, dropped: 0, candidates: [] });
});

test('the Anchors of a DEC are read in every form the repo writes them', () => {
  const body = [
    '### DEC-201: 書き方 1',
    '',
    '- **Anchors**: `src/a.ts`, `src/b.ts`',
    '',
    '### DEC-202: 書き方 2',
    '',
    '- **Anchors**:',
    '  - `src/c.ts`',
    '  - `src/d.ts#runTick`',
    '',
    '### DEC-203: 書き方 3',
    '',
    '- **Anchors**: `src/e.ts:10`, `src/f.ts`（`symbol`）, `src/dir/`',
    '',
    '### DEC-204: 書き方 4',
    '',
    '- **Anchors**: `packages/x/**/*.ts`, `app/api/x/[id]/route.ts`',
    '',
    '### DEC-205: 見出しの形',
    '',
    '- **Anchors**: `src/g.ts`',
    '',
    '## DEC-206 — 二番目の見出し',
    '',
    '- **Anchors**: `src/h.ts`',
  ].join('\n');
  const root = recordRoot({ 'app/forms': doc('forms', body) });
  const idsFor = (p) => decisionIndex({ source: { root }, root, paths: [p] }).candidates.map((c) => c.id);
  assert.deepEqual(idsFor('src/a.ts'), ['DEC-201']);
  assert.deepEqual(idsFor('src/b.ts'), ['DEC-201']);
  assert.deepEqual(idsFor('src/c.ts'), ['DEC-202']);
  assert.deepEqual(idsFor('src/d.ts'), ['DEC-202']);
  assert.deepEqual(idsFor('src/e.ts'), ['DEC-203']);
  assert.deepEqual(idsFor('src/f.ts'), ['DEC-203']);
  assert.deepEqual(idsFor('src/dir/inner.ts'), ['DEC-203']);
  assert.deepEqual(idsFor('packages/x/y/z.ts'), ['DEC-204']);
  assert.deepEqual(idsFor('app/api/x/[id]/route.ts'), ['DEC-204']);
  assert.deepEqual(idsFor('src/g.ts'), ['DEC-205']);
  assert.deepEqual(idsFor('src/h.ts'), ['DEC-206']);
});

test('no cap on the candidates: 150 DECs anchored to one file all come back', () => {
  const entries = Array.from({ length: 150 }, (_, i) => `### DEC-${1000 + i}: 判断 ${i}\n\n- **Anchors**: \`src/many.ts\`\n`).join('\n');
  const root = recordRoot({ 'app/many': doc('many', entries) });
  const res = decisionIndex({ source: { root }, root, paths: ['src/many.ts'] });
  assert.equal(res.count, 150);
  assert.equal(new Set(res.candidates.map((c) => c.id)).size, 150);
});

test('excluded documents and ids are dropped, so a planner does not meet its own lane', () => {
  const root = recordRoot({
    'app/mine': doc('mine', '### DEC-301: 自分の判断\n\n- **Anchors**: `src/shared.ts`\n'),
    'app/other': doc('other', '### DEC-302: 他の判断\n\n- **Anchors**: `src/shared.ts`\n'),
  });
  const res = decisionIndex({ source: { root }, root, paths: ['src/shared.ts'], excludeDocs: ['_docs/intent/app/mine/decision.md'], excludeIds: ['DEC-302'] });
  assert.deepEqual(res.candidates, []);
  const kept = decisionIndex({ source: { root }, root, paths: ['src/shared.ts'], excludeDocs: ['_docs/intent/app/mine/decision.md'] });
  assert.deepEqual(kept.candidates.map((c) => c.id), ['DEC-302']);
});

test('a DEC number resolves to its title and document across areas and lanes', () => {
  const root = recordRoot({
    'app/one': doc('one', '### DEC-401: 別 area の判断\n\n- **Anchors**: `a.ts`\n'),
    'other/thing/two': doc('two', '### DEC-402: 別 lane の判断\n\n- **Anchors**: `b.ts`\n'),
  });
  assert.deepEqual(decisionRecord({ root }, 'DEC-402'), { id: 'DEC-402', title: '別 lane の判断', doc: '_docs/intent/other/thing/two/decision.md' });
  assert.equal(decisionRecord({ root }, 'DEC-999'), null);
  const many = decisionRecords({ root }, ['DEC-401', 'DEC-999', 'DEC-402']);
  assert.deepEqual([...many.keys()].sort(), ['DEC-401', 'DEC-402']);
  assert.equal(many.get('DEC-401').title, '別 area の判断');
});

test('a moved DEC still resolves by number and stays in the candidate index', () => {
  const root = temp('idd-dec-moved-');
  const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  put('_docs/intent/app/open/decision.md', doc('open', '### DEC-600: 開いている判断\n\n- **Anchors**: `src/now.ts`\n'));
  put('_docs/archives/intent/app/moved/decision.md', doc('moved', '### DEC-601: 移した判断\n\n- **Anchors**: `src/old.ts`\n'));

  assert.deepEqual(decisionRecord({ root }, 'DEC-601'), { id: 'DEC-601', title: '移した判断', doc: '_docs/archives/intent/app/moved/decision.md' });
  assert.deepEqual([...decisionRecords({ root }, ['DEC-600', 'DEC-601']).keys()].sort(), ['DEC-600', 'DEC-601']);
  // the candidate index reads the archive too: a binding DEC whose document moved is not lost
  const moved = decisionIndex({ source: { root }, root, paths: ['src/old.ts'] });
  assert.deepEqual(moved.candidates.map((c) => c.id), ['DEC-601']);
  assert.equal(moved.candidates[0].doc, '_docs/archives/intent/app/moved/decision.md');
  assert.deepEqual(decisionIndex({ source: { root }, root, paths: ['src/now.ts'] }).candidates.map((c) => c.id), ['DEC-600']);
});

test('records read from a git rev give the state at that rev, not the working tree', () => {
  const root = temp('idd-dec-git-');
  const git = (...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd: root, encoding: 'utf8' }).trim();
  const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  git('init', '-q');
  put('_docs/intent/app/one/decision.md', doc('one', '### DEC-501: base の判断\n\n- **Anchors**: `src/x.ts`\n'));
  put('_docs/archives/intent/app/moved/decision.md', doc('moved', '### DEC-503: 移した判断\n\n- **Anchors**: `src/y.ts`\n'));
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  put('_docs/intent/app/one/decision.md', doc('one', '### DEC-502: head で立てた判断\n\n- **Anchors**: `src/x.ts`\n'));
  git('add', '-A'); git('commit', '-q', '-m', 'head');
  const fromBase = decisionIndex({ source: { repo: root, ref: base }, root, paths: ['src/x.ts'] });
  assert.deepEqual(fromBase.candidates.map((c) => c.id), ['DEC-501']);
  // a rev is read for the archive too: R2's index is built from a base rev, not the working tree
  assert.deepEqual(decisionIndex({ source: { repo: root, ref: base }, root, paths: ['src/y.ts'] }).candidates.map((c) => c.id), ['DEC-503']);
  assert.equal(decisionRecord({ repo: root, ref: base }, 'DEC-502'), null);
});

test('unreadable records answer empty rather than throwing', () => {
  const root = temp('idd-dec-none-');
  assert.deepEqual(decisionIndex({ source: { root: join(root, 'missing') }, paths: ['a.ts'] }), { count: 0, dropped: 0, candidates: [] });
  assert.equal(decisionRecord({ root: join(root, 'missing') }, 'DEC-1'), null);
  const notRepo = temp('idd-dec-notrepo-');
  assert.deepEqual(decisionIndex({ source: { repo: notRepo, ref: 'HEAD' }, paths: ['a.ts'] }), { count: 0, dropped: 0, candidates: [] });
  assert.deepEqual(decisionIndex({ source: { repo: root, ref: 'no-such-rev' }, paths: ['a.ts'] }), { count: 0, dropped: 0, candidates: [] });
});

test('a Superseded by field drops the DEC from the candidates and is counted (AC-001)', () => {
  const body = [
    '### DEC-101: 有効な判断',
    '',
    '- **Anchors**: `src/save.ts`',
    '',
    '### DEC-102: 置き換えられた判断',
    '',
    '- **Anchors**: `src/save.ts`',
    '- **Superseded by**: DEC-103',
    '',
    '### DEC-103: 後継の判断',
    '',
    '- **Anchors**: `src/other.ts`',
    '',
    '## DEC-104 — 二番目の見出しの DEC',
    '',
    '- **Anchors**: `src/save.ts`',
    '- **Superseded by**: DEC-105、DEC-106',
  ].join('\n');
  const root = recordRoot({ 'app/one': doc('one', body) });
  const res = decisionIndex({ source: { root }, root, paths: ['src/save.ts'] });
  assert.deepEqual(res.candidates.map((c) => c.id), ['DEC-101']);
  assert.equal(res.dropped, 2, 'the ### and the ## DEC are both dropped');
});

test('a Superseded by field the reader cannot turn into a number leaves the DEC in the index (AC-002 / INV-2321)', () => {
  const body = [
    '### DEC-201: 空の欄',
    '',
    '- **Anchors**: `src/save.ts`',
    '- **Superseded by**:',
    '',
    '### DEC-202: なしと書いた欄',
    '',
    '- **Anchors**: `src/save.ts`',
    '- **Superseded by**: なし',
    '',
    '### DEC-203: 番号で始まらない欄',
    '',
    '- **Anchors**: `src/save.ts`',
    '- **Superseded by**: 後継は未定',
    '',
    '### DEC-204: 壊れた番号',
    '',
    '- **Anchors**: `src/save.ts`',
    '- **Superseded by**: DEC-, DEC-2',
  ].join('\n');
  const root = recordRoot({ 'app/two': doc('two', body) });
  const res = decisionIndex({ source: { root }, root, paths: ['src/save.ts'] });
  assert.deepEqual(res.candidates.map((c) => c.id), ['DEC-201', 'DEC-202', 'DEC-203', 'DEC-204']);
  assert.equal(res.dropped, 0);
});

test('a DEC number resolves even when the DEC was superseded (AC-003)', () => {
  const root = recordRoot({
    'app/one': doc('one', '### DEC-301: 置き換えられた判断\n\n- **Anchors**: `src/x.ts`\n- **Superseded by**: DEC-302\n'),
  });
  const rec = decisionRecord({ root }, 'DEC-301');
  assert.equal(rec.title, '置き換えられた判断');
  assert.equal(rec.doc, '_docs/intent/app/one/decision.md');
  const many = decisionRecords({ root }, ['DEC-301']);
  assert.equal(many.get('DEC-301').title, '置き換えられた判断');
});

test('the candidate carries the Why first sentence and the row prints it (AC-011)', () => {
  const root = recordRoot({ 'app/one': doc('one', '### DEC-401: 題\n\n- **Why**: 一つ目の文。二つ目の文。\n- **Anchors**: `src/x.ts`\n') });
  const [hit] = decisionIndex({ source: { root }, root, paths: ['src/x.ts'] }).candidates;
  assert.equal(hit.why, '一つ目の文。');
  const line = decisionIndexLine(hit);
  assert.match(line, /DEC-401 題 — 一つ目の文。/);
  assert.match(line, /_docs\/intent\/app\/one\/decision\.md（src\/x\.ts）/);
  assert.match(renderDecisionIndex(decisionIndex({ source: { root }, root, paths: ['src/x.ts'] })), /一つ目の文。/);
});

test('the index reads the three identifier forms and orders bare, lane, then area (AC-007)', () => {
  const root = recordRoot({
    'app/one': doc('one', [
      '### DEC-701: 番号だけの判断',
      '',
      '- **Anchors**: `src/x.ts`',
      '',
      '### DEC-088-1: lane の判断',
      '',
      '- **Anchors**: `src/x.ts`',
      '',
      '### DEC-IddCore-2: 手書きの判断',
      '',
      '- **Anchors**: `src/x.ts`',
    ].join('\n')),
  });
  const res = decisionIndex({ source: { root }, root, paths: ['src/x.ts'] });
  assert.deepEqual(res.candidates.map((c) => c.id), ['DEC-701', 'DEC-088-1', 'DEC-IddCore-2']);
  assert.deepEqual(res.candidates.map((c) => c.title), ['番号だけの判断', 'lane の判断', '手書きの判断']);
  assert.equal(decisionRecord({ root }, 'DEC-088-1').doc, '_docs/intent/app/one/decision.md');
});

test('a bare identifier never resolves to a longer lane identifier (AC-008 a)', () => {
  const root = recordRoot({ 'app/one': doc('one', '### DEC-077-3: lane の判断\n\n- **Anchors**: `src/x.ts`\n') });
  assert.equal(decisionRecord({ root }, 'DEC-077'), null);
  assert.equal(decisionRecord({ root }, 'DEC-077-3').title, 'lane の判断');
});

test('a heading separated by a hyphen still reads (DEC-9463)', () => {
  const root = recordRoot({ 'app/one': doc('one', '## DEC-12 - 区切りがハイフンの見出し\n\n- **Anchors**: `src/x.ts`\n') });
  assert.deepEqual(decisionIndex({ source: { root }, root, paths: ['src/x.ts'] }).candidates.map((c) => c.id), ['DEC-12']);
  assert.equal(decisionRecord({ root }, 'DEC-12').title, '区切りがハイフンの見出し');
});

test('the index and the validator read the same Anchors and Superseded by sample table (AC-014 / INV-2323)', () => {
  const table = JSON.parse(readFileSync(new URL('../../../_meta/validator-fixtures/intent/readings.json', import.meta.url), 'utf8'));
  const root = temp('idd-dec-table-');
  for (const row of table.anchors) if (row.rootFile) writeFileSync(join(root, row.rootFile), 'x\n');
  const wrap = (body) => `## Decisions\n\n### DEC-900: t\n${body}\n`;
  for (const row of [...table.anchors, ...table.superseded]) {
    const [dec] = parseDecisionDoc('_docs/intent/app/one/decision.md', wrap(row.body), root);
    const got = table.anchors.includes(row) ? dec.places : dec.supersededBy;
    assert.deepEqual(got, row.expect, row.body);
  }
});
