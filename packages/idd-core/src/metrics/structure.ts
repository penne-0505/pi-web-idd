import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, posix } from "node:path";
import ts from "typescript";

import type { StructureDecl } from "../config/structure.ts";

/**
 * The counts of a tree's structure, read from files alone (no git, no network): the same tree and the same declaration
 * give the same numbers, so a landing can compare the mainline tip with the merge commit (C-243-1, C-243-4). One pass
 * prints every count, the two a landing is stopped by and the ones that are only recorded.
 *
 * - `duplicate-tokens`: every token of a TypeScript / JavaScript file is read with identifiers collapsed to one symbol
 *   and literals (true, false and null among them) to another (imports left out), and the count is the number of positions where a window of
 *   `decl.window` tokens starts and the same window starts somewhere else too. Renaming or reformatting a copy does not
 *   move the number; copying a function does.
 * - `layer-violations`: imports from one layer into another that the declaration's `allow` does not list.
 *
 * Recorded only: `large-files`, `complex-functions`, `any-types`, `mbt-json-functions`, `mbt-wildcard-arms` and
 * `ts-reference-lines` (the TypeScript copies of the MoonBit fold).
 */

export type StructureCounts = Record<string, number>;

/**
 * Where no file is read from, decided by position so a tracked source is never left out for the name of a folder on its
 * way (`app/api/sessions/[id]/state/route.ts` is counted): dependencies at any depth, the repo's scratch and runtime
 * state only at the root, and build output only directly under a package root (a directory holding a package.json or a moon.mod).
 */
const DEPENDENCY_DIRS = new Set(["node_modules", ".git"]);
const ROOT_ONLY_DIRS = new Set(["_meta", "state", ".next"]);
const PACKAGE_BUILD_DIRS = new Set(["dist", "_build", ".mooncakes", "target"]);
const PACKAGE_ROOT_FILES = new Set(["package.json", "moon.mod", "moon.mod.json"]);
const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SCRIPT_KIND: Record<string, ts.ScriptKind> = { ".tsx": ts.ScriptKind.TSX, ".jsx": ts.ScriptKind.JSX, ".js": ts.ScriptKind.JS, ".mjs": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS };
const REFERENCE_FILE = /-reference\.ts$/;
const MBT_TEST_FILE = /(_wbtest|_test)\.mbt$/;

/** a prefix is a directory, written with or without its trailing slash: `packages/ui/` also holds the path `packages/ui` an import of `../ui` resolves to */
function isIn(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => {
    const dir = p.replace(/\/+$/, "");
    return path === dir || path.startsWith(`${dir}/`);
  });
}

/**
 * the repo-relative paths of the files under `root`, sorted, without the directories nobody reads and the excluded
 * prefixes. A symbolic link is not followed and not counted: a commit holds the link, not what it points at, so a target
 * outside the tree must not move a number, an alias must not be counted twice, and a broken or looping link must not fail the scan.
 */
export function listFiles(root: string, exclude: string[] = []): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    const entries = readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const isPackageRoot = entries.some((e) => PACKAGE_ROOT_FILES.has(e.name));
    for (const entry of entries) {
      if (DEPENDENCY_DIRS.has(entry.name) || (dir === "" && ROOT_ONLY_DIRS.has(entry.name)) || (isPackageRoot && PACKAGE_BUILD_DIRS.has(entry.name))) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (isIn(rel, exclude)) continue;
      if (entry.isDirectory()) visit(rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  visit("");
  return out;
}

// ---------------------------------------------------------------- tokens

const IDENT = -1;
const LITERAL = -2;

/** the token symbols of one parsed file: identifiers and literals collapsed, import / re-export statements left out */
function tokensOf(sf: ts.SourceFile): number[] {
  const skip: Array<[number, number]> = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st) || (ts.isExportDeclaration(st) && st.moduleSpecifier)) skip.push([st.getStart(sf), st.end]);
  }
  const out: number[] = [];
  let next = 0;
  const leaf = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length) {
      for (const c of children) leaf(c);
      return;
    }
    const kind = node.kind;
    if (kind === ts.SyntaxKind.EndOfFileToken) return;
    const at = node.getStart(sf);
    while (next < skip.length && skip[next][1] <= at) next += 1;
    if (next < skip.length && at >= skip[next][0]) return;
    if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier) out.push(IDENT);
    else if (kind === ts.SyntaxKind.JsxText) {
      if (!(node as ts.JsxText).containsOnlyTriviaWhiteSpaces) out.push(LITERAL);
    } else if ((kind >= ts.SyntaxKind.FirstLiteralToken && kind <= ts.SyntaxKind.LastLiteralToken) || kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle || kind === ts.SyntaxKind.TemplateTail || kind === ts.SyntaxKind.TrueKeyword || kind === ts.SyntaxKind.FalseKeyword || kind === ts.SyntaxKind.NullKeyword) out.push(LITERAL);
    else out.push(kind);
  };
  leaf(sf);
  return out;
}

