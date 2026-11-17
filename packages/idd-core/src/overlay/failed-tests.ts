import { CUT_BY_OUTPUT, CUT_BY_TIME_RE } from "./gate.ts";
import type { GateCheck } from "./gate.ts";

/**
 * The names of the tests a failed check's output lists, read once when the run writes its record so a later reader
 * compares names it was handed and never re-reads the words of a detail.
 *
 * The source is the summary `packages/idd-lane/src/test-entry.ts` writes at the very end of a failed group: a header
 * with the count, then one `  - <name>` line per test. A summary that left names out (a `（ほか N 件）` line, or fewer
 * names than the count) names no test: a list that may be partial cannot show two rounds did not fail on the same one.
 * A name is kept whole: cutting it would read two tests that share a long prefix as one.
 */

const SUMMARY_HEADER = /^\[test-entry\] 組 .+ が落ちました: 落ちたテスト (\d+) 件$/;

/** the names of the failed tests the detail lists; empty when it lists none or cannot be trusted to list all */
export function failedTestNames(detail: string | undefined): string[] {
  if (!detail || CUT_BY_TIME_RE.test(detail) || detail.includes(CUT_BY_OUTPUT)) return [];
  const lines = detail.split("\n").map((l) => l.replace(/\r$/, ""));
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SUMMARY_HEADER.test(lines[i])) { at = i; break; }
  }
  if (at < 0) return [];
  const count = Number(lines[at].match(SUMMARY_HEADER)?.[1]);
  const names: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith("  - ")) {
      const name = line.slice(4).trim();
      if (name) names.push(name);
    } else if (line.startsWith("  （ほか")) {
      return [];
    } else if (line.trim() !== "") {
      break;
    }
  }
  return names.length > 0 && names.length === count ? names : [];
}

/** the rows with the names of the tests each failed row lists; a row with none is left as it is */
export function withFailedTests(checks: GateCheck[]): GateCheck[] {
  return checks.map((c) => {
    if (c.status !== "fail") return c;
    const names = failedTestNames(c.detail);
    return names.length ? { ...c, failedTests: names } : c;
  });
}

/** the failed tests of the rows of a record, by check: what the next round of the same group is compared with */
export function earlierFailedOf(checks: readonly GateCheck[]): { name: string; tests: string[] }[] {
  return checks.filter((c) => c.status === "fail" && c.failedTests?.length).map((c) => ({ name: c.name, tests: c.failedTests! }));
}
