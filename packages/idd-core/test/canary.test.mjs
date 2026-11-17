import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './helpers/scratch.mjs';

Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost',
});

function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** a state of its own: the canary writes beside the pipeline's state, never into the repo's */
function freshState(prefix = 'canary-') {
  const state = scratchDir(prefix);
  process.env.IDD_STATE_DIR = state;
  return state;
}

const ROLES = [
  { role: 'executor', model: 'ollama-cloud/deepseek-v4.1-flash', thinking: 'high' },
  { role: 'planner', model: 'openrouter/deepseek/deepseek-v4.1-flash', thinking: 'high' },
];

const ANSWERS = {
  'json-items': '{"title": "2026-10 の注文のまとめ", "items": [{"name": "りんご", "count": 3}, {"name": "みかん", "count": 5}, {"name": "ぶどう", "count": 2}], "total": 10}',
  'diff-fix': '--- a/buggy.ts\n+++ b/buggy.ts\n@@ -1,4 +1,4 @@\n-  return items.slice(-n - 1);\n+  return items.slice(-n);\n',
};

/** a runner that answers every question and remembers what it was asked */
function fakeRunner(roles = ROLES) {
  const asked = [];
  return {
    asked,
    deliver: async () => {},
    canaryRoles: () => roles,
    canaryRun: async ({ role, task }) => {
      asked.push({ role, task: task.id, prompt: task.prompt });
      return { text: ANSWERS[task.id] ?? 'この code は注文の合計を出す関数を 3 つ持ちます。', usd: 0.00012, tokens: { input: 591, output: 13, cacheRead: 0, cacheWrite: 0 } };
    },
  };
}

const day = (iso) => Date.parse(iso);

test('canary AC-001: a role is asked once a day, and the second pass of the same day asks nothing', async () => {
  freshState('canary-once-');
  const { runCanary } = await import('../src/canary/run.ts');
  const runner = fakeRunner([ROLES[0]]);
  const now = day('2026-10-19T03:00:00+09:00');
  const first = await runCanary({ runner, now });
  assert.deepEqual(first.ran, ['executor']);
  assert.equal(runner.asked.length, 4, 'every question is asked once in the role’s one run');
  assert.deepEqual(first.errors, []);

  const second = await runCanary({ runner, now: now + 60 * 60 * 1000 });
  assert.deepEqual(second.ran, []);
  assert.deepEqual(second.failed, []);
  assert.equal(runner.asked.length, 4, 'the same day’s second pass asks no question');
  assert.match(second.reason ?? '', /記録済み/);

  const tomorrow = await runCanary({ runner, now: now + 24 * 60 * 60 * 1000 });
  assert.deepEqual(tomorrow.ran, ['executor'], 'the next day asks the role again');
  assert.equal(runner.asked.length, 8);
});

