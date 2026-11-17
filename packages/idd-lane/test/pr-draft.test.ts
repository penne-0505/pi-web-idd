import { describe, expect, test } from "bun:test";

import { buildCommitDraftArgs, buildPrDraftArgs, buildPrTitleArgs, parseCommitDraft, parsePrDraft, parsePrTitle, withPrTitle } from "../src/pr-draft.ts";
import { parseRoles } from "../src/roles.ts";
import { shows } from "./helpers/shows.ts";

/** the rewriter role the drafts are built for */
const role = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  rewriter: { model: x-y, thinking: low }").roles.rewriter;

describe("PR draft", () => {
  test("the rewriter writes the PR with the repo's context and no tools", () => {
    const args = buildPrDraftArgs(role, "材料", "## 対外文書の言語\nenで書く。");
    expect(args).toContain("--no-tools");
    const message = args[args.length - 1];
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("");
    expect(message).toContain("<propter-system-message>");
    expect(message).toContain("<repo-conventions>");
    expect(message).toContain("enで書く。");
    expect(message).toContain("材料");
  });

  test("the rewriter is told to leave the Issue line out, which the submit adds in the repo's form", () => {
    const args = buildPrDraftArgs(role, "材料", "");
    const message = args[args.length - 1];
    expect(message).not.toContain("Closes を入れる");
    expect(message).toContain("Issue を指す行");
  });

  test("the first line is the title and the rest the body", () => {
    expect(parsePrDraft("docs: keep the public files\n\nCloses #1\n\n- one\n")).toEqual({ title: "docs: keep the public files", body: "Closes #1\n\n- one" });
    expect(parsePrDraft("# Title: fix it\nbody")).toEqual({ title: "fix it", body: "body" });
    expect(() => parsePrDraft("   ")).toThrow();
  });

  test("the rewriter is told the title is not a template heading, and the body carries every template section", () => {
    const message = buildPrDraftArgs(role, "材料", "## PR テンプレ\n## Summary\n## Test plan").at(-1) as string;
    expect(message).toContain("見出し（Summary など）");
    expect(message).toContain("テンプレがあればその節をすべて");
    expect(message).toContain("最初の節も省かない");
    expect(message).toContain("Co-Authored-By");
  });

  test("a repo that points at its PR section is told to follow the section, and the recent PRs are for reference only", () => {
    const pointed = buildPrDraftArgs(role, "材料", "", { pointed: true }).at(-1) as string;
    shows(pointed, ["PR の規約の節に従う", "直近の PR は参考で"], ["直近の PR の題の型と言語に合わせる", "その構成に合わせる"]);
    const title = buildPrTitleArgs(role, "## Summary", "", { pointed: true }).at(-1) as string;
    shows(title, ["直近の PR は参考で"], ["直近の PR の題の型と言語に合わせる"]);
    shows(buildPrDraftArgs(role, "材料", "").at(-1) as string, ["直近の PR の題の型と言語に合わせる"]);
    shows(buildPrTitleArgs(role, "## Summary", "").at(-1) as string, ["直近の PR の題の型と言語に合わせる"]);
  });

  test("a body that starts with the template's first section keeps it under a real title", () => {
    expect(parsePrDraft("fix: keep the public files\n\n## Summary\n\n- one\n\n## Test plan\n\n- two\n")).toEqual({
      title: "fix: keep the public files",
      body: "## Summary\n\n- one\n\n## Test plan\n\n- two",
    });
  });

  test("a heading as the first line is a section: the whole text is the body and the title is left to ask for", () => {
    expect(parsePrDraft("## Summary\n\n- one\n\n## Test plan\n\n- two\n")).toEqual({ title: "", body: "## Summary\n\n- one\n\n## Test plan\n\n- two" });
    expect(parsePrDraft("# Summary\nbody")).toEqual({ title: "", body: "# Summary\nbody" });
  });

  test("a single # line over a blank line and a heading is a title followed by the template's sections", async () => {
    const parsed = parsePrDraft("# fix: x\n\n## Summary\n\n- one\n\n## Test plan\n\n- two");
    expect(parsed).toEqual({ title: "fix: x", body: "## Summary\n\n- one\n\n## Test plan\n\n- two" });
    let called = false;
    const drafted = await withPrTitle(parsed, async () => { called = true; return "y"; });
    expect(called).toBe(false);
    expect(drafted).toEqual(parsed);
  });

  test("a heading that repeats a body heading, or sits over body text, is not read as a title", () => {
    expect(parsePrDraft("# Summary\n\n## Summary\n\n- one")).toEqual({ title: "", body: "# Summary\n\n## Summary\n\n- one" });
    expect(parsePrDraft("# Summary\n\nbody\n\n## Test plan")).toEqual({ title: "", body: "# Summary\n\nbody\n\n## Test plan" });
    expect(parsePrDraft("## fix: x\n\n## Summary\n\n- one")).toEqual({ title: "", body: "## fix: x\n\n## Summary\n\n- one" });
  });


  test("the title is asked for alone, from the body, and is told not to be a template heading", () => {
    const args = buildPrTitleArgs(role, "## Summary\n\n- one", "## 直近の PR\nfix: x");
    expect(args).toContain("--no-tools");
    const message = args.at(-1) as string;
    expect(message).toContain("<propter-system-message>");
    expect(message).toContain("- one");
    expect(message).toContain("fix: x");
    expect(message).toContain("見出し（Summary など）");
    expect(message).toContain("題の 1 行だけ");
  });

  test("the title is the first line of the answer, never a heading", () => {
    const body = "## Summary\n\n- one\n\n## Test plan\n\n- two";
    expect(parsePrTitle("fix: keep the files\n", body)).toBe("fix: keep the files");
    expect(parsePrTitle("```\nfix: keep the files\n```", body)).toBe("fix: keep the files");
    expect(parsePrTitle("題: ファイルを残す", body)).toBe("ファイルを残す");
    expect(() => parsePrTitle("## Summary", body)).toThrow();
    expect(() => parsePrTitle("Summary", body)).toThrow();
    expect(() => parsePrTitle("test plan", body)).toThrow();
    expect(() => parsePrTitle("  \n", body)).toThrow();
  });

  test("a body without a title keeps every section in order and gets a title; a failed title fails the whole draft", async () => {
    const parsed = parsePrDraft("## Summary\n\n- one\n\n## Test plan\n\n- two");
    let asked = "";
    const drafted = await withPrTitle(parsed, async (body) => { asked = body; return "fix: keep the files"; });
    expect(drafted).toEqual({ title: "fix: keep the files", body: "## Summary\n\n- one\n\n## Test plan\n\n- two" });
    expect(asked).toBe(parsed.body);
    await expect(withPrTitle(parsed, async () => { throw new Error("pi が落ちた"); })).rejects.toThrow();
    await expect(withPrTitle(parsed, async () => "## Summary")).rejects.toThrow();
    let called = false;
    await withPrTitle({ title: "fix: x", body: "b" }, async () => { called = true; return "y"; });
    expect(called).toBe(false);
  });

  describe("the template's sections and the AI's marks", () => {
    const template = "## Summary\n\n<!-- what -->\n\n## Test plan\n\n- [ ] x\n";

    test("a body that lacks a template section throws, naming it", () => {
      expect(() => parsePrDraft("fix: x\n\n## Test plan\n\n- two", { template })).toThrow("## Summary");
      expect(() => parsePrDraft("## Summary\n\n- one", { template })).toThrow("## Test plan");
      expect(() => parsePrDraft("fix: x\n\nonly prose", { template })).toThrow("## Summary, ## Test plan");
      expect(parsePrDraft("fix: x\n\n## Summary\n\n- one\n\n## Test plan\n\n- two", { template })).toEqual({ title: "fix: x", body: "## Summary\n\n- one\n\n## Test plan\n\n- two" });
      expect(parsePrDraft("## Summary\n\n- one\n\n## Test plan\n\n- two", { template }).title).toBe("");
    });

    test("the sections are in the template's order, may be joined by others, and match by words only", () => {
      expect(() => parsePrDraft("fix: x\n\n## Test plan\n\n- two\n\n## Summary\n\n- one", { template })).toThrow();
      expect(parsePrDraft("fix: x\n\n## Summary\n\n- one\n\n## Notes\n\n- n\n\n## Test plan\n\n- two", { template }).title).toBe("fix: x");
      expect(parsePrDraft("fix: x\n\n# summary ##\n\n- one\n\n### TEST PLAN\n\n- two", { template }).title).toBe("fix: x");
    });

    test("without a template, or a template without headings, nothing is checked", () => {
      expect(parsePrDraft("fix: x\n\nprose")).toEqual({ title: "fix: x", body: "prose" });
      expect(parsePrDraft("fix: x\n\nprose", {})).toEqual({ title: "fix: x", body: "prose" });
      expect(parsePrDraft("fix: x\n\nprose", { template: null }).body).toBe("prose");
      expect(parsePrDraft("fix: x\n\nprose", { template: "just prose" }).body).toBe("prose");
    });

    test("a # line in a fenced block or an HTML comment is not a section, in the template or the body", () => {
      const fenced = "## Summary\n\n```sh\n# not a section\n```\n\n<!--\n## Hidden\n-->\n\n## Test plan\n";
      expect(parsePrDraft("fix: x\n\n## Summary\n\n- one\n\n## Test plan\n\n- two", { template: fenced }).title).toBe("fix: x");
      expect(() => parsePrDraft("fix: x\n\n## Summary\n\n```\n## Test plan\n```", { template })).toThrow("## Test plan");
      expect(() => parsePrDraft("fix: x\n\n## Summary\n\n<!-- ## Test plan -->", { template })).toThrow("## Test plan");
    });

    test("a clipped template is checked by the headings the writer saw, without the one the clip may have cut", () => {
      const clipped = "## Summary\n\n## Test plan\n\n## Chec\n…";
      expect(parsePrDraft("fix: x\n\n## Summary\n\n- one\n\n## Test plan\n\n- two", { template: clipped }).title).toBe("fix: x");
      expect(() => parsePrDraft("fix: x\n\n## Summary\n\n- one", { template: clipped })).toThrow("## Test plan");
    });

    test("a text marked as written by an AI throws, in the body, the title or a title-only answer", () => {
      expect(() => parsePrDraft("fix: x\n\n## Summary\n\n- one\n\nCo-Authored-By: Claude <noreply@anthropic.com>")).toThrow();
      expect(() => parsePrDraft("fix: x\n\nco-authored-by: someone")).toThrow();
      expect(() => parsePrDraft("fix: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)")).toThrow();
      expect(() => parsePrDraft("fix: x\n\nGenerated by a tool")).toThrow();
      expect(() => parsePrDraft("Generated with a tool\n\nbody")).toThrow();
      expect(() => parsePrTitle("🤖 Generated with Claude Code", "## Summary")).toThrow();
      // the line the team's template carries is refused in the title and in the body
      expect(() => parsePrTitle("🤖 AIが作成したPR本文です", "## Summary")).toThrow("AI の印");
      expect(() => parsePrDraft("fix: x\n\n## Summary\n\n- one\n\n🤖 AIが作成したPR本文です。内容に問題がなければこの文を削除してください。")).toThrow("AI の印");
      expect(() => parsePrDraft("🤖 AIが作成したPR本文です\n\n## Summary\n\n- one")).toThrow("AI の印");
      expect(parsePrDraft("fix: x\n\nThe code generated with the tool stays.").title).toBe("fix: x");
    });
  });

  describe("a title that is only a heading's words, and a revision of a body that is already up", () => {
    const template = "## Summary\n\n<!-- what -->\n\n## Test plan\n\n- [ ] x\n";
    const body = "## Summary\n\n- one\n\n## Test plan\n\n- two";

    test("a bare first line that repeats a template heading is not a title", () => {
      for (const title of ["Summary", "summary", "Test plan:", "Title: Summary", "題: Test plan："]) {
        expect(() => parsePrDraft(`${title}\n\n${body}`, { template })).toThrow("テンプレの節の見出し");
      }
      expect(parsePrDraft(`fix: x\n\n${body}`, { template }).title).toBe("fix: x");
      expect(parsePrDraft(`Summary of the fix\n\n${body}`, { template }).title).toBe("Summary of the fix");
    });

    test("without a template, a title that repeats one of the body's headings is still not a title", () => {
      expect(() => parsePrDraft(`Summary\n\n${body}`)).toThrow("テンプレの節の見出し");
      expect(() => parsePrDraft(`Summary\n\n${body}`, { template: null, marks: false })).toThrow("テンプレの節の見出し");
      expect(parsePrDraft(`fix: x\n\n${body}`).title).toBe("fix: x");
    });

    test("marks: false and no template let a body that lacks a section or carries a mark through", () => {
      const marked = "fix: x\n\nonly prose\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
      expect(() => parsePrDraft(marked, { template })).toThrow();
      expect(parsePrDraft(marked, { template: null, marks: false }).title).toBe("fix: x");
      expect(() => parsePrDraft(marked, { template: null })).toThrow("AI の印");
    });
  });

  test("the rewriter writes the commit message with the repo's commit rules and no tools", () => {
    const args = buildCommitDraftArgs(role, "材料", "## commit の規則\nConventional Commits");
    expect(args).toContain("--no-tools");
    const message = args[args.length - 1];
    expect(message).toContain("commit message");
    expect(message).toContain("Conventional Commits");
    expect(message).toContain("材料");
  });

  test("a repo that points at its commit section has the writer follow it over the recent commits; without one the recent commits are the form", () => {
    const task = (pointed: boolean) => buildCommitDraftArgs(role, "材料", "## commit", { pointed }).at(-1)!;
    expect(task(true)).toContain("commit の規則の節に従う");
    expect(task(true)).toContain("直近の commit の型・言語に合わせない");
    expect(task(true)).not.toContain("規則が無ければ直近の commit の形に合わせる");
    expect(task(false)).toContain("規則が無ければ直近の commit の形に合わせる");
    expect(task(false)).not.toContain("節に従う");
  });

  test("the commit message is the whole text, without a fence around it", () => {
    expect(parseCommitDraft("feat: 直す\n\n説明\n")).toBe("feat: 直す\n\n説明");
    expect(parseCommitDraft("```\nfix: 直す\n```")).toBe("fix: 直す");
    expect(() => parseCommitDraft("  \n")).toThrow();
  });
});
