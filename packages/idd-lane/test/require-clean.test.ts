import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertReportWriter } from "../src/pi-extensions/report-writer.ts";
import { ALL_TOOLS, parseRoles } from "../src/roles.ts";
import { buildClaudeArgs, executeLane, prepareLane, sendLane, settleDirtyWorktree, snapshotDiff, worktreeSnapshot, type LaneRecord } from "../src/runner.ts";
import { parseSpec, renderBrief } from "../src/spec.ts";
import { shippedConfig, shippedConfigTest } from "./helpers/shipped-config.ts";
import { tmpDir } from "./helpers/tmp.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd, encoding: "utf8" });

function repo(): string {
  const wt = join(tmpDir("idd-require-clean-"), "wt");
  mkdirSync(wt);
  git(wt, "init", "-q");
  writeFileSync(join(wt, "tracked.txt"), "one\n");
  writeFileSync(join(wt, "other.txt"), "other\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "base");
  return wt;
}

describe("worktreeSnapshot", () => {
  test("a clean worktree reads the same twice, and the index is not moved by reading", () => {
    const wt = repo();
    writeFileSync(join(wt, "untracked.txt"), "u\n");
    const indexBefore = git(wt, "ls-files", "--stage");
    const a = worktreeSnapshot(wt);
    expect(snapshotDiff(a, worktreeSnapshot(wt))).toEqual([]);
    expect(git(wt, "ls-files", "--stage")).toBe(indexBefore);
    expect(git(wt, "status", "--short")).toBe("?? untracked.txt\n");
  });

  test("a tracked file's content, an untracked file's content with the same list, a new file and a commit each differ", () => {
    const wt = repo();
    writeFileSync(join(wt, "note.md"), "a\n");
    const start = worktreeSnapshot(wt);

    writeFileSync(join(wt, "tracked.txt"), "changed\n");
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual(["追跡ファイルの中身"]);
    writeFileSync(join(wt, "tracked.txt"), "one\n");
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual([]);

    // the untracked list is the same, only the content moved: `git status` reads the same here
    writeFileSync(join(wt, "note.md"), "b\n");
    expect(git(wt, "status", "--short")).toBe("?? note.md\n");
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual(["未追跡ファイルの一覧か中身"]);
    writeFileSync(join(wt, "note.md"), "a\n");
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual([]);

    writeFileSync(join(wt, "extra.txt"), "x\n");
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual(["未追跡ファイルの一覧か中身"]);
    execFileSync("rm", [join(wt, "extra.txt")]);

    // a commit that leaves the files as they were still moves HEAD
    git(wt, "commit", "-q", "--allow-empty", "-m", "empty");
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual(["HEAD"]);
  });

  test("staging a tracked change does not hide it, and a deleted tracked file is a difference", () => {
    const wt = repo();
    const start = worktreeSnapshot(wt);
    writeFileSync(join(wt, "tracked.txt"), "staged\n");
    git(wt, "add", "tracked.txt");
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual(["stage した追跡ファイルの中身"]);
    git(wt, "reset", "-q", "--hard");
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual([]);
    execFileSync("rm", [join(wt, "other.txt")]);
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual(["追跡ファイルの中身"]);
  });

  test("a staged change whose files were put back is still seen, and a difference that was there at the start is allowed", () => {
    const wt = repo();
    const start = worktreeSnapshot(wt);
    writeFileSync(join(wt, "tracked.txt"), "staged\n");
    git(wt, "add", "tracked.txt");
    writeFileSync(join(wt, "tracked.txt"), "one\n");
    // the files read as HEAD, so only the index tells
    expect(git(wt, "diff", "HEAD", "--stat")).toBe("");
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual(["stage した追跡ファイルの中身", "追跡ファイルの中身"]);
    git(wt, "reset", "-q", "tracked.txt");
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual([]);

    // staged and unstaged differences from the start stay allowed while they stay as they were
    writeFileSync(join(wt, "tracked.txt"), "staged\n");
    git(wt, "add", "tracked.txt");
    writeFileSync(join(wt, "other.txt"), "dirty\n");
    const dirty = worktreeSnapshot(wt);
    expect(snapshotDiff(dirty, worktreeSnapshot(wt))).toEqual([]);
    git(wt, "reset", "-q", "tracked.txt");
    expect(snapshotDiff(dirty, worktreeSnapshot(wt))).not.toEqual([]);
  });

  test("a file the repo ignores is not part of the state, so a build's output does not fail the run", () => {
    const wt = repo();
    writeFileSync(join(wt, ".gitignore"), "local.db\n_build/\n");
    git(wt, "add", ".gitignore");
    git(wt, "commit", "-q", "-m", "ignore");
    writeFileSync(join(wt, "local.db"), "mine\n");
    const start = worktreeSnapshot(wt);
    expect(git(wt, "status", "--short")).toBe("");

    writeFileSync(join(wt, "local.db"), "gone\n");
    mkdirSync(join(wt, "_build"));
    writeFileSync(join(wt, "_build", "out.js"), "built\n");
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual([]);
    writeFileSync(join(wt, "kept.txt"), "k\n");
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual(["未追跡ファイルの一覧か中身"]);
  });

  test("a change past the first chunk of a large untracked file is seen", () => {
    const wt = repo();
    const big = Buffer.alloc(3 * (1 << 20) + 5, 1);
    writeFileSync(join(wt, "big.bin"), big);
    const start = worktreeSnapshot(wt);
    big[big.length - 1] = 2;
    writeFileSync(join(wt, "big.bin"), big);
    expect(snapshotDiff(start, worktreeSnapshot(wt))).toEqual(["未追跡ファイルの一覧か中身"]);
  });

  test.skipIf(process.getuid?.() === 0)("an untracked file whose content cannot be read fails the snapshot instead of reading as unchanged", () => {
    const wt = repo();
    writeFileSync(join(wt, "secret.txt"), "s\n");
    chmodSync(join(wt, "secret.txt"), 0o000);
    try {
      expect(() => worktreeSnapshot(wt)).toThrow();
    } finally {
      chmodSync(join(wt, "secret.txt"), 0o644);
    }
  });
});

/** a lane of one role `deep` whose fake pi runs `body` in the worktree, with the deliverable written after it */
function lane(body: string, wt: string, roleLines = "") {
  const root = tmpDir("idd-require-clean-lane-");
  const cfg = join(root, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, ".credentials.json"), "{}");
  writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${cfg}\nmodels:\n  m:\n    model: x/y\nroles:\n  deep:\n    model: m\n    report: review\n${roleLines}`);
  writeFileSync(join(root, "repos.yaml"), "repos:\n");
  const agent = join(root, "agent");
  mkdirSync(agent);
  const noRoot = join(root, "no-lane-root");
  mkdirSync(noRoot);
  const out = join(root, "out");
  mkdirSync(out);
  const report = join(out, "report");
  const fakePi = join(root, "pi");
  writeFileSync(fakePi, `#!/bin/sh
case "$*" in *--list-models*) exit 0 ;; esac
SESS=""; SID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-dir) SESS="$2"; shift 2;;
    --session-id) SID="$2"; shift 2;;
    *) shift;;
  esac
