import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { load as yamlLoad } from "js-yaml";

import { INTENT_PURPOSE } from "../../idd-core/src/plan/prompt-text.ts";
import { readStandard, solvingStandardNote, standardsPath } from "../../idd-core/src/rules/rules.ts";
import { acReviewRule, planReviewFocus, planReviewTask, writePlanReviewSpec } from "../src/plan-review.ts";
import { startReviewRuns, stageTask } from "../src/review-runs.ts";
import { commitAll, emptyRepo, git, writeFiles } from "./helpers/git.ts";
import { isolateRepos } from "./helpers/repos.ts";
import { tmpDir } from "./helpers/tmp.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

/** the principle's own sentence: it lives in the standard, so no prompt may carry it */
const PRINCIPLE_BODY = "系が特別扱いなしにその課題を満たす形へ直すものである";

/** the prompt names the standard and each number, and carries none of the principle's own sentence */
function expectCites(task: string, numbers: string[]): void {
  expect(task).toContain("_docs/standards/solving.md");
  for (const n of numbers) expect(task).toContain(n);
  expect(task).not.toContain(PRINCIPLE_BODY);
}

/** every needle is in the text */
function has(text: string, ...needles: string[]): void {
  for (const n of needles) expect(text).toContain(n);
}

/** no needle is in the text */
function lacks(text: string, ...needles: string[]): void {
  for (const n of needles) expect(text).not.toContain(n);
}

describe("the solving standard is cited by number and never copied", () => {
  test("AC-001: the standard holds the seven principles and the six first rules, and the workflow names it", () => {
    const solving = readStandard("solving")?.body ?? "";
    for (const p of ["P1", "P2", "P3", "P4", "P5", "P6", "P7"]) expect(solving).toContain(`**${p}.`);
    for (const r of ["R1", "R3", "R5", "R9", "R10", "R11"]) expect(solving).toMatch(new RegExp(`\\| ${r} \\|`));
    expect(readFileSync(join(repoRoot, "_docs", "standards", "workflow.md"), "utf8")).toContain("`solving.md`");
  });

  test("AC-003: the plan review sends a symptom-only, bridging or unrecorded plan back by number", () => {
    for (const shape of ["docs", "state"] as const) {
      expectCites(planReviewTask(true, shape, "request", true), ["R1", "P1", "P4", "P7", "R9"]);
    }
    expect(planReviewFocus(true, "state", "request").join("\n")).toContain("P1・P4・P7");
    // a plan in the old design form keeps its lens and reads the same principles; where the stopgap is recorded follows the lane's shape
    for (const shape of ["docs", "state"] as const) {
      expectCites(planReviewTask(true, shape, "design"), ["R1", "R3", "P1", "P4", "R9"]);
    }
    const docsDesign = planReviewTask(true, "docs", "design");
    has(docsDesign, "後続の Issue の案", "Choice や DEC は求めず");
    lacks(docsDesign, "応急処置の Choice の草案");
    // the AC section is the work standard's own words (it names the docs lane's follow-up Issue too), so it is not this lens's wording
    const stateDesign = planReviewTask(true, "state", "design").replace(acReviewRule("state"), "");
    has(stateDesign, "応急処置の Choice の草案");
    lacks(stateDesign, "後続の Issue の案");
    has(planReviewFocus(true, "docs", "design").join("\n"), "後続の Issue の案");
    has(planReviewFocus(true, "state", "design").join("\n"), "応急処置の Choice の草案");
  });

  test("AC-003: the blind, the last review and the judgement cite the standard, and the blind still gets no purpose", () => {
    for (const stage of ["blind", "final"] as const) {
      const task = stageTask(stage);
      expectCites(task, ["P1・P4・P7"]);
      expect(task).not.toContain(INTENT_PURPOSE);
    }
    has(stageTask("triage"), "P1・P4・P7", "頻度に関わらず must");
    has(stageTask("spec"), "応急処置の Choice");
  });
});

