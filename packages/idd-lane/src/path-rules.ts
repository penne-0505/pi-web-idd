import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";

import { load as yamlLoad } from "js-yaml";

import { isOverlayPath } from "../../idd-core/src/overlay/manifest.ts";
import { git } from "./git.ts";

/**
 * Project rules in Claude Code's layout: a `.claude/rules/**.md` whose frontmatter has `paths:` (globs
 * from the repo root) applies to the files those globs match, and one without applies to every file. A
 * lane is handed the rules without `paths:` and those its diff touches, so every harness gets the same
 * conventions whatever it loads itself. The rules are read from the diff's base (what is merged): a rule
 * the diff adds or rewrites is under review, not yet a convention.
 * Globs follow common globs (picomatch's defaults, dot files included): `**`, `*`, `?`, `[...]`, `{a,b}`
 * and `\` escapes. Extglobs (`!(x)`, `+(x)`) and numeric ranges (`{1..3}`) are not read. Whether this is
 * exactly how Claude Code matches `paths:` has not been checked.
 */
export const PATH_RULES_DIR = ".claude/rules";

export interface PathRule {
  /** repo-relative, with forward slashes */
  file: string;
  /** null: no `paths:`, so it applies to every file */
  paths: string[] | null;
  text: string;
}

export interface RuleRead {
  rules: PathRule[];
  /** why a rule or a glob was left out; a lane still starts */
  warnings: string[];
}

/** `a{b,c{d,e}}f` → abf, acdf, acef; a brace without a top-level comma stays literal */
function expandBraces(glob: string): string[] {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") { if (depth++ === 0) open = i; continue; }
    if (c !== "}" || depth === 0) continue;
    if (--depth > 0) continue;
    const body = glob.slice(open + 1, i);
    const parts: string[] = [];
    let d = 0;
    let from = 0;
    for (let j = 0; j < body.length; j++) {
      const b = body[j];
      if (b === "\\") { j++; continue; }
      if (b === "{") d++;
      else if (b === "}") d--;
      else if (b === "," && d === 0) { parts.push(body.slice(from, j)); from = j + 1; }
    }
    parts.push(body.slice(from));
    if (parts.length < 2) continue;
    const head = glob.slice(0, open);
    const rest = expandBraces(glob.slice(i + 1));
    return parts.flatMap((p) => expandBraces(p).flatMap((mid) => rest.map((tail) => `${head}${mid}${tail}`)));
  }
  return [glob];
}

const escapeRegex = (c: string) => c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** `[...]` from seg[at]: a leading `]` is a member, `!` or `^` negates, `\\` escapes; null when it does not close */
function classSource(seg: string, at: number): { src: string; end: number } | null {
  let i = at + 1;
  const negate = seg[i] === "!" || seg[i] === "^";
  if (negate) i++;
  let body = "";
  for (let first = true; i < seg.length; i++, first = false) {
    const c = seg[i];
    if (c === "]" && !first) return { src: negate ? `[^/${body}]` : `[${body}]`, end: i };
    if (c === "\\" && i + 1 < seg.length) body += escapeRegex(seg[++i]);
    else body += c === "-" ? "-" : escapeRegex(c);
  }
  return null;
}

function segmentSource(seg: string): string {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "\\" && i + 1 < seg.length) { out += escapeRegex(seg[++i]); continue; }
    if (c === "*") { while (seg[i + 1] === "*") i++; out += "[^/]*"; continue; }
    if (c === "?") { out += "[^/]"; continue; }
    if (c === "[") {
      const cls = classSource(seg, i);
      if (cls) { out += cls.src; i = cls.end; continue; }
    }
    out += escapeRegex(c);
  }
  return out;
}

/** one brace-free glob: `**` as a whole segment spans zero or more directories; dot files are not special */
function braceFreeSource(glob: string): string {
  const segs = glob.split("/");
  let out = "";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") {
      // leading or middle: zero or more whole directories; trailing: the directory itself or anything below
      if (last) out = i === 0 ? ".*" : `${out.replace(/\/$/, "")}(?:/.*)?`;
      else out += "(?:[^/]+/)*";
      return;
    }
    out += segmentSource(seg) + (last ? "" : "/");
  });
  return out;
}

const compiled = new Map<string, RegExp>();

