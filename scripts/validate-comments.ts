// Deno版 comment allowlist validator: コード内コメントをポインタ/機械向けのみに制限する。
// 散文コメントは error とし、error 文で行き先 (DEC 化 or 削除) を案内する。
// 併せて intent ポインタの参照実在 (配達確認) を検査する。

import { loadScope, makeInScope } from "./scope.ts";

type Finding = {
  file: string;
  line: number;
  message: string;
};

type CommentConfig = {
  exclude: string[];
  allowDocComments: boolean;
  allowPatterns: string[];
};

const DEFAULT_CONFIG: CommentConfig = {
  exclude: [
    // テンプレート付属 tooling の why は upstream (standards / commit) にある。
    "scripts/",
    "node_modules/",
    "_docs/",
    "_meta/",
    ".git/",
  ],
  allowDocComments: false,
  allowPatterns: [],
};

const CODE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

const POINTER_RE = /^intent: (DEC-\d+)(\s+—|\s+-|$)/;
const INVARIANT_POINTER_RE = /^intent-invariant: (INV-\d+)(\s+—|\s+-|$)/;
const LEGACY_POINTER_RE =
  /^intent(?: why-not)?: (DEC-\d+)\s+\([A-Za-z][A-Za-z0-9-]*\/[a-z0-9-]+\)/;
const LEGACY_INVARIANT_RE =
  /^intent-invariant: (INV-\d+)\s+\([A-Za-z][A-Za-z0-9-]*\/[a-z0-9-]+\)/;
const COVERS_RE = /^Covers\s+(AC|INV)-\d+/;
const PRAGMA_RE =
  /^(deno-lint-ignore|deno-fmt-ignore|deno-coverage-ignore|eslint-disable|eslint-enable|biome-ignore|@ts-(expect-error|ignore|nocheck|check)|prettier-ignore|@vite-ignore|@__PURE__|@license|SPDX-License-Identifier|node:coverage|v8 ignore|<reference\s)/;

const GUIDANCE =
  "prose comments are not allowed: if this explains a decision (why), record it as a DEC in _docs/intent/ and replace the comment with `// intent: DEC-xxx — <one-line causal reason>`; if it restates what the code does (how), delete it";

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const loadConfig = async (): Promise<CommentConfig> => {
  try {
    const raw = await Deno.readTextFile("docs-validators.json");
    const parsed = JSON.parse(raw) as {
      comments?: Partial<CommentConfig>;
    };
    const comments = parsed.comments ?? {};
    return {
      exclude: [...DEFAULT_CONFIG.exclude, ...(comments.exclude ?? [])],
      allowDocComments: comments.allowDocComments ??
        DEFAULT_CONFIG.allowDocComments,
      allowPatterns: comments.allowPatterns ?? [],
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return DEFAULT_CONFIG;
    throw err;
  }
};

const walkFiles = async function* (
  dir: string,
  exclude: string[],
): AsyncGenerator<string> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = normalizePath(
        dir === "." ? entry.name : `${dir}/${entry.name}`,
      );
      if (
        exclude.some((prefix) =>
          path === prefix.replace(/\/$/, "") || path.startsWith(prefix)
        )
      ) {
        continue;
      }
      if (entry.isDirectory) {
        yield* walkFiles(path, exclude);
      } else if (
        entry.isFile &&
        CODE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))
      ) {
        yield path;
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
};

type Comment = {
  line: number;
  text: string;
  block: boolean;
  doc: boolean;
};

