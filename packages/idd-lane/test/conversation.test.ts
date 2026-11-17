import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isClaudeQuotaBlocked, recordClaudeQuota } from "../src/claude-quota.ts";
import { readContextSnapshots } from "../src/context-files.ts";
import { consumptionPath, readConsumption } from "../src/consumption.ts";
import { markStoppedByUser, stoppedByUserAt } from "../src/conversation-lock.ts";
import {
  acquireConversationLock, adoptPipelineConversation, conversationBusyAt, conversationCost, conversationLockHeld, conversationStatus, conversationTurns,
  deliverToConversation, isConversation, refreshConversationModel, isSupervisedPipelineSession, liveConversationIds, openConversation, piConversationArgs, piConversationEnv,
  prepareConversationAgentDir, queueMessage, stageSystemPrompts, queuedMessages, livePiConversationIds, releaseConversationLock, runConversation, startSupervisor, wakeConversation,
} from "../src/conversation.ts";
import { pipelineResumeOptions, pipelinePlanFor, planPipelineSpawn, readPipelineSession, recordPipelineSession, type ClaudePipelineSpawnPlan } from "../src/pipeline-spawn.ts";
import { stopPipelineSession } from "../src/pipeline-start.ts";
import { TOOL_TIMEOUT_LOG } from "../src/lane-shell.ts";
import { providerOf, resolveRoute } from "../src/route.ts";
import { readRoles, resolveRole } from "../src/roles.ts";
import { laneDir, readLane, runLane, sendLane, stopLane, writeLane, type LaneRecord } from "../src/runner.ts";
import { superviseLane } from "../src/supervisor.ts";

// the planner's bundle is wrapped so a test can make a read fail; it passes through unless a test sets `bundleFails`
const realRules = { ...(await import("../../idd-core/src/rules/rules.ts")) };
const bundle = { calls: 0, failsFrom: Infinity };
mock.module("../../idd-core/src/rules/rules.ts", () => ({
  ...realRules,
  plannerRulesBundle: (...args: Parameters<typeof realRules.plannerRulesBundle>) => {
    bundle.calls += 1;
    if (bundle.calls >= bundle.failsFrom) throw new Error("work.md: ## 受け入れ条件（AC）が無い");
    return realRules.plannerRulesBundle(...args);
  },
}));

/**
 * A stand-in for `claude -p`, shaped after the real one (checked with haiku, 2026-09-24): it reads the prompt
 * from the argument after `--` or else from stdin, reports total_cost_usd accumulated over the conversation,
 * refuses --session-id for a conversation that exists and --resume for one that does not. It records how it
 * was started and whether another reply was running at the same time.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const dash = args.indexOf("--");
const fromArgv = dash >= 0 && dash < args.length - 1;
const prompt = fromArgv ? args[dash + 1] : fs.readFileSync(0, "utf8");
const resume = args.includes("--resume");
const session = at("--session-id") ?? at("--resume");
const log = process.env.FAKE_CLAUDE_LOG;
fs.appendFileSync(log + ".attempts", JSON.stringify({ mode: resume ? "resume" : "session-id", prompt: prompt.slice(0, 40) }) + "\\n");
const sessions = log + ".sessions";
fs.mkdirSync(sessions, { recursive: true });
const known = fs.existsSync(sessions + "/" + session);
if (!resume && known) { process.stderr.write("Error: Session ID " + session + " is already in use.\\n"); process.exit(1); }
if (resume && !known) { process.stderr.write("No conversation found with session ID: " + session + "\\n"); process.exit(1); }
if (!known) fs.writeFileSync(sessions + "/" + session, "0");
let overlap = false;
try { fs.mkdirSync(log + ".active"); } catch { overlap = true; }
const entry = { mode: resume ? "resume" : "session-id", session, prompt: prompt.length > 200 ? prompt.slice(0, 40) : prompt, length: prompt.length,
  via: fromArgv ? "argv" : "stdin", argv: args.join(" "), start: Date.now(), overlap, pid: process.pid,
  config: process.env.CLAUDE_CONFIG_DIR, lane: process.env.IDD_LANE_ID, idd: process.env.IDD_ID, token: process.env.IDD_AGENT_TOKEN, memory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, apiKey: Boolean(process.env.ANTHROPIC_API_KEY) };
fs.appendFileSync(log + ".starts", JSON.stringify(entry) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: session });
const util = process.env.FAKE_CLAUDE_UTIL;
if (util) out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: Number(util), resetsAt: Math.floor(Date.now() / 1000) + 3600 }, session_id: session });
setTimeout(() => {
  const report = process.env.FAKE_CLAUDE_REPORT;
  if (report) { fs.writeFileSync(report + ".md", "ok"); fs.writeFileSync(report + ".json", "{}"); }
  const total = Number(fs.readFileSync(sessions + "/" + session, "utf8")) + Number(process.env.FAKE_CLAUDE_COST || "0.25");
  fs.writeFileSync(sessions + "/" + session, String(total));
  out({ type: "assistant", message: { content: [{ type: "text", text: "answered" }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "answered", total_cost_usd: total, session_id: session, usage: { input_tokens: 10, output_tokens: 5 } });
  fs.appendFileSync(log, JSON.stringify({ ...entry, end: Date.now() }) + "\\n");
  if (!overlap) fs.rmSync(log + ".active", { recursive: true, force: true });
}, Number(process.env.FAKE_CLAUDE_MS || "600"));
`;

interface Run { mode: string; session: string; prompt: string; length: number; via: string; argv: string; start: number; end: number; overlap: boolean; pid: number; config: string; lane: string; idd?: string; token?: string; memory: string; apiKey: boolean }

const ENV_KEYS = [
  "IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_CLAUDE_CONFIG_DIR", "IDD_CLAUDE_BIN", "IDD_LANE_SCOPE", "IDD_SYSTEMD_RUN_BIN", "IDD_SYSTEMCTL_BIN",
  "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR", "IDD_LANE_REAL_PATH",
  "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_MS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_REPORT", "FAKE_CLAUDE_UTIL", "ANTHROPIC_API_KEY",
  "FAKE_PI_LOG", "FAKE_PI_MS", "FAKE_PI_MODE", "FAKE_PI_COST", "FAKE_PI_ASK", "FAKE_PI_ASK_WHEN", "FAKE_PI_DIALOG", "FAKE_PI_PRE_MS", "FAKE_PI_POST_MS", "FAKE_PI_BASH", "FAKE_PI_BASH_BYPASS", "IDD_AGENT_TOKEN",
  "PORT", "NODE_ENV", "NEXT_PUBLIC_TEST",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const roots: string[] = [];

afterEach(async () => {
  // let supervisors started by the test finish before their directories go
  await new Promise((r) => setTimeout(r, 200));
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(extraRoles = "") {
  const root = mkdtempSync(join(tmpdir(), "idd-conv-"));
  roots.push(root);
  const state = join(root, "state");
  const cfg = join(root, "claude-cfg");
  const worktree = join(root, "wt");
  for (const d of [state, cfg, worktree]) mkdirSync(d);
  writeFileSync(join(cfg, ".credentials.json"), "{}");
  writeFileSync(join(root, "roles.yaml"), [
    "roles:",
    "  planner-claude: { harness: claude, model: opus, thinking: high, tools: [read, bash, grep, find, ls], report: free, budget_minutes: 5 }",
    extraRoles,
    "pipeline:",
    "  planner: { role: planner-claude }",
  ].join("\n"));
  const fake = join(root, "claude");
  writeFileSync(fake, FAKE_CLAUDE);
  chmodSync(fake, 0o755);
  const log = join(root, "claude.log");
  Object.assign(process.env, {
    IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_CLAUDE_CONFIG_DIR: cfg, IDD_CLAUDE_BIN: fake, IDD_LANE_SCOPE: "off",
    FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MS: "600", FAKE_CLAUDE_COST: "0.25",
  });
  delete process.env.FAKE_CLAUDE_REPORT;
  const lines = <T = Run>(p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);
  return {
    root, cfg, worktree, log,
    starts: () => lines(`${log}.starts`), runs: () => lines(log), attempts: () => lines<{ mode: string; prompt: string }>(`${log}.attempts`),
  };
}

/** a scratch worktree removed with the test's root */
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "idd-conv-wt-"));
  roots.push(d);
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(50);
  }
}

function claudePlan(): ClaudePipelineSpawnPlan {
  const plan = planPipelineSpawn("planner", { prepareAgentDir: () => { throw new Error("a claude slot has no pi agent dir"); } });
  if (plan.harness !== "claude") throw new Error("expected a claude plan");
  return plan;
}

const settled = (sessionId: string) => () => conversationStatus(sessionId).state !== "running";
const lockOf = (laneId: string) => join(laneDir(laneId), "conversation.lock");
const MODULE = resolve(import.meta.dir, "../src/conversation.ts");

