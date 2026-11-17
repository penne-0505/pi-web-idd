import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { executorBrief, fixBrief, prevResultOf } from '../src/plan/exec.ts';
import { INTENT_PURPOSE } from '../src/plan/prompt-text.ts';
import { INTENT_WHY_SECTION } from '../src/agent/message.ts';
import { plannerBrief } from '../src/plan/prep.ts';
import { resumeBrief } from '../src/plan/resume.ts';
import { buildEnvelope } from '../src/ledger/write.ts';
import { planReviewEnvelope } from '../src/plan/plan-review.ts';
import { reviewFixEnvelope } from '../src/plan/review-loop.ts';
import * as store from '../src/intent/store.ts';
import { tmpDir } from './helpers/tmp.mjs';

function setup() {
  const root = tmpDir('idd-brief-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main' } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  return join(root, 'wt');
}

const rec = { idd_id: 'IDD-1', area: 'me/app', title: 'T', context: '', gh_issue_url: 'https://github.com/me/app/issues/1' };

test('the envelope is propter-system-message and carries no internal fields', () => {
  const wt = setup();
  const texts = {
    planner: plannerBrief(rec),
    executor: executorBrief(rec, wt),
    resume: resumeBrief({ iddId: 'IDD-1', role: 'executor', sessionId: 's', worktree: wt }, 'r'),
    followup: buildEnvelope('info_update', 'IDD-1', '  <message>x</message>'),
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(text.startsWith('<propter-system-message>'), `${name}: root`);
    assert.ok(text.trimEnd().endsWith('</propter-system-message>'), `${name}: close`);
    assert.match(text, /以上のコンテクストで task を行う。/, `${name}: closing line`);
    for (const field of ['type', 'idd-id', 'sent-at']) assert.doesNotMatch(text, new RegExp(`<${field}>[^<\\n]*</${field}>`), `${name}: ${field}`);
    assert.doesNotMatch(text, /\/api\/idd/, `${name}: an endpoint`);
    assert.doesNotMatch(text, /IDD_AGENT_TOKEN/, `${name}: the token name`);
  }
});

test('every section of the executor brief is closed by its own tag', () => {
  const brief = executorBrief(rec, setup());
  for (const tag of ['norms', 'task', 'completion', 'skill-rules', 'records-rules', 'writing-rules', 'question-rules', 'host-rules', 'callback', 'lane', 'contract', 'configured-checks']) {
    assert.equal((brief.match(new RegExp(`<${tag}>`, 'g')) ?? []).length, 1, `<${tag}> opens once`);
    assert.equal((brief.match(new RegExp(`</${tag}>`, 'g')) ?? []).length, 1, `</${tag}> closes once`);
  }
});

test('the lane carries this lane\'s number and the shape of every identifier, so the executor never counts them', () => {
  const lane = executorBrief(rec, setup()).split('<lane>')[1].split('</lane>')[0];
  assert.match(lane, /<lane-number>1<\/lane-number>/);
  assert.match(lane, /`Round 1-&lt;連番&gt;`/);
  assert.match(lane, /`Next ID No` は読まず、書き換えない/);
});

test('the records rules say how the qa round is written, and nothing about R2 (removed 2026-10-22)', () => {
  const records = executorBrief(rec, setup()).split('<records-rules>')[1].split('</records-rules>')[0];
  assert.doesNotMatch(records, /R2/);
  assert.match(records, /Risk を High 以上/);
  assert.match(records, /applied:/);
});

test('AC-003: every executor brief names the MoonBit skill by absolute path, in the first session and in a fix', () => {
  const wt = setup();
  const fix = fixBrief(rec, wt, buildEnvelope('review_fix', 'IDD-1', '  <task>直す</task>'));
  for (const [name, brief] of [['first', executorBrief(rec, wt)], ['fix', fix]]) {
    const section = brief.split('<skill-rules>')[1].split('</skill-rules>')[0];
    assert.match(section, /`~\/\.agents\/skills\/propter-moonbit\/SKILL\.md`/, `${name}: the absolute path`);
    assert.match(section, /MoonBit を書く前に/, `${name}: when to read it`);
  }
  // the planner and the review roles are out of this lane's scope: their briefs keep the section out
  assert.doesNotMatch(plannerBrief(rec), /<skill-rules>/);
});