// 最小の状態機械で string / template / comment を追跡する。正規表現リテラルは
// 追跡しない (エスケープ済み slash は連続 // にならないため実害が小さい)。
export const extractComments = (src: string): Comment[] => {
  const comments: Comment[] = [];
  let i = 0;
  let line = 1;
  let state: "code" | "single" | "double" | "template" = "code";
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (state === "code") {
      if (ch === "'") state = "single";
      else if (ch === '"') state = "double";
      else if (ch === "`") state = "template";
      else if (ch === "/" && next === "/") {
        const end = src.indexOf("\n", i);
        const text = src.slice(i + 2, end === -1 ? n : end).trim();
        comments.push({ line, text, block: false, doc: false });
        i = end === -1 ? n : end;
        continue;
      } else if (ch === "/" && next === "*") {
        const doc = src[i + 2] === "*";
        const end = src.indexOf("*/", i + 2);
        const rawEnd = end === -1 ? n : end;
        const raw = src.slice(i + 2, rawEnd);
        comments.push({
          line,
          text: raw.replace(/^\*+/, "").trim(),
          block: true,
          doc,
        });
        line += (raw.match(/\n/g) ?? []).length;
        i = end === -1 ? n : end + 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (
      (state === "single" && ch === "'") ||
      (state === "double" && ch === '"') ||
      (state === "template" && ch === "`")
    ) {
      state = "code";
    }
    i += 1;
  }
  return comments;
};

type IntentIndex = {
  decisions: Set<string>;
  invariants: Set<string>;
};

const buildIntentIndex = async (): Promise<IntentIndex> => {
  const index: IntentIndex = {
    decisions: new Set(),
    invariants: new Set(),
  };
  const walk = async function* (dir: string): AsyncGenerator<string> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory) yield* walk(path);
        else if (entry.isFile && entry.name.endsWith(".md")) yield path;
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  };
  for await (const file of walk("_docs/intent")) {
    const src = await Deno.readTextFile(file);
    for (const match of src.matchAll(/^###\s+(DEC-\d+):/gm)) {
      index.decisions.add(match[1]);
    }
    for (const match of src.matchAll(/^- (INV-\d+) \(from DEC-\d+\):/gm)) {
      index.invariants.add(match[1]);
    }
  }
  return index;
};

export const classifyComment = (
  comment: Comment,
  config: CommentConfig,
): { allowed: boolean; pointer?: { kind: "DEC" | "INV"; id: string } } => {
  const text = comment.text;
  if (comment.block) {
    if (comment.doc && config.allowDocComments) return { allowed: true };
    if (PRAGMA_RE.test(text)) return { allowed: true };
    return { allowed: false };
  }
  const pointer = text.match(POINTER_RE) ?? text.match(LEGACY_POINTER_RE);
  if (pointer) {
    return { allowed: true, pointer: { kind: "DEC", id: pointer[1] } };
  }
  const invariant = text.match(INVARIANT_POINTER_RE) ??
    text.match(LEGACY_INVARIANT_RE);
  if (invariant) {
    return { allowed: true, pointer: { kind: "INV", id: invariant[1] } };
  }
  if (COVERS_RE.test(text)) return { allowed: true };
  if (PRAGMA_RE.test(text)) return { allowed: true };
  if (config.allowPatterns.some((pattern) => new RegExp(pattern).test(text))) {
    return { allowed: true };
  }
  return { allowed: false };
};

const run = async (): Promise<void> => {
  const config = await loadConfig();
  const inScope = makeInScope(await loadScope());
  const index = await buildIntentIndex();
  const findings: Finding[] = [];

  const explicitTargets = Deno.args.filter((arg) => !arg.startsWith("-"));
  const files: string[] = [];
  if (explicitTargets.length > 0) {
    files.push(...explicitTargets.map(normalizePath));
  } else {
    for await (const file of walkFiles(".", config.exclude)) files.push(file);
  }

  for (const file of files) {
    if (explicitTargets.length === 0 && !inScope(file)) continue;
    const src = await Deno.readTextFile(file);
    // shebang は comment ではなく実行契約として常に許可する。
    for (const comment of extractComments(src)) {
      if (comment.line === 1 && src.startsWith("#!")) continue;
      const { allowed, pointer } = classifyComment(comment, config);
      if (!allowed) {
        findings.push({
          file,
          line: comment.line,
          message: GUIDANCE,
        });
        continue;
      }
      if (pointer) {
        const defined = pointer.kind === "DEC"
          ? index.decisions.has(pointer.id)
          : index.invariants.has(pointer.id);
        if (!defined) {
          findings.push({
            file,
            line: comment.line,
            message:
              `${pointer.id} is referenced here but not defined in _docs/intent/ (broken pointer)`,
          });
        }
      }
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `ERROR: ${finding.file}:${finding.line}\n  - ${finding.message}`,
      );
    }
    Deno.exit(1);
  }
};

if (import.meta.main) {
  await run();
}
