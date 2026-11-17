import { attempt } from "../overlay/git.ts";

/**
 * The defects that went through the net, found only by what git holds: a lane's merge put lines on the work side's
 * mainline, and within a week a change that went straight onto the mainline (not another lane's merge) rewrote those
 * lines. Later lanes and Issues that merely mention a lane are not read, because most of them are the follow-ups the
 * review chose to put off, and a follow-up is not a leak.
 */

/** how long after a landing a direct change still counts as having found a defect in it */
export const LEAK_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * One landed lane and the Issue it closed. A work side lane's merge commit is in the ledger (`merge`). A public side
 * lane's PR merge is not (the ledger holds only that it merged), so it carries the head the PR was opened from and the
 * merge on the mainline is solved from git. A lane with neither cannot be placed on the mainline.
 */
export interface LandedLane {
  lane: string;
  merge?: string;
  /** the commit the PR was pushed at, for a lane whose merge commit the ledger does not hold */
  head?: string;
  /** when the lane's landing was recorded, which tells whether a landing that cannot be placed could matter to the period */
  at?: string;
  issue?: number;
}

/** a landed lane once placed on the mainline: the merge that brought it, and the commit its lines are read from */
interface Placed {
  lane: string;
  merge: string;
  head?: string;
  issue?: number;
}

export interface MetricsLeak {
  lane: string;
  merge: string;
  /** the direct change that rewrote the landed lines */
  fix: string;
  /** the JST day of the fix */
  date: string;
  /** the files of the fix whose rewritten lines the landing had put there */
  files: string[];
  /** why the change counts: it reverts, it is a fix by its type, or it names the lane or the Issue */
  kind: "revert" | "fix" | "named";
  /** the Issues the fix names besides the one the lane closed */
  issues: number[];
}

/** one repo's leaks; `rows` is null when its git could not be read, which is not the same as none */
export interface MetricsLeakArea {
  area: string;
  repo: string;
  rows: MetricsLeak[] | null;
  /** the public side lanes of the period whose landing could not be placed on the mainline (squashed, or never fetched) */
  unresolved?: number;
}

/** what the history gave: the rows, and the landings that could not be placed on the mainline */
export interface LeaksRead {
  rows: MetricsLeak[];
  unresolved: number;
}

interface Entry {
  sha: string;
  parents: string[];
  ct: number;
  message: string;
}

const jstDay = (seconds: number): string => new Date(seconds * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);

/** the day `days` before a JST day */
function dayBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/** the first-parent history from `since` on, newest first: merges and direct changes alike */
function readEntries(cwd: string, base: string, since: string): Entry[] | null {
  const out = attempt(cwd, [
    "-c", "log.showSignature=false", "log", "--first-parent", `--since=${since}T00:00:00+09:00`,
    "--format=%H%x1f%P%x1f%ct%x1f%B%x1e", `refs/heads/${base}`, "--",
  ]);
  if (out === null) return null;
  const entries: Entry[] = [];
  for (const chunk of out.split("\x1e")) {
    const text = chunk.replace(/^\n/, "");
    if (!text.trim()) continue;
    const [sha, parents, ct, ...message] = text.split("\x1f");
    if (!sha || ct === undefined) continue;
    entries.push({ sha: sha.trim(), parents: parents.split(" ").filter(Boolean), ct: Number(ct), message: message.join("\x1f") });
  }
  return entries;
}

interface Hunks {
  /** the path the lines were in before the change, which is where blame looks */
  before: string;
  /** the path after the change (the one shown) */
  after: string;
  ranges: [number, number][];
}

/** the lines a direct change removed or rewrote, by file (an added line has nothing to blame) */
function removedLines(cwd: string, sha: string): Hunks[] | null {
  const out = attempt(cwd, ["-c", "core.quotePath=false", "diff", "-U0", "-M", "--no-color", "--no-ext-diff", `${sha}^`, sha, "--"]);
  if (out === null) return null;
  const files: Hunks[] = [];
  let current: Hunks | undefined;
  let before = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
      before = "";
    } else if (line.startsWith("--- ")) {
      before = line.slice(4).replace(/\t.*$/, "");
      before = before === "/dev/null" ? "" : before.replace(/^a\//, "");
    } else if (line.startsWith("+++ ")) {
      let after = line.slice(4).replace(/\t.*$/, "");
      after = after === "/dev/null" ? before : after.replace(/^b\//, "");
      current = before ? { before, after, ranges: [] } : undefined;
      if (current) files.push(current);
    } else if (current && line.startsWith("@@ ")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) current.ranges.push([start, start + count - 1]);
    }
  }
  return files.filter((f) => f.ranges.length);
}

