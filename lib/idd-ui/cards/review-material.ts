import type { DiffLine, InboxItem } from "../types.ts";

/** one changed file of a review, read back from the engine's material */
export interface ReviewFile {
  file: string;
  fileIndex: number;
  fileTotal: number;
  before: DiffLine[];
  after: DiffLine[];
}

const KEY = /^diff_(file|before|after)_(\d+)$/;
const FILE = /^(.*)（(\d+)\/(\d+)）$/;
/** a line of a side as the engine wrote it: `<line number> <marker> <code>`, the number absent for a line with none */
const LINE = /^(?:(\d+) )?([+\- ]) (.*)$/;

function linesOf(text: string): DiffLine[] {
  return text.split("\n").map((raw) => {
    const hit = LINE.exec(raw);
    // the engine's note of lines it left out ("… あと N 行") is not a diff line: it is shown as a plain line
    if (!hit) return { marker: null, code: raw };
    return { marker: hit[2] === "+" || hit[2] === "-" ? hit[2] : null, code: hit[3], ...(hit[1] ? { lineNo: hit[1] } : {}) };
  });
}

/**
 * The files of a review card, read from the engine's material (`diff_file_N`, `diff_before_N`, `diff_after_N`). The lane's
 * diff has one reading, the core's `laneDiffAll`, and this is how a screen reads it back; no other copy of the lines is sent.
 */
export function reviewFilesOf(item: InboxItem): ReviewFile[] {
  const files = new Map<number, ReviewFile>();
  for (const m of item.decision?.material ?? []) {
    const hit = KEY.exec(m.key);
    if (!hit) continue;
    const n = Number(hit[2]);
    const entry = files.get(n) ?? { file: "", fileIndex: n, fileTotal: 0, before: [], after: [] };
    if (hit[1] === "file") {
      const named = FILE.exec(m.value);
      entry.file = named ? named[1] : m.value;
      entry.fileIndex = named ? Number(named[2]) : n;
      entry.fileTotal = named ? Number(named[3]) : 0;
    } else entry[hit[1] as "before" | "after"] = linesOf(m.value);
    files.set(n, entry);
  }
  return [...files.entries()].sort((a, b) => a[0] - b[0]).map(([, f]) => f);
}
