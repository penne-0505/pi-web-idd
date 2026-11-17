import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Temp dirs made through here are removed once the tests are done, so repeated runs do not fill /tmp.
// bun test fires no process exit event, so this relies on afterAll: `test:lane` preloads this file, which makes
// the hook run after every file; imported without the preload, it runs after the first file that imports it.
const made = new Set<string>();
afterAll(() => {
  for (const dir of made) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup never fails the run */ }
  }
  made.clear();
});

export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  return dir;
}
