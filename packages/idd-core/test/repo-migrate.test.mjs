import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runRepoMigrate } from '../src/init/repo-migrate.ts';
import { templateRoot } from '../src/init/init.ts';
import { tmpDir } from './helpers/tmp.mjs';

for (const k of ['IDD_REPOS_FILE', 'IDD_ROLES_FILE', 'IDD_MODES_FILE']) delete process.env[k];

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** a repo fixed to an earlier template: template copies, a repo's own pieces, and the old init's overlays */
function templateRepo(extra = {}) {
  // the registry file sits next to the repo inside one private temp dir, so parallel runs (two land checks at once) do not overwrite each other's repos.yaml
  const outer = tmpDir('idd-repomig-');
  const root = join(outer, 'repo');
  mkdirSync(root);
  git(root, 'init', '-q');
  const files = {
    'AGENTS.md': '# repo rules\n\nIDD の規範: intent-driven development を使う。\n',
    'CLAUDE.md': '@./AGENTS.md\n',
    'AGENTS.override.md': 'old overlay\n',
    'CLAUDE.local.md': '@./AGENTS.override.md\n',
    'QUICKSTART.md': '# quickstart\n',
    'deno.json': '{}\n',
    'docs-template.lock.example.json': '{}\n',
    'docs-template.lock.json': JSON.stringify({ schema: 1, source: 'https://github.com/penne-0505/intent_driven_dev_template.git', revision: { tag: 'v2.6.0', commit: 'a'.repeat(40) } }, null, 2),
    'overlay.manifest': ['_docs/', '_meta/', 'TODO.md', 'AGENTS.override.md', 'CLAUDE.local.md', 'deno.json', 'overlay.manifest', 'docs-template.lock.json', 'scripts/', ''].join('\n'),
    'TODO.md': '# T\n',
    '_docs/standards/workflow.md': '# workflow\n',
    '_docs/standards/repo_only.md': '# ours\n',
    // a document of the repo's own that happens to share a name the v2 standards use
    '_docs/standards/records.md': '# our records\n',
    '_docs/standards/templates/qa.md': '# old qa template\n',
    '_docs/intent/x/decision.md': '### DEC-1\n',
    '_meta/notes.md': 'notes\n',
    'scripts/check-docs.sh': 'echo check\n',
    'scripts/validate-intent.ts': 'export {};\n',
    'scripts/build.sh': 'echo build\n',
    '.claude/settings.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'deno run scripts/agent-workflow-hook.ts' }] }] } }),
    '.claude/skills/docs-prep/SKILL.md': '# docs-prep\n',
    '.claude/skills/frontend-design/SKILL.md': '# ours\n',
    '.agents/skills/my-skill/SKILL.md': '# ours\n',
    ...extra,
  };
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, dirname(p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  const reposFile = join(outer, 'repos.yaml');
  writeFileSync(reposFile, `repos:\n  me/app:\n    name: app\n    upstream: ${root}\n    work: ${root}\n    checks:\n      - { name: docs, command: "bash scripts/check-docs.sh", required: false, scope: records }\n`);
  return { root, reposFile };
}

test('repo migrate removes only the names it knows as the template\'s, and never touches AGENTS.md', () => {
  const { root, reposFile } = templateRepo();
  const before = git(root, 'rev-parse', 'HEAD');
  const digest = (rel) => createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
  const records = ['_docs/intent/x/decision.md', '_meta/notes.md', 'TODO.md'];
  const recordsBefore = Object.fromEntries(records.map((r) => [r, digest(r)]));
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  const res = runRepoMigrate({ repo: root, source: templateRoot(), reposFile, now: () => new Date('2026-09-28T00:00:00Z') });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  for (const rel of ['_docs/standards/workflow.md', '_docs/standards/templates/qa.md', 'scripts/check-docs.sh', 'scripts/validate-intent.ts', '.claude/skills/docs-prep', '.claude/settings.json', 'AGENTS.override.md', 'CLAUDE.local.md', 'QUICKSTART.md', 'docs-template.lock.example.json']) {
    assert.equal(existsSync(join(root, rel)), false, `${rel} is taken out`);
  }
  for (const rel of ['_docs/standards/repo_only.md', '_docs/standards/records.md', 'scripts/build.sh', 'deno.json', '.claude/skills/frontend-design/SKILL.md', '.agents/skills/my-skill/SKILL.md']) {
    assert.equal(existsSync(join(root, rel)), true, `${rel} stays`);
  }
  assert.ok(res.kept.includes('.claude/skills/frontend-design'));
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), agents, 'AGENTS.md is untouched');
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), claude, 'CLAUDE.md is untouched');
  assert.equal(res.agents.norms, true, 'the IDD-looking AGENTS.md is reported');
  // no commit, and the removals show in the worktree
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
  assert.match(git(root, 'status', '--porcelain'), /D  AGENTS\.override\.md| D AGENTS\.override\.md/);
  // the manifest keeps the record lines and drops the removed ones
  const manifest = readFileSync(join(root, 'overlay.manifest'), 'utf8').split('\n');
  assert.ok(manifest.includes('_docs/') && manifest.includes('_meta/') && manifest.includes('TODO.md'));
  assert.equal(manifest.includes('AGENTS.override.md'), false);
  assert.equal(manifest.includes('CLAUDE.local.md'), false);
  assert.equal(manifest.includes('scripts/'), true, 'scripts/ still holds the repo\'s own build.sh');
  // the lock records the migration point and keeps where it came from
  const lock = JSON.parse(readFileSync(join(root, 'docs-template.lock.json'), 'utf8'));
  assert.equal(lock.source, 'pi-web-idd');
  assert.equal(lock.revision.commit, git(templateRoot(), 'rev-parse', 'HEAD'));
  assert.equal(lock.migrated_from.revision.tag, 'v2.6.0');
  assert.equal(lock.adopted_base, before);
  assert.equal(lock.migrated_at, '2026-09-28T00:00:00.000Z');
  // the registry entry whose check still names the repo's copy is reported with the replacement
  assert.ok(res.registry, 'the registry entry is reported');
  assert.equal(res.registry.key, 'me/app');
  assert.match(res.registry.command, /bash scripts\/check-docs\.sh/);
  assert.match(res.registry.replacement, /bin\/idd" rules check/);
  assert.match(readFileSync(reposFile, 'utf8'), /bash scripts\/check-docs\.sh/, 'repos.yaml is not rewritten');
  assert.match(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), /^_meta\/scratch\/$/m, 'the scratch place is excluded');
  for (const r of records) assert.equal(digest(r), recordsBefore[r], `${r} is not rewritten (INV-763)`);
});

