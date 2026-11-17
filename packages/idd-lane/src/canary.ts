import { join } from "node:path";

import { assistantTurns, piExitText, runPiOnce } from "./pi-oneshot.ts";
import { pipelineAgentDir, pipelineStateDir } from "./pipeline-spawn.ts";
import { readRoles, resolveRole, resolveRoleModel, type RolePreset, type RolesFile } from "./roles.ts";

/**
 * The canary's runtime: the roles the pipeline runs on pi, and one question asked of one role's model. The role's
 * model and thinking are the ones a lane would run it on, the run has no tools and no session, and the answer's usage
 * is read from the run's own `message_end`. A role's model moving under the same name changes what this asks; the
 * record of the day is where that shows.
 */

/** a role the canary watches, as core asks it for */
export interface CanaryRole {
  role: string;
  /** the call target the question is asked with */
  model: string;
  /** the model definition the call target came from: the record's file is one per role and model definition */
  modelName?: string;
  thinking: string;
}

export interface CanaryAnswer {
  text: string;
  usd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * The pipeline's pi roles, in a stable order, each with the model and thinking roles.yaml resolves. A stage that
 * names several models is watched once per model: the record is one per role and model, so a model that moves under
 * the same name shows up as a change of its own.
 */
export function pipelineCanaryRoles(roles: RolesFile = readRoles()): CanaryRole[] {
  const names = new Set<string>();
  for (const slot of Object.values(roles.pipeline)) {
    for (const name of [slot.role, ...slot.roles, ...(slot.firstRoundExtra ?? []), ...(slot.highRiskExtra ?? [])]) {
      if (name) names.add(name);
    }
  }
  const out: CanaryRole[] = [];
  const seen = new Set<string>();
  for (const name of [...names].sort()) {
    let role: RolePreset;
    try {
      role = resolveRole(name, roles);
    } catch {
      // a pipeline role with no model now is not a model to watch
      continue;
    }
    if (role.harness !== "pi") continue;
    // the models the stage runs this role with: the stage's own, or the role's own when the stage names none
    const models = new Map<string, string>();
    for (const slot of Object.values(roles.pipeline)) {
      for (const run of slot.runs) {
        if (run.role !== name) continue;
        models.set(run.model ?? "", run.thinking);
      }
      for (const run of slot.extraRuns.first_round) if (run.role === name) models.set(run.model ?? "", run.thinking);
      for (const run of slot.extraRuns.high_risk) if (run.role === name) models.set(run.model ?? "", run.thinking);
    }
    if (!models.size) models.set(role.modelName ?? "", role.thinking);
    for (const [modelName, thinking] of models) {
      const key = `${name}\u0000${modelName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const preset = modelName ? resolveRoleModel(name, modelName, roles, thinking) : role;
      out.push({ role: preset.name, model: preset.model, ...(preset.modelName ? { modelName: preset.modelName } : {}), thinking: preset.thinking });
    }
  }
  return out;
}

/** the one-shot arguments: the role's model and thinking, no tools, no context files and no session */
export function buildCanaryArgs(role: RolePreset, prompt: string): string[] {
  return [
    "-p", "--mode", "json", "--model", role.model, "--thinking", role.thinking,
    "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--no-session", "--no-approve",
    "--system-prompt", "",
    prompt,
  ];
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number } | number;
}

function usdOf(usage: PiUsage | undefined): number {
  if (!usage) return 0;
  const total = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

/** the answer's text and usage, from the JSONL a `--mode json` run writes */
export function parseCanaryOutput(stdout: string): CanaryAnswer {
  const turns = assistantTurns(stdout);
  const usage = turns.filter((t) => t.usage).at(-1)?.usage as PiUsage | undefined;
  return {
    text: turns.map((t) => t.text).filter(Boolean).at(-1) ?? "",
    usd: usdOf(usage),
    tokens: {
      input: Number(usage?.input ?? 0) || 0,
      output: Number(usage?.output ?? 0) || 0,
      cacheRead: Number(usage?.cacheRead ?? 0) || 0,
      cacheWrite: Number(usage?.cacheWrite ?? 0) || 0,
    },
  };
}

/**
 * The agent dir the role's questions run out of: the same per-role dir a lane runs the role in, so the model's
 * routing and price are the ones the lane gets. A model the role does not run itself gets a dir of its own, so the
 * lane's dir keeps the routing of the model the lane runs.
 */
export function canaryAgentDir(roleName: string, modelName?: string): string {
  const role = resolveRole(roleName);
  if (!modelName || modelName === role.modelName) return pipelineAgentDir(role);
  return join(pipelineStateDir(), "agent", `${roleName}-${modelName}`);
}

/**
 * One question, asked once. The role's own agent dir carries the model's routing and price, as every pipeline role's
 * does; the run is killed at the limit, and its stdout is read for the answer and the usage. A run that exits on an
 * error throws, which the canary records as a failure of that question.
 *
 * `agentDir` is a dir the caller readied before the question's clock started (core asks its runtime to ready it once a
 * day). It is required, and this function never readies one: preparing a dir runs pi's catalog synchronously, and a
 * run in the engine's process would freeze every conversation of that process while it does.
 */
export function runCanaryQuestion(opts: { role: string; modelName?: string; prompt: string; timeoutMs: number; agentDir: string }): Promise<CanaryAnswer> {
  if (typeof opts.agentDir !== "string" || !opts.agentDir) {
    return Promise.reject(new Error("role の agent dir を渡されていないので、問いを実行しません（用意は呼び出し側が 1 日 1 回だけ行う）"));
  }
  const role = opts.modelName ? resolveRoleModel(opts.role, opts.modelName) : resolveRole(opts.role);
  // the child is given a moment under the pass's own limit to end by itself; the canary's own wall ends the wait
  return runPiOnce(buildCanaryArgs(role, opts.prompt), { agentDir: opts.agentDir, timeoutMs: Math.max(500, opts.timeoutMs - 500) }).then((run) => {
    if (run.timedOut) throw new Error(`時間の上限（${Math.round(opts.timeoutMs / 1000)} 秒）で止めました`);
    if (run.code !== 0) throw new Error(piExitText(run));
    return parseCanaryOutput(run.stdout);
  });
}
