import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { load as yamlLoad } from "js-yaml";

import { configPath } from "./files.ts";
import { DEFAULT_MAX_SHOULD_FIX } from "./review-defaults.ts";
import type { MissingMeansMarker } from "../agent/port.ts";

export { DEFAULT_MAX_SHOULD_FIX };

/**
 * The engine's view of config/roles.yaml: whether a slot is declared, its concurrency and how many roles it runs,
 * and the review loop's policies (`reviewPolicy`). Which model / harness a slot maps to is the runtime's business
 * (AgentRunner.spawn reads the same file through @idd/lane); the parallel cap is pipeline discipline and stays here (DEC-671).
 */
export function rolesPath(): string {
  return configPath("roles");
}

export function parsePipelineConcurrency(text: string, slot: string): number | undefined {
  if (!text.trim()) return undefined;
  const raw = (yamlLoad(text) ?? {}) as { pipeline?: Record<string, { concurrency?: unknown }> };
  const c = raw.pipeline?.[slot]?.concurrency;
  return typeof c === "number" && Number.isInteger(c) && c >= 1 ? c : undefined;
}

/** the pipeline block of roles.yaml read once, for a caller that asks about many slots in one go */
export interface PipelineSnapshot {
  concurrency(slot: string): number;
  declared(slot: string): boolean;
  size(slot: string): number;
  /** the runs one round of the slot may make, named so that a run listed twice is told from two runs */
  roster(slot: string): SlotRoster;
  /** the most routes a routed round gives blinds of their own */
  maxRoutes(): number;
}

/**
 * The runs of a slot as the loader lists them, each named by its role and the model definition it runs with. An extra
 * runs with its role's own model (`roles.<name>.model`), so it repeats a run of the slot only when it is the same role
 * with the model the slot runs that role with. A Claude Code role has no model definition to name (its model is its
 * own alias), so its run outside the slot's models is told from the run of any definition the slot names for it.
 */
export interface SlotRoster {
  runs: string[];
  extra: { first_round: string[]; high_risk: string[] };
}

/** the most routes a routed round gives blinds of their own when risk_map names no `max_routes` (the runner's default) */
export const DEFAULT_MAX_ROUTES = 8;

/** one pipeline slot as roles.yaml writes it: the roles it runs, the models it names them with, the extras a round adds */
interface SlotShape {
  role?: unknown;
  roles?: unknown;
  models?: unknown;
  first_round_extra?: unknown;
  high_risk_extra?: unknown;
}

