import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { expandHome, readModes, userAgentDir } from "@idd/lane";
import { stateDir } from "@idd/core";
import { load as yamlLoad } from "js-yaml";

/*
 * The conversation features the screen switches: which skills a conversation's pi may read, whether web
 * search is on, and whether MCP is on. The engine owns one file for all three; the screen reads and patches
 * it through `/api/conversation-settings`. A skill is named by its directory, and the engine never writes
 * inside a skill's files.
 */

/** the web-search tool names the pi-web-access extension provides, when the settings file names none */
export const DEFAULT_WEB_SEARCH_TOOLS: readonly string[] = Object.freeze(["web_search", "fetch_content", "get_search_content", "source_check"]);

/** the two entries that reach every MCP tool (one loads a script tool, the other declares a deferred one) */
export const MCP_ENTRY_TOOLS: readonly string[] = Object.freeze(["codemode", "tool_search"]);

export type SkillOrigin = "user" | "workspace" | "repo";

export interface SkillCandidate {
  /** the skill's directory, absolute: what `--skill` takes and the enabled list holds */
  path: string;
  name: string;
  description: string;
  origin: SkillOrigin;
}

export interface ConversationSettings {
  /** the directories of the skills that are on */
  skills: string[];
  webSearch: boolean;
  /** the tool names web search adds to a conversation's allow-list */
  webSearchTools: string[];
  mcp: boolean;
}

/** a skill's dir never nests this deep under a search root */
const SKILL_SCAN_DEPTH = 4;

export function conversationSettingsPath(): string {
  return join(stateDir(), "pipeline", "conversation-settings.json");
}

function defaultSettings(): ConversationSettings {
  return { skills: [], webSearch: true, webSearchTools: [...DEFAULT_WEB_SEARCH_TOOLS], mcp: false };
}

function stringList(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return undefined;
  return [...(v as string[])];
}

/** the settings file merged over the defaults; a malformed field reads as its default rather than failing */
export function readConversationSettings(path = conversationSettingsPath()): ConversationSettings {
  const base = defaultSettings();
  if (!existsSync(path)) return base;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return base; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const o = raw as Record<string, unknown>;
  const skills = stringList(o.skills);
  const webSearchTools = stringList(o.webSearchTools ?? o.web_search_tools);
  return {
    skills: skills ?? base.skills,
    webSearch: typeof o.webSearch === "boolean" ? o.webSearch : typeof o.web_search === "boolean" ? o.web_search : base.webSearch,
    webSearchTools: webSearchTools ?? base.webSearchTools,
    mcp: typeof o.mcp === "boolean" ? o.mcp : base.mcp,
  };
}

