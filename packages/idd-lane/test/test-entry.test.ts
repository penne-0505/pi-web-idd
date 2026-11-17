import { describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { KEEP_TEST_SCRATCH_MARKER, failureSummary, isTestGroup, parseFailures, parseProgress, runTestEntry, testRunnerCommand, testScratchPlace } from "../src/test-entry.ts";
import { shimEnv } from "../src/shim.ts";
import { NODE_SPEC_FOUR_FAILED } from "./helpers/node-spec-output.ts";
import { tmpDir } from "./helpers/tmp.ts";

/**
 * The entry is checked against a shim environment built here: a fake real gh (and git) in a temp bin, then
 * `shimEnv` over it. What the entry starts must reach the real git, keep the gh refusal, and leave the parent's
 * shim in place.
 */

function fakeBin(withGit: boolean): string {
  const bin = tmpDir("idd-entry-bin-");
  const gh = join(bin, "gh");
  writeFileSync(gh, "#!/usr/bin/env bash\n[ -n \"${FAKE_GH_CALLED:-}\" ] && touch \"$FAKE_GH_CALLED\"\necho \"REAL gh $*\"\n");
  chmodSync(gh, 0o755);
  if (withGit) {
    const git = join(bin, "git");
    writeFileSync(git, "#!/usr/bin/env bash\n[ -n \"${FAKE_GIT_CALLED:-}\" ] && touch \"$FAKE_GIT_CALLED\"\necho \"REAL git $*\"\n");
    chmodSync(git, 0o755);
  }
  return bin;
}

/** the shim env over a fake bin, with IDD_STATE_DIR pointed at a state dir of its own so the shim lands there */
function shimEnvOver(bin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const state = tmpDir("idd-entry-shimstate-");
  const saved = process.env.IDD_STATE_DIR;
  process.env.IDD_STATE_DIR = state;
  try {
    return shimEnv({ ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ...extra });
  } finally {
    if (saved === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved;
  }
}

function probeFile(name: string, body: string): string {
  const file = join(tmpDir("idd-entry-probe-"), name);
  writeFileSync(file, body);
  return file;
}

function capture(): { stdout: string[]; stderr: string[]; all: () => string; io: { stdout: (t: string) => void; stderr: (t: string) => void } } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, all: () => `${stdout.join("")}${stderr.join("")}`, io: { stdout: (t) => void stdout.push(t), stderr: (t) => void stderr.push(t) } };
}

const ENV_PROBE = `
import { test } from "bun:test";
import { writeFileSync } from "node:fs";
const TOOL_KEYS = ["BASH_MAX_TIMEOUT_MS", "BASH_DEFAULT_TIMEOUT_MS", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"];
const QUIET_KEYS = ["CLAUDECODE", "AGENT"];
test("probe", () => {
  // the one IDD_ variable the entry hands down points the user's instructions into the run's own place
  const idd = Object.keys(process.env).filter((k) => k.startsWith("IDD_") && k !== "IDD_INSTRUCTIONS_DIR");
  const tools = TOOL_KEYS.filter((k) => process.env[k] !== undefined);
  const quiet = QUIET_KEYS.filter((k) => process.env[k] !== undefined);
  writeFileSync(process.env.ENTRY_PROBE_OUT, JSON.stringify({ idd, tools, quiet, instructions: process.env.IDD_INSTRUCTIONS_DIR, scratch: process.env.TEST_SCRATCH_DIR }));
});
`;

