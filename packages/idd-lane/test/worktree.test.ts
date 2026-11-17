import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LaneRepo } from "../src/repos.ts";
import { addWorktree, moveWorktree, removeWorktree } from "../src/worktree.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, ["init", "--quiet", "-b", "main"]);
  writeFileSync(join(dir, "a.txt"), "1\n");
  sh(dir, ["add", "a.txt"]);
  sh(dir, ["commit", "--quiet", "-m", "one"]);
  writeFileSync(join(dir, "a.txt"), "2\n");
  sh(dir, ["commit", "--quiet", "-am", "two"]);
  return dir;
}

/** a repo whose review root was moved: copies cut before the move stay in the old root */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "idd-wt-"));
  roots.push(root);
  const clone = gitRepo(join(root, "upstream"));
  const work = gitRepo(join(root, "work"));
  const oldRoot = join(root, "old-review-wt");
  const newRoot = join(root, "new-review-wt");
  const repo: LaneRepo = {
    name: "app", clone, work, github: "o/app", base: "main", remote: "", reviewRoot: oldRoot,
    copy: [], setup: [], checks: [], lanesRoot: join(root, "work-lanes"),
  };
  return { root, clone, work, oldRoot, newRoot, repo };
}

const listed = (clone: string) => sh(clone, ["worktree", "list", "--porcelain"]);

describe("a review copy recorded before the review root moved", () => {
  test("is removed with its meta from the old root, when its name and meta match the lane's record", () => {
    const f = fixture();
    const meta = addWorktree(f.repo, { rev: "HEAD", name: "REV-1", skipSetup: true });
    const moved = { ...f.repo, reviewRoot: f.newRoot };
    expect(removeWorktree(moved, meta.path, { force: true, recorded: { name: "REV-1" } })).toEqual({ removed: meta.path });
    expect(existsSync(meta.path)).toBe(false);
    expect(existsSync(join(f.oldRoot, "REV-1.json"))).toBe(false);
    expect(listed(f.clone)).not.toContain(meta.path);
  });

  test("is moved to a new head in place: its meta beside it is updated, none is left in the new root", () => {
    const f = fixture();
    const meta = addWorktree(f.repo, { rev: "HEAD~1", name: "REV-2", skipSetup: true });
    const moved = { ...f.repo, reviewRoot: f.newRoot };
    const head = sh(f.clone, ["rev-parse", "HEAD"]).trim();
    const next = moveWorktree(moved, meta.path, { rev: "HEAD", recorded: { name: "REV-2" } });
    expect(next.head).toBe(head);
    expect(sh(meta.path, ["rev-parse", "HEAD"]).trim()).toBe(head);
    expect(JSON.parse(readFileSync(join(f.oldRoot, "REV-2.json"), "utf8"))).toMatchObject({ path: meta.path, head, created_at: meta.created_at });
    expect(existsSync(join(f.newRoot, "REV-2.json"))).toBe(false);
  });

  test("without the lane's record, a path outside the review root is refused: by rm as before, and now by move too", () => {
    const f = fixture();
    const meta = addWorktree(f.repo, { rev: "HEAD", name: "REV-3", skipSetup: true });
    const moved = { ...f.repo, reviewRoot: f.newRoot };
    expect(() => removeWorktree(moved, meta.path, { force: true })).toThrow(/reviewRoot 配下ではありません/);
    expect(() => moveWorktree(moved, meta.path, { rev: "HEAD" })).toThrow(/reviewRoot 配下ではありません/);
    expect(existsSync(meta.path)).toBe(true);
  });

  test("a copy recorded under another name, or for another PR, is not the lane's", () => {
    const f = fixture();
    const meta = addWorktree(f.repo, { rev: "HEAD", name: "REV-4", skipSetup: true });
    const moved = { ...f.repo, reviewRoot: f.newRoot };
    expect(() => removeWorktree(moved, meta.path, { force: true, recorded: { name: "REV-5" } })).toThrow(/扱えません（名前が記録の REV-5 と違う）/);
    expect(() => removeWorktree(moved, meta.path, { force: true, recorded: { name: "REV-4", pr: 9 } })).toThrow(/扱えません（複製の記録の PR が #9 ではない）/);
    expect(existsSync(meta.path)).toBe(true);
    expect(existsSync(join(f.oldRoot, "REV-4.json"))).toBe(true);
  });
});

describe("what a recorded path never reaches", () => {
  const forge = (dir: string, name: string, repo: LaneRepo, path = join(dir, name)) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ path, repo: repo.name, head: "", base: "main", merge_base: "", created_at: "", setup: [] }));
  };

  test("the clones themselves", () => {
    const f = fixture();
    const moved = { ...f.repo, reviewRoot: f.newRoot };
    for (const clone of [f.clone, f.work]) {
      forge(join(clone, ".."), clone.split("/").pop() as string, moved, clone);
      expect(() => removeWorktree(moved, clone, { force: true, recorded: { name: clone.split("/").pop() as string } })).toThrow(`扱えません（${clone} の中にある）`);
      expect(() => moveWorktree(moved, clone, { rev: "HEAD~1", recorded: { name: clone.split("/").pop() as string } })).toThrow(`扱えません（${clone} の中にある）`);
      expect(existsSync(join(clone, ".git"))).toBe(true);
    }
    expect(sh(f.clone, ["symbolic-ref", "HEAD"]).trim()).toBe("refs/heads/main");
  });

  test("an Issue lane's worktree, even with a meta that names it", () => {
    const f = fixture();
    const moved = { ...f.repo, reviewRoot: f.newRoot };
    const lane = join(f.repo.lanesRoot, "REV-6");
    mkdirSync(f.repo.lanesRoot, { recursive: true });
    sh(f.work, ["worktree", "add", "--quiet", "-b", "feat/x", lane]);
    forge(f.repo.lanesRoot, "REV-6", moved);
    expect(() => removeWorktree(moved, lane, { force: true, recorded: { name: "REV-6" } })).toThrow(`扱えません（${f.repo.lanesRoot} の中にある）`);
    expect(existsSync(lane)).toBe(true);
    expect(listed(f.work)).toContain(lane);
  });

  test("a worktree made by hand outside the review root, with no meta of a review copy", () => {
    const f = fixture();
    const moved = { ...f.repo, reviewRoot: f.newRoot };
    const hand = join(f.root, "elsewhere", "REV-7");
    sh(f.clone, ["worktree", "add", "--quiet", "--detach", hand]);
    expect(() => removeWorktree(moved, hand, { force: true, recorded: { name: "REV-7" } })).toThrow(/扱えません（複製の記録 .* が読めない）/);
    expect(existsSync(hand)).toBe(true);
  });

  test("a directory with a meta but no worktree of either clone", () => {
    const f = fixture();
    const moved = { ...f.repo, reviewRoot: f.newRoot };
    const other = gitRepo(join(f.root, "other"));
    const stray = join(f.root, "stray", "REV-8");
    sh(other, ["worktree", "add", "--quiet", "--detach", stray]);
    forge(join(f.root, "stray"), "REV-8", moved);
    expect(() => removeWorktree(moved, stray, { force: true, recorded: { name: "REV-8" } })).toThrow(/扱えません（app の clone の worktree ではない）/);
    expect(existsSync(stray)).toBe(true);
  });
});

