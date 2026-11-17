import { describe, expect, test } from "bun:test";

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildCanaryArgs, parseCanaryOutput, pipelineCanaryRoles, runCanaryQuestion } from "../src/canary.ts";
import { parseRoles } from "../src/roles.ts";
import { holdPipes, IGNORE_SIGTERM_AND_STAY } from "./helpers/oneshot-scripts.ts";
import { tmpDir } from "./helpers/tmp.ts";

const ROLES = `
models:
  ollama-flash: { model: "ollama-cloud/deepseek-v4.1-flash" }
  openrouter-flash: { model: "openrouter/deepseek/deepseek-v4.1-flash" }
  gpt-6-luna: { model: "openai-codex/gpt-6-luna" }
roles:
  planner-pi: { model: ollama-flash, thinking: high }
  executor-pi: { model: openrouter-flash, thinking: xhigh }
  reviewer-claude: { model: "claude-x", harness: claude, thinking: high }
  unused-pi: { model: gpt-6-luna, thinking: medium }
  extra-only-pi: { model: openrouter-flash, thinking: medium }
pipeline:
  planner: { role: planner-pi, concurrency: 2 }
  executor: { role: executor-pi, concurrency: 2 }
  review_blind: { roles: [executor-pi, reviewer-claude] }
  review_blind_high: { roles: [reviewer-claude], high_risk_extra: [extra-only-pi] }
`;

describe("canary roles", () => {
  test("the canary watches the pipeline's pi roles, never a Claude role and never a role no slot uses", () => {
    const roles = pipelineCanaryRoles(parseRoles(ROLES));
    expect(roles.map((r) => r.role)).toEqual(["executor-pi", "extra-only-pi", "planner-pi"]);
    // the role's model and thinking are the ones a lane would run it on
    expect(roles.find((r) => r.role === "executor-pi")).toEqual({
      role: "executor-pi",
      model: "openrouter/deepseek/deepseek-v4.1-flash",
      modelName: "openrouter-flash",
      thinking: "xhigh",
    });
  });

  test("a role reached only through a slot's extra list is watched too", () => {
    const roles = pipelineCanaryRoles(parseRoles(ROLES));
    expect(roles.map((r) => r.role)).toContain("extra-only-pi");
  });

  test("a role run twice by the pipeline is asked once", () => {
    const roles = pipelineCanaryRoles(parseRoles(ROLES));
    expect(roles.filter((r) => r.role === "executor-pi")).toHaveLength(1);
  });
});

describe("canary question", () => {
  test("it runs the role's model and thinking with no tools and no session", () => {
    const role = parseRoles(ROLES).roles["executor-pi"];
    const args = buildCanaryArgs(role, "指示");
    expect(args).toContain("--no-tools");
    expect(args).toContain("--no-session");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-skills");
    expect(args[args.indexOf("--model") + 1]).toBe("openrouter/deepseek/deepseek-v4.1-flash");
    expect(args[args.indexOf("--thinking") + 1]).toBe("xhigh");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("");
    expect(args[args.length - 1]).toBe("指示");
  });

  test("the answer and its usage are read from the run's own message_end", () => {
    const stdout = [
      JSON.stringify({ type: "message_end", message: { role: "user", content: "指示" } }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "答え" }, { type: "thinking", text: "考え" }],
          usage: { input: 591, output: 13, cacheRead: 0, cacheWrite: 0, cost: { total: 0.000096 } },
        },
      }),
    ].join("\n");
    expect(parseCanaryOutput(stdout)).toEqual({
      text: "答え",
      usd: 0.000096,
      tokens: { input: 591, output: 13, cacheRead: 0, cacheWrite: 0 },
    });
  });

  test("a run that wrote no answer reads as an empty text, not a crash", () => {
    expect(parseCanaryOutput("")).toEqual({ text: "", usd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(parseCanaryOutput('{"type":"agent_start"}').text).toBe("");
  });
});

