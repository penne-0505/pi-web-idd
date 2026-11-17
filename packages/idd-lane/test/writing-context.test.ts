import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { parsePrDraft } from "../src/pr-draft.ts";
import { SECTION_LIMIT, draftedSections, pointedHeldPr, pointedPrTemplate, pointedRules, prTemplate, publicWritingContext } from "../src/writing-context.ts";
import { commitAll, git, pushToNewOrigin, writeFiles } from "./helpers/git.ts";
import { withPointedRepo, withRepos } from "./helpers/repos.ts";
import { shows } from "./helpers/shows.ts";
import { tmpDir } from "./helpers/tmp.ts";

function repo(files: Record<string, string>): string {
  const root = tmpDir("idd-writing-");
  writeFiles(root, files);
  return root;
}

describe("publicWritingContext", () => {
  test("a PR follows the language, the PR template, the repo's PR skill and recent PRs", () => {
    const root = repo({
      ".github/PULL_REQUEST_TEMPLATE.md": "## Summary\n\n## Test plan\n",
      ".agents/skills/create-pr/SKILL.md": "Write the Summary first.",
      ".agents/skills/docs-prep/SKILL.md": "unrelated",
      "CONTRIBUTING.md": "Keep PRs small.",
    });
    const ctx = publicWritingContext(root, { kind: "pr", language: "en", recentPrs: () => [{ title: "fix: a", body: "## Summary\nfixed a" }] });
    expect(ctx).toContain("en");
    expect(ctx).toContain("## Test plan");
    expect(ctx).toContain("Write the Summary first.");
    expect(ctx).not.toContain("unrelated");
    expect(ctx).toContain("Keep PRs small.");
    expect(ctx).toContain("fixed a");
  });

  test("the PR template is read as the writer is shown it: clipped, or null when the repo has none", () => {
    const root = repo({ ".github/pull_request_template.md": "## Summary\n\n## Test plan\n" });
    expect(prTemplate(root)).toBe("## Summary\n\n## Test plan\n");
    expect(publicWritingContext(root, { kind: "pr", recentPrs: () => [] })).toContain(`## PR テンプレ（この構成に従う）\n${prTemplate(root)}`);
    const long = repo({ ".github/pull_request_template.md": `## Summary\n${"x".repeat(4000)}` });
    expect(prTemplate(long)).toBe(`## Summary\n${"x".repeat(3000 - "## Summary\n".length)}\n…`);
    expect(prTemplate(repo({ "README.md": "x" }))).toBeNull();
  });

  test("an Issue follows the issue templates and picks labels only from the existing ones", () => {
    const root = repo({ ".github/ISSUE_TEMPLATE/bug.md": "---\nname: Bug\n---\n## Steps\n" });
    const ctx = publicWritingContext(root, { kind: "issue", labels: () => ["bug", "idd-ready"] });
    expect(ctx).toContain("## Steps");
    expect(ctx).toContain("bug, idd-ready");
  });

  test("with nothing to follow, only the language is stated", () => {
    const ctx = publicWritingContext(repo({}), { kind: "pr" });
    expect(ctx).toContain("日本語");
    expect(ctx).not.toContain("テンプレ");
  });

  test("a commit message follows the commit rules the repo writes in AGENTS.md, CLAUDE.md and .claude/rules, and its recent commits", () => {
    const root = repo({
      "AGENTS.md": "# Agents\n\n## Style\n\nUse tabs.\n\n## Commit rules\n\nWrite the subject in Japanese and end with Co-Authored-By.\n",
      "CLAUDE.md": "@AGENTS.md\n\n## コミット\n\n件名は 50 字まで。\n",
      ".claude/rules/git.md": "---\npaths: ['**']\n---\n# Git\n\ncommit は Conventional Commits の形にする。\n",
      ".claude/rules/ui.md": "# UI\n\nUse AppTheme colors.\n",
    });
    const ctx = publicWritingContext(root, { kind: "commit", recentCommits: () => ["feat(auth): ログインを直す", "fix: 表示を直す"] });
    expect(ctx).toContain("Write the subject in Japanese and end with Co-Authored-By.");
    expect(ctx).toContain("件名は 50 字まで。");
    expect(ctx).toContain("Conventional Commits");
    expect(ctx).not.toContain("Use tabs.");
    expect(ctx).not.toContain("AppTheme");
    expect(ctx).toContain("feat(auth): ログインを直す");
  });

  describe("a rule the repo points at", () => {
    const SKILL = ".agents/skills/create-pr/SKILL.md";
    const skill = (commit: string) => `# create-pr\n\n## コミットメッセージ規約\n\n${commit}\n\n### 例\n\n- fix: 直す (APP-1)\n\n## PR本文テンプレート\n\n### 概要\n\n🤖 AIが作成したPR本文です。内容に問題がなければこの文を削除してください。\n\n### 手順\n\nbranch を切る。\n\n## 次の節\n\n含まれない文。\n`;
    /** a clone whose public base has one version of the rule and whose working tree has another */
    function clone(files: Record<string, string> = {}) {
      const root = repo({ [SKILL]: skill("件名は `カテゴリ: 説明 (APP-xxx)` の形にする。"), "AGENTS.md": "## Commit rules\n\nUse the AGENTS.md rule.\n", ...files });
      git(root, "init", "-q", "--initial-branch=main");
      commitAll(root, "base");
      writeFileSync(join(root, SKILL), skill("作業ツリーだけの規約。"));
      return root;
    }
    const conventions = { commit: { file: SKILL, section: "## コミットメッセージ規約" }, pr: { file: SKILL, section: "## PR本文テンプレート" } };

    test("a commit message is shown the pointed section alone, from the public base and not the working tree", () => {
      const ctx = publicWritingContext(clone(), { kind: "commit", base: "main", conventions, recentCommits: () => [] });
      shows(ctx, ["件名は `カテゴリ: 説明 (APP-xxx)` の形にする。", "fix: 直す (APP-1)", `${SKILL} の ## コミットメッセージ規約`], ["作業ツリーだけの規約", "PR本文テンプレート", "Use the AGENTS.md rule."]);
    });

    test("the section ends at the next heading of its level, and a PR is shown its own section without the AI's mark", () => {
      const ctx = publicWritingContext(clone(), { kind: "pr", base: "main", conventions, recentPrs: () => [] });
      shows(ctx, ["### 概要", "branch を切る。"], ["含まれない文", "🤖", "AIが作成した", "件名は"]);
    });

    test("the recent PRs are shown as a reference, not a precedent, to a repo that points at its PR section", () => {
      const recentPrs = () => [{ title: "fix: a", body: "body" }];
      const pointed = publicWritingContext(clone(), { kind: "pr", base: "main", conventions, recentPrs });
      expect(pointed).toContain("## 直近の PR（参考。規約の節と違っても節に従う）");
      expect(pointed).not.toContain("構成と粒度の前例");
      const commitOnly = publicWritingContext(clone(), { kind: "pr", base: "main", conventions: { commit: conventions.commit }, recentPrs });
      expect(commitOnly).toContain("## 直近の PR（構成と粒度の前例）");
    });

    test("the recent commits are shown as a reference, not a precedent, to a repo that points at its commit section", () => {
      const recentCommits = () => ["feat: a"];
      const pointed = publicWritingContext(clone(), { kind: "commit", base: "main", conventions, recentCommits });
      expect(pointed).toContain("## 直近の commit（参考。規約の節と違っても節に従う）");
      expect(pointed).not.toContain("形の前例");
      const prOnly = publicWritingContext(clone(), { kind: "commit", base: "main", conventions: { pr: conventions.pr }, recentCommits });
      expect(prOnly).toContain("## 直近の commit（形の前例）");
    });

    test("a heading with no body is a section that is not there: the writer is given no rule and no hash is recorded", () => {
      const empty = { [SKILL]: "# create-pr\n\n## コミットメッセージ規約\n\n🤖 AIが作成したPR本文です。\n\n## 次の節\n\n含まれない文。\n" };
      const root = repo(empty);
      git(root, "init", "-q", "--initial-branch=main");
      commitAll(root, "base");
      const ctx = publicWritingContext(root, { kind: "commit", base: "main", conventions, recentCommits: () => [] });
      expect(ctx).not.toContain("commit の規則（従う）");
      expect(draftedSections(root, "commit", { conventions, base: "main" })).toEqual([]);
      expect(pointedPrTemplate(root, { conventions: { pr: conventions.commit }, base: "main" })).toBeNull();
    });

    test("the section a draft read is recorded with its hash, as the file has it", () => {
      const root = clone();
      const [read] = draftedSections(root, "commit", { conventions, base: "main" });
      expect(read).toMatchObject({ kind: "commit", file: SKILL, section: "## コミットメッセージ規約" });
      expect(read!.hash).toMatch(/^[0-9a-f]{64}$/);
      // a different kind or none pointed: nothing to record
      expect(draftedSections(root, "issue", { conventions, base: "main" })).toEqual([]);
      expect(draftedSections(root, "commit", null)).toEqual([]);
    });

    test("a pointer whose file or section the base does not have gives the writer no rule, and no other rule in its place", () => {
      const root = clone({ "CONTRIBUTING.md": "Keep PRs small.", ".github/pull_request_template.md": "## Summary\n" });
      const noSection = publicWritingContext(root, { kind: "pr", base: "main", conventions: { pr: { file: SKILL, section: "## 無い節" } }, recentPrs: () => [] });
      expect(noSection).not.toContain("Keep PRs small.");
      expect(noSection).not.toContain("## Summary");
      const noFile = publicWritingContext(root, { kind: "commit", base: "main", conventions: { commit: { file: "docs/none.md", section: "## x" } }, recentCommits: () => [] });
      expect(noFile).not.toContain("Use the AGENTS.md rule.");
    });

    /** the registry's entry for "o/r", whose upstream clone has an origin; `fn` runs with IDD_REPOS_FILE set */
    const registered = <T>(upstream: string, fn: () => T, pointers: typeof conventions = conventions): T => withPointedRepo("o/r", upstream, pointers, fn);
    /** a clone whose origin is a bare repo, which another clone then moves ahead: `origin/main` here is the old one */
    function staleClone() {
      const root = clone();
      const origin = pushToNewOrigin(root);
      git(root, "fetch", "-q", "origin");
      const other = tmpDir("idd-other-");
      git(other, "clone", "-q", origin, ".");
      writeFileSync(join(other, SKILL), skill("チームが直した新しい規約。"));
      git(other, "commit", "-q", "-a", "-m", "edit the rule");
      git(other, "push", "-q", "origin", "main");
      return { root, origin };
    }

    test("the pointers are read from the registry for the repo the engine names, and the base is the public base as it is now", () => {
      const { root } = staleClone();
      // the tracking ref the clone holds is a day old: the section the writer reads is not that one
      expect(git(root, "show", `origin/main:${SKILL}`)).toContain("件名は `カテゴリ: 説明 (APP-xxx)` の形にする。");
      const ctx = registered(root, () => publicWritingContext(root, { kind: "commit", repo: "o/r", base: "origin/main", recentCommits: () => [] }));
      shows(ctx, ["チームが直した新しい規約。"], ["件名は `カテゴリ: 説明 (APP-xxx)` の形にする。", "作業ツリーだけの規約"]);
    });

    test("a public base that cannot be fetched fails the draft, and no older copy of the rule stands in", () => {
      const { root } = staleClone();
      git(root, "remote", "set-url", "origin", join(root, "no-such-origin"));
      expect(() => registered(root, () => publicWritingContext(root, { kind: "pr", repo: "o/r", recentPrs: () => [] }))).toThrow("公開側の base を取れません");
    });

    test("a kind the repo points at nothing for does not depend on the public base, whatever another kind points at", () => {
      const { root } = staleClone();
      git(root, "remote", "set-url", "origin", join(root, "no-such-origin"));
      const commitOnly = { commit: conventions.commit };
      // the commit pointer is there, the PR one is not: the PR draft is looked for as it always was and is not stopped
      const ctx = registered(root, () => publicWritingContext(root, { kind: "pr", repo: "o/r", recentPrs: () => [] }), commitOnly);
      expect(ctx).toContain("対外文書の言語");
      expect(registered(root, () => pointedRules("o/r", "pr"), commitOnly)).toBeNull();
      // the kind that does point still fails when the base cannot be fetched
      expect(() => registered(root, () => pointedRules("o/r", "commit"), commitOnly)).toThrow("公開側の base を取れません");
    });

    test("a registry with a wrong pointer is a config error, not a repo that points at nothing", () => {
      const root = clone();
      const bad = { bogus: { file: SKILL, section: "## x" } };
      expect(() => withRepos(JSON.stringify({ repos: { "o/r": { upstream: root, work: root, conventions: bad } } }), () => pointedRules("o/r", "pr"))).toThrow("知らない種類");
      // no registry file at all is unregistered, not an error
      const saved = process.env.IDD_REPOS_FILE;
      process.env.IDD_REPOS_FILE = join(tmpDir("idd-none-"), "absent.yaml");
      try { expect(pointedRules("o/r", "pr")).toBeNull(); } finally { if (saved === undefined) delete process.env.IDD_REPOS_FILE; else process.env.IDD_REPOS_FILE = saved; }
    });

    test("a repo the registry does not know, or that points at nothing, is not fetched", () => {
      const root = clone();
      expect(pointedRules("nobody/none", "pr")).toBeNull();
      withRepos(JSON.stringify({ repos: { "o/r": { upstream: root, work: root } } }), () => expect(pointedRules("o/r", "pr")).toBeNull());
    });

    test("the template a PR draft is checked against is the pointed section's own headings, from the same text the writer reads", () => {
      const root = clone({ ".github/pull_request_template.md": "## Summary\n\n## Test plan\n" });
      const at = { conventions, base: "main" };
      const template = pointedPrTemplate(root, at);
      expect(template).toBe("### 概要\n\n\n### 手順\n\nbranch を切る。");
      expect(publicWritingContext(root, { kind: "pr", base: "main", conventions, recentPrs: () => [] })).toContain(template!);
      // a draft with the section's headings passes, one with only the working tree template's headings is not asked for them
      expect(() => parsePrDraft("feat: 直す\n\n### 概要\n\n直した。\n\n### 手順\n\n手順。", { template })).not.toThrow();
      expect(() => parsePrDraft("feat: 直す\n\n## Summary\n\nx\n\n## Test plan\n\ny", { template })).toThrow("テンプレの節を欠いていました");
      // the base has no such section: no template, and the working tree's is not put in its place
      expect(pointedPrTemplate(root, { conventions: { pr: { file: SKILL, section: "## 無い節" } }, base: "main" })).toBeNull();
      // a repo that points at no PR section keeps the working tree's template
      expect(pointedPrTemplate(root, { conventions: { commit: conventions.commit }, base: "main" })).toBeUndefined();
      expect(pointedPrTemplate(root, null)).toBeUndefined();
    });

    test("the text the lane's agent handed over meets the pointed section's headings and loses the AI's mark lines, and is kept as it is for a repo that points at nothing", () => {
      const root = clone();
      const at = { conventions, base: "main" };
      // a body with the section's headings goes through, without the mark line the agent copied from the template
      const body = "### 概要\n\n直した。\n\n🤖 AIが作成したPR本文です。内容に問題がなければこの文を削除してください。\n\n### 手順\n\n手順。\n\nCo-Authored-By: A <a@example.com>";
      const kept = pointedHeldPr(root, { title: "feat: 直す", body }, at);
      expect(kept.title).toBe("feat: 直す");
      expect(kept.body).toBe("### 概要\n\n直した。\n\n\n### 手順\n\n手順。");
      // a body that does not carry the section's headings, or a title that is only a heading's words, is refused
      expect(() => pointedHeldPr(root, { title: "feat: 直す", body: "## Summary\n\nx" }, at)).toThrow("テンプレの節を欠いていました");
      expect(() => pointedHeldPr(root, { title: "概要", body }, at)).toThrow("見出し");
      expect(() => pointedHeldPr(root, { title: "🤖 Generated with Claude", body }, at)).toThrow("AI の印");
      expect(() => pointedHeldPr(root, { title: "🤖 AIが作成したPR本文です", body }, at)).toThrow("AI の印");
      // the base has no such section: there are no headings to ask for, and the marks are still taken out
      const none = { conventions: { pr: { file: SKILL, section: "## 無い節" } }, base: "main" };
      expect(pointedHeldPr(root, { title: "feat: x", body: "x\n🤖 AIが作成した" }, none).body).toBe("x");
      // a repo that points at no PR section keeps the text as the agent handed it over
      const handed = { title: "t", body: "## Summary\n\nx\n\nCo-Authored-By: A <a@example.com>" };
      expect(pointedHeldPr(root, handed, null)).toBe(handed);
    });

    test("a section is shown whole to the writer and to the heading check, and one over the limit stops the draft rather than being cut", () => {
      // the PR section's last heading comes after the old 8000-character cut
      const long = `### 概要\n\n${"あ".repeat(9000)}\n\n### 末尾の節\n\n最後の要件。`;
      const root = clone({ [SKILL]: `# s\n\n## PR本文テンプレート\n\n${long}\n` });
      const at = { conventions: { pr: { file: SKILL, section: "## PR本文テンプレート" } }, base: "main" };
      const ctx = publicWritingContext(root, { kind: "pr", base: "main", conventions: at.conventions, recentPrs: () => [] });
      expect(ctx).toContain("最後の要件。");
      expect(ctx).not.toContain("\n…");
      expect(pointedPrTemplate(root, at)).toContain("### 末尾の節");
      expect(() => parsePrDraft("feat: x\n\n### 概要\n\nx", { template: pointedPrTemplate(root, at) })).toThrow("### 末尾の節");
      const over = clone({ [SKILL]: `# s\n\n## PR本文テンプレート\n\n### 概要\n\n${"あ".repeat(SECTION_LIMIT)}\n` });
      expect(() => publicWritingContext(over, { kind: "pr", base: "main", conventions: at.conventions, recentPrs: () => [] })).toThrow("長すぎて");
      expect(() => pointedPrTemplate(over, at)).toThrow("長すぎて");
    });

    test("a repo with no pointer is read as it always was", () => {
      const ctx = publicWritingContext(clone(), { kind: "commit", base: "main", conventions: {}, recentCommits: () => [] });
      expect(ctx).toContain("Use the AGENTS.md rule.");
    });
  });
});
