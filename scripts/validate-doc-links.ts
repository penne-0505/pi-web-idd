// Deno版 Markdown link / front-matter reference validator: npm / remote import 依存なし

import { loadScope, makeInScope } from "./scope.ts";
import type { DocScope, InScopePredicate } from "./scope.ts";

type YamlValue = string | number | boolean | YamlValue[];
type FrontMatter = Record<string, YamlValue>;

type FrontMatterParseResult = {
  attrs: FrontMatter | null;
  error: string | null;
};

type ValidationItem = {
  file: string;
  message: string;
};

type SplitTarget = {
  clean: string;
  anchor: string;
};

const DOC_ROOTS = ["_docs", "_meta"] as const;
const ROOT_FILES = [
  "README.md",
  "AGENTS.md",
  "TODO.md",
  "QUICKSTART.md",
] as const;
const ARCHIVE_TYPES = ["draft", "plan", "survey", "intent"] as const;
const FORBIDDEN_ARCHIVE_TYPES = ["qa", "guide", "reference"] as const;
const INTENT_ROOT = "_docs/intent/";
const ARCHIVE_INTENT_ROOT = "_docs/archives/intent/";
const ROOT_RELATIVE_PREFIXES = [
  "_docs/",
  "_meta/",
  ".agents/",
  ".claude/",
  ".github/",
  "scripts/",
] as const;
const ROOT_RELATIVE_FILES = [
  "README.md",
  "AGENTS.md",
  "TODO.md",
  "QUICKSTART.md",
  "LICENSE.txt",
] as const;
const FIXTURE_ROOT = "_meta/validator-fixtures/";
const STARTER_ROOT = "starter/";

/**
 * A plan in the request form opens with `## 依頼`; one written before the switch opens with the design form's
 * sections. The plan itself carries the shape, read the same way the plan review reads it, so no marker is added.
 *
 * A plan written before the switch to the state shape cannot be told apart from the old shape by its heading, so
 * its own references carry the shape too: a lane whose records are documents names its corresponding
 * `decision.md` there (the plan template does), and a lane whose records are the state has none to name.
 */
const REQUEST_FORM_HEADING = /^##\s*依頼\s*$/m;

/** whether the plan names `wanted` among the references it carries in its own front matter */
const namedReference = (
  file: string,
  attrs: FrontMatter | null,
  wanted: string[],
): boolean =>
  (Array.isArray(attrs?.references) ? attrs.references : []).some(
    (ref) =>
      typeof ref === "string" &&
      wanted.includes(resolveTarget(file, ref) ?? ""),
  );

const normalizePath = (path: string): string => {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
};

// The package root this validator ships in. A repo adopted by `idd repo init` keeps none of `_docs/standards/`,
// so a record's link into the norms is resolved against the package that holds them (DEC-1529).
const PACKAGE_ROOT = (() => {
  try {
    // normalizePath drops the leading slash; keep it, or Deno.stat would resolve the path against the cwd
    const raw = decodeURIComponent(new URL(".", import.meta.url).pathname);
    const abs = raw.startsWith("/") ? raw : `/${raw}`;
    const normalized = normalizePath(`${abs}/..`);
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  } catch {
    return "";
  }
})();

const dirname = (path: string): string => {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "." : normalized.slice(0, index);
};

const FETCHED_DIRS = new Set([".mooncakes", "node_modules"]);

const walkFiles = async function* (
  dir: string,
  predicate: (path: string) => boolean = () => true,
  skipFetched = false,
): AsyncGenerator<string> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (normalizePath(path) === "_meta/scratch") continue;
      // a toolchain's fetched dependencies are not the repo's documents
      if (skipFetched && entry.isDirectory && FETCHED_DIRS.has(entry.name)) {
        continue;
      }
      if (entry.isDirectory) {
        yield* walkFiles(path, predicate, skipFetched);
      } else if (entry.isFile && predicate(path)) {
        yield normalizePath(path);
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
};

const isExternal = (target: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(target) ||
  target.startsWith("//");

const isTemplatePlaceholder = (target: string): boolean =>
  /<[^>]+>/.test(target);
const isValidatorFixture = (file: string): boolean =>
  file.startsWith(FIXTURE_ROOT);

/**
 * A closed lane's decision.md is moved to `_docs/archives/intent/` at the same relative path, so a reference
 * that names the old `_docs/intent/` path still resolves. The rewrite never leaves the intent place: a missing
 * target under `_docs/qa/` or elsewhere is left to fail as before (DEC-120-7).
 */
const archivedIntentPath = (path: string): string | null =>
  path.startsWith(INTENT_ROOT)
    ? `${ARCHIVE_INTENT_ROOT}${path.slice(INTENT_ROOT.length)}`
    : null;

const stripCodeBlocks = (src: string): string => {
  const output: string[] = [];
  let inFence = false;
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      output.push("");
      continue;
    }
    output.push(inFence ? "" : line);
  }
  return output.join("\n");
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

