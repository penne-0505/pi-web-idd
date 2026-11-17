import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SHIPPED_REPOS, shippedSkip } from './helpers/shipped-repos.mjs';
import { harmExampleLines, parseHarmExamples, readHarmExamples, writeHarmExamplesFile } from '../src/config/harm-examples.ts';

const made = [];
const saved = process.env.IDD_REPOS_FILE;
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env.IDD_REPOS_FILE; else process.env.IDD_REPOS_FILE = saved;
});

function setup(repo) {
  const root = mkdtempSync(join(tmpdir(), 'idd-harm-'));
  made.push(root);
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), ...repo } } }));
  process.env.IDD_REPOS_FILE = join(root, 'repos.yaml');
  return root;
}

test('the declaration returns its examples and always_must; a repo with none returns an empty reading (AC-040)', () => {
  setup({ harm_examples: [{ harm: 3, example: 'engine が止まる' }, { harm: 1, example: '一覧の表示が崩れる' }], always_must: ['記録を信じて拡張すると誤る'] });
  const read = readHarmExamples('me/app');
  assert.equal(read.from, 'declaration');
  assert.deepEqual(read.examples, [{ harm: 3, example: 'engine が止まる' }, { harm: 1, example: '一覧の表示が崩れる' }]);
  assert.deepEqual(read.alwaysMust, ['記録を信じて拡張すると誤る']);
  assert.match(harmExampleLines('me/app').join('\n'), /害 3: engine が止まる/);
  assert.match(harmExampleLines('me/app').join('\n'), /頻度に関わらず must: 記録を信じて拡張すると誤る/);

  setup({});
  assert.deepEqual(readHarmExamples('me/app'), { examples: [], alwaysMust: [], from: 'none' });
  assert.deepEqual(harmExampleLines('me/app'), []);
  assert.equal(writeHarmExamplesFile('me/app', 'x'), undefined);
});

test('a grade outside 1〜3, a missing example, and a non-string always_must are config errors (AC-040)', () => {
  assert.throws(() => parseHarmExamples('repos.me/app', [{ harm: 4, example: 'x' }]), /harm: 1〜3/);
  assert.throws(() => parseHarmExamples('repos.me/app', [{ harm: 0, example: 'x' }]), /harm: 1〜3/);
  assert.throws(() => parseHarmExamples('repos.me/app', [{ harm: 2, example: '   ' }]), /example/);
  assert.throws(() => parseHarmExamples('repos.me/app', 'nope'), /一覧/);
  assert.throws(() => parseHarmExamples('repos.me/app', [{ harm: 2, example: 'x' }], [3]), /always_must/);
});

test('a declared repo writes a file the judgement reads (AC-040)', () => {
  setup({ harm_examples: [{ harm: 3, example: 'engine が止まる' }] });
  const file = writeHarmExamplesFile('me/app', 'IDD-1-1-judge');
  assert.ok(file, 'a file is written');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /engine が止まる/);
});

test('the propter declaration carries the examples the engine moved out of its text, graded by penne (AC-042)', { skip: shippedSkip }, () => {
  process.env.IDD_REPOS_FILE = SHIPPED_REPOS;
  const read = readHarmExamples('penne-0505/pi-web-idd');
  assert.ok(read.examples.length > 0);
  assert.ok(read.examples.every((e) => [1, 2, 3].includes(e.harm)));
  // 2026-10-25 penne: only what cannot be undone is grade 3; a stop the restart undoes is grade 2
  assert.ok(read.examples.some((e) => e.harm === 3 && /不可逆/.test(e.example)));
  assert.ok(read.examples.some((e) => e.harm === 2 && /engine や tick が止まる/.test(e.example)));
});
