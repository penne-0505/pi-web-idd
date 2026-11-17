import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ROUTER_PROMPT_BYTES_MAX, buildRouterArgs, buildRouterPrompt, parseRouterOutput, QUESTION_ROUTING_SLOT, questionRoutingRole, runQuestionRouter } from "../src/question-routing.ts";
import { RouteFailed } from "../../idd-core/src/agent/question-routing.ts";
import { parseRoles } from "../src/roles.ts";
import { holdPipes } from "./helpers/oneshot-scripts.ts";
import { tmpDir } from "./helpers/tmp.ts";

const BASE = `
models:
  flash: { model: "openrouter/deepseek/deepseek-v4.1-flash" }
roles:
  planner-pi: { model: flash, thinking: high }
  question-router: { model: flash, thinking: high, report: free, budget_minutes: 5 }
pipeline:
  planner: { role: planner-pi, concurrency: 2 }
`;

/** run `fn` with IDD_ROLES_FILE (and any other variable given) set to the test's own values */
function withEnv(env: Record<string, string>, fn: () => unknown) {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const restore = () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function rolesFile(text: string): string {
  const file = join(tmpDir("idd-qrouting-"), "roles.yaml");
  writeFileSync(file, text);
  return file;
}

const call = {
  lane: "IDD-1",
  batch: {
    idd_id: "IDD-1", batch_id: "B-1", asked_at: "2026-10-27T00:00:00Z",
    questions: [{ question_id: "q1", question: "どちらにしますか", context: "", options: [{ index: 1, label: "案 A" }, { index: 2, label: "案 B", description: "説明" }] }],
  },
  material: { choices: [{ id: "C-1-1", chosen: "選んだ形", why: "なぜなら", anchored: "守る", free: "" }], issue: "Issue の本文", worktree: "/tmp/secret-wt" },
};

describe("question routing setting", () => {
  test("AC-005: a roles.yaml without the key routes nothing", () => {
    withEnv({ IDD_ROLES_FILE: rolesFile(BASE) }, () => expect(questionRoutingRole()).toBeNull());
  });

  test("the key names the role and the model that judge", () => {
    withEnv({ IDD_ROLES_FILE: rolesFile(`${BASE}  ${QUESTION_ROUTING_SLOT}: { role: question-router }\n`) }, () => {
      expect(questionRoutingRole()).toEqual({ role: "question-router", model: "openrouter/deepseek/deepseek-v4.1-flash" });
    });
  });

  test("the shipped example settings define the role, read-only and clean, with the time in the role", () => {
    const parsed = parseRoles(readFileSync("config/roles.example.yaml", "utf8"));
    const role = parsed.roles["question-router"];
    expect(role).toBeDefined();
    expect(role.thinking).toBe("high");
    expect(role.budgetMinutes).toBe(5);
    expect(role.requireClean).toBe(true);
    expect(parsed.pipeline[QUESTION_ROUTING_SLOT]?.role).toBe("question-router");
  });
});

const PROMPT = buildRouterPrompt(call as never);

describe("the judge's call", () => {
  test("the run reads and searches only: no tool that writes or runs a command", () => {
    const args = buildRouterArgs({ model: "x/y", thinking: "high" } as never, "PROMPT");
    const tools = args[args.indexOf("--tools") + 1]!.split(",");
    expect(tools.sort()).toEqual(["find", "grep", "ls", "read"]);
    expect(args).toContain("--no-session");
    expect(args.at(-1)).toBe("PROMPT");
  });

  test("the prompt carries the questions, the Choices, the Issue and the closed kinds, and keeps the worktree path out of it", () => {
    for (const word of ["どちらにしますか", "案 B", "C-1-1", "Issue の本文", "signature", "irreversible", "against_decision", "settled", "_docs/standards/"]) expect(PROMPT).toContain(word);
    expect(PROMPT).not.toContain("/tmp/secret-wt");
  });

  test("the prompt names no source the engine does not check: a policy or the code is no evidence", () => {
    expect(PROMPT).toContain("choice / issue / norm");
    expect(PROMPT).not.toMatch(/policy|利用者の方針/);
  });

  test("the prompt tells the judge to send what may be a kind a person keeps, or what it doubts, to a person", () => {
    expect(PROMPT).toContain("迷うときも human にする");
    expect(PROMPT).toContain("settled 以外の kind の質問は、材料が答えを決めていても human にする");
  });

  test("the prompt's example answers with an option index the question has, and says to copy the index", () => {
    expect(PROMPT).toContain('"option_index":1');
    expect(PROMPT).not.toContain('"option_index":0');
    expect(PROMPT).toContain("questions[].options[].index の値をそのまま写す");
  });
});

/** the JSONL a `--mode json` run writes: one assistant turn per usage, the last one saying `text` */
function jsonRun(text: string, usages: Record<string, unknown>[] = []): string {
  const turns = usages.slice(0, -1).map((usage) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }], usage } }));
  turns.push({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: usages.length ? usages[usages.length - 1] : undefined } } as never);
  return `${[{ type: "agent_start" }, { type: "message_end", message: { role: "user", content: "x" } }, ...turns].map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/** a pi that records how it was started and says `reply` (or fails with `exit`) */
function fakePi(opts: { reply?: string; exit?: number; stdout?: string } = {}) {
  const dir = tmpDir("idd-qrouting-pi-");
  if (opts.stdout !== undefined) writeFileSync(join(dir, "out.jsonl"), opts.stdout);
  const log = join(dir, "started.json");
  const bin = join(dir, "pi");
  writeFileSync(bin, `#!/usr/bin/env bash