/** throws when the glob cannot be compiled (a range out of order, `[z-a]`) */
export function globToRegExp(glob: string): RegExp {
  let re = compiled.get(glob);
  if (!re) {
    const rooted = glob.trim().replace(/^(?:\.\/|\/)+/, "");
    re = new RegExp(`^(?:${expandBraces(rooted).map(braceFreeSource).join("|")})$`);
    compiled.set(glob, re);
  }
  return re;
}

export function matchesPathGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path.replace(/^\.\//, ""));
}

/** one rule file; null when it cannot be read as a rule (the warning says why) */
export function parseRule(file: string, text: string, warnings: string[]): PathRule | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ""));
  if (!m) return { file, paths: null, text };
  let raw: unknown;
  try { raw = yamlLoad(m[1]); } catch (err) {
    warnings.push(`${file}: frontmatter を YAML として読めないので外しました（${err instanceof Error ? err.message.split("\n")[0] : String(err)}）`);
    return null;
  }
  const paths = raw && typeof raw === "object" ? (raw as Record<string, unknown>).paths : undefined;
  if (paths === undefined || paths === null || (Array.isArray(paths) && paths.length === 0)) return { file, paths: null, text };
  if (typeof paths === "string") return { file, paths: [paths], text };
  if (!Array.isArray(paths)) {
    warnings.push(`${file}: paths が glob の並びではないので外しました`);
    return null;
  }
  const globs = paths.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  if (globs.length < paths.length) warnings.push(`${file}: paths のうち glob でない ${paths.length - globs.length} 件を外しました`);
  return { file, paths: globs, text };
}

/** a diff's names or a rule file can be far over execFileSync's 1 MB default */
const GIT_BUFFER = 256 * 1024 * 1024;

const gitOut = (repo: string, args: string[]) => git(repo, args, { maxBuffer: GIT_BUFFER });
const why = (err: unknown) => (err instanceof Error ? (err as Error & { stderr?: string }).stderr?.trim() || err.message : String(err)).split("\n")[0];

/** `<mode> <type> <oid>\t<path>` entries of `git ls-tree -z` */
function treeEntries(repo: string, rev: string, path: string, recursive: boolean): { mode: string; type: string; oid: string; path: string }[] {
  const out = gitOut(repo, ["ls-tree", ...(recursive ? ["-r"] : []), "-z", "--full-tree", rev, "--", path]);
  return out.split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, type, oid] = line.slice(0, tab).split(" ");
    return { mode, type, oid, path: line.slice(tab + 1) };
  });
}

/** a file's text at a commit, through symlinks that stay inside the repo (`at` is the file the text was read from); a string is the reason it could not be read */
function textAt(repo: string, rev: string, path: string): { text: string; at: string } | string {
  let at = path;
  for (let hop = 0; hop < 8; hop++) {
    const [entry] = treeEntries(repo, rev, at, false);
    if (!entry || entry.type !== "blob") return `${rev} に ${at} のファイルがありません`;
    const text = gitOut(repo, ["cat-file", "blob", entry.oid]);
    if (entry.mode !== "120000") return { text, at };
    if (posix.isAbsolute(text)) return `シンボリックリンクの先（${text}）が repo の外です`;
    const next = posix.normalize(posix.join(posix.dirname(at), text));
    if (next === ".." || next.startsWith("../")) return `シンボリックリンクの先（${text}）が repo の外です`;
    at = next;
  }
  return "シンボリックリンクが深すぎます";
}

/** the rules under `.claude/rules` at a commit; one that cannot be read is left out with a warning */
export function readRulesAt(repo: string, rev: string): RuleRead {
  let entries;
  try {
    entries = treeEntries(repo, rev, PATH_RULES_DIR, true);
  } catch (err) {
    return { rules: [], warnings: [`${rev} の ${PATH_RULES_DIR} を読めないので、規則を渡せませんでした: ${why(err)}`] };
  }
  const rules: PathRule[] = [];
  const warnings: string[] = [];
  for (const e of entries) {
    if (e.type !== "blob" || !e.path.endsWith(".md")) continue;
    let got;
    try { got = textAt(repo, rev, e.path); } catch (err) { got = why(err); }
    if (typeof got === "string") {
      warnings.push(`${e.path}: 読めないので外しました（${got}）`);
      continue;
    }
    const rule = parseRule(e.path, got.text, warnings);
    if (rule) rules.push(rule);
  }
  return { rules: rules.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0)), warnings };
}

export interface RuleSelection {
  rules: string[];
  warnings: string[];
}

