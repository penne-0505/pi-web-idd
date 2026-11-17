import { existsSync, readFileSync } from "node:fs";

import { load as yamlLoad } from "js-yaml";

import { CLAUDE_QUOTA_WINDOWS, DEFAULT_CLAUDE_QUOTA_STOP } from "./claude-quota.ts";
import { DEFAULT_SHARED_DAEMONS } from "./leftovers.ts";
import { expandHome, rolesPath } from "./paths.ts";

export type ReportKind = "review" | "confirm" | "triage" | "map" | "exec" | "probe" | "scan" | "free" | "fix_plan" | "shape";

export type Harness = "pi" | "claude";

/**
 * The kinds of failure that may move a run to the next candidate: a contract's windows or balance ran out,
 * the provider could not answer, or the role's own budget ran out. A failure outside these is the role's
 * conduct, not its route, so the run ends as it did before.
 */
export const FAILURE_KINDS = ["quota", "provider", "timeout"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** how long Claude Code keeps a run's prompt cache: 1h for a run with waits, 5m for a run with none */
export type CacheTtl = "1h" | "5m";

/**
 * A model definition: what pi is called with and the window it is reached through. The definition's own name is
 * what a role and a stage write; the call target is written as it is, so the file says which window the call goes
 * through and nothing rewrites it afterwards.
 */
export interface ModelDefinition {
  /** the definition's name, as a role and a stage write it */
  name: string;
  /** the call target pi is given: <窓口>/<その先での id> */
  model: string;
  /** provider-side routing object, passed as-is (OpenRouter `provider`: order / only / ignore / allow_fallbacks) */
  provider?: Record<string, unknown>;
  /** models.json compat key that carries `provider`; defaults by provider name */
  routingField?: string;
  /** the same model through several providers, one per attempt */
  providers?: string[];
  /** the model definition that stands in when this one's own qualification (price, window) is missing */
  fallback?: string;
}

/** one run of a stage: the role it runs and the model it runs it with */
export interface StageRun {
  /** the role's name */
  role: string;
  /** the model definition's name; absent when the stage names none (the role's own model is used) */
  model?: string;
  /** the thinking this pair runs with */
  thinking: string;
}

/** a model a stage runs a role with: the model definition's name, and the thinking this pair runs with */
export interface StageModel {
  /** the model definition's name */
  name: string;
  /** the thinking this pair runs with; absent reads the stage's, then the role's */
  thinking?: string;
}

export interface RolePreset {
  name: string;
  /** which headless CLI runs the lane: pi (default) or claude (Claude Code, subscription) */
  harness: Harness;
  /** the call target pi is given — empty means "not configured yet" */
  model: string;
  /** the model definition the call target came from; absent for a Claude Code role (its model is a Claude alias) */
  modelName?: string;
  /** the model definition that stands in for this one when its own qualification is missing */
  modelFallback?: string;
  thinking: string;
  /** pi tool allow-list (built-in names: read, bash, edit, write, grep, find, ls); a role that writes none has all seven */
  tools: string[];
  /** extra lines appended to the fixed policy block of the brief */
  policy: string[];
  report: ReportKind;
  /** the worktree must end as it began (HEAD, tracked files' content, untracked files and their content) */
  requireClean: boolean;
  /** hard wall-clock budget for the pi process */
  budgetMinutes: number;
  /** load AGENTS.md / CLAUDE.md of the target cwd into the pi system prompt */
  contextFiles: boolean;
  /** provider-side routing object, passed as-is (OpenRouter `provider`: order / only / ignore / allow_fallbacks) */
  provider?: Record<string, unknown>;
  /** models.json compat key that carries `provider`; defaults by provider name */
  routingField?: string;
  /** how many times the supervisor resumes a lane that exited 0 without writing report.md (0 = never) */
  maxResumes: number;
  /**
   * the role(s) run in this role's place when its route cannot run: one name or a list, in the order given.
   * The fallback's own `fallback` is never followed, so a role's whole order reads from its own block.
   */
  fallback?: string | string[];
  /**
   * the same model through several providers, one per attempt. Each attempt is pinned to one provider (it never
   * hands over to another), so the record and the consumption row name the provider that answered. A role that
   * writes this may not also write `provider` (the routing object).
   */
  providers?: string[];
  /** the failure kinds that move this role to the next candidate; absent reads the defaults, [] never moves */
  fallbackOn?: FailureKind[];
  /** this role's own limit of one shell tool call, over the repo's and the default; null: no limit */
  toolTimeoutMinutes?: number | null;
  /** harness: claude only: this role's prompt cache hold, over the repo's and the run kind's default (1h for a conversation, 5m otherwise) */
  cacheTtl?: CacheTtl;
}

/** which lanes to run for a task of a given size (est). Read by the orchestrator, not by the runner */
export interface LaneProfile {
  name: string;
  /** blind reviewers to run in parallel */
  blind: string[];
  confirm?: string;
  /** reviews the planner's plan before any executor runs (different model family from the planner) */
  plan_review?: string;
  /** deep pass (harness: claude) after the blind/confirm round */
  escalation?: string;
  note?: string;
}

/** Issue lane (S0〜S4 pipeline) の runner 選択: どの role をどの並列度で回すか */
export interface PipelineSlot {
  /** the first (or only) role */
  role: string;
  /** every role of the slot; a slot run in parallel (review_blind) lists several */
  roles: string[];
  /** the model definitions the slot runs its roles with; empty means each role's own model */
  models: StageModel[];
  /** the thinking the slot's pairs run with when a model does not name its own */
  thinking?: string;
  /** the runs the slot declares: every role of the slot with every model it names */
  runs: StageRun[];
  /** the runs the slot's extra roles make: each extra with its own model */
  extraRuns: { first_round: StageRun[]; high_risk: StageRun[] };
  concurrency: number;
  /** risk_map: a diff this many changed lines or larger is mapped before its blind round */
  minLines?: number;
  /** risk_map: the most routes a mapped round gives blinds of their own */
  maxRoutes?: number;
  /** review_blind: the roles the first blind round of a pass (and a conflict round) runs next to `roles` */
  firstRoundExtra?: string[];
  /** review_blind: the roles a high-risk lane's first blind round and first final run next to `roles` */
  highRiskExtra?: string[];
}

/**
 * The review loop's policies as roles.yaml sets them (`pipeline.review_loop.should_default`),
 * checked here so a typo fails loudly. The engine reads the same keys for the loop and tells each stage what it
 * runs under (StartReviewOptions), so a pass keeps what it began with. Left out, each reads as before.
 */
export interface ReviewStagePolicy {
  shouldDefault: "fix" | "followup" | "triage";
}

/**
 * pipeline keys that were retired with the stage they configured. A file that still declares one fails loudly with
 * what to do, instead of quietly reading as a stage that no longer runs: `r2` (the R2 reconstruction test and its
 * gate) was removed on 2026-10-22, and a lane's past R2 events are still read by the fold.
 */
export const PIPELINE_RETIRED_KEYS: Record<string, string> = {
  r2: "R2（再構成テスト）は 2026-10-22 に外しました。pipeline.r2 の行と r2-reviewer の役を消してください",
};

/** pipeline blocks that hold the loop's policies rather than a stage's roles */
export const PIPELINE_POLICY_BLOCKS = ["review_loop", "review_final", "stall_watch", "missing_means"] as const;

/**
 * pipeline keys that hold a value of their own rather than a stage's roles. They select no role, so nothing spawns
 * from them: the engine reads them (its own config reader), and this file only has to leave them out of the slot
 * table instead of failing with "role か roles が必要です". `granularity` is the granularity stage's `on` / `off`.
 */
export const PIPELINE_VALUE_KEYS = ["granularity"] as const;

/**
 * The speech-to-text role: its own block, apart from `roles:`, because it is not a lane or a conversation and
 * carries no harness. `provider` names one of the supported APIs, `model` the model to call there, and the
 * key is read from `apiKeyEnv` so the block never holds the value itself.
 */
export interface SttConfig {
  provider: string;
  model: string;
  apiKeyEnv: string;
  maxBytes: number;
  /** the API's base URL; defaults to the provider's public one */
  baseUrl: string;
}

/** the public URL each provider's API is reached at, when the block gives no `base_url` */
export const STT_PROVIDER_URLS: Record<string, string> = Object.freeze({
  gemini: "https://generativelanguage.googleapis.com",
});

const DEFAULT_STT_KEY_ENV = "GEMINI_API_KEY";
const DEFAULT_STT_MAX_BYTES = 20 * 1024 * 1024;

/** all lanes share one slice, so the sum of what they run stays under cpuQuota and yields to penne's own work */
export interface LaneCpu {
  slice: string;
  /** systemd's CPUQuota, a percentage of one CPU ("1000%" = 10 CPUs); null (cpu_quota: off) keeps the slice and the weight without a limit */
  cpuQuota: string | null;
  /** systemd's CPUWeight (1..10000; the default of other units is 100) */
  cpuWeight: number;
}

export const DEFAULT_LANE_CPU: LaneCpu = { slice: "idd_lanes.slice", cpuQuota: "1000%", cpuWeight: 20 };

/** how long one of a lane's shell tool calls may run, in minutes */
export const DEFAULT_TOOL_TIMEOUT_MINUTES = 15;

/** a run that waits for a person (a conversation) keeps its cache an hour; one that does not pays no premium and holds it 5 minutes */
export const DEFAULT_CONVERSATION_CACHE_TTL: CacheTtl = "1h";
export const DEFAULT_RUN_CACHE_TTL: CacheTtl = "5m";

export interface RolesFile {
  /**
   * claudeConfigDir: the CLAUDE_CONFIG_DIR lanes run Claude Code in, never penne's own.
   * claudeQuotaStop: per subscription window (five_hour / seven_day), the utilization at which no new Claude Code lane starts
   * laneCpu: the slice every scoped lane runs in, and the CPU limit and weight the slice is given before each start
   * toolTimeoutMinutes: how long one shell tool call of a lane's agent may run before the harness cuts it; null (off) for no limit
   * sharedDaemons: patterns of the processes a lane's supervisor moves out of the lane's scope instead of stopping them when the lane ends
   */
  defaults: { thinking: string; budgetMinutes: number; maxResumes: number; claudeConfigDir: string; claudeChatConfigDir: string; claudeQuotaStop: Record<string, number>; laneCpu: LaneCpu; toolTimeoutMinutes: number | null; sharedDaemons: string[]; titleContextTurns: number; fallbackOn: FailureKind[] };
  /** the model definitions, by name: the call target and the window it is reached through */
  models: Record<string, ModelDefinition>;
  roles: Record<string, RolePreset>;
  /** the speech-to-text API a transcription uses; absent means the door answers "not configured" */
  stt?: SttConfig;
  profiles: Record<string, LaneProfile>;
  /** keyed by pipeline role name: planner / executor */
  pipeline: Record<string, PipelineSlot>;
  /** absent: every policy as it was before it was configurable */
  policy?: ReviewStagePolicy;
}

const REPORT_KINDS: ReportKind[] = ["review", "confirm", "triage", "map", "exec", "probe", "scan", "free", "fix_plan", "shape"];
const TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** pi's built-in tools, all of them: a role that writes no `tools` has the whole set, and writing the list is how it narrows */
export const ALL_TOOLS: readonly string[] = [...TOOL_NAMES];

function asStringArray(v: unknown, label: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${label}: 文字列の配列を指定してください`);
  return v as string[];
}

function asRouting(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${label}: order / only / ignore / allow_fallbacks を持つオブジェクトを指定してください`);
  const o = v as Record<string, unknown>;
  for (const k of ["order", "only", "ignore"]) {
    if (o[k] !== undefined && (!Array.isArray(o[k]) || (o[k] as unknown[]).some((x) => typeof x !== "string"))) throw new Error(`${label}.${k}: 文字列の配列`);
  }
  return o;
}

