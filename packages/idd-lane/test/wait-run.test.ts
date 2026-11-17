import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { WAIT_INTERRUPTED_EXIT, WAIT_RUNNING_EXIT, WAIT_TIMEOUT_EXIT, resolveWaitCheck, runWaitRun, waitLimitMs, waitRunPaths, waitRunRoot, waitSliceMs } from "../src/wait-run.ts";
import { isOverlayPath } from "../../idd-core/src/overlay/manifest.ts";
import { repoForPath } from "../src/repos.ts";
import { addRecordlessCopy, manifestRowsAt } from "../src/worktree.ts";
import { tmpDir } from "./helpers/tmp.ts";

const ENV_KEYS = ["IDD_STATE_DIR", "IDD_LANE_ID", "IDD_REPOS_FILE", "IDD_ROLES_FILE", "BASH_MAX_TIMEOUT_MS"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const strays: number[] = [];

afterEach(() => {
  for (const pid of strays.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const env = { ...process.env };
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** a scratch lane directory and a state dir of its own; the env is handed to runWaitRun explicitly */
function scratch() {
  const root = tmpDir("idd-wait-run-");
  const state = join(root, "state");
  const cwd = join(root, "work");
  mkdirSync(state, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const laneEnv = { ...env, IDD_STATE_DIR: state, IDD_LANE_ID: "L1" };
  return { root, state, cwd, laneEnv };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t), all: () => `${out.join("")}${err.join("")}` };
}

/** remember the run's process so the test can take it down even when it outlives its call */
async function withStray<T>(cwd: string, command: string, laneEnv: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const paths = waitRunPaths("L1", cwd, command, laneEnv);
  try {
    return await fn();
  } finally {
    try {
      const rec = JSON.parse(readFileSync(paths.record, "utf8")) as { pid: number };
      if (rec.pid) strays.push(rec.pid);
    } catch { /* no record: nothing to take down */ }
  }
}

describe("wait-run: the call returns while the command keeps running (AC-001 / DEC-2601)", () => {
  test("the first call returns at the slice with the output so far and a still-running notice, and the command goes on", async () => {
    const fx = scratch();
    const io = capture();
    const command = "echo one; sleep 0.3; echo two; sleep 5";
    const code = await withStray(fx.cwd, command, fx.laneEnv, () => runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, sliceMs: 700, ...io }));
    expect(code).toBe(WAIT_RUNNING_EXIT);
    expect(io.out.join("")).toContain("one");
    expect(io.all()).toContain("まだ走っています");
    const paths = waitRunPaths("L1", fx.cwd, command, fx.laneEnv);
    const rec = JSON.parse(readFileSync(paths.record, "utf8")) as { pid: number; exit?: number };
    expect(rec.exit).toBeUndefined();
    expect(() => process.kill(rec.pid, 0)).not.toThrow();
  });

  test("the default slice stays under the 5-minute hold, and under the tool limit when there is one", () => {
    expect(waitSliceMs({ ...env, BASH_MAX_TIMEOUT_MS: String(15 * 60_000) })).toBe(4 * 60_000);
    expect(waitSliceMs({ ...env, BASH_MAX_TIMEOUT_MS: "120000" })).toBeLessThan(120_000);
    expect(waitSliceMs({ ...env })).toBeGreaterThan(0);
    expect(waitSliceMs({}, undefined)).toBe(waitSliceMs({}));
    expect(waitRunRoot({ IDD_STATE_DIR: "/tmp/whatever" })).toBe("/tmp/whatever/wait-run");
  });
});

describe("wait-run: a repeated call attaches to the running command (AC-002 / DEC-2602)", () => {
  test("the same lane, directory and command start the command once, and the second call waits for the same run", async () => {
    const fx = scratch();
    const count = join(fx.root, "starts");
    const command = `echo start >> ${count}; echo a; sleep 0.5; echo b; sleep 5`;
    const first = await withStray(fx.cwd, command, fx.laneEnv, () => runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, sliceMs: 200, ...capture() }));
    expect(first).toBe(WAIT_RUNNING_EXIT);
    const io2 = capture();
    const second = await runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, sliceMs: 900, ...io2 });
    expect(second).toBe(WAIT_RUNNING_EXIT);
    // the first call returned "a", the second starts from where the first left off: it never shows "a" again
    expect(io2.all()).not.toContain("a\n");
    expect(io2.all()).toContain("b");
    expect(readFileSync(count, "utf8").trim().split("\n").length).toBe(1);
  });

  test("two calls in parallel start the command once", async () => {
    const fx = scratch();
    const count = join(fx.root, "starts");
    const command = `echo x >> ${count}; sleep 5`;
    const [a, b] = await Promise.all([
      withStray(fx.cwd, command, fx.laneEnv, () => runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, sliceMs: 250, ...capture() })),
      runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, sliceMs: 250, ...capture() }),
    ]);
    expect([a, b]).toEqual([WAIT_RUNNING_EXIT, WAIT_RUNNING_EXIT]);
    expect(readFileSync(count, "utf8").trim().split("\n").length).toBe(1);
  });

  test("a different command or directory is a different run", async () => {
    const fx = scratch();
    const other = join(fx.root, "other");
    mkdirSync(other);
    const command = "sleep 5";
    const a = await withStray(fx.cwd, command, fx.laneEnv, () => runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, sliceMs: 150, ...capture() }));
    const b = await withStray(other, command, fx.laneEnv, () => runWaitRun({ command, cwd: other, env: fx.laneEnv, sliceMs: 150, ...capture() }));
    expect(a).toBe(WAIT_RUNNING_EXIT);
    expect(b).toBe(WAIT_RUNNING_EXIT);
    const p1 = waitRunPaths("L1", fx.cwd, command, fx.laneEnv);
    const p2 = waitRunPaths("L1", other, command, fx.laneEnv);
    expect(p1.key).not.toBe(p2.key);
    const r1 = JSON.parse(readFileSync(p1.record, "utf8")) as { pid: number };
    const r2 = JSON.parse(readFileSync(p2.record, "utf8")) as { pid: number };
    expect(r1.pid).not.toBe(r2.pid);
  });
});

