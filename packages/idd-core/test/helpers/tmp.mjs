import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Temp dirs made through here are removed when the test process exits, so repeated runs do not fill /tmp.
// Removal waits for exit because fixtures are often shared across tests in one file.
const made = new Set();
process.on('exit', () => {
  for (const dir of made) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup never fails the run */ }
  }
});

export function tmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  return dir;
}
