import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { INTENT_PURPOSE, NORMS_OPENING } from "../../idd-core/src/plan/prompt-text.ts";
import { INTENT_WHY_SECTION } from "../../idd-core/src/agent/message.ts";
import { PLAN_REVIEW_FOCUS, PLAN_REVIEW_TASK, planReviewFocus, planReviewLens, planReviewTask, writePlanReviewSpec } from "../src/plan-review.ts";
import { STAGE_TASK, stageTask } from "../src/review-runs.ts";
import { parseRoles } from "../src/roles.ts";
import { renderBrief, type LaneSpec } from "../src/spec.ts";
import { tmpDir } from "./helpers/tmp.ts";

const roleOf = (report: "review" | "triage" | "map" = "review") =>
  parseRoles(`models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y, report: ${report} }\n`).roles.r;

const spec = (over: Partial<LaneSpec> = {}): LaneSpec => ({
  role: "r", worktree: tmpDir("idd-purpose-"), inputs: [], rules: [], focus: [], norms: [], iddNorms: [],
  commands: {}, report: "/r/report", setup: [], ...over,
});

describe("the purpose reaches the reading stages and never a blind", () => {
  test("AC-002: the plan review and the Issue lane's judgement carry the same words (R2, which also did, was removed 2026-10-22)", () => {
    expect(PLAN_REVIEW_TASK).toContain(INTENT_PURPOSE);
    expect(stageTask("triage")).toContain(INTENT_PURPOSE);
    expect("r2" in STAGE_TASK).toBe(false);
  });

  test("AC-003: blind / final / confirm / map / device and a review lane's judgement never carry it", () => {
    for (const stage of ["blind", "final", "confirm", "device"] as const) {
      expect(stageTask(stage)).not.toContain(INTENT_PURPOSE);
    }
    expect(stageTask("triage", { laneKind: "review" })).not.toContain(INTENT_PURPOSE);
    // the norms opening is what every stage shares: it is unchanged, so a blind never gets the purpose through it
    expect(NORMS_OPENING).toBe("propter は、Issue を 1 件ずつ lane として受け取り、計画・実装・レビュー・提出を段に分けて回す、IDD-based のハーネスである。");
    const brief = renderBrief(spec({ stage: "blind", task: STAGE_TASK.blind }), roleOf());
    expect(brief).not.toContain(INTENT_PURPOSE);
    expect(brief).not.toContain(`<${INTENT_WHY_SECTION}>`);
    expect(brief).not.toContain("<purposes>");
    for (const stage of ["blind", "final", "confirm", "map"] as const) {
      const b = renderBrief(spec({ stage, task: stageTask(stage) }), roleOf(stage === "map" ? "map" : stage === "confirm" ? "review" : "review"));
      expect(b).not.toContain(INTENT_PURPOSE);
      expect(b).not.toContain(`<${INTENT_WHY_SECTION}>`);
      expect(b).not.toContain("<purposes>");
    }
  });

  test("AC-006: the judgement is told not to accept the numberless whole row on the executor's own report", () => {
    expect(stageTask("triage")).toContain("番号の無い全体の行を、実装役の報告（evidence を含む）だけを根拠に満たしたとしない");
  });
});

