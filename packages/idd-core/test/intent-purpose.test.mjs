import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { INTENT_PURPOSE, NO_INV_RULE, PLANNER_EXISTING_DEC_RULE, PLANNER_RECORD_RULES, WORK_INSTRUCTION_RULE } from '../src/plan/prompt-text.ts';
import { INTENT_WHY_SECTION } from '../src/agent/message.ts';
import { plannerBrief } from '../src/plan/prep.ts';
import { standardsPath } from '../src/rules/rules.ts';
import { executorBrief, fixBrief, runExec } from '../src/plan/exec.ts';
import { parseRepos } from '../src/config/areas.ts';
import { setAgentRunner } from '../src/agent/port.ts';
import { ensureLaneWorktree } from '../src/worktree/ensure.ts';
import { shippedConfigSkip } from './helpers/shipped-config.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const rec = { idd_id: 'IDD-001', area: 'me/app', title: 'T', context: '', gh_issue_url: 'https://github.com/me/app/issues/1' };

/** a state + repos.yaml whose one area may ask for a work instruction */
function setup(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'idd-purpose-'));
  const state = join(root, 'state'); mkdirSync(state);
  const area = { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main', ...(opts.area ?? {}) };
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': area } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  const wt = join(root, 'wt'); mkdirSync(wt);
  return { root, state, wt };
}

