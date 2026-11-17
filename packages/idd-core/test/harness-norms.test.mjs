import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HARNESS_NORMS, NORM_STAGES, normText, normsFor } from '../src/plan/harness-norms.ts';
import { executorBrief } from '../src/plan/exec.ts';
import { followupTaskId } from '../src/plan/followups.ts';
import { plannerBrief } from '../src/plan/prep.ts';

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function setup(workInstruction) {
  const root = mkdtempSync(join(tmpdir(), 'idd-norms-'));
  temps.push(root);
  const state = join(root, 'state'); mkdirSync(state);
  const repo = { upstream: join(root, 'u'), work: join(root, 'w'), public_base: 'main' };
  if (workInstruction) repo.work_instruction = workInstruction;
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos: { 'me/app': repo } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, 'repos.yaml') });
  return join(root, 'wt');
}

const rec = { idd_id: 'IDD-1', area: 'me/app', title: 'T', context: '', gh_issue_url: 'https://github.com/me/app/issues/1' };
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('no norm and no brief tells the lane about R2: it was removed (2026-10-22)', () => {
  assert.equal(HARNESS_NORMS.find((n) => n.id === 'r2'), undefined);
  for (const shape of ['docs', 'state']) {
    for (const who of ['planner', 'executor']) for (const t of normsFor(who, shape)) assert.doesNotMatch(t, /R2/, `${who} ${shape}`);
  }
});

test('the list names the lane identifiers the planner writes, against the repo\'s max-plus-one rule', () => {
  const norm = HARNESS_NORMS.find((n) => n.id === 'lane-ids');
  assert.ok(norm);
  assert.equal(norm.toldTo, 'planner');
  assert.match(norm.repo, /最大値 \+ 1/);
  assert.match(norm.harness, /DEC-<lane の番号>-<連番>/);
  assert.match(norm.harness, /INV-<lane の番号>-<連番>/);
  assert.match(norm.harness, /1 から数える/);
  assert.doesNotMatch(norm.harness, /帯/);
});

test('the list names the lane identifiers the executor writes for every record type, and says it leaves Next ID No alone', () => {
  const norm = HARNESS_NORMS.find((n) => n.id === 'lane-record-ids');
  assert.ok(norm);
  assert.equal(norm.toldTo, 'executor');
  assert.match(norm.repo, /Next ID No/);
  assert.match(norm.harness, /Round <lane の番号>-<連番>/);
  assert.match(norm.harness, /<Area>-<種別>-<lane の番号>-<連番>/);
  assert.match(norm.harness, /この lane が書いたものだけを数える/);
  assert.match(norm.harness, /`Next ID No` は読まず、書き換えない/);
  assert.doesNotMatch(norm.harness, /帯/);
});

test('the executor lane carries the lane number and the shape of every identifier it writes', () => {
  const lane = unescape(executorBrief(rec, setup()).split('<lane>')[1].split('</lane>')[0]);
  assert.match(lane, /<lane-number>1<\/lane-number>/);
  assert.match(lane, /`Round 1-<連番>`/);
  assert.match(lane, /`Next ID No` は読まず、書き換えない/);
  assert.doesNotMatch(lane, /<todo-band>|<round-band>|帯/);
});

test('every norm has its own id and says both what the repo asks and what the harness does instead', () => {
  assert.equal(new Set(HARNESS_NORMS.map((n) => n.id)).size, HARNESS_NORMS.length);
  for (const n of HARNESS_NORMS) {
    assert.ok(n.repo.trim(), `${n.id}: repo`);
    assert.ok(n.harness.trim(), `${n.id}: harness`);
  }
});

test('normsFor keeps the one-audience points apart, and a both-audience point reaches either role', () => {
  const plannerOnly = HARNESS_NORMS.filter((n) => n.toldTo === 'planner').map((n) => n.harness);
  const executorOnly = HARNESS_NORMS.filter((n) => n.toldTo === 'executor').map((n) => n.harness);
  assert.ok(plannerOnly.length > 0);
  assert.ok(executorOnly.length > 0);
  assert.ok(!plannerOnly.some((t) => executorOnly.includes(t)));
  assert.ok(!plannerOnly.some((t) => normsFor('executor').includes(t)));
  assert.ok(!executorOnly.some((t) => normsFor('planner').includes(t)));
  const both = HARNESS_NORMS.filter((n) => n.toldTo === 'both').map((n) => n.harness);
  assert.ok(both.length > 0);
  for (const t of both) {
    assert.ok(normsFor('planner').includes(t));
    assert.ok(normsFor('executor').includes(t));
  }
});

