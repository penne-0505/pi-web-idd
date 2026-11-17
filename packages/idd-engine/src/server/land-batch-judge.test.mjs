import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { assertLanded, assertLeftOut, closeRunner, conflicting, git, pressAndCarry, reachable } from '../../../idd-core/test/helpers/batch-fixture.mjs';
import { scratchDir } from '../../../idd-core/test/helpers/scratch.mjs';
import { resolveLandConflict } from '../../../idd-lane/src/land-conflict.ts';

/**
 * The production judge (`land-resolver`, run once through pi) behind a batch landing: a stand-in for pi answers with a
 * fixed text, so what is exercised is the message the role is given, the reading of its answer and the batch's gate.
 */

const FAKE_PI = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes("--list-models")) {
  const parts = String(at("--list-models") || "").split("/");
  process.stdout.write(parts[0] + " " + parts.slice(1).join("/") + "\\n");
} else {
  writeFileSync(process.env.FAKE_PI_ASKED, args[args.length - 1]);
  process.stdout.write(readFileSync(process.env.FAKE_PI_ANSWER, "utf8"));
}
`;

const keys = ['IDD_ROLES_FILE', 'IDD_PI_BIN', 'IDD_PI_USER_AGENT_DIR', 'FAKE_PI_ANSWER', 'FAKE_PI_ASKED'];
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

/** the role, the stand-in pi and the answer it gives; the real judge is installed as the runner's */
function judgeAnswering(answer) {
  const dir = scratchDir('batch-judge-');
  mkdirSync(join(dir, 'user-agent'), { recursive: true });
  const pi = join(dir, 'pi');
  writeFileSync(pi, FAKE_PI);
  chmodSync(pi, 0o755);
  writeFileSync(join(dir, 'roles.yaml'), ['models:', '  glm:', '    model: openrouter/z-ai/glm-5.3', 'roles:', '  land-resolver: { model: glm, thinking: high }', ''].join('\n'));
  writeFileSync(join(dir, 'answer.txt'), answer);
  Object.assign(process.env, {
    IDD_ROLES_FILE: join(dir, 'roles.yaml'), IDD_PI_BIN: pi, IDD_PI_USER_AGENT_DIR: join(dir, 'user-agent'),
    FAKE_PI_ANSWER: join(dir, 'answer.txt'), FAKE_PI_ASKED: join(dir, 'asked.txt'),
  });
  closeRunner({ resolveLandConflict });
  return join(dir, 'asked.txt');
}


test('the production judge lands a same-file conflict it shows keeps both lanes, and is given the files and each side\'s archived plan', async () => {
  const f = await conflicting('_docs/archives/plan');
  const asked = judgeAnswering([
    '<decision>keeps</decision>',
    '<rationale>両方の lane が app.txt に別の行を足すだけで、互いの決めたことを変えない</rationale>',
    '<file path="app.txt">',
    '<why>足す行が別で、並べても意味を変えない</why>',
    '<content>',
    'one',
    'from one',
    'from two',
    '</content>',
    '</file>',
  ].join('\n'));
  const { b } = await pressAndCarry();
  assertLanded(b);
  for (const id of f.ids) assert.equal(reachable(f, id), true, id);
  assert.equal(git(f.work, 'show', 'work-main:app.txt'), 'one\nfrom one\nfrom two');
  assert.equal(b.conversions[0].kind, 'resolved');
  assert.match(b.conversions[0].rationale, /app\.txt: 足す行が別/);
  const message = readFileSync(asked, 'utf8');
  for (const part of [/<propter-system-message>/, /from one/, /from two/, /# plan one/, /# plan two/]) assert.match(message, part);
});

test('the production judge leaves out the lane whose conflict it cannot show keeps both', async () => {
  const f = await conflicting('_docs/archives/plan');
  judgeAnswering('<decision>changes</decision>\n<reason>IDD-1 は 2 行目を from one と決め、IDD-2 は from two と決めていて、1 行にしか収まらない</reason>');
  const { b } = await pressAndCarry();
  assertLanded(b, [['IDD-2', 'conflict']]);
  assert.match(b.dropped[0].reason, /1 行にしか収まらない/);
  assert.equal(reachable(f, 'IDD-1'), true);
  assert.equal(reachable(f, 'IDD-3'), true);
  assert.equal(reachable(f, 'IDD-2'), false);
});

test('an answer the production judge cannot read, or one with no ground for the file, leaves the lane out', async () => {
  for (const answer of [
    'どちらも残せます',
    '<decision>keeps</decision>\n<rationale>残す</rationale>\n<file path="app.txt">\n<content>\none\nfrom one\nfrom two\n</content>\n</file>',
    '<decision>keeps</decision>\n<rationale>残す</rationale>\n<file path="other.txt">\n<why>別</why>\n<content>\nx\n</content>\n</file>',
    '<decision>keeps</decision>\n<rationale>残す</rationale>\n<file path="app.txt">\n<why>別の行</why>\n<content>\none\nfrom one &lt; two\n</content>\n</file>',
  ]) {
    const f = await conflicting('_docs/archives/plan');
    judgeAnswering(answer);
    const { b } = await pressAndCarry();
    assertLeftOut(f, b);
    assert.equal(reachable(f, 'IDD-1'), true, answer);
  }
});
