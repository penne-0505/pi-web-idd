import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { load as yamlLoad } from "js-yaml";

import { changedFunctions, fixRanges, incrementContext, renderIncrementContext } from "../src/increment.ts";
import { blindCopyCap, blindRoles, blindRuns, stageRunPlans, stageTask, startReviewRuns, STAGE_TASK } from "../src/review-runs.ts";
import { pipelineSlotSize } from "../../idd-core/src/config/pipeline.ts";
import { parseRoles, readRoles } from "../src/roles.ts";
import { parseSpec, renderBrief } from "../src/spec.ts";
import { isolatePi } from "./helpers/fake-pi.ts";
import { isolateRepos } from "./helpers/repos.ts";
import { shippedConfig, shippedConfigTest } from "./helpers/shipped-config.ts";
import { tmpDir } from "./helpers/tmp.ts";

// the registry these tests read is their own, and no IDD_REPOS_FILE they set outlives them
isolateRepos();
// the pi these tests start is a stub, so the role checks do not spawn the real one
isolatePi();

const ROLES = [
  "models:",
  "  x-v:",
  "    model: x/v",
  "  x-o:",
  "    model: x/o",
  "  x-j:",
  "    model: x/j",
  "  x-r:",
  "    model: x/r",
  "roles:",
  "  v: { model: x-v, report: review }",
  "  o: { model: x-o, report: review }",
  "  judge: { model: x-j, report: triage }",
  "  rr: { model: x-r, report: review }",
  "pipeline:",
].join("\n");

describe("review_blind's extras", () => {
  const roles = parseRoles(`${ROLES}\n  review_blind: { roles: [v], first_round_extra: [o], high_risk_extra: [o, v], concurrency: 3 }\n`);
  const slot = roles.pipeline.review_blind;

  test("a round runs the slot's roles and the extras it names, each once", () => {
    expect(blindRoles(slot)).toEqual(["v"]);
    expect(blindRoles(slot, ["first_round"])).toEqual(["v", "o"]);
    expect(blindRoles(slot, ["high_risk"])).toEqual(["v", "o"]);
    expect(blindRoles(slot, ["first_round", "high_risk"])).toEqual(["v", "o"]);
    expect(stageRunPlans("final", slot, { maxRoutes: 3, extras: ["high_risk"] }).map((p) => p.role)).toEqual(["v", "o"]);
    expect(stageRunPlans("final", slot, { maxRoutes: 3 }).map((p) => p.role)).toEqual(["v"]);
    // the stages that are not a blind never take them
    expect(stageRunPlans("triage", roles.pipeline.review_blind, { maxRoutes: 3, extras: ["first_round"] }).map((p) => p.role)).toEqual(["v"]);
  });

  test("the copy cap counts the largest round, extras included", () => {
    expect(blindCopyCap(roles)).toBe(6);
    expect(blindCopyCap(parseRoles(`${ROLES}\n  review_blind: { roles: [v, o], concurrency: 2 }\n`))).toBe(4);
  });

  test("the copy cap counts the runs a round cuts, the models of a role included", () => {
    const withModels = parseRoles(`${ROLES}\n  review_blind: { role: v, models: [x-v, x-o], high_risk_extra: [o], concurrency: 2 }\n`);
    // the slot's one role runs with both of its models, and the high-risk extra cuts one more
    expect(blindRuns(withModels.pipeline.review_blind, ["first_round", "high_risk"]).length).toBe(3);
    expect(blindCopyCap(withModels)).toBe(6);
  });

  test("the engine's estimate of the copies a round cuts is the runs the round cuts", () => {
    const dir = tmpDir("idd-blind-cap-");
    const file = join(dir, "roles.yaml");
    const prev = process.env.IDD_ROLES_FILE;
    process.env.IDD_ROLES_FILE = file;
    try {
      writeFileSync(file, `${ROLES}\n  review_blind: { role: v, models: [x-v, x-o], high_risk_extra: [o], concurrency: 2 }\n`);
      const roles = readRoles(file);
      expect(pipelineSlotSize("review_blind")).toBe(blindRuns(roles.pipeline.review_blind, ["first_round", "high_risk"]).length);
    } finally {
      if (prev === undefined) delete process.env.IDD_ROLES_FILE;
      else process.env.IDD_ROLES_FILE = prev;
    }
  });

  // this repo's own roles.yaml, whose blind slot names two models for its one role
  shippedConfigTest(["roles.yaml"], "the engine's estimate of the copies a round cuts is the runs the round cuts, for the shipped roles.yaml", () => {
    const prev = process.env.IDD_ROLES_FILE;
    process.env.IDD_ROLES_FILE = shippedConfig("roles.yaml");
    try {
      const own = readRoles();
      expect(pipelineSlotSize("review_blind")).toBe(blindRuns(own.pipeline.review_blind, ["first_round", "high_risk"]).length);
    } finally {
      if (prev === undefined) delete process.env.IDD_ROLES_FILE;
      else process.env.IDD_ROLES_FILE = prev;
    }
  });

  test("an extra that names no role is refused like any slot role", () => {
    expect(() => parseRoles(`${ROLES}\n  review_blind: { roles: [v], first_round_extra: [nobody] }\n`)).toThrow(/first_round_extra: 未定義の role "nobody"/);
  });

  test("the High role's round is read from high_risk_when, and an unknown value is refused at load", () => {
    expect(parseRoles(`${ROLES}\n  review_blind: { roles: [v], high_risk_extra: [o], high_risk_when: last }\n`).pipeline.review_blind).toMatchObject({ highRiskExtra: ["o"] });
    expect(() => parseRoles(`${ROLES}\n  review_blind: { roles: [v], high_risk_extra: [o], high_risk_when: middle }\n`)).toThrow(/pipeline[.]review_blind[.]high_risk_when/);
  });
});

