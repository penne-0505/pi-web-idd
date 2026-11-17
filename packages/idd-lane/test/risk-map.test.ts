import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { load as yamlLoad } from "js-yaml";

import { diffLineCount, mapFocus, MAP_TASK, parseRoutes, planRoutedBlind, routesInDiff, type RiskRoute } from "../src/risk-map.ts";
import { freshDir, reviewRunState, riskMapSkipReason, stageRunPlans, startReviewRuns, STAGE_SLOT, STAGE_TASK, writeMappedBlindSpecs, writeRiskMapSpec } from "../src/review-runs.ts";
import { repoForPath } from "../src/repos.ts";
import { parseRoles, readRoles } from "../src/roles.ts";
import { parseSpec, renderBrief } from "../src/spec.ts";
import { isolateRepos, ownRepos } from "./helpers/repos.ts";
import { shippedConfig, shippedConfigTest } from "./helpers/shipped-config.ts";
import { tmpDir } from "./helpers/tmp.ts";

// the registry these tests read is their own, and no IDD_REPOS_FILE they set outlives them
isolateRepos();

// the tests below point the state and roles at their own files; the other test files must not see them
const savedEnv = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_ROLES_FILE: process.env.IDD_ROLES_FILE };
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd, encoding: "utf8" }).trim();

/** a repo whose second commit adds `lines` lines to lib/a.dart and a binary file */
function repoWithDiff(lines: number): { root: string; base: string; head: string } {
  const root = tmpDir("idd-map-repo-");
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "AGENTS.md"), "# a\n");
  gitIn(root, "add", "-A"); gitIn(root, "commit", "-q", "-m", "base");
  const base = gitIn(root, "rev-parse", "HEAD");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "a.dart"), Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") + "\n");
  writeFileSync(join(root, "lib", "icon.png"), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
  gitIn(root, "add", "-A"); gitIn(root, "commit", "-q", "-m", "head");
  return { root, base, head: gitIn(root, "rev-parse", "HEAD") };
}

const route = (n: number, extra: Partial<RiskRoute> = {}): RiskRoute => ({ id: `R-${n}`, paths: [`lib/r${n}.dart`], question: `問い ${n}`, harms: ["authority"], ...extra });

const ROLES_YAML = [
  "models:",
  "  x-b1:",
  "    model: x/b1",
  "  x-b2:",
  "    model: x/b2",
  "  x-m:",
  "    model: x/m",
  "roles:",
  "  b1: { model: x-b1, report: review }",
  "  b2: { model: x-b2, report: review }",
  "  mapper: { model: x-m, report: map, tools: [read, bash, grep, find, ls] }",
  "pipeline:",
  "  review_blind: { roles: [b1, b2], concurrency: 2 }",
  "  risk_map: { role: mapper, min_lines: 50, max_routes: 3 }",
  "",
].join("\n");

describe("the map's routes", () => {
  test("are renumbered in the map's order, and unknown harms are dropped", () => {
    const got = parseRoutes([
      { id: "X", paths: ["lib/a.dart", "lib/b.dart"], question: "画面の値と送る値が同じ", harms: ["shown_vs_sent"] },
      { paths: ["./lib/c.dart"], question: "取り返しがつかない操作が起きない", harms: ["irreversible", "weird"] },
    ]);
    expect(got.map((r) => r.id)).toEqual(["R-1", "R-2"]);
    expect(got[0]).toEqual({ id: "R-1", paths: ["lib/a.dart", "lib/b.dart"], question: "画面の値と送る値が同じ", harms: ["shown_vs_sent"] });
    expect(got[1].harms).toEqual(["irreversible"]);
    expect(got[1].paths).toEqual(["lib/c.dart"]);
  });

  test("a route without a file or a question, or with a path outside the repo, is left out", () => {
    const got = parseRoutes([
      { paths: ["lib/a.dart"], harms: ["authority"] },
      { question: "問い", harms: ["authority"] },
      { paths: ["/etc/passwd"], question: "abs" },
      { paths: ["../x.dart"], question: "outside" },
      { paths: ["lib/ok.dart", "lib/ok.dart", "/abs", 3], question: "ok" },
      "not an object",
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].paths).toEqual(["lib/ok.dart"]);
  });

  test("a path with a newline, a control character or git's pathspec magic is left out", () => {
    const got = parseRoutes([
      { paths: ["lib/a\n.dart"], question: "newline" },
      { paths: ["lib/a\u0007.dart"], question: "bell" },
      { paths: [":(top)lib/a.dart"], question: "magic" },
      { paths: ["lib/ok.dart", "lib/b\r.dart", ":!x", "lib/c.dart"], question: "ok" },
    ]);
    expect(got.map((r) => r.paths)).toEqual([["lib/ok.dart", "lib/c.dart"]]);
  });

  test("only the routes that pass through a changed file are kept: another route is dropped and the rest renumbered", () => {
    const files = new Set(["lib/r1.dart", "lib/shared.dart"]);
    const got = routesInDiff([route(1, { paths: ["lib/r1.dart", "lib/unchanged.dart"] }), route(2, { paths: ["lib/not_in_diff.dart"] })], files);
    expect(got.map((r) => r.paths[0])).toEqual(["lib/r1.dart"]);
    expect(got[0].paths).toEqual(["lib/r1.dart", "lib/unchanged.dart"]);
    expect(got[0].id).toBe("R-1");
  });

  test("anything but an array is no routes", () => {
    expect(parseRoutes(undefined)).toEqual([]);
    expect(parseRoutes({ routes: [] })).toEqual([]);
  });
});