test('the host rules say heavy tests are run only as far as a claim needs, and a partial run is reported', () => {
  const rules = executorBrief(rec, setup()).split('<host-rules>')[1].split('</host-rules>')[0];
  assert.match(rules, /重いテストや検証（Flutter の全体テストなど）/);
  assert.match(rules, /回した範囲を簡潔に報告に書く/);
});

test('the host rules of the executor and the planner say how to run a process that does not end', () => {
  const wt = setup();
  for (const brief of [executorBrief(rec, wt), plannerBrief(rec)]) {
    const rules = brief.split('<host-rules>')[1].split('</host-rules>')[0];
    assert.match(rules, /常駐する ?process/);
    assert.match(rules, /`timeout -k 10 N`（N は秒）を付けて/);
    assert.doesNotMatch(rules, /--foreground/);
  }
});

test('the executor host rules put a server started for a check under the same timeout, and stop it by its own PID', () => {
  const rules = executorBrief(rec, setup()).split('<host-rules>')[1].split('</host-rules>')[0];
  const server = rules.split('\n').find((l) => l.includes('未使用の port'));
  assert.ok(server);
  assert.match(server, /`timeout -k 10 N`/);
  assert.match(server, /PID だけ/);
});

test('the planner is told only the records-scope checks, the executor all of them', () => {
  const root = tmpDir('idd-brief-checks-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main', checks: [{ name: 'typecheck', command: 'tsc', required: true, scope: 'public' }, { name: 'docs', command: 'check-docs', required: false, scope: 'records' }] } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  const planner = plannerBrief(rec);
  assert.match(planner, /"name":"docs"/);
  assert.doesNotMatch(planner, /"name":"typecheck"/);
  const executor = executorBrief(rec, join(root, 'wt'));
  assert.match(executor, /"name":"typecheck"/);
  assert.match(executor, /"name":"docs"/);
});

test('the planner deliverables name the right places, and the lane number is an element', () => {
  const brief = plannerBrief(rec);
  assert.match(brief, /<decision path="_docs\/intent\/[^"]+\/decision\.md"/);
  assert.match(brief, /<qa path="_docs\/qa\/[^"]+\/qa\.md"/);
  assert.match(brief, /<reference path="_docs\/reference\/[^"]+\/reference\.md"/);
  assert.match(brief, /<lane-number>1<\/lane-number>/);
  assert.match(brief, /`DEC-1-&lt;連番&gt;`/);
  assert.doesNotMatch(brief, /&lt;lane-number&gt;/);
});

test('the report verbs of the stage are shown', () => {
  const wt = setup();
  const planner = plannerBrief(rec);
  assert.match(planner, /idd report questions/);
  assert.match(planner, /idd report plan/);
  const executor = executorBrief(rec, wt);
  for (const verb of ['progress', 'result', 'questions']) assert.match(executor, new RegExp(`idd report ${verb}`));
  const taskOf = (xml) => xml.split('<task>')[1].split('</task>')[0];
  assert.match(planReviewEnvelope('IDD-1', [{ severity: 'must', path: 'a', claim: 'c', evidence: '' }], ['r']), /idd report plan/);
  assert.match(taskOf(reviewFixEnvelope('IDD-1', 1, [])), /idd report result/);
  assert.equal(
    resumeBrief({ iddId: 'IDD-1', role: 'planner', sessionId: 's', worktree: wt }, 'r').includes('idd report plan'),
    true,
  );
  assert.equal(
    resumeBrief({ iddId: 'IDD-1', role: 'executor', sessionId: 's', worktree: wt }, 'r').includes('idd report result'),
    true,
  );
});