describe("the loop's policy blocks in roles.yaml", () => {
  test("are not stages: they need no role, and give the stages' policy", () => {
    const roles = parseRoles(`${ROLES}\n  review_blind: { roles: [v] }\n  review_final: { when: behaviour, scope: increment }\n  review_loop: { max_fix_rounds: 2, should_default: followup, after_merge: conflict }\n`);
    expect(Object.keys(roles.pipeline).sort()).toEqual(["review_blind"]);
    expect(roles.policy).toEqual({ shouldDefault: "followup" });
  });

  shippedConfigTest(["roles.yaml"], "the shipped roles.yaml reads: the depth table's two API roles, the flash role on the final, the triage value on shoulds, and no R2", () => {
    const roles = readRoles(shippedConfig("roles.yaml"));
    expect(roles.pipeline.review_blind.roles).toEqual(["blind-reviewer"]);
    expect(roles.pipeline.review_blind.models.map((m) => [m.name, m.thinking])).toEqual([["deepseek-v4.1-flash-ollama", undefined], ["gpt-6-luna", "xhigh"]]);
    expect([roles.pipeline.review_blind.firstRoundExtra, roles.pipeline.review_blind.highRiskExtra]).toEqual([undefined, ["blind-reviewer-final"]]);
    expect(roles.policy).toEqual({ shouldDefault: "triage" });
    expect(roles.pipeline.r2).toBeUndefined();
    expect(roles.pipeline.review_loop).toBeUndefined();
    expect(roles.pipeline.review_final).toBeUndefined();
  });

  test("left out, every policy is the old one", () => {
    expect(parseRoles(`${ROLES}\n  review_blind: { roles: [v] }\n`).policy).toEqual({ shouldDefault: "fix" });
  });

  test("a value it does not know fails loudly instead of quietly reading as the old behaviour", () => {
    expect(() => parseRoles(`${ROLES}\n  review_loop: { should_default: sometimes }\n`)).toThrow(/review_loop.should_default/);
    expect(() => parseRoles(`${ROLES}\n  review_loop: { max_fix_rounds: 0 }\n`)).toThrow(/max_fix_rounds/);
    expect(() => parseRoles(`${ROLES}\n  review_loop: { max_should_fix: 0 }\n`)).toThrow(/max_should_fix/);
    expect(() => parseRoles(`${ROLES}\n  review_loop: { after_merge: half }\n`)).toThrow(/after_merge/);
    expect(() => parseRoles(`${ROLES}\n  review_final: { scope: half }\n`)).toThrow(/review_final.scope/);
    expect(() => parseRoles(`${ROLES}\n  review_final: { when: sometimes }\n`)).toThrow(/review_final.when/);
    // a key retired with its stage fails loudly with what to do, instead of reading as a stage that no longer runs
    expect(() => parseRoles(`${ROLES}\n  r2: { role: rr, gate: records }\n`)).toThrow(/pipeline\.r2: R2（再構成テスト）は 2026-10-22 に外しました/);
  });

  test("the third value reads, and the should cap is accepted when it is a positive integer", () => {
    const t = parseRoles(`${ROLES}\n  review_blind: { roles: [v] }\n  review_loop: { should_default: triage, max_should_fix: 3 }\n`);
    expect(t.policy).toEqual({ shouldDefault: "triage" });
  });
});

