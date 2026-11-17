import { realpathSync } from "node:fs";

/**
 * The failures a check's output names, read with the repo's `failure_id_pattern` for that check (config/repos.yaml):
 * what lets a failure at the lane's head be compared with the same check at the public base by the failures each run
 * named, not by pass / fail alone.
 *
 * The output is read one line at a time, after the colours a terminal would get are taken out and the copy's own path
 * (the copy is cut afresh for each run, so its path differs between the two runs) is taken out of every line. A line
 * the pattern matches names one failure: its first capture group, or the whole match when the pattern has no group.
 * The names come back sorted and once each.
 */

const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** the copy's path as it was given and as the file system resolves it, longest first, each with its trailing slash */
function copyPrefixes(copy: string): string[] {
  const out = new Set<string>([`${copy.replace(/\/+$/, "")}/`]);
  try { out.add(`${realpathSync(copy).replace(/\/+$/, "")}/`); } catch { /* a copy already gone is read by the path it was given */ }
  return [...out].sort((a, b) => b.length - a.length);
}

/** the output's lines as the patterns read them: no colours, no copy path */
function linesOf(output: string, copy?: string): string[] {
  const prefixes = copy ? copyPrefixes(copy) : [];
  return output.split("\n").map((raw) => {
    let line = raw.replace(/\r$/, "").replace(COLOUR, "");
    for (const p of prefixes) line = line.split(p).join("");
    return line;
  });
}

export function failureIdsOf(output: string, pattern: string, copy?: string): string[] {
  const re = new RegExp(pattern);
  const ids = new Set<string>();
  for (const line of linesOf(output, copy)) {
    const m = re.exec(line);
    if (!m) continue;
    const id = (m.length > 1 && m[1] !== undefined ? m[1] : m[0]).trim();
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

/** whether a line of the output says the run went to its end (`complete_pattern`) */
export function ranToEnd(output: string, pattern: string, copy?: string): boolean {
  const re = new RegExp(pattern);
  return linesOf(output, copy).some((line) => re.test(line));
}
