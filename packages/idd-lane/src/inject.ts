import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTENT_LANE_ENV, INTENT_RECORD_ENV, INTENT_ROLE_ENV, INTENT_STAGE_ENV,
} from "../../idd-core/src/intent/inject.ts";
import { laneHoldToken } from "../../idd-core/src/agent/token.ts";
import { readAgentToken } from "./agent-token.ts";
import { repoRoot } from "./paths.ts";

/**
 * What a stage gets when the injection is attached to it: the pi extension and its `intent_lookup` tool, or the
 * Claude Code settings file, plus the environment its hooks read. The stages are named here, never inferred from
 * a role or a harness (DEC-107-3): a stage nobody named gets nothing, so a new stage is safe by default.
 *
 * The list is the Issue lane's conversations (their injection is decided from the lane they belong to) and the
 * stages that judge the work: the judgement, the PR feedback's, the plan review, and the
 * delivery's own plan run (which has to read the Choices to plan a fix). Blind, final, confirm, the confirm of PR
 * feedback and its leftovers, the device check, the map and the ad-hoc lanes are deliberately absent: a blind's
 * whole point is to read the diff and the rules without the implementer's context (DEC-2641).
 */
const INJECT_STAGES = new Set<string>(["triage", "feedback", "plan_review", "fix_plan"]);

/**
 * The mark an Issue lane's own conversation carries so the extension registers the `ask` tool. Only a reply a
 * supervisor can answer questions for gets it: the one-off judging stages have nobody to put the question to.
 */
export const ASK_ENV = "IDD_ASK";

/**
 * The Issue lane a stage run belongs to, for a command it runs that writes on the lane's behalf (`idd out draft`).
 * `IDD_ID` is not that: it also opens the report and intent doors as the lane, so a run that has no token for them
 * must not carry it. The name is the lane the harness wrote into the spec, never one guessed from the cwd.
 */
export const RUN_LANE_ENV = "IDD_RUN_LANE";

/** the lane a command in this environment is asked for: a conversation's `IDD_ID`, else a stage run's `IDD_RUN_LANE`; none outside a lane */
export function requestingLane(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.IDD_ID?.trim() || env[RUN_LANE_ENV]?.trim() || undefined;
}

/**
 * A stage run's lane in its environment: the spec's own, which a blind has even without an injection. With it goes the
 * credential of this lane alone that `idd hold` presents (derived from the shared token, which the run never gets, as
 * `IDD_ID` is withheld for the same reason): the implementer's `git push` is a stage run, and without the credential
 * the hold door would refuse it. No readable token leaves the run with none, and the door refuses.
 */
export function runLaneEnv(spec: { lane?: string; injectLane?: string } | null): Record<string, string> {
  const lane = spec?.lane ?? spec?.injectLane;
  if (!lane) return {};
  const token = readAgentToken();
  return { [RUN_LANE_ENV]: lane, ...(token ? { [HOLD_TOKEN_ENV]: laneHoldToken(lane, token) } : {}) };
}

/** the credential of one lane for the hold door; a conversation gets it with its `IDD_ID`, a stage run with its `IDD_RUN_LANE` */
export const HOLD_TOKEN_ENV = "IDD_HOLD_TOKEN";

/** the name the plan review carries: it has no `stage` of its own, since that field drives the loop's report reading */
export const PLAN_REVIEW_STAGE = "plan_review";

/** the shape of a spec this needs: only whether the injection is attached and which lane it belongs to */
export interface InjectableSpec {
  stage?: string;
  injectStage?: string;
  injectLane?: string;
}

/** the injection stage of a run, or null when the run gets none */
export function injectionStageOf(spec: InjectableSpec): string | null {
  const stage = spec.injectStage ?? spec.stage;
  return stage && INJECT_STAGES.has(stage) ? stage : null;
}

export function stageGetsInjection(spec: InjectableSpec): boolean {
  return injectionStageOf(spec) !== null;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** the pi extension the injection's bridge lives in, named by its absolute path */
export function intentInjectExtensionPath(): string {
  return join(HERE, "pi-extensions", "intent-inject.ts");
}

/**
 * The CLI a hook calls. The checkout's own wrapper, so a lane runs the code it is standing in rather than whatever
 * `idd` the PATH happens to resolve to. `IDD_INTENT_CLI` is how a test hands in a stand-in.
 */
export function intentCliPath(): string {
  const explicit = process.env.IDD_INTENT_CLI?.trim();
  if (explicit) return explicit;
  const own = join(repoRoot(), "bin", "idd");
  return existsSync(own) ? own : "idd";
}

/** where a run records what it handed over: one append-only file, beside the run's other records */
export function injectionRecordPath(dir: string): string {
  return join(dir, "intent-inject.jsonl");
}

export interface InjectionEnvInput {
  /** the Issue lane the run belongs to: the viewer the lookup names */
  lane?: string;
  stage?: string | null;
  role?: string;
  record: string;
}

/** the environment every hook of a run reads (the lane, stage, role and record file), and the CLI to call */
export function injectionEnv(input: InjectionEnvInput): Record<string, string> {
  return {
    ...(input.lane ? { [INTENT_LANE_ENV]: input.lane } : {}),
    ...(input.stage ? { [INTENT_STAGE_ENV]: input.stage } : {}),
    ...(input.role ? { [INTENT_ROLE_ENV]: input.role } : {}),
    [INTENT_RECORD_ENV]: input.record,
    IDD_INTENT_CLI: intentCliPath(),
  };
}

/**
 * The Claude Code settings a run reads. Only `hooks`, and all of them the Harness's own injection: the run is
 * started with `--setting-sources ""`, so this file is the only hook that reaches it (DEC-107-9 / INV-107-4).
 */
export function claudeInjectSettings(): Record<string, unknown> {
  const command = `${intentCliPath()} intent hook`;
  const hook = { type: "command", command, timeout: 10 };
  return {
    hooks: {
      // a new session is told how to look a Choice up; after a compaction the source is `compact`, which re-opens
      // every body handed over before it
      SessionStart: [{ hooks: [hook] }],
      PostToolUse: [{ matcher: "Read|Bash", hooks: [hook] }],
      PreToolUse: [{ matcher: "Edit|Write|Bash", hooks: [hook] }],
    },
  };
}

/** write the run's settings file and return its path */
export function writeClaudeInjectSettings(dir: string): string {
  const path = join(dir, "claude-settings.json");
  writeFileSync(path, `${JSON.stringify(claudeInjectSettings(), null, 2)}\n`);
  return path;
}