done
cd "${wt}"
${body}
mkdir -p "$SESS"; printf '%s\\n' '{"type":"message","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"ok"}]}}' > "$SESS/$SID.jsonl"
echo done > "${report}.md"; echo '{}' > "${report}.json"
exit 0
`);
  chmodSync(fakePi, 0o755);
  Object.assign(process.env, {
    IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"),
    IDD_LANE_ROOT: noRoot, IDD_LANE_SCOPE: "off", IDD_PI_BIN: fakePi, IDD_PI_USER_AGENT_DIR: agent,
  });
  const specPath = join(root, "spec.yaml");
  writeFileSync(specPath, `role: deep\nworktree: ${wt}\nreport: ${report}\ntask: t\n`);
  return specPath;
}

const clearEnv = () => { for (const k of ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_REPOS_FILE", "IDD_LANE_ROOT", "IDD_LANE_SCOPE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR"]) delete process.env[k]; };

async function run(body: string, setup: (wt: string) => void = () => {}, roleLines = "") {
  const wt = repo();
  setup(wt);
  try {
    const { rec } = prepareLane(lane(body, wt, roleLines));
    return await executeLane(rec.id);
  } finally { clearEnv(); }
}

describe("a require_clean run is held to ending as it began", () => {
  test("a worktree that began dirty starts, and a run that leaves it as it was is done", async () => {
    const done = await run("true", (wt) => {
      writeFileSync(join(wt, "tracked.txt"), "uncommitted\n");
      writeFileSync(join(wt, "record.md"), "an uncommitted record\n");
    });
    expect(done.status).toBe("done");
    expect(done.clean).toBe(true);
    expect(done.state_before).toEqual(done.state_after!);
  });

  test("a run that rewrote an untracked record is failed, naming what moved", async () => {
    const done = await run(`echo changed > record.md`, (wt) => writeFileSync(join(wt, "record.md"), "an uncommitted record\n"));
    expect(done.status).toBe("failed");
    expect(done.clean).toBe(false);
    expect(done.error).toContain("未追跡ファイルの一覧か中身");
  });

  test("a run that edited a tracked file is failed", async () => {
    const done = await run(`echo changed > tracked.txt`);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("追跡ファイルの中身");
  });

  test("a run that committed is failed on HEAD even though the files read the same", async () => {
    const done = await run(`git -c user.email=a@b -c user.name=a commit -q --allow-empty -m x`);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("HEAD");
  });

  test("a change made and put back during the run reads the same state and passes", async () => {
    const done = await run(`echo changed > tracked.txt; echo new > scratch.txt; rm scratch.txt; git checkout -q tracked.txt`);
    expect(done.status).toBe("done");
    expect(done.clean).toBe(true);
  });

  test("a role that writes require_clean: false is not checked", async () => {
    const done = await run(`echo changed > tracked.txt`, () => {}, "    require_clean: false\n");
    expect(done.status).toBe("done");
    expect(done.clean).toBeUndefined();
    expect(done.state_before).toBeUndefined();
  });
});

describe("what a require_clean run leaves behind", () => {
  const stashes = (wt: string) => git(wt, "stash", "list").trim().split("\n").filter(Boolean);
  const kept = (wt: string) => git(wt, "for-each-ref", "--format=%(refname)", "refs/idd/require-clean/").trim().split("\n").filter(Boolean);

  // a role that may not write ran in the lane's own worktree: what it wrote must not reach the lane's next step
  test("a run that began on a clean worktree has what it wrote kept on a ref of the lane's own and taken back, and the paths are kept on the record", async () => {
    const wt = repo();
    let done: LaneRecord;
    try {
      const { rec } = prepareLane(lane(`mkdir -p .tmp-probe/x && echo t > .tmp-probe/x/probe.test.ts; echo changed > tracked.txt`, wt));
      done = await executeLane(rec.id);
    } finally { clearEnv(); }
    expect(done.status).toBe("failed");
    expect(done.clean).toBe(false);
    expect(done.error).toContain("worktree が開始時から変わっている");
    expect(git(wt, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("one\n");
    expect(done.worktree_restore?.paths).toEqual([".tmp-probe/x/probe.test.ts", "tracked.txt"]);
    expect(done.worktree_restore?.ok).toBe(true);
    // nothing is lost for good: a ref of the lane's own holds what the role wrote, and the shared stash is left alone
    expect(kept(wt)).toEqual([done.worktree_restore?.ref]);
    expect(git(wt, "show", `${done.worktree_restore?.commit}:tracked.txt`)).toBe("changed\n");
    expect(git(wt, "show", `${done.worktree_restore?.commit}:.tmp-probe/x/probe.test.ts`)).toBe("t\n");
    expect(stashes(wt)).toHaveLength(0);
  });

  test("a run that began on a dirty worktree is not taken back: what was the role's cannot be told from what was there", async () => {
    const done = await run(`echo changed > record.md; echo s > scratch.txt`, (wt) => writeFileSync(join(wt, "record.md"), "an uncommitted record\n"));
    expect(done.status).toBe("failed");
    expect(done.worktree_restore).toBeUndefined();
    expect(readFileSync(join(done.worktree, "record.md"), "utf8")).toBe("changed\n");
    expect(existsSync(join(done.worktree, "scratch.txt"))).toBe(true);
    expect(kept(done.worktree)).toHaveLength(0);
  });

  test("a run that moved HEAD is not taken back", async () => {
    const done = await run(`echo s > scratch.txt; git -c user.email=a@b -c user.name=a commit -q --allow-empty -m x`);
    expect(done.status).toBe("failed");
    expect(done.worktree_restore).toBeUndefined();
    expect(existsSync(join(done.worktree, "scratch.txt"))).toBe(true);
  });

  /** a record of a require_clean attempt that ended with `body` run in a clean worktree, as the run would have sealed it */
  function ended(body: (wt: string) => void, setup: (wt: string) => void = () => {}) {
    const wt = repo();
    setup(wt);
    const before = worktreeSnapshot(wt);
    body(wt);
    const after = worktreeSnapshot(wt);
    const rec = { id: "t", status: "timeout", worktree: wt, state_before_at: new Date(Date.now() - 60_000).toISOString(), state_before: before, state_after: after, clean: snapshotDiff(before, after).length === 0 } as unknown as LaneRecord;
    return { wt, rec, dir: tmpDir("idd-require-clean-end-") };
  }

  test("a run that ended on its time budget still names the change and has it taken back", () => {
    const { wt, rec, dir } = ended((w) => writeFileSync(join(w, "scratch.txt"), "s\n"));
    const state = tmpDir("idd-require-clean-state-");
    process.env.IDD_STATE_DIR = state;
    try { settleDirtyWorktree(rec, dir); } finally { delete process.env.IDD_STATE_DIR; }
    expect(rec.status).toBe("timeout");
    expect(rec.error).toContain("worktree が開始時から変わっている");
    expect(rec.worktree_restore?.ok).toBe(true);
    expect(rec.worktree_restore?.paths).toEqual(["scratch.txt"]);
    expect(existsSync(join(wt, "scratch.txt"))).toBe(false);
    expect(readFileSync(join(dir, "supervisor.log"), "utf8")).toContain("scratch.txt");
  });

  test("a file the repo ignores is left where it is, and the worktree still reads as it began", () => {
    const { wt, rec, dir } = ended(
      (w) => { writeFileSync(join(w, "build.out"), "b\n"); writeFileSync(join(w, "scratch.txt"), "s\n"); },
      (w) => { writeFileSync(join(w, ".gitignore"), "build.out\n"); git(w, "add", ".gitignore"); git(w, "commit", "-q", "-m", "ignore"); },
    );
    const state = tmpDir("idd-require-clean-state-");
    process.env.IDD_STATE_DIR = state;
    try { settleDirtyWorktree(rec, dir); } finally { delete process.env.IDD_STATE_DIR; }
    expect(rec.worktree_restore?.ok).toBe(true);
    expect(existsSync(join(wt, "build.out"))).toBe(true);
    expect(existsSync(join(wt, "scratch.txt"))).toBe(false);
  });

  test("a worktree another running lane is using is not touched, and the reason is recorded", () => {
    const { wt, rec, dir } = ended((w) => writeFileSync(join(w, "tracked.txt"), "the executor's edit\n"));
    const state = tmpDir("idd-require-clean-state-");
    // the executor's conversation in the same worktree, alive now
    mkdirSync(join(state, "lanes", "exec-1"), { recursive: true });
    writeFileSync(join(state, "lanes", "exec-1", "lane.json"), JSON.stringify({ id: "exec-1", status: "running", pid: process.pid, worktree: wt, started_at: "2026-10-26T00:00:00Z" }));
    process.env.IDD_STATE_DIR = state;
    try { settleDirtyWorktree(rec, dir); } finally { delete process.env.IDD_STATE_DIR; }
    expect(rec.worktree_restore?.ok).toBe(false);
    expect(rec.worktree_restore?.skipped).toContain("exec-1");
    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("the executor's edit\n");
    expect(kept(wt)).toHaveLength(0);
  });

  test("a worktree whose conversation took a turn during the attempt and let go of its lock is not touched", () => {
    const { wt, rec, dir } = ended((w) => writeFileSync(join(w, "tracked.txt"), "the executor's edit\n"));
    const state = tmpDir("idd-require-clean-state-");
    // the conversation answered during the attempt and stopped: no live lock, but its record moved after the start
    mkdirSync(join(state, "lanes", "conv-1"), { recursive: true });
    writeFileSync(join(state, "lanes", "conv-1", "lane.json"), JSON.stringify({ id: "conv-1", mode: "conversation", status: "idle", worktree: wt, started_at: "2026-10-26T00:00:00Z" }));
    process.env.IDD_STATE_DIR = state;
    try { settleDirtyWorktree(rec, dir); } finally { delete process.env.IDD_STATE_DIR; }
    expect(rec.worktree_restore?.skipped).toContain("conv-1");
    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("the executor's edit\n");
  });

  test("a lane on the same worktree whose record has not moved since the attempt began does not hold it", () => {
    const { wt, rec, dir } = ended((w) => writeFileSync(join(w, "scratch.txt"), "s\n"));
    const state = tmpDir("idd-require-clean-state-");
    mkdirSync(join(state, "lanes", "old-1"), { recursive: true });
    const old = join(state, "lanes", "old-1", "lane.json");
    writeFileSync(old, JSON.stringify({ id: "old-1", status: "done", worktree: wt, started_at: "2026-10-25T00:00:00Z" }));
    const longAgo = new Date(Date.now() - 3_600_000);
    utimesSync(old, longAgo, longAgo);
    process.env.IDD_STATE_DIR = state;
    try { settleDirtyWorktree(rec, dir); } finally { delete process.env.IDD_STATE_DIR; }
    expect(rec.worktree_restore?.ok).toBe(true);
    expect(existsSync(join(wt, "scratch.txt"))).toBe(false);
  });

  test("a commit made after the attempt was sealed is never rolled back", () => {
    const { wt, rec, dir } = ended((w) => writeFileSync(join(w, "scratch.txt"), "s\n"));
    // another process commits between the seal and the restore
    git(wt, "commit", "-q", "--allow-empty", "-m", "someone else's commit");
    const head = git(wt, "rev-parse", "HEAD").trim();
    const state = tmpDir("idd-require-clean-state-");
    process.env.IDD_STATE_DIR = state;
    try { settleDirtyWorktree(rec, dir); } finally { delete process.env.IDD_STATE_DIR; }
    expect(git(wt, "rev-parse", "HEAD").trim()).toBe(head);
    expect(rec.worktree_restore?.ok).toBe(false);
    expect(existsSync(join(wt, "scratch.txt"))).toBe(true);
  });

  test("a staged new file and a deleted tracked file are both taken back", () => {
    const { wt, rec, dir } = ended((w) => { writeFileSync(join(w, "added.txt"), "a\n"); git(w, "add", "added.txt"); execFileSync("rm", [join(w, "other.txt")]); });
    const state = tmpDir("idd-require-clean-state-");
    process.env.IDD_STATE_DIR = state;
    try { settleDirtyWorktree(rec, dir); } finally { delete process.env.IDD_STATE_DIR; }
    expect(rec.worktree_restore?.ok).toBe(true);
    expect(existsSync(join(wt, "added.txt"))).toBe(false);
    expect(readFileSync(join(wt, "other.txt"), "utf8")).toBe("other\n");
    expect(git(wt, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  test("a path named like a glob pattern (`[id]`) is taken back by its own name", () => {
    const { wt, rec, dir } = ended(
      (w) => writeFileSync(join(w, "app", "[id]", "page.tsx"), "role\n"),
      (w) => { mkdirSync(join(w, "app", "[id]"), { recursive: true }); writeFileSync(join(w, "app", "[id]", "page.tsx"), "one\n"); git(w, "add", "."); git(w, "commit", "-q", "-m", "pages"); },
    );
    const state = tmpDir("idd-require-clean-state-");
    process.env.IDD_STATE_DIR = state;
    try { settleDirtyWorktree(rec, dir); } finally { delete process.env.IDD_STATE_DIR; }
    expect(rec.worktree_restore?.ok).toBe(true);
    expect(readFileSync(join(wt, "app", "[id]", "page.tsx"), "utf8")).toBe("one\n");
    expect(git(wt, "show", `${rec.worktree_restore?.commit}:app/[id]/page.tsx`)).toBe("role\n");
  });

  test("a path written again after the commit was taken is left as written, and the rest is taken back", () => {
    const { wt, rec, dir } = ended((w) => { writeFileSync(join(w, "tracked.txt"), "role\n"); writeFileSync(join(w, "scratch.txt"), "s\n"); });
    const state = tmpDir("idd-require-clean-state-");
    process.env.IDD_STATE_DIR = state;
    try {
      // another writer touches tracked.txt between the kept commit and the take-back
      settleDirtyWorktree(rec, dir, { afterKeep: () => writeFileSync(join(wt, "tracked.txt"), "written after\n") });
    } finally { delete process.env.IDD_STATE_DIR; }
    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("written after\n");
    expect(existsSync(join(wt, "scratch.txt"))).toBe(false);
    expect(rec.worktree_restore?.ok).toBe(false);
    expect(rec.worktree_restore?.error).toContain("tracked.txt");
    expect(git(wt, "show", `${rec.worktree_restore?.commit}:tracked.txt`)).toBe("role\n");
  });

  test("a failing git leaves the worktree as it is and names the failure", () => {
    const { wt, rec, dir } = ended((w) => writeFileSync(join(w, "scratch.txt"), "s\n"));
    const state = tmpDir("idd-require-clean-state-");
    // another git holds the index: the reset cannot run
    writeFileSync(join(wt, ".git", "index.lock"), "");
    process.env.IDD_STATE_DIR = state;
    try { settleDirtyWorktree(rec, dir); } finally { delete process.env.IDD_STATE_DIR; }
    expect(rec.worktree_restore?.ok).toBe(false);
    expect(rec.worktree_restore?.error).toBeTruthy();
    expect(rec.error).toContain("worktree を戻しきれなかった");
    expect(existsSync(join(wt, "scratch.txt"))).toBe(true);
  });

  test("a worktree that still differs after the take-back (a nested repository the commit does not hold) is recorded as not taken back", () => {
    const { rec, dir } = ended((w) => { mkdirSync(join(w, "nested")); git(join(w, "nested"), "init", "-q"); writeFileSync(join(w, "nested", "f.txt"), "f\n"); git(join(w, "nested"), "add", "."); git(join(w, "nested"), "commit", "-q", "-m", "n"); });
    const state = tmpDir("idd-require-clean-state-");
    process.env.IDD_STATE_DIR = state;
    try { settleDirtyWorktree(rec, dir); } finally { delete process.env.IDD_STATE_DIR; }
    expect(rec.worktree_restore?.ok).toBe(false);
    expect(rec.error).toContain("worktree を戻しきれなかった");
  });
});

describe("a require_clean follow-up is held to the same rule", () => {
  /** a first run that changes nothing, then a follow-up that edits the tracked file when `.git/second` exists */
  async function followUp(roleLines: string) {
    const wt = repo();
    try {
      const { rec } = prepareLane(lane(`test -f .git/second && echo changed > tracked.txt`, wt, roleLines));
      const first = await executeLane(rec.id);
      expect(first.status).toBe("done");
      writeFileSync(join(wt, ".git", "second"), "");
      return await sendLane(rec.id, "続き");
    } finally { clearEnv(); }
  }

  test("a follow-up that changed the worktree is failed, naming what moved, and has the change taken back", async () => {
    const sent = await followUp("");
    expect(sent.exit).toBe(0);
    expect(sent.clean).toBe(false);
    expect(sent.status).toBe("failed");
    expect(sent.error).toContain("追跡ファイルの中身");
    expect(sent.worktree_restore?.ok).toBe(true);
    expect(readFileSync(join(sent.worktree, "tracked.txt"), "utf8")).toBe("one\n");
  });

  test("a follow-up that left it as it began is done", async () => {
    const wt = repo();
    try {
      const { rec } = prepareLane(lane(`true`, wt));
      await executeLane(rec.id);
      const sent = await sendLane(rec.id, "続き");
      expect(sent.status).toBe("done");
      expect(sent.clean).toBe(true);
    } finally { clearEnv(); }
  });

  test("a role that writes require_clean: false has its follow-up recorded as before", async () => {
    const sent = await followUp("    require_clean: false\n");
    expect(sent.status).toBe("done");
    expect(sent.clean).toBeUndefined();
  });
});

describe("a role's tools", () => {
  const ROLES = `models:
  m:
    model: x/y
