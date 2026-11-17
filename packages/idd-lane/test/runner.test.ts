import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claimLaneId, isRateLimited, lastProviderError, needsResume, planSupervisorLaunch, reportComplete, resumeNudge, runSetup, summarizeEvents, supervisorLaunch } from "../src/runner.ts";
import { failureKindOf } from "../src/route.ts";
import { parseRoles } from "../src/roles.ts";
import { parseSpec } from "../src/spec.ts";
import { shippedConfig, shippedConfigTest } from "./helpers/shipped-config.ts";
import { tmpDir } from "./helpers/tmp.ts";

describe("summarizeEvents", () => {
  test("sums usage over every assistant message and keeps the last text as final_text", () => {
    const dir = tmpDir("idd-lane-events-");
    const p = join(dir, "events.jsonl");
    const lines = [
      { type: "session", path: "/s.jsonl" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }], usage: { input: 100, output: 10, cacheRead: 5, cost: { total: 0.001 } } } },
      { type: "tool_execution_start", toolName: "bash", args: {} },
      { type: "turn_end" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 200, output: 20, cacheRead: 50, cost: 0.002 } } },
      { type: "turn_end" },
    ];
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
    const s = summarizeEvents(p);
    expect(s.usage).toEqual({ input: 300, output: 30, cacheRead: 55, cacheWrite: 0, cost: 0.003 });
    expect(s.finalText).toBe("done");
    expect(s.toolCalls).toBe(1);
    expect(s.turns).toBe(2);
    expect(s.sessionFile).toBe("/s.jsonl");
  });
});

describe("needsResume", () => {
  test("only an exit-0 lane without report.md is resumed, and only up to the role's limit", () => {
    expect(needsResume({ status: "running", exit: 0, report_md: false }, 1)).toBe(true);
    expect(needsResume({ status: "running", exit: 0, report_md: false, resumes: 1 }, 1)).toBe(false);
    expect(needsResume({ status: "running", exit: 0, report_md: true }, 1)).toBe(false);
    expect(needsResume({ status: "running", exit: 1, report_md: false }, 1)).toBe(false);
    expect(needsResume({ status: "timeout", exit: 143, report_md: false }, 1)).toBe(false);
    expect(needsResume({ status: "running", exit: 0, report_md: false }, 0)).toBe(false);
    expect(resumeNudge("/r/out")).toContain("/r/out.json");
  });
});

describe("lastProviderError", () => {
  const entry = (role: string, stopReason?: string, errorMessage?: string) => JSON.stringify({ type: "message", message: { role, stopReason, errorMessage } });
  test("returns the error of the last reply only when that reply failed", () => {
    expect(lastProviderError([entry("user"), entry("assistant", "error", "429: rate-limited upstream")].join("\n"))).toBe("429: rate-limited upstream");
    expect(lastProviderError([entry("assistant", "error", "429"), entry("assistant", "stop")].join("\n"))).toBeNull();
    expect(lastProviderError("")).toBeNull();
  });
  test("a rate limit is told apart from other errors", () => {
    expect(isRateLimited("429: deepseek/deepseek-v4.1-flash is temporarily rate-limited upstream")).toBe(true);
    expect(isRateLimited("400: reasoning_content must be passed back")).toBe(false);
  });
});

describe("lane ids", () => {
  test("two lanes of the same role started in the same second get their own directories", () => {
    process.env.IDD_STATE_DIR = tmpDir("idd-ids-");
    const now = new Date("2026-09-24T00:10:48.123Z");
    const a = claimLaneId("r2-reviewer", now);
    const b = claimLaneId("r2-reviewer", now);
    const c = claimLaneId("r2-reviewer", now);
    expect(a).toBe("20260924-001048-r2-reviewer");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(b).toBe("20260924-001048-r2-reviewer-2");
  });
});

