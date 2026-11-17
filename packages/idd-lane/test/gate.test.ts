import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { changedSinceBase, runGate, touchedSinceBase } from "../src/gate.ts";
import type { LaneRepo } from "../src/repos.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };

/** a clone whose feature branch changed, deleted and added files, with edits not yet committed */
function fixture(base = "main") {
  const root = mkdtempSync(join(tmpdir(), "idd-gate-"));
  roots.push(root);
  const clone = join(root, "clone");
  mkdirSync(clone);
  sh(clone, ["init", "--quiet", "-b", "main"]);
  put(join(clone, "a.txt"), "1\n"); put(join(clone, "gone.txt"), "1\n"); put(join(clone, "kept.txt"), "1\n");
  sh(clone, ["add", "-A"]); sh(clone, ["commit", "--quiet", "-m", "base"]);
  sh(clone, ["checkout", "--quiet", "-b", "feature"]);
  put(join(clone, "a.txt"), "2\n"); put(join(clone, "lib/x y.dart"), "void main() {}\n"); sh(clone, ["rm", "--quiet", "gone.txt"]);
  sh(clone, ["add", "-A"]); sh(clone, ["commit", "--quiet", "-m", "feature"]);
  put(join(clone, "kept.txt"), "edited\n"); put(join(clone, "new.txt"), "untracked\n");
  const out = join(root, "changed");
  const repo: LaneRepo = {
    name: "app", clone, work: clone, base, remote: "", reviewRoot: join(root, "review"), copy: [], setup: [],
    checks: [{ name: "changed", command: `if [ -n "\${IDD_CHANGED_FILES:-}" ]; then tr '\\0' '\\n' < "$IDD_CHANGED_FILES" > ${JSON.stringify(out)}; else echo none > ${JSON.stringify(out)}; fi`, required: true }],
    lanesRoot: join(root, "lanes"),
  };
  return { clone, repo, out };
}
const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).sort();

