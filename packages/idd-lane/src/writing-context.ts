import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describeSection, readSectionAt, sectionHash, withoutAiMarks, type ConventionKind, type Conventions, type DraftedSection } from "../../idd-core/src/config/conventions.ts";
import { fetchPublic } from "../../idd-core/src/overlay/git.ts";
import { checkPrText } from "./pr-draft.ts";
import { findRepoByGithub } from "./repos.ts";

export interface WritingContextOptions {
  /** review: a reply on someone else's PR, which follows only the language. commit: the commit message of a push */
  kind: "pr" | "issue" | "review" | "commit";
  /** config/repos.yaml public_language; unset means Japanese */
  language?: string;
  /** owner/name, for the recent PRs and the labels read through gh */
  repo?: string;
  recentPrs?: () => { title: string; body: string }[];
  labels?: () => string[];
  /** commit: the ref whose recent commits are the precedent (the public base; HEAD when unset). With `conventions` given, the sections are read from this ref too; the registry's entry for `repo` is read from the public base fetched now */
  base?: string;
  /** where the repo's rules are (config/repos.yaml `conventions`) and the ref they are read from (`base`); unset reads the registry's entry for `repo` */
  conventions?: Conventions;
  recentCommits?: () => string[];
}

const PR_TEMPLATES = [".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md", "PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md"];
const SKILL_DIRS = [".agents/skills", ".claude/skills"];
const SKILL_NAME: Record<WritingContextOptions["kind"], RegExp> = { pr: /(^|-)(pr|pull)(-|$)|create-pr/i, issue: /issue|linear|ticket/i, review: /(?!)/, commit: /commit/i };
/** where a repo writes its rules for agents and contributors, commit rules among them */
const RULE_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md"];
const RULE_DIRS = [".claude/rules", ".agents/rules"];
const COMMIT_WORD = /commit|コミット/i;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…` : s);

function read(root: string, rel: string): string | null {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** the repo's PR template as the PR writer is shown it (clipped), or null when the repo has none */
export function prTemplate(root: string): string | null {
  const template = PR_TEMPLATES.map((t) => read(root, t)).find((t) => t !== null);
  return template == null ? null : clip(template, 3000);
}

function issueTemplates(root: string): string[] {
  const dir = join(root, ".github/ISSUE_TEMPLATE");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.(md|ya?ml)$/.test(f)).sort().map((f) => `### ${f}\n${clip(readFileSync(join(dir, f), "utf8"), 2000)}`);
}

function skills(root: string, kind: WritingContextOptions["kind"]): string[] {
  const out: string[] = [];
  for (const d of SKILL_DIRS) {
    const dir = join(root, d);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name, "SKILL.md");
      if (SKILL_NAME[kind].test(name) && existsSync(file) && !out.some((s) => s.startsWith(`### ${name}\n`))) out.push(`### ${name}\n${clip(readFileSync(file, "utf8"), 3000)}`);
    }
  }
  return out.slice(0, 2);
}

/**
 * The parts of a markdown file about commits: a section whose heading names them (down to the next heading of its
 * level or above), and elsewhere each paragraph that mentions them, under its heading.
 */
function commitParts(text: string): string {
  const lines = text.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const level = (l: string) => /^(#{1,6})\s/.exec(l)?.[1].length ?? 0;
  const out: string[] = [];
  let heading = "";
  let i = 0;
  while (i < lines.length) {
    const lv = level(lines[i]);
    if (lv && COMMIT_WORD.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !(level(lines[j]) && level(lines[j]) <= lv)) j += 1;
      out.push(lines.slice(i, j).join("\n").trim());
      i = j;
      continue;
    }
    if (lv) { heading = lines[i]; i += 1; continue; }
    let j = i;
    while (j < lines.length && lines[j].trim() && !level(lines[j])) j += 1;
    const block = lines.slice(i, j).join("\n").trim();
    if (block && COMMIT_WORD.test(block)) out.push(heading ? `${heading}\n${block}` : block);
    i = Math.max(j, i + 1);
  }
  return out.join("\n\n");
}

/** the commit rules a repo writes in its AGENTS.md, CLAUDE.md, CONTRIBUTING.md and rule directories */
function commitRules(root: string): string[] {
  const files = [...RULE_FILES];
  for (const d of RULE_DIRS) {
    const dir = join(root, d);
    if (existsSync(dir)) files.push(...readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => `${d}/${f}`));
  }
  return files.flatMap((f) => {
    const text = read(root, f);
    const parts = text ? commitParts(text) : "";
    return parts ? [`### ${f}\n${clip(parts, 2000)}`] : [];
  });
}

/**
 * The longest a pointed section may be. The section is the rule itself, so it is shown whole or not at all: a writer
 * (and the heading check, which reads the same text) never gets the first part of a rule as if it were the rule.
 */
