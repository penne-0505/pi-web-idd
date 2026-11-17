// Deno版 survey validator: 確かめた事実を書く恒久文書 (survey) の型を機械検査する。
// 検査は 4 つ: 置き場の形、節 (問い・条件・結果・確かめていないこと) の有無と順、
// 参照の向き (DEC など → survey の一方向)、書いた後の本文の書き換え。
// 置き場 (_docs/survey/) が無い repo では何も検査せずに通る。

import { loadScope, makeInScope } from "./scope.ts";

type YamlValue = string | number | boolean | YamlValue[];
type FrontMatter = Record<string, YamlValue>;

type ValidationItem = {
  file: string;
  message: string;
};

const SURVEY_PATH_RE =
  /^_docs\/survey\/([A-Za-z][A-Za-z0-9_-]*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/survey\.md$/;

const REQUIRED_SECTIONS = [
  "問い",
  "条件",
  "結果",
  "確かめていないこと",
] as const;

// survey が指してはいけない置き場。参照は DEC など → survey の一方向である。
const FORBIDDEN_DIRS = [
  "_docs/intent/",
  "_docs/qa/",
  "_docs/plan/",
  "_docs/archives/plan/",
  "_docs/guide/",
  "_docs/reference/",
] as const;

const ROOT_RELATIVE_PREFIXES = ["_docs/", "_meta/", ".agents/"] as const;
// DEC / INV の ID は 3 つの形 (Ф号だけ・lane・手書き) を、短い ID を長い ID の先頭から読まないよう丸ごと 1 語で読む。
const ID_MENTION_RE =
  "\\b(?:AC-\\d+|(?:DEC|INV)-(?:\\d+(?:-[1-9]\\d*)?|[A-Za-z][A-Za-z0-9_-]*-[1-9]\\d*))\\b";

const normalizePath = (path: string): string => {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
};

const dirname = (path: string): string => {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "." : normalized.slice(0, index);
};

const walkFiles = async function* (
  dir: string,
  predicate: (path: string) => boolean,
): AsyncGenerator<string> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        yield* walkFiles(path, predicate);
      } else if (entry.isFile && predicate(path)) {
        yield normalizePath(path);
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
};

const collectMarkdownFiles = async function* (
  roots: string[],
): AsyncGenerator<string> {
  for (const root of roots) {
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(root);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      throw err;
    }
    if (stat.isFile) {
      if (root.endsWith(".md")) yield normalizePath(root);
      continue;
    }
    yield* walkFiles(root, (path) => path.endsWith(".md"));
  }
};

const stripInlineComment = (value: string): string => {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && value[i - 1] !== "\\") {
      quote = quote === ch ? null : quote ?? ch;
    }
    if (ch === "#" && quote === null) return value.slice(0, i).trim();
  }
  return value.trim();
};

const parseScalar = (raw: string): YamlValue => {
  const value = stripInlineComment(raw);
  if (value === "") return "";
  if (value === "[]") return [];
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => parseScalar(item));
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
};

type SplitDocument = {
  attrs: FrontMatter | null;
  bodyLines: string[];
  error: string | null;
};

const splitDocument = (src: string): SplitDocument => {
  const lines = src.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { attrs: null, bodyLines: lines, error: "missing front matter" };
  }
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end === -1) {
    return {
      attrs: null,
      bodyLines: lines,
      error: "front matter is not closed",
    };
  }

  const attrs: FrontMatter = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/);
    if (!match) {
      return {
        attrs: null,
        bodyLines: lines.slice(end + 1),
        error: `unsupported front matter line: ${line}`,
      };
    }
    const [, key, rest = ""] = match;
    if (rest.trim() !== "") {
      attrs[key] = parseScalar(rest);
      continue;
    }
    const values: YamlValue[] = [];
    let cursor = i + 1;
    while (cursor < end) {
      const item = lines[cursor].match(/^\s+-\s+(.*)$/);
      if (!item) break;
      values.push(parseScalar(item[1]));
      cursor += 1;
    }
    attrs[key] = values.length > 0 ? values : "";
    if (values.length > 0) i = cursor - 1;
  }
  return { attrs, bodyLines: lines.slice(end + 1), error: null };
};

// frontmatter の閉じ線より後を本文とする。行末の差で揺れないよう
// 改行を正規化して比べる。
const bodyOf = (src: string): string => splitDocument(src).bodyLines.join("\n");

const stripCodeBlocks = (body: string): string => {
  const output: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      output.push("");
      continue;
    }
    output.push(inFence ? "" : line);
  }
  return output.join("\n");
};