describe("a symlink is never taken for a copy", () => {
  const forge = (dir: string, name: string, repo: LaneRepo, path = join(dir, name)) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ path, repo: repo.name, head: "", base: "main", merge_base: "", created_at: "", setup: [] }));
  };

  test("outside the root: a link with the recorded name and a meta beside it does not reach the worktree it points to", () => {
    const f = fixture();
    const moved = { ...f.repo, reviewRoot: f.newRoot };
    const hand = join(f.root, "hand", "mine");
    sh(f.clone, ["worktree", "add", "--quiet", "--detach", hand]);
    writeFileSync(join(hand, "unsaved.txt"), "not committed\n");
    mkdirSync(f.oldRoot, { recursive: true });
    const link = join(f.oldRoot, "REV-9");
    symlinkSync(hand, link);
    forge(f.oldRoot, "REV-9", moved);
    expect(() => removeWorktree(moved, link, { force: true, recorded: { name: "REV-9" } })).toThrow(/扱えません（symlink）/);
    expect(() => moveWorktree(moved, link, { rev: "HEAD~1", recorded: { name: "REV-9" } })).toThrow(/扱えません（symlink）/);
    expect(readFileSync(join(hand, "unsaved.txt"), "utf8")).toBe("not committed\n");
    expect(listed(f.clone)).toContain(hand);
  });

  test("inside the root: a link to an Issue lane's worktree is refused, and the lane keeps its work", () => {
    const f = fixture();
    const lane = join(f.repo.lanesRoot, "feat-x");
    mkdirSync(f.repo.lanesRoot, { recursive: true });
    sh(f.work, ["worktree", "add", "--quiet", "-b", "feat/x", lane]);
    writeFileSync(join(lane, "wip.txt"), "wip\n");
    mkdirSync(f.oldRoot, { recursive: true });
    const link = join(f.oldRoot, "pr-1");
    symlinkSync(lane, link);
    expect(() => removeWorktree(f.repo, link, { force: true })).toThrow(/扱えません（symlink）/);
    expect(() => moveWorktree(f.repo, link, { rev: "HEAD~1" })).toThrow(/扱えません（symlink）/);
    expect(readFileSync(join(lane, "wip.txt"), "utf8")).toBe("wip\n");
    expect(listed(f.work)).toContain(lane);
  });

  test("inside the root: a linked directory that leads out of the root is refused", () => {
    const f = fixture();
    const lane = join(f.repo.lanesRoot, "feat-y");
    mkdirSync(f.repo.lanesRoot, { recursive: true });
    sh(f.work, ["worktree", "add", "--quiet", "-b", "feat/y", lane]);
    mkdirSync(f.oldRoot, { recursive: true });
    symlinkSync(f.repo.lanesRoot, join(f.oldRoot, "sub"));
    expect(() => removeWorktree(f.repo, join(f.oldRoot, "sub", "feat-y"), { force: true })).toThrow(/扱えません（reviewRoot の外にある）/);
    expect(existsSync(lane)).toBe(true);
  });
});

