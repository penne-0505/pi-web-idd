import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isClaudeQuotaBlocked, recordClaudeQuota, ClaudeQuotaBlocked } from "../src/claude-quota.ts";
import { isConversation, liveConversationIds, queueMessage } from "../src/conversation.ts";
import * as pipelineStart from "../src/pipeline-start.ts";
const { spawnPipelineSession } = pipelineStart;
import { pipelineQuotaFallback, pipelineResumeOptions, planPipelineSpawn, readPipelineSession, recordPipelineSession, type ClaudePipelineSpawnPlan } from "../src/pipeline-spawn.ts";
import { parseRoles } from "../src/roles.ts";
import { startReviewRuns } from "../src/review-runs.ts";
import { executeLane, prepareLane, readLane, cacheTtlOf } from "../src/runner.ts";
import { tmpDir } from "./helpers/tmp.ts";

const claudeRole = (extra = "") => `    harness: claude\n    model: opus\n    tools: [read, bash]\n    report: review\n${extra}`;
const piRole = (extra = "") => `    model: m\n    tools: [read, bash]\n    report: review\n${extra}`;

describe("a role's fallback in roles.yaml", () => {
  test("a Claude Code role names an API role to run in its place", () => {
    const file = parseRoles(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  deep:\n${claudeRole("    fallback: api\n")}  api:\n${piRole()}`);
    expect(file.roles.deep.fallback).toBe("api");
    expect(file.roles.api.fallback).toBeUndefined();
  });

  test("refuses a fallback that could not stand in when the windows run out", () => {
    const refuse = (roles: string, why: RegExp) => expect(() => parseRoles(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n${roles}`)).toThrow(why);
    refuse(`  deep:\n${claudeRole("    fallback: nope\n")}`, /roles\.deep\.fallback: 未定義の role "nope"/);
    refuse(`  deep:\n${claudeRole("    fallback: deep\n")}`, /roles\.deep\.fallback: 自分自身/);
    // a list with the same name twice would try the same role twice
    refuse(`  deep:\n${claudeRole("    fallback: [api, api]\n")}  api:\n${piRole()}`, /roles\.deep\.fallback: .*重複/);
    // the stage reads the report in its role's format
    refuse(`  deep:\n${claudeRole("    fallback: api\n")}  api:\n    model: m\n    tools: [read, bash]\n    report: free\n`, /roles\.deep\.fallback: .*report/);
    // found when the windows run out would be the worst time to find it
    refuse(`  deep:\n${claudeRole("    fallback: api\n")}  api:\n    tools: [read, bash]\n    report: review\n`, /roles\.deep\.fallback: .*model/);
    // the fallback does the stage's work: every tool the Claude Code role has (an executor's edit / write included)
    refuse(`  deep:\n    harness: claude\n    model: opus\n    tools: [read, bash, edit, write]\n    report: exec\n    fallback: api\n  api:\n    model: m\n    tools: [read, bash]\n    report: exec\n`, /roles\.deep\.fallback: .*edit, write/);
    expect(parseRoles(`models:\n  x-y:\n    model: x/y\nroles:\n  deep:\n    harness: claude\n    model: opus\n    tools: [read, bash]\n    report: review\n    fallback: api\n  api:\n    model: x-y\n    tools: [read, bash, grep]\n    report: review\n`).roles.deep.fallback).toBe("api");
  });

  test("a fallback may be a list, and the harness direction does not matter", () => {
    // an API role may name a fallback too, and a Claude role may stand in for another Claude role: the order is
    // tried in turn, so a route that cannot run is skipped rather than refused at load time
    const file = parseRoles(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  api:\n${piRole("    fallback: [api2, deep]\n")}  api2:\n${piRole()}  deep:\n${claudeRole()}`);
    expect(file.roles.api.fallback).toEqual(["api2", "deep"]);
    const one = parseRoles(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  api:\n${piRole("    fallback: [api2]\n")}  api2:\n${piRole()}`);
    expect(one.roles.api.fallback).toEqual(["api2"]);
  });
});

