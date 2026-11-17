import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { configPath } from "../config/files.ts";
import { parseRepos } from "../config/areas.ts";
import { templateRoot, TEMPLATE_ASSET_SCRIPTS, templateHookConfig, HOOK_CONFIGS, ensureScratchExcluded, PRE_V2_STANDARDS } from "./init.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
}
function gitTry(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/** every file under `dir`, as paths relative to `dir`, recursively */
function filesUnder(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

/** the skill names an earlier template put into a repo: `propter-<x>`, `<x>` and `docs-<x>` */
function templateSkillNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const e of readdirSync(join(source, "skills"), { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith("propter-")) continue;
    const rest = e.name.slice("propter-".length);
    names.add(e.name);
    names.add(rest);
    if (!rest.startsWith("docs-")) names.add(`docs-${rest}`);
  }
  return names;
}

export interface RepoMigrateOptions {
  repo: string;
  /** the propter checkout whose package assets the copies are compared with */
  source?: string;
  /** where the registry lives (defaults to the same read order) */
  reposFile?: string;
  now?: () => Date;
}

export interface RepoMigrateResult {
  ok: boolean;
  repo: string;
  /** the files and directories taken out of the working tree */
  removed: string[];
  /** template-adjacent names that were left alone (a repo's own skill or script, deno.json) */
  kept: string[];
  manifest: { path: string; removedLines: string[] } | null;
  lock: { path: string; source: string; revision: { commit: string }; migrated_from: unknown; adopted_base: string } | null;
  agents: { agentsMd: boolean; claudeMd: boolean; norms: boolean };
  registry: { key: string; command: string; replacement: string } | null;
  steps: string[];
  errors: string[];
  /** why nothing was changed (dirty worktree, or not a template repo) */
  skipped?: string;
}

/**
 * `idd repo migrate [--repo <path>]`: take a fixed template's copies out of a repo and leave it as one clone.
 * Only names that are recognisably the template's are removed (the package's norms, the template validators,
 * the template skills, a hook config that holds only the template's hook, QUICKSTART, the lock example, and the
 * old init's AGENTS.override.md / CLAUDE.local.md). A repo's own skill, its own scripts and deno.json stay and are
 * reported. Never commits, never pushes: the lock is rewritten and the user commits from the diff.
 */
export function runRepoMigrate(opts: RepoMigrateOptions): RepoMigrateResult {
  const repo = resolve(opts.repo);
  const source = resolve(opts.source ?? templateRoot());
  const now = opts.now ?? (() => new Date());
  const result: RepoMigrateResult = { ok: false, repo, removed: [], kept: [], manifest: null, lock: null, agents: { agentsMd: false, claudeMd: false, norms: false }, registry: null, steps: [], errors: [] };

  if (!existsSync(join(repo, ".git"))) {
    result.errors.push(`git の repo ではありません: ${repo}`);
    return result;
  }
  if ((gitTry(repo, ["status", "--porcelain"]) ?? "x").trim()) {
    result.skipped = "未 commit の変更があるので、何も変えずに止まりました";
    return result;
  }
  const lockPath = join(repo, "docs-template.lock.json");
  if (!existsSync(lockPath)) {
    result.skipped = "docs-template.lock.json が無いので、template を固定した repo ではありません";
    return result;
  }

  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  const removals = new Set<string>();
  const add = (rel: string) => { if (rel && existsSync(join(repo, rel))) removals.add(rel); };

  // the norms an earlier template copied in, by the fixed list of the names it shipped; a document of the repo's
  // own under `_docs/standards/` stays, whatever name the package's current norms use
  for (const rel of PRE_V2_STANDARDS) add(join("_docs", "standards", rel));
  if (existsSync(join(repo, "_docs", "standards"))) {
    for (const rel of filesUnder(join(repo, "_docs", "standards"))) {
      if (!PRE_V2_STANDARDS.includes(rel)) result.kept.push(join("_docs", "standards", rel));
    }
  }

  // the template validators, by name, and the repo's own scripts kept
  for (const rel of (gitTry(repo, ["ls-files", "scripts"]) ?? "").split("\n").filter(Boolean)) {
    if (TEMPLATE_ASSET_SCRIPTS.test(rel)) add(rel);
    else result.kept.push(rel);
  }

  // the template skills; a repo's own skill (frontend-design) stays
  const templateSkills = templateSkillNames(source);
  for (const dir of [".agents/skills", ".claude/skills", ".codex/skills"]) {
    const abs = join(repo, dir);
    if (!existsSync(abs)) continue;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (templateSkills.has(e.name)) add(join(dir, e.name));
      else result.kept.push(join(dir, e.name));
    }
  }

  // a hook config that holds nothing but the template's workflow hook
  for (const cfg of HOOK_CONFIGS) {
    const abs = join(repo, cfg);
    if (existsSync(abs) && templateHookConfig(abs)) add(cfg);
    else if (existsSync(abs)) result.kept.push(cfg);
  }

  // the template's own docs and the old init's overlays
  for (const rel of ["QUICKSTART.md", "docs-template.lock.example.json", "AGENTS.override.md", "CLAUDE.local.md"]) add(rel);
  if (existsSync(join(repo, "deno.json"))) result.kept.push("deno.json");

  // take them out of the working tree (tracked: git rm; untracked: remove)
  for (const rel of removals) {
    const abs = join(repo, rel);
    const isDir = existsSync(abs) && lstatSync(abs).isDirectory();
    const tracked = (gitTry(repo, ["ls-files", "--", rel]) ?? "").trim() !== "";
    if (tracked) git(repo, ["rm", "-q", "-f", ...(isDir ? ["-r"] : []), "--", rel]);
    else rmSync(abs, { recursive: true, force: true });
    result.removed.push(rel);
  }
  // remove directories the removals left empty, without touching a directory that still holds files
  for (const dir of ["_docs/standards", ".agents/skills", ".claude/skills", ".codex/skills"]) {
    const abs = join(repo, dir);
    try {
      if (existsSync(abs) && lstatSync(abs).isDirectory() && readdirSync(abs).length === 0) rmdirSync(abs);
    } catch {
      // a directory another process holds is left as it is
    }
  }

  // the manifest: drop only the lines that name a copy taken out (the _docs/ and _meta/ lines stay). A line for a
  // directory that is missing or empty is kept: it may be a private place not filled yet, and dropping it would
  // move whatever lands there later to the public side
  const manifestPath = join(repo, "overlay.manifest");
  if (existsSync(manifestPath)) {
    const lines = readFileSync(manifestPath, "utf8").split("\n");
    const removedLines: string[] = [];
    const keptLines = lines.filter((raw) => {
      const trimmed = raw.trim();
      const key = trimmed.replace(/\/$/, "");
      if (!key) return true;
      if (removals.has(key) && !(key === "_docs" || key === "_meta")) {
        removedLines.push(trimmed);
        return false;
      }
      return true;
    });
    if (removedLines.length) {
      writeFileSync(manifestPath, keptLines.join("\n"));
      result.manifest = { path: manifestPath, removedLines };
      result.steps.push(`manifest から ${removedLines.length} 行を外しました`);
    } else {
      result.manifest = { path: manifestPath, removedLines: [] };
    }
  }

  // the lane brief writes its scratch files under _meta/scratch; the same exclude repo init writes goes here too.
  // The removals are already in the tree, so a failure here is reported and the lock is still rewritten
  try {
    if (ensureScratchExcluded(repo)) result.steps.push("info/exclude に _meta/scratch/ を足しました");
  } catch (err) {
    result.errors.push(`info/exclude に _meta/scratch/ を足せませんでした: ${err instanceof Error ? err.message : String(err)}`);
  }

  // the lock: the package's revision, with where it came from kept as migrated_from
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
  const packageCommit = (gitTry(source, ["rev-parse", "HEAD"]) ?? "").trim();
  const next = {
    ...lock,
    source: "pi-web-idd",
    revision: { commit: packageCommit },
    migrated_from: { source: lock.source, revision: lock.revision },
    adopted_base: head,
    migrated_at: now().toISOString(),
  };
  writeFileSync(lockPath, `${JSON.stringify(next, null, 2)}\n`);
  result.lock = { path: lockPath, source: "pi-web-idd", revision: { commit: packageCommit }, migrated_from: next.migrated_from, adopted_base: head };
  result.steps.push("lock を移行の点に書き替えました（commit はしていません）");

  // AGENTS.md / CLAUDE.md are never touched; report when they look like the IDD norms
  const agents = join(repo, "AGENTS.md");
  const claude = join(repo, "CLAUDE.md");
  const agentsText = existsSync(agents) ? readFileSync(agents, "utf8") : "";
  result.agents = {
    agentsMd: existsSync(agents),
    claudeMd: existsSync(claude),
    norms: /intent-driven development|Intent Delta|_docs\/standards\/|\/\/ intent: DEC-/.test(agentsText),
  };
  if (result.agents.norms) result.steps.push("AGENTS.md に IDD の規範らしい記述が残っています。規範は brief で渡るので重なります");
  // the package's validate-todo no longer takes the R2 category: a repo that still holds R2 tasks fails its TODO check
  const r2Tasks = existsSync(join(repo, "TODO.md")) ? [...readFileSync(join(repo, "TODO.md"), "utf8").matchAll(/^###\s+([A-Za-z][A-Za-z0-9_]*-R2-\d+):/gm)].map((m) => m[1]) : [];
  if (r2Tasks.length) result.steps.push(`TODO.md に旧い形の R2 task が残っています（${r2Tasks.join("、")}）。R2 は外したので、package の検査の前に退役させてください（migration.md の「TODO.md」）`);

  // a registry entry whose record check still names the repo's own scripts/check-docs.sh
  const reposFile = resolve(opts.reposFile ?? configPath("repos"));
  if (existsSync(reposFile)) {
    try {
      const { areas } = parseRepos(readFileSync(reposFile, "utf8"));
      for (const [key, cfg] of Object.entries(areas)) {
        const paths = [cfg.local_path, cfg.upstream_path].filter(Boolean).map((p) => resolve(String(p)));
        if (!paths.includes(repo)) continue;
        const check = (cfg.checks ?? []).find((c) => c.command.join(" ").includes("scripts/check-docs.sh"));
        if (check) result.registry = { key, command: check.command.join(" "), replacement: `"${join(source, "bin", "idd")}" rules check` };
      }
    } catch (err) {
      result.steps.push(`repos.yaml を読めませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}
