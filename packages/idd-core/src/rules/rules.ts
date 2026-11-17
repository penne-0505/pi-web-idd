import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { templateRoot } from "../init/init.ts";

/** the package's norms: the one copy of the standards the CLI hands out, so adopted repos keep none */
export function standardsPath(): string {
  return join(templateRoot(), "_docs", "standards");
}

/**
 * Where a role finds the solving standard when the tree it reads has no copy: one line naming the package's original,
 * null when the tree has it. Only the place is told, never the principles (their body is solving.md alone), so a role
 * of an adopted repo that keeps no norms can still open what the task names by its relative path.
 */
export function solvingStandardNote(tree: string): string | null {
  if (existsSync(join(tree, "_docs", "standards", "solving.md"))) return null;
  return `\`_docs/standards/solving.md\` はこの tree に無い。原物は \`${join(standardsPath(), "solving.md")}\` にあるのでそれを開く。`;
}

/** the body of one norm (`workflow`,`document_contracts`, ...); null when the name is not there */
export function readStandard(name: string): { path: string; body: string } | null {
  const dir = standardsPath();
  const rel = name.endsWith(".md") ? name : `${name}.md`;
  const path = resolve(dir, rel);
  // only the Markdown files inside the standards directory, by name or by relative path within it
  if (!path.startsWith(`${dir}/`) || !path.endsWith(".md")) return null;
  if (!existsSync(path)) return null;
  return { path, body: readFileSync(path, "utf8") };
}

/** the acceptance-criteria section of `work.md`: the one place the three conditions of an AC and where a defence goes are written */
export const AC_SECTION: { from: string; to: string } = Object.freeze({ from: "## 受け入れ条件（AC）", to: "## 検証ログ" });

/** where the AC section's last subsection begins: the rule for where a defence goes, which a review of an old-form (docs) lane is not given */
export const AC_PLACEMENT_HEADING = "### 害の防ぎの置き場";

/**
 * The parts a planner's run starts with, in the one order every lane gets them: the work instruction standard,
 * the granularity standard, the Project standard (a planner reads where a Project's decision becomes a Choice),
 * the solving standard (the principles a plan is written and read by),
 * the three templates the planner writes, and the Size / Risk part of the workflow
 * standard (the risk classification, the repo's declaration, the automatic floor and the depth judgement, up to the
 * next level-2 heading), and the acceptance-criteria section of the work standard (the three conditions an AC is
 * written by, and where a defence of a harm goes). The originals are read, never a copy, so a fix to one takes effect at the next planner.
 * The acceptance-criteria section is `required`: a planner that started without it would write qa.md by no conditions
 * and a later lane would be judged complete by them, so a bundle that cannot carry it stops (the other parts are left out).
 */
export const PLANNER_BUNDLE_PARTS: readonly { rel: string; section?: { from: string; to: string }; required?: true }[] = Object.freeze([
  { rel: "brief.md" },
  { rel: "granularity.md" },
  { rel: "project.md" },
  { rel: "records.md", section: { from: "## Purpose", to: "## Choice" } },
  { rel: "solving.md" },
  { rel: "templates/qa.md" },
  { rel: "templates/reference.md" },
  { rel: "templates/plan.md" },
  { rel: "workflow.md", section: { from: "### Risk 分類", to: "## 基盤原則" } },
  { rel: "work.md", section: AC_SECTION, required: true },
]);

/** the paragraph the bundle opens with: it is already here, so the planner need not read the same files again */
const PLANNER_BUNDLE_HEAD = [
  "この run の規約（パッケージの規約の原物から、起動のたびに組んだもの）。",
  "計画役は下の規約をそのまま当てる。同じ内容を `_docs/standards/` から読み直す必要はない。",
  "規約そのものを変える lane だけは、worktree の `_docs/standards/`（その lane の branch の版）を読む。",
  "ただし work.md の「受け入れ条件（AC）」の節だけは、計画の査読もパッケージの原物で読むので、worktree の版で読み替えない。",
  "原物を直せば、次に起きる計画役の束から効く。",
].join("");

/**
 * one part of the bundle read from the standards place; a section is the body from its heading to the next one.
 * A section with no closing heading runs to the end of the file, unless `strictEnd` is set: then a missing closing
 * heading is a part that cannot be read, so the text after the section never rides in as if it were the section.
 */
function bundlePart(dir: string, rel: string, section?: { from: string; to: string }, strictEnd = false): string | null {
  const root = resolve(dir);
  const path = resolve(root, rel);
  if (!path.startsWith(`${root}/`) || !path.endsWith(".md") || !existsSync(path)) return null;
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (!section) return body.trim() || null;
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(section.from));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && line.trim().startsWith(section.to));
  if (end < 0 && strictEnd) return null;
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trim() || null;
}