describe("the blinds of a routed round", () => {
  test("one blind per route over the whole diff, and one whole-diff blind for the files no route covers", () => {
    const runs = planRoutedBlind([route(1, { paths: ["lib/p1.dart", "lib/shared.dart"] }), route(2)], ["b1", "b2"], { cap: 4, leftovers: ["lib/p1.dart", "lib/shared.dart", "lib/p2.dart", "lib/rest.dart"] });
    expect(runs.map((r) => r.label)).toEqual(["r1", "r2", "rest"]);
    // the route's blind reads the file list as one unit; the diff is not scoped to it
    expect(runs[0].role).toBe("b1");
    expect(runs[1].role).toBe("b1");
    expect(runs[0].focus.join("\n")).toContain("lib/p1.dart");
    expect(runs[0].focus.join("\n")).toContain("lib/shared.dart");
    expect(runs[0].focus.join("\n")).not.toContain("問い 1");
    expect(runs[0].focus.join("\n")).not.toContain("判断が外に出る");
    expect(runs[0].focus.join("\n")).not.toContain("問い 2");
    // the leftover blind is a different role and names only the files no kept route covers
    expect(runs[2].role).toBe("b2");
    expect(runs[2].wholeDiff).toBe(true);
    expect(runs[2].focus.join("\n")).toContain("lib/rest.dart");
    expect(runs[2].focus.join("\n")).not.toContain("lib/p1.dart");
  });

  test("every route uses the slot's first role, and the leftovers use the second", () => {
    const runs = planRoutedBlind([route(1), route(2), route(3)], ["b1", "b2"], { cap: 5, leftovers: ["lib/r1.dart"] });
    expect(runs.map((r) => r.role)).toEqual(["b1", "b1", "b1", "b2"]);
  });

  test("routes past the cap are not given a blind of their own: their files go to the leftovers' list", () => {
    const runs = planRoutedBlind([route(1), route(2), route(3), route(4), route(5)], ["b1"], { cap: 3, leftovers: ["lib/r1.dart", "lib/r2.dart", "lib/r3.dart", "lib/r4.dart", "lib/r5.dart"] });
    expect(runs.map((r) => r.label)).toEqual(["r1", "r2", "r3", "rest"]);
    const rest = runs[3].focus.join("\n");
    for (const n of [4, 5]) expect(rest).toContain(`lib/r${n}.dart`);
    expect(rest).not.toContain("lib/r1.dart");
    expect(runs.length).toBe(4);
  });

  test("a cap of one puts every route's files into the leftovers", () => {
    const runs = planRoutedBlind([route(1), route(2)], ["b1"], { cap: 1, leftovers: ["lib/r1.dart", "lib/r2.dart"] });
    expect(runs.map((r) => r.label)).toEqual(["r1", "rest"]);
    expect(runs[1].focus.join("\n")).toContain("lib/r2.dart");
  });

  test("a role list of one uses it for the leftovers too", () => {
    const runs = planRoutedBlind([route(1)], ["b1"], { cap: 3, leftovers: [] });
    expect(runs.map((r) => r.role)).toEqual(["b1", "b1"]);
  });

  test("no routes, no routed round", () => {
    expect(planRoutedBlind([], ["b1"], { cap: 3, leftovers: [] })).toEqual([]);
  });
});

describe("the size of a diff", () => {
  test("counts added and deleted lines, and nothing for a binary file", () => {
    const { root, base, head } = repoWithDiff(120);
    expect(diffLineCount(root, base, head)).toBe(120);
  });

  test("is unknown when a revision cannot be read", () => {
    const { root, base } = repoWithDiff(3);
    expect(diffLineCount(root, base, "0000000000000000000000000000000000000000")).toBeNull();
  });
});