roles:
  all: { model: m }
  few: { model: m, tools: [read, grep] }
  none: { model: m, tools: [] }
`;

  test("a role that writes no tools has all seven, a written list is read as it is, and a written empty list stays empty", () => {
    const r = parseRoles(ROLES).roles;
    expect(r.all.tools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(r.all.tools).toEqual([...ALL_TOOLS]);
    expect(r.few.tools).toEqual(["read", "grep"]);
    expect(r.none.tools).toEqual([]);
  });

  test("a name pi does not have is refused at the read", () => {
    expect(() => parseRoles(ROLES.replace("[read, grep]", "[read, WebFetch]"))).toThrow(/未知の tool "WebFetch"/);
  });

  test("a role with `tools:` left empty of a value has all seven", () => {
    expect(parseRoles(ROLES.replace("tools: [read, grep]", "tools:")).roles.few.tools).toEqual([...ALL_TOOLS]);
  });

  test("a Claude Code role is given the seven mapped to its own names, with no sub-agent and no Claude-only tool", () => {
    const role = parseRoles(`roles:\n  c: { harness: claude, model: opus }\n`).roles.c;
    const args = buildClaudeArgs(role, "sid", "brief");
    expect(args[args.indexOf("--tools") + 1].split(",").sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
    const denied = args[args.indexOf("--disallowedTools") + 1].split(",");
    for (const name of ["Agent", "Task", "WebFetch", "WebSearch", "NotebookEdit", "SendUserMessage"]) expect(denied).toContain(name);
    expect(args[args.indexOf("--tools") + 1]).not.toMatch(/Agent|Task|WebFetch|WebSearch|NotebookEdit/);
    expect(() => assertReportWriter(role)).not.toThrow();
  });

  test("a Claude Code role written with `tools: []` is refused before it starts", () => {
    const role = parseRoles(`roles:\n  c: { harness: claude, model: opus, tools: [] }\n`).roles.c;
    expect(() => assertReportWriter(role)).toThrow(/書けません/);
  });
});

describe("the brief's require_clean line", () => {
  test("asks for the state the run began in, and does not ask to empty git status", () => {
    const wt = repo();
    const roles = parseRoles(`models:\n  m:\n    model: x/y\nroles:\n  r: { model: m, report: review }\n`);
    const spec = parseSpec(`role: r\nstage: blind\nworktree: ${wt}\nreport: ${join(wt, "r")}\n`);
    const brief = renderBrief(spec, roles.roles.r);
    expect(brief).toContain("開始時と同じでなければならない");
    expect(brief).not.toContain("git status --short");
    expect(readFileSync(join(import.meta.dir, "..", "src", "spec.ts"), "utf8")).not.toContain("終了時 git status --short が空");
  });

  test("a spec with no stage, like the plan review's, still carries the line", () => {
    const wt = repo();
    const roles = parseRoles(`models:\n  m:\n    model: x/y\nroles:\n  r: { model: m, report: review }\n  w: { model: m, report: review, require_clean: false }\n`);
    const spec = parseSpec(`role: r\ninject_stage: plan-review\nworktree: ${wt}\nreport: ${join(wt, "r")}\n`);
    expect(renderBrief(spec, roles.roles.r)).toContain("開始時と同じでなければならない");
    expect(renderBrief(spec, roles.roles.w)).not.toContain("開始時と同じでなければならない");
  });
});

describe("the shipped configs", () => {
  const WRITERS = /^(planner|executor|chat|rewriter|titler)/;
  for (const file of ["roles.yaml", "roles.example.yaml"]) {
    shippedConfigTest([file], `${file}: every role has the same seven tools, and only the roles that write ask not to be checked`, () => {
      const roles = parseRoles(readFileSync(shippedConfig(file), "utf8")).roles;
      for (const role of Object.values(roles)) {
        expect(role.tools, `${file}: ${role.name}`).toEqual([...ALL_TOOLS]);
        expect(role.requireClean, `${file}: ${role.name}`).toBe(!WRITERS.test(role.name));
      }
    });
  }
});
