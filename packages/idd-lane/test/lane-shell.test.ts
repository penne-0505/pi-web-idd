import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LANE_SHELL_PASS_ENV, TOOL_TIMEOUT_LOG, TOOL_TIMEOUT_LOG_ENV, TOOL_TIMEOUT_SECONDS_ENV, writeLaneShell, writeLaneShellEnv } from "../src/lane-shell.ts";

const roots: string[] = [];
const leftovers: number[] = [];

afterEach(() => {
  for (const pid of leftovers.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(limitSeconds: number) {
  const root = mkdtempSync(join(tmpdir(), "idd-lane-shell-"));
  roots.push(root);
  const log = join(root, TOOL_TIMEOUT_LOG);
  const shell = writeLaneShell(join(root, "agent"), limitSeconds, log);
  // stand-ins that look like adb's server and an emulator (they only sleep)
  const fake = (name: string, argv0: string) => {
    const p = join(root, name);
    writeFileSync(p, `#!/usr/bin/env bash\nexec -a "${argv0}" sleep 60\n`);
    chmodSync(p, 0o755);
    return p;
  };
  return { root, log, shell, fakeAdb: fake("fake-adb", "adb -L tcp:5999 fork-server server"), fakeEmulator: fake("fake-emulator", "/sdk/emulator/emulator -avd Pixel_test") };
}

/** run the shell as pi runs a bash tool call: `<shell> -c <command>`, in a process group of its own */
function call(shell: string, command: string, opts: { detached?: boolean } = {}): Promise<{ code: number | null; out: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn(shell, ["-c", command], { detached: opts.detached ?? true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("exit", (code) => resolveRun({ code, out, ms: Date.now() - started }));
  });
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidsIn = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);

/** run the shared shell as pi runs a call, with the reply's environment merged over the test's */
function callEnv(shell: string, command: string, extra: Record<string, string>): Promise<{ code: number | null; out: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn(shell, ["-c", command], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...extra } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("exit", (code) => resolveRun({ code, out, ms: Date.now() - started }));
  });
}

describe("the shell a pi lane's bash tool calls run in", () => {
  test("a call that is still running at the limit is cut, and the cut is written to the lane's log and told to the agent", async () => {
    const fx = setup(1);
    const r = await call(fx.shell, "echo started; sleep 30");
    expect(r.code).toBe(124);
    expect(r.ms).toBeLessThan(10_000);
    expect(r.out).toContain("started");
    expect(r.out).toContain("打ち切りました");
    expect(r.out).toContain("timeout -k 10");
    expect(r.out).not.toContain("--foreground");
    const lines = readFileSync(fx.log, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const [at, seconds, command] = lines[0].split("\t");
    expect(Number.isNaN(Date.parse(at))).toBe(false);
    expect(seconds).toBe("1");
    expect(command).toBe("echo started; sleep 30");
  }, 20_000);

  test("every process of the call's group goes with it, children in the background included", async () => {
    const fx = setup(1);
    const pids = join(fx.root, "pids");
    const r = await call(fx.shell, `sleep 60 & echo $! >> ${pids}; bash -c 'sleep 60' & echo $! >> ${pids}; sleep 60`);
    expect(r.code).toBe(124);
    const started = pidsIn(pids);
    expect(started.length).toBe(2);
    for (const pid of started) leftovers.push(pid);
    await new Promise((res) => setTimeout(res, 300));
    expect(started.filter(alive)).toEqual([]);
  }, 20_000);

  test("a command that makes a group of its own (timeout without --foreground) is still cut, with what it runs", async () => {
    const fx = setup(1);
    const pids = join(fx.root, "pids");
    const r = await call(fx.shell, `timeout 60 bash -c 'echo $$ >> ${pids}; sleep 30'`);
    expect(r.code).toBe(124);
    expect(r.ms).toBeLessThan(8_000);
    const started = pidsIn(pids);
    for (const pid of started) leftovers.push(pid);
    await new Promise((res) => setTimeout(res, 300));
    expect(started.filter(alive)).toEqual([]);
  }, 20_000);

  test("so is a command run under setsid in the foreground", async () => {
    const fx = setup(1);
    const pids = join(fx.root, "pids");
    const r = await call(fx.shell, `setsid bash -c 'echo $$ >> ${pids}; sleep 30'`);
    expect(r.code).toBe(124);
    const started = pidsIn(pids);
    for (const pid of started) leftovers.push(pid);
    await new Promise((res) => setTimeout(res, 300));
    expect(started.filter(alive)).toEqual([]);
  }, 20_000);

  test("a call is reported cut only when it was stopped: it never runs past the limit to its end and then reads as cut", async () => {
    const fx = setup(2);
    // `&&`, not `;`: the marker means the command ran past the limit to its own end, not that a shell leaked one
    // last builtin between the stopped child and its own killed process
    const r = await call(fx.shell, "timeout 6 bash -c 'sleep 4 && echo done'");
    expect(r.code).toBe(124);
    expect(r.out).not.toContain("done");
    expect(r.ms).toBeLessThan(3_900);
    expect(readFileSync(fx.log, "utf8").trim().split("\n").length).toBe(1);
  }, 20_000);

  test("a process that detached from the call (a daemon, as adb's server: its own session, its parent gone) is not stopped by the cut", async () => {
    const fx = setup(1);
    const pids = join(fx.root, "pids");
    const r = await call(fx.shell, `(setsid sleep 60 </dev/null >/dev/null 2>&1 & echo $! >> ${pids}); sleep 60`);
    expect(r.code).toBe(124);
    const [daemon] = pidsIn(pids);
    leftovers.push(daemon);
    expect(alive(daemon)).toBe(true);
  }, 20_000);

  test("a shared daemon still under the call (adb's server under a waiting client) is stopped with it: only the lane's end keeps shared daemons", async () => {
    const fx = setup(1);
    const pids = join(fx.root, "pids");
    const r = await call(fx.shell, `setsid ${fx.fakeAdb} </dev/null >/dev/null 2>&1 & echo $! >> ${pids}; sleep 60`);
    expect(r.code).toBe(124);
    const [daemon] = pidsIn(pids);
    leftovers.push(daemon);
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(daemon)).toBe(false);
  }, 20_000);

  test("so is an emulator it left running in the background in its group", async () => {
    const fx = setup(1);
    const pids = join(fx.root, "pids");
    const r = await call(fx.shell, `${fx.fakeEmulator} </dev/null >/dev/null 2>&1 & echo $! >> ${pids}; sleep 60`);
    expect(r.code).toBe(124);
    const [emulator] = pidsIn(pids);
    leftovers.push(emulator);
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(emulator)).toBe(false);
  }, 20_000);

  test("a call that ends within the limit keeps its own exit code and output, and nothing is logged", async () => {
    const fx = setup(5);
    const r = await call(fx.shell, "echo hi; exit 3");
    expect(r.code).toBe(3);
    expect(r.out.trim()).toBe("hi");
    expect(existsSync(fx.log)).toBe(false);
  }, 20_000);

  test("a call that backgrounds a process and returns is not held until the limit", async () => {
    const fx = setup(20);
    const pids = join(fx.root, "pids");
    const r = await call(fx.shell, `sleep 30 </dev/null >/dev/null 2>&1 & echo $! >> ${pids}; echo back`);
    for (const pid of pidsIn(pids)) leftovers.push(pid);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(5_000);
    expect(existsSync(fx.log)).toBe(false);
  }, 20_000);

  test("started outside a group of its own, it runs the call without the limit instead of stopping its caller's group", async () => {
    const fx = setup(1);
    const r = await call(fx.shell, "sleep 2; echo finished", { detached: false });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("finished");
    expect(existsSync(fx.log)).toBe(false);
  }, 20_000);
});

