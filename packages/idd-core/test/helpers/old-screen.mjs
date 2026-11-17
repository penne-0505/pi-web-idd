import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** what the old screen's build left at a checkout's root, as untracked files */
export function layOldScreenOutput(checkout) {
  mkdirSync(join(checkout, '.next', 'server'), { recursive: true });
  writeFileSync(join(checkout, '.next', 'server', 'index.js'), 'x\n');
  writeFileSync(join(checkout, 'next-env.d.ts'), 'x\n');
}

/** which of the two outputs are still there */
export const outputsLeft = (checkout) => ['.next', 'next-env.d.ts'].filter((name) => existsSync(join(checkout, name)));

/** both outputs, as a checkout still holding them reads */
export const BOTH_OUTPUTS = ['.next', 'next-env.d.ts'];