test('AC-001: the purpose is at the head of workflow.md, before the loop section, and matches the code', () => {
  const text = read('_docs/standards/workflow.md');
  const at = text.indexOf(INTENT_PURPOSE);
  assert.ok(at > 0, 'the purpose is in the standard');
  assert.ok(at < text.indexOf('## ループ'), 'the purpose is before the loop section');
  assert.match(text.slice(0, at), /## 目的/);
});

test('AC-001: the standard writes the want as the user\'s state and lowers the artifact\'s nature to a Choice', () => {
  const std = read('_docs/standards/records.md');
  assert.match(std, /Purpose の want は、成果物を使う者（人か agent）が何をできるか・どうなるかで書く/);
  assert.match(std, /主語は使う者か/);
  assert.match(std, /成果物の性質（一致する・無い・同じ）を述べていないか/);
  assert.match(std, /成果物の性質は\s*want に書かず、Choice の守る形（`anchored`）に降ろす/);
});

test('AC-004 / AC-005: the Choice bar and the why causality are in the standard, the old DEC bar stays in the old template and the old planner brief', () => {
  const std = read('_docs/standards/records.md');
  assert.match(std, /Choice を立てる判定は「Why not が書けるか」である/);
  assert.match(std, /出所（回答、指摘、AC の文面）だけを why にしない/);
  assert.match(std, /INV の番号を新しく作らない/);
  // the old decision.md template is gone: no door writes a decision.md any more, so a template would only invite misuse
  assert.equal(existsSync(join(ROOT, '_docs/standards/templates/intent.md')), false);
  const contracts = read('_docs/standards/document_contracts.md');
  assert.match(contracts, /### 旧い形の intent（`decision\.md`）— 読むだけ/);
  const { wt } = setup();
  const brief = plannerBrief(rec, undefined, wt);
  for (const line of PLANNER_RECORD_RULES) assert.ok(brief.includes(line), `the planner is told: ${line.slice(0, 30)}`);
});

test('AC-006: a repo configured for a work instruction is asked for plan.md, with its template and the rule', () => {
  const { wt } = setup({ area: { work_instruction: 'plan' } });
  const brief = plannerBrief(rec, undefined, wt);
  assert.match(brief, /<plan path="_docs\/plan\/app\/idd-001\/plan\.md"/);
  assert.match(brief, /templates\/plan\.md/);
  assert.ok(brief.includes(WORK_INSTRUCTION_RULE));
});

test('AC-006: a setting the reader does not know is an error, and `decision` is the old shape', () => {
  const base = { upstream: 'u', work: 'w' };
  assert.throws(() => parseRepos(JSON.stringify({ repos: { 'me/app': { ...base, work_instruction: 'bogus' } } })), /work_instruction/);
  const cfg = parseRepos(JSON.stringify({ repos: { 'me/app': { ...base, work_instruction: 'decision' } } }));
  assert.equal(cfg.areas['me/app'].work_instruction, undefined);
  const plan = parseRepos(JSON.stringify({ repos: { 'me/app': { ...base, work_instruction: 'plan' } } }));
  assert.equal(plan.areas['me/app'].work_instruction, 'plan');
});

test('AC-002: the v2 planner brief tells the Purpose want to be written as the user\'s state', () => {
  const { wt } = setup({ area: { work_instruction: 'plan' } });
  const brief = plannerBrief(rec, undefined, wt, undefined, 'state');
  assert.match(brief, /案の want は成果物を使う者（人か agent）が何をできるか・どうなるかで書き、成果物の性質（一致する・無い・同じ）は want に書かず Choice の守る形に降ろす/);
  // the v1 brief has no Purpose draft step, so it is not told how to write a want
  assert.doesNotMatch(plannerBrief(rec, undefined, wt, undefined, 'docs'), /案の want は成果物を使う者/);
});

test('AC-009: a repo without the setting is asked for the three records alone, and still gets the purpose and the bar', () => {
  const { wt } = setup();
  const brief = plannerBrief(rec, undefined, wt);
  assert.match(brief, /<decision path=/);
  assert.match(brief, /<qa path=/);
  assert.match(brief, /<reference path=/);
  assert.doesNotMatch(brief, /<plan path=/);
  assert.ok(!brief.includes(WORK_INSTRUCTION_RULE));
  assert.ok(brief.includes(INTENT_PURPOSE));
  for (const line of PLANNER_RECORD_RULES) assert.ok(brief.includes(line));
});

test('AC-001: the request rule reaches the planner only when the repo asks for a plan, in both record shapes', () => {
  const { wt } = setup({ area: { work_instruction: 'plan' } });
  for (const shape of ['docs', 'state']) {
    const brief = plannerBrief(rec, undefined, wt, undefined, shape);
    assert.ok(brief.includes(WORK_INSTRUCTION_RULE), `${shape} carries the rule`);
    for (const part of ['6 欄', 'how', '原物は所在・読み方・罠', '踏んだ回避']) assert.ok(brief.includes(part), `${shape}: ${part}`);
  }
  const { wt: plain } = setup();
  for (const shape of ['docs', 'state']) assert.ok(!plannerBrief(rec, undefined, plain, undefined, shape).includes(WORK_INSTRUCTION_RULE));
});

test('the request rule names the Issue body as an original and asks for a place the executor can open', () => {
  const { wt } = setup({ area: { work_instruction: 'plan' } });
  for (const shape of ['docs', 'state']) {
    const brief = plannerBrief(rec, undefined, wt, undefined, shape);
    assert.ok(brief.includes('Issue の本文が原物のときは'), `${shape} names the Issue body as an original`);
    assert.ok(brief.includes('実装役の席から開ける所在と読み方'), `${shape} asks for a place the executor can open`);
  }
  const { wt: plain } = setup();
  for (const shape of ['docs', 'state']) {
    assert.ok(!plannerBrief(rec, undefined, plain, undefined, shape).includes('Issue の本文が原物'), `${shape} without a plan carries no Issue rule`);
  }
});

test('AC-003 / AC-004: the standard limits the whole to the want in real states and keeps the artifact nature off it', () => {
  const brief = read('_docs/standards/brief.md');
  assert.match(brief, /Purpose の want を lane の範囲で本物の状態に\s*言い換えた文にする/);
  assert.match(brief, /成果物の性質（prototype と一致する・絵が同じ・無い）は全体に書かず、\s*床か Choice に置く/);
  assert.match(brief, /本物の状態（本物の engine と本物のデータ）の上で行う/);
  assert.match(brief, /偽の engine の画面と prototype と\s*並べた絵は床の確かめに使ってよいが、全体の判定の代わりにしない/);
  assert.match(brief, /誰が判定するかは Harness が決める/);
  // the first field's and the whole's examples carry no artifact nature
  assert.doesNotMatch(brief, /prototype と並べて見分けがつかない/);
  assert.doesNotMatch(brief, /配置・寸法・階層の違いを\s*挙げられない/);
});

test('AC-005: the standard\'s plan-review line puts an artifact-nature whole and a lane\'s own Purpose draft on must', () => {
  const brief = read('_docs/standards/brief.md');
  assert.match(brief, /全体 1 文が成果物の性質であるときも must にする/);
  assert.match(brief, /その lane が\s*出した Purpose の案の want が成果物の性質であるときも must にする/);
  assert.match(brief, /草案が連なる既存の active な\s*Purpose の want が成果物の性質であるときは should にする/);
});

test('the standard shows an Issue original a place the executor can open, and why its absence is not excused', () => {
  const brief = read('_docs/standards/brief.md');
  assert.match(brief, /Issue の本文が原物なら/);
  assert.match(brief, /gh issue view <N> --repo <owner\/name>/);
  assert.match(brief, /backlog\.jsonl/);
  assert.match(brief, /本文の先頭 2000 文字/);
  assert.match(brief, /実装役の席から開ける所在として当てにしない/);
  assert.match(brief, /実装役の brief には Issue の\s*URL しか届かず、本文は届かない/);
  assert.doesNotMatch(brief, /計画役の封筒に全文があることは/);
  assert.match(brief, /写しがあることは、依頼に所在を省く理由にならない/);
});

test('the planner catalog carries the Issue rule with the code', () => {
  const catalog = read('_meta/prompt-catalog/01-planner.md');
  assert.ok(catalog.includes(WORK_INSTRUCTION_RULE), 'the catalog line matches the code');
  assert.ok(catalog.includes('Issue の本文が原物のときは'), 'the catalog names the Issue body as an original');
});

test('AC-002: the standard, the plan template, the skill and the catalog write the request as 6 fields, with no old shape', () => {
  const fields = ['## 依頼', '## 意図', '## 重要なコンテクスト', '## 裁量', '## 完了の形', '## 戻す条件'];
  const brief = read('_docs/standards/brief.md');
  for (const h of fields) assert.ok(brief.includes(h), `brief.md: ${h}`);
  assert.match(brief, /原物については所在・読み方・罠を書き、中身を要約しない/);
  assert.match(brief, /計画役が自分で踏んだ回避/);
  const plan = read('_docs/standards/templates/plan.md');
  for (const h of fields) assert.ok(plan.includes(h), `plan.md: ${h}`);
  assert.match(plan, /_docs\/standards\/brief\.md/);
  // the touched places open a list item with the path, so the mainline's advance reading picks them up
  assert.match(plan, /^\s*[-*]\s+`[^`]+`/m);
  assert.doesNotMatch(plan, /## Non-Goals|## Deployment \/ Rollout|## Overview|## QA Plan/);
  const contracts = read('_docs/standards/document_contracts.md');
  assert.match(contracts, /_docs\/standards\/brief\.md/);
  assert.doesNotMatch(contracts, /作業指示 \(触る場所・順序・確かめ方・やらないこと\)/);
  const workflow = read('_docs/standards/workflow.md');
  assert.match(workflow, /_docs\/standards\/brief\.md/);
  assert.doesNotMatch(workflow, /作業指示（触る場所・順序・確かめ方・やらないこと）/);
  const skill = read('skills/propter-prep/SKILL.md');
  assert.match(skill, /_docs\/standards\/brief\.md/);
  assert.doesNotMatch(skill, /Overview \/ Scope \/ Non-Goals/);
  const catalog = read('_meta/prompt-catalog/01-planner.md');
  assert.ok(catalog.includes(WORK_INSTRUCTION_RULE));
  assert.doesNotMatch(catalog, /作業指示（触る場所・順序・確かめ方・やらないこと）/);
});

test('AC-005: a plan lane\'s executor brief carries the discretion and the minimal default', () => {
  const { wt } = setup();
  planFile(wt, '_docs/plan/app/idd-001/plan.md');
  const brief = executorBrief(rec, wt);
  assert.match(brief, /依頼の裁量（触る範囲・自由・守ること）に従い、依頼に書かれていない所の変更は最小に留める/);
});

/** the brief names the solving standard and its numbers; the body is the standard's own, so none of it is copied */
function assertCitesSolving(brief) {
  assert.match(brief, /_docs\/standards\/solving\.md/);
  for (const n of ['P1', 'P4', 'P7', 'R3', 'R5', 'R9']) assert.ok(brief.includes(n), n);
  assert.doesNotMatch(brief, /系が特別扱いなしにその課題を満たす形/);
}

test('AC-004: an old-form plan lane\'s executor brief cites the solving standard by number, and a fix session\'s does too', () => {
  const { wt } = setup();
  planFile(wt, '_docs/plan/app/idd-001/plan.md');
  const brief = executorBrief(rec, wt);
  assertCitesSolving(brief);
  assertCitesSolving(fixBrief(rec, wt, '  <task>直す</task>'));
  // no rule's own sentence is copied into the brief: the rules are named by number
  assert.doesNotMatch(brief, /新しい形を入れたら同じ lane で旧い形を消す|実装に入らず止まって尋ねる|原因に届くのに必要な分だけ範囲を広げてよい/);
  // this lane's records are decision.md: the stopgap's three facts go in a follow-up Issue's draft, not a Choice or a note on the place
  assert.match(brief, /out draft --kind gh-issue/);
  assert.match(brief, /場所に付いた指摘を後続の Issue の代わりにせず/);
  assert.doesNotMatch(brief, /応急処置として Choice に記録/);
  // a cause outside the listed places is reached under R11, whose body is the standard's own; the brief asks only for the widening to be reported
  assert.match(brief, /広げた場所と理由を結果の side_findings に書く（R11）/);
});

test('AC-004: a tree without solving.md is told where the package\'s original is, and a tree with it is told nothing', () => {
  const original = join(standardsPath(), 'solving.md');
  const briefsOf = (keep) => {
    const { wt } = setup();
    planFile(wt, '_docs/plan/app/idd-001/plan.md');
    if (keep) { mkdirSync(join(wt, '_docs', 'standards'), { recursive: true }); writeFileSync(join(wt, '_docs', 'standards', 'solving.md'), '# solving\n'); }
    return [executorBrief(rec, wt), fixBrief(rec, wt, '  <task>直す</task>')];
  };
  for (const brief of briefsOf(false)) {
    assert.ok(brief.includes(`原物は \`${original}\` にある`), 'the original is named by its absolute path');
    // only the place is told: no principle's own sentence goes with it
    assert.doesNotMatch(brief, /系が特別扱いなしにその課題を満たす形/);
  }
  for (const brief of briefsOf(true)) {
    assert.doesNotMatch(brief, /はこの tree に無い/);
    assert.ok(!brief.includes(original));
  }
});