function asFallbackOn(v: unknown, label: string): FailureKind[] | undefined {
  if (v === undefined || v === null) return undefined;
  const list = asStringArray(v, label);
  for (const k of list) if (!(FAILURE_KINDS as readonly string[]).includes(k)) throw new Error(`${label}: 知らない種類 "${k}"（${FAILURE_KINDS.join(" / ")}）`);
  return [...new Set(list)] as FailureKind[];
}

function asQuotaStop(v: unknown): Record<string, number> {
  if (v === undefined || v === null) return { ...DEFAULT_CLAUDE_QUOTA_STOP };
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("defaults.claude_quota_stop: { five_hour: 0.9, seven_day: 0.95 } の形で指定してください");
  const out = { ...DEFAULT_CLAUDE_QUOTA_STOP };
  for (const [name, t] of Object.entries(v as Record<string, unknown>)) {
    // a misspelt window would leave the default in force without a word
    if (!(name in CLAUDE_QUOTA_WINDOWS)) throw new Error(`defaults.claude_quota_stop.${name}: 知らない窓です（${Object.keys(CLAUDE_QUOTA_WINDOWS).join(" / ")}）`);
    if (typeof t !== "number" || !(t > 0 && t <= 1)) throw new Error(`defaults.claude_quota_stop.${name}: 0 より大きく 1 以下の使用率（0.9 = 90%）`);
    out[name] = t;
  }
  return out;
}

