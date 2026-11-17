import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import { spawnSync } from "node:child_process";

import { requirePrice, vercelPrice, type ModelCost } from "./gateway.ts";
import { expandHome, laneStateDir, piBinary } from "./paths.ts";
import type { RolePreset } from "./roles.ts";
import { agentEnv } from "./agent-env.ts";
import { TOOL_TIMEOUT_LOG, writeLaneShell, writeLaneShellEnv } from "./lane-shell.ts";

type Json = Record<string, unknown>;

/** which models.json compat key carries the routing object, by provider */
const ROUTING_FIELDS: Record<string, string> = {
  openrouter: "openRouterRouting",
  "vercel-gw": "vercelGatewayRouting",
  vercel: "vercelGatewayRouting",
};

export function userAgentDir(): string {
  return process.env.IDD_PI_USER_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim() || join(expandHome("~"), ".pi", "agent");
}

function routingFieldFor(provider: string, role: RolePreset): string {
  if (role.routingField) return role.routingField;
  const base = provider.split("-")[0];
  return ROUTING_FIELDS[provider] ?? ROUTING_FIELDS[base] ?? "openRouterRouting";
}

/**
 * Build the models.json a lane runs with: the user's config plus the role's provider routing
 * attached to the role's model. Pure so it can be unit-tested.
 */
export function buildModelsConfig(user: Json, role: RolePreset, opts: { knownToCatalog?: boolean; cost?: ModelCost | null } = {}): Json {
  const cfg = JSON.parse(JSON.stringify(user)) as Json;
  // nothing to add: a catalog model with no routing runs as-is
  if (!role.provider && opts.knownToCatalog !== false) return cfg;
  const [provider, ...rest] = role.model.split("/");
  const modelId = rest.join("/");
  const field = routingFieldFor(provider, role);
  const providers = (cfg.providers ??= {}) as Record<string, Json>;
  const p = (providers[provider] ??= {}) as Json;
  const custom = (p.models as Json[] | undefined)?.find((m) => m.id === modelId);
  if (custom) {
    if (role.provider) {
      const compat = (custom.compat ??= {}) as Json;
      compat[field] = role.provider;
    }
    return cfg;
  }
  if (opts.knownToCatalog === false) {
    // modelOverrides は既知 id にしか効かないので、未知の id は custom model として足す。
    // in-process の RPC session は enabled scope に無い model を拒むので、routing が無くてもここは要る
    const models = (p.models ??= []) as Json[];
    models.push({ id: modelId, name: modelId, reasoning: true, input: ["text"], contextWindow: 262144, maxTokens: 65536, ...(opts.cost ? { cost: opts.cost } : {}), ...(role.provider ? { compat: { [field]: role.provider } } : {}) });
    return cfg;
  }
  const overrides = (p.modelOverrides ??= {}) as Record<string, Json>;
  const entry = (overrides[modelId] ??= {}) as Json;
  const compat = (entry.compat ??= {}) as Json;
  compat[field] = role.provider;
  return cfg;
}

/** the gateway's public model list, kept beside the other pipeline state */
function vercelPriceCache(): string {
  return join(laneStateDir(), "..", "pipeline", "vercel-models.json");
}

/** the models.json for a role: a model pi's catalog does not know is added with the gateway's list price when one is known */
function modelsFor(user: Json, role: RolePreset, src: string): Json {
  const known = catalogHas(role.model, src);
  const [provider, ...rest] = role.model.split("/");
  // a gateway model the catalog does not price would run at a cost of 0; only Vercel has a price list to read.
  // Command Code models are priced only in the user's models.json, so one missing from it has no price
  const cost = known ? null
    : provider === "vercel-ai-gateway" ? requirePrice(role, vercelPrice(rest.join("/"), vercelPriceCache()))
    : provider === "openrouter" || provider === "commandcode" ? requirePrice(role, null)
    : null;
  return buildModelsConfig(user, role, { knownToCatalog: known, cost });
}

/**
 * Create a per-lane PI_CODING_AGENT_DIR: generated models.json, auth.json linked from the user's dir
 * (never copied), empty settings so no packages / extensions are loaded.
 */
/** exact-id lookup in pi's model catalog (offline) */
export function catalogHas(model: string, agentDir = userAgentDir()): boolean {
  const r = spawnSync(piBinary(), ["--offline", "--list-models", model], { encoding: "utf8", env: agentEnv(process.env, { PI_CODING_AGENT_DIR: agentDir }), timeout: 30000 });
  const [provider, ...rest] = model.split("/");
  const id = rest.join("/");
  return (r.stdout ?? "").split("\n").some((line) => {
    const cols = line.trim().split(/\s+/);
    return cols[0] === provider && cols[1] === id;
  });
}

/** Throws what preparing a pi role's agent dir would throw (a model with no price), without writing anything. */
export function checkPiRoleStartable(role: RolePreset): void {
  const src = userAgentDir();
  const userModelsPath = join(src, "models.json");
  const user = existsSync(userModelsPath) ? (JSON.parse(readFileSync(userModelsPath, "utf8")) as Json) : {};
  modelsFor(user, role, src);
}

/**
 * With a tool call limit (seconds), pi runs the lane's bash tool calls in the lane's shell (settings' shellPath),
 * which cuts a call at the limit and writes the cut to the lane's tool-timeouts.log.
 */
