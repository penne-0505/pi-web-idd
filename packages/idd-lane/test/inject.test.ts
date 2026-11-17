import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { claudeInjectSettings, intentCliPath, intentInjectExtensionPath, injectionStageOf, stageGetsInjection, PLAN_REVIEW_STAGE } from "../src/inject.ts";
import { writePlanReviewSpec } from "../src/plan-review.ts";
import { executeLane, laneDir, prepareLane } from "../src/runner.ts";
import { conversationArgs, piConversationArgs, piConversationEnv } from "../src/conversation.ts";
import type { LaneRecord } from "../src/runner.ts";
import { tmpDir } from "./helpers/tmp.ts";

const EXTENSION = intentInjectExtensionPath();

const TOUCHED = ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_REPOS_FILE", "IDD_LANE_ROOT", "IDD_LANE_SCOPE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR", "IDD_CLAUDE_BIN", "IDD_INTENT_CLI", "IDD_TEST_ARGS", "IDD_TEST_ENV"];
afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
});

interface Fixture {
  root: string;
  wt: string;
  head: string;
  cfg: string;
  args: string;
  env: string;
}

/**
 * A lane fixture: a git worktree, a roles file, and a harness stand-in that writes its own argv and environment
 * to files, so a dry-run's arguments and a run's environment can both be read back.
 */
function fixture(roles: string): Fixture {
  const root = tmpDir("idd-inject-");
  const wt = join(root, "wt");
  mkdirSync(wt);
  execFileSync("git", ["init", "-q", wt]);
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: wt });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
  const cfg = join(root, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, ".credentials.json"), "{}");
  writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${cfg}\n${roles}`);
  writeFileSync(join(root, "repos.yaml"), "repos:\n");
  const args = join(root, "argv.txt");
  const envOut = join(root, "env.txt");
  // the harness stand-in: the model catalog answer (`pi --offline --list-models`) keeps the role startable, and
  // the run's own arguments and environment are written out for the test to read
  const dump = `#!/bin/sh\nif [ "$1" = "--offline" ]; then echo "openrouter z-ai/glm-5.3"; exit 0; fi\nprintf '%s\\n' "$@" > "$IDD_TEST_ARGS"\nenv > "$IDD_TEST_ENV"\nexit 0\n`;
  const fakePi = join(root, "pi");
  writeFileSync(fakePi, dump);
  chmodSync(fakePi, 0o755);
  const fakeClaude = join(root, "claude");
  writeFileSync(fakeClaude, dump);
  chmodSync(fakeClaude, 0o755);
  Object.assign(process.env, {
    IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"),
    IDD_LANE_ROOT: root, IDD_LANE_SCOPE: "off", IDD_PI_BIN: fakePi, IDD_CLAUDE_BIN: fakeClaude,
    IDD_PI_USER_AGENT_DIR: join(root, "agent"), IDD_TEST_ARGS: args, IDD_TEST_ENV: envOut,
    IDD_INTENT_CLI: join(root, "bin", "idd"),
  });
  // the lane this test runs in has a report lane of its own: a run must not inherit it as an added variable
  delete process.env.IDD_ID;
  delete process.env.IDD_AGENT_TOKEN;
  return { root, wt, head, cfg, args, env: envOut };
}

function specFile(fx: Fixture, body: string): string {
  const path = join(fx.root, "spec.yaml");
  writeFileSync(path, body);
  return path;
}

/** the arguments a run was prepared with, and the environment it was started with */
function argsOf(rec: LaneRecord): string[] {
  return JSON.parse(readFileSync(join(laneDir(rec.id), "pi-args.json"), "utf8")) as string[];
}