describe("where a lane's supervisor runs", () => {
  test("under systemd it gets its own scope, so restarting the UI service does not take the lane down", () => {
    const scoped = supervisorLaunch("20260924-081500-blind-reviewer", "/r/supervise.ts", true);
    expect(scoped.cmd).toBe("systemd-run");
    expect(scoped.args.slice(0, 5)).toEqual(["--user", "--scope", "--quiet", "--collect", "--unit=idd-lane-20260924-081500-blind-reviewer"]);
    expect(scoped.args.slice(-4)).toEqual(["bun", "run", "/r/supervise.ts", "20260924-081500-blind-reviewer"]);
    const plain = supervisorLaunch("x", "/r/supervise.ts", false);
    expect(plain).toEqual({ cmd: "bun", args: ["run", "/r/supervise.ts", "x"] });
  });

  test("a lane id with characters a unit name cannot hold is made safe", () => {
    expect(supervisorLaunch("a b/c", "/s", true).args).toContain("--unit=idd-lane-a_b_c");
  });
});

describe("the lanes' shared CPU limit", () => {
  const cpu = { slice: "idd_lanes.slice", cpuQuota: "1000%", cpuWeight: 20 };
  type Call = { cmd: string; args: string[] };
  const recorder = (status: number | null, extra: { stderr?: string; error?: Error } = {}) => {
    const calls: Call[] = [];
    return { calls, run: (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { status, ...extra }; } };
  };

  test("a scoped lane goes into the slice, and the slice is given its limit before the start, at runtime only", () => {
    const { calls, run } = recorder(0);
    const launch = planSupervisorLaunch("20260925-100000-executor", "/r/supervise.ts", { scoped: true, cpu, run });
    expect(calls).toEqual([{ cmd: "systemctl", args: ["--user", "set-property", "--runtime", "idd_lanes.slice", "CPUQuota=1000%", "CPUWeight=20"] }]);
    expect(launch.cmd).toBe("systemd-run");
    expect(launch.args.slice(0, 6)).toEqual(["--user", "--scope", "--quiet", "--collect", "--unit=idd-lane-20260925-100000-executor", "--slice=idd_lanes.slice"]);
    expect(launch.args.slice(-4)).toEqual(["bun", "run", "/r/supervise.ts", "20260925-100000-executor"]);
    expect(launch.warning).toBeUndefined();
  });

  test("a conversation's own unit name is kept, inside the same slice", () => {
    const launch = planSupervisorLaunch("lane-a", "/s", { scoped: true, unit: "lane-a-1-2", cpu, run: recorder(0).run });
    expect(launch.args).toContain("--unit=idd-lane-lane-a-1-2");
    expect(launch.args).toContain("--slice=idd_lanes.slice");
  });

  test("when the limit cannot be set, the lane still starts in the slice and a warning says it runs without the limit", () => {
    const failed = planSupervisorLaunch("x", "/s", { scoped: true, cpu, run: recorder(1, { stderr: "Failed to connect to bus\n" }).run });
    expect(failed.cmd).toBe("systemd-run");
    expect(failed.args).toContain("--slice=idd_lanes.slice");
    expect(failed.warning).toContain("exit 1: Failed to connect to bus");
    expect(failed.warning).toContain("CPU の上限を付け直せなかった（前の起動の上限が残っていればそれが効く）");
    const missing = planSupervisorLaunch("x", "/s", { scoped: true, cpu, run: recorder(null, { error: new Error("spawnSync systemctl ENOENT") }).run });
    expect(missing.cmd).toBe("systemd-run");
    expect(missing.warning).toContain("ENOENT");
  });

  test("cpu_quota: off takes only the limit away: the scope, the slice and the weight stay, and a limit left by an earlier start is cleared", () => {
    const off = parseRoles("defaults:\n  lane_cpu: { cpu_quota: off }\nroles: {}").defaults.laneCpu;
    expect(off).toEqual({ slice: "idd_lanes.slice", cpuQuota: null, cpuWeight: 20 });
    const { calls, run } = recorder(0);
    const launch = planSupervisorLaunch("x", "/s", { scoped: true, cpu: off, run });
    expect(calls[0].args).toEqual(["--user", "set-property", "--runtime", "idd_lanes.slice", "CPUQuota=", "CPUWeight=20"]);
    expect(launch.cmd).toBe("systemd-run");
    expect(launch.args).toContain("--slice=idd_lanes.slice");
  });

  test("an unscoped lane (IDD_LANE_SCOPE=off, or no systemd) starts as before, and nothing is asked of systemctl", () => {
    const { calls, run } = recorder(0);
    expect(planSupervisorLaunch("x", "/s", { scoped: false, cpu, run })).toEqual({ cmd: "bun", args: ["run", "/s", "x"] });
    expect(calls).toEqual([]);
  });

  test("the slice and its values are read from roles; the defaults are 10 of 16 CPUs at a low weight", () => {
    expect(parseRoles("roles: {}").defaults.laneCpu).toEqual({ slice: "idd_lanes.slice", cpuQuota: "1000%", cpuWeight: 20 });
    expect(parseRoles("defaults:\n  lane_cpu: { cpu_quota: 400%, cpu_weight: 10 }\nroles: {}").defaults.laneCpu).toEqual({ slice: "idd_lanes.slice", cpuQuota: "400%", cpuWeight: 10 });
    expect(parseRoles("defaults:\n  lane_cpu: { slice: idd_other.slice }\nroles: {}").defaults.laneCpu.slice).toBe("idd_other.slice");
  });

  shippedConfigTest(["roles.yaml"], "config/roles.yaml sets the slice and its values", () => {
    const repo = parseRoles(readFileSync(shippedConfig("roles.yaml"), "utf8"));
    expect(repo.defaults.laneCpu).toEqual({ slice: "idd_lanes.slice", cpuQuota: "1000%", cpuWeight: 20 });
  });

  test("a slice the lanes do not own, a slice name with a dash (systemd would nest it under another slice), or a malformed value is refused", () => {
    for (const shared of ["app.slice", "session.slice", "background.slice", "user.slice", "-.slice"]) {
      expect(() => parseRoles(`defaults:\n  lane_cpu: { slice: "${shared}" }\nroles: {}`)).toThrow(/idd_/);
    }
    expect(() => parseRoles("defaults:\n  lane_cpu: { slice: idd_lanes-x.slice }\nroles: {}")).toThrow(/階層/);
    expect(() => parseRoles("defaults:\n  lane_cpu: { slice: idd-lanes.slice }\nroles: {}")).toThrow(/idd_/);
    expect(() => parseRoles("defaults:\n  lane_cpu: { slice: idd_.slice }\nroles: {}")).toThrow(/idd_/);
    expect(() => parseRoles("defaults:\n  lane_cpu: { slice: idd_lanes }\nroles: {}")).toThrow(/\.slice/);
    expect(() => parseRoles("defaults:\n  lane_cpu: { cpu_quota: 10 }\nroles: {}")).toThrow(/百分率/);
    expect(() => parseRoles("defaults:\n  lane_cpu: { cpu_weight: 0 }\nroles: {}")).toThrow(/1〜10000/);
    expect(() => parseRoles("defaults:\n  lane_cpu: { cpu_quta: 400% }\nroles: {}")).toThrow(/知らない項目/);
  });
});