export function prepareAgentDir(laneDir: string, role: RolePreset, opts: { toolTimeoutSeconds?: number | null } = {}): string {
  const src = userAgentDir();
  const dir = join(laneDir, "agent");
  mkdirSync(dir, { recursive: true });
  const userModelsPath = join(src, "models.json");
  const user = existsSync(userModelsPath) ? (JSON.parse(readFileSync(userModelsPath, "utf8")) as Json) : {};
  writeFileSync(join(dir, "models.json"), `${JSON.stringify(modelsFor(user, role, src), null, 2)}\n`);
  for (const name of ["auth.json", "models-store.json", "trust.json"]) {
    const target = join(src, name);
    const link = join(dir, name);
    if (existsSync(link)) { try { unlinkSync(link); } catch { /* ignore */ } }
    if (existsSync(target)) symlinkSync(target, link);
  }
  const shellPath = opts.toolTimeoutSeconds ? writeLaneShell(dir, opts.toolTimeoutSeconds, join(laneDir, TOOL_TIMEOUT_LOG)) : undefined;
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ quietStartup: true, packages: [], skills: [], ...(shellPath ? { shellPath } : {}) }, null, 2)}\n`);
  return dir;
}

/**
 * Agent dir for an Issue-lane (pipeline) role: the user's dir linked in (extensions, skills, auth) and
 * regenerated to carry the role's provider routing and the lane's shell. Unlike the ad-hoc lane dir this keeps
 * the user's extensions, because Issue lanes rely on them.
 */
const CONTEXT_FILES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/** the entries the directory generates rather than links from the user's dir (models.json, and settings.json with the shell) */
const GENERATED_FILES = new Set(["models.json", "settings.json"]);

/** the user's settings, or an empty object when there is none (or it is not readable as JSON) */
function userSettings(src: string): Json {
  const p = join(src, "settings.json");
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    // pi cannot use a settings file it cannot parse either; the shell still has to reach the lane
    return {};
  }
}

let tempSeq = 0;

function pathExists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

/** does this link already point at `target` (compared resolved, so a relative link counts too) */
function linksTo(link: string, target: string): boolean {
  try { return resolve(link, "..", readlinkSync(link)) === resolve(target); } catch { return false; }
}

/**
 * Swap one symbolic link for another without an instant where the path is missing (rename replaces the
 * link itself). Only a link is ever replaced: a real file or directory at that path is pi's own (its
 * sessions, say) and may hold records a reply is reading, so it is left as it is.
 */
function replaceSymlink(p: string, target: string): void {
  const tmp = `${p}.${process.pid}-${tempSeq += 1}.tmp`;
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, p);
  } catch {
    // a real file or directory stands there after all: removing it would throw away what pi wrote
    rmSync(tmp, { force: true });
  }
}

/**
 * Agent dir for an Issue-lane (pipeline) role: the user's dir linked in (extensions, skills, auth), with
 * models.json regenerated to carry the role's provider routing and settings.json a copy of the user's carrying
 * the role's shell. Unlike the ad-hoc lane dir this keeps the user's extensions, because Issue lanes rely on them.
 *
 * The dir is shared by every reply of the role and is rebuilt while other replies are starting, so a
 * reader must never meet a missing link or a half-written models.json: a link that already points where
 * we would point is left alone, the others are put in place by rename, and models.json is written aside
 * and renamed over. settings.json is a copy of the user's, with the role's shell added: the user's dir is a
 * symlink target and pi writes settings in place, so linking it would let a lane's write reach the user's file.
 */
export function preparePipelineAgentDir(baseDir: string, role: RolePreset): string {
  const src = userAgentDir();
  const dir = join(baseDir, role.name);
  mkdirSync(dir, { recursive: true });
  // links are brought in line with the user's dir; a real file or directory pi wrote into this dir stays,
  // whichever name it has, because a reply may be running out of it
  const userEntries = new Set(existsSync(src) ? readdirSync(src) : []);
  for (const entry of readdirSync(dir)) {
    if (GENERATED_FILES.has(entry)) continue;
    const p = join(dir, entry);
    // the user's global context file (e.g. a delegate-orchestration prompt for the pi CLI) is not part
    // of a pipeline / mode session: the cwd's own AGENTS.md carries the protocol
    if (CONTEXT_FILES.has(entry)) { rmSync(p, { recursive: true, force: true }); continue; }
    if (userEntries.has(entry)) {
      const target = join(src, entry);
      // only links of ours are swapped. A real file or directory with the user's name (pi's sessions, say)
      // stays: a reply may be running out of it, and nothing here may throw away its records.
      if (lstatSync(p).isSymbolicLink() && !linksTo(p, target)) replaceSymlink(p, target);
      continue;
    }
    // a stale link of ours, pointing at something the user's dir no longer has, goes; pi's own files stay
    if (lstatSync(p).isSymbolicLink()) rmSync(p, { force: true });
  }
  for (const entry of userEntries) {
    if (GENERATED_FILES.has(entry) || CONTEXT_FILES.has(entry)) continue;
    const p = join(dir, entry);
    if (pathExists(p)) continue;
    replaceSymlink(p, join(src, entry));
  }
  const userModelsPath = join(src, "models.json");
  const user = existsSync(userModelsPath) ? (JSON.parse(readFileSync(userModelsPath, "utf8")) as Json) : {};
  const tmp = join(dir, `.models.json.${process.pid}-${tempSeq += 1}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(modelsFor(user, role, src), null, 2)}\n`);
  renameSync(tmp, join(dir, "models.json"));
  // the shell goes in before settings points at it, so a reader never meets a settings.json whose shellPath is missing.
  // Every pi in this dir runs bash through it; a reply with no limit in its environment (the engine's chat) runs the
  // call as pi's own shell would. The dir is shared across repos, so the limit and the log are the reply's, not baked here.
  const shellPath = writeLaneShellEnv(dir);
  const settingsTmp = join(dir, `.settings.json.${process.pid}-${tempSeq += 1}.tmp`);
  writeFileSync(settingsTmp, `${JSON.stringify({ ...userSettings(src), shellPath }, null, 2)}\n`);
  renameSync(settingsTmp, join(dir, "settings.json"));
  return dir;
}
