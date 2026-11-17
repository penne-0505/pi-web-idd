import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A backquoted word that names a place in the repo, as the Anchors of a DEC and the reference of a plan write it.
 * A path with a slash is a place whether the lane has it yet or the plan means to make it: the work branch making it
 * first is a move into the plan. A bare file name is a place only as a file at the top of the lane (`README.md`):
 * `a.ts` or a dotted symbol (`AppTheme.primary`) names nothing there and would never match a changed path, so without
 * a root to check against it is left out. A glob is read as the directory before its first wildcard (`*`, `?`, `{`).
 * Brackets are part of a name, as in a route of Next.js (`app/api/x/[id]/route.ts`, `app/[...slug]/page.tsx`), so
 * a path with them is read as it is. Symbols (`runTick`) and prose are not places.
 *
 * One implementation: the plan's touched paths and the DEC index both read Anchors through it, so the two cannot
 * drift on what a path is.
 */
export function placeOf(token: string, root?: string): string | null {
  // a line, a range or a symbol after the path (`a.ts:10`, `a.ts:3-9`, `a.ts#L4-L9`, `a.ts#runTick`) names the same file
  let t = token.trim().replace(/^\.\//, "").replace(/#.*$/, "").replace(/:\d+(?:-\d+)?$/, "");
  if (!t || /\s/.test(t) || t.startsWith("/") || t.split("/").includes("..")) return null;
  const glob = t.search(/[*?{]/);
  if (glob >= 0) {
    const cut = t.slice(0, glob);
    const dir = cut.slice(0, cut.lastIndexOf("/") + 1);
    return dir || null;
  }
  if (!/^[\w.@+~[\]-]+(\/[\w.@+~[\]-]*)*$/.test(t)) return null;
  t = t.replace(/\/{2,}/g, "/");
  if (t.includes("/")) return t;
  return root !== undefined && /\.[A-Za-z0-9]+$/.test(t) && existsSync(join(root, t)) ? t : null;
}

/**
 * Whether a path the diff (or the Issue) names falls under a place an Anchors holds. A place that ends in a slash
 * (a directory, or a glob read to its directory) stands for everything under it.
 */
export function placeMatches(file: string, place: string): boolean {
  const f = file.replace(/^\.\//, "");
  const p = place.replace(/^\.\//, "");
  if (p.endsWith("/")) return f === p.slice(0, -1) || f.startsWith(p);
  return f === p || f.startsWith(`${p}/`);
}
