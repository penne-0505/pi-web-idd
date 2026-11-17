import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canaryAgentDir, createOutbound, discardOutbound, readOutbound } from "@idd/lane";
import { getAgentRunner, setAgentRunner } from "../../idd-core/src/agent/port.ts";
import { GET } from "../src/routes/state.ts";
import { ensureAgentRunner } from "../src/server/agent-runner.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

/**
 * The canary's questions reach the engine's runner, and the runner never readies a role's agent dir in its own
 * process: the preparation runs pi's catalog synchronously (and can fetch a gateway's price list), which would
 * freeze the event loop and every conversation with it.
 */

const ROOT = tmpDir("canary-runner-");
const ENV_KEYS = ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_MODES_FILE", "IDD_REPOS_FILE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR", "FAKE_PI_LIST_MODELS_MS"] as const;
const SAVED = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

/** a stand-in for pi: it answers `--list-models` after `FAKE_PI_LIST_MODELS_MS`, and one question with its agent dir */
const FAKE_PI = `#!/usr/bin/env node
const args = process.argv.slice(2);
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes("--list-models")) {
  const ms = Number(process.env.FAKE_PI_LIST_MODELS_MS || "0");
  const parts = String(at("--list-models") || "").split("/");
  setTimeout(() => { process.stdout.write(parts[0] + " " + parts.slice(1).join("/") + "\\n"); process.exit(0); }, ms);
} else if (args.includes("-p") || args.includes("--print")) {
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: String(process.env.PI_CODING_AGENT_DIR || "") }], usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } } } }) + "\\n");
  process.exit(0);
} else {
  process.exit(1);
}
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** a state of its own, the pipeline roles the runner resolves, and the stand-in pi */
function setup(): { userAgent: string } {
  const root = join(ROOT, `run-${Math.random().toString(36).slice(2)}`);
  const state = join(root, "state");
  const userAgent = join(root, "user-agent");
  for (const dir of [state, userAgent]) mkdirSync(dir, { recursive: true });
  const pi = join(root, "pi");
  writeFileSync(pi, FAKE_PI);
  chmodSync(pi, 0o755);
  writeFileSync(join(root, "roles.yaml"), [
    "models:",
    "  openrouter-z-ai-glm-5.3:",
    "    model: openrouter/z-ai/glm-5.3",
    "roles:",
    "  chat: { model: openrouter-z-ai-glm-5.3, thinking: high }",
    "pipeline:",
    "  planner: { role: chat }",
    "",
  ].join("\n"));
  writeFileSync(join(root, "modes.yaml"), `modes:\n  chat: { role: chat, workspace: ${join(root, "chat")} }\n`);
  writeFileSync(join(root, "repos.yaml"), "repos: {}\n");
  Object.assign(process.env, {
    IDD_STATE_DIR: state,
    IDD_ROLES_FILE: join(root, "roles.yaml"),
    IDD_MODES_FILE: join(root, "modes.yaml"),
    IDD_REPOS_FILE: join(root, "repos.yaml"),
    IDD_PI_BIN: pi,
    IDD_PI_USER_AGENT_DIR: userAgent,
    FAKE_PI_LIST_MODELS_MS: "0",
  });
  return { userAgent };
}

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = SAVED[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setAgentRunner(null);
  rmSync(ROOT, { recursive: true, force: true });
});

describe("the engine's canary runner", () => {
  test("readies a role's agent dir in a child, so the loop answers another door while it does", async () => {
    setup();
    ensureAgentRunner();
    process.env.FAKE_PI_LIST_MODELS_MS = "3000";
    let beats = 0;
    const beat = setInterval(() => { beats += 1; }, 100);
    try {
      const preparing = getAgentRunner()!.canaryPrepare!({ role: "chat" });
      await sleep(400);
      const t0 = Date.now();
      const state = await GET(new Request("http://127.0.0.1/api/idd/state"));
      const elapsed = Date.now() - t0;
      expect(state.status).toBe(200);
      expect(elapsed).toBeLessThan(1000);
      await preparing;
      expect(beats).toBeGreaterThan(5);
    } finally {
      clearInterval(beat);
      process.env.FAKE_PI_LIST_MODELS_MS = "0";
    }
  }, 30_000);

  test("a question uses the readied dir and readies nothing itself", async () => {
    const { userAgent } = setup();
    ensureAgentRunner();
    // a user dir whose models.json cannot be read: readying it here would throw before any question is asked
    writeFileSync(join(userAgent, "models.json"), "{ not json");
    const answer = await getAgentRunner()!.canaryRun!({
      role: "chat",
      model: "openrouter/z-ai/glm-5.3",
      thinking: "high",
      task: { id: "read-one", kind: "read", prompt: "指示" },
      timeoutMs: 20_000,
    });
    expect(answer.text).toBe(canaryAgentDir("chat"));
  }, 30_000);

  test("lists the follow-up Issue drafts of one lane, read only, leaving out the discarded and other lanes' and other kinds'", async () => {
    setup();
    ensureAgentRunner();
    const issue = (title: string, body: string, lane?: string) => createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title, body, noRewrite: true, lane });
    const mine = await issue("旧い形を消す", "R9 の記録", "IDD-7");
    discardOutbound((await issue("取り下げた案", "x", "IDD-7")).id);
    await issue("別の lane", "x", "IDD-8");
    await issue("lane の外", "x");
    const drafts = getAgentRunner()!.laneFollowupDrafts!("IDD-7");
    expect(drafts).toEqual([{ id: mine.id, title: "旧い形を消す", body: "R9 の記録", status: "ready" }]);
    expect(getAgentRunner()!.laneFollowupDrafts!("IDD-9")).toEqual([]);
    // reading posts and approves nothing
    expect(readOutbound(mine.id)?.status).toBe("ready");
  });

  test("puts the runner back when it was taken away, whatever ran before", () => {
    ensureAgentRunner();
    setAgentRunner(null);
    expect(getAgentRunner()).toBeNull();
    ensureAgentRunner();
    expect(getAgentRunner()).not.toBeNull();
  });
});