export const SECTION_LIMIT = 40_000;

/** the rules a repo points at, with the ref of its public base they are read from */
export interface PointedRules { conventions: Conventions; base: string }

/**
 * The rules the registry says `repo` points at, with the public base as the public side has it now. The base is
 * fetched (as the card's check fetches it) and named by its commit, so a remote-tracking ref a day old never
 * stands in for it: a rule the team has just edited is the rule the next draft follows. A repo the registry does not
 * know, or that points at nothing for this `kind` of text, gives null without asking the public side (a pointer for
 * another kind of text is no reason for this draft to depend on it); a base that cannot be fetched fails a draft that
 * does point, rather than falling back to an older copy of the rule. A registry that is wrong (a kind it does not
 * know, a pointer it cannot read) throws as the config error it is, and is never read as "no pointer".
 */
export function pointedRules(repo: string, kind: ConventionKind): PointedRules | null {
  const r = findRepoByGithub(repo);
  if (!r?.conventions?.[kind]) return null;
  try {
    return { conventions: r.conventions, base: fetchPublic(r.work, r.clone, r.base) };
  } catch (e) {
    throw new Error(`公開側の base を取れません: ${((e as Error).message ?? String(e)).split("\n")[0]}`);
  }
}

/**
 * The rules a repo points at: the options' own (read from `opts.base`), or the registry's for `repo` (the engine's
 * draft calls may not carry them), read from the public base fetched now. A repo that points at nothing has its rules
 * looked for as they always were.
 */
function pointed(opts: WritingContextOptions): PointedRules | null {
  if (opts.conventions) return Object.keys(opts.conventions).length ? { conventions: opts.conventions, base: opts.base ?? "HEAD" } : null;
  return opts.repo && opts.kind !== "review" ? pointedRules(opts.repo, opts.kind) : null;
}

/**
 * The section of `kind` as the writer reads it (without the AI's marks, whole), or null when `at` has not got it. A
 * section over `SECTION_LIMIT` fails the draft, saying so: the writer is not given part of the rule.
 */
function sectionBody(root: string, kind: ConventionKind, at: PointedRules): string | null {
  const ref = at.conventions[kind];
  const read = ref && root ? readSectionAt(root, at.base, ref) : null;
  if (!read?.found) return null;
  const body = withoutAiMarks(read.text);
  if (body.length > SECTION_LIMIT) throw new Error(`規約の節が長すぎて下書き係に全体を渡せません（${describeSection(ref!)}: ${body.length} 字、上限 ${SECTION_LIMIT} 字）。節を分けるか、上限に収まるように設定を直してください`);
  return body;
}

/**
 * The section of `kind` as the public base has it, or null when the repo does not point at one for this kind (the
 * caller then looks for the rule as it always did). A pointer whose file or section is not there gives an empty
 * string: the repo said where the rule is, so the writer is not given another rule in its place (the card says the
 * pointer is broken). The text is the section's alone, without the lines that mark a text as an AI's.
 */
function pointedSection(root: string, kind: ConventionKind, at: PointedRules | null): string | null {
  const ref = at?.conventions[kind];
  if (!at || !ref) return null;
  const body = sectionBody(root, kind, at);
  return body === null ? "" : `### ${describeSection(ref)}\n${body}`;
}

/**
 * The template a PR draft is checked against when the repo points at its PR section: the section the writer is shown,
 * without its own heading line, so the draft needs the section's headings and not those of a template in the working
 * tree. Null when the base has no such section (the writer is shown no rule either). Undefined when the repo does not
 * point at one, and the template is the working tree's as it always was.
 */
export function pointedPrTemplate(root: string, at: PointedRules | null): string | null | undefined {
  if (!at?.conventions.pr) return undefined;
  const body = sectionBody(root, "pr", at);
  return body === null ? null : body.split("\n").slice(1).join("\n").trim();
}

/**
 * The sections of `kind` a draft was given, with the hash of each: what the submit card later compares the base's section
 * with, so a rule edited after the draft shows as changed on the first check. The hash is of the section as the file has
 * it (`readSectionAt`'s text, as the card's check hashes it), not of what the writer was shown. None when the repo points
 * at no section of this kind or the base has none, which is also when the writer was given none.
 */
export function draftedSections(root: string, kind: ConventionKind, at: PointedRules | null): DraftedSection[] {
  const ref = at?.conventions[kind];
  if (!at || !ref || !root) return [];
  const read = readSectionAt(root, at.base, ref);
  return read.found ? [{ kind, file: ref.file, section: ref.section, hash: sectionHash(read.text) }] : [];
}

