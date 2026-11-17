import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { agentEnv } from "../src/agent-env.ts";
import { parseRoles } from "../src/roles.ts";
import { laneHoldToken } from "../../idd-core/src/agent/token.ts";
import { runLaneEnv, requestingLane, RUN_LANE_ENV } from "../src/inject.ts";
import { laneEnv, type LaneRecord } from "../src/runner.ts";
import { conversationReplyEnv, piConversationEnv } from "../src/conversation.ts";
import { riskPathsEnvForPath } from "../src/repos.ts";
import { tmpDir } from "./helpers/tmp.ts";

describe("the engine's Linear key never reaches an agent", () => {
  test("agentEnv drops LINEAR_API_KEY from the base and from what is added, and keeps the rest", () => {
    const env = agentEnv({ LINEAR_API_KEY: "lin_api_x", PATH: "/bin", HOME: "/h" }, { IDD_LANE_ID: "L1", LINEAR_API_KEY: "again" });
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", IDD_LANE_ID: "L1" });
  });

  test("the default speech-to-text key is dropped from an agent's environment", () => {
    const env = agentEnv({ GEMINI_API_KEY: "gm_x", PATH: "/bin" }, { GEMINI_API_KEY: "again" });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env).toEqual({ PATH: "/bin" });
  });

  test("a lane gets no key, whatever its harness", () => {
    const root = tmpDir("idd-agent-env-");
    writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${join(root, "cfg")}\nroles: {}\n`);
    const roles = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p:\n    model: x-y\n    tools: [read]\n  c:\n    harness: claude\n    model: opus\n    tools: [read]\n").roles;
    Object.assign(process.env, { IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), LINEAR_API_KEY: "lin_api_secret" });
    try {
      for (const role of [roles.p, roles.c]) {
        const env = laneEnv(role, "L1", join(root, "lane"));
        expect(env.LINEAR_API_KEY).toBeUndefined();
        expect(env.IDD_LANE_ID).toBe("L1");
      }
    } finally {
      delete process.env.IDD_STATE_DIR; delete process.env.IDD_ROLES_FILE; delete process.env.LINEAR_API_KEY;
    }
  });

  test("a pi lane leaves the prompt cache variable of the engine's environment as it found it", () => {
    const root = tmpDir("idd-agent-env-cache-");
    writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${join(root, "cfg")}\nroles: {}\n`);
    const role = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p:\n    model: x-y\n    tools: [read]\n").roles.p;
    Object.assign(process.env, { IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml") });
    const before = process.env.FORCE_PROMPT_CACHING_5M;
    try {
      for (const value of [undefined, "1"]) {
        if (value === undefined) delete process.env.FORCE_PROMPT_CACHING_5M;
        else process.env.FORCE_PROMPT_CACHING_5M = value;
        expect(laneEnv(role, "L1", join(root, "lane")).FORCE_PROMPT_CACHING_5M).toBe(value);
      }
    } finally {
      delete process.env.IDD_STATE_DIR; delete process.env.IDD_ROLES_FILE;
      if (before === undefined) delete process.env.FORCE_PROMPT_CACHING_5M;
      else process.env.FORCE_PROMPT_CACHING_5M = before;
    }
  });

  test("no agent spawn in idd-lane hands process.env over as it is", () => {
    // git is not an agent; every other child (lanes, conversations, supervisors, drafters) goes through agentEnv
    const dir = resolve("packages/idd-lane/src");
    const raw = /env:\s*process\.env\b|\.\.\.process\.env\b/;
    const offenders = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "git.ts" && f !== "agent-env.ts")
      .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").map((line, i) => ({ f, i: i + 1, line })))
      .filter(({ line }) => raw.test(line))
      .map(({ f, i }) => `${f}:${i}`);
    expect(offenders).toEqual([]);
  });
});

