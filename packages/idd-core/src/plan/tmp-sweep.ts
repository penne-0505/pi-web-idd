import { lstatSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Removes `idd-*` entries directly under the temp dir that have not changed for a day. Test runs that were
 * killed leave their temp dirs behind, and lanes run the tests often enough to fill a tmpfs. Only the top level
 * is looked at, only names starting with `idd-`; a failure to read or remove anything is ignored.
 */
export function sweepStaleTmp(root: string = tmpdir(), now: number = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(root); } catch { return removed; }
  for (const name of names) {
    if (!name.startsWith("idd-")) continue;
    const path = join(root, name);
    try {
      if (now - lstatSync(path).mtimeMs <= STALE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch { /* another process may hold or have removed it; the next tick tries again */ }
  }
  return removed;
}