/**
 * The acceptance-criteria section of the package's `work.md`, as it stands now: the planner's bundle and the plan
 * review read the same words from the same place. Both need it, so a section that cannot be read throws, naming the
 * file and the heading missing, rather than letting a role start without the three conditions of an AC.
 * `placement: false` stops before the placement subsection (`AC_PLACEMENT_HEADING`), for a reader that is given the
 * three conditions and not the rule for where a defence goes; a version with no such heading is returned whole.
 */
export function acStandardSection(dir: string = standardsPath(), opts: { placement?: boolean } = {}): string {
  const body = bundlePart(dir, "work.md", AC_SECTION, true);
  if (!body) throw new Error(`work.md の AC の節を読めないので、規約の束と査読を組めません。path: ${join(dir, "work.md")} / 不足している見出し: ${AC_SECTION.from}（と、節の終わりを示す次の見出し ${AC_SECTION.to}。どちらが欠けても節の境界が決まらない）。work.md を直してから起こし直してください`);
  if (opts.placement !== false) return body;
  const lines = body.split("\n");
  const at = lines.findIndex((line) => line.trim().startsWith(AC_PLACEMENT_HEADING));
  return at < 0 ? body : lines.slice(0, at).join("\n").trim();
}

/**
 * The norms a planner's run carries in its system prompt: every part of `PLANNER_BUNDLE_PARTS` as it stands in the
 * package's standards place now, under a heading naming its file. The text never depends on a lane, an Issue or a
 * worktree, so every lane's planner gets the same prefix and the same words. A part that cannot be read is left out
 * rather than failing a planner that could still start, and no parts at all gives null. A `required` part that cannot
 * be read throws instead (the acceptance-criteria section), so the planner does not start without it.
 */
export function plannerRulesBundle(dir: string = standardsPath()): string | null {
  const parts: string[] = [];
  for (const part of PLANNER_BUNDLE_PARTS) {
    const body = part.required ? acStandardSection(dir) : bundlePart(dir, part.rel, part.section);
    if (body) parts.push(`## ${part.rel}\n\n${body}`);
  }
  if (!parts.length) return null;
  return [PLANNER_BUNDLE_HEAD, ...parts].join("\n\n");
}

/** run the package's validator against the repo at cwd; the exit status is the validator's */
export function runStandardCheck(cwd: string = process.cwd()): number {
  const script = join(templateRoot(), "scripts", "check-docs.sh");
  if (!existsSync(script)) throw new Error(`パッケージの validator がありません: ${script}`);
  const res = spawnSync("bash", [script], { cwd, stdio: "inherit" });
  if (res.error) throw res.error;
  return res.status ?? 1;
}

/** the package's record-check script; a repo with no copy of it runs this one against its own tree */
export function standardCheckScript(): string {
  return join(templateRoot(), "scripts", "check-docs.sh");
}

const SKILL_PREFIX = "propter-";

/**
 * The user's home the skills go under, or null when it cannot be pinned to an absolute path. An empty or
 * relative HOME would make the places `cwd/.agents/skills`, inside whatever repo the command happens to run in.
 */
export function skillsHome(explicit?: string): string | null {
  const candidate = explicit !== undefined ? explicit : process.env.HOME || homedir();
  return candidate && isAbsolute(candidate) ? candidate : null;
}

/** the user-wide skills places: `~/.agents/skills` holds the real copies, Claude Code reads `~/.claude/skills` */
export function skillsPlaces(home: string): { agents: string; claude: string } {
  return { agents: join(home, ".agents", "skills"), claude: join(home, ".claude", "skills") };
}

export interface SkillInstallResult {
  ok: boolean;
  source: string;
  agents: string;
  claude: string;
  installed: string[];
  removed: string[];
  error?: string;
}

/** remove a file, a directory or a symlink; false when it was not there */
function removeEntry(path: string): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  if (stat.isDirectory()) rmSync(path, { recursive: true, force: true });
  else unlinkSync(path);
  return true;
}

function propterNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).map((e) => e.name).filter((n) => n.startsWith(SKILL_PREFIX));
}

