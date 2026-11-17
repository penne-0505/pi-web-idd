import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { prepareLane, readLane } from "../src/runner.ts";
import { bookFollowUpTick, followUpName, requestTick, tickKickLaunch, tickKickUnit, TICK_AGAIN_FILE, TICK_KICK_DELAY_SECONDS } from "../src/tick-kick.ts";

const ENV_KEYS = ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_REPOS_FILE", "IDD_LANE_ROOT", "IDD_LANE_SCOPE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR", "IDD_SYSTEMD_RUN_BIN", "IDD_SYSTEMCTL_BIN", "IDD_TICK_KICK", "IDD_AGENT_BASE_URL"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const roots: string[] = [];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "idd-tick-kick-"));
  roots.push(d);
  return d;
}

const SCHEDULED = { status: 0 };
const CALLS: { cmd: string; args: string[] }[] = [];
const runner = (reply: { status: number; stderr?: string }) => (cmd: string, args: string[]) => { CALLS.push({ cmd, args }); return reply; };
/** a systemd whose kick unit of this name exists, with its timer in the given sub-state */
const existingKick = (unit: string, sub: string) => (cmd: string, args: string[]) => {
  CALLS.push({ cmd, args });
  if (cmd === "/fake/systemctl") return { status: 0, stdout: `${sub}\n` };
  if (args.includes(`--unit=${unit}`)) return { status: 1, stderr: `Failed to start transient timer unit: Unit ${unit}.timer was already loaded or has a fragment file.` };
  return { status: 0 };
};

