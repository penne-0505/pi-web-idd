import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** the registry this checkout ships; it is an overlay file, so a stripped copy and the public checkout do not have it */
export const SHIPPED_REPOS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'config', 'repos.yaml');

/**
 * The `skip` option for a test that reads the shipped registry itself: false where it exists, and otherwise the
 * reason, which names the path that could not be read. `test(name, { skip: shippedSkip }, fn)`.
 */
export const shippedSkip = existsSync(SHIPPED_REPOS) ? false : `${SHIPPED_REPOS} を読めません`;