describe("an Issue lane's planner / executor on Claude Code", () => {
  test("spawn only claims the conversation; the first deliver starts the supervisor with --session-id, later ones wait and follow with --resume, one at a time", async () => {
    const env = setup();
    const conv = openConversation(claudePlan(), env.worktree);
    expect(conv.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(readPipelineSession(conv.sessionId)).toMatchObject({ harness: "claude", lane_id: conv.laneId, claude_session_id: conv.sessionId, slot: "planner", role: "planner-claude" });
    expect(isConversation(conv.sessionId)).toBe(true);
    expect(pipelineResumeOptions(conv.sessionId)).toEqual({});
    expect(readLane(conv.laneId)).toMatchObject({ mode: "conversation", status: "idle", worktree: env.worktree });
    expect(env.starts()).toEqual([]);
    expect(conversationStatus(conv.sessionId)).toEqual({ state: "unknown" });

    const t0 = Date.now();
    expect(deliverToConversation(conv.sessionId, "brief").launched).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(conversationStatus(conv.sessionId)).toEqual({ state: "running" });

    await until(() => env.starts().length === 1);
    const t1 = Date.now();
    expect(deliverToConversation(conv.sessionId, "second").launched).toBe(false);
    expect(deliverToConversation(conv.sessionId, "third").launched).toBe(false);
    expect(Date.now() - t1).toBeLessThan(300);
    expect(liveConversationIds()).toContain(conv.sessionId);

    await until(settled(conv.sessionId));
    const runs = env.runs();
    expect(runs.map((r) => [r.mode, r.prompt])).toEqual([["session-id", "brief"], ["resume", "second"], ["resume", "third"]]);
    expect(new Set(runs.map((r) => r.session))).toEqual(new Set([conv.sessionId]));
    expect(runs.some((r) => r.overlap)).toBe(false);
    for (let i = 1; i < runs.length; i += 1) expect(runs[i].start).toBeGreaterThanOrEqual(runs[i - 1].end);
    expect(runs[0]).toMatchObject({ config: env.cfg, lane: conv.laneId, memory: "1" });

    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "finished" });
    expect(liveConversationIds()).not.toContain(conv.sessionId);
    expect(queuedMessages(conv.laneId)).toEqual([]);
    expect(readLane(conv.laneId)).toMatchObject({ status: "idle", conversation_started: true });
    expect(readLane(conv.laneId).supervisor_pid).toBeUndefined();
    expect(conversationLockHeld(conv.laneId)).toBe(false);

    // with no supervisor left, a deliver wakes one, and it resumes the same conversation
    expect(deliverToConversation(conv.sessionId, "fourth").launched).toBe(true);
    await until(() => env.runs().length === 4 && settled(conv.sessionId)());
    expect(env.runs()[3]).toMatchObject({ mode: "resume", prompt: "fourth", session: conv.sessionId });
  }, 40_000);

  test("the lane's id and the token from state/agent-token reach every reply's environment, and neither record keeps the token", async () => {
    const env = setup();
    writeFileSync(join(process.env.IDD_STATE_DIR as string, "agent-token"), "token-value\n");
    // the parent process has no token: the supervisor reads the file itself
    delete process.env.IDD_AGENT_TOKEN;
    const conv = openConversation(claudePlan(), env.worktree, { iddId: "IDD-035" });
    expect(readLane(conv.laneId).idd_id).toBe("IDD-035");
    expect(readPipelineSession(conv.sessionId)?.idd_id).toBe("IDD-035");
    expect(JSON.stringify(readLane(conv.laneId))).not.toContain("token-value");
    expect(JSON.stringify(readPipelineSession(conv.sessionId))).not.toContain("token-value");
    deliverToConversation(conv.sessionId, "brief");
    await until(() => env.starts().length === 1);
    const [run] = env.starts();
    expect(run.idd).toBe("IDD-035");
    expect(run.token).toBe("token-value");
    // IDD_LANE_ID stays the runner's lane id, not the Issue lane
    expect(run.lane).toBe(conv.laneId);
    await until(settled(conv.sessionId));
  }, 40_000);

  test("the conversation's cost is what Claude reports last: --resume reports the total so far, not the reply's own", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    const conv = openConversation(claudePlan(), env.worktree);
    for (const m of ["a", "b", "c"]) deliverToConversation(conv.sessionId, m);
    await until(() => env.runs().length === 3 && settled(conv.sessionId)());
    expect(conversationCost(conv.sessionId)).toBe(0.75);
    expect(readLane(conv.laneId).usage?.cost).toBe(0.75);
  }, 40_000);

  test("every reply leaves one consumption row, and a Claude reply's cost is the rise in the total it reported", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    const conv = openConversation(claudePlan(), env.worktree, { iddId: "IDD-035" });
    for (const m of ["a", "b"]) deliverToConversation(conv.sessionId, m);
    await until(() => env.runs().length === 2 && settled(conv.sessionId)());
    const rows = readConsumption();
    expect(rows.length).toBe(2);
    // the resume reports the whole conversation so far, so each reply's own cost is the rise from the reply before
    expect(rows.map((r) => [r.unit, r.cost, r.status])).toEqual([["reply", 0.25, "done"], ["reply", 0.25, "done"]]);
    expect(rows.reduce((a, r) => a + r.cost, 0)).toBeCloseTo(readLane(conv.laneId).usage?.cost ?? 0, 6);
    expect(rows[0]).toMatchObject({ lane: conv.laneId, idd_id: "IDD-035", role: "planner-claude", model: "opus", harness: "claude", contract: "claude" });
    expect(rows[0].provider).toBeUndefined();
    expect(readFileSync(consumptionPath(), "utf8").trim().split("\n").length).toBe(2);
  }, 40_000);

  test("two supervisors started at once never feed the same conversation together", async () => {
    const env = setup();
    const conv = openConversation(claudePlan(), env.worktree);
    for (const m of ["a", "b", "c"]) queueMessage(conv.laneId, m);
    startSupervisor(conv.laneId);
    startSupervisor(conv.laneId);
    await until(() => env.runs().length === 3 && settled(conv.sessionId)());
    await sleep(500);
    const runs = env.runs();
    expect(runs.map((r) => [r.mode, r.prompt])).toEqual([["session-id", "a"], ["resume", "b"], ["resume", "c"]]);
    expect(env.starts().length).toBe(3);
    expect(runs.some((r) => r.overlap)).toBe(false);
    const log = readFileSync(join(laneDir(conv.laneId), "supervisor.log"), "utf8");
    expect(log.match(/holds the conversation/g)?.length).toBe(1);
  }, 40_000);

  test("a lock left by a dead supervisor goes to exactly one of the supervisors taking it at the same moment", async () => {
    setup();
    const conv = openConversation(claudePlan(), scratch());
    const script = join(process.env.IDD_STATE_DIR as string, "take.ts");
    writeFileSync(script, [
      `import { readdirSync, writeFileSync } from "node:fs";`,
      `const { acquireConversationLock } = await import(${JSON.stringify(MODULE)});`,
      "const [laneId, mode, barrierDir] = [process.argv[2], process.argv[3], process.argv[4]];",
      "// every holder is running and lined up before any of them takes the lock: the state the test is about",
      "if (barrierDir) {",
      "  writeFileSync(barrierDir + '/' + process.pid, '');",
      "  const deadline = Date.now() + 20000;",
      "  while (readdirSync(barrierDir).length < 6 && Date.now() < deadline) { /* line up */ }",
      "}",
      "let ok = false; let err = '';",
      "try { ok = acquireConversationLock(laneId); } catch (e) { err = String(e); }",
      "if (mode === 'die') process.exit(0);",
      "// the winner stays alive while the others look: a dead winner would let the next one take the lock",
      "if (ok) await new Promise((r) => setTimeout(r, 1500));",
      "process.stdout.write(JSON.stringify({ ok, err }));",
    ].join("\n"));
    const run = (mode: string, barrierDir = "") => new Promise<string>((res) => {
      const c = spawn("bun", ["run", script, conv.laneId, mode, barrierDir], { env: process.env });
      let s = "";
      c.stdout.on("data", (d) => { s += d; });
      c.on("exit", () => res(s));
    });
    for (let round = 0; round < 8; round += 1) {
      // the lock of a supervisor that died holding it
      await run("die");
      expect(existsSync(lockOf(conv.laneId))).toBe(true);
      expect(conversationLockHeld(conv.laneId)).toBe(false);
      const barrierDir = mkdtempSync(join(tmpdir(), "idd-take-lock-"));
      const outs = (await Promise.all(Array.from({ length: 6 }, () => run("hold", barrierDir)))).map((o) => JSON.parse(o) as { ok: boolean; err: string });
      expect(outs.filter((o) => o.err)).toEqual([]);
      expect(outs.filter((o) => o.ok).length).toBe(1);
    }
  }, 60_000);

  test("a live supervisor keeps the conversation even when its lock looks old (after a suspend)", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "2500";
    const conv = openConversation(claudePlan(), env.worktree);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => env.starts().length === 1);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lockOf(conv.laneId), old, old);
    expect(conversationLockHeld(conv.laneId)).toBe(true);
    expect(conversationStatus(conv.sessionId)).toEqual({ state: "running" });
    expect(deliverToConversation(conv.sessionId, "second").launched).toBe(false);
    await until(() => env.runs().length === 2 && settled(conv.sessionId)());
    expect(env.runs().map((r) => [r.prompt, r.overlap])).toEqual([["brief", false], ["second", false]]);
    expect(conversationTurns(conv.laneId).map((t) => t.n)).toEqual([1, 2]);
  }, 40_000);

  test("the lock belongs to a live process that started when the owner did (a reused pid does not count)", () => {
    setup();
    const conv = openConversation(claudePlan(), scratch());
    expect(acquireConversationLock(conv.laneId)).toBe(true);
    expect(conversationLockHeld(conv.laneId)).toBe(true);
    expect(acquireConversationLock(conv.laneId)).toBe(false);
    releaseConversationLock(conv.laneId);
    expect(conversationLockHeld(conv.laneId)).toBe(false);
    // our own pid, but a start time from another process: a pid reused after the owner died
    writeFileSync(lockOf(conv.laneId), JSON.stringify({ pid: process.pid, start: "1", nonce: "x" }));
    expect(conversationLockHeld(conv.laneId)).toBe(false);
    expect(acquireConversationLock(conv.laneId)).toBe(true);
    releaseConversationLock(conv.laneId);
  });

  test("the message goes to Claude on stdin: an envelope over the argument limit arrives whole, and its token is not on the command line", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    const conv = openConversation(claudePlan(), env.worktree);
    const big = `<token>SECRET-TOKEN-123</token>${"x".repeat(200 * 1024)}`;
    deliverToConversation(conv.sessionId, big);
    await until(() => env.runs().length === 1 && settled(conv.sessionId)());
    const [run] = env.runs();
    expect(run).toMatchObject({ via: "stdin", length: big.length });
    expect(run.argv).not.toContain("SECRET-TOKEN");
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "finished" });
  }, 40_000);

  test("a reply that fails to start at all is recorded with its cause, and the message stays for the resume", async () => {
    const env = setup();
    const conv = openConversation(claudePlan(), env.worktree);
    process.env.IDD_CLAUDE_BIN = join(env.root, "no-such-claude");
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    const status = conversationStatus(conv.sessionId);
    expect(status).toMatchObject({ state: "stopped", cause: "error" });
    expect(status.state === "stopped" && status.error).toMatch(/ENOENT|no-such-claude/);
    expect(readLane(conv.laneId).status).toBe("failed");
    expect(conversationTurns(conv.laneId)).toMatchObject([{ status: "failed", reached: false }]);
    expect(queuedMessages(conv.laneId).length).toBe(1);

    process.env.IDD_CLAUDE_BIN = join(env.root, "claude");
    deliverToConversation(conv.sessionId, "resume brief");
    await until(() => env.runs().length === 2 && settled(conv.sessionId)());
    expect(env.runs().map((r) => [r.mode, r.prompt])).toEqual([["session-id", "brief"], ["resume", "resume brief"]]);
  }, 40_000);

  test("a supervisor that died in the middle of the first reply: the next one knows the conversation exists and does not send that message again", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "4000";
    const conv = openConversation(claudePlan(), env.worktree);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => env.starts().length === 1);
    await sleep(200);
    const rec = readLane(conv.laneId);
    process.kill(rec.supervisor_pid as number, "SIGKILL");
    process.kill(env.starts()[0].pid, "SIGKILL");
    await until(() => !conversationLockHeld(conv.laneId));
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "interrupted" });

    process.env.FAKE_CLAUDE_MS = "100";
    deliverToConversation(conv.sessionId, "next");
    await until(() => env.runs().length === 1 && settled(conv.sessionId)());
    expect(env.attempts().map((a) => [a.mode, a.prompt])).toEqual([["session-id", "brief"], ["resume", "next"]]);
    expect(conversationTurns(conv.laneId).map((t) => [t.n, t.status, t.reached])).toEqual([[1, "failed", true], [2, "done", true]]);
  }, 40_000);

  test("a message moved to inflight by a supervisor that died before writing what it was sending is not lost", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    const conv = openConversation(claudePlan(), env.worktree);
    const dir = laneDir(conv.laneId);
    const name = queueMessage(conv.laneId, "must not be lost");
    mkdirSync(join(dir, "inflight"), { recursive: true });
    renameSync(join(dir, "queue", name), join(dir, "inflight", name));
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "interrupted" });
    await runConversation(conv.laneId);
    expect(env.runs().map((r) => [r.mode, r.prompt])).toEqual([["session-id", "must not be lost"]]);
    expect(conversationTurns(conv.laneId).map((t) => [t.n, t.status])).toEqual([[1, "done"]]);
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "finished" });
  }, 40_000);

  test("a supervisor that died after recording a finished reply, before clearing what it was sending, leaves a finished conversation", async () => {
    const env = setup();
    const conv = openConversation(claudePlan(), env.worktree);
    const dir = laneDir(conv.laneId);
    for (const d of ["inflight", "sent", "turns"]) mkdirSync(join(dir, d), { recursive: true });
    const name = queueMessage(conv.laneId, "answered before the crash");
    renameSync(join(dir, "queue", name), join(dir, "sent", name));
    writeFileSync(join(dir, "turns", "1.jsonl"), `${[
      { type: "system", subtype: "init", session_id: conv.sessionId },
      { type: "result", subtype: "success", is_error: false, result: "answered", total_cost_usd: 0.5, session_id: conv.sessionId },
    ].map((l) => JSON.stringify(l)).join("\n")}\n`);
    const startedAt = new Date(Date.now() - 2000).toISOString();
    appendFileSync(join(dir, "turns.jsonl"), `${JSON.stringify({ n: 1, message: name, resume: false, started_at: startedAt, ended_at: new Date().toISOString(), exit: 0, status: "done", reached: true, reported_cost: 0.5 })}\n`);
    writeFileSync(join(dir, "inflight.json"), JSON.stringify({ n: 1, message: name, resume: false, started_at: startedAt }));
    await runConversation(conv.laneId);
    expect(conversationTurns(conv.laneId).map((t) => [t.n, t.status])).toEqual([[1, "done"]]);
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "finished" });
    expect(conversationCost(conv.sessionId)).toBe(0.5);
    expect(env.starts()).toEqual([]);
  }, 40_000);

  test("a supervisor that died after writing what it would send, before taking it from the queue, leaves it to be sent once", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    const conv = openConversation(claudePlan(), env.worktree);
    const dir = laneDir(conv.laneId);
    const name = queueMessage(conv.laneId, "still queued");
    writeFileSync(join(dir, "inflight.json"), JSON.stringify({ n: 1, message: name, resume: false, started_at: new Date().toISOString() }));
    await runConversation(conv.laneId);
    expect(env.runs().map((r) => r.prompt)).toEqual(["still queued"]);
    expect(conversationTurns(conv.laneId).map((t) => [t.n, t.status])).toEqual([[1, "done"]]);
  }, 40_000);

  test("a conversation Claude already has, though the record says not started, is resumed instead", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    const conv = openConversation(claudePlan(), env.worktree);
    mkdirSync(`${env.log}.sessions`, { recursive: true });
    writeFileSync(`${env.log}.sessions/${conv.sessionId}`, "0");
    deliverToConversation(conv.sessionId, "brief");
    await until(() => env.runs().length === 1 && settled(conv.sessionId)());
    expect(env.attempts().map((a) => a.mode)).toEqual(["session-id", "resume"]);
    expect(env.runs()[0]).toMatchObject({ mode: "resume", prompt: "brief" });
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "finished" });
  }, 40_000);

  test("a conversation penne stopped reads as stopped by a person, not as interrupted, until a new message comes", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "4000";
    const conv = openConversation(claudePlan(), env.worktree);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => env.starts().length === 1);
    await sleep(200);
    stopLane(conv.laneId);
    await until(() => !conversationLockHeld(conv.laneId), 10_000);
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "stopped" });
    expect(conversationStatus(conv.sessionId, Date.now() + 180_000)).toMatchObject({ state: "stopped", cause: "stopped" });
    expect(readLane(conv.laneId).status).toBe("stopped");

    process.env.FAKE_CLAUDE_MS = "100";
    deliverToConversation(conv.sessionId, "go on");
    await until(() => env.runs().length === 1 && settled(conv.sessionId)());
    expect(env.runs()[0]).toMatchObject({ mode: "resume", prompt: "go on" });
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "finished" });
  }, 40_000);

  test("a supervisor that takes the lock after penne stopped the lane sends nothing queued before the stop; a message after it goes on", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    const conv = openConversation(claudePlan(), env.worktree);
    queueMessage(conv.laneId, "brief", Date.now() - 1000);
    // the stop comes while the supervisor is started but has not taken the lock: nobody to send SIGTERM to
    stopLane(conv.laneId);
    await runConversation(conv.laneId);
    expect(env.starts()).toEqual([]);
    expect(queuedMessages(conv.laneId).length).toBe(1);
    expect(readLane(conv.laneId).status).toBe("stopped");
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "stopped" });

    await sleep(5);
    expect(deliverToConversation(conv.sessionId, "go on").launched).toBe(true);
    await until(() => env.runs().length === 2 && settled(conv.sessionId)());
    expect(env.runs().map((r) => r.prompt)).toEqual(["brief", "go on"]);
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "finished" });
  }, 40_000);

  test("a stop that comes while the supervisor has let go of the lock holds back what was queued before it", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    const conv = openConversation(claudePlan(), env.worktree);
    queueMessage(conv.laneId, "first");
    let stopped = false;
    // a message queued, then penne's stop, both at the moment the supervisor lets go (no live owner to signal)
    await runConversation(conv.laneId, { beforeRelease: () => { if (!stopped) { stopped = true; queueMessage(conv.laneId, "late"); markStoppedByUser(laneDir(conv.laneId)); } } });
    expect(env.runs().map((r) => r.prompt)).toEqual(["first"]);
    expect(queuedMessages(conv.laneId).length).toBe(1);
    expect(readLane(conv.laneId).status).toBe("stopped");
  }, 40_000);

  test("a message queued while the supervisor lets go of the conversation is still sent", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    const conv = openConversation(claudePlan(), env.worktree);
    queueMessage(conv.laneId, "first");
    let queued = false;
    // a deliver that saw the lock still held, so it started no supervisor
    await runConversation(conv.laneId, { beforeRelease: () => { if (!queued) { queued = true; queueMessage(conv.laneId, "late"); } } });
    expect(env.runs().map((r) => r.prompt)).toEqual(["first", "late"]);
    expect(queuedMessages(conv.laneId)).toEqual([]);
  }, 40_000);

  test("whether a message still waits for a supervisor is told by the queue's contents, not by comparing times", () => {
    setup();
    const conv = openConversation(claudePlan(), scratch());
    const T = Date.now();
    appendFileSync(join(laneDir(conv.laneId), "turns.jsonl"), `${JSON.stringify({ n: 1, message: "x", resume: false, started_at: new Date(T - 5000).toISOString(), ended_at: new Date(T).toISOString(), status: "done", reached: true })}\n`);
    queueMessage(conv.laneId, "queued in the millisecond the reply ended", T);
    expect(conversationStatus(conv.sessionId, T + 10)).toEqual({ state: "running" });
    expect(conversationStatus(conv.sessionId, T + 5 * 60_000)).toMatchObject({ state: "stopped", cause: "interrupted" });
  });

  test("a lane left with queued messages and no supervisor reads as interrupted once the launch grace has passed", () => {
    setup();
    const conv = openConversation(claudePlan(), scratch());
    queueMessage(conv.laneId, "orphan", Date.now() - 5 * 60_000);
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "interrupted" });
    expect(liveConversationIds()).not.toContain(conv.sessionId);
    queueMessage(conv.laneId, "just now");
    expect(conversationStatus(conv.sessionId)).toEqual({ state: "running" });
    expect(liveConversationIds()).toContain(conv.sessionId);
  });

  test("a pi session is not a conversation, and a conversation cannot be sent to around its queue", async () => {
    setup();
    expect(isConversation("no-such-session")).toBe(false);
    const conv = openConversation(claudePlan(), scratch());
    await expect(sendLane(conv.laneId, "direct")).rejects.toThrow(/会話/);
  });
});