/** the entry started as its own command and stopped by timeout(1): the real signal path, not a function call */
function entryStoppedByTimeout(group: "lane" | "core", seconds: number, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ output: string }> {
  const file = group === "lane"
    ? probeFile("hang.test.ts", `
import { test, expect } from "bun:test";
test("the one before the hang passes", () => { expect(1).toBe(1); });
test("the hang", async () => { await new Promise(() => {}); });
`)
    : probeFile("hang.test.mjs", `
import { test } from "node:test";
import assert from "node:assert/strict";
test("the one before the hang passes", () => { assert.equal(1, 1); });
test("the hang", async () => { await new Promise(() => {}); });
`);
  const entry = join(import.meta.dir, "..", "src", "test-entry.ts");
  return new Promise((resolve) => {
    const child = spawn("timeout", ["--kill-after=30", String(seconds), "node", "--experimental-strip-types", entry, group, file], {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("close", () => resolve({ output }));
  });
}

describe("test-entry: the environment it starts a runner in", () => {
  test("the child's git reaches the real binary, and no IDD_ variable is left (AC-005 / AC-006 / INV-2083)", async () => {
    const bin = fakeBin(true);
    const env = shimEnvOver(bin);
    const probeOut = join(tmpDir("idd-entry-out-"), "probe.json");
    const gitCalled = join(tmpDir("idd-entry-mark-"), "git-called");
    const file = probeFile("probe.test.ts", ENV_PROBE);
    const io = capture();
    const code = await runTestEntry({ group: "lane", files: [file], env: { ...env, ENTRY_PROBE_OUT: probeOut }, io: io.io });
    expect(code).toBe(0);
    const probe = JSON.parse(readFileSync(probeOut, "utf8")) as { idd: string[]; instructions: string; scratch: string };
    expect(probe.idd).toEqual([]);
    // a test that builds a brief reads none of the user's real instructions: they are looked for in the run's own place
    expect(probe.instructions.startsWith(`${probe.scratch}/`)).toBe(true);

    // the fake real git is reached only because the shim is off the child's PATH
    const realGit = probeFile("gitprobe.test.ts", `
import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
test("git push", () => {
  const out = execFileSync("git", ["push", "origin", "main"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  writeFileSync(process.env.ENTRY_PROBE_OUT, out);
});
`);
    const out2 = join(tmpDir("idd-entry-out-"), "git.json");
    const code2 = await runTestEntry({ group: "lane", files: [realGit], env: { ...env, ENTRY_PROBE_OUT: out2, FAKE_GIT_CALLED: gitCalled }, io: capture().io });
    expect(code2).toBe(0);
    expect(readFileSync(out2, "utf8")).toContain("REAL git push origin main");
    expect(existsSync(gitCalled)).toBe(true);
  });

  test("the parent's shim is still in place after the entry, and only the runner's command is ever started (AC-005 / INV-2083)", async () => {
    const bin = fakeBin(false);
    const env = shimEnvOver(bin);
    await runTestEntry({ group: "lane", files: [probeFile("p.test.ts", ENV_PROBE)], env: { ...env, ENTRY_PROBE_OUT: join(tmpDir("idd-entry-out-"), "p.json") }, io: capture().io });
    // the same shim env, used by the parent after the entry, still refuses the push
    let refused = 0;
    try { execFileSync("bash", ["-c", "git push origin main"], { env, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { refused = (e as { status: number }).status; }
    expect(refused).toBe(86);
    // an option-looking argument is refused, and a shell string is only ever a file name for the runner
    expect(await runTestEntry({ group: "lane", files: ["-e", "process.exit(7)"], env, io: capture().io })).toBe(2);
    const marker = join(tmpDir("idd-entry-mark-"), "ran");
    const code = await runTestEntry({ group: "lane", files: [`sh -c 'touch ${marker}'`], env, io: capture().io });
    expect(existsSync(marker)).toBe(false);
    expect(code).not.toBe(0);
  });

  test("the lane's tool-limit and agent-quiet variables are dropped with the IDD_ ones", async () => {
    const bin = fakeBin(false);
    const env = shimEnvOver(bin);
    const probeOut = join(tmpDir("idd-entry-out-"), "tools.json");
    const file = probeFile("probe.test.ts", ENV_PROBE);
    const toolEnv = { BASH_MAX_TIMEOUT_MS: "900000", BASH_DEFAULT_TIMEOUT_MS: "900000", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDECODE: "1", AGENT: "1" };
    const code = await runTestEntry({ group: "lane", files: [file], env: { ...env, ...toolEnv, ENTRY_PROBE_OUT: probeOut }, io: capture().io });
    expect(code).toBe(0);
    const probe = JSON.parse(readFileSync(probeOut, "utf8")) as { idd: string[]; tools: string[]; quiet: string[] };
    expect(probe.idd).toEqual([]);
    // a test that read the lane's tool limit would fail here and pass in a clean checkout, so the entry drops it
    expect(probe.tools).toEqual([]);
    // with the agents' quieting variables gone, `bun test` writes the line of every test that passed
    expect(probe.quiet).toEqual([]);
  });

  test("a state dir handed in is not read or written by the child (AC-006 / INV-2082)", async () => {
    const bin = fakeBin(false);
    const env = shimEnvOver(bin);
    const probeState = tmpDir("idd-entry-probestate-");
    const probeOut = join(tmpDir("idd-entry-out-"), "state.json");
    const file = probeFile("probe.test.ts", ENV_PROBE);
    const code = await runTestEntry({ group: "lane", files: [file], env: { ...env, IDD_STATE_DIR: probeState, IDD_REPOS_FILE: join(probeState, "repos.yaml"), IDD_ROLES_FILE: join(probeState, "roles.yaml"), ENTRY_PROBE_OUT: probeOut }, io: capture().io });
    expect(code).toBe(0);
    expect((JSON.parse(readFileSync(probeOut, "utf8")) as { idd: string[] }).idd).toEqual([]);
    expect(readdirSync(probeState)).toEqual([]);
  });
});

describe("test-entry: the summary names the group and the failed tests", () => {
  test("one failing test, on bun and on node (AC-011 / INV-2085)", async () => {
    const bun = probeFile("one.test.ts", `
import { test, expect } from "bun:test";
test("this one fails", () => { expect(1).toBe(2); });
`);
    const bunIo = capture();
    const bunCode = await runTestEntry({ group: "lane", files: [bun], io: bunIo.io });
    expect(bunCode).not.toBe(0);
    expect(bunIo.all().slice(-1400)).toContain("組 test:lane が落ちました");
    expect(bunIo.all().slice(-1400)).toContain("this one fails");

    const node = probeFile("one.test.mjs", `
import { test } from "node:test";
import assert from "node:assert/strict";
test("node one fails", () => { assert.equal(1, 2); });
`);
    const nodeIo = capture();
    const nodeCode = await runTestEntry({ group: "core", files: [node], io: nodeIo.io });
    expect(nodeCode).not.toBe(0);
    expect(nodeIo.all().slice(-1400)).toContain("組 test:core が落ちました");
    expect(nodeIo.all().slice(-1400)).toContain("node one fails");
  });

  test("many long failures keep the count and the first names inside the frame (AC-011 / INV-2085)", async () => {
    const many = probeFile("many.test.ts", `
import { test, expect } from "bun:test";
for (let i = 0; i < 60; i += 1) {
  test("long failing case " + i, () => {
    console.log("x".repeat(400));
    expect(i).toBe(-1);
  });
}
`);
    const io = capture();
    const code = await runTestEntry({ group: "lane", files: [many], io: io.io });
    expect(code).not.toBe(0);
    const tail = io.all().slice(-1400);
    expect(tail).toContain("組 test:lane が落ちました");
    expect(tail).toContain("落ちたテスト 60 件");
    expect(tail).toContain("long failing case 0");
    expect(tail).toMatch(/（ほか \d+ 件）/);
  });

  test("a passing group exits 0 and writes no summary (AC-011)", async () => {
    const ok = probeFile("ok.test.ts", `
import { test, expect } from "bun:test";
test("fine", () => { expect(1).toBe(1); });
`);
    const io = capture();
    expect(await runTestEntry({ group: "lane", files: [ok], io: io.io })).toBe(0);
    expect(io.all()).not.toContain("[test-entry]");
  });
});

describe("test-entry: the entry is not a way out of the lane", () => {
  test("a local push works, https is refused, and gh is refused before the real one is called (AC-017 / INV-2087)", async () => {
    const bin = fakeBin(false);
    const env = shimEnvOver(bin);
    const probeOut = join(tmpDir("idd-entry-out-"), "outbound.json");
    const ghCalled = join(tmpDir("idd-entry-mark-"), "gh-called");
    const file = probeFile("outbound.test.ts", `
import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("outbound", () => {
  const out = { local: "", https: "", gh: -1 };
  const root = mkdtempSync(join(tmpdir(), "entry-out-"));
  const bare = join(root, "r.git");
  execFileSync("git", ["init", "--bare", "-q", bare]);
  const wt = join(root, "w");
  mkdirSync(wt);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: wt });
  writeFileSync(join(wt, "a"), "1");
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "x"], { cwd: wt });
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: wt });
  try { execFileSync("git", ["push", "origin", "main"], { cwd: wt, stdio: ["ignore", "pipe", "pipe"] }); out.local = "ok"; } catch (e) { out.local = "ERR " + String((e as { stderr?: Buffer }).stderr); }
  execFileSync("git", ["remote", "set-url", "origin", "https://example.invalid/o/r.git"], { cwd: wt });
  try { execFileSync("git", ["push", "origin", "main"], { cwd: wt, stdio: ["ignore", "pipe", "pipe"] }); out.https = "pushed"; } catch (e) { out.https = String((e as { stderr?: Buffer }).stderr); }
  try { execFileSync("gh", ["pr", "create"], { stdio: ["ignore", "pipe", "pipe"] }); out.gh = 0; } catch (e) { out.gh = (e as { status: number }).status; }
  writeFileSync(process.env.ENTRY_PROBE_OUT, JSON.stringify(out));
});
`);
    const code = await runTestEntry({ group: "lane", files: [file], env: { ...env, ENTRY_PROBE_OUT: probeOut, FAKE_GH_CALLED: ghCalled }, io: capture().io });
    expect(code).toBe(0);
    const out = JSON.parse(readFileSync(probeOut, "utf8")) as { local: string; https: string; gh: number };
    expect(out.local).toBe("ok");
    expect(out.https).toContain("not allowed");
    expect(out.gh).toBe(86);
    expect(existsSync(ghCalled)).toBe(false);
  });
});

describe("test-entry: the run's place under _meta/scratch", () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const SCRATCH_HELPER = join(REPO_ROOT, "packages", "idd-core", "test", "helpers", "scratch.mjs");
  const ENTRY_SCRIPT = join(REPO_ROOT, "packages", "idd-lane", "src", "test-entry.ts");

  const placeEntries = (root: string): string[] => {
    try { return readdirSync(testScratchPlace(root)); } catch { return []; }
  };

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** a dir the runner makes through the helper, with a marker written beside it so the place is known to exist */
  function passBody(group: "node" | "bun"): string {
    const imports = group === "bun"
      ? `import { test } from "bun:test";`
      : `import { test } from "node:test";\nimport assert from "node:assert/strict";`;
    const check = group === "bun" ? `expect(existsSync(join(dir, "marker"))).toBe(true);` : `assert.ok(existsSync(join(dir, "marker")));`;
    const bunImport = group === "bun" ? `import { expect } from "bun:test";` : "";
    return `${imports}\n${bunImport}\nimport { existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nimport { scratchDir } from ${JSON.stringify(SCRATCH_HELPER)};\ntest("sample", () => {\n  const dir = scratchDir("sample-");\n  writeFileSync(join(dir, "marker"), "made");\n  ${check}\n  if (process.env.KEEP_PROBE_OUT) writeFileSync(process.env.KEEP_PROBE_OUT, process.env.KEEP_TEST_SCRATCH || "");\n});\n`;
  }

  function failBody(group: "node" | "bun"): string {
    const imports = group === "bun"
      ? `import { test, expect } from "bun:test";`
      : `import { test } from "node:test";\nimport assert from "node:assert/strict";`;
    const fail = group === "bun" ? `expect(1).toBe(2);` : `assert.equal(1, 2);`;
    return `${imports}\nimport { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nimport { scratchDir } from ${JSON.stringify(SCRATCH_HELPER)};\ntest("sample fails", () => {\n  const dir = scratchDir("sample-");\n  writeFileSync(join(dir, "marker"), "made");\n  ${fail}\n});\n`;
  }

  function endlessBody(): string {
    return `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nimport { scratchDir } from ${JSON.stringify(SCRATCH_HELPER)};\ntest("endless", async () => {\n  const dir = scratchDir("endless-");\n  writeFileSync(join(dir, "alive"), "x");\n  await new Promise(() => {});\n});\n`;
  }

  /** a test that leaves a detached writer behind: it writes into its work dir after the runner is gone */
  function lateWriterBody(): string {
    return `import { test } from "bun:test";\nimport { spawn } from "node:child_process";\nimport { scratchDir } from ${JSON.stringify(SCRATCH_HELPER)};\ntest("leaves a writer behind", () => {\n  const dir = scratchDir("late-");\n  const code = 'setTimeout(() => { const fs = require("node:fs"), p = require("node:path"); fs.mkdirSync(process.env.LATE_DIR, { recursive: true }); fs.writeFileSync(p.join(process.env.LATE_DIR, "late-marker"), "late"); }, 1500);';\n  spawn(process.execPath, ["-e", code], { env: { ...process.env, LATE_DIR: dir }, detached: true, stdio: "ignore" }).unref();\n});\n`;
  }

  function sampleFile(name: string, body: string): string {
    const file = join(tmpDir("idd-entry-sample-"), name);
    writeFileSync(file, body);
    return file;
  }

  /** the real node, so the entry's core group is exercised even though the lane group hosts this file under bun */
  const NODE_BIN = (() => {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      if (!dir) continue;
      const p = join(dir, "node");
      try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
    }
    return "node";
  })();

  /** run the entry as a node command, its cwd and run place both the given root (the core group needs no preload) */
  async function runEntryNode(file: string, root: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
    const child = spawn(NODE_BIN, ["--experimental-strip-types", ENTRY_SCRIPT, "core", file], {
      cwd: REPO_ROOT,
      env: { ...process.env, IDD_LANE_ROOT: root, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (out += c.toString()));
    const code = await exitCode(child);
    return { code, out };
  }

  /** a pid that has certainly ended: the child is waited for, so a later kill(pid, 0) reports ESRCH */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    return child.pid ?? 999999;
  }

  function pgrepFound(marker: string): boolean {
    try {
      return readdirSync("/proc").some((name) => {
        if (!/^\d+$/.test(name)) return false;
        try { return readFileSync(`/proc/${name}/cmdline`, "utf8").includes(marker); } catch { return false; }
      });
    } catch {
      return false;
    }
  }

  async function waitGone(root: string, name: string): Promise<void> {
    for (let i = 0; i < 200 && existsSync(join(testScratchPlace(root), name)); i += 1) await delay(25);
  }

  async function waitNoProcess(marker: string): Promise<void> {
    for (let i = 0; i < 200 && pgrepFound(marker); i += 1) await delay(25);
  }

  function exitCode(child: ChildProcess): Promise<number | null> {
    return new Promise((r) => child.on("exit", (code) => r(code)));
  }

  async function newPlaceSince(root: string, before: Set<string>): Promise<string | null> {
    for (let i = 0; i < 400; i += 1) {
      const fresh = placeEntries(root).find((n) => !before.has(n));
      if (fresh) return fresh;
      await delay(25);
    }
    return null;
  }

  test("a passing run leaves no place, on node and on bun (AC-001 / INV-2641)", async () => {
    const nodeRoot = tmpDir("idd-entry-node-");
    const nodeRun = await runEntryNode(sampleFile("pass.test.mjs", passBody("node")), nodeRoot);
    expect(nodeRun.code).toBe(0);
    expect(placeEntries(nodeRoot)).toEqual([]);

    const bunRoot = tmpDir("idd-entry-bun-");
    const bunRun = await runTestEntry({ group: "lane", files: [sampleFile("pass.test.ts", passBody("bun"))], scratchRoot: bunRoot, io: capture().io });
    expect(bunRun).toBe(0);
    expect(placeEntries(bunRoot)).toEqual([]);
  });

  test("a failing run leaves no place either (AC-002 / INV-2641)", async () => {
    const root = tmpDir("idd-entry-fail-");
    const io = capture();
    const code = await runTestEntry({ group: "lane", files: [sampleFile("fail.test.ts", failBody("bun"))], scratchRoot: root, io: io.io });
    expect(code).not.toBe(0);
    expect(placeEntries(root)).toEqual([]);
  });

  test("the keep variable keeps the place, reaches the runner, and names the path (AC-003 / DEC-9543)", async () => {
    const root = tmpDir("idd-entry-keepenv-");
    const probeOut = join(tmpDir("idd-entry-keepout-"), "keep.txt");
    const io = capture();
    const env = { ...process.env, KEEP_TEST_SCRATCH: "1", KEEP_PROBE_OUT: probeOut };
    const code = await runTestEntry({ group: "lane", files: [sampleFile("keep.test.ts", passBody("bun"))], scratchRoot: root, env, io: io.io });
    expect(code).toBe(0);
    const kept = placeEntries(root);
    expect(kept.length).toBe(1);
    expect(existsSync(join(testScratchPlace(root), kept[0], KEEP_TEST_SCRATCH_MARKER))).toBe(true);
    expect(io.all()).toContain(kept[0]);
    expect(readFileSync(probeOut, "utf8")).toBe("1");

    const plain = capture();
    const plainCode = await runTestEntry({ group: "lane", files: [sampleFile("plain.test.ts", passBody("bun"))], scratchRoot: root, io: plain.io });
    expect(plainCode).toBe(0);
    expect(plain.all()).not.toContain("作業場所を残しました");
  });

  test("a later run does not remove a kept place (AC-004 / DEC-9543)", async () => {
    const root = tmpDir("idd-entry-keeplater-");
    const keptRun = await runTestEntry({ group: "lane", files: [sampleFile("keep.test.ts", passBody("bun"))], scratchRoot: root, keepScratch: true, io: capture().io });
    expect(keptRun).toBe(0);
    const kept = placeEntries(root);
    expect(kept.length).toBe(1);
    const later = await runTestEntry({ group: "lane", files: [sampleFile("later.test.ts", passBody("bun"))], scratchRoot: root, io: capture().io });
    expect(later).toBe(0);
    expect(placeEntries(root)).toEqual(kept);
  });

  test("the sweep removes the place of a stopped run (AC-005 / DEC-9542)", async () => {
    const root = tmpDir("idd-entry-stopped-");
    const stale = join(testScratchPlace(root), `run-${deadPid()}-stale`);
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "marker"), "x");
    const code = await runTestEntry({ group: "lane", files: [sampleFile("pass.test.ts", passBody("bun"))], scratchRoot: root, io: capture().io });
    expect(code).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(placeEntries(root)).toEqual([]);
  });

  test("the sweep leaves a running run and an unreadable name alone (AC-006 / INV-2643)", async () => {
    const root = tmpDir("idd-entry-alive-");
    const place = testScratchPlace(root);
    const alive = join(place, `run-${process.pid}-alive`);
    const unnamed = join(place, "not-a-run");
    mkdirSync(alive, { recursive: true });
    mkdirSync(unnamed, { recursive: true });
    const code = await runTestEntry({ group: "lane", files: [sampleFile("pass.test.ts", passBody("bun"))], scratchRoot: root, io: capture().io });
    expect(code).toBe(0);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(unnamed)).toBe(true);
  });

  test("the sweep never touches anything outside the run place (AC-007 / INV-2642)", async () => {
    const root = tmpDir("idd-entry-outside-");
    const scratch = join(root, "_meta", "scratch");
    mkdirSync(join(scratch, "overlay-tests", "run-x"), { recursive: true });
    mkdirSync(join(scratch, "blind-replay"), { recursive: true });
    writeFileSync(join(scratch, "blind-replay", "a.md"), "kept");
    writeFileSync(join(scratch, "questions.json"), "{}");
    const code = await runTestEntry({ group: "lane", files: [sampleFile("pass.test.ts", passBody("bun"))], scratchRoot: root, io: capture().io });
    expect(code).toBe(0);
    expect(existsSync(join(scratch, "overlay-tests", "run-x"))).toBe(true);
    expect(existsSync(join(scratch, "blind-replay", "a.md"))).toBe(true);
    expect(existsSync(join(scratch, "questions.json"))).toBe(true);

    // the run place itself points outside: the sweep must not follow it
    const outside = tmpDir("idd-entry-target-");
    const target = join(outside, `run-${deadPid()}-outside`);
    mkdirSync(target, { recursive: true });
    const symRoot = tmpDir("idd-entry-symroot-");
    mkdirSync(join(symRoot, "_meta", "scratch"), { recursive: true });
    const link = testScratchPlace(symRoot);
    symlinkSync(outside, link, "dir");
    const linkCode = await runTestEntry({ group: "lane", files: [sampleFile("pass.test.ts", passBody("bun"))], scratchRoot: symRoot, io: capture().io });
    expect(linkCode).toBe(0);
    expect(existsSync(target)).toBe(true);
    unlinkSync(link);
  });

  test("a process the run left behind is stopped before the place is removed (AC-001 / INV-2641)", async () => {
    const root = tmpDir("idd-entry-latewriter-");
    const code = await runTestEntry({ group: "lane", files: [sampleFile("late.test.ts", lateWriterBody())], scratchRoot: root, io: capture().io });
    expect(code).toBe(0);
    expect(placeEntries(root)).toEqual([]);
    // past the writer's delay: a process the run left running would have put the place back after the removal
    await delay(2000);
    expect(placeEntries(root)).toEqual([]);
  });

  test("a directly run test keeps the place and a later run keeps it too (AC-015 / DEC-9543)", async () => {
    const root = tmpDir("idd-entry-direct-");
    const file = join(tmpDir("idd-entry-direct-sample-"), "direct.test.mjs");
    writeFileSync(file, passBody("node"));
    const args = ["--experimental-strip-types", "--test", file];
    const child = spawn(NODE_BIN, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, TEST_SCRATCH_DIR: "", IDD_LANE_ROOT: root, KEEP_TEST_SCRATCH: "1" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    expect(await exitCode(child)).toBe(0);
    const kept = placeEntries(root);
    expect(kept.length).toBe(1);
    expect(existsSync(join(testScratchPlace(root), kept[0], KEEP_TEST_SCRATCH_MARKER))).toBe(true);
    // an entry with no keep variable must leave that place alone (its owner is gone, but the marker keeps it)
    const code = await runTestEntry({ group: "lane", files: [sampleFile("later.test.ts", passBody("bun"))], scratchRoot: root, io: capture().io });
    expect(code).toBe(0);
    expect(placeEntries(root)).toEqual(kept);

    // a directly run test with no keep variable removes its own place (AC-011)
    const plainRoot = tmpDir("idd-entry-directplain-");
    const plain = spawn(NODE_BIN, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, TEST_SCRATCH_DIR: "", IDD_LANE_ROOT: plainRoot },
      stdio: ["ignore", "ignore", "ignore"],
    });
    expect(await exitCode(plain)).toBe(0);
    expect(placeEntries(plainRoot)).toEqual([]);
  });

  test("a signal stops the entry, removes its place, and leaves no runner (AC-014 / DEC-9541)", async () => {
    const place = testScratchPlace(REPO_ROOT);
    for (const [signal, expected] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
      const before = new Set(placeEntries(REPO_ROOT));
      const file = sampleFile("endless.test.ts", endlessBody());
      const args = process.versions.bun ? [ENTRY_SCRIPT, "lane", file] : ["--experimental-strip-types", ENTRY_SCRIPT, "lane", file];
      const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      const fresh = await newPlaceSince(REPO_ROOT, before);
      expect(fresh).not.toBe(null);
      child.kill(signal);
      expect(await exitCode(child)).toBe(expected);
      expect(fresh).not.toBe(null);
      await waitGone(REPO_ROOT, fresh as string);
      expect(existsSync(join(place, fresh as string))).toBe(false);
      await waitNoProcess(file);
      expect(pgrepFound(file)).toBe(false);
    }
  });

  test("an aborted runTestEntry removes its place and adds no signal listener (AC-014 / DEC-9541)", async () => {
    const root = tmpDir("idd-entry-abort-");
    const file = sampleFile("endless.test.ts", endlessBody());
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");
    const controller = new AbortController();
    const promise = runTestEntry({ group: "lane", files: [file], scratchRoot: root, signal: controller.signal, io: capture().io });
    const fresh = placeEntries(root)[0] ?? null;
    expect(fresh).not.toBe(null);
    controller.abort();
    expect(await promise).not.toBe(0);
    await waitGone(root, fresh as string);
    expect(existsSync(join(testScratchPlace(root), fresh as string))).toBe(false);
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
  });
});

