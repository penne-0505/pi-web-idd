import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ConsumptionRow } from "../src/consumption.ts";
import { parseRoles } from "../src/roles.ts";
import { checkClaudeQuota, ClaudeQuotaBlocked, claudeQuotaBlock, isClaudeQuotaBlocked, quotaFromEvent, readClaudeQuota, readClaudeQuotaWindows, recordClaudeQuota } from "../src/claude-quota.ts";
import { startReviewRuns } from "../src/review-runs.ts";
import { buildClaudeArgs, checkClaudeConfigDir, claudeEnv, executeLane, laneDir, prepareLane, readLane, sendLane, summarizeClaudeEvents } from "../src/runner.ts";
import { tmpDir } from "./helpers/tmp.ts";

describe("claude harness", () => {
  test("maps pi tool names and thinking to claude flags and isolates settings", () => {
    const role = parseRoles("roles:\n  e:\n    harness: claude\n    model: opus\n    thinking: xhigh\n    tools: [read, bash, grep, find, ls]").roles.e;
    const args = buildClaudeArgs(role, "00000000-0000-4000-8000-000000000000", "brief");
    expect(args).not.toContain("--bare");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Bash,Grep,Glob");
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Agent");
    expect(args[args.indexOf("--session-id") + 1]).toBe("00000000-0000-4000-8000-000000000000");
    expect(args[args.length - 1]).toBe("brief");
    expect(buildClaudeArgs(role, "x", "again", true)).toContain("--resume");
  });

  test("accepts a bare alias as model only for the claude harness", () => {
    // Claude Code's model is its own alias, so it stays in the role; a pi role names a model definition
    expect(() => parseRoles("roles:\n  p:\n    harness: claude\n    model: opus")).not.toThrow();
    expect(() => parseRoles("roles:\n  p:\n    model: opus")).toThrow(/model 定義/);
  });

  test("summarizes stream-json: tool calls, turns, usage and cost from the result event", () => {
    const dir = tmpDir("idd-lane-claude-");
    const p = join(dir, "events.jsonl");
    writeFileSync(p, [
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }, { type: "tool_use", name: "Read" }], usage: { input_tokens: 10 } } },
      { type: "user", message: { content: [] } },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }], usage: { output_tokens: 5 } } },
      { type: "result", subtype: "success", is_error: false, result: "final", total_cost_usd: 1.25, num_turns: 2, session_id: "s1", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } },
    ].map((l) => JSON.stringify(l)).join("\n"));
    const s = summarizeClaudeEvents(p);
    expect(s.toolCalls).toBe(2);
    expect(s.turns).toBe(2);
    expect(s.usage).toEqual({ input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, cost: 1.25 });
    expect(s.finalText).toBe("final");
    expect(s.sessionFile).toBe("s1");
  });
});

describe("the lane's own Claude Code config dir", () => {
  test("a lane runs Claude Code in the lane's config dir, with auto memory off", () => {
    const env = claudeEnv({ CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "/home/p/.claude-work", PATH: "/bin" }, "/home/p/.config/idd/claude");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/p/.config/idd/claude");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  test("a lane's Claude Code always runs on the subscription login: API-billed credentials are dropped", () => {
    const env = claudeEnv({
      ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://gw", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1", AWS_BEARER_TOKEN_BEDROCK: "b",
      CLAUDE_CODE_OAUTH_TOKEN: "sub", PATH: "/bin",
    }, "/cfg");
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "AWS_BEARER_TOKEN_BEDROCK"]) expect(env[k]).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sub");
  });

  test("the config dir defaults under ~/.config/idd, roles.yaml and IDD_CLAUDE_CONFIG_DIR can move it", () => {
    const home = process.env.HOME as string;
    expect(parseRoles("roles: {}").defaults.claudeConfigDir).toBe(join(home, ".config/idd/claude"));
    expect(parseRoles("defaults:\n  claude_config_dir: ~/lanes/claude\nroles: {}").defaults.claudeConfigDir).toBe(join(home, "lanes/claude"));
    process.env.IDD_CLAUDE_CONFIG_DIR = "/srv/claude";
    try { expect(parseRoles("roles: {}").defaults.claudeConfigDir).toBe("/srv/claude"); } finally { delete process.env.IDD_CLAUDE_CONFIG_DIR; }
  });

  test("penne's own config dirs are refused, and a dir with no login stops the lane with the login command", () => {
    const home = process.env.HOME as string;
    expect(() => checkClaudeConfigDir(join(home, ".claude"), {})).toThrow(/個人/);
    expect(() => checkClaudeConfigDir("/x/desk", { CLAUDE_CONFIG_DIR: "/x/desk" })).toThrow(/個人/);
    const dir = tmpDir("idd-claude-cfg-");
    expect(() => checkClaudeConfigDir(dir, {})).toThrow(new RegExp(`CLAUDE_CONFIG_DIR=${dir} claude`));
    writeFileSync(join(dir, ".credentials.json"), "{}");
    expect(() => checkClaudeConfigDir(dir, {})).not.toThrow();
  });
});