describe("the subscription's windows on a conversation lane", () => {
  const H = 3600;
  const windows = (cfg: string, utilization: number) => recordClaudeQuota(cfg, { status: "allowed", rate_limit_type: "five_hour", windows: { five_hour: { utilization, resets_at: Math.floor(Date.now() / 1000) + H } } });

  test("a spawn over the threshold is a wait, not a failure, and claims nothing", () => {
    const env = setup();
    windows(env.cfg, 0.95);
    let err: unknown;
    try { openConversation(claudePlan(), env.worktree); } catch (e) { err = e; }
    expect(isClaudeQuotaBlocked(err)).toBe(true);
    expect(existsSync(join(process.env.IDD_STATE_DIR as string, "pipeline", "conversations"))).toBe(false);
  });

  test("the first deliver over the threshold starts no Claude; the message waits, the status says why and until when, and it goes once the windows allow", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    const conv = openConversation(claudePlan(), env.worktree);
    windows(env.cfg, 0.95);
    expect(deliverToConversation(conv.sessionId, "brief").launched).toBe(false);
    await sleep(800);
    expect(env.attempts()).toEqual([]);
    expect(queuedMessages(conv.laneId).length).toBe(1);
    const status = conversationStatus(conv.sessionId);
    expect(status).toMatchObject({ state: "quota_wait" });
    expect(status.state === "quota_wait" && status.reason).toMatch(/枠/);
    expect(status.state === "quota_wait" && status.resetsAt).toBeGreaterThan(Date.now() / 1000);
    expect(liveConversationIds()).not.toContain(conv.sessionId);
    expect(await wakeConversation(conv.sessionId)).toBe(false);
    await sleep(300);
    expect(env.attempts()).toEqual([]);

    windows(env.cfg, 0.2);
    expect(await wakeConversation(conv.sessionId)).toBe(true);
    await until(() => env.runs().length === 1 && settled(conv.sessionId)());
    expect(env.runs()[0]).toMatchObject({ mode: "session-id", prompt: "brief" });
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "finished" });
    expect(await wakeConversation(conv.sessionId)).toBe(false);
  }, 40_000);

  test("a reply that reports the windows over the threshold holds the next message back until they allow it", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "800";
    process.env.FAKE_CLAUDE_UTIL = "0.95";
    const conv = openConversation(claudePlan(), env.worktree);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => env.starts().length === 1);
    expect(deliverToConversation(conv.sessionId, "second").launched).toBe(false);
    await until(() => env.runs().length === 1 && settled(conv.sessionId)());
    await sleep(300);
    expect(env.attempts().map((a) => a.prompt)).toEqual(["brief"]);
    expect(queuedMessages(conv.laneId).length).toBe(1);
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "quota_wait" });
    expect(conversationTurns(conv.laneId).map((t) => t.status)).toEqual(["done"]);
    // the reply keeps the windows it reported on its own turn, so a later reply does not replace this measurement
    expect(conversationTurns(conv.laneId)[0].claude_quota).toMatchObject({ status: "allowed", windows: { five_hour: { utilization: 0.95 } }, config_dir: resolve(env.cfg) });

    delete process.env.FAKE_CLAUDE_UTIL;
    windows(env.cfg, 0.2);
    expect(await wakeConversation(conv.sessionId)).toBe(true);
    await until(() => env.runs().length === 2 && settled(conv.sessionId)());
    expect(env.runs()[1]).toMatchObject({ mode: "resume", prompt: "second" });
  }, 40_000);

  test("a conversation's Claude Code runs on the subscription's login, never on an API key of the environment", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    process.env.ANTHROPIC_API_KEY = "sk-should-not-reach";
    const conv = openConversation(claudePlan(), env.worktree);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => env.runs().length === 1 && settled(conv.sessionId)());
    expect(env.runs()[0].apiKey).toBe(false);
  }, 40_000);
});

describe("a short stage on Claude Code still ends on its deliverable", () => {
  function shortLane(env: ReturnType<typeof setup>): { spec: string; report: string } {
    spawnSync("git", ["init", "-q"], { cwd: env.worktree });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: env.worktree });
    const report = join(env.root, "out", "report");
    const spec = join(env.root, "spec.yaml");
    writeFileSync(spec, `role: short-claude\nworktree: ${env.worktree}\nreport: ${report}\ntask: review\n`);
    return { spec, report };
  }
  const roles = "  short-claude: { harness: claude, model: opus, thinking: high, tools: [read, bash], report: review, require_clean: false, max_resumes: 1, budget_minutes: 5 }";

  test("no report: resumed once with the nudge, then failed for the missing deliverable", async () => {
    const env = setup(roles);
    process.env.FAKE_CLAUDE_MS = "100";
    const { spec } = shortLane(env);
    const rec = await runLane(spec, { wait: true });
    expect(rec.status).toBe("failed");
    expect(rec.error).toMatch(/成果物なし/);
    expect(rec.resumes).toBe(1);
    expect(env.runs().map((r) => [r.mode, r.via])).toEqual([["session-id", "argv"], ["resume", "argv"]]);
    expect(env.runs()[1].prompt).toMatch(/成果物/);
  }, 40_000);

  test("a report: done after one reply", async () => {
    const env = setup(roles);
    process.env.FAKE_CLAUDE_MS = "100";
    const { spec, report } = shortLane(env);
    process.env.FAKE_CLAUDE_REPORT = report;
    const rec = await runLane(spec, { wait: true });
    expect(rec.status).toBe("done");
    expect(env.runs().length).toBe(1);
  }, 40_000);
});

