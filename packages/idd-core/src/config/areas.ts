
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { load as yamlLoad } from "js-yaml";

import { parseBuildOutputs, parseStorage, type StorageConfig } from "../storage/config.ts";
import { readBacklog } from "../ledger/read.ts";
import { parseCommitConvention } from "./commit-convention.ts";
import { parseConventions, type Conventions } from "./conventions.ts";
import { parseGeneratedFiles, type GeneratedFiles } from "./generated.ts";
import { parseIncrements, parseIncrementShares, type AreaIncrement } from "./increments.ts";
import { configPath } from "./files.ts";
import { parseHarmExamples } from "./harm-examples.ts";
import { BRANCH_FIELDS, LANE_FIELDS, MESSAGE_FIELDS, laneBranchName, parsePattern, type NamePattern } from "./lane-names.ts";
import { parseRiskPaths, type RiskPaths } from "./risk-paths.ts";
import { parseTmpDir } from "./tmp-dir.ts";
import type { CommitConvention } from "../plan/vocab.ts";
import { parseTrackerSync } from "../sync/parse.ts";
import type { TrackerSyncConfig } from "../sync/types.ts";

export interface AreaCheck {
  name: string;
  command: string[];
  required: boolean;
  applicable?: boolean;
  scope?: "public" | "records";
}

export interface AreaConfig {
  context: "meltly" | "personal";
  source_type_priority: "linear" | "github";
  linked_repo: string;
  branch_name_source?: string;
  /** the repo's rule for a lane's branch (lane-names.ts); without one, feature/<Linear identifier or lane id> */
  branch_name_pattern?: NamePattern;
  /** the repo's form for the message of the commit an export makes; without one, the PR title */
  commit_message?: NamePattern;
  /** how a Linear lane's PR body names the Issue: a link or Closes. Without it the Issue is kept out of the PR */
  pr_linear_reference?: "link" | "closes";
  local_path?: string;
  upstream_path?: string;
  work_base?: string;
  public_base?: string;
  checks?: AreaCheck[];
  lanes_root?: string | null;
  /** the repo takes Issues into the Issue lane (config/repos.yaml has an issue_lane section) */
  intake?: boolean;
  intake_filter?: {
    github_labels?: string[];
    /** Linear team keys (APP, BAC ...) whose Issues this repo takes in; a team belongs to one repo at most */
    linear_teams?: string[];
    /** Linear workflow state names to take in (default Todo) */
    linear_statuses?: string[];
    /** Linear labels an Issue must all carry */
    linear_labels?: string[];
    /** Linear labels that keep an Issue out of the unnamed intake, even when the labels it must carry are there */
    linear_exclude_labels?: string[];
    /** true: this repo also takes in the unassigned Issues of its teams; without it, only the key owner's */
    linear_include_unassigned?: true;
  };
  /** words of the records workflow this repo uses in its own sense (not warned about in a PR body) */
  public_vocabulary_allow?: string[];
  /** the language of the repo's public text (`ja` when left out); an English repo writes the record names as plain words */
  public_language?: string;
  /**
   * `plan`: the repo's planner is asked for a work instruction (`_docs/plan/<seg>/<slug>/plan.md`) beside the
   * records, and it is archived before the submit. Absent (or `decision`): the old shape, the records alone. Only a
   * repo that writes `plan` carries the field, so the settings hash of every other repo does not change.
   */
  work_instruction?: "plan";
  /**
   * false: the repo is not published (repos.yaml's publish: false). A lane of such a repo is landed into the work
   * side's mainline instead of pushed. Only a repo that writes publish: false carries the field, so the settings of
   * every other repo hash as they did before the field existed.
   */
  publish?: false;
  /**
   * false: the lane's GitHub Issue is closed by a separate outbound card, not by the landing's approval. Only a repo
   * that writes `land.close_issue: false` carries the field, so the settings of every other repo hash as they did
   * before the field existed. A Linear lane has no close either way.
   */
  land?: { close_issue: false };
}

/**
 * Whether the landing of this repo's lane closes the lane's GitHub Issue with the same approval. A repo that writes
 * nothing (or true) closes it; only `land.close_issue: false` turns the close into a separate outbound card.
 */
export function closesOnLand(cfg: Pick<AreaConfig, "land"> | undefined): boolean {
  return cfg?.land?.close_issue !== false;
}