function envOf(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(process.env.IDD_TEST_ENV as string, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** prepare a pi run and start it, so its environment is dumped */
async function runningPiEnv(fx: Fixture, body: string): Promise<{ rec: LaneRecord; args: string[]; env: Record<string, string> }> {
  const path = specFile(fx, body);
  const { rec } = prepareLane(path);
  const args = argsOf(rec);
  const done = await executeLane(rec.id);
  return { rec: done, args, env: envOf() };
}

const PI_ROLES = "models:\n  openrouter-z-ai-glm-5.3:\n    model: openrouter/z-ai/glm-5.3\nroles:\n  pi-r:\n    model: openrouter-z-ai-glm-5.3\n    tools: [read, bash]\n    report: review\n";
const CLAUDE_ROLES = "roles:\n  cl-r:\n    harness: claude\n    model: opus\n    tools: [read, bash]\n    report: review\n";

describe("the injection's stage list", () => {
  test("AC-019/AC-021: only the named stages are attached, and a new or unnamed stage is not", () => {
    for (const stage of ["triage", "feedback", "fix_plan"]) expect(stageGetsInjection({ stage })).toBe(true);
    expect(injectionStageOf({ injectStage: PLAN_REVIEW_STAGE })).toBe(PLAN_REVIEW_STAGE);
    // r2 was removed with R2 (2026-10-22): a spec that still names it gets nothing, like any unnamed stage
    for (const stage of ["blind", "final", "confirm", "feedback_confirm", "feedback_leftovers", "device", "map", "r2", "shape", "unknown_stage"]) {
      expect(stageGetsInjection({ stage })).toBe(false);
    }
    expect(stageGetsInjection({})).toBe(false);
  });
});

describe("a pi run", () => {
  test("AC-019: a named stage keeps --no-extensions and names the Harness's extension, with intent_lookup", async () => {
    const fx = fixture(PI_ROLES);
    const { rec, args, env } = await runningPiEnv(fx, `role: pi-r\nstage: triage\ninject_lane: IDD-1\nworktree: ${fx.wt}\nreport: ${join(fx.root, "out", "report")}\ntask: t\n`);
    void rec;
    expect(args).toContain("--no-extensions");
    expect(args[args.indexOf("--extension") + 1]).toBe(EXTENSION);
    const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
    expect(tools).toContain("intent_lookup");
    expect(tools).toContain("read");
    expect(env.IDD_INTENT_LANE).toBe("IDD-1");
    expect(env.IDD_INTENT_STAGE).toBe("triage");
    expect(env.IDD_INTENT_ROLE).toBe("pi-r");
    expect(env.IDD_INTENT_RECORD).toBe(join(laneDir(rec.id), "intent-inject.jsonl"));
    // and the report lane's own variables are not added (DEC-1202)
    expect(env.IDD_ID).toBeUndefined();
    expect(env.IDD_AGENT_TOKEN).toBeUndefined();
    // a judging stage gets no ask tool: there is no supervisor to answer a question for it (DEC-111-7)
    expect(env.IDD_ASK).toBeUndefined();
  });

  test("AC-021: a stage the list does not name gets no extension, no tool and no injection environment", async () => {
    const fx = fixture(PI_ROLES);
    const { args, env } = await runningPiEnv(fx, `role: pi-r\nstage: blind\ninject_lane: IDD-1\nworktree: ${fx.wt}\nreport: ${join(fx.root, "out", "report")}\ntask: t\n`);
    expect(args).not.toContain("--extension");
    expect(args[args.indexOf("--tools") + 1]).not.toContain("intent_lookup");
    expect(env.IDD_INTENT_LANE).toBeUndefined();
    expect(env.IDD_INTENT_RECORD).toBeUndefined();
  });

  test("AC-019: the plan review and R2 stages are attached", async () => {
    const fx = fixture(PI_ROLES);
    writeFileSync(join(fx.wt, "plan.md"), "# plan\n");
    // the plan review has no `stage` of its own: the injection names its own, and the lane it belongs to
    const { specPath } = writePlanReviewSpec({ iddId: "IDD-7", worktree: fx.wt, inputs: ["plan.md"], role: "pi-r" });
    const specText = readFileSync(specPath, "utf8");
    expect(specText).toContain("inject_stage: plan_review");
    expect(specText).toContain("inject_lane: IDD-7");
    const plan = prepareLane(specPath, { dryRun: true });
    expect(argsOf(plan.rec)).toContain("--extension");
    const judge = prepareLane(specFile(fx, `role: pi-r\nstage: triage\ninject_lane: IDD-7\nworktree: ${fx.wt}\nreport: ${join(fx.root, "out", "triage")}\ntask: t\n`), { dryRun: true });
    expect(argsOf(judge.rec)).toContain("--extension");
  });
});

describe("a Claude Code run", () => {
  test("AC-020/AC-022: a named stage gets a settings file of hooks only, and keeps its isolation", async () => {
    const fx = fixture(CLAUDE_ROLES);
    const { rec } = prepareLane(specFile(fx, `role: cl-r\nstage: triage\ninject_lane: IDD-2\nworktree: ${fx.wt}\nreport: ${join(fx.root, "out", "report")}\ntask: t\n`));
    const args = argsOf(rec);
    const settings = join(laneDir(rec.id), "claude-settings.json");
    expect(args[args.indexOf("--settings") + 1]).toBe(settings);
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(existsSync(settings)).toBe(true);
    // the file holds nothing but hooks, and every hook is the Harness's injection verb
    const written = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(["hooks"]);
    const hooks = written.hooks as Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "SessionStart"]);
    for (const entry of Object.values(hooks)) for (const h of entry) expect(h.hooks[0].command.endsWith("intent hook")).toBe(true);
    expect(hooks.PostToolUse[0].matcher).toBe("Read|Bash");
    expect(hooks.PreToolUse[0].matcher).toBe("Edit|Write|Bash");
    // the run's hooks name their lane, stage and record
    const done = await executeLane(rec.id);
    void done;
    const env = envOf();
    expect(env.IDD_INTENT_LANE).toBe("IDD-2");
    expect(env.IDD_INTENT_STAGE).toBe("triage");
    expect(env.IDD_INTENT_RECORD).toBe(join(laneDir(rec.id), "intent-inject.jsonl"));
    expect(env.IDD_ID).toBeUndefined();
  });

  test("AC-021: an unnamed stage writes no settings file and leaves the arguments as they were", () => {
    const fx = fixture(CLAUDE_ROLES);
    const { rec } = prepareLane(specFile(fx, `role: cl-r\nstage: confirm\ninject_lane: IDD-2\nworktree: ${fx.wt}\nreport: ${join(fx.root, "out", "report")}\ntask: t\n`));
    expect(argsOf(rec)).not.toContain("--settings");
    expect(existsSync(join(laneDir(rec.id), "claude-settings.json"))).toBe(false);
  });

  test("AC-020: a conversation reply's settings file rides the same way", () => {
    const fx = fixture(CLAUDE_ROLES);
    const role = { name: "cl-r", harness: "claude" as const, model: "opus", thinking: "high", tools: ["read"], policy: [], report: "review" as const, requireClean: true, budgetMinutes: 1, contextFiles: true, maxResumes: 0 };
    const settings = join(fx.root, "claude-settings.json");
    const args = conversationArgs(role, "session-1", false, settings);
    expect(args[args.indexOf("--settings") + 1]).toBe(settings);
    expect(conversationArgs(role, "session-1", false)).not.toContain("--settings");
  });
});

