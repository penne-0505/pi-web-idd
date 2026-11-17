import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { plannerBrief } from '../src/plan/prep.ts';
import { PLANNER_EXISTING_DEC_RULE, PLANNER_IMPACT_RULE } from '../src/plan/prompt-text.ts';
import { esc } from '../src/agent/message.ts';

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };

function setup() {
  const root = temp('idd-planner-dec-');
  const state = join(root, 'state'); mkdirSync(state);
  const worktree = join(root, 'wt'); mkdirSync(worktree);
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main' } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  const put = (rel, text) => { mkdirSync(dirname(join(worktree, rel)), { recursive: true }); writeFileSync(join(worktree, rel), text); };
  put('_docs/intent/app/other/decision.md', '# other\n\n## Decisions\n\n### DEC-801: 保存の前に確認を挟む\n\n- **Why**: 取り消せない削除を防ぐため。\n- **Anchors**: `src/save.ts`\n');
  return { root, state, worktree, put };
}

const rec = (context) => ({ idd_id: 'IDD-9', area: 'me/app', title: 'T', context, gh_issue_url: 'https://github.com/me/app/issues/9', created_at: '2026-09-24T00:00:00Z' });

test('the brief pulls the DECs of the paths the Issue names (AC-003)', () => {
  const { worktree } = setup();
  const brief = plannerBrief(rec('`src/save.ts` の確認を外す'), undefined, worktree);
  const block = brief.split('<existing-decisions')[1].split('</existing-decisions>')[0];
  assert.match(block, /count="1"/);
  assert.match(block, /DEC-801/);
  assert.match(block, /保存の前に確認を挟む/);
  assert.match(block, /_docs\/intent\/app\/other\/decision\.md/);
});

test('a lane whose Issue names no path gets the pull instructions and a count of 0 (AC-003)', () => {
  const { worktree } = setup();
  const brief = plannerBrief(rec('とくにファイルを挙げない'), undefined, worktree);
  const block = brief.split('<existing-decisions')[1].split('</existing-decisions>')[0];
  assert.match(block, /count="0"/);
  assert.match(block, /idd intent decisions/);
  assert.match(block, /Issue の文面からファイルを特定できなかった/);
});

test('the brief tells the planner to read the existing DECs before writing, and how to report (AC-003)', () => {
  const { worktree } = setup();
  const brief = plannerBrief(rec('`src/save.ts`'), undefined, worktree);
  const rules = brief.split('<record-rules>')[1].split('</record-rules>')[0];
  assert.ok(rules.includes(esc(PLANNER_EXISTING_DEC_RULE)));
  assert.match(rules, /What か Why の文が成り立たなくなるとき/);
  assert.doesNotMatch(rules, /Why を変えるときは、その更新をこの lane の DEC として書く/);
  assert.match(rules, /後継の DEC をこの lane に書き/);
  assert.match(rules, /Superseded by/);
  assert.match(rules, /元の DEC に更新の行は足さない/);
  const plan = brief.split('<plan>')[1].split('</plan>')[0];
  for (const line of PLANNER_IMPACT_RULE) assert.ok(plan.includes(line));
  assert.match(plan, /--intent-impact/);
  assert.match(plan, /keep\|within_freedom\|change_why/);
});

test('the brief index row carries the first sentence of the Why (AC-023)', () => {
  const { worktree } = setup();
  const brief = plannerBrief(rec('`src/save.ts` の確認を外す'), undefined, worktree);
  const block = brief.split('<existing-decisions')[1].split('</existing-decisions>')[0];
  assert.match(block, /取り消せない削除を防ぐため。/);
});

test('the lane\'s own decision document is not handed back as an existing DEC (AC-003)', () => {
  const { worktree, put } = setup();
  put('_docs/intent/app/idd-9/decision.md', '# mine\n\n## Decisions\n\n### DEC-802: 自分の判断\n\n- **Anchors**: `src/save.ts`\n');
  const brief = plannerBrief(rec('`src/save.ts`'), undefined, worktree);
  const block = brief.split('<existing-decisions')[1].split('</existing-decisions>')[0];
  assert.match(block, /DEC-801/);
  assert.doesNotMatch(block, /DEC-802/);
});

test('the brief without a worktree still renders an existing-decisions element', () => {
  setup();
  const brief = plannerBrief(rec('`src/save.ts`'));
  assert.match(brief, /<existing-decisions count="\d+">/);
  assert.match(brief, /<\/existing-decisions>/);
});

test('AC-027: the brief hands the open findings of the Issue paths to the planner', () => {
  const { state, worktree } = setup();
  const rows = [
    { event: 'finding_placed', at: '2026-10-13T00:00:00Z', repo: 'me/app', lane: 'IDD-8', id: 'F-8-1', round: 1, path: 'src/save.ts', lines: [3, 5], commit: 'H1', severity: 'should', claim: '保存の前に確認が無い' },
    { event: 'finding_disposed', at: '2026-10-13T01:00:00Z', repo: 'me/app', lane: 'IDD-7', id: 'F-8-1', action: 'fix' },
  ];
  writeFileSync(join(state, 'work-me%2Fapp.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(state, 'lifecycle-me-app.jsonl'), JSON.stringify({ idd_id: 'IDD-8', event: 'lane_close', at: '2026-10-13T02:00:00Z', attrs: { outcome: 'merged' } }) + '\n');
  const brief = plannerBrief(rec('`src/save.ts` の確認を直す'), undefined, worktree);
  const block = brief.split('<open-findings')[1].split('</open-findings>')[0];
  assert.match(block, /count="1"/);
  assert.match(block, /F-8-1/);
  assert.match(block, /src\/save\.ts:3-5/);
  assert.match(block, /should/);
  assert.match(block, /保存の前に確認が無い/);
  assert.match(block, /from IDD-8/);
  assert.match(block, /IDD-7 が「直す」と申告/);
  // the record rule tells the planner to dispose of them
  assert.match(brief.split('<record-rules>')[1].split('</record-rules>')[0], /--findings/);
});

test('AC-027: with no open finding the section says so', () => {
  const { state, worktree } = setup();
  writeFileSync(join(state, 'lifecycle-me-app.jsonl'), '');
  const brief = plannerBrief(rec('`src/save.ts`'), undefined, worktree);
  const block = brief.split('<open-findings')[1].split('</open-findings>')[0];
  assert.match(block, /count="0"/);
  assert.match(block, /open な指摘は無い/);
});
