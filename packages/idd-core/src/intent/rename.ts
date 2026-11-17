import { moduleOf } from "./records.ts";

/**
 * The one reading of the lane's renames, shared by the landing's follow and by the lane's own check: a Place on a
 * file the lane moved is looked at where the file went, and is followed there when the lane lands. Both read git's
 * own rename detection, so the two cannot disagree about what moved.
 *
 * A move is a file (`from` naming the file) or a dir (`from` ending in `/`, which carries every Place under it).
 * Nothing here reads the disk: the caller hands in the diff text and, for dirs, whether the old dir still stands.
 */

/** one rename: a file path, or a dir path with its trailing `/` */
export interface PlaceMove {
  from: string;
  to: string;
}

/**
 * The renames of a `git diff -M --name-status -z` output. Each entry is a status and its path (or the two paths of a
 * rename); a copy (`C`) is read as a rename too, so a Place on the copied-from file also reaches its copy's module.
 */
export function parseRenameDiff(raw: string): PlaceMove[] {
  const tokens = raw.split("\0");
  const moves: PlaceMove[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      i += 2;
      if (from && to && from !== to) moves.push({ from, to });
      continue;
    }
    i += 1;
  }
  return moves;
}

/**
 * The dir moves the file moves add up to: every file that left a dir went to one and the same dir, and the old dir
 * is gone. A dir whose files were split across several dirs did not move, and neither did one that still stands (the
 * lane removed some files and moved others): following those would carry Places to a dir that was never the new
 * home of the whole module.
 */
export function dirMovesOf(moves: PlaceMove[], dirExists: (dir: string) => boolean): PlaceMove[] {
  const pairs = new Map<string, string | null>();
  for (const move of moves) {
    const from = moduleOf(move.from);
    const to = moduleOf(move.to);
    if (from === "/" || from === to) continue;
    const known = pairs.get(from);
    if (known === undefined) pairs.set(from, to);
    else if (known !== to) pairs.set(from, null);
  }
  return [...pairs]
    .filter(([from, to]) => to !== null && !dirExists(from))
    .map(([from, to]) => ({ from, to: to as string }));
}

/** the dir moves first, so a file move inside a moved dir rewrites the same result either way */
export function placeMovesOf(files: PlaceMove[], dirExists: (dir: string) => boolean): PlaceMove[] {
  return [...dirMovesOf(files, dirExists), ...files];
}
