import { load as yamlLoad } from "js-yaml";

/**
 * A repo's structure declaration (`config/structure.yaml` in the repo's own tree): the command that counts the code's
 * structure, the counts a landing may not increase, and the rules the command reads (the layers and the directions
 * between them, the window a duplicate is measured with). It lives in the tree, not in this checkout's config, and the
 * landing reads it from the mainline tip: a lane that could change its own grading in the same landing would not be
 * graded (`overlay/structure.ts` chooses the tree; this module only reads a text).
 */

/** where the declaration sits in a repo's tree */
export const STRUCTURE_DECL_PATH = "config/structure.yaml";

export interface StructureDecl {
  /** the command that prints the counts as one JSON object on its last line; it runs where the declaration is read from */
  command: string[];
  timeoutMinutes: number;
  /** the counts a landing may not increase; the other counts the command prints are only recorded */
  blocking: string[];
  /** tokens in one duplicate window */
  window: number;
  /** a file with more lines than this is a large file */
  largeFileLines: number;
  /** a function whose branch count is above this is a complex function */
  complexityLimit: number;
  /** layer name -> the repo-relative path prefixes that belong to it (the longest prefix wins) */
  layers: Record<string, string[]>;
  /** layer name -> the other layers it may import from; a layer may always import from itself */
  allow: Record<string, string[]>;
  /** an import prefix -> the repo-relative path it stands for (a trailing `/` makes it a prefix) */
  aliases: Record<string, string>;
  /** repo-relative path prefixes that are not counted at all */
  exclude: string[];
}

export const DEFAULT_STRUCTURE_MINUTES = 10;
export const DEFAULT_WINDOW = 50;
const DEFAULT_LARGE_FILE_LINES = 600;
const DEFAULT_COMPLEXITY_LIMIT = 20;

const FIELDS = ["command", "timeout_minutes", "blocking", "window", "large_file_lines", "complexity_limit", "layers", "allow", "aliases", "exclude"];

function table(where: string, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: 表で書いてください`);
  return raw as Record<string, unknown>;
}

/** a list of non-blank strings (a missing list is an empty one) */
function strings(where: string, raw: unknown): string[] {
  const items = raw ?? [];
  const bad = !Array.isArray(items) || items.some((v) => typeof v !== "string" || v.trim() === "");
  if (bad) throw new Error(`${where}: 文字列の一覧で書いてください`);
  return (items as string[]).map((v) => v.trim());
}

function positive(where: string, raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) throw new Error(`${where}: 正の整数で書いてください`);
  return raw;
}

/**
 * The declaration a text holds. An unknown field, a missing command or blocking name, a layer that no prefix names, an
 * allow entry that names a layer nobody declared, and a number that is not a positive integer are errors, not silent
 * defaults: a declaration read as something else would stop the wrong landings, or none.
 */
export function parseStructure(text: string, where = STRUCTURE_DECL_PATH): StructureDecl {
  let raw: unknown;
  try {
    raw = yamlLoad(text);
  } catch (e) {
    throw new Error(`${where}: YAML として読めません（${String((e as Error).message).split("\n")[0]}）`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: 表で書いてください`);
  const o = raw as Record<string, unknown>;
  for (const field of Object.keys(o)) {
    if (!FIELDS.includes(field)) throw new Error(`${where}: 知らない欄 ${field}（使える欄: ${FIELDS.join(", ")}）`);
  }
  const command = typeof o.command === "string" ? ["bash", "-c", o.command] : strings(`${where}.command`, o.command);
  if (!command.length) throw new Error(`${where}.command: 数えるコマンドを書いてください`);
  const blocking = strings(`${where}.blocking`, o.blocking);
  if (!blocking.length) throw new Error(`${where}.blocking: 止める数の名前を書いてください`);
  const layers: Record<string, string[]> = {};
  for (const [name, prefixes] of Object.entries(table(`${where}.layers`, o.layers))) {
    layers[name] = strings(`${where}.layers.${name}`, prefixes);
    if (!layers[name].length) throw new Error(`${where}.layers.${name}: パスの前方一致を 1 つ以上書いてください`);
  }
  const allow: Record<string, string[]> = {};
  for (const [name, to] of Object.entries(table(`${where}.allow`, o.allow))) {
    if (!layers[name]) throw new Error(`${where}.allow.${name}: layers に宣言されていない層です`);
    allow[name] = strings(`${where}.allow.${name}`, to);
    const missing = allow[name].filter((t) => !layers[t]);
    if (missing.length) throw new Error(`${where}.allow.${name}: layers に宣言されていない層 ${missing.join(", ")}`);
  }
  const aliases: Record<string, string> = {};
  for (const [prefix, to] of Object.entries(table(`${where}.aliases`, o.aliases))) {
    if (typeof to !== "string") throw new Error(`${where}.aliases.${prefix}: パスを文字列で書いてください`);
    aliases[prefix] = to;
  }
  return {
    command,
    timeoutMinutes: positive(`${where}.timeout_minutes`, o.timeout_minutes, DEFAULT_STRUCTURE_MINUTES),
    blocking,
    window: positive(`${where}.window`, o.window, DEFAULT_WINDOW),
    largeFileLines: positive(`${where}.large_file_lines`, o.large_file_lines, DEFAULT_LARGE_FILE_LINES),
    complexityLimit: positive(`${where}.complexity_limit`, o.complexity_limit, DEFAULT_COMPLEXITY_LIMIT),
    layers,
    allow,
    aliases,
    exclude: strings(`${where}.exclude`, o.exclude),
  };
}