/** whether the repo publishes (a repo without the field does, and every existing repo keeps its behavior) */
export function publishes(cfg: Pick<AreaConfig, "publish"> | undefined): boolean {
  return cfg?.publish !== false;
}

/** the kinds of projection a repo may ask for; only A is drawn today */
export type ProjectionKind = "A" | "B" | "C";

/**
 * How a repo draws its projections: which kinds are on, and the visibility a Choice body without one takes.
 * Kept beside the areas (not inside AreaConfig) so a repo that writes it does not change any repo's settings
 * hash, and so a repo that writes nothing keeps the defaults.
 */
export interface ProjectionConfig {
  projections: ProjectionKind[];
  visibility_default: "private" | "public";
}

/** the settings of a repo that writes none: A on, private */
export const DEFAULT_PROJECTION: ProjectionConfig = { projections: ["A"], visibility_default: "private" };

export interface AreasFile {
  areas: Record<string, AreaConfig>;
  /**
   * key -> short name (repos.yaml's name:, else the last part of owner/name). Kept beside the areas: an
   * area's config is hashed into the records of a pending submit or import, which a new field would void.
   */
  names?: Record<string, string>;
  /** key -> review_root, the place for the repo's detached copies (kept beside the areas for the same reason) */
  reviewRoots?: Record<string, string>;
  /** key -> how a copy is made ready for the repo's checks and how long each may run (beside the areas for the same reason) */
  checkPrep?: Record<string, CheckPrep>;
  /** key -> the repo's declaration of dangerous paths by kind (beside the areas for the same reason) */
  riskPaths?: Record<string, RiskPaths>;
  /** key -> the repo's examples of what harm is and which conditions are always a must (beside the areas for the same reason) */
  harmExamples?: Record<string, HarmExamples>;
  /** key -> the repo's build output paths, worktree-root relative (beside the areas for the same reason) */
  buildOutputs?: Record<string, string[]>;
  /** key -> the repo's projection settings (beside the areas for the same reason) */
  intent?: Record<string, ProjectionConfig>;
  /** key -> the counts a landing may not increase (beside the areas for the same reason) */
  increments?: Record<string, AreaIncrement[]>;
  /** key -> check name -> the increment whose run a landing reads that check from (beside the areas for the same reason) */
  incrementShares?: Record<string, Record<string, string>>;
  /** key -> the files the repo generates from its sources and the command that makes them again (beside the areas for the same reason) */
  generatedFiles?: Record<string, GeneratedFiles[]>;
  /**
   * key -> check name -> how its failures are named in its output (`failure_id_pattern`, and `complete_pattern`, the
   * line a run that went to its end prints): the submit compares a failure at the lane's head with the public base by
   * these names (beside the areas for the same reason)
   */
  failureIds?: Record<string, Record<string, FailureIdRule>>;
  /**
   * the repos that run their required public checks at the lane's head before the S2 review loop converges
   * (`checks_before_converge: true`), in the file's order. A repo that writes nothing, or false, is not in it, so the loop
   * converges as before (beside the areas for the same reason)
   */
  convergeChecks?: string[];
  /** key -> the form of the repo's commit message and where it says so (beside the areas for the same reason) */
  commitConvention?: Record<string, CommitConvention>;
  /** key -> which outside tracker the repo's Projects and Issues are read from and how often (beside the areas for the same reason) */
  trackerSync?: Record<string, TrackerSyncConfig>;
  /** key -> where the repo's rules for its public text are (a file and a section), read from the public base when a draft is made (beside the areas for the same reason) */
  conventions?: Record<string, Conventions>;
  /** the top-level sweep settings (beside the areas: they are not hashed into a submit or import) */
  storage?: StorageConfig;
}

/**
 * A repo's own examples of what harm is there and which conditions are always a must
 * (config/repos.yaml `harm_examples` and `always_must`). Kept beside the areas so a new field does not change
 * any repo's settings hash.
 */
export interface HarmExamples {
  examples: { harm: number; example: string }[];
  alwaysMust: string[];
}

/** how a check's failed run names its failures, and how it says it went to its end (failure-ids.ts) */
export interface FailureIdRule {
  /** one line names one failure: its first group, or the whole match */
  pattern: string;
  /** a line only a run that went to its end prints; a run without one names no failure */
  complete?: string;
}

