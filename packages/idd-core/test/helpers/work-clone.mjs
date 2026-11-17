import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const GOOD_MANIFEST = '_docs/\noverlay.manifest\n';

export function gitIn(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** a work clone in `root/name` whose branch `work-main` holds `manifest` (null: no manifest on it) */
export function workClone(root, name, manifest) {
  const dir = join(root, name);
  mkdirSync(dir);
  gitIn(dir, 'init', '-q', '--initial-branch=work-main');
  writeFileSync(join(dir, 'app.txt'), 'a\n');
  if (manifest !== null) writeFileSync(join(dir, 'overlay.manifest'), manifest);
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-qm', 'base');
  return dir;
}

/** commits `text` as the manifest on the clone's current branch */
export function commitManifest(dir, text) {
  writeFileSync(join(dir, 'overlay.manifest'), text);
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-qm', 'manifest');
}

/** registers `repos` (the repos.yaml entries) and an empty state dir for the engine under `root`; `env` is added to the environment */
export function registerRepos(root, repos, env = {}) {
  const state = join(root, 'state');
  mkdirSync(state);
  writeFileSync(join(root, 'repos.yaml'), JSON.stringify({ repos }));
  Object.assign(process.env, { IDD_REPOS_FILE: join(root, 'repos.yaml'), IDD_STATE_DIR: state, ...env });
  return state;
}