printf '{"cwd":"%s","root":"%s","args":%s}' "$PWD" "$IDD_READ_ROOT" "$(printf '%s\\n' "$@" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().split("\\n")))')" > "${log}"
${opts.exit ? `${opts.stdout !== undefined ? `cat "${dir}/out.jsonl"; ` : ""}echo "boom" >&2; exit ${opts.exit}` : `${opts.stdout !== undefined ? `cat "${dir}/out.jsonl"` : `printf '%s' '${opts.reply ?? "{}"}'`}`}
`);
  chmodSync(bin, 0o755);
  return { bin, started: () => JSON.parse(readFileSync(log, "utf8")) as { cwd: string; root: string; args: string[] } };
}

describe("one shot of the judge in a child process", () => {
  const roles = () => rolesFile(`${BASE}  ${QUESTION_ROUTING_SLOT}: { role: question-router }\n`);
  /** one run of the judge with `pi` as the binary, in a worktree of its own unless the material says otherwise */
  const runWith = (pi: string, material: Record<string, unknown> = {}) =>
    withEnv({ IDD_ROLES_FILE: roles(), IDD_PI_BIN: pi }, () =>
      runQuestionRouter({ ...call, material: { ...call.material, worktree: tmpDir("idd-qrouting-wt-"), ...material } } as never, tmpDir("idd-qrouting-agent-"))) as Promise<Awaited<ReturnType<typeof runQuestionRouter>>>;

  test("it starts in the lane's worktree with the path guard's root there, and returns the judge's text with the role and model", async () => {
    const worktree = tmpDir("idd-qrouting-wt-");
    const pi = fakePi({ stdout: jsonRun('{"answers":[]}') });
    const out = await runWith(pi.bin, { worktree });
    expect(out).toEqual({ text: '{"answers":[]}', role: "question-router", model: "openrouter/deepseek/deepseek-v4.1-flash" });
    const started = pi.started();
    expect(started.root).toBe(worktree);
    expect(started.cwd).toBe(worktree);
    expect(started.args.join(" ")).toContain("--tools read,grep,find,ls");
  });

  test("the run's usage is read from every turn and returned for the engine to record", async () => {
    const pi = fakePi({ stdout: jsonRun("done", [{ input: 100, output: 10, cacheRead: 5, cost: { total: 0.01 } }, { input: 200, output: 20, cacheWrite: 7, cost: { total: 0.02 } }]) });
    const out = await runWith(pi.bin);
    expect(out.text).toBe("done");
    expect(out.usage).toMatchObject({ input: 300, output: 30, cacheRead: 5, cacheWrite: 7 });
    expect(out.usage!.cost as number).toBeCloseTo(0.03);
  });

  test("a run that reports no usage returns none, and a line that is not JSON is skipped", () => {
    expect(parseRouterOutput('not json\n{"type":"message_end","message":{"role":"assistant","content":"x"}}\n')).toEqual({ text: "x" });
    expect(parseRouterOutput("")).toEqual({ text: "" });
  });

  test("it asks pi for JSON events so the run's usage is there to be counted", () => {
    expect(buildRouterArgs({ model: "x/y", thinking: "high" } as never, "P").join(" ")).toContain("--mode json");
  });

  test("AC-005: a judge that exits with an error is a failure core leaves to a person", async () => {
    const pi = fakePi({ exit: 3 });
    await expect(runWith(pi.bin)).rejects.toThrow(/exit 3/);
  });

  test("a judge that answers and exits is read as answered while a grandchild still holds the pipes open", async () => {
    const dir = tmpDir("idd-qrouting-gc-");
    const bin = join(dir, "pi");
    const line = jsonRun('{"answers":[]}', [{ input: 10, output: 2, cost: { total: 0.001 } }]);
    writeFileSync(bin, `#!/usr/bin/env node
${holdPipes()}
process.stdout.write(${JSON.stringify(line)});
process.exit(0);
`);
    chmodSync(bin, 0o755);
    const started = Date.now();
    const out = await runWith(bin);
    expect(out.text).toBe('{"answers":[]}');
    expect(out.usage).toMatchObject({ input: 10, output: 2 });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a judge that exits with an error after spending carries its usage on the failure, and one that spent nothing carries none", async () => {
    const spent = fakePi({ exit: 1, stdout: jsonRun("", [{ input: 400, output: 40, cost: { total: 0.02 } }]) });
    const err = await runWith(spent.bin).catch((e) => e);
    expect(err).toBeInstanceOf(RouteFailed);
    expect(err.partial.usage).toMatchObject({ input: 400, output: 40, cost: 0.02 });
    expect(err.partial.role).toBe("question-router");
    const bare = await runWith(fakePi({ exit: 3 }).bin).catch((e) => e);
    expect(bare).toBeInstanceOf(RouteFailed);
    expect(bare.partial).toBeUndefined();
  });

  test("AC-005: a prompt too large for the command line is not started, and the batch goes to a person", async () => {
    const pi = fakePi({ reply: "{}" });
    await expect(runWith(pi.bin, { issue: "あ".repeat(ROUTER_PROMPT_BYTES_MAX) })).rejects.toThrow(/大きすぎ/);
  });

  test("AC-005: a judge that cannot be started is a failure", async () => {
    await expect(runWith("/nonexistent/pi")).rejects.toThrow();
  });

  test("AC-005: without the key the judge is not started", async () => {
    await expect(withEnv({ IDD_ROLES_FILE: rolesFile(BASE) }, () => runQuestionRouter(call as never, tmpDir("idd-qrouting-agent-")))).rejects.toThrow(/question_routing/);
  });
});
