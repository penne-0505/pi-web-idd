import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ORDER_WAIT_HOURS, LEGACY_MAX_FIX_ROUNDS, parseGranularityStage, parsePipelineConcurrency, parseReviewPolicy, parseStallWatchPolicy, pipelineSlotDeclared, pipelineSlotSize, pipelineSnapshot } from '../src/config/pipeline.ts';
import { shippedConfigSkip } from './helpers/shipped-config.mjs';
import { tmpDir } from './helpers/tmp.mjs';

test('pipeline concurrency is read per slot and ignores malformed values', () => {
  const yaml = 'models:\n  x-y:\n    model: x/y\nroles:\n  p: { model: x-y }\npipeline:\n  planner: { role: p, concurrency: 3 }\n  executor: { role: p, concurrency: "2" }\n';
  assert.equal(parsePipelineConcurrency(yaml, 'planner'), 3);
  assert.equal(parsePipelineConcurrency(yaml, 'executor'), undefined);
  assert.equal(parsePipelineConcurrency(yaml, 'reviewer'), undefined);
  assert.equal(parsePipelineConcurrency('', 'planner'), undefined);
});

test('the review policy left out of roles.yaml reads as the loop always behaved: that is its rollback', () => {
  const p = parseReviewPolicy('models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  review_blind: { roles: [r] }\n');
  assert.deepEqual(p, {
    roles: ['r'], extras: { first_round: 0, high_risk: 0 }, extraRoles: { first_round: [], high_risk: [] },
    highRiskWhen: 'first', finalExtra: 'high',
    finalWhen: 'always', finalScope: 'whole', afterMerge: 'whole', maxFixRounds: LEGACY_MAX_FIX_ROUNDS, shouldDefault: 'fix', maxShouldFix: 2,
    orderWaitHours: DEFAULT_ORDER_WAIT_HOURS, orderExcludeFiles: ['TODO.md'], executorStillSeconds: 0, fixPlanSkipWhenHow: false,
  });
  assert.deepEqual(parseReviewPolicy(''), { ...p, roles: [] });
});

test('each review policy key reads both of its values, and a value it does not know reads as the rollback', () => {
  const yaml = (blocks) => `models:\n  x-y:\n    model: x/y\n  x-o:\n    model: x/o\nroles:\n  a: { model: x-y }\n  o: { model: x-o }\npipeline:\n${blocks}`;
  const on = parseReviewPolicy(yaml([
    '  review_blind: { roles: [a], first_round_extra: [o], high_risk_extra: [o, a], concurrency: 3 }',
    '  review_final: { when: behaviour, scope: increment }',
    '  review_loop: { max_fix_rounds: 2, should_default: followup, after_merge: conflict }',
  ].join('\n') + '\n'));
  assert.deepEqual(on.extraRoles, { first_round: ['o'], high_risk: ['o'] }, 'an extra already among the roles adds nothing');
  assert.deepEqual([on.finalWhen, on.finalScope, on.afterMerge, on.maxFixRounds, on.shouldDefault], ['behaviour', 'increment', 'conflict', 2, 'followup']);
  // the third value and the should cap: the value reads, and a malformed cap reads as the default
  const triage = parseReviewPolicy(yaml('  review_blind: { roles: [a] }\n  review_loop: { should_default: triage, max_should_fix: 3 }\n'));
  assert.deepEqual([triage.shouldDefault, triage.maxShouldFix], ['triage', 3]);
  const oddCap = parseReviewPolicy(yaml('  review_blind: { roles: [a] }\n  review_loop: { max_should_fix: 0 }\n'));
  assert.equal(oddCap.maxShouldFix, 2);
  // the high-risk role's round: `last` (the rollback's `first`, and a value it does not know, read as the rollback)
  const last = parseReviewPolicy(yaml('  review_blind: { roles: [a], high_risk_extra: [o], high_risk_when: last }\n'));
  assert.equal(last.highRiskWhen, 'last');
  const oddKey = parseReviewPolicy(yaml('  review_blind: { roles: [a], high_risk_extra: [o], high_risk_when: middle }\n'));
  assert.equal(oddKey.highRiskWhen, 'first');
  // final_extra: `all` adds the extra to every lane's final; `high` (and a value it does not know, or none) keeps it to High lanes
  assert.equal(parseReviewPolicy(yaml('  review_blind: { roles: [a], high_risk_extra: [o], high_risk_when: last, final_extra: all }\n')).finalExtra, 'all');
  assert.equal(parseReviewPolicy(yaml('  review_blind: { roles: [a], high_risk_extra: [o], high_risk_when: last, final_extra: high }\n')).finalExtra, 'high');
  assert.equal(parseReviewPolicy(yaml('  review_blind: { roles: [a], high_risk_extra: [o], high_risk_when: last, final_extra: everyone }\n')).finalExtra, 'high');
  assert.equal(parseReviewPolicy(yaml('  review_blind: { roles: [a], high_risk_extra: [o], high_risk_when: last }\n')).finalExtra, 'high');
  const off = parseReviewPolicy(yaml([
    '  review_blind: { roles: [o] }',
    '  review_final: { when: always, scope: whole }',
    '  review_loop: { max_fix_rounds: 8, should_default: fix, after_merge: whole }',
  ].join('\n') + '\n'));
  assert.deepEqual([off.finalWhen, off.finalScope, off.afterMerge, off.maxFixRounds, off.shouldDefault], ['always', 'whole', 'whole', 8, 'fix']);
  const odd = parseReviewPolicy(yaml('  review_final: { when: sometimes, scope: half }\n  review_loop: { max_fix_rounds: 0, should_default: maybe }\n'));
  assert.deepEqual([odd.finalWhen, odd.finalScope, odd.maxFixRounds, odd.shouldDefault], ['always', 'whole', LEGACY_MAX_FIX_ROUNDS, 'fix']);
});