describe("the principle is read where there is no plan, and a declared contract's compatibility is not a bridge", () => {
  test("AC-003: a state lane with no plan is reviewed against the standard by number", () => {
    expectCites(planReviewTask(false, "state"), ["R1", "R3", "R9", "P1", "P4", "P7"]);
    expect(planReviewFocus(false, "state").join("\n")).toContain("P1・P4・P7");
  });

  test("AC-003: an old-form lane with no plan reads decision.md and qa.md by number, and asks for the stopgap in the follow-up Issue's draft", () => {
    const task = planReviewTask(false, "docs");
    expectCites(task, ["R1", "R3", "R9", "P1", "P4", "P7"]);
    has(task, "decision.md・qa.md", "Choice や DEC は求めない", "後続の Issue の案");
    lacks(task, "応急処置の Choice の草案");
    const focus = planReviewFocus(false, "docs").join("\n");
    has(focus, "P1・P4・P7", "後続の Issue の案");
    lacks(focus, "Choice の草案");
    // the state form keeps its own lens, and the base questions are not repeated in either
    has(planReviewFocus(false, "state").join("\n"), "Choice の草案");
    for (const shape of ["docs", "state"] as const) {
      const list = planReviewFocus(false, shape);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  test("AC-003: every plan review lens leaves a compatibility that keeps a declared contract alone", () => {
    const tasks = [
      planReviewTask(false, "state"),
      planReviewTask(false, "docs"),
      ...(["docs", "state"] as const).flatMap((shape) => [planReviewTask(true, shape, "request", true), planReviewTask(true, shape, "design")]),
    ];
    for (const task of tasks) {
      // a contract needs no declaration when it is a persisted format or a public interface: the standard defines it, the prompt names the section
      has(task, "`contracts`", "P5", "宣言が無くても契約になるもの");
    }
  });

  test("AC-001: the machine check of bridges is R12, apart from the retired R2", () => {
    const solving = readStandard("solving")?.body ?? "";
    expect(solving).toMatch(/R12（橋渡しの機械判定/);
    expect(solving).not.toMatch(/R2（橋渡しの機械判定/);
  });

  test("AC-003: the review and the judgement draw the bridge/contract line at the declared list, never at a compatibility's look", () => {
    const stages = [
      stageTask("blind"),
      stageTask("final"),
      stageTask("spec"),
      stageTask("spec", { recordsShape: "docs" }),
      stageTask("triage"),
      stageTask("triage", { recordsShape: "docs" }),
      stageTask("blind", { scope: "conflict" }),
    ];
    for (const task of stages) {
      has(task, "config/repos.yaml", "`contracts`", "指摘にも must にもしない");
    }
  });

  test("AC-003: no review prompt copies the standard's own definition of a bridge", () => {
    for (const task of [stageTask("blind"), stageTask("final"), stageTask("spec"), stageTask("triage"), stageTask("blind", { scope: "conflict" })]) {
      lacks(task, "旧い形と新しい形を共存させるためだけ");
    }
  });
});

describe("a stopgap is accepted only where a follow-up Issue is pointed at, in the shape the lane records in", () => {
  test("AC-005: the judgement rejects a stopgap only when the draft it points at is in the list it is handed, and the body records it", () => {
    const noList = "一覧が「なし」のとき、一覧に案が無いとき、一覧が入力に無いときは";
    const triage = stageTask("triage");
    has(triage, "revisit が指す後続の Issue の案", "followup-issues-*.md", "実在し", "revisit が後続の Issue を指さない Choice は記録の不備");
    // no list, an empty list and a list without the draft are the same: nothing the judgement can take as present
    has(triage, noList, "reject にしない");
    const docs = stageTask("triage", { recordsShape: "docs" });
    has(docs, "followup-issues-*.md", "一覧に、R9 の記録を本文に持つ案が実在し", noList);
    // a pointer in the lane's report is no draft; the list is the only ground
    has(docs, "lane の報告の記述だけのものを含む");
    lacks(docs, "revisit");
  });

  test("AC-005: in the state shape the Choice holds the record, so the judgement does not ask the draft's body to repeat it", () => {
    const triage = stageTask("triage");
    // a stopgap with its Choice (R9) and a revisit that points at a listed draft can be rejected
    has(triage, "R9 の記録を持つ Choice の範囲に収まり", "その revisit が指す後続の Issue の案", "実在するものだけで", "同じ記録を重ねては求めない");
    lacks(triage, "案の本文に R9 の記録");
    // the must list does not include a draft whose body lacks the record
    const musts = triage.slice(triage.indexOf("記録の無いもの"));
    lacks(musts, "案の本文に記録が無い");
    // the body record is the docs shape's place only
    has(stageTask("triage", { recordsShape: "docs" }), "R9 の記録を本文に持つ案が実在し");
  });

  test("AC-005: an old-form lane is asked for a follow-up Issue's draft, never a Choice or a note on the place, in the review and the plan review", () => {
    const spec = stageTask("spec", { recordsShape: "docs" });
    has(spec, "後続の Issue の案", "場所に付いた指摘は後続の Issue の代わりにならない");
    lacks(spec, "応急処置の Choice");
    const plan = planReviewTask(true, "docs", "request", true);
    has(plan, "Choice や DEC は求めない");
    lacks(plan, "応急処置の Choice の草案");
    lacks(planReviewFocus(true, "docs", "request").join("\n"), "Choice の草案");
    has(planReviewTask(true, "state", "request", true), "応急処置の Choice の草案");
    has(planReviewFocus(true, "state", "request").join("\n"), "Choice の草案");
  });

  test("AC-004: the scope look does not count a change that reaches the cause as leaving the plan", () => {
    has(stageTask("spec"), "課題の原因に届くために必要な計画の範囲外の変更", "P2・R11");
  });
});

describe("a review lane (someone else's PR) is not handed this harness's standard", () => {
  const reviewTasks = () => [
    stageTask("blind", { laneKind: "review" }),
    stageTask("final", { laneKind: "review" }),
    stageTask("final", { laneKind: "review", scope: "increment" }),
    stageTask("blind", { laneKind: "review", scope: "conflict" }),
    stageTask("final", { laneKind: "review", scope: "conflict" }),
  ];

  test("AC-003: the blind and the last review of a review lane name neither the standard nor the contract list", () => {
    for (const task of reviewTasks()) {
      lacks(task, "solving.md", "P1・P4・P7", "`contracts`");
      // what the review lane's task keeps is its own writing and severity rules
      has(task, "重要度");
    }
  });

  test("AC-003: the Issue lane keeps reading the standard, with or without the lane kind", () => {
    for (const laneKind of [undefined, "issue" as const]) {
      const opts = laneKind ? { laneKind } : {};
      for (const task of [
        stageTask("blind", opts),
        stageTask("final", opts),
        stageTask("final", { ...opts, scope: "increment" }),
        stageTask("blind", { ...opts, scope: "conflict" }),
        stageTask("final", { ...opts, scope: "conflict" }),
      ]) {
        expectCites(task, ["P1・P4・P7", "`contracts`"]);
      }
    }
  });
});

describe("the conflict scope reads the resolution against the standard", () => {
  test("AC-003: the conflict blind and final cite the standard by number and keep to the resolved hunks", () => {
    for (const stage of ["blind", "final"] as const) {
      const task = stageTask(stage, { scope: "conflict" });
      expectCites(task, ["P1・P4・P7"]);
      has(task, "範囲は解消の hunk に限る");
    }
  });
});

// config/repos.yaml is the operator's own declaration and a public checkout may not carry it: without it the
// contracts cannot be read, so these checks are skipped rather than failing the whole suite at registration
const reposFile = join(repoRoot, "config", "repos.yaml");
const hasRepos = existsSync(reposFile);
type Contract = { name?: string; what?: string };
const contracts: Contract[] = hasRepos
  ? ((yamlLoad(readFileSync(reposFile, "utf8")) as { repos?: Record<string, { contracts?: Contract[] }> }).repos?.["penne-0505/pi-web-idd"]?.contracts ?? [])
  : [];

describe("the propter contracts are declared in config/repos.yaml", () => {
  test.skipIf(!hasRepos)("AC-006: the list is one place, each item has a name and what depends on it", () => {
    expect(contracts.length).toBeGreaterThan(0);
    for (const c of contracts) {
      expect(typeof c.name).toBe("string");
      expect(typeof c.what).toBe("string");
    }
    expect(new Set(contracts.map((c) => c.name)).size).toBe(contracts.length);
  });

  test.skipIf(!hasRepos)("AC-006: the persisted formats and the public interfaces are in it, and the engine-to-screen API is not", () => {
    const text = contracts.map((c) => `${c.name} ${c.what}`).join("\n");
    has(text, "台帳", "CLI", "設定ファイル", "install", "外への書き込み", "agent の API");
    lacks(text, "画面");
  });
});

// a tree the roles read may hold no copy of the standard (an adopted repo keeps none): they are told where the package's original is
describe("a tree without solving.md is told where the original is, and the principles are not copied", () => {
  isolateRepos();
  const original = join(standardsPath(), "solving.md");
  const ROLES = [
    "models:", "  x-v:", "    model: x/v", "  x-j:", "    model: x/j",
    "roles:", "  v: { model: x-v, report: review }", "  s: { model: x-v, report: review }", "  judge: { model: x-j, report: triage }",
    "pipeline:", "  review_blind: { roles: [v] }", "  spec_check: { role: s }", "  triage: { role: judge }", "",
  ].join("\n");

  /** a git tree of its own, with solving.md in it or not; the copy a run reads is this tree */
  function tree(withStandard: boolean): { dir: string; base: string; head: string } {
    const dir = emptyRepo("idd-solving-tree-");
    writeFiles(dir, { "AGENTS.md": "# a\n", "a.ts": "export const a = 1;\n", ...(withStandard ? { "_docs/standards/solving.md": "# solving\n" } : {}) });
    commitAll(dir, "base");
    const base = git(dir, "rev-parse", "HEAD");
    writeFiles(dir, { "a.ts": "export const a = 2;\n" });
    commitAll(dir, "head");
    return { dir, base, head: git(dir, "rev-parse", "HEAD") };
  }

  /** every stage that names solving.md, started for the lane kind; each run's spec is read back */
  async function specsOf(t: ReturnType<typeof tree>, laneKind?: "review"): Promise<{ stage: string; inputs: string[]; task: string }[]> {
    const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_ROLES_FILE: process.env.IDD_ROLES_FILE };
    const state = tmpDir("idd-solving-state-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, ROLES);
    const paths: string[] = [];
    const deps = {
      addWorktree: (_r: unknown, o: { name: string }) => ({ path: t.dir, name: o.name }) as never,
      removeWorktree: () => {},
      runLane: async (p: string) => { paths.push(p); return { id: `L${paths.length}` } as never; },
      stopLane: () => ({}) as never,
    };
    try {
      const common = { iddId: "IDD-1", round: 1, worktree: t.dir, base: t.base, head: t.head, inputs: [], ...(laneKind ? { laneKind } : {}) };
      // a review lane is given no spec check (it has no plan to check against)
      await startReviewRuns({ ...common, stage: "blind", ...(laneKind ? {} : { spec: { count: 1, inputs: [] } }) }, deps);
      await startReviewRuns({ ...common, stage: "final" }, deps);
      await startReviewRuns({ ...common, stage: "triage" }, deps);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    return paths.map((p) => yamlLoad(readFileSync(p, "utf8")) as { stage: string; inputs: string[]; task: string });
  }

  test("AC-003: the note names the original by its absolute path, only where the tree has none", () => {
    const bare = tree(false).dir;
    const note = solvingStandardNote(bare);
    expect(note).toContain(original);
    expect(note).toContain("_docs/standards/solving.md");
    // the place only: none of the principles' own sentences goes with it
    lacks(note ?? "", PRINCIPLE_BODY, "P1");
    expect(solvingStandardNote(tree(true).dir)).toBeNull();
  });

  test("AC-003: the blind, the spec check and the judgement of an Issue lane read the original when the copy has no standard", async () => {
    const specs = await specsOf(tree(false));
    expect(specs.map((s) => s.stage).sort()).toEqual(["blind", "final", "spec", "triage"]);
    for (const s of specs) {
      has(s.task, original);
      expect(s.inputs).toContain(original);
    }
    const kept = await specsOf(tree(true));
    for (const s of kept) {
      lacks(s.task, "はこの tree に無い", original);
      expect(s.inputs).not.toContain(original);
    }
  }, 60_000);

  test("AC-003: a review lane's task and inputs name neither the standard nor its original", async () => {
    const specs = await specsOf(tree(false), "review");
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      lacks(s.task, "solving.md", original);
      expect(s.inputs).not.toContain(original);
    }
  }, 60_000);

  test("AC-003: the plan review is handed the original as an input when its tree has no standard", () => {
    const saved = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = tmpDir("idd-solving-pr-");
    try {
      const run = (withStandard: boolean) => {
        const wt = tree(withStandard).dir;
        mkdirSync(join(wt, "_docs/plan/x"), { recursive: true });
        writeFileSync(join(wt, "_docs/plan/x/plan.md"), "# plan\n");
        const { specPath } = writePlanReviewSpec({ iddId: "IDD-9", worktree: wt, role: "r", inputs: ["_docs/plan/x/plan.md"] });
        return yamlLoad(readFileSync(specPath, "utf8")) as { inputs: string[]; task: string };
      };
      const bare = run(false);
      has(bare.task, original);
      expect(bare.inputs).toContain(original);
      const kept = run(true);
      lacks(kept.task, "はこの tree に無い", original);
      expect(kept.inputs).not.toContain(original);
    } finally {
      if (saved === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved;
    }
  });
});