/** what a fresh copy of the repo needs before its checks can run, and each check's time limit */
export interface CheckPrep {
  /** files copied from the clone the copy is cut from (secrets such as .env: their contents never reach a record) */
  copy: string[];
  /** shell commands run in order in the copy before its checks */
  setup: string[];
  /** check name -> its limit in minutes (timeout_minutes); a check without one gets the runner's default */
  timeouts: Record<string, number>;
}

/** config/repos.yaml: one entry per project, both clones required (the Issue lane's areas are its keys) */
export function areasPath(): string {
  return configPath("repos");
}

const home = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function parseRepos(text: string): AreasFile {
  const raw = (yamlLoad(text) ?? {}) as { repos?: Record<string, Record<string, unknown>>; storage?: unknown };
  const areas: Record<string, AreaConfig> = {};
  const names: Record<string, string> = {};
  const reviewRoots: Record<string, string> = {};
  const checkPrep: Record<string, CheckPrep> = {};
  const riskPaths: Record<string, RiskPaths> = {};
  const harmExamples: Record<string, HarmExamples> = {};
  const buildOutputs: Record<string, string[]> = {};
  const intent: Record<string, ProjectionConfig> = {};
  const increments: Record<string, AreaIncrement[]> = {};
  const incrementShares: Record<string, Record<string, string>> = {};
  const generatedFiles: Record<string, GeneratedFiles[]> = {};
  const commitConvention: Record<string, CommitConvention> = {};
  const conventions: Record<string, Conventions> = {};
  const trackerSync: Record<string, TrackerSyncConfig> = {};
  const failureIds: Record<string, Record<string, FailureIdRule>> = {};
  const convergeChecks: string[] = [];
  for (const [key, r] of Object.entries(raw.repos ?? {})) {
    const github = typeof r.github === "string" ? r.github : key;
    if (!/^[\w.-]+\/[\w.-]+$/.test(github)) throw new Error(`repos.${key}: GitHub の owner/name をキーか github: に書いてください`);
    // every project is split into an upstream clone and a work clone; an entry without both is a config error
    if (typeof r.upstream !== "string" || typeof r.work !== "string") throw new Error(`repos.${key}: upstream と work の 2 つの clone が必要です`);
    if (r.publish !== undefined && typeof r.publish !== "boolean") throw new Error(`repos.${key}.publish: true か false で書いてください`);
    const workInstruction = parseWorkInstruction(key, r.work_instruction);
    const land = parseLand(key, r.land);
    const lane = (r.issue_lane ?? null) as Record<string, unknown> | null;
    const checks = ((r.checks as Record<string, unknown>[] | undefined) ?? []).map((c) => ({
      name: String(c.name),
      // one shell line in the file; the engine runs argv
      command: typeof c.command === "string" ? ["bash", "-c", c.command] : ((c.command as string[] | undefined) ?? []).map(String),
      required: c.required === undefined ? true : Boolean(c.required),
      scope: (c.scope === "records" ? "records" : "public") as "public" | "records",
    }));
    checkKeys(key, r.checks);
    checkPrep[key] = parseCheckPrep(key, r);
    // the pattern a check's failures are named by is kept beside the areas: a field inside AreaConfig would void the
    // records a pending submit or import saved
    const rules = parseFailureIdRules(key, r.checks);
    if (rules) failureIds[key] = rules;
    // the checks before the loop converges: kept beside the areas for the same reason, so a repo that writes nothing keeps its hash
    if (r.checks_before_converge !== undefined && typeof r.checks_before_converge !== "boolean") throw new Error(`repos.${key}.checks_before_converge: true か false で書いてください`);
    if (r.checks_before_converge === true) convergeChecks.push(key);
    // the lane runs' temp dir is read by the lane (repos.ts) when it builds a run's environment; it is checked here so a
    // wrong value stops the engine's reading of the registry as well, and it stays out of AreaConfig so no hash moves
    parseTmpDir(`repos.${key}.tmp_dir`, r.tmp_dir);
    // the declaration is kept beside the areas: a field inside AreaConfig would change the hash saved into a
    // pending submit or import and void it
    const declared = parseRiskPaths(`repos.${key}.risk_paths`, r.risk_paths);
    if (declared) riskPaths[key] = declared;
    // the repo's own examples of harm; kept beside the areas like risk_paths
    const harms = parseHarmExamples(`repos.${key}`, r.harm_examples, r.always_must);
    if (harms) harmExamples[key] = harms;
    // the declaration is kept beside the areas, like risk_paths: a field inside AreaConfig would void saved records
    const outputs = parseBuildOutputs(`repos.${key}.build_outputs`, r.build_outputs);
    if (outputs) buildOutputs[key] = outputs;
    // the projection settings are kept beside the areas too: a new field inside AreaConfig would void saved records
    const projection = parseProjection(`repos.${key}.intent`, r.intent);
    if (projection) intent[key] = projection;
    // the increment checks are kept beside the areas too: a landing reads them, and a field inside AreaConfig would
    // void the records a pending submit or import saved
    const declaresIncrements = parseIncrements(`repos.${key}.increments`, r.increments);
    if (declaresIncrements) increments[key] = declaresIncrements;
    // a check a landing reads from an increment's run: kept beside the areas for the same reason, and written on the
    // check so an engine that does not know the field still reads the declaration
    const shares = parseIncrementShares(`repos.${key}.checks`, r.checks, declaresIncrements);
    if (shares) incrementShares[key] = shares;
    // the generated files a landing makes again are kept beside the areas too: a field inside AreaConfig would void the
    // records a pending submit or landing saved
    const generated = parseGeneratedFiles(`repos.${key}.generated_files`, r.generated_files);
    if (generated) Object.assign(generatedFiles, { [key]: generated });
    // the commit message's form is kept beside the areas too: the card judges the message by it, and a field inside
    // AreaConfig would void every saved submit
    // the sections the repo's rules are in are kept beside the areas too, and the commit form may take its source from them
    const pointed = parseConventions(`repos.${key}.conventions`, r.conventions);
    if (pointed) conventions[key] = pointed;
    const convention = parseCommitConvention(`repos.${key}.commit_convention`, r.commit_convention, pointed?.commit);
    if (convention) commitConvention[key] = convention;
    // the pairing with an outside tracker is kept beside the areas too: a field inside AreaConfig would void every saved submit
    const syncs = parseTrackerSync(key, r.tracker_sync);
    if (syncs) trackerSync[key] = syncs;
    names[key] = typeof r.name === "string" && r.name.trim() ? r.name.trim() : key.split("/").pop() as string;
    if (typeof r.review_root === "string" && r.review_root.trim()) reviewRoots[key] = resolve(home(r.review_root.trim()));
    areas[key] = {
      context: (lane?.context === "meltly" ? "meltly" : "personal"),
      source_type_priority: (lane?.source_type_priority === "linear" ? "linear" : "github"),
      linked_repo: github,
      local_path: home(r.work),
      upstream_path: home(r.upstream),
      ...(typeof r.work_base === "string" ? { work_base: r.work_base } : {}),
      ...(typeof r.public_base === "string" ? { public_base: r.public_base } : {}),
      checks,
      lanes_root: typeof r.lanes_root === "string" ? home(r.lanes_root) : null,
      intake: lane !== null,
      ...(lane && typeof lane.branch_name_source === "string" ? { branch_name_source: lane.branch_name_source } : {}),
      ...(lane && lane.branch_name_pattern != null ? { branch_name_pattern: parsePattern(`repos.${key}.issue_lane.branch_name_pattern`, lane.branch_name_pattern, BRANCH_FIELDS, LANE_FIELDS) } : {}),
      ...(lane?.intake_filter ? { intake_filter: parseIntakeFilter(key, lane.intake_filter) } : {}),
      ...(Array.isArray(r.public_vocabulary_allow) ? { public_vocabulary_allow: r.public_vocabulary_allow.map(String) } : {}),
      ...(typeof r.public_language === "string" && r.public_language.trim() ? { public_language: r.public_language.trim() } : {}),
      // only a repo configured for a work instruction carries the field: `decision` is the default and is not kept
      ...(workInstruction ? { work_instruction: workInstruction } : {}),
      ...(r.commit_message != null ? { commit_message: parsePattern(`repos.${key}.commit_message`, r.commit_message, MESSAGE_FIELDS) } : {}),
      ...(r.pr_linear_reference != null ? { pr_linear_reference: parseLinearReference(key, r.pr_linear_reference) } : {}),
      // only a repo that turns publishing off carries the field: a repo that writes it (or writes nothing) keeps the
      // settings shape it had, so its saved submits and imports stay valid
      ...(r.publish === false ? { publish: false as const } : {}),
      // the same for the landing's close setting: only false is carried, so a repo that writes nothing keeps its hash
      ...(land ? { land } : {}),
    };
  }
  const owner = new Map<string, string>();
  for (const [key, cfg] of Object.entries(areas)) {
    if (!cfg.intake) continue;
    for (const team of cfg.intake_filter?.linear_teams ?? []) {
      const other = owner.get(team);
      if (other) throw new Error(`repos.${key}: Linear のチーム ${team} は repos.${other} にも書かれています。1 つの repo にだけ書いてください`);
      owner.set(team, key);
    }
  }
  return {
    areas, names, reviewRoots, checkPrep,
    ...nonEmpty({ riskPaths, harmExamples, buildOutputs, intent, increments, incrementShares, generatedFiles, commitConvention, conventions, trackerSync, failureIds }),
    ...(convergeChecks.length ? { convergeChecks } : {}),
    storage: parseStorage(raw.storage),
  };
}