function checkFixture({ timeout } = {}) {
  const root = tmpDir('idd-brief-wrapped-');
  const state = join(root, 'state'); mkdirSync(state);
  const check = (name, command, extra = '') => `{ name: '${name}', command: '${command}', required: true${extra} }`;
  writeFileSync(join(root, 'repos.yaml'), `repos:\n  me/app:\n    upstream: ${join(root, 'u')}\n    work: ${join(root, 'w')}\n    public_base: main\n    checks:\n      - ${check('typecheck', 'tsc', `, timeout_minutes: ${timeout ?? 10}`)}\n      - ${check('docs', 'check-docs', ", scope: 'records'")}\n`);
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  return join(root, 'wt');
}

test('a 5-minute claude executor brief lists the checks by name with their limits, and drops the command JSON', () => {
  const wt = checkFixture();
  const brief = executorBrief(rec, wt, { run: { harness: 'claude', cacheTtl: '5m' } });
  assert.match(brief, /idd wait-run --check typecheck/);
  assert.match(brief, /idd wait-run --check docs/);
  assert.match(brief, /timeout_minutes="10"/);
  assert.doesNotMatch(brief, /<configured-checks>/);
  assert.doesNotMatch(brief, /tsc/);
  assert.match(brief, /全部を回す指示ではない/);
});

test('a 1-hour claude brief and a pi brief keep the command JSON and list no checks to wrap', () => {
  const wt = checkFixture();
  for (const run of [{ harness: 'claude', cacheTtl: '1h' }, { harness: 'pi', cacheTtl: '5m' }, undefined]) {
    const brief = run ? executorBrief(rec, wt, { run }) : executorBrief(rec, wt);
    assert.match(brief, /<configured-checks>/, `${JSON.stringify(run)}: the JSON stays`);
    assert.doesNotMatch(brief, /<checks>/);
  }
});

test('a 5-minute claude planner brief wraps only the records checks; the executor wraps all of them', () => {
  const wt = checkFixture();
  const run = { harness: 'claude', cacheTtl: '5m' };
  const planner = plannerBrief(rec, { dec: 801, inv: 401 }, wt, run);
  assert.match(planner, /idd wait-run --check docs/);
  assert.doesNotMatch(planner, /idd wait-run --check typecheck/);
  assert.doesNotMatch(planner, /<configured-checks>/);
  const executor = executorBrief(rec, wt, { run });
  assert.match(executor, /idd wait-run --check typecheck/);
  assert.match(executor, /idd wait-run --check docs/);
});

const ESLINT_INCREMENT = { increments: [{ name: 'eslint-warnings', command: 'node_modules/.bin/eslint . -f json', count: 'eslint-json', required: true, timeout_minutes: 10 }] };

/** a repo whose lanes land on `feat/trunk`, set up with one line; `declare(extra)` rewrites the repo's own settings */
function trunkRepo(prefix) {
  const root = tmpDir(prefix);
  const state = join(root, 'state'); mkdirSync(state);
  const declare = (extra) => writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': {
    upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main', work_base: 'feat/trunk',
    setup: ['ln -sfn ~/w/node_modules node_modules'], ...extra,
  } } }));
  declare({});
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  return { root, wt: join(root, 'wt'), declare };
}

/** the first brief and the fix brief of a lane, which carry the same sections */
const firstAndFix = (wt) => [['first', executorBrief(rec, wt)], ['fix', fixBrief(rec, wt, buildEnvelope('review_fix', 'IDD-1', '  <task>直す</task>'))]];