test('the stall watch defaults to 45 minutes and 4 hours, and roles.yaml can change or turn both off', () => {
  assert.deepEqual(parseStallWatchPolicy(''), { stallMinutes: 45, cardNoticeHours: 4 });
  const yaml = (block) => `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${block}`;
  assert.deepEqual(parseStallWatchPolicy(yaml('  stall_watch: { stall_minutes: 10, card_notice_hours: 1 }\n')), { stallMinutes: 10, cardNoticeHours: 1 });
  assert.deepEqual(parseStallWatchPolicy(yaml('  stall_watch: { stall_minutes: 0, card_notice_hours: 0 }\n')), { stallMinutes: 0, cardNoticeHours: 0 });
  assert.deepEqual(parseStallWatchPolicy(yaml('  stall_watch: { stall_minutes: -5, card_notice_hours: "4" }\n')), { stallMinutes: 45, cardNoticeHours: 4 });
});

test('the order policy defaults to six hours and TODO.md, and roles.yaml can change both', () => {
  const yaml = (block) => `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  review_blind: { roles: [r] }\n${block}`;
  assert.deepEqual(parseReviewPolicy(yaml('')).orderExcludeFiles, ['TODO.md']);
  assert.equal(parseReviewPolicy(yaml('')).orderWaitHours, 6);
  const tuned = parseReviewPolicy(yaml('  review_loop: { order_wait_hours: 1.5, order_exclude_files: [bun.lock, TODO.md] }\n'));
  assert.equal(tuned.orderWaitHours, 1.5);
  assert.deepEqual(tuned.orderExcludeFiles, ['TODO.md', 'bun.lock'], 'the default stays, and a config entry already there is not doubled');
  const off = parseReviewPolicy(yaml('  review_loop: { order_wait_hours: 0 }\n'));
  assert.equal(off.orderWaitHours, 0, '0 is read as 0, not as the default');
  const odd = parseReviewPolicy(yaml('  review_loop: { order_wait_hours: -1 }\n'));
  assert.equal(odd.orderWaitHours, 6, 'a negative hours reads as the default');
});

test('the executor-still wait is off when roles.yaml names no seconds, and reads a named length', () => {
  const yaml = (block) => `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  review_blind: { roles: [r] }\n${block}`;
  assert.equal(parseReviewPolicy(yaml('')).executorStillSeconds, 0, 'omitted is the rollback: no wait');
  assert.equal(parseReviewPolicy(yaml('  review_loop: { executor_still_seconds: 90 }\n')).executorStillSeconds, 90);
  assert.equal(parseReviewPolicy(yaml('  review_loop: { executor_still_seconds: 0 }\n')).executorStillSeconds, 0);
  assert.equal(parseReviewPolicy(yaml('  review_loop: { executor_still_seconds: -1 }\n')).executorStillSeconds, 0, 'a negative length reads as the rollback');
  assert.equal(parseReviewPolicy(yaml('  review_loop: { executor_still_seconds: "90" }\n')).executorStillSeconds, 0, 'a string length reads as the rollback');
});

