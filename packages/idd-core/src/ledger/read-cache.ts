import { closeSync, lstatSync, openSync, readSync, statSync, type Stats } from "node:fs";

/**
 * The append-only columns are read many times per answer: the state's submit card alone walks the lifecycle eight
 * times, and the intent column is folded by every card that shows a Choice. Reading a 12 MB file from the top on
 * every one of those reads is what made one state answer cost 20 seconds. The reader below keeps the parsed rows in
 * memory and reads only what was added, so a read costs the growth rather than the whole file.
 *
 * The column is written by other processes too (the idd CLI appends from its own process), so the copy may not be
 * keyed on who wrote: it watches the file itself. A stat tells whether anything moved; an unchanged size and mtime
 * is the answer, and a grown size is read on from where the last read ended. Only when the file cannot have grown
 * by an append — it shrank, its inode changed, the bytes just before the old end no longer match, or a rewrite kept
 * the size — is the whole file read again. Either way the answer is the rows the file holds now, in file order.
 *
 * `readJsonlCached` never writes: the column stays the one source (P-4).
 */

interface FileCache {
  /** the byte length read so far */
  size: number;
  mtimeMs: number;
  ino: number;
  /** the bytes at the end of what was read, used to tell an append from a rewrite */
  tail: Buffer;
  /** the trailing bytes of an incomplete last line, held until the line ends */
  pending: Buffer;
  rows: unknown[];
}

const files = new Map<string, FileCache>();

/**
 * Bumped whenever a cached file turns out to hold something else. A reader that wants to know whether the columns
 * moved since it last looked compares this before and after its own reads (the engine's derived snapshot does).
 */
let revision = 0;

/** every byte the reader took from a file, over this process's life; a reader compares two points of it */
let bytesRead = 0;

export function jsonlCacheRevision(): number {
  return revision;
}

/** how much of the columns this process has read so far: the whole file once, then only what was added */
export function jsonlCacheBytesRead(): number {
  return bytesRead;
}

/** forget every copy: for a test that works in more than one state directory, and for nothing else */
export function resetJsonlCache(): void {
  files.clear();
  revision += 1;
}

/** how much of the old end is compared to tell an append from a rewrite */
const TAIL_CHECK = 64;

function readRange(path: string, start: number, end: number): Buffer {
  const length = end - start;
  if (length <= 0) return Buffer.alloc(0);
  bytesRead += length;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const got = readSync(fd, buf, filled, length - filled, start + filled);
      if (got <= 0) break;
      filled += got;
    }
    return filled === length ? buf : buf.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/** the rows of the lines in `chunk`, with a line that has no newline yet held back in `pending` */
function takeLines(chunk: Buffer, pending: Buffer, rows: unknown[]): Buffer {
  const all = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  let from = 0;
  for (;;) {
    const nl = all.indexOf(0x0a, from);
    if (nl < 0) break;
    if (nl > from) pushLine(all.subarray(from, nl), rows);
    from = nl + 1;
  }
  return all.subarray(from);
}

function pushLine(line: Buffer, rows: unknown[]): void {
  const text = line.toString("utf8").trim();
  if (!text) return;
  try {
    rows.push(JSON.parse(text));
  } catch {
    // a line that is not JSON is dropped, the same way the reader that reads the whole file drops it
  }
}

/** whether the bytes just before the old end still hold what was read there: if not, the file was made over */
function sameEnd(path: string, cache: FileCache): boolean {
  if (cache.size < cache.tail.length) return true;
  const start = cache.size - cache.tail.length;
  try {
    return readRange(path, start, cache.size).equals(cache.tail);
  } catch {
    return false;
  }
}

/**
 * The rows of an append-only JSONL file, in file order. The first call reads it whole and every later call reads
 * only what was added, so an unchanged file costs a stat and a copy of the row list.
 *
 * Every answer is a copy: a caller that pushes a row onto what it was given (intake does, right after appending the
 * same row itself) changes its own list only. The copy keeps a whole-read or a grown-read answer as separate from
 * the copy as the unchanged read already is, so no caller can write a row the file does not hold.
 */