function asLaneCpu(v: unknown): LaneCpu {
  if (v === undefined || v === null) return { ...DEFAULT_LANE_CPU };
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("defaults.lane_cpu: { slice: idd_lanes.slice, cpu_quota: 1000%, cpu_weight: 20 } の形で指定してください");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["slice", "cpu_quota", "cpu_weight"].includes(k)) throw new Error(`defaults.lane_cpu.${k}: 知らない項目です（slice / cpu_quota / cpu_weight）`);
  const out = { ...DEFAULT_LANE_CPU };
  if (o.slice !== undefined) {
    const slice = String(o.slice).trim();
    // a slice the lanes do not own (app.slice, say) would put penne's own work under the limit and the low weight
    if (!slice.startsWith("idd_")) throw new Error(`defaults.lane_cpu.slice: lane 専用の slice にするため、idd_ で始まる名前にしてください: ${slice}`);
    // systemd reads "-" as nesting (a-b.slice lives inside a.slice), where the weight would only be weighed against the parent's other children
    if (slice.includes("-")) throw new Error(`defaults.lane_cpu.slice: "-" は systemd の slice の階層の区切りです。最上位の slice にするため "-" を使わないでください: ${slice}`);
    if (!/^idd_[A-Za-z0-9_]+\.slice$/.test(slice)) throw new Error(`defaults.lane_cpu.slice: idd_ で始まり英数字と _ だけで書いた <名前>.slice にしてください: ${slice}`);
    out.slice = slice;
  }
  if (o.cpu_quota === false || (typeof o.cpu_quota === "string" && o.cpu_quota.trim() === "off")) out.cpuQuota = null;
  else if (o.cpu_quota !== undefined) {
    const q = String(o.cpu_quota).trim();
    if (!/^[1-9]\d*%$/.test(q)) throw new Error(`defaults.lane_cpu.cpu_quota: 1 CPU を 100% とした百分率（例: 1000%）か off にしてください: ${q}`);
    out.cpuQuota = q;
  }
  if (o.cpu_weight !== undefined) {
    const w = o.cpu_weight;
    if (typeof w !== "number" || !Number.isInteger(w) || w < 1 || w > 10000) throw new Error("defaults.lane_cpu.cpu_weight: 1〜10000 の整数（他の unit の既定は 100）");
    out.cpuWeight = w;
  }
  return out;
}