const splitInlineArray = (value: string): string[] => {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of value) {
    if ((ch === '"' || ch === "'") && current.at(-1) !== "\\") {
      quote = quote === ch ? null : quote ?? ch;
    }
    if (ch === "," && quote === null) {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") items.push(current.trim());
  return items;
};

const parseScalar = (raw: string): YamlValue => {
  const value = stripInlineComment(raw);
  if (value === "") return "";
  if (value === "[]") return [];
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return splitInlineArray(inner).map(parseScalar);
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

const parseFrontMatter = (src: string): FrontMatterParseResult => {
  const lines = src.split(/\r?\n/);
  if (lines[0] !== "---") return { attrs: null, error: null };
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end === -1) return { attrs: null, error: "front matter is not closed" };

  const attrs: FrontMatter = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/);
    if (!match) {
      return { attrs: null, error: `unsupported front matter line: ${line}` };
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
    if (values.length > 0) {
      attrs[key] = values;
      i = cursor - 1;
    } else {
      attrs[key] = "";
    }
  }
  return { attrs, error: null };
};

const normalizeLinkTarget = (raw: string): string => {
  let target = raw.trim();
  if (target.startsWith("<")) {
    const close = target.indexOf(">");
    target = close === -1 ? target.slice(1) : target.slice(1, close);
  } else {
    target = target.split(/\s+/)[0];
  }
  return target;
};

const referenceDefinitions = (body: string): Map<string, string> => {
  const refs = new Map<string, string>();
  const defRe = /^\s{0,3}\[([^\]]+)]:\s*(\S+(?:\s+\S+)*)\s*$/gm;
  for (const match of body.matchAll(defRe)) {
    refs.set(match[1].trim().toLowerCase(), normalizeLinkTarget(match[2]));
  }
  return refs;
};

const extractInlineMarkdownTargets = (body: string): string[] => {
  const targets: string[] = [];
  const linkRe = /!?\[[^\]]*]\(([^)]+)\)/g;
  for (const match of body.matchAll(linkRe)) {
    targets.push(normalizeLinkTarget(match[1]));
  }
  return targets;
};

const extractReferenceMarkdownTargets = (
  file: string,
  body: string,
  errors: ValidationItem[],
): string[] => {
  const targets: string[] = [];
  const refs = referenceDefinitions(body);
  for (const target of refs.values()) targets.push(target);

  const usageRe = /!?\[([^\]]+)]\[([^\]]*)]/g;
  for (const match of body.matchAll(usageRe)) {
    const label = match[2].trim() === "" ? match[1].trim() : match[2].trim();
    const target = refs.get(label.toLowerCase());
    if (target === undefined) {
      errors.push({
        file,
        message: `missing reference-style link definition: ${label}`,
      });
      continue;
    }
    targets.push(target);
  }
  return targets;
};

const extractMarkdownTargets = (
  file: string,
  src: string,
  errors: ValidationItem[],
): string[] => {
  const body = stripCodeBlocks(src);
  return [
    ...extractInlineMarkdownTargets(body),
    ...extractReferenceMarkdownTargets(file, body, errors),
  ];
};

const splitTarget = (target: string): SplitTarget => {
  const [beforeAnchor, rawAnchor = ""] = target.split("#");
  const clean = beforeAnchor.split("?")[0];
  return {
    clean,
    anchor: rawAnchor === "" ? "" : rawAnchor.split("?")[0],
  };
};

const isRootRelative = (target: string): boolean =>
  ROOT_RELATIVE_PREFIXES.some((prefix) => target.startsWith(prefix)) ||
  (ROOT_RELATIVE_FILES as readonly string[]).includes(target);

const resolveTarget = (fromFile: string, target: string): string | null => {
  if (isExternal(target)) return null;
  const { clean } = splitTarget(target);
  if (clean === "") return normalizePath(fromFile);
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  if (decoded.startsWith("/")) return null;
  const base = isRootRelative(decoded) ? "." : dirname(fromFile);
  return normalizePath(`${base}/${decoded}`);
};

const decodeAnchor = (anchor: string): string => {
  try {
    return decodeURIComponent(anchor);
  } catch {
    return anchor;
  }
};

const slugifyHeading = (heading: string): string =>
  heading
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");

const headingAnchors = async (
  file: string,
  cache: Map<string, Set<string>>,
): Promise<Set<string>> => {
  if (cache.has(file)) return cache.get(file)!;
  const src = await Deno.readTextFile(file);
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of stripCodeBlocks(src).split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const base = slugifyHeading(match[1]);
    if (base === "") continue;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  cache.set(file, anchors);
  return anchors;
};

