import { checkPiRoleStartable } from "./agent-dir.ts";
import {
  checkClaudeConfigDir,
  checkClaudeQuota,
  ClaudeQuotaBlocked,
  fallbackCannotStart,
  quotaFallbackOf,
  type QuotaFallback,
} from "./claude-quota.ts";
import { fallbackNames, readRoles, resolveRole, withModel, type FailureKind, type ModelDefinition, type RolePreset, type RolesFile } from "./roles.ts";

/**
 * The order a role's route is drawn from: the role itself (one candidate per provider when it wrote
 * `providers`), then the roles written under its `fallback`, in the order given. A fallback's own `fallback`
 * is never followed, so one role's whole order reads from its own block and no cycle is possible.
 */
export interface Candidate {
  /** the preset that would run, pinned to one provider when the role wrote `providers` */
  role: RolePreset;
  /** the role whose report the stage reads: the originally requested role, even for a fallback candidate */
  origin: string;
  /** claude for the Claude Code harness, else the model's provider name (ollama-cloud, openrouter, ...) */
  contract: string;
  /** the provider this candidate pins, when the role wrote a provider column */
  provider?: string;
  /** the role named in `fallback` that this candidate came from; absent for the role's own candidates */
  via?: string;
  /** the model definition this candidate runs */
  modelName?: string;
  /** the model definition this candidate stands in for: the 替わり the definition names */
  modelFallback?: string;
}

export interface RouteOptions {
  /** how a pi candidate's startability is checked; defaults to the price check preparing its agent dir would do */
  checkStartable?: (role: RolePreset) => void;
  /** the moment the windows are judged from (tests) */
  now?: number;
  /** a run that may not change roles: only the role's own candidates are drawn */
  noFallback?: boolean;
}

export interface Route {
  candidate: Candidate;
  /** the candidate's place in the role's whole order, so the caller can keep the ones after it */
  index: number;
  /** a Claude candidate's route was refused and this candidate ran in its place */
  fallback?: QuotaFallback;
}

/** the provider a candidate's preset pinned, if it wrote a provider column (the routing's `only` names it) */
export function providerOf(role: RolePreset): string | undefined {
  const only = role.provider?.only;
  return Array.isArray(only) && typeof only[0] === "string" ? only[0] : undefined;
}

/** the contract a candidate bills through, read from its harness and model name */
export function contractOf(role: RolePreset): string {
  if (role.harness === "claude") return "claude";
  const slash = role.model.indexOf("/");
  return slash > 0 ? role.model.slice(0, slash) : role.model;
}

/** the routing object that pins one provider and forbids handing the attempt to another */
function pinnedRouting(provider: string): Record<string, unknown> {
  return { only: [provider], allow_fallbacks: false };
}

function pinnedRole(role: RolePreset, provider: string): RolePreset {
  const vercel = role.model.startsWith("vercel-ai-gateway/");
  return { ...role, provider: pinnedRouting(provider), routingField: vercel ? "vercelGatewayRouting" : "openRouterRouting" };
}

function ownCandidates(role: RolePreset, origin: string, via?: string, modelFallback?: string): Candidate[] {
  const common = { origin, contract: contractOf(role), ...(via ? { via } : {}), ...(role.modelName ? { modelName: role.modelName } : {}), ...(modelFallback ? { modelFallback } : {}) };
  if (role.providers?.length) {
    return role.providers.map((provider) => ({ ...common, role: pinnedRole(role, provider), provider }));
  }
  return [{ ...common, role }];
}

/**
 * The model definitions a call goes through: the role's own model, then the 替わり it names, then that one's 替わり.
 * The 替わり is what runs when the model's own qualification (its price, its window) is missing, so the order is the
 * order the run tries them in.
 */
export function modelChain(role: RolePreset, file: RolesFile): ModelDefinition[] {
  const out: ModelDefinition[] = [];
  const seen = new Set<string>();
  let name = role.modelName;
  while (name && !seen.has(name)) {
    seen.add(name);
    const def = file.models?.[name];
    if (!def) break;
    out.push(def);
    name = def.fallback;
  }
  return out;
}

/** every way this role may be started, in the order to try: its own model, its 替わり, then its fallbacks' routes */
export function candidatesFor(role: RolePreset, file: RolesFile): Candidate[] {
  const out: Candidate[] = [];
  const chain = modelChain(role, file);
  if (!chain.length) {
    out.push(...ownCandidates(role, role.name));
  } else {
    let stands = role.modelName;
    for (const def of chain) {
      const own = def.name === role.modelName;
      out.push(...ownCandidates(own ? role : withModel(role, def), role.name, undefined, own ? undefined : stands));
      stands = def.name;
    }
  }
  for (const name of fallbackNames(role)) {
    const target = resolveRole(name, file);
    out.push(...ownCandidates(target, role.name, name));
  }
  return out;
}

