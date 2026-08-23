// Deno版 intent schema validator: schema v2 の why-first decision record を検証する

import { loadScope, makeInScope } from "./scope.ts";

type YamlValue = string | number | boolean | YamlValue[];
type FrontMatter = Record<string, YamlValue>;

type FrontMatterParseResult = {
  attrs: FrontMatter | null;
  error: string | null;
};

type ValidationError = {
  file: string;
  message: string;
};

type DecisionEntry = {
  id: string;
  candidate: boolean;
  title: string;
  body: string;
};

const INTENT_SCHEMAS = [2, 3] as const;
const CURRENT_INTENT_SCHEMA = 3;
const INTENT_PATH_RE =
  /^_docs\/intent\/([A-Za-z][A-Za-z0-9-]*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/decision\.md$/;

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const walkFiles = async function* (dir: string): AsyncGenerator<string> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        yield* walkFiles(path);
      } else if (entry.isFile && entry.name.endsWith(".md")) {
        yield normalizePath(path);
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
};

const fileOrDir = async (path: string): Promise<"file" | "dir"> => {
  const stat = await Deno.stat(path);
  return stat.isFile ? "file" : "dir";
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
  if (/^-?\d+$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

const parseFrontMatter = (src: string): FrontMatterParseResult => {
  const lines = src.split(/\r?\n/);
  if (lines[0] !== "---") return { attrs: null, error: "missing front matter" };
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end === -1) return { attrs: null, error: "front matter is not closed" };

  const attrs: FrontMatter = {};
  for (let i = 1; i < end; i += 1) {
    const match = lines[i].match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const [, key, rest = ""] = match;
    attrs[key] = parseScalar(rest);
  }
  return { attrs, error: null };
};

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

const sectionContent = (src: string, heading: string): string | null => {
  const lines = stripCodeBlocks(src).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) =>
    index > start && /^##\s+/.test(line)
  );
  return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");
};

const decisionEntries = (content: string): DecisionEntry[] => {
  const lines = content.split(/\r?\n/);
  const entries: DecisionEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(
      /^###\s+(DEC-\d{3,})(\s+\(candidate\))?:\s+(.+)$/,
    );
    if (!match) continue;
    const end = lines.findIndex((line, index) =>
      index > i && /^###\s+DEC-\d{3,}(\s+\(candidate\))?:/.test(line)
    );
    entries.push({
      id: match[1],
      candidate: match[2] !== undefined,
      title: match[3].trim(),
      body: lines.slice(i + 1, end === -1 ? lines.length : end).join("\n"),
    });
    if (end !== -1) i = end - 1;
  }
  return entries;
};

const fieldValue = (body: string, name: string): string | undefined =>
  body.match(new RegExp(`^- \\*\\*${name}\\*\\*:\\s*(.+)$`, "m"))?.[1]
    ?.trim();

const isNoneLike = (content: string): boolean => {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, "").trim();
  return /^(None|N\/A|なし)$/i.test(withoutComments);
};

const add = (
  items: ValidationError[],
  file: string,
  message: string,
): void => {
  items.push({ file, message });
};

type DocIds = {
  decisionIds: string[];
  invariantIds: string[];
};

const validateDecisionDoc = (
  file: string,
  src: string,
  schema: number,
  errors: ValidationError[],
): DocIds => {
  const requiredHeadings = [
    "Context",
    "Decisions",
    "Consequences / Impact",
    "Quality Implications",
    "Intent-derived Invariants",
    "Rollback / Follow-ups",
  ] as const;
  for (const heading of requiredHeadings) {
    if (sectionContent(src, heading) === null) {
      add(errors, file, `intent_schema ${schema} missing heading: ${heading}`);
    }
  }

  const decisions = decisionEntries(sectionContent(src, "Decisions") ?? "");
  if (decisions.length === 0) {
    add(
      errors,
      file,
      `intent_schema ${schema} requires at least one DEC entry`,
    );
  }

  const decisionIds = new Set<string>();
  for (const decision of decisions) {
    if (decisionIds.has(decision.id)) {
      add(errors, file, `duplicate decision ID: ${decision.id}`);
    }
    decisionIds.add(decision.id);
    if (decision.candidate) {
      add(
        errors,
        file,
        `${decision.id}: the (candidate) mark was removed (issue #17) — remove the mark to ratify the decision or delete the entry`,
      );
    }
    for (const field of ["What", "Why", "Change freedom"] as const) {
      if (!fieldValue(decision.body, field)) {
        add(errors, file, `${decision.id} missing substantive ${field}`);
      }
    }
    for (const field of ["Why not", "Revisit when"] as const) {
      const fieldLine = new RegExp(`^- \\*\\*${field}\\*\\*:`, "m");
      if (fieldLine.test(decision.body) && !fieldValue(decision.body, field)) {
        add(errors, file, `${decision.id} has empty optional field: ${field}`);
      }
    }
  }

  const invariantIds = new Set<string>();
  const invariants = sectionContent(src, "Intent-derived Invariants") ?? "";
  if (isNoneLike(invariants)) {
    return { decisionIds: [...decisionIds], invariantIds: [] };
  }

  const invariantLines = invariants
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^- INV-/.test(line));
  if (invariantLines.length === 0) {
    add(
      errors,
      file,
      "Intent-derived Invariants must be None or use INV-001 (from DEC-001)",
    );
    return { decisionIds: [...decisionIds], invariantIds: [] };
  }

  for (const line of invariantLines) {
    const match = line.match(
      /^- (INV-\d{3,}) \(from (DEC-\d{3,})\):\s*(.+)$/,
    );
    if (!match) {
      add(
        errors,
        file,
        `invalid invariant format: ${line}`,
      );
      continue;
    }
    const [, invariantId, decisionId] = match;
    if (invariantIds.has(invariantId)) {
      add(errors, file, `duplicate invariant ID: ${invariantId}`);
    }
    invariantIds.add(invariantId);
    if (!decisionIds.has(decisionId)) {
      add(
        errors,
        file,
        `${invariantId} references missing decision ${decisionId}`,
      );
    }
  }
  return { decisionIds: [...decisionIds], invariantIds: [...invariantIds] };
};

