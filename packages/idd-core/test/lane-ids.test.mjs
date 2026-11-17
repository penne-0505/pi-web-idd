import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decisionIndex, decisionRecord } from '../src/intent/decisions.ts';
import { parseIntent } from '../src/intent/parse.ts';
import { plannerBrief } from '../src/plan/prep.ts';
import { executorBrief } from '../src/plan/exec.ts';
import { appendBacklogTask } from '../src/init/init.ts';
import { tmpDir } from './helpers/tmp.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VALIDATE_INTENT = join(REPO, 'scripts', 'validate-intent.ts');
const VALIDATE_QA = join(REPO, 'scripts', 'validate-qa.ts');
const VALIDATE_TODO = join(REPO, 'scripts', 'validate-todo.ts');

const git = (cwd, ...a) =>
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd, encoding: 'utf8' }).trim();

const put = (root, rel, text) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

const denoRun = (cwd, script, args) =>
  spawnSync('deno', ['run', '--allow-read', '--allow-env', '--allow-run=git', script, ...args], { cwd, encoding: 'utf8' });

/** a decision document with one DEC and (optionally) one INV */
const decisionDoc = (title, area, slug, dec, inv) => `---
title: ${title}
status: active
intent_schema: 4
created_at: 2026-10-06
updated_at: 2026-10-06
references: []
related_issues: []
related_prs: []
fixture_path: _docs/intent/${area}/${slug}/decision.md
---

## Context
- mixed identifier fixture.

## Decisions

### ${dec}: 判断

- **What**: a
- **Why**: b
- **Change freedom**: c
- **Anchors**: \`scripts/validate-intent.ts\`

## Consequences / Impact
None

## Quality Implications
None

## Intent-derived Invariants
${inv ? `- ${inv} (from ${dec}): 性質` : "None"}

## Rollback / Follow-ups
None
`;

const TODO_MIXED = `# TODO

- **Current Max ID**: \`Next ID No: 5\`

## Inbox

-

## Backlog

### IddCore-Enhance-4: [Enhance] 本流の task

- **Title**: [Enhance] 本流の task
- **ID**: IddCore-Enhance-4
- **Priority**: P2
- **Size**: S
- **Risk**: Low
- **Area**: IddCore
- **Dependencies**: []
- **Goal**: mixed.
- **Acceptance Criteria**:
  - AC-001: x.
- **Steps**:
  1. [ ] x.
- **Description**:
  - Context: x.
  - Notes: x.
- **Plan**: None
- **Intent**: None
- **QA**: _docs/qa/IddCore/maintenance.md

### IddCore-Bug-088-1: [Bug] lane の task

- **Title**: [Bug] lane の task
- **ID**: IddCore-Bug-088-1
- **Priority**: P2
- **Size**: S
- **Risk**: Low
- **Area**: IddCore
- **Dependencies**: []
- **Goal**: mixed.
- **Acceptance Criteria**:
  - AC-001: x.
- **Steps**:
  1. [ ] x.
- **Description**:
  - Context: x.
  - Notes: x.
- **Plan**: None
- **Intent**: None
- **QA**: _docs/qa/IddCore/maintenance.md

## Ready

## In Progress
`;

const QA_MIXED = `---
title: "QA: mixed"
status: active
qa_status: verified
risk: Medium
qa_schema: 5
created_at: 2026-10-06
updated_at: 2026-10-06
references: []
related_issues: []
related_prs: []
fixture_path: _docs/qa/IddCore/mixed/qa.md
---

# QA: mixed

## Acceptance Criteria

- AC-001: mixed.

## Checks

| ID | Source | Requirement / Invariant | Check Type | Command / File | Status |
| --- | --- | --- | --- | --- | --- |
| AC-001 | TODO | mixed | validator | scripts/validate-qa.ts | verified |

## Rounds

### Round 3 (2026-10-06)

- **Commands**: \`x\`
- **AC Coverage**: AC-001
- **Intent Delta**: applied: DEC-701
- **R2**: 非発動
- **Verdict**: PASS

### Round 088-1 (2026-10-06)

- **Commands**: \`x\`
- **AC Coverage**: AC-001
- **Intent Delta**: applied: DEC-088-1
- **R2**: R2 の結果（Round 3）
- **Verdict**: PASS
`;