describe("the map stage", () => {
  test("runs on the risk_map slot, and its task only reads and asks for routes", () => {
    expect(STAGE_SLOT.map).toBe("risk_map");
    expect(STAGE_TASK.map).toBe(MAP_TASK);
    expect(MAP_TASK).toMatch(/読むだけ/);
    for (const kind of ["authority", "irreversible", "shown_vs_sent"]) expect(MAP_TASK).toContain(kind);
    expect(mapFocus(3).join("\n")).toContain("3 本");
  });

  test("roles.yaml carries the slot's threshold and cap, and a role may write the map format", () => {
    const roles = parseRoles(ROLES_YAML);
    expect(roles.pipeline.risk_map).toMatchObject({ role: "mapper", minLines: 50, maxRoutes: 3 });
    expect(roles.roles.mapper.report).toBe("map");
    expect(() => parseRoles(ROLES_YAML.replace("min_lines: 50", "min_lines: -1"))).toThrow(/min_lines/);
    expect(() => parseRoles(ROLES_YAML.replace("max_routes: 3", "max_routes: 0"))).toThrow(/max_routes/);
  });

  shippedConfigTest(["roles.yaml"], "the shipped risk-mapper must end as it began, and a worktree the executor left dirty does not stop it", () => {
    const shipped = readRoles(shippedConfig("roles.yaml")).roles["risk-mapper"];
    expect(shipped.report).toBe("map");
    // like the triage, which reads the same worktree: held to the state it began in, not to a clean tree
    expect(shipped.requireClean).toBe(true);
    expect(shipped.tools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  });

  test("the brief asks for the routes, each with its files, question and harm kinds", () => {
    const wt = tmpDir("idd-map-brief-");
    const spec = parseSpec(`role: mapper\nworktree: ${wt}\nreport: ${join(wt, "r")}\n`);
    const brief = renderBrief(spec, parseRoles(ROLES_YAML).roles.mapper);
    expect(brief).toContain('"routes"');
    for (const key of ['"paths"', '"question"', '"harms"', '"skipped_paths"']) expect(brief).toContain(key);
  });

  test("a quote in a scoped path cannot close the brief's quoting", () => {
    const wt = tmpDir("idd-map-quote-");
    const spec = parseSpec(`role: b1\nworktree: ${wt}\nreport: ${join(wt, "r")}\ndiff: { base: A, head: B, paths: ["lib/a'; touch x; echo '.dart"] }\n`);
    const brief = renderBrief(spec, parseRoles(ROLES_YAML).roles.b1);
    expect(brief).toContain("git diff A B -- 'lib/a'\\''; touch x; echo '\\''.dart'");
  });

  test("a diff below the threshold starts nothing and says why", async () => {
    const state = tmpDir("idd-map-state-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, ROLES_YAML);
    const { root, base, head } = repoWithDiff(10);
    const res = await startReviewRuns({ iddId: "IDD-1", stage: "map", round: 1, worktree: root, base, head, inputs: [] });
    expect(res.runIds).toEqual([]);
    expect(res.skipped).toMatch(/10 行/);
    expect(res.skipped).toMatch(/50 行/);
  });

  test("says whether a diff is mapped before any map slot is taken", () => {
    const roles = parseRoles(ROLES_YAML);
    const small = repoWithDiff(10);
    expect(riskMapSkipReason({ worktree: small.root, base: small.base, head: small.head }, roles)).toMatch(/10 行/);
    const large = repoWithDiff(60);
    expect(riskMapSkipReason({ worktree: large.root, base: large.base, head: large.head }, roles)).toBeNull();
    expect(riskMapSkipReason({ worktree: large.root, base: large.base, head: large.head }, parseRoles(ROLES_YAML.replace(/  risk_map:.*\n/, "")))).toMatch(/未宣言/);
  });

  test("a finished map hands its routes back", () => {
    const state = tmpDir("idd-map-done-");
    process.env.IDD_STATE_DIR = state;
    const report = join(state, "out", "report");
    mkdirSync(join(state, "out"), { recursive: true });
    writeFileSync(`${report}.json`, JSON.stringify({ routes: [{ paths: ["lib/a.dart"], question: "遷移が成り立つ", harms: ["authority"] }], clean: true }));
    writeFileSync(`${report}.md`, "# map\n");
    mkdirSync(join(state, "lanes", "L1"), { recursive: true });
    writeFileSync(join(state, "lanes", "L1", "lane.json"), JSON.stringify({ id: "L1", role: "mapper", model: "x/m", worktree: state, spec: "", report, status: "done", started_at: "" }));
    const st = reviewRunState("L1");
    expect(st.state).toBe("done");
    if (st.state !== "done") return;
    expect(st.routes).toEqual([{ id: "R-1", paths: ["lib/a.dart"], question: "遷移が成り立つ", harms: ["authority"] }]);
  });
});

describe("the runs of a stage", () => {
  const roles = parseRoles(ROLES_YAML);

  test("a blind without routes runs every role of the slot over the whole diff, as before", () => {
    const runs = stageRunPlans("blind", roles.pipeline.review_blind, { maxRoutes: 3 });
    expect(runs).toEqual([
      { label: "", role: "b1", model: "x-b1", thinking: "medium", focus: [] },
      { label: "", role: "b2", model: "x-b2", thinking: "medium", focus: [] },
    ]);
  });

  test("a blind with routes runs the routed round", () => {
    const runs = stageRunPlans("blind", roles.pipeline.review_blind, { routes: [route(1)], maxRoutes: 3, leftovers: ["lib/r1.dart"] });
    expect(runs.map((r) => r.label)).toEqual(["r1", "rest"]);
  });

  test("the map is one run of the slot's role, told the cap", () => {
    const runs = stageRunPlans("map", roles.pipeline.risk_map, { maxRoutes: 3 });
    expect(runs).toHaveLength(1);
    expect(runs[0].role).toBe("mapper");
    expect(runs[0].focus.join("\n")).toContain("3 本");
  });

  test("the CLI writes the map's spec and the specs the routed blinds would get, the way the pipeline builds them", () => {
    const state = tmpDir("idd-map-cli-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, ROLES_YAML);
    const { root, base, head } = repoWithDiff(80);
    const out = join(state, "cli");
    const written = writeRiskMapSpec({ worktree: root, base, head, out });
    const map = yamlLoad(readFileSync(written.specPath, "utf8")) as { role: string; task: string; diff: unknown; rules: string[] };
    expect(map.role).toBe("mapper");
    expect(map.task).toBe(MAP_TASK);
    expect(map.diff).toEqual({ base, head });
    expect(map.rules).toContain("AGENTS.md");
    expect(written.diffLines).toBe(80);
    expect(written.minLines).toBe(50);
    const { specs: blind, copyRoot } = writeMappedBlindSpecs({ worktree: root, base, head, out }, [route(1, { paths: ["lib/a.dart"] }), route(2, { paths: ["lib/icon.png"] })]);
    // a repo with no overlay manifest has no records to take out: the specs point at the map's worktree as they did
    expect(copyRoot).toBeNull();
    expect(blind.map((b) => b.worktree)).toEqual([root, root, root]);
    expect(blind.map((b) => b.label)).toEqual(["r1", "r2", "rest"]);
    expect(blind.map((b) => b.role)).toEqual(["b1", "b1", "b2"]);
    // routes the diff does not touch give no blind of their own; with none left the round is the usual one
    const outside = writeMappedBlindSpecs({ worktree: root, base, head, out: join(state, "cli-outside") }, [route(1, { paths: ["lib/not_in_diff.dart"] })]).specs;
    expect(outside.map((b) => b.label)).toEqual(["", ""]);
    // without review_blind there are no roles to give the blinds: nothing is written, and no role name is made up
    writeFileSync(process.env.IDD_ROLES_FILE as string, ROLES_YAML.replace(/  review_blind:.*\n/, ""));
    expect(writeMappedBlindSpecs({ worktree: root, base, head, out: join(state, "cli-no-blind") }, [route(1, { paths: ["lib/a.dart"] })]).specs).toEqual([]);
    writeFileSync(process.env.IDD_ROLES_FILE as string, ROLES_YAML);
    const r1 = yamlLoad(readFileSync(blind[0].specPath, "utf8")) as { role: string; task: string; worktree: string; diff: { base: string; head: string; paths?: string[] }; focus: string[] };
    expect(r1.role).toBe("b1");
    expect(r1.worktree).toBe(root);
    expect(r1.diff).toEqual({ base, head });
    expect(r1.task).toBe(STAGE_TASK.blind);
    // a route's blind reads the whole diff, not only the route's files
    expect(r1.diff.paths).toBeUndefined();
    expect(r1.focus.join("\n")).toContain("lib/a.dart");
  });
});

describe("the CLI's blind specs in a repo with records", () => {
  const MANIFEST = ["overlay.manifest", "_docs/plan/", "TODO.md", ""].join("\n");

  const put = (root: string, rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const commit = (root: string, msg: string, ...flags: string[]) => {
    gitIn(root, "add", "-A"); gitIn(root, "commit", "-q", ...flags, "-m", msg);
    return gitIn(root, "rev-parse", "HEAD");
  };
  /** a repo whose base commits `baseFiles` and whose head commits `headFiles` over them */
  function repoOf(prefix: string, baseFiles: Record<string, string>, headFiles: Record<string, string>): { root: string; base: string; head: string } {
    const root = tmpDir(prefix);
    execFileSync("git", ["init", "-q", root]);
    for (const [rel, text] of Object.entries(baseFiles)) put(root, rel, text);
    const base = commit(root, "base");
    for (const [rel, text] of Object.entries(headFiles)) put(root, rel, text);
    return { root, base, head: commit(root, "head") };
  }
  /** a base with an overlay manifest and a plan, and a head that changes lib/a.dart and the plan */
  const repoWithRecords = () => repoOf(
    "idd-map-records-",
    { "AGENTS.md": "# a\n", "overlay.manifest": MANIFEST, "_docs/plan/x/plan.md": "plan v1\n" },
    { "lib/a.dart": "a\n", "lib/b.dart": "b\n", "_docs/plan/x/plan.md": "plan v2\n" },
  );
  const dropManifest = (root: string) => { gitIn(root, "rm", "-q", "overlay.manifest"); return commit(root, "no manifest"); };

  type Loaded = { worktree: string; diff: { base: string; head: string }; focus: string[]; rules: string[]; setup?: string[] };
  const load = (specPath: string) => yamlLoad(readFileSync(specPath, "utf8")) as Loaded;
  const gitOk = (cwd: string, ...args: string[]) => { try { execFileSync("git", args, { cwd, stdio: "ignore" }); return true; } catch { return false; } };

  /** the state and roles of this test, and the repo it cuts (the records repo unless given another) */
  function fixture(repo = repoWithRecords()) {
    const state = tmpDir("idd-map-cli-rec-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, ROLES_YAML);
    return { ...repo, state, out: join(state, "o") };
  }
  type Fixture = ReturnType<typeof fixture>;
  const cut = (f: Fixture, routes = [route(1, { paths: ["lib/a.dart"] })], over: Partial<Fixture> = {}) =>
    writeMappedBlindSpecs({ worktree: f.root, base: f.base, head: f.head, out: f.out, ...over }, routes);
  /** an earlier run's copy under review-wt, which a later run or its removal must leave */
  const holdEarlier = (out: string) => {
    mkdirSync(join(out, "review-wt", "earlier"), { recursive: true });
    writeFileSync(join(out, "review-wt", "earlier", "copy.txt"), "mine\n");
  };
  const removeRoot = (copyRoot: string | null) => rmSync(copyRoot as string, { recursive: true, force: true });

  test("each spec points at a copy with no record in its tree, its diff or its object store, and the map's worktree keeps them", () => {
    const f = fixture();
    const { root, base, head, state } = f;
    // the repo is in no registry (the test's own is empty): the copies are cut all the same
    const { specs, copyRoot } = cut(f);
    expect(specs.map((b) => b.label)).toEqual(["r1", "rest"]);
    // a directory of this run's own under <out>/review-wt
    expect(dirname(copyRoot as string)).toBe(join(state, "o", "review-wt"));
    const copies = new Set<string>();
    for (const b of specs) {
      const spec = load(b.specPath);
      expect(b.worktree).toBe(spec.worktree);
      expect(spec.worktree.startsWith(`${copyRoot}/`)).toBe(true);
      copies.add(spec.worktree);
      expect(existsSync(join(spec.worktree, "lib", "a.dart"))).toBe(true);
      for (const gone of ["_docs/plan/x/plan.md", "overlay.manifest"]) expect(existsSync(join(spec.worktree, gone))).toBe(false);
      // the two ends resolve inside the copy, and read the same change as the worktree's, less its records
      for (const end of [spec.diff.base, spec.diff.head]) expect(gitOk(spec.worktree, "rev-parse", "--verify", `${end}^{commit}`)).toBe(true);
      expect(gitIn(spec.worktree, "diff", "--name-only", spec.diff.base, spec.diff.head).split("\n")).toEqual(["lib/a.dart", "lib/b.dart"]);
      expect(gitIn(spec.worktree, "diff", spec.diff.base, spec.diff.head)).toBe(gitIn(root, "diff", base, head, "--", "lib"));
      // not through the real revs, a ref, or the object store either
      for (const rev of [base, head]) expect(gitOk(spec.worktree, "cat-file", "-e", rev)).toBe(false);
      expect(gitIn(spec.worktree, "log", "--all", "--format=%H", "--", "_docs")).toBe("");
      expect(gitOk(spec.worktree, "show", `${spec.diff.head}:_docs/plan/x/plan.md`)).toBe(false);
    }
    expect(copies.size).toBe(specs.length);
    expect(readFileSync(join(root, "_docs", "plan", "x", "plan.md"), "utf8")).toBe("plan v2\n");
    expect(gitIn(root, "show", `${head}:_docs/plan/x/plan.md`)).toBe("plan v2");
  });

  test("a route that names only records starts no blind, and no focus names a record", () => {
    const { specs } = cut(fixture(), [route(1, { paths: ["_docs/plan/x/plan.md"] }), route(2, { paths: ["lib/a.dart", "_docs/plan/x/plan.md"] })]);
    // the second route is numbered again as the first
    expect(specs.map((b) => b.label)).toEqual(["r1", "rest"]);
    for (const b of specs) expect(load(b.specPath).focus.join("\n")).not.toContain("_docs");
  });

  test("a merge head's parents' manifest rows are taken out as well", () => {
    const f = fixture();
    const { root, base } = f;
    gitIn(root, "checkout", "-q", "-b", "side", base);
    put(root, "notes/n.md", "note\n");
    put(root, "overlay.manifest", `${MANIFEST}notes/\n`);
    commit(root, "side");
    gitIn(root, "checkout", "-q", "-b", "main2", base);
    put(root, "lib/a.dart", "a\n");
    commit(root, "main");
    gitIn(root, "merge", "-q", "--no-ff", "-m", "merge", "side");
    // the merge's own manifest does not list notes/, only its side parent's does
    put(root, "overlay.manifest", MANIFEST);
    const merge = commit(root, "merge", "--amend");
    expect(gitIn(root, "show", `${merge}:notes/n.md`)).toBe("note");
    const { specs } = cut(f, [route(1, { paths: ["notes/n.md"] })], { head: merge });
    // the route lay in the parent's records only: no blind of its own
    expect(specs.map((b) => b.label)).toEqual(["", ""]);
    const spec = load(specs[0].specPath);
    expect(existsSync(join(spec.worktree, "notes"))).toBe(false);
    expect(existsSync(join(spec.worktree, "lib", "a.dart"))).toBe(true);
    expect(gitIn(spec.worktree, "diff", "--name-only", spec.diff.base, spec.diff.head)).toBe("lib/a.dart");
    expect(gitOk(spec.worktree, "show", `${spec.diff.head}^2:notes/n.md`)).toBe(false);
  });

  test("a rule the manifest takes out is handed to no blind, and the other rules are", () => {
    const f = fixture(repoOf(
      "idd-map-rules-",
      { "AGENTS.md": "# a\n", "overlay.manifest": ["overlay.manifest", ".claude/rules/secret.md", ""].join("\n"), ".claude/rules/secret.md": "rule-body-in-a-record\n", ".claude/rules/open.md": "rule-body-in-the-open\n" },
      { "lib/a.dart": "a\n", ".claude/rules/secret.md": "rule-body-rewritten\n", ".claude/rules/open.md": "rule-body-rewritten-open\n" },
    ));
    const { specs, copyRoot } = cut(f);
    // what each spec hands on, read the way the lane reads it: repo-relative in the copy, or by an absolute path
    const handed: string[] = [];
    for (const b of specs) {
      const spec = load(b.specPath);
      for (const r of spec.rules) {
        const at = r.startsWith("/") ? r : join(spec.worktree, r);
        handed.push(existsSync(at) ? readFileSync(at, "utf8") : "");
      }
    }
    expect(handed.join("")).not.toContain("rule-body-in-a-record");
    expect(handed.join("")).not.toContain("rule-body-rewritten\n");
    // the base's version of a rule the head rewrites is still handed as the base has it
    expect(handed.join("")).toContain("rule-body-in-the-open");
    // nor does a file the specs' directories hold outside the copies (the base's rules are written there)
    const texts = (readdirSync(join(f.out, "blind"), { recursive: true }) as string[]).map((n) => join(f.out, "blind", n)).filter((n) => statSync(n).isFile()).map((n) => readFileSync(n, "utf8"));
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.join("")).not.toContain("rule-body-in-a-record");
    removeRoot(copyRoot);
  });

  test("an earlier run's copies stay under review-wt, through a failed run and through removing a copy root", () => {
    const f = fixture();
    const { out } = f;
    holdEarlier(out);
    writeFileSync(join(out, "review-wt", "keep.txt"), "mine\n");
    expect(() => cut(f, undefined, { base: "no-such-rev" })).toThrow();
    expect(readFileSync(join(out, "review-wt", "earlier", "copy.txt"), "utf8")).toBe("mine\n");
    expect(readdirSync(join(out, "review-wt")).sort()).toEqual(["earlier", "keep.txt"]);
    const first = cut(f);
    const second = cut(f);
    expect(first.copyRoot).not.toBe(second.copyRoot);
    removeRoot(second.copyRoot);
    expect(existsSync(join(out, "review-wt", "keep.txt"))).toBe(true);
    expect(existsSync(join(out, "review-wt", "earlier"))).toBe(true);
    for (const b of first.specs) expect(existsSync(b.worktree)).toBe(true);
    expect(readdirSync(join(out, "review-wt")).sort()).toEqual(["earlier", "keep.txt", basename(first.copyRoot as string)].sort());
  });

  test("a registry that does not exist cuts the copies all the same", () => {
    const f = fixture();
    process.env.IDD_REPOS_FILE = join(f.state, "no-such-repos.yaml");
    const { specs, copyRoot } = cut(f);
    expect(copyRoot).not.toBeNull();
    for (const b of specs) {
      expect(b.worktree.startsWith(`${copyRoot}/`)).toBe(true);
      expect(existsSync(join(b.worktree, "_docs", "plan"))).toBe(false);
    }
  });

  test("a registry that cannot be parsed fails and leaves no copy behind", () => {
    const f = fixture();
    ownRepos("repos: [");
    expect(() => cut(f)).toThrow();
    expect(existsSync(join(f.out, "review-wt"))).toBe(false);
    expect(existsSync(join(f.out, "blind"))).toBe(false);
  });

  test("a repo without manifest rows points at the map's worktree whatever the registry", () => {
    const f = fixture();
    // the base and the head both lose the manifest
    const bare = dropManifest(f.root);
    ownRepos("repos: [");
    const { specs, copyRoot } = cut(f, undefined, { base: bare, head: bare });
    expect(copyRoot).toBeNull();
    for (const b of specs) expect(b.worktree).toBe(f.root);
    expect(f.head).not.toBe(bare);
    expect(f.base).not.toBe(bare);
  });

  test("the copy root holds every copy and its record, and removing it leaves neither", () => {
    const f = fixture();
    const { specs, copyRoot } = cut(f);
    const names = readdirSync(copyRoot as string);
    // one directory and one record per spec
    expect(names.filter((n) => n.endsWith(".json"))).toHaveLength(specs.length);
    expect(names.filter((n) => !n.endsWith(".json"))).toHaveLength(specs.length);
    for (const b of specs) expect(names).toContain(`${basename(b.worktree)}.json`);
    removeRoot(copyRoot);
    expect(existsSync(specs[0].worktree)).toBe(false);
    expect(existsSync(join(f.out, "blind"))).toBe(true);
    expect(gitIn(f.root, "status", "--short")).toBe("");
  });

  test("a name already taken under review-wt is never reused, so the copy root holds only this run's", () => {
    const parent = join(fixture().state, "taken");
    mkdirSync(join(parent, "same"), { recursive: true });
    writeFileSync(join(parent, "same", "earlier-copy.txt"), "mine\n");
    const names = ["same", "same", "fresh"];
    const made = freshDir(parent, () => names.shift() as string);
    expect(basename(made)).toBe("fresh");
    expect(readdirSync(made)).toEqual([]);
    removeRoot(made);
    expect(readFileSync(join(parent, "same", "earlier-copy.txt"), "utf8")).toBe("mine\n");
  });

  test("a registered repo's setup and checks are on the spec of its blind, in a copy or in the map's worktree", () => {
    const f = fixture();
    ownRepos(`repos:\n  o/w:\n    upstream: ${f.root}\n    work: ${f.root}\n    setup:\n      - echo prepared\n    checks:\n      - name: unit\n        command: [echo, hi]\n        timeout_minutes: 7\n      - name: docs\n        command: [echo, hi]\n        scope: records\n`);
    const { specs } = cut(f);
    expect(specs.length).toBeGreaterThan(0);
    // a copy with its records taken out is not handed the check that reads them
    for (const b of specs) {
      expect(load(b.specPath).setup).toEqual(["echo prepared"]);
      const text = JSON.stringify(load(b.specPath));
      expect(text).toContain("unit");
      // the check's own name, not the word: the task names the standards directory
      expect(text).not.toContain('"name":"docs"');
    }
    // the map's worktree keeps its records, so its spec lists every check
    const noRows = dropManifest(f.root);
    const { specs: inTree } = cut(f, undefined, { base: noRows, head: noRows, out: join(f.state, "w") });
    expect(inTree.length).toBeGreaterThan(0);
    for (const b of inTree) {
      expect(b.worktree).toBe(f.root);
      const text = JSON.stringify(load(b.specPath));
      expect(text).toContain("unit");
      expect(text).toContain('"name":"docs"');
    }
    // a repo the registry does not list has none to hand
    ownRepos("repos: {}\n");
    const { specs: bare } = cut(f, undefined, { out: join(f.state, "p") });
    for (const b of bare) expect(readFileSync(b.specPath, "utf8")).not.toContain("unit");
  });
  test("a registered repo's copy takes out the rows of the root its list of changed files starts at, from the routes and the focus too, and names the repo it was cut for", () => {
    // the root lists notes/ as records; the lane dropped that row before its base, so the head and base manifests do not
    const f = fixture(repoOf("idd-map-start-", { "AGENTS.md": "# a\n", "overlay.manifest": `${MANIFEST}notes/\n`, "notes/n.md": "note v1\n" }, { "overlay.manifest": MANIFEST }));
    gitIn(f.root, "branch", "-M", "main");
    gitIn(f.root, "checkout", "-q", "-b", "lane", f.head);
    put(f.root, "lib/a.dart", "a\n");
    put(f.root, "notes/n.md", "note v2\n");
    const head = commit(f.root, "lane head");
    gitIn(f.root, "branch", "-f", "main", f.base);
    ownRepos(`repos:\n  o/w:\n    upstream: ${f.root}\n    work: ${f.root}\n`);
    const { specs } = cut(f, [route(1, { paths: ["notes/n.md"] }), route(2, { paths: ["notes/n.md", "lib/a.dart"] })], { base: f.head, head });
    // the route on a start-only record has no blind, and no focus names that record
    expect(specs.map((b) => b.label)).toEqual(["r1", "rest"]);
    for (const b of specs) {
      const spec = load(b.specPath);
      expect(spec.focus.join("\n")).not.toContain("notes/");
      expect(existsSync(join(spec.worktree, "notes"))).toBe(false);
      // the copy lies outside the registry's roots, and still belongs to the repo it was cut for
      expect(repoForPath(spec.worktree)?.name).toBe("w");
    }
  });

  test("a registered repo whose base and head have no manifest row still gets a copy without the rows its change start has", () => {
    const f = fixture(repoOf("idd-map-start-only-", { "AGENTS.md": "# a\n", "overlay.manifest": `${MANIFEST}notes/\n`, "notes/n.md": "note v1\n" }, { "lib/a.dart": "a\n" }));
    gitIn(f.root, "branch", "-M", "main");
    gitIn(f.root, "checkout", "-q", "-b", "lane", f.base);
    gitIn(f.root, "branch", "-f", "main", f.base);
    // the lane drops the manifest before its base: no rev the blind reads lists a row
    const base = dropManifest(f.root);
    put(f.root, "lib/a.dart", "a\n");
    put(f.root, "notes/n.md", "note v2\n");
    const head = commit(f.root, "lane head");
    ownRepos(`repos:\n  o/w:\n    upstream: ${f.root}\n    work: ${f.root}\n`);
    const { specs, copyRoot } = cut(f, [route(1, { paths: ["notes/n.md"] }), route(2, { paths: ["notes/n.md", "lib/a.dart"] })], { base, head });
    expect(copyRoot).not.toBeNull();
    expect(specs.map((b) => b.label)).toEqual(["r1", "rest"]);
    for (const b of specs) {
      const spec = load(b.specPath);
      expect(spec.worktree.startsWith(`${copyRoot}/`)).toBe(true);
      expect(spec.focus.join("\n")).not.toContain("notes/");
      expect(existsSync(join(spec.worktree, "notes"))).toBe(false);
      expect(gitIn(spec.worktree, "diff", "--name-only", spec.diff.base, spec.diff.head)).toBe("lib/a.dart");
    }
    // the map's worktree keeps them
    expect(readFileSync(join(f.root, "notes", "n.md"), "utf8")).toBe("note v2\n");
  });
});

describe("the copies of a routed round", () => {
  /** a repo whose head changes lib/r1.dart … lib/r<n>.dart */
  function repoWithFiles(n: number): { root: string; base: string; head: string } {
    const root = tmpDir("idd-map-files-");
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "AGENTS.md"), "# a\n");
    gitIn(root, "add", "-A"); gitIn(root, "commit", "-q", "-m", "base");
    const base = gitIn(root, "rev-parse", "HEAD");
    mkdirSync(join(root, "lib"), { recursive: true });
    for (let i = 1; i <= n; i += 1) writeFileSync(join(root, "lib", `r${i}.dart`), `x${i}\n`);
    gitIn(root, "add", "-A"); gitIn(root, "commit", "-q", "-m", "head");
    return { root, base, head: gitIn(root, "rev-parse", "HEAD") };
  }

  function fakes(fail: { addAt?: number; runAt?: number } = {}) {
    const log = { added: [] as string[], removed: [] as string[], started: [] as string[], stopped: [] as string[] };
    let adds = 0;
    let runs = 0;
    return {
      log,
      deps: {
        addWorktree: (_repo: unknown, o: { name?: string }) => {
          adds += 1;
          if (adds === fail.addAt) throw new Error("No space left on device");
          const path = join(tmpDir("idd-map-copy-"), `copy-${o.name}`);
          mkdirSync(path, { recursive: true });
          log.added.push(path);
          return { path } as never;
        },
        removeWorktree: (_repo: unknown, path: string) => { log.removed.push(path); return {} as never; },
        runLane: async (specPath: string) => {
          runs += 1;
          if (runs === fail.runAt) throw new Error("spawn failed");
          const id = `L${runs}`;
          log.started.push(specPath);
          return { id } as never;
        },
        stopLane: (id: string) => { log.stopped.push(id); return {} as never; },
      },
    };
  }

  function useRoles(yaml: string): void {
    const state = tmpDir("idd-map-copies-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, yaml);
  }

  const routes = (n: number) => Array.from({ length: n }, (_, i) => route(i + 1));

  test("never cut more copies than the blind cap allows at once (concurrency × roles), capping the routes", async () => {
    // two roles, one lane at a time: two copies, so the whole-diff blind and one route together
    useRoles(ROLES_YAML.replace("review_blind: { roles: [b1, b2], concurrency: 2 }", "review_blind: { roles: [b1, b2], concurrency: 1 }").replace("max_routes: 3", "max_routes: 5"));
    const { root, base, head } = repoWithFiles(5);
    const f = fakes();
    const res = await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: root, base, head, inputs: [], routes: routes(5) }, f.deps);
    expect(res.runIds).toHaveLength(2);
    expect(f.log.added).toHaveLength(2);
    const rest = yamlLoad(readFileSync(f.log.started[1], "utf8")) as { focus: string[] };
    expect(rest.focus.join("\n")).toContain("lib/r2.dart");
  });

  test("a cap below two copies leaves no room for a routed round, so the diff is not mapped", () => {
    const roles = parseRoles(ROLES_YAML.replace("review_blind: { roles: [b1, b2], concurrency: 2 }", "review_blind: { roles: [b1], concurrency: 1 }"));
    const { root, base, head } = repoWithDiff(60);
    expect(riskMapSkipReason({ worktree: root, base, head }, roles)).toMatch(/2 本未満/);
  });

  test("a copy that cannot be cut takes down the copies cut before it, and no run starts", async () => {
    useRoles(ROLES_YAML);
    const { root, base, head } = repoWithFiles(3);
    const f = fakes({ addAt: 3 });
    await expect(startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: root, base, head, inputs: [], routes: routes(3) }, f.deps)).rejects.toThrow(/No space/);
    expect(f.log.started).toEqual([]);
    expect(f.log.removed.sort()).toEqual(f.log.added.sort());
  });

  test("a run that cannot start stops the runs started before it and takes down every copy", async () => {
    useRoles(ROLES_YAML);
    const { root, base, head } = repoWithFiles(3);
    const f = fakes({ runAt: 2 });
    await expect(startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: root, base, head, inputs: [], routes: routes(3) }, f.deps)).rejects.toThrow(/spawn failed/);
    expect(f.log.stopped).toEqual(["L1"]);
    expect(f.log.removed.sort()).toEqual(f.log.added.sort());
  });

  test("two maps of the same round never share a directory or a report", async () => {
    useRoles(ROLES_YAML);
    const { root, base, head } = repoWithDiff(80);
    const f = fakes();
    await startReviewRuns({ iddId: "IDD-1", stage: "map", round: 1, worktree: root, base, head, inputs: [] }, f.deps);
    await startReviewRuns({ iddId: "IDD-1", stage: "map", round: 1, worktree: root, base, head, inputs: [] }, f.deps);
    expect(f.log.started).toHaveLength(2);
    const [a, b] = f.log.started.map((p) => yamlLoad(readFileSync(p, "utf8")) as { report: string });
    expect(f.log.started[0]).not.toBe(f.log.started[1]);
    expect(a.report).not.toBe(b.report);
  });

  test("a routed round says which of its runs reads the whole diff: the leftovers one", async () => {
    useRoles(ROLES_YAML);
    const { root, base, head } = repoWithFiles(2);
    const f = fakes();
    const res = await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: root, base, head, inputs: [], routes: routes(2) }, f.deps);
    expect(res.runIds).toEqual(["L1", "L2", "L3"]);
    expect(res.runLabels).toEqual(["r1", "r2", "rest"]);
    expect(res.wholeDiff).toEqual(["L3"]);
  });

  test("a routed round records how many routes the map brought and whether that passed the cap", async () => {
    useRoles(ROLES_YAML);
    const { root, base, head } = repoWithFiles(5);
    const f = fakes();
    const res = await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: root, base, head, inputs: [], routes: routes(5) }, f.deps);
    expect(res.routeCount).toBe(5);
    expect(res.routesOverCap).toBe(true);
  });
});
