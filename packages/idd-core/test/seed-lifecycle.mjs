import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../src/paths.ts';
import { readBacklog } from '../src/ledger/read.ts';

function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/**
 * A fixture's record, written straight to the lane's lifecycle file in the shape the engine writes it. The engine
 * writes the events it checks only through its write gate; a fixture that has to put a lane at a stage writes them
 * here, where no stage is checked.
 */
export async function seedLifecycle(event, iddId, attrs = {}) {
  const area = readBacklog().find((b) => b.idd_id === iddId)?.area;
  const safe = area ? area.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default' : 'default';
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `lifecycle-${safe}.jsonl`);
  appendFileSync(path, JSON.stringify({ event, idd_id: iddId, at: nowIso(), attrs }) + '\n', 'utf8');
  return path;
}