test('a repo that declares increments has the executor compare them against the mainline before it reports; a repo without keeps its shape', () => {
  const { wt, declare } = trunkRepo('idd-brief-increments-');
  declare(ESLINT_INCREMENT);
  for (const [name, brief] of firstAndFix(wt)) {
    const completion = brief.split('<completion>')[1].split('</completion>')[0];
    assert.match(completion, /increments の数が本流より増えていないこと/, `${name}: the completion names the comparison`);
    assert.equal((brief.match(/<increments>/g) ?? []).length, 1, `${name}: the section opens once`);
    const section = brief.split('<increments>')[1].split('</increments>')[0];
    assert.match(section, /`git merge --no-edit feat\/trunk` で取り込み（rebase 禁止）/, `${name}: the mainline the lane lands on, merged first`);
    assert.match(section, /`git worktree add --detach _meta\/scratch\/mainline feat\/trunk`/, `${name}: the mainline copy`);
    assert.match(section, /`git worktree remove --force _meta\/scratch\/mainline`/, `${name}: the copy is removed`);
    assert.match(section, /repo の setup（`ln -sfn ~\/w\/node_modules node_modules`）/, `${name}: the copy is set up the way the checks' copy is`);
    assert.match(section, /<increment name="eslint-warnings" timeout_minutes="10">node_modules\/\.bin\/eslint \. -f json \| node -e '/, `${name}: the declared command with the count pipe`);
    assert.match(section, /warningCount/, `${name}: the eslint-json count is the warnings summed`);
    assert.doesNotMatch(section, /[<>]=|=>/, `${name}: the pipe carries no character the escaping would change`);
  }
  // the planner does not report a result: its brief keeps the section out
  assert.doesNotMatch(plannerBrief(rec), /<increments>/);
  // a repo that declares no increment: no section, and the completion keeps its two lines
  const plain = executorBrief(rec, setup());
  assert.doesNotMatch(plain, /<increments>/);
  assert.doesNotMatch(plain, /increments の数/);
});

test('a worktree that holds a structure declaration has the executor count the structure against the mainline copy before it reports; one without keeps its shape', () => {
  const { root, wt, declare } = trunkRepo('idd-brief-structure-');
  mkdirSync(join(wt, 'config'), { recursive: true });
  writeFileSync(join(wt, 'config', 'structure.yaml'), 'command: [node, scan.ts]\nblocking: [duplicate-tokens, layer-violations]\n');
  for (const [name, brief] of firstAndFix(wt)) {
    const completion = brief.split('<completion>')[1].split('</completion>')[0];
    assert.match(completion, /構造の数（宣言の blocking）が本流より増えていないこと/, `${name}: the completion names the comparison`);
    assert.equal((brief.match(/<structure>/g) ?? []).length, 1, `${name}: the section opens once`);
    const section = brief.split('<structure>')[1].split('</structure>')[0];
    const told = {
      'nothing uncommitted is left out of the count': /変更を commit して追跡されていない file を残さず/,
      'the mainline the lane lands on, merged first': /`git merge --no-edit feat\/trunk` で取り込み（rebase 禁止）/,
      'the mainline copy, its own place': /`git worktree add --detach _meta\/scratch\/mainline-structure feat\/trunk`/,
      'the copy is not prepared, only its dependencies linked': /repo の setup は回さない.*`ln -s "\$\(realpath node_modules\)" _meta\/scratch\/mainline-structure\/node_modules`/,
      'the copy is removed': /`git worktree remove --force _meta\/scratch\/mainline-structure`/,
      'the copy\'s declaration and command, not the worktree\'s': /複製の `config\/structure\.yaml` の `command`/,
      'both trees are counted': /`IDD_STRUCTURE_ROOT`（数える tree の絶対 path。worktree と複製の 2 回）/,
      'the declaration is the copy\'s': /`IDD_STRUCTURE_DECL`（複製の `config\/structure\.yaml` の絶対 path）/,
      'the blocking counts must not rise': /blocking の数がどれも増えていないこと/,
      'the per-file listing': /`IDD_STRUCTURE_FILES=1`/,
      'the listing adds up to the count': /合計は `duplicate-tokens` に一致する/,
    };
    for (const [why, pattern] of Object.entries(told)) assert.match(section, pattern, `${name}: ${why}`);
    assert.doesNotMatch(brief, /<increments>/, `${name}: no increment declared, no increments section`);
  }
  // a repo that declares increments too: each section cuts, uses and removes its own copy, so neither removes the other's
  declare(ESLINT_INCREMENT);
  const both = executorBrief(rec, wt);
  const incSection = both.split('<increments>')[1].split('</increments>')[0];
  const strSection = both.split('<structure>')[1].split('</structure>')[0];
  assert.ok(both.indexOf('<increments>') < both.indexOf('<structure>'), 'the sections come in a fixed order');
  assert.doesNotMatch(incSection, /mainline-structure/, 'the increments section never touches the structure copy');
  assert.doesNotMatch(strSection, /--detach _meta\/scratch\/mainline feat|remove --force _meta\/scratch\/mainline`/, 'the structure section never touches the increments copy');
  // the planner reports no result: its brief keeps the section out; a worktree without a declaration keeps the shape
  assert.doesNotMatch(plannerBrief(rec), /<structure>/);
  const plain = executorBrief(rec, join(root, 'bare'));
  assert.doesNotMatch(plain, /<structure>/);
  assert.doesNotMatch(plain, /構造の数/);
});

test('AC-012: the executor brief tells the evidence form, and the fix brief carries the previous evidence', () => {
  const wt = setup();
  const brief = executorBrief(rec, wt);
  assert.match(brief, /--evidence 'AC-001=<テストの名前か、実行した命令と結果>'/);
  assert.match(brief, /evidence の無い verified は確認済みにならない。/);
  writeFileSync(join(process.env.IDD_STATE_DIR, 'lifecycle-me-app.jsonl'),
    JSON.stringify({ event: 's2_result', idd_id: 'IDD-1', at: '2026-10-13T00:00:00Z', attrs: { outcome: 'partial', changed_files: ['a.ts'], commit_count: 1, qa_verified: ['AC-001'], qa_unverified: ['AC-002'], qa_evidence: { 'AC-001': 'ran the suite: 12 passed' }, side_findings: [] } }) + '\n');
  const prev = prevResultOf('IDD-1');
  assert.deepEqual(prev.evidence, { 'AC-001': 'ran the suite: 12 passed' });
  const fix = fixBrief(rec, wt, buildEnvelope('review_fix', 'IDD-1', '  <task>直す</task>'));
  assert.match(fix, /<evidence>AC-001: ran the suite: 12 passed<\/evidence>/);
  assert.match(fix, /--evidence/);
});

test('AC-007/AC-009: the plan is its own escaped section, with how the implementer treats it', () => {
  const wt = setup();
  const plan = '直し方: a < b & c > d\n触る: x.ts の f()\n';
  const fix = fixBrief(rec, wt, buildEnvelope('review_fix', 'IDD-1', '  <task>直す</task>'), undefined, plan);
  assert.match(fix, /<fix-plan>/);
  assert.match(fix, /a &lt; b &amp; c &gt; d/, 'the plan body is escaped');
  assert.doesNotMatch(fix, /a < b & c > d/, 'the raw body never breaks the brief XML');
  assert.match(fix, /<fix-plan-guidance>/);
  assert.match(fix, /案に従う。外れるときは、理由を `idd report result` の side_findings に書く。/);
  assert.match(fix, /案と人の文（instruction・user-note）が食い違えば、人の文に従う。/);
  // without a plan the brief keeps the shape it had (the plan section and its words do not show)
  const plain = fixBrief(rec, wt, buildEnvelope('review_fix', 'IDD-1', '  <task>直す</task>'));
  assert.doesNotMatch(plain, /<fix-plan>/);
  assert.doesNotMatch(plain, /<fix-plan-guidance>/);
});

test('AC-002: the lane context document is in the contract and the task appends to it, in the first brief and in a fix', () => {
  const wt = setup();
  mkdirSync(join(wt, '_docs/context/app/idd-1'), { recursive: true });
  writeFileSync(join(wt, '_docs/context/app/idd-1/context.md'), '# c\n');
  const fix = fixBrief(rec, wt, buildEnvelope('review_fix', 'IDD-1', '  <task>直す</task>'));
  for (const [name, brief] of [['first', executorBrief(rec, wt)], ['fix', fix]]) {
    assert.match(brief, /<lane-context>_docs\/context\/app\/idd-1\/context\.md<\/lane-context>/, `${name}: the contract names the document`);
    const task = brief.split('<task>')[1].split('</task>')[0];
    assert.match(task, /追記し、commit する/, `${name}: the task says to append and commit`);
    assert.match(task, /前の巡が書いた事実は書き換えない/, `${name}: the earlier rounds are never rewritten`);
  }
});

test('AC-008: the person\'s instruction and note stay as written next to the plan', () => {
  const wt = setup();
  const body = [
    '  <task>直す</task>',
    '  <user-note>人が書いた補足 &lt;そのまま&gt;</user-note>',
    '  <instruction>型を揃える</instruction>',
  ].join('\n');
  const fix = fixBrief(rec, wt, body, undefined, '案\n');
  assert.match(fix, /<instruction>型を揃える<\/instruction>/, 'the instruction is kept word for word');
  assert.match(fix, /人が書いた補足 &lt;そのまま&gt;/, 'the person\'s note is kept word for word');
  assert.match(fix, /<fix-plan>/);
});

test('AC-017: the unwritten records carry the draft whole and the disposal line, escaped, and an old record keeps its shape', () => {
  const wt = setup();
  const state = process.env.IDD_STATE_DIR;
  writeFileSync(join(state, 'lifecycle-test.jsonl'), [
    { event: 's1_ready', idd_id: 'IDD-1', at: '2026-10-14T00:00:00Z', attrs: { records_shape: 'state' } },
    { event: 's1_go', idd_id: 'IDD-1', at: '2026-10-14T00:10:00Z', attrs: {} },
    { event: 's2_plan_written', idd_id: 'IDD-1', at: '2026-10-14T00:11:00Z', attrs: { written: [], skipped: [
      { op: 'choice:0', reason: 'P-9 が active ではありません', draft: { purpose: 'P-9', forms: { chosen: 'a < b' }, place: [{ path: 'src/a.ts', kind: 'file' }], why: 'w', anchored: 'a', free: 'f' } },
      { op: 'existing:C-1', reason: 'もう unconfirmed ではない', existing: { id: 'C-1', effect: 'drop', grounds: '現物と違う' } },
      { op: 'existing:DEC-9', reason: 'もう unconfirmed ではない' },
    ] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const brief = executorBrief(rec, wt);
  const block = brief.split('<unwritten-records>')[1].split('</unwritten-records>')[0];
  assert.match(block, /choice:0/);
  assert.match(block, /<chosen>a &lt; b<\/chosen>/);
  assert.match(block, /<purpose>P-9<\/purpose>/);
  assert.match(block, /<place>src\/a\.ts（file）<\/place>/);
  assert.match(block, /<why>w<\/why>/);
  assert.match(block, /<anchored>a<\/anchored>/);
  assert.match(block, /<free>f<\/free>/);
  assert.match(block, /intent raise choice --file/);
  assert.match(block, /side_findings/);
  assert.match(block, /<id>C-1<\/id>/);
  assert.match(block, /<effect>drop<\/effect>/);
  assert.match(block, /<grounds>現物と違う<\/grounds>/);
  assert.match(block, /確認・捨てる・Supersede/);
  assert.match(block, /<item op="existing:DEC-9">もう unconfirmed ではない<\/item>/, 'an old record with no body keeps the op and the reason');
});

/** a v2 lane's state: a repo, a state dir, a worktree, and the lifecycle rows that mark the shape and the GO */
function setupV2() {
  const root = tmpDir('idd-brief-v2-');
  const state = join(root, 'state'); mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main' } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  const wt = join(root, 'wt'); mkdirSync(wt);
  return { root, state, wt };
}

const seedLifecycle = (state, rows) => appendFileSync(join(state, 'lifecycle-test.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

test('AC-001 / AC-002: a v2 brief lists each Purpose once and links every Choice to it, in the first brief and in a fix', async () => {
  const { state, wt } = setupV2();
  const first = await store.raisePurpose({ repo: 'me/app', actor: { session: 's1' }, statement: '題が固定の高さからはみ出さないようにしたい。なぜなら重なると読めないからである。', origin: '常設' });
  const second = await store.raisePurpose({ repo: 'me/app', actor: { session: 's1' }, statement: '状態を 1 か所に集めたい。', origin: '常設' });
  assert.equal(first.ok && second.ok, true, first.error ?? second.error);
  const body = (purpose, chosen) => ({ purpose, forms: { chosen, rejected: [{ form: '捨てる', fails_because: '読めない' }] }, place: [{ path: 'src/a.ts', kind: 'file' }], why: 'w', anchored: 'a' });
  const c1 = await store.raiseChoice({ repo: 'me/app', actor: { lane: 'IDD-1' }, body: body(first.id, '収める') });
  const c2 = await store.raiseChoice({ repo: 'me/app', actor: { lane: 'IDD-1' }, body: body(first.id, '伸ばさない') });
  const c3 = await store.raiseChoice({ repo: 'me/app', actor: { lane: 'IDD-1' }, body: body(second.id, '集める') });
  assert.equal(c1.ok && c2.ok && c3.ok, true, c1.error ?? c2.error ?? c3.error);
  seedLifecycle(state, [
    { event: 'lane_open', idd_id: 'IDD-1', at: '2026-10-17T00:00:00Z', attrs: {} },
    { event: 's1_ready', idd_id: 'IDD-1', at: '2026-10-17T00:01:00Z', attrs: { records_shape: 'state' } },
    { event: 's1_go', idd_id: 'IDD-1', at: '2026-10-17T00:02:00Z', attrs: {} },
  ]);
  const brief = executorBrief(rec, wt);
  const purposes = brief.split('<purposes>')[1].split('</purposes>')[0];
  assert.equal((purposes.match(/<purpose id=/g) ?? []).length, 2, 'one entry per Purpose, even when two Choices share one');
  assert.ok(purposes.includes(`<purpose id="${first.id}" status="active">題が固定の高さからはみ出さないようにしたい。なぜなら重なると読めないからである。</purpose>`), purposes);
  assert.ok(purposes.includes(`<purpose id="${second.id}" status="active">状態を 1 か所に集めたい。</purpose>`), purposes);
  const choices = brief.split('<choices>')[1].split('</choices>')[0];
  for (const c of [c1, c2]) assert.ok(choices.includes(`<choice id="${c.id}">\n        <purpose>${first.id}</purpose>`), `choice ${c.id} links ${first.id}`);
  assert.ok(choices.includes(`<choice id="${c3.id}">\n        <purpose>${second.id}</purpose>`), `choice ${c3.id} links ${second.id}`);
  // AC-002: the fix session starts without the first session's conversation, so the same section and links reach it
  const fix = fixBrief(rec, wt, buildEnvelope('review_fix', 'IDD-1', '  <task>直す</task>'));
  const fixPurposes = fix.split('<purposes>')[1].split('</purposes>')[0];
  assert.equal((fixPurposes.match(/<purpose id=/g) ?? []).length, 2);
  assert.ok(fixPurposes.includes(first.id) && fixPurposes.includes(second.id));
  assert.ok(fix.split('<choices>')[1].split('</choices>')[0].includes(`<purpose>${first.id}</purpose>`));
});

test('AC-005: the philosophy section is one name in every brief, and it is not `purpose`', () => {
  const wt = setup();
  for (const brief of [plannerBrief(rec), executorBrief(rec, wt)]) {
    const at = brief.indexOf(INTENT_PURPOSE);
    assert.ok(at > 0, 'the philosophy is in the brief');
    const section = /<([a-z][a-z-]*)>\n\s+propter が意図を記録する/.exec(brief);
    assert.ok(section, 'the philosophy has a section of its own');
    assert.equal(section[1], INTENT_WHY_SECTION);
    assert.notEqual(section[1], 'purpose', 'the lane Purpose owns the word `purpose` alone');
  }
});
