import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SHARED_DAEMONS, laneScopeCgroup, planLeftovers, rehomeArgs, settleLeftovers, type ScopeProcess } from "../src/leftovers.ts";
import { parseRoles } from "../src/roles.ts";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const SCOPE = "/user.slice/user-1000.slice/user@1000.service/idd_lanes.slice/idd-lane-20260925-080020-blind-reviewer-2.scope";

describe("which scope a supervisor cleans up", () => {
  test("only the scope started for its own lane: an ad-hoc lane's, or one of a conversation's", () => {
    expect(laneScopeCgroup(`0::${SCOPE}\n`, "20260925-080020-blind-reviewer-2")).toBe(SCOPE);
    const conv = "/user.slice/user-1000.slice/user@1000.service/idd_lanes.slice/idd-lane-20260925-010000-planner-opus-1790000000000-4242.scope";
    expect(laneScopeCgroup(`0::${conv}`, "20260925-010000-planner-opus")).toBe(conv);
  });

  test("never the caller's cgroup (the UI's service, a terminal, a test run inside some other lane)", () => {
    expect(laneScopeCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/idd-web.service\n", "L")).toBeNull();
    expect(laneScopeCgroup("0::/user.slice/user-1000.slice/session-2.scope\n", "L")).toBeNull();
    // a supervisor started by a test from inside another lane's scope
    expect(laneScopeCgroup(`0::${SCOPE}`, "20260926-000000-short-claude")).toBeNull();
    // a lane whose id is the other's with a suffix (two lanes of a role in one second)
    expect(laneScopeCgroup(`0::${SCOPE}`, "20260925-080020-blind-reviewer")).toBeNull();
    expect(laneScopeCgroup("", "L")).toBeNull();
  });
});

describe("what is left in a lane's scope when the lane ends", () => {
  const proc = (pid: number, ppid: number, cmdline: string): ScopeProcess => ({ pid, ppid, cmdline });

  test("a shared daemon (adb's server) and what it started are moved out; everything else is stopped", () => {
    const plan = planLeftovers([
      proc(10, 1, "adb -L tcp:5037 fork-server server --reply-fd 4"),
      proc(11, 10, "adb shell-helper"),
      proc(20, 1, "python3 scripts/run-host-mpris-live.py --position-lead-ms -100"),
      proc(21, 20, "sleep 999"),
    ], DEFAULT_SHARED_DAEMONS);
    expect(plan.keep).toEqual([{ root: proc(10, 1, "adb -L tcp:5037 fork-server server --reply-fd 4"), pids: [10, 11] }]);
    expect(plan.stop.map((p) => p.pid)).toEqual([20, 21]);
  });

  test("the adb client and a script that merely mentions adb are not taken for the server", () => {
    const plan = planLeftovers([proc(30, 1, "adb devices"), proc(31, 1, "bash -c adb wait-for-device")], DEFAULT_SHARED_DAEMONS);
    expect(plan.keep).toEqual([]);
    expect(plan.stop.map((p) => p.pid)).toEqual([30, 31]);
  });

  test("Gradle's and Kotlin's daemons, which a build outside the lane may be using, are kept", () => {
    const plan = planLeftovers([
      proc(40, 1, "/usr/lib/jvm/bin/java -Xmx2g -cp gradle-launcher.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10"),
      proc(41, 1, "/usr/lib/jvm/bin/java -cp kotlin-daemon.jar org.jetbrains.kotlin.daemon.KotlinCompileDaemon --daemon-runFilesPath x"),
    ], DEFAULT_SHARED_DAEMONS);
    expect(plan.keep.map((g) => g.root.pid)).toEqual([40, 41]);
    expect(plan.stop).toEqual([]);
  });

  test("an emulator and a Waydroid session a lane started are kept, not killed", () => {
    const plan = planLeftovers([
      proc(50, 1, "/home/p/Android/Sdk/emulator/emulator -avd Pixel_10a -no-snapshot"),
      proc(51, 50, "/home/p/Android/Sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64 -netdelay none -avd Pixel_10a"),
      proc(52, 1, "/home/p/Android/Sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64 -avd Other"),
      proc(53, 1, "/usr/bin/python3 /usr/bin/waydroid session start"),
      proc(54, 1, "waydroid status"),
      proc(55, 1, "python3 scripts/emulator_check.py"),
    ], DEFAULT_SHARED_DAEMONS);
    expect(plan.keep.map((g) => g.root.pid)).toEqual([50, 52, 53]);
    expect(plan.keep[0].pids).toEqual([50, 51]);
    expect(plan.stop.map((p) => p.pid)).toEqual([54, 55]);
  });

  test("an emulator started by its AVD's name (emulator @Pixel_10a) is kept too, and emulator's other commands are not", () => {
    const plan = planLeftovers([
      proc(60, 1, "/home/p/Android/Sdk/emulator/emulator @Pixel_10a -no-snapshot"),
      proc(61, 1, "emulator -no-window @Pixel_10a"),
      proc(62, 1, "emulator -list-avds"),
      proc(63, 1, "grep emulator user@host"),
    ], DEFAULT_SHARED_DAEMONS);
    expect(plan.keep.map((g) => g.root.pid)).toEqual([60, 61]);
    expect(plan.stop.map((p) => p.pid)).toEqual([62, 63]);
  });

  test("the move asks systemd for a scope of its own holding the daemon's processes, collected once they end", () => {
    expect(rehomeArgs("idd-kept-adb-10.scope", [10, 11], "kept")).toEqual([
      "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "StartTransientUnit",
      "ssa(sv)a(sa(sv))", "idd-kept-adb-10.scope", "fail", "3", "PIDs", "au", "2", "10", "11", "Description", "s", "kept", "CollectMode", "s", "inactive-or-failed", "0",
    ]);
  });
});

/** a /proc and a cgroup tree with the supervisor (pid 100) and what the lane left */
function fakeHost(scope: string, procs: ScopeProcess[], supervisor: ScopeProcess[] = [{ pid: 100, ppid: 1, cmdline: "bun run supervise.ts L" }]) {
  const root = mkdtempSync(join(tmpdir(), "idd-leftovers-"));
  roots.push(root);
  const procRoot = join(root, "proc");
  const cgroupRoot = join(root, "cgroup");
  const all = [...supervisor, ...procs];
  for (const p of all) {
    mkdirSync(join(procRoot, String(p.pid)), { recursive: true });
    writeFileSync(join(procRoot, String(p.pid), "cgroup"), `0::${scope}\n`);
    writeFileSync(join(procRoot, String(p.pid), "stat"), `${p.pid} (x y) S ${p.ppid} ${p.pid} ${p.pid} 0 -1\n`);
    writeFileSync(join(procRoot, String(p.pid), "cmdline"), `${p.cmdline.split(" ").join("\0")}\0`);
  }
  mkdirSync(join(cgroupRoot, scope), { recursive: true });
  const members = new Set(all.map((p) => p.pid));
  const writeMembers = () => writeFileSync(join(cgroupRoot, scope, "cgroup.procs"), `${[...members].join("\n")}\n`);
  writeMembers();
  const signals: string[] = [];
  const commands: string[][] = [];
  const write = (p: ScopeProcess) => {
    mkdirSync(join(procRoot, String(p.pid)), { recursive: true });
    writeFileSync(join(procRoot, String(p.pid), "cgroup"), `0::${scope}\n`);
    writeFileSync(join(procRoot, String(p.pid), "stat"), `${p.pid} (x y) S ${p.ppid} ${p.pid} ${p.pid} 0 -1\n`);
    writeFileSync(join(procRoot, String(p.pid), "cmdline"), `${p.cmdline.split(" ").join("\0")}\0`);
  };
  return {
    procRoot, cgroupRoot, signals, commands, members,
    /** a process that starts in the scope later */
    add(p: ScopeProcess) { write(p); members.add(p.pid); writeMembers(); },
    /** a process that ends on its own */
    drop(pid: number) { members.delete(pid); writeMembers(); },
    /** pids that go away on SIGTERM; the others stay until SIGKILL */
    kill(stubborn: number[] = []) {
      return (pid: number, sig: NodeJS.Signals) => {
        signals.push(`${sig} ${pid}`);
        if (sig === "SIGKILL" || !stubborn.includes(pid)) { members.delete(pid); writeMembers(); }
      };
    },
    run(ok = true) {
      return (cmd: string, args: string[]) => {
        commands.push([cmd, ...args]);
        if (ok) for (const p of args.slice(13, 13 + Number(args[12]))) members.delete(Number(p));
        writeMembers();
        return ok ? { status: 0 } : { status: 1, stderr: "Access denied" };
      };
    },
  };
}

describe("the supervisor's cleanup of its lane's scope", () => {
  const LANE = "20260925-080020-blind-reviewer-2";
  const left = [
    { pid: 201, ppid: 1, cmdline: "adb -L tcp:5037 fork-server server --reply-fd 4" },
    { pid: 202, ppid: 1, cmdline: "python3 scripts/run-host-mpris-live.py --position-lead-ms -100" },
    { pid: 203, ppid: 202, cmdline: "sleep 999" },
  ];

  test("moves the shared daemon out, stops the rest, and says so line by line", async () => {
    const host = fakeHost(SCOPE, left);
    const lines = await settleLeftovers({ laneId: LANE, secrets: [], selfPid: 100, procRoot: host.procRoot, cgroupRoot: host.cgroupRoot, run: host.run(), kill: host.kill(), graceMs: 200, sleep: async () => {} });
    expect(host.commands.length).toBe(1);
    expect(host.commands[0]).toContain("idd-kept-adb-201.scope");
    expect(host.signals).toEqual(["SIGTERM 202", "SIGTERM 203"]);
    expect([...host.members]).toEqual([100]);
    expect(lines.some((l) => l.includes("idd-kept-adb-201.scope") && l.includes("fork-server"))).toBe(true);
    expect(lines.filter((l) => l.includes("止めた")).length).toBe(2);
    expect(lines.some((l) => l.includes("run-host-mpris-live.py"))).toBe(true);
  });

  test("a process that ignores SIGTERM gets SIGKILL after the grace", async () => {
    const host = fakeHost(SCOPE, left.slice(1));
    let now = 0;
    await settleLeftovers({ laneId: LANE, secrets: [], selfPid: 100, procRoot: host.procRoot, cgroupRoot: host.cgroupRoot, run: host.run(), kill: host.kill([202]), graceMs: 500, sleep: async (ms) => { now += ms; }, now: () => now });
    expect(host.signals).toEqual(["SIGTERM 202", "SIGTERM 203", "SIGKILL 202"]);
    expect([...host.members]).toEqual([100]);
  });

  test("when the move is refused, the daemon is left where it is, never stopped", async () => {
    const host = fakeHost(SCOPE, left.slice(0, 1));
    const lines = await settleLeftovers({ laneId: LANE, secrets: [], selfPid: 100, procRoot: host.procRoot, cgroupRoot: host.cgroupRoot, run: host.run(false), kill: host.kill(), graceMs: 200, sleep: async () => {} });
    expect(host.signals).toEqual([]);
    expect(host.members.has(201)).toBe(true);
    expect(lines.join("\n")).toContain("Access denied");
  });

  test("outside its own lane's scope it touches nothing", async () => {
    const host = fakeHost("/user.slice/user-1000.slice/user@1000.service/app.slice/idd-web.service", left);
    const lines = await settleLeftovers({ laneId: LANE, secrets: [], selfPid: 100, procRoot: host.procRoot, cgroupRoot: host.cgroupRoot, run: host.run(), kill: host.kill(), graceMs: 200, sleep: async () => {} });
    expect(lines).toEqual([]);
    expect(host.signals).toEqual([]);
    expect(host.commands).toEqual([]);
  });

  test("the processes the supervisor runs under (a launcher of bun, as volta's) are never taken for leftovers", async () => {
    const host = fakeHost(SCOPE, left.slice(1), [
      { pid: 98, ppid: 1, cmdline: "/home/p/.volta/bin/bun run supervise.ts L" },
      { pid: 99, ppid: 98, cmdline: "/home/p/.volta/tools/image/bun/1.3/bin/bun run supervise.ts L" },
      { pid: 100, ppid: 99, cmdline: "bun supervise.ts L" },
    ]);
    const lines = await settleLeftovers({ laneId: LANE, secrets: [], selfPid: 100, procRoot: host.procRoot, cgroupRoot: host.cgroupRoot, run: host.run(), kill: host.kill(), graceMs: 200, sleep: async () => {} });
    expect(host.signals).toEqual(["SIGTERM 202", "SIGTERM 203"]);
    expect([...host.members].sort()).toEqual([100, 98, 99].sort());
    expect(lines.join("\n")).not.toContain("volta");
  });

  test("processes that appear while the others are stopping (a child forked on SIGTERM) are stopped in a later round", async () => {
    const host = fakeHost(SCOPE, left.slice(1));
    const base = host.kill();
    const kill = (pid: number, sig: NodeJS.Signals) => {
      base(pid, sig);
      // the script forks a helper as it shuts down: a new pid in the scope, never seen by the first look
      if (pid === 202 && sig === "SIGTERM") host.add({ pid: 204, ppid: 1, cmdline: "python3 cleanup-helper.py" });
    };
    const lines = await settleLeftovers({ laneId: LANE, secrets: [], selfPid: 100, procRoot: host.procRoot, cgroupRoot: host.cgroupRoot, run: host.run(), kill, graceMs: 200, sleep: async () => {} });
    expect(host.signals).toEqual(["SIGTERM 202", "SIGTERM 203", "SIGTERM 204"]);
    expect([...host.members]).toEqual([100]);
    expect(lines.some((l) => l.includes("cleanup-helper.py"))).toBe(true);
  });

  test("a shared daemon that appears late is moved, and what was moved is never looked at again", async () => {
    const host = fakeHost(SCOPE, left.slice(0, 2));
    const base = host.kill();
    const kill = (pid: number, sig: NodeJS.Signals) => {
      base(pid, sig);
      if (pid === 202 && sig === "SIGTERM") host.add({ pid: 205, ppid: 1, cmdline: "adb -L tcp:5037 fork-server server --reply-fd 4" });
    };
    await settleLeftovers({ laneId: LANE, secrets: [], selfPid: 100, procRoot: host.procRoot, cgroupRoot: host.cgroupRoot, run: host.run(), kill, graceMs: 200, sleep: async () => {} });
    expect(host.commands.map((c) => c.find((a) => a.startsWith("idd-kept-")))).toEqual(["idd-kept-adb-201.scope", "idd-kept-adb-205.scope"]);
    expect(host.signals).toEqual(["SIGTERM 202"]);
    expect([...host.members]).toEqual([100]);
  });

  test("a move refused because one of its pids ended meanwhile is tried once more with the pids still there", async () => {
    const host = fakeHost(SCOPE, [left[0], { pid: 206, ppid: 201, cmdline: "adb helper" }]);
    let calls = 0;
    const run = (cmd: string, args: string[]) => {
      calls += 1;
      if (calls === 1) {
        // the helper ended between the look and the call: systemd refuses the whole start
        host.drop(206);
        host.commands.push([cmd, ...args]);
        return { status: 1, stderr: "No such process" };
      }
      return host.run()(cmd, args);
    };
    const lines = await settleLeftovers({ laneId: LANE, secrets: [], selfPid: 100, procRoot: host.procRoot, cgroupRoot: host.cgroupRoot, run, kill: host.kill(), graceMs: 200, sleep: async () => {} });
    expect(host.commands.length).toBe(2);
    expect(host.commands[1].slice(12, 15)).toEqual(["au", "1", "201"]);
    expect([...host.members]).toEqual([100]);
    expect(lines.some((l) => l.includes("移した"))).toBe(true);
    expect(host.signals).toEqual([]);
  });

  test("what a daemon that could not be moved starts later is left with it, not stopped", async () => {
    const host = fakeHost(SCOPE, [left[0], left[1]]);
    const base = host.kill();
    const kill = (pid: number, sig: NodeJS.Signals) => {
      base(pid, sig);
      if (pid === 202 && sig === "SIGTERM") host.add({ pid: 207, ppid: 201, cmdline: "adb shell-helper" });
    };
    await settleLeftovers({ laneId: LANE, secrets: [], selfPid: 100, procRoot: host.procRoot, cgroupRoot: host.cgroupRoot, run: host.run(false), kill, graceMs: 200, sleep: async () => {} });
    expect(host.signals).toEqual(["SIGTERM 202"]);
    expect(host.members.has(201)).toBe(true);
    expect(host.members.has(207)).toBe(true);
  });

  test("told not to stop (the shared daemons unknown), it moves what it knows and leaves the rest running, saying so", async () => {
    const host = fakeHost(SCOPE, left);
    const lines = await settleLeftovers({ laneId: LANE, stop: false, secrets: [], selfPid: 100, procRoot: host.procRoot, cgroupRoot: host.cgroupRoot, run: host.run(), kill: host.kill(), graceMs: 200, sleep: async () => {} });
    expect(host.signals).toEqual([]);
    expect(host.commands.length).toBe(1);
    expect([...host.members].sort()).toEqual([100, 202, 203]);
    expect(lines.filter((l) => l.includes("止めずに残す")).length).toBe(2);
  });

  test("with nothing left but the supervisor, it has nothing to say", async () => {
    const host = fakeHost(SCOPE, []);
    expect(await settleLeftovers({ laneId: LANE, secrets: [], selfPid: 100, procRoot: host.procRoot, cgroupRoot: host.cgroupRoot, run: host.run(), kill: host.kill(), sleep: async () => {} })).toEqual([]);
  });
});

describe("the settings in roles.yaml", () => {
  test("the tool call limit defaults to 15 minutes, takes a number of minutes, and off", () => {
    expect(parseRoles("roles: {}").defaults.toolTimeoutMinutes).toBe(15);
    expect(parseRoles("defaults:\n  tool_timeout_minutes: 0.5\nroles: {}").defaults.toolTimeoutMinutes).toBe(0.5);
    expect(parseRoles("defaults:\n  tool_timeout_minutes: off\nroles: {}").defaults.toolTimeoutMinutes).toBeNull();
    expect(() => parseRoles("defaults:\n  tool_timeout_minutes: 0\nroles: {}")).toThrow(/tool_timeout_minutes/);
    expect(() => parseRoles("defaults:\n  tool_timeout_minutes: ten\nroles: {}")).toThrow(/tool_timeout_minutes/);
  });

  test("the shared daemons default to adb's server and the build daemons, and a pattern that does not compile is refused", () => {
    expect(parseRoles("roles: {}").defaults.sharedDaemons).toEqual(DEFAULT_SHARED_DAEMONS);
    expect(parseRoles("defaults:\n  shared_daemons: ['emulator']\nroles: {}").defaults.sharedDaemons).toEqual(["emulator"]);
    expect(() => parseRoles("defaults:\n  shared_daemons: ['(']\nroles: {}")).toThrow(/shared_daemons/);
    expect(() => parseRoles("defaults:\n  shared_daemons: adb\nroles: {}")).toThrow(/shared_daemons/);
  });
});