/** the role names a list holds */
function roleNames(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

/**
 * The most runs one round of a slot makes: the slot's runs (its roles with the models it names, or with their own
 * models when it names none) and the runs of the extras a round may add on top of them (the first round's, a high-risk
 * lane's), each counted once. An extra runs with its own role's model, so one that shares a name with a slot role is
 * still a run of its own when the slot names models. 1 for a missing slot.
 */
function slotSizeOf(s: SlotShape | undefined, own: RoleModels): number {
  if (!slotRoles(s).length) return 1;
  const roster = slotRosterOf(s, own);
  // the slot's runs as listed, then each extra's run the slot does not make already: the way a round lists its runs
  const runs = [...roster.runs];
  for (const run of [...roster.extra.first_round, ...roster.extra.high_risk]) if (!runs.includes(run)) runs.push(run);
  return runs.length;
}

/** the model definitions a slot names, in order; one empty name when it names none (each role runs with its own model) */
function slotModelNames(v: unknown): string[] {
  const items = v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
  const names = items.map((m) => (typeof m === "string" ? m.trim() : m && typeof m === "object" ? String((m as { model?: unknown }).model ?? "").trim() : "")).filter(Boolean);
  return names.length ? names : [""];
}

/** the roles section of roles.yaml, read for the model definition each role runs with when no slot names one */
type RoleModels = Record<string, { model?: unknown; harness?: unknown } | undefined> | undefined;

/** the runs of a slot, and of each extra a round may add (an extra's run is left out when the slot already makes it) */
function slotRosterOf(s: SlotShape | undefined, own: RoleModels): SlotRoster {
  const roles = slotRoles(s);
  // a role the slot names no model for runs with its own. A Claude Code role's model is its own alias, not a model
  // definition, so the run it makes outside a slot's models names none: it is never the run of a definition the slot names
  const ownModel = (role: string) => (own?.[role]?.harness === "claude" || typeof own?.[role]?.model !== "string" ? "" : own[role].model.trim());
  const runs = roles.flatMap((role) => slotModelNames(s?.models).map((model) => `${role}|${model || ownModel(role)}`));
  const extraOf = (v: unknown) => [...new Set(roleNames(v).map((role) => `${role}|${ownModel(role)}`))];
  return { runs, extra: { first_round: extraOf(s?.first_round_extra), high_risk: extraOf(s?.high_risk_extra) } };
}

export function pipelineSnapshot(): PipelineSnapshot {
  const p = rolesPath();
  const text = existsSync(p) ? readFileSync(p, "utf8") : "";
  const raw = (text.trim() ? yamlLoad(text) ?? {} : {}) as { roles?: RoleModels; pipeline?: Record<string, { concurrency?: unknown; role?: unknown; roles?: unknown; models?: unknown; first_round_extra?: unknown; high_risk_extra?: unknown }> };
  const slotOf = (slot: string) => raw.pipeline?.[slot];
  const concurrencyOf = (slot: string) => {
    const c = slotOf(slot)?.concurrency;
    return typeof c === "number" && Number.isInteger(c) && c >= 1 ? c : 1;
  };
  const rosterOf = (slot: string) => slotRosterOf(slotOf(slot), raw.roles);
  return {
    concurrency: concurrencyOf,
    declared: (slot) => {
      const s = slotOf(slot);
      if (Array.isArray(s?.roles) && s.roles.length > 0) return true;
      return typeof s?.role === "string" && s.role.trim().length > 0;
    },
    size: (slot) => slotSizeOf(slotOf(slot), raw.roles),
    roster: rosterOf,
    maxRoutes: () => {
      const named = (slotOf("risk_map") as { max_routes?: unknown } | undefined)?.max_routes;
      const asked = typeof named === "number" && Number.isInteger(named) && named >= 1 ? named : DEFAULT_MAX_ROUTES;
      // never more than the copies the blind cap leaves beside the whole-diff blind
      const blind = rosterOf("review_blind");
      const everyRun = [...blind.runs];
      for (const run of [...blind.extra.first_round, ...blind.extra.high_risk]) if (!everyRun.includes(run)) everyRun.push(run);
      return Math.max(1, Math.min(asked, concurrencyOf("review_blind") * everyRun.length - 1));
    },
  };
}

/**
 * What the pipeline was set to at one moment: the whole `pipeline` section of roles.yaml with the model each slot's
 * roles run (roles.<name>.model), and a key over the two. A lane's `lane_open` keeps one of these, so lanes can be
 * grouped by the settings they ran under instead of by the date they opened: a key IDD-183 adds to the section is
 * picked up without this side being changed, and the table can show a group without printing the whole copy.
 *
 * Values whose field name says they are a secret (a key, a token, a password) are left out: the copy is a record, and
 * a record never holds one.
 */
export interface PipelineSettings {
  /** roles.yaml's `pipeline` section as it was (comments are not kept: yaml drops them) */
  pipeline: Record<string, unknown>;
  /** slot -> the call targets the slot runs (a slot without a model is left out) */
  models: Record<string, string[]>;
  /** a short hash over the two, which is what a lane is grouped by */
  key: string;
}

/** the field names a settings copy never carries: a value under one of them is a secret, not a setting */
const SECRET_FIELDS = ["api_key", "apikey", "token", "secret", "password"];

/** the copy of a value with every field that names a secret taken out (nested objects too) */
function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELDS.includes(k.toLowerCase())) continue;
    out[k] = withoutSecrets(v);
  }
  return out;
}

/** the roles one slot runs, from its `role` or `roles` field */
function slotRoles(slot: unknown): string[] {
  if (!slot || typeof slot !== "object") return [];
  const s = slot as { role?: unknown; roles?: unknown };
  const names = Array.isArray(s.roles) ? s.roles.map((r) => String(r).trim()).filter(Boolean) : [];
  if (names.length) return names;
  return typeof s.role === "string" && s.role.trim() ? [s.role.trim()] : [];
}