describe("a pi conversation", () => {
  test("AC-023: an Issue lane's conversation runs in rpc mode with exactly the extension flag and its path added", () => {
    const role = { name: "planner-pi", harness: "pi" as const, model: "openrouter/z-ai/glm-5.3", thinking: "high", tools: ["read"], policy: [], report: "free" as const, requireClean: false, budgetMinutes: 1, contextFiles: true, maxResumes: 0 };
    const base = { id: "L1", role: "planner-pi", model: "openrouter/z-ai/glm-5.3", worktree: "/wt", spec: "", report: "", status: "idle" as const, started_at: "x", role_preset: role, session_file: "s" };
    const withoutLane = piConversationArgs({ ...base, slot: "planner" } as LaneRecord, "s", []);
    const withLane = piConversationArgs({ ...base, slot: "planner", idd_id: "IDD-3" } as LaneRecord, "s", []);
    expect(withoutLane).not.toContain("--extension");
    expect(withLane.filter((a) => a === "--extension").length).toBe(1);
    expect(withLane[withLane.indexOf("--extension") + 1]).toBe(EXTENSION);
    // removing the one flag and its path gives back the arguments the conversation had before
    const at = withLane.indexOf("--extension");
    const stripped = [...withLane.slice(0, at), ...withLane.slice(at + 2)];
    expect(stripped).toEqual(withoutLane);
    for (const args of [withoutLane, withLane]) {
      expect(args[args.indexOf("--mode") + 1]).toBe("rpc");
      // the message goes as an rpc prompt, so neither -p nor an @file argument is here
      expect(args).not.toContain("-p");
      expect(args.some((a) => a.startsWith("@"))).toBe(false);
      expect(args).toContain("--model");
      expect(args).toContain("--thinking");
      expect(args).not.toContain("--tools");
      expect(args).not.toContain("--no-extensions");
    }
  });

  test("INV-111-6: the ask mark is on an Issue lane's conversation reply only", () => {
    fixture(PI_ROLES);
    const role = { name: "planner-pi", harness: "pi" as const, model: "openrouter/z-ai/glm-5.3", thinking: "high", tools: ["read"], policy: [], report: "free" as const, requireClean: false, budgetMinutes: 1, contextFiles: true, maxResumes: 0 };
    const base = { id: "L1", role: "planner-pi", model: "openrouter/z-ai/glm-5.3", worktree: "/wt", spec: "", report: "", status: "idle" as const, started_at: "x", role_preset: role, session_file: "s" };
    expect(piConversationEnv({ ...base, slot: "planner" } as LaneRecord, role).IDD_ASK).toBeUndefined();
    expect(piConversationEnv({ ...base, slot: "planner", idd_id: "IDD-3" } as LaneRecord, role).IDD_ASK).toBe("1");
  });
});

describe("the settings and CLI choice", () => {
  test("AC-022: the settings hold hooks only, all of them the injection verb", () => {
    process.env.IDD_INTENT_CLI = "/somewhere/idd";
    const settings = claudeInjectSettings();
    expect(Object.keys(settings)).toEqual(["hooks"]);
    expect(intentCliPath()).toBe("/somewhere/idd");
    const commands = JSON.stringify(settings).match(/intent hook/g) ?? [];
    expect(commands.length).toBe(3);
  });

  test("the extension path is the bridge's own file", () => {
    expect(resolve(EXTENSION).endsWith(join("idd-lane", "src", "pi-extensions", "intent-inject.ts"))).toBe(true);
    expect(existsSync(EXTENSION)).toBe(true);
  });
});