describe("what each stage is told under the loop's policies", () => {
  test("the judgement's task is the same whatever the loop's should_default is", () => {
    // the wording no longer depends on the setting: it says the same thing under any value
    expect(stageTask("triage")).toBe(STAGE_TASK.triage);
    expect(stageTask("triage", {})).toBe(STAGE_TASK.triage);
    expect(STAGE_TASK.triage).toMatch(/must の action は必ず fix/);
  });

  test("there is no R2 stage task any more (removed 2026-10-22)", () => {
    expect("r2" in STAGE_TASK).toBe(false);
  });

  test("an increment's final reads the fixes and their callers; a conflict round reads the resolution", () => {
    expect(stageTask("final", { scope: "increment" })).toMatch(/前回のレビューの後に入った修正だけ/);
    expect(stageTask("final", { scope: "increment" })).toMatch(/呼び手まで読む/);
    expect(stageTask("final")).toBe(STAGE_TASK.final);
    expect(stageTask("blind", { scope: "conflict" })).toMatch(/衝突を解いた箇所だけ/);
    expect(stageTask("blind")).toBe(STAGE_TASK.blind);
    // a blind is never an increment
    expect(stageTask("blind", { scope: "increment" })).toBe(STAGE_TASK.blind);
  });
});

describe("the brief of a conflict round and of an increment", () => {
  const dir = tmpDir("idd-brief-");
  const role = parseRoles(ROLES).roles.v;

  test("a conflict round is shown the merge's resolution, and the lane's change only to read around it", () => {
    const spec = parseSpec(`role: v\nworktree: ${dir}\nreport: r\ndiff: { base: b0, head: h1, merge: abcdef1 }\n`, dir);
    const brief = renderBrief(spec, role);
    expect(brief).toContain('kind="conflict"');
    expect(brief).toContain("git show --cc abcdef1（本流の merge で解いた箇所。これだけ）");
    expect(brief).toContain("周りを読むとき: git diff b0 h1");
  });

  test("an increment is shown its fixes, and a mainline merge among them by its resolution", () => {
    const plain = renderBrief(parseSpec(`role: v\nworktree: ${dir}\nreport: r\ndiff: { base: b0, head: h1, increment: true }\n`, dir), role);
    expect(plain).toContain('kind="increment"');
    expect(plain).toContain("レビューの対象: git diff b0 h1");
    const merged = renderBrief(parseSpec(`role: v\nworktree: ${dir}\nreport: r\ndiff: { base: b0, head: h1, merge: abcdef1, increment: true }\n`, dir), role);
    expect(merged).toContain('kind="increment"');
    expect(merged).toContain('merge="abcdef1"');
    expect(merged).toContain("merge の解消: git show --cc abcdef1");
  });

  test("an increment's diff carries since, base and head, and reads the lane's whole change around the fixes", () => {
    const spec = parseSpec(`role: v\nworktree: ${dir}\nreport: r\ndiff: { base: prev, head: now, increment: true, laneBase: lane0 }\n`, dir);
    const brief = renderBrief(spec, role);
    expect(brief).toContain('kind="increment" since="prev" head="now"');
    expect(brief).toContain('base="lane0"');
    expect(brief).toContain("レビューの対象: git diff prev now");
    expect(brief).toContain("周りを読むときの lane の変更全体: git diff lane0 now");
  });

  test("a merge that is not a commit sha is refused", () => {
    expect(() => parseSpec(`role: v\nworktree: ${dir}\nreport: r\ndiff: { base: b0, head: h1, merge: "x; rm -rf /" }\n`, dir)).toThrow(/diff.merge/);
  });
});

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd, encoding: "utf8" }).trim();
function commit(cwd: string, files: Record<string, string>): string {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, p)), { recursive: true });
    writeFileSync(join(cwd, p), text);
  }
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "commit", "-q", "-m", "c");
  return gitIn(cwd, "rev-parse", "HEAD");
}