describe("test-entry: helpers", () => {
  test("only the three known groups are groups", () => {
    expect(isTestGroup("test")).toBe(true);
    expect(isTestGroup("core")).toBe(true);
    expect(isTestGroup("lane")).toBe(true);
    expect(isTestGroup("all")).toBe(false);
    expect(isTestGroup("rm -rf /")).toBe(false);
  });

  test("the runner command is the group's own, with the given files as arguments", () => {
    const { cmd, args } = testRunnerCommand("core", ["a.test.mjs"]);
    expect(args).toEqual(["--experimental-strip-types", "--test", "a.test.mjs"]);
    expect(cmd.length).toBeGreaterThan(0);
    const lane = testRunnerCommand("lane", []).args;
    // a path, not a filter: a bare target also matched the review copies under state/ in the main checkout
    expect(lane).toContain("./packages/idd-lane/test");
    expect(lane.filter((a) => a.includes("packages/") && !a.startsWith("./"))).toEqual([]);
    // a test that only hangs would otherwise be stopped at bun's 5 s default: the entry's own limit is wider
    expect(lane).toContain("--timeout=30000");
  });

  test("parseFailures reads both reporters, and the summary stays inside the frame", () => {
    expect(parseFailures("✖ a (1.2ms)\n✖ b (0.3ms)\nℹ fail 2\n").names).toEqual(["a", "b"]);
    expect(parseFailures("(fail) g > c [0.5ms]\n\n 3 fail\n").failed).toBe(3);
    const long = Array.from({ length: 200 }, (_, i) => `(fail) name ${i} [0.1ms]`).join("\n");
    const summary = failureSummary("lane", `${long}\n200 fail\n`);
    expect(summary.length).toBeLessThanOrEqual(1300);
    expect(summary).toContain("（ほか ");
  });

  test("parseFailures names each failed node leaf once, by its place, whatever suites and repeated names the output holds", () => {
    const { failed, names } = parseFailures(NODE_SPEC_FOUR_FAILED);
    expect(failed).toBe(4);
    expect(names).toEqual(["dup (x.test.mjs:2:29)", "leaf (x.test.mjs:2:102)", "dup (x.test.mjs:3:27)", "top (x.test.mjs:4:1)"]);
  });

  test("parseProgress reads the file and the last finished test of both reporters", () => {
    const bun = "packages/a/test/x.test.ts:\n(pass) first [0.1ms]\n(fail) second [0.2ms]\n(pass) third [0.3ms]\n";
    expect(parseProgress(bun)).toEqual({ file: "packages/a/test/x.test.ts", lastTest: "third", finished: 3 });
    const node = "✔ first (1.2ms)\n  ✔ nested second (0.2ms)\n✖ third (2.1ms)\nℹ fail 1\n";
    expect(parseProgress(node)).toEqual({ lastTest: "third", finished: 3 });
    expect(parseProgress("(pass) x [0.1ms]").finished).toBe(1);
    // node names a cancelled file as a failing test of its own: that line is not a test
    const stopped = "✔ first (1.2ms)\n✖ _meta/x/hang.test.mjs (7832.0ms)\n✖ failing tests:\n\ntest at file:1:1\n✖ _meta/x/hang.test.mjs (7832.0ms)\n";
    expect(parseProgress(stopped)).toEqual({ lastTest: "first", finished: 1 });
  });
});

