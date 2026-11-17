import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runProbe } from "../src/probe.ts";
import { shimEnv } from "../src/shim.ts";
import { tmpDir } from "./helpers/tmp.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

function makeRepo(): { dir: string; base: string } {
  const dir = tmpDir("idd-lane-probe-");
  process.env.IDD_STATE_DIR = tmpDir("idd-lane-state-");
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "value.txt"), "old\n");
  git(dir, ["add", "."]); git(dir, ["commit", "-qm", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "value.txt"), "new\n");
  git(dir, ["commit", "-qam", "change"]);
  return { dir, base };
}

describe("runProbe", () => {
  test("reverts, runs, and always restores the worktree", () => {
    const { dir, base } = makeRepo();
    const res = runProbe({ worktree: dir, to: base, files: ["value.txt"], run: "grep -q new value.txt" });
    expect(res.exit).not.toBe(0);
    expect(res.reverted).toEqual(["value.txt"]);
    expect(res.restored).toBe(true);
    expect(res.clean_after).toBe(true);
    expect(readFileSync(join(dir, "value.txt"), "utf8")).toBe("new\n");
  });

  test("restores even when launched from inside a lane (shim PATH refuses reset --hard)", () => {
    const { dir, base } = makeRepo();
    const saved = { PATH: process.env.PATH, REAL: process.env.IDD_LANE_REAL_PATH };
    const env = shimEnv();
    process.env.PATH = env.PATH;
    process.env.IDD_LANE_REAL_PATH = env.IDD_LANE_REAL_PATH;
    try {
      const res = runProbe({ worktree: dir, to: base, files: ["value.txt"], run: "grep -q old value.txt" });
      expect(res.exit).toBe(0);
      expect(res.restored).toBe(true);
      expect(res.clean_after).toBe(true);
      expect(readFileSync(join(dir, "value.txt"), "utf8")).toBe("new\n");
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.REAL === undefined) delete process.env.IDD_LANE_REAL_PATH; else process.env.IDD_LANE_REAL_PATH = saved.REAL;
    }
  });

  test("refuses to start on a dirty worktree", () => {
    const { dir, base } = makeRepo();
    writeFileSync(join(dir, "value.txt"), "dirty\n");
    expect(() => runProbe({ worktree: dir, to: base, files: ["value.txt"], run: "true" })).toThrow(/clean ではありません/);
  });

  test("extracts failing flutter test names from the output", () => {
    const { dir, base } = makeRepo();
    const res = runProbe({ worktree: dir, to: base, files: ["value.txt"], run: "printf '00:01 +3 -1: APP-1: foo bar [E]\\n'; exit 1" });
    expect(res.failed_tests).toEqual(["APP-1: foo bar"]);
  });
});

describe("shimEnv", () => {
  test("puts the shim dir first and denies push / review while passing reads through", () => {
    process.env.IDD_STATE_DIR = tmpDir("idd-lane-state-");
    const env = shimEnv();
    const shimDir = env.PATH!.split(":")[0];
    expect(env.IDD_LANE_REAL_PATH!.split(":")).not.toContain(shimDir);
    const run = (cmd: string) => { try { execFileSync("bash", ["-c", cmd], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return 0; } catch (e) { return (e as { status: number }).status; } };
    expect(run("git push origin main")).toBe(86);
    expect(run("git commit --no-verify -m x")).toBe(86);
    expect(run("gh pr review 1 --approve")).toBe(86);
    expect(run("git --version")).toBe(0);
  });
});