const isExternal = (target: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");

const resolveTarget = (fromFile: string, raw: string): string | null => {
  let target = raw.trim();
  if (target.startsWith("<")) {
    const close = target.indexOf(">");
    target = close === -1 ? target.slice(1) : target.slice(1, close);
  } else {
    target = target.split(/\s+/)[0];
  }
  target = target.split("#")[0].split("?")[0];
  if (target === "" || isExternal(target) || target.startsWith("/")) {
    return null;
  }
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }
  const rootRelative = (ROOT_RELATIVE_PREFIXES as readonly string[]).some(
    (prefix) => decoded.startsWith(prefix),
  );
  const base = rootRelative ? "." : dirname(fromFile);
  return normalizePath(`${base}/${decoded}`);
};

const forbiddenDirection = (target: string): boolean =>
  (FORBIDDEN_DIRS as readonly string[]).some((dir) => target.startsWith(dir));

const markdownTargets = (body: string): string[] => {
  const targets: string[] = [];
  const linkRe = /!?\[[^\]]*]\(([^)]+)\)/g;
  for (const match of body.matchAll(linkRe)) targets.push(match[1]);
  const definitionRe = /^\s{0,3}\[([^\]]+)]:\s*(\S+(?:\s+\S+)*)\s*$/gm;
  for (const match of body.matchAll(definitionRe)) targets.push(match[2]);
  return targets;
};

const gitLines = async (
  cwd: string | null,
  args: string[],
): Promise<string[] | null> => {
  const env = { ...Deno.env.toObject() };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("git", {
      args,
      cwd: cwd ?? undefined,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch {
    return null;
  }
  if (!output.success) return null;
  return new TextDecoder()
    .decode(output.stdout)
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean);
};

const gitFileAt = async (
  commit: string,
  path: string,
): Promise<string | null> => {
  const env = { ...Deno.env.toObject() };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("git", {
      args: ["show", `${commit}:${path}`],
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch {
    return null;
  }
  return output.success ? new TextDecoder().decode(output.stdout) : null;
};

const validateSections = (
  file: string,
  body: string,
  errors: ValidationItem[],
): void => {
  const headings: string[] = [];
  for (const line of stripCodeBlocks(body).split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match || match[1].length !== 2) continue;
    headings.push(match[2].trim());
  }

  const indices: number[] = [];
  for (const section of REQUIRED_SECTIONS) {
    const found = headings.filter((heading) => heading === section).length;
    if (found === 0) {
      errors.push({
        file,
        message: `missing required section: ## ${section}`,
      });
      indices.push(-1);
      continue;
    }
    if (found > 1) {
      errors.push({
        file,
        message: `duplicate section: ## ${section}`,
      });
    }
    indices.push(headings.indexOf(section));
  }
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i - 1] === -1 || indices[i] === -1) continue;
    if (indices[i] < indices[i - 1]) {
      errors.push({
        file,
        message: `section order must be ${REQUIRED_SECTIONS.join(" → ")}`,
      });
      break;
    }
  }
};

const validateDirection = (
  file: string,
  attrs: FrontMatter,
  body: string,
  errors: ValidationItem[],
): void => {
  const references = attrs.references;
  if (
    references !== undefined && references !== "" && !Array.isArray(references)
  ) {
    errors.push({
      file,
      message: "front matter references must be an array",
    });
  } else if (Array.isArray(references)) {
    for (const ref of references) {
      if (typeof ref !== "string") {
        errors.push({
          file,
          message: "front matter references must contain only strings",
        });
        continue;
      }
      const resolved = resolveTarget(file, ref);
      if (resolved === null || !forbiddenDirection(resolved)) continue;
      errors.push({
        file,
        message:
          `survey must not reference judgments or plans (${ref}); references run from DEC or QA to survey, never the reverse`,
      });
    }
  }

  const visible = stripCodeBlocks(body);
  for (const target of markdownTargets(visible)) {
    const resolved = resolveTarget(file, target);
    if (resolved === null || !forbiddenDirection(resolved)) continue;
    errors.push({
      file,
      message:
        `survey must not link to judgments or plans (${target}); references run from DEC or QA to survey, never the reverse`,
    });
  }

  for (const match of visible.matchAll(new RegExp(ID_MENTION_RE, "g"))) {
    errors.push({
      file,
      message: `survey must not mention ${
        match[0]
      }; DEC / INV / AC IDs belong to the intent ledger`,
    });
  }
};

// 足した commit を探す。`--follow` は名前を替えた file を追うが、中身が同じ別の
// file を rename と見て無関係な commit を返すことがある。候補を集め、その commit に
// 本当にその path があるかを `git show` で確かめてから使う。
const addedCommits = async (file: string): Promise<string[] | null> => {
  const follow = await gitLines(null, [
    "log",
    "--diff-filter=A",
    "--follow",
    "--format=%H",
    "--",
    file,
  ]);
  if (follow === null) return null;
  const plain = await gitLines(null, [
    "log",
    "--diff-filter=A",
    "--format=%H",
    "--",
    file,
  ]);
  if (plain === null) return null;
  return [...new Set([...follow, ...plain])];
};