/** a tool_timeout_minutes value (defaults, a role, a repo): minutes, null for off, undefined when not written */
export function parseToolTimeoutMinutes(v: unknown, label: string): number | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === false || (typeof v === "string" && v.trim() === "off")) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`${label}: 0 より大きい分の数（例: 15）か off にしてください: ${String(v)}`);
  return v;
}

/** a cache_ttl value (a role, a repo): 1h or 5m, undefined when not written; anything else is refused where it is written */
export function parseCacheTtl(v: unknown, label: string): CacheTtl | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "1h" || v === "5m") return v;
  throw new Error(`${label}: cache_ttl は 1h か 5m を指定してください: ${String(v)}`);
}

function asToolTimeout(v: unknown): number | null {
  const parsed = parseToolTimeoutMinutes(v, "defaults.tool_timeout_minutes");
  return parsed === undefined ? DEFAULT_TOOL_TIMEOUT_MINUTES : parsed;
}

/**
 * The `stt` block. A provider outside the known set is refused here, so a typo does not reach the network. The
 * block holds no key: `api_key_env` names where the key lives.
 */
function asStt(v: unknown): SttConfig | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("stt: provider / model / api_key_env / max_bytes / base_url を持つ対応表にしてください");
  const o = v as Record<string, unknown>;
  const provider = typeof o.provider === "string" ? o.provider.trim() : "";
  if (!provider) throw new Error(`stt.provider: 1 つ指定してください（${Object.keys(STT_PROVIDER_URLS).join(" / ")}）`);
  const publicUrl = STT_PROVIDER_URLS[provider];
  if (!publicUrl) throw new Error(`stt.provider: 知らない provider "${provider}"（${Object.keys(STT_PROVIDER_URLS).join(" / ")}）`);
  const model = typeof o.model === "string" ? o.model.trim() : "";
  if (!model) throw new Error("stt.model: 文字起こしに使う model を指定してください");
  const apiKeyEnv = typeof o.api_key_env === "string" && o.api_key_env.trim() ? o.api_key_env.trim() : DEFAULT_STT_KEY_ENV;
  const maxBytes = o.max_bytes === undefined || o.max_bytes === null ? DEFAULT_STT_MAX_BYTES : o.max_bytes;
  if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("stt.max_bytes: 0 より大きい整数（byte）を指定してください");
  const baseUrl = typeof o.base_url === "string" && o.base_url.trim() ? o.base_url.trim().replace(/\/+$/, "") : publicUrl;
  return { provider, model, apiKeyEnv, maxBytes, baseUrl };
}

function asTitleContextTurns(v: unknown): number {
  if (v === undefined || v === null) return 3;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error("defaults.title_context_turns: 1 以上の整数（末尾の何ターンからタイトルを付けるか）");
  return v;
}

function asSharedDaemons(v: unknown): string[] {
  if (v === undefined || v === null) return [...DEFAULT_SHARED_DAEMONS];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error("defaults.shared_daemons: 正規表現の文字列の配列を指定してください");
  for (const p of v as string[]) {
    try { new RegExp(p); } catch (err) { throw new Error(`defaults.shared_daemons: 正規表現として読めません: ${p}（${err instanceof Error ? err.message : String(err)}）`); }
  }
  return [...(v as string[])];
}

/**
 * A fallback stands in for a route that cannot run, so it must be able to do the stage's work: a role that
 * exists, writes the report the stage reads, has a model now rather than when the route fails, and has every
 * tool the role has (the stage's brief is written for them). The direction of the harness does not matter: a
 * run may move from Claude to an API role or the other way around, as long as the list is tried in order.
 * The fallback's own `fallback` is not followed here.
 */
function checkFallback(role: RolePreset, roles: Record<string, RolePreset>): void {
  if (role.fallback === undefined) return;
  const label = `roles.${role.name}.fallback`;
  const names = typeof role.fallback === "string" ? [role.fallback] : role.fallback;
  const seen = new Set<string>();
  for (const name of names) {
    if (name === role.name) throw new Error(`${label}: 自分自身は代わりになりません`);
    if (seen.has(name)) throw new Error(`${label}: 代わりの "${name}" が重複しています`);
    seen.add(name);
    const target = roles[name];
    if (!target) throw new Error(`${label}: 未定義の role "${name}"`);
    const missing = role.tools.filter((t) => !target.tools.includes(t));
    if (missing.length) throw new Error(`${label}: 代わりの "${target.name}" に ${missing.join(", ")} がありません。段の仕事ができるよう、元の role の tools をすべて持つ role を指定してください`);
    if (target.report !== role.report) throw new Error(`${label}: 代わりの "${target.name}" は report: ${target.report}。段は ${role.report} の書式で読むので、同じ report の role を指定してください`);
    try {
      resolveRole(target.name, { roles } as RolesFile);
    } catch (err) {
      throw new Error(`${label}: 代わりの role を起動できません（${err instanceof Error ? err.message : String(err)}）。model が要ります`);
    }
  }
}

