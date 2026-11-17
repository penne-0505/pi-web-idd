import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createHash } from "node:crypto";

import { load as yamlLoad } from "js-yaml";

import { STAGE_SLOT, STAGE_TASK, specRunPlans, startReviewRuns, stageTask, withoutRecords, writeMappedBlindSpecs } from "../src/review-runs.ts";
import { parseRoles } from "../src/roles.ts";
import { parseSpec, renderBrief, reportJsonSchema } from "../src/spec.ts";
import { incrementContext } from "../src/increment.ts";
import { addRecordlessCopy, manifestRowsAt, removeWorktree } from "../src/worktree.ts";
import { isOverlayPath } from "../../idd-core/src/overlay/manifest.ts";
import { solvingStandardNote, standardsPath } from "../../idd-core/src/rules/rules.ts";
import { INTENT_PURPOSE } from "../../idd-core/src/plan/prompt-text.ts";
import { changedSinceBase } from "../src/gate.ts";
import { repoForPath, type LaneRepo } from "../src/repos.ts";
import { isolateRepos, ownRepos } from "./helpers/repos.ts";
import { tmpDir } from "./helpers/tmp.ts";

// the registry these tests read is their own, and no IDD_REPOS_FILE they set outlives them
isolateRepos();

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** what only a record carries: if it turns up anywhere in a recordless copy, a record leaked */
const SECRETS = ["OLD-PLAN-SECRET", "NEW-PLAN-SECRET", "QA-SECRET", "TODO-SECRET", "CONTEXT-SECRET"];

const MANIFEST = ["# overlay manifest", "_docs/plan/", "_docs/qa/", "_docs/context/", "TODO.md", "overlay.manifest", ""].join("\n");