/**
 * The rules without `paths:`, and those whose `paths:` match at least one of the files. A glob that
 * cannot be compiled is dropped, the rule's other globs still apply.
 */
export function selectRules(read: RuleRead, files: string[]): RuleSelection {
  const warnings = [...read.warnings];
  const picked = read.rules.filter((r) => {
    if (r.paths === null) return true;
    const globs = r.paths.flatMap((g) => {
      try { return [globToRegExp(g)]; } catch (err) {
        warnings.push(`${r.file}: paths の glob を外しました（${g}: ${err instanceof Error ? err.message : String(err)}）`);
        return [];
      }
    });
    return files.some((f) => globs.some((re) => re.test(f.replace(/^\.\//, ""))));
  });
  return { rules: picked.map((r) => r.file), warnings };
}

export function rulesForPaths(repo: string, rev: string, files: string[]): RuleSelection {
  return selectRules(readRulesAt(repo, rev), files);
}

/** every path the diff touches, both sides of a rename; no paths and the reason when it cannot be read */
export function diffPaths(worktree: string, base: string, head: string): { paths: string[]; warning?: string } {
  if (!existsSync(worktree)) return { paths: [], warning: `差分を読めません（${worktree} がありません）` };
  let out: string;
  try {
    out = gitOut(worktree, ["diff", "--name-only", "--no-renames", "-z", base, head]);
  } catch (err) {
    return { paths: [], warning: `差分（${base}..${head}）を読めないので、差分に当たる規則を選べませんでした: ${why(err)}` };
  }
  return { paths: [...new Set(out.split("\0").filter(Boolean))].sort() };
}

/**
 * The rules a lane with this diff reads, from the base. A rule the lane's checkout (the head) has as
 * is stays repo-relative; one the diff rewrites or deletes is written under `out` and handed by its
 * absolute path, so the lane reads the base's version. Never throws: what cannot be read is left out
 * with a warning, so a lane still starts. A rule `omit` (overlay manifest rows) names is a record: it is
 * neither handed nor written under `out`.
 */
export function diffRules(opts: { repo: string; base: string; head: string; out: string; omit?: string[] }): RuleSelection {
  try {
    return readDiffRules(opts);
  } catch (err) {
    return { rules: [], warnings: [`${PATH_RULES_DIR} を読めませんでした: ${why(err)}`] };
  }
}

/** the base's text as the lane should read it: repo-relative when the head has it as is, else a copy under `out` */
function handFromBase(opts: { repo: string; head: string; out: string }, file: string, base: string, warnings: string[]): string | null {
  let head: ReturnType<typeof textAt>;
  try { head = textAt(opts.repo, opts.head, file); } catch (err) { head = why(err); }
  if (typeof head !== "string" && head.text === base) return file;
  const copy = join(opts.out, "base-rules", file);
  try {
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, base);
    return copy;
  } catch (err) {
    warnings.push(`${file}: base の版を書き出せないので外しました（${why(err)}）`);
    return null;
  }
}

/**
 * for the stage's record (spec.yaml, stderr), never its brief: the reader cannot check a boundary it is told of.
 * a manifest row marks a file propter manages, not the repo's own convention, so no stage reads it as a rule (C-284-2)
 */
const recordOmitted = (file: string) => `${file}: overlay.manifest の行に当たる file なので、規則として渡しません（propter が管理する file で、repo の規約ではない）`;

/** the file a rule's text is read from, which is another file when the rule is a symlink */
function sourceAt(repo: string, rev: string, file: string): string | undefined {
  try {
    const got = textAt(repo, rev, file);
    return typeof got === "string" ? undefined : got.at;
  } catch { return undefined; }
}

/** an absolute symlink target as a repo-relative path when it resolves to a file inside the repo; undefined for outside or unresolvable */
function insideRepo(repo: string, target: string): string | undefined {
  try {
    const rel = relative(realpathSync(repo), realpathSync(target));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    return rel.split(sep).join("/");
  } catch { return undefined; }
}

/** the file a checkout's rule reads from, through symlinks that stay inside the repo like `textAt`; undefined when it cannot be followed */
function sourceInCheckout(repo: string, file: string): string | undefined {
  let at = file;
  try {
    for (let hop = 0; hop < 8; hop++) {
      if (!lstatSync(join(repo, at)).isSymbolicLink()) return at;
      const to = readlinkSync(join(repo, at));
      const next = posix.isAbsolute(to) ? insideRepo(repo, to) : posix.normalize(posix.join(posix.dirname(at), to));
      if (next === undefined) return undefined;
      if (next === ".." || next.startsWith("../")) return undefined;
      at = next;
    }
  } catch { /* unreadable: no source to judge by */ }
  return undefined;
}

/** a rule file the manifest rows name, or one that reads its text from such a file */
const isRecord = (omit: string[] | undefined, file: string, via?: string) => !!omit?.length && (isOverlayPath(omit, file) || (via !== undefined && isOverlayPath(omit, via)));

function readDiffRules(opts: { repo: string; base: string; head: string; out: string; omit?: string[] }): RuleSelection {
  const diff = diffPaths(opts.repo, opts.base, opts.head);
  const read = readRulesAt(opts.repo, opts.base);
  const picked = selectRules(read, diff.paths);
  const warnings = [...(diff.warning ? [diff.warning] : []), ...picked.warnings];
  const rules: string[] = [];
  for (const file of picked.rules) {
    if (opts.omit?.length && isRecord(opts.omit, file, sourceAt(opts.repo, opts.base, file))) { warnings.push(recordOmitted(file)); continue; }
    const handed = handFromBase(opts, file, read.rules.find((r) => r.file === file)!.text, warnings);
    if (handed) rules.push(handed);
  }
  return { rules, warnings };
}

/**
 * Fixed rule files (`AGENTS.md` and the like) as the base has them, handed like `diffRules`: one the
 * diff rewrites or deletes as the base's copy, one the base does not have not at all. With no base,
 * or a base git cannot read, the checkout's files are handed as they are, with a warning. A file `omit`
 * (overlay manifest rows) names is a record and is not handed. Never throws.
 */
export function baseFiles(opts: { repo: string; base: string; head: string; out: string; files: string[]; omit?: string[] }): RuleSelection {
  const fromCheckout = (reason: string): RuleSelection => {
    const present = opts.files.filter((f) => existsSync(join(opts.repo, f)));
    const omitted = present.filter((f) => !!opts.omit?.length && isRecord(opts.omit, f, sourceInCheckout(opts.repo, f)));
    return {
      rules: present.filter((f) => !omitted.includes(f)),
      warnings: [`${reason}ので、${opts.files.join("・")} は worktree の版を渡します`, ...omitted.map(recordOmitted)],
    };
  };
  if (!opts.base) return fromCheckout("diff.base が無い");
  try {
    gitOut(opts.repo, ["cat-file", "-e", `${opts.base}^{commit}`]);
  } catch (err) {
    return fromCheckout(`base（${opts.base}）を読めない（${why(err)}）`);
  }
  const rules: string[] = [];
  const warnings: string[] = [];
  for (const file of opts.files) {
    try {
      if (!treeEntries(opts.repo, opts.base, file, false).length) continue;
      if (isRecord(opts.omit, file)) { warnings.push(recordOmitted(file)); continue; }
      const base = textAt(opts.repo, opts.base, file);
      if (typeof base === "string") { warnings.push(`${file}: 読めないので外しました（${base}）`); continue; }
      if (isRecord(opts.omit, file, base.at)) { warnings.push(recordOmitted(file)); continue; }
      const handed = handFromBase(opts, file, base.text, warnings);
      if (handed) rules.push(handed);
    } catch (err) {
      warnings.push(`${file}: 読めないので外しました（${why(err)}）`);
    }
  }
  return { rules, warnings };
}

/**
 * The fixed rule files of a checkout that the overlay manifest rows do not name: a file a row names, or a symlink that
 * reads from one, is the harness's own and is left out. Files a person named for a run are not passed through this.
 */
export function withoutManifestRows(repo: string, files: string[], rows: string[]): string[] {
  return files.filter((f) => !isRecord(rows, f, sourceInCheckout(repo, f)));
}

/**
 * What a lane reads first: the fixed rule files, then the `.claude/rules` that apply to the diff, both as
 * the base has them (`baseFiles` / `diffRules`). `omit` is the overlay manifest rows of a stage kept from the
 * records: a rule they name is left out of both. Never throws.
 */
export function laneRules(opts: { repo: string; base: string; head: string; out: string; files: string[]; omit?: string[] }): RuleSelection {
  const own = baseFiles(opts);
  const scoped = diffRules(opts);
  return { rules: [...new Set([...own.rules, ...scoped.rules])], warnings: [...own.warnings, ...scoped.warnings] };
}