export function parsePipelineSettings(text: string): PipelineSettings {
  const raw = (text.trim() ? yamlLoad(text) ?? {} : {}) as { pipeline?: Record<string, unknown>; roles?: Record<string, { model?: unknown }>; models?: Record<string, { model?: unknown }> };
  const pipeline = (withoutSecrets(raw.pipeline ?? {}) ?? {}) as Record<string, unknown>;
  const models: Record<string, string[]> = {};
  for (const [slot, value] of Object.entries(raw.pipeline ?? {})) {
    const names = slotModels(value, raw)
      .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      .map((m) => m.trim());
    if (names.length) models[slot] = [...new Set(names)];
  }
  const key = createHash("sha256").update(JSON.stringify({ pipeline, models })).digest("hex").slice(0, 16);
  return { pipeline, models, key };
}

/**
 * The call targets a slot runs: the models it names (each a model definition's call target), or the call targets of
 * the models its roles name themselves. The call target is written in the file, so this is what the lane runs.
 */
function slotModels(slot: unknown, raw: { roles?: Record<string, { model?: unknown }>; models?: Record<string, { model?: unknown }> }): string[] {
  const s = (slot ?? {}) as { models?: unknown };
  const named = Array.isArray(s.models) ? s.models : s.models === undefined ? [] : [s.models];
  const modelNames = named.map((m) => (typeof m === "string" ? m : typeof (m as { model?: unknown })?.model === "string" ? String((m as { model?: unknown }).model) : ""));
  // a model definition's name stands for the call target it holds; a name no definition holds is read as it is
  const callOf = (name: string): string => (typeof raw.models?.[name]?.model === "string" ? String(raw.models[name].model) : name);
  if (modelNames.length) return modelNames.map(callOf);
  return slotRoles(slot).map((role) => {
    const name = raw.roles?.[role]?.model;
    return typeof name === "string" ? callOf(name) : "";
  });
}

/**
 * The pipeline as roles.yaml sets it now. A file that cannot be read or parsed is answered as an empty section: a lane
 * that opens while the settings are broken still opens, and its copy says plainly that nothing was set.
 */
export function pipelineSettings(): PipelineSettings {
  const p = rolesPath();
  try {
    return parsePipelineSettings(existsSync(p) ? readFileSync(p, "utf8") : "");
  } catch {
    return parsePipelineSettings("");
  }
}

/**
 * 1 when the file or the slot is missing. The old env defaults (planner 5 / executor 3) were the
 * env's, not the pipeline's: with roles.yaml as the single source a cap has to be declared, and an
 * undeclared pipeline erring on one lane at a time is the safe reading (DEC-754).
 */
export function pipelineConcurrency(slot: string): number {
  const p = rolesPath();
  if (!existsSync(p)) return 1;
  return parsePipelineConcurrency(readFileSync(p, "utf8"), slot) ?? 1;
}

/**
 * Whether a slot is declared at all. Optional stages (plan_review) run only when roles.yaml names a
 * role for them; which role and model that is stays with the runtime.
 */
export function pipelineSlotDeclared(slot: string): boolean {
  const p = rolesPath();
  if (!existsSync(p)) return false;
  const text = readFileSync(p, "utf8");
  if (!text.trim()) return false;
  const raw = (yamlLoad(text) ?? {}) as { pipeline?: Record<string, { role?: unknown; roles?: unknown }> };
  const s = raw.pipeline?.[slot];
  if (Array.isArray(s?.roles) && s.roles.length > 0) return true;
  return typeof s?.role === "string" && s.role.trim().length > 0;
}

/**
 * How many roles a slot runs at once in one lane (review_blind runs every role of its list, and a round may add its
 * extras): 1 when it names one role or is missing. With the concurrency it bounds the copies the blind rounds hold at once.
 */
export function pipelineSlotSize(slot: string): number {
  const p = rolesPath();
  if (!existsSync(p)) return 1;
  const text = readFileSync(p, "utf8");
  if (!text.trim()) return 1;
  const raw = (yamlLoad(text) ?? {}) as { roles?: RoleModels; pipeline?: Record<string, { role?: unknown; roles?: unknown; models?: unknown; first_round_extra?: unknown; high_risk_extra?: unknown }> };
  return slotSizeOf(raw.pipeline?.[slot], raw.roles);
}

