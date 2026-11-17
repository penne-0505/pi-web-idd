import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRoles } from "../src/roles.ts";
import { parseLaneRepos } from "../src/repos.ts";
import { executeLane, laneDir, laneEnv, prepareLane, readLane, summarizeClaudeEvents, toolTimeoutOf } from "../src/runner.ts";
import { DEFAULT_SHARED_DAEMONS } from "../src/leftovers.ts";
import { leftoverSettings, superviseLane } from "../src/supervisor.ts";

const stray: number[] = [];
const ENV_KEYS = ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_REPOS_FILE", "IDD_LANE_ROOT", "IDD_LANE_SCOPE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR", "IDD_CLAUDE_BIN", "FAKE_PI_TOOL", "FAKE_PI_REPORT"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const roots: string[] = [];

afterEach(() => {
  for (const pid of stray.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/**
 * A stand-in for pi that runs one bash tool call as pi does (its settings' shellPath, `-c`, a process group of its
 * own), waits for it, and then writes the deliverable.
 */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("--list-models")) process.exit(0);
const settings = JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR + "/settings.json", "utf8"));
const shell = settings.shellPath || "/bin/bash";
const child = spawn(shell, ["-c", process.env.FAKE_PI_TOOL], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { out += d; });
child.on("exit", (code) => {
  process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: {} }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolName: "bash", result: { exit: code, out } }) + "\\n");
  const report = process.env.FAKE_PI_REPORT;
  fs.writeFileSync(report + ".md", "ok");
  fs.writeFileSync(report + ".json", JSON.stringify({ exit: code, out }));
});
`;

function fixture(defaults: string, opts: { role?: string; repos?: (wt: string, root: string) => string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "idd-tool-timeout-"));
  roots.push(root);
  const wt = join(root, "wt"); mkdirSync(wt);
  execFileSync("git", ["init", "-q", wt]);
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: wt });
  writeFileSync(join(root, "roles.yaml"), `defaults:\n${defaults}models:\n  x-y:\n    model: x/y\nroles:\n  r:\n    model: x-y\n    tools: [read, bash]\n    report: free\n    require_clean: false\n    budget_minutes: 2\n${opts.role ?? ""}`);
  writeFileSync(join(root, "repos.yaml"), opts.repos ? opts.repos(wt, root) : "repos:\n");
  const agent = join(root, "agent"); mkdirSync(agent);
  const noRoot = join(root, "no-lane-root"); mkdirSync(noRoot);
  const fakePi = join(root, "pi"); writeFileSync(fakePi, FAKE_PI); chmodSync(fakePi, 0o755);
  const report = join(root, "out", "report");
  mkdirSync(join(root, "out"));
  Object.assign(process.env, {
    IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"),
    IDD_LANE_ROOT: noRoot, IDD_LANE_SCOPE: "off", IDD_PI_BIN: fakePi, IDD_PI_USER_AGENT_DIR: agent, FAKE_PI_REPORT: report,
  });
  const specPath = join(root, "spec.yaml");
  writeFileSync(specPath, `role: r\nworktree: ${wt}\nreport: ${report}\ntask: t\n`);
  return { root, specPath, report };
}

describe("a pi lane's tool call that does not end", () => {
  test("is cut at the lane's limit, the lane goes on to its deliverable, and its record counts the cut", async () => {
    const fx = fixture("  tool_timeout_minutes: 0.02\n");
    process.env.FAKE_PI_TOOL = "echo waiting for the device; sleep 60";
    const { rec } = prepareLane(fx.specPath);
    expect(rec.tool_timeout_minutes).toBe(0.02);
    const settings = JSON.parse(readFileSync(join(laneDir(rec.id), "agent", "settings.json"), "utf8"));
    expect(settings.shellPath).toBe(join(laneDir(rec.id), "agent", "lane-bash"));
    const started = Date.now();
    const done = await executeLane(rec.id);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(done.status).toBe("done");
    expect(done.tool_timeouts).toBe(1);
    expect(readLane(rec.id).tool_timeouts).toBe(1);
    expect(JSON.parse(readFileSync(`${fx.report}.json`, "utf8")).exit).toBe(124);
    expect(readFileSync(join(laneDir(rec.id), "tool-timeouts.log"), "utf8")).toContain("sleep 60");
    expect(readFileSync(join(laneDir(rec.id), "supervisor.log"), "utf8")).toContain("[tool-timeout]");
  }, 30_000);

  test("a shared daemon still under the stuck call (adb's server under a waiting client) is stopped with it at the limit", async () => {
    const fx = fixture("  tool_timeout_minutes: 0.02\n");
    const fakeAdb = join(fx.root, "fake-adb");
    writeFileSync(fakeAdb, `#!/usr/bin/env bash\nexec -a "adb -L tcp:5999 fork-server server" sleep 60\n`);
    chmodSync(fakeAdb, 0o755);
    const pids = join(fx.root, "pids");
    process.env.FAKE_PI_TOOL = `setsid ${fakeAdb} </dev/null >/dev/null 2>&1 & echo $! >> ${pids}; sleep 60`;
    const { rec } = prepareLane(fx.specPath);
    const done = await executeLane(rec.id);
    const [daemon] = readFileSync(pids, "utf8").trim().split("\n").map(Number);
    stray.push(daemon);
    await new Promise((res) => setTimeout(res, 300));
    expect(done.tool_timeouts).toBe(1);
    let alive = true;
    try { process.kill(daemon, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  }, 30_000);

  test("with the limit off, the lane's shell is pi's own and nothing is cut", async () => {
    const fx = fixture("  tool_timeout_minutes: off\n");
    process.env.FAKE_PI_TOOL = "echo quick";
    const { rec } = prepareLane(fx.specPath);
    expect(rec.tool_timeout_minutes).toBeNull();
    const settings = JSON.parse(readFileSync(join(laneDir(rec.id), "agent", "settings.json"), "utf8"));
    expect(settings.shellPath).toBeUndefined();
    const done = await executeLane(rec.id);
    expect(done.status).toBe("done");
    expect(done.tool_timeouts ?? 0).toBe(0);
    expect(existsSync(join(laneDir(rec.id), "tool-timeouts.log"))).toBe(false);
  }, 30_000);
});