/** a logged-in lane config dir, a git worktree, and roles; nothing real starts */
function fixture(roles: string) {
  const root = tmpDir("idd-fallback-");
  const cfg = join(root, "cfg"); mkdirSync(cfg); writeFileSync(join(cfg, ".credentials.json"), "{}");
  const wt = join(root, "wt"); mkdirSync(wt);
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: (execFileSync("git", ["init", "-q", wt]), wt) });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
  writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${cfg}\n${roles}`);
  writeFileSync(join(root, "repos.yaml"), "repos:\n");
  const agent = join(root, "agent"); mkdirSync(agent);
  const noRoot = join(root, "no-lane-root"); mkdirSync(noRoot);
  const ran = join(root, "ran");
  const report = join(root, "out", "report");
  // a pi that writes the deliverable, and a claude that must never run
  const fakePi = join(root, "pi"); writeFileSync(fakePi, `#!/bin/sh\ncase "$*" in *--list-models*) exit 0 ;; esac\necho pi >> ${ran}\nmkdir -p ${join(root, "out")}\necho done > ${report}.md\necho '{"findings":[]}' > ${report}.json\n`); chmodSync(fakePi, 0o755);
  const fakeClaude = join(root, "claude"); writeFileSync(fakeClaude, `#!/bin/sh\necho claude >> ${ran}\nexit 1\n`); chmodSync(fakeClaude, 0o755);
  Object.assign(process.env, {
    IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"),
    IDD_LANE_ROOT: noRoot, IDD_LANE_SCOPE: "off", IDD_PI_BIN: fakePi, IDD_PI_USER_AGENT_DIR: agent, IDD_CLAUDE_BIN: fakeClaude,
  });
  const specPath = join(root, "spec.yaml");
  writeFileSync(specPath, `role: deep\nworktree: ${wt}\nreport: ${report}\ntask: t\n`);
  const ranWith = () => (existsSync(ran) ? readFileSync(ran, "utf8").trim().split("\n") : []);
  return { root, cfg, wt, head, report, specPath, ranWith };
}
const clearEnv = () => { for (const k of ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_REPOS_FILE", "IDD_LANE_ROOT", "IDD_LANE_SCOPE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR", "IDD_CLAUDE_BIN"]) delete process.env[k]; };
const future = () => Math.floor(Date.now() / 1000) + 3600;
const overWindow = (cfg: string, resetsAt = future()) => recordClaudeQuota(cfg, { status: "allowed_warning", windows: { five_hour: { utilization: 0.95, resets_at: resetsAt } } });

describe("a short stage refused for the windows", () => {
  test("a lane of a Claude Code role with a fallback runs on the fallback, and says so on its record", async () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  deep:\n${claudeRole("    fallback: api\n")}  api:\n${piRole()}`);
    try {
      const resetsAt = future();
      overWindow(fx.cfg, resetsAt);
      const { rec } = prepareLane(fx.specPath);
      expect(rec.role).toBe("api");
      expect(rec.model).toBe("x/y");
      expect(rec.role_preset?.harness).toBe("pi");
      expect(rec.quota_fallback).toMatchObject({ role: "deep", fallback: "api", resets_at: resetsAt });
      expect(rec.quota_fallback?.reason).toMatch(/5 時間の枠 95%/);
      const args = JSON.parse(readFileSync(join(fx.root, "state", "lanes", rec.id, "pi-args.json"), "utf8")) as string[];
      expect(args[0]).toBe(process.env.IDD_PI_BIN as string);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("done");
      expect(fx.ranWith()).toEqual(["pi"]);
      expect(readLane(rec.id).quota_fallback?.fallback).toBe("api");
    } finally { clearEnv(); }
  });

  test("with the windows open, the Claude Code role runs as written", () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  deep:\n${claudeRole("    fallback: api\n")}  api:\n${piRole()}`);
    try {
      const { rec } = prepareLane(fx.specPath, { dryRun: true });
      expect(rec.role).toBe("deep");
      expect(rec.role_preset?.harness).toBe("claude");
      expect(rec.quota_fallback).toBeUndefined();
    } finally { clearEnv(); }
  });

  test("with no fallback, the lane waits for the windows as before and takes no lane id", () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  deep:\n${claudeRole()}`);
    try {
      overWindow(fx.cfg);
      let caught: unknown;
      try { prepareLane(fx.specPath); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(ClaudeQuotaBlocked);
      expect(readdirSync(join(fx.root, "state", "lanes")).filter((f) => f !== "shim")).toEqual([]);
    } finally { clearEnv(); }
  });

  test("a lapsed login is not the windows: it fails, with no fallback", () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  deep:\n${claudeRole("    fallback: api\n")}  api:\n${piRole()}`);
    try {
      overWindow(fx.cfg);
      execFileSync("rm", [join(fx.cfg, ".credentials.json")]);
      const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      try {
        expect(() => prepareLane(fx.specPath)).toThrow(/ログインしていません/);
      } finally { if (token !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = token; }
    } finally { clearEnv(); }
  });

  test("a stage swaps only its Claude Code role for the fallback; its other roles run as they are", async () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  pi-blind:\n${piRole()}  deep:\n${claudeRole("    fallback: api\n")}  api:\n${piRole()}pipeline:\n  review_blind: { roles: [pi-blind, deep] }\n`);
    try {
      const resetsAt = future();
      overWindow(fx.cfg, resetsAt);
      const { runIds, fallbacks } = await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: fx.wt, base: fx.head, head: fx.head, inputs: [] });
      expect(runIds.length).toBe(2);
      expect(runIds.map((id) => readLane(id).role)).toEqual(["pi-blind", "api"]);
      expect(fallbacks).toEqual([{ role: "deep", fallback: "api", kind: "quota", reason: expect.stringMatching(/5 時間の枠/), resets_at: resetsAt }]);
      const meta = JSON.parse(readFileSync(join(fx.root, "state", "pipeline", "review-runs", `${runIds[1]}.json`), "utf8")) as Record<string, unknown>;
      expect(meta.role).toBe("api");
      expect(meta.quota_fallback).toMatchObject({ role: "deep", fallback: "api" });
      const first = JSON.parse(readFileSync(join(fx.root, "state", "pipeline", "review-runs", `${runIds[0]}.json`), "utf8")) as Record<string, unknown>;
      expect(first.quota_fallback).toBeUndefined();
      // the fallback's report goes where the Claude Code role's would have, not onto the other reviewer's
      expect(readLane(runIds[1]).report).toMatch(/1-blind-deep-[0-9a-f]{6}\/report$/);
      expect(readLane(runIds[0]).report).toMatch(/1-blind-pi-blind-m-[0-9a-f]{6}\/report$/);
    } finally { clearEnv(); }
  });

  test("a stage whose Claude Code roles are not all covered by a fallback waits whole, starting nothing", async () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  deep:\n${claudeRole("    fallback: api\n")}  deep2:\n${claudeRole()}  api:\n${piRole()}pipeline:\n  review_blind: { roles: [deep, deep2] }\n`);
    try {
      overWindow(fx.cfg);
      let caught: unknown;
      try { await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: fx.wt, base: fx.head, head: fx.head, inputs: [] }); } catch (err) { caught = err; }
      expect(isClaudeQuotaBlocked(caught)).toBe(true);
      expect(readdirSync(join(fx.root, "state", "lanes")).filter((f) => f !== "shim")).toEqual([]);
    } finally { clearEnv(); }
  });

  test("with the windows open, a stage reports no fallback", async () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  deep:\n${claudeRole("    fallback: api\n")}  api:\n${piRole()}pipeline:\n  review_blind: { roles: [deep] }\n`);
    try {
      const { runIds, fallbacks } = await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: fx.wt, base: fx.head, head: fx.head, inputs: [] });
      expect(fallbacks).toBeUndefined();
      expect(readLane(runIds[0]).role).toBe("deep");
    } finally { clearEnv(); }
  });

  test("a role named in noFallback holds the stage for the windows even when it has a fallback (a High lane's final)", async () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  pi-blind:\n${piRole()}  deep:\n${claudeRole("    fallback: api\n")}  api:\n${piRole()}pipeline:\n  review_blind: { roles: [pi-blind, deep] }\n`);
    try {
      overWindow(fx.cfg);
      let caught: unknown;
      try { await startReviewRuns({ iddId: "IDD-1", stage: "final", round: 1, worktree: fx.wt, base: fx.head, head: fx.head, inputs: [], noFallbackRoles: ["deep"] }); } catch (err) { caught = err; }
      expect(isClaudeQuotaBlocked(caught)).toBe(true);
      expect(readdirSync(join(fx.root, "state", "lanes")).filter((f) => f !== "shim")).toEqual([]);
      // a role not named still falls back as it did
      const { fallbacks } = await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: fx.wt, base: fx.head, head: fx.head, inputs: [], noFallbackRoles: ["pi-blind"] });
      expect(fallbacks?.[0]?.role).toBe("deep");
    } finally { clearEnv(); }
  });
});