describe("wait-run: a finished command returns its output and exit code (AC-003 / DEC-2603)", () => {
  test("a command shorter than the slice returns on the first call with its own exit code", async () => {
    const fx = scratch();
    const io = capture();
    const code = await runWaitRun({ command: "echo hi; exit 3", cwd: fx.cwd, env: fx.laneEnv, ...io });
    expect(code).toBe(3);
    expect(io.all()).toContain("hi");
    expect(io.all()).toContain("終了コード 3");
  });

  test("a command that exits 0 ends the call with 0", async () => {
    const fx = scratch();
    expect(await runWaitRun({ command: "true", cwd: fx.cwd, env: fx.laneEnv, ...capture() })).toBe(0);
  });

  test("a command whose own exit code is the running call's code is still told apart by the notice", async () => {
    const fx = scratch();
    const io = capture();
    const code = await runWaitRun({ command: `exit ${WAIT_RUNNING_EXIT}`, cwd: fx.cwd, env: fx.laneEnv, ...io });
    expect(code).toBe(WAIT_RUNNING_EXIT);
    expect(io.all()).toContain("終了コード");
    expect(io.all()).not.toContain("まだ走っています");
  });
});

describe("wait-run: the dedicated exit code of a call that returns early (AC-004 / INV-1842)", () => {
  test("a still-running call never exits 0 or 124", async () => {
    const fx = scratch();
    const code = await withStray(fx.cwd, "sleep 5", fx.laneEnv, () => runWaitRun({ command: "sleep 5", cwd: fx.cwd, env: fx.laneEnv, sliceMs: 150, ...capture() }));
    expect(code).toBe(WAIT_RUNNING_EXIT);
    expect(code).not.toBe(0);
    expect(code).not.toBe(WAIT_TIMEOUT_EXIT);
  });
});