function quotaFallbackFor(role: RolePreset, candidate: Candidate, err: ClaudeQuotaBlocked): QuotaFallback {
  return quotaFallbackOf(role.name, candidate.role.name, err, { kind: "quota", ...(candidate.provider ? { provider: candidate.provider } : {}) });
}

/**
 * Whether one candidate can start now: a Claude candidate against the subscription's windows, a pi candidate
 * against its price. Throws the refusal (a ClaudeQuotaBlocked for the windows) when it cannot.
 */
export function checkCandidateStartable(candidate: Candidate, file: RolesFile, opts: RouteOptions = {}): void {
  if (candidate.role.harness === "claude") checkClaudeQuota(file.defaults.claudeConfigDir, file.defaults.claudeQuotaStop, opts.now);
  else (opts.checkStartable ?? checkPiRoleStartable)(candidate.role);
}

/**
 * Draw the first candidate of a role that can start now. A login that has lapsed is a failure, never a reason to
 * move on; a candidate refused for the windows or one whose price is unknown is skipped to the next. When nothing
 * can start, the windows' refusal is thrown (with the last fallback that could not start named on it), or the
 * first candidate's own failure when the role itself is the one that cannot start.
 */
export function resolveRoute(role: RolePreset, file: RolesFile = readRoles(), opts: RouteOptions = {}): Route {
  const candidates = opts.noFallback ? candidatesFor(role, file).filter((c) => c.via === undefined) : candidatesFor(role, file);
  if (candidates.some((c) => c.role.harness === "claude")) checkClaudeConfigDir(file.defaults.claudeConfigDir);
  let quotaRefusal: ClaudeQuotaBlocked | undefined;
  let lastCause: unknown;
  let lastName: string | undefined;
  for (const [i, candidate] of candidates.entries()) {
    try {
      checkCandidateStartable(candidate, file, opts);
    } catch (err) {
      if (candidate.role.harness === "claude") {
        quotaRefusal ??= err as ClaudeQuotaBlocked;
        continue;
      }
      // the role's own first route cannot start: that is a failure, as it always was. A later route that cannot
      // start is skipped like a refused window, so one unavailable fallback does not hold a stage that has another
      // The model definition's 替わり is the way out of a model whose own qualification is missing, so the run
      // moves to it instead of failing.
      const standsIn = candidates[i + 1]?.modelFallback !== undefined && candidates[i + 1]?.modelFallback === candidate.modelName;
      if (!quotaRefusal && i === 0 && !standsIn) throw err;
      lastCause = err;
      lastName = candidate.role.name;
      continue;
    }
    const fallback = quotaRefusal && candidate.via ? quotaFallbackFor(role, candidate, quotaRefusal) : undefined;
    return { candidate, index: i, ...(fallback ? { fallback } : {}) };
  }
  if (quotaRefusal) {
    if (lastName !== undefined && lastCause !== undefined) throw fallbackCannotStart(quotaRefusal, lastName, lastCause);
    throw quotaRefusal;
  }
  const why = lastCause ? `（${lastCause instanceof Error ? lastCause.message : String(lastCause)}）` : "";
  throw new Error(`role ${role.name}: 起動できる候補がありません${why}`);
}

/** the provider errors that mean a contract's balance or windows ran out, judged narrowly: an unknown wording falls to a provider fault */
const QUOTA_ERROR = /\b402\b|insufficient[_ -]?(funds|quota|balance|credits)|quota[ _-]?(exceeded|exhausted|reached)|usage[ _-]?limit|out of credits|credit[ _-]?balance/i;

export function isQuotaError(text: string): boolean {
  return QUOTA_ERROR.test(text);
}

export interface FailureInputs {
  status: "running" | "done" | "failed" | "timeout" | "stopped";
  /** why the harness binary could not be started */
  spawnError?: string;
  /** the provider error of the session's last reply, or null when it did not fail */
  providerError?: string | null;
}

/**
 * The kind of a failed attempt, or null when it has none: a wall-clock cut is a timeout, a reply that ended in a
 * provider error is a quota or provider fault, and everything else (no report, a binary that would not start, a
 * dirty worktree, a person's stop) carries no kind. An unknown provider wording is taken as a provider fault.
 * An attempt that finished done already has its deliverable, so its last reply ending in a provider error is not a
 * failure: it does not move to the next candidate, and its consumption row stays done without a failure kind.
 */
export function failureKindOf(o: FailureInputs): FailureKind | null {
  if (o.status === "done") return null;
  if (o.status === "stopped") return null;
  if (o.status === "timeout") return "timeout";
  if (o.spawnError) return null;
  const err = o.providerError;
  if (!err) return null;
  return isQuotaError(err) ? "quota" : "provider";
}