/** the per-repo maps that hold something: a setting no repo writes stays out of the file, as if it did not exist */
function nonEmpty<T extends Record<string, Record<string, unknown>>>(maps: T): Partial<T> {
  return Object.fromEntries(Object.entries(maps).filter(([, map]) => Object.keys(map).length)) as Partial<T>;
}

const PROJECTION_KINDS: readonly ProjectionKind[] = ["A", "B", "C"];

/**
 * A repo's projection settings. The value is a list of kinds (default `[A]`, an empty list turns every drawing
 * off) and the visibility a body without one takes (default private). An unknown kind, a value that is not a
 * list, and a default that is neither private nor public are config errors, not silent defaults: a repo that
 * turns on a kind it cannot draw must be told so.
 */
function parseProjection(where: string, raw: unknown): ProjectionConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: 表で書いてください`);
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => k !== "projections" && k !== "visibility_default");
  if (unknown.length) throw new Error(`${where}: 知らない欄 ${unknown.join(", ")}（使える欄: projections, visibility_default）`);
  const projections: ProjectionKind[] = [];
  if (o.projections !== undefined && o.projections !== null) {
    if (!Array.isArray(o.projections)) throw new Error(`${where}.projections: A / B / C の一覧で書いてください`);
    for (const kind of o.projections) {
      if (typeof kind !== "string" || !PROJECTION_KINDS.includes(kind as ProjectionKind)) {
        throw new Error(`${where}.projections: 知らない種類 ${String(kind)}（使える種類: ${PROJECTION_KINDS.join(", ")}）`);
      }
      const k = kind as ProjectionKind;
      if (!projections.includes(k)) projections.push(k);
    }
  } else {
    projections.push("A");
  }
  let visibilityDefault: "private" | "public" = "private";
  if (o.visibility_default !== undefined && o.visibility_default !== null) {
    if (o.visibility_default !== "private" && o.visibility_default !== "public") {
      throw new Error(`${where}.visibility_default: private か public で書いてください`);
    }
    visibilityDefault = o.visibility_default;
  }
  return { projections, visibility_default: visibilityDefault };
}

/** the projection settings of one repo, with the defaults filled in; a repo that writes none gets A and private */
export function projectionConfigOf(repo: string, file: AreasFile = readAreas()): ProjectionConfig {
  return file.intent?.[repo] ?? DEFAULT_PROJECTION;
}

/**
 * `land` is the landing's settings; today only `close_issue`. A repo that writes nothing (or true) keeps its shape,
 * so its saved submits and landings stay valid; anything but a boolean is a config error, not a silent default.
 */
function parseLand(key: string, raw: unknown): { close_issue: false } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`repos.${key}.land: 表で書いてください`);
  const l = raw as Record<string, unknown>;
  const unknown = Object.keys(l).filter((k) => k !== "close_issue");
  if (unknown.length) throw new Error(`repos.${key}.land: 知らない欄 ${unknown.join(", ")}（使える欄: close_issue）`);
  if (l.close_issue === undefined || l.close_issue === true) return undefined;
  if (l.close_issue !== false) throw new Error(`repos.${key}.land.close_issue: true か false で書いてください`);
  return { close_issue: false };
}

/**
 * `work_instruction`: `plan` asks the repo's planner for a work instruction; `decision` (or nothing) is the old
 * shape. Anything else is a config error, not a silent default.
 */
function parseWorkInstruction(key: string, raw: unknown): "plan" | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "decision") return undefined;
  if (raw === "plan") return "plan";
  throw new Error(`repos.${key}.work_instruction: plan / decision のどちらかで書いてください`);
}

/** the fields a check may have: a field outside them (a misspelt one) is a config error, not a setting quietly left out */
const CHECK_FIELDS = ["name", "command", "required", "scope", "timeout_minutes", "land_from_increment", "failure_id_pattern", "complete_pattern"];

function checkKeys(key: string, raw: unknown): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const unknown = Object.keys(item as Record<string, unknown>).filter((k) => !CHECK_FIELDS.includes(k));
    if (unknown.length) throw new Error(`repos.${key}.checks.${String((item as Record<string, unknown>).name)}: 知らない欄 ${unknown.join(", ")}（使える欄: ${CHECK_FIELDS.join(", ")}）`);
  }
}

/** a regular expression a check's field holds, or why it is a config error */
function regexField(where: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where}: 正規表現を文字列で書いてください`);
  try { new RegExp(value); } catch (e) { throw new Error(`${where}: 正規表現として読めません（${(e as Error).message}）`); }
  return value;
}