describe("wait-run: the total limit stops the command (AC-005 / DEC-2604 / INV-1843)", () => {
  test("over the limit the call exits 124, says it cut the command, and no process of the run is left", async () => {
    const fx = scratch();
    const childPidFile = join(fx.root, "child.pid");
    const command = `sleep 30 & echo $! > ${childPidFile}; wait`;
    const io = capture();
    const code = await runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, sliceMs: 4_000, timeoutMinutes: 0.02, killGraceMs: 300, pollMs: 50, ...io });
    expect(code).toBe(WAIT_TIMEOUT_EXIT);
    expect(io.all()).toContain("上限");
    const paths = waitRunPaths("L1", fx.cwd, command, fx.laneEnv);
    const rec = JSON.parse(readFileSync(paths.record, "utf8")) as { pid: number };
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(rec.pid, 0)).toThrow();
    if (existsSync(childPidFile)) {
      const child = Number(readFileSync(childPidFile, "utf8").trim());
      expect(() => process.kill(child, 0)).toThrow();
    }
  });

  test("without an explicit limit the lane's tool limit is used", () => {
    const e = { ...env, BASH_MAX_TIMEOUT_MS: String(12 * 60_000) };
    expect(waitLimitMs({}, e)).toBe(12 * 60_000);
    expect(waitLimitMs({ timeoutMinutes: 3 }, e)).toBe(180_000);
    expect(waitLimitMs({}, { ...env })).toBe(null);
  });
});

describe("wait-run: a consumed result is not reused (AC-006 / DEC-2602)", () => {
  test("after a finished result is handed over, the next call starts the command again", async () => {
    const fx = scratch();
    const count = join(fx.root, "starts");
    const command = `echo x >> ${count}`;
    expect(await runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, ...capture() })).toBe(0);
    expect(await runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, ...capture() })).toBe(0);
    expect(readFileSync(count, "utf8").trim().split("\n").length).toBe(2);
  });

  test("a result the command wrote while no call waited is taken by the next call, without starting again", async () => {
    const fx = scratch();
    const count = join(fx.root, "starts");
    const command = `echo x >> ${count}; sleep 0.4; echo done; exit 4`;
    const first = await withStray(fx.cwd, command, fx.laneEnv, () => runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, sliceMs: 100, ...capture() }));
    expect(first).toBe(WAIT_RUNNING_EXIT);
    await new Promise((r) => setTimeout(r, 700));
    const io = capture();
    const second = await runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, ...io });
    expect(second).toBe(4);
    expect(io.all()).toContain("done");
    expect(io.all()).toContain("終了コード 4");
    expect(readFileSync(count, "utf8").trim().split("\n").length).toBe(1);
  });
});

describe("wait-run: a run stopped from outside comes back as interrupted (AC-020 / DEC-2602)", () => {
  test("the next call says it was stopped and exits non-zero; the one after starts it again", async () => {
    const fx = scratch();
    const count = join(fx.root, "starts");
    const command = `echo x >> ${count}; echo started; sleep 30`;
    const first = await withStray(fx.cwd, command, fx.laneEnv, () => runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, sliceMs: 200, ...capture() }));
    expect(first).toBe(WAIT_RUNNING_EXIT);
    const paths = waitRunPaths("L1", fx.cwd, command, fx.laneEnv);
    const rec = JSON.parse(readFileSync(paths.record, "utf8")) as { pid: number };
    try { process.kill(-rec.pid, "SIGKILL"); } catch { process.kill(rec.pid, "SIGKILL"); }
    await new Promise((r) => setTimeout(r, 200));
    const io = capture();
    const second = await runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, sliceMs: 500, ...io });
    expect(second).toBe(WAIT_INTERRUPTED_EXIT);
    expect(second).not.toBe(0);
    expect(io.all()).toContain("止められました");
    const third = await withStray(fx.cwd, command, fx.laneEnv, () => runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, sliceMs: 200, ...capture() }));
    expect(third).toBe(WAIT_RUNNING_EXIT);
    expect(readFileSync(count, "utf8").trim().split("\n").length).toBe(2);
  });
});

describe("wait-run: output and records stay out of the worktree (AC-021 / DEC-2601)", () => {
  test("a wrapped command in a git repo leaves the tree clean and writes under the state dir", async () => {
    const fx = scratch();
    sh(fx.cwd, ["init", "--quiet", "-b", "main"]);
    writeFileSync(join(fx.cwd, "a.txt"), "1\n");
    sh(fx.cwd, ["add", "-A"]);
    sh(fx.cwd, ["commit", "--quiet", "-m", "base"]);
    const command = "echo out; sleep 0.1";
    const code = await runWaitRun({ command, cwd: fx.cwd, env: fx.laneEnv, ...capture() });
    expect(code).toBe(0);
    expect(sh(fx.cwd, ["status", "--short"]).trim()).toBe("");
    const paths = waitRunPaths("L1", fx.cwd, command, fx.laneEnv);
    expect(paths.out.startsWith(join(fx.state, "wait-run"))).toBe(true);
    expect(existsSync(paths.out)).toBe(true);
  });
});

