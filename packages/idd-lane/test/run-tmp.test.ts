import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseRepos } from "../../idd-core/src/config/areas.ts";
import { acquireLock } from "../src/conversation-lock.ts";
import { conversationReplyEnv, conversationStatus, deliverToConversation, openConversation, piConversationEnv, queueMessage } from "../src/conversation.ts";
import { planPipelineSpawn, type ClaudePipelineSpawnPlan } from "../src/pipeline-spawn.ts";
import { parseLaneRepos } from "../src/repos.ts";
import { parseRoles } from "../src/roles.ts";
import { runTmpDir } from "../src/run-tmp.ts";
import { laneDir, laneEnv, prepareLane, readLane, sendLane, writeLane, type LaneRecord } from "../src/runner.ts";
import { superviseLane } from "../src/supervisor.ts";

const ENV_KEYS = [
  "IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_REPOS_FILE", "IDD_LANE_ROOT", "IDD_LANE_SCOPE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR",
  "IDD_CLAUDE_BIN", "IDD_CLAUDE_CONFIG_DIR", "FAKE_PI_TOOL", "FAKE_PI_REPORT", "FAKE_SEEN", "TMPDIR", "TEMP", "TMP",
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const roots: string[] = [];

afterEach(async () => {
  // let a conversation's supervisor started by the test finish before its directories go
  await new Promise((r) => setTimeout(r, 200));
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/**
 * A stand-in for pi that runs FAKE_PI_TOOL as pi runs a bash tool call: through the shell its agent dir's settings
 * name (the lane's own lane-bash), with the environment pi was given. It writes down which shell it used.
 */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("--list-models")) process.exit(0);
const settings = JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR + "/settings.json", "utf8"));
const shell = settings.shellPath;
fs.writeFileSync(process.env.FAKE_SEEN + ".shell", String(shell));
const r = spawnSync(shell, ["-c", process.env.FAKE_PI_TOOL], { encoding: "utf8" });
process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: {} }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolName: "bash", result: { exit: r.status } }) + "\\n");
const report = process.env.FAKE_PI_REPORT;
fs.writeFileSync(report + ".md", "ok");
fs.writeFileSync(report + ".json", JSON.stringify({ exit: r.status }));
`;

/**
 * A stand-in for \`claude -p\` that writes down the temp dir it was given, whether an earlier reply's file is still
 * there, and leaves a file in it, as flutter test does
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const session = at("--session-id") ?? at("--resume");
try { fs.readFileSync(0, "utf8"); } catch {}
const dir = process.env.TMPDIR;
const kept = fs.existsSync(dir + "/flutter_tools.leftover");
let made = false;
try { fs.writeFileSync(dir + "/flutter_tools.leftover", "x"); made = true; } catch {}
fs.appendFileSync(process.env.FAKE_SEEN, JSON.stringify({ TMPDIR: dir, TEMP: process.env.TEMP, TMP: process.env.TMP, made, kept }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: session });
out({ type: "assistant", message: { content: [{ type: "text", text: "answered" }] } });
out({ type: "result", subtype: "success", is_error: false, result: "answered", total_cost_usd: 0.1, session_id: session, usage: { input_tokens: 1, output_tokens: 1 } });
`;