/** the commits that wrote the given lines of a file as it was before the change */
function writers(cwd: string, parent: string, file: Hunks): Set<string> | null {
  const out = attempt(cwd, ["blame", "--porcelain", ...file.ranges.flatMap(([a, b]) => ["-L", `${a},${b}`]), parent, "--", file.before]);
  if (out === null) return null;
  const shas = new Set<string>();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (m) shas.add(m[1]);
  }
  return shas;
}

/**
 * The commits a landing put on the mainline. A merge the ledger names brought everything its second parent had. A merge
 * solved from a PR's head brought that lane's commits only: the merge may also carry others, and they are not this lane.
 */
function brought(cwd: string, land: Placed, cache: Map<string, Set<string>>): Set<string> | null {
  const key = `${land.merge}\u0000${land.head ?? ""}`;
  const seen = cache.get(key);
  if (seen) return seen;
  const out = attempt(cwd, ["rev-list", land.head ?? land.merge, `^${land.merge}^1`]);
  if (out === null) return null;
  const set = new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
  // a revert of the merge itself names the merge, which the lane's own commits do not include
  set.add(land.merge);
  cache.set(key, set);
  return set;
}

/** the files a merge changed from the mainline it joined: the only files its lines can be in */
function touchedBy(cwd: string, merge: string, cache: Map<string, Set<string>>): Set<string> | null {
  const seen = cache.get(merge);
  if (seen) return seen;
  const out = attempt(cwd, ["-c", "core.quotePath=false", "diff", "--name-only", `${merge}^1`, merge, "--"]);
  if (out === null) return null;
  const set = new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
  cache.set(merge, set);
  return set;
}

const FIX_TYPE = /^(?:revert|fix|hotfix)(?:\([^)]*\))?!?:/i;

