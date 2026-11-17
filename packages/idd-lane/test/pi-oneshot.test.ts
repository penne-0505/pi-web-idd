import { afterEach, describe, expect, test } from "bun:test";

import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runPiOnce } from "../src/pi-oneshot.ts";
import { holdPipes, IGNORE_SIGTERM_AND_STAY } from "./helpers/oneshot-scripts.ts";
import { tmpDir } from "./helpers/tmp.ts";

const saved = process.env.IDD_PI_BIN;
afterEach(() => {
  if (saved === undefined) delete process.env.IDD_PI_BIN;
  else process.env.IDD_PI_BIN = saved;
});

/** a stand-in for pi that runs `body` as a node script */
function standIn(body: string): string {
  const file = join(tmpDir("oneshot-pi-"), "pi");
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  process.env.IDD_PI_BIN = file;
  return file;
}

const agentDir = () => tmpDir("oneshot-agent-");

/** runs a stand-in with `body` and reports how long the run took */
async function runStandIn(body: string, opts: { timeoutMs: number; graceMs?: number; drainMs?: number }) {
  standIn(body);
  const started = Date.now();
  const run = await runPiOnce([], { agentDir: agentDir(), ...opts });
  return { run, elapsedMs: Date.now() - started };
}

/** a stand-in that outlives its limit: the run must come back, read as timed out */
async function timedOutRun(body: string, opts: { timeoutMs: number; graceMs?: number; drainMs?: number }) {
  const ran = await runStandIn(body, opts);
  expect(ran.run.timedOut).toBe(true);
  return ran;
}

describe("one-shot run", () => {
  test("a child that answers and exits is read as it ended", async () => {
    const { run } = await runStandIn(`console.log("hello"); process.exit(0);`, { timeoutMs: 10_000 });
    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("hello");
  });

  test("a child that stays past the limit is stopped by SIGTERM and read as timed out", async () => {
    const { run } = await timedOutRun(`setInterval(() => {}, 1000);`, { timeoutMs: 300 });
    expect(run.signal).toBe("SIGTERM");
  });

  test("a child that ignores SIGTERM is raised to SIGKILL and the run settles as timed out", async () => {
    const { run, elapsedMs } = await timedOutRun(`console.log("partial"); ${IGNORE_SIGTERM_AND_STAY}`, { timeoutMs: 500, graceMs: 300 });
    expect(run.signal).toBe("SIGKILL");
    expect(run.stdout).toContain("partial");
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test("a run settles as timed out even when no close follows SIGKILL", async () => {
    // a grandchild keeps the pipes open after the child itself is killed, so close does not come until it exits
    const { elapsedMs } = await timedOutRun(`
${holdPipes(6_000)}
${IGNORE_SIGTERM_AND_STAY}`, { timeoutMs: 500, graceMs: 300 });
    expect(elapsedMs).toBeLessThan(4_000);
  });

  // the child ends on its own while a grandchild holds the pipes: the run is read as the child ended, not as timed out
  const endedByItself = [
    { what: "answers and exits", tail: `console.log("answer"); process.exit(0);`, opts: { timeoutMs: 10_000, drainMs: 200 }, code: 0, stream: "stdout", text: "answer" },
    { what: "exits with an error", tail: `console.error("boom"); process.exit(3);`, opts: { timeoutMs: 10_000, drainMs: 200 }, code: 3, stream: "stderr", text: "boom" },
    // the limit falls inside the pipe drain: a child that ended before the limit is not read as timed out
    { what: "exits before a limit that falls inside the drain", tail: `console.log("answer"); setTimeout(() => process.exit(0), 200);`, opts: { timeoutMs: 700, graceMs: 300, drainMs: 1_200 }, code: 0, stream: "stdout", text: "answer" },
  ] as const;
  for (const { what, tail, opts, code, stream, text } of endedByItself) {
    test(`a child that ${what} keeps its own ending while a grandchild holds its pipes open`, async () => {
      const { run, elapsedMs } = await runStandIn(`${holdPipes(6_000)}\n${tail}`, opts);
      expect(run.timedOut).toBe(false);
      expect(run.code).toBe(code);
      expect(run[stream]).toContain(text);
      expect(elapsedMs).toBeLessThan(3_000);
    });
  }

  test("a run the clock ended stays timed out even when it left its answer before the pipes closed", async () => {
    const { run } = await timedOutRun(`
${holdPipes(6_000)}
console.log("partial");
setInterval(() => {}, 1000);`, { timeoutMs: 400, graceMs: 300, drainMs: 200 });
    expect(run.stdout).toContain("partial");
  });

  // The race lives in node's event loop (bun reads the exit first), so the run is made under node itself: a harness that
  // stalls its loop past the limit while the child ends, then reports what the run read.
  const stalled = [
    { what: "alone", child: `console.log("answer"); process.exit(0);`, drainMs: 300 },
    { what: "with a grandchild holding its pipes", child: `${holdPipes(6_000)}\nconsole.log("answer"); process.exit(0);`, drainMs: 200 },
  ];
  for (const { what, child, drainMs } of stalled) {
    test(`a child that ended before the limit is not timed out when the event loop stalled past the limit (${what})`, async () => {
      const dir = tmpDir("oneshot-stall-");
      const pi = join(dir, "pi");
      writeFileSync(pi, `#!/usr/bin/env node\n${child}\n`);
      chmodSync(pi, 0o755);
      const harness = join(dir, "harness.mts");
      writeFileSync(harness, `
import { runPiOnce } from ${JSON.stringify(join(import.meta.dirname, "../src/pi-oneshot.ts"))};
const pending = runPiOnce([], { agentDir: ${JSON.stringify(dir)}, timeoutMs: 300, drainMs: ${drainMs} });
const until = Date.now() + 1500;
while (Date.now() < until) {}
const run = await pending;
console.log(JSON.stringify({ timedOut: run.timedOut, code: run.code, stdout: run.stdout }));
`);
      const out = await new Promise<string>((resolve, reject) => {
        const proc = spawn("node", ["--experimental-strip-types", harness], { env: { ...process.env, IDD_PI_BIN: pi }, stdio: ["ignore", "pipe", "inherit"] });
        let text = "";
        proc.stdout.on("data", (c) => { text += String(c); });
        proc.on("error", reject);
        proc.on("close", () => resolve(text));
      });
      const run = JSON.parse(out.trim().split("\n").pop() ?? "{}");
      expect(run.timedOut).toBe(false);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("answer");
    });
  }

  test("a child that cannot start rejects", async () => {
    process.env.IDD_PI_BIN = join(tmpDir("oneshot-none-"), "no-such-pi");
    await expect(runPiOnce([], { agentDir: agentDir(), timeoutMs: 1_000 })).rejects.toBeDefined();
  });
});