/** a registered repo whose worktree is `wt`; `tmp` is the repo's tmp_dir, or none */
function fixture(tmp: (root: string) => string | null) {
  const root = mkdtempSync(join(tmpdir(), "idd-run-tmp-"));
  roots.push(root);
  const wt = join(root, "wt"); mkdirSync(wt);
  execFileSync("git", ["init", "-q", wt]);
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: wt });
  const cfg = join(root, "claude-cfg"); mkdirSync(cfg);
  writeFileSync(join(cfg, ".credentials.json"), "{}");
  writeFileSync(join(root, "roles.yaml"), [
    "defaults:",
    `  claude_config_dir: ${cfg}`,
    "  tool_timeout_minutes: 5",
    "models:",
    "  x-y:",
    "    model: x/y",
    "roles:",
    "  r: { model: x-y, tools: [read, bash], report: free, require_clean: false, budget_minutes: 2 }",
    "  planner-claude: { harness: claude, model: opus, tools: [read, bash], report: free, budget_minutes: 2 }",
    "pipeline:",
    "  planner: { role: planner-claude }",
    "",
  ].join("\n"));
  const tmpRoot = tmp(root);
  writeFileSync(join(root, "repos.yaml"), `repos:\n  me/app:\n    upstream: ${wt}\n    work: ${join(root, "work")}\n${tmpRoot ? `    tmp_dir: ${tmpRoot}\n` : ""}`);
  const agent = join(root, "agent"); mkdirSync(agent);
  const noRoot = join(root, "no-lane-root"); mkdirSync(noRoot);
  const fakePi = join(root, "pi"); writeFileSync(fakePi, FAKE_PI); chmodSync(fakePi, 0o755);
  const fakeClaude = join(root, "claude"); writeFileSync(fakeClaude, FAKE_CLAUDE); chmodSync(fakeClaude, 0o755);
  const report = join(root, "out", "report");
  mkdirSync(join(root, "out"));
  const seen = join(root, "seen");
  Object.assign(process.env, {
    IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"),
    IDD_LANE_ROOT: noRoot, IDD_LANE_SCOPE: "off", IDD_PI_BIN: fakePi, IDD_PI_USER_AGENT_DIR: agent, IDD_CLAUDE_BIN: fakeClaude,
    IDD_CLAUDE_CONFIG_DIR: cfg, FAKE_PI_REPORT: report, FAKE_SEEN: seen,
  });
  // what the run's shell sees, and whether it can leave a file in its temp dir
  process.env.FAKE_PI_TOOL = `printf '%s\\n' "TMPDIR=$TMPDIR" "TEMP=$TEMP" "TMP=$TMP" > ${seen}; touch "\${TMPDIR:-/nonexistent}/flutter_tools.leftover" && echo made >> ${seen}`;
  const specPath = join(root, "spec.yaml");
  writeFileSync(specPath, `role: r\nworktree: ${wt}\nreport: ${report}\ntask: t\n`);
  return { root, wt, specPath, seen, tmpRoot };
}

/** the supervisor, without the tick and with the scope's cleanup stood in for */
function supervise(id: string, settle: () => Promise<string[]> = async () => []) {
  return superviseLane(id, { kick: () => ({ outcome: "off" }), settle: async () => settle() });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(50);
  }
}

const seenLines = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean);

