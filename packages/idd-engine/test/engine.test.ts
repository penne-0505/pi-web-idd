import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, relative, resolve } from "node:path";

import { getAgentRunner, stateDir } from "@idd/core";
import { landPath } from "@idd/core";
import { runChecks } from "../../idd-core/src/overlay/gate.ts";
import { readPipelineSession } from "@idd/lane";

import { ensureIddOnPath } from "../src/idd-path.ts";
import { matchRoute, routes } from "../src/routes.ts";
import { createFetchHandler, startEngine } from "../src/server.ts";
import { ensureAgentRunner } from "../src/server/agent-runner.ts";
import { buildState } from "../src/server/state.ts";
import { beginRequest, checkNow, endRequest, requestCount, resetReload, setConversationProvider, setReloadRunner, setReloading, setStartupCheck } from "../src/server/reload.ts";
import { engineStaleView, readStaleness, rememberEngineStart, resetStaleness, waitingRequestsView } from "../src/server/staleness.ts";
import { POST as modePlanPost } from "../src/routes/mode-plan.ts";
import { POST as modeRecordPost } from "../src/routes/mode-record.ts";
import { GET as sessionInfoGet } from "../src/routes/session-info.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";
import { LAND_CHECK_DETAILS } from "./fixtures/land-check-details.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** wait for a condition the tests drive with files and requests, never longer than a bound */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A raw TCP request the test drives itself. `fetch` decides on its own when to cut a request; a peer that leaves
 * before the answer is what this lane is about, so the connection is opened and cut by hand.
 */
function rawRequest(port: number, method: string, path: string) {
  const socket = connect({ host: "127.0.0.1", port });
  let received = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => { received += chunk; });
  // a cut is the test's own doing, and its error is expected
  socket.on("error", () => { /* the test drives the cut */ });
  const connected = new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return {
    async send(): Promise<void> {
      await connected;
      socket.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    },
    /** wait until the engine has sent the whole answer and closed the connection */
    async readAll(): Promise<string> {
      await closed;
      return received;
    },
    text: (): string => received,
    destroy: (): void => { socket.destroy(); },
  };
}

const ENV_KEYS = ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_MODES_FILE", "IDD_REPOS_FILE", "IDD_ENGINE_PORT", "IDD_AGENT_BASE_URL", "PORT"] as const;
let saved: Record<string, string | undefined> = {};
function saveEnv(): void {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
}
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** an engine whose state is a temp dir, so a test never touches the machine's records */
function engineFixture(): { state: string; server: ReturnType<typeof startEngine>; base: string } {
  saveEnv();
  const state = tmpDir("idd-engine-state-");
  process.env.IDD_STATE_DIR = state;
  process.env.IDD_REPOS_FILE = join(state, "repos.yaml");
  // the low-space card follows the host's disk, not this test's subject: pin the threshold off so an empty
  // state stays empty on a machine whose filesystem is smaller than the default line
  writeFileSync(process.env.IDD_REPOS_FILE, "storage: { cleanup: false, min_free_gb: 0 }\nrepos: {}\n");
  const server = startEngine({ port: 0 });
  return { state, server, base: `http://127.0.0.1:${server.port}` };
}