test('AC-005: every executor role of the shipped roles.yaml carries the discretion and the minimal default, and the planner role stays read-only', { skip: shippedConfigSkip('roles.yaml') }, () => {
  const roles = read('config/roles.yaml');
  const line = '変更は最小に留め、責務外のリファクタをしない。依頼の裁量（触る範囲・自由・守ること）があるときはそれに従い、依頼に書かれていない所だけ最小に留める。';
  // every role that reports as the executor carries the same line
  assert.equal(roles.split(line).length - 1, roles.match(/^\s+report: exec\s*$/gm).length);
  // the planner role stays read-only: the plan review reads
  assert.match(roles, /実装はしない。成果物の文書以外のコードを変更しない。/);
});

test('AC-006: the qa template puts a numberless whole row before the floor, and the contract says it is not an AC', () => {
  const qa = read('_docs/standards/templates/qa.md');
  const ac = qa.split('## Acceptance Criteria')[1].split('## Checks')[0];
  assert.match(ac, /^- 全体: /m);
  assert.ok(ac.indexOf('- 全体:') < ac.indexOf('- AC-001:'), 'the whole row is before the floor');
  assert.match(ac, /判定: <実装役以外/);
  const contracts = read('_docs/standards/document_contracts.md');
  assert.match(contracts, /全体の行は AC として読まれず、Checks の表は床の行だけを持つ/);
});

