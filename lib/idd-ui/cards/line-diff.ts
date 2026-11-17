export interface DiffLine {
  op: "same" | "del" | "add";
  text: string;
}

function lines(text: string): string[] {
  const all = text.replace(/\r\n/g, "\n").split("\n");
  // a trailing newline is not a line of its own
  if (all.length && all[all.length - 1] === "") all.pop();
  return all;
}

/** above this many lines on a side the table would be large; the whole text is shown as replaced instead */
const MAX_LINES = 2000;

/**
 * The lines of `before` taken out and the lines of `after` put in, in order (a longest common subsequence of
 * the lines). A taken-out line comes before the line that replaces it.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map((text) => ({ op: "del" as const, text })), ...b.map((text) => ({ op: "add" as const, text }))];
  }
  // lcs[i][j]: the common lines of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ op: "add", text: b[j] });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) out.push({ op: "del", text: a[i] });
  for (; j < b.length; j += 1) out.push({ op: "add", text: b[j] });
  return out;
}