const validateLocalTarget = async (
  fromFile: string,
  target: string,
  errors: ValidationItem[],
  anchorCache: Map<string, Set<string>>,
): Promise<void> => {
  if (isTemplatePlaceholder(target)) return;
  const initial = resolveTarget(fromFile, target);
  if (!initial) return;
  // 未初期化 template では、利用者向けファイルが starter/ に畳まれている。
  // README / QUICKSTART のリンクは展開後の layout を指すのが正しいため、
  // root で見つからない場合だけ starter/ を同一 target として許容する。
  const archivedIntent = archivedIntentPath(initial);
  const candidate = await exists(initial)
    ? initial
    : archivedIntent && await exists(archivedIntent)
    ? archivedIntent
    : await exists(`${STARTER_ROOT}${initial}`)
    ? `${STARTER_ROOT}${initial}`
    : initial;
  // 規約の写しを持たない採用先: `_docs/standards/` へのリンクはパッケージ側で解く
  const packageCandidate =
    PACKAGE_ROOT && candidate.startsWith("_docs/standards/")
      ? `${PACKAGE_ROOT}/${candidate}`
      : null;
  const resolved = await exists(candidate)
    ? candidate
    : packageCandidate && await exists(packageCandidate)
    ? packageCandidate
    : candidate;
  if (!await exists(resolved)) {
    errors.push({
      file: fromFile,
      message: `missing local link target: ${target} -> ${resolved}`,
    });
    return;
  }
  const { anchor } = splitTarget(target);
  if (anchor === "" || !resolved.endsWith(".md")) return;
  const anchors = await headingAnchors(resolved, anchorCache);
  const slug = slugifyHeading(decodeAnchor(anchor));
  if (!anchors.has(slug)) {
    errors.push({
      file: fromFile,
      message: `missing markdown anchor: ${target} -> ${resolved}#${slug}`,
    });
  }
};

const markdownFiles = async (): Promise<string[]> => {
  const files: string[] = [];
  for (const root of DOC_ROOTS) {
    for await (
      const file of walkFiles(root, (path) => path.endsWith(".md"), true)
    ) {
      files.push(file);
    }
  }
  for (const file of ROOT_FILES) {
    if (await exists(file)) files.push(file);
  }
  return files.sort();
};

const hasMarkdown = async (dir: string): Promise<boolean> => {
  for await (const _file of walkFiles(dir, (path) => path.endsWith(".md"))) {
    return true;
  }
  return false;
};

const collectIntentReferences = async (): Promise<Set<string>> => {
  const refs = new Set<string>();
  for await (
    const file of walkFiles("_docs/intent", (path) => path.endsWith(".md"))
  ) {
    const src = await Deno.readTextFile(file);
    const { attrs } = parseFrontMatter(src);
    if (Array.isArray(attrs?.references)) {
      for (const ref of attrs.references) {
        if (typeof ref !== "string") continue;
        const resolved = resolveTarget(file, ref);
        if (resolved) refs.add(resolved);
      }
    }
  }
  return refs;
};

const validateArchiveInvariants = async (
  errors: ValidationItem[],
  inScope: InScopePredicate,
  scoped: boolean,
): Promise<void> => {
  // ディレクトリ存在自体を咎める検査は、スコープ有効時は既存構造を判定しないため抑止する。
  if (!scoped) {
    for (const type of FORBIDDEN_ARCHIVE_TYPES) {
      const dir = `_docs/archives/${type}`;
      if (await isDirectory(dir)) {
        errors.push({
          file: dir,
          message:
            "archive directories are only allowed for draft, plan, and survey",
        });
      }
    }
  }

  const intentRefs = await collectIntentReferences();
  for await (
    const file of walkFiles("_docs/archives", (path) => path.endsWith(".md"))
  ) {
    if (!inScope(file)) continue;
    const parts = file.split("/");
    const [, archives, type, area, slug] = parts;
    if (
      archives !== "archives" ||
      !(ARCHIVE_TYPES as readonly string[]).includes(type) ||
      !area ||
      !slug
    ) {
      errors.push({
        file,
        message:
          "archive path must match _docs/archives/{draft,plan,survey,intent}/<Area>/<slug>/...",
      });
      continue;
    }

    const src = await Deno.readTextFile(file);
    const { attrs, error } = parseFrontMatter(src);
    if (error || !attrs) {
      errors.push({
        file,
        message: error ?? "archived document must have parseable front matter",
      });
    }

    const intent = `_docs/intent/${area}/${slug}/decision.md`;
    // the decision.md a closed lane moved to the archive is the same document at the same relative path; a
    // decision.md under `_docs/archives/intent/` is its own corresponding intent (DEC-120-7)
    const archivedIntent = `${ARCHIVE_INTENT_ROOT}${area}/${slug}/decision.md`;
    // a plan in the request form belongs to a lane whose Choices live in the state, so no decision.md exists to
    // correspond to and the requirement is not applied. A plan in the old design form written before the switch
    // carries the same fact in its own references: a lane whose records are documents names its decision.md
    // there, and a lane whose records are the state has none to name. Either way the plan's own content tells
    // its shape, so no marker is added.
    const stateShapePlan = type === "plan" &&
      (REQUEST_FORM_HEADING.test(src) ||
        !namedReference(file, attrs, [intent, archivedIntent]));
    if (
      !stateShapePlan &&
      !await exists(intent) &&
      !await exists(archivedIntent) &&
      !intentRefs.has(file)
    ) {
      errors.push({
        file,
        message: `archived document requires corresponding intent: ${intent}`,
      });
    }

    const liveDir = `_docs/${type}/${area}/${slug}`;
    if (await hasMarkdown(liveDir)) {
      errors.push({
        file,
        message:
          `live ${type} document still exists for archived ${area}/${slug}`,
      });
    }
  }
};

