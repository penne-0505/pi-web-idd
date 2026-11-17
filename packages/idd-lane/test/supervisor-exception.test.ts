import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planReviewState } from "../src/plan-review.ts";
import { reviewRunState } from "../src/review-runs.ts";
import { laneDir, prepareLane, readLane, type LaneRecord } from "../src/runner.ts";
import { superviseLane } from "../src/supervisor.ts";

const ENV_KEYS = [
  "IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_REPOS_FILE", "IDD_LANE_ROOT", "IDD_LANE_SCOPE",
  "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR", "IDD_TICK_KICK", "IDD_SYSTEMD_RUN_BIN", "IDD_SYSTEMCTL_BIN",
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const roots: string[] = [];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** enough of pi for `prepareLane`'s startability check: the catalog comes back empty, which the role tolerates */
const FAKE_PI = `#!/usr/bin/env node
if (process.argv.includes("--list-models")) process.exit(0);
process.exit(0);
`;

/**
 * A prepared pi lane plus a systemd-run stand-in that records the calls it gets: a fake kick must keep the real one
 * (and systemd) out of the test. The lane never starts pi in these tests; its run is made to throw first.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "idd-supervisor-exc-"));
  roots.push(root);
  const wt = join(root, "wt"); mkdirSync(wt);
  execFileSync("git", ["init", "-q", wt]);
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: wt });
  writeFileSync(join(root, "roles.yaml"), [
    "defaults:",
    "  tool_timeout_minutes: off",
    "models:",
    "  m:",
    "    model: x/y",
    "roles:",
    "  r:",
    "    model: m",
    "    tools: [read, bash]",
    "    report: free",
    "    require_clean: false",
    "    budget_minutes: 2",
  ].join("\n"));
  writeFileSync(join(root, "repos.yaml"), "repos:\n");
  const agent = join(root, "agent"); mkdirSync(agent);
  const noRoot = join(root, "no-lane-root"); mkdirSync(noRoot);
  const fakePi = join(root, "pi"); writeFileSync(fakePi, FAKE_PI); chmodSync(fakePi, 0o755);
  const report = join(root, "out", "report"); mkdirSync(join(root, "out"));
  const marker = join(root, "systemd-runs");
  const fakeSystemdRun = join(root, "systemd-run");
  writeFileSync(fakeSystemdRun, `#!/usr/bin/env bash\necho "$@" >> ${marker}\nexit 0\n`); chmodSync(fakeSystemdRun, 0o755);
  Object.assign(process.env, {
    IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"),
    IDD_LANE_ROOT: noRoot, IDD_LANE_SCOPE: "off", IDD_PI_BIN: fakePi, IDD_PI_USER_AGENT_DIR: agent,
    IDD_TICK_KICK: "off", IDD_SYSTEMD_RUN_BIN: fakeSystemdRun, IDD_SYSTEMCTL_BIN: fakeSystemdRun,
  });
  const specPath = join(root, "spec.yaml");
  writeFileSync(specPath, `role: r\nworktree: ${wt}\nreport: ${report}\ntask: t\n`);
  return { root, specPath, report, marker };
}

/** make the lane's run throw at its first step: `executeLane` reads this before it starts anything */
function breakRun(id: string): void {
  rmSync(join(laneDir(id), "pi-args.json"));
}

/** the error `superviseLane` rejects with, or null when it resolved */
async function rejection(id: string, opts: Parameters<typeof superviseLane>[1]): Promise<Error | null> {
  return superviseLane(id, opts).then(() => null, (e) => (e instanceof Error ? e : new Error(String(e))));
}

describe("a stage lane's run that throws", () => {
  test("is closed as failed before a tick is asked for, and the run's exception still leaves", async () => {
    const fx = fixture();
    const { rec } = prepareLane(fx.specPath);
    breakRun(rec.id);
    let statusAtKick: string | undefined;
    const kicks: number[] = [];
    const settled: string[] = [];
    const err = await rejection(rec.id, {
      kick: () => { statusAtKick = readLane(rec.id).status; kicks.push(Date.now()); return { outcome: "scheduled", unit: "k1" }; },
      settle: async (id) => { settled.push(id); return []; },
    });

    expect(err?.message).toMatch(/pi-args/);
    expect(kicks.length).toBe(1);
    expect(statusAtKick).toBe("failed");
    const after = readLane(rec.id);
    expect(after.status).toBe("failed");
    expect(after.error).toContain("監督が異常終了した");
    expect(after.error).toContain("pi-args");
    expect(typeof after.ended_at).toBe("string");
    expect(planReviewState(rec.id).state).toBe("failed");
    expect(reviewRunState(rec.id).state).toBe("failed");
    expect(settled).toEqual([rec.id]);
    const log = readFileSync(join(laneDir(rec.id), "supervisor.log"), "utf8");
    expect(log).toContain("[tick] scheduled k1");
    // the fake kick is the one used: the real requestTick never reaches systemd
    expect(existsSync(fx.marker)).toBe(false);
  }, 30_000);

  test("leaves a record that is already in an end state as it is", async () => {
    const fx = fixture();
    const { rec } = prepareLane(fx.specPath);
    const done: LaneRecord = { ...readLane(rec.id), status: "done", ended_at: new Date().toISOString(), exit: 0 };
    writeFileSync(join(laneDir(rec.id), "lane.json"), `${JSON.stringify(done, null, 2)}\n`);
    breakRun(rec.id);
    let kicked = 0;
    const err = await rejection(rec.id, { kick: () => { kicked += 1; return { outcome: "off" }; }, settle: async () => [] });
    // an ended record is not read for its run at all: nothing is started and no exception leaves
    expect(err).toBeNull();
    expect(kicked).toBe(1);
    const after = readLane(rec.id);
    expect(after.status).toBe("done");
    expect(after.error).toBeUndefined();
  }, 30_000);
});

describe("the exception's cleanup is best effort", () => {
  test("a kick that throws does not replace the run's exception", async () => {
    const fx = fixture();
    const { rec } = prepareLane(fx.specPath);
    breakRun(rec.id);
    const err = await rejection(rec.id, { kick: () => { throw new Error("kick boom"); }, settle: async () => [] });
    expect(err?.message).toMatch(/pi-args/);
    expect(readLane(rec.id).status).toBe("failed");
    const log = readFileSync(join(laneDir(rec.id), "supervisor.log"), "utf8");
    expect(log).toContain("[tick] failed");
    expect(log).toContain("kick boom");
  }, 30_000);

  test("a kick that returns a failure does not replace the run's exception either", async () => {
    const fx = fixture();
    const { rec } = prepareLane(fx.specPath);
    breakRun(rec.id);
    const err = await rejection(rec.id, { kick: () => ({ outcome: "failed", detail: "nope" }), settle: async () => [] });
    expect(err?.message).toMatch(/pi-args/);
    expect(readLane(rec.id).status).toBe("failed");
    expect(readFileSync(join(laneDir(rec.id), "supervisor.log"), "utf8")).toContain("[tick] failed: nope");
  }, 30_000);

  test("a record that cannot be closed is written down, the tick is still asked for, and the exception still leaves", async () => {
    const fx = fixture();
    const { rec } = prepareLane(fx.specPath);
    breakRun(rec.id);
    const record = join(laneDir(rec.id), "lane.json");
    chmodSync(record, 0o444);
    let kicked = 0;
    let settled = 0;
    try {
      const err = await rejection(rec.id, {
        kick: () => { kicked += 1; return { outcome: "scheduled", unit: "k2" }; },
        settle: async () => { settled += 1; return []; },
      });
      // the record is read-only, so the supervisor cannot name itself in it before the run starts
      expect(err?.message).toMatch(/lane\.json/);
      expect(kicked).toBe(1);
      expect(settled).toBe(1);
      const log = readFileSync(join(laneDir(rec.id), "supervisor.log"), "utf8");
      expect(log).toContain("[exception] 記録を失敗で閉じられなかった");
      expect(log).toContain("[tick] scheduled k2");
    } finally {
      chmodSync(record, 0o644);
    }
  }, 30_000);
});

describe("a lane whose record cannot be read", () => {
  test("still asks for a tick, writes nothing new, and leaves the exception", async () => {
    const fx = fixture();
    const { rec } = prepareLane(fx.specPath);
    rmSync(join(laneDir(rec.id), "lane.json"));
    let kicked = 0;
    let settled = 0;
    const err = await rejection(rec.id, {
      kick: () => { kicked += 1; return { outcome: "scheduled", unit: "k3" }; },
      settle: async () => { settled += 1; return []; },
    });
    expect(err?.message).toContain(rec.id);
    expect(kicked).toBe(1);
    expect(settled).toBe(1);
    expect(existsSync(join(laneDir(rec.id), "lane.json"))).toBe(false);
    const log = readFileSync(join(laneDir(rec.id), "supervisor.log"), "utf8");
    expect(log).toContain("[exception] 記録を失敗で閉じられなかった");
    expect(log).toContain("[tick] scheduled k3");
  }, 30_000);
});

describe("the supervisor before it starts the agent", () => {
  test("names itself in the record before the agent process is up", async () => {
    const fx = fixture();
    const { rec } = prepareLane(fx.specPath);
    const snapshot = join(fx.root, "at-agent.json");
    const pi = join(fx.root, "pi");
    writeFileSync(pi, `#!/usr/bin/env node
if (process.argv.includes("--list-models")) process.exit(0);
const fs = require("node:fs");
const path = require("node:path");
const dir = path.join(process.env.IDD_STATE_DIR, "lanes", process.env.IDD_LANE_ID);
fs.copyFileSync(path.join(dir, "lane.json"), ${JSON.stringify(snapshot)});
process.exit(0);
`);
    chmodSync(pi, 0o755);
    await superviseLane(rec.id, { kick: () => ({ outcome: "off" }), settle: async () => [] });
    expect(JSON.parse(readFileSync(snapshot, "utf8")).supervisor_pid).toBe(process.pid);
  }, 30_000);

  test("starts nothing when the record already ended, and leaves it alone", async () => {
    const fx = fixture();
    const { rec } = prepareLane(fx.specPath);
    const marker = join(fx.root, "agent-ran");
    const pi = join(fx.root, "pi");
    writeFileSync(pi, `#!/usr/bin/env node
if (process.argv.includes("--list-models")) process.exit(0);
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");
process.exit(0);
`);
    chmodSync(pi, 0o755);
    for (const status of ["failed", "stopped"] as const) {
      const closed: LaneRecord = { ...readLane(rec.id), status, error: "runner process ended before the lane finished", ended_at: new Date().toISOString() };
      writeFileSync(join(laneDir(rec.id), "lane.json"), `${JSON.stringify(closed, null, 2)}\n`);
      await superviseLane(rec.id, { kick: () => ({ outcome: "off" }), settle: async () => [] });
      expect(existsSync(marker)).toBe(false);
      expect(JSON.parse(readFileSync(join(laneDir(rec.id), "lane.json"), "utf8"))).toEqual(closed);
    }
    expect(readFileSync(join(laneDir(rec.id), "supervisor.log"), "utf8")).toContain("[skip]");
  }, 30_000);
});

describe("a conversation lane whose run throws", () => {
  const conversationRecord = (id: string, worktree: string): LaneRecord => ({
    id, role: "planner", model: "opus", worktree, spec: "", report: "",
    status: "idle", started_at: new Date().toISOString(), mode: "conversation", slot: "planner",
  });

  test("asks for no tick when no reply was added, and leaves the record alone", async () => {
    const fx = fixture();
    const id = "2026-01-01-000000-planner";
    const dir = laneDir(id);
    mkdirSync(dir, { recursive: true });
    const before = conversationRecord(id, fx.root);
    writeFileSync(join(dir, "lane.json"), `${JSON.stringify(before, null, 2)}\n`);
    // a directory no file can be created in: taking the conversation's lock fails before any reply runs
    chmodSync(dir, 0o555);
    let kicked = 0;
    let settled = 0;
    try {
      const err = await rejection(id, {
        kick: () => { kicked += 1; return { outcome: "scheduled" }; },
        settle: async () => { settled += 1; return []; },
      });
      expect(err).not.toBeNull();
      expect(kicked).toBe(0);
      expect(settled).toBe(1);
      expect(JSON.parse(readFileSync(join(dir, "lane.json"), "utf8"))).toEqual(before);
    } finally {
      chmodSync(dir, 0o755);
    }
  }, 30_000);
});