describe("what an increment's final reads next to its diff", () => {
  test("the changed functions come from the hunk headers and the definitions on changed lines", () => {
    const diff = [
      "@@ -10,2 +10,3 @@ export function approveOnce(id: string) {",
      "+  const x = 1;",
      "@@ -40 +41 @@ class Gate {",
      "-  open(a: number) {",
      "+  open(a: number, b = 0) {",
      "+export const loadState = async (p) => {",
      "+  if (x) {",
    ].join("\n");
    expect(changedFunctions(diff)).toEqual(["approveOnce", "Gate", "open", "loadState"]);
  });

  test("a merge among the fixes splits the range around it", () => {
    expect(fixRanges("a", "b")).toEqual([["a", "b"]]);
    expect(fixRanges("a", "b", "m")).toEqual([["a", "m^1"], ["m", "b"]]);
  });

  test("callers one hop out, the files a touched test covers, and the lane's file names", () => {
    const repo = tmpDir("idd-inc-");
    execFileSync("git", ["init", "-q", repo]);
    const laneBase = commit(repo, { "lib/state.ts": "export function loadState() { return 1; }\n", "lib/use.ts": "import { loadState } from './state';\nexport const v = loadState();\n" });
    const reviewed = commit(repo, { "lib/other.ts": "export const o = 1;\n" });
    const head = commit(repo, {
      "lib/state.ts": "export function loadState() { return 2; }\n",
      "lib/state.test.ts": "import { loadState } from './state';\nimport { o } from './other.ts';\n",
    });
    const c = incrementContext(repo, { base: reviewed, head, laneBase });
    expect(c.functions).toContain("loadState");
    expect(c.callers.some((l) => l.startsWith("lib/use.ts:2:"))).toBe(true);
    expect(c.callers.some((l) => l.startsWith("lib/state.ts:1:"))).toBe(false);
    expect(c.covered.sort()).toEqual(["lib/other.ts", "lib/state.ts"]);
    expect(c.laneFiles.sort()).toEqual(["lib/other.ts", "lib/state.test.ts", "lib/state.ts"]);
    const md = renderIncrementContext(c);
    expect(md).toContain("`lib/use.ts:2:");
    expect(md).toContain("## lane が変えたファイルの一覧（名前だけ。必要なら開く）");
  });

  test("the pipeline hands an increment's final the context and the fixes' range; a whole final gets neither", async () => {
    const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_ROLES_FILE: process.env.IDD_ROLES_FILE };
    const state = tmpDir("idd-inc-state-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, `${ROLES}\n  review_blind: { roles: [v], high_risk_extra: [o] }\n`);
    const repo = tmpDir("idd-inc-repo-");
    execFileSync("git", ["init", "-q", repo]);
    const laneBase = commit(repo, { "AGENTS.md": "# a\n", "_docs/standards/solving.md": "# solving\n", "a.ts": "export function fetchIt() {}\n" });
    const reviewed = commit(repo, { "b.ts": "fetchIt();\n" });
    const head = commit(repo, { "a.ts": "export function fetchIt() { return 1; }\n" });
    const specs: string[] = [];
    const deps = {
      addWorktree: (_repo: unknown, o: { name: string }) => ({ path: repo, name: o.name }) as never,
      removeWorktree: () => {},
      runLane: async (p: string) => { specs.push(p); return { id: `L${specs.length}` } as never; },
      stopLane: () => ({}) as never,
    };
    try {
      await startReviewRuns({ iddId: "IDD-1", stage: "final", round: 2, worktree: repo, base: reviewed, head, inputs: [], scope: "increment", laneBase, extras: ["high_risk"] }, deps);
      expect(specs.length).toBe(2);
      const spec = yamlLoad(readFileSync(specs[0], "utf8")) as { diff: Record<string, unknown>; inputs: string[]; task: string; role: string };
      expect(spec.diff).toEqual({ base: reviewed, head, increment: true, laneBase });
      expect(spec.task).toBe(stageTask("final", { scope: "increment" }));
      const context = spec.inputs.find((p) => /increment-2-/.test(p));
      expect(context).toBeDefined();
      expect(readFileSync(context!, "utf8")).toContain("`b.ts:1:");
      expect((yamlLoad(readFileSync(specs[1], "utf8")) as { role: string }).role).toBe("o");
      await startReviewRuns({ iddId: "IDD-1", stage: "final", round: 3, worktree: repo, base: laneBase, head, inputs: [] }, deps);
      const whole = yamlLoad(readFileSync(specs[2], "utf8")) as { diff: Record<string, unknown>; inputs: string[]; task: string };
      expect(whole.diff).toEqual({ base: laneBase, head });
      expect(whole.inputs.some((p) => /increment-/.test(p))).toBe(false);
      expect(whole.task).toBe(STAGE_TASK.final);
      expect(specs.length).toBe(3);
      // the judgement of a pass that closes on musts is told so; one not told keeps its usual task (a review lane's)
      writeFileSync(process.env.IDD_ROLES_FILE!, `${ROLES}\n  review_blind: { roles: [v] }\n  triage: { role: judge }\n`);
      await startReviewRuns({ iddId: "IDD-1", stage: "triage", round: 1, worktree: repo, base: laneBase, head, inputs: [], shouldDefault: "followup" }, deps);
      await startReviewRuns({ iddId: "IDD-1", stage: "triage", round: 1, worktree: repo, base: laneBase, head, inputs: [] }, deps);
      const task = (i: number) => (yamlLoad(readFileSync(specs[i], "utf8")) as { task: string }).task;
      // the same task whatever the settings say
      expect(task(3)).toBe(STAGE_TASK.triage);
      expect(task(4)).toBe(STAGE_TASK.triage);
      writeFileSync(process.env.IDD_ROLES_FILE!, `${ROLES}\n  review_blind: { roles: [v], high_risk_extra: [o] }\n`);
      specs.splice(3);
      // a conflict round carries its merge in the spec
      await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: repo, base: laneBase, head, inputs: [], scope: "conflict", merge: head }, deps);
      const conflict = yamlLoad(readFileSync(specs[3], "utf8")) as { diff: Record<string, unknown>; task: string };
      expect(conflict.diff).toEqual({ base: laneBase, head, merge: head });
      expect(conflict.task).toBe(stageTask("blind", { scope: "conflict" }));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("a conflict scope round's roles and the follow-ups already written", () => {
  const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_ROLES_FILE: process.env.IDD_ROLES_FILE };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  /** a repo with a base and a head, and a runner that records the specs it starts */
  function lane() {
    const state = tmpDir("idd-conflict-roles-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    const repo = tmpDir("idd-conflict-roles-repo-");
    execFileSync("git", ["init", "-q", repo]);
    const base = commit(repo, { "a.ts": "export const a = 1;\n" });
    const head = commit(repo, { "b.ts": "export const b = 1;\n" });
    const specs: string[] = [];
    const deps = {
      addWorktree: (_repo: unknown, o: { name: string }) => ({ path: repo, name: o.name }) as never,
      removeWorktree: () => {},
      runLane: async (p: string) => { specs.push(p); return { id: `L${specs.length}` } as never; },
      stopLane: () => ({}) as never,
    };
    return { repo, base, head, specs, deps };
  }
  const rolesOf = (specs: string[]) => specs.map((p) => (yamlLoad(readFileSync(p, "utf8")) as { role: string }).role);

  test("a conflict scope blind runs the slot's first role only; a usual blind runs every slot role", async () => {
    try {
      const { repo, base, head, specs, deps } = lane();
      writeFileSync(process.env.IDD_ROLES_FILE!, `${ROLES}\n  review_blind: { roles: [v, o], first_round_extra: [o] }\n`);
      await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 2, worktree: repo, base, head, inputs: [], scope: "conflict", merge: head }, deps);
      expect(rolesOf(specs)).toEqual(["v"]);
      specs.splice(0);
      await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: repo, base, head, inputs: [], extras: ["first_round"] }, deps);
      expect(rolesOf(specs)).toEqual(["v", "o"]);
    } finally { restore(); }
  });

  test("a high-risk conflict scope blind runs the first role and the high-risk extra", async () => {
    try {
      const { repo, base, head, specs, deps } = lane();
      writeFileSync(process.env.IDD_ROLES_FILE!, `${ROLES}\n  review_blind: { roles: [v], high_risk_extra: [o] }\n`);
      await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 2, worktree: repo, base, head, inputs: [], scope: "conflict", merge: head, extras: ["high_risk"] }, deps);
      expect(rolesOf(specs)).toEqual(["v", "o"]);
      specs.splice(0);
      await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 2, worktree: repo, base, head, inputs: [], scope: "conflict", merge: head }, deps);
      expect(rolesOf(specs)).toEqual(["v"]);
    } finally { restore(); }
  });

  test("a judgement handed the written follow-ups is told not to report the same content again", async () => {
    // the list file goes into the spec's inputs
    const task = stageTask("triage", { existingFollowups: true });
    expect(task).toMatch(/既に TODO に書いた follow-up/);
    expect(task).toMatch(/既出として扱い/);
    expect(task).not.toMatch(/R2/);
    // without the flag the task is the usual one
    expect(stageTask("triage", { existingFollowups: false })).toBe(STAGE_TASK.triage);
    try {
      const { repo, base, head, specs, deps } = lane();
      writeFileSync(process.env.IDD_ROLES_FILE!, `${ROLES}\n  review_blind: { roles: [v] }\n  triage: { role: judge }\n`);
      const list = join(process.env.IDD_STATE_DIR!, "existing.md");
      writeFileSync(list, "- should _docs/a.md: 既出\n");
      await startReviewRuns({ iddId: "IDD-1", stage: "triage", round: 2, worktree: repo, base, head, inputs: [list], existingFollowups: true }, deps);
      const spec = yamlLoad(readFileSync(specs[0], "utf8")) as { task: string; inputs: string[] };
      expect(spec.task).toMatch(/既出として扱い/);
      expect(spec.inputs).toContain(list);
    } finally { restore(); }
  });
});

