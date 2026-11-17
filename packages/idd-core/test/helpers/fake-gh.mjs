import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scratchDir } from './scratch.mjs';

function executable(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
}

/** a gh that answers nothing, so a check never asks GitHub for real */
export function noGh() {
  return executable(join(scratchDir('gh-'), 'gh'), '#!/bin/sh\nexit 1\n');
}

/**
 * A gh that answers `pr list --state merged` with the text of `answerFile` (read on every call, so a test may rewrite it)
 * and hands every other call to the gh at `fallback`.
 */
export function mergedGh(answerFile, fallback) {
  return executable(join(scratchDir('gh-'), 'gh'), `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'list' && a.includes('--state') && a[a.indexOf('--state') + 1] === 'merged') { process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(answerFile)}, 'utf8')); process.exit(0); }
const r = require('node:child_process').spawnSync(${JSON.stringify(fallback)}, a, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`);
}

/** puts a gh on PATH that runs the node `body` (argv is `process.argv.slice(2)`) */
export function ghOnPath(body) {
  const stub = executable(join(scratchDir('gh-'), 'gh'), `#!${process.execPath}\n${body}\n`);
  process.env.PATH = `${dirname(stub)}:${process.env.PATH}`;
}