test('IDD-083 AC-006: the qa template does not reference plan.md and says why', () => {
  const qa = read('_docs/standards/templates/qa.md');
  assert.doesNotMatch(qa, /_docs\/plan\//);
  assert.match(qa, /references に plan\.md は書かない/);
});

test('IDD-083 AC-007: the contract asks the harness to rewrite the references and drops the no-update rule', () => {
  const contracts = read('_docs/standards/document_contracts.md');
  assert.match(contracts, /ハーネスが移動と同じ commit で、移した後の path に書き換える/);
  assert.match(contracts, /lane の記録（`qa\.md`・`reference\.md`・`context\.md`、旧い形の lane の `decision\.md`）は plan を参照しない/);
  assert.doesNotMatch(contracts, /参照リンクの更新は不要/);
});

test('IDD-083 AC-014: the planner catalog carries the same work-instruction rule as the code', () => {
  const catalog = read('_meta/prompt-catalog/01-planner.md');
  assert.ok(catalog.includes(WORK_INSTRUCTION_RULE), 'the catalog line matches the code');
  assert.match(catalog, /変更（2026-10-05、IDD-083）/);
});

test('IDD-088: the planner catalog carries the same existing-DEC rule as the code, with no number-only successor', () => {
  const catalog = read('_meta/prompt-catalog/01-planner.md');
  assert.ok(catalog.includes(PLANNER_EXISTING_DEC_RULE), 'the catalog line matches the code');
  assert.match(PLANNER_EXISTING_DEC_RULE, /<後継の DEC の ID>/);
  assert.doesNotMatch(PLANNER_EXISTING_DEC_RULE, /DEC-<後継の番号>/);
  const currentText = catalog.split('````xml')[1].split('````')[0];
  assert.doesNotMatch(currentText, /DEC-<後継の番号>/);
});

const planFile = (wt, rel) => { mkdirSync(dirname(join(wt, rel)), { recursive: true }); writeFileSync(join(wt, rel), '---\ntitle: t\n---\n\n## Tasks\n- `src/a.ts` — 直す\n'); };

test('AC-007 / AC-010: the executor points at the plan when it is there, and keeps its old shape when it is not', () => {
  const { wt } = setup();
  const withoutPlan = executorBrief(rec, wt);
  assert.doesNotMatch(withoutPlan, /<plan>/);
  assert.match(withoutPlan, /決定された契約（DEC）を実装し、条件（AC）を自分で検証する。/);
  assert.ok(withoutPlan.includes(INTENT_PURPOSE), 'the executor carries the purpose');
  planFile(wt, '_docs/plan/app/idd-001/plan.md');
  const withPlan = executorBrief(rec, wt);
  assert.match(withPlan, /<plan>_docs\/plan\/app\/idd-001\/plan\.md<\/plan>/);
  assert.match(withPlan, /作業指示（plan）に沿って実装し、条件（AC）を自分で検証する。/);
});

test('AC-007: a plan already archived is pointed at on the archive side', () => {
  const { wt } = setup();
  planFile(wt, '_docs/archives/plan/app/idd-001/plan.md');
  const brief = executorBrief(rec, wt);
  assert.match(brief, /<plan>_docs\/archives\/plan\/app\/idd-001\/plan\.md<\/plan>/);
});

test('AC-011: a lane with a condition and no decision is implemented; one with neither is left', async () => {
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@l', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@l' };
  Object.assign(process.env, env);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const root = mkdtempSync(join(tmpdir(), 'idd-purpose-exec-'));
  const work = join(root, 'work'); const state = join(root, 'state');
  mkdirSync(work); mkdirSync(state);
  git(work, 'init', '-q', '--initial-branch=main'); put(join(work, 'app.txt'), 'a\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'base');
  git(work, 'checkout', '-qb', 'work-main');
  put(join(work, 'overlay.manifest'), '_docs/\noverlay.manifest\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'overlay');
  put(join(root, 'repos.yaml'), JSON.stringify({ repos: { demo: { github: 't/p', upstream: work, work, work_base: 'work-main', public_base: 'main', lanes_root: join(root, 'lanes'), checks: [], issue_lane: { context: 'personal', source_type_priority: 'github' } } } }));
  put(join(root, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  executor: { role: r }\n');
  Object.assign(process.env, { IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, 'roles.yaml'), IDD_INTENT_DIR: join(root, 'unused') });
  put(join(state, 'backlog.jsonl'), JSON.stringify({ idd_id: 'IDD-001', area: 'demo', title: 'T', context: '' }) + '\n');
  put(join(state, 'lifecycle-demo.jsonl'), [['lane_open'], ['s1_ready'], ['s1_go']].map(([event]) => JSON.stringify({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs: {} })).join('\n') + '\n');
  const lanePath = ensureLaneWorktree('demo', 'IDD-001').path;
  const delivered = [];
  setAgentRunner({ spawn: async () => ({ sessionId: 'E1', model: 'x/y' }), deliver: async (id) => { delivered.push(id); } });

  // decisions empty, one condition: the executor starts
  put(join(lanePath, '_docs/qa/demo/idd-001/qa.md'), '- AC-001: 条件\n');
  const started = await runExec();
  assert.deepEqual(started.started.map((s) => s.sessionId), ['E1'], JSON.stringify(started.skipped));

  // nothing at all: the lane is left with the refusal
  put(join(lanePath, '_docs/qa/demo/idd-001/qa.md'), '');
  put(join(lanePath, '_docs/intent/demo/idd-001/decision.md'), '');
  put(join(state, 'executor-sessions.jsonl'), '');
  put(join(state, 'lifecycle-demo.jsonl'), [['lane_open'], ['s1_ready'], ['s1_go']].map(([event]) => JSON.stringify({ event, idd_id: 'IDD-001', at: '2026-09-01T10:00:00+09:00', attrs: {} })).join('\n') + '\n');
  const none = await runExec();
  assert.deepEqual(none.started, []);
  assert.equal(none.skipped[0].reason, 'contract is empty');
  setAgentRunner(null);
  rmSync(root, { recursive: true, force: true });
});

test('AC-011: a brief with no DEC still opens no broken decisions element', () => {
  const { wt } = setup();
  mkdirSync(join(wt, '_docs/qa/app/idd-001'), { recursive: true });
  writeFileSync(join(wt, '_docs/qa/app/idd-001/qa.md'), '- AC-001: 条件\n');
  const brief = executorBrief(rec, wt);
  assert.match(brief, /<decisions>/);
  assert.match(brief, /<\/decisions>/);
  assert.doesNotMatch(brief, /<item id="DEC-/);
  assert.match(brief, /DEC は後から変える agent のために残す契約/);
});

test('the purpose is one constant: the planner and the executor carry the same words', () => {
  const { wt } = setup();
  for (const brief of [plannerBrief(rec, undefined, wt), executorBrief(rec, wt)]) {
    assert.equal(brief.split(INTENT_PURPOSE).length - 1, 1, 'once');
  }
  assert.ok(existsSync(join(ROOT, '_docs/standards/workflow.md')));
});

test('AC-006: both catalogs carry the renamed philosophy section, and the executor catalog names the lane Purpose section', () => {
  const planner = read('_meta/prompt-catalog/01-planner.md');
  const executor = read('_meta/prompt-catalog/03-executor.md');
  for (const [name, text] of [['01', planner], ['03', executor]]) {
    assert.ok(text.includes(`<${INTENT_WHY_SECTION}>`), `${name} carries the new section name`);
    assert.ok(!/<purpose>\s*\n\s*propter が意図を記録する/.test(text), `${name} keeps no section named purpose`);
    assert.match(text, /変更（2026-10-17、IDD-159）/, `${name} opens with this lane's change line`);
  }
  assert.match(executor, /<purposes>/);
  assert.match(planner, /変更（2026-10-16、IDD-150）/);
});

test('the v2 planner and executor are told not to number an INV, and the standard says the same', () => {
  const { wt } = setup({ area: { work_instruction: 'plan' } });
  assert.ok(plannerBrief(rec, undefined, wt, undefined, 'state').includes(NO_INV_RULE), 'the v2 planner is told');
  // the old shape keeps its own words: its planner still numbers DEC and INV in decision.md
  assert.ok(!plannerBrief(rec, undefined, wt, undefined, 'docs').includes(NO_INV_RULE), 'the old planner is not told');
  const records = read('_docs/standards/records.md');
  assert.match(records, /anchored・why・free に `INV-…` の番号を振らない/);
});