/**
 * How the S2 review loop behaves, from roles.yaml. Every key left out reads as the loop's behaviour
 * before it was configurable, so taking a key out of the file is its rollback.
 * - review_blind.first_round_extra / high_risk_extra: the roles a round adds to review_blind.roles (the runtime
 *   resolves them); the engine only says which of them apply to a round, and how many roles that round runs
 * - review_blind.high_risk_when: `first` adds a high-risk lane's extra to its first blind (and to the first final of
 *   a pass that no final read high in), the behaviour before the key existed; `last` keeps it off the blind rounds
 *   (a conflict scope round keeps it) and adds it to every final, so the High role sees the tree the lane closes on
 * - review_blind.final_extra: `high` adds the high-risk extra to a final only when the lane's Risk reads High, the
 *   behaviour before the key existed; `all` adds it to every lane's final, whatever its Risk, and has the final's
 *   skip and scope read the lane as High too (a conflict scope round still reads the lane's real Risk)
 * - review_final.when: `always` runs the final review after every fix; `behaviour` only when the fixes since the last
 *   review touched a behaviour file (not a record, not a test)
 * - review_final.scope: `whole` shows the final review the whole diff; `increment` only the fixes since the last
 *   review, with their callers
 * - review_loop.after_merge: `whole` reviews the whole diff after a mainline merge; `conflict` only the hunks the merge resolved
 * - review_loop.max_fix_rounds: fix rounds a pass of S2 may send before it asks penne where the boundary lies
 * - review_loop.should_default: `fix` sends an accepted should to the fix (and tolerates one); `followup` has the
 *   judgement leave shoulds for a follow-up by default, and the loop closes once no accepted must is left;
 *   `triage` closes only when neither an accepted must nor a should the judgement recommended a fix for (with a
 *   basis) is left
 * - review_loop.max_should_fix: the shoulds one judgement of the `triage` value may recommend fixing before penne
 *   is asked where the boundary lies (default 2)
 * - review_loop.order_wait_hours: how long a lane waits for the lanes ahead of it before its first review; 0 turns
 *   the order check off
 * - review_loop.order_exclude_files: files added to the always-excluded TODO.md, whose conflict alone never waits
 * - review_loop.executor_still_seconds: how long a lane's head must hold still, with the executor's conversation no
 *   longer answering, before a review stage the executor's result began; 0 turns the wait off
 * - review_loop.fix_plan_skip_when_how: whether a fix that carries the reviewers' how-to-fix skips the one-off plan run
 *   (the trial run by Issue #211); left out or false keeps the plan, as every fix went through it before
 */
export interface ReviewPolicy {
  extras: { first_round: number; high_risk: number };
  extraRoles: { first_round: string[]; high_risk: string[] };
  /** when a high-risk lane's extra role joins a round: the first blind (`first`), or every final (`last`) */
  highRiskWhen: "first" | "last";
  /** which lanes' finals the high-risk extra joins under `last`: a High lane's (`high`), or every lane's (`all`) */
  finalExtra: "high" | "all";
  roles: string[];
  finalWhen: "always" | "behaviour";
  finalScope: "whole" | "increment";
  afterMerge: "whole" | "conflict";
  maxFixRounds: number;
  shouldDefault: "fix" | "followup" | "triage";
  /** the shoulds one judgement of the `triage` value may recommend fixing before penne is asked (default 2) */
  maxShouldFix: number;
  /** how long a lane waits for the lanes ahead of it before its first review; 0 turns the whole order check off */
  orderWaitHours: number;
  /** the files whose conflict alone never makes a lane wait (the repo's TODO.md is always among them) */
  orderExcludeFiles: string[];
  /** seconds a lane's head must hold still before a review stage the executor's result began; 0 turns the wait off */
  executorStillSeconds: number;
  /**
   * Whether a fix whose findings carry the reviewers' how-to-fix skips the one-off plan run. The plan and the
   * how-to-fix are two ways to answer the same question, so the trial runs one or the other in a round, not both
   * (C-197-5). A fix with no how-to-fix, a person's send-back and a stall watch's instruction keep the plan; a
   * conflict-merge instruction keeps skipping it whatever this says (C-123-4). Left out reads as off, the behaviour
   * before the key: every fix goes through the plan.
   */
  fixPlanSkipWhenHow: boolean;
}

/** the fix rounds a pass could send before the cap was configurable (and still, with review_loop.max_fix_rounds left out) */
export const LEGACY_MAX_FIX_ROUNDS = 8;