/** a role's fallback names, however it wrote them (one name or a list) */
export function fallbackNames(role: RolePreset): string[] {
  if (role.fallback === undefined) return [];
  return typeof role.fallback === "string" ? [role.fallback] : role.fallback;
}

/**
 * A model definition: the call target pi is given and the window it is reached through. The name is the
 * definition's own; the call target is written as it is, so the file says which window the call goes through and
 * nothing rewrites it afterwards.
 */
function asModelDefinition(name: string, raw: unknown): ModelDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`models.${name}: 対応表で書いてください`);
  const o = raw as Record<string, unknown>;
  const model = typeof o.model === "string" ? o.model.trim() : "";
  if (!model) throw new Error(`models.${name}.model: 呼び先そのもの（<窓口>/<その先での id>）を書いてください`);
  if (!/^[^/\s]+\/\S+$/.test(model)) throw new Error(`models.${name}.model: 呼び先の形（<窓口>/<その先での id>）にしてください: ${model}`);
  const provider = o.provider !== undefined ? asRouting(o.provider, `models.${name}.provider`) : undefined;
  const providers = o.providers !== undefined ? asStringArray(o.providers, `models.${name}.providers`).map((s) => s.trim()).filter(Boolean) : undefined;
  if (provider && providers) throw new Error(`models.${name}.providers: provider（routing）と併記できません。どちらか 1 つにしてください`);
  if (providers && !providers.length) throw new Error(`models.${name}.providers: 1 つ以上の provider 名を指定してください`);
  const fallback = typeof o.fallback === "string" ? o.fallback.trim() : "";
  if (o.fallback !== undefined && !fallback) throw new Error(`models.${name}.fallback: 替わりとなる model 定義の名前を指定してください`);
  return {
    name,
    model,
    ...(provider ? { provider } : {}),
    ...(typeof o.routing_field === "string" ? { routingField: o.routing_field } : {}),
    ...(providers ? { providers } : {}),
    ...(fallback ? { fallback } : {}),
  };
}

/** the model definitions of the file, by name; a 替わり that names no definition is refused */
function asModels(raw: unknown): Record<string, ModelDefinition> {
  const out: Record<string, ModelDefinition> = {};
  const rawModels = (raw ?? {}) as Record<string, unknown>;
  for (const [name, def] of Object.entries(rawModels)) {
    if (name.includes("/")) throw new Error(`models.${name}: model 定義の名前には / を書けません（呼び先は model.<名前>.model に書きます）`);
    out[name] = asModelDefinition(name, def);
  }
  for (const def of Object.values(out)) {
    const seen = new Set<string>([def.name]);
    let next = def.fallback;
    while (next) {
      if (!out[next]) throw new Error(`models.${def.name}.fallback: 未定義の model 定義 "${next}"`);
      if (seen.has(next)) throw new Error(`models.${def.name}.fallback: 替わりが輪になっています（${next}）`);
      seen.add(next);
      next = out[next].fallback;
    }
  }
  return out;
}

