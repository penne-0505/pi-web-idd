import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { preparePipelineAgentDir } from "../src/agent-dir.ts";
import { pipelineResumeOptions, planPipelineSpawn, readPipelineSession, recordPipelineSession } from "../src/pipeline-spawn.ts";
import { resolveRole } from "../src/roles.ts";
import { tmpDir } from "./helpers/tmp.ts";

function withRoles(yaml: string): void {
  const dir = tmpDir("idd-roles-");
  writeFileSync(join(dir, "roles.yaml"), yaml);
  process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
  process.env.IDD_STATE_DIR = tmpDir("idd-state-");
}

describe("planPipelineSpawn", () => {
  test("maps a pi slot to initialModel / thinkingLevel / agentDir and records the session for resume", () => {
    withRoles("models:\n  opencode-go-glm-5.3:\n    model: opencode-go/glm-5.3\nroles:\n  p: { model: opencode-go-glm-5.3, thinking: high }\npipeline:\n  planner: { role: p, concurrency: 2 }");
    const plan = planPipelineSpawn("planner", { checkStartable: () => {} });
    expect(plan.harness).toBe("pi");
    expect(plan.initialModel).toEqual({ provider: "opencode-go", modelId: "glm-5.3" });
    expect(plan.thinkingLevel).toBe("high");
    // the plan names the shared role dir; it is written at delivery, not here
    expect(plan.agentDir).toMatch(/\/pipeline\/agent\/p$/);
    recordPipelineSession("sess-1", plan);
    expect(readPipelineSession("sess-1")?.agent_dir).toBe(plan.agentDir);
    expect(readPipelineSession("nope")).toBeNull();
    expect(pipelineResumeOptions("sess-1", { prepareAgentDir: (r) => `/agent/${r.name}` })).toEqual({ agentDir: "/agent/p" });
    expect(pipelineResumeOptions("nope")).toEqual({});
  });

  test("resuming prepares the role's agent dir again from the current roles.yaml", () => {
    withRoles("models:\n  opencode-go-glm-5.3:\n    model: opencode-go/glm-5.3\nroles:\n  p: { model: opencode-go-glm-5.3, thinking: high }\npipeline:\n  executor: { role: p }");
    recordPipelineSession("sess-2", planPipelineSpawn("executor", { checkStartable: () => {} }));
    const prepared: string[] = [];
    const options = pipelineResumeOptions("sess-2", { prepareAgentDir: (r) => { prepared.push(r.name); return "/agent/fresh"; } });
    expect(prepared).toEqual(["p"]);
    expect(options).toEqual({ agentDir: "/agent/fresh" });
    withRoles("models:\n  x-y:\n    model: x/y\nroles:\n  q: { model: x-y, thinking: high }\npipeline:\n  executor: { role: q }");
    recordPipelineSession("sess-3", { slot: "executor", role: "gone", model: "x/y", initialModel: { provider: "x", modelId: "y" }, thinkingLevel: "high", agentDir: "/agent/kept" });
    expect(pipelineResumeOptions("sess-3", { prepareAgentDir: () => "/never" })).toEqual({ agentDir: "/agent/kept" });
  });

  test("the Issue lane id is recorded and comes back on resume; a mode record without one carries nothing", () => {
    withRoles("models:\n  opencode-go-glm-5.3:\n    model: opencode-go/glm-5.3\nroles:\n  p: { model: opencode-go-glm-5.3, thinking: high }\npipeline:\n  planner: { role: p }");
    const plan = planPipelineSpawn("planner", { prepareAgentDir: () => "/agent/p" });
    process.env.IDD_AGENT_TOKEN = "token-value";
    recordPipelineSession("sess-lane", plan, "IDD-035");
    expect(readPipelineSession("sess-lane")?.idd_id).toBe("IDD-035");
    expect(pipelineResumeOptions("sess-lane", { prepareAgentDir: () => "/agent/p" })).toEqual({ agentDir: "/agent/p", iddLaneId: "IDD-035" });
    // the token is never written to the record
    expect(JSON.stringify(readPipelineSession("sess-lane"))).not.toContain("token-value");
    // a mode session has no Issue lane, so nothing is added for it
    recordPipelineSession("sess-mode", plan);
    expect(readPipelineSession("sess-mode")?.idd_id).toBeUndefined();
    expect(pipelineResumeOptions("sess-mode", { prepareAgentDir: () => "/agent/p" })).toEqual({ agentDir: "/agent/p" });
    delete process.env.IDD_AGENT_TOKEN;
  });

  test("a claude-harness slot is planned as a conversation, with no pi agent dir", () => {
    withRoles("roles:\n  c: { harness: claude, model: opus, thinking: xhigh }\npipeline:\n  planner: { role: c }\n  executor: { role: c }");
    const plan = planPipelineSpawn("planner", { checkStartable: () => { throw new Error("not for claude"); } });
    expect(plan).toMatchObject({ harness: "claude", slot: "planner", role: "c", model: "opus", thinkingLevel: "xhigh" });
    expect(planPipelineSpawn("executor", { checkStartable: () => {} }).harness).toBe("claude");
  });

  test("refuses a thinking value outside pi's levels on either harness, and an unknown slot", () => {
    withRoles("models:\n  x-y:\n    model: x/y\nroles:\n  c: { harness: claude, model: opus, thinking: turbo }\n  t: { model: x-y, thinking: turbo }\npipeline:\n  planner: { role: c }\n  executor: { role: t }");
    expect(() => planPipelineSpawn("planner", { checkStartable: () => {} })).toThrow(/thinking "turbo"/);
    expect(() => planPipelineSpawn("executor", { checkStartable: () => {} })).toThrow(/thinking "turbo"/);
    expect(() => planPipelineSpawn("reviewer", { checkStartable: () => {} })).toThrow(/pipeline に "reviewer"/);
  });
});