describe("a conversation lane refused for the windows at spawn", () => {
  const withRoles = (yaml: string) => {
    const dir = tmpDir("idd-fallback-roles-");
    writeFileSync(join(dir, "roles.yaml"), yaml);
    process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
    process.env.IDD_STATE_DIR = tmpDir("idd-fallback-state-");
  };
  const blocked = () => new ClaudeQuotaBlocked("Claude の枠が止める閾値に達しているので lane を起動しません: 5 時間の枠 95%", 1_790_000_000);

  test("the slot's fallback is planned as a pi session, and the session record keeps what it stood in for", () => {
    withRoles(`models:\n  openrouter-z-ai-glm-5.3:\n    model: openrouter/z-ai/glm-5.3\nroles:\n  c: { harness: claude, model: opus, thinking: xhigh, fallback: p }\n  p: { model: openrouter-z-ai-glm-5.3, thinking: high }\npipeline:\n  planner: { role: c }\n`);
    try {
      const plan = planPipelineSpawn("planner", { checkStartable: () => {} }) as ClaudePipelineSpawnPlan;
      const next = pipelineQuotaFallback(plan, blocked(), { checkStartable: () => {} });
      expect(next).toMatchObject({ harness: "pi", slot: "planner", role: "p", model: "openrouter/z-ai/glm-5.3", thinkingLevel: "high", initialModel: { provider: "openrouter", modelId: "z-ai/glm-5.3" } });
      expect(next.agentDir).toMatch(/\/pipeline\/agent\/p$/);
      expect(next.quotaFallback).toEqual({ role: "c", fallback: "p", kind: "quota", reason: expect.stringMatching(/5 時間の枠/), resets_at: 1_790_000_000 });
      recordPipelineSession("sess-f", next);
      expect(readPipelineSession("sess-f")).toMatchObject({ role: "p", quota_fallback: { role: "c", fallback: "p" } });
      expect(readPipelineSession("sess-f")?.harness).toBeUndefined();
      // a resume after the idle shutdown comes back as the fallback's pi session
      expect(pipelineResumeOptions("sess-f", { prepareAgentDir: (r) => `/agent/${r.name}` })).toEqual({ agentDir: "/agent/p" });
    } finally { delete process.env.IDD_ROLES_FILE; delete process.env.IDD_STATE_DIR; }
  });

  test("with no fallback, or for another error, the refusal is thrown on as it was", () => {
    withRoles(`models:\n  openrouter-z-ai-glm-5.3:\n    model: openrouter/z-ai/glm-5.3\nroles:\n  c: { harness: claude, model: opus, thinking: xhigh }\n  d: { harness: claude, model: opus, thinking: xhigh, fallback: p }\n  p: { model: openrouter-z-ai-glm-5.3, thinking: high }\npipeline:\n  planner: { role: c }\n  executor: { role: d }\n`);
    try {
      const plan = planPipelineSpawn("planner", { checkStartable: () => {} }) as ClaudePipelineSpawnPlan;
      const err = blocked();
      expect(() => pipelineQuotaFallback(plan, err, { checkStartable: () => {} })).toThrow(err);
      const withFallback = planPipelineSpawn("executor", { checkStartable: () => {} }) as ClaudePipelineSpawnPlan;
      const other = new Error("ログインしていません");
      expect(() => pipelineQuotaFallback(withFallback, other, { checkStartable: () => {} })).toThrow(other);
    } finally { delete process.env.IDD_ROLES_FILE; delete process.env.IDD_STATE_DIR; }
  });
});

