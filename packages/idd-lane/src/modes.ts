import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { load as yamlLoad } from "js-yaml";

// a relative path, not `@idd/core`: the CLI must start under plain Node without workspace links
import { configPath } from "../../idd-core/src/config/files.ts";

import { preparePipelineAgentDir } from "./agent-dir.ts";
import { expandHome, repoRoot } from "./paths.ts";
import { pipelineStateDir, splitModel, PI_THINKING_LEVELS, type PiThinkingLevel } from "./pipeline-spawn.ts";
import { readRoles, resolveRole, type RolePreset } from "./roles.ts";

/**
 * One of a mode's conversation types (chat / idea / ...). A type differs from its mode only by where its
 * documents live and which operations file governs the conversation; the cwd, role and system prompt stay
 * the mode's. Every path is absolute once parsed.
 */
export interface SessionType {
  name: string;
  label: string;
  /** the dir the type's documents live in; the workspace itself when the type wrote no `dir` */
  dir: string;
  /** whether the type wrote its own `dir` (a type without one has no operations by default) */
  hasDir: boolean;
  /** the operations file this type reads at delivery time; absent when the type has none */
  operations?: string;
  /** the document template this type points at; absent when the type has none */
  template?: string;
}

/**
 * A session mode is the harness-independent 4-tuple (cwd, protocol document in that cwd, tools, memory)
 * plus the role preset that supplies model / thinking / routing. The UI starts a pi session from it;
 * the same tuple can be opened with the pi CLI or Claude Code when pi-web is down.
 */
export interface SessionMode {
  name: string;
  label: string;
  role: string;
  /** the mode's own dir: the reference point conversations start from and the workdirs stay under */
  workspace: string;
  /** the mode's dir, carried for clients that still read a mode's `cwd`; the same value as `workspace` */
  cwd: string;
  description?: string;
  /** the mode's conversation types, in the config's order; absent when the mode has none */
  types?: Record<string, SessionType>;
  /** the first type in the config's order, i.e. the mode's default type; absent when the mode has none */
  defaultType?: string;
  /** the dir the conversation's memory lives in; absolute */
  memory: string;
}

export function modesPath(): string {
  return configPath("modes", { checkout: repoRoot() });
}

// A mode only points at a role and a workspace; the protocol lives in the workspace's own norm document so any harness can open it.
const MODE_KEYS = new Set(["label", "role", "workspace", "description", "types", "memory"]);

// A type points at a document dir and the operations that govern it; anything else belongs to the mode or the role.
const TYPE_KEYS = new Set(["label", "dir", "operations", "template"]);

/** a path the config wrote, resolved against the workspace unless it is absolute or starts at `~` */
function resolveUnder(workspace: string, value: string): string {
  const trimmed = value.trim();
  if (isAbsolute(trimmed) || trimmed.startsWith("~")) return expandHome(trimmed);
  return join(workspace, trimmed);
}

/**
 * Read one mode's `types` table. A relative `dir` is under the workspace and an absolute or `~` path is kept;
 * `operations` and `template` are relative to the type's dir. A type that wrote no `dir` has no operations
 * unless it names one, so a mode whose conversations keep the workspace's own AGENTS.md can say so.
 */
function parseTypes(name: string, workspace: string, value: unknown): { types: Record<string, SessionType>; defaultType: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`modes.${name}.types: 表が必要です`);
  const table = value as Record<string, unknown>;
  const names = Object.keys(table);
  if (!names.length) throw new Error(`modes.${name}.types: 型が 1 つもありません`);
  const types: Record<string, SessionType> = {};
  for (const typeName of names) {
    const raw = table[typeName];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`modes.${name}.types.${typeName}: 表が必要です`);
    const def = raw as Record<string, unknown>;
    for (const key of Object.keys(def)) if (!TYPE_KEYS.has(key)) throw new Error(`modes.${name}.types.${typeName}.${key}: 型に置けるのは label / dir / operations / template だけです`);
    const hasDir = typeof def.dir === "string" && def.dir.trim().length > 0;
    const dir = hasDir ? resolveUnder(workspace, def.dir as string) : workspace;
    const operations = hasDir
      ? resolveUnder(dir, typeof def.operations === "string" && def.operations.trim() ? def.operations : "AGENTS.md")
      : typeof def.operations === "string" && def.operations.trim() ? resolveUnder(dir, def.operations) : undefined;
    const template = typeof def.template === "string" && def.template.trim() ? resolveUnder(dir, def.template) : undefined;
    types[typeName] = {
      name: typeName,
      label: typeof def.label === "string" && def.label ? def.label : typeName,
      dir,
      hasDir,
      ...(operations ? { operations } : {}),
      ...(template ? { template } : {}),
    };
  }
  return { types, defaultType: names[0] };
}