/** the role's preset with a model definition's call target and window */
export function withModel(preset: RolePreset, def: ModelDefinition, thinking?: string): RolePreset {
  return {
    ...preset,
    model: def.model,
    modelName: def.name,
    ...(def.provider ? { provider: def.provider } : {}),
    ...(def.routingField ? { routingField: def.routingField } : {}),
    ...(def.providers ? { providers: def.providers } : {}),
    ...(def.fallback ? { modelFallback: def.fallback } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

export function parseRoles(text: string): RolesFile {
  const raw = (yamlLoad(text) ?? {}) as Record<string, unknown>;
  const d = (raw.defaults ?? {}) as Record<string, unknown>;
  // the whole-window switch is the old form: the call target in the file is the call target that runs
  if (d.gateway !== undefined) throw new Error("defaults.gateway: 旧形式です。窓口の読み替えはしません。model の定義に呼び先そのもの書いてください");
  const defaults = {
    thinking: typeof d.thinking === "string" ? d.thinking : "medium",
    budgetMinutes: typeof d.budget_minutes === "number" ? d.budget_minutes : 40,
    maxResumes: typeof d.max_resumes === "number" ? d.max_resumes : 1,
    claudeConfigDir: expandHome(process.env.IDD_CLAUDE_CONFIG_DIR?.trim() || (typeof d.claude_config_dir === "string" ? d.claude_config_dir : "~/.config/idd/claude")),
    claudeChatConfigDir: expandHome(process.env.IDD_CLAUDE_CHAT_CONFIG_DIR?.trim() || (typeof d.claude_chat_config_dir === "string" ? d.claude_chat_config_dir : "~/.config/idd/claude-chat")),
    claudeQuotaStop: asQuotaStop(d.claude_quota_stop),
    laneCpu: asLaneCpu(d.lane_cpu),
    toolTimeoutMinutes: asToolTimeout(d.tool_timeout_minutes),
    sharedDaemons: asSharedDaemons(d.shared_daemons),
    titleContextTurns: asTitleContextTurns(d.title_context_turns),
    fallbackOn: asFallbackOn(d.fallback_on, "defaults.fallback_on") ?? [...FAILURE_KINDS],
  };
  const stt = asStt(raw.stt);
  const modelDefs = asModels(raw.models);
  const roles: Record<string, RolePreset> = {};
  const rawRoles = (raw.roles ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, r] of Object.entries(rawRoles)) {
    // not writing `tools` is the whole set; an empty list that is written stays empty (pi reads it as read only)
    const tools = r.tools === undefined || r.tools === null ? [...ALL_TOOLS] : asStringArray(r.tools, `roles.${name}.tools`);
    for (const t of tools) if (!TOOL_NAMES.has(t)) throw new Error(`roles.${name}.tools: 未知の tool "${t}"`);
    const report = (r.report ?? "free") as ReportKind;
    if (!REPORT_KINDS.includes(report)) throw new Error(`roles.${name}.report: ${REPORT_KINDS.join("|")} のいずれか`);
    const harness = (r.harness ?? "pi") as Harness;
    if (harness !== "pi" && harness !== "claude") throw new Error(`roles.${name}.harness: pi | claude`);
    const cacheTtl = parseCacheTtl(r.cache_ttl, `roles.${name}.cache_ttl`);
    // Claude Code's switch: a pi run reads none of it, so a value there would only be misread as taking effect
    if (cacheTtl !== undefined && harness !== "claude") throw new Error(`roles.${name}.cache_ttl: harness: claude の role にだけ書けます（値は 1h か 5m）`);
    // the window belongs to the model definition; a role that names one is the old form
    if (r.provider !== undefined) throw new Error(`roles.${name}.provider: 旧形式です。窓口の指定は model の定義（models 節）に書いてください`);
    if (r.providers !== undefined) throw new Error(`roles.${name}.providers: 旧形式です。窓口の指定は model の定義（models 節）に書いてください`);
    const modelName = typeof r.model === "string" ? r.model.trim() : "";
    roles[name] = {
      name,
      harness,
      model: "",
      thinking: typeof r.thinking === "string" ? r.thinking : defaults.thinking,
      tools,
      policy: asStringArray(r.policy, `roles.${name}.policy`),
      report,
      requireClean: r.require_clean === undefined ? true : Boolean(r.require_clean),
      budgetMinutes: typeof r.budget_minutes === "number" ? r.budget_minutes : defaults.budgetMinutes,
      contextFiles: r.context_files === undefined ? true : Boolean(r.context_files),
      maxResumes: typeof r.max_resumes === "number" ? r.max_resumes : defaults.maxResumes,
      fallbackOn: asFallbackOn(r.fallback_on, `roles.${name}.fallback_on`) ?? defaults.fallbackOn,
    };
    if (harness === "claude") {
      // Claude Code's model is its own alias, not a pi call target: it stays in the role
      roles[name].model = modelName;
    } else if (modelName) {
      if (modelName.includes("/")) throw new Error(`roles.${name}.model: 旧形式です。呼び先ではなく model 定義の名前（models 節）を書いてください: ${modelName}`);
      const def = modelDefs[modelName];
      if (!def) throw new Error(`roles.${name}.model: 未定義の model 定義 "${modelName}"（models 節: ${Object.keys(modelDefs).join(", ") || "なし"}）`);
      roles[name] = withModel(roles[name], def);
    }
    if (r.fallback !== undefined) {
      const names = typeof r.fallback === "string" ? [r.fallback.trim()] : asStringArray(r.fallback, `roles.${name}.fallback`).map((s) => s.trim());
      if (!names.length || names.some((n) => !n)) throw new Error(`roles.${name}.fallback: role 名を 1 つ以上指定してください`);
      roles[name].fallback = typeof r.fallback === "string" ? names[0] : names;
    }
    const toolTimeout = parseToolTimeoutMinutes(r.tool_timeout_minutes, `roles.${name}.tool_timeout_minutes`);
    if (toolTimeout !== undefined) roles[name].toolTimeoutMinutes = toolTimeout;
    if (cacheTtl !== undefined) roles[name].cacheTtl = cacheTtl;
  }
  for (const role of Object.values(roles)) checkFallback(role, roles);
  const profiles: Record<string, LaneProfile> = {};
  const rawProfiles = (raw.profiles ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, p] of Object.entries(rawProfiles)) {
    const blind = asStringArray(p.blind, `profiles.${name}.blind`);
    const refs = [...blind, ...(typeof p.confirm === "string" ? [p.confirm] : []), ...(typeof p.plan_review === "string" ? [p.plan_review] : []), ...(typeof p.escalation === "string" ? [p.escalation] : [])];
    for (const ref of refs) if (!roles[ref]) throw new Error(`profiles.${name}: 未定義の role "${ref}"`);
    profiles[name] = {
      name, blind,
      ...(typeof p.confirm === "string" ? { confirm: p.confirm } : {}),
      ...(typeof p.plan_review === "string" ? { plan_review: p.plan_review } : {}),
      ...(typeof p.escalation === "string" ? { escalation: p.escalation } : {}),
      ...(typeof p.note === "string" ? { note: p.note } : {}),
    };
  }
  const pipeline: Record<string, PipelineSlot> = {};
  const rawPipeline = (raw.pipeline ?? {}) as Record<string, Record<string, unknown>>;
  const policy = parseStagePolicy(rawPipeline);
  for (const [name, why] of Object.entries(PIPELINE_RETIRED_KEYS)) if (rawPipeline[name] !== undefined) throw new Error(`pipeline.${name}: ${why}`);
  for (const [name, slot] of Object.entries(rawPipeline)) {
    if ((PIPELINE_POLICY_BLOCKS as readonly string[]).includes(name) || (PIPELINE_VALUE_KEYS as readonly string[]).includes(name)) continue;
    const list = Array.isArray(slot.roles)
      ? slot.roles.map((r) => String(r).trim()).filter(Boolean)
      : typeof slot.role === "string" && slot.role.trim() ? [slot.role.trim()] : [];
    if (!list.length) throw new Error(`pipeline.${name}: role か roles が必要です`);
    for (const r of list) if (!roles[r]) throw new Error(`pipeline.${name}: 未定義の role "${r}"`);
    // two runs of one role in a stage would write the same spec and report
    const dup = list.find((r, i) => list.indexOf(r) !== i);
    if (dup) throw new Error(`pipeline.${name}: role "${dup}" が重複しています`);
    const c = slot.concurrency;
    if (c !== undefined && (typeof c !== "number" || !Number.isInteger(c) || c < 1)) throw new Error(`pipeline.${name}.concurrency: 1 以上の整数`);
    const count = (key: string, min: number): number | undefined => {
      const v = slot[key];
      if (v === undefined) return undefined;
      if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new Error(`pipeline.${name}.${key}: ${min} 以上の整数`);
      return v;
    };
    const minLines = count("min_lines", 0);
    const maxRoutes = count("max_routes", 1);
    const extra = (key: string): string[] | undefined => {
      if (slot[key] === undefined) return undefined;
      const names = asStringArray(slot[key], `pipeline.${name}.${key}`).map((r) => r.trim()).filter(Boolean);
      for (const r of names) if (!roles[r]) throw new Error(`pipeline.${name}.${key}: 未定義の role "${r}"`);
      // a repeated name would start the same role and model twice; the count reads each pair once
      return names.filter((r, i) => names.indexOf(r) === i);
    };
    const firstRoundExtra = extra("first_round_extra");
    const highRiskExtra = extra("high_risk_extra");
    // the models the stage runs its roles with, and the thinking of each pair
    const models: StageModel[] = [];
    if (slot.models !== undefined) {
      const items = Array.isArray(slot.models) ? slot.models : [slot.models];
      for (const item of items) {
        if (typeof item === "string") {
          const n = item.trim();
          if (!n) throw new Error(`pipeline.${name}.models: model 定義の名前を指定してください`);
          models.push({ name: n });
          continue;
        }
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`pipeline.${name}.models: model 定義の名前か { model: 名前, thinking: 値 } で指定してください`);
        const o = item as Record<string, unknown>;
        const n = typeof o.model === "string" ? o.model.trim() : "";
        if (!n) throw new Error(`pipeline.${name}.models: model 定義の名前を指定してください`);
        models.push({ name: n, ...(typeof o.thinking === "string" ? { thinking: o.thinking } : {}) });
      }
      for (const m of models) if (!modelDefs[m.name]) throw new Error(`pipeline.${name}.models: 未定義の model 定義 "${m.name}"（models 節: ${Object.keys(modelDefs).join(", ") || "なし"}）`);
      const dupModel = models.find((m, i) => models.findIndex((x) => x.name === m.name) !== i);
      if (dupModel) throw new Error(`pipeline.${name}.models: model 定義 "${dupModel.name}" が重複しています`);
    }
    const stageThinking = typeof slot.thinking === "string" ? slot.thinking : undefined;
    pipeline[name] = {
      role: list[0], roles: list, models, concurrency: typeof c === "number" ? c : 1,
      runs: runsFor(list, models, stageThinking, roles, defaults.thinking),
      extraRuns: {
        first_round: runsFor(firstRoundExtra ?? [], [], undefined, roles, defaults.thinking),
        high_risk: runsFor(highRiskExtra ?? [], [], undefined, roles, defaults.thinking),
      },
      ...(stageThinking !== undefined ? { thinking: stageThinking } : {}),
      ...(minLines !== undefined ? { minLines } : {}),
      ...(maxRoutes !== undefined ? { maxRoutes } : {}),
      ...(firstRoundExtra?.length ? { firstRoundExtra } : {}),
      ...(highRiskExtra?.length ? { highRiskExtra } : {}),
    };
  }
  return { defaults, models: modelDefs, roles, ...(stt ? { stt } : {}), profiles, pipeline, policy };
}