/**
 * The checks' `failure_id_pattern` and `complete_pattern`: regular expressions one line of a failed run's output is
 * matched with. The first names one failure (its first group, or the whole match); the second is a line only a run
 * that went to its end prints. Only a public check takes them (a records check is not run at the public base), and a
 * `complete_pattern` only beside a `failure_id_pattern`. A value that is not a non-empty string, or does not compile,
 * is a config error.
 */
function parseFailureIdRules(key: string, raw: unknown): Record<string, FailureIdRule> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Record<string, FailureIdRule> = {};
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const c = item as Record<string, unknown>;
    const has = (v: unknown) => v !== undefined && v !== null;
    const where = `repos.${key}.checks.${String(c.name)}`;
    if (!has(c.failure_id_pattern)) {
      if (has(c.complete_pattern)) throw new Error(`${where}.complete_pattern: failure_id_pattern と一緒に書いてください`);
      continue;
    }
    if (c.scope === "records") throw new Error(`${where}.failure_id_pattern: 記録の検査には書けません（公開 base では回しません）`);
    const pattern = regexField(`${where}.failure_id_pattern`, c.failure_id_pattern);
    out[String(c.name)] = has(c.complete_pattern) ? { pattern, complete: regexField(`${where}.complete_pattern`, c.complete_pattern) } : { pattern };
  }
  return Object.keys(out).length ? out : undefined;
}

