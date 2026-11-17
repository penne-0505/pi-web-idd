import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { rejectUnknownFields, tableEntries } from "./table.ts";

/** where a repo writes a rule its public text follows: a file and the heading of the section in it */
export interface SectionRef {
  file: string;
  /** the section's heading as the file writes it, hashes included (`## コミットメッセージ規約`) */
  section: string;
}

/** the kinds of text a repo's rule can be pointed at; each names the draft that reads the section */
export const CONVENTION_KINDS = ["commit", "pr", "issue"] as const;
export type ConventionKind = (typeof CONVENTION_KINDS)[number];
export type Conventions = Partial<Record<ConventionKind, SectionRef>>;

const REF_FIELDS = ["file", "section"];
const HEADING = /^(#{1,6})\s+(\S.*?)(?:\s+#+)?\s*$/;

/**
 * config/repos.yaml's `conventions`: for each kind of public text, the file and the section the repo's rule is in.
 * The text of the section is never kept: it is read from the public base when a draft is made, so a rule the team
 * edits is the rule the next draft follows. A kind, a field or a heading that is not understood is a config error,
 * never a silent default: a misspelt pointer would otherwise leave the writer with no rule while the card read as
 * if it had one.
 */
export function parseConventions(where: string, raw: unknown): Conventions | undefined {
  const entries = tableEntries(where, raw);
  if (!entries) return undefined;
  const out: Conventions = {};
  for (const [kind, value] of entries) {
    if (!(CONVENTION_KINDS as readonly string[]).includes(kind)) throw new Error(`${where}: 知らない種類 ${kind}（使える種類: ${CONVENTION_KINDS.join(", ")}）`);
    const at = `${where}.${kind}`;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at}: file と section を持つ表で書いてください`);
    const o = value as Record<string, unknown>;
    rejectUnknownFields(at, o, REF_FIELDS);
    if (typeof o.file !== "string" || !o.file.trim() || o.file.trim().startsWith("/") || o.file.split("/").includes("..")) throw new Error(`${at}.file: repo の root からの相対パスで書いてください`);
    if (typeof o.section !== "string" || !HEADING.test(o.section.trim())) throw new Error(`${at}.section: 節の見出しを # も含めて書いてください（例: "## コミットメッセージ規約"）`);
    out[kind as ConventionKind] = { file: o.file.trim(), section: o.section.trim() };
  }
  return Object.keys(out).length ? out : undefined;
}

/** the pointer as a person reads it: `.agents/skills/create-pr/SKILL.md の ## コミットメッセージ規約` */
export function describeSection(ref: SectionRef): string {
  return `${ref.file} の ${ref.section}`;
}

/**
 * The part of a line outside HTML comments, and whether the line ends inside one. A `<!--` inside an inline code span
 * (backticks of one length, on the line) is text. A `<!--` that opens at the start of a line runs to the `-->` that
 * closes it, on this line or a later one; one in the middle of a line with no `-->` after it on the line is text too,
 * so a comment that is never closed does not carry a section to the end of the file.
 */
function visibleOf(line: string, inComment: boolean): { visible: string; inComment: boolean } {
  let visible = "";
  let rest = line;
  let comment = inComment;
  while (rest) {
    if (comment) {
      const end = rest.indexOf("-->");
      if (end < 0) break;
      comment = false;
      rest = rest.slice(end + 3);
      continue;
    }
    const at = /<!--|`+/.exec(rest);
    if (!at) { visible += rest; break; }
    visible += rest.slice(0, at.index);
    rest = rest.slice(at.index);
    if (at[0] === "<!--") {
      if (rest.indexOf("-->", 4) >= 0) { comment = true; rest = rest.slice(4); continue; }
      if (visible.trim() === "") { comment = true; break; }
      visible += rest;
      break;
    }
    const ticks = at[0];
    const close = new RegExp(`(?<!\`)${ticks}(?!\`)`).exec(rest.slice(ticks.length));
    const span = close ? ticks.length + close.index + ticks.length : ticks.length;
    visible += rest.slice(0, span);
    rest = rest.slice(span);
  }
  return { visible, inComment: comment };
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * The section a heading names, from the heading line to the next heading of its level or above (so its sub-sections
 * are in it), or null when the file has no such heading. Lines are read the way CommonMark does: a fenced block ends at
 * a fence of the same character at least as long as its opening, and nothing inside it (a heading, a comment mark, a
 * shorter or other fence) means anything; a line inside an HTML comment neither opens a fence nor is a heading; and
 * a comment at the end of a heading line is not part of its name. The text returned is the file's own.
 */
export function sectionOf(text: string, section: string): string | null {
  const want = HEADING.exec(section.trim());
  if (!want) return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let fence: { char: string; len: number } | null = null;
  let comment = false;
  let start = -1;
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (fence) {
      const close = FENCE_CLOSE.exec(lines[i]);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      continue;
    }
    if (!comment) {
      const open = FENCE_OPEN.exec(lines[i]);
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) { fence = { char: open[1][0], len: open[1].length }; continue; }
    }
    const seen = visibleOf(lines[i], comment);
    comment = seen.inComment;
    const h = HEADING.exec(seen.visible);
    if (!h) continue;
    if (start < 0) {
      if (h[1] === want[1] && h[2] === want[2]) { start = i; depth = h[1].length; }
    } else if (h[1].length <= depth) {
      return lines.slice(start, i).join("\n").trim();
    }
  }
  return start < 0 ? null : lines.slice(start).join("\n").trim();
}

export type SectionRead =
  | { found: true; text: string }
  | { found: false; missing: "file" | "section" | "body" };

/** a section a draft was made under: where it is, and the hash of its text (the text itself is not kept) */
export interface DraftedSection extends SectionRef {
  kind: ConventionKind;
  hash: string;
}

/**
 * the section as the file has it at `ref` (a commit or a ref of `repo`'s object store), not as any working tree has it.
 * A heading with no body (once the AI's marks are taken out) is `missing: "body"`: it is a pointer that gives a writer
 * nothing to follow, so it is read as a section that is not there rather than as an empty rule.
 */
export function readSectionAt(repo: string, ref: string, pointer: SectionRef): SectionRead {
  let text: string;
  try {
    text = execFileSync("git", ["show", `${ref}:${pointer.file}`], { cwd: repo, encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" } });
  } catch {
    return { found: false, missing: "file" };
  }
  const section = sectionOf(text, pointer.section);
  if (section === null) return { found: false, missing: "section" };
  if (!withoutAiMarks(section).split("\n").slice(1).join("\n").trim()) return { found: false, missing: "body" };
  return { found: true, text: section };
}

/** a hash of the section's text: what a draft's record keeps instead of the text */
export function sectionHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The lines of a section that mark a text as written by an AI (`🤖 AIが作成したPR本文です…`, `Co-Authored-By:`, `Generated with …`; the forms the PR draft's check refuses). The
 * team's rule has a person delete them by hand; penne's text is approved by a person on the card before it goes out,
 * so a writer shown them would put them into the draft. They are taken out of what the writer reads.
 */
export function withoutAiMarks(text: string): string {
  return text.split("\n").filter((l) => !isAiMarkLine(l)).join("\n").trim();
}

/** a line that marks a text as written by an AI: the one test both the section's filter and the PR draft's check use */
export function isAiMarkLine(line: string): boolean {
  return /^[\s>*_-]*(?:🤖|co-authored-by\s*:|generated\s+(?:with|by)\b)/i.test(line) || /AIが作成した/.test(line);
}