/** the loop's policy blocks, checked so a typo fails loudly instead of quietly reading as the old behaviour */
function parseStagePolicy(raw: Record<string, Record<string, unknown>>): ReviewStagePolicy {
  const pick = <T extends string>(block: string, key: string, allowed: readonly T[], fallback: T): T => {
    const v = raw[block]?.[key];
    if (v === undefined) return fallback;
    if (!allowed.includes(v as T)) throw new Error(`pipeline.${block}.${key}: ${allowed.join(" か ")}`);
    return v as T;
  };
  for (const block of PIPELINE_POLICY_BLOCKS) {
    const b = raw[block];
    if (b !== undefined && (typeof b !== "object" || b === null || Array.isArray(b))) throw new Error(`pipeline.${block}: 対応表で書いてください`);
  }
  const cap = raw.review_loop?.max_fix_rounds;
  if (cap !== undefined && (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1)) throw new Error("pipeline.review_loop.max_fix_rounds: 1 以上の整数");
  const shouldCap = raw.review_loop?.max_should_fix;
  if (shouldCap !== undefined && (typeof shouldCap !== "number" || !Number.isInteger(shouldCap) || shouldCap < 1)) throw new Error("pipeline.review_loop.max_should_fix: 1 以上の整数");
  pick("review_loop", "after_merge", ["whole", "conflict"] as const, "whole");
  pick("review_blind", "high_risk_when", ["first", "last"] as const, "first");
  pick("review_final", "when", ["always", "behaviour"] as const, "always");
  pick("review_final", "scope", ["whole", "increment"] as const, "whole");
  return {
    shouldDefault: pick("review_loop", "should_default", ["fix", "followup", "triage"] as const, "fix"),
  };
}