function parseCheckPrep(key: string, r: Record<string, unknown>): CheckPrep {
  const list = (field: string): string[] => {
    const v = r[field];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) throw new Error(`repos.${key}.${field}: 文字列の一覧で書いてください`);
    return (v as string[]).map((x) => x.trim());
  };
  const timeouts: Record<string, number> = {};
  for (const c of (r.checks as Record<string, unknown>[] | undefined) ?? []) {
    if (c.timeout_minutes === undefined || c.timeout_minutes === null) continue;
    const m = c.timeout_minutes;
    if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) throw new Error(`repos.${key}.checks.${String(c.name)}.timeout_minutes: 正の数（分）で書いてください`);
    timeouts[String(c.name)] = m;
  }
  return { copy: list("copy"), setup: list("setup"), timeouts };
}

function parseLinearReference(key: string, raw: unknown): "link" | "closes" | undefined {
  if (raw === "none") return undefined;
  if (raw === "link" || raw === "closes") return raw;
  throw new Error(`repos.${key}.pr_linear_reference: none / link / closes のどれかで書いてください`);
}

function stringList(key: string, field: string, v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" && typeof x !== "number")) throw new Error(`repos.${key}.issue_lane.intake_filter.${field}: 文字列の一覧で書いてください`);
  return v.map((x) => String(x).trim()).filter(Boolean);
}

const INTAKE_FILTER_FIELDS = ["github_labels", "linear_teams", "linear_statuses", "linear_labels", "linear_exclude_labels", "linear_include_unassigned"];