/** write through a rename, so a reader never sees half a file */
export function writeConversationSettings(settings: ConversationSettings, path = conversationSettingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** the fields a PATCH may change */
export type ConversationSettingsPatch = Partial<Pick<ConversationSettings, "skills" | "webSearch" | "mcp">>;

// ---- skill discovery ----

interface ParsedSkill {
  name: string;
  description: string;
}

/** the leading `---` block of a `SKILL.md`, read without pi's SDK */
function frontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  try {
    const parsed = yamlLoad(text.slice(3, end)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseSkill(dir: string): ParsedSkill | undefined {
  const file = join(dir, "SKILL.md");
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return undefined; }
  const fm = frontmatter(text);
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : basename(dir);
  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  return { name, description };
}

/** every directory holding a `SKILL.md` under `root`, up to the scan depth */
function skillsUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) out.push(dir);
    if (depth >= SKILL_SCAN_DEPTH) return;
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function candidate(path: string, origin: SkillOrigin): SkillCandidate | undefined {
  const parsed = parseSkill(path);
  if (!parsed) return undefined;
  return { path: resolve(path), name: parsed.name, description: parsed.description, origin };
}

/** the user's skill places: the shared `~/.agents/skills` and the pi dir's own `skills` */
export function userSkillRoots(): string[] {
  const roots = [expandHome("~/.agents/skills"), join(userAgentDir(), "skills")];
  return roots.filter((p, i, all) => all.indexOf(p) === i);
}

/** the skill places a mode's workspace holds: `.agents/skills` and `.pi/skills` */
export function workspaceSkillRoots(cwd: string): string[] {
  return [join(cwd, ".agents", "skills"), join(cwd, ".pi", "skills")];
}

/**
 * The repository root of `cwd`: the nearest ancestor that holds a `.git` entry, whether a directory (an
 * ordinary checkout) or a file (a linked worktree). A cwd outside any repository has none.
 */
export function repositoryRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** the dirs between `cwd` and its repository root, inclusive; none when `cwd` is not in a repository */
function ancestorDirs(cwd: string): string[] {
  const root = repositoryRoot(cwd);
  if (!root) return [];
  const out: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    out.push(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function collect(roots: string[], origin: SkillOrigin, seen: Set<string>): SkillCandidate[] {
  const out: SkillCandidate[] = [];
  for (const root of roots) {
    for (const dir of skillsUnder(root)) {
      const key = resolve(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      const found = candidate(key, origin);
      if (found) out.push(found);
    }
  }
  return out;
}

/** the candidates a conversation with this cwd may turn on: user, the cwd's workspace, and its repository */
export function skillCandidates(cwd?: string): SkillCandidate[] {
  const seen = new Set<string>();
  const out = collect(userSkillRoots(), "user", seen);
  if (cwd) {
    out.push(...collect(workspaceSkillRoots(cwd), "workspace", seen));
    const repo: string[] = [];
    for (const dir of ancestorDirs(cwd)) repo.push(...workspaceSkillRoots(dir));
    out.push(...collect(repo, "repo", seen));
  }
  return out;
}

/** the candidates shown without a cwd: the user's places and every mode's workspace */
export function listedSkillCandidates(): SkillCandidate[] {
  const seen = new Set<string>();
  const out = collect(userSkillRoots(), "user", seen);
  let modes: Record<string, { cwd: string }> = {};
  try { modes = readModes(); } catch { modes = {}; }
  for (const mode of Object.values(modes)) out.push(...collect(workspaceSkillRoots(mode.cwd), "workspace", seen));
  return out;
}

/** the skill dirs whose path is both on and still a candidate for this cwd; the missing ones are dropped */
export function enabledSkillPaths(settings: ConversationSettings, cwd: string): string[] {
  if (!settings.skills.length) return [];
  const available = new Set(skillCandidates(cwd).map((c) => resolve(c.path)));
  const out: string[] = [];
  for (const skill of settings.skills) {
    const resolved = resolve(expandHome(skill));
    if (available.has(resolved) && existsSync(join(resolved, "SKILL.md"))) out.push(resolved);
  }
  return out;
}

/** the extra tool names this conversation's allow-list gets from the features that are on */
export function featureTools(settings: ConversationSettings): string[] {
  const tools: string[] = [];
  if (settings.webSearch) tools.push(...settings.webSearchTools);
  if (settings.mcp) tools.push(...MCP_ENTRY_TOOLS);
  return tools;
}

/** whether a path is a candidate at all, used to refuse enabling an arbitrary directory */
export function isSkillCandidate(path: string, cwd?: string): boolean {
  const resolved = resolve(expandHome(path));
  const candidates = cwd ? skillCandidates(cwd) : listedSkillCandidates();
  return candidates.some((c) => resolve(c.path) === resolved);
}

/** the on list's paths, resolved, so a path written in another form still counts as already on */
function resolvedSkills(skills: readonly string[]): Set<string> {
  return new Set(skills.map((skill) => resolve(expandHome(skill))));
}

/**
 * The requested paths that this change newly turns on and that are not candidates for `cwd`. A skill that is
 * already on is never checked: the settings are one list shared by every conversation, while a candidate list
 * belongs to one cwd, so insisting on this cwd's list would refuse every change as long as a skill for another
 * cwd is on. Only a path a conversation could not actually be handed is refused, which is what keeps the door
 * from pointing pi at an arbitrary directory (C-174-2).
 */
export function newSkillsOutsideCandidates(requested: readonly string[], current: ConversationSettings, cwd?: string): string[] {
  const on = resolvedSkills(current.skills);
  return requested.filter((skill) => !on.has(resolve(expandHome(skill))) && !isSkillCandidate(skill, cwd));
}

/** the directory exists and holds a `SKILL.md` (the stat form, for a caller that only has the path) */
export function isSkillDir(path: string): boolean {
  try { return statSync(join(path, "SKILL.md")).isFile(); } catch { return false; }
}
