import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

import { load as yamlLoad } from "js-yaml";

import { expandHome, reposPath } from "./paths.ts";
import { parseCacheTtl, parseToolTimeoutMinutes, type CacheTtl } from "./roles.ts";
// a relative path, not the `@idd/core` package name: the CLI must start under plain Node without workspace links
import { parseRiskPaths, type RiskPaths } from "../../idd-core/src/config/risk-paths.ts";
import { parseConventions, type Conventions } from "../../idd-core/src/config/conventions.ts";
import { parseTmpDir } from "../../idd-core/src/config/tmp-dir.ts";

/** what a check needs to run: `records` needs the records of the lane (docs, intent); anything else is public */
export type CheckScope = "public" | "records";

export interface CheckDef {
  name: string;
  command: string;
  required: boolean;
  /** unset reads as public; an unknown value in the registry is read as public too (the same reading as the areas' briefs) */
  scope?: CheckScope;
  timeoutMinutes?: number;
}

export type ReviewLabelEvent = "comment" | "request-changes" | "approve";

/** labels changed on a PR along with a review: taken off, then put on */
export interface LabelSwap { remove: string[]; add: string[] }

export type ReviewLabelRules = Partial<Record<ReviewLabelEvent, LabelSwap>>;

export interface LaneRepo {
  /** short name (`idd wt add --repo NAME`) */
  name: string;
  /** clone used for fetch / worktree add: the upstream clone (lanes never push from it) */
  clone: string;
  /** the private work clone that holds the records */
  work: string;
  /** owner/name on GitHub (the registry key) */
  github?: string;
  /** default base branch for merge-base: the public base */
  base: string;
  /** the work clone's base branch */
  workBase?: string;
  /** git remote used for fetch / merge-base; a copy cut from the work clone sets "" */
  remote: string;
  /** where detached review copies go */
  reviewRoot: string;
  /** files copied from clone into a new worktree (secrets etc.) */
  copy: string[];
  /** shell commands run in a fresh worktree */
  setup: string[];
  /** ordered gate checks run by `idd gate` */
  checks: CheckDef[];
  /** where this repo's lane worktrees live (Issue lane, msync wt); paths under it belong to this repo */
  lanesRoot: string;
  /** the language of text meant for its public side (PRs, Issues, review replies); unset means Japanese */
  language?: string;
  /** labels swapped when a review of someone else's PR is posted, by the kind of review; unset kinds touch no label */
  reviewLabels?: ReviewLabelRules;
  /** the limit of one shell tool call of a lane on this repo, over the default and under a role's own; null: no limit */
  toolTimeoutMinutes?: number | null;
  /** the repo's declaration of dangerous paths by kind (config/repos.yaml `risk_paths`); no declaration is absent */
  riskPaths?: RiskPaths;
  /** where the repo's rules for its public text are (config/repos.yaml `conventions`): a file and a section of it; none declared is absent */
  conventions?: Conventions;
  /** this repo's prompt cache hold for Claude Code runs, over the run kind's default and under a role's own; 1h for a repo with long checks */
  cacheTtl?: CacheTtl;
  /** where this repo's lane runs keep their temp files, a dir per run under it (config/repos.yaml `tmp_dir`); unset keeps the engine's */
  tmpDir?: string;
}

const REVIEW_LABEL_KEYS: Record<string, ReviewLabelEvent> = { comment: "comment", request_changes: "request-changes", approve: "approve" };

function labelList(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((l) => typeof l !== "string" || !l.trim())) throw new Error(`${where}: ラベル名の配列にしてください`);
  // a label written twice is one label: the card shows one checkbox for it
  return [...new Set((value as string[]).map((l) => l.trim()))];
}