describe("an ordinary copy under today's root is handled as before", () => {
  test("rm (as `idd wt rm` calls it) takes the copy and its meta; a dirty copy needs --force", () => {
    const f = fixture();
    const meta = addWorktree(f.repo, { rev: "HEAD", name: "pr-2", skipSetup: true });
    writeFileSync(join(meta.path, "a.txt"), "changed\n");
    expect(() => removeWorktree(f.repo, meta.path, { force: false })).toThrow(/dirty/);
    expect(removeWorktree(f.repo, meta.path, { force: true })).toEqual({ removed: meta.path });
    expect(existsSync(meta.path)).toBe(false);
    expect(existsSync(join(f.oldRoot, "pr-2.json"))).toBe(false);
  });

  test("move checks out the new head and updates the meta", () => {
    const f = fixture();
    const meta = addWorktree(f.repo, { rev: "HEAD~1", name: "pr-3", skipSetup: true });
    const head = sh(f.clone, ["rev-parse", "HEAD"]).trim();
    expect(moveWorktree(f.repo, meta.path, { rev: "HEAD" }).head).toBe(head);
    expect(JSON.parse(readFileSync(join(f.oldRoot, "pr-3.json"), "utf8")).head).toBe(head);
  });

  test("a root reached through a link (the pipeline's copies) still takes its copies", () => {
    const f = fixture();
    const real = join(f.root, "real-root");
    mkdirSync(real);
    const linkedRoot = join(f.root, "linked-root");
    symlinkSync(real, linkedRoot);
    const repo = { ...f.repo, reviewRoot: linkedRoot };
    const meta = addWorktree(repo, { rev: "HEAD", name: "pr-4", skipSetup: true });
    expect(removeWorktree(repo, meta.path, { force: true })).toEqual({ removed: meta.path });
    expect(existsSync(join(real, "pr-4"))).toBe(false);
    expect(existsSync(join(real, "pr-4.json"))).toBe(false);
  });

  test("a root inside the work clone (a copy cut from a lane's worktree) still takes its copies", () => {
    const f = fixture();
    const repo = { ...f.repo, clone: f.work, reviewRoot: join(f.work, "state", "review-wt"), lanesRoot: f.work };
    const meta = addWorktree(repo, { rev: "HEAD", name: "run-1", skipSetup: true });
    expect(removeWorktree(repo, meta.path, { force: true })).toEqual({ removed: meta.path });
    expect(existsSync(meta.path)).toBe(false);
  });
});

describe("the meta of a copy", () => {
  test("a meta the old move wrote into the new root, naming the same copy, goes with the copy", () => {
    const f = fixture();
    const meta = addWorktree(f.repo, { rev: "HEAD", name: "REV-11", skipSetup: true });
    const moved = { ...f.repo, reviewRoot: f.newRoot };
    mkdirSync(f.newRoot, { recursive: true });
    writeFileSync(join(f.newRoot, "REV-11.json"), JSON.stringify({ ...meta }));
    writeFileSync(join(f.newRoot, "REV-12.json"), JSON.stringify({ ...meta, path: join(f.newRoot, "REV-12") }));
    removeWorktree(moved, meta.path, { force: true, recorded: { name: "REV-11" } });
    expect(existsSync(join(f.newRoot, "REV-11.json"))).toBe(false);
    expect(existsSync(join(f.newRoot, "REV-12.json"))).toBe(true);
  });

  test("a meta in the new root that names another copy stays", () => {
    const f = fixture();
    const meta = addWorktree(f.repo, { rev: "HEAD", name: "REV-13", skipSetup: true });
    const moved = { ...f.repo, reviewRoot: f.newRoot };
    mkdirSync(f.newRoot, { recursive: true });
    const other = { ...meta, path: join(f.newRoot, "REV-13") };
    writeFileSync(join(f.newRoot, "REV-13.json"), JSON.stringify(other));
    removeWorktree(moved, meta.path, { force: true, recorded: { name: "REV-13" } });
    expect(JSON.parse(readFileSync(join(f.newRoot, "REV-13.json"), "utf8")).path).toBe(other.path);
  });

  test("a meta that cannot be removed does not make the removed copy a failure", () => {
    const f = fixture();
    const meta = addWorktree(f.repo, { rev: "HEAD", name: "pr-5", skipSetup: true });
    // a directory where the meta file would be: removing it as a file fails
    rmSync(join(f.oldRoot, "pr-5.json"));
    mkdirSync(join(f.oldRoot, "pr-5.json", "x"), { recursive: true });
    expect(removeWorktree(f.repo, meta.path, { force: true })).toEqual({ removed: meta.path });
    expect(existsSync(meta.path)).toBe(false);
  });
});
