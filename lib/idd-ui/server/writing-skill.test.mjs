// Covers AC-001 / AC-003 / AC-004 / AC-005
// intent: DEC-701 — skill の存在と frontmatter、brief の参照と qa_schema 指示を node --test から検査する

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { plannerBrief, executorBrief } = await import("@idd/core");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

let dir;

function rec(iddId = "IDD-903") {
  return {
    idd_id: iddId,
    parent_id: null,
    created_at: "2026-08-27T00:00:00Z",
    linear_issue_url: null,
    gh_issue_url: null,
    pull_req_url: null,
    source_type: "github",
    context: "",
    title: "test lane",
    area: "test-area",
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-writing-"));
  process.env.IDD_STATE_DIR = dir;
  process.env.IDD_AGENT_TOKEN = "test-token";
  process.env.IDD_AGENT_BASE_URL = "http://127.0.0.1:39999";
});

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_AGENT_TOKEN;
  delete process.env.IDD_AGENT_BASE_URL;
  rmSync(dir, { recursive: true, force: true });
});

describe("writing skill file (AC-001)", () => {
  it("exists under .agents/skills/ with frontmatter name and description", () => {
    const skillFile = join(repoRoot, ".agents", "skills", "writing", "SKILL.md");
    assert.equal(existsSync(skillFile), true, "SKILL.md must exist");
    const src = readFileSync(skillFile, "utf8");
    const m = src.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(m, "frontmatter must exist");
    assert.match(m[1], /^name:\s*writing$/m);
    assert.match(m[1], /^description:\s*\S/m);
  });

  it("every .agents/skills/*/SKILL.md carries frontmatter", () => {
    const skillsRoot = join(repoRoot, ".agents", "skills");
    const dirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    assert.ok(dirs.length > 0, "at least one skill directory");
    for (const name of dirs) {
      const src = readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
      assert.match(src, /^---\nname:\s*\S+\ndescription:\s*\S/m, `${name}/SKILL.md`);
    }
  });
});

describe("plannerBrief writing guidance (AC-003 / AC-005)", () => {
  it("keeps the essentials and references the skill file (AC-003)", () => {
    const brief = plannerBrief(rec());
    assert.match(brief, /1 主張 1 文/);
    assert.match(brief, /読点で節を継ぎ足さない/);
    assert.match(brief, /40 文字前後/);
    assert.match(brief, /\.agents\/skills\/writing\/SKILL\.md/);
  });

  it("instructs qa_schema: 5 and not 3 (AC-005)", () => {
    const brief = plannerBrief(rec());
    assert.match(brief, /qa_schema: 5/);
    assert.doesNotMatch(brief, /qa_schema: 3/);
  });
});

describe("executorBrief writing guidance (AC-004)", () => {
  it("references the skill file", () => {
    const brief = executorBrief(rec(), dir);
    assert.match(brief, /\.agents\/skills\/writing\/SKILL\.md/);
  });
});
