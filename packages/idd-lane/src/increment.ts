import { posix } from "node:path";

import { isOverlayPath } from "../../idd-core/src/overlay/manifest.ts";
import { gitTry } from "./git.ts";

/**
 * What a final review of only the fixes since the last round reads next to that diff (`review_final.scope:
 * increment`): where the functions the fixes changed are called from (one hop), the files the tests the fixes
 * touched cover (their relative imports), and the names of every file the lane changed (names only, to open when
 * needed). Everything here is found by reading git, as far as it can be; what it cannot find is simply not listed.
 */
export interface IncrementContext {
  /** `path:line: text` of a call site of a changed function, outside the lines the fixes changed */
  callers: string[];
  /** the changed functions whose callers were looked for */
  functions: string[];
  /** files a touched test imports */
  covered: string[];
  /** every file the lane changed, base..head */
  laneFiles: string[];
}

const MAX_CALLERS_PER_NAME = 8;
const MAX_CALLERS = 40;
const MAX_FUNCTIONS = 12;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "const", "let", "var", "class", "new", "await", "async", "export", "import", "default", "else", "try", "typeof", "void", "delete", "case", "this", "super", "constructor", "get", "set", "static"]);

const lines = (out: string | null) => (out ?? "").split("\n").filter(Boolean);
const TEST_FILE = /(^|\/)[^/]*\.test\.[^/]+$|(^|\/)tests?\//;

/** the commit ranges that hold the fixes: the whole range, or around a mainline merge (whose content is not the fixes) */
export function fixRanges(base: string, head: string, merge?: string): [string, string][] {
  if (!merge) return [[base, head]];
  return [[base, `${merge}^1`], [merge, head]];
}

/** the names of the functions a diff changed: from its hunk headers and from definitions on its changed lines */
export function changedFunctions(diff: string): string[] {
  const out: string[] = [];
  const add = (name: string | undefined) => {
    if (!name || name.length < 3 || KEYWORDS.has(name) || out.includes(name)) return;
    out.push(name);
  };
  const def = /(?:function\*?|def|func|fn|class)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^\s*(?:(?:public|private|protected|static|async|export|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{/;
  for (const line of diff.split("\n")) {
    const header = /^@@[^@]*@@\s?(.*)$/.exec(line);
    const text = header ? header[1] : /^[+-](?![+-])/.test(line) ? line.slice(1) : undefined;
    if (text === undefined) continue;
    const m = def.exec(text);
    if (m) add(m[1] ?? m[2] ?? m[3]);
  }
  return out.slice(0, MAX_FUNCTIONS);
}

/** where a test file's relative imports resolve in the tree at `head` */
export function importsOf(worktree: string, head: string, testPath: string): string[] {
  const text = gitTry(worktree, ["show", `${head}:${testPath}`]);
  if (!text) return [];
  const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);
  const out: string[] = [];
  for (const spec of specs) {
    const target = posix.normalize(posix.join(posix.dirname(testPath), spec));
    const found = ["", ".ts", ".tsx", ".js", ".mjs", ".jsx", "/index.ts", "/index.js"]
      .map((ext) => `${target}${ext}`)
      .find((p) => gitTry(worktree, ["cat-file", "-e", `${head}:${p}`]) !== null);
    if (found && !out.includes(found) && !TEST_FILE.test(found)) out.push(found);
  }
  return out;
}

/**
 * `omit` is the overlay manifest's rows: a reader that must not see the lane's records gets none of their names, the
 * functions their hunks mention, or the lines that grep finds in them.
 */
export function incrementContext(worktree: string, opts: { base: string; head: string; merge?: string; laneBase?: string; omit?: string[] }): IncrementContext {
  const ranges = fixRanges(opts.base, opts.head, opts.merge);
  const omit = opts.omit ?? [];
  const kept = (path: string) => !isOverlayPath(omit, path);
  const scope = omit.length ? ["--", ".", ...omit.map((row) => `:(exclude)${row}`)] : [];
  const touched = [...new Set(ranges.flatMap(([a, b]) => lines(gitTry(worktree, ["diff", "--name-only", "--no-renames", a, b, ...scope]))))];
  const diff = ranges.map(([a, b]) => gitTry(worktree, ["diff", "-U0", "--no-color", "--no-renames", a, b, ...scope]) ?? "").join("\n");
  const functions = changedFunctions(diff);
  const callers: string[] = [];
  for (const name of functions) {
    if (callers.length >= MAX_CALLERS) break;
    const hits = lines(gitTry(worktree, ["grep", "-n", "-w", "-F", "-e", name, opts.head, "--"]))
      // `<head>:path:line:text`; the definition itself is not a caller
      .map((l) => l.slice(opts.head.length + 1))
      .filter((l) => kept(l.split(":")[0]))
      .filter((l) => !new RegExp(`(function\\*?|def|func|fn|class|const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\b`).test(l))
      .slice(0, MAX_CALLERS_PER_NAME)
      .map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
    callers.push(...hits.slice(0, MAX_CALLERS - callers.length));
  }
  const covered = [...new Set(touched.filter((p) => TEST_FILE.test(p)).flatMap((t) => importsOf(worktree, opts.head, t)))].filter(kept);
  const laneFiles = opts.laneBase ? lines(gitTry(worktree, ["diff", "--name-only", "--no-renames", opts.laneBase, opts.head, ...scope])) : [];
  return { callers, functions, covered, laneFiles };
}

/** the context as a file the final review reads first */
export function renderIncrementContext(c: IncrementContext): string {
  const list = (items: string[], none: string) => (items.length ? items.map((x) => `- \`${x}\``) : [`- ${none}`]);
  return [
    "# 増分のレビューで一緒に読むもの",
    "",
    "レビューの対象は、前回のレビューの後に入った修正（対象差分）。ここにあるのは、その修正が壊していないかを確かめるために読む場所。git から機械で拾ったもので、漏れがありうる。",
    "",
    `## 修正が変えた関数の呼び手（1 段、関数: ${c.functions.length ? c.functions.join(", ") : "拾えなかった"}）`,
    "",
    ...list(c.callers, "拾えなかった。差分の関数名で grep して呼び手を探す"),
    "",
    "## 修正が触ったテストが覆うファイル（テストの import 先）",
    "",
    ...list(c.covered, "なし"),
    "",
    "## lane が変えたファイルの一覧（名前だけ。必要なら開く）",
    "",
    ...list(c.laneFiles, "なし"),
    "",
  ].join("\n");
}