describe("a lane started when the slice's limit cannot be set", () => {
  /** stand-ins for systemd-run (records how it was asked, starts nothing) and a systemctl that refuses */
  function fakeSystemd(root: string): { runs: () => string[]; ctl: () => string[] } {
    const runLog = join(root, "systemd-run.log");
    const ctlLog = join(root, "systemctl.log");
    const run = join(root, "systemd-run");
    writeFileSync(run, `#!/bin/sh\necho "$*" >> ${runLog}\nexit 0\n`);
    const ctl = join(root, "systemctl");
    writeFileSync(ctl, `#!/bin/sh\necho "$*" >> ${ctlLog}\necho "Access denied" >&2\nexit 1\n`);
    chmodSync(run, 0o755); chmodSync(ctl, 0o755);
    delete process.env.IDD_LANE_SCOPE;
    Object.assign(process.env, { IDD_SYSTEMD_RUN_BIN: run, IDD_SYSTEMCTL_BIN: ctl });
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : []);
    return { runs: () => read(runLog), ctl: () => read(ctlLog) };
  }
  const warning = "CPU の上限を付け直せなかった（前の起動の上限が残っていればそれが効く）";

  test("an ad-hoc lane (runLane) still starts in the slice, and its supervisor.log says the limit was not set again", async () => {
    const env = setup("  short-claude: { harness: claude, model: opus, thinking: high, tools: [read, bash], report: review, require_clean: false, budget_minutes: 5 }");
    const systemd = fakeSystemd(env.root);
    spawnSync("git", ["init", "-q"], { cwd: env.worktree });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: env.worktree });
    const spec = join(env.root, "spec.yaml");
    writeFileSync(spec, `role: short-claude\nworktree: ${env.worktree}\nreport: ${join(env.root, "out", "report")}\ntask: review\n`);
    const rec = await runLane(spec, { wait: false });
    expect(systemd.ctl()).toEqual(["--user set-property --runtime idd_lanes.slice CPUQuota=1000% CPUWeight=20"]);
    const log = readFileSync(join(laneDir(rec.id), "supervisor.log"), "utf8");
    expect(log).toContain("[slice]");
    expect(log).toContain("Access denied");
    expect(log).toContain(warning);
    await until(() => systemd.runs().some((r) => r.includes(`--slice=idd_lanes.slice`) && r.endsWith(rec.id)));
  });

  test("a conversation's supervisor (startSupervisor) still starts in the slice, and its supervisor.log says the limit was not set again", async () => {
    const env = setup();
    const conv = openConversation(claudePlan(), env.worktree);
    const systemd = fakeSystemd(env.root);
    startSupervisor(conv.laneId);
    expect(systemd.ctl()).toEqual(["--user set-property --runtime idd_lanes.slice CPUQuota=1000% CPUWeight=20"]);
    const log = readFileSync(join(laneDir(conv.laneId), "supervisor.log"), "utf8");
    expect(log).toContain("Access denied");
    expect(log).toContain(warning);
    await until(() => systemd.runs().some((r) => r.includes(`--slice=idd_lanes.slice`) && r.endsWith(conv.laneId)));
  });
});

describe("a conversation's supervisor and the tick", () => {
  const kicks = () => {
    const calls: number[] = [];
    return { calls, kick: () => { calls.push(Date.now()); return { outcome: "scheduled" as const }; } };
  };

  test("asks for a tick after it fed the conversation, once its replies are recorded", async () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    const conv = openConversation(claudePlan(), env.worktree);
    queueMessage(conv.laneId, "brief");
    const k = kicks();
    const { rec, kick } = await superviseLane(conv.laneId, { kick: k.kick });
    expect(k.calls.length).toBe(1);
    expect(kick?.outcome).toBe("scheduled");
    expect(rec.status).toBe("idle");
    expect(conversationTurns(conv.laneId).length).toBe(1);
    expect(k.calls[0]).toBeGreaterThanOrEqual(Date.parse(conversationTurns(conv.laneId)[0].ended_at));
  }, 20_000);

  test("does not ask for one when it fed nothing (an empty queue, or another supervisor holds the conversation)", async () => {
    const env = setup();
    const conv = openConversation(claudePlan(), env.worktree);
    const k = kicks();
    await superviseLane(conv.laneId, { kick: k.kick });
    expect(k.calls).toEqual([]);
    queueMessage(conv.laneId, "brief");
    expect(acquireConversationLock(conv.laneId)).toBe(true);
    try {
      await superviseLane(conv.laneId, { kick: k.kick });
    } finally { releaseConversationLock(conv.laneId); }
    expect(k.calls).toEqual([]);
    expect(env.starts()).toEqual([]);
  }, 20_000);
});

/** one planner message supervised while the bundle's reads fail from the `failsFrom`-th on; `open` makes the lane */
async function superviseWithFailingBundle<E extends { attempts: () => unknown[]; runs: () => { argv?: unknown }[] }>(failsFrom: number, open: () => { env: E; laneId: string }) {
  const { env, laneId } = open();
  bundle.calls = 0;
  bundle.failsFrom = failsFrom;
  try {
    queueMessage(laneId, "brief");
    await superviseLane(laneId, { kick: () => ({ outcome: "scheduled" as const }) });
    const inflight = join(laneDir(laneId), "inflight");
    return { env, queued: queuedMessages(laneId), inflight: existsSync(inflight) ? readdirSync(inflight) : [], turns: conversationTurns(laneId).map((t) => t.status), calls: bundle.calls };
  } finally { bundle.calls = 0; bundle.failsFrom = Infinity; }
}

/** the two checks of a planner's reply reading its bundle once, for whichever harness `supervised` runs */
function bundleReadOnceTests(supervised: (failsFrom: number) => ReturnType<typeof superviseWithFailingBundle>) {
  test("a bundle that cannot be read stops the reply with the message still queued and nothing in flight", async () => {
    const r = await supervised(1);
    expect([r.queued.length, r.inflight, r.env.attempts(), r.turns]).toEqual([1, [], [], ["failed"]]);
  }, 20_000);

  test("a read that would fail the second time is never made: the reply goes out with the bundle read before", async () => {
    const r = await supervised(2);
    expect([r.calls, r.queued, r.env.runs().length, r.turns]).toEqual([1, [], 1, ["done"]]);
    expect(r.env.runs()[0].argv).toContain("--append-system-prompt");
  }, 20_000);
}

describe("a planner's reply reads its norms bundle once, before the message leaves the queue", () => {
  bundleReadOnceTests((failsFrom) => superviseWithFailingBundle(failsFrom, () => {
    const env = setup();
    process.env.FAKE_CLAUDE_MS = "100";
    return { env, laneId: openConversation(claudePlan(), env.worktree).laneId };
  }));
});