describe("the tick a finished lane asks for", () => {
  test("is a transient timer that runs the CLI's intake-less tick for this state, shortly after, under a name of its own per state", () => {
    const launch = tickKickLaunch({ state: "/s/state", root: "/r", env: { PATH: "/bin:/usr/bin", IDD_AGENT_BASE_URL: "http://127.0.0.1:30142" } });
    const unit = tickKickUnit("/s/state");
    expect(unit).toMatch(/^idd-tick-kick-[0-9a-f]{8}$/);
    expect(tickKickUnit("/other/state")).not.toBe(unit);
    expect(launch.args).toEqual([
      "--user", "--quiet", "--collect", `--unit=${unit}`,
      `--on-active=${TICK_KICK_DELAY_SECONDS}s`, "--timer-property=AccuracySec=1s",
      "--working-directory=/r", "--property=Nice=10",
      "--setenv=PATH=/bin:/usr/bin", "--setenv=IDD_STATE_DIR=/s/state", "--setenv=IDD_AGENT_BASE_URL=http://127.0.0.1:30142",
      "/r/bin/idd", "tick", "--no-intake", "--for-state", "/s/state",
    ]);
    // without a base URL, the engine's port picks it (the API's destination is the engine), with PORT as the fallback
    expect(tickKickLaunch({ state: "/s", root: "/r", env: { PORT: "30143" } }).args).toContain("--setenv=IDD_AGENT_BASE_URL=http://127.0.0.1:30143");
    expect(tickKickLaunch({ state: "/s", root: "/r", env: { IDD_ENGINE_PORT: "30200" } }).args).toContain("--setenv=IDD_AGENT_BASE_URL=http://127.0.0.1:30200");
    expect(tickKickLaunch({ state: "/s", root: "/r", env: {} }).args).toContain("--setenv=IDD_AGENT_BASE_URL=http://127.0.0.1:30144");
  });

  test("leaves a request in the state, then schedules the tick; a tick already scheduled or running is not scheduled twice", () => {
    const root = scratch();
    const state = join(root, "state");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_SYSTEMD_RUN_BIN = "/fake/systemd-run";
    delete process.env.IDD_LANE_SCOPE; delete process.env.IDD_TICK_KICK;
    CALLS.length = 0;
    expect(requestTick({ run: runner(SCHEDULED) })).toMatchObject({ outcome: "scheduled", unit: tickKickUnit(state) });
    expect(existsSync(join(state, TICK_AGAIN_FILE))).toBe(true);
    expect(CALLS[0].cmd).toBe("/fake/systemd-run");
    expect(CALLS[0].args).toContain(`--unit=${tickKickUnit(state)}`);
    expect(CALLS[0].args.slice(-3)).toEqual(["--no-intake", "--for-state", state]);
    rmSync(join(state, TICK_AGAIN_FILE));
    // systemd refuses a second unit of the same name while the first waits or its tick runs
    const exists = { status: 1, stderr: `Failed to start transient timer unit: Unit ${tickKickUnit(state)}.timer was already loaded or has a fragment file.` };
    expect(requestTick({ run: runner(exists) })).toMatchObject({ outcome: "coalesced" });
    expect(existsSync(join(state, TICK_AGAIN_FILE))).toBe(true);
    const broken = requestTick({ run: runner({ status: 1, stderr: "Failed to connect to bus" }) });
    expect(broken.outcome).toBe("failed");
    expect(broken.detail).toContain("Failed to connect to bus");
  });

  test("that meets the kick of this state already running its tick books a follow-up under a name of its own; one still waiting covers it", () => {
    const root = scratch();
    const state = join(root, "state");
    Object.assign(process.env, { IDD_STATE_DIR: state, IDD_SYSTEMD_RUN_BIN: "/fake/systemd-run", IDD_SYSTEMCTL_BIN: "/fake/systemctl" });
    delete process.env.IDD_LANE_SCOPE; delete process.env.IDD_TICK_KICK;
    const unit = tickKickUnit(state);
    CALLS.length = 0;
    // the tick of the kick is running, and may have passed the point where it looks for requests
    const running = requestTick({ run: existingKick(unit, "running") });
    expect(running.outcome).toBe("scheduled");
    expect(running.unit).toMatch(new RegExp(`^${unit}-f[0-9a-z-]+$`));
    const runs = CALLS.filter((c) => c.cmd === "/fake/systemd-run");
    expect(runs.length).toBe(2);
    expect(runs[1].args).toContain(`--unit=${running.unit}`);
    expect(runs[1].args.slice(-3)).toEqual(["--no-intake", "--for-state", state]);
    expect(CALLS.find((c) => c.cmd === "/fake/systemctl")?.args).toEqual(["--user", "show", "-p", "SubState", "--value", `${unit}.timer`]);
    // still waiting: its tick has not started, and it reads this result when it does
    CALLS.length = 0;
    expect(requestTick({ run: existingKick(unit, "waiting") }).outcome).toBe("coalesced");
    expect(CALLS.filter((c) => c.cmd === "/fake/systemd-run").length).toBe(1);
  });

  test("a follow-up booked for a request left past a tick's last pass gets a name no kick holds", () => {
    const root = scratch();
    const state = join(root, "state");
    Object.assign(process.env, { IDD_STATE_DIR: state, IDD_SYSTEMD_RUN_BIN: "/fake/systemd-run" });
    delete process.env.IDD_LANE_SCOPE; delete process.env.IDD_TICK_KICK;
    CALLS.length = 0;
    const unit = tickKickUnit(state);
    // the clock is fixed: both bookings land in the same millisecond on purpose, and the names must still differ
    const a = bookFollowUpTick({ run: runner(SCHEDULED), now: 1_700_000_000_000 });
    const b = bookFollowUpTick({ run: runner(SCHEDULED), now: 1_700_000_000_000 });
    expect(a.outcome).toBe("scheduled");
    expect(a.unit).not.toBe(unit);
    expect(a.unit?.startsWith(`${unit}-f`)).toBe(true);
    expect(a.unit).toMatch(new RegExp(`^${unit}-f[0-9a-z-]+$`));
    expect(a.unit?.length).toBeLessThanOrEqual(255);
    expect(b.unit).not.toBe(a.unit);
    expect(CALLS[0].args.slice(-4)).toEqual(["tick", "--no-intake", "--for-state", state]);
    process.env.IDD_TICK_KICK = "off";
    expect(bookFollowUpTick({ run: runner(SCHEDULED) }).outcome).toBe("off");
  });

  test("a follow-up booked for the same millisecond by another process is under a name of its own", () => {
    const root = scratch();
    const state = join(root, "state");
    Object.assign(process.env, { IDD_STATE_DIR: state, IDD_SYSTEMD_RUN_BIN: "/fake/systemd-run" });
    delete process.env.IDD_LANE_SCOPE; delete process.env.IDD_TICK_KICK;
    const unit = tickKickUnit(state);
    const now = 1_700_000_000_000;
    // the same millisecond and the same count, and only the process differs: the pid alone must separate them
    expect(followUpName(state, { now, pid: 111, count: 1 })).not.toBe(followUpName(state, { now, pid: 222, count: 1 }));
    CALLS.length = 0;
    const first = bookFollowUpTick({ run: runner(SCHEDULED), now, pid: 111 });
    const second = bookFollowUpTick({ run: runner(SCHEDULED), now, pid: 222 });
    expect(first.unit).not.toBe(second.unit);
    const runs = CALLS.filter((c) => c.cmd === "/fake/systemd-run");
    expect(runs.map((c) => c.args.find((a) => a.startsWith("--unit=")))).toEqual([`--unit=${first.unit}`, `--unit=${second.unit}`]);
    for (const u of [first.unit, second.unit]) {
      expect(u).toMatch(new RegExp(`^${unit}-f[0-9a-z-]+$`));
      expect(u).not.toBe(unit);
      expect(u?.length).toBeLessThanOrEqual(255);
    }
  });

  test("is not asked for when kicks are off, or when lanes run without systemd", () => {
    const root = scratch();
    const state = join(root, "state");
    process.env.IDD_STATE_DIR = state;
    CALLS.length = 0;
    process.env.IDD_TICK_KICK = "off";
    expect(requestTick({ run: runner(SCHEDULED) }).outcome).toBe("off");
    delete process.env.IDD_TICK_KICK;
    process.env.IDD_LANE_SCOPE = "off";
    expect(requestTick({ run: runner(SCHEDULED) }).outcome).toBe("off");
    expect(CALLS).toEqual([]);
    expect(existsSync(join(state, TICK_AGAIN_FILE))).toBe(false);
  });
});