test('canary AC-004: the day’s record keeps the numbers of every question, and the next day leaves it in place', async () => {
  freshState('canary-record-');
  const { runCanary } = await import('../src/canary/run.ts');
  const { canaryRecordPath } = await import('../src/canary/record.ts');
  const day1 = '2026-10-19';
  await runCanary({ runner: fakeRunner([ROLES[0]]), now: day(`${day1}T03:00:00+09:00`) });
  const file = canaryRecordPath(day1, 'executor', 'ollama-cloud/deepseek-v4.1-flash');
  assert.ok(existsSync(file), 'the role’s record is on disk after its run');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const before = readFileSync(file, 'utf8');
  assert.equal(record.role, 'executor');
  assert.equal(record.model, ROLES[0].model);
  assert.equal(record.day, day1);
  assert.equal(record.tasks.length, 4);
  const kinds = record.tasks.map((t) => t.kind);
  assert.ok(kinds.includes('read') && kinds.includes('json') && kinds.includes('diff'), 'the questions cover reading, JSON and a diff');
  assert.ok(record.tasks.length >= 3 && record.tasks.length <= 5);
  for (const task of record.tasks) {
    assert.ok(typeof task.id === 'string' && task.id, 'every task is named');
    assert.ok(typeof task.output === 'string', 'the answer is kept');
    assert.ok(['ok', 'fail', 'none'].includes(task.structure), 'the shape is judged on its own');
    assert.equal(typeof task.chars, 'number');
    assert.equal(typeof task.total_ms, 'number');
    assert.equal(typeof task.usd, 'number');
    assert.equal(typeof task.tokens.input, 'number');
  }
  const json = record.tasks.find((t) => t.kind === 'json');
  assert.equal(json.structure, 'ok', 'the JSON answer has the keys the question asked for');
  const diff = record.tasks.find((t) => t.kind === 'diff');
  assert.equal(diff.structure, 'ok', 'the diff answer is a unified diff');

  await runCanary({ runner: fakeRunner([ROLES[0]]), now: day('2026-10-20T03:00:00+09:00') });
  assert.equal(readFileSync(file, 'utf8'), before, 'the next day’s run does not touch the day before');
  assert.ok(existsSync(canaryRecordPath('2026-10-20', 'executor', 'ollama-cloud/deepseek-v4.1-flash')));
});

test('canary AC-004: a run that does not answer is recorded as a failure, apart from the shape', async () => {
  freshState('canary-no-answer-');
  const { runCanary } = await import('../src/canary/run.ts');
  const { canaryRecordPath } = await import('../src/canary/record.ts');
  const runner = {
    deliver: async () => {},
    canaryRoles: () => [ROLES[0]],
    canaryRun: async () => { throw new Error('provider が 500 を返しました'); },
  };
  const result = await runCanary({ runner, now: day('2026-10-19T03:00:00+09:00') });
  assert.deepEqual(result.failed, ['executor']);
  const record = JSON.parse(readFileSync(canaryRecordPath('2026-10-19', 'executor', 'ollama-cloud/deepseek-v4.1-flash'), 'utf8'));
  for (const task of record.tasks) {
    assert.equal(task.structure, 'none', 'a missing answer has no shape to fail');
    assert.match(task.error, /500/);
  }
});

