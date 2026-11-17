import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { load as yamlLoad } from "js-yaml";

import { writePlanReviewSpec } from "../src/plan-review.ts";
import { parseRoles } from "../src/roles.ts";
import { parseSpec, readSpec, renderBrief } from "../src/spec.ts";
import { commitAll, emptyRepo, writeFiles } from "./helpers/git.ts";
import { tmpDir } from "./helpers/tmp.ts";

const roles = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  plan-reviewer: { model: x-y, report: review }\n  shape-judge: { model: x-y, report: shape }\n  t: { model: x-y, report: review }").roles;
const rulesOf = (brief: string) => /<rules>(.*)<\/rules>/.exec(brief)?.[1];

/** a worktree whose manifest names AGENTS.override.md (Meltly's work clone) or does not (this repo) */
function worktree(manifest: string | null) {
  const wt = emptyRepo("idd-brn-wt-");
  writeFiles(wt, { "AGENTS.md": "# a\n", "AGENTS.override.md": "# o\n", "plan.md": "# p\n", ...(manifest === null ? {} : { "overlay.manifest": manifest }) });
  commitAll(wt, "c");
  return wt;
}

function planReview(wt: string, extra: { rules?: string[]; shape?: boolean; role?: string } = {}) {
  const prev = process.env.IDD_STATE_DIR;
  process.env.IDD_STATE_DIR = tmpDir("idd-brn-state-");
  try {
    const { specPath } = writePlanReviewSpec({ iddId: "IDD-9", worktree: wt, inputs: ["plan.md"], role: "plan-reviewer", ...extra });
    return { specPath, spec: yamlLoad(readFileSync(specPath, "utf8")) as Record<string, unknown> };
  } finally { if (prev === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = prev; }
}

describe("the rules a plan review is handed follow the worktree's overlay.manifest", () => {
  test("a row that names AGENTS.override.md takes it out and AGENTS.md stays", () => {
    const { specPath, spec } = planReview(worktree("AGENTS.override.md\noverlay.manifest\n"));
    expect(spec.rules).toEqual(["AGENTS.md"]);
    expect(rulesOf(renderBrief(readSpec(specPath), roles["plan-reviewer"]))).toBe("`AGENTS.md`");
  });

  test("the shape judge's rules follow it too", () => {
    expect(planReview(worktree("AGENTS.override.md\noverlay.manifest\n"), { shape: true, role: "shape-judge" }).spec.rules).toEqual(["AGENTS.md"]);
  });

  test("a repo whose manifest does not name AGENTS.md hands it as before", () => {
    expect(planReview(worktree("_docs/\noverlay.manifest\n")).spec.rules).toEqual(["AGENTS.md", "AGENTS.override.md"]);
    expect(planReview(worktree(null)).spec.rules).toEqual(["AGENTS.md", "AGENTS.override.md"]);
  });

  test("a file a person named for the run is not taken out by the manifest", () => {
    const wt = worktree("AGENTS.override.md\noverlay.manifest\n");
    expect(planReview(wt, { rules: ["AGENTS.override.md"] }).spec.rules).toEqual(["AGENTS.override.md"]);
    const spec = parseSpec(`role: t\nworktree: ${wt}\nrules: [AGENTS.override.md]\nreport: r\n`, wt);
    expect(spec.rules).toEqual(["AGENTS.override.md"]);
    expect(rulesOf(renderBrief(spec, roles.t))).toBe("`AGENTS.override.md`");
  });
});

describe("a brief opens with the name of the run's role", () => {
  test("a plan review and a shape judge, whose stage is empty, name their roles", () => {
    const wt = worktree(null);
    const review = planReview(wt);
    const shape = planReview(wt, { shape: true, role: "shape-judge" });
    expect(review.spec.stage).toBeUndefined();
    for (const [run, name] of [[review, "plan-reviewer"], [shape, "shape-judge"]] as const) {
      const brief = renderBrief(readSpec(run.specPath), roles[name]);
      expect(brief).toContain(`あなたはこの lane の "${name}" を担う。`);
      expect(brief).not.toContain("即席の作業");
    }
  });

  test("an ad hoc spec names its role too", () => {
    const wt = worktree(null);
    const brief = renderBrief(parseSpec(`role: t\nworktree: ${wt}\nreport: r\n`, wt), roles.t);
    expect(brief).toContain('あなたはこの lane の "t" を担う。');
    expect(brief).not.toContain("即席の作業");
  });
});