function kindOf(message: string): MetricsLeak["kind"] | undefined {
  const subject = message.split("\n")[0] ?? "";
  if (/^revert\b/i.test(subject)) return "revert";
  if (FIX_TYPE.test(subject)) return "fix";
  return undefined;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** whether a message names the lane or the Issue the lane closed */
function names(message: string, land: Placed): boolean {
  if (new RegExp(`(?<![\\w-])${escapeRe(land.lane)}(?![\\w-])`).test(message)) return true;
  return land.issue !== undefined && new RegExp(`(?<![\\w/&])#${land.issue}(?!\\d)`).test(message);
}

function issuesIn(message: string, own: number | undefined): number[] {
  const found = new Set<number>();
  for (const m of message.matchAll(/(?<![\w/&])#(\d+)(?!\d)/g)) if (Number(m[1]) !== own) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/** the commits a `git revert` names in its message */
function revertedBy(message: string): string[] {
  return [...message.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)].map((m) => m[1]);
}

/**
 * The merge on the mainline that brought a PR's head in: the oldest first-parent commit that has the head among its
 * ancestors. Null when the history cannot be read; "none" when the head never joined the mainline through a merge (a
 * squash or a rebase leaves the head out, a fast-forward leaves no merge to name), or the clone does not hold the head.
 */
function mergeOf(cwd: string, base: string, head: string): string | "none" | null {
  const known = attempt(cwd, ["cat-file", "-e", `${head}^{commit}`]);
  if (known === null) return "none";
  const out = attempt(cwd, ["rev-list", "--first-parent", "--ancestry-path", `${head}..refs/heads/${base}`]);
  if (out === null) return null;
  const oldest = out.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return oldest ?? "none";
}

/**
 * The leaks found in a repo's mainline in the period. A direct change counts for a landing when it came after the
 * merge on the mainline, within `LEAK_DAYS` of it, rewrote lines the merge brought, and is a revert, a hotfix or a fix
 * by its type, or names the lane or its Issue. One change that rewrote several landings' lines is a row in each, and
 * one landing has one row per change. A public side lane has no merge commit in the ledger, so its merge is solved
 * from the head its PR was opened from; one that cannot be solved is counted, not dropped. Null when the history cannot
 * be read.
 */
export function leaksOf(cwd: string | undefined, base: string | undefined, lands: LandedLane[], period: { since: string; until: string }): LeaksRead | null {
  if (!cwd || !base) return null;
  const from = dayBefore(period.since, LEAK_DAYS + 1);
  const entries = readEntries(cwd, base, from);
  if (entries === null) return null;
  const position = new Map(entries.map((e, i) => [e.sha, i]));
  const placed: Placed[] = [];
  let unresolved = 0;
  const solved = new Map<string, string | "none">();
  for (const l of lands) {
    if (l.merge !== undefined) {
      if (position.has(l.merge)) placed.push({ lane: l.lane, merge: l.merge, ...(l.issue === undefined ? {} : { issue: l.issue }) });
      continue;
    }
    // a landing before the window cannot have a leak in the period, so it is neither read nor counted
    const ms = l.at === undefined ? Number.NaN : Date.parse(l.at);
    const day = Number.isNaN(ms) ? "" : jstDay(ms / 1000);
    if (!day || day < from || day > period.until) continue;
    if (l.head === undefined) {
      unresolved += 1;
      continue;
    }
    let merge = solved.get(l.head);
    if (merge === undefined) {
      const read = mergeOf(cwd, base, l.head);
      if (read === null) return null;
      merge = read;
      solved.set(l.head, merge);
    }
    const at = merge === "none" ? undefined : position.get(merge);
    // a merge that is not a two-parent merge puts no lane commits apart from the mainline's own
    if (at === undefined || entries[at].parents.length < 2) {
      if (merge === "none" || at !== undefined) unresolved += 1;
      continue;
    }
    placed.push({ lane: l.lane, merge, head: l.head, ...(l.issue === undefined ? {} : { issue: l.issue }) });
  }
  const cache = new Map<string, Set<string>>();
  const changed = new Map<string, Set<string>>();
  const rows = new Map<string, MetricsLeak>();
  for (const [at, change] of entries.entries()) {
    const date = jstDay(change.ct);
    if (change.parents.length !== 1 || date < period.since || date > period.until) continue;
    const kind = kindOf(change.message);
    // a landing older on the mainline, and no more than a week older in time
    const candidates = placed.filter((l) => {
      const merge = entries[position.get(l.merge)!];
      return position.get(l.merge)! > at && change.ct >= merge.ct && change.ct - merge.ct <= LEAK_DAYS * DAY_MS / 1000 && (kind !== undefined || names(change.message, l));
    });
    if (!candidates.length) continue;
    const hunks = removedLines(cwd, change.sha);
    if (hunks === null) return null;
    // blame is the slow step, so only the files a candidate landing changed are blamed
    const reach = candidates.map((l) => touchedBy(cwd, l.merge, changed));
    if (reach.some((r) => r === null)) return null;
    const origin: { file: Hunks; shas: Set<string> }[] = [];
    for (const h of hunks) {
      if (!reach.some((r) => r!.has(h.before))) continue;
      const shas = writers(cwd, `${change.sha}^`, h);
      // a blame that failed cannot say whether the landing's lines were rewritten, so the area is unreadable, not empty
      if (shas === null) return null;
      origin.push({ file: h, shas });
    }
    const reverted = revertedBy(change.message);
    for (const land of candidates) {
      const set = brought(cwd, land, cache);
      if (set === null) return null;
      const found = new Set(origin.filter((o) => [...o.shas].some((s) => set.has(s))).map((o) => o.file.after));
      // a revert names what it undoes, which holds even where blame finds no line to point at
      if (!found.size && reverted.some((r) => [...set].some((s) => s.startsWith(r)))) {
        const touched = attempt(cwd, ["-c", "core.quotePath=false", "diff", "--name-only", `${change.sha}^`, change.sha, "--"]);
        if (touched === null) return null;
        for (const f of touched.split("\n").map((l) => l.trim()).filter(Boolean)) found.add(f);
      }
      if (!found.size) continue;
      rows.set(`${land.merge}\u0000${change.sha}`, {
        lane: land.lane,
        merge: land.merge,
        fix: change.sha,
        date,
        files: [...found].sort(),
        kind: reverted.length || kind === "revert" ? "revert" : kind ?? "named",
        issues: issuesIn(change.message, land.issue),
      });
    }
  }
  const sorted = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.lane.localeCompare(b.lane) || a.fix.localeCompare(b.fix) || a.merge.localeCompare(b.merge));
  return { rows: sorted, unresolved };
}