test('canary AC-002: a model that never answers still ends the pass, and the record says what was not answered', async () => {
  freshState('canary-hang-');
  const { runCanary } = await import('../src/canary/run.ts');
  const { canaryRecordPath } = await import('../src/canary/record.ts');
  const runner = {
    deliver: async () => {},
    canaryRoles: () => [ROLES[0]],
    canaryRun: () => new Promise(() => {}),
  };
  const started = Date.now();
  const result = await runCanary({ runner, now: day('2026-10-19T03:00:00+09:00'), passMs: 2_500, runMs: 800, rolesPerPass: 1 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 9_000, `the pass ended inside its limit (took ${elapsed} ms)`);
  assert.deepEqual(result.failed, ['executor']);
  const record = JSON.parse(readFileSync(canaryRecordPath('2026-10-19', 'executor', 'ollama-cloud/deepseek-v4.1-flash'), 'utf8'));
  assert.equal(record.tasks.length, 4, 'the role’s record is kept even though it did not answer');
  assert.ok(record.tasks.some((t) => t.structure === 'none' && t.error), 'the unanswered questions are marked');
});

test('canary AC-003: a failing canary is kept to its own stage, and a record that cannot be written is an error, not a throw', async () => {
  const state = freshState('canary-fail-');
  const { runCanary } = await import('../src/canary/run.ts');
  // the day's folder is a plain file: nothing can be written under it
  put(join(state, 'pipeline', 'canary'), 'not a folder\n');
  const result = await runCanary({ runner: fakeRunner([ROLES[0]]), now: day('2026-10-19T03:00:00+09:00') });
  assert.deepEqual(result.failed, ['executor']);
  assert.ok(result.errors.some((e) => /記録を書けませんでした/.test(e.error)));
});

test('canary AC-003: a record that cannot be written still bounds the day’s tries and lets the next role through', async () => {
  const state = freshState('canary-unwritable-');
  const { runCanary, CANARY_MAX_ATTEMPTS } = await import('../src/canary/run.ts');
  // nothing can be written under the day: every record of the day is lost
  put(join(state, 'pipeline', 'canary'), 'not a folder\n');
  const asked = [];
  const runner = {
    deliver: async () => {},
    canaryRoles: () => ROLES,
    canaryRun: async ({ role, task }) => {
      asked.push(`${role}:${task.id}`);
      return { text: ANSWERS[task.id] ?? '答え', usd: 0.0001, tokens: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  // a day of its own, so no other case’s count is shared with this one
  const now = day('2026-10-22T03:00:00+09:00');
  for (let i = 1; i <= CANARY_MAX_ATTEMPTS; i += 1) {
    asked.length = 0;
    const result = await runCanary({ runner, now: now + i * 60_000 });
    assert.deepEqual(result.failed, ['executor'], `try ${i}: an unwritable record is a failure, not a throw`);
    assert.ok(result.errors.some((e) => /記録を書けませんでした/.test(e.error)));
    assert.equal(asked.length, 4, `try ${i} asks the role’s questions once`);
    assert.ok(asked.every((a) => a.startsWith('executor:')), 'the pass stops asking once the write fails');
  }
  asked.length = 0;
  const after = await runCanary({ runner, now: now + 10 * 60_000 });
  assert.deepEqual(after.failed, ['planner'], 'the role that spent its tries steps aside, and the next role is asked');
  assert.ok(asked.length > 0, 'the next role is asked instead of the first one again');
  assert.ok(asked.every((a) => a.startsWith('planner:')), 'the role with no tries left is not asked again');
});

test('canary AC-002: a role’s agent dir is readied once before its questions, outside a question’s time', async () => {
  freshState('canary-prepare-');
  const { runCanary } = await import('../src/canary/run.ts');
  const { canaryRecordPath } = await import('../src/canary/record.ts');
  const events = [];
  const runner = fakeRunner([ROLES[0]]);
  const answer = runner.canaryRun;
  runner.canaryPrepare = async ({ role }) => {
    events.push(`prepare:${role}`);
    await new Promise((r) => setTimeout(r, 300));
  };
  runner.canaryRun = async (opts) => {
    events.push(`ask:${opts.task.id}`);
    return answer(opts);
  };
  const result = await runCanary({ runner, now: day('2026-10-19T03:00:00+09:00') });
  assert.deepEqual(result.ran, ['executor']);
  assert.equal(events[0], 'prepare:executor', 'the dir is readied before the role’s first question');
  assert.equal(events.filter((e) => e.startsWith('prepare:')).length, 1, 'one preparation for the role, not one per question');
  const record = JSON.parse(readFileSync(canaryRecordPath('2026-10-19', 'executor', 'ollama-cloud/deepseek-v4.1-flash'), 'utf8'));
  assert.equal(record.tasks.length, 4);
  for (const task of record.tasks) {
    assert.ok(task.total_ms < 250, `the wait for the dir is not counted as the question’s time (${task.total_ms} ms)`);
  }
});

test('canary AC-003: a role whose dir cannot be readied fails alone, and the other roles still run', async () => {
  freshState('canary-prepare-fail-');
  const { runCanary } = await import('../src/canary/run.ts');
  const { canaryRecordPath } = await import('../src/canary/record.ts');
  const runner = fakeRunner(ROLES);
  runner.canaryPrepare = async ({ role }) => {
    if (role === 'executor') throw new Error('価格が読めませんでした');
  };
  const result = await runCanary({ runner, now: day('2026-10-19T03:00:00+09:00') });
  assert.deepEqual(result.failed, ['executor']);
  assert.deepEqual(result.ran, ['planner']);
  assert.ok(runner.asked.every((a) => a.role === 'planner'), 'the role whose dir was not readied asks no question');
  const record = JSON.parse(readFileSync(canaryRecordPath('2026-10-19', 'executor', 'ollama-cloud/deepseek-v4.1-flash'), 'utf8'));
  assert.equal(record.tasks.length, 4, 'the day’s record is written all the same, so the role is not asked again today');
  for (const task of record.tasks) {
    assert.equal(task.structure, 'none');
    assert.match(task.error, /価格が読めませんでした/);
  }
});

test('canary AC-002: a preparation that never returns still ends the pass inside its limit', async () => {
  freshState('canary-prepare-hang-');
  const { runCanary } = await import('../src/canary/run.ts');
  const { canaryRecordPath } = await import('../src/canary/record.ts');
  const runner = {
    deliver: async () => {},
    canaryRoles: () => [ROLES[0]],
    canaryPrepare: () => new Promise(() => {}),
    canaryRun: async () => { throw new Error('asked a role whose dir was never readied'); },
  };
  const started = Date.now();
  const result = await runCanary({ runner, now: day('2026-10-19T03:00:00+09:00'), passMs: 2_500, runMs: 800, rolesPerPass: 1 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 9_000, `the pass ended inside its limit (took ${elapsed} ms)`);
  assert.deepEqual(result.failed, ['executor']);
  const record = JSON.parse(readFileSync(canaryRecordPath('2026-10-19', 'executor', 'ollama-cloud/deepseek-v4.1-flash'), 'utf8'));
  assert.equal(record.tasks.length, 4);
  for (const task of record.tasks) assert.match(task.error, /agent dir を用意できませんでした/);
});

test('canary AC-002: a role’s dir is readied once a day, and the day’s retry does not ready it again', async () => {
  freshState('canary-prepare-day-');
  const { runCanary } = await import('../src/canary/run.ts');
  const { canaryRecordPath } = await import('../src/canary/record.ts');
  const prepared = [];
  let failing = true;
  const runner = {
    deliver: async () => {},
    canaryRoles: () => [ROLES[0]],
    canaryPrepare: async ({ role }) => { prepared.push(role); },
    canaryRun: async ({ task }) => {
      if (failing) throw new Error('provider が 500 を返しました');
      return { text: ANSWERS[task.id] ?? '答え', usd: 0.0001, tokens: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  const now = day('2026-10-19T03:00:00+09:00');
  await runCanary({ runner, now });
  assert.deepEqual(prepared, ['executor'], 'the dir is readied with the day’s first try');
  const record = JSON.parse(readFileSync(canaryRecordPath('2026-10-19', 'executor', 'ollama-cloud/deepseek-v4.1-flash'), 'utf8'));
  assert.equal(record.prepared, true, 'the record keeps that the dir was readied');
  failing = false;
  await runCanary({ runner, now: now + 60 * 60 * 1000 });
  assert.deepEqual(prepared, ['executor'], 'the day’s retry asks with the dir already readied');
});

test('canary AC-001: a role whose answer did not come back is partial, and the next pass asks only what is missing', async () => {
  freshState('canary-partial-');
  const { runCanary } = await import('../src/canary/run.ts');
  const { canaryRecordPath } = await import('../src/canary/record.ts');
  const asked = [];
  let failing = new Set(['json-items']);
  const runner = {
    deliver: async () => {},
    canaryRoles: () => [ROLES[0]],
    canaryRun: async ({ task }) => {
      asked.push(task.id);
      if (failing.has(task.id)) throw new Error('provider が 500 を返しました');
      return { text: ANSWERS[task.id] ?? 'この code は注文の合計を出す関数を 3 つ持ちます。', usd: 0.00012, tokens: { input: 591, output: 13, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  const now = day('2026-10-19T03:00:00+09:00');
  const file = canaryRecordPath('2026-10-19', 'executor', 'ollama-cloud/deepseek-v4.1-flash');
  const first = await runCanary({ runner, now });
  assert.deepEqual(first.failed, ['executor']);
  const before = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(before.partial, true, 'the role is marked partial while an answer is missing');
  assert.equal(before.attempts, 1);
  assert.equal(asked.length, 4);
  const answered = before.tasks.filter((t) => t.error === undefined);
  assert.equal(answered.length, 3);

  asked.length = 0;
  failing = new Set();
  const second = await runCanary({ runner, now: now + 60 * 60 * 1000 });
  assert.deepEqual(second.ran, ['executor']);
  assert.deepEqual(asked, ['json-items'], 'the retry asks only the question that is missing');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.partial, undefined, 'a role with every answer is no longer partial');
  assert.equal(after.attempts, 2);
  for (const task of answered) {
    assert.deepEqual(after.tasks.find((t) => t.id === task.id), task, 'the answer already given is kept as it was');
  }
});

test('canary AC-001: a role is tried at most three times in its day', async () => {
  freshState('canary-attempts-');
  const { runCanary, CANARY_MAX_ATTEMPTS } = await import('../src/canary/run.ts');
  const { canaryRecordPath } = await import('../src/canary/record.ts');
  const asked = [];
  const runner = {
    deliver: async () => {},
    canaryRoles: () => [ROLES[0]],
    canaryRun: async ({ task }) => { asked.push(task.id); throw new Error('provider が落ちています'); },
  };
  const now = day('2026-10-19T03:00:00+09:00');
  for (let i = 1; i <= CANARY_MAX_ATTEMPTS; i += 1) {
    asked.length = 0;
    const result = await runCanary({ runner, now: now + i * 60 * 60 * 1000 });
    assert.deepEqual(result.failed, ['executor'], `try ${i} fails`);
    assert.equal(asked.length, 4, `try ${i} asks the four questions again`);
    const record = JSON.parse(readFileSync(canaryRecordPath('2026-10-19', 'executor', 'ollama-cloud/deepseek-v4.1-flash'), 'utf8'));
    assert.equal(record.attempts, i);
    assert.equal(record.partial, true);
  }
  asked.length = 0;
  const after = await runCanary({ runner, now: now + 6 * 60 * 60 * 1000 });
  assert.deepEqual(after.ran, []);
  assert.deepEqual(after.failed, []);
  assert.equal(asked.length, 0, 'the day stops asking after its last try');
  assert.match(after.reason ?? '', /記録済み/);
});

test('canary AC-002: a tick’s canary has one wall, and the pass after it asks nothing', async () => {
  freshState('canary-wall-');
  const { runCanary } = await import('../src/canary/run.ts');
  const { canaryDeadlineOf } = await import('../src/plan/tick.ts');
  const runner = {
    deliver: async () => {},
    canaryRoles: () => ROLES,
    canaryRun: () => new Promise(() => {}),
  };
  const now = day('2026-10-19T03:00:00+09:00');
  const wall = canaryDeadlineOf(2_500);
  const started = Date.now();
  const deadline = wall();
  assert.ok(deadline - started <= 3_000, 'the wall is one limit, made once');
  assert.equal(wall(), deadline, 'the tick’s later passes read the same instant');
  const first = await runCanary({ runner, now, deadline, runMs: 600, rolesPerPass: 2 });
  const spent = Date.now();
  assert.ok(spent - started < 9_000, `the canary ended inside its limit (took ${spent - started} ms)`);
  assert.deepEqual(first.failed, ['executor'], 'the role it reached is recorded as partial');
  assert.deepEqual(first.skipped, ['planner'], 'the other role waits for the next tick');

  const second = await runCanary({ runner, now, deadline: wall(), runMs: 600, rolesPerPass: 2 });
  assert.deepEqual(second.ran, []);
  assert.deepEqual(second.failed, []);
  assert.deepEqual(second.skipped.sort(), ['executor', 'planner'], 'the later pass asks nothing inside the spent wall');
  assert.match(second.reason ?? '', /上限を使い切りました/);
  assert.ok(Date.now() - spent < 1_000, 'the later pass returns at once');
  assert.ok(Date.now() - started < 4_000, 'two passes share one wall, not two walls');
});

test('canary AC-002: a tick whose canary hangs still lets go of the lock, and its other stages ran', async () => {
  const state = freshState('canary-tick-');
  put(join(state, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r }\n');
  process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
  const { runTick } = await import('../src/plan/tick.ts');
  const { setAgentRunner } = await import('../src/agent/port.ts');
  setAgentRunner({
    deliver: async () => {},
    canaryRoles: () => [{ role: 'r', model: 'x/y', thinking: 'high' }],
    canaryRun: () => new Promise(() => {}),
  });
  try {
    const first = await runTick({ intake: false, canary: { passMs: 2_000, runMs: 600, rolesPerPass: 1 } });
    assert.notEqual(first.skipped, 'another tick is running');
    assert.ok(first.canary.failed.includes('r') || first.canary.ran.includes('r'), 'the role was run or recorded as failed');
    // the lock was let go: a second tick starts instead of finding it held
    const second = await runTick({ intake: false, canary: { passMs: 1_000, runMs: 300, rolesPerPass: 1 } });
    assert.notEqual(second.skipped, 'another tick is running');
  } finally {
    setAgentRunner(null);
  }
});

test('canary AC-003: a canary that throws leaves the tick’s other stages as they were', async () => {
  const { runTick } = await import('../src/plan/tick.ts');
  const { setAgentRunner } = await import('../src/agent/port.ts');

  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'canary') continue;
      out[key] = strip(item);
    }
    return out;
  };

  async function tickWithCanary(make) {
    const state = freshState('canary-other-stages-');
    put(join(state, 'roles.yaml'), 'models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  planner: { role: r }\n');
    process.env.IDD_ROLES_FILE = join(state, 'roles.yaml');
    setAgentRunner(make());
    try {
      return strip(await runTick({ intake: false, canary: { passMs: 1_000, runMs: 500, rolesPerPass: 1 } }));
    } finally {
      setAgentRunner(null);
    }
  }

  const quiet = await tickWithCanary(() => ({ deliver: async () => {} }));
  const throwing = await tickWithCanary(() => ({
    deliver: async () => {},
    canaryRoles: () => [{ role: 'r', model: 'x/y', thinking: 'high' }],
    canaryRun: async () => { throw new Error('provider が落ちました'); },
  }));
  assert.deepEqual(throwing, quiet, 'every other stage reads the same as a tick that has no canary at all');
});

test('canary AC-005: a record put in another day’s folder is read as the day of the folder', async () => {
  freshState('canary-copied-');
  const { canaryDayDir, readCanaryDay, readCanaryRecords } = await import('../src/canary/record.ts');
  const { buildCanaryView } = await import('../src/metrics/build.ts');
  const value = (chars) => ({ id: 'json-items', kind: 'json', structure: 'ok', output: 'x', chars, total_ms: 1000, usd: 0.0002, tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } });
  const record = (day, tasks) => ({ role: 'executor', model: 'ollama-cloud/deepseek-v4.1-flash', thinking: 'high', day, at: `${day}T03:00:00+09:00`, tasks });
  // a record written for the 19th, copied into the folder of the week before: the folder is the day it is read as
  put(join(canaryDayDir('2026-10-05'), 'executor.json'), JSON.stringify(record('2026-10-19', [value(100)])));
  put(join(canaryDayDir('2026-10-13'), 'executor.json'), JSON.stringify(record('2026-10-13', [value(300)])));

  assert.equal(readCanaryDay('2026-10-05')[0].day, '2026-10-05', 'the folder decides the day a record is read as');

  const view = buildCanaryView(readCanaryRecords(['2026-10-05', '2026-10-13']), { since: '2026-10-12', until: '2026-10-18' });
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].previous.day, '2026-10-05', 'the copied record stands as the week before');
  assert.deepEqual(view.rows[0].marks, { structure: false, chars: true, total_ms: false }, 'the copy makes the week before readable, so the length is marked');
});