/** the pipeline role dir is rebuilt at every delivery, while other replies of the role may be starting */
describe("the role's shared agent dir is rebuilt without breaking a starting reply", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const c of cleanups.splice(0)) c(); });

  /** an empty catalog answer, so building models.json needs no network and no real pi */
  function fakePi(root: string): { bin: string } {
    const bin = join(root, "pi");
    writeFileSync(bin, `#!/bin/sh\ncase "$1 $2" in *--list-models*) printf '%s\\n' "${"$"}3" | sed 's|/| |' ;; esac\nexit 0\n`);
    chmodSync(bin, 0o755);
    return { bin };
  }

  function fixture(): { base: string; user: string; role: ReturnType<typeof resolveRole> } {
    withRoles("models:\n  opencode-go-glm-5.3:\n    model: opencode-go/glm-5.3\nroles:\n  p: { model: opencode-go-glm-5.3, thinking: high }\npipeline:\n  planner: { role: p }");
    const user = tmpDir("idd-user-agent-");
    writeFileSync(join(user, "auth.json"), "{}");
    writeFileSync(join(user, "models.json"), JSON.stringify({ providers: {} }));
    mkdirSync(join(user, "extensions"), { recursive: true });
    writeFileSync(join(user, "extensions", "e.js"), "1");
    const fakeRoot = tmpDir("idd-fake-pi-");
    const { bin } = fakePi(fakeRoot);
    const saved = { user: process.env.IDD_PI_USER_AGENT_DIR, pi: process.env.IDD_PI_BIN };
    process.env.IDD_PI_USER_AGENT_DIR = user;
    process.env.IDD_PI_BIN = bin;
    cleanups.push(() => {
      if (saved.user === undefined) delete process.env.IDD_PI_USER_AGENT_DIR; else process.env.IDD_PI_USER_AGENT_DIR = saved.user;
      if (saved.pi === undefined) delete process.env.IDD_PI_BIN; else process.env.IDD_PI_BIN = saved.pi;
    });
    return { base: join(process.env.IDD_STATE_DIR as string, "pipeline", "agent"), user, role: resolveRole("p") };
  }

  test("a link that already points where it should is left alone, and pi's own directory survives", () => {
    const { base, user, role } = fixture();
    const dir = preparePipelineAgentDir(base, role);
    expect(readlinkSync(join(dir, "auth.json"))).toBe(join(user, "auth.json"));
    expect(readlinkSync(join(dir, "extensions"))).toBe(join(user, "extensions"));
    expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8"))).toBeTruthy();
    expect(lstatSync(join(dir, "models.json")).isSymbolicLink()).toBe(false);

    const inode = lstatSync(join(dir, "auth.json")).ino;
    preparePipelineAgentDir(base, role);
    // untouched: a starting pi sees no moment without the link (as it would if we unlinked and re-linked)
    expect(lstatSync(join(dir, "auth.json")).ino).toBe(inode);

    // what pi wrote into the dir itself (its sessions) is not swept away by the next rebuild
    mkdirSync(join(dir, "sessions", "a"), { recursive: true });
    writeFileSync(join(dir, "sessions", "a", "s.jsonl"), "{}\n");
    preparePipelineAgentDir(base, role);
    expect(readFileSync(join(dir, "sessions", "a", "s.jsonl"), "utf8")).toBe("{}\n");
    expect(readdirSync(dir).some((f) => f.includes(".tmp"))).toBe(false);
  });

  test("a real directory where the user's dir has one (pi's own sessions) is never removed or replaced", () => {
    const { base, user, role } = fixture();
    const dir = preparePipelineAgentDir(base, role);
    // the production shape: the user's dir has sessions, so the role dir links it
    mkdirSync(join(user, "sessions"), { recursive: true });
    preparePipelineAgentDir(base, role);
    expect(lstatSync(join(dir, "sessions")).isSymbolicLink()).toBe(true);
    // a real directory stands there instead (pi wrote into it before a link was made), holding a record
    rmSync(join(dir, "sessions"), { force: true });
    mkdirSync(join(dir, "sessions", "--wt--"), { recursive: true });
    writeFileSync(join(dir, "sessions", "--wt--", "t_id.jsonl"), '{"type":"session"}\n');
    preparePipelineAgentDir(base, role);
    // the rebuild neither removes it nor turns it into a link: the session record is still there
    expect(lstatSync(join(dir, "sessions")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, "sessions", "--wt--", "t_id.jsonl"), "utf8")).toBe('{"type":"session"}\n');
    // the entries the user's dir does own are still linked
    expect(readlinkSync(join(dir, "auth.json"))).toBe(join(user, "auth.json"));
  });

  test("a reader looping beside the rebuild never meets a missing link or a half-written models.json", async () => {
    const { base, role } = fixture();
    const dir = preparePipelineAgentDir(base, role);
    const script = join(base, "reader.mjs");
    writeFileSync(script, [
      "import { readFileSync } from \"node:fs\";",
      "import { join } from \"node:path\";",
      "const dir = process.argv[2];",
      "let n = 0;",
      "const deadline = Date.now() + 1500;",
      "while (Date.now() < deadline) {",
      "  const text = readFileSync(join(dir, \"models.json\"), \"utf8\");",
      "  JSON.parse(text);",
      "  readFileSync(join(dir, \"auth.json\"), \"utf8\");",
      "  const settings = JSON.parse(readFileSync(join(dir, \"settings.json\"), \"utf8\"));",
      "  if (!settings.shellPath) throw new Error(\"settings has no shellPath\");",
      "  readFileSync(settings.shellPath, \"utf8\");",
      "  n += 1;",
      "}",
      "process.stdout.write(String(n));",
    ].join("\n"));
    const child = spawn(process.execPath, [script, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const deadline = Date.now() + 1300;
    while (Date.now() < deadline) preparePipelineAgentDir(base, role);
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(Number(out)).toBeGreaterThan(0);
  }, 20_000);
});