/** a run's record in the state, as a run keeps it under `lanes/<run>/lane.json` */
function keepRun(state: string, id: string, record: unknown): void {
  mkdirSync(join(state, "lanes", id), { recursive: true });
  writeFileSync(join(state, "lanes", id, "lane.json"), JSON.stringify(record));
}

describe("the Claude subscription's windows", () => {
  const H = 3600;
  const now = Date.parse("2026-09-24T06:00:00Z");
  const sec = now / 1000;
  const rateLimit = (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s1" });

  test("the last rate_limit_event of a run is kept: status and each window's utilization and reset", () => {
    const dir = tmpDir("idd-lane-claude-");
    const p = join(dir, "events.jsonl");
    writeFileSync(p, [
      rateLimit({ status: "allowed", resetsAt: sec + 5 * H, rateLimitType: "five_hour", utilization: 0.1, unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: sec + 5 * H } } }),
      { type: "assistant", message: { content: [{ type: "text", text: "x" }] } },
      rateLimit({ status: "allowed_warning", resetsAt: sec + 50 * H, rateLimitType: "seven_day", utilization: 0.91, isUsingOverage: false, surpassedThreshold: 0.75, unifiedWindows: { five_hour: { utilization: 0, resetsAt: sec + 4 * H }, seven_day: { utilization: 0.91, resetsAt: sec + 50 * H } } }),
      { type: "result", subtype: "success", total_cost_usd: 0.5, session_id: "s1" },
    ].map((l) => JSON.stringify(l)).join("\n"));
    expect(summarizeClaudeEvents(p).quota).toEqual({
      status: "allowed_warning",
      rate_limit_type: "seven_day",
      resets_at: sec + 50 * H,
      windows: { five_hour: { utilization: 0, resets_at: sec + 4 * H }, seven_day: { utilization: 0.91, resets_at: sec + 50 * H } },
    });
  });

  test("an event without unifiedWindows still gives the window it names", () => {
    expect(quotaFromEvent(rateLimit({ status: "rejected", resetsAt: sec + H, rateLimitType: "five_hour", utilization: 1 }))).toEqual({
      status: "rejected", rate_limit_type: "five_hour", resets_at: sec + H, windows: { five_hour: { utilization: 1, resets_at: sec + H } },
    });
    expect(quotaFromEvent({ type: "rate_limit_event" })).toBeNull();
  });

  test("the stop thresholds default to 90% of five hours and 95% of the week, and roles.yaml can move them", () => {
    expect(parseRoles("roles: {}").defaults.claudeQuotaStop).toEqual({ five_hour: 0.9, seven_day: 0.95 });
    expect(parseRoles("defaults:\n  claude_quota_stop: { five_hour: 0.8 }\nroles: {}").defaults.claudeQuotaStop).toEqual({ five_hour: 0.8, seven_day: 0.95 });
    expect(() => parseRoles("defaults:\n  claude_quota_stop: { seven_day: 95 }\nroles: {}")).toThrow(/claude_quota_stop/);
    expect(() => parseRoles("defaults:\n  claude_quota_stop: { five_hours: 0.8 }\nroles: {}")).toThrow(/five_hours/);
  });

  test("the last observation is kept per config dir, so each account is judged on its own", () => {
    process.env.IDD_STATE_DIR = tmpDir("idd-quota-");
    try {
      expect(readClaudeQuota("/cfg/a")).toBeNull();
      recordClaudeQuota("/cfg/a", { status: "allowed", windows: { five_hour: { utilization: 0.5, resets_at: sec + H } } }, "L1", new Date(now));
      recordClaudeQuota("/cfg/b", { status: "rejected", windows: {} }, "L2", new Date(now));
      recordClaudeQuota("/cfg/a", { status: "allowed", windows: { five_hour: { utilization: 0.6, resets_at: sec + H } } }, "L3", new Date(now + 1000));
      expect(readClaudeQuota("/cfg/a")).toEqual({ status: "allowed", windows: { five_hour: { utilization: 0.6, resets_at: sec + H } }, observed_at: new Date(now + 1000).toISOString(), lane: "L3" });
      expect(readClaudeQuota("/cfg/b/")?.status).toBe("rejected");
      expect(existsSync(join(process.env.IDD_STATE_DIR, "pipeline", "claude-quota.json"))).toBe(true);
    } finally { delete process.env.IDD_STATE_DIR; }
  });

  test("the windows' rise over a period is read from the observations of the runs the period's Claude rows name", () => {
    const state = tmpDir("idd-quota-windows-");
    process.env.IDD_STATE_DIR = state;
    try {
      const reset = Date.parse("2026-11-13T10:00:00Z") / 1000;
      const keep = (id: string, record: unknown) => keepRun(state, id, record);
      // `run observed_at utilization reset offset in weeks`: three runs of one week's window, a later window that rose
      // less, a run before the period, a run of another contract, and a run that kept no observation
      for (const spec of ["r1 2026-11-06T01:00:00Z 0.02 0", "r2 2026-11-08T01:00:00Z 0.3 0", "r3 2026-11-10T01:00:00Z 0.68 0", "r4 2026-11-10T02:00:00Z 0.1 1", "r5 2026-10-20T00:00:00Z 0.9 -2", "r6 2026-11-07T00:00:00Z 0.99 0"]) {
        const [id, observed_at, utilization, weeks] = spec.split(" ");
        keep(id, { id, claude_quota: { status: "allowed", windows: { seven_day: { utilization: Number(utilization), resets_at: reset + Number(weeks) * 7 * 86400 } }, observed_at, lane: id } });
      }
      keep("r7", { id: "r7" });
      // the conversation's config dir is another account's window; one that names the lane side's dir, or none, is counted
      keep("r8", { id: "r8", claude_quota: { status: "allowed", windows: { seven_day: { utilization: 0.99, resets_at: reset } }, observed_at: "2026-11-09T01:00:00Z", config_dir: "/cfg/chat" } });
      keep("r9", { id: "r9", claude_quota: { status: "allowed", windows: { seven_day: { utilization: 0.1, resets_at: reset + 7 * 86400 } }, observed_at: "2026-11-09T02:00:00Z", config_dir: "/cfg/lane/" } });
      const rows: ConsumptionRow[] = ["r1 2026-11-06T01:00:00Z", "r2 2026-11-08T01:00:00Z", "r3 2026-11-10T01:00:00Z", "r4 2026-11-10T02:00:00Z", "r5 2026-10-20T00:00:00Z", "r6 2026-11-07T00:00:00Z ollama-cloud", "r7 2026-11-09T00:00:00Z", "r8 2026-11-09T01:00:00Z", "r9 2026-11-09T02:00:00Z", "missing 2026-11-09T00:00:00Z"].map((spec) => {
        const [lane, at, contract = "claude"] = spec.split(" ");
        return { at, unit: "attempt", lane, contract, harness: contract, cost: 1 };
      });
      const period = { since: "2026-11-01", until: "2026-11-10" };
      const read = readClaudeQuotaWindows(rows, period, "/cfg/lane");
      expect(read.windows[0]).toEqual({ window: "five_hour", label: "5 時間の枠", observations: 0, unplaced: 0 });
      expect(read.windows[1].window).toBe("seven_day");
      expect(read.windows[1].observations).toBe(5);
      expect(read.windows[1].peak).toEqual({
        start: "2026-11-06T10:00:00.000Z", end: "2026-11-13T10:00:00.000Z", first_at: "2026-11-06T01:00:00Z", last_at: "2026-11-10T01:00:00Z",
        from: 0.02, to: 0.68, rise: 0.68 - 0.02, observations: 3,
      });
      // the same records read twice give the same readings, and nothing is written
      expect(readClaudeQuotaWindows([...rows].reverse(), period, "/cfg/lane")).toEqual(read);
      expect(existsSync(join(state, "pipeline", "claude-quota.json"))).toBe(false);
    } finally { delete process.env.IDD_STATE_DIR; }
  });

  test("each reply of a conversation lane is a point of its own, and the record's copy of the last one is not a second", () => {
    const state = tmpDir("idd-quota-windows-");
    process.env.IDD_STATE_DIR = state;
    try {
      const reset = Date.parse("2026-11-13T10:00:00Z") / 1000;
      const windows = (u: number) => ({ seven_day: { utilization: u, resets_at: reset } });
      const reply = (n: number, ended_at: string, u: number, config_dir?: string) => JSON.stringify({ n, ended_at, status: "done", claude_quota: { status: "allowed", windows: windows(u), ...(config_dir ? { config_dir } : {}) } });
      keepRun(state, "c1", { id: "c1", claude_quota: { status: "allowed", windows: windows(0.5), observed_at: "2026-11-09T01:00:00Z", config_dir: "/cfg/lane" } });
      writeFileSync(join(state, "lanes", "c1", "turns.jsonl"), [reply(1, "2026-11-07T01:00:00Z", 0.1, "/cfg/lane"), reply(2, "2026-11-08T01:00:00Z", 0.3, "/cfg/lane"), reply(3, "2026-11-09T01:00:01Z", 0.5, "/cfg/lane"), reply(4, "2026-11-09T02:00:00Z", 0.9, "/cfg/chat"), JSON.stringify({ n: 5, ended_at: "2026-11-09T03:00:00Z", status: "failed" }), "{partial"].join("\n"));
      const row: ConsumptionRow = { at: "2026-11-09T01:00:00Z", unit: "reply", lane: "c1", contract: "claude", cost: 1 };
      const read = readClaudeQuotaWindows([row], { since: "2026-11-01", until: "2026-11-10" }, "/cfg/lane").windows[1];
      expect(read.observations).toBe(3);
      expect(read.peak).toMatchObject({ from: 0.1, to: 0.5, observations: 3 });
    } finally { delete process.env.IDD_STATE_DIR; }
  });

  test("an observation with no reset time is counted but cannot be placed in a window", () => {
    const state = tmpDir("idd-quota-windows-");
    process.env.IDD_STATE_DIR = state;
    try {
      keepRun(state, "r1", { claude_quota: { status: "allowed", windows: { five_hour: { utilization: 0.4 } }, observed_at: "2026-11-02T00:00:00Z" } });
      const row: ConsumptionRow = { at: "2026-11-02T00:00:00Z", unit: "attempt", lane: "r1", contract: "claude", cost: 1 };
      expect(readClaudeQuotaWindows([row], { since: "2026-11-01", until: "2026-11-10" }, "/cfg/lane").windows[0]).toEqual({ window: "five_hour", label: "5 時間の枠", observations: 1, unplaced: 1 });
    } finally { delete process.env.IDD_STATE_DIR; }
  });

  test("an observation older than the account's last one does not replace it; the lane still keeps its own", () => {
    process.env.IDD_STATE_DIR = tmpDir("idd-quota-");
    try {
      recordClaudeQuota("/cfg/a", { status: "allowed", windows: { five_hour: { utilization: 0.95, resets_at: sec + H } } }, "L2", new Date(now + 1000));
      const own = recordClaudeQuota("/cfg/a", { status: "allowed", windows: { five_hour: { utilization: 0.5, resets_at: sec + H } } }, "L1", new Date(now));
      expect(own).toMatchObject({ lane: "L1", windows: { five_hour: { utilization: 0.5 } } });
      expect(readClaudeQuota("/cfg/a")).toMatchObject({ lane: "L2", observed_at: new Date(now + 1000).toISOString(), windows: { five_hour: { utilization: 0.95 } } });
    } finally { delete process.env.IDD_STATE_DIR; }
  });

  test("Claude Code lanes writing their observations at the same moment do not lose each other's", async () => {
    const state = tmpDir("idd-quota-");
    const script = join(state, "writer.ts");
    writeFileSync(script, [
      `import { recordClaudeQuota } from ${JSON.stringify(resolve(import.meta.dir, "../src/claude-quota.ts"))};`,
      "const [account, start] = process.argv.slice(2);",
      "while (Date.now() < Number(start)) { /* start together */ }",
      "for (let i = 1; i <= 40; i += 1) recordClaudeQuota(account, { status: \"allowed\", windows: { five_hour: { utilization: i / 100 } } }, `${account}-${i}`);",
    ].join("\n"));
    const start = Date.now() + 1500;
    const accounts = Array.from({ length: 6 }, (_, i) => `/cfg/${i}`);
    await Promise.all(accounts.map((a) => new Promise<void>((done, fail) => {
      const child = spawn(process.execPath, [script, a, String(start)], { env: { ...process.env, IDD_STATE_DIR: state }, stdio: ["ignore", "ignore", "inherit"] });
      child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`writer ${a} exit ${code}`))));
    })));
    process.env.IDD_STATE_DIR = state;
    try {
      for (const a of accounts) expect(readClaudeQuota(a)?.lane).toBe(`${a}-40`);
    } finally { delete process.env.IDD_STATE_DIR; }
  }, 30_000);

  test("a window at or over its threshold stops the lane, with its reset in Japan time; a past window and no observation do not", () => {
    const stop = { five_hour: 0.9, seven_day: 0.95 };
    const obs = (windows: Record<string, { utilization: number; resets_at?: number }>, status = "allowed") => ({ status, windows, observed_at: new Date(now).toISOString() });
    expect(claudeQuotaBlock(null, stop, now)).toBeNull();
    expect(claudeQuotaBlock(obs({ five_hour: { utilization: 0.89, resets_at: sec + H }, seven_day: { utilization: 0.94, resets_at: sec + 50 * H } }), stop, now)).toBeNull();
    const block = claudeQuotaBlock(obs({ five_hour: { utilization: 0.9, resets_at: sec + H } }), stop, now) as string;
    expect(block).toMatch(/5 時間の枠 90%（閾値 90%、リセット 2026-09-24 16:00 JST）/);
    expect(claudeQuotaBlock(obs({ seven_day: { utilization: 0.97, resets_at: sec + 50 * H } }), stop, now)).toMatch(/週上限 97%.*2026-09-26 17:00 JST/);
    expect(claudeQuotaBlock(obs({ five_hour: { utilization: 1, resets_at: sec - 1 } }), stop, now)).toBeNull();
    expect(claudeQuotaBlock(obs({ seven_day_opus: { utilization: 1, resets_at: sec + H } }), stop, now)).toBeNull();
  });

  test("a rejected status stops the lane until its reset; past that, the other windows are still judged", () => {
    const stop = { five_hour: 0.9, seven_day: 0.95 };
    const at = new Date(now).toISOString();
    expect(claudeQuotaBlock({ status: "rejected", resets_at: sec + H, windows: {}, observed_at: at }, stop, now)).toMatch(/rejected.*2026-09-24 16:00 JST/);
    expect(claudeQuotaBlock({ status: "rejected", resets_at: sec - 1, windows: {}, observed_at: at }, stop, now)).toBeNull();
    const week = claudeQuotaBlock({ status: "rejected", resets_at: sec - 60, rate_limit_type: "five_hour", windows: { five_hour: { utilization: 1, resets_at: sec - 60 }, seven_day: { utilization: 0.97, resets_at: sec + 50 * H } }, observed_at: at }, stop, now);
    expect(week).toMatch(/週上限 97%/);
  });

  test("with no reset on the event, a rejection waits for the window it names, not the furthest one", () => {
    const stop = { five_hour: 0.9, seven_day: 0.95 };
    const at = new Date(now).toISOString();
    const obs = { status: "rejected", rate_limit_type: "five_hour", windows: { five_hour: { utilization: 1, resets_at: sec + H }, seven_day: { utilization: 0.3, resets_at: sec + 120 * H } }, observed_at: at };
    expect(claudeQuotaBlock(obs, stop, now)).toMatch(/リセット 2026-09-24 16:00 JST/);
    expect(claudeQuotaBlock(obs, stop, now + 2 * H * 1000)).toBeNull();
  });

  test("a reset nobody reported is bounded by the window's own length from the observation", () => {
    const stop = { five_hour: 0.9, seven_day: 0.95 };
    const at = new Date(now).toISOString();
    // nothing tells when: wait out the shortest window, then let a lane find out
    const unknown = { status: "rejected", windows: {}, observed_at: at };
    expect(claudeQuotaBlock(unknown, stop, now)).toMatch(/2026-09-24 20:00 JST/);
    expect(claudeQuotaBlock(unknown, stop, now + 5 * H * 1000 + 1000)).toBeNull();
    const noReset = { status: "allowed", windows: { five_hour: { utilization: 0.95 } }, observed_at: at };
    expect(claudeQuotaBlock(noReset, stop, now)).toMatch(/5 時間の枠 95%/);
    expect(claudeQuotaBlock(noReset, stop, now + 5 * H * 1000 + 1000)).toBeNull();
  });

  test("the refusal is a wait, told apart from a failure to start, with when to try again", () => {
    process.env.IDD_STATE_DIR = tmpDir("idd-quota-");
    try {
      recordClaudeQuota("/cfg/a", { status: "allowed", windows: { five_hour: { utilization: 0.95, resets_at: sec + H } } }, "L1", new Date(now));
      let caught: unknown;
      try { checkClaudeQuota("/cfg/a", { five_hour: 0.9 }, now); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(ClaudeQuotaBlocked);
      expect((caught as ClaudeQuotaBlocked).code).toBe("claude_quota");
      expect((caught as ClaudeQuotaBlocked).resetsAt).toBe(sec + H);
      expect(isClaudeQuotaBlocked(caught)).toBe(true);
      expect(isClaudeQuotaBlocked(new Error("x"))).toBe(false);
    } finally { delete process.env.IDD_STATE_DIR; }
  });

  test("a broken record in claude-quota.json reads as no observation, and the other accounts stay", () => {
    process.env.IDD_STATE_DIR = tmpDir("idd-quota-");
    try {
      recordClaudeQuota("/cfg/ok", { status: "allowed", windows: { five_hour: { utilization: 0.95, resets_at: sec + H } } }, "L1", new Date(now));
      const p = join(process.env.IDD_STATE_DIR, "pipeline", "claude-quota.json");
      const file = JSON.parse(readFileSync(p, "utf8"));
      Object.assign(file.accounts, {
        "/cfg/no-windows": { status: "allowed", observed_at: new Date(now).toISOString() },
        "/cfg/bad-time": { status: "allowed", windows: {}, observed_at: "garbage" },
        "/cfg/bad-util": { status: "allowed", windows: { five_hour: { utilization: "high" } }, observed_at: new Date(now).toISOString() },
        "/cfg/no-status": { windows: {}, observed_at: new Date(now).toISOString() },
      });
      writeFileSync(p, JSON.stringify(file));
      for (const dir of ["/cfg/no-windows", "/cfg/bad-time", "/cfg/bad-util", "/cfg/no-status"]) {
        expect(readClaudeQuota(dir)).toBeNull();
        expect(() => checkClaudeQuota(dir, { five_hour: 0.9, seven_day: 0.95 }, now)).not.toThrow();
      }
      expect(readClaudeQuota("/cfg/ok")?.windows.five_hour.utilization).toBe(0.95);
      writeFileSync(p, "{not json");
      expect(readClaudeQuota("/cfg/ok")).toBeNull();
    } finally { delete process.env.IDD_STATE_DIR; }
  });

  test("a Claude Code lane over its window is refused before it takes a lane id", () => {
    const root = tmpDir("idd-quota-lane-");
    const cfg = join(root, "cfg"); mkdirSync(cfg); writeFileSync(join(cfg, ".credentials.json"), "{}");
    const wt = join(root, "wt"); mkdirSync(wt);
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: (execFileSync("git", ["init", "-q", wt]), wt) });
    writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${cfg}\nroles:\n  deep:\n    harness: claude\n    model: opus\n    tools: [read, bash]\n`);
    const specPath = join(root, "spec.yaml");
    writeFileSync(specPath, `role: deep\nworktree: ${wt}\nreport: ${join(root, "out", "report")}\ntask: t\n`);
    Object.assign(process.env, { IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml") });
    try {
      const future = Math.floor(Date.now() / 1000) + 3600;
      recordClaudeQuota(cfg, { status: "allowed_warning", windows: { seven_day: { utilization: 0.96, resets_at: future } } });
      expect(() => prepareLane(specPath, { dryRun: true })).toThrow(/週上限 96%/);
      expect(readdirSync(join(root, "state", "lanes"))).toEqual([]);
      recordClaudeQuota(cfg, { status: "allowed", windows: { seven_day: { utilization: 0.5, resets_at: future } } });
      expect(prepareLane(specPath, { dryRun: true }).rec.role).toBe("deep");
    } finally { delete process.env.IDD_STATE_DIR; delete process.env.IDD_ROLES_FILE; }
  });

  test("a finished Claude Code lane keeps the windows its run reported, on lane.json and as the account's last observation", async () => {
    const root = tmpDir("idd-quota-run-");
    const cfg = join(root, "cfg"); mkdirSync(cfg); writeFileSync(join(cfg, ".credentials.json"), "{}");
    const wt = join(root, "wt"); mkdirSync(wt);
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: (execFileSync("git", ["init", "-q", wt]), wt) });
    const report = join(root, "out", "report");
    const fake = join(root, "claude");
    const events = [
      rateLimit({ status: "allowed_warning", resetsAt: sec + 50 * H, rateLimitType: "seven_day", utilization: 0.91, unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: sec + 4 * H }, seven_day: { utilization: 0.91, resetsAt: sec + 50 * H } } }),
      { type: "result", subtype: "success", total_cost_usd: 0.75, session_id: "s1", result: "ok" },
    ].map((l) => JSON.stringify(l)).join("\n");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${events}'\necho done > ${report}.md\necho '{}' > ${report}.json\n`);
    chmodSync(fake, 0o755);
    writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${cfg}\nroles:\n  deep:\n    harness: claude\n    model: opus\n    tools: [read, bash]\n`);
    const specPath = join(root, "spec.yaml");
    writeFileSync(specPath, `role: deep\nworktree: ${wt}\nreport: ${report}\ntask: t\n`);
    Object.assign(process.env, { IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_CLAUDE_BIN: fake });
    try {
      const { rec } = prepareLane(specPath);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("done");
      expect(done.usage?.cost).toBe(0.75);
      const lane = readLane(rec.id);
      expect(lane.claude_quota?.status).toBe("allowed_warning");
      expect(lane.claude_quota?.windows.seven_day).toEqual({ utilization: 0.91, resets_at: sec + 50 * H });
      expect(lane.claude_quota?.lane).toBe(rec.id);
      expect(lane.claude_quota?.config_dir).toBe(resolve(cfg));
      // the lane's record also names the dir it ran in; the account's own record is keyed by it
      expect({ ...readClaudeQuota(cfg), config_dir: resolve(cfg) }).toEqual(lane.claude_quota ?? null);
    } finally { delete process.env.IDD_STATE_DIR; delete process.env.IDD_ROLES_FILE; delete process.env.IDD_CLAUDE_BIN; }
  });

  test("a run's output that trails its exit is read before the run is collected: its cost, session and windows are kept", async () => {
    const root = tmpDir("idd-quota-trail-");
    const cfg = join(root, "cfg"); mkdirSync(cfg); writeFileSync(join(cfg, ".credentials.json"), "{}");
    const wt = join(root, "wt"); mkdirSync(wt);
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: (execFileSync("git", ["init", "-q", wt]), wt) });
    const report = join(root, "out", "report");
    const fake = join(root, "claude");
    const events = [
      rateLimit({ status: "allowed", resetsAt: sec + 4 * H, rateLimitType: "five_hour", utilization: 0.3, unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: sec + 4 * H } } }),
      { type: "result", subtype: "success", total_cost_usd: 0.75, session_id: "s1", result: "ok" },
    ].map((l) => JSON.stringify(l)).join("\n");
    // the deliverable is written and the process exits at once; what it printed reaches the pipe only afterwards
    writeFileSync(fake, `#!/bin/sh\necho done > ${report}.md\necho '{}' > ${report}.json\n( sleep 0.5; printf '%s\\n' '${events}' ) &\nexit 0\n`);
    chmodSync(fake, 0o755);
    writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${cfg}\nroles:\n  deep:\n    harness: claude\n    model: opus\n    tools: [read, bash]\n`);
    const specPath = join(root, "spec.yaml");
    writeFileSync(specPath, `role: deep\nworktree: ${wt}\nreport: ${report}\ntask: t\n`);
    Object.assign(process.env, { IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_CLAUDE_BIN: fake });
    try {
      const { rec } = prepareLane(specPath);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("done");
      expect(done.usage?.cost).toBe(0.75);
      expect(readLane(rec.id).claude_quota?.windows.five_hour.utilization).toBe(0.3);
      expect(readClaudeQuota(cfg)?.lane).toBe(rec.id);
    } finally { delete process.env.IDD_STATE_DIR; delete process.env.IDD_ROLES_FILE; delete process.env.IDD_CLAUDE_BIN; }
  });

  /** a lane's scratch: a logged-in lane config dir, a git worktree, roles and a spec for a Claude Code role */
  function laneFixture(rolesYaml?: string) {
    const root = tmpDir("idd-quota-fx-");
    const cfg = join(root, "cfg"); mkdirSync(cfg); writeFileSync(join(cfg, ".credentials.json"), "{}");
    const wt = join(root, "wt"); mkdirSync(wt);
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: (execFileSync("git", ["init", "-q", wt]), wt) });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
    writeFileSync(join(root, "roles.yaml"), rolesYaml ?? `defaults:\n  claude_config_dir: ${cfg}\nroles:\n  deep:\n    harness: claude\n    model: opus\n    tools: [read, bash]\n`);
    writeFileSync(join(root, "repos.yaml"), "repos:\n");
    const agent = join(root, "agent"); mkdirSync(agent);
    const fakeRoot = join(root, "no-lane-root"); mkdirSync(fakeRoot);
    const fakePi = join(root, "pi"); writeFileSync(fakePi, "#!/bin/sh\nexit 0\n"); chmodSync(fakePi, 0o755);
    Object.assign(process.env, {
      IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"),
      // nothing real starts: a missing supervisor, a pi that exits at once, and no user agent dir
      IDD_LANE_ROOT: fakeRoot, IDD_LANE_SCOPE: "off", IDD_PI_BIN: fakePi, IDD_PI_USER_AGENT_DIR: agent,
    });
    const report = join(root, "out", "report");
    const specPath = join(root, "spec.yaml");
    writeFileSync(specPath, `role: deep\nworktree: ${wt}\nreport: ${report}\ntask: t\n`);
    return { root, cfg, wt, head, report, specPath };
  }
  const clearEnv = () => { for (const k of ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_REPOS_FILE", "IDD_LANE_ROOT", "IDD_LANE_SCOPE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR", "IDD_CLAUDE_BIN"]) delete process.env[k]; };
  const future = () => Math.floor(Date.now() / 1000) + 3600;

  test("a stage with several roles checks every Claude Code role's window before it starts any run", async () => {
    const root = tmpDir("idd-quota-stage-");
    const cfg = join(root, "cfg-dir");
    const fx = laneFixture(`defaults:\n  claude_config_dir: ${cfg}\nmodels:\n  x-y:\n    model: x/y\nroles:\n  pi-blind:\n    model: x-y\n    tools: [read, bash]\n    report: review\n  claude-blind:\n    harness: claude\n    model: opus\n    tools: [read, bash]\n    report: review\npipeline:\n  review_blind: { roles: [pi-blind, claude-blind] }\n`);
    mkdirSync(cfg); writeFileSync(join(cfg, ".credentials.json"), "{}");
    try {
      recordClaudeQuota(cfg, { status: "allowed", windows: { five_hour: { utilization: 0.95, resets_at: future() } } });
      let caught: unknown;
      try { await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: fx.wt, base: fx.head, head: fx.head, inputs: [] }); } catch (err) { caught = err; }
      expect(isClaudeQuotaBlocked(caught)).toBe(true);
      const lanes = readdirSync(join(fx.root, "state", "lanes")).filter((f) => f !== "shim");
      expect(lanes).toEqual([]);
      const copies = join(fx.root, "state", "pipeline", "review-wt");
      expect(existsSync(copies) ? readdirSync(copies) : []).toEqual([]);
    } finally { clearEnv(); }
  });

  test("a follow-up sent to a Claude Code lane waits for the window too", async () => {
    const fx = laneFixture();
    const fake = join(fx.root, "claude"); writeFileSync(fake, `#!/bin/sh\ntouch ${join(fx.root, "ran")}\n`); chmodSync(fake, 0o755);
    process.env.IDD_CLAUDE_BIN = fake;
    try {
      const { rec } = prepareLane(fx.specPath, { dryRun: true });
      recordClaudeQuota(fx.cfg, { status: "rejected", resets_at: future(), windows: {} });
      let caught: unknown;
      try { await sendLane(rec.id, "続き"); } catch (err) { caught = err; }
      expect(isClaudeQuotaBlocked(caught)).toBe(true);
      expect(existsSync(join(fx.root, "ran"))).toBe(false);
      expect(readLane(rec.id).status).toBe("stopped");
    } finally { clearEnv(); }
  });

  test("a follow-up whose harness cannot be started fails the lane with the reason instead of throwing at the caller", async () => {
    const fx = laneFixture();
    process.env.IDD_CLAUDE_BIN = join(fx.root, "no-such-claude");
    try {
      const { rec } = prepareLane(fx.specPath, { dryRun: true });
      const sent = await sendLane(rec.id, "続き");
      expect(sent.status).toBe("failed");
      expect(sent.exit).toBe(127);
      expect(sent.spawn_error).toContain("を起動できない");
      const lane = readLane(rec.id);
      expect(lane.status).toBe("failed");
      expect(lane.pid).toBeUndefined();
      expect(readFileSync(join(laneDir(rec.id), "stderr.log"), "utf8")).toContain("を起動できない");
    } finally { clearEnv(); }
  });

  test("a resume that reports no new window keeps the account's newer observation from another lane", async () => {
    const fx = laneFixture();
    const quotaFile = join(fx.root, "state", "pipeline", "claude-quota.json");
    const newer = join(fx.root, "newer.json");
    const first = JSON.stringify(rateLimit({ status: "allowed", resetsAt: sec + H, rateLimitType: "five_hour", utilization: 0.4, unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: sec + H } } }));
    const result = JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.1, session_id: "s1", result: "ok" });
    const fake = join(fx.root, "claude");
    // the first run reports a window and leaves no report; before the resume, another lane records a newer one
    writeFileSync(fake, `#!/bin/sh\ncase "$*" in\n  *--resume*) cp ${newer} ${quotaFile}; printf '%s\\n' '${result}'; echo done > ${fx.report}.md; echo '{}' > ${fx.report}.json ;;\n  *) printf '%s\\n' '${first}' '${result}' ;;\nesac\n`);
    chmodSync(fake, 0o755);
    process.env.IDD_CLAUDE_BIN = fake;
    try {
      const { rec } = prepareLane(fx.specPath);
      const other = { status: "allowed", windows: { five_hour: { utilization: 0.7, resets_at: sec + H } }, observed_at: new Date().toISOString(), lane: "OTHER" };
      writeFileSync(newer, JSON.stringify({ accounts: { [fx.cfg]: other } }));
      const done = await executeLane(rec.id);
      expect(done.resumes).toBe(1);
      expect(done.status).toBe("done");
      expect(readClaudeQuota(fx.cfg)?.lane).toBe("OTHER");
      expect(readLane(rec.id).claude_quota?.windows.five_hour.utilization).toBe(0.4);
    } finally { clearEnv(); }
  });
});