function parseIntakeFilter(key: string, raw: unknown): NonNullable<AreaConfig["intake_filter"]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`repos.${key}.issue_lane.intake_filter: 表で書いてください`);
  const f = raw as Record<string, unknown>;
  // a misspelt field would otherwise be dropped without a word (github_label: every open Issue would be taken in)
  const unknown = Object.keys(f).filter((k) => !INTAKE_FILTER_FIELDS.includes(k));
  if (unknown.length) throw new Error(`repos.${key}.issue_lane.intake_filter: 知らない欄 ${unknown.join(", ")}（使える欄: ${INTAKE_FILTER_FIELDS.join(", ")}）`);
  const github = stringList(key, "github_labels", f.github_labels);
  const teams = stringList(key, "linear_teams", f.linear_teams)?.map((t) => t.toUpperCase());
  const statuses = stringList(key, "linear_statuses", f.linear_statuses);
  const labels = stringList(key, "linear_labels", f.linear_labels);
  const excludeLabels = stringList(key, "linear_exclude_labels", f.linear_exclude_labels);
  const includeUnassigned = parseIncludeUnassigned(key, f.linear_include_unassigned);
  return {
    ...(github ? { github_labels: github } : {}),
    ...(teams ? { linear_teams: teams } : {}),
    ...(statuses ? { linear_statuses: statuses } : {}),
    ...(labels ? { linear_labels: labels } : {}),
    ...(excludeLabels ? { linear_exclude_labels: excludeLabels } : {}),
    ...(includeUnassigned ? { linear_include_unassigned: true as const } : {}),
  };
}

/**
 * `linear_include_unassigned` is a boolean, and only `true` is carried: a repo that writes nothing (or `false`)
 * takes in only the key owner's Issues, and keeps the settings shape and hash it had before the field existed.
 */
function parseIncludeUnassigned(key: string, raw: unknown): true | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw !== true) throw new Error(`repos.${key}.issue_lane.intake_filter.linear_include_unassigned: true か false で書いてください`);
  return true;
}

/** a broken or incomplete registry is an error, not an empty list: an engine that silently sees no areas stalls every lane */
export function readAreas(): AreasFile {
  const path = areasPath();
  if (!existsSync(path)) return { areas: {}, storage: parseStorage(undefined) };
  return parseRepos(readFileSync(path, "utf8"));
}

/** config/repos.yaml's top-level `storage`, off when the file or the section is missing */
export function readStorageConfig(): StorageConfig {
  return readAreas().storage ?? parseStorage(undefined);
}

/** the repo's declared build output paths, worktree-root relative; empty when it declares none */
export function buildOutputsOf(area: string): string[] {
  return readAreas().buildOutputs?.[area] ?? [];
}

/**
 * Whether the repo runs its required public checks at the lane's head before the S2 review loop converges. It is the
 * gate in front of a convergence, so a config that cannot be read throws rather than answer "no": the loop's step then
 * fails, is counted, and stops for penne with the reason, instead of converging without the checks
 */
export function convergeChecksOn(area: string): boolean {
  return readAreas().convergeChecks?.includes(area) ?? false;
}

/** the repo's declared increment checks; a repo that declares none has none */
export function incrementsOf(area: string): AreaIncrement[] {
  return readAreas().increments?.[area] ?? [];
}

/** the repo's generated files and the commands that make them again; a repo that declares none has none */
export function generatedFilesOf(area: string): GeneratedFiles[] {
  return readAreas().generatedFiles?.[area] ?? [];
}

/** the repo's checks that a landing reads from an increment's run: check name -> increment name */
export function incrementSharesOf(area: string): Record<string, string> {
  return readAreas().incrementShares?.[area] ?? {};
}

/**
 * The repo's checks as a brief lists them, with each check's declared time limit (config/repos.yaml
 * checks.<name>.timeout_minutes). `scope` filters to the records checks when the planner asks. The list is
 * structural, so the brief builders do not need the config types.
 */
export function areaBriefChecks(area: string, scope?: "public" | "records"): { name: string; timeoutMinutes?: number }[] {
  const file = readAreas();
  const timeouts = file.checkPrep?.[area]?.timeouts ?? {};
  return (file.areas[area]?.checks ?? [])
    .filter((c) => !scope || c.scope === scope)
    .map((c) => ({ name: c.name, ...(timeouts[c.name] !== undefined ? { timeoutMinutes: timeouts[c.name] } : {}) }));
}

/**
 * The registry key for an area as a person writes it: the key itself (owner/name), the repo's short name,
 * or its GitHub owner/name. A name that matches no area, or more than one, comes back as a message that
 * lists the keys.
 */