const isShallowRepository = async (): Promise<boolean> => {
  const result = await gitLines(null, [
    "rev-parse",
    "--is-shallow-repository",
  ]);
  return result !== null && result[0] === "true";
};

// 候補が本当にその file を足した commit かを確かめる。浅い clone の境界の commit は
// 親を持たないので、足した commit と取り違えない。
const isAddCommit = async (commit: string, file: string): Promise<boolean> => {
  const parent = await gitLines(null, [
    "rev-parse",
    "--verify",
    `${commit}^`,
  ]);
  if (parent === null || parent.length === 0) return false;
  const atParent = await gitLines(null, [
    "cat-file",
    "-e",
    `${parent[0]}:${file}`,
  ]);
  return atParent === null;
};

const validateRewrite = async (
  file: string,
  src: string,
  warnings: ValidationItem[],
  errors: ValidationItem[],
): Promise<void> => {
  const candidates = await addedCommits(file);
  if (candidates === null) {
    warnings.push({
      file,
      message:
        "could not read git history (need --allow-run=git); skipping the rewrite check",
    });
    return;
  }
  if (candidates.length === 0) {
    const tracked = await gitLines(null, [
      "ls-files",
      "--error-unmatch",
      "--",
      file,
    ]);
    // まだ commit されていない survey は比べる相手が無い。tracked なのに add が
    // 見つからないときは浅い clone とみなす。
    if (tracked !== null) {
      warnings.push({
        file,
        message:
          "no commit that added this survey (shallow clone?); skipping the rewrite check",
      });
    }
    return;
  }

  let original: string | null = null;
  for (const commit of candidates) {
    if (!await isAddCommit(commit, file)) continue;
    original = await gitFileAt(commit, file);
    if (original !== null) break;
  }
  if (original === null) {
    warnings.push({
      file,
      message: await isShallowRepository()
        ? "shallow clone: cannot confirm the commit that added this survey; skipping the rewrite check"
        : "could not confirm the commit that added this survey; skipping the rewrite check",
    });
    return;
  }
  if (bodyOf(original) !== bodyOf(src)) {
    errors.push({
      file,
      message:
        "survey body changed after it was added; write a new survey and set the old one's status to superseded",
    });
  }
};

const parseArgs = (
  args: string[],
): { roots: string[]; fixtureMode: boolean } => {
  if (args.length === 0) return { roots: ["_docs/survey"], fixtureMode: false };
  if (args[0] === "--fixture") {
    return { roots: args.slice(1), fixtureMode: true };
  }
  return { roots: args, fixtureMode: false };
};

const report = (
  prefix: string,
  items: ValidationItem[],
  logger: (message: string) => void,
): void => {
  const grouped = new Map<string, string[]>();
  for (const item of items) {
    if (!grouped.has(item.file)) grouped.set(item.file, []);
    grouped.get(item.file)!.push(item.message);
  }
  for (const [file, messages] of grouped) {
    logger(`${prefix}: ${file}`);
    for (const message of messages) logger(`  - ${message}`);
  }
};

const run = async (): Promise<void> => {
  const errors: ValidationItem[] = [];
  const warnings: ValidationItem[] = [];
  const { roots, fixtureMode } = parseArgs(Deno.args);
  const inScope = makeInScope(await loadScope());

  if (roots.length === 0) {
    errors.push({
      file: "(args)",
      message: "--fixture requires at least one path",
    });
  }

  for await (const file of collectMarkdownFiles(roots)) {
    if (!inScope(file)) continue;
    const src = await Deno.readTextFile(file);
    const { attrs, bodyLines, error } = splitDocument(src);
    if (error || !attrs) {
      errors.push({ file, message: error ?? "missing front matter" });
      continue;
    }
    const effectivePath = fixtureMode && typeof attrs.fixture_path === "string"
      ? normalizePath(attrs.fixture_path)
      : file;
    if (!SURVEY_PATH_RE.test(effectivePath)) {
      errors.push({
        file,
        message: "survey path must match _docs/survey/<Area>/<slug>/survey.md",
      });
      continue;
    }

    const body = bodyLines.join("\n");
    validateSections(file, body, errors);
    validateDirection(file, attrs, body, errors);
    // fixture は commit の履歴を持たない。書き換えの検査は git の実 repo で行う。
    if (!fixtureMode) {
      await validateRewrite(file, src, warnings, errors);
    }
  }

  report("WARN", warnings, console.warn);
  if (errors.length) {
    report("ERROR", errors, console.error);
    Deno.exit(1);
  }
};

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  Deno.exit(1);
});
