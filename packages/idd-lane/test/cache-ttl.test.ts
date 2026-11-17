import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseLaneRepos } from "../src/repos.ts";
import { parseRoles } from "../src/roles.ts";
import { cacheTtlOf, laneEnv, prepareLane, resolveCacheTtl, type LaneRecord, type RolePreset } from "../src/runner.ts";
import { conversationReplyEnv } from "../src/conversation.ts";
import { cacheReport, cacheRunStats, claudeRequests, orderedTurnFiles } from "../src/cache-rewrites.ts";

const ENV_KEYS = ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_REPOS_FILE", "IDD_LANE_ROOT", "IDD_LANE_SCOPE", "FORCE_PROMPT_CACHING_5M"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const roots: string[] = [];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** a lane's scratch: a logged-in lane config dir, a git worktree, roles and a repo registry with a cache_ttl */
function fixture(opts: { roleTtl?: string; repoTtl?: string; repo?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "idd-cache-ttl-"));
  roots.push(root);
  const wt = join(root, "wt"); mkdirSync(wt);
  execFileSync("git", ["init", "-q", wt]);
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: wt });
  const cfg = join(root, "cfg"); mkdirSync(cfg); writeFileSync(join(cfg, ".credentials.json"), "{}");
  writeFileSync(join(root, "roles.yaml"), [
    "defaults:",
    `  claude_config_dir: ${cfg}`,
    "  tool_timeout_minutes: off",
    "roles:",
    "  c:",
    "    harness: claude",
    "    model: opus",
    "    tools: [read, bash]",
    "    report: free",
    "    require_clean: false",
    ...(opts.roleTtl ? [`    cache_ttl: ${opts.roleTtl}`] : []),
  ].join("\n") + "\n");
  const header = `repos:\n  me/app:\n    upstream: ${wt}\n    work: ${join(root, "work")}\n`;
  writeFileSync(join(root, "repos.yaml"), opts.repo === false ? "repos:\n" : `${header}${opts.repoTtl ? `    cache_ttl: ${opts.repoTtl}\n` : ""}`);
  mkdirSync(join(root, "fake-root"));
  Object.assign(process.env, { IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"), IDD_LANE_ROOT: join(root, "fake-root"), IDD_LANE_SCOPE: "off" });
  const specPath = join(root, "spec.yaml");
  writeFileSync(specPath, `role: c\nworktree: ${wt}\nreport: ${join(root, "out", "report")}\ntask: t\n`);
  return { root, wt, specPath };
}

const envOf = (rec: LaneRecord, dir: string) => laneEnv(rec.role_preset as RolePreset, rec.id, dir, null, {}, cacheTtlOf(rec));

/** a conversation is opened, not prepared, so its record carries no hold of its own: it is resolved at env time */
function conversationOf(rec: LaneRecord): LaneRecord {
  const conv: LaneRecord = { ...rec, mode: "conversation" };
  delete conv.cache_ttl;
  return conv;
}

describe("the prompt cache hold of a run's environment", () => {
  test("a run that waits for nobody carries the 5m switch; a conversation keeps the hour", () => {
    const fx = fixture();
    const { rec } = prepareLane(fx.specPath, { dryRun: true });
    expect(rec.cache_ttl).toBe("5m");
    expect(envOf(rec, join(fx.root, "d")).FORCE_PROMPT_CACHING_5M).toBe("1");
    const conversation = conversationOf(rec);
    expect(cacheTtlOf(conversation)).toBe("1h");
    expect(envOf(conversation, join(fx.root, "d")).FORCE_PROMPT_CACHING_5M).toBeUndefined();
    // the reply env a conversation actually runs with is the same path
    expect(conversationReplyEnv(conversation, conversation.role_preset as RolePreset, join(fx.root, "d"), null).FORCE_PROMPT_CACHING_5M).toBeUndefined();
  });

  test("a variable inherited from the engine's environment does not decide the hold", () => {
    const fx = fixture();
    const { rec } = prepareLane(fx.specPath, { dryRun: true });
    process.env.FORCE_PROMPT_CACHING_5M = "1";
    const conversation = conversationOf(rec);
    expect(cacheTtlOf(conversation)).toBe("1h");
    expect(envOf(conversation, join(fx.root, "d")).FORCE_PROMPT_CACHING_5M).toBeUndefined();
    // a role that names the hour gets it, whatever the engine's shell holds
    const fx1 = fixture({ roleTtl: "1h" });
    const r1 = prepareLane(fx1.specPath, { dryRun: true }).rec;
    expect(cacheTtlOf(r1)).toBe("1h");
    expect(envOf(r1, join(fx1.root, "d")).FORCE_PROMPT_CACHING_5M).toBeUndefined();
  });
});

describe("where a run's prompt cache hold comes from", () => {
  test("the role's own first, then the repo's, then the run kind's default", () => {
    const roleWins = fixture({ roleTtl: "5m", repoTtl: "1h" });
    const rw = prepareLane(roleWins.specPath, { dryRun: true }).rec;
    expect(rw.cache_ttl).toBe("5m");
    // a role's 5m reaches a conversation too
    const conversation = conversationOf(rw);
    expect(cacheTtlOf(conversation)).toBe("5m");
    expect(envOf(conversation, join(roleWins.root, "d")).FORCE_PROMPT_CACHING_5M).toBe("1");
    const roleHour = fixture({ roleTtl: "1h" });
    expect(prepareLane(roleHour.specPath, { dryRun: true }).rec.cache_ttl).toBe("1h");
    const repoHour = fixture({ repoTtl: "1h" });
    expect(prepareLane(repoHour.specPath, { dryRun: true }).rec.cache_ttl).toBe("1h");
    const plain = fixture();
    expect(prepareLane(plain.specPath, { dryRun: true }).rec.cache_ttl).toBe("5m");
  });

  test("a worktree no repo claims, and a registry that cannot be read, fall to the run kind's default", () => {
    const fx = fixture({ repoTtl: "1h" });
    const { rec } = prepareLane(fx.specPath, { dryRun: true });
    expect(resolveCacheTtl(rec.role_preset, join(fx.root, "elsewhere"), false)).toBe("5m");
    process.env.IDD_REPOS_FILE = join(fx.root, "missing.yaml");
    expect(resolveCacheTtl(rec.role_preset, fx.wt, false)).toBe("5m");
    expect(resolveCacheTtl(rec.role_preset, fx.wt, true)).toBe("1h");
  });
});

describe("reading cache_ttl from the config files", () => {
  test("a value that is neither 1h nor 5m is refused where it is written", () => {
    for (const v of ["10m", "1", "\"\"", "1H"])
      expect(() => parseRoles(`roles:\n  c:\n    harness: claude\n    model: opus\n    cache_ttl: ${v}\n`)).toThrow(/roles\.c\.cache_ttl.*1h.*5m/);
    expect(() => parseLaneRepos("repos:\n  me/app:\n    upstream: /u\n    work: /w\n    cache_ttl: 10m\n")).toThrow(/repos\.me\/app\.cache_ttl.*1h.*5m/);
  });

  test("a pi role cannot carry it: Claude Code reads the variable, a pi run would only look configured", () => {
    expect(() => parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p:\n    model: x-y\n    cache_ttl: 5m\n")).toThrow(/roles\.p\.cache_ttl.*1h.*5m/);
  });

  test("1h and 5m are read, and a role that writes nothing carries nothing", () => {
    expect(parseRoles("roles:\n  c:\n    harness: claude\n    model: opus\n    cache_ttl: 1h\n").roles.c.cacheTtl).toBe("1h");
    expect(parseRoles("roles:\n  c:\n    harness: claude\n    model: opus\n    cache_ttl: 5m\n").roles.c.cacheTtl).toBe("5m");
    expect(parseRoles("roles:\n  c:\n    harness: claude\n    model: opus\n").roles.c.cacheTtl).toBeUndefined();
    expect(parseLaneRepos("repos:\n  me/app:\n    upstream: /u\n    work: /w\n    cache_ttl: 5m\n").app.cacheTtl).toBe("5m");
    expect(parseLaneRepos("repos:\n  me/app:\n    upstream: /u\n    work: /w\n").app.cacheTtl).toBeUndefined();
  });
});

describe("the hold a lane carries", () => {
  test("a prepared lane writes the hold down, and a later config change does not move it", () => {
    const fx = fixture({ repoTtl: "1h" });
    const { rec } = prepareLane(fx.specPath, { dryRun: true });
    expect(rec.cache_ttl).toBe("1h");
    writeFileSync(join(fx.root, "repos.yaml"), `repos:\n  me/app:\n    upstream: ${fx.wt}\n    work: ${join(fx.root, "work")}\n    cache_ttl: 5m\n`);
    expect(cacheTtlOf(rec)).toBe("1h");
    // a lane from before the setting (or a conversation) has no value and is resolved at env time
    const fromBefore: LaneRecord = { ...rec };
    delete fromBefore.cache_ttl;
    expect(cacheTtlOf(fromBefore)).toBe("5m");
  });
});

describe("counting cache rewrites", () => {
  const req = (id: string, at: string, u: { input?: number; read?: number; write?: number }) => JSON.stringify({
    type: "assistant",
    timestamp: at,
    message: { id, usage: { input_tokens: u.input ?? 2, cache_read_input_tokens: u.read ?? 0, cache_creation_input_tokens: u.write ?? 0 } },
  });
  const t = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();

  test("a message written to several lines counts once, and lines that are not requests are skipped", () => {
    const reqs = claudeRequests([
      req("m1", t(0), { write: 100 }),
      JSON.stringify({ type: "result", usage: { input_tokens: 999 } }),
      "not json",
      req("m1", t(1), { write: 100 }),
      req("m2", t(2), { read: 90 }),
    ]);
    expect(reqs.length).toBe(2);
    expect(reqs.map((r) => r.id)).toEqual(["m1", "m2"]);
  });

  test("a request under half of the previous write is a rewrite; the first request never is", () => {
    const one = cacheRunStats(claudeRequests([req("m1", t(0), { write: 1000 })]));
    expect(one.requests).toBe(1);
    expect(one.rewrites).toBe(0);
    const two = cacheRunStats(claudeRequests([req("m1", t(0), { write: 1000 }), req("m2", t(10), { read: 499, write: 10 })]));
    expect(two.rewrites).toBe(1);
    expect(two.rewriteTokens).toBe(1000);
    // reading exactly half is not a rewrite
    const half = cacheRunStats(claudeRequests([req("m1", t(0), { write: 1000 }), req("m2", t(10), { read: 500 })]));
    expect(half.rewrites).toBe(0);
  });

  test("a big new read is no rewrite but does land in the earlier context definition", () => {
    const stats = cacheRunStats(claudeRequests([
      req("m1", t(0), { write: 1000 }),
      req("m2", t(10), { read: 900, write: 100 }),
      req("m3", t(20), { read: 200, write: 100000 }),
    ]));
    expect(stats.rewrites).toBe(0);
    expect(stats.contextRewrites).toBe(2);
  });

  test("a gap over five minutes is counted, and the longest gap is kept", () => {
    const stats = cacheRunStats(claudeRequests([req("m1", t(0), { write: 10 }), req("m2", t(301), { read: 10 })]));
    expect(stats.overGap).toBe(1);
    expect(stats.maxGapMs).toBe(301_000);
    expect(cacheRunStats(claudeRequests([req("m1", t(0), { write: 10 }), req("m2", t(299), { read: 10 })])).overGap).toBe(0);
  });

  test("a conversation's turns are read by reply number, not by name", () => {
    expect(orderedTurnFiles(["10.jsonl", "2.jsonl", "1.jsonl", "notes.txt", "3.jsonl"])).toEqual(["1.jsonl", "2.jsonl", "3.jsonl", "10.jsonl"]);
  });

  test("the runs are summed by role and hold", () => {
    const runs = [
      { role: "a", ttl: "5m" as const, requests: claudeRequests([req("m1", t(0), { write: 100 }), req("m2", t(10), { read: 1 })]) },
      { role: "a", ttl: "5m" as const, requests: claudeRequests([req("n1", t(0), { write: 100 })]) },
      { role: "b", ttl: "1h" as const, requests: claudeRequests([req("o1", t(0), { write: 100 })]) },
    ];
    const rows = cacheReport(runs);
    expect(rows[0]).toMatchObject({ role: "a", ttl: "5m", runs: 2, requests: 3, rewrites: 1, rewriteTokens: 100 });
    expect(rows[1]).toMatchObject({ role: "b", ttl: "1h", runs: 1, requests: 1, rewrites: 0 });
  });
});