/** a registry with no repo, so startReviewRuns reads this and not the config/repos.yaml of whoever runs the tests */
function emptyRepos(state: string): string {
  const path = join(state, "repos.yaml");
  writeFileSync(path, "repos: {}\n");
  return path;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

function commit(dir: string, files: Record<string, string>, message: string): string {
  write(dir, files);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", message);
  return sh(dir, "rev-parse", "HEAD").trim();
}

/** a lane worktree whose base already holds a past lane's records and whose head adds this lane's own */
function laneRepo() {
  const root = tmpDir("idd-recordless-");
  const wt = join(root, "wt");
  mkdirSync(wt, { recursive: true });
  sh(wt, "init", "-q", "-b", "main");
  const base = commit(wt, {
    "overlay.manifest": MANIFEST,
    "AGENTS.md": "# rules\n",
    "src/a.ts": "export const a = 1;\n",
    "_docs/plan/old/plan.md": "OLD-PLAN-SECRET\n",
  }, "base");
  const reviewed = commit(wt, { "src/a.ts": "export const a = 2;\n", "_docs/qa/x/qa.md": "QA-SECRET\n" }, "reviewed with a record");
  const head = commit(wt, {
    "src/a.ts": "export const a = 3;\n",
    "src/b.test.ts": "import { a } from './a.ts';\n",
    "_docs/plan/x/plan.md": "NEW-PLAN-SECRET\n",
    "_docs/context/x/context.md": "CONTEXT-SECRET\n",
    "TODO.md": "TODO-SECRET\n",
  }, "docs(records): the lane's records");
  const repo: LaneRepo = { name: "app", clone: wt, work: wt, base: "main", remote: "", reviewRoot: join(root, "review-wt"), copy: [], setup: [], checks: [], lanesRoot: wt };
  return { root, wt, repo, base, reviewed, head };
}

/** every object the copy's repository holds, read as text */
function allObjectText(copy: string): string[] {
  const rows = sh(copy, "cat-file", "--batch-all-objects", "--batch-check").trim().split("\n").filter(Boolean);
  return rows.map((row) => {
    const [sha, type] = row.split(" ");
    return type === "blob" || type === "commit" || type === "tree" ? sh(copy, "cat-file", "-p", sha) : "";
  });
}

describe("a copy with the records taken out", () => {
  test("reads the manifest of the revs it is cut from, and none when no rev has one", () => {
    const f = laneRepo();
    expect(manifestRowsAt(f.wt, [f.head, f.base])).toEqual(["_docs/plan/", "_docs/qa/", "_docs/context/", "TODO.md", "overlay.manifest"]);
    const bare = tmpDir("idd-recordless-bare-");
    sh(bare, "init", "-q", "-b", "main");
    const only = commit(bare, { "a.txt": "1\n" }, "one");
    expect(manifestRowsAt(bare, [only])).toEqual([]);
  });

  test("holds no record in its working tree, its diff between base and head, its refs, its commits or its objects", () => {
    const f = laneRepo();
    const rows = manifestRowsAt(f.wt, [f.head, f.base]);
    const made = addRecordlessCopy(f.repo, { name: "blind-1", revs: { base: f.base, head: f.head, laneBase: f.base }, rows, head: "head" });
    const copy = made.meta.path;
    // the working tree
    expect(existsSync(join(copy, "_docs"))).toBe(false);
    expect(existsSync(join(copy, "TODO.md"))).toBe(false);
    expect(existsSync(join(copy, "overlay.manifest"))).toBe(false);
    expect(readFileSync(join(copy, "src/a.ts"), "utf8")).toBe("export const a = 3;\n");
    // what is not a record is read as before: the rules and the code
    expect(readFileSync(join(copy, "AGENTS.md"), "utf8")).toBe("# rules\n");
    // the diff from both sides: a record the base holds does not appear as a deletion either
    const diff = sh(copy, "diff", made.refs.base, made.refs.head);
    expect(diff).toContain("+export const a = 3;");
    expect(diff).not.toContain("_docs");
    expect(diff).not.toContain("TODO.md");
    expect(sh(copy, "diff", "--name-only", made.refs.laneBase, made.refs.head).trim().split("\n").sort()).toEqual(["src/a.ts", "src/b.test.ts"]);
    // the refs, the commits and the objects
    // every ref names a commit the copy made, none of the lane's own, and its name carries no record
    const refRows = sh(copy, "for-each-ref", "--format=%(objectname) %(refname)").trim().split("\n").filter(Boolean);
    const copyCommits = new Set(Object.values(made.refs));
    expect(refRows.length).toBeGreaterThan(0);
    for (const row of refRows) {
      const [sha, name] = row.split(" ");
      expect(copyCommits.has(sha)).toBe(true);
      for (const secret of SECRETS) expect(name).not.toContain(secret);
    }
    expect(sh(copy, "log", "--all", "--format=%H %s").trim().split("\n").every((line) => line.endsWith("review copy"))).toBe(true);
    const text = [sh(copy, "log", "--all", "--format=%B"), ...allObjectText(copy)].join("\n");
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    // the lane's own commits are not in the copy's store at all
    for (const real of [f.base, f.reviewed, f.head]) expect(gitTry(copy, "cat-file", "-e", real)).toBe(false);
    // and the copy is clean as a reviewer leaves it
    expect(sh(copy, "status", "--short").trim()).toBe("");
  });

  test("keeps every rev the brief names readable after a prune, and finds the base as the merge base of its head (C-238-1)", () => {
    const f = laneRepo();
    const rows = manifestRowsAt(f.wt, [f.head, f.base]);
    const made = addRecordlessCopy(f.repo, { name: "blind-prune", revs: { base: f.reviewed, head: f.head, laneBase: f.base }, rows, head: "head" });
    const copy = made.meta.path;
    sh(copy, "reflog", "expire", "--expire=now", "--all");
    sh(copy, "prune", "--expire=now");
    sh(copy, "gc", "--prune=now", "--quiet");
    for (const rev of Object.values(made.refs)) expect(sh(copy, "cat-file", "-t", rev).trim()).toBe("commit");
    // the registered name of the base is not known to this fixture, so the merge base is asked of the ref the copy keeps for the lane's origin
    expect(sh(copy, "merge-base", "refs/idd/rev/laneBase", "HEAD").trim()).toBe(made.refs.laneBase);
    expect(sh(copy, "diff", "--name-only", made.refs.laneBase, "HEAD").trim().split("\n").sort()).toEqual(["src/a.ts", "src/b.test.ts"]);
  });

  test("an incremental round's copy lists the lane's whole change, as the worktree does less the paths it took out (C-238-1)", () => {
    const f = laneRepo();
    const rows = manifestRowsAt(f.wt, [f.head, f.base]);
    // the previous head is the `base` of the round and the lane's origin its `laneBase`
    const made = addRecordlessCopy(f.repo, { name: "blind-incr", revs: { base: f.reviewed, head: f.head, laneBase: f.base }, rows, head: "head" });
    const copy = made.meta.path;
    const listed = (dir: string, from: string) => sh(dir, "diff", "--no-renames", "--name-only", "--diff-filter=d", from, "HEAD").trim().split("\n").sort();
    // the fixture registers no base name, so the ref the registry would name is placed by hand: where the list looks for the root
    expect(listed(copy, sh(copy, "merge-base", "refs/idd/rev/laneBase", "HEAD").trim())).toEqual(listed(f.wt, f.base).filter((p) => !isOverlayPath(rows, p)));
    expect(listed(copy, sh(copy, "merge-base", "refs/idd/rev/laneBase", "HEAD").trim())).toEqual(["src/a.ts", "src/b.test.ts"]);
    // the root is the origin, not the previous head, and the diff of the round itself is read from the trees
    expect(sh(copy, "rev-list", "--max-parents=0", "HEAD").trim()).toBe(made.refs.laneBase);
    expect(sh(copy, "diff", "--name-only", made.refs.base, made.refs.head).trim()).toBe("src/a.ts\nsrc/b.test.ts");
  });

  test("a lane cut from a mainline ahead of the public base lists what the worktree lists, the inherited change too, less the paths it took out (C-238-1)", () => {
    const f = laneRepo();
    // the public base is the fixture's first commit; the work clone's mainline has moved on from it, and the lane was cut there
    const publicRef = `refs/idd/public/${createHash("sha256").update(JSON.stringify("main")).digest("hex")}`;
    sh(f.wt, "update-ref", publicRef, f.base);
    sh(f.wt, "branch", "-m", "main", "mainline");
    const mainline = commit(f.wt, { "src/m.ts": "export const m = 1;\n", "_docs/plan/m/plan.md": "OLD-PLAN-SECRET\n" }, "mainline moved on");
    const own = commit(f.wt, { "src/l.ts": "export const l = 1;\n" }, "the lane's own change");
    ownRepos([
      "repos:",
      "  me/app:",
      `    upstream: ${f.wt}`,
      `    work: ${f.wt}`,
      "    remote: \"\"",
      "    public_base: main",
      `    review_root: ${f.repo.reviewRoot}`,
      `    lanes_root: ${join(f.root, "lanes")}`,
    ].join("\n") + "\n");
    const registered = repoForPath(f.wt)!;
    const rows = manifestRowsAt(f.wt, [own, f.base, mainline]);
    const inWorktree = changedSinceBase(f.wt, registered)!;
    expect(inWorktree).toContain("src/m.ts");
    const expected = inWorktree.filter((p) => !isOverlayPath(rows, p)).sort();
    // a first round (`base` is the mainline) and an incremental one (`base` is the previous head): the same list
    for (const [name, base] of [["whole", mainline], ["incr", f.head]] as const) {
      const made = addRecordlessCopy({ ...registered, clone: f.wt, base }, { name: `blind-ahead-${name}`, revs: { base, head: own, laneBase: mainline }, rows, head: "head" });
      const copy = made.meta.path;
      expect((changedSinceBase(copy, registered) ?? []).sort()).toEqual(expected);
      // the root is where the worktree starts its list, kept under the registered name
      expect(sh(copy, "rev-parse", "refs/heads/main").trim()).toBe(sh(copy, "rev-list", "--max-parents=0", "HEAD").trim());
      expect(sh(copy, "diff", "--name-only", made.refs.base, made.refs.head).trim()).not.toBe("");
      sh(copy, "reflog", "expire", "--expire=now", "--all");
      sh(copy, "gc", "--prune=now", "--quiet");
      for (const rev of Object.values(made.refs)) expect(sh(copy, "cat-file", "-t", rev).trim()).toBe("commit");
      // the root's tree is stripped as well: a record only an old tree holds does not appear
      const text = [sh(copy, "log", "--all", "--format=%B"), ...allObjectText(copy)].join("\n");
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
  });

  test("holds a merge as a merge of its two parents, so its resolution is read with `git show --cc`", () => {
    const f = laneRepo();
    sh(f.wt, "checkout", "-q", "-b", "side", f.base);
    const sideHead = commit(f.wt, { "src/side.ts": "export const s = 1;\n", "_docs/plan/side/plan.md": "NEW-PLAN-SECRET\n" }, "side");
    sh(f.wt, "checkout", "-q", "main");
    sh(f.wt, "merge", "-q", "--no-edit", "side");
    const merge = sh(f.wt, "rev-parse", "HEAD").trim();
    const rows = manifestRowsAt(f.wt, [merge]);
    const made = addRecordlessCopy(f.repo, { name: "blind-merge", revs: { base: f.base, head: merge, merge }, rows, head: "head" });
    expect(sh(made.meta.path, "rev-list", "--parents", "-n", "1", made.refs.merge).trim().split(" ").length).toBe(3);
    expect(sh(made.meta.path, "show", "--cc", made.refs.merge)).not.toContain("_docs");
    // the merge's parents descend from the base too, so the base is what the copy's git finds as the merge base
    expect(sh(made.meta.path, "merge-base", made.refs.base, "HEAD").trim()).toBe(made.refs.base);
    void sideHead;
  });

  test("takes out a record only the merge or one of its parents lists, from every tree the copy keeps", () => {
    const f = laneRepo();
    sh(f.wt, "checkout", "-q", "-b", "side", f.base);
    commit(f.wt, { "overlay.manifest": `${MANIFEST}notes/\n`, "notes/n.md": "MERGE-ONLY-SECRET\n", "src/side.ts": "export const s = 1;\n" }, "side");
    sh(f.wt, "checkout", "-q", "-B", "lane", f.head);
    sh(f.wt, "merge", "-q", "--no-edit", "side");
    const merge = sh(f.wt, "rev-parse", "HEAD").trim();
    // neither the lane's head nor its base lists `notes/`: only the merge and the side parent do
    expect(manifestRowsAt(f.wt, [f.head, f.base])).not.toContain("notes/");
    const rows = manifestRowsAt(f.wt, [f.head, f.base, merge]);
    expect(rows).toContain("notes/");
    const made = addRecordlessCopy(f.repo, { name: "blind-merge-only", revs: { base: f.base, head: merge, merge }, rows, head: "head" });
    expect(existsSync(join(made.meta.path, "notes"))).toBe(false);
    expect(sh(made.meta.path, "show", "--cc", made.refs.merge)).not.toContain("MERGE-ONLY-SECRET");
    expect([sh(made.meta.path, "log", "--all", "--format=%B"), ...allObjectText(made.meta.path)].join("\n")).not.toContain("MERGE-ONLY-SECRET");
  });

  test("is taken down by the removal every copy goes through, the repository and its meta with it", () => {
    const f = laneRepo();
    const rows = manifestRowsAt(f.wt, [f.head]);
    const made = addRecordlessCopy(f.repo, { name: "blind-rm", revs: { base: f.base, head: f.head }, rows, head: "head" });
    expect(existsSync(join(f.repo.reviewRoot, "blind-rm.json"))).toBe(true);
    expect(removeWorktree(f.repo, made.meta.path, { force: true })).toEqual({ removed: made.meta.path });
    expect(existsSync(made.meta.path)).toBe(false);
    expect(existsSync(join(f.repo.reviewRoot, "blind-rm.json"))).toBe(false);
    // the lane's own repository is untouched
    expect(sh(f.wt, "rev-parse", "HEAD").trim()).toBe(f.head);
  });

  test("ignores what the lane's repository ignores in its own exclude, so the link the setup makes leaves it clean, and names no record there", () => {
    const f = laneRepo();
    // the work clone ignores the node_modules link there (a directory pattern in .gitignore does not match a link);
    // its exclude also names a record's place, which the copy must not pass on
    appendFileSync(join(f.wt, ".git", "info", "exclude"), "node_modules\n/_docs/plan/x/\n_docs\n");
    // the copy is cut from the lane's linked worktree, as a review round cuts it
    const lane = join(f.root, "lane-wt");
    sh(f.wt, "worktree", "add", "-q", "--detach", lane, f.head);
    const made = addRecordlessCopy({ ...f.repo, clone: lane }, { name: "blind-link", revs: { base: f.base, head: f.head }, rows: manifestRowsAt(lane, [f.head, f.base]), head: "head" });
    symlinkSync(f.wt, join(made.meta.path, "node_modules"));
    expect(sh(made.meta.path, "status", "--short").trim()).toBe("");
    const copied = readFileSync(join(made.meta.path, ".git", "info", "exclude"), "utf8");
    expect(copied).toContain("node_modules");
    expect(copied).not.toContain("_docs");
  });

  test("a failed cut leaves no half-made copy behind", () => {
    const f = laneRepo();
    expect(() => addRecordlessCopy(f.repo, { name: "blind-bad", revs: { base: f.base, head: f.head }, rows: ["TODO.md"], head: "nothead" })).toThrow();
    expect(existsSync(join(f.repo.reviewRoot, "blind-bad"))).toBe(false);
  });

  test("the increment context names no record, nor a function a record's hunk mentions", () => {
    const f = laneRepo();
    const rows = manifestRowsAt(f.wt, [f.head]);
    const withRecords = incrementContext(f.wt, { base: f.reviewed, head: f.head, laneBase: f.base });
    expect(withRecords.laneFiles.some((p) => p.startsWith("_docs/") || p === "TODO.md")).toBe(true);
    const stripped = incrementContext(f.wt, { base: f.reviewed, head: f.head, laneBase: f.base, omit: rows });
    expect(stripped.laneFiles.sort()).toEqual(["src/a.ts", "src/b.test.ts"]);
    expect(stripped.covered.every((p) => !p.startsWith("_docs/"))).toBe(true);
  });
});

function gitTry(cwd: string, ...args: string[]): boolean {
  try { sh(cwd, ...args); return true; } catch { return false; }
}

const ROLES = [
  "models:",
  "  x-v:",
  "    model: x/v",
  "  x-s:",
  "    model: x/s",
  "  x-j:",
  "    model: x/j",
  "roles:",
  "  v: { model: x-v, report: review }",
  "  s: { model: x-s, report: review }",
  "  judge: { model: x-j, report: triage }",
  "  conf: { model: x-j, report: confirm }",
  "pipeline:",
].join("\n");

describe("the spec check a blind round starts beside its blinds", () => {
  const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_ROLES_FILE: process.env.IDD_ROLES_FILE, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  function setup(pipeline: string) {
    const state = tmpDir("idd-spec-state-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    process.env.IDD_REPOS_FILE = emptyRepos(state);
    writeFileSync(process.env.IDD_ROLES_FILE, `${ROLES}\n${pipeline}\n`);
    const f = laneRepo();
    const specs: string[] = [];
    const copies: { name: string; path: string }[] = [];
    const recordless: string[] = [];
    const deps = {
      addWorktree: (_repo: unknown, o: { name: string }) => { const path = f.wt; copies.push({ name: o.name, path }); return { path } as never; },
      addRecordlessCopy: (repo: LaneRepo, o: Parameters<typeof addRecordlessCopy>[1]) => { recordless.push(o.name); return addRecordlessCopy(repo, o); },
      removeWorktree: () => {},
      runLane: async (p: string) => { specs.push(p); return { id: `L${specs.length}` } as never; },
      stopLane: () => ({}) as never,
    };
    const read = (i: number) => yamlLoad(readFileSync(specs[i], "utf8")) as { stage: string; role: string; worktree: string; diff: { base: string; head: string; laneBase?: string; increment?: boolean; merge?: string }; inputs: string[]; task: string; overview?: string; report: string };
    return { ...f, specs, copies, recordless, deps, read };
  }

  test("is a stage and a slot of its own, apart from the confirm's", () => {
    expect(STAGE_SLOT.spec).toBe("spec_check");
    expect(STAGE_SLOT.confirm).toBe("confirm");
    expect(STAGE_SLOT.feedback_confirm).toBe("confirm");
    // the confirm's wording is the one it always had
    expect(STAGE_TASK.confirm).toMatch(/確かめる指摘の一覧（confirm-<巡>\.md）/);
    expect(STAGE_TASK.spec).not.toMatch(/confirm-<巡>/);
  });

  test("its brief reads the plan, the criteria, the Choices and the Purposes, and names no earlier finding or fix", () => {
    const task = stageTask("spec");
    expect(task).toBe(STAGE_TASK.spec);
    expect(task).toContain(INTENT_PURPOSE);
    for (const word of ["plan.md", "qa.md", "Choice", "Purpose", "repo の概要"]) expect(task).toContain(word);
    expect(task).toMatch(/前の巡の指摘と前の巡の修正の一覧は渡されない/);
    // the lines penne drew on a stuck card are the lane's scope: the check does not ask for what penne put off
    expect(task).toMatch(/人が決めた線引き（human-lines-\*\.md、あれば）/);
    expect(task).toMatch(/人が見送る・後に回すと決めた指摘と境目は、計画と同じくこの lane の仕様として読み、同じ性質の指摘を出さない/);
    // so are the questions a judgement put to penne, with her answers (IDD-292's round 6 asked round 4's question again)
    expect(task).toMatch(/判定が人に尋ね人が答えた問いの答えも、計画と同じくこの lane の仕様として読み、答えと逆を求める指摘を出さない/);
    expect(task).toMatch(/問いの外の部分は答えとして読まない。答えを、それ以外の指摘を出す根拠にも出さない根拠にもしない/);
    // the blind is never told of them (DEC-113-5)
    expect(STAGE_TASK.blind).not.toMatch(/human-lines|線引き/);
    // the two things a finding is a must for, whatever its frequency, as the judgement's table says
    expect(task).toMatch(/既存の active な Choice の why と逆向きの実装と、主な経路の AC 未達は、頻度に関わらず must/);
    // it asks for the blind's report format with how
    expect(task).toMatch(/各指摘に how/);
    const schema = reportJsonSchema("review", "spec");
    expect(schema).toContain('"how"');
    expect(schema).toContain('"action"');
    expect(schema).toContain('"frequency"');
    expect(schema).toBe(reportJsonSchema("review", "blind"));
  });

  test("a v1 lane's spec check is told it reads decision.md, and a v2 lane's brief is the one it always had", () => {
    const v1 = stageTask("spec", { recordsShape: "docs" });
    expect(v1).toContain("decision.md");
    expect(v1).not.toMatch(/lane の Choice|lane の Purpose/);
    expect(v1).toMatch(/既存の active な Choice の why と逆向きの実装と、主な経路の AC 未達は、頻度に関わらず must/);
    expect(stageTask("spec", { recordsShape: "state" })).toBe(STAGE_TASK.spec);
  });

  test("the lines penne drew reach the spec check's spec.yaml and never a blind's (DEC-113-5)", async () => {
    const f = setup("  review_blind: { roles: [v] }\n  spec_check: { role: s }\n");
    try {
      const lines = join(f.root, "human-lines-4-blind.md");
      writeFileSync(lines, "# 人が決めた線引き\n");
      await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 4, worktree: f.wt, base: f.base, head: f.head, inputs: [], spec: { count: 1, inputs: [lines] } }, f.deps);
      const read = f.specs.map((_, i) => f.read(i));
      const spec = read.filter((s) => s.stage === "spec");
      const blinds = read.filter((s) => s.stage === "blind");
      expect(spec.length).toBe(1);
      expect(blinds.length).toBe(1);
      expect(spec[0].inputs).toContain(lines);
      for (const b of blinds) expect(b.inputs.filter((p) => /human-lines/.test(p))).toEqual([]);
    } finally { restore(); }
  });

  test("a depth-bearing round starts one spec check on the lane's whole change, with the inputs it was handed and none of the blinds'", async () => {
    const f = setup("  review_blind: { roles: [v] }\n  spec_check: { role: s }\n");
    try {
      const plan = join(f.root, "plan.md");
      writeFileSync(plan, "plan\n");
      const res = await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 2, worktree: f.wt, base: f.base, head: f.head, inputs: [], overview: "概要の 1 文", spec: { count: 1, inputs: [plan, join(f.root, "gone.md")] } }, f.deps);
      expect(f.specs.length).toBe(2);
      expect(res.runIds).toEqual(["L1", "L2"]);
      // the spec check comes after the blinds, so the roles of the blinds keep their places, and the fold tells it by its label
      expect(res.runRoles).toEqual(["v", "s"]);
      expect(res.runLabels).toEqual(["", "spec"]);
      const blind = f.read(0);
      const spec = f.read(1);
      expect(blind.stage).toBe("blind");
      expect(spec.stage).toBe("spec");
      expect(spec.role).toBe("s");
      // this tree keeps no solving.md (a recordless one would not hold _docs), so each task ends with where the original is
      expect(spec.task).toBe(`${STAGE_TASK.spec}\n${solvingStandardNote(spec.worktree)}`);
      expect(blind.task).toBe(`${STAGE_TASK.blind}\n${solvingStandardNote(blind.worktree)}`);
      // the same head, in a report directory of its own
      expect(spec.diff.head).not.toBe("");
      expect(spec.report).not.toBe(blind.report);
      expect(spec.report).toMatch(/2-spec-s-/);
      // what it reads: the inputs it was handed (the ones that exist), and the repo's overview
      // (and the original of the standard its task names, since this tree keeps none)
      expect(spec.inputs).toEqual([plan, join(standardsPath(), "solving.md")]);
      expect(spec.overview).toBe("概要の 1 文");
      // the blind is handed none of them (only the original of the standard its task names)
      expect(blind.inputs).toEqual([join(standardsPath(), "solving.md")]);
      expect(blind.task).not.toContain("plan.md");
      // the brief a spec role reads
      const brief = renderBrief(parseSpec(readFileSync(f.specs[1], "utf8"), dirname(f.specs[1])), { name: "s", harness: "pi", model: "x/s", thinking: "high", tools: ["read"], policy: [], report: "review", requireClean: true, budgetMinutes: 5, contextFiles: true, maxResumes: 0 } as never);
      expect(brief).toContain("<input>" + plan + "</input>");
      expect(brief).toContain("<overview>概要の 1 文</overview>");
    } finally { restore(); }
  });

  test("reads the whole lane change even when the round shown to its blinds is only the fixes since the last round", async () => {
    const f = setup("  review_blind: { roles: [v], high_risk_extra: [v] }\n  spec_check: { role: s }\n");
    try {
      await startReviewRuns({ iddId: "IDD-1", stage: "final", round: 3, worktree: f.wt, base: f.reviewed, head: f.head, inputs: [], scope: "increment", laneBase: f.base, onlyHighRisk: true, spec: { count: 1, inputs: [] } }, f.deps);
      expect(f.specs.length).toBe(2);
      const spec = f.read(1);
      expect(spec.stage).toBe("spec");
      // the real shas: the spec check is not given a copy with the records taken out
      expect(spec.diff).toEqual({ base: f.base, head: f.head });
      expect(f.copies.length).toBe(1);
      expect(f.recordless.length).toBe(1);
    } finally { restore(); }
  });

  /** a lane that rewrote its rules in an earlier round: `start` is where the lane began, `mid` the last reviewed head */
  function ruleLane() {
    const wt = join(tmpDir("idd-spec-rules-"), "wt");
    mkdirSync(wt, { recursive: true });
    sh(wt, "init", "-q", "-b", "main");
    const start = commit(wt, {
      "AGENTS.md": "# rules at the start\n",
      ".claude/rules/src.md": "---\npaths: [\"src/**\"]\n---\n# src rule at the start\n",
      ".claude/rules/docs.md": "---\npaths: [\"docs/**\"]\n---\n# docs rule at the start\n",
      "src/a.ts": "export const a = 1;\n",
    }, "start");
    const mid = commit(wt, {
      "AGENTS.md": "# rules rewritten by the lane\n",
      ".claude/rules/src.md": "---\npaths: [\"src/**\"]\n---\n# src rule rewritten by the lane\n",
      "docs/x.md": "x\n",
      "src/a.ts": "export const a = 2;\n",
    }, "mid");
    const head = commit(wt, { "src/a.ts": "export const a = 3;\n" }, "head");
    return { wt, start, mid, head };
  }
  const bodyOf = (rule: string) => readFileSync(rule, "utf8");

  test("reads the rules of the version the lane started at, and the ones the whole lane change matches", async () => {
    const f = setup("  review_blind: { roles: [v], high_risk_extra: [v] }\n  spec_check: { role: s }\n");
    try {
      const r = ruleLane();
      await startReviewRuns({ iddId: "IDD-1", stage: "final", round: 3, worktree: r.wt, base: r.mid, head: r.head, inputs: [], scope: "increment", laneBase: r.start, onlyHighRisk: true, spec: { count: 1, inputs: [] } }, f.deps);
      const spec = f.read(1) as unknown as { diff: { base: string }; rules: string[] };
      expect(spec.diff.base).toBe(r.start);
      // docs/x.md was changed in an earlier round: only the whole lane change matches the docs rule
      const names = spec.rules.map((x) => x.replace(/^.*\/base-rules\//, ""));
      expect(names).toEqual(["AGENTS.md", ".claude/rules/docs.md", ".claude/rules/src.md"]);
      // a rule the lane rewrote is handed as the lane started with it; one it did not touch is read from the tree
      expect(bodyOf(spec.rules[0])).toBe("# rules at the start\n");
      expect(bodyOf(spec.rules[2])).toContain("# src rule at the start");
      expect(spec.rules[1]).toBe(".claude/rules/docs.md");
    } finally { restore(); }
  });

  test("the blind and the last review read their rules from the round's base, and a round that is not an increment reads the spec check's from its own", async () => {
    const f = setup("  review_blind: { roles: [v], high_risk_extra: [v] }\n  spec_check: { role: s }\n");
    try {
      const r = ruleLane();
      await startReviewRuns({ iddId: "IDD-1", stage: "final", round: 3, worktree: r.wt, base: r.mid, head: r.head, inputs: [], scope: "increment", laneBase: r.start, onlyHighRisk: true, spec: { count: 1, inputs: [] } }, f.deps);
      const blind = f.read(0) as unknown as { rules: string[] };
      // the round's base already holds the lane's rewrite, and the head did not touch the rules: they are handed as they are
      expect(blind.rules).toEqual(["AGENTS.md", ".claude/rules/src.md"]);
      await startReviewRuns({ iddId: "IDD-1", stage: "final", round: 1, worktree: r.wt, base: r.start, head: r.head, inputs: [], onlyHighRisk: true, spec: { count: 1, inputs: [] } }, f.deps);
      const whole = f.read(3) as unknown as { diff: { base: string }; rules: string[] };
      expect(whole.diff.base).toBe(r.start);
      // not an increment: the spec check starts where the round does, which is where the lane did
      expect(whole.rules.map((x) => x.replace(/^.*\/base-rules\//, ""))).toEqual(["AGENTS.md", ".claude/rules/docs.md", ".claude/rules/src.md"]);
      expect(bodyOf(whole.rules[0])).toBe("# rules at the start\n");
    } finally { restore(); }
  });

  test("a lane start it cannot read is a warning and the check still starts", async () => {
    const f = setup("  review_blind: { roles: [v], high_risk_extra: [v] }\n  spec_check: { role: s }\n");
    try {
      const r = ruleLane();
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
      try {
        await startReviewRuns({ iddId: "IDD-1", stage: "final", round: 3, worktree: r.wt, base: r.mid, head: r.head, inputs: [], scope: "increment", laneBase: "0123456789abcdef0123456789abcdef01234567", onlyHighRisk: true, spec: { count: 1, inputs: [] } }, f.deps);
      } finally { console.warn = warn; }
      expect(f.specs.length).toBe(2);
      expect(warned.some((w) => w.includes("spec"))).toBe(true);
    } finally { restore(); }
  });

  test("a round without a spec count starts none, and a runner without the slot fails the start instead of dropping the check", async () => {
    const f = setup("  review_blind: { roles: [v] }\n");
    try {
      await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: f.wt, base: f.base, head: f.head, inputs: [] }, f.deps);
      expect(f.specs.length).toBe(1);
      let caught: unknown;
      try { await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: f.wt, base: f.base, head: f.head, inputs: [], spec: { count: 1, inputs: [] } }, f.deps); } catch (err) { caught = err; }
      expect(String(caught)).toMatch(/spec_check/);
      // nothing was started by the failed one
      expect(f.specs.length).toBe(1);
    } finally { restore(); }
  });

  test("the slot's role has to write the review format", async () => {
    const f = setup("  review_blind: { roles: [v] }\n  spec_check: { role: conf }\n");
    try {
      let caught: unknown;
      try { await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: f.wt, base: f.base, head: f.head, inputs: [], spec: { count: 1, inputs: [] } }, f.deps); } catch (err) { caught = err; }
      expect(String(caught)).toMatch(/report: confirm/);
      expect(f.specs.length).toBe(0);
    } finally { restore(); }
  });

  test("takes its runs from the slot in order, as many as the depth table says, and the slot's models each make a run", () => {
    const roles = parseRoles(`${ROLES}\n  spec_check: { role: s, models: [x-v, x-s] }\n`);
    const plans = specRunPlans(roles.pipeline.spec_check, 1);
    expect(plans.map((p) => [p.stage, p.label, p.role, p.model])).toEqual([["spec", "spec", "s", "x-v"]]);
    expect(specRunPlans(roles.pipeline.spec_check, 5).length).toBe(2);
    expect(specRunPlans(roles.pipeline.spec_check, 0)).toEqual([]);
  });
});

