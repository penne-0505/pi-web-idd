import { describe, expect, test } from "bun:test";

import { AC_FORM_MUST_CLAUSE, AC_FORM_MUST_PLACEMENT, AC_FORM_MUST_ROOT, planReviewSeverityRules } from "../../idd-core/src/plan/review-rules.ts";
import { AC_PLACEMENT_HEADING, acStandardSection } from "../../idd-core/src/rules/rules.ts";
import { PLAN_REVIEW_FOCUS_AC_PLACEMENT, acReviewRule, planReviewFocus, planReviewTask } from "../src/plan-review.ts";

const BASE_QUESTION = "受け入れ条件とそのテストは、上で見つけた問題を検出できるか";
const FULL = acStandardSection();
const CONDITIONS_ONLY = acStandardSection(undefined, { placement: false });

describe("the plan review reads a qa.md's AC by the work standard, whether or not the lane has a plan", () => {
  test("AC-001: a v2 lane with no plan gets the section as the original and sends a non-state AC back as must", () => {
    const task = planReviewTask(false, "state");
    expect(task).toContain(FULL);
    expect(task).toContain(`次は must にして計画役へ差し戻す: ${AC_FORM_MUST_CLAUSE}`);
    // the must bar is the section's 3 conditions by reference, never a second list of them
    expect(AC_FORM_MUST_ROOT.includes("「受け入れ条件（AC）」の節の 3 条件のいずれかを満たさない") && !AC_FORM_MUST_ROOT.includes("関数名や内部の構造を主語にする")).toBe(true);
  });

  test("AC-002: a request-form plan gets the same section, and the table's must branch carries the same clause", () => {
    expect(planReviewTask(true, "state", "request", true)).toContain(FULL);
    expect(planReviewTask(true, "docs", "request", true)).toContain(CONDITIONS_ONLY);
    for (const [shape, clause] of [["state", AC_FORM_MUST_CLAUSE], ["docs", AC_FORM_MUST_ROOT]] as const) {
      const table = planReviewSeverityRules(shape);
      expect(table.indexOf(clause)).toBeGreaterThan(table.indexOf("- must:"));
      expect(table.indexOf(clause)).toBeLessThan(table.indexOf("- should:"));
    }
  });

  test("AC-003: the weight is one root handed through one helper, so every lens, plan or none, gives the same root", () => {
    const state = acReviewRule("state");
    const docs = acReviewRule("docs");
    expect(state).toContain(AC_FORM_MUST_CLAUSE);
    expect(docs).toContain(AC_FORM_MUST_ROOT);
    // the clause of a lane with Choices is the docs root and a tail: the root is written once
    expect(AC_FORM_MUST_CLAUSE).toBe(AC_FORM_MUST_ROOT + AC_FORM_MUST_PLACEMENT);
    const tasks = {
      state: [planReviewTask(false, "state"), planReviewTask(true, "state", "request"), planReviewTask(true, "state", "design")],
      docs: [planReviewTask(false, "docs"), planReviewTask(true, "docs", "request"), planReviewTask(true, "docs", "design")],
    };
    for (const task of tasks.state) expect(task).toContain(state);
    for (const task of tasks.docs) expect(task).toContain(docs);
    // the 3rd condition (a failure means the Purpose is unmet) reaches every path through the section
    for (const rule of [state, docs]) expect(rule).toContain("失敗したら Purpose が満たされないと言える");
  });

  test("AC-004: a lane with Choices is asked where a defence belongs, and the question that sent it into an AC is not read there", () => {
    expect(PLAN_REVIEW_FOCUS_AC_PLACEMENT).toContain("AC の状態・Choice の anchored・free");
    expect(PLAN_REVIEW_FOCUS_AC_PLACEMENT).toContain("AC の文を増やすことだけを直しにしていないか");
    const reads = [planReviewFocus(true, "state"), planReviewFocus(false, "state")];
    expect(reads.map((f) => f.includes(PLAN_REVIEW_FOCUS_AC_PLACEMENT))).toEqual([true, true]);
    expect(reads.map((f) => f.includes(BASE_QUESTION))).toEqual([false, false]);
    expect(planReviewFocus(true, "state", "design")).toContain(BASE_QUESTION);
  });

  test("C-285-7: an old-form lane is given the three conditions and no rule for where a defence goes, in its task and its focus", () => {
    expect(FULL).toContain(AC_PLACEMENT_HEADING);
    expect(CONDITIONS_ONLY).not.toContain(AC_PLACEMENT_HEADING);
    expect(FULL.startsWith(CONDITIONS_ONLY)).toBe(true);
    const docsTasks = [planReviewTask(false, "docs"), planReviewTask(true, "docs", "request"), planReviewTask(true, "docs", "design")];
    for (const task of docsTasks) {
      expect(task).not.toContain(AC_PLACEMENT_HEADING);
      expect(task).not.toContain(AC_FORM_MUST_PLACEMENT);
    }
    // the docs lane's focus keeps the question it had before, and its fix stays in decision.md and qa.md
    const docsFocus = [planReviewFocus(true, "docs"), planReviewFocus(false, "docs"), planReviewFocus(true, "docs", "design")];
    expect(docsFocus.map((f) => f.includes(PLAN_REVIEW_FOCUS_AC_PLACEMENT))).toEqual([false, false, false]);
    expect(planReviewFocus(false, "docs")).toContain(BASE_QUESTION);
  });

  test("C-285-1: the review is told the section is the package's, so a branch's own work.md does not split it from the planner's", () => {
    for (const shape of ["docs", "state"] as const) expect(acReviewRule(shape)).toContain("この worktree の `_docs/standards/work.md`（branch の版）が違っていても、この節だけは読み替えない");
  });
});