/** how long a lane waits for the lanes ahead of it before its first review, when roles.yaml names no hours */
export const DEFAULT_ORDER_WAIT_HOURS = 6;

/** the file every lane appends to, so its conflict is never a reason to wait (review_loop.order_exclude_files adds to it) */
export const DEFAULT_ORDER_EXCLUDE_FILES = ["TODO.md"];

/**
 * The seconds a lane's head must hold still before a review stage the executor's result began (roles.yaml
 * `review_loop.executor_still_seconds`), when the repo names none. The executor's work often lands in a commit
 * minutes after its first report (IDD-153), so the review has to see a head that stopped moving, not the one the
 * report happened to leave behind. Omitted reads as 0 (the wait off), the loop's behaviour before this key existed;
 * this repo writes 90 in config/roles.yaml. 0 or less turns the wait off.
 */
export const DEFAULT_EXECUTOR_STILL_SECONDS = 0;

export function parseReviewPolicy(text: string): ReviewPolicy {
  const raw = (text.trim() ? yamlLoad(text) ?? {} : {}) as { pipeline?: Record<string, Record<string, unknown> | undefined> };
  const p = raw.pipeline ?? {};
  const names = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const one = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  const blind = p.review_blind ?? {};
  const roles = slotRoles(blind);
  // an extra already in the slot's roles adds nothing to the round
  const extra = (v: unknown) => names(v).filter((r, i, all) => !roles.includes(r) && all.indexOf(r) === i);
  const first = extra(blind.first_round_extra);
  const high = extra(blind.high_risk_extra);
  const cap = p.review_loop?.max_fix_rounds;
  const shouldCap = p.review_loop?.max_should_fix;
  const orderHours = p.review_loop?.order_wait_hours;
  const stillSeconds = p.review_loop?.executor_still_seconds;
  const skipPlanForHow = p.review_loop?.fix_plan_skip_when_how;
  return {
    roles,
    extras: { first_round: first.length, high_risk: high.length },
    extraRoles: { first_round: first, high_risk: high },
    highRiskWhen: one(blind.high_risk_when, ["first", "last"] as const, "first"),
    finalExtra: one(blind.final_extra, ["high", "all"] as const, "high"),
    finalWhen: one(p.review_final?.when, ["always", "behaviour"] as const, "always"),
    finalScope: one(p.review_final?.scope, ["whole", "increment"] as const, "whole"),
    afterMerge: one(p.review_loop?.after_merge, ["whole", "conflict"] as const, "whole"),
    maxFixRounds: typeof cap === "number" && Number.isInteger(cap) && cap >= 1 ? cap : LEGACY_MAX_FIX_ROUNDS,
    shouldDefault: one(p.review_loop?.should_default, ["fix", "followup", "triage"] as const, "fix"),
    maxShouldFix: typeof shouldCap === "number" && Number.isInteger(shouldCap) && shouldCap >= 1 ? shouldCap : DEFAULT_MAX_SHOULD_FIX,
    orderWaitHours: typeof orderHours === "number" && Number.isFinite(orderHours) && orderHours >= 0 ? orderHours : DEFAULT_ORDER_WAIT_HOURS,
    orderExcludeFiles: [...new Set([...DEFAULT_ORDER_EXCLUDE_FILES, ...names(p.review_loop?.order_exclude_files)])],
    executorStillSeconds: typeof stillSeconds === "number" && Number.isFinite(stillSeconds) && stillSeconds >= 0 ? stillSeconds : DEFAULT_EXECUTOR_STILL_SECONDS,
    fixPlanSkipWhenHow: skipPlanForHow === true,
  };
}

export function reviewPolicy(): ReviewPolicy {
  const p = rolesPath();
  return parseReviewPolicy(existsSync(p) ? readFileSync(p, "utf8") : "");
}

/**
 * How the stall watch behaves, from roles.yaml. Both keys default to their built-in value when left out, so taking
 * the block out of the file is its rollback; 0 turns the detection or the notice off, and a negative or non-number
 * value falls back to the default.
 */
export interface StallWatchPolicy {
  /** minutes on the same step before the engine reads a lane as stopped (0 turns detection off) */
  stallMinutes: number;
  /** hours a card waits on the lane before the engine records one notice (0 turns the notice off) */
  cardNoticeHours: number;
}

