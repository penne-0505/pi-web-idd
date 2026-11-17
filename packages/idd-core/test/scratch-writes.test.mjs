import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The entry removes exactly one place under `_meta/scratch`, so a test that builds a work place there by hand
// writes where the entry's cleanup never looks, and the disk fills again. Every test-side file must make its
// places through `helpers/scratch.mjs`; this test fails the group when a hand-built path is left behind, so the
// mistake stops before it lands instead of being noticed in review.
//
// The check reads the text of the files the three groups run, plus the fixtures and helpers they read. A path
// that is only checked as data (a regex on `.git/info/exclude`, a sample the review-scope walker classifies) is
// not a place, and a file that only holds such text is excluded below with its reason.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MARK = ['_meta', 'scratch'].join('/');

// the calls that compose a path; a bare string that merely names the scratch root is data, not a place
const WRITE_CALLS = ['mkdtempSync', 'mkdirSync', 'resolve', 'join', 'realpathSync'];
const WRITE_RE = new RegExp(`\\b(?:${WRITE_CALLS.join('|')})\\s*\\([^;]{0,300}?${MARK.replace('/', '\\/')}`);

/** true when the text composes a path under the scratch root instead of going through the helper */
export function scratchPathViolations(text) {
  return WRITE_RE.test(text);
}

// the directories the three groups take their files from; the file names are filtered below
const TARGET_ROOTS = [
  'app',
  'components',
  'hooks',
  'lib',
  'public',
  'packages/idd-engine/src',
  'packages/idd-lane/test',
  'packages/idd-cli/test',
  'packages/idd-engine/test',
  'packages/idd-core/test',
  'packages/idd-gui/test',
];

const EXCLUDED = new Map([
  ['packages/idd-core/test/helpers/scratch.mjs', '専用の場所を組み立てる唯一のファイル'],
  ['packages/idd-core/test/scratch-writes.test.mjs', '違反の見本の文をこのファイル自身が持つ'],
  ['packages/idd-core/test/review-loop-scope.test.mjs', 'scratch の下のパスを分類の見本として持つだけで、作業場所を作らない'],
  ['packages/idd-core/test/init.test.mjs', '.git/info/exclude の行を正規表現で確かめるだけで、作業場所を作らない'],
  ['packages/idd-core/test/repo-migrate.test.mjs', '.git/info/exclude の行を正規表現で確かめるだけで、作業場所を作らない'],
]);

function isTarget(rel) {
  if (rel.startsWith('packages/idd-core/test/')) return rel.endsWith('.mjs');
  // `packages/idd-gui/test/compare.mjs` is a hand-run tool outside every group; only its test files are scanned
  return rel.endsWith('.test.mjs') || rel.endsWith('.test.ts');
}

function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path, out);
    else if (entry.isFile()) out.push(relative(ROOT, path));
  }
}

function targetFiles() {
  const out = [];
  for (const root of TARGET_ROOTS) collect(join(ROOT, root), out);
  return out.filter(isTarget).sort();
}

// the samples are built at run time so this file does not carry the violation it looks for
const VIOLATION = ['const dir = ', 'resolve', "('", MARK, "/x');"].join('');
const HELPER_USE = ["import { scratchDir } from './helpers/scratch.mjs';", "const dir = scratchDir('x-');"].join('\n');
const DATA_ONLY = ['const samples = [', "'", MARK, "/x.ts', 'README.md'];"].join('');

test('a hand-built scratch path is a violation and the helper or data is not', () => {
  assert.equal(scratchPathViolations(VIOLATION), true);
  assert.equal(scratchPathViolations(HELPER_USE), false);
  assert.equal(scratchPathViolations(DATA_ONLY), false);
});

test('every test-side file makes its places through the helper', () => {
  const violations = [];
  for (const rel of targetFiles()) {
    if (EXCLUDED.has(rel)) continue;
    if (scratchPathViolations(readFileSync(join(ROOT, rel), 'utf8'))) violations.push(rel);
  }
  assert.deepEqual(violations, []);
});

test('every excluded file carries its reason', () => {
  for (const [file, reason] of EXCLUDED) assert.ok(reason.trim().length > 0, `${file} needs a reason`);
});