/** the directory a path lands on with every symlink resolved, or null when it is not there */
function realDir(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** the git work tree root a path sits in, or null when it is not in one */
function gitRoot(path: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * True when the place resolves inside a checkout that keeps the IDD skills' canon (`skills/propter-*` tracked at
 * the repo root): the package's own checkout, a trunk clone, a lane worktree. Writing there would rewrite that
 * repo's tracked files, so the placement refuses. Other git repos (a home whose dotfiles are versioned) are the
 * user's own place and are written to.
 */
function isPackageCheckout(place: string): boolean {
  const root = gitRoot(place);
  if (!root) return false;
  try {
    const out = execFileSync("git", ["ls-files", "--", "skills"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    return out.split("\n").some((line) => new RegExp(`^skills/${SKILL_PREFIX}[^/]+/`).test(line));
  } catch {
    return false;
  }
}

/**
 * Put the package's `propter-*` skills into the user's places: the real copies under `~/.agents/skills`,
 * and relative symlinks to them under `~/.claude/skills`. Only `propter-` names are replaced or removed;
 * other skills are left alone.
 *
 * A place may be a symlink (`.claude/skills` to `.agents/skills`, `.claude` from dotfiles, `~/.agents`):
 * `~/.agents/skills/propter-*` is always given the real copy, and the function proves that both places read
 * every skill back before it reports success. A self-referential or broken link is never reported as ok.
 *
 * When the home is not an absolute path, or a place resolves inside a checkout that tracks `skills/propter-*`
 * (the package's own checkout, a trunk clone, a lane worktree), nothing is written or removed and ok is false.
 */
export function installSkills(home?: string): SkillInstallResult {
  const base = skillsHome(home);
  const source = join(templateRoot(), "skills");
  const places = base ? skillsPlaces(base) : { agents: "", claude: "" };
  const result: SkillInstallResult = { ok: false, source, agents: places.agents, claude: places.claude, installed: [], removed: [] };
  if (!base) {
    return { ...result, error: `置き場の基点が絶対パスに定まりません（HOME=${JSON.stringify(process.env.HOME ?? "")}）。HOME を絶対パスで指定してください` };
  }
  const { agents, claude } = places;
  if (!existsSync(source)) return { ...result, error: `パッケージの skills がありません: ${source}` };
  const names = readdirSync(source, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(SKILL_PREFIX))
    .map((e) => e.name);
  if (!names.length) return { ...result, error: `パッケージに ${SKILL_PREFIX} の付いた skill がありません: ${source}` };

  mkdirSync(agents, { recursive: true });
  mkdirSync(claude, { recursive: true });
  const agentsReal = realDir(agents);
  const claudeReal = realDir(claude);
  const sourceReal = realDir(source);
  if (agentsReal === null || claudeReal === null || sourceReal === null) {
    return { ...result, error: `置き場の実体を解決できません: ${agents} / ${claude} / ${source}` };
  }
  // A place linked at the package's own `skills/` (or at a directory that holds it, or at a directory inside it)
  // would make the copies below delete and overwrite the package's tracked files.
  const inside = (inner: string, outer: string) => inner === outer || inner.startsWith(`${outer}/`);
  const overlapsSource = inside(agentsReal, sourceReal) || inside(claudeReal, sourceReal) || inside(sourceReal, agentsReal) || inside(sourceReal, claudeReal);
  // A place inside any checkout that tracks `skills/propter-*` (a trunk clone, another lane's worktree) is the
  // same kind of danger: the placement would rewrite that repo's tracked files.
  const canonCheckout = [agents, claude].find((place) => isPackageCheckout(place));
  if (overlapsSource || canonCheckout) {
    return { ...result, error: `置き場が IDD の skills（skills/propter-*）を持つ checkout の中にあります。その repo のファイルを壊すので、link を外してから回してください: ${agents} / ${claude}` };
  }
  // the two places may be one directory (a symlinked `.claude/skills` or `.claude`): then the real copy under
  // the agents place is the claude place too, and a link there would point at itself
  const samePlace = agentsReal === claudeReal;
  // the fixed relative target resolves from the directory the link sits in, so it is right only when the
  // literal `.claude/skills` path has no symlink in it; otherwise an absolute target is used
  const claudeRelativeFits = claudeReal === resolve(claude);

  const wanted = new Set(names);
  // a propter- name the package no longer has is propter's, and would otherwise keep an old skill readable
  for (const place of samePlace ? [agents] : [agents, claude]) {
    for (const name of propterNames(place)) {
      if (wanted.has(name)) continue;
      removeEntry(join(place, name));
      result.removed.push(join(place, name));
    }
  }
  for (const name of names) {
    const to = join(agents, name);
    removeEntry(to);
    cpSync(join(source, name), to, { recursive: true });
    result.installed.push(to);
    if (samePlace) continue;
    const link = join(claude, name);
    removeEntry(link);
    symlinkSync(claudeRelativeFits ? join("..", "..", ".agents", "skills", name) : join(agentsReal ?? agents, name), link);
    result.installed.push(link);
  }

  // prove both places read every propter- skill back: a chained or broken link must not report success
  const unreadable: string[] = [];
  for (const name of names) {
    for (const base of [agents, claude]) {
      const file = join(base, name, "SKILL.md");
      try {
        readFileSync(file, "utf8");
      } catch {
        unreadable.push(file);
      }
    }
  }
  if (unreadable.length) return { ...result, error: `読めない skill があります: ${unreadable.join(", ")}` };
  return { ...result, ok: true };
}