/** the type's full instruction is the only one that carries the operations body; a type without one is still a type */
export function modeType(mode: SessionMode, name: string | undefined): SessionType | undefined {
  if (!mode.types) return undefined;
  if (!name) return undefined;
  return mode.types[name];
}

/** the type a conversation is on: the mark's when the mode still defines it, else the mode's default */
export function effectiveModeType(mode: SessionMode, marked: string | undefined): string | undefined {
  if (!mode.types) return undefined;
  if (marked && mode.types[marked]) return marked;
  return mode.defaultType;
}

/** the mode's default type's name, or undefined for a type-less mode */
export function defaultModeType(mode: SessionMode): string | undefined {
  return mode.types ? mode.defaultType : undefined;
}

export function parseModes(text: string, roles = readRoles()): Record<string, SessionMode> {
  const raw = (yamlLoad(text) ?? {}) as { modes?: Record<string, Record<string, unknown>> };
  const out: Record<string, SessionMode> = {};
  for (const [name, m] of Object.entries(raw.modes ?? {})) {
    // the key changed from `cwd` to `workspace` (a conversation can now live in a workdir under the workspace);
    // reading `cwd` silently would leave two keys with one meaning
    if (Object.prototype.hasOwnProperty.call(m, "cwd")) throw new Error(`modes.${name}.cwd: cwd を workspace に書き換えてください（mode の会話の置き場は workspace です）`);
    for (const key of Object.keys(m)) if (!MODE_KEYS.has(key)) throw new Error(`modes.${name}.${key}: モードに置けるのは label / role / workspace / description だけです（規範は workspace の AGENTS.md、model 等は role へ）`);
    const role = typeof m.role === "string" ? m.role.trim() : "";
    if (!role || !roles.roles[role]) throw new Error(`modes.${name}: 未定義の role "${role}"`);
    if (typeof m.workspace !== "string" || !m.workspace.trim()) throw new Error(`modes.${name}: workspace が必要です`);
    const workspace = expandHome(m.workspace.trim());
    const parsedTypes = m.types !== undefined ? parseTypes(name, workspace, m.types) : undefined;
    const memory = typeof m.memory === "string" && m.memory.trim() ? resolveUnder(workspace, m.memory) : join(workspace, "memory");
    out[name] = {
      name,
      label: typeof m.label === "string" ? m.label : name,
      role,
      workspace,
      cwd: workspace,
      ...(typeof m.description === "string" ? { description: m.description } : {}),
      ...(parsedTypes ? { types: parsedTypes.types, defaultType: parsedTypes.defaultType } : {}),
      memory,
    };
  }
  return out;
}

export function readModes(): Record<string, SessionMode> {
  const p = modesPath();
  if (!existsSync(p)) return {};
  return parseModes(readFileSync(p, "utf8"));
}

export interface ModeStartPlan {
  mode: SessionMode;
  role: RolePreset;
  cwd: string;
  toolNames: string[];
  initialModel: { provider: string; modelId: string };
  thinkingLevel: PiThinkingLevel;
  agentDir: string;
}

/** Everything needed to start a pi session in a mode; the caller (API route) does the RPC start. */
export function planModeStart(name: string, opts: { prepareAgentDir?: (role: RolePreset) => string } = {}): ModeStartPlan {
  const mode = readModes()[name];
  if (!mode) throw new Error(`config/modes.yaml に "${name}" がありません`);
  if (!existsSync(mode.workspace)) throw new Error(`modes.${name}: workspace がありません: ${mode.workspace}`);
  const role = resolveRole(mode.role);
  if (role.harness !== "pi") throw new Error(`modes.${name}: harness ${role.harness} の role はモードに使えません`);
  if (!(PI_THINKING_LEVELS as readonly string[]).includes(role.thinking)) throw new Error(`modes.${name}: thinking "${role.thinking}" は pi の値ではありません`);
  const prepare = opts.prepareAgentDir ?? ((r: RolePreset) => preparePipelineAgentDir(join(pipelineStateDir(), "agent"), r));
  return {
    mode, role, cwd: mode.workspace,
    // pi-web treats an empty tool list as "no system prompt", which would drop the cwd's AGENTS.md
    toolNames: role.tools.length ? [...role.tools] : ["read"],
    initialModel: splitModel(role.model),
    thinkingLevel: role.thinking as PiThinkingLevel,
    agentDir: prepare(role),
  };
}
