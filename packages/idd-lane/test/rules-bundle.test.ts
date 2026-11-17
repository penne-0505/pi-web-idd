import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PLANNER_BUNDLE_PARTS, acStandardSection, plannerRulesBundle, standardsPath } from "../../idd-core/src/rules/rules.ts";
import { conversationArgs, piConversationArgs, stageSystemPrompts } from "../src/conversation.ts";
import type { LaneRecord } from "../src/runner.ts";
import type { RolePreset } from "../src/roles.ts";
import { tmpDir } from "./helpers/tmp.ts";

/** each part's marker, in the order the parts are listed */
const PART_BODIES = ["BRIEF-BODY", "GRANULARITY-BODY", "PROJECT-BODY", "PURPOSE-BODY", "SOLVING-BODY", "QA-BODY", "REFERENCE-BODY", "PLAN-BODY", "RISK-BODY", "AC-BODY"];

/** a standards place of our own: one body per file, so a bundle can be read back by its parts */
function standardsFixture(over: { workflow?: string; work?: string } = {}): string {
  const dir = tmpDir("idd-rules-bundle-");
  mkdirSync(join(dir, "templates"), { recursive: true });
  const files = ["brief.md", "granularity.md", "project.md", "records.md", "solving.md", "templates/qa.md", "templates/reference.md", "templates/plan.md"];
  files.forEach((rel, i) => writeFileSync(join(dir, rel), rel === "records.md"
    ? `# records.md\n\n## 単位\n\nUNIT-BODY\n\n## Purpose\n\n${PART_BODIES[i]}\n\n## Choice\n\nCHOICE-BODY\n`
    : `# ${rel}\n\n${PART_BODIES[i]}\n`));
  writeFileSync(join(dir, "workflow.md"), over.workflow ?? "# workflow\n\n## Size と Risk\n\n### Risk 分類\n\nRISK-BODY\n\n### 自動下限\n\nFLOOR-BODY\n\n## 基盤原則\n\nPRINCIPLE-BODY\n");
  writeFileSync(join(dir, "work.md"), over.work ?? "# work\n\n## 仕事の単位\n\nUNIT-BODY\n\n## 受け入れ条件（AC）\n\nAC-BODY\n\n## 検証ログ\n\nLOG-BODY\n");
  return dir;
}

const role = (name = "planner-pi", harness: "claude" | "pi" = "pi"): RolePreset => ({
  name, harness, model: "openrouter/z-ai/glm-5.3", thinking: "high", tools: ["read"], policy: [],
  report: "free", requireClean: false, budgetMinutes: 1, contextFiles: true, maxResumes: 0,
});

const laneRecord = (slot: string, over: Partial<LaneRecord> = {}): LaneRecord => ({
  id: "L1", role: "planner-pi", model: "openrouter/z-ai/glm-5.3", worktree: "/wt", spec: "", report: "",
  status: "idle", started_at: "x", role_preset: role(), slot, session_file: "s", ...over,
} as LaneRecord);