describe("a timed-out attempt", () => {
  // the wall-clock cut in spawnLaneProcess waits at least 60 s before it fires, so the move itself cannot be driven
  // inside a test's timeout; the decision it feeds is checked here: a cut reads as timeout, the default kinds
  // (quota, provider, timeout) let a role that writes no kinds move it to the next candidate, and taking timeout
  // out of that role's kinds stops the move
  test("reads as timeout, which the default kinds allow and a role can take out", () => {
    expect(failureKindOf({ status: "timeout" })).toBe("timeout");
    const dflt = parseRoles(`models:\n  x-y:\n    model: x/y\nroles:\n  a:\n    model: x-y\n    tools: [read]\n    report: review\n`);
    expect(dflt.defaults.fallbackOn).toEqual(["quota", "provider", "timeout"]);
    expect(dflt.roles.a.fallbackOn).toEqual(["quota", "provider", "timeout"]);
    const without = parseRoles(`models:\n  x-y:\n    model: x/y\nroles:\n  a:\n    model: x-y\n    tools: [read]\n    report: review\n    fallback_on: [quota, provider]\n`);
    expect(without.roles.a.fallbackOn).not.toContain("timeout");
  });
});

describe("what counts as a lane's deliverable", () => {
  test("a report.md alone (e.g. a progress note written before the provider failed) is not a deliverable; a readable report.json is required", () => {
    const dir = tmpDir("idd-report-");
    const base = join(dir, "report");
    writeFileSync(`${base}.md`, "作業中（途中経過）");
    expect(reportComplete(base)).toBe(false);
    writeFileSync(`${base}.json`, "{ not json");
    expect(reportComplete(base)).toBe(false);
    writeFileSync(`${base}.json`, JSON.stringify({ findings: [] }));
    expect(reportComplete(base)).toBe(true);
  });
});