describe("the blind and the last review are cut without the records", () => {
  const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_ROLES_FILE: process.env.IDD_ROLES_FILE, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  function setup() {
    const state = tmpDir("idd-recordless-state-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    process.env.IDD_REPOS_FILE = emptyRepos(state);
    writeFileSync(process.env.IDD_ROLES_FILE, `${ROLES}\n  review_blind: { roles: [v], high_risk_extra: [v] }\n  spec_check: { role: s }\n  confirm: { role: conf }\n  triage: { role: judge }\n`);
    return { state, ...laneRepo() };
  }
  const depsFor = (f: ReturnType<typeof setup>) => {
    const specs: string[] = [];
    const linked: string[] = [];
    const cut: string[] = [];
    const deps = {
      addWorktree: (_r: unknown, o: { name: string }) => { linked.push(o.name); return { path: f.wt } as never; },
      addRecordlessCopy: (repo: LaneRepo, o: Parameters<typeof addRecordlessCopy>[1]) => { cut.push(o.name); return addRecordlessCopy(repo, o); },
      removeWorktree: () => {},
      runLane: async (p: string) => { specs.push(p); return { id: `L${specs.length}` } as never; },
      stopLane: () => ({}) as never,
    };
    return { specs, linked, cut, deps };
  };
  const readSpec = (path: string) => yamlLoad(readFileSync(path, "utf8")) as { worktree: string; diff: { base: string; head: string; laneBase?: string }; inputs: string[] };

  test("a blind and a final each read a copy of its own with no record, and are told that copy's revs", async () => {
    const f = setup();
    try {
      const d = depsFor(f);
      await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: f.wt, base: f.base, head: f.head, inputs: [] }, d.deps);
      await startReviewRuns({ iddId: "IDD-1", stage: "final", round: 2, worktree: f.wt, base: f.reviewed, head: f.head, inputs: [], scope: "increment", laneBase: f.base, extras: ["high_risk"] }, d.deps);
      // one copy for each run: the blind's, and the final's (the high-risk extra is the same role and model, so one run)
      expect(d.cut.length).toBe(2);
      expect(d.linked).toEqual([]);
      for (const path of d.specs) {
        const spec = readSpec(path);
        expect(existsSync(join(spec.worktree, "_docs"))).toBe(false);
        // the diff the brief names is between the copy's commits, and has no record
        expect(sh(spec.worktree, "diff", spec.diff.base, spec.diff.head)).not.toContain("_docs");
        expect(spec.diff.head).not.toBe(f.head);
        if (spec.diff.laneBase) expect(sh(spec.worktree, "diff", "--name-only", spec.diff.laneBase, spec.diff.head)).not.toContain("_docs");
        // an increment's context file names no record
        for (const input of spec.inputs) for (const secret of SECRETS) expect(readFileSync(input, "utf8")).not.toContain(secret);
      }
      const context = d.specs.map(readSpec).flatMap((s) => s.inputs).find((p) => /increment-2-/.test(p));
      expect(readFileSync(context!, "utf8")).not.toContain("_docs/");
    } finally { restore(); }
  });

  test("a review lane's blind is cut the same way, and is given no spec check", async () => {
    const f = setup();
    try {
      const d = depsFor(f);
      const res = await startReviewRuns({ iddId: "R-1", stage: "blind", round: 1, worktree: f.wt, base: f.base, head: f.head, inputs: [], laneKind: "review" }, d.deps);
      expect(d.cut.length).toBe(1);
      expect(d.linked).toEqual([]);
      expect(res.runRoles).toEqual(["v"]);
      expect(res.runLabels).toEqual([""]);
      expect(existsSync(join(readSpec(d.specs[0]).worktree, "_docs"))).toBe(false);
    } finally { restore(); }
  });

  test("the confirm and the stages that read the records keep the copy they always had", async () => {
    const f = setup();
    try {
      const d = depsFor(f);
      await startReviewRuns({ iddId: "IDD-1", stage: "confirm", round: 1, worktree: f.wt, base: f.base, head: f.head, inputs: [] }, d.deps);
      await startReviewRuns({ iddId: "IDD-1", stage: "feedback_confirm", round: 1, worktree: f.wt, base: f.base, head: f.head, inputs: [] }, d.deps);
      expect(d.cut).toEqual([]);
      expect(d.linked.length).toBe(2);
      // the confirm's diff is the real one
      expect(readSpec(d.specs[0]).diff).toEqual({ base: f.base, head: f.head });
    } finally { restore(); }
  });

  test("takes the records out of the routes and the leftovers, drops a route that passed only through records, and numbers the rest again", () => {
    const rows = ["_docs/plan/", "TODO.md"];
    const route = (id: string, paths: string[]) => ({ id, paths, question: "q", harms: [] });
    const out = withoutRecords(
      [route("R-1", ["_docs/plan/x/plan.md", "TODO.md"]), route("R-2", ["src/a.ts", "_docs/plan/x/plan.md", "src/b.ts"])],
      ["_docs/plan/x/plan.md", "TODO.md", "src/a.ts", "src/c.ts"],
      rows,
    );
    expect(out.changed).toEqual(["src/a.ts", "src/c.ts"]);
    expect(out.routes).toEqual([route("R-1", ["src/a.ts", "src/b.ts"])]);
    // a lane with no record is left as it was
    const plain = [route("R-1", ["src/a.ts"])];
    expect(withoutRecords(plain, ["src/a.ts", "x.md"], [])).toEqual({ routes: plain, changed: ["src/a.ts", "x.md"] });
  });

  test("a routed blind and a routed final name no record in their focus, and keep the route that is code", async () => {
    const f = setup();
    try {
      const routes = [
        { id: "R-1", paths: ["_docs/plan/x/plan.md", "TODO.md"], question: "q", harms: [] },
        { id: "R-2", paths: ["src/a.ts", "src/b.test.ts", "_docs/context/x/context.md"], question: "q", harms: [] },
      ];
      const d = depsFor(f);
      await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: f.wt, base: f.base, head: f.head, inputs: [], routes }, d.deps);
      await startReviewRuns({ iddId: "IDD-1", stage: "final", round: 2, worktree: f.wt, base: f.base, head: f.head, inputs: [], routes, onlyHighRisk: true }, d.deps);
      // blind: the one route that is code and the rest; final: the same two
      expect(d.specs.length).toBe(4);
      for (const path of d.specs) {
        const text = readFileSync(path, "utf8");
        const focus = (yamlLoad(text) as { focus?: string[] }).focus ?? [];
        expect(focus.length).toBeGreaterThan(0);
        for (const row of ["_docs", "TODO.md", "overlay.manifest"]) expect(focus.join("\n")).not.toContain(row);
      }
      const focus = d.specs.map((p) => ((yamlLoad(readFileSync(p, "utf8")) as { focus?: string[] }).focus ?? []).join("\n"));
      expect(focus.filter((t) => t.includes("`src/a.ts` → `src/b.test.ts`")).length).toBe(2);
    } finally { restore(); }
  });

  test("a repo with no overlay manifest is cut as before", async () => {
    const state = tmpDir("idd-recordless-plain-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    process.env.IDD_REPOS_FILE = emptyRepos(state);
    writeFileSync(process.env.IDD_ROLES_FILE, `${ROLES}\n  review_blind: { roles: [v] }\n`);
    try {
      const repo = tmpDir("idd-plain-repo-");
      sh(repo, "init", "-q", "-b", "main");
      const head = commit(repo, { "a.txt": "1\n" }, "one");
      const cut: string[] = [];
      const linked: string[] = [];
      const deps = {
        addWorktree: (_r: unknown, o: { name: string }) => { linked.push(o.name); return { path: repo } as never; },
        addRecordlessCopy: (_r: unknown, o: { name: string }) => { cut.push(o.name); throw new Error("not for a repo without records"); },
        removeWorktree: () => {},
        runLane: async () => ({ id: "L1" }) as never,
        stopLane: () => ({}) as never,
      };
      await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: repo, base: head, head, inputs: [] }, deps as never);
      expect(cut).toEqual([]);
      expect(linked.length).toBe(1);
    } finally { restore(); }
  });
});

