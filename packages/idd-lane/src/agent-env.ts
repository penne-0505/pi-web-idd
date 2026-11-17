/**
 * Credentials that belong to the engine and never to an agent it starts. A lane, a conversation, a
 * supervisor or a one-shot drafter gets the engine's environment without them, whatever its harness.
 */
export const AGENT_ENV_STRIP: readonly string[] = Object.freeze(["LINEAR_API_KEY", "GEMINI_API_KEY"]);

/** the environment for a child process that runs (or supervises) an agent */
export function agentEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(base)) if (!AGENT_ENV_STRIP.includes(k)) env[k] = v;
  for (const [k, v] of Object.entries(extra)) if (!AGENT_ENV_STRIP.includes(k)) env[k] = v;
  return env;
}

/**
 * The engine's own environment without a lane-level dangerous-path declaration. The engine runs several repos' lanes,
 * and a declaration left in its shell must not reach a repo that declares none; each lane's own value is passed in
 * explicitly after this filter.
 */
export function withoutRiskPaths(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(env)) if (k !== "IDD_RISK_PATHS") out[k] = v;
  return out;
}

/**
 * The UI server's own runtime variables (the same set the host's bash extension takes out of a project
 * command). A reply's agent must not see the server's PORT: its bash would reach the UI instead of the
 * project. The supervisor keeps them, so it can still build the tick's destination from PORT.
 */
function isHostRuntimeVariable(name: string, platform: NodeJS.Platform): boolean {
  const comparable = platform === "win32" ? name.toUpperCase() : name;
  return comparable === "PORT" || comparable === "NODE_ENV" || comparable.startsWith("NEXT_");
}

/** the same environment with the server's runtime variables dropped */
export function withoutHostRuntime(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(env)) if (!isHostRuntimeVariable(k, platform)) out[k] = v;
  return out;
}