describe("the plan review reads a request, a design form or records alone", () => {
  test("AC-008: with no plan the v1 task and focus are unchanged, and the records alone are read", () => {
    const v1Task = planReviewTask(false);
    expect(v1Task.slice(0, PLAN_REVIEW_TASK.length)).toBe(PLAN_REVIEW_TASK);
    expect(planReviewFocus(false)).toEqual(PLAN_REVIEW_FOCUS);
    expect(planReviewFocus(false)).toEqual(planReviewFocus(false, "docs", "design"));
  });

  test("AC-003: a request-form plan is read by the 6 observations, and the weights ride with the task", () => {
    const task = planReviewTask(true, "docs", "request");
    expect(task).not.toBe(PLAN_REVIEW_TASK);
    expect(task).toContain(INTENT_PURPOSE);
    expect(task).toContain("_docs/standards/brief.md");
    for (const o of ["原物の所在と読み方があり、要約で代えていないか", "意図に出典があるか", "完了の形に全体 1 文と実装役以外の判定者", "守ることに why", "戻す条件に入力・手段の不足", "how（順序・手順・関数の分割・テストの構成）が混ざっていないか"]) {
      expect(task).toContain(o);
    }
    // the seat-invisible gaps send the plan back; how and a rule with no why do not
    expect(task).toContain("- must: planner に差し戻す");
    expect(task).toContain("- should: planner には差し戻さない");
    // an artifact-nature whole and an original with no place send the plan back too; a lane with no original is not one
    expect(task).toContain("完了の形の全体 1 文が成果物の性質（prototype と一致する・絵が同じ・無い）である。");
    expect(task).toContain("原物があるとき、その所在と読み方が無い、または要約で代えている。");
    expect(planReviewFocus(true, "docs", "request")).toContain("how（順序・手順・関数の分割・テストの構成）が混ざっていないか");
    expect(planReviewFocus(true, "docs", "request")).toContain("decision.md の各 DEC は基準に合い、Why は因果か");
  });

  test("AC-005: a v2 lane's own Purpose draft want is on must, with or without a plan", () => {
    for (const hasPlan of [true, false]) {
      const task = planReviewTask(hasPlan, "state", "request");
      expect(task).toContain("この lane が出した Purpose の案の want が成果物の性質（prototype と一致する・絵が同じ・無い）なら must にする");
    }
  });

  test("AC-006: an existing active Purpose want is on should, and the input carries the statement and the raiser", () => {
    for (const hasPlan of [true, false]) {
      const task = planReviewTask(hasPlan, "state", "request");
      expect(task).toContain("草案が連なる既存の active な Purpose の want が成果物の性質なら、planner には差し戻さず GO の人に見えるよう should にする");
    }
  });

  test("F-124-12: the v2 no-plan task names reference.md among its inputs", () => {
    expect(planReviewTask(false, "state")).toContain("Choice のファイル・qa.md・reference.md");
  });

  test("AC-004: a request-form plan stays on the old what-breaks lens for the v1 records", () => {
    const design = planReviewTask(true, "docs", "design");
    expect(design).toContain("作業指示をレビューする。");
    expect(design).toContain("decision.md は恒久の意図の記録で、作業指示ではない。");
    expect(design).not.toContain("_docs/standards/brief.md");
  });

  test("AC-004: the plan review reads the lane's context document beside plan.md", () => {
    for (const shape of ["docs", "state"] as const) {
      const task = planReviewTask(true, shape, "request", true);
      expect(task, shape).toContain("lane の重要なコンテクストの文書（context.md）");
      expect(task, shape).toContain("plan.md と並べてこの文書を読み");
    }
    // a design-form plan was written before the section pointed at a document: the section paragraph is the request lens's
    expect(planReviewTask(true, "docs", "design", true)).not.toContain("plan.md と並べてこの文書を読み");
  });

  test("2-blind/F-1: a plan with no context document is not sent back for the section's place-only bar", () => {
    for (const shape of ["docs", "state"] as const) {
      const task = planReviewTask(true, shape, "request", false);
      // the bar that did not exist when such a plan was written is not asked of it
      expect(task, shape).not.toContain("欄は、lane のコンテクストの文書");
      expect(task, shape).not.toContain("plan.md と並べてこの文書を読み");
      // and it is said out loud, so the review is not left between the two bars
      expect(task, shape).toContain("この lane には lane のコンテクストの文書が無い");
      expect(task, shape).toContain("欄が事実を持っていても、この査読では誤りとしない");
      // the document it does not have is not named among the inputs either
      expect(task, shape).toContain(shape === "state" ? "実装役は plan.md・Choice のファイル・qa.md を読む。" : "実装役は plan.md・decision.md・qa.md を読む。");
    }
    // the default is the safe side: a caller that is not told reads the plan as one written without a document
    expect(planReviewTask(true, "docs", "request")).toBe(planReviewTask(true, "docs", "request", false));
  });

  test("AC-004: a v2 lane with no plan reads its Choice records and names no decision.md or DEC", () => {
    const task = planReviewTask(false, "state");
    expect(task).toContain(INTENT_PURPOSE);
    expect(task).toContain("Choice のファイル");
    expect(task).not.toContain("decision.md");
    expect(task).not.toContain("DEC");
    expect(task).not.toContain("plan.md");
  });

  test("AC-004: the plan's own form is read from its heading", () => {
    expect(planReviewLens("---\ntitle: p\n---\n\n## 依頼\n- x\n")).toBe("request");
    expect(planReviewLens("## Overview\n- x\n")).toBe("design");
  });

  test("AC-003: a spec whose inputs include a request-form plan is written with the request lens", () => {
    const prevState = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = tmpDir("idd-purpose-state-");
    try {
      const wt = tmpDir("idd-purpose-pr-");
      mkdirSync(join(wt, "_docs/intent/Demo/idd-009"), { recursive: true });
      mkdirSync(join(wt, "_docs/plan/Demo/idd-009"), { recursive: true });
      writeFileSync(join(wt, "_docs/intent/Demo/idd-009/decision.md"), "# d");
      writeFileSync(join(wt, "_docs/plan/Demo/idd-009/plan.md"), "---\ntitle: p\n---\n\n## 依頼\n- x\n");
      const { specPath } = writePlanReviewSpec({ iddId: "IDD-009", worktree: wt, role: "r", inputs: ["_docs/intent/Demo/idd-009/decision.md", "_docs/plan/Demo/idd-009/plan.md"] });
      const written = readFileSync(specPath, "utf8");
      expect(written).toContain("_docs/standards/brief.md");
      expect(written).toContain(INTENT_PURPOSE);
    } finally {
      if (prevState === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = prevState;
    }
  });

  test("AC-003: a design-form plan among the inputs keeps the what-breaks lens", () => {
    const prevState = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = tmpDir("idd-purpose-state2-");
    try {
      const wt = tmpDir("idd-purpose-pr2-");
      mkdirSync(join(wt, "_docs/intent/Demo/idd-009"), { recursive: true });
      mkdirSync(join(wt, "_docs/plan/Demo/idd-009"), { recursive: true });
      writeFileSync(join(wt, "_docs/intent/Demo/idd-009/decision.md"), "# d");
      writeFileSync(join(wt, "_docs/plan/Demo/idd-009/plan.md"), "## Overview\n- x\n");
      const { specPath } = writePlanReviewSpec({ iddId: "IDD-009", worktree: wt, role: "r", inputs: ["_docs/intent/Demo/idd-009/decision.md", "_docs/plan/Demo/idd-009/plan.md"] });
      const written = readFileSync(specPath, "utf8");
      expect(written).toContain("作業指示をレビューする。");
      expect(written).not.toContain("_docs/standards/brief.md");
    } finally {
      if (prevState === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = prevState;
    }
  });
});