describe("a lane run's temp dir on a repo that names one (tmp_dir)", () => {
  test("the run's shell (pi's lane-bash) gets TMPDIR, TEMP and TMP at <tmp_dir>/<state>/<run id>, can write there, and the dir goes after the scope's cleanup", async () => {
    const fx = fixture((root) => join(root, "lane-tmp"));
    const { rec } = prepareLane(fx.specPath);
    const own = runTmpDir(rec.id, fx.wt) as string;
    expect(dirname(dirname(own))).toBe(fx.tmpRoot as string);
    let atSettle: boolean | undefined;
    const { rec: done } = await supervise(rec.id, async () => { atSettle = existsSync(own); return []; });
    expect(done.status).toBe("done");
    // the tool call went through the lane's own shell, as pi's does
    expect(readFileSync(`${fx.seen}.shell`, "utf8")).toBe(join(laneDir(rec.id), "agent", "lane-bash"));
    expect(seenLines(fx.seen)).toEqual([`TMPDIR=${own}`, `TEMP=${own}`, `TMP=${own}`, "made"]);
    // the processes the run left are settled while the dir is still there; it goes after
    expect(atSettle).toBe(true);
    expect(existsSync(own)).toBe(false);
    expect(existsSync(fx.tmpRoot as string)).toBe(true);
  }, 30_000);

  test("the setup gets the dir too, and a run that ends without starting its agent (setup failed) leaves no dir either", async () => {
    const fx = fixture((root) => join(root, "lane-tmp"));
    const setupSeen = join(fx.root, "setup-seen");
    writeFileSync(fx.specPath, `${readFileSync(fx.specPath, "utf8")}setup:\n  - 'echo "$TMPDIR" > ${setupSeen}; exit 3'\n`);
    const { rec } = prepareLane(fx.specPath);
    const { rec: done } = await supervise(rec.id);
    expect(done.status).toBe("failed");
    expect(readFileSync(setupSeen, "utf8").trim()).toBe(runTmpDir(rec.id, fx.wt) as string);
    expect(existsSync(runTmpDir(rec.id, fx.wt) as string)).toBe(false);
  }, 30_000);

  test("a follow-up (sendLane) gets the run's dir and takes it down when it ends", async () => {
    const fx = fixture((root) => join(root, "lane-tmp"));
    const { rec } = prepareLane(fx.specPath);
    await supervise(rec.id);
    const own = runTmpDir(rec.id, fx.wt) as string;
    expect(existsSync(own)).toBe(false);
    writeLane({ ...readLane(rec.id), session_file: join(fx.root, "session.jsonl") });
    rmSync(fx.seen);
    const done = await sendLane(rec.id, "one more thing");
    expect(done.exit).toBe(0);
    expect(seenLines(fx.seen)).toEqual([`TMPDIR=${own}`, `TEMP=${own}`, `TMP=${own}`, "made"]);
    expect(existsSync(own)).toBe(false);
  }, 30_000);

  test("a follow-up is refused while the run's supervisor is still alive, and makes no dir", async () => {
    const fx = fixture((root) => join(root, "lane-tmp"));
    const { rec } = prepareLane(fx.specPath);
    await supervise(rec.id);
    // another process stands in for the supervisor that is still settling the run
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeLane({ ...readLane(rec.id), session_file: join(fx.root, "session.jsonl"), supervisor_pid: other.pid });
      await expect(sendLane(rec.id, "one more thing")).rejects.toThrow(/監督がまだ動いています/);
      expect(existsSync(runTmpDir(rec.id, fx.wt) as string)).toBe(false);
    } finally {
      other.kill("SIGKILL");
    }
  }, 30_000);

  test("a second supervisor that read a conversation's record half written does not take the conversation's dir", async () => {
    const fx = fixture((root) => join(root, "lane-tmp"));
    const roles = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p:\n    model: x-y\n    tools: [read]\n").roles;
    for (const kind of ["conversation", "locked"] as const) {
      const id = kind === "conversation" ? "20261113-160000-p" : "20261113-160000-p-2";
      mkdirSync(laneDir(id), { recursive: true });
      const whole = { id, role: "p", model: "x/y", worktree: fx.wt, spec: "", report: "", status: "idle", started_at: new Date().toISOString(), role_preset: roles.p, ...(kind === "conversation" ? { mode: "conversation" } : {}) } as LaneRecord;
      // the conversation's dir, and (the second case) the lock of the supervisor feeding it
      writeLane(whole);
      piConversationEnv(whole, roles.p);
      const own = runTmpDir(id, fx.wt) as string;
      expect(existsSync(own)).toBe(true);
      if (kind === "locked") acquireLock(laneDir(id));
      // the second supervisor's first read catches the record half written; by its cleanup the record is whole again
      writeFileSync(join(laneDir(id), "lane.json"), JSON.stringify(whole).slice(0, 40));
      await expect(supervise(id, async () => { writeLane(whole); return []; })).rejects.toThrow();
      expect(existsSync(own)).toBe(true);
    }
  });

  test("the leftovers of this state's runs that are gone are taken down when a run starts; a live run's, a fresh one, other names and another state's are kept", () => {
    const fx = fixture((root) => join(root, "lane-tmp"));
    const tmpRoot = fx.tmpRoot as string;
    const mine = dirname(runTmpDir("20261113-000000-x", fx.wt) as string);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const record = (id: string, fields: Partial<LaneRecord>) => {
      mkdirSync(laneDir(id), { recursive: true });
      writeLane({ id, role: "r", model: "x/y", worktree: fx.wt, spec: "", report: "", status: "done", started_at: old.toISOString(), ...fields } as LaneRecord);
    };
    const dir = (parent: string, name: string, stale = true) => {
      const p = join(parent, name);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "flutter_tools.x"), "x");
      if (stale) utimesSync(p, old, old);
      return p;
    };
    record("20261113-140000-dead", { status: "running", supervisor_pid: 2 ** 22 + 12345 });
    record("20261113-140000-done", { status: "done" });
    record("20261113-140000-live", { status: "running", supervisor_pid: process.pid });
    // a conversation is alive while a supervisor holds it, whatever its record's status says
    record("20261113-140000-talking", { status: "idle", mode: "conversation" });
    acquireLock(laneDir("20261113-140000-talking"));
    record("20261113-140000-quiet", { status: "idle", mode: "conversation" });
    const dead = dir(mine, "20261113-140000-dead");
    const finished = dir(mine, "20261113-140000-done");
    const live = dir(mine, "20261113-140000-live");
    const orphan = dir(mine, "20261113-140000-orphan");
    const talking = dir(mine, "20261113-140000-talking");
    const quiet = dir(mine, "20261113-140000-quiet");
    const fresh = dir(mine, "20261113-140000-fresh", false);
    const other = dir(mine, "not-a-run");
    // another state's run (another checkout, a bench): its records are not here, so its dir is not this state's to judge
    const elsewhere = dir(join(tmpRoot, "0123456789ab"), "20261113-140000-elsewhere");
    prepareLane(fx.specPath, { dryRun: true });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(finished)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(quiet)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(talking)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(elsewhere)).toBe(true);
  });

  test("a dir that is used again is marked as in use (its time renewed)", () => {
    const fx = fixture((root) => join(root, "lane-tmp"));
    const roles = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p:\n    model: x-y\n    tools: [read]\n").roles;
    const id = "20261113-150000-p";
    const own = runTmpDir(id, fx.wt) as string;
    mkdirSync(own, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(own, old, old);
    const rec = { id, role: "p", model: "x/y", worktree: fx.wt, spec: "", report: "", status: "idle", started_at: new Date().toISOString(), mode: "conversation", role_preset: roles.p } as LaneRecord;
    piConversationEnv(rec, roles.p);
    expect(Date.now() - statSync(own).mtimeMs).toBeLessThan(60_000);
  });

  test("a conversation keeps its dir from reply to reply while its supervisor feeds it, and the dir goes when the supervisor lets go", async () => {
    const fx = fixture((root) => join(root, "lane-tmp"));
    // the conversation's supervisor is started from this checkout
    delete process.env.IDD_LANE_ROOT;
    const plan = planPipelineSpawn("planner", { prepareAgentDir: () => { throw new Error("a claude slot has no pi agent dir"); } }) as ClaudePipelineSpawnPlan;
    const conv = openConversation(plan, fx.wt, { iddId: "IDD-001" });
    // both messages wait before the supervisor starts, so one supervisor feeds both
    queueMessage(conv.laneId, "brief");
    deliverToConversation(conv.sessionId, "and then");
    await until(() => existsSync(fx.seen) && seenLines(fx.seen).length === 2 && conversationStatus(conv.sessionId).state !== "running");
    const own = runTmpDir(conv.laneId, fx.wt) as string;
    const seen = seenLines(fx.seen).map((l) => JSON.parse(l) as { TMPDIR: string; TEMP: string; TMP: string; made: boolean; kept: boolean });
    expect(seen[0]).toEqual({ TMPDIR: own, TEMP: own, TMP: own, made: true, kept: false });
    // what the first reply left is still there for the second
    expect(seen[1]).toEqual({ TMPDIR: own, TEMP: own, TMP: own, made: true, kept: true });
    await until(() => !existsSync(own), 10_000);
  }, 40_000);

  test("every way a run's environment is built carries the dir (a lane, a Claude conversation, a pi conversation)", () => {
    const fx = fixture((root) => join(root, "lane-tmp"));
    const roles = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p:\n    model: x-y\n    tools: [read]\n  c:\n    harness: claude\n    model: opus\n    tools: [read]\n").roles;
    const id = "20261113-150000-p";
    const own = runTmpDir(id, fx.wt) as string;
    const rec = { id, role: "p", model: "x/y", worktree: fx.wt, spec: "", report: "", status: "idle", started_at: new Date().toISOString(), mode: "conversation", role_preset: roles.p } as LaneRecord;
    for (const env of [conversationReplyEnv({ ...rec, role_preset: roles.c }, roles.c, join(fx.root, "d"), null), piConversationEnv(rec, roles.p)]) {
      expect([env.TMPDIR, env.TEMP, env.TMP]).toEqual([own, own, own]);
    }
    expect(existsSync(own)).toBe(true);
    // laneEnv alone does not know the worktree: what it is given in `extra` is what the run gets
    expect(laneEnv(roles.p, id, join(fx.root, "d"), null, { TMPDIR: own }).TMPDIR).toBe(own);
  });
});

