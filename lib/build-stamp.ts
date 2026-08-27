import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// intent: 出先の端末で「いま見ているのが最新の build か」を判別するための刻印。
// dev では source の最終更新時刻、build 済みでは起動時刻に落ちる。
const WATCHED = ["app", "components", "hooks", "lib"];
const SKIP = new Set(["node_modules", ".next", ".git", "__pycache__"]);
const EXT = /\.(tsx?|css|mjs)$/;

function newestMtime(dir: string, depth = 0): number {
  if (depth > 4) return 0;
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      newest = Math.max(newest, newestMtime(full, depth + 1));
    } else if (EXT.test(e.name) && !e.name.includes(".test.")) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // 読めないものは無視
      }
    }
  }
  return newest;
}

let cached: { at: number; value: string } | null = null;

/** MMDD-HHmm 形式の刻印。5 秒間だけ memo 化する (毎 request の walk を避ける)。 */
export function getBuildStamp(): string {
  const now = Date.now();
  if (cached && now - cached.at < 5000) return cached.value;

  const root = process.cwd();
  let newest = 0;
  for (const d of WATCHED) newest = Math.max(newest, newestMtime(join(root, d)));
  if (!newest) newest = now;

  const d = new Date(newest);
  const p = (n: number) => String(n).padStart(2, "0");
  const value = `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;

  cached = { at: now, value };
  return value;
}