/** a roles / modes pair the mode endpoints can plan against */
function modeFixture(): { state: string; cwd: string; roles: string; modes: string } {
  saveEnv();
  const dir = tmpDir("idd-engine-modes-");
  const state = join(dir, "state");
  const cwd = join(dir, "chat");
  mkdirSync(state, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const roles = join(dir, "roles.yaml");
  const modes = join(dir, "modes.yaml");
  writeFileSync(roles, "models:\n  opencode-go-glm-5.3:\n    model: opencode-go/glm-5.3\nroles:\n  chat: { model: opencode-go-glm-5.3, thinking: high, tools: [read, bash] }\n");
  writeFileSync(modes, `modes:\n  chat: { role: chat, workspace: ${cwd} }\n`);
  process.env.IDD_STATE_DIR = state;
  process.env.IDD_ROLES_FILE = roles;
  process.env.IDD_MODES_FILE = modes;
  return { state, cwd, roles, modes };
}

describe("the engine's process", () => {
  test("answers the API on its own port, outside the GUI's process", async () => {
    const { server, base } = engineFixture();
    try {
      const res = await fetch(`${base}/api/idd/state`);
      expect(res.status).toBe(200);
      const body = await res.json() as { lanes: unknown[]; sections: unknown[]; items: unknown[] };
      expect(body.lanes).toEqual([]);
      expect(body.sections).toEqual([]);
      expect(body.items).toEqual([]);
      // its own process, not a child of `next` (checked by the runner; here the port answers at all)
      expect(server.port).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });

  test("never cuts a long request before it answers", async () => {
    // the server's own `idleTimeout: 0` is the fix; a route waiting past Bun's default proves it end to end
    const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(source).toMatch(/idleTimeout:\s*0/);
    const { server } = engineFixture();
    server.stop(true);
    const slow = startEngine({
      port: 0,
      extraRoutes: [{
        method: "GET",
        pattern: "/api/idd/slow",
        handler: async () => {
          await new Promise((r) => setTimeout(r, 11_000));
          return new Response("slow ok", { status: 200 });
        },
      }],
    });
    try {
      const res = await fetch(`http://127.0.0.1:${slow.port}/api/idd/slow`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("slow ok");
    } finally {
      slow.stop(true);
    }
  }, 20_000);

  // A test route runs the same wait the landing and the submit checks use (DEC-2330): the state door answers
  // while a repo check runs in the engine's own process. A full land fixture here would repeat the core one.
  test("keeps answering the state door while a repo check waits", async () => {
    saveEnv();
    const state = tmpDir("idd-engine-state-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_REPOS_FILE = join(state, "repos.yaml");
    writeFileSync(process.env.IDD_REPOS_FILE, "repos: {}\n");
    const started = join(state, "started"), signal = join(state, "signal");
    const server = startEngine({
      port: 0,
      extraRoutes: [{
        method: "POST",
        pattern: "/api/idd/slow-check",
        handler: async () => {
          await runChecks(state, [{ name: "slow", command: ["bash", "-c", `touch ${started}; while [ ! -f ${signal} ]; do sleep 0.1; done`], required: true }]);
          return new Response("ok");
        },
      }],
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const pending = fetch(`${base}/api/idd/slow-check`, { method: "POST" });
      const deadline = Date.now() + 10_000;
      while (!existsSync(started)) {
        if (Date.now() > deadline) throw new Error("the check did not start");
        await new Promise((r) => setTimeout(r, 20));
      }
      for (let i = 0; i < 5; i += 1) {
        const t0 = Date.now();
        const res = await fetch(`${base}/api/idd/state`);
        expect(res.status).toBe(200);
        expect(Date.now() - t0).toBeLessThan(1000);
      }
      writeFileSync(signal, "go");
      expect((await pending).status).toBe(200);
    } finally {
      server.stop(true);
    }
  });
});

describe("the engine's guard", () => {
  test("refuses a Host that is not loopback, and a cross-site request, and lets a loopback call through", async () => {
    const { state, server } = engineFixture();
    try {
      const handler = createFetchHandler();
      const host = await handler(new Request("http://127.0.0.1:30144/api/idd/state", { headers: { host: "example.com" } }));
      expect(host.status).toBe(403);
      const crossSite = await handler(new Request("http://127.0.0.1:30144/api/idd/state", { headers: { "sec-fetch-site": "cross-site" } }));
      expect(crossSite.status).toBe(403);
      const ok = await handler(new Request("http://127.0.0.1:30144/api/idd/state", { headers: { host: `127.0.0.1:${server.port}` } }));
      expect(ok.status).toBe(200);
      expect(existsSync(state)).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("the engine's routes", () => {
  test("keep the paths and methods of the routes that moved out of the GUI", () => {
    const found = new Set(routes.map((r) => `${r.method} ${r.pattern}`));
    for (const expected of [
      "GET /api/idd/state", "POST /api/idd/tick", "POST /api/idd/decide",
      "GET /api/idd/check", "POST /api/idd/check", "GET /api/idd/close", "POST /api/idd/close",
      "GET /api/idd/deliver", "POST /api/idd/deliver", 
      "GET /api/idd/exec", "POST /api/idd/exec", "POST /api/idd/intake",
      "GET /api/idd/intake/ignore", "POST /api/idd/intake/ignore", "GET /api/idd/lane/:id",
      "GET /api/idd/modes", "POST /api/idd/overlay", "GET /api/idd/prep", "POST /api/idd/prep",
      "POST /api/idd/resume", "POST /api/idd/snooze",
      "POST /api/idd/passkey/challenge", "GET /api/idd/passkey/register", "POST /api/idd/passkey/register",
      "POST /api/idd/agent/progress", "POST /api/idd/agent/questions", "POST /api/idd/agent/ready", "POST /api/idd/agent/result",
    ]) expect(found.has(expected), expected).toBe(true);
    expect(matchRoute("/api/idd/lane/:id", "/api/idd/lane/IDD-1")).toEqual({ id: "IDD-1" });
    expect(matchRoute("/api/idd/lane/:id", "/api/idd/lane/IDD-1/extra")).toBeNull();
  });

  test("the API's only door is the engine: no other process serves it, and the screen is the engine's own /gui", () => {
    // the old GUI's `/api/idd/*` proxy (a Next route) is gone with the Next app
    expect(existsSync(join(REPO_ROOT, "app"))).toBe(false);
    expect(existsSync(join(REPO_ROOT, "lib", "engine-proxy.ts"))).toBe(false);
    expect(routes.some((r) => r.pattern === "/gui/:file")).toBe(true);
  });
});

describe("the engine's package", () => {
  test("reads no GUI module and no pi SDK: the agent runs outside this process", () => {
    const src = join(REPO_ROOT, "packages", "idd-engine", "src");
    // the words are split, so this test's own source does not look like the import it forbids
    const forbidden = new RegExp(["rpc-mana" + "ger", "session-rea" + "der", "pi-coding-" + "agent", "pi-agent-" + "core", 'from "@/li' + 'b'].join("|"));
    const hits: string[] = [];
    for (const file of readdirSync(src, { recursive: true })) {
      const path = join(src, String(file));
      if (!/\.(ts|mjs)$/.test(path)) continue;
      if (forbidden.test(readFileSync(path, "utf8"))) hits.push(relative(REPO_ROOT, path));
    }
    expect(hits).toEqual([]);
  });

  test("refuses to deliver to a session that is neither a conversation nor a pipeline record", async () => {
    saveEnv();
    process.env.IDD_STATE_DIR = tmpDir("idd-engine-deliver-");
    ensureAgentRunner();
    const runner = getAgentRunner();
    expect(runner).not.toBeNull();
    await expect(runner!.deliver("nobody-session", "hello")).rejects.toThrow(/engine のものではありません/);
  });
});

/** a checkout that has the `bin/idd` the engine's wrapper execs */
function codeCheckout(prefix: string): string {
  const root = tmpDir(prefix);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "idd"), "#!/bin/sh\necho idd\n");
  return root;
}

/** the engine put its wrapper under `state` (not under the checkout), and it execs the checkout's bin/idd */
function expectWrapperUnder(state: string, root: string, env: NodeJS.ProcessEnv): string {
  const dir = ensureIddOnPath({ root, env });
  expect(dir).toBe(join(state, "bin"));
  expect(existsSync(join(root, "state"))).toBe(false);
  expect(readFileSync(join(state, "bin", "idd"), "utf8")).toContain(`exec '${join(root, "bin", "idd")}'`);
  return dir as string;
}

describe("the engine's idd on PATH", () => {
  test("writes the wrapper under the state, where the engine is the writer", () => {
    const root = codeCheckout("idd-engine-path-");
    const env = { PATH: "/usr/bin" };
    const dir = ensureIddOnPath({ root, env });
    expect(dir).toBe(join(root, "state", "bin"));
    expect(existsSync(join(root, "state", "bin", "idd"))).toBe(true);
    expect(env.PATH).toBe(`${dir}:/usr/bin`);
  });

  test("the wrapper goes under the state the engine reads, and execs the running checkout's bin/idd", () => {
    const root = codeCheckout("idd-engine-path-code-");
    const state = tmpDir("idd-engine-path-state-");
    const env = { PATH: "/usr/bin", IDD_STATE_DIR: state };
    const dir = expectWrapperUnder(state, root, env);
    expect(env.PATH).toBe(`${dir}:/usr/bin`);
  });

  test("with no state in the environment, the wrapper goes under the install record's state and the agent is handed the recorded state and pi", () => {
    const root = codeCheckout("idd-engine-path-rec-code-");
    const home = tmpDir("idd-engine-path-rec-home-");
    const state = tmpDir("idd-engine-path-rec-state-");
    mkdirSync(join(home, ".config", "idd"), { recursive: true });
    writeFileSync(join(home, ".config", "idd", "install.json"), JSON.stringify({ schema: 1, checkout: root, version: "v0", installed_at: "", state_dir: state, pi_bin: "/rec/pi" }));
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: home };
    expectWrapperUnder(state, root, env);
    expect(env.IDD_STATE_DIR).toBe(state);
    expect(env.IDD_PI_BIN).toBe("/rec/pi");
  });

  test("a relative state is read against the process cwd, and the agent inherits that one absolute path", () => {
    const root = codeCheckout("idd-engine-path-rel-code-");
    const state = tmpDir("idd-engine-path-rel-state-");
    const rel = relative(process.cwd(), state);
    expect(rel).not.toBe(state);
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", IDD_STATE_DIR: rel };
    const dir = expectWrapperUnder(state, root, env);
    expect(env.IDD_STATE_DIR).toBe(state);
    const saved = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = rel;
    try {
      expect(resolve(stateDir(), "bin")).toBe(dir);
    } finally {
      if (saved === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved;
    }
  });
});

describe("the mode's two doors", () => {
  test("the plan door prepares the role's agent dir and returns the values the GUI starts pi with", async () => {
    const { state } = modeFixture();
    const res = await modePlanPost(new Request("http://127.0.0.1:30144/api/idd/modes/chat/plan", { method: "POST" }), { name: "chat" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; plan: { toolNames: string[]; thinkingLevel: string; agentDir: string; cwd: string } };
    expect(body.ok).toBe(true);
    expect(body.plan.toolNames).toEqual(["read", "bash"]);
    expect(body.plan.thinkingLevel).toBe("high");
    expect(existsSync(body.plan.agentDir)).toBe(true);
    expect(existsSync(state)).toBe(true);
  });

  test("the record door writes the spawn record the GUI's start cannot", async () => {
    modeFixture();
    const res = await modeRecordPost(new Request("http://127.0.0.1:30144/api/idd/modes/chat/record", { method: "POST", body: JSON.stringify({ sessionId: "mode-session-1" }) }), { name: "chat" });
    expect(res.status).toBe(200);
    const rec = readPipelineSession("mode-session-1");
    expect(rec?.slot).toBe("mode:chat");
    expect(rec?.role).toBe("chat");
  });

  test("the record door refuses a session id that is not one, and never writes outside pipeline/sessions", async () => {
    const { state } = modeFixture();
    const res = await modeRecordPost(new Request("http://127.0.0.1:30144/api/idd/modes/chat/record", { method: "POST", body: JSON.stringify({ sessionId: "../escape" }) }), { name: "chat" });
    expect(res.status).toBe(400);
    expect(existsSync(join(state, "escape.json"))).toBe(false);
    expect(existsSync(join(state, "pipeline", "escape.json"))).toBe(false);
  });

  test("the record door never replaces an engine-owned session's record with a mode's", async () => {
    const { state } = modeFixture();
    mkdirSync(join(state, "pipeline", "sessions"), { recursive: true });
    const ownedPath = join(state, "pipeline", "sessions", "planner-1.json");
    writeFileSync(ownedPath, JSON.stringify({
      session_id: "planner-1", slot: "planner", role: "chat", model: "opencode-go/glm-5.3", agent_dir: "", thinking: "high", spawned_at: "2026-01-01T00:00:00.000Z",
    }));
    const before = readFileSync(ownedPath, "utf8");
    const res = await modeRecordPost(new Request("http://127.0.0.1:30144/api/idd/modes/chat/record", { method: "POST", body: JSON.stringify({ sessionId: "planner-1" }) }), { name: "chat" });
    expect(res.status).toBe(409);
    expect(readFileSync(ownedPath, "utf8")).toBe(before);
    expect(readPipelineSession("planner-1")?.slot).toBe("planner");
  });
});

describe("the session question the chat screen asks", () => {
  test("tells an engine-owned session from a mode one, and carries the mode's agent dir for a revive", async () => {
    const { state } = modeFixture();
    // a planner spawn record from before the switch-over is the engine's
    mkdirSync(join(state, "pipeline", "sessions"), { recursive: true });
    writeFileSync(join(state, "pipeline", "sessions", "planner-1.json"), JSON.stringify({
      session_id: "planner-1", slot: "planner", role: "chat", model: "opencode-go/glm-5.3", agent_dir: "", thinking: "high", spawned_at: "2026-01-01T00:00:00.000Z",
    }));
    const owned = await (await sessionInfoGet(new Request("http://127.0.0.1:30144/api/idd/session/planner-1"), { id: "planner-1" })).json() as { engineOwned: boolean };
    expect(owned.engineOwned).toBe(true);

    // a mode session is the GUI's to revive, but its agent dir is the engine's record
    await modeRecordPost(new Request("http://127.0.0.1:30144/api/idd/modes/chat/record", { method: "POST", body: JSON.stringify({ sessionId: "mode-session-2" }) }), { name: "chat" });
    const mode = await (await sessionInfoGet(new Request("http://127.0.0.1:30144/api/idd/session/mode-session-2"), { id: "mode-session-2" })).json() as { engineOwned: boolean; agentDir?: string };
    expect(mode.engineOwned).toBe(false);
    expect(mode.agentDir).toBeTruthy();

    const unknown = await (await sessionInfoGet(new Request("http://127.0.0.1:30144/api/idd/session/none"), { id: "none" })).json() as { engineOwned: boolean };
    expect(unknown.engineOwned).toBe(false);
  });

  test("prepares a mode's agent dir from the current roles, the way an in-process revive did", async () => {
    const { state } = modeFixture();
    await modeRecordPost(new Request("http://127.0.0.1:30144/api/idd/modes/chat/record", { method: "POST", body: JSON.stringify({ sessionId: "mode-session-3" }) }), { name: "chat" });
    const first = await (await sessionInfoGet(new Request("http://127.0.0.1:30144/api/idd/session/mode-session-3"), { id: "mode-session-3" })).json() as { agentDir?: string };
    expect(first.agentDir).toBeTruthy();
    // the same place the start used and the record names (not a nested <role>/<role>)
    expect(first.agentDir).toBe(join(state, "pipeline", "agent", "chat"));
    expect(first.agentDir).toBe(readPipelineSession("mode-session-3")?.agent_dir);
    // the dir is gone (a cleaned state, a changed role): the next revive question rebuilds it
    rmSync(first.agentDir as string, { recursive: true, force: true });
    expect(existsSync(first.agentDir as string)).toBe(false);
    const again = await (await sessionInfoGet(new Request("http://127.0.0.1:30144/api/idd/session/mode-session-3"), { id: "mode-session-3" })).json() as { agentDir?: string };
    expect(again.agentDir).toBe(first.agentDir);
    expect(existsSync(again.agentDir as string)).toBe(true);
    expect(existsSync(join(state, "pipeline"))).toBe(true);
  });

  test("an unreadable record is not answered as 'not the engine\'s'", async () => {
    const { state } = modeFixture();
    mkdirSync(join(state, "pipeline", "sessions"), { recursive: true });
    writeFileSync(join(state, "pipeline", "sessions", "planner-broken.json"), "{ not json");
    const res = await sessionInfoGet(new Request("http://127.0.0.1:30144/api/idd/session/planner-broken"), { id: "planner-broken" });
    expect(res.status).toBe(500);
    const body = await res.json() as { engineOwned?: boolean };
    expect(body.engineOwned).toBeUndefined();
  });
});

describe("the state's stop and blocked readings", () => {
  /** a state for one lane with a real worktree, a session, and the given lifecycle records */
  function cardsFixture(events: { event: string; at: string; attrs?: Record<string, unknown> }[]): string {
    saveEnv();
    const state = tmpDir("idd-engine-cards-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_REPOS_FILE = join(state, "repos.yaml");
    writeFileSync(process.env.IDD_REPOS_FILE, "repos: {}\n");
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, "models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\npipeline:\n  executor: { role: r }\n");
    const wt = join(state, "wt");
    mkdirSync(wt, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@l", "-c", "commit.gpgsign=false", ...args], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    writeFileSync(join(wt, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(state, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-1", area: "demo", title: "T", context: "", created_at: "2026-09-01T09:00:00+09:00" }) + "\n");
    writeFileSync(join(state, "executor-sessions.jsonl"), JSON.stringify({ idd_id: "IDD-1", executor_session_id: "E1", worktree_path: wt }) + "\n");
    writeFileSync(join(state, "lifecycle-demo.jsonl"), events.map((e) => JSON.stringify({ idd_id: "IDD-1", event: e.event, at: e.at, attrs: e.attrs ?? {} })).join("\n") + "\n");
    return state;
  }

  const ev = (event: string, at: string, attrs: Record<string, unknown> = {}) => ({ event, at, attrs });

  test("a halt record becomes a stuck card with the stage, the time, the last record and the reason", () => {
    cardsFixture([
      ev("lane_open", "2026-09-01T10:00:00+09:00"),
      ev("s1_go", "2026-09-01T10:01:00+09:00"),
      ev("s2_start", "2026-09-01T10:02:00+09:00"),
      ev("s2_result", "2026-09-01T10:03:00+09:00"),
      ev("s2_review_converged", "2026-09-01T10:04:00+09:00"),
      ev("s2_device_skipped", "2026-09-01T10:05:00+09:00"),
      ev("s3_ready", "2026-09-01T10:06:00+09:00"),
      ev("s2_order_limit", "2026-09-01T10:07:00+09:00"),
      ev("lane_stall_detected", "2026-09-01T10:08:00+09:00", {
        stage: "提出の準備中",
        since: "2026-09-01T10:06:00+09:00",
        last_event: { event: "s2_order_limit", at: "2026-09-01T10:07:00+09:00" },
        reason: "engine の番のまま進んでいない",
        causes: [],
        can_send_back: true,
      }),
    ]);
    const item = buildState().items.find((i) => i.kind === "stuck") as { halt?: { stage: string; since: string; lastEvent: { name: string; at: string }; reason: string; canSendBack: boolean } } | undefined;
    expect(item?.halt?.stage).toBe("提出の準備中");
    expect(item?.halt?.since).toBe("2026-09-01T10:06:00+09:00");
    expect(item?.halt?.lastEvent.name).toBe("順番待ちの上限を超えた");
    expect(item?.halt?.reason).toBe("engine の番のまま進んでいない");
    expect(item?.halt?.canSendBack).toBe(true);
  });

  test("a ship card whose past R2 record stopped is not blocked by it (R2 removed 2026-10-22)", () => {
    cardsFixture([
      ev("lane_open", "2026-09-01T10:00:00+09:00"),
      ev("s1_go", "2026-09-01T10:01:00+09:00"),
      ev("s2_start", "2026-09-01T10:02:00+09:00"),
      ev("s2_result", "2026-09-01T10:03:00+09:00"),
      ev("s2_review_converged", "2026-09-01T10:04:00+09:00"),
      ev("s2_device_skipped", "2026-09-01T10:05:00+09:00"),
      ev("s3_ready", "2026-09-01T10:06:00+09:00"),
      ev("s3_r2_started", "2026-09-01T10:07:00+09:00", { run_id: "r" }),
      ev("s3_r2_done", "2026-09-01T10:08:00+09:00", { run_id: "r", must: 0, should: 0 }),
      ev("s3_r2_not_recorded", "2026-09-01T10:09:00+09:00", { run_id: "r", reason: "記録の検査が通らないので commit していません" }),
      ev("s3_ok", "2026-09-01T10:10:00+09:00", { at_by: "auto" }),
      ev("s4_submit_started", "2026-09-01T10:11:00+09:00"),
    ]);
    const item = buildState().items.find((i) => i.kind === "ship") as { blocked?: { reasons: string[] } } | undefined;
    expect(item).toBeDefined();
    expect(item?.blocked?.reasons.join(" ") ?? "").not.toMatch(/R2|記録の検査/);
  });

  /**
   * A lane at the submit whose landing record holds the given checks, and a repo that does not publish. The card
   * is then the landing card, the one the non-blocking checks are folded onto.
   */
  function landState(checks: unknown[], blocking = 0): string {
    const state = cardsFixture([
      ev("lane_open", "2026-09-01T10:00:00+09:00"),
      ev("s1_go", "2026-09-01T10:01:00+09:00"),
      ev("s2_start", "2026-09-01T10:02:00+09:00"),
      ev("s2_result", "2026-09-01T10:03:00+09:00"),
      ev("s2_review_converged", "2026-09-01T10:04:00+09:00"),
      ev("s2_device_skipped", "2026-09-01T10:05:00+09:00"),
      ev("s3_ready", "2026-09-01T10:06:00+09:00"),
      ev("s3_r2_started", "2026-09-01T10:07:00+09:00", { run_id: "r" }),
      ev("s3_r2_done", "2026-09-01T10:08:00+09:00", { run_id: "r", must: 0, should: 0 }),
      ev("s3_ok", "2026-09-01T10:10:00+09:00", { at_by: "auto" }),
      ev("s4_submit_started", "2026-09-01T10:11:00+09:00"),
    ]);
    const wt = join(state, "wt");
    const head = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(process.env.IDD_REPOS_FILE!, `repos:\n  demo:\n    github: o/r\n    upstream: ${wt}\n    work: ${wt}\n    publish: false\n    work_base: main\n    public_base: main\n`);
    writeFileSync(landPath("IDD-1"), JSON.stringify({
      iddId: "IDD-1", branch: "idd/IDD-1", head, workBase: "main", repo: "o/r", mainTip: head,
      checks, blocking, token: "tok", expiresAt: "2035-01-01T00:00:00Z", configKey: "cfg", status: "prepared",
    }));
    return state;
  }

  test("a failed non-blocking landing check is a warning on the ship card, with the line that says why", () => {
    landState([
      { name: "typecheck", status: "pass", severity: "blocking" },
      { name: "docs", status: "fail", severity: "non-blocking", detail: LAND_CHECK_DETAILS.docs122 },
      { name: "intent", status: "fail", severity: "non-blocking", detail: LAND_CHECK_DETAILS.intent119 },
    ]);
    const item = buildState().items.find((i) => i.kind === "ship") as { checkWarnings?: { name: string; reason: string }[]; blocked?: unknown } | undefined;
    expect(item?.checkWarnings).toEqual([
      { name: "docs", reason: "check-docs: FAILED: doc-links" },
      { name: "intent", reason: "error projection P-11.md: 写しが直されています。`idd intent draw` で描き直してください" },
    ]);
    expect(item?.blocked).toBeUndefined();
  });

  test("a reason is never empty: a finding line wins, the count line stands in when the findings were cut", () => {
    const cases: [string, string][] = [
      [LAND_CHECK_DETAILS.intent153, "error round IDD-153: 巡（2026-10-17T01:26:00+09:00 まで）に Choice の新設・Re-anchor・Supersede・Waive がありません"],
      [LAND_CHECK_DETAILS.intent121, "error 276 件、注記 0 件、印 155 件"],
    ];
    for (const [detail, reason] of cases) {
      landState([{ name: "intent", status: "fail", severity: "non-blocking", detail }]);
      const item = buildState().items.find((i) => i.kind === "ship") as { checkWarnings?: { name: string; reason: string }[] } | undefined;
      expect(item?.checkWarnings).toEqual([{ name: "intent", reason }]);
    }
  });

  test("a landing whose non-blocking checks passed adds no warning", () => {
    landState([
      { name: "docs", status: "pass", severity: "non-blocking" },
      { name: "intent", status: "not-applicable", severity: "non-blocking" },
    ]);
    const item = buildState().items.find((i) => i.kind === "ship") as { checkWarnings?: unknown } | undefined;
    expect(item?.checkWarnings).toBeUndefined();
  });

  test("a blocking check that failed still holds the signature, beside the non-blocking warning", () => {
    landState([
      { name: "test", status: "fail", severity: "blocking", detail: "1 failed" },
      { name: "docs", status: "fail", severity: "non-blocking", detail: LAND_CHECK_DETAILS.docs122 },
    ], 1);
    const item = buildState().items.find((i) => i.kind === "ship") as { blocked?: { reasons: string[] }; checkWarnings?: { name: string; reason: string }[] } | undefined;
    expect(item?.blocked?.reasons).toEqual(["止めている検査: test（1 failed）"]);
    expect(item?.checkWarnings).toEqual([{ name: "docs", reason: "check-docs: FAILED: doc-links" }]);
  });

  test("a blocking check that did not run holds the signature as a named reason, whatever its name", () => {
    landState([
      { name: "anything-at-all", status: "skipped", severity: "blocking", detail: "検査コマンドがありません" },
      { name: "typecheck", status: "pass", severity: "blocking" },
      { name: "gone", status: "not-applicable", severity: "blocking" },
    ], 1);
    const item = buildState().items.find((i) => i.kind === "ship") as { blocked?: { reasons: string[] } } | undefined;
    expect(item?.blocked?.reasons).toEqual(["止めている検査: anything-at-all（未実行: 検査コマンドがありません）"]);
  });

  test("a decision card carries the notice the engine recorded for it", async () => {
    cardsFixture([
      ev("lane_open", "2026-09-01T10:00:00+09:00"),
      ev("s1_ready", "2026-09-01T10:01:00+09:00"),
      ev("s1_plan_review_done", "2026-09-01T10:02:00+09:00", { must: 0, should: 0 }),
      ev("lane_wait_notified", "2026-09-01T10:03:00+09:00", { decision: "go", since: "2026-09-01T10:01:00+09:00" }),
    ]);
    const item = buildState().items.find((i) => i.kind === "go") as { waitNoticeAt?: string } | undefined;
    expect(item?.waitNoticeAt).toBe("2026-09-01T10:03:00+09:00");
  });

  test("a question card carries its notice too, without an appearedAt", () => {
    const state = cardsFixture([
      ev("lane_open", "2026-09-01T10:00:00+09:00"),
      ev("question_batch_asked", "2026-09-01T10:01:00+09:00"),
      ev("lane_wait_notified", "2026-09-01T10:03:00+09:00", { decision: "question", since: "2026-09-01T10:01:00+09:00" }),
    ]);
    writeFileSync(join(state, "pending-questions.jsonl"), JSON.stringify({
      idd_id: "IDD-1", batch_id: "b1", asked_at: "2026-09-01T10:01:00+09:00",
      questions: [{ question_id: "q1", question: "どちらにしますか", context: "", options: [{ index: 1, label: "A" }] }],
    }) + "\n");
    const item = buildState().items.find((i) => i.kind === "question") as { waitNoticeAt?: string; appearedAt?: string } | undefined;
    expect(item?.waitNoticeAt).toBe("2026-09-01T10:03:00+09:00");
    // a question batch is told apart by its id, so it keeps no appearedAt (the notice is the engine's record)
    expect(item?.appearedAt).toBeUndefined();
  });

  test("a closed lane's unanswered question is no card, and an open lane's is", () => {
    const ask = (iddId: string) => JSON.stringify({
      idd_id: iddId, batch_id: "b1", asked_at: "2026-09-01T10:01:00+09:00",
      questions: [{ question_id: "q1", question: "どちらにしますか", context: "", options: [{ index: 1, label: "A" }] }],
    }) + "\n";
    const state = cardsFixture([
      ev("lane_open", "2026-09-01T10:00:00+09:00"),
      ev("question_batch_asked", "2026-09-01T10:01:00+09:00"),
    ]);
    writeFileSync(join(state, "pending-questions.jsonl"), ask("IDD-1"));
    expect(buildState().items.filter((i) => i.kind === "question").length).toBe(1);

    appendFileSync(join(state, "lifecycle-demo.jsonl"), JSON.stringify({ idd_id: "IDD-1", ...ev("lane_close", "2026-09-01T10:02:00+09:00", { outcome: "aborted" }) }) + "\n");
    expect(buildState().items.filter((i) => i.kind === "question").length).toBe(0);
    // the question is still in the record: it is only no longer waited on
    expect(readFileSync(join(state, "pending-questions.jsonl"), "utf8")).toBe(ask("IDD-1"));
  });
});

describe("the engine's request count and the reloading window", () => {
  /** a checkout the engine started on and then advanced under it */
  function staleRepo(): string {
    const repo = tmpDir("idd-engine-reload-repo-");
    const run = (...args: string[]) => { execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }); };
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    mkdirSync(join(repo, "packages"), { recursive: true });
    writeFileSync(join(repo, "packages", "a.ts"), "a");
    run("add", "-A");
    run("commit", "-q", "-m", "base");
    rememberEngineStart({ root: repo });
    // a shared-code change: the engine is behind its checkout
    writeFileSync(join(repo, "packages", "a.ts"), "b");
    run("add", "-A");
    run("commit", "-q", "-m", "change");
    readStaleness({ root: repo });
    return repo;
  }

  function fakeShell() {
    const restarts: string[][] = [];
    const runner = (_cmd: string, args: string[]) => {
      if (args.includes("--value")) return { status: 0, stdout: `${process.pid}\n`, stderr: "" };
      restarts.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };
    return { restarts, runner };
  }

  /**
   * A running engine behind its checkout, with a stand-in systemd and the routes a count test needs. The routes are
   * gated on a file so a test decides when a handler returns without sleeping for it.
   */
  function reloadFixture(makeRoutes: (state: string) => { method: string; pattern: string; handler: (req: Request) => Promise<Response> | Response }[]) {
    saveEnv();
    const state = tmpDir("idd-engine-state-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_REPOS_FILE = join(state, "repos.yaml");
    writeFileSync(process.env.IDD_REPOS_FILE, "repos: {}\n");
    staleRepo();
    const shell = fakeShell();
    setReloadRunner(shell.runner);
    setConversationProvider(() => []);
    setStartupCheck(() => ({ ok: true }));
    const server = startEngine({
      port: 0,
      tailnet: { loopback: "127.0.0.1", addresses: [], origins: [], rejected: [] },
      passkeyCount: () => 0,
      extraRoutes: makeRoutes(state),
    });
    return { state, shell, server };
  }

  /** a route whose handler waits on `gate` before it answers */
  function gatedRoute(pattern: string, gate: string, body = "late") {
    return {
      method: "GET",
      pattern,
      handler: async (): Promise<Response> => {
        while (!existsSync(gate)) await new Promise((r) => setTimeout(r, 10));
        return new Response(body);
      },
    };
  }

  // a request a test answered by calling a handler directly (never the server) leaves its count held; start clean
  beforeEach(() => {
    resetReload();
    resetStaleness();
  });

  afterEach(() => {
    resetReload();
    resetStaleness();
  });

  test("counts a slow request until its answer is sent, and does not ask the restart while it runs", async () => {
    saveEnv();
    const state = tmpDir("idd-engine-state-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_REPOS_FILE = join(state, "repos.yaml");
    writeFileSync(process.env.IDD_REPOS_FILE, "repos: {}\n");
    staleRepo();
    const shell = fakeShell();
    setReloadRunner(shell.runner);
    setConversationProvider(() => []);
    setStartupCheck(() => ({ ok: true }));
    const gate = join(state, "go");
    const server = startEngine({
      port: 0,
      tailnet: { loopback: "127.0.0.1", addresses: [], origins: [], rejected: [] },
      passkeyCount: () => 0,
      extraRoutes: [{
        method: "GET",
        pattern: "/api/idd/slow",
        handler: async () => {
          while (!existsSync(gate)) await new Promise((r) => setTimeout(r, 10));
          return new Response("slow ok");
        },
      }],
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const pending = fetch(`${base}/api/idd/slow`);
      await waitFor(() => requestCount() === 1, "the slow request was counted");
      const held = await checkNow();
      expect(held.action).toBe("hold");
      expect(shell.restarts.length).toBe(0);
      writeFileSync(gate, "go");
      expect(await (await pending).text()).toBe("slow ok");
      await waitFor(() => requestCount() === 0, "the count returned to 0");
      const after = await checkNow();
      expect(after.action).toBe("reload");
      expect(shell.restarts.length).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("refuses on every listener while the restart is on its way, and counts from all of them", async () => {
    saveEnv();
    const state = tmpDir("idd-engine-state-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_REPOS_FILE = join(state, "repos.yaml");
    writeFileSync(process.env.IDD_REPOS_FILE, "repos: {}\n");
    staleRepo();
    const shell = fakeShell();
    setReloadRunner(shell.runner);
    setConversationProvider(() => []);
    setStartupCheck(() => ({ ok: true }));
    const gate = join(state, "go");
    const slow = {
      method: "GET",
      pattern: "/api/idd/slow",
      handler: async () => {
        while (!existsSync(gate)) await new Promise((r) => setTimeout(r, 10));
        return new Response("slow ok");
      },
    };
    // two handlers, as two listeners of one engine: the count and the window are shared, not per listener
    const h1 = createFetchHandler([slow], {}, "127.0.0.1");
    const h2 = createFetchHandler([slow], {}, "127.0.0.2");
    try {
      const pending = h1(new Request("http://127.0.0.1:30144/api/idd/slow", { headers: { host: "127.0.0.1:30144" } }));
      await waitFor(() => requestCount() === 1, "the request on the first listener was counted");
      setReloading(true);
      const refused = await h2(new Request("http://127.0.0.2:30144/api/idd/slow", { headers: { host: "127.0.0.2:30144" } }));
      expect(refused.status).toBe(503);
      expect((await refused.json()).reloading).toBe(true);
      setReloading(false);
      writeFileSync(gate, "go");
      expect(await (await pending).text()).toBe("slow ok");
      await waitFor(() => requestCount() === 0, "the count returned to 0");
    } finally {
      resetReload();
    }
  });

  test("counts a slowly streamed answer until the client has read every chunk", async () => {
    saveEnv();
    const state = tmpDir("idd-engine-state-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_REPOS_FILE = join(state, "repos.yaml");
    writeFileSync(process.env.IDD_REPOS_FILE, "repos: {}\n");
    const encoder = new TextEncoder();
    const route = {
      method: "GET",
      pattern: "/api/idd/stream",
      handler: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          let i = 0;
          const tick = (): void => {
            if (i < 3) {
              controller.enqueue(encoder.encode(`chunk${i}`));
              i += 1;
              setTimeout(tick, 80);
            } else {
              controller.close();
            }
          };
          tick();
        },
      })),
    };
    const handler = createFetchHandler([route], {}, "127.0.0.1");
    try {
      const res = await handler(new Request("http://127.0.0.1:30144/api/idd/stream", { headers: { host: "127.0.0.1:30144" } }));
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      expect(requestCount()).toBe(1);
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
        if (text.length < 18) expect(requestCount()).toBe(1);
      }
      expect(text).toBe("chunk0chunk1chunk2");
      await waitFor(() => requestCount() === 0, "the count returned to 0 when the body was read out");
    } finally {
      resetReload();
    }
  });

  test("holds a request whose peer left until its handler returns, then drops it and lets the restart ask", async () => {
    const { state, shell, server } = reloadFixture((s) => [gatedRoute("/api/idd/peer-left", join(s, "gate"))]);
    try {
      const conn = rawRequest(server.port, "GET", "/api/idd/peer-left");
      await conn.send();
      await waitFor(() => requestCount() === 1, "the request was counted");
      // the peer cuts before the answer; the handler keeps running, and the count must stand until it returns (INV-097-1)
      conn.destroy();
      await new Promise((r) => setTimeout(r, 200));
      expect(requestCount()).toBe(1);
      const held = await checkNow();
      expect(held.action).toBe("hold");
      expect(shell.restarts.length).toBe(0);
      // the handler returns; nobody is reading the answer, so the count is handed back
      writeFileSync(join(state, "gate"), "go");
      await waitFor(() => requestCount() === 0, "the count returned to 0 after the handler returned");
      const after = await checkNow();
      expect(after.action).toBe("reload");
      expect(shell.restarts.length).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("drops a HEAD answer as soon as its handler returns", async () => {
    const { server } = reloadFixture(() => []);
    try {
      // the route table has GET /api/idd/state; a HEAD matches none, so the answer is a 404 with a body
      const conn = rawRequest(server.port, "HEAD", "/api/idd/state");
      await conn.send();
      await conn.readAll();
      await waitFor(() => requestCount() === 0, "the HEAD request left the count");
      const after = await checkNow();
      expect(after.action).toBe("reload");
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("does not count an event stream", async () => {
    const route = {
      method: "GET",
      pattern: "/api/idd/events",
      handler: () => new Response(new ReadableStream<Uint8Array>({ start() { /* stays open like a conversation's stream */ } }), { headers: { "content-type": "text/event-stream" } }),
    };
    const { server } = reloadFixture(() => [route]);
    try {
      const conn = rawRequest(server.port, "GET", "/api/idd/events");
      await conn.send();
      await new Promise((r) => setTimeout(r, 200));
      expect(requestCount()).toBe(0);
      conn.destroy();
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("hands back every count when 20 requests run and half their peers leave", async () => {
    const { state, server } = reloadFixture((s) => [gatedRoute("/api/idd/many", join(s, "gate"))]);
    try {
      const conns = Array.from({ length: 20 }, () => rawRequest(server.port, "GET", "/api/idd/many"));
      await Promise.all(conns.map((c) => c.send()));
      await waitFor(() => requestCount() === 20, "all 20 requests were counted");
      for (let i = 0; i < 10; i += 1) conns[i].destroy();
      await new Promise((r) => setTimeout(r, 200));
      // the handler has not returned: the ten peers that left still hold the count (INV-097-1)
      expect(requestCount()).toBe(20);
      writeFileSync(join(state, "gate"), "go");
      // the ten that stayed read their answers to the end; the ten that left are let go at the handler's return
      await Promise.all(conns.slice(10).map((c) => c.readAll()));
      await waitFor(() => requestCount() === 0, "every count was handed back");
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("keeps the query out of the hold reason and the waiting requests", async () => {
    const { state, server } = reloadFixture((s) => [gatedRoute("/api/idd/secret", join(s, "gate"))]);
    try {
      const conn = rawRequest(server.port, "GET", "/api/idd/secret?token=hunter2");
      await conn.send();
      await waitFor(() => requestCount() === 1, "the request was counted");
      const held = await checkNow(Date.now() + 12 * 60_000);
      expect(held.action).toBe("hold");
      expect(held.reason).toContain("処理中の要求 1 件");
      expect(held.reason).toContain("/api/idd/secret");
      expect(held.reason).not.toContain("hunter2");
      const views = waitingRequestsView();
      expect(views.length).toBe(1);
      expect(views[0].path).toBe("/api/idd/secret");
      expect(views[0].method).toBe("GET");
      expect(JSON.stringify(views)).not.toContain("hunter2");
      expect(engineStaleView().hold ?? "").not.toContain("hunter2");
      writeFileSync(join(state, "gate"), "go");
      await conn.readAll();
      await waitFor(() => requestCount() === 0, "the count returned to 0");
    } finally {
      server.stop(true);
    }
  }, 20_000);
});
