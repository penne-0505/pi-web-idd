import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load as yamlLoad } from "js-yaml";

import { isClaudeQuotaBlocked, recordClaudeQuota } from "../src/claude-quota.ts";
import { PLAN_REVIEW_TASK, planReviewTask, startPlanReviews, writePlanReviewSpec, type PlanReviewOptions } from "../src/plan-review.ts";
import { PLAN_REVIEW_STAGE } from "../src/inject.ts";
import { parseRoles } from "../src/roles.ts";
import { SHAPE_TASK } from "../src/review-runs.ts";
import { readSpec, renderBrief } from "../src/spec.ts";
import { HARNESS_NORMS, normText } from "../../idd-core/src/plan/harness-norms.ts";
import { esc } from "../../idd-core/src/agent/message.ts";
import { tmpDir } from "./helpers/tmp.ts";

describe("plan review spec", () => {
  test("hands the planner's documents as inputs with the fixed task and a per-attempt report", () => {
    const prevState = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = tmpDir("idd-prv-");
    const wt = tmpDir("idd-prv-wt-");
    mkdirSync(join(wt, "_docs/intent/Demo/t"), { recursive: true });
    writeFileSync(join(wt, "_docs/intent/Demo/t/decision.md"), "# d");
    writeFileSync(join(wt, "AGENTS.md"), "# a");
    // the tree keeps the solving standard, so the spec adds neither a place note nor an input for it
    mkdirSync(join(wt, "_docs/standards"), { recursive: true });
    writeFileSync(join(wt, "_docs/standards/solving.md"), "# s");
    const { specPath, report } = writePlanReviewSpec({
      iddId: "IDD-009", worktree: wt, role: "plan-reviewer", attempt: 2,
      inputs: ["_docs/intent/Demo/t/decision.md", "_docs/qa/Demo/t/qa.md"],
    });
    const spec = yamlLoad(readFileSync(specPath, "utf8")) as Record<string, unknown>;
    expect(spec.role).toBe("plan-reviewer");
    expect(spec.inputs).toEqual([join(wt, "_docs/intent/Demo/t/decision.md")]);
    expect(spec.rules).toEqual(["AGENTS.md"]);
    expect(spec.task).toBe(planReviewTask(false));
    expect((spec.task as string).startsWith(PLAN_REVIEW_TASK)).toBe(true);
    expect(report.endsWith(join("plan-review", "IDD-009-2-plan-reviewer", "plan-review"))).toBe(true);
    expect(() => writePlanReviewSpec({ iddId: "IDD-009", worktree: wt, role: "r", inputs: ["nope.md"] })).toThrow(/査読する文書/);
    if (prevState === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = prevState;
  });

  // the lane having a context document is read off the filtered inputs, the same place the plan is found (C-196-4)
  test("the task's context bar follows the context document being among the inputs", () => {
    const prevState = process.env.IDD_STATE_DIR;
    const temps: string[] = [];
    try {
      process.env.IDD_STATE_DIR = tmpDir("idd-prv-ctx-state-");
      const setup = (withContext: boolean) => {
        const wt = tmpDir("idd-prv-ctx-");
        temps.push(wt);
        mkdirSync(join(wt, "_docs/plan/Demo/t"), { recursive: true });
        writeFileSync(join(wt, "_docs/plan/Demo/t/plan.md"), "---\ntitle: p\n---\n\n## 依頼\n- x\n");
        const inputs = ["_docs/plan/Demo/t/plan.md"];
        if (withContext) {
          mkdirSync(join(wt, "_docs/context/Demo/t"), { recursive: true });
          writeFileSync(join(wt, "_docs/context/Demo/t/context.md"), "# c");
          inputs.push("_docs/context/Demo/t/context.md");
        }
        return wt;
      };
      const withDoc = yamlLoad(readFileSync(writePlanReviewSpec({ iddId: "IDD-009", worktree: setup(true), role: "r", inputs: ["_docs/plan/Demo/t/plan.md", "_docs/context/Demo/t/context.md"] }).specPath, "utf8")) as Record<string, unknown>;
      expect(String(withDoc.task)).toContain("plan.md と並べてこの文書を読み");
      expect(String(withDoc.task)).not.toContain("この lane には lane のコンテクストの文書が無い");

      const noDoc = yamlLoad(readFileSync(writePlanReviewSpec({ iddId: "IDD-009", worktree: setup(false), role: "r", inputs: ["_docs/plan/Demo/t/plan.md"] }).specPath, "utf8")) as Record<string, unknown>;
      expect(String(noDoc.task)).toContain("この lane には lane のコンテクストの文書が無い");
      expect(String(noDoc.task)).not.toContain("plan.md と並べてこの文書を読み");
    } finally {
      for (const d of temps) rmSync(d, { recursive: true, force: true });
      if (prevState === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = prevState;
    }
  });

  const rolesFile = (yaml: string) => {
    const dir = tmpDir("idd-prv-roles-");
    process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, yaml);
    return dir;
  };
  const opts = { iddId: "IDD-009", worktree: "/wt", inputs: ["d.md"], attempt: 1 };

  test("starts one run per role of the slot, and the single-role form still starts one", async () => {
    try {
      rolesFile("models:\n  x-a:\n    model: x/a\n  x-b:\n    model: x/b\nroles:\n  pa: { model: x-a, report: review }\n  pb: { model: x-b, report: review }\npipeline:\n  plan_review: { roles: [pa, pb], concurrency: 2 }\n");
      const seen: PlanReviewOptions[] = [];
      const start = async (o: PlanReviewOptions) => { seen.push(o); return { laneId: `L-${o.role}`, report: "" }; };
      const two = await startPlanReviews(opts, start);
      expect(seen.map((o) => o.role)).toEqual(["pa", "pb"]);
      expect(two).toEqual({ runs: [{ runId: "L-pa", role: "pa", model: "x/a" }, { runId: "L-pb", role: "pb", model: "x/b" }], failed: [] });

      rolesFile("models:\n  x-a:\n    model: x/a\nroles:\n  pa: { model: x-a, report: review }\npipeline:\n  plan_review: { role: pa }\n");
      const one = await startPlanReviews(opts, start);
      expect(one.runs).toEqual([{ runId: "L-pa", role: "pa", model: "x/a" }]);
    } finally { delete process.env.IDD_ROLES_FILE; }
  });

  // the stage's declared pair reaches the run: one role with two models makes two runs, each with its own
  // model definition and thinking, and each run writes its own spec and report
  test("a role that declares two models runs two reviews, each with its own model and thinking", async () => {
    const prevState = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = tmpDir("idd-prv-");
    const wt = tmpDir("idd-prv-wt-");
    writeFileSync(join(wt, "d.md"), "# d");
    try {
      rolesFile("models:\n  x-a:\n    model: x/a\n  x-b:\n    model: x/b\nroles:\n  pa: { model: x-a, report: review }\npipeline:\n  plan_review:\n    role: pa\n    models:\n      - model: x-a\n        thinking: high\n      - model: x-b\n        thinking: low\n");
      const seen: PlanReviewOptions[] = [];
      const reports: string[] = [];
      const start = async (o: PlanReviewOptions) => {
        seen.push(o);
        const { report } = writePlanReviewSpec({ ...o, worktree: wt });
        reports.push(report);
        return { laneId: `L-${o.model}`, report };
      };
      const r = await startPlanReviews({ ...opts, worktree: wt }, start);
      expect(seen.map((o) => [o.role, o.model, o.thinking])).toEqual([["pa", "x-a", "high"], ["pa", "x-b", "low"]]);
      // the resolved model is the one the definition names: the record shows the call target
      expect(r.runs.map((x) => x.model)).toEqual(["x/a", "x/b"]);
      // the two runs of one role do not fold into one, and they do not share a spec or a report
      expect(r.runs.map((x) => x.runId)).toEqual(["L-x-a", "L-x-b"]);
      expect(new Set(reports).size).toBe(2);
    } finally {
      delete process.env.IDD_ROLES_FILE;
      if (prevState === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = prevState;
    }
  });

  test("the spec carries the model definition and the thinking the stage declared", () => {
    const prevState = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = tmpDir("idd-prv-");
    const wt = tmpDir("idd-prv-wt-");
    writeFileSync(join(wt, "d.md"), "# d");
    try {
      const { specPath, report } = writePlanReviewSpec({ iddId: "IDD-009", worktree: wt, role: "pa", model: "x-a", thinking: "high", inputs: ["d.md"] });
      const spec = yamlLoad(readFileSync(specPath, "utf8")) as Record<string, unknown>;
      expect(spec.model).toBe("x-a");
      expect(spec.thinking).toBe("high");
      expect(report.endsWith(join("plan-review", "IDD-009-1-pa-x-a", "plan-review"))).toBe(true);
    } finally {
      if (prevState === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = prevState;
    }
  });

  // the lane's depth decides how many of the slot's roles run: the count takes the list from the top, and a list
  // shorter than the count runs as it is (DEC-113-2)
  test("a role count from the lane's depth takes the slot's roles from the top", async () => {
    try {
      rolesFile("models:\n  x-a:\n    model: x/a\n  x-b:\n    model: x/b\nroles:\n  pa: { model: x-a, report: review }\n  pb: { model: x-b, report: review }\npipeline:\n  plan_review: { roles: [pa, pb], concurrency: 2 }\n");
      const start = async (o: PlanReviewOptions) => ({ laneId: `L-${o.role}`, report: "" });
      const first = await startPlanReviews({ ...opts, roles: 1 }, start);
      expect(first.runs.map((r) => r.role)).toEqual(["pa"]);
      const both = await startPlanReviews({ ...opts, roles: 2 }, start);
      expect(both.runs.map((r) => r.role)).toEqual(["pa", "pb"]);
      const over = await startPlanReviews({ ...opts, roles: 5 }, start);
      expect(over.runs.map((r) => r.role)).toEqual(["pa", "pb"]);
    } finally { delete process.env.IDD_ROLES_FILE; }
  });

  test("a role that cannot start is listed as failed while the others run; none starting is an error", async () => {
    try {
      rolesFile("models:\n  x-a:\n    model: x/a\n  x-b:\n    model: x/b\nroles:\n  pa: { model: x-a }\n  pb: { model: x-b }\npipeline:\n  plan_review: { roles: [pa, pb] }\n");
      const half = await startPlanReviews(opts, async (o) => { if (o.role === "pa") throw new Error("no spec"); return { laneId: "L-pb", report: "" }; });
      expect(half.runs.map((r) => r.role)).toEqual(["pb"]);
      expect(half.failed).toEqual([{ role: "pa", model: "x/a", error: "no spec" }]);
      await expect(startPlanReviews(opts, async () => { throw new Error("down"); })).rejects.toThrow(/pa: down.*pb: down/);
    } finally { delete process.env.IDD_ROLES_FILE; }
  });

  test("a Claude Code role nobody logged in to fails alone; the other roles still start", async () => {
    const root = rolesFile("");
    const cfg = join(root, "cfg"); mkdirSync(cfg);
    const prevState = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = join(root, "state");
    writeFileSync(process.env.IDD_ROLES_FILE!, `defaults:\n  claude_config_dir: ${cfg}\nmodels:\n  x-a:\n    model: x/a\nroles:\n  pa: { model: x-a }\n  deep: { harness: claude, model: opus }\npipeline:\n  plan_review: { roles: [pa, deep] }\n`);
    const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      const seen: string[] = [];
      const r = await startPlanReviews(opts, async (o) => { seen.push(o.role); return { laneId: `L-${o.role}`, report: "" }; });
      expect(seen).toEqual(["pa"]);
      expect(r.runs.map((x) => x.role)).toEqual(["pa"]);
      expect(r.failed.map((x) => x.role)).toEqual(["deep"]);
      expect(r.failed[0].error).toMatch(/ログインしていません/);
    } finally {
      delete process.env.IDD_ROLES_FILE;
      if (prevState === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = prevState;
      if (prevToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
    }
  });

  test("a Claude Code role over its window refuses the whole review before any run starts", async () => {
    const root = rolesFile("");
    const cfg = join(root, "cfg"); mkdirSync(cfg); writeFileSync(join(cfg, ".credentials.json"), "{}");
    const prevState = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = join(root, "state");
    writeFileSync(process.env.IDD_ROLES_FILE!, `defaults:\n  claude_config_dir: ${cfg}\nmodels:\n  x-a:\n    model: x/a\nroles:\n  pa: { model: x-a }\n  deep: { harness: claude, model: opus }\npipeline:\n  plan_review: { roles: [pa, deep] }\n`);
    try {
      recordClaudeQuota(cfg, { status: "allowed", windows: { five_hour: { utilization: 0.95, resets_at: Math.floor(Date.now() / 1000) + 3600 } } });
      let started = 0;
      let caught: unknown;
      try { await startPlanReviews(opts, async () => { started += 1; return { laneId: "L", report: "" }; }); } catch (err) { caught = err; }
      expect(isClaudeQuotaBlocked(caught)).toBe(true);
      expect(started).toBe(0);
    } finally {
      delete process.env.IDD_ROLES_FILE;
      if (prevState === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = prevState;
    }
  });
  /** a lane config dir (logged in unless told otherwise) and roles with a Claude Code role that has a fallback */
  const fallbackRoles = (roles: string, opts: { login?: boolean; slot?: string[] } = {}) => {
    const root = rolesFile("");
    const cfg = join(root, "cfg"); mkdirSync(cfg);
    if (opts.login !== false) writeFileSync(join(cfg, ".credentials.json"), "{}");
    const agent = join(root, "agent"); mkdirSync(agent);
    const prev = { state: process.env.IDD_STATE_DIR, agent: process.env.IDD_PI_USER_AGENT_DIR, token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    process.env.IDD_STATE_DIR = join(root, "state");
    process.env.IDD_PI_USER_AGENT_DIR = agent;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    writeFileSync(process.env.IDD_ROLES_FILE!, `defaults:\n  claude_config_dir: ${cfg}\nmodels:\n  a: { model: x/a }\n  f: { model: x/f }\n  z: { model: x/z }\nroles:\n${roles}pipeline:\n  plan_review: { roles: [${(opts.slot ?? ["pa", "deep"]).join(", ")}] }\n`);
    recordClaudeQuota(cfg, { status: "allowed", windows: { five_hour: { utilization: 0.95, resets_at: Math.floor(Date.now() / 1000) + 3600 } } });
    return () => {
      delete process.env.IDD_ROLES_FILE;
      for (const [k, v] of [["IDD_STATE_DIR", prev.state], ["IDD_PI_USER_AGENT_DIR", prev.agent], ["CLAUDE_CODE_OAUTH_TOKEN", prev.token]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    };
  };
  const pi = (name: string, model: string) => `  ${name}:\n    model: ${model}\n    tools: [read]\n    report: review\n`;
  const deep = (fallback: string, name = "deep") => `  ${name}:\n    harness: claude\n    model: opus\n    tools: [read]\n    report: review\n    fallback: ${fallback}\n`;

  test("over the windows, a Claude Code role with a fallback runs as it beside the other roles, and the start says so", async () => {
    const done = fallbackRoles(pi("pa", "a") + deep("fb") + pi("fb", "f"));
    try {
      const seen: PlanReviewOptions[] = [];
      const r = await startPlanReviews(opts, async (o) => { seen.push(o); return { laneId: `L-${o.role}`, role: o.role, model: o.role === "fb" ? "x/f" : "x/a" }; });
      expect(seen.map((o) => [o.role, o.slotRole, o.quotaFallback?.role])).toEqual([["pa", undefined, undefined], ["fb", "deep", "deep"]]);
      expect(r.runs).toEqual([{ runId: "L-pa", role: "pa", model: "x/a" }, { runId: "L-fb", role: "fb", model: "x/f" }]);
      expect(r.failed).toEqual([]);
      expect(r.fallbacks?.map((f) => [f.role, f.fallback, f.folded ?? false])).toEqual([["deep", "fb", false]]);
      expect(r.fallbacks?.[0].reason).toMatch(/5 時間の枠/);
    } finally { done(); }
  });

  test("a fallback that is already one of the review's roles is folded into that run, not started twice", async () => {
    const done = fallbackRoles(pi("pa", "a") + deep("pa"));
    try {
      const seen: string[] = [];
      const r = await startPlanReviews(opts, async (o) => { seen.push(o.role); return { laneId: `L-${o.role}` }; });
      expect(seen).toEqual(["pa"]);
      expect(r.runs.map((x) => x.role)).toEqual(["pa"]);
      expect(r.failed).toEqual([]);
      expect(r.fallbacks?.map((f) => [f.role, f.fallback, f.folded])).toEqual([["deep", "pa", true]]);
    } finally { done(); }
  });

  /** the first start fails; the ones after it start */
  const firstFails = (seen: PlanReviewOptions[]) => async (o: PlanReviewOptions) => {
    seen.push(o);
    if (seen.length === 1) throw new Error("spawn failed");
    return { laneId: `L-${seen.length}`, role: o.role };
  };

  test("two roles falling back to the same role: when the first start fails, the second still starts it", async () => {
    const done = fallbackRoles(deep("zz") + deep("zz", "deep2") + pi("zz", "z"), { slot: ["deep", "deep2"] });
    try {
      const seen: PlanReviewOptions[] = [];
      const r = await startPlanReviews(opts, firstFails(seen));
      expect(seen.map((o) => [o.role, o.slotRole])).toEqual([["zz", "deep"], ["zz", "deep2"]]);
      expect(r.runs.map((x) => x.role)).toEqual(["zz"]);
      expect(r.failed.map((x) => x.role)).toEqual(["deep"]);
      expect(r.fallbacks?.map((f) => [f.role, f.fallback, f.folded ?? false])).toEqual([["deep2", "zz", false]]);
    } finally { done(); }
  });

  for (const slot of [["zz", "deep"], ["deep", "zz"]]) {
    test(`a fallback is not folded into a run of its role that failed to start (slot ${slot.join(", ")})`, async () => {
      const done = fallbackRoles(deep("zz") + pi("zz", "z"), { slot });
      try {
        const seen: PlanReviewOptions[] = [];
        const r = await startPlanReviews(opts, firstFails(seen));
        expect(seen.map((o) => [o.role, o.slotRole])).toEqual([["zz", undefined], ["zz", "deep"]]);
        expect(r.runs.map((x) => x.role)).toEqual(["zz"]);
        expect(r.failed.map((x) => x.role)).toEqual(["zz"]);
        expect(r.fallbacks?.map((f) => [f.role, f.fallback, f.folded ?? false])).toEqual([["deep", "zz", false]]);
      } finally { done(); }
    });

    test(`a fallback is folded into its role's run that started, whichever comes first (slot ${slot.join(", ")})`, async () => {
      const done = fallbackRoles(deep("zz") + pi("zz", "z"), { slot });
      try {
        const seen: PlanReviewOptions[] = [];
        const r = await startPlanReviews(opts, async (o) => { seen.push(o); return { laneId: `L-${o.role}`, role: o.role }; });
        expect(seen.map((o) => [o.role, o.slotRole])).toEqual([["zz", undefined]]);
        expect(r.runs.map((x) => x.role)).toEqual(["zz"]);
        expect(r.failed).toEqual([]);
        expect(r.fallbacks?.map((f) => [f.role, f.fallback, f.folded])).toEqual([["deep", "zz", true]]);
      } finally { done(); }
    });
  }

  test("a lapsed login is a failure of that role even over the windows: no fallback stands in for it", async () => {
    const done = fallbackRoles(pi("pa", "a") + deep("fb") + pi("fb", "f"), { login: false });
    try {
      const seen: string[] = [];
      const r = await startPlanReviews(opts, async (o) => { seen.push(o.role); return { laneId: `L-${o.role}` }; });
      expect(seen).toEqual(["pa"]);
      expect(r.failed.map((x) => x.role)).toEqual(["deep"]);
      expect(r.failed[0].error).toMatch(/ログインしていません/);
      expect(r.fallbacks).toBeUndefined();
    } finally { done(); }
  });

  test("a fallback's run is kept in the directory of the role the slot asked for", () => {
    const prevState = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = tmpDir("idd-prv-");
    const wt = tmpDir("idd-prv-wt-");
    writeFileSync(join(wt, "d.md"), "# d");
    try {
      const { specPath, report } = writePlanReviewSpec({ iddId: "IDD-009", worktree: wt, role: "fb", slotRole: "deep", inputs: ["d.md"] });
      expect((yamlLoad(readFileSync(specPath, "utf8")) as Record<string, unknown>).role).toBe("fb");
      expect(report.endsWith(join("plan-review", "IDD-009-1-deep", "plan-review"))).toBe(true);
    } finally {
      if (prevState === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = prevState;
    }
  });
});

describe("the plan review and the harness's rules over the repo's", () => {
  const temps: string[] = [];
  afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
  const setup = () => {
    const state = mkdtempSync(join(tmpdir(), "idd-prv-norms-"));
    const wt = mkdtempSync(join(tmpdir(), "idd-prv-norms-wt-"));
    temps.push(state, wt);
    writeFileSync(join(wt, "d.md"), "# d");
    return { state, wt };
  };
  const withState = <T>(state: string, fn: () => T): T => {
    const prev = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = state;
    try { return fn(); } finally { if (prev === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = prev; }
  };

  test("the norms told to the planner reach the plan review's brief word for word, in the norms section", () => {
    const { state, wt } = setup();
    withState(state, () => {
      const norms = [normText("lane-ids"), normText("todo-source")];
      const { specPath } = writePlanReviewSpec({ iddId: "IDD-009", worktree: wt, role: "plan-reviewer", inputs: ["d.md"], norms });
      expect((yamlLoad(readFileSync(specPath, "utf8")) as { norms?: string[] }).norms).toEqual(norms);
      const brief = renderBrief(readSpec(specPath), parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  plan-reviewer: { model: x-y, report: review }").roles["plan-reviewer"]);
      const section = brief.slice(brief.indexOf("<norms>"), brief.indexOf("</norms>"));
      const asBrief = normText("lane-ids").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      expect(section).toContain(asBrief);
      expect(section).toContain(esc(normText("todo-source")));
      expect(brief).not.toContain("## ハーネスの規則");
      expect(brief).not.toContain("## IDD の規範");
    });
  });

  test("a plan review handed no norms has none in its spec", () => {
    const { state, wt } = setup();
    withState(state, () => {
      const { specPath } = writePlanReviewSpec({ iddId: "IDD-009", worktree: wt, role: "plan-reviewer", inputs: ["d.md"] });
      expect((yamlLoad(readFileSync(specPath, "utf8")) as { norms?: string[] }).norms).toBeUndefined();
      expect((yamlLoad(readFileSync(specPath, "utf8")) as { idd_norms?: string[] }).idd_norms).toBeUndefined();
    });
  });
});

describe("the v2 lane's plan review task (AC-025)", () => {
  test("with a plan it asks about the report's Choice drafts, not decision.md's DECs", () => {
    const v2 = planReviewTask(true, "state");
    expect(v2).toContain("plan の報告の草案");
    expect(v2).toContain("既存の Choice に付いた処置");
    expect(v2).not.toContain("decision.md は恒久の意図の記録");
    expect(planReviewTask(true)).toContain("decision.md は恒久の意図の記録");
  });
});

/** run `body` with the state directory a fresh one, and the old one put back afterwards */
function inTempState<T>(body: () => T): T {
  const before = process.env.IDD_STATE_DIR;
  process.env.IDD_STATE_DIR = tmpDir("idd-shape-state-");
  try { return body(); } finally { if (before === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = before; }
}

describe("the shape judge beside a deep plan review (AC-001, AC-011)", () => {
  const BASE = "models:\n  x-a:\n    model: x/a\n  x-j:\n    model: y/j\nroles:\n  pa: { model: x-a, report: review }\n  judge: { model: x-j, report: shape }\npipeline:\n  plan_review: { roles: [pa], concurrency: 1 }\n";
  const SLOT = "  shape_judge: { role: judge, concurrency: 1 }\n";
  const opts = { iddId: "IDD-009", worktree: "/wt", inputs: ["d.md"], attempt: 1 };
  /** run `body` with the settings file holding `yaml`, and without it afterwards */
  const withRoles = async (yaml: string, body: () => Promise<void> | void) => {
    const file = join(tmpDir("idd-shape-roles-"), "roles.yaml");
    writeFileSync(file, yaml);
    process.env.IDD_ROLES_FILE = file;
    try { await body(); } finally { delete process.env.IDD_ROLES_FILE; }
  };
  const startsOf = (seen: PlanReviewOptions[]) => async (o: PlanReviewOptions) => { seen.push(o); return { laneId: `L-${o.role}`, report: "" }; };

  test("starts the judge as an extra run of its own slot, and not at all when the depth asks for none", () => withRoles(BASE + SLOT, async () => {
    const seen: PlanReviewOptions[] = [];
    const deep = await startPlanReviews({ ...opts, withShape: true }, startsOf(seen));
    expect(deep.runs.map((r) => r.role)).toEqual(["pa", "judge"]);
    expect(seen.map((o) => [o.role, Boolean(o.shape)])).toEqual([["pa", false], ["judge", true]]);
    seen.length = 0;
    const shallow = await startPlanReviews(opts, startsOf(seen));
    expect(shallow.runs.map((r) => r.role)).toEqual(["pa"]);
    expect(seen.some((o) => o.shape)).toBe(false);
  }));

  test("a settings file without the slot stops before any run starts and says what is missing", async () => {
    const seen: PlanReviewOptions[] = [];
    await withRoles(BASE, async () => {
      await expect(startPlanReviews({ ...opts, withShape: true }, startsOf(seen))).rejects.toThrow(/pipeline に "shape_judge" がありません/);
      expect(seen).toEqual([]);
    });
    // a role there that does not write the shape report is refused the same way
    await withRoles(`${BASE.replace("report: shape", "report: review")}  shape_judge: { role: judge }\n`, async () => {
      await expect(startPlanReviews({ ...opts, withShape: true }, startsOf(seen))).rejects.toThrow(/report: review。この段は shape が必要/);
    });
  });

  test("the judge's spec carries the one task and reads the same documents", () => {
    const wt = tmpDir("idd-shape-wt-");
    writeFileSync(join(wt, "d.md"), "# d");
    const { specPath, report } = inTempState(() => writePlanReviewSpec({ ...opts, worktree: wt, role: "judge", shape: true }));
    const spec = yamlLoad(readFileSync(specPath, "utf8")) as Record<string, unknown>;
    expect([spec.task, report.endsWith("shape"), specPath.endsWith("shape.yaml"), spec.inputs]).toEqual([SHAPE_TASK, true, true, [join(wt, "d.md")]]);
    // the judge reads what it is handed and no Choice is brought in beside it
    expect([spec.inject_stage, spec.inject_lane]).toEqual([undefined, undefined]);
    expect(spec.lane).toBe(opts.iddId);
    // the plan review beside it still has its injection
    const review = inTempState(() => writePlanReviewSpec({ ...opts, worktree: wt, role: "pa" }));
    const reviewSpec = yamlLoad(readFileSync(review.specPath, "utf8")) as Record<string, unknown>;
    expect([reviewSpec.inject_stage, reviewSpec.inject_lane]).toEqual([PLAN_REVIEW_STAGE, opts.iddId]);
  });
});