test('the list names the source TODO as one point, told to both the planner and the executor, and the other two keep their audience (AC-001)', () => {
  const points = HARNESS_NORMS.filter((n) => n.id === 'todo-source');
  assert.equal(points.length, 1);
  assert.equal(points[0].toldTo, 'both');
  assert.ok(points[0].repo.trim());
  assert.ok(points[0].harness.trim());
  assert.ok(normsFor('planner').includes(points[0].harness));
  assert.ok(normsFor('executor').includes(points[0].harness));
  assert.deepEqual(
    Object.fromEntries(HARNESS_NORMS.filter((n) => n.id !== 'todo-source').map((n) => [n.id, n.toldTo])),
    { 'lane-ids': 'planner', 'lane-record-ids': 'executor' },
  );
});

test('the source-TODO point says the fields are not rewritten and the lane\'s record place may differ from the item\'s Area (AC-002)', () => {
  const t = normText('todo-source');
  assert.match(t, /ハーネスが決めるので、[^。]*Area と違ってよい/);
  assert.match(t, /ID・Area と Plan \/ Intent \/ QA の欄は書き換えず/);
  assert.match(t, /lane の記録に向ける作業を計画にも書かない/);
});

test('the source-TODO point says the four conditions for deleting, what is not waited for, and what happens otherwise (AC-003)', () => {
  const t = normText('todo-source');
  assert.match(t, /Steps が済み/);
  assert.match(t, /Acceptance Criteria を全部満たし/);
  assert.match(t, /Intent Delta のある QA round/);
  assert.match(t, /verdict が PASS/);
  assert.match(t, /TODO から消す/);
  assert.match(t, /作業指示の archive はハーネスが後で行うので待たない/);
  assert.doesNotMatch(t, /R2/);
  assert.match(t, /一部だけ満たしたときは項目を残し、済んだ Steps に印を付ける/);
  assert.match(t, /消した後の巡で条件が崩れたら項目を戻す/);
});

test('the source-TODO point says a lane whose brief names no ID deletes nothing (AC-013)', () => {
  assert.match(normText('todo-source'), /brief が項目を名指さない lane では項目を消さない/);
});

test('the planner brief carries the source-TODO point whether or not the repo asks for a work instruction (AC-004)', () => {
  for (const wi of [undefined, 'plan']) {
    const brief = unescape(plannerBrief(rec, undefined, setup(wi)));
    assert.ok(brief.includes(normText('todo-source')), `work_instruction: ${wi}`);
  }
});

test('the executor brief carries the source-TODO point in a plan lane and in a lane without one (AC-005)', () => {
  const noPlan = unescape(executorBrief(rec, setup()));
  assert.ok(noPlan.includes(normText('todo-source')));
  const wt = setup();
  mkdirSync(join(wt, '_docs/plan/app/idd-1'), { recursive: true });
  writeFileSync(join(wt, '_docs/plan/app/idd-1/plan.md'), '# plan');
  const withPlan = unescape(executorBrief(rec, wt));
  assert.ok(withPlan.includes(normText('todo-source')));
  assert.match(withPlan, /<plan>_docs\/plan\/app\/idd-1\/plan\.md<\/plan>/);
});

test('the executor brief names the TODO task the intake names, read as the follow-ups\' write target is (AC-012)', () => {
  const named = { ...rec, title: 'IddCore-Enhance-751: 何か' };
  assert.equal(followupTaskId({ title: named.title, context: named.context }), 'IddCore-Enhance-751');
  const lane = executorBrief(named, setup()).split('<lane>')[1].split('</lane>')[0];
  assert.match(lane, /<source-todo>IddCore-Enhance-751<\/source-todo>/);
  const plain = executorBrief(rec, setup()).split('<lane>')[1].split('</lane>')[0];
  assert.doesNotMatch(plain, /<source-todo>/);
  const fix = executorBrief(named, setup(), { fix: { task: ['直す。'], instruction: '指示' } }).split('<lane>')[1].split('</lane>')[0];
  assert.match(fix, /<source-todo>IddCore-Enhance-751<\/source-todo>/);
});

test('the planner lane carries the lane number and the DEC / INV shape', () => {
  const brief = unescape(plannerBrief(rec));
  assert.match(brief, /<lane-number>1<\/lane-number>/);
  assert.match(brief, /`DEC-1-<連番>`/);
  assert.match(brief, /`INV-1-<連番>`/);
  assert.doesNotMatch(brief, /<dec-band>|<inv-band>/);
});

test('the norms band line goes to the stages that review or judge the lane\'s own diff, not to a map or the device check', () => {
  for (const s of ['blind', 'final', 'triage', 'confirm']) assert.ok(NORM_STAGES.has(s), s);
  for (const s of ['map', 'device', 'feedback', 'feedback_confirm', 'feedback_leftovers']) assert.ok(!NORM_STAGES.has(s), s);
});

test('both briefs name the writing skill in the user\'s place, not a repo path', () => {
  const wt = setup();
  for (const brief of [plannerBrief(rec), executorBrief(rec, wt)]) {
    assert.match(brief, /~\/\.agents\/skills\/propter-writing\/SKILL\.md/);
    assert.doesNotMatch(brief, /\.agents\/skills\/writing\/SKILL\.md/);
  }
});
