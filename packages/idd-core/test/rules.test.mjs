import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { installSkills, readStandard, skillsHome, skillsPlaces, standardsPath } from '../src/rules/rules.ts';

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'idd-rules-'));
  temps.push(dir);
  return dir;
}

const SKILL_NAMES = ['propter-close', 'propter-docs-inventory', 'propter-docs-template-migration', 'propter-handoff', 'propter-intent-mining', 'propter-moonbit', 'propter-prep', 'propter-writing'];

function sourceSkills() {
  return join(standardsPath(), '..', '..', 'skills');
}

function assertReadableFromBoth(dir) {
  const { agents, claude } = skillsPlaces(dir);
  for (const name of SKILL_NAMES) {
    assert.equal(existsSync(join(agents, name, 'SKILL.md')), true, `${name} under .agents`);
    assert.equal(existsSync(join(claude, name, 'SKILL.md')), true, `${name} under .claude`);
  }
}

test('readStandard returns the body of a norm and refuses a name that is not there', () => {
  const found = readStandard('workflow');
  assert.ok(found);
  assert.equal(found.path, join(standardsPath(), 'workflow.md'));
  assert.match(found.body, /^# 変更のループ/);
  const records = readStandard('records');
  assert.ok(records);
  assert.match(records.body, /^# Intent Record の仕様/);
  assert.equal(readStandard('nope'), null);
  assert.equal(readStandard('../secrets'), null);
});

test('a plain home gets real copies under .agents and relative links under .claude', () => {
  const dir = home();
  const res = installSkills(dir);
  assert.equal(res.ok, true, res.error);
  assertReadableFromBoth(dir);
  const { agents, claude } = skillsPlaces(dir);
  for (const name of SKILL_NAMES) {
    const src = readFileSync(join(sourceSkills(), name, 'SKILL.md'), 'utf8');
    assert.equal(readFileSync(join(agents, name, 'SKILL.md'), 'utf8'), src);
    assert.equal(readlinkSync(join(claude, name)), `../../.agents/skills/${name}`);
  }
});

test('the moonbit skill names the 5 norms with their reasons, the verified toolchain and the pinned mizchi pointer', () => {
  const skill = readFileSync(join(sourceSkills(), 'propter-moonbit', 'SKILL.md'), 'utf8');
  // the 5 norms of #182, each with its own heading so a reader can find it
  for (const phrase of ['規範 1: `Any` と `%identity` は FFI の境界でだけ使う', '規範 2: `raise` を握りつぶさない', '規範 3: enum と網羅の `match` を使い、`_` で残りを受けない', '規範 4: inline snapshot test を書く', '規範 5: JS backend で bun の上に置き、`mizchi/js` の bind を使う']) {
    assert.ok(skill.includes(phrase), phrase);
  }
  // the verified toolchain and the 1.0 review, so a reader can tell whether the norm holds on their compiler
  assert.ok(skill.includes('moon 0.1.20260827'));
  assert.ok(skill.includes('moonc v0.10.11'));
  assert.ok(skill.includes('1.0'));
  // the mizchi skill is named by a pinned commit and a way to read it, never copied in
  assert.ok(skill.includes('mizchi/skills'));
  assert.ok(skill.includes('a41865b34b78f2675a6c73178377a5bcc1b492c6'));
  assert.ok(skill.includes('moonbit-practice'));
  assert.ok(skill.includes('gh api repos/mizchi/skills/contents/'));
  assert.ok(!skill.includes('moonbit-practice/SKILL.md\n\n---'), 'the external body is not copied');
});

const HANDOFF = 'propter-handoff';

test('the handoff skill lands with its bundled template and is readable from both places', () => {
  const dir = home();
  const res = installSkills(dir);
  assert.equal(res.ok, true, res.error);
  const { agents, claude } = skillsPlaces(dir);
  for (const base of [agents, claude]) {
    assert.equal(existsSync(join(base, HANDOFF, 'SKILL.md')), true, `${base}/SKILL.md`);
    assert.equal(existsSync(join(base, HANDOFF, 'template.md')), true, `${base}/template.md`);
  }
});

test('the bundled handoff template has a title form, body sections and AC-001 acceptance criteria', () => {
  const tpl = readFileSync(join(sourceSkills(), HANDOFF, 'template.md'), 'utf8');
  assert.match(tpl, /^## 題$/m);
  assert.match(tpl, /^## 目的$/m);
  assert.match(tpl, /^## 非ゴール$/m);
  assert.match(tpl, /^## 受け入れ条件$/m);
  assert.match(tpl, /AC-001/);
});

test('the handoff skill names the user template, the CLI commands and the posting ban, and names no rewrite-stopping flag', () => {
  const skill = readFileSync(join(sourceSkills(), HANDOFF, 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('~/.config/idd/handoff-template.md'), 'user template');
  assert.ok(skill.includes('idd out targets'), 'targets');
  assert.ok(skill.includes('idd out draft --kind gh-issue'), 'draft');
  assert.ok(skill.includes('--lane'), 'lane flag');
  assert.ok(skill.includes('gh issue create'), 'posting ban');
  assert.equal(skill.includes('--no-rewrite'), false, 'no rewrite-stopping flag');
});

test('the handoff skill says the rewrite cleans the title too and keeps the title language step', () => {
  const skill = readFileSync(join(sourceSkills(), HANDOFF, 'SKILL.md'), 'utf8');
  assert.equal(skill.includes('清書は題を直さない'), false, 'no stale claim that the rewrite leaves the title');
  assert.ok(skill.includes('題は宛先の repo の対外文書の言語で書く'), 'title language step');
  assert.ok(skill.includes('清書は題も本文も直す'), 'the rewrite fixes the title too');
});

test('the handoff description is narrowed to an explicit request and does not gate on the IDD repo', () => {
  const skill = readFileSync(join(sourceSkills(), HANDOFF, 'SKILL.md'), 'utf8');
  const description = /^description:\s*(.+)$/m.exec(skill)?.[1] ?? '';
  assert.ok(description.includes('明示'), 'explicit request');
  assert.equal(description.includes('docs-template.lock.json'), false, 'not gated on the IDD repo');
});

test('a user handoff template survives placements and is never created by one', () => {
  const dir = home();
  const tpl = join(dir, '.config', 'idd', 'handoff-template.md');
  mkdirSync(dirname(tpl), { recursive: true });
  writeFileSync(tpl, '# my template\n');
  installSkills(dir);
  installSkills(dir);
  assert.equal(readFileSync(tpl, 'utf8'), '# my template\n');
  const bare = home();
  installSkills(bare);
  assert.equal(existsSync(join(bare, '.config', 'idd', 'handoff-template.md')), false);
});

test('the claude place being a link to the agents place still leaves a readable real copy', () => {
  const dir = home();
  const { agents, claude } = skillsPlaces(dir);
  mkdirSync(agents, { recursive: true });
  mkdirSync(join(dir, '.claude'), { recursive: true });
  symlinkSync(join('..', '.agents', 'skills'), claude);
  const res = installSkills(dir);
  assert.equal(res.ok, true, res.error);
  assertReadableFromBoth(dir);
  // the real copy is there once, and no propter- name is a link to itself
  const st = readFileSync(join(agents, 'propter-prep', 'SKILL.md'), 'utf8');
  assert.match(st, /^---\nname: propter-prep/m);
  assert.equal(existsSync(join(agents, 'propter-prep')), true);
});

test('a home whose .claude is a link (dotfiles) still reads every skill from both places', () => {
  const dir = home();
  mkdirSync(join(dir, 'dotfiles', 'claude'), { recursive: true });
  symlinkSync(join('dotfiles', 'claude'), join(dir, '.claude'));
  const res = installSkills(dir);
  assert.equal(res.ok, true, res.error);
  assertReadableFromBoth(dir);
  // the literal .claude path is not a real directory, so the link target is absolute (a relative one would miss)
  const link = readlinkSync(join(dir, '.claude', 'skills', 'propter-prep'));
  assert.ok(link.startsWith('/'), link);
});

test('a .claude that links straight to .agents (the parent link) is the same place', () => {
  const dir = home();
  mkdirSync(join(dir, '.agents'), { recursive: true });
  symlinkSync('.agents', join(dir, '.claude'));
  const res = installSkills(dir);
  assert.equal(res.ok, true, res.error);
  assertReadableFromBoth(dir);
});

test('a propter- name the package no longer has is removed from both places, and other skills are left alone', () => {
  const dir = home();
  const { agents, claude } = skillsPlaces(dir);
  mkdirSync(join(agents, 'propter-old'), { recursive: true });
  mkdirSync(join(claude, 'propter-old'), { recursive: true });
  mkdirSync(join(agents, 'keep-me'), { recursive: true });
  writeFileSync(join(agents, 'keep-me', 'SKILL.md'), 'keep\n');
  mkdirSync(join(claude, 'other'), { recursive: true });
  writeFileSync(join(claude, 'other', 'SKILL.md'), 'other\n');
  const res = installSkills(dir);
  assert.equal(res.ok, true, res.error);
  assert.equal(existsSync(join(agents, 'propter-old')), false);
  assert.equal(existsSync(join(claude, 'propter-old')), false);
  assert.equal(readFileSync(join(agents, 'keep-me', 'SKILL.md'), 'utf8'), 'keep\n');
  assert.equal(readFileSync(join(claude, 'other', 'SKILL.md'), 'utf8'), 'other\n');
  assert.equal(res.removed.filter((p) => p.includes('propter-old')).length, 2);
});

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** a git repo with one commit, at `root`, holding the given files */
function gitRepo(root, files) {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, dirname(p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

test('skillsHome refuses a home that is not an absolute path', () => {
  assert.equal(skillsHome('/h'), '/h');
  assert.equal(skillsHome(''), null);
  assert.equal(skillsHome('relative/home'), null);
  // an empty HOME falls back to the real homedir (this only resolves a path; nothing is written)
  const prev = process.env.HOME;
  process.env.HOME = '';
  try {
    const real = homedir();
    assert.equal(skillsHome(), real && isAbsolute(real) ? real : null);
  } finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
  }
});

test('a home that is not absolute leaves the cwd and the repo alone', () => {
  const res = installSkills('');
  assert.equal(res.ok, false);
  assert.match(res.error, /絶対パス/);
  assert.equal(res.agents, '');
  assert.equal(existsSync(join(process.cwd(), '.agents', 'skills', 'propter-prep')), false);
  assert.equal(installSkills('relative/home').ok, false);
});

test('a place inside a checkout that tracks skills/propter-* is refused, and that checkout is left alone', () => {
  const co = gitRepo(join(home(), 'other-checkout'), { 'skills/propter-x/SKILL.md': 'x\n', 'src/app.ts': 'a\n' });
  const dir = home();
  const { agents } = skillsPlaces(dir);
  mkdirSync(join(dir, '.agents'), { recursive: true });
  symlinkSync(join(co, 'skills'), agents);
  const res = installSkills(dir);
  assert.equal(res.ok, false);
  assert.match(res.error, /checkout の中にあります/);
  assert.equal(readFileSync(join(co, 'skills', 'propter-x', 'SKILL.md'), 'utf8'), 'x\n');
});

test('a place inside a git repo without skills/propter-* (dotfiles) is written to', () => {
  const dots = gitRepo(join(home(), 'dotfiles'), { 'claude/settings.json': '{}\n', 'README.md': '# dots\n' });
  const dir = home();
  symlinkSync(join(dots, 'claude'), join(dir, '.claude'));
  const res = installSkills(dir);
  assert.equal(res.ok, true, res.error);
  assertReadableFromBoth(dir);
});

const sourceSnapshot = () => Object.fromEntries(SKILL_NAMES.map((n) => [n, readFileSync(join(sourceSkills(), n, 'SKILL.md'), 'utf8')]));
function assertSourceIntact(before) {
  for (const name of SKILL_NAMES) {
    assert.equal(readFileSync(join(sourceSkills(), name, 'SKILL.md'), 'utf8'), before[name], `${name} intact`);
  }
}

test('a place linked at the package skills/ is refused without touching the package', () => {
  const before = sourceSnapshot();
  const dir = home();
  const { agents } = skillsPlaces(dir);
  mkdirSync(join(dir, '.agents'), { recursive: true });
  symlinkSync(sourceSkills(), agents);
  const res = installSkills(dir);
  assert.equal(res.ok, false);
  assert.match(res.error, /壊すので、link を外して/);
  assertSourceIntact(before);
});

test('a .agents linked at the package root is refused without touching the package', () => {
  const before = sourceSnapshot();
  const dir = home();
  symlinkSync(dirname(sourceSkills()), join(dir, '.agents'));
  const res = installSkills(dir);
  assert.equal(res.ok, false);
  assert.match(res.error, /壊すので、link を外して/);
  assertSourceIntact(before);
});

test('a .claude/skills linked at the package skills/ is refused without touching the package', () => {
  const before = sourceSnapshot();
  const dir = home();
  const { claude } = skillsPlaces(dir);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  symlinkSync(sourceSkills(), claude);
  const res = installSkills(dir);
  assert.equal(res.ok, false);
  assert.match(res.error, /壊すので、link を外して/);
  assertSourceIntact(before);
});