describe("a tmp_dir that is the runs' records", () => {
  test("is not used, also through a link to it: the run keeps the engine's temp dir and no record is taken for a leftover", () => {
    for (const via of ["direct", "link"] as const) {
      const fx = fixture((root) => {
        const records = join(root, "state", "lanes");
        if (via === "direct") return records;
        mkdirSync(records, { recursive: true });
        execFileSync("ln", ["-s", records, join(root, "records-link")]);
        return join(root, "records-link");
      });
      const ended = "20261113-140000-ended";
      mkdirSync(laneDir(ended), { recursive: true });
      writeLane({ id: ended, role: "r", model: "x/y", worktree: fx.wt, spec: "", report: "", status: "done", started_at: new Date(0).toISOString() } as LaneRecord);
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(laneDir(ended), old, old);
      const { rec } = prepareLane(fx.specPath, { dryRun: true });
      expect(existsSync(join(laneDir(ended), "lane.json"))).toBe(true);
      expect(runTmpDir(rec.id, fx.wt)).toBeNull();
      const roles = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p:\n    model: x-y\n    tools: [read]\n").roles;
      expect(piConversationEnv({ ...rec, mode: "conversation" }, roles.p).TMPDIR).toBe(process.env.TMPDIR);
    }
  });
});

describe("a repo that names no tmp_dir", () => {
  test("the run's temp dir is whatever the engine's environment had, and nothing is made", async () => {
    const fx = fixture(() => null);
    const engineTmp = join(fx.root, "engine-tmp");
    mkdirSync(engineTmp);
    process.env.TMPDIR = engineTmp;
    delete process.env.TEMP;
    delete process.env.TMP;
    const { rec } = prepareLane(fx.specPath);
    const { rec: done } = await supervise(rec.id);
    expect(done.status).toBe("done");
    expect(seenLines(fx.seen)).toEqual([`TMPDIR=${engineTmp}`, "TEMP=", "TMP=", "made"]);
    // the run's leftover stays where it was written, as before
    expect(existsSync(join(engineTmp, "flutter_tools.leftover"))).toBe(true);
  }, 30_000);
});