test('the fix plan\'s trial key is on only when roles.yaml says true, and left out it keeps the plan for every fix', () => {
  const yaml = (block) => `roles:\n  r: { model: x/y }\npipeline:\n  review_blind: { roles: [r] }\n${block}`;
  assert.equal(parseReviewPolicy(yaml('')).fixPlanSkipWhenHow, false, 'omitted is the rollback: every fix goes through the plan');
  assert.equal(parseReviewPolicy(yaml('  review_loop: { fix_plan_skip_when_how: true }\n')).fixPlanSkipWhenHow, true);
  assert.equal(parseReviewPolicy(yaml('  review_loop: { fix_plan_skip_when_how: false }\n')).fixPlanSkipWhenHow, false);
  assert.equal(parseReviewPolicy(yaml('  review_loop: { fix_plan_skip_when_how: "true" }\n')).fixPlanSkipWhenHow, false, 'a value it does not read is the rollback');
  assert.equal(parseReviewPolicy(yaml('  review_loop: { fix_plan_skip_when_how: on }\n')).fixPlanSkipWhenHow, false);
});

test('the shipped roles.yaml runs the loop with the depth table\'s two API roles and the flash role on the final (2026-10-19 penne: no Claude quota in lanes)', { skip: shippedConfigSkip('roles.yaml') }, () => {
  const root = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  const p = parseReviewPolicy(readFileSync(join(root, 'config', 'roles.yaml'), 'utf8'));
  assert.deepEqual(p.roles, ['blind-reviewer'], 'the blind round is one role that runs the models the stage names');
  assert.deepEqual(p.extraRoles, { first_round: [], high_risk: ['blind-reviewer-final'] });
  assert.equal(p.highRiskWhen, 'last', 'the High role joins the final, not the first blind (first is the rollback)');
  assert.equal(p.finalExtra, 'all', 'the High role joins every lane\'s final, whatever its Risk (high is the rollback; 2026-10-19 penne)');
  assert.equal(p.finalScope, 'increment', 'the final review reads the increment by default (whole is the rollback)');
  assert.equal(p.executorStillSeconds, 90, 'the shipped roles.yaml waits for the executor to stop before a review stage');
  assert.equal(p.fixPlanSkipWhenHow, true, 'the shipped roles.yaml runs the trial: a fix with a how-to-fix skips the plan');
  assert.deepEqual([p.finalWhen, p.afterMerge, p.maxFixRounds, p.shouldDefault], ['behaviour', 'conflict', 2, 'triage']);
  assert.equal('r2Gate' in p, false, 'the R2 gate went with R2 (2026-10-22)');
  assert.equal(p.maxShouldFix, 2);
});

test('AC-001: the granularity stage runs only when the key says on, and a value it does not read leaves it stopped', () => {
  const yaml = (block) => `models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n${block}`;
  assert.equal(parseGranularityStage(yaml('  granularity: on\n')), true);
  assert.equal(parseGranularityStage(yaml('  granularity: "on"\n')), true, 'a quoted on still reads as on');
  assert.equal(parseGranularityStage(yaml('  granularity: ON\n')), true);
  assert.equal(parseGranularityStage(yaml('  granularity: off\n')), false);
  assert.equal(parseGranularityStage(yaml('  granularity: maybe\n')), false, 'a value it does not read leaves the stage stopped');
  assert.equal(parseGranularityStage(yaml('  granularity: 1\n')), false);
  assert.equal(parseGranularityStage(yaml('  planner: { role: r, concurrency: 1 }\n')), false, 'a missing key leaves the stage stopped');
  assert.equal(parseGranularityStage(''), false);
});

for (const name of ['roles.yaml', 'roles.example.yaml']) {
  test(`AC-001: this repo stops the granularity stage in ${name} and says how to turn it back on`, { skip: shippedConfigSkip(name) }, () => {
    const root = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
    const text = readFileSync(join(root, 'config', name), 'utf8');
    assert.equal(parseGranularityStage(text), false, `${name} stops the stage`);
    assert.match(text, /granularity: off/, `${name} writes the stopped value`);
    assert.match(text, /pipeline\.granularity/, `${name} names the key`);
    assert.match(text, /on にする|on で戻/, `${name} says how to turn it back on`);
  });
}

test('the blind slot\'s size counts the extras a round may add, once each', () => {
  const dir = tmpDir('idd-pipe-');
  const prev = process.env.IDD_ROLES_FILE;
  process.env.IDD_ROLES_FILE = join(dir, 'roles.yaml');
  try {
    writeFileSync(process.env.IDD_ROLES_FILE, 'pipeline:\n  review_blind: { roles: [a, b], first_round_extra: [o], high_risk_extra: [o, a] }\n');
    assert.equal(pipelineSlotSize('review_blind'), 3);
    assert.equal(pipelineSnapshot().size('review_blind'), 3);
    writeFileSync(process.env.IDD_ROLES_FILE, 'pipeline:\n  review_blind: { roles: [a, b] }\n');
    assert.equal(pipelineSlotSize('review_blind'), 2);
  } finally {
    if (prev === undefined) delete process.env.IDD_ROLES_FILE;
    else process.env.IDD_ROLES_FILE = prev;
  }
});