describe("a stage lane's supervisor", () => {
  test("asks for a tick once the lane's record is final", async () => {
    const root = scratch();
    const wt = join(root, "wt"); mkdirSync(wt);
    execFileSync("git", ["init", "-q", wt]);
    execFileSync("git", ["-C", wt, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"]);
    const report = join(root, "out", "report");
    const fakePi = join(root, "pi");
    writeFileSync(fakePi, `#!/bin/sh\ncase "$*" in *--list-models*) exit 0 ;; esac\nmkdir -p ${join(root, "out")}\necho done > ${report}.md\necho '{"findings":[]}' > ${report}.json\n`);
    chmodSync(fakePi, 0o755);
    const agent = join(root, "agent"); mkdirSync(agent);
    const noRoot = join(root, "no-lane-root"); mkdirSync(noRoot);
    writeFileSync(join(root, "roles.yaml"), "models:\n  x-y:\n    model: x/y\nroles:\n  api:\n    model: x-y\n    tools: [read]\n    report: review\n");
    writeFileSync(join(root, "repos.yaml"), "repos:\n");
    const state = join(root, "state");
    Object.assign(process.env, {
      IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"),
      IDD_LANE_ROOT: noRoot, IDD_PI_BIN: fakePi, IDD_PI_USER_AGENT_DIR: agent,
    });
    delete process.env.IDD_LANE_SCOPE; delete process.env.IDD_TICK_KICK;
    const spec = join(root, "spec.yaml");
    writeFileSync(spec, `role: api\nworktree: ${wt}\nreport: ${report}\ntask: t\n`);
    const { rec } = prepareLane(spec);
    // a systemd-run that records how it was asked and what the lane's record said at that moment
    const log = join(root, "systemd-run.log");
    const fakeRun = join(root, "systemd-run");
    writeFileSync(fakeRun, `#!/bin/sh\necho "$*" >> ${log}\ngrep -m1 -o '^  "status": "[a-z]*"' ${join(state, "lanes", rec.id, "lane.json")} >> ${log}\nexit 0\n`);
    chmodSync(fakeRun, 0o755);
    const supervisor = resolve(import.meta.dir, "../bin/supervise.ts");
    const r = spawnSync(process.execPath, ["run", supervisor, rec.id], { env: { ...process.env, IDD_SYSTEMD_RUN_BIN: fakeRun }, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(readLane(rec.id).status).toBe("done");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain(`--unit=${tickKickUnit(state)}`);
    expect(lines[0]).toContain("tick --no-intake --for-state");
    expect(lines[1]).toBe('  "status": "done"');
    expect(existsSync(join(state, TICK_AGAIN_FILE))).toBe(true);
    expect(readFileSync(join(state, "lanes", rec.id, "supervisor.log"), "utf8")).toContain("[tick] scheduled");
  }, 60_000);
});