describe("wait-run: a repo check by name runs with the changed-files list (AC-019 / DEC-2609 / INV-1845)", () => {
  function repoFixture(opts: { base?: string; remote?: string } = {}) {
    const base = opts.base ?? "main";
    const root = tmpDir("idd-wait-check-");
    const wt = join(root, "wt");
    mkdirSync(wt);
    sh(wt, ["init", "--quiet", "-b", "main"]);
    writeFileSync(join(wt, "a.txt"), "1\n");
    sh(wt, ["add", "-A"]);
    sh(wt, ["commit", "--quiet", "-m", "base"]);
    sh(wt, ["checkout", "--quiet", "-b", "feature"]);
    writeFileSync(join(wt, "b.txt"), "2\n");
    writeFileSync(join(wt, "a.txt"), "1\nchanged\n");
    sh(wt, ["add", "-A"]);
    sh(wt, ["commit", "--quiet", "-m", "feature"]);
    const out = join(root, "list");
    const repos = join(root, "repos.yaml");
    writeFileSync(repos, [
      "repos:",
      "  me/app:",
      `    upstream: ${wt}`,
      `    work: ${wt}`,
      `    remote: ${JSON.stringify(opts.remote ?? "")}`,
      `    public_base: ${base}`,
      "    checks:",
      `      - { name: seen, command: "tr '\\\\0' '\\\\n' < \\"$IDD_CHANGED_FILES\\" > ${out}", required: true, timeout_minutes: 7 }`,
      `      - { name: multiline, command: "printf '%s\\\\n' a b | grep -q a", required: false }`,
      "    lanes_root: " + join(root, "lanes"),
    ].join("\n") + "\n");
    const laneEnv = { ...env, IDD_STATE_DIR: join(root, "state"), IDD_LANE_ID: "L1", IDD_REPOS_FILE: repos };
    mkdirSync(join(root, "state"), { recursive: true });
    return { root, wt, out, laneEnv, repos };
  }

  test("resolveWaitCheck reads the repo's check and its limit", () => {
    const fx = repoFixture();
    process.env.IDD_REPOS_FILE = fx.repos;
    const seen = resolveWaitCheck("seen", fx.wt);
    expect("command" in seen && seen.command).toContain("IDD_CHANGED_FILES");
    expect("timeoutMinutes" in seen && seen.timeoutMinutes).toBe(7);
    expect(resolveWaitCheck("nope", fx.wt)).toHaveProperty("error");
  });

  test("running the check by name hands it the changed-files list and ends with its exit code", async () => {
    const fx = repoFixture();
    process.env.IDD_REPOS_FILE = fx.repos;
    const io = capture();
    const code = await runWaitRun({ check: "seen", cwd: fx.wt, env: fx.laneEnv, ...io });
    expect(code).toBe(0);
    const list = readFileSync(fx.out, "utf8").split("\n").filter(Boolean).sort();
    expect(list).toEqual(["a.txt", "b.txt"]);
  });

  test("a check with a multi-line command runs with the same meaning, and an unknown name is a usage error", async () => {
    const fx = repoFixture();
    process.env.IDD_REPOS_FILE = fx.repos;
    expect(await runWaitRun({ check: "multiline", cwd: fx.wt, env: fx.laneEnv, ...capture() })).toBe(0);
    const io = capture();
    expect(await runWaitRun({ check: "nope", cwd: fx.wt, env: fx.laneEnv, ...io })).toBe(2);
    expect(io.err.join("")).toContain("nope");
  });

  test("a check whose changed-files list cannot be taken fails without starting the command (AC-015 / DEC-2845 / INV-2086)", async () => {
    const fx = repoFixture({ base: "no-such-branch" });
    process.env.IDD_REPOS_FILE = fx.repos;
    const io = capture();
    const code = await runWaitRun({ check: "seen", cwd: fx.wt, env: fx.laneEnv, ...io });
    expect(code).not.toBe(0);
    expect(io.all()).toContain("一覧");
    expect(existsSync(fx.out)).toBe(false);
    // a second call must not attach to a run: nothing was started, and the same failure comes back
    const io2 = capture();
    const code2 = await runWaitRun({ check: "seen", cwd: fx.wt, env: fx.laneEnv, ...io2 });
    expect(code2).toBe(code);
    expect(io2.all()).toContain("一覧");
    expect(existsSync(fx.out)).toBe(false);
  });

  test("two remotes that have the base are no answer either (AC-015 / DEC-2845)", async () => {
    const fx = repoFixture({ base: "target", remote: "origin" });
    process.env.IDD_REPOS_FILE = fx.repos;
    sh(fx.wt, ["update-ref", "refs/remotes/one/target", "main"]);
    sh(fx.wt, ["update-ref", "refs/remotes/two/target", "main~0"]);
    const io = capture();
    expect(await runWaitRun({ check: "seen", cwd: fx.wt, env: fx.laneEnv, ...io })).not.toBe(0);
    expect(io.all()).toContain("一覧");
    expect(existsSync(fx.out)).toBe(false);
  });

  test("with no changes the empty list is still handed over (AC-016 / DEC-2845)", async () => {
    const fx = repoFixture();
    process.env.IDD_REPOS_FILE = fx.repos;
    sh(fx.wt, ["checkout", "--quiet", "main"]);
    const code = await runWaitRun({ check: "seen", cwd: fx.wt, env: fx.laneEnv, ...capture() });
    expect(code).toBe(0);
    expect(existsSync(fx.out)).toBe(true);
    expect(readFileSync(fx.out, "utf8")).toBe("");
  });
});