describe("the fallback is settled before anything starts", () => {
  const unpriced = `  api:\n    model: u\n    tools: [read, bash]\n    report: review\n`;

  test("a fallback that cannot start (no price for its model) leaves the stage waiting, with no run started", async () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  ok:\n${piRole()}  deep:\n${claudeRole("    fallback: api\n")}${unpriced}pipeline:\n  review_blind: { roles: [ok, deep] }\n`);
    try {
      overWindow(fx.cfg);
      let caught: unknown;
      try { await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: fx.wt, base: fx.head, head: fx.head, inputs: [] }); } catch (err) { caught = err; }
      expect(isClaudeQuotaBlocked(caught)).toBe(true);
      expect(String((caught as Error).message)).toMatch(/代わりの api も起動できない.*価格/);
      expect(readdirSync(join(fx.root, "state", "lanes")).filter((f) => f !== "shim")).toEqual([]);
      const copies = join(fx.root, "state", "pipeline", "review-wt");
      expect(existsSync(copies) ? readdirSync(copies) : []).toEqual([]);
      expect(fx.ranWith()).toEqual([]);
    } finally { clearEnv(); }
  });

  test("a single lane whose fallback cannot start waits too, and takes no lane id", () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  deep:\n${claudeRole("    fallback: api\n")}${unpriced}`);
    try {
      overWindow(fx.cfg);
      let caught: unknown;
      try { prepareLane(fx.specPath); } catch (err) { caught = err; }
      expect(isClaudeQuotaBlocked(caught)).toBe(true);
      expect(readdirSync(join(fx.root, "state", "lanes")).filter((f) => f !== "shim")).toEqual([]);
    } finally { clearEnv(); }
  });

  test("a lane run with its model overridden is not switched to the fallback: it waits", () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  deep:\n${claudeRole("    fallback: api\n")}  api:\n${piRole()}`);
    try {
      overWindow(fx.cfg);
      let caught: unknown;
      try { prepareLane(fx.specPath, { model: "anthropic/claude-x" }); } catch (err) { caught = err; }
      expect(isClaudeQuotaBlocked(caught)).toBe(true);
      expect(readdirSync(join(fx.root, "state", "lanes")).filter((f) => f !== "shim")).toEqual([]);
    } finally { clearEnv(); }
  });

  test("fallbacks that land on a role the stage already runs are folded into that one run", async () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  api:\n${piRole()}  deep:\n${claudeRole("    fallback: api\n")}  deep2:\n${claudeRole("    fallback: api\n")}pipeline:\n  review_blind: { roles: [api, deep, deep2] }\n`);
    try {
      overWindow(fx.cfg);
      const { runIds, fallbacks } = await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: fx.wt, base: fx.head, head: fx.head, inputs: [] });
      expect(runIds.map((id) => readLane(id).role)).toEqual(["api"]);
      expect(runIds.map((id) => readLane(id).quota_fallback)).toEqual([undefined]);
      expect(fallbacks?.map((f) => [f.role, f.fallback, f.folded])).toEqual([["deep", "api", true], ["deep2", "api", true]]);
    } finally { clearEnv(); }
  });

  test("two Claude Code roles with the same fallback run it once", async () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  deep:\n${claudeRole("    fallback: api\n")}  deep2:\n${claudeRole("    fallback: api\n")}  api:\n${piRole()}pipeline:\n  review_blind: { roles: [deep, deep2] }\n`);
    try {
      overWindow(fx.cfg);
      const { runIds, fallbacks } = await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: fx.wt, base: fx.head, head: fx.head, inputs: [] });
      expect(runIds.map((id) => readLane(id).role)).toEqual(["api"]);
      expect(readLane(runIds[0]).quota_fallback?.role).toBe("deep");
      expect(fallbacks?.map((f) => [f.role, f.fallback, f.folded ?? false])).toEqual([["deep", "api", false], ["deep2", "api", true]]);
    } finally { clearEnv(); }
  });
});

describe("the runtime's spawn of a pipeline slot", () => {
  const slot = (fallback = "    fallback: api\n", api = `  api:\n    model: m\n    thinking: high\n`) =>
    `models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  deep:\n    harness: claude\n    model: opus\n    thinking: xhigh\n${fallback}${api}pipeline:\n  planner: { role: deep }\n`;

  test("refused for the windows, a claude slot with a fallback opens the fallback's pi conversation and says so", async () => {
    const fx = fixture(slot());
    try {
      const resetsAt = future();
      overWindow(fx.cfg, resetsAt);
      const r = await spawnPipelineSession("planner", fx.wt, { checkStartable: () => {} });
      expect(r.harness).toBe("pi");
      expect(r.model).toBe("x/y");
      expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.fallbacks).toEqual([{ role: "deep", fallback: "api", kind: "quota", reason: expect.stringMatching(/5 時間の枠/), resets_at: resetsAt }]);
      const rec = readPipelineSession(r.sessionId);
      expect(rec).toMatchObject({ role: "api", slot: "planner", harness: "pi", quota_fallback: { role: "deep", fallback: "api" } });
      expect(rec?.lane_id).toBeTruthy();
      expect(rec?.agent_dir).toMatch(/\/pipeline\/agent\/api$/);
      expect(isConversation(r.sessionId)).toBe(true);
      // a conversation is fed by its supervisor, so nothing in-process resumes it
      expect(pipelineResumeOptions(r.sessionId)).toEqual({});
    } finally { clearEnv(); }
  });

  test("with the windows open, it claims a Claude Code conversation", async () => {
    const fx = fixture(slot());
    try {
      const r = await spawnPipelineSession("planner", fx.wt, { checkStartable: () => {} });
      expect(r.harness).toBe("claude");
      expect(r.fallbacks).toBeUndefined();
      expect(isConversation(r.sessionId)).toBe(true);
      expect(readPipelineSession(r.sessionId)).toMatchObject({ harness: "claude", lane_id: expect.any(String) });
      // the reported hold is the one the conversation actually runs with (a default claude conversation is an
      // hour), not the plain run's five minutes: idd-core wraps the checks only when this reads 5m
      const laneId = readPipelineSession(r.sessionId)?.lane_id ?? "";
      expect(r.cacheTtl).toBe("1h");
      expect(r.cacheTtl).toBe(cacheTtlOf(readLane(laneId)));
    } finally { clearEnv(); }
  });

  test("a slot whose role holds the cache 5 minutes still reports 5 minutes", async () => {
    const fx = fixture(`models:\n  x-y:\n    model: x/y\nroles:\n  deep:\n    harness: claude\n    model: opus\n    thinking: xhigh\n    cache_ttl: 5m\n    fallback: api\n  api:\n    model: x-y\n    thinking: high\npipeline:\n  planner: { role: deep }\n`);
    try {
      const r = await spawnPipelineSession("planner", fx.wt, { checkStartable: () => {} });
      expect(r.harness).toBe("claude");
      expect(r.cacheTtl).toBe("5m");
    } finally { clearEnv(); }
  });

  test("a conversation whose start the engine refused is taken back: no longer a conversation, and its lane stopped", async () => {
    const fx = fixture(slot());
    try {
      const r = await spawnPipelineSession("planner", fx.wt, { checkStartable: () => {} });
      const laneId = readPipelineSession(r.sessionId)?.lane_id ?? "";
      expect(isConversation(r.sessionId)).toBe(true);
      pipelineStart.discardPipelineSession(r.sessionId);
      expect(isConversation(r.sessionId)).toBe(false);
      expect(readPipelineSession(r.sessionId)).toBeNull();
      expect(readLane(laneId).status).toBe("stopped");
      expect(liveConversationIds()).not.toContain(r.sessionId);
    } finally { clearEnv(); }
  });

  test("a pi conversation whose start the engine refused is taken back the same way", async () => {
    const fx = fixture(slot());
    try {
      overWindow(fx.cfg);
      const r = await spawnPipelineSession("planner", fx.wt, { checkStartable: () => {} });
      expect(r.harness).toBe("pi");
      const laneId = readPipelineSession(r.sessionId)?.lane_id ?? "";
      pipelineStart.discardPipelineSession(r.sessionId);
      expect(isConversation(r.sessionId)).toBe(false);
      expect(readPipelineSession(r.sessionId)).toBeNull();
      expect(readLane(laneId).status).toBe("stopped");
    } finally { clearEnv(); }
  });

  test("a conversation that was already given a message is not taken back", async () => {
    const fx = fixture(slot());
    try {
      const r = await spawnPipelineSession("planner", fx.wt, { checkStartable: () => {} });
      const laneId = readPipelineSession(r.sessionId)?.lane_id ?? "";
      queueMessage(laneId, "brief");
      expect(() => pipelineStart.discardPipelineSession(r.sessionId)).toThrow(/始まっている/);
      expect(isConversation(r.sessionId)).toBe(true);
      expect(readLane(laneId).status).toBe("idle");
    } finally { clearEnv(); }
  });

  test("with no fallback, or a fallback that cannot start, the slot waits and nothing starts", async () => {
    for (const [roles, check] of [[slot(""), () => {}], [slot(), () => { throw new Error("価格が分からない"); }]] as const) {
      const fx = fixture(roles);
      try {
        overWindow(fx.cfg);
        let caught: unknown;
        try { await spawnPipelineSession("planner", fx.wt, { checkStartable: check }); } catch (err) { caught = err; }
        expect(isClaudeQuotaBlocked(caught)).toBe(true);
        expect(readdirSync(join(fx.root, "state", "lanes")).filter((f) => f !== "shim")).toEqual([]);
      } finally { clearEnv(); }
    }
  });
});

describe("a mapped round refused for the windows", () => {
  /** base: the repo's rules (one scoped to lib/p1.dart, one for every file); head: lib/p1.dart and lib/p2.dart */
  function mappedDiff(wt: string): { base: string; head: string } {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd: wt, encoding: "utf8" }).trim();
    mkdirSync(join(wt, ".claude", "rules"), { recursive: true });
    writeFileSync(join(wt, "AGENTS.md"), "# a\n");
    writeFileSync(join(wt, ".claude", "rules", "p1.md"), "---\npaths:\n  - lib/p1.dart\n---\np1 の規則\n");
    writeFileSync(join(wt, ".claude", "rules", "all.md"), "全体の規則\n");
    git("add", "-A"); git("commit", "-q", "-m", "rules");
    const base = git("rev-parse", "HEAD");
    mkdirSync(join(wt, "lib"), { recursive: true });
    writeFileSync(join(wt, "lib", "p1.dart"), "x1\n");
    writeFileSync(join(wt, "lib", "p2.dart"), "x2\n");
    git("add", "-A"); git("commit", "-q", "-m", "head");
    return { base, head: git("rev-parse", "HEAD") };
  }
  const route = (n: number) => ({ id: `R-${n}`, paths: [`lib/p${n}.dart`], question: `問い ${n}`, harms: ["authority"] as ("authority" | "irreversible" | "shown_vs_sent")[] });
  const specOf = (id: string) => readFileSync(join(readLane(id).report, "..", "spec.yaml"), "utf8");
  const briefOf = (id: string) => readFileSync(join(process.env.IDD_STATE_DIR as string, "lanes", id, "brief.md"), "utf8");

  test("no blind is folded: each route keeps its own run, and the leftovers read the whole diff, on the fallback", async () => {
    // the routes run on the first role (deep) and its fallback api is also the second role the leftovers use
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  deep:\n${claudeRole("    fallback: api\n")}  api:\n${piRole()}pipeline:\n  review_blind: { roles: [deep, api], concurrency: 2 }\n`);
    try {
      const { base, head } = mappedDiff(fx.wt);
      overWindow(fx.cfg);
      const res = await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: fx.wt, base, head, inputs: [], routes: [route(1), route(2)] });
      expect(res.runIds).toHaveLength(3);
      expect(res.runIds.map((id) => readLane(id).role)).toEqual(["api", "api", "api"]);
      // the whole-diff (leftovers) blind is the round's judge; the route blinds are read on the fallback
      expect(res.wholeDiff).toEqual([res.runIds[2]]);
      expect(res.fallbacks?.map((f) => [f.role, f.fallback, f.folded ?? false])).toEqual([["deep", "api", false], ["deep", "api", false]]);
      // each run's report is named after its part of the diff and the role the round asked for
      expect(res.runIds.map((id) => readLane(id).report)).toEqual([
        expect.stringMatching(/1-blind-r1-deep-[0-9a-f]{6}\/report$/), expect.stringMatching(/1-blind-r2-deep-[0-9a-f]{6}\/report$/), expect.stringMatching(/1-blind-rest-api-m-[0-9a-f]{6}\/report$/),
      ]);
      const [r1, , rest] = res.runIds;
      // neither the route blind nor the leftovers blind scopes its diff: both read the whole diff
      expect(specOf(r1)).not.toContain("paths:");
      expect(specOf(rest)).not.toContain("paths:");
      // the rules that apply to the diff are handed to every blind; the route's files are its reading unit
      const brief = briefOf(r1);
      expect(brief).toContain("`AGENTS.md`");
      expect(brief).toContain("`.claude/rules/p1.md`");
      expect(brief).toContain("`.claude/rules/all.md`");
      expect(brief).toContain("経路: `lib/p1.dart`");
      expect(briefOf(rest)).toContain("`.claude/rules/p1.md`");
      expect(briefOf(rest)).toContain("この差分全体を読む");
    } finally { clearEnv(); }
  });

  test("a map on a Claude Code role runs on its fallback and says so", async () => {
    const mapper = (extra = "") => `    harness: claude\n    model: opus\n    tools: [read]\n    report: map\n${extra}`;
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  mapc:\n${mapper("    fallback: mapapi\n")}  mapapi:\n    model: m\n    tools: [read]\n    report: map\n  api:\n${piRole()}  api2:\n${piRole()}pipeline:\n  review_blind: { roles: [api, api2], concurrency: 1 }\n  risk_map: { role: mapc, min_lines: 1 }\n`);
    try {
      const { base, head } = mappedDiff(fx.wt);
      overWindow(fx.cfg);
      const res = await startReviewRuns({ iddId: "IDD-1", stage: "map", round: 1, worktree: fx.wt, base, head, inputs: [] });
      expect(res.runIds.map((id) => readLane(id).role)).toEqual(["mapapi"]);
      expect(res.fallbacks?.map((f) => [f.role, f.fallback])).toEqual([["mapc", "mapapi"]]);
    } finally { clearEnv(); }
  });

  test("a map on a Claude Code role without a fallback waits for the windows, starting nothing", async () => {
    const fx = fixture(`models:\n  m:\n    model: x/y\n  u:\n    model: openrouter/unpriced/m\nroles:\n  mapc:\n    harness: claude\n    model: opus\n    tools: [read]\n    report: map\n  api:\n${piRole()}  api2:\n${piRole()}pipeline:\n  review_blind: { roles: [api, api2], concurrency: 1 }\n  risk_map: { role: mapc, min_lines: 1 }\n`);
    try {
      const { base, head } = mappedDiff(fx.wt);
      overWindow(fx.cfg);
      let caught: unknown;
      try { await startReviewRuns({ iddId: "IDD-1", stage: "map", round: 1, worktree: fx.wt, base, head, inputs: [] }); } catch (err) { caught = err; }
      expect(isClaudeQuotaBlocked(caught)).toBe(true);
      expect(readdirSync(join(fx.root, "state", "lanes")).filter((f) => f !== "shim")).toEqual([]);
    } finally { clearEnv(); }
  });
});