describe("the rules the blind and the last review are handed", () => {
  const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_ROLES_FILE: process.env.IDD_ROLES_FILE, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const manifestOf = (...rows: string[]) => ["# overlay manifest", "_docs/plan/", "overlay.manifest", ...rows, ""].join("\n");

  /**
   * AGENTS.md is a rule that is no record. AGENTS.override.md is a record in every manifest; `.claude/rules/lane-only.md`
   * is a record only in the lane base's manifest, and `.claude/rules/merge-only.md` only in the merge's.
   */
  function ruleRepo() {
    const root = tmpDir("idd-rules-recordless-");
    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });
    sh(wt, "init", "-q", "-b", "main");
    const files = { "AGENTS.md": "# rules\n", "AGENTS.override.md": "OVERRIDE-SECRET\n", ".claude/rules/lane-only.md": "LANE-SECRET\n", ".claude/rules/merge-only.md": "MERGE-SECRET\n", ".claude/rules/code.md": "# code rule\n", "src/a.ts": "export const a = 1;\n" };
    const laneBase = commit(wt, { ...files, "overlay.manifest": manifestOf("AGENTS.override.md", ".claude/rules/lane-only.md") }, "lane base");
    const base = commit(wt, { "overlay.manifest": manifestOf("AGENTS.override.md") }, "base");
    const head = commit(wt, { "AGENTS.override.md": "OVERRIDE rewritten\n", ".claude/rules/lane-only.md": "LANE rewritten\n", ".claude/rules/merge-only.md": "MERGE rewritten\n", ".claude/rules/code.md": "# code rule rewritten\n", "src/a.ts": "export const a = 2;\n" }, "head");
    const merge = commit(wt, { "overlay.manifest": manifestOf("AGENTS.override.md", ".claude/rules/merge-only.md") }, "merge's manifest");
    const repo: LaneRepo = { name: "app", clone: wt, work: wt, base: "main", remote: "", reviewRoot: join(root, "review-wt"), copy: [], setup: [], checks: [], lanesRoot: wt };
    return { root, wt, repo, laneBase, base, head, merge };
  }

  async function start(stage: "blind" | "final", revs: (f: ReturnType<typeof ruleRepo>) => { laneBase?: string; merge?: string } = () => ({})) {
    const state = tmpDir("idd-rules-state-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    process.env.IDD_REPOS_FILE = emptyRepos(state);
    writeFileSync(process.env.IDD_ROLES_FILE, `${ROLES}\n  review_blind: { roles: [v], high_risk_extra: [v] }\n  spec_check: { role: s }\n  confirm: { role: conf }\n  triage: { role: judge }\n`);
    const f = ruleRepo();
    const specs: string[] = [];
    const deps = {
      addWorktree: () => ({ path: f.wt }) as never,
      addRecordlessCopy: (repo: LaneRepo, o: Parameters<typeof addRecordlessCopy>[1]) => addRecordlessCopy(repo, o),
      removeWorktree: () => {},
      runLane: async (p: string) => { specs.push(p); return { id: `L${specs.length}` } as never; },
      stopLane: () => ({}) as never,
    };
    await startReviewRuns({ iddId: "IDD-1", stage, round: 1, worktree: f.wt, base: f.base, head: f.head, inputs: [], ...revs(f), spec: { count: 1, inputs: [] } }, deps);
    return { f, specs };
  }
  const specOf = (path: string) => yamlLoad(readFileSync(path, "utf8")) as { stage: string; rules: string[]; rule_warnings?: string[] };
  const names = (rules: string[]) => rules.map((r) => r.replace(/^.*\/base-rules\//, "base-rules/"));
  /** every file's text under a directory, to look for a record's text in the reader's own run directory */
  const textUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? textUnder(join(dir, e.name)) : [readFileSync(join(dir, e.name), "utf8")]));
  const ROLE = { name: "v", harness: "pi", model: "x/v", thinking: "high", tools: ["read"], policy: [], report: "review", requireClean: true, budgetMinutes: 5, contextFiles: true, maxResumes: 0 } as never;

  for (const stage of ["blind", "final"] as const) {
    test(`a ${stage} is handed no record among its rules, even one only the lane base's or the merge's manifest lists; the spec check beside it drops the same rows`, async () => {
      try {
        const { specs } = await start(stage, (f) => ({ laneBase: f.laneBase, merge: f.merge }));
        expect(specs.length).toBe(2);
        const [reader, spec] = specs.map(specOf);
        expect(reader.stage).toBe(stage);
        expect(spec.stage).toBe("spec");
        // a rule that is no record stays, from the base (the head rewrote it); the three records are gone from the list
        expect(names(reader.rules)).toEqual(["AGENTS.md", "base-rules/.claude/rules/code.md"]);
        // the spec check drops every row too, the merge's included: no stage reads a file a manifest row marks as propter's
        expect(names(spec.rules)).toEqual(["AGENTS.md", "base-rules/.claude/rules/code.md"]);
        expect((spec.rule_warnings ?? []).some((w) => w.includes("merge-only.md"))).toBe(true);
        // no record's text is written in the reader's run directory, and its brief names none of them
        const written = textUnder(dirname(specs[0])).join("\n");
        for (const secret of ["OVERRIDE", "LANE-SECRET", "MERGE-SECRET"]) expect(written).not.toContain(secret);
        const brief = renderBrief(parseSpec(readFileSync(specs[0], "utf8"), dirname(specs[0])), ROLE);
        for (const word of ["AGENTS.override", "lane-only", "merge-only", "SECRET"]) expect(brief).not.toContain(word);
        // the spec check's own directory holds no row's text either
        const specWritten = textUnder(dirname(specs[1])).join("\n");
        for (const secret of ["OVERRIDE-SECRET", "MERGE-SECRET"]) expect(specWritten).not.toContain(secret);
      } finally { restore(); }
    });
  }

  test("the blind `idd review map` writes has the same rules, from the head and base it is given", async () => {
    try {
      const { f, specs } = await start("blind", () => ({}));
      // the CLI knows the head and the base only: it cuts by their manifests, which list the override and not the lane-only rule
      const out = join(tmpDir("idd-rules-cli-"), "out");
      const { specs: written } = writeMappedBlindSpecs({ worktree: f.wt, base: f.base, head: f.head, out }, []);
      expect(written.length).toBe(1);
      const cli = specOf(written[0].specPath);
      const pipeline = specOf(specs[0]);
      expect(cli.stage).toBe("blind");
      // the pipeline's round had no laneBase or merge, so its rows are the same pair
      expect(names(cli.rules)).toEqual(names(pipeline.rules));
      expect(names(cli.rules)).toEqual(["AGENTS.md", "base-rules/.claude/rules/code.md", "base-rules/.claude/rules/lane-only.md", "base-rules/.claude/rules/merge-only.md"]);
      expect(textUnder(dirname(written[0].specPath)).join("\n")).not.toContain("OVERRIDE");
    } finally { restore(); }
  });

  test("the blind `idd review map` writes names no record rule in its focus, and keeps the route that is code", async () => {
    try {
      const { f } = await start("blind", () => ({}));
      const out = join(tmpDir("idd-rules-cli-focus-"), "out");
      const route = (id: string, paths: string[]) => ({ id, paths, question: "q", harms: [] });
      const { specs: written } = writeMappedBlindSpecs({ worktree: f.wt, base: f.base, head: f.head, out }, [route("R-1", ["AGENTS.override.md"]), route("R-2", ["src/a.ts", "AGENTS.override.md"])]);
      // the route that passed only through the record is gone and the other is numbered again, keeping its code
      expect(written.map((w) => w.label)).toEqual(["r1", "rest"]);
      // the spec's rule_warnings keep the withheld fact for the harness; what the reader is shown (focus, brief) does not name it
      for (const w of written) {
        const spec = yamlLoad(readFileSync(w.specPath, "utf8")) as { focus?: string[] };
        expect((spec.focus ?? []).join("\n")).not.toContain("AGENTS.override");
        expect(textUnder(dirname(w.specPath)).join("\n")).not.toContain("OVERRIDE");
      }
      const first = yamlLoad(readFileSync(written[0].specPath, "utf8")) as { focus: string[] };
      expect(first.focus.join("\n")).toContain("src/a.ts");
    } finally { restore(); }
  });
});
