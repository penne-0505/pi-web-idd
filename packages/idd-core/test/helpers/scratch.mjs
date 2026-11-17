import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The one place test files make their work dirs through. `_meta/scratch` holds an agent's temp files and a
// person's comparison records beside the tests, so a test must never remove it and must never name a place of
// its own outside the entry's run place:
//   - run through the entry, `TEST_SCRATCH_DIR` holds the run's place, and the entry removes that place whole
//     (passed or failed, and for a run that was killed, the next run's sweep removes it),
//   - run directly, this helper makes one place of its own under the same dedicated directory and removes it on
//     process exit; a place made by hand (or left by a killed process) is removed by the next entry's sweep,
//     which reads the owner out of the place's name.
// Work dirs are always made inside that place, so a test only calls scratchDir(prefix).
//
// The root is found the same way the entry finds it (IDD_LANE_ROOT, then this file's own checkout), never from
// the cwd: some tests chdir into a fixture.

const HERE = dirname(fileURLToPath(import.meta.url));
// kept as separate segments so this file never spells the scratch path as one literal
const SCRATCH_PARTS = ['_meta', 'scratch'];
const PLACE_NAME = 'test-runs';
const DIR_ENV = 'TEST_SCRATCH_DIR';
const KEEP_ENV = 'KEEP_TEST_SCRATCH';
const KEEP_MARKER = 'KEEP';

function checkoutRoot() {
  return process.env.IDD_LANE_ROOT?.trim() || resolve(HERE, '..', '..', '..', '..');
}

function keepWanted() {
  const value = process.env[KEEP_ENV];
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

let baseDir = null;

/** the place this process writes under: the entry's, or one made here and removed when the process exits */
function base() {
  const fromEnv = process.env[DIR_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv;
  if (baseDir) return baseDir;
  const place = join(checkoutRoot(), ...SCRATCH_PARTS, PLACE_NAME);
  mkdirSync(place, { recursive: true });
  baseDir = mkdtempSync(join(place, `run-${process.pid}-`));
  if (keepWanted()) {
    // a place with the marker is left for a person by every later sweep
    writeFileSync(join(baseDir, KEEP_MARKER), `${process.pid}\n`);
  } else {
    const owned = baseDir;
    process.on('exit', () => {
      try { rmSync(owned, { recursive: true, force: true }); } catch { /* cleanup never fails the run */ }
    });
  }
  return baseDir;
}

/** a fresh work dir under this run's place; removed with the place, so callers write nothing of their own */
export function scratchDir(prefix = 'run-') {
  return mkdtempSync(join(base(), prefix));
}