test('the blind slot\'s size counts an extra that shares a name with a slot role, which runs with its own model', () => {
  const dir = tmpDir('idd-pipe-');
  const prev = process.env.IDD_ROLES_FILE;
  process.env.IDD_ROLES_FILE = join(dir, 'roles.yaml');
  try {
    // the slot names two models for a, the extra a runs with a's own model: three runs
    writeFileSync(process.env.IDD_ROLES_FILE, 'pipeline:\n  review_blind: { role: a, models: [m1, m2], high_risk_extra: [a] }\n');
    assert.equal(pipelineSlotSize('review_blind'), 3);
    assert.equal(pipelineSnapshot().size('review_blind'), 3);
    // with no model named the slot's run and the extra's are the same run
    writeFileSync(process.env.IDD_ROLES_FILE, 'pipeline:\n  review_blind: { role: a, high_risk_extra: [a] }\n');
    assert.equal(pipelineSlotSize('review_blind'), 1);
    // an extra whose own model is one of the slot's models repeats that run
    writeFileSync(process.env.IDD_ROLES_FILE, 'models:\n  m1:\n    model: x/1\nroles:\n  a: { model: m1 }\npipeline:\n  review_blind: { role: a, models: [m1, m2], high_risk_extra: [a] }\n');
    assert.equal(pipelineSlotSize('review_blind'), 2);
    assert.equal(pipelineSnapshot().size('review_blind'), 2);
    // a role listed twice is two runs, as the round lists them
    writeFileSync(process.env.IDD_ROLES_FILE, 'pipeline:\n  review_blind: { roles: [a, a] }\n');
    assert.equal(pipelineSlotSize('review_blind'), 2);
  } finally {
    if (prev === undefined) delete process.env.IDD_ROLES_FILE;
    else process.env.IDD_ROLES_FILE = prev;
  }
});

test('the blind slot\'s size counts the models its one role runs with', () => {
  const dir = tmpDir('idd-pipe-');
  const prev = process.env.IDD_ROLES_FILE;
  process.env.IDD_ROLES_FILE = join(dir, 'roles.yaml');
  try {
    // one role with two models cuts two runs, and the extra a high-risk round adds cuts one more
    writeFileSync(process.env.IDD_ROLES_FILE, 'pipeline:\n  review_blind: { role: a, models: [m1, m2], high_risk_extra: [o] }\n');
    assert.equal(pipelineSlotSize('review_blind'), 3);
    assert.equal(pipelineSnapshot().size('review_blind'), 3);
    // a pair of a model and its thinking is one model too
    writeFileSync(process.env.IDD_ROLES_FILE, 'pipeline:\n  review_blind: { role: a, models: [{ model: m1, thinking: high }] }\n');
    assert.equal(pipelineSlotSize('review_blind'), 1);
    // a slot that names no model runs each role with its own model
    writeFileSync(process.env.IDD_ROLES_FILE, 'pipeline:\n  review_blind: { role: a }\n');
    assert.equal(pipelineSlotSize('review_blind'), 1);
  } finally {
    if (prev === undefined) delete process.env.IDD_ROLES_FILE;
    else process.env.IDD_ROLES_FILE = prev;
  }
});

test('the shipped roles.yaml declares no r2 slot, and the rest of the pipeline still parses', { skip: shippedConfigSkip('roles.yaml') }, () => {
  const root = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  const prev = process.env.IDD_ROLES_FILE;
  process.env.IDD_ROLES_FILE = join(root, 'config', 'roles.yaml');
  try {
    assert.equal(pipelineSlotDeclared('r2'), false);
    assert.equal(pipelineSlotDeclared('review_blind'), true);
    assert.equal(pipelineSlotDeclared('triage'), true);
    assert.equal(pipelineSlotDeclared('risk_map'), true, 'the map slot stays declared; its threshold alone stops it');
    assert.equal(parsePipelineConcurrency(readFileSync(process.env.IDD_ROLES_FILE, 'utf8'), 'r2'), undefined);
  } finally {
    if (prev === undefined) delete process.env.IDD_ROLES_FILE; else process.env.IDD_ROLES_FILE = prev;
  }
});

for (const name of ['roles.yaml', 'roles.example.yaml']) {
  test(`${name} has no r2 line and no R2 role (removed 2026-10-22)`, { skip: shippedConfigSkip(name) }, () => {
    const root = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
    const text = readFileSync(join(root, 'config', name), 'utf8');
    assert.doesNotMatch(text, /^\s*#?\s*r2:/m, `${name} has no r2 line, not even a commented one`);
    assert.doesNotMatch(text, /r2-reviewer/, `${name} has no R2 role`);
  });
}