describe("a lane's setup runs in its supervisor, not in the tick", () => {
  test("setup commands run in order in the worktree; the first failure stops them and is reported", () => {
    const dir = tmpDir("idd-setup-");
    const log = join(dir, "setup.log");
    expect(runSetup(["echo one > a.txt", "echo two >> a.txt"], dir, log)).toEqual({ ok: true });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\ntwo\n");
    const r = runSetup(["true", "echo broken >&2; exit 3", "echo never > b.txt"], dir, log);
    expect(r.ok).toBe(false);
    expect(r.failed).toBe("echo broken >&2; exit 3");
    expect(r.output).toContain("broken");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
  });

  test("a spec can carry setup commands", () => {
    const dir = tmpDir("idd-spec-");
    const s = parseSpec(`role: r\nworktree: ${dir}\nreport: ${join(dir, "report")}\nsetup:\n  - fvm flutter pub get\n`, dir);
    expect(s.setup).toEqual(["fvm flutter pub get"]);
    expect(parseSpec(`role: r\nworktree: ${dir}\nreport: ${join(dir, "report")}\n`, dir).setup).toEqual([]);
  });
});

describe("a lane whose harness binary cannot be started", () => {
  test("fails with the reason instead of taking the supervisor down", async () => {
    const { spawnLaneProcess } = await import("../src/runner.ts");
    const dir = tmpDir("idd-spawn-");
    const rec = { id: "L", worktree: dir } as unknown as Parameters<typeof spawnLaneProcess>[0];
    const prev = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = dir;
    mkdirSync(join(dir, "lanes", "L"), { recursive: true });
    try {
      const code = await spawnLaneProcess(rec, join(dir, "no-such-claude"), ["-p"], process.env, dir, 60_000);
      expect(code).toBe(127);
      expect((rec as { spawn_error?: string }).spawn_error).toMatch(/no-such-claude/);
      expect(readFileSync(join(dir, "stderr.log"), "utf8")).toMatch(/no-such-claude/);
      // a bare name that is not on the PATH (the service's PATH lacked claude): bun throws at spawn
      const bare = { id: "L", worktree: dir } as unknown as Parameters<typeof spawnLaneProcess>[0];
      expect(await spawnLaneProcess(bare, "idd-no-such-harness", ["-p"], { PATH: dir }, dir, 60_000)).toBe(127);
      expect((bare as { spawn_error?: string }).spawn_error).toMatch(/idd-no-such-harness/);
    } finally {
      if (prev === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = prev;
    }
  });
});