const validateQaInvariants = async (
  errors: ValidationItem[],
  inScope: InScopePredicate,
): Promise<void> => {
  for await (
    const file of walkFiles("_docs/qa", (path) => path.endsWith(".md"))
  ) {
    if (!inScope(file)) continue;
    // 受理集合は validate-qa の QA_PATH_RE と同期させる: 現行 unified qa.md /
    // maintenance.md と legacy test-plan.md / verification.md。片側だけ更新すると
    // doc-links が現行 schema の QA 文書を偽陽性で拒否する。
    if (/^_docs\/qa\/[A-Za-z][A-Za-z0-9_-]*\/maintenance\.md$/.test(file)) {
      continue;
    }
    const match = file.match(
      /^_docs\/qa\/([A-Za-z][A-Za-z0-9_-]*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(qa|test-plan|verification)\.md$/,
    );
    if (!match) {
      errors.push({
        file,
        message:
          "QA path must match _docs/qa/<Area>/<slug>/qa.md, _docs/qa/<Area>/maintenance.md, or a legacy test-plan.md / verification.md path",
      });
      continue;
    }

    const [, area, slug, kind] = match;
    if (kind === "verification") {
      const testPlan = `_docs/qa/${area}/${slug}/test-plan.md`;
      if (!await exists(testPlan)) {
        errors.push({
          file,
          message: `verification requires matching test plan: ${testPlan}`,
        });
      }
    }
  }
};

const validateGuideReferenceWarnings = async (
  warnings: ValidationItem[],
  inScope: InScopePredicate,
): Promise<void> => {
  for (const type of ["guide", "reference"] as const) {
    for await (
      const file of walkFiles(`_docs/${type}`, (path) => path.endsWith(".md"))
    ) {
      if (!inScope(file)) continue;
      const src = await Deno.readTextFile(file);
      const { attrs } = parseFrontMatter(src);
      if (attrs?.status !== "active") continue;
      const refs = Array.isArray(attrs.references) ? attrs.references : [];
      const hasRelatedRef = refs.some((ref) =>
        typeof ref === "string" &&
        (ref.includes("/intent/") ||
          ref.includes("../intent/") ||
          ref.includes("/guide/") ||
          ref.includes("/reference/") ||
          ref.includes("../guide/") ||
          ref.includes("../reference/"))
      );
      if (!hasRelatedRef) {
        warnings.push({
          file,
          message:
            "active guide/reference should reference related intent, guide, or reference",
        });
      }
    }
  }
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
  const scope: DocScope = await loadScope();
  const inScope = makeInScope(scope);
  const scoped = scope !== null;
  const files = (await markdownFiles()).filter(inScope);
  const anchorCache = new Map<string, Set<string>>();

  for (const file of files) {
    const src = await Deno.readTextFile(file);
    for (const target of extractMarkdownTargets(file, src, errors)) {
      await validateLocalTarget(file, target, errors, anchorCache);
    }

    const { attrs, error } = parseFrontMatter(src);
    if (error) {
      errors.push({ file, message: error });
      continue;
    }
    // validator fixture は references に故意の不正値を持つため、fixture では
    // references 検査ごとスキップする。しないと fixture 自身で check-docs が落ちる。
    if (attrs && "references" in attrs && !isValidatorFixture(file)) {
      if (!Array.isArray(attrs.references)) {
        errors.push({
          file,
          message: "front matter references must be an array",
        });
      } else {
        for (const ref of attrs.references) {
          if (typeof ref !== "string") {
            errors.push({
              file,
              message: "front matter references must contain only strings",
            });
            continue;
          }
          await validateLocalTarget(file, ref, errors, anchorCache);
        }
      }
    }
  }

  await validateArchiveInvariants(errors, inScope, scoped);
  await validateQaInvariants(errors, inScope);
  await validateGuideReferenceWarnings(warnings, inScope);

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