/**
 * A stand-in for `pi --mode rpc`: it records how it was started, reads the prompt from stdin, writes the session
 * file where pi keeps a cwd's sessions (so the cost and the record can be read), emits the JSON records the
 * supervisor reads, and appends the reply's own cost to the session record. It waits for an extension dialog when
 * `FAKE_PI_ASK` (an ask batch) or `FAKE_PI_DIALOG` (another dialog) names one. A `--list-models` call answers as
 * pi's catalog would.
 */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes("--list-models")) {
  const q = String(at("--list-models") || "openrouter/z-ai/glm-5.3");
  const parts = q.split("/");
  process.stdout.write(parts[0] + " " + parts.slice(1).join("/") + "\\n");
  process.exit(0);
}
const log = process.env.FAKE_PI_LOG;
const sessionId = at("--session-id");
const entry = {
  session: sessionId, model: at("--model"), thinking: at("--thinking"), message: "", length: 0,
  argv: args.join(" "), cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, lane: process.env.IDD_LANE_ID,
  port: process.env.PORT, nodeEnv: process.env.NODE_ENV, nextTest: process.env.NEXT_PUBLIC_TEST,
  pathFirst: (process.env.PATH || "").split(":")[0],
  approve: args.includes("--approve"), noApprove: args.includes("--no-approve"),
  hasTools: args.includes("--tools"), noExtensions: args.includes("--no-extensions"),
  noSkills: args.includes("--no-skills"), noContext: args.includes("--no-context-files"),
  mode: at("--mode"), start: Date.now(), pid: process.pid,
};
let overlap = false;
try { fs.mkdirSync(log + ".active"); } catch { overlap = true; }
entry.overlap = overlap;
fs.appendFileSync(log + ".starts", JSON.stringify(entry) + "\\n");
const agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = process.cwd();
const safe = "--" + cwd.replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--";
const sessionDir = path.join(agentDir, "sessions", safe);
fs.mkdirSync(sessionDir, { recursive: true });
const file = path.join(sessionDir, "2026-01-01T00-00-00-000Z_" + sessionId + ".jsonl");
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const finish = () => {
  if (process.env.FAKE_PI_MODE === "error") {
    fs.appendFileSync(file, JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "failed" }], stopReason: "error", errorMessage: "provider 429" } }) + "\\n");
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "failed" }] } });
    out({ type: "turn_end" });
  } else {
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: Number(process.env.FAKE_PI_COST || "0.25") } };
    fs.appendFileSync(file, JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "answered" }], usage } }) + "\\n");
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answered" }], usage } });
    out({ type: "turn_end" });
  }
  out({ type: "agent_end" });
  out({ type: "agent_settled" });
  fs.appendFileSync(log, JSON.stringify({ ...entry, end: Date.now() }) + "\\n");
  if (!overlap) fs.rmSync(log + ".active", { recursive: true, force: true });
};
let replied = false;
let awaitingUi = false;
// when FAKE_PI_BASH names a command, the reply runs one bash tool call first, as pi's own bash tool does: through the
// agent dir's settings shellPath (unless FAKE_PI_BASH_BYPASS says to use /bin/bash and skip the shell)
const runBash = (command, done) => {
  const bypass = process.env.FAKE_PI_BASH_BYPASS ? "/bin/bash" : (JSON.parse(fs.readFileSync(agentDir + "/settings.json", "utf8")).shellPath || "/bin/bash");
  out({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command } });
  const child = spawn(bypass, ["-c", command], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout.on("data", (d) => { text += d.toString(); });
  child.stderr.on("data", (d) => { text += d.toString(); });
  child.on("exit", (code) => {
    out({ type: "tool_execution_end", toolCallId: "b1", toolName: "bash", result: { exit: code, out: text } });
    done();
  });
};
const handle = (rec) => {
  if (rec.type === "prompt" && !replied) {
    replied = true;
    const message = String(rec.message || "");
    entry.message = message.slice(0, 40); entry.length = message.length;
    fs.appendFileSync(file, JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: message }] } }) + "\\n");
    out({ id: rec.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    out({ type: "agent_start" });
    const pre = Number(process.env.FAKE_PI_PRE_MS || process.env.FAKE_PI_MS || "300");
    setTimeout(() => {
      const askMap = process.env.FAKE_PI_ASK_MAP ? JSON.parse(process.env.FAKE_PI_ASK_MAP) : null;
      const askKey = askMap ? Object.keys(askMap).find((k) => message.includes(k)) : undefined;
      const ask = askMap ? (askKey ? askMap[askKey] : undefined) : process.env.FAKE_PI_ASK;
      const dialog = process.env.FAKE_PI_DIALOG;
      const when = process.env.FAKE_PI_ASK_WHEN;
      if (ask && (!when || message.includes(when))) {
        awaitingUi = true;
        out({ type: "extension_ui_request", id: "ui-1", method: "input", title: JSON.stringify({ idd: "ask", batch_id: ask }), placeholder: "which?" });
        return;
      }
      if (dialog) {
        awaitingUi = true;
        out({ type: "extension_ui_request", id: "ui-1", method: dialog, title: "Allow?", options: ["Allow", "Block"] });
        return;
      }
      const bash = process.env.FAKE_PI_BASH;
      if (bash) { runBash(bash, finish); return; }
      finish();
    }, pre);
    return;
  }
  if (rec.type === "extension_ui_response") {
    entry.ui_response = rec;
    awaitingUi = false;
    const post = Number(process.env.FAKE_PI_POST_MS || "0");
    setTimeout(finish, post);
    return;
  }
  if (rec.type === "abort") { entry.aborted = true; return; }
};
let buffer = "";
process.stdin.on("data", (d) => {
  buffer += d.toString("utf8");
  for (;;) {
    const i = buffer.indexOf("\\n");
    if (i < 0) break;
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
});
process.stdin.on("end", () => { setTimeout(() => process.exit(0), 20); });
`;

interface PiRun {
  session: string; model: string; thinking: string; message: string; length: number; argv: string; cwd: string;
  agentDir: string; lane: string; port?: string; nodeEnv?: string; nextTest?: string; pathFirst: string;
  approve: boolean; noApprove: boolean; hasTools: boolean; noExtensions: boolean; noSkills: boolean; noContext: boolean;
  mode?: string; ui_response?: { id: string; value?: string; cancelled?: boolean; confirmed?: boolean }; aborted?: boolean;
  start: number; end: number; overlap: boolean; pid: number;
}

function piFixture(planner = "  planner-pi: { model: glm-5.3, thinking: high, tools: [read, bash], report: free, budget_minutes: 5 }", roleName = "planner-pi", defaultsLines = "  thinking: medium") {
  const root = mkdtempSync(join(tmpdir(), "idd-pi-"));
  roots.push(root);
  const state = join(root, "state");
  const worktree = join(root, "wt");
  const userAgent = join(root, "user-agent");
  for (const d of [state, worktree, userAgent]) mkdirSync(d);
  writeFileSync(join(root, "roles.yaml"), [
    "defaults:", defaultsLines, "models:", "  glm-5.3:", "    model: openrouter/z-ai/glm-5.3", "roles:", planner, "pipeline:", `  planner: { role: ${roleName} }`,
  ].join("\n") + "\n");
  const fake = join(root, "pi");
  writeFileSync(fake, FAKE_PI);
  chmodSync(fake, 0o755);
  const log = join(root, "pi.log");
  Object.assign(process.env, {
    IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_PI_BIN: fake, IDD_PI_USER_AGENT_DIR: userAgent,
    IDD_LANE_SCOPE: "off", FAKE_PI_LOG: log, FAKE_PI_MS: "300",
    PORT: "30142", NODE_ENV: "production", NEXT_PUBLIC_TEST: "x",
  });
  delete process.env.FAKE_PI_MODE;
  delete process.env.FAKE_PI_ASK;
  delete process.env.FAKE_PI_ASK_MAP;
  delete process.env.FAKE_PI_ASK_WHEN;
  delete process.env.FAKE_PI_DIALOG;
  delete process.env.FAKE_PI_PRE_MS;
  delete process.env.FAKE_PI_POST_MS;
  delete process.env.FAKE_PI_BASH;
  delete process.env.FAKE_PI_BASH_BYPASS;
  const lines = <T>(p: string): T[] => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);
  return {
    root, state, worktree, userAgent, log,
    starts: () => lines<PiRun>(log + ".starts"), runs: () => lines<PiRun>(log),
  };
}

/** a conversation for the fixture's planner slot, claimed but not yet given a message */
function openPiConversation(env: ReturnType<typeof piFixture>) {
  const plan = planPipelineSpawn("planner", { checkStartable: () => {} });
  if (plan.harness !== "pi") throw new Error("expected a pi plan");
  const conv = openConversation(plan, env.worktree);
  return { ...conv, agentDir: plan.agentDir, roleDir: join(env.state, "pipeline", "agent", plan.role) };
}

/** the answer's body as the engine writes it: the batch's id and the question's id are in the body alone */
function answerEnvelope(batchId: string, questionId = "q1", label = "A"): string {
  return [
    "<propter-system-message>",
    "  <context>",
    `  <answers batch-id="${batchId}">`,
    `    <qa-pair question-id="${questionId}">`,
    "      <question>Q</question>",
    `      <selection index="1">${label}</selection>`,
    "    </qa-pair>",
    "  </answers>",
    "  </context>",
    "</propter-system-message>",
  ].join("\n");
}

describe("an Issue lane's planner / executor on pi", () => {
  test("spawn claims the session and starts nothing; the first deliver starts the supervisor, one reply at a time, all on the same session", async () => {
    const env = piFixture();
    const conv = openPiConversation(env);
    expect(readPipelineSession(conv.sessionId)).toMatchObject({ harness: "pi", lane_id: conv.laneId, slot: "planner", role: "planner-pi" });
    expect(isConversation(conv.sessionId)).toBe(true);
    expect(pipelineResumeOptions(conv.sessionId)).toEqual({});
    expect(readLane(conv.laneId)).toMatchObject({ mode: "conversation", status: "idle", worktree: env.worktree });
    // nothing started by the spawn itself: no pi session lives in the server's process
    expect(env.starts()).toEqual([]);
    expect(conversationStatus(conv.sessionId)).toEqual({ state: "unknown" });

    const t0 = Date.now();
    expect(deliverToConversation(conv.sessionId, "brief").launched).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(conversationStatus(conv.sessionId)).toEqual({ state: "running" });
    await until(() => env.starts().length === 1);
    // a message that arrives while the reply runs waits for it
    expect(deliverToConversation(conv.sessionId, "second").launched).toBe(false);
    await until(settled(conv.sessionId));
    const runs = env.runs();
    expect(runs.map((r) => [r.message, r.length])).toEqual([["brief", 5], ["second", 6]]);
    expect(new Set(runs.map((r) => r.session))).toEqual(new Set([conv.sessionId]));
    expect(runs.some((r) => r.overlap)).toBe(false);
    for (let i = 1; i < runs.length; i += 1) expect(runs[i].start).toBeGreaterThanOrEqual(runs[i - 1].end);
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "finished" });
  }, 40_000);

  test("the reply starts as the server-internal one did: the role's agent dir, the default tools, the record's model and thinking, the shim first on PATH", async () => {
    const env = piFixture();
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    const [run] = env.starts();
    expect(run).toMatchObject({
      agentDir: conv.agentDir,
      model: "openrouter/z-ai/glm-5.3",
      thinking: "high",
      cwd: env.worktree,
      lane: conv.laneId,
      hasTools: false,
      noExtensions: false,
      noSkills: false,
      noContext: false,
      pathFirst: join(process.env.IDD_STATE_DIR as string, "lanes", "shim"),
    });
    // the role dir is the pipeline's shared one, a view of the user's (auth and extensions linked)
    expect(run.agentDir).toBe(join(env.state, "pipeline", "agent", "planner-pi"));
    // no trust recorded: the flag is --no-approve, as the UI's own server-internal start would decide
    expect(run.noApprove).toBe(true);
    expect(run.approve).toBe(false);
    // the norms it was given are copied into the run's record, the very text on its command line
    const norms = stageSystemPrompts("planner").join("\n\n");
    expect([norms.length > 0, run.argv.includes(norms), readContextSnapshots(laneDir(conv.laneId)).map((snap) => [snap.turn, snap.addendum === norms])]).toEqual([true, true, [[1, true]]]);
  }, 40_000);

  test("the trust flag follows the record: a trusted cwd is --approve", async () => {
    const env = piFixture();
    writeFileSync(join(env.userAgent, "trust.json"), JSON.stringify({ [realpathSync(env.worktree)]: true }));
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    const [run] = env.starts();
    expect(run.approve).toBe(true);
    expect(run.noApprove).toBe(false);
  }, 40_000);

  test("the reply's environment drops the server's PORT / NODE_ENV / NEXT_*, and keeps the lane's id", async () => {
    const env = piFixture();
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    const [run] = env.starts();
    expect(run.port).toBeUndefined();
    expect(run.nodeEnv).toBeUndefined();
    expect(run.nextTest).toBeUndefined();
    expect(run.lane).toBe(conv.laneId);
  }, 40_000);

  test("a reply that fails is recorded with the session record's reason", async () => {
    const env = piFixture();
    process.env.FAKE_PI_MODE = "error";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    expect(conversationTurns(conv.laneId)).toMatchObject([{ status: "failed", reached: true, error: expect.stringMatching(/429/) }]);
    const status = conversationStatus(conv.sessionId);
    expect(status).toMatchObject({ state: "stopped", cause: "error" });
    expect(status.state === "stopped" && status.error).toMatch(/429/);
  }, 40_000);

  test("a supervisor killed in the middle of a reply leaves the lane interrupted, and the next deliver continues the session", async () => {
    const env = piFixture();
    process.env.FAKE_PI_MS = "4000";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => env.starts().length === 1);
    await sleep(200);
    const rec = readLane(conv.laneId);
    process.kill(rec.supervisor_pid as number, "SIGKILL");
    process.kill(env.starts()[0].pid, "SIGKILL");
    await until(() => !conversationLockHeld(conv.laneId));
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "interrupted" });

    process.env.FAKE_PI_MS = "100";
    deliverToConversation(conv.sessionId, "next");
    await until(() => env.runs().length >= 1 && settled(conv.sessionId)());
    const runs = env.runs();
    expect(runs[runs.length - 1]).toMatchObject({ session: conv.sessionId, message: "next" });
    expect(conversationStatus(conv.sessionId)).toMatchObject({ state: "stopped", cause: "finished" });
  }, 40_000);

  test("the cost is the session record's total, not what a single reply reported", async () => {
    const env = piFixture();
    process.env.FAKE_PI_MS = "80";
    const conv = openPiConversation(env);
    for (const m of ["a", "b", "c"]) deliverToConversation(conv.sessionId, m);
    await until(() => env.runs().length === 3 && settled(conv.sessionId)());
    expect(conversationCost(conv.sessionId)).toBe(0.75);
    expect(readLane(conv.laneId).usage?.cost).toBe(0.75);
  }, 40_000);

  test("a reply that runs past the role's budget is cut and recorded as a timeout", async () => {
    const env = piFixture("  tight-pi: { model: glm-5.3, thinking: high, tools: [read], report: free, budget_minutes: 0.001 }", "tight-pi");
    process.env.FAKE_PI_MS = "5000";
    const conv = openPiConversation(env);
    queueMessage(conv.laneId, "brief");
    await runConversation(conv.laneId, { replyFloorMs: 150 });
    const [turn] = conversationTurns(conv.laneId);
    expect(turn.status).toBe("timeout");
    expect(turn.error).toMatch(/予算/);
    expect(env.starts().length).toBe(1);
  }, 40_000);

  test("a planner / executor pi session from before the switch-over is taken over with its own session id and the delivery's worktree", async () => {
    const env = piFixture();
    const id = "legacy-planner-session";
    const file = join(env.root, "legacy.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd: env.worktree }) + "\n");
    recordPipelineSession(id, { slot: "planner", role: "planner-pi", model: "openrouter/z-ai/glm-5.3", thinkingLevel: "high", agentDir: join(env.state, "pipeline", "agent", "planner-pi") });
    expect(isSupervisedPipelineSession(id)).toBe(true);
    expect(isConversation(id)).toBe(false);

    // the session record's own cwd is the fallback when the delivery brings none
    const adopted = adoptPipelineConversation(id, { sessionFile: file });
    expect(isConversation(id)).toBe(true);
    expect(adopted.sessionId).toBe(id);
    expect(readLane(adopted.laneId).worktree).toBe(env.worktree);

    // a delivery with a cwd of its own wins
    const other = join(env.root, "other-wt");
    mkdirSync(other);
    const id2 = "legacy-planner-2";
    recordPipelineSession(id2, { slot: "executor", role: "planner-pi", model: "openrouter/z-ai/glm-5.3", thinkingLevel: "high", agentDir: "" });
    const adopted2 = adoptPipelineConversation(id2, { cwd: other });
    expect(readLane(adopted2.laneId).worktree).toBe(other);

    // neither: there is nowhere to run it, and the delivery fails
    const id3 = "legacy-planner-3";
    recordPipelineSession(id3, { slot: "planner", role: "planner-pi", model: "openrouter/z-ai/glm-5.3", thinkingLevel: "high", agentDir: "" });
    expect(() => adoptPipelineConversation(id3, {})).toThrow(/worktree/);
    expect(isConversation(id3)).toBe(false);

    // every reply of the adopted session runs with the spawn record's thinking, not the role's current one
    const id4 = "legacy-planner-4";
    recordPipelineSession(id4, { slot: "planner", role: "planner-pi", model: "openrouter/z-ai/glm-5.3", thinkingLevel: "low", agentDir: "" });
    const adopted4 = adoptPipelineConversation(id4, { cwd: other });
    const rec4 = readLane(adopted4.laneId);
    expect(rec4.role_preset?.thinking).toBe("low");
    const args = piConversationArgs(rec4, id4, []);
    expect(args[args.indexOf("--thinking") + 1]).toBe("low");
  });

  test("a session taken over keeps the lane it belongs to, so its replies still carry the report environment", () => {
    const env = piFixture();
    const id = "legacy-planner-with-lane";
    // the engine's callback token, as the engine leaves it before any spawn
    delete process.env.IDD_AGENT_TOKEN;
    writeFileSync(join(env.state, "agent-token"), "report-token\n");
    recordPipelineSession(id, { slot: "planner", role: "planner-pi", model: "openrouter/z-ai/glm-5.3", thinkingLevel: "high", agentDir: "" }, "IDD-1");
    const adopted = adoptPipelineConversation(id, { cwd: env.worktree });
    const lane = readLane(adopted.laneId);
    // the lane the session belongs to rides along into the lane record and back into the spawn record
    expect(lane.idd_id).toBe("IDD-1");
    expect(readPipelineSession(id)?.idd_id).toBe("IDD-1");
    // so every reply of the adopted session can report as the lane (the CLI refuses without these)
    const replyEnv = piConversationEnv(lane, lane.role_preset as NonNullable<typeof lane.role_preset>);
    expect(replyEnv.IDD_ID).toBe("IDD-1");
    expect(replyEnv.IDD_AGENT_TOKEN).toBe("report-token");
    // and the token is read per reply, never written to the lane record
    expect(JSON.stringify(lane)).not.toContain("report-token");
  });

  test("a mode session is not the engine's, and its in-process resume is unchanged", () => {
    const env = piFixture();
    recordPipelineSession("mode-1", { slot: "mode:chat", role: "planner-pi", model: "openrouter/z-ai/glm-5.3", thinkingLevel: "high", agentDir: join(env.state, "pipeline", "agent", "planner-pi") });
    expect(isSupervisedPipelineSession("mode-1")).toBe(false);
    expect(isConversation("mode-1")).toBe(false);
  });

  test("a worktree with a running conversation counts as busy, and stops counting once it settles", async () => {
    const env = piFixture();
    process.env.FAKE_PI_MS = "800";
    const conv = openPiConversation(env);
    expect(conversationBusyAt(env.worktree)).toBe(false);
    deliverToConversation(conv.sessionId, "brief");
    expect(conversationBusyAt(env.worktree)).toBe(true);
    expect(liveConversationIds()).toContain(conv.sessionId);
    await until(settled(conv.sessionId));
    expect(conversationBusyAt(env.worktree)).toBe(false);
    expect(liveConversationIds()).not.toContain(conv.sessionId);
  }, 40_000);

  test("the sidebar's running list keeps to pi conversations, while the busy check and the UI's list count both", () => {
    const env = piFixture();
    const pi = openPiConversation(env);
    queueMessage(pi.laneId, "brief");
    // a claude conversation running at the same time
    const claudeSession = "claude-executor-session";
    const claudeLane = "2026-01-01-000001-executor-claude";
    const claudeRole = { name: "executor-claude", harness: "claude", model: "opus", thinking: "high", tools: [], policy: [], report: "free", requireClean: false, budgetMinutes: 90, contextFiles: true, maxResumes: 0 };
    mkdirSync(laneDir(claudeLane), { recursive: true });
    writeFileSync(join(laneDir(claudeLane), "lane.json"), JSON.stringify({
      id: claudeLane, role: "executor-claude", model: "opus", worktree: env.worktree, spec: "", report: "",
      status: "idle", started_at: new Date().toISOString(), session_file: claudeSession, mode: "conversation", role_preset: claudeRole,
    }));
    queueMessage(claudeLane, "brief");
    mkdirSync(join(process.env.IDD_STATE_DIR as string, "pipeline", "conversations"), { recursive: true });
    writeFileSync(join(process.env.IDD_STATE_DIR as string, "pipeline", "conversations", claudeSession), claudeLane);

    // the UI's screens and the busy-worktree check count both harnesses
    expect(liveConversationIds()).toContain(pi.sessionId);
    expect(liveConversationIds()).toContain(claudeSession);
    expect(conversationBusyAt(env.worktree)).toBe(true);
    // the sidebar lists pi sessions only: a claude id there would re-read the list and sound the completion tone
    expect(livePiConversationIds()).toContain(pi.sessionId);
    expect(livePiConversationIds()).not.toContain(claudeSession);
  });

  test("the conversation's supervisor runs in the lane slice, and keeps the server's PORT for the tick", async () => {
    const env = piFixture();
    const conv = openPiConversation(env);
    const runLog = join(env.root, "systemd-run.log");
    const fake = join(env.root, "systemd-run");
    writeFileSync(fake, `#!/bin/sh\n{ echo "$*"; env | grep -E '^(PORT|NODE_ENV|NEXT_PUBLIC_TEST)=' | sort; } >> ${runLog}\nexit 0\n`);
    chmodSync(fake, 0o755);
    delete process.env.IDD_LANE_SCOPE;
    process.env.IDD_SYSTEMD_RUN_BIN = fake;
    startSupervisor(conv.laneId);
    await until(() => existsSync(runLog) && readFileSync(runLog, "utf8").includes("--slice=idd_lanes.slice"));
    const logged = readFileSync(runLog, "utf8");
    expect(logged).toContain(`--slice=idd_lanes.slice`);
    expect(logged).toContain("PORT=30142");
    expect(logged).toContain("NODE_ENV=production");
  }, 20_000);

  test("an ask question waits for the answer's message, gets it as the tool's result in the same reply, and leaves the queue", async () => {
    const env = piFixture();
    process.env.FAKE_PI_ASK = "b1";
    process.env.FAKE_PI_MS = "80";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => readLane(conv.laneId).question_wait?.batch_id === "b1");
    // the record carries the batch while the reply waits, and the conversation counts as running
    expect(readLane(conv.laneId).question_wait).toMatchObject({ batch_id: "b1" });
    expect(conversationStatus(conv.sessionId)).toEqual({ state: "running" });
    const answerName = queueMessage(conv.laneId, answerEnvelope("b1"));
    await until(settled(conv.sessionId));
    const [run] = env.runs();
    // the answer's whole body is what pi got, with the batch and the question's id in it
    expect(run.ui_response).toMatchObject({ id: "ui-1" });
    expect(run.ui_response?.value).toContain('<answers batch-id="b1">');
    expect(run.ui_response?.value).toContain('question-id="q1"');
    // one reply, done, with the wait written on it; the answer left the queue and the wait is cleared
    const turns = conversationTurns(conv.laneId);
    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe("done");
    expect(turns[0].question_waits).toMatchObject([{ batch_id: "b1" }]);
    expect(readLane(conv.laneId).question_wait).toBeUndefined();
    expect(queuedMessages(conv.laneId)).not.toContain(answerName);
    expect(existsSync(join(laneDir(conv.laneId), "sent", answerName))).toBe(true);
  }, 40_000);

  test("the answer's message leaves the queue only after pi has it", async () => {
    const env = piFixture();
    process.env.FAKE_PI_ASK = "b1";
    process.env.FAKE_PI_MS = "80";
    const conv = openPiConversation(env);
    queueMessage(conv.laneId, "brief");
    const answerName = queueMessage(conv.laneId, answerEnvelope("b1"));
    let queuedAtHandover: string[] = [];
    await runConversation(conv.laneId, { replyFloorMs: 10_000, afterAnswer: () => { queuedAtHandover = queuedMessages(conv.laneId); } });
    expect(queuedAtHandover).toContain(answerName);
    expect(queuedMessages(conv.laneId)).not.toContain(answerName);
    expect(env.runs()[0].ui_response?.value).toContain('<answers batch-id="b1">');
  }, 40_000);

  test("another message that arrives during the wait is not handed over: the answer ends this reply, and the rest flows after it", async () => {
    const env = piFixture();
    process.env.FAKE_PI_ASK = "b1";
    process.env.FAKE_PI_ASK_WHEN = "brief";
    process.env.FAKE_PI_MS = "80";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => readLane(conv.laneId).question_wait?.batch_id === "b1");
    const other = answerEnvelope("b2");
    deliverToConversation(conv.sessionId, "other");
    deliverToConversation(conv.sessionId, other);
    await sleep(150);
    expect(env.runs()).toHaveLength(0);
    deliverToConversation(conv.sessionId, answerEnvelope("b1"));
    // the mark names the first message alone: the replies that follow must not ask again
    await until(() => env.runs().length >= 1 && settled(conv.sessionId)());
    expect(env.runs()[0].ui_response?.value).toContain('<answers batch-id="b1">');
    await until(() => env.runs().length === 3);
    // the leftover messages become their own replies, in queue order
    expect(env.runs().slice(1).map((r) => r.length)).toEqual([5, other.length]);
  }, 40_000);

  test("a reply cut by a person cancels the question and is recorded as stopped", async () => {
    const env = piFixture();
    process.env.FAKE_PI_ASK = "b1";
    process.env.FAKE_PI_MS = "80";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => readLane(conv.laneId).question_wait?.batch_id === "b1");
    process.kill(readLane(conv.laneId).supervisor_pid as number, "SIGTERM");
    await until(() => conversationTurns(conv.laneId).length === 1 && env.runs().length >= 1);
    expect(conversationTurns(conv.laneId)[0].status).toBe("stopped");
    expect(env.runs()[0].ui_response).toMatchObject({ cancelled: true });
  }, 40_000);

  test("a supervisor and pi killed during the wait leave the answer queued; the next reply delivers it", async () => {
    const env = piFixture();
    process.env.FAKE_PI_ASK = "b1";
    process.env.FAKE_PI_MS = "80";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => readLane(conv.laneId).question_wait?.batch_id === "b1");
    const rec = readLane(conv.laneId);
    process.kill(rec.supervisor_pid as number, "SIGKILL");
    process.kill(env.starts()[0].pid, "SIGKILL");
    await until(() => !conversationLockHeld(conv.laneId));
    delete process.env.FAKE_PI_ASK;
    process.env.FAKE_PI_MS = "60";
    // the answer arrives after the supervisor is gone; the next deliver starts a new one and feeds the answer
    deliverToConversation(conv.sessionId, answerEnvelope("b1"), "question_batch_answered");
    await until(() => conversationTurns(conv.laneId).some((t) => t.status === "done"));
    const turns = conversationTurns(conv.laneId);
    expect(turns.some((t) => t.status === "failed" && t.reached === true)).toBe(true);
  }, 40_000);

  test("pi dying during the wait ends the question and leaves the answer for the next reply", async () => {
    const env = piFixture();
    process.env.FAKE_PI_ASK = "b1";
    process.env.FAKE_PI_MS = "80";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => readLane(conv.laneId).question_wait?.batch_id === "b1");
    // only pi dies: the supervisor stays, and the reply's wait must end with it
    process.kill(env.starts()[0].pid, "SIGKILL");
    await until(() => conversationTurns(conv.laneId).length === 1);
    await until(() => readLane(conv.laneId).question_wait === undefined, 3_000);
    delete process.env.FAKE_PI_ASK;
    process.env.FAKE_PI_MS = "60";
    const answerName = queueMessage(conv.laneId, answerEnvelope("b1"));
    await sleep(300);
    // the answer waits for the next reply: the dead reply's wait loop does not move it to sent
    expect(queuedMessages(conv.laneId)).toContain(answerName);
    expect(existsSync(join(laneDir(conv.laneId), "sent", answerName))).toBe(false);
    // the next reply takes it as its message
    await until(() => !conversationLockHeld(conv.laneId));
    await runConversation(conv.laneId);
    expect(queuedMessages(conv.laneId)).not.toContain(answerName);
    expect(existsSync(join(laneDir(conv.laneId), "sent", answerName))).toBe(true);
  }, 40_000);

  test("a dying reply's wait does not swallow a later answer or clear another reply's wait", async () => {
    const env = piFixture();
    process.env.FAKE_PI_ASK_MAP = JSON.stringify({ brief: "b1", other: "b2" });
    process.env.FAKE_PI_MS = "80";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => readLane(conv.laneId).question_wait?.batch_id === "b1");
    // a second message waits behind the first reply: the supervisor stays and feeds it as soon as pi dies
    queueMessage(conv.laneId, "other");
    process.kill(env.starts()[0].pid, "SIGKILL");
    await until(() => readLane(conv.laneId).question_wait?.batch_id === "b2");
    // the first reply's wait loop is over: the answer to b1 stays queued, and b2's wait is left alone
    const answerName = queueMessage(conv.laneId, answerEnvelope("b1"));
    await sleep(300);
    expect(readLane(conv.laneId).question_wait?.batch_id).toBe("b2");
    expect(queuedMessages(conv.laneId)).toContain(answerName);
    expect(existsSync(join(laneDir(conv.laneId), "sent", answerName))).toBe(false);
    // the second reply still gets its own answer and finishes
    delete process.env.FAKE_PI_ASK_MAP;
    queueMessage(conv.laneId, answerEnvelope("b2"));
    await until(() => conversationTurns(conv.laneId).some((t) => t.question_waits?.some((w) => w.batch_id === "b2")));
  }, 40_000);

  test("a question the reply cannot wait for sends the harness's dialog back at once, and the reply goes on", async () => {
    const env = piFixture();
    process.env.FAKE_PI_DIALOG = "select";
    process.env.FAKE_PI_MS = "80";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    expect(env.runs()[0].ui_response).toMatchObject({ cancelled: true });
    expect(conversationTurns(conv.laneId)[0].status).toBe("done");
  }, 40_000);

  test("the wait is outside the reply's budget: a long wait ends done", async () => {
    const env = piFixture("  tight-pi: { model: glm-5.3, thinking: high, tools: [read], report: free, budget_minutes: 0.001 }", "tight-pi");
    process.env.FAKE_PI_ASK = "b1";
    process.env.FAKE_PI_MS = "60";
    const conv = openPiConversation(env);
    queueMessage(conv.laneId, "brief");
    const draining = runConversation(conv.laneId, { replyFloorMs: 400 });
    await until(() => readLane(conv.laneId).question_wait?.batch_id === "b1");
    await sleep(700);
    queueMessage(conv.laneId, answerEnvelope("b1"));
    await draining;
    expect(conversationTurns(conv.laneId)[0].status).toBe("done");
  }, 40_000);

  test("the time outside the wait still has a bound: a reply that works past the budget is cut", async () => {
    const env = piFixture("  tight-pi: { model: glm-5.3, thinking: high, tools: [read], report: free, budget_minutes: 0.001 }", "tight-pi");
    process.env.FAKE_PI_ASK = "b1";
    process.env.FAKE_PI_PRE_MS = "120";
    process.env.FAKE_PI_POST_MS = "600";
    const conv = openPiConversation(env);
    queueMessage(conv.laneId, "brief");
    const draining = runConversation(conv.laneId, { replyFloorMs: 400 });
    await until(() => readLane(conv.laneId).question_wait?.batch_id === "b1");
    queueMessage(conv.laneId, answerEnvelope("b1"));
    await draining;
    expect(conversationTurns(conv.laneId)[0].status).toBe("timeout");
  }, 40_000);

  test("an answer without a kind record, in a queue whose kinds map is over its cap, is still found by the batch in the body", async () => {
    const env = piFixture();
    process.env.FAKE_PI_ASK = "b1";
    process.env.FAKE_PI_MS = "80";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(() => readLane(conv.laneId).question_wait?.batch_id === "b1");
    // no kind is written for the answer, and the display map is filled past its 200-name cap
    const answerName = queueMessage(conv.laneId, answerEnvelope("b1"));
    const kinds: Record<string, string> = {};
    for (let i = 0; i < 205; i += 1) kinds[`filler-${String(i).padStart(3, "0")}`] = "progress";
    writeFileSync(join(laneDir(conv.laneId), "message-types.json"), JSON.stringify(kinds));
    await until(settled(conv.sessionId));
    expect(env.runs()[0].ui_response?.value).toContain('<answers batch-id="b1">');
    expect(queuedMessages(conv.laneId)).not.toContain(answerName);
  }, 40_000);
});