const MOD = 2_147_483_629;
const MOD_B = 2_147_483_587;

/**
 * The window starts whose window of `size` tokens also starts somewhere else in the corpus (another file, or another
 * place of the same file), kept per file: the entry at index i is how many window starts of `files[i]` are a duplicate,
 * and the entries sum to the `duplicate-tokens` count. A copy adds positions to the file it was copied from as well as
 * to the copy, so the file that was not changed is listed too. Two rolling hashes make the key, so a collision is a
 * mistake nobody will meet.
 */
export function duplicatePositionsByFile(files: number[][], size: number): number[] {
  const seen = new Map<string, number>();
  let top = 1;
  let topB = 1;
  for (let i = 1; i < size; i += 1) {
    top = (top * 257) % MOD;
    topB = (topB * 263) % MOD_B;
  }
  const keyOf = (a: number, b: number): string => `${a}:${b}`;
  const eachWindow = (visit: (key: string, file: number) => void): void => {
    for (const [file, tokens] of files.entries()) {
      if (tokens.length < size) continue;
      let h = 0;
      let g = 0;
      for (let i = 0; i < tokens.length; i += 1) {
        const t = tokens[i] + 3;
        if (i >= size) {
          const old = tokens[i - size] + 3;
          h = (h - ((old * top) % MOD) + MOD) % MOD;
          g = (g - ((old * topB) % MOD_B) + MOD_B) % MOD_B;
        }
        h = (h * 257 + t) % MOD;
        g = (g * 263 + t) % MOD_B;
        if (i >= size - 1) visit(keyOf(h, g), file);
      }
    }
  };
  eachWindow((key) => seen.set(key, (seen.get(key) ?? 0) + 1));
  const positions = files.map(() => 0);
  eachWindow((key, file) => { if ((seen.get(key) ?? 0) > 1) positions[file] += 1; });
  return positions;
}

// ---------------------------------------------------------------- imports and branches

/** the module specifiers a file imports: static, re-exported, `import("…")` and `require("…")` with a literal */
function importsOf(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) out.push(node.moduleReference.expression.text);
    else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) out.push((node.arguments[0] as ts.StringLiteralLike).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** the repo-relative path an import names, or null when it is a package or a built-in */
export function resolveImport(from: string, specifier: string, aliases: Record<string, string>): string | null {
  if (specifier.startsWith(".")) return posix.normalize(posix.join(dirname(from), specifier));
  const hit = Object.keys(aliases)
    .filter((a) => (a.endsWith("/") ? specifier.startsWith(a) : specifier === a))
    .sort((a, b) => b.length - a.length)[0];
  if (hit === undefined) return null;
  const to = aliases[hit];
  return hit.endsWith("/") ? posix.normalize(posix.join(to, specifier.slice(hit.length))) : to;
}

/**
 * What a workspace package's name stands for, read from its package.json: the name is its entry (`main`, else the
 * directory) and `name/…` a path under its `src/` (or the directory, when `main` is not under `src/`). A package under
 * the repo root's own package.json is not one: the root names the whole tree. The declaration's `aliases` win over these.
 */
export function workspaceAliases(root: string, files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of files) {
    if (posix.basename(file) !== "package.json" || posix.dirname(file) === ".") continue;
    let pkg: { name?: unknown; main?: unknown };
    try {
      pkg = JSON.parse(readFileSync(join(root, file), "utf8"));
    } catch {
      continue;
    }
    if (!pkg || typeof pkg.name !== "string" || pkg.name === "") continue;
    const dir = posix.dirname(file);
    const main = typeof pkg.main === "string" ? posix.normalize(posix.join(dir, pkg.main)) : null;
    out[pkg.name] = main ?? `${dir}/`;
    out[`${pkg.name}/`] = main?.startsWith(`${dir}/src/`) ? `${dir}/src/` : `${dir}/`;
  }
  return out;
}

/** the layer a repo-relative path belongs to: the one whose longest prefix matches, or null */
export function layerOf(path: string, layers: Record<string, string[]>): string | null {
  let best: string | null = null;
  let length = -1;
  for (const [name, prefixes] of Object.entries(layers)) {
    for (const p of prefixes) {
      if (isIn(path, [p]) && p.length > length) { best = name; length = p.length; }
    }
  }
  return best;
}

/** how many of a file's imports cross from its layer into a layer the declaration does not allow */
export function layerViolations(from: string, specifiers: string[], decl: StructureDecl): number {
  const mine = layerOf(from, decl.layers);
  if (!mine) return 0;
  let count = 0;
  for (const s of specifiers) {
    const target = resolveImport(from, s, decl.aliases);
    const there = target === null ? null : layerOf(target, decl.layers);
    if (there && there !== mine && !(decl.allow[mine] ?? []).includes(there)) count += 1;
  }
  return count;
}

