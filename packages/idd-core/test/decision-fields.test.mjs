import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDecisionFields } from '../src/intent/decisions.ts';

const doc = (body) => `---\ntitle: 見本\n---\n\n# 見本\n\n## Decisions\n\n${body}\n\n## Intent-derived Invariants\n\n- INV-9-1 (from DEC-9-1): 順は engine が返したまま。\n- INV-9-2 (from DEC-9-1): 人の番の行には印が出る。\n- INV-9-3 (from DEC-9-2): 見込みの無い lane に朱は出ない。\n`;

test('AC-012: the five fields are read apart, with the whole Why and the dropped forms', () => {
  const [dec] = parseDecisionFields(doc([
    '### DEC-9-1: 五つの欄',
    '',
    '- **What**: 本文は欄にしない',
    '- **Anchors**: `packages/idd-gui/src/App.tsx`',
    '- **Why**: 一つ目の文。',
    '  続きの文。',
    '- **Why not**（捨てた形）: 却下した理由',
    '- **Why not**（もう一つの形）: もう一つの理由',
    '- **Anchored**: `INV-9-1`',
    '- **Free**: 欄の順は自由',
    '',
    '### DEC-9-2: 欄が無い',
    '',
    '- **Why not**: 形の無い理由',
  ].join('\n')));
  assert.equal(dec.id, 'DEC-9-1');
  assert.equal(dec.title, '五つの欄');
  assert.equal(dec.place, '`packages/idd-gui/src/App.tsx`');
  assert.equal(dec.why, '一つ目の文。\n  続きの文。');
  assert.deepEqual(dec.whyNot, [{ form: '捨てた形', reason: '却下した理由' }, { form: 'もう一つの形', reason: 'もう一つの理由' }]);
  assert.deepEqual(dec.anchored, [
    { id: 'INV-9-1', text: '順は engine が返したまま。' },
    { id: 'INV-9-2', text: '人の番の行には印が出る。' },
  ]);
  assert.equal(dec.free, '欄の順は自由');
  assert.equal(dec.hasPlace, true);
  assert.equal(dec.place.length > 0, true);
});

test('AC-012: a DEC without a field leaves it out, and What is never a field of its own', () => {
  const [, second] = parseDecisionFields(doc('### DEC-9-1: 一つ目\n\n- **Anchors**: `a.ts`\n\n### DEC-9-2: 二つ目\n\n- **Why not**: 理由だけ\n'));
  assert.equal(second.hasPlace, false);
  assert.equal(second.place, '');
  assert.equal(second.why, '');
  assert.equal(second.free, '');
  assert.deepEqual(second.anchored, [{ id: 'INV-9-3', text: '見込みの無い lane に朱は出ない。' }]);
  assert.deepEqual(second.whyNot, [{ form: '', reason: '理由だけ' }]);
  assert.equal(Object.hasOwn(second, 'what'), false);
});

test('the Why not form reads the full-width and the bare parenthesis alike', () => {
  const [dec] = parseDecisionFields(doc('### DEC-9-1: 形\n\n- **Why not**（全角）: 理由1\n- **Why not**(半角): 理由2\n- **Why not**: 形なし\n'));
  assert.deepEqual(dec.whyNot.map((w) => w.form), ['全角', '半角', '']);
});

test('the document order is the order of the DECs', () => {
  const fields = parseDecisionFields(doc('### DEC-9-2: 二番目\n\n- **Why**: b\n\n### DEC-9-1: 一番目\n\n- **Why**: a\n'));
  assert.deepEqual(fields.map((f) => f.id), ['DEC-9-2', 'DEC-9-1']);
});

test('a document with no decisions reads none', () => {
  assert.deepEqual(parseDecisionFields('# T\n\n## Context\n\n- 背景\n'), []);
});

test('an INV line the reader cannot tie to a DEC is left out', () => {
  const fields = parseDecisionFields('# T\n\n## Decisions\n\n### DEC-1: t\n\n- **Why**: w\n\n## Intent-derived Invariants\n\n- INV-1 (from DEC-1): 守る。\n- INV-2: from の欄が無い。\n');
  assert.deepEqual(fields[0].anchored, [{ id: 'INV-1', text: '守る。' }]);
});