// The Issue lane's judgement weighs a finding by the harm grade and the frequency table (DEC-113-7), and it
// carries no repo-specific example of harm: a repo's examples reach it as an input, not as engine text.
describe("the judgement's harm and frequency table", () => {
  const task = stageTask("triage");
  test("names the three harm grades and the four frequencies, and the two-condition rule (AC-025)", () => {
    expect(task).toMatch(/害: 3 =/);
    expect(task).toMatch(/害: .*2 =/);
    expect(task).toMatch(/害: .*1 =/);
    expect(task).toMatch(/常時 = /);
    expect(task).toMatch(/条件つき = /);
    expect(task).toMatch(/まれ = /);
    expect(task).toMatch(/事実上起きない/);
    expect(task).toMatch(/独立したまれな条件を 2 つ以上/);
    expect(task).toMatch(/認証・認可・secret の指摘は、頻度を条件つきより下に置かない/);
  });

  test("names the conditions that are a must whatever the frequency (AC-026)", () => {
    expect(task).toMatch(/頻度に関わらず must にするのは、主な経路で受け入れ条件を満たさない指摘/);
    expect(task).toMatch(/既存の active な Choice の Why と逆向きの実装/);
    expect(task).toMatch(/まれな分岐でだけ満たさない受け入れ条件は should/);
    expect(task).toMatch(/未確認（移行）の Choice との食い違いは should を超えない/);
  });

  test("carries no repo-specific example of harm (AC-042)", () => {
    expect(task).not.toMatch(/engine や tick が止まる/);
    expect(task).not.toMatch(/ほかの lane を巻き込む/);
    expect(task).not.toMatch(/利用者のデータや文面が黙って欠ける/);
    // the should fix rests on the change's intent and the harm table, not on where a must sits
    expect(task).toMatch(/この変更の意図の中で小さく直せ、害の表で should 以上に当たる/);
    expect(task).not.toMatch(/受理した must と同じファイルの同じ関数/);
  });
});

describe("the depth's role count", () => {
  const roles = parseRoles(`${ROLES}\n  review_blind: { roles: [v, o], high_risk_extra: [o], concurrency: 3 }\n`);
  const slot = roles.pipeline.review_blind;
  test("takes the slot's roles from the top, and the last review runs the high role alone (AC-007, AC-038)", () => {
    expect(stageRunPlans("blind", slot, { maxRoutes: 3, roleCount: 1 }).map((p) => p.role)).toEqual(["v"]);
    expect(stageRunPlans("blind", slot, { maxRoutes: 3, roleCount: 2 }).map((p) => p.role)).toEqual(["v", "o"]);
    expect(stageRunPlans("blind", slot, { maxRoutes: 3, roleCount: 5 }).map((p) => p.role)).toEqual(["v", "o"]);
    expect(stageRunPlans("final", slot, { maxRoutes: 3, onlyHighRisk: true }).map((p) => p.role)).toEqual(["o"]);
  });
});