const BRANCH_NODES = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.CaseClause, ts.SyntaxKind.CatchClause, ts.SyntaxKind.ConditionalExpression,
]);
const BRANCH_OPERATORS = new Set<ts.SyntaxKind>([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

/** the branch count of every function-like node of a file (1 + the branches in its own body, nested functions apart) */
function branchCounts(sf: ts.SourceFile): number[] {
  const out: number[] = [];
  const stack: number[] = [];
  const visit = (node: ts.Node): void => {
    const own = ts.isFunctionLike(node) && !!(node as ts.FunctionLikeDeclaration).body;
    if (own) stack.push(1);
    const branches = BRANCH_NODES.has(node.kind) || (ts.isBinaryExpression(node) && BRANCH_OPERATORS.has(node.operatorToken.kind));
    if (stack.length && branches) stack[stack.length - 1] += 1;
    ts.forEachChild(node, visit);
    if (own) out.push(stack.pop()!);
  };
  visit(sf);
  return out;
}

function anyTypes(sf: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

// ---------------------------------------------------------------- MoonBit

const MBT_FN = /^[ \t]*(?:pub(?:\([a-z]+\))?\s+|priv\s+)?(?:async\s+)?(?:extern\s+"js"\s+)?fn\s*(?:\[[^\]]*\]\s*)?([A-Za-z_][\w:]*)\s*(?:\[[^\]]*\]\s*)?\(/gm;
const MBT_JSON = /(?<![\w.@])Json\b/;

/** the named `fn` declarations of a MoonBit source that take or return `Json`, and its `_ =>` arms (line comments dropped) */
export function mbtLooseness(source: string): { jsonFunctions: number; wildcardArms: number } {
  const text = source.replace(/\/\/[^\n]*/g, "");
  let jsonFunctions = 0;
  for (const m of text.matchAll(MBT_FN)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let close = open;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")" && --depth === 0) { close = i; break; }
    }
    const signature = text.slice(open, close + 1);
    const returns = /^\s*->\s*([^{=\n]*)/.exec(text.slice(close + 1))?.[1] ?? "";
    if (MBT_JSON.test(signature) || MBT_JSON.test(returns)) jsonFunctions += 1;
  }
  return { jsonFunctions, wildcardArms: text.split("_ =>").length - 1 };
}

// ---------------------------------------------------------------- the whole tree

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** every count of the tree at `root`, by the declaration's rules */
export function scanTree(root: string, decl: StructureDecl): StructureCounts {
  return scanTreeDetailed(root, decl).counts;
}

/** the counts of a tree and, from the same pass, each file's share of `duplicate-tokens` (files with none left out, most first) */
export interface StructureScan {
  counts: StructureCounts;
  duplicateFiles: Array<{ path: string; positions: number }>;
}

export function scanTreeDetailed(root: string, decl: StructureDecl): StructureScan {
  const windows: number[][] = [];
  const windowFiles: string[] = [];
  const counts: StructureCounts = {
    "duplicate-tokens": 0,
    "layer-violations": 0,
    "large-files": 0,
    "complex-functions": 0,
    "any-types": 0,
    "mbt-json-functions": 0,
    "mbt-wildcard-arms": 0,
    "ts-reference-lines": 0,
  };
  const files = listFiles(root, decl.exclude);
  const rules: StructureDecl = { ...decl, aliases: { ...workspaceAliases(root, files), ...decl.aliases } };
  for (const file of files) {
    const ext = extname(file);
    const isTs = TS_EXT.has(ext) && !file.endsWith(".d.ts");
    if (!isTs && ext !== ".mbt") continue;
    const text = readFileSync(join(root, file), "utf8");
    const lines = lineCount(text);
    if (lines > decl.largeFileLines) counts["large-files"] += 1;
    if (ext === ".mbt") {
      if (MBT_TEST_FILE.test(file)) continue;
      const loose = mbtLooseness(text);
      counts["mbt-json-functions"] += loose.jsonFunctions;
      counts["mbt-wildcard-arms"] += loose.wildcardArms;
      continue;
    }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, SCRIPT_KIND[ext] ?? ts.ScriptKind.TS);
    windows.push(tokensOf(sf));
    windowFiles.push(file);
    counts["layer-violations"] += layerViolations(file, importsOf(sf), rules);
    counts["complex-functions"] += branchCounts(sf).filter((n) => n > decl.complexityLimit).length;
    counts["any-types"] += anyTypes(sf);
    if (REFERENCE_FILE.test(file)) counts["ts-reference-lines"] += lines;
  }
  const byFile = duplicatePositionsByFile(windows, decl.window);
  counts["duplicate-tokens"] = byFile.reduce((sum, n) => sum + n, 0);
  const duplicateFiles = windowFiles
    .map((path, i) => ({ path, positions: byFile[i] }))
    .filter((f) => f.positions > 0)
    .sort((a, b) => b.positions - a.positions || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { counts, duplicateFiles };
}
