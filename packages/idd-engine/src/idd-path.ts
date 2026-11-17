import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { settlePointers } from "@idd/core";

/**
 * Put `idd` on PATH for every agent the engine starts: a lane's supervisor inherits the engine's env, so
 * the bash of a pi / claude conversation finds the report CLI. The wrapper goes under the state (the engine
 * is the only writer there), and only `idd` goes into the directory, not the rest of bin/. It is a small
 * wrapper, not a symlink: bin/idd locates the CLI from its own path, which a symlink would point away from.
 */
export function ensureIddOnPath(opts: { root: string; env?: NodeJS.ProcessEnv }): string | null {
  const env = opts.env ?? process.env;
  const root = opts.root;
  const target = join(root, "bin", "idd");
  if (!existsSync(target)) return null;
  // the state this engine reads, not a `state/` beside the code: a run clone's code and the state it serves are in
  // different places, and the agent's `idd` must come from the same place as the state the engine reads. The decision
  // is the one resolver's, and its absolute answer (and the recorded pi) is what the agent inherits too, so engine,
  // wrapper and the agent's `idd` cannot land on different states or pis
  const { stateDir: state } = settlePointers({ checkout: root, env });
  const dir = join(state, "bin");
  mkdirSync(dir, { recursive: true });
  const wrapper = join(dir, "idd");
  // single-quoted for sh, so $ ` \\ in the path stay literal
  const quoted = `'${target.replace(/'/g, `'\\''`)}'`;
  const body = `#!/bin/sh\nexec ${quoted} "$@"\n`;
  let current: string | null = null;
  try { current = readFileSync(wrapper, "utf8"); } catch { current = null; }
  if (current !== body) {
    rmSync(wrapper, { force: true });
    writeFileSync(wrapper, body);
    chmodSync(wrapper, 0o755);
  }
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (!parts.includes(dir)) env.PATH = [dir, ...parts].join(delimiter);
  return dir;
}