const collectFiles = async (target: string): Promise<string[]> => {
  if (await fileOrDir(target) === "file") return [normalizePath(target)];
  const files: string[] = [];
  for await (const file of walkFiles(target)) files.push(file);
  return files;
};

const run = async (): Promise<void> => {
  const fixtureIndex = Deno.args.indexOf("--fixture");
  const fixtureTarget = fixtureIndex === -1
    ? null
    : Deno.args[fixtureIndex + 1];
  if (fixtureIndex !== -1 && !fixtureTarget) {
    console.error("ERROR: --fixture requires a file or directory");
    Deno.exit(1);
  }

  const target = fixtureTarget ??
    Deno.args.find((arg) => !arg.startsWith("-")) ??
    "_docs/intent";
  const inScope = makeInScope(await loadScope());
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const globalDecisionIds = new Map<string, string>();
  const globalInvariantIds = new Map<string, string>();

  for (const file of await collectFiles(target)) {
    if (!fixtureTarget && !inScope(file)) continue;
    const src = await Deno.readTextFile(file);
    const { attrs, error } = parseFrontMatter(src);
    if (error || !attrs) {
      add(errors, file, error ?? "missing front matter");
      continue;
    }

    const logicalPath = typeof attrs.fixture_path === "string"
      ? attrs.fixture_path
      : file;
    if (!INTENT_PATH_RE.test(logicalPath)) {
      add(errors, file, `invalid canonical intent path: ${logicalPath}`);
      continue;
    }

    if (!("intent_schema" in attrs)) {
      add(
        warnings,
        file,
        "legacy intent document without intent_schema: migrate when its meaning next changes",
      );
      continue;
    }
    const schema = attrs.intent_schema;
    if (!INTENT_SCHEMAS.some((allowed) => allowed === schema)) {
      add(
        errors,
        file,
        `intent_schema must be one of ${INTENT_SCHEMAS.join(", ")}`,
      );
      continue;
    }
    if (schema !== CURRENT_INTENT_SCHEMA) {
      add(
        warnings,
        file,
        `legacy intent_schema ${schema}: migrate to ${CURRENT_INTENT_SCHEMA} when its meaning next changes`,
      );
    }
    const ids = validateDecisionDoc(file, src, Number(schema), errors);
    if (schema === CURRENT_INTENT_SCHEMA) {
      for (const id of ids.decisionIds) {
        const existing = globalDecisionIds.get(id);
        if (existing && existing !== file) {
          add(
            errors,
            file,
            `${id} is already defined in ${existing} (DEC IDs are repository-unique)`,
          );
        } else {
          globalDecisionIds.set(id, file);
        }
      }
      for (const id of ids.invariantIds) {
        const existing = globalInvariantIds.get(id);
        if (existing && existing !== file) {
          add(
            errors,
            file,
            `${id} is already defined in ${existing} (INV IDs are repository-unique)`,
          );
        } else {
          globalInvariantIds.set(id, file);
        }
      }
    }
  }

  for (const { file, message } of warnings) {
    console.warn(`WARN: ${file}\n  - ${message}`);
  }
  if (errors.length > 0) {
    for (const { file, message } of errors) {
      console.error(`ERROR: ${file}\n  - ${message}`);
    }
    Deno.exit(1);
  }
};

await run();