export function readJsonlCached<T>(path: string): T[] {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    files.delete(path);
    return [];
  }
  if (!stat.isFile()) {
    files.delete(path);
    return [];
  }
  return readFile<T>(path, stat);
}

/** a column that is there but cannot be read: its stat failed for a reason other than "not there", it is not a file, or opening or reading it failed */
export class ColumnUnreadable extends Error {
  readonly path: string;
  readonly why: unknown;
  constructor(path: string, why: unknown, message?: string) {
    super(message ?? `列を読めません: ${path}（${reasonOf(why)}）`);
    this.name = new.target.name;
    this.path = path;
    this.why = why;
  }
}

/** a failure's reason as a sentence part */
export function reasonOf(why: unknown): string {
  return why instanceof Error ? why.message : String(why);
}

/**
 * The same reading for a column whose silence must not be taken for an empty one. A column that is not there yet (no
 * row was ever appended) is an empty list; a column that is there and cannot be read throws `ColumnUnreadable`, so a
 * caller never gets "none" for "could not read". The cache is the one `readJsonlCached` keeps.
 */
export function readJsonlColumn<T>(path: string): T[] {
  const stat = statColumn(path);
  if (!stat) return [];
  if (!stat.isFile()) {
    files.delete(path);
    throw new ColumnUnreadable(path, new Error("file ではありません"));
  }
  try {
    // a copy that is still current answers without opening the file, so the permission is asked here: a column that
    // lost its read permission after the copy warmed up is unreadable, whatever the copy holds
    closeSync(openSync(path, "r"));
    return readFile<T>(path, stat);
  } catch (err) {
    files.delete(path);
    throw new ColumnUnreadable(path, err);
  }
}

/**
 * The stat of a column, or `undefined` for a column not made yet. A path stat cannot find is not always absent: stat
 * follows a link, so a link to something missing is a column there that cannot be read, and only a path with nothing at
 * all is a column not made yet. When the lstat finds something after stat found nothing, the column may just have been
 * made between the two calls, so stat is asked once more; a second miss is the dangling link, and a hit is read like any
 * other column (its file check and its open check follow in the caller). `ops` is the pair of calls, so a test can
 * make the race that a real directory seldom shows.
 */
export function statColumn(path: string, ops: { stat: (p: string) => Stats; lstat: (p: string) => unknown } = { stat: statSync, lstat: lstatSync }): Stats | undefined {
  let first: unknown;
  try {
    return ops.stat(path);
  } catch (err) {
    files.delete(path);
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new ColumnUnreadable(path, err);
    first = err;
  }
  try {
    ops.lstat(path);
  } catch (lerr) {
    if ((lerr as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ColumnUnreadable(path, lerr);
  }
  try {
    return ops.stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new ColumnUnreadable(path, err);
    throw new ColumnUnreadable(path, first);
  }
}

function readFile<T>(path: string, stat: { ino: number; size: number; mtimeMs: number }): T[] {
  const hit = files.get(path);
  if (hit && hit.ino === stat.ino && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    return hit.rows.slice() as T[];
  }

  if (hit && hit.ino === stat.ino && stat.size > hit.size && sameEnd(path, hit)) {
    const rows = hit.rows.slice();
    const chunk = readRange(path, hit.size, stat.size);
    const pending = takeLines(chunk, hit.pending, rows);
    const tail = readRange(path, Math.max(0, stat.size - TAIL_CHECK), stat.size);
    files.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, tail, pending, rows });
    revision += 1;
    return rows.slice() as T[];
  }

  const whole = readRange(path, 0, stat.size);
  const rows: unknown[] = [];
  const pending = takeLines(whole, Buffer.alloc(0), rows);
  const tail = readRange(path, Math.max(0, stat.size - TAIL_CHECK), stat.size);
  files.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, tail, pending, rows });
  revision += 1;
  return rows.slice() as T[];
}

/** the same reading, as the ledger's own typed rows; the shape is the file's, so no check is made here */
export function readLedgerJsonl<T>(path: string): T[] {
  return readJsonlCached<T>(path);
}