describe("idd gate hands its checks the worktree's changed files", () => {
  test("from the merge base with the repo's base, the uncommitted and untracked ones too, deletions left out", () => {
    const f = fixture();
    const res = runGate(f.clone, { repo: f.repo });
    expect(res.ok).toBe(true);
    expect(lines(f.out)).toEqual(["a.txt", "kept.txt", "lib/x y.dart", "new.txt"]);
  });

  test("from a remote named otherwise than the registry says, when only that remote has the base", () => {
    const f = fixture();
    sh(f.clone, ["update-ref", "refs/remotes/dayseum/main", "main"]);
    sh(f.clone, ["branch", "-D", "main"]);
    const res = runGate(f.clone, { repo: { ...f.repo, remote: "origin" } });
    expect(res.ok).toBe(true);
    expect(lines(f.out)).toEqual(["a.txt", "kept.txt", "lib/x y.dart", "new.txt"]);
  });

  test("from the public base the submission fetched into the work clone", () => {
    const f = fixture();
    const key = createHash("sha256").update(JSON.stringify("main")).digest("hex");
    sh(f.clone, ["update-ref", `refs/idd/public/${key}`, "main"]);
    sh(f.clone, ["branch", "-D", "main"]);
    runGate(f.clone, { repo: { ...f.repo, remote: "origin" } });
    expect(lines(f.out)).toEqual(["a.txt", "kept.txt", "lib/x y.dart", "new.txt"]);
  });

  test("a list longer than the default output buffer of a child process", () => {
    const f = fixture();
    const many = join(f.clone, "many");
    mkdirSync(many);
    const pad = "p".repeat(80);
    for (let i = 0; i < 12_000; i += 1) writeFileSync(join(many, `${pad}-${i}`), "");
    const res = runGate(f.clone, { repo: f.repo });
    expect(res.ok).toBe(true);
    expect(lines(f.out).length).toBe(12_004);
  });

  test("no list when two remotes have the base: the pick would be a guess", () => {
    const f = fixture();
    sh(f.clone, ["update-ref", "refs/remotes/one/main", "main"]);
    sh(f.clone, ["update-ref", "refs/remotes/two/main", "main~0"]);
    sh(f.clone, ["branch", "-D", "main"]);
    runGate(f.clone, { repo: { ...f.repo, remote: "origin" } });
    expect(lines(f.out)).toEqual(["none"]);
  });

  test("no list when the base cannot be found, and none inherited from the caller", () => {
    const f = fixture("no-such-branch");
    const before = process.env.IDD_CHANGED_FILES;
    process.env.IDD_CHANGED_FILES = "/nowhere";
    try {
      runGate(f.clone, { repo: f.repo });
    } finally {
      if (before === undefined) delete process.env.IDD_CHANGED_FILES;
      else process.env.IDD_CHANGED_FILES = before;
    }
    expect(lines(f.out)).toEqual(["none"]);
  });
  test("the touched files include the deletions the gate's own list leaves out", () => {
    const f = fixture();
    expect(changedSinceBase(f.clone, f.repo)).not.toContain("gone.txt");
    expect(touchedSinceBase(f.clone, f.repo)?.sort()).toEqual(["a.txt", "gone.txt", "kept.txt", "lib/x y.dart", "new.txt"]);
    expect(touchedSinceBase(f.clone, { ...f.repo, base: "no-such-branch" })).toBeNull();
  });

  test("AC-020: counts from the work base's merge base, so the mainline's advance is not the lane's change", () => {
    const root = mkdtempSync(join(tmpdir(), "idd-gate-workbase-"));
    roots.push(root);
    const clone = join(root, "clone");
    mkdirSync(clone);
    sh(clone, ["init", "--quiet", "-b", "main"]);
    put(join(clone, "a.txt"), "1\n"); put(join(clone, "public.txt"), "1\n");
    sh(clone, ["add", "-A"]); sh(clone, ["commit", "--quiet", "-m", "base"]);
    // the work side's mainline moves ahead of the public base; the lane is cut from there
    sh(clone, ["checkout", "--quiet", "-b", "work-base"]);
    put(join(clone, "mainline.txt"), "1\n");
    sh(clone, ["add", "-A"]); sh(clone, ["commit", "--quiet", "-m", "mainline"]);
    sh(clone, ["checkout", "--quiet", "-b", "feature"]);
    put(join(clone, "a.txt"), "2\n"); put(join(clone, "lane.txt"), "1\n");
    sh(clone, ["add", "-A"]); sh(clone, ["commit", "--quiet", "-m", "lane"]);
    const repo: LaneRepo = {
      name: "app", clone, work: clone, base: "main", workBase: "work-base", remote: "", reviewRoot: join(root, "review"), copy: [], setup: [], checks: [],
      lanesRoot: join(root, "lanes"),
    };
    expect(touchedSinceBase(clone, repo)?.sort()).toEqual(["a.txt", "lane.txt"]);
    // without a work base the public base is the start, and the mainline's file reads as the lane's
    expect(touchedSinceBase(clone, { ...repo, workBase: undefined })?.sort()).toEqual(["a.txt", "lane.txt", "mainline.txt"]);
  });
});

describe("idd gate hands its checks the worktree's repo declaration", () => {
  const withStale = (fn: () => void) => {
    const before = process.env.IDD_RISK_PATHS;
    process.env.IDD_RISK_PATHS = JSON.stringify({ auth: ["stale/"] });
    try { fn(); } finally {
      if (before === undefined) delete process.env.IDD_RISK_PATHS;
      else process.env.IDD_RISK_PATHS = before;
    }
  };
  const seenBy = (f: ReturnType<typeof fixture>, seen: string) => {
    f.repo.checks = [{ name: "risk", command: `printf %s "\${IDD_RISK_PATHS-unset}" > ${JSON.stringify(seen)}`, required: true }];
  };

  test("the worktree repo's declaration reaches the checks, replacing whatever the caller had", () => {
    const f = fixture();
    const seen = join(f.clone, "..", "risk");
    f.repo.riskPaths = { auth: ["lib/"] };
    seenBy(f, seen);
    withStale(() => { runGate(f.clone, { repo: f.repo }); });
    expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({ auth: ["lib/"] });
  });

  test("a repo without a declaration passes none, even when the caller has one", () => {
    const f = fixture();
    const seen = join(f.clone, "..", "risk");
    seenBy(f, seen);
    withStale(() => { runGate(f.clone, { repo: f.repo }); });
    expect(readFileSync(seen, "utf8")).toBe("unset");
  });
});