/**
 * The PR text the lane's agent handed over, as the draft of a repo that points at its PR section: the same refusals as
 * a writer's draft meet it, against the section as the writer would have been shown it (the headings the section
 * has, a title that is only a heading's words). The lines that mark a text as an AI's are taken out of the body, as
 * they are from the section: the card shows the text as it goes out, so nothing is hidden from the person who signs.
 * A title with a mark, or a body that lacks a heading of the section, throws. The text is returned as it is when the
 * repo does not point at its PR section (the agent's own text, as it was handed over).
 */
export function pointedHeldPr(root: string, held: { title: string; body: string }, at: PointedRules | null): { title: string; body: string } {
  if (!at?.conventions.pr) return held;
  return checkPrText({ title: held.title, body: withoutAiMarks(held.body) }, { template: pointedPrTemplate(root, at) });
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * What a text meant for a repo's public side has to follow, gathered from the repo itself: its
 * language, templates, the project's own skills for PRs or Issues, recent PRs as precedent, and the
 * labels it has. Handed to the rewriter along with its rules; it cannot open files itself.
 */
export function publicWritingContext(root: string, opts: WritingContextOptions): string {
  const parts: string[] = [`## 対外文書の言語\n${opts.language ?? "日本語"}で書く。`];
  if (opts.kind === "review") return parts[0];
  const at = pointed(opts);
  if (opts.kind === "commit") {
    const section = pointedSection(root, "commit", at);
    if (section !== null) {
      if (section) parts.push(`## この repo の commit の規則（従う）\n${section}`);
    } else {
      const rules = commitRules(root);
      if (rules.length) parts.push(`## この repo の commit の規則（従う）\n${rules.join("\n\n")}`);
      const found = skills(root, "commit");
      if (found.length) parts.push(`## このプロジェクトの commit の手順（従う）\n${found.join("\n\n")}`);
    }
    let commits: string[] = [];
    try {
      commits = opts.recentCommits
        ? opts.recentCommits()
        : root ? execFileSync("git", ["log", "-n", "6", "--no-merges", "--format=%B%x1e", opts.base ?? "HEAD"], { cwd: root, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }).split("\x1e").map((c) => c.trim()).filter(Boolean) : [];
    } catch { /* no precedent */ }
    // a repo that points at its commit section is written to that section: the recent commits are for reference, not a form to match
    const precedent = at?.conventions.commit ? "## 直近の commit（参考。規約の節と違っても節に従う）" : "## 直近の commit（形の前例）";
    if (commits.length) parts.push(`${precedent}\n${commits.map((c) => `- ${clip(c, 400).replace(/\n/g, "\n  ")}`).join("\n")}`);
    return parts.join("\n\n");
  }
  const section = pointedSection(root, opts.kind, at);
  if (section !== null) {
    // the repo said where its rule for this text is: that section is the whole of the rule the writer reads
    if (section) parts.push(`## この repo の ${opts.kind === "pr" ? "PR" : "起票"} の規約（従う）\n${section}`);
  } else {
    if (opts.kind === "pr") {
      const template = prTemplate(root);
      if (template) parts.push(`## PR テンプレ（この構成に従う）\n${template}`);
    } else {
      const templates = issueTemplates(root);
      if (templates.length) parts.push(`## Issue テンプレ（合うものの構成に従う）\n${templates.join("\n\n")}`);
    }
    const found = skills(root, opts.kind);
    if (found.length) parts.push(`## このプロジェクトの ${opts.kind === "pr" ? "PR" : "起票"} の手順（従う）\n${found.join("\n\n")}`);
    const contributing = read(root, "CONTRIBUTING.md");
    if (contributing) parts.push(`## CONTRIBUTING.md\n${clip(contributing, 2000)}`);
  }
  if (opts.kind === "pr") {
    let prs: { title: string; body: string }[] = [];
    try { prs = opts.recentPrs ? opts.recentPrs() : opts.repo ? JSON.parse(gh(["pr", "list", "--repo", opts.repo, "--state", "merged", "--limit", "3", "--json", "title,body"])) : []; } catch { /* no precedent */ }
    // a repo that points at its PR section is written to that section: the recent PRs are for reference, not a form to match
    const precedent = at?.conventions.pr ? "## 直近の PR（参考。規約の節と違っても節に従う）" : "## 直近の PR（構成と粒度の前例）";
    if (prs.length) parts.push(`${precedent}\n${prs.map((p) => `### ${p.title}\n${clip(p.body ?? "", 1500)}`).join("\n\n")}`);
  } else {
    let labels: string[] = [];
    try { labels = opts.labels ? opts.labels() : opts.repo ? (JSON.parse(gh(["label", "list", "--repo", opts.repo, "--json", "name", "--limit", "100"])) as { name: string }[]).map((l) => l.name) : []; } catch { /* no labels */ }
    if (labels.length) parts.push(`## ラベル（付けるならこの中から選ぶ）\n${labels.join(", ")}`);
  }
  return parts.join("\n\n");
}