describe("which limit a lane gets", () => {
  const repo = (minutes: string) => (wt: string, root: string) => `repos:\n  me/app:\n    upstream: ${wt}\n    work: ${join(root, "work")}\n${minutes ? `    tool_timeout_minutes: ${minutes}\n` : ""}`;

  test("the role's own limit first, then the repo's (config/repos.yaml), then the default", () => {
    let fx = fixture("  tool_timeout_minutes: 15\n", { repos: repo("30"), role: "    tool_timeout_minutes: 45\n" });
    expect(prepareLane(fx.specPath, { dryRun: true }).rec.tool_timeout_minutes).toBe(45);
    fx = fixture("  tool_timeout_minutes: 15\n", { repos: repo("30") });
    expect(prepareLane(fx.specPath, { dryRun: true }).rec.tool_timeout_minutes).toBe(30);
    fx = fixture("  tool_timeout_minutes: 15\n", { repos: repo("") });
    expect(prepareLane(fx.specPath, { dryRun: true }).rec.tool_timeout_minutes).toBe(15);
    // off at the role or the repo turns the limit off there, whatever the default
    fx = fixture("  tool_timeout_minutes: 15\n", { repos: repo("off") });
    expect(prepareLane(fx.specPath, { dryRun: true }).rec.tool_timeout_minutes).toBeNull();
    fx = fixture("  tool_timeout_minutes: 15\n", { repos: repo("30"), role: "    tool_timeout_minutes: off\n" });
    expect(prepareLane(fx.specPath, { dryRun: true }).rec.tool_timeout_minutes).toBeNull();
  });

  test("a lane with no limit of its own on the record (a conversation) resolves it the same way", () => {
    const fx = fixture("  tool_timeout_minutes: 15\n", { repos: repo("30") });
    const { rec } = prepareLane(fx.specPath, { dryRun: true });
    const role = parseRoles("roles:\n  c:\n    harness: claude\n    model: opus\n    tools: [read]\n    tool_timeout_minutes: 50\n").roles.c;
    expect(toolTimeoutOf({ worktree: rec.worktree, role_preset: rec.role_preset })).toBe(30);
    expect(toolTimeoutOf({ worktree: rec.worktree, role_preset: role })).toBe(50);
    expect(toolTimeoutOf({ worktree: rec.worktree, role_preset: rec.role_preset, tool_timeout_minutes: null })).toBeNull();
  });

  test("the role's and the repo's limits are checked like the default", () => {
    expect(() => parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  r:\n    model: x-y\n    tool_timeout_minutes: -1\n")).toThrow(/roles\.r\.tool_timeout_minutes/);
    expect(parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  r:\n    model: x-y\n").roles.r.toolTimeoutMinutes).toBeUndefined();
    expect(() => parseLaneRepos("repos:\n  me/app:\n    upstream: /u\n    work: /w\n    tool_timeout_minutes: soon\n")).toThrow(/repos\.me\/app\.tool_timeout_minutes/);
    expect(parseLaneRepos("repos:\n  me/app:\n    upstream: /u\n    work: /w\n    tool_timeout_minutes: off\n").app.toolTimeoutMinutes).toBeNull();
  });
});

describe("a Claude Code lane's tool calls", () => {
  const claude = parseRoles("roles:\n  c:\n    harness: claude\n    model: opus\n    tools: [read, bash]\n").roles.c;

  test("run under the same limit (Claude Code's own timeout of its Bash tool), with no move to the background", () => {
    const root = mkdtempSync(join(tmpdir(), "idd-tool-timeout-env-"));
    roots.push(root);
    writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${join(root, "cfg")}\nroles: {}\n`);
    Object.assign(process.env, { IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml") });
    const env = laneEnv(claude, "L1", join(root, "lane"), 15);
    expect(env.BASH_MAX_TIMEOUT_MS).toBe(String(15 * 60_000));
    // a call that names no timeout runs up to the limit too, as it ran on in the background before, not 2 minutes
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe(String(15 * 60_000));
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    // the hold changes nothing about it: a 1h lane stops the move to the background just the same
    expect(laneEnv(claude, "L1", join(root, "lane"), 15, {}, "1h").CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    expect(laneEnv(claude, "L1", join(root, "lane"), 15, {}, "5m").CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    expect(env.CLAUDE_AUTO_BACKGROUND_TASKS).toBeUndefined();
    expect(env.CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS).toBeUndefined();
    expect(laneEnv(claude, "L1", join(root, "lane"), 0.5).BASH_DEFAULT_TIMEOUT_MS).toBe("30000");
    // off leaves Claude Code as it is
    const off = laneEnv(claude, "L1", join(root, "lane"), null);
    expect(off.BASH_MAX_TIMEOUT_MS).toBe(process.env.BASH_MAX_TIMEOUT_MS);
    expect(off.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS);
  });

  test("a call Claude Code cut at the lane's limit is counted from its stream; a shorter timeout the model asked for is not", () => {
    const root = mkdtempSync(join(tmpdir(), "idd-tool-timeout-claude-"));
    roots.push(root);
    const p = join(root, "events.jsonl");
    writeFileSync(p, [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", is_error: true, content: "Command timed out after 15m 0.0s" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "b2", name: "Bash" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b2", is_error: true, content: [{ type: "text", text: "started\nCommand timed out after 15m 0.3s" }] }] } },
      // the model's own timeout of 2 minutes: Claude Code did what it was asked, the lane's limit cut nothing
      { type: "assistant", message: { content: [{ type: "tool_use", id: "b4", name: "Bash" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b4", is_error: true, content: "Command timed out after 2m 0.0s" }] } },
      // the words in a file read, or in a Bash call's ordinary output, are not a cut
      { type: "assistant", message: { content: [{ type: "tool_use", id: "r1", name: "Read" }, { type: "tool_use", id: "b3", name: "Bash" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r1", is_error: true, content: "Command timed out after 2m 0.0s" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b3", content: "grep: Command timed out after 2m 0.0s" }] } },
      { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.1, session_id: "s", usage: {} },
    ].map((l) => JSON.stringify(l)).join("\n"));
    expect(summarizeClaudeEvents(p, 15).toolTimeouts).toBe(2);
    expect(summarizeClaudeEvents(p, 2).toolTimeouts).toBe(1);
    // with no limit, nothing is the lane's cut
    expect(summarizeClaudeEvents(p, null).toolTimeouts).toBe(0);
  });
});

describe("which shared daemons a lane's cleanup keeps", () => {
  test("the lane keeps the list it was prepared with, even when roles.yaml can no longer be read", () => {
    const fx = fixture("  tool_timeout_minutes: off\n  shared_daemons: ['my-device-bridge']\n");
    const { rec } = prepareLane(fx.specPath, { dryRun: true });
    expect(rec.shared_daemons).toEqual(["my-device-bridge"]);
    writeFileSync(join(fx.root, "roles.yaml"), "defaults: [broken\n");
    expect(leftoverSettings(rec.id)).toEqual({ patterns: ["my-device-bridge"], stop: true });
  });

  test("a lane with no list on its record reads the setting now; if that cannot be read, it stops nothing", () => {
    const fx = fixture("  tool_timeout_minutes: off\n  shared_daemons: ['my-device-bridge']\n");
    const { rec } = prepareLane(fx.specPath, { dryRun: true });
    const old = readLane(rec.id);
    delete old.shared_daemons;
    writeFileSync(join(laneDir(rec.id), "lane.json"), JSON.stringify(old));
    expect(leftoverSettings(rec.id)).toEqual({ patterns: ["my-device-bridge"], stop: true });
    writeFileSync(join(fx.root, "roles.yaml"), "defaults: [broken\n");
    const unread = leftoverSettings(rec.id);
    expect(unread.stop).toBe(false);
    expect(unread.patterns).toEqual(DEFAULT_SHARED_DAEMONS);
  });
});

describe("the supervisor", () => {
  test("cleans up its lane's scope once the lane's record is final, and writes what it did to supervisor.log", async () => {
    const fx = fixture("  tool_timeout_minutes: off\n");
    process.env.FAKE_PI_TOOL = "echo quick";
    const { rec } = prepareLane(fx.specPath);
    const seen: string[] = [];
    await superviseLane(rec.id, {
      kick: () => ({ outcome: "off" }),
      settle: async (id) => { seen.push(`${id} ${readLane(id).status}`); return ["[leftover] moved adb", "[leftover] stopped 1"]; },
    });
    expect(seen).toEqual([`${rec.id} done`]);
    const log = readFileSync(join(laneDir(rec.id), "supervisor.log"), "utf8");
    expect(log).toContain("[leftover] moved adb\n[leftover] stopped 1\n");
  }, 30_000);

  test("a cleanup that throws is written down and does not change the lane's result", async () => {
    const fx = fixture("  tool_timeout_minutes: off\n");
    process.env.FAKE_PI_TOOL = "echo quick";
    const { rec } = prepareLane(fx.specPath);
    const r = await superviseLane(rec.id, { kick: () => ({ outcome: "off" }), settle: async () => { throw new Error("boom"); } });
    expect(r.rec.status).toBe("done");
    expect(readFileSync(join(laneDir(rec.id), "supervisor.log"), "utf8")).toContain("boom");
  }, 30_000);
});