describe("a planner's reply on pi reads its norms bundle once, before the message leaves the queue", () => {
  bundleReadOnceTests((failsFrom) => superviseWithFailingBundle(failsFrom, () => {
    const env = piFixture();
    process.env.FAKE_PI_MS = "100";
    return { env: { ...env, attempts: () => env.starts() }, laneId: openPiConversation(env).laneId };
  }));
});

describe("a pi conversation's bash tool calls run under the lane's shell", () => {
  /** the exit one reply's first bash tool call reported, read from the reply's own stream */
  function firstBashExit(laneId: string, n = 1): number | undefined {
    const p = join(laneDir(laneId), "turns", `${n}.jsonl`);
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line) as { type?: string; toolName?: string; result?: { exit?: number } };
      if (ev.type === "tool_execution_end" && ev.toolName === "bash") return ev.result?.exit;
    }
    return undefined;
  }

  test("a call that does not end is cut at the lane's limit, the reply goes on, and the cut is recorded per reply and on the lane", async () => {
    const env = piFixture(undefined, undefined, "  thinking: medium\n  tool_timeout_minutes: 0.02");
    process.env.FAKE_PI_BASH = "echo waiting for the device; sleep 60";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    const turns = conversationTurns(conv.laneId);
    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe("done");
    expect(turns[0].tool_timeouts).toBe(1);
    expect(readLane(conv.laneId).tool_timeouts).toBe(1);
    expect(firstBashExit(conv.laneId)).toBe(124);
    expect(readFileSync(join(laneDir(conv.laneId), TOOL_TIMEOUT_LOG), "utf8")).toContain("sleep 60");
    expect(readFileSync(join(laneDir(conv.laneId), "supervisor.log"), "utf8")).toContain("[tool-timeout]");
  }, 40_000);

  test("a call that ends within the limit is not counted and leaves no log", async () => {
    const env = piFixture(undefined, undefined, "  thinking: medium\n  tool_timeout_minutes: 5");
    process.env.FAKE_PI_BASH = "echo quick";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    const turn = conversationTurns(conv.laneId)[0];
    expect(turn.status).toBe("done");
    expect(turn.tool_timeouts).toBeUndefined();
    expect(readLane(conv.laneId).tool_timeouts ?? 0).toBe(0);
    expect(firstBashExit(conv.laneId)).toBe(0);
    expect(existsSync(join(laneDir(conv.laneId), TOOL_TIMEOUT_LOG))).toBe(false);
  }, 40_000);

  test("the role's own limit wins over the default", async () => {
    const env = piFixture("  planner-pi: { model: glm-5.3, thinking: high, tools: [read, bash], report: free, budget_minutes: 5, tool_timeout_minutes: 0.02 }", "planner-pi", "  thinking: medium\n  tool_timeout_minutes: off");
    process.env.FAKE_PI_BASH = "sleep 60";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    expect(conversationTurns(conv.laneId)[0].tool_timeouts).toBe(1);
  }, 40_000);

  test("the role's off leaves a longer call to its own end, whatever the default says", async () => {
    const env = piFixture("  planner-pi: { model: glm-5.3, thinking: high, tools: [read, bash], report: free, budget_minutes: 5, tool_timeout_minutes: off }", "planner-pi", "  thinking: medium\n  tool_timeout_minutes: 0.02");
    process.env.FAKE_PI_BASH = "sleep 2; echo done";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    const turn = conversationTurns(conv.laneId)[0];
    expect(turn.status).toBe("done");
    expect(turn.tool_timeouts).toBeUndefined();
    expect(firstBashExit(conv.laneId)).toBe(0);
    expect(existsSync(join(laneDir(conv.laneId), TOOL_TIMEOUT_LOG))).toBe(false);
  }, 40_000);

  test("two conversations of the same role keep their own limit and their own log", async () => {
    const env = piFixture(undefined, undefined, "  thinking: medium\n  tool_timeout_minutes: 0.02");
    process.env.FAKE_PI_BASH = "echo waiting; sleep 60";
    const a = openPiConversation(env);
    const b = openPiConversation(env);
    expect(a.roleDir).toBe(b.roleDir);
    deliverToConversation(a.sessionId, "brief");
    deliverToConversation(b.sessionId, "brief");
    await until(() => settled(a.sessionId)() && settled(b.sessionId)());
    for (const conv of [a, b]) {
      expect(readLane(conv.laneId).tool_timeouts).toBe(1);
      const lines = readFileSync(join(laneDir(conv.laneId), TOOL_TIMEOUT_LOG), "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
    }
  }, 40_000);
});