/** The resolved role preset for a pipeline slot (planner / executor). Throws when unset or its model is empty. */
export function resolvePipelineRole(slotName: string, roles = readRoles()): { slot: PipelineSlot; role: RolePreset } {
  const slot = roles.pipeline[slotName];
  if (!slot) throw new Error(`config/roles.yaml の pipeline に "${slotName}" がありません`);
  const run = stageRuns(slot, roles)[0];
  const role = run?.model ? resolveRoleModel(run.role, run.model, roles, run.thinking) : resolveRole(slot.role, roles);
  return { slot, role };
}

export function readRoles(path = rolesPath()): RolesFile {
  if (!existsSync(path)) throw new Error(`roles ファイルがありません: ${path}。\`idd install\` で例（config/roles.example.yaml）を ~/.config/idd/roles.yaml に置けます`);
  return parseRoles(readFileSync(path, "utf8"));
}

export function resolveRole(name: string, roles = readRoles()): RolePreset {
  const role = roles.roles[name];
  if (!role) throw new Error(`未知の role "${name}"。定義済み: ${Object.keys(roles.roles).join(", ")}`);
  if (!role.model) throw new Error(`role "${name}" に model が設定されていません（config/roles.yaml）`);
  if (role.harness === "pi" && !/^[^/\s]+\/\S+$/.test(role.model)) throw new Error(`role "${name}" の model は provider/modelId の形にしてください: ${role.model}`);
  return role;
}

/**
 * The role's preset with the model definition a stage names for it: the call target and the window come from the
 * definition, the thinking from the pair (the stage's, then the role's own default).
 */
export function resolveRoleModel(name: string, modelName: string, roles = readRoles(), thinking?: string): RolePreset {
  const role = roles.roles[name];
  if (!role) throw new Error(`未知の role "${name}"。定義済み: ${Object.keys(roles.roles).join(", ")}`);
  const def = roles.models?.[modelName];
  if (!def) throw new Error(`未知の model 定義 "${modelName}"。定義済み: ${Object.keys(roles.models ?? {}).join(", ")}`);
  return withModel(role, def, thinking ?? role.thinking);
}

/**
 * The runs a set of roles makes with a set of models: every role with every model. A set of models that is empty
 * means the roles' own models, so a role used outside a stage reads its own defaults.
 */
export function runsFor(roleNames: readonly string[], models: readonly StageModel[], thinking: string | undefined, roles: Record<string, RolePreset>, defaultThinking: string): StageRun[] {
  const out: StageRun[] = [];
  for (const name of roleNames) {
    const preset = roles[name];
    const roleThinking = preset?.thinking ?? defaultThinking;
    if (!models.length) {
      out.push({ role: name, ...(preset?.modelName ? { model: preset.modelName } : {}), thinking: thinking ?? roleThinking });
      continue;
    }
    for (const m of models) {
      out.push({ role: name, model: m.name, thinking: m.thinking ?? thinking ?? roleThinking });
    }
  }
  return out;
}

/**
 * The runs a stage declares: every role of the slot with every model the slot names. A slot that names no model
 * runs each role with the role's own model, so a stage outside the pipeline (an ad-hoc lane, a mode) reads the
 * role's own defaults.
 */
export function stageRuns(slot: PipelineSlot, roles: RolesFile): StageRun[] {
  return runsFor(slot.roles, slot.models, slot.thinking, roles.roles, roles.defaults.thinking);
}

/** the run of a role outside a stage: the role's own model and the role's own thinking */
export function roleRun(roleName: string, roles: RolesFile): StageRun {
  const preset = roles.roles[roleName];
  return { role: roleName, ...(preset?.modelName ? { model: preset.modelName } : {}), thinking: preset?.thinking ?? roles.defaults.thinking };
}