/** a one-shot stand-in for pi: it knows the model's name and answers one question with a usage line */
function standIn(answer = "答え", ms = 0): string {
  const dir = tmpDir("canary-pi-");
  const file = join(dir, "pi");
  writeFileSync(file, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--list-models")) { console.log("openrouter deepseek/deepseek-v4.1-flash"); process.exit(0); }
setTimeout(() => {
  console.log(JSON.stringify({ type: "session", version: 3, id: "oneshot", timestamp: new Date().toISOString(), cwd: process.cwd() }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(answer)} }], usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0002 } } } }));
  process.exit(0);
}, ${ms});
`);
  chmodSync(file, 0o755);
  return file;
}

/** the environment one question needs: its own state, roles file and pi */
function withCanaryEnv(pi: string) {
  const root = tmpDir("canary-env-");
  const state = join(root, "state");
  const agent = join(root, "agent");
  mkdirSync(state, { recursive: true });
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(root, "roles.yaml"), [
    "models:",
    "  openrouter-deepseek-deepseek-v4.1-flash:",
    "    model: openrouter/deepseek/deepseek-v4.1-flash",
    "roles:",
    "  executor: { model: openrouter-deepseek-deepseek-v4.1-flash, thinking: high }",
    "pipeline:",
    "  executor: { role: executor }",
    "",
  ].join("\n"));
  const before = { ...process.env };
  process.env.IDD_PI_BIN = pi;
  process.env.IDD_STATE_DIR = state;
  process.env.IDD_ROLES_FILE = join(root, "roles.yaml");
  process.env.IDD_PI_USER_AGENT_DIR = agent;
  return () => {
    for (const key of ["IDD_PI_BIN", "IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_PI_USER_AGENT_DIR"] as const) {
      const value = before[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** a one-shot stand-in that answers with the agent dir its pi was run in */
function agentDirStandIn(): string {
  const dir = tmpDir("canary-pi-dir-");
  const file = join(dir, "pi");
  writeFileSync(file, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--list-models")) { console.log("openrouter deepseek/deepseek-v4.1-flash"); process.exit(0); }
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: String(process.env.PI_CODING_AGENT_DIR || "") }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }));
process.exit(0);
`);
  chmodSync(file, 0o755);
  return file;
}

/** a stand-in that runs `head`, writes one answer line, then runs `tail` */
function answeringPi(head: string, text: string, tail: string): string {
  const file = join(tmpDir("canary-pi-answering-"), "pi");
  const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0002 } } } });
  writeFileSync(file, `#!/usr/bin/env node\n${head}\nconsole.log(${JSON.stringify(line)});\n${tail}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** asks the canary question with this pi, in its own environment */
async function askCanary(pi: string, timeoutMs: number) {
  const restore = withCanaryEnv(pi);
  const readied = join(tmpDir("canary-readied-"), "executor");
  mkdirSync(readied, { recursive: true });
  try {
    return await runCanaryQuestion({ role: "executor", prompt: "指示", timeoutMs, agentDir: readied });
  } finally {
    restore();
  }
}

describe("canary one shot", () => {
  test("it runs the role's model with no session and reads the answer's usage", async () => {
    const restore = withCanaryEnv(standIn("3 つの関数があります。"));
    const readied = join(tmpDir("canary-readied-"), "executor");
    mkdirSync(readied, { recursive: true });
    try {
      const answer = await runCanaryQuestion({ role: "executor", prompt: "指示", timeoutMs: 20_000, agentDir: readied });
      expect(answer.text).toBe("3 つの関数があります。");
      expect(answer.usd).toBe(0.0002);
      expect(answer.tokens).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
    } finally {
      restore();
    }
  }, 30_000);

  test("the run uses the dir the caller readied and never readies one itself", async () => {
    const restore = withCanaryEnv(agentDirStandIn());
    // a user dir whose models.json cannot be read: readying a dir here would throw before the question is asked
    const broken = tmpDir("canary-broken-user-");
    writeFileSync(join(broken, "models.json"), "{ not json");
    process.env.IDD_PI_USER_AGENT_DIR = broken;
    try {
      // no dir handed (the field is required, and an empty one is refused at run time): the question is not run at all
      await expect(runCanaryQuestion({ role: "executor", prompt: "指示", timeoutMs: 20_000, agentDir: "" })).rejects.toThrow(/agent dir/);
      const readied = join(tmpDir("canary-readied-"), "executor");
      mkdirSync(readied, { recursive: true });
      const answer = await runCanaryQuestion({ role: "executor", prompt: "指示", timeoutMs: 20_000, agentDir: readied });
      expect(answer.text).toBe(readied);
    } finally {
      restore();
    }
  }, 30_000);

  test("a run that answers and exits is read as answered while a grandchild still holds the pipes open", async () => {
    const started = Date.now();
    const answer = await askCanary(answeringPi(holdPipes(), "孫がいる答え", "process.exit(0);"), 20_000);
    expect(answer.text).toBe("孫がいる答え");
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 30_000);

  test("a run that wrote an answer and then outlasts its limit is still a failure, and the partial answer is not used", async () => {
    await expect(askCanary(answeringPi("", "途中の答え", IGNORE_SIGTERM_AND_STAY), 1_500)).rejects.toThrow(/時間の上限/);
  }, 30_000);

  test("a run that outlasts its limit is stopped and reported as a failure", async () => {
    const restore = withCanaryEnv(standIn("遅い答え", 10_000));
    const readied = join(tmpDir("canary-readied-"), "executor");
    mkdirSync(readied, { recursive: true });
    try {
      await expect(runCanaryQuestion({ role: "executor", prompt: "指示", timeoutMs: 1_500, agentDir: readied })).rejects.toThrow(/時間の上限/);
    } finally {
      restore();
    }
  }, 30_000);
});