describe("test-entry: a stopped run says where it got to", () => {
  test("timeout(1) stops the lane and the core groups, and the tail names the last finished test", async () => {
    const lane = await entryStoppedByTimeout("lane", 10);
    const laneTail = lane.output.slice(-1400);
    expect(lane.output).toContain("the one before the hang passes");
    expect(laneTail).toContain("[test-entry] 組 test:lane が時間で止められました");
    expect(laneTail).toContain("経過 ");
    expect(laneTail).toContain("終わったテスト ");
    expect(laneTail).toContain("最後に終わったテスト: the one before the hang passes");
    expect(laneTail).toContain("途中のファイル: ");
    expect(laneTail).toContain("hang.test.ts");
    // a stopped run is not a failed one: the two summaries never both appear
    expect(lane.output).not.toContain("が落ちました");
    expect(lane.output.length).toBeGreaterThan(0);
  }, 30_000);

  test("the core group's stopped run names the last finished test and its count", async () => {
    const core = await entryStoppedByTimeout("core", 10);
    const tail = core.output.slice(-1400);
    expect(tail).toContain("[test-entry] 組 test:core が時間で止められました");
    expect(tail).toContain("最後に終わったテスト: the one before the hang passes");
    expect(tail).toMatch(/終わったテスト \d+ 件/);
    expect(core.output).not.toContain("が落ちました");
  }, 30_000);

  test("the quieting variables of the agent's shell do not hide the passing lines from a stopped run", async () => {
    const run = await entryStoppedByTimeout("lane", 10, { CLAUDECODE: "1", AGENT: "1" });
    expect(run.output).toContain("the one before the hang passes");
    expect(run.output.slice(-1400)).toContain("最後に終わったテスト: the one before the hang passes");
  }, 30_000);
});

describe("test-entry: two groups at once do not share the run's state", () => {
  test("both finish, and each output holds only its own test (AC-010 / INV-2521)", async () => {
    const a = probeFile("only-a.test.ts", `
import { test, expect } from "bun:test";
test("the A group's own test", () => { expect(1).toBe(1); });
`);
    const b = probeFile("only-b.test.ts", `
import { test, expect } from "bun:test";
test("the B group's own test", () => { expect(2).toBe(2); });
`);
    const ioA = capture();
    const ioB = capture();
    const [codeA, codeB] = await Promise.all([
      runTestEntry({ group: "lane", files: [a], io: ioA.io }),
      runTestEntry({ group: "lane", files: [b], io: ioB.io }),
    ]);
    expect([codeA, codeB]).toEqual([0, 0]);
    expect(ioA.all()).toContain("the A group's own test");
    expect(ioA.all()).not.toContain("the B group's own test");
    expect(ioB.all()).toContain("the B group's own test");
    expect(ioB.all()).not.toContain("the A group's own test");
  });
});