// AC-023 / INV-2562: a repo where the bare, lane and hand-written forms all live at once passes the
// intent, qa and todo checks; the index answers all three.
test('a repo with all three identifier forms passes the validators and the index', { skip: spawnSync('deno', ['--version']).status !== 0 }, async () => {
  const root = tmpDir('idd-mixed-');
  put(root, '_docs/intent/Mixed/mixed-ids/decision.md', decisionDoc('mixed', 'Mixed', 'mixed-ids', 'DEC-701', 'INV-041'));
  put(root, '_docs/intent/IddCore/mixed-ids/decision.md', decisionDoc('mixed', 'IddCore', 'mixed-ids', 'DEC-IddCore-2', 'INV-IddCore-3'));
  put(root, '_docs/intent/pi-web-idd/idd-088/decision.md', decisionDoc('mixed', 'pi-web-idd', 'idd-088', 'DEC-088-1', 'INV-088-1')
    .replace('- mixed identifier fixture.', '- ほかの lane と Area の例: `DEC-077-3`・`DEC-IddCore-12`。定義ではない。'));
  put(root, 'TODO.md', TODO_MIXED);
  put(root, '_docs/qa/IddCore/mixed/qa.md', QA_MIXED);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'a@b');
  git(root, 'config', 'user.name', 'a');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');

  const intent = denoRun(root, VALIDATE_INTENT, ['--fixture', '_docs/intent']);
  assert.equal(intent.status, 0, `${intent.stdout}${intent.stderr}`);
  const qa = denoRun(root, VALIDATE_QA, ['--fixture', '_docs/qa/IddCore/mixed/qa.md']);
  assert.equal(qa.status, 0, `${qa.stdout}${qa.stderr}`);
  const todo = denoRun(root, VALIDATE_TODO, ['TODO.md']);
  assert.equal(todo.status, 0, `${todo.stdout}${todo.stderr}`);

  put(root, '_docs/intent/pi-web-idd/idd-088/decision.md', decisionDoc('mixed', 'pi-web-idd', 'idd-088', 'DEC-088-1', 'INV-088-1'));
  const index = decisionIndex({ root, source: { root }, paths: ['scripts/validate-intent.ts'] });
  assert.deepEqual(index.candidates.map((c) => c.id).sort(), ['DEC-088-1', 'DEC-701', 'DEC-IddCore-2']);
  assert.equal(decisionRecord({ root }, 'DEC-088'), null);
  const parsed = parseIntent('pi-web-idd', 'idd-088', { root });
  assert.deepEqual(parsed.decisions.map((d) => d.id), ['DEC-088-1']);
  assert.deepEqual(parsed.invariants.map((i) => i.id), ['INV-088-1']);

});

// AC-015: a task added without a lane still takes the `Next ID No` and moves it on.
test('appendBacklogTask numbers a mainstream task from Next ID No and advances the line', () => {
  const todo = '# TODO\n\n- **Current Max ID**: `Next ID No: 7`\n\n## Backlog\n\n';
  const task = { area: 'Docs', category: 'Chore', title: 't', goal: 'g', criteria: ['c'], steps: ['s'], context: 'x', notes: 'x', qa: '_docs/qa/Docs/maintenance.md' };
  const made = appendBacklogTask(todo, task);
  assert.equal(made.id, 'Docs-Chore-7');
  assert.match(made.todo, /`Next ID No: 8`/);
});

// AC-012 / AC-013: a task added for a lane takes the lane serial and leaves `Next ID No` alone.
test('appendBacklogTask numbers a lane task from the lane serial and leaves Next ID No', () => {
  const todo = '# TODO\n\n- **Current Max ID**: `Next ID No: 7`\n\n## Backlog\n\n### Docs-Chore-088-1: [Chore] a\n\n';
  const made = appendBacklogTask(todo, { area: 'Docs', category: 'Chore', title: 't', goal: 'g', criteria: ['c'], steps: ['s'], context: 'x', notes: 'x', qa: '_docs/qa/Docs/maintenance.md', lane: '088' });
  assert.equal(made.id, 'Docs-Chore-088-2');
  assert.match(made.todo, /`Next ID No: 7`/);
});