describe("a pi conversation that uses the bash tool without its lane's shell says so", () => {
  test("a reply that used bash and never reached the shell leaves a miss on its turn and in the lane's log", async () => {
    const env = piFixture();
    process.env.FAKE_PI_BASH = "echo quick";
    process.env.FAKE_PI_BASH_BYPASS = "1";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    expect(conversationTurns(conv.laneId)[0].tool_shell_missing).toBe(true);
    expect(readFileSync(join(laneDir(conv.laneId), "supervisor.log"), "utf8")).toContain("[tool-shell]");
  }, 40_000);

  test("a reply through the shell, and a reply that used no bash, leave no miss", async () => {
    const env = piFixture();
    process.env.FAKE_PI_BASH = "echo quick";
    const conv = openPiConversation(env);
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    expect(conversationTurns(conv.laneId)[0].tool_shell_missing).toBeUndefined();
    // a reply with no bash tool call at all: nothing to miss
    delete process.env.FAKE_PI_BASH;
    const plain = openPiConversation(env);
    deliverToConversation(plain.sessionId, "brief");
    await until(settled(plain.sessionId));
    expect(conversationTurns(plain.laneId)[0].tool_shell_missing).toBeUndefined();
    expect(readFileSync(join(laneDir(plain.laneId), "supervisor.log"), "utf8")).not.toContain("[tool-shell]");
  }, 40_000);
});