describe("a repo's dangerous-path declaration reaches its lane and no other", () => {
  test("the declaring repo's lane env carries its risk_paths; a repo with none carries no variable, even with a stale one in the caller's env", () => {
    const root = tmpDir("idd-risk-lane-");
    const declaring = join(root, "declaring"); mkdirSync(declaring);
    const plain = join(root, "plain"); mkdirSync(plain);
    writeFileSync(join(root, "repos.yaml"), `repos:\n  o/app: { name: app, upstream: ${declaring}, work: ${declaring}, risk_paths: { auth: [lib/] } }\n  o/plain: { name: plain, upstream: ${plain}, work: ${plain} }\n`);
    writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${join(root, "cfg")}\nroles: {}\n`);
    Object.assign(process.env, { IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"), IDD_RISK_PATHS: JSON.stringify({ auth: ["stale/"] }) });
    const role = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p:\n    model: x-y\n    tools: [read]\n").roles.p;
    try {
      const declared = laneEnv(role, "L1", join(root, "lane"), null, riskPathsEnvForPath(declaring));
      expect(JSON.parse(declared.IDD_RISK_PATHS as string)).toEqual({ auth: ["lib/"] });
      // a repo with no declaration never inherits one, not even the engine's own stale value
      const none = laneEnv(role, "L2", join(root, "lane2"), null, riskPathsEnvForPath(plain));
      expect(none.IDD_RISK_PATHS).toBeUndefined();
    } finally {
      delete process.env.IDD_STATE_DIR; delete process.env.IDD_ROLES_FILE; delete process.env.IDD_REPOS_FILE; delete process.env.IDD_RISK_PATHS;
    }
  });

  test("both harnesses' conversation replies carry the worktree repo's risk_paths, and never a stale inherited one", () => {
    const root = tmpDir("idd-risk-conv-");
    const declaring = join(root, "declaring"); mkdirSync(declaring);
    const plain = join(root, "plain"); mkdirSync(plain);
    writeFileSync(join(root, "repos.yaml"), `repos:\n  o/app: { name: app, upstream: ${declaring}, work: ${declaring}, risk_paths: { auth: [lib/] } }\n  o/plain: { name: plain, upstream: ${plain}, work: ${plain} }\n`);
    writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${join(root, "cfg")}\nroles: {}\n`);
    Object.assign(process.env, { IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"), IDD_RISK_PATHS: JSON.stringify({ auth: ["stale/"] }) });
    const roles = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p:\n    model: x-y\n    tools: [read]\n  c:\n    harness: claude\n    model: opus\n    tools: [read]\n").roles;
    const lane = (worktree: string): LaneRecord => ({ id: "L1", role: "p", model: "x/y", worktree, spec: "", report: "", status: "idle", started_at: "2026-01-01T00:00:00.000Z", session_file: "s", mode: "conversation" });
    const replies: [string, (rec: LaneRecord) => NodeJS.ProcessEnv][] = [
      ["pi", (rec) => piConversationEnv(rec, roles.p)],
      ["claude", (rec) => conversationReplyEnv(rec, roles.c, join(root, "d"), null)],
    ];
    try {
      for (const [harness, envOf] of replies) {
        expect({ [harness]: JSON.parse(envOf(lane(declaring)).IDD_RISK_PATHS as string) }).toEqual({ [harness]: { auth: ["lib/"] } });
        // a repo with no declaration never inherits one, not even the engine's own stale value
        expect({ [harness]: envOf(lane(plain)).IDD_RISK_PATHS }).toEqual({ [harness]: undefined });
      }
    } finally {
      delete process.env.IDD_STATE_DIR; delete process.env.IDD_ROLES_FILE; delete process.env.IDD_REPOS_FILE; delete process.env.IDD_RISK_PATHS;
    }
  });
});

describe("a stage run names the Issue lane it belongs to", () => {
  test("the spec's lane rides as IDD_RUN_LANE, a blind's included, and an inherited value never reaches another run", () => {
    const root = tmpDir("idd-run-lane-");
    writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${join(root, "cfg")}\nroles: {}\n`);
    const roles = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p:\n    model: x-y\n    tools: [read]\n  c:\n    harness: claude\n    model: opus\n    tools: [read]\n").roles;
    const tokenBefore = process.env.IDD_AGENT_TOKEN;
    delete process.env.IDD_AGENT_TOKEN;
    Object.assign(process.env, { IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), [RUN_LANE_ENV]: "IDD-stale" });
    try {
      // no readable token leaves the run with its lane alone: the hold door then refuses, never guesses
      expect(runLaneEnv({ lane: "IDD-7" })).toEqual({ [RUN_LANE_ENV]: "IDD-7" });
      expect(runLaneEnv({ injectLane: "IDD-8" })).toEqual({ [RUN_LANE_ENV]: "IDD-8" });
      expect(runLaneEnv({})).toEqual({});
      expect(runLaneEnv(null)).toEqual({});
      for (const role of [roles.p, roles.c]) {
        expect(laneEnv(role, "L1", join(root, "lane"), null, runLaneEnv({ lane: "IDD-7" }))[RUN_LANE_ENV]).toBe("IDD-7");
        expect(laneEnv(role, "L2", join(root, "lane2"), null, runLaneEnv({}))[RUN_LANE_ENV]).toBeUndefined();
      }
    } finally {
      delete process.env.IDD_STATE_DIR; delete process.env.IDD_ROLES_FILE; delete process.env[RUN_LANE_ENV];
      if (tokenBefore !== undefined) process.env.IDD_AGENT_TOKEN = tokenBefore;
    }
  });

  test("a stage run carries the hold credential of its own lane alone, never the shared token or an inherited credential", () => {
    const root = tmpDir("idd-run-hold-");
    writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${join(root, "cfg")}\nroles: {}\n`);
    const roles = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p:\n    model: x-y\n    tools: [read]\n  c:\n    harness: claude\n    model: opus\n    tools: [read]\n").roles;
    const before = { token: process.env.IDD_AGENT_TOKEN, hold: process.env.IDD_HOLD_TOKEN };
    Object.assign(process.env, { IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_AGENT_TOKEN: "shared", IDD_HOLD_TOKEN: "inherited-from-another-lane" });
    try {
      expect(runLaneEnv({ lane: "IDD-7" })).toEqual({ [RUN_LANE_ENV]: "IDD-7", IDD_HOLD_TOKEN: laneHoldToken("IDD-7", "shared") });
      expect(runLaneEnv({ lane: "IDD-8" }).IDD_HOLD_TOKEN).not.toBe(runLaneEnv({ lane: "IDD-7" }).IDD_HOLD_TOKEN);
      for (const role of [roles.p, roles.c]) {
        const env = laneEnv(role, "L1", join(root, "lane"), null, runLaneEnv({ lane: "IDD-7" }));
        expect(env.IDD_HOLD_TOKEN).toBe(laneHoldToken("IDD-7", "shared"));
        // a run with no lane takes nothing from the engine's shell either
        expect(laneEnv(role, "L2", join(root, "lane2"), null, runLaneEnv({})).IDD_HOLD_TOKEN).toBeUndefined();
      }
    } finally {
      delete process.env.IDD_STATE_DIR; delete process.env.IDD_ROLES_FILE;
      for (const [k, v] of [["IDD_AGENT_TOKEN", before.token], ["IDD_HOLD_TOKEN", before.hold]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  test("the lane a command is asked for is IDD_ID, else IDD_RUN_LANE, else none", () => {
    expect(requestingLane({ IDD_ID: "IDD-1", [RUN_LANE_ENV]: "IDD-2" })).toBe("IDD-1");
    expect(requestingLane({ IDD_ID: "", [RUN_LANE_ENV]: "IDD-2" })).toBe("IDD-2");
    expect(requestingLane({ IDD_ID: " ", [RUN_LANE_ENV]: " " })).toBeUndefined();
    expect(requestingLane({})).toBeUndefined();
  });
});