function parseReviewLabels(value: unknown, where: string): ReviewLabelRules | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: comment / request_changes / approve ごとに remove と add を書いてください`);
  const rules: ReviewLabelRules = {};
  for (const [key, rule] of Object.entries(value as Record<string, unknown>)) {
    const event = REVIEW_LABEL_KEYS[key];
    if (!event) throw new Error(`${where}.${key}: 未知のレビューの種類です（comment / request_changes / approve）`);
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`${where}.${key}: remove と add を書いてください`);
    const r = rule as Record<string, unknown>;
    const unknown = Object.keys(r).filter((k) => k !== "remove" && k !== "add");
    if (unknown.length) throw new Error(`${where}.${key}: 未知の項目 ${unknown.join(", ")}（remove / add）`);
    const swap = { remove: labelList(r.remove, `${where}.${key}.remove`), add: labelList(r.add, `${where}.${key}.add`) };
    const both = swap.remove.filter((l) => swap.add.includes(l));
    if (both.length) throw new Error(`${where}.${key}: ${both.join(", ")} が remove と add の両方にあります`);
    if (swap.remove.length || swap.add.length) rules[event] = swap;
  }
  return Object.keys(rules).length ? rules : undefined;
}

/**
 * config/repos.yaml, the one registry shared with the engine: one entry per project keyed by its
 * GitHub owner/name, both clones required. Returned keyed by the short name.
 */
export function parseLaneRepos(text: string): Record<string, LaneRepo> {
  const raw = (yamlLoad(text) ?? {}) as Record<string, unknown>;
  const repos = (raw.repos ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, LaneRepo> = {};
  for (const [key, r] of Object.entries(repos)) {
    if (typeof r.upstream !== "string" || typeof r.work !== "string") throw new Error(`repos.${key}: upstream と work の 2 つの clone が必要です`);
    const checks: CheckDef[] = [];
    for (const c of (r.checks as Record<string, unknown>[] | undefined) ?? []) {
      if (typeof c.name !== "string" || c.command === undefined) throw new Error(`repos.${key}.checks: name と command`);
      const command = Array.isArray(c.command) ? (c.command as unknown[]).map(String).join(" ") : String(c.command);
      checks.push({ name: c.name, command, required: c.required === undefined ? true : Boolean(c.required), scope: c.scope === "records" ? "records" : "public", ...(typeof c.timeout_minutes === "number" ? { timeoutMinutes: c.timeout_minutes } : {}) });
    }
    const reviewLabels = parseReviewLabels(r.review_labels, `repos.${key}.review_labels`);
    const toolTimeout = parseToolTimeoutMinutes(r.tool_timeout_minutes, `repos.${key}.tool_timeout_minutes`);
    const riskPaths = parseRiskPaths(`repos.${key}.risk_paths`, r.risk_paths);
    const cacheTtl = parseCacheTtl(r.cache_ttl, `repos.${key}.cache_ttl`);
    const conventions = parseConventions(`repos.${key}.conventions`, r.conventions);
    const tmpDir = parseTmpDir(`repos.${key}.tmp_dir`, r.tmp_dir);
    const work = resolve(expandHome(r.work));
    const name = typeof r.name === "string" ? r.name : key.split("/").pop() as string;
    out[name] = {
      name,
      clone: resolve(expandHome(r.upstream)),
      work,
      github: typeof r.github === "string" ? r.github : key,
      base: typeof r.public_base === "string" ? r.public_base : "main",
      ...(typeof r.work_base === "string" ? { workBase: r.work_base } : {}),
      remote: typeof r.remote === "string" ? r.remote : "origin",
      reviewRoot: resolve(expandHome(typeof r.review_root === "string" ? r.review_root : "~/.cache/review-wt")),
      copy: ((r.copy as string[] | undefined) ?? []).map(String),
      setup: ((r.setup as string[] | undefined) ?? []).map(String),
      checks,
      lanesRoot: typeof r.lanes_root === "string" ? resolve(expandHome(r.lanes_root)) : `${work}-lanes`,
      ...(typeof r.public_language === "string" ? { language: r.public_language } : {}),
      ...(reviewLabels ? { reviewLabels } : {}),
      ...(toolTimeout !== undefined ? { toolTimeoutMinutes: toolTimeout } : {}),
      ...(riskPaths ? { riskPaths } : {}),
      ...(conventions ? { conventions } : {}),
      ...(cacheTtl !== undefined ? { cacheTtl } : {}),
      ...(tmpDir ? { tmpDir } : {}),
    };
  }
  return out;
}

/** the same repo, but copies are cut from the work clone (commits that exist only there) with no fetch */
export function fromWork(repo: LaneRepo): LaneRepo {
  return { ...repo, clone: repo.work, remote: "", base: repo.workBase ?? repo.base };
}

export function readLaneRepos(path = reposPath()): Record<string, LaneRepo> {
  if (!existsSync(path)) throw new Error(`repo の登録（config/repos.yaml）がありません: ${path}`);
  return parseLaneRepos(readFileSync(path, "utf8"));
}

/** find the repo whose clone or reviewRoot contains the given path */
/** the clone a worktree was cut from (its common .git directory's parent), or null outside git */
function cloneOf(path: string): string | null {
  const r = spawnSync("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  const dir = r.status === 0 ? r.stdout.trim() : "";
  return dir ? dirname(dir) : null;
}

/** the file in a recordless copy's git directory that says the copy is one, which paths it took out and which registered repo it was cut for */
export const RECORDLESS_MARK = "idd-recordless.json";

/** the registered repo a recordless copy was cut for, by the name its mark gives; null for any other directory */
function markedRepoName(path: string): string | null {
  const r = spawnSync("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-path", RECORDLESS_MARK], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  const mark = r.status === 0 ? r.stdout.trim() : "";
  if (!mark || !existsSync(mark)) return null;
  try {
    const name = (JSON.parse(readFileSync(mark, "utf8")) as { repo?: unknown }).repo;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

export function repoForPath(path: string, repos = readLaneRepos()): LaneRepo | null {
  const abs = resolve(expandHome(path));
  // several repos may share one review root (~/.cache/review-wt): a copy belongs to the clone it was cut from
  const clone = existsSync(abs) ? cloneOf(abs) : null;
  if (clone) {
    const own = Object.values(repos).find((r) => r.clone === clone || r.work === clone);
    if (own) return own;
    // a recordless copy is a repository of its own, wherever it was cut (a spec written by `idd review map` keeps it under the map's directory): its mark names the repo it was cut for
    const named = markedRepoName(abs);
    if (named && repos[named]) return repos[named];
  }
  // the longest matching root wins: one repo's review root may contain another's (~/.cache/review-wt and ~/.cache/review-wt/pi-web-idd)
  let best: { repo: LaneRepo; len: number } | null = null;
  for (const r of Object.values(repos)) {
    for (const d of [r.clone, r.work, r.lanesRoot, r.reviewRoot]) {
      if ((abs === d || abs.startsWith(`${d}/`)) && (!best || d.length > best.len)) best = { repo: r, len: d.length };
    }
  }
  return best?.repo ?? null;
}

export function repoByName(name: string, repos = readLaneRepos()): LaneRepo {
  const r = repos[name] ?? Object.values(repos).find((x) => x.github === name);
  if (!r) throw new Error(`未知の repo "${name}"。定義済み: ${Object.keys(repos).join(", ")}`);
  return r;
}

/** the repo's declaration of dangerous paths as IDD_RISK_PATHS, for a lane's agent environment or a check; {} when none */
export function riskPathsEnv(repo: LaneRepo | null | undefined): Record<string, string> {
  return repo?.riskPaths ? { IDD_RISK_PATHS: JSON.stringify(repo.riskPaths) } : {};
}

/**
 * The declaration of the repo a path belongs to, as the environment value to hand down; {} outside a registered
 * repo or when the registry cannot be read (a repo with no declaration must not inherit another repo's).
 */
export function riskPathsEnvForPath(path: string | undefined): Record<string, string> {
  if (!path) return {};
  try {
    return riskPathsEnv(repoForPath(path));
  } catch {
    return {};
  }
}

/**
 * What the registry says about the dangerous paths of the repo a path belongs to, with the cases kept apart: a
 * registered repo that declares paths (`declared`), one that declares none (`none`), a path the registry does not
 * know or a registry that is not there (`unregistered`), and a registry that cannot be read (`broken`). A check run by
 * hand needs the difference: a repo without a declaration has no floor, but a lookup that failed must say so instead
 * of quietly dropping the floor. On a CI runner the checkout is not where the registry says, so the run's own
 * repository (`github`, e.g. GITHUB_REPOSITORY) names the repo, for a path inside that checkout (`workspace`) only.
 */
export type RiskPathsLookup =
  | { kind: "declared"; repo: string; value: string }
  | { kind: "none"; repo: string }
  | { kind: "unregistered"; reason: string }
  | { kind: "broken"; reason: string };

export function riskPathsLookup(path: string, opts: { github?: string; workspace?: string; registry?: string } = {}): RiskPathsLookup {
  const registry = opts.registry ?? reposPath();
  if (!existsSync(registry)) return { kind: "unregistered", reason: `repo の登録（${registry}）がありません` };
  let repos: Record<string, LaneRepo>;
  try {
    repos = readLaneRepos(registry);
  } catch (err) {
    return { kind: "broken", reason: `repo の登録（${registry}）を読めません: ${String((err as Error).message ?? err).slice(0, 300)}` };
  }
  const abs = resolve(expandHome(path));
  let repo = repoForPath(abs, repos);
  if (!repo && opts.github && opts.workspace) {
    const ws = resolve(opts.workspace);
    if (abs === ws || abs.startsWith(`${ws}/`)) repo = Object.values(repos).find((r) => r.github?.toLowerCase() === opts.github!.toLowerCase()) ?? null;
  }
  if (!repo) return { kind: "unregistered", reason: `${abs} は登録（${registry}）のどの repo にも属しません` };
  return repo.riskPaths ? { kind: "declared", repo: repo.name, value: JSON.stringify(repo.riskPaths) } : { kind: "none", repo: repo.name };
}

/** the lane-repos entry whose github owner/name matches (review lanes know a PR by its GitHub repo) */
export function repoByGithub(github: string, repos = readLaneRepos()): LaneRepo {
  const r = findRepoByGithub(github, repos);
  if (!r) throw new Error(`config/repos.yaml に ${github} がありません`);
  return r;
}

/**
 * The same lookup, but null for a repo that is not registered (also when there is no registry file). A registry that
 * cannot be parsed still throws: a wrong setting is not the same as no setting.
 */
export function findRepoByGithub(github: string, repos: Record<string, LaneRepo> = reviewLabelRegistry()): LaneRepo | null {
  return Object.values(repos).find((x) => x.github?.toLowerCase() === github.toLowerCase()) ?? null;
}

/** the registry the label swaps are read from: none registered when there is no file, an error when it cannot be parsed */
export function reviewLabelRegistry(path = reposPath()): Record<string, LaneRepo> {
  return existsSync(path) ? parseLaneRepos(readFileSync(path, "utf8")) : {};
}

/**
 * The label swaps for reviews of a GitHub repo's PRs. A repo that is not registered, or has no
 * review_labels, gets none: the harness changes no label it was not told to.
 */
export function reviewLabelRules(github: string, repos: Record<string, LaneRepo> = reviewLabelRegistry()): ReviewLabelRules {
  const r = Object.values(repos).find((x) => x.github?.toLowerCase() === github.toLowerCase());
  return r?.reviewLabels ?? {};
}