describe("a pi conversation settles its model and its agent dir in the supervisor, just before each reply", () => {
  test("the delivery writes only the queue; the reply's own process prepares the role's agent dir", async () => {
    const env = piFixture();
    const conv = openPiConversation(env);
    // another supervisor holds the conversation, so this deliver only queues: nothing starts here
    expect(acquireConversationLock(conv.laneId)).toBe(true);
    try {
      expect(deliverToConversation(conv.sessionId, "brief").launched).toBe(false);
    } finally {
      releaseConversationLock(conv.laneId);
    }
    expect(queuedMessages(conv.laneId)).toHaveLength(1);
    expect(existsSync(join(conv.roleDir, "models.json"))).toBe(false);
    await runConversation(conv.laneId);
    expect(existsSync(join(conv.roleDir, "models.json"))).toBe(true);
    const [run] = env.runs();
    expect(run).toMatchObject({ message: "brief", agentDir: conv.agentDir, model: "openrouter/z-ai/glm-5.3" });
  }, 40_000);

  test("a refresh that reads a slow plan keeps what a supervisor wrote meanwhile, and the old model does not come back", () => {
    const env = piFixture();
    const conv = openPiConversation(env);
    const before = readLane(conv.laneId);
    const moved = "openrouter/z-ai/glm-5.4";
    expect(refreshConversationModel(conv.laneId, () => {
      // the plan reads a catalog; a supervisor settles the reply meanwhile
      writeLane({ ...readLane(conv.laneId), status: "running", supervisor_pid: 4242, pid: 4343, question_wait: { batch_id: "b1", since: new Date().toISOString() } });
      return { harness: "pi", slot: "planner", role: "planner-pi", model: moved, preset: { ...before.role_preset!, model: moved } } as unknown as ReturnType<typeof planPipelineSpawn>;
    })).toBe(true);
    const after = readLane(conv.laneId);
    expect(after).toMatchObject({ model: moved, status: "running", supervisor_pid: 4242, pid: 4343 });
    expect(after.question_wait?.batch_id).toBe("b1");
    expect(after.role_preset?.model).toBe(moved);
    // the supervisor's next write starts from the record it reads then: an older picture cannot put the model back
    writeLane({ ...readLane(conv.laneId), status: "idle" });
    expect(readLane(conv.laneId).model).toBe(moved);
  });

  test("the reply after roles.yaml moved the slot runs on the slot's model, and the agent dir is built for it", async () => {
    const env = piFixture();
    const conv = openPiConversation(env);
    writeFileSync(process.env.IDD_ROLES_FILE as string, [
      "defaults:", "  thinking: medium",
      "models:", "  glm-5.3:", "    model: openrouter/z-ai/glm-5.3", "  glm-5.4:", "    model: openrouter/z-ai/glm-5.4",
      "roles:", "  planner-pi: { model: glm-5.4, thinking: high, tools: [read, bash], report: free, budget_minutes: 5 }",
      "pipeline:", "  planner: { role: planner-pi }",
    ].join("\n") + "\n");
    deliverToConversation(conv.sessionId, "brief");
    await until(settled(conv.sessionId));
    const [run] = env.starts();
    expect(run.model).toBe("openrouter/z-ai/glm-5.4");
    expect(readLane(conv.laneId).model).toBe("openrouter/z-ai/glm-5.4");
    // the reply's own process prepared the role's agent dir before pi started
    expect(existsSync(join(conv.roleDir, "models.json"))).toBe(true);
    expect(readLane(conv.laneId).role_preset?.model).toBe("openrouter/z-ai/glm-5.4");
  }, 40_000);
});

describe("a pi conversation's agent dir is pinned to the provider the lane started with", () => {
  test("models.json carries the routing of the first provider of a role's providers column", () => {
    const env = piFixture();
    writeFileSync(join(env.root, "roles.yaml"), [
      "defaults:", "  thinking: medium",
      "models:", "  glm-5.3:", "    model: openrouter/z-ai/glm-5.3", "    providers: [novita/fp8, deepseek]",
      "roles:", "  provider-pi: { model: glm-5.3, thinking: high, tools: [read, bash], report: free, budget_minutes: 5 }",
      "pipeline:", "  planner: { role: provider-pi }",
    ].join("\n") + "\n");
    const file = readRoles();
    const route = resolveRoute(resolveRole("provider-pi", file), file);
    const plan = pipelinePlanFor("planner", route.candidate.role);
    if (plan.harness !== "pi") throw new Error("expected a pi plan");
    const conv = openConversation(plan, env.worktree);
    prepareConversationAgentDir(conv.laneId);
    const models = JSON.parse(readFileSync(join(env.state, "pipeline", "agent", "provider-pi", "models.json"), "utf8"));
    expect(models.providers.openrouter.modelOverrides["z-ai/glm-5.3"].compat.openRouterRouting).toEqual({ only: ["novita/fp8"], allow_fallbacks: false });
  }, 40_000);
});

describe("the stop port a lane taken out uses", () => {
  test("a Claude conversation is stopped as its lane (a person's stop), a pi session goes to the runtime's own shutdown", async () => {
    const env = setup();
    const conv = openConversation(claudePlan(), env.worktree);
    const stopped: string[] = [];
    await stopPipelineSession(conv.sessionId, (id) => { stopped.push(id); });
    expect(stopped).toEqual([]);
    expect(stoppedByUserAt(laneDir(conv.laneId))).toBeGreaterThan(0);
    expect(readLane(conv.laneId).status).toBe("stopped");
    // a session that is no conversation of ours: the caller's own stop is what can end it
    await stopPipelineSession("pi-session-1", (id) => { stopped.push(id); });
    expect(stopped).toEqual(["pi-session-1"]);
  });
});

describe("a conversation opened before roles.yaml moved its slot to another pi model", () => {
  const piPreset = (model: string) => ({ name: "executor", harness: "pi", model, thinking: "high", tools: ["read"], report: "exec", requireClean: false, budgetMinutes: 5 }) as unknown as LaneRecord["role_preset"];
  const lane = (over: Partial<LaneRecord> = {}): string => {
    setup();
    const rec = { id: `20261023-000000-executor-${Math.random().toString(36).slice(2, 8)}`, role: "executor", model: "opencode-go/minimax-m3.1-flash-free", worktree: "/tmp", title: "Issue lane executor", spec: "", report: "", status: "idle", started_at: new Date().toISOString(), role_preset: piPreset("opencode-go/minimax-m3.1-flash-free"), mode: "conversation", slot: "executor", ...over } as LaneRecord;
    mkdirSync(laneDir(rec.id), { recursive: true });
    writeLane(rec);
    return rec.id;
  };
  const now = (model: string) => () => ({ harness: "pi", slot: "executor", role: "executor", model, preset: piPreset(model) }) as unknown as ReturnType<typeof planPipelineSpawn>;

  test("the next reply runs on the slot's model now (a retired model must not hold the lane's session)", () => {
    const id = lane();
    expect(refreshConversationModel(id, now("opencode-go/deepseek-v4.1-flash"))).toBe(true);
    expect(readLane(id)).toMatchObject({ model: "opencode-go/deepseek-v4.1-flash", role_preset: { model: "opencode-go/deepseek-v4.1-flash" } });
  });

  test("a delivery whose slot still plans the same model does not ask pi whether the role can start (no synchronous catalog look-up per message)", () => {
    const checks: boolean[] = [];
    const planner = (model: string) => (_slot: string, check?: boolean) => { checks.push(check === true); return now(model)(); };
    const same = lane();
    expect(refreshConversationModel(same, planner("opencode-go/minimax-m3.1-flash-free"))).toBe(false);
    expect(checks).toEqual([false]);
    checks.length = 0;
    const moved = lane();
    expect(refreshConversationModel(moved, planner("opencode-go/deepseek-v4.1-flash"))).toBe(true);
    expect(checks).toEqual([false, true]);
    const unstartable = lane();
    expect(refreshConversationModel(unstartable, (_slot, check) => { if (check) throw new Error("not startable"); return now("opencode-go/deepseek-v4.1-flash")(); })).toBe(false);
    expect(readLane(unstartable).model).toBe("opencode-go/minimax-m3.1-flash-free");
  });

  test("a running supervisor keeps the record: it holds its own copy and would write the old model back over the new one", () => {
    const id = lane();
    expect(acquireConversationLock(id)).toBe(true);
    try {
      expect(refreshConversationModel(id, now("opencode-go/deepseek-v4.1-flash"))).toBe(false);
      expect(readLane(id).model).toBe("opencode-go/minimax-m3.1-flash-free");
    } finally {
      releaseConversationLock(id);
    }
    expect(refreshConversationModel(id, now("opencode-go/deepseek-v4.1-flash"))).toBe(true);
  });

  test("the same model, a Claude Code lane, a model named for the run, and a slot that now plans Claude Code keep the record", () => {
    const same = lane();
    expect(refreshConversationModel(same, now("opencode-go/minimax-m3.1-flash-free"))).toBe(false);
    const claude = lane({ role_preset: { ...piPreset("opus"), harness: "claude" } as LaneRecord["role_preset"], model: "opus" });
    expect(refreshConversationModel(claude, now("opencode-go/deepseek-v4.1-flash"))).toBe(false);
    expect(readLane(claude).model).toBe("opus");
    const named = lane({ no_fallback: true });
    expect(refreshConversationModel(named, now("opencode-go/deepseek-v4.1-flash"))).toBe(false);
    expect(readLane(named).model).toBe("opencode-go/minimax-m3.1-flash-free");
    const toClaude = lane();
    expect(refreshConversationModel(toClaude, () => ({ harness: "claude", slot: "executor", role: "executor-claude", model: "opus", preset: piPreset("opus") }) as unknown as ReturnType<typeof planPipelineSpawn>)).toBe(false);
    const unplannable = lane();
    expect(refreshConversationModel(unplannable, () => { throw new Error("no such slot"); })).toBe(false);
  });

  test("a provider the lane started on stays its provider when the slot's model moves", () => {
    const pinned = { ...piPreset("opencode-go/minimax-m3.1-flash-free"), provider: { only: ["novita/fp8"], allow_fallbacks: false }, routingField: "openRouterRouting" } as LaneRecord["role_preset"];
    const id = lane({ role_preset: pinned });
    expect(refreshConversationModel(id, now("opencode-go/deepseek-v4.1-flash"))).toBe(true);
    const after = readLane(id);
    expect(after.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(after.role_preset?.model).toBe("opencode-go/deepseek-v4.1-flash");
    // the consumption row is built from this role: the provider column of the row is the one fixed at spawn
    expect(providerOf(after.role_preset!)).toBe("novita/fp8");
    expect(after.role_preset).toMatchObject({ name: "executor", routingField: "openRouterRouting" });
  });

  test("a pinned conversation does not follow the slot to another gateway, so its agent dir and route stay put", () => {
    const pinned = { ...piPreset("opencode-go/minimax-m3.1-flash-free"), provider: { only: ["novita/fp8"], allow_fallbacks: false }, routingField: "openRouterRouting" } as LaneRecord["role_preset"];
    const id = lane({ role_preset: pinned });
    expect(refreshConversationModel(id, now("openrouter/z-ai/glm-5.3"))).toBe(false);
    expect(readLane(id)).toMatchObject({ model: "opencode-go/minimax-m3.1-flash-free", role_preset: { name: "executor", model: "opencode-go/minimax-m3.1-flash-free" } });
  });

  test("a slot that now plans another role leaves the conversation on its own role and agent dir", () => {
    const id = lane();
    const moved = "opencode-go/deepseek-v4.1-flash";
    expect(refreshConversationModel(id, () => ({ harness: "pi", slot: "executor", role: "executor-other", model: moved, preset: { ...piPreset(moved), name: "executor-other" } }) as unknown as ReturnType<typeof planPipelineSpawn>)).toBe(false);
    expect(readLane(id)).toMatchObject({ model: "opencode-go/minimax-m3.1-flash-free", role_preset: { name: "executor", model: "opencode-go/minimax-m3.1-flash-free" } });
  });
});