test('repo migrate stops on a dirty repo and on a repo without the lock', () => {
  const { root, reposFile } = templateRepo();
  writeFileSync(join(root, 'dirty.txt'), 'x\n');
  const dirty = runRepoMigrate({ repo: root, source: templateRoot(), reposFile });
  assert.equal(dirty.ok, false);
  assert.match(dirty.skipped, /未 commit/);
  assert.equal(existsSync(join(root, '_docs/standards/workflow.md')), true, 'nothing moved');
  const other = tmpDir('idd-repomig-plain-');
  git(other, 'init', '-q');
  writeFileSync(join(other, 'README.md'), '# x\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', 'init');
  const none = runRepoMigrate({ repo: other, source: templateRoot(), reposFile });
  assert.equal(none.ok, false);
  assert.match(none.skipped, /docs-template\.lock\.json/);
});

test('repo migrate drops only the manifest lines of what it took out, never a missing or empty directory', () => {
  const manifestLines = ['_docs/', '_meta/', 'TODO.md', 'AGENTS.override.md', 'CLAUDE.local.md', 'overlay.manifest', 'docs-template.lock.json', '.claude/skills/docs-prep/', '.claude/settings.json', 'private-notes/', 'empty-dir/', 'scripts/check-docs.sh', ''];
  const { root, reposFile } = templateRepo({ 'overlay.manifest': manifestLines.join('\n') });
  // an empty directory is not tracked, so it does not make the repo dirty
  mkdirSync(join(root, 'empty-dir'));
  const res = runRepoMigrate({ repo: root, source: templateRoot(), reposFile });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const manifest = readFileSync(join(root, 'overlay.manifest'), 'utf8').split('\n');
  for (const line of ['private-notes/', 'empty-dir/', '_docs/', '_meta/', 'TODO.md']) {
    assert.ok(manifest.includes(line), `${line} stays: the private boundary does not shrink`);
  }
  for (const line of ['AGENTS.override.md', 'CLAUDE.local.md', '.claude/skills/docs-prep/', '.claude/settings.json', 'scripts/check-docs.sh']) {
    assert.equal(manifest.includes(line), false, `${line} names a copy that was taken out`);
  }
  assert.deepEqual([...res.manifest.removedLines].sort(), ['.claude/settings.json', '.claude/skills/docs-prep/', 'AGENTS.override.md', 'CLAUDE.local.md', 'scripts/check-docs.sh']);
});

test('repo migrate runs to the end on a linked worktree, whose .git is a file', () => {
  const { root, reposFile } = templateRepo();
  const linked = join(tmpDir('idd-repomig-linked-'), 'wt');
  git(root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
  const res = runRepoMigrate({ repo: linked, source: templateRoot(), reposFile });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(existsSync(join(linked, 'AGENTS.override.md')), false, 'the removals went through');
  const lock = JSON.parse(readFileSync(join(linked, 'docs-template.lock.json'), 'utf8'));
  assert.equal(lock.source, 'pi-web-idd', 'the lock is rewritten after the removals');
  const exclude = git(linked, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
  assert.match(readFileSync(exclude, 'utf8'), /^_meta\/scratch\/$/m, 'the scratch place is excluded where git reads it');
});

test('repo migrate names the old R2 tasks a TODO still holds, which the package\'s validate-todo no longer takes', () => {
  const { root, reposFile } = templateRepo({ 'TODO.md': '# T\n\n## Backlog\n\n### App-R2-9: [R2] 再構成\n\n- **ID**: App-R2-9\n\n### App-Bug-3: [Bug] x\n' });
  const res = runRepoMigrate({ repo: root, source: templateRoot(), reposFile });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const note = res.steps.find((s) => s.includes('R2 task'));
  assert.ok(note, JSON.stringify(res.steps));
  assert.match(note, /App-R2-9/);
  assert.doesNotMatch(note, /App-Bug-3/);
  // a TODO without them says nothing
  const clean = templateRepo();
  assert.ok(!runRepoMigrate({ repo: clean.root, source: templateRoot(), reposFile: clean.reposFile }).steps.some((s) => s.includes('R2 task')));
});