export function resolveAreaKey(given: string, file: AreasFile = readAreas()): { key: string } | { error: string } {
  const { areas, names = {} } = file;
  const name = given.trim();
  const known = () => Object.keys(areas).map((k) => (names[k] && names[k] !== k ? `${k}（${names[k]}）` : k)).join(", ") || "なし";
  if (!name) return { error: `repo を指定してください。登録済み: ${known()}` };
  if (areas[name]) return { key: name };
  const hits = Object.entries(areas).filter(([k, c]) => names[k] === name || c.linked_repo === name).map(([k]) => k);
  if (hits.length === 1) return { key: hits[0] };
  if (hits.length > 1) return { error: `repo "${name}" に当たる登録が複数あります: ${hits.join(", ")}。正式名で指定してください` };
  return { error: `repo "${name}" はありません。登録済み: ${known()}` };
}

/**
 * resolveAreaKey for a name GitHub reports: owner/name is case-insensitive there, so a registration that spells it
 * with other capitals is still the same repo. An exact match wins; otherwise exactly one registration must match.
 */
export function resolveGithubAreaKey(given: string, file: AreasFile = readAreas()): { key: string } | { error: string } {
  const exact = resolveAreaKey(given, file);
  if ("key" in exact) return exact;
  const name = given.trim().toLowerCase();
  if (!name) return exact;
  const hits = Object.entries(file.areas).filter(([k, c]) => k.toLowerCase() === name || (file.names ?? {})[k]?.toLowerCase() === name || c.linked_repo?.toLowerCase() === name).map(([k]) => k);
  if (hits.length === 1) return { key: hits[0] };
  if (hits.length > 1) return { error: `repo "${given}" に当たる登録が複数あります: ${hits.join(", ")}` };
  return exact;
}

/**
 * source_type_priority names the repo's primary source. The primary is always read; the other source is read
 * only when its filter is written (github_labels for GitHub, linear_teams for Linear), so a Linear-first repo
 * never takes in every open GitHub Issue by default.
 */
function readsGithub(cfg: AreaConfig): boolean {
  return cfg.source_type_priority === "github" || (cfg.intake_filter?.github_labels?.length ?? 0) > 0;
}

function readsLinear(cfg: AreaConfig): boolean {
  return cfg.source_type_priority === "linear" || (cfg.intake_filter?.linear_teams?.length ?? 0) > 0;
}

export function githubAreas(): { area: string; repo: string; labels: string[]; context: string; primary: boolean }[] {
  return Object.entries(readAreas().areas)
    .filter(([, cfg]) => cfg.intake && cfg.linked_repo && readsGithub(cfg))
    .map(([area, cfg]) => ({
      area,
      repo: cfg.linked_repo,
      labels: cfg.intake_filter?.github_labels ?? [],
      context: cfg.context,
      primary: cfg.source_type_priority === "github",
    }));
}

export interface LinearArea {
  area: string;
  repo: string;
  teams: string[];
  statuses: string[];
  /** Linear labels an Issue must all carry */
  labels: string[];
  /** Linear labels that keep an Issue out of the unnamed intake */
  excludeLabels: string[];
  /** this repo also takes in the unassigned Issues of its teams */
  includeUnassigned: boolean;
  /** set at intake: why this repo's Issues are not taken in now (what its work base lacks to start a lane) */
  refusal?: string;
  context: string;
  primary: boolean;
}

/** repos that take in Linear Issues; a repo without an issue_lane section (the Meltly repos today) is never one */
export function linearAreas(): LinearArea[] {
  return Object.entries(readAreas().areas)
    .filter(([, cfg]) => cfg.intake && cfg.linked_repo && readsLinear(cfg))
    .map(([area, cfg]) => ({
      area,
      repo: cfg.linked_repo,
      teams: cfg.intake_filter?.linear_teams ?? [],
      statuses: cfg.intake_filter?.linear_statuses?.length ? cfg.intake_filter.linear_statuses : ["Todo"],
      labels: cfg.intake_filter?.linear_labels ?? [],
      excludeLabels: cfg.intake_filter?.linear_exclude_labels ?? [],
      includeUnassigned: cfg.intake_filter?.linear_include_unassigned === true,
      context: cfg.context,
      primary: cfg.source_type_priority === "linear",
    }));
}

/** the branch a new lane of this repo is made on (a lane already made keeps the branch it recorded) */
export function branchFor(area: string, iddId: string): string {
  const cfg = readAreas().areas[area];
  return laneBranchName(cfg?.branch_name_pattern, iddId, readBacklog().find((r) => r.idd_id === iddId));
}