/** minutes on the same step before a lane the engine owns reads as stopped, when roles.yaml names none */
export const DEFAULT_STALL_MINUTES = 45;
/** hours a card waits before a notice is recorded, when roles.yaml names none */
export const DEFAULT_CARD_NOTICE_HOURS = 4;

export function parseStallWatchPolicy(text: string): StallWatchPolicy {
  const raw = (text.trim() ? yamlLoad(text) ?? {} : {}) as { pipeline?: Record<string, Record<string, unknown> | undefined> };
  const w = raw.pipeline?.stall_watch ?? {};
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);
  return {
    stallMinutes: num(w.stall_minutes, DEFAULT_STALL_MINUTES),
    cardNoticeHours: num(w.card_notice_hours, DEFAULT_CARD_NOTICE_HOURS),
  };
}

export function stallWatchPolicy(): StallWatchPolicy {
  const p = rolesPath();
  return parseStallWatchPolicy(existsSync(p) ? readFileSync(p, "utf8") : "");
}

/**
 * Whether the granularity stage runs (roles.yaml `pipeline.granularity`): on turns it back to the stage as it was,
 * where the planner is asked how to slice the lane and a split or a merge waits on a person's card. This is the one
 * pipeline key whose left-out side is not the behaviour before the key: roles.yaml is copied outside the checkout
 * (~/.config/idd) and those copies carry no key either, and the stage is meant to be stopped in them as well until it
 * is measured again. So only the word `on` turns it on, and a missing key, a typo or any other value reads as stopped:
 * a broken setting cannot quietly bring the cards back.
 */
export function parseGranularityStage(text: string): boolean {
  if (!text.trim()) return false;
  const raw = (yamlLoad(text) ?? {}) as { pipeline?: Record<string, unknown> };
  const v = raw.pipeline?.granularity;
  return typeof v === "string" && v.trim().toLowerCase() === "on";
}

/** `pipeline.granularity` of config/roles.yaml; false when the file is absent or anything but `on` */
export function granularityStageOn(): boolean {
  const p = rolesPath();
  return existsSync(p) ? parseGranularityStage(readFileSync(p, "utf8")) : false;
}

/** a lane's spend before it stops for penne, when roles.yaml names none (USD) */
export const DEFAULT_LANE_BUDGET_USD = 5;
export function parseLaneBudget(text: string): number {
  const raw = (text.trim() ? yamlLoad(text) : null) as { defaults?: { lane_budget_usd?: unknown } } | null;
  const v = raw?.defaults?.lane_budget_usd;
  return typeof v === "number" && v > 0 ? v : DEFAULT_LANE_BUDGET_USD;
}

/** `defaults.lane_budget_usd` of config/roles.yaml */
export function laneBudgetUsd(): number {
  const p = rolesPath();
  return existsSync(p) ? parseLaneBudget(readFileSync(p, "utf8")) : DEFAULT_LANE_BUDGET_USD;
}

/**
 * The marks `pipeline.missing_means.markers` names, read next to the built-in ones. A marker binds a text to the
 * tool whose own result carries it and to the start of that result, so a document that quotes the words is not a
 * detection. A marker that names no tool or no prefix is dropped; the built-in marks stay whatever the block says.
 */
export function parseMissingMeansMarkers(text: string): MissingMeansMarker[] {
  const raw = (text.trim() ? yamlLoad(text) ?? {} : {}) as { pipeline?: { missing_means?: { markers?: unknown } } };
  const list = raw.pipeline?.missing_means?.markers;
  if (!Array.isArray(list)) return [];
  const out: MissingMeansMarker[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const m = item as Record<string, unknown>;
    const tool = typeof m.tool === "string" ? m.tool.trim() : "";
    const prefix = typeof m.prefix === "string" ? m.prefix : "";
    if (!tool || !prefix) continue;
    const id = typeof m.id === "string" && m.id.trim() ? m.id.trim() : `marker-${out.length + 1}`;
    const note = typeof m.note === "string" && m.note ? m.note : undefined;
    out.push({ id, tool, prefix, ...(note ? { note } : {}) });
  }
  return out;
}

/** `pipeline.missing_means.markers` of config/roles.yaml, or none when the file or the block is absent */
export function missingMeansMarkers(): MissingMeansMarker[] {
  const p = rolesPath();
  return existsSync(p) ? parseMissingMeansMarkers(readFileSync(p, "utf8")) : [];
}
