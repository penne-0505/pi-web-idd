// Shared fixture for the tests of a generated file made again at a landing (not a test file itself): gen.txt is src.txt
// in one upper-cased line, so it is a function of the sources and a file two sides' text merges can both change.
import { join } from 'node:path';

import { commit, git, put } from '../stacked-fixture.mjs';

export const GEN = { paths: ['gen.txt'], command: "tr '\\n' ' ' < src.txt | tr a-z A-Z > gen.txt", timeout_minutes: 1 };
export const genOf = (src) => src.replace(/\n/g, ' ').toUpperCase();
export const SRC = 'alpha\nbeta\ngamma\n';
// edits of SRC: TOP and BOTTOM text-merge (a different line each); TOP and TOP_OTHER conflict (the same line)
export const TOP = 'alpha2\nbeta\ngamma\n';
export const BOTTOM = 'alpha\nbeta\ngamma2\n';
export const TOP_OTHER = 'alpha3\nbeta\ngamma\n';
export const TOP_AND_BOTTOM = 'alpha2\nbeta\ngamma2\n';

/** the repos.yaml entry that declares GEN with `command` (and a limit, for a command that is cut) in its place */
export const generating = (command, timeout_minutes) => ({ generated_files: [{ ...GEN, command, ...(timeout_minutes ? { timeout_minutes } : {}) }] });

/** write files into a clone the way a lane (or the mainline) does and commit them */
export function writeIn(cwd, writes, message) {
  for (const [name, text] of Object.entries(writes)) put(join(cwd, name), text);
  commit(cwd, message);
}

/** write a source and the generated file built from it (at `gen`) into a clone and commit */
export const builds = (cwd, src, message, gen = 'gen.txt') => writeIn(cwd, { 'src.txt': src, [gen]: genOf(src) }, message);

/** the mainline (a clone) holds SRC and the file built from it, and the lanes (given as paths) are brought up to it */
export function seedGenerated(work, lanePaths = [], gen = 'gen.txt') {
  builds(work, SRC, 'chore: seed generated', gen);
  for (const path of lanePaths) git(path, 'merge', '--ff-only', 'work-main');
}

/** the mainline changes line 1 of src.txt and builds gen.txt; the lane changes line 3 of the source and leaves the old build: no conflict */
export function mainlineBuildsLaneEditsSource(f) {
  writeIn(f.work, { 'src.txt': TOP, 'gen.txt': genOf(TOP) }, 'chore: mainline builds');
  writeIn(f.lane.path, { 'src.txt': BOTTOM }, 'feat: lane changes the source only');
}
