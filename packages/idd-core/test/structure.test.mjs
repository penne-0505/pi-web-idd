import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scratchDir } from './helpers/scratch.mjs';
import { parseStructure } from '../src/config/structure.ts';
import { layerOf, listFiles, mbtLooseness, resolveImport, scanTree, scanTreeDetailed } from '../src/metrics/structure.ts';

const SCAN = fileURLToPath(new URL('../src/metrics/structure-scan.ts', import.meta.url));

const RULES = [
  'command: [node, scan.ts]',
  'blocking: [duplicate-tokens, layer-violations]',
  'window: 20',
  'large_file_lines: 5',
  'complexity_limit: 2',
  'layers: { core: [packages/core/], ui: [packages/ui/], app: [app/] }',
  'allow: { ui: [core], app: [ui, core] }',
  'aliases: { "@/": "", "@core": packages/core/src/index.ts }',
].join('\n');
const decl = parseStructure(RULES);

/** a scratch dir holding a tree of files (path -> text) */
function planted(files) {
  const root = scratchDir('structure-');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const scan = (files) => scanTree(planted(files), decl);
const dups = (files) => scan(files)['duplicate-tokens'];
const violations = (files) => scan(files)['layer-violations'];

/** a function of about thirty tokens; the names differ between copies, the shape does not */
const clip = (name, arg) => `export function ${name}(${arg}: string): string {\n  const parts = ${arg}.split("/").filter(Boolean);\n  if (parts.length > 1) { return parts.join("-"); }\n  return parts[0] ?? "none";\n}\n`;
const FIRST = { 'packages/core/a.ts': clip('first', 'x') };

test('AC-006: the same tree gives the same counts twice, whatever order it was written in', () => {
  const pair = { 'packages/core/a.ts': clip('first', 'x'), 'packages/ui/b.ts': clip('second', 'y') };
  const reversed = Object.fromEntries(Object.entries(pair).reverse());
  assert.deepEqual(scan(pair), scan(pair));
  assert.deepEqual(scan(pair), scan(reversed));
});

test('AC-002: a copy under other names is a duplicate, unlike code and a block of imports are not, and layout does not hide a copy', () => {
  const table = 'export const table = { a: 1, b: [2, 3], c: () => 4 };\nexport class Box { constructor(public n: number) {} get twice() { return this.n * 2; } }\n';
  const imports = (names) => `import { ${names} } from "./x.ts";\nimport type { ${names} } from "./y.ts";\nexport { ${names} } from "./z.ts";\n`;
  const spread = clip('first', 'x').replace(/\n {2}/g, '\n\n      ').replace('{ return', '{\n return');
  assert.deepEqual(
    [dups(FIRST), dups({ ...FIRST, 'packages/core/b.ts': clip('renamed', 'other') }) > 0, dups({ ...FIRST, 'packages/core/b.ts': table }), dups({ 'packages/core/a.ts': imports('a, b, c, d, e, f, g, h'), 'packages/core/b.ts': imports('p, q, r, s, t, u, v, w') }), dups({ ...FIRST, 'packages/core/b.ts': spread }) > 0],
    [0, true, 0, 0, true],
  );
});

test('AC-002: a copy that differs only in true, false and null is a duplicate', () => {
  // a flag sits in every few tokens, so a window that does not hold one does not exist: only the collapse can make the two files match
  const flags = (a, b, c) => `export const pick = [${a}, ${b}, ${c}, ${a}];\nexport function on(list: string[]): unknown {\n  const out = { name: list[0], none: ${c}, on: ${a} };\n  if (list.length > 1) { return [${b}, ${a}]; }\n  while (out.name) { out.name = ${c}; }\n  return list.map((item) => item === ${a} ? ${b} : ${c});\n}\nexport const end = ${b};\n`;
  const one = flags('true', 'false', 'null');
  const same = dups({ 'packages/core/a.ts': one, 'packages/core/b.ts': one });
  // the same shape with other values in every place the keywords stand: the keywords are literals too, so it counts as many
  assert.deepEqual(
    [dups({ 'packages/core/a.ts': one }), dups({ 'packages/core/a.ts': one, 'packages/core/b.ts': flags('false', 'null', 'true') }), dups({ 'packages/core/a.ts': one, 'packages/core/b.ts': flags('1', '"x"', '2') })],
    [0, same, same],
  );
});

test('AC-006: a symbolic link is neither followed nor counted, so a link cannot move a number or fail the scan', () => {
  const outside = scratchDir('structure-outside-');
  writeFileSync(join(outside, 'o.ts'), clip('far', 'z'));
  const tree = { ...FIRST, 'packages/core/b.ts': 'export const b = 1;\n' };
  const bare = scan(tree);
  const root = planted(tree);
  const links = { 'packages/outside': outside, 'packages/alias': 'packages/core', 'packages/core/c.ts': 'packages/core/a.ts', 'packages/broken': 'packages/missing', 'packages/loop': 'packages/loop' };
  for (const [at, to] of Object.entries(links)) symlinkSync(isAbsolute(to) ? to : join(root, to), join(root, at));
  assert.deepEqual(scanTree(root, decl), bare);
});

const BASE = { 'packages/core/index.ts': 'export const c = 1;\n', 'packages/core/src/index.ts': 'export const c = 1;\n', 'packages/ui/u.ts': 'import { c } from "../core/index.ts";\nexport const u = c;\n', 'app/a.ts': 'import { u } from "../packages/ui/u.ts";\nexport const a = u;\n' };
const IMPORTS = [
  ['the allowed directions alone', {}, 0],
  ['core importing ui', { 'packages/core/bad.ts': 'import { u } from "../ui/u.ts";\nexport const b = u;\n' }, 1],
  ['an alias, a dynamic import and a path into app', { 'packages/core/bad.ts': 'import { a } from "@/app/a.ts";\nexport { a };\nexport const lazy = () => import("../../app/a.ts");\n' }, 2],
  ['an alias into an allowed layer', { 'packages/ui/ok.ts': 'import { c } from "@core";\nexport { c };\n' }, 0],
  ['a directory import into a forbidden layer and into an allowed one', { 'packages/core/bad.ts': 'import { u } from "../ui";\nexport const b = u;\n', 'packages/ui/ok.ts': 'import { c } from "../core";\nexport { c };\n' }, 1],
];
for (const [title, extra, expected] of IMPORTS) {
  test(`AC-002: ${title} count ${expected} layer violations`, () => {
    assert.equal(violations({ ...BASE, ...extra }), expected);
  });
}

test('AC-006: scratch and dependencies are skipped by where they stand, a source under a folder of the same name is listed', () => {
  const manifest = { 'package.json': '{}', 'packages/core/package.json': '{"name":"core"}', 'packages/ui/moon.mod': '' };
  const names = ['state', '_meta', 'node_modules', 'dist', '_build'];
  const files = Object.fromEntries(['', 'app/x/[id]/', 'packages/core/', 'packages/core/lib/', 'packages/ui/'].flatMap((at) => names.map((n) => [`${at}${n}/f.ts`, '']))
    .concat(Object.entries(manifest)));
  assert.deepEqual(
    listFiles(planted(files)).filter((f) => f.endsWith('.ts')),
    [
      'app/x/[id]/_build/f.ts', 'app/x/[id]/_meta/f.ts', 'app/x/[id]/dist/f.ts', 'app/x/[id]/state/f.ts',
      'packages/core/_meta/f.ts', 'packages/core/lib/_build/f.ts', 'packages/core/lib/_meta/f.ts', 'packages/core/lib/dist/f.ts', 'packages/core/lib/state/f.ts', 'packages/core/state/f.ts',
      'packages/ui/_meta/f.ts', 'packages/ui/state/f.ts',
    ],
  );
});

test('AC-002: a workspace package imported by its name or by a path under it counts as an import into its layer', () => {
  const pkg = (dir, name, main) => ({ [`packages/${dir}/package.json`]: JSON.stringify({ name, ...(main ? { main } : {}) }) });
  const tree = { ...pkg('core', '@w/core', 'src/index.ts'), ...pkg('ui', '@w/ui'), 'package.json': '{"name":"@w/root"}', 'packages/ui/u.ts': 'export const u = 1;\n' };
  const from = (specifier) => violations({ ...tree, 'packages/core/x.ts': `import { u } from "${specifier}";\nexport { u };\n` });
  assert.deepEqual(['@w/ui', '@w/ui/deep/u.ts', '@w/core', '@w/core/a.ts', '@w/root', 'react'].map(from), [1, 1, 0, 0, 0, 0]);
  assert.equal(violations({ ...tree, 'packages/ui/y.ts': 'import { c } from "@w/core/a.ts";\nexport { c };\n' }), 0);
});

test('AC-003: the counts that are only recorded are counted by the declaration', () => {
  const counts = scan({
    'packages/core/long.ts': `${Array.from({ length: 8 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`,
    'packages/core/branchy.ts': 'export function f(a: number) {\n  if (a > 1) { return 1; }\n  if (a > 2) { return 2; }\n  return a > 3 ? 3 : 4;\n}\n',
    'packages/core/x-reference.ts': 'export const r = 1;\nexport const s = 2;\n',
    'packages/core/loose.ts': 'export const v: any = 1;\n',
    'packages/core/fold.mbt': 'pub fn read(v : Json) -> Int {\n  match v {\n    Json::Null => 0\n    _ => 1\n  }\n}\n',
    'packages/core/fold_wbtest.mbt': 'fn t(v : Json) -> Int {\n  match v {\n    _ => 1\n  }\n}\n',
  });
  const recorded = Object.fromEntries(Object.entries(counts).filter(([name]) => !decl.blocking.includes(name)));
  assert.deepEqual(recorded, { 'large-files': 2, 'complex-functions': 1, 'any-types': 1, 'mbt-json-functions': 1, 'mbt-wildcard-arms': 1, 'ts-reference-lines': 2 });
});

test('a MoonBit function is a Json function when its arguments or its result carry Json', () => {
  const source = 'fn a(x : Int) -> Json { x }\npub fn b(facts : Json, n : Int) -> Int { n }\nfn c(x : Array[Json]) -> Unit { }\nfn d(x : Int) -> Int { x } // Json in a comment\n';
  assert.equal(mbtLooseness(source).jsonFunctions, 3);
});

test('imports resolve against the file, the aliases and the layer prefixes', () => {
  const aliases = { '@core': 'packages/core/src/index.ts', '@/': '' };
  assert.deepEqual(
    [resolveImport('packages/ui/deep/a.ts', '../../core/x.ts', {}), resolveImport('app/a.ts', '@/lib/x', aliases), resolveImport('app/a.ts', '@core', aliases), resolveImport('app/a.ts', 'react', aliases)],
    ['packages/core/x.ts', 'lib/x', 'packages/core/src/index.ts', null],
  );
  assert.deepEqual([layerOf('packages/core/src/a.ts', { core: ['packages/core/'], src: ['packages/core/src/'] }), layerOf('packages/corex/a.ts', { core: ['packages/core'] })], ['src', null]);
});

test('AC-003: the duplicate windows are listed per file, and the entries sum to duplicate-tokens', () => {
  const tree = planted({ ...FIRST, 'packages/core/b.ts': clip('renamed', 'other'), 'packages/core/c.ts': 'export const lone = { a: 1 };\n' });
  const { counts, duplicateFiles } = scanTreeDetailed(tree, decl);
  // a copy raises the file it was copied from as well, and a file with no shared window is not listed
  assert.deepEqual(duplicateFiles.map((f) => f.path), ['packages/core/a.ts', 'packages/core/b.ts']);
  assert.equal(duplicateFiles.reduce((sum, f) => sum + f.positions, 0), counts['duplicate-tokens']);
  assert.ok(counts['duplicate-tokens'] > 0);
  assert.deepEqual(scanTree(tree, decl), counts);
});

test('AC-003: the scan command prints the per-file lines only on request, and the counts stay the last line either way', () => {
  const tree = planted({ ...FIRST, 'packages/core/b.ts': clip('renamed', 'other') });
  const declFile = join(scratchDir('structure-decl-'), 'structure.yaml');
  writeFileSync(declFile, RULES);
  const run = (extra) => execFileSync(process.execPath, ['--experimental-strip-types', SCAN], { env: { ...process.env, IDD_STRUCTURE_ROOT: tree, IDD_STRUCTURE_DECL: declFile, ...extra }, encoding: 'utf8' });
  const plain = run({ IDD_STRUCTURE_FILES: '' }).trim().split('\n');
  const listed = run({ IDD_STRUCTURE_FILES: '1' }).trim().split('\n');
  assert.equal(plain.length, 1, 'a landing reads one line and gets one line');
  assert.equal(listed.at(-1), plain[0], 'the counts are the same last line');
  const rows = listed.slice(0, -1).map((l) => l.split('\t'));
  assert.deepEqual(rows.map((r) => r[1]).sort(), ['packages/core/a.ts', 'packages/core/b.ts']);
  assert.equal(rows.reduce((sum, r) => sum + Number(r[0]), 0), JSON.parse(plain[0])['duplicate-tokens']);
});

const BAD_DECLARATIONS = {
  'blocking: [a]\n': /command/,
  'command: [x]\n': /blocking/,
  'command: [x]\nblocking: [a]\nlayers: {a: [p/]}\nallow: {a: [b]}\n': /宣言されていない層/,
  'command: [x]\nblocking: [a]\nwindow: 0\n': /window/,
  'command: [x]\nblocking: [a]\nextra: 1\n': /知らない欄/,
  'command: [x\n': /YAML/,
};
for (const [text, reason] of Object.entries(BAD_DECLARATIONS)) {
  test(`AC-004: ${JSON.stringify(text)} is an error, not a default`, () => {
    assert.throws(() => parseStructure(text), reason);
  });
}