// AC-013 / INV-2564: two lanes adding a task to the same TODO range merge without touching `Next ID No`.
test('two lanes merging into the same TODO keep both tasks and leave Next ID No alone', () => {
  const root = tmpDir('idd-merge-');
  const task = (id) => [
    `### ${id}: [Chore] task`,
    "",
    `- **Title**: [Chore] task`,
    `- **ID**: ${id}`,
    "- **Priority**: P2",
    "- **Size**: S",
    "- **Risk**: Low",
    "- **Area**: IddCore",
    "- **Dependencies**: []",
    "- **Goal**: merge.",
    "- **Acceptance Criteria**:",
    "  - AC-001: x.",
    "- **Steps**:",
    "  1. [ ] x.",
    "- **Description**:",
    "  - Context: x.",
    "  - Notes: x.",
    "- **Plan**: None",
    "- **Intent**: None",
    "- **QA**: _docs/qa/IddCore/maintenance.md",
    "",
    "",
  ].join("\n");
  const todo = (tasks) => `# TODO\n\n- **Current Max ID**: \`Next ID No: 1\`\n\n## Inbox\n\n-\n\n## Backlog\n\n${tasks}## Ready\n\n## In Progress\n`;
  put(root, 'TODO.md', todo(''));
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'lane-a');
  writeFileSync(join(root, 'TODO.md'), todo(task('IddCore-Chore-088-1')));
  git(root, 'commit', '-qam', 'a');
  git(root, 'checkout', '-q', '-b', 'lane-b', base);
  writeFileSync(join(root, 'TODO.md'), todo(task('IddCore-Chore-089-1')));
  git(root, 'commit', '-qam', 'b');
  git(root, 'checkout', '-q', 'lane-a');
  const merged = spawnSync('git', ['merge', 'lane-b'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(merged.status, 0, 'the two additions to the same range conflict');
  const conflicted = readFileSync(join(root, 'TODO.md'), 'utf8');
  const counterAt = conflicted.indexOf('Next ID No');
  assert.doesNotMatch(conflicted.slice(counterAt - 5, counterAt + 40), /<<<<<<</, 'the counter line is not conflicted');
  // resolve by keeping both blocks: the identifiers stay, the counter line stays once
  writeFileSync(join(root, 'TODO.md'), todo(`${task('IddCore-Chore-088-1')}${task('IddCore-Chore-089-1')}`));
  git(root, 'add', 'TODO.md');
  git(root, 'commit', '-q', '-m', 'merge');
  const resolved = readFileSync(join(root, 'TODO.md'), 'utf8');
  assert.match(resolved, /`Next ID No: 1`/);
  assert.match(resolved, /IddCore-Chore-088-1/);
  assert.match(resolved, /IddCore-Chore-089-1/);
  const check = denoRun(root, VALIDATE_TODO, ['TODO.md']);
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
});

// AC-022 / INV-2561: two lanes made at the same time write their own identifiers and never collide.
test('two lanes built side by side name no identifier of the other', () => {
  const rec = (idd) => ({ idd_id: idd, area: 'Demo/repo', title: 'T', context: '', gh_issue_url: '' });
  const wt = tmpDir('idd-two-lanes-');
  mkdirSync(join(wt, 'state'), { recursive: true });
  writeFileSync(join(wt, 'repos.yaml'), JSON.stringify({ repos: { 'Demo/repo': { upstream: join(wt, 'u'), work: join(wt, 'w'), public_base: 'main' } } }));
  Object.assign(process.env, { IDD_STATE_DIR: join(wt, 'state'), IDD_REPOS_FILE: join(wt, 'repos.yaml') });
  const briefs = ['IDD-088', 'IDD-089'].map((id) => ({ id, planner: plannerBrief(rec(id)), executor: executorBrief(rec(id), wt) }));
  assert.match(briefs[0].planner, /`DEC-088-&lt;連番&gt;`/);
  assert.match(briefs[0].executor, /`Round 088-&lt;連番&gt;`/);
  assert.match(briefs[1].planner, /`DEC-089-&lt;連番&gt;`/);
  assert.match(briefs[1].executor, /`Round 089-&lt;連番&gt;`/);
  assert.doesNotMatch(briefs[0].executor, /089-&lt;連番&gt;/);
  assert.doesNotMatch(briefs[1].executor, /088-&lt;連番&gt;/);
  // the identifiers the two lanes write per the briefs do not overlap
  const writtenA = ['DEC-088-1', 'INV-088-1', 'Round 088-1', 'IddCore-Bug-088-1'];
  const writtenB = ['DEC-089-1', 'INV-089-1', 'Round 089-1', 'IddCore-Bug-089-1'];
  assert.equal(writtenA.filter((x) => writtenB.includes(x)).length, 0);
});