/** the value the `--flag` carries in an argument list */
const flagValue = (args: string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

describe("the planner's norms bundle is built from the originals", () => {
  test("AC-002: the ten parts come in one order, each as it stands (the Purpose section and the solving standard ride after the Project one, the acceptance-criteria section last)", () => {
    const dir = standardsFixture();
    const bundle = plannerRulesBundle(dir);
    expect(bundle).not.toBeNull();
    const text = bundle as string;
    for (const body of PART_BODIES) {
      expect(text).toContain(body);
    }
    // the order is the one the parts are listed in, whichever standards place is read
    const at = PART_BODIES.map((body) => text.indexOf(body));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(PLANNER_BUNDLE_PARTS.map((p) => p.rel)).toEqual(["brief.md", "granularity.md", "project.md", "records.md", "solving.md", "templates/qa.md", "templates/reference.md", "templates/plan.md", "workflow.md", "work.md"]);
  });

  test("AC-005: the record standard rides as its Purpose section only, and the package's original reaches the planner whole", () => {
    const fixture = plannerRulesBundle(standardsFixture()) as string;
    expect(fixture).toContain("## records.md");
    expect(fixture).toContain("PURPOSE-BODY");
    for (const outside of ["UNIT-BODY", "CHOICE-BODY"]) expect(fixture).not.toContain(outside);

    const original = readFileSync(join(standardsPath(), "records.md"), "utf8");
    const from = original.indexOf("\n## Purpose\n") + 1;
    const section = original.slice(from, original.indexOf("\n## Choice\n", from)).trim();
    expect(section).toContain("先方のチームの Issue の Purpose");
    expect((plannerRulesBundle() as string).includes(section)).toBe(true);
  });

  test("AC-002: the workflow part runs from the Risk section to the next level-2 heading", () => {
    const text = plannerRulesBundle(standardsFixture()) as string;
    expect(text).toContain("### Risk 分類");
    expect(text).toContain("RISK-BODY");
    // the subsections under Size and Risk (the floor, the depth judgement) ride along
    expect(text).toContain("FLOOR-BODY");
    expect(text).not.toContain("PRINCIPLE-BODY");
  });

  test("C-285-1: the work standard part is the acceptance-criteria section alone, and the package's own is carried as it stands", () => {
    const text = plannerRulesBundle(standardsFixture()) as string;
    expect([text.includes("AC-BODY"), text.includes("UNIT-BODY"), text.includes("LOG-BODY")]).toEqual([true, false, false]);
    expect((plannerRulesBundle() as string).includes(acStandardSection() as string)).toBe(true);
  });

  test("C-285-1: the bundle's head says the AC section is read from the package even by a lane that changes the norms", () => {
    const text = plannerRulesBundle(standardsFixture()) as string;
    const said = ["規約そのものを変える lane だけは、worktree の `_docs/standards/`", "work.md の「受け入れ条件（AC）」の節だけは、計画の査読もパッケージの原物で読むので、worktree の版で読み替えない"];
    expect(said.every((line) => text.includes(line))).toBe(true);
  });

  test("C-285-7: a reader given no placement rule gets the section up to the placement heading, and a version without the heading whole", () => {
    const work = (tail: string) => `# work\n\n## 受け入れ条件（AC）\n\nAC-BODY\n\n### 害の防ぎの置き場\n\nPLACEMENT-BODY\n${tail}`;
    const dir = standardsFixture({ work: work("\n## 検証ログ\n\nLOG-BODY\n") });
    const plain = standardsFixture();
    expect([
      acStandardSection(dir).includes("PLACEMENT-BODY"),
      acStandardSection(dir, { placement: false }),
      acStandardSection(plain, { placement: false }) === acStandardSection(plain),
    ]).toEqual([true, "## 受け入れ条件（AC）\n\nAC-BODY", true]);
    // the strict end holds for the cut too: no closing heading is still a section that cannot be read
    expect(() => acStandardSection(standardsFixture({ work: work("") }), { placement: false })).toThrow("## 検証ログ");
  });

  test("AC-002: a fix to an original reaches the next bundle, and no copy is kept", () => {
    const dir = standardsFixture();
    expect(plannerRulesBundle(dir)).toContain("BRIEF-BODY");
    writeFileSync(join(dir, "brief.md"), "# brief\n\nBRIEF-FIXED\n");
    const again = plannerRulesBundle(dir) as string;
    expect(again).toContain("BRIEF-FIXED");
    expect(again).not.toContain("BRIEF-BODY");
  });

  test("AC-002: a part that cannot be read is left out", () => {
    const dir = standardsFixture({ workflow: "# workflow\n\nno risk section here\n" });
    const text = plannerRulesBundle(dir) as string;
    expect(text).toContain("BRIEF-BODY");
    expect(text).not.toContain("## workflow.md");
  });

  test("C-285-1: a bundle that cannot carry the AC section stops, naming the file and the heading, while another part is still only left out", () => {
    for (const work of ["# work\n\n## 仕事の単位\n\nUNIT-BODY\n", undefined]) {
      const dir = standardsFixture(work === undefined ? {} : { work });
      if (work === undefined) rmSync(join(dir, "work.md"));
      expect(() => plannerRulesBundle(dir)).toThrow(new RegExp(`${join(dir, "work.md")}.*## 受け入れ条件（AC）`));
      expect(() => acStandardSection(dir)).toThrow("work.md");
    }
    expect(() => plannerRulesBundle(tmpDir("idd-rules-empty-"))).toThrow("受け入れ条件（AC）");
  });

  test("C-285-6: an AC section with no closing heading stops the bundle and never carries the text after it", () => {
    const dir = standardsFixture({ work: "# work\n\n## 受け入れ条件（AC）\n\nAC-BODY\n\n## 後続\n\nAFTER-BODY\n" });
    expect(() => plannerRulesBundle(dir)).toThrow(new RegExp(`${join(dir, "work.md")}.*## 検証ログ`));
    expect(() => acStandardSection(dir)).toThrow("## 検証ログ");
    // another part whose closing heading is missing is read to the end of its file, as it always was
    const text = plannerRulesBundle(standardsFixture({ workflow: "# workflow\n\n### Risk 分類\n\nRISK-BODY\n\n## 後続\n\nTAIL-BODY\n" })) as string;
    expect([text.includes("RISK-BODY"), text.includes("TAIL-BODY")]).toEqual([true, true]);
  });

  test("AC-002: the package's own standards place gives every part", () => {
    const text = plannerRulesBundle() as string;
    for (const part of PLANNER_BUNDLE_PARTS) expect(text).toContain(`## ${part.rel}`);
    expect(text).toContain("### Risk 分類");
  });

  test("AC-002: the solving standard reaches the planner as the original, whole", () => {
    const original = readFileSync(join(standardsPath(), "solving.md"), "utf8").trim();
    expect(original.length).toBeGreaterThan(0);
    expect((plannerRulesBundle() as string).includes(original)).toBe(true);
  });
});

describe("only the planner's replies carry the bundle", () => {
  test("AC-001: the planner's stage gets one bundle, and no other stage gets any", () => {
    const planner = stageSystemPrompts("planner");
    expect(planner.length).toBe(1);
    expect(planner[0]).toContain("## brief.md");
    for (const slot of ["executor", "blind", "review", "confirm", "r2", "plan-review", undefined]) {
      expect(stageSystemPrompts(slot)).toEqual([]);
    }
    // nothing of a lane, an Issue or a worktree is in the words: every lane's planner gets the same prefix
    expect(stageSystemPrompts("planner")).toEqual(planner);
  });

  test("AC-001: claude's planner reply is started with the bundle as its system prompt appendix", () => {
    const bundle = stageSystemPrompts("planner");
    const args = conversationArgs(role("planner-claude", "claude"), "session-1", false, undefined, bundle);
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(bundle[0]);
    expect(args[args.length - 2]).toBe("--session-id");
    // a stage with nothing to append starts as it did before
    expect(conversationArgs(role("planner-claude", "claude"), "session-1", false, undefined, stageSystemPrompts("executor"))).not.toContain("--append-system-prompt");
  });

  test("AC-001: pi's planner reply gets the same bundle, and an executor's reply does not", () => {
    const planner = piConversationArgs(laneRecord("planner"), "s", stageSystemPrompts("planner"));
    expect(planner[planner.indexOf("--append-system-prompt") + 1]).toBe(stageSystemPrompts("planner")[0]);
    expect(planner.filter((a) => a === "--append-system-prompt").length).toBe(1);
    expect(piConversationArgs(laneRecord("executor"), "s", stageSystemPrompts("executor"))).not.toContain("--append-system-prompt");
    // a reply uses the prompts it was given and reads nothing again
    const passed = piConversationArgs(laneRecord("planner"), "s", ["PASSED"]);
    expect([flagValue(passed, "--append-system-prompt"), passed.filter((a) => a === "--append-system-prompt").length]).toEqual(["PASSED", 1]);
    expect(piConversationArgs(laneRecord("planner"), "s", [])).not.toContain("--append-system-prompt");
  });

  test("AC-001: both harnesses carry the same words", () => {
    const claude = conversationArgs(role("planner-claude", "claude"), "session-1", false, undefined, stageSystemPrompts("planner"));
    const pi = piConversationArgs(laneRecord("planner"), "s", stageSystemPrompts("planner"));
    expect(flagValue(claude, "--append-system-prompt")).toBe(flagValue(pi, "--append-system-prompt"));
  });
});
