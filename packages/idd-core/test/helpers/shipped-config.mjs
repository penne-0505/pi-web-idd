import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'config');

/** a config file this checkout ships; roles.yaml and modes.yaml are overlay files, so a stripped copy and the public checkout do not have them */
export const shippedConfig = (name) => resolve(CONFIG, name);

/**
 * Throws unless `dir` is a checkout's config dir. roles.example.yaml is the mark: it is tracked in every checkout, so
 * a stripped copy and the public checkout have it, and a wrong path does not. Without this a wrong path would read as
 * "the overlay file is missing" and skip the shipped-config tests even on the mainline.
 */
export function assertConfigDir(dir) {
  if (!existsSync(resolve(dir, 'roles.example.yaml'))) {
    throw new Error(`${dir} は checkout の config dir ではありません（追跡済みの roles.example.yaml がありません）。helper の CONFIG の path がずれています`);
  }
}

/** the reason for `names` under `dir`, or false where all of them exist; `.example.` names are not counted (see shippedConfigSkip) */
export function skipReason(dir, names) {
  assertConfigDir(dir);
  const missing = names
    .filter((name) => !name.includes('.example.'))
    .map((name) => resolve(dir, name))
    .filter((file) => !existsSync(file));
  return missing.length === 0 ? false : `${missing.join(', ')} を読めません`;
}

/**
 * The `skip` option for a test that reads shipped config files itself: false where all of them exist, and otherwise
 * the reason, which names each path that could not be read. The check is the checkout's own file and never the
 * machine's `~/.config/idd`, so a skip does not depend on where the run happens.
 * `*.example.yaml` is tracked in every checkout, so one that is gone is a defect and is not counted: its test runs and fails.
 * `test(name, { skip: shippedConfigSkip('roles.yaml') }, fn)`.
 */
export function shippedConfigSkip(...names) {
  return skipReason(CONFIG, names);
}