/**
 * The shell a pipeline role's shared agent dir points at. It reads the limit and the log from the reply's
 * environment, so one file serves the Issue lanes of several repos at once, and the engine's chat, which carries
 * no limit, runs the call as pi's own shell would.
 */
describe("the shared shell a pipeline role's dir points at", () => {
  test("cuts at the limit the reply's environment names, and writes the cut to the log in it", async () => {
    const root = mkdtempSync(join(tmpdir(), "idd-lane-shell-env-"));
    roots.push(root);
    const log = join(root, TOOL_TIMEOUT_LOG);
    const shell = writeLaneShellEnv(join(root, "agent"));
    const r = await callEnv(shell, "echo started; sleep 30", { [TOOL_TIMEOUT_SECONDS_ENV]: "1", [TOOL_TIMEOUT_LOG_ENV]: log });
    expect(r.code).toBe(124);
    expect(r.ms).toBeLessThan(10_000);
    expect(r.out).toContain("started");
    expect(r.out).toContain("打ち切りました");
    expect(readFileSync(log, "utf8")).toContain("sleep 30");
  }, 20_000);

  test("with no limit in the environment (the engine's chat) it runs the call as pi's own shell would", async () => {
    const root = mkdtempSync(join(tmpdir(), "idd-lane-shell-env-off-"));
    roots.push(root);
    const log = join(root, TOOL_TIMEOUT_LOG);
    const shell = writeLaneShellEnv(join(root, "agent"));
    const r = await callEnv(shell, "sleep 2; echo finished", { [TOOL_TIMEOUT_LOG_ENV]: log });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("finished");
    expect(existsSync(log)).toBe(false);
  }, 20_000);

  test("marks each call it starts, so a reply that used bash can be told whether it reached the shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "idd-lane-shell-env-pass-"));
    roots.push(root);
    const pass = join(root, "passes");
    const shell = writeLaneShellEnv(join(root, "agent"));
    const r = await callEnv(shell, "echo hi", { [LANE_SHELL_PASS_ENV]: pass });
    expect(r.code).toBe(0);
    expect(existsSync(pass)).toBe(true);
    expect(readFileSync(pass, "utf8").length).toBeGreaterThan(0);
  }, 20_000);
});