describe("wait-run: a check by name in a copy with the records taken out (C-238-1)", () => {
  const MANIFEST = ["# overlay manifest", "_docs/", "TODO.md", "overlay.manifest", "config/repos.yaml", ""].join("\n");

  /** a lane worktree whose base and head both hold records, registered with a review root of its own */
  function copyFixture() {
    const root = tmpDir("idd-wait-copy-");
    const wt = join(root, "wt");
    const put = (rel: string, text: string) => { mkdirSync(join(wt, rel, ".."), { recursive: true }); writeFileSync(join(wt, rel), text); };
    mkdirSync(wt);
    sh(wt, ["init", "--quiet", "-b", "main"]);
    put("overlay.manifest", MANIFEST);
    put("a.txt", "1\n");
    put("_docs/plan/old.md", "OLD\n");
    sh(wt, ["add", "-A"]);
    sh(wt, ["commit", "--quiet", "-m", "base"]);
    const base = sh(wt, ["rev-parse", "HEAD"]).trim();
    sh(wt, ["checkout", "--quiet", "-b", "feature"]);
    put("b.txt", "2\n");
    put("a.txt", "1\nchanged\n");
    put("_docs/plan/new.md", "NEW\n");
    put("TODO.md", "todo\n");
    sh(wt, ["add", "-A"]);
    sh(wt, ["commit", "--quiet", "-m", "feature"]);
    const head = sh(wt, ["rev-parse", "HEAD"]).trim();
    const out = join(root, "list");
    const repos = join(root, "repos.yaml");
    writeFileSync(repos, [
      "repos:",
      "  me/app:",
      `    upstream: ${wt}`,
      `    work: ${wt}`,
      "    remote: \"\"",
      "    public_base: main",
      `    review_root: ${join(root, "review-wt")}`,
      "    checks:",
      `      - { name: seen, command: "tr '\\\\0' '\\\\n' < \\"$IDD_CHANGED_FILES\\" > ${out}", required: true }`,
      "    lanes_root: " + join(root, "lanes"),
    ].join("\n") + "\n");
    process.env.IDD_REPOS_FILE = repos;
    const laneEnv = { ...env, IDD_STATE_DIR: join(root, "state"), IDD_LANE_ID: "L1", IDD_REPOS_FILE: repos };
    mkdirSync(join(root, "state"), { recursive: true });
    const rows = manifestRowsAt(wt, [head, base]);
    // the copy is cut the way the review route cuts it: from the worktree, with the base as a rev
    const source = { ...repoForPath(wt)!, clone: wt, base };
    const cut = (revs: Record<string, string>) => addRecordlessCopy(source, { name: `c-${Math.random().toString(16).slice(2, 8)}`, revs, rows, head: "head" });
    return { root, wt, base, head, rows, out, laneEnv, cut };
  }

  const listOf = (out: string) => readFileSync(out, "utf8").split("\n").filter(Boolean).sort();

  test("starts with the changed-files list and ends with the check's exit code; the list is the worktree's less the paths the copy took out", async () => {
    const fx = copyFixture();
    expect(await runWaitRun({ check: "seen", cwd: fx.wt, env: fx.laneEnv, ...capture() })).toBe(0);
    const inWorktree = listOf(fx.out);
    expect(inWorktree).toEqual(["TODO.md", "_docs/plan/new.md", "a.txt", "b.txt"]);
    rmSync(fx.out);
    const copy = fx.cut({ base: fx.base, head: fx.head, laneBase: fx.base }).meta.path;
    const io = capture();
    expect(await runWaitRun({ check: "seen", cwd: copy, env: fx.laneEnv, ...io })).toBe(0);
    expect(listOf(fx.out)).toEqual(inWorktree.filter((f) => !isOverlayPath(fx.rows, f)));
    expect(listOf(fx.out)).toEqual(["a.txt", "b.txt"]);
  });

  test("an incremental round's copy hands the check the whole lane's list, not what changed since the reviewed head", async () => {
    const fx = copyFixture();
    writeFileSync(join(fx.wt, "c.txt"), "3\n");
    sh(fx.wt, ["add", "-A"]);
    sh(fx.wt, ["commit", "--quiet", "-m", "after the review"]);
    const next = sh(fx.wt, ["rev-parse", "HEAD"]).trim();
    expect(await runWaitRun({ check: "seen", cwd: fx.wt, env: fx.laneEnv, ...capture() })).toBe(0);
    const inWorktree = listOf(fx.out);
    expect(inWorktree).toContain("b.txt");
    rmSync(fx.out);
    // the previous head is `base` and the lane's origin is `laneBase`, as the review route names them
    const copy = fx.cut({ base: fx.head, head: next, laneBase: fx.base }).meta.path;
    expect(await runWaitRun({ check: "seen", cwd: copy, env: fx.laneEnv, ...capture() })).toBe(0);
    expect(listOf(fx.out)).toEqual(inWorktree.filter((f) => !isOverlayPath(fx.rows, f)));
    expect(listOf(fx.out)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("a copy outside every root the registry knows still finds its repo's checks, from its mark", async () => {
    const fx = copyFixture();
    // the review route's place: under the lane's state, not under the repo's clone, work, lanes or review root
    const elsewhere = tmpDir("idd-wait-copy-state-");
    const far = join(elsewhere, "pipeline", "review-wt");
    const copy = addRecordlessCopy({ ...repoForPath(fx.wt)!, clone: fx.wt, base: fx.base, reviewRoot: far }, { name: "far-copy", revs: { base: fx.base, head: fx.head, laneBase: fx.base }, rows: fx.rows, head: "head" }).meta.path;
    expect(copy.startsWith(far)).toBe(true);
    // no root of the registry holds the copy; the mark is what names its repo
    expect(repoForPath(copy)?.name).toBe(repoForPath(fx.wt)!.name);
    expect(resolveWaitCheck("seen", copy)).toMatchObject({ name: "seen" });
    expect(await runWaitRun({ check: "seen", cwd: copy, env: fx.laneEnv, ...capture() })).toBe(0);
    expect(listOf(fx.out)).toEqual(["a.txt", "b.txt"]);
  });

  test("a copy cut with no base rev starts no check and leaves nothing of one (DEC-2845)", async () => {
    const fx = copyFixture();
    const copy = fx.cut({ head: fx.head }).meta.path;
    const io = capture();
    const code = await runWaitRun({ check: "seen", cwd: copy, env: fx.laneEnv, ...io });
    expect(code).toBe(3);
    expect(existsSync(fx.out)).toBe(false);
  });

  test("the result names the paths the copy took out and says it does not show the lane's change; a worktree's result says none of it", async () => {
    const fx = copyFixture();
    const copy = fx.cut({ base: fx.base, head: fx.head }).meta.path;
    const io = capture();
    await runWaitRun({ check: "seen", cwd: copy, env: fx.laneEnv, ...io });
    const text = io.all();
    for (const row of fx.rows) expect(text).toContain(row);
    expect(text).toContain("lane の差分を映しません");
    const plain = capture();
    await runWaitRun({ check: "seen", cwd: fx.wt, env: fx.laneEnv, ...plain });
    expect(plain.all()).not.toContain("記録を剥がした複製");
  });
});