describe("the tmp_dir setting", () => {
  const base = (extra: string) => `repos:\n  me/app:\n    upstream: /u\n    work: /w\n${extra}`;

  test("both readers take an absolute path (a home path too) and refuse anything else, an empty field among them", () => {
    expect(parseLaneRepos(base("    tmp_dir: /mnt/x/lanes\n")).app.tmpDir).toBe("/mnt/x/lanes");
    expect(parseLaneRepos(base("    tmp_dir: ~/lanes\n")).app.tmpDir).toBe(join(process.env.HOME as string, "lanes"));
    expect(parseLaneRepos(base("")).app.tmpDir).toBeUndefined();
    for (const bad of ["    tmp_dir: lanes\n", "    tmp_dir: 3\n", "    tmp_dir: [/a]\n", "    tmp_dir: ''\n", "    tmp_dir: /\n", "    tmp_dir:\n", "    tmp_dir: ~\n"]) {
      expect(() => parseLaneRepos(base(bad))).toThrow(/repos\.me\/app\.tmp_dir/);
      expect(() => parseRepos(base(bad))).toThrow(/repos\.me\/app\.tmp_dir/);
    }
  });

  test("the setting is kept beside the areas: a repo that writes it hashes as one that does not", () => {
    const without = parseRepos(base(""));
    const withTmp = parseRepos(base("    tmp_dir: /mnt/x/lanes\n"));
    expect(withTmp.areas).toEqual(without.areas);
  });
});
