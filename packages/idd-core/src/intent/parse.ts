
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readAreas } from "../config/areas.ts";
import { intentRoot } from "../paths.ts";
import type { BacklogRecord } from "../schema/records.ts";

const HEADING = /^#{2,3}\s*((?:DEC|QA|INV)-[\w.-]+)\s*[—–:-]?\s*(.+?)\s*$/;
/** any ATX heading: the end of a section (a decision's Why / Source live between its heading and the next one) */
const ANY_HEADING = /^#{1,6}\s/;
/** a field line of a decision: `- **Name**` or `- **Name**（…）`, the colon optional (the next field ends the one before) */
const FIELD = /^-\s+\*\*[^*]+\*\*/;

export function areaSegment(area: string): string {
  return area.split("/").pop() || area;
}

/** who judges a lane's overall statement (the 全体 line): the words the one reader understands */
export type OverallJudge = "human" | "viewer" | "other" | "none";

/** the 全体 line of a lane's qa.md: the statement and the judge it declares */
export interface OverallLine {
  /** the statement, with the `（判定: …）` part removed */
  text: string;
  /** the declared judge, read from the line: 人 / 絵を見る役, or other / none */
  judge: OverallJudge;
  /** the declared word as written, for a reason a lane can read back */
  word: string;
}

/**
 * The 全体 line of a qa.md, with the judge its trailing `（判定: …）` declares. The reader takes the word before the
 * first `。`/`、`/bracket as the judge, so a line that adds the material after a period (`（判定: 人。…）`) still
 * reads. A line with no declaration reads as `none`; a word other than 人 / 絵を見る役 reads as `other`, and the
 * stage leaves it alone rather than guessing a judge.
 */
export function overallLineOf(src: string | null): OverallLine {
  for (const line of (src ?? "").split("\n")) {
    const m = line.match(/^-\s*全体\s*[:：]\s*(.+?)\s*$/);
    if (!m) continue;
    const body = m[1];
    const declared = body.match(/（判定\s*[:：]\s*([^）]*)）/);
    if (!declared) return { text: body.trim(), judge: "none", word: "" };
    const raw = declared[1].trim();
    const word = raw.split(/[。、,（(]/)[0].trim();
    const judge: OverallJudge = word === "人" ? "human" : word === "絵を見る役" ? "viewer" : "other";
    return { text: body.replace(declared[0], "").trim(), judge, word: word || raw };
  }
  return { text: "", judge: "none", word: "" };
}

/** a file as committed on a ref of a repo, or null when the ref does not have it */
function showFile(repo: string, ref: string, rel: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${rel}`], { cwd: repo, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** one decision of a lane's decision.md, with the Why and Source its section carries */
export interface IntentDecision {
  id: string;
  text: string;
  /** the decision's `Why` field, as written (continuation lines kept, nothing trimmed or summarised) */
  why: string;
  /** the decision's `Source` field, or an empty string when it has none */
  source: string;
}

/** the body of a section's field, from its own line until the next field: continuation lines are kept as they are */
function fieldOf(body: string[], name: string): string {
  const start = new RegExp(`^-\\s+\\*\\*${name}\\*\\*(?:（[^）]*）)?\\s*[:：]\\s?`);
  const at = body.findIndex((line) => start.test(line));
  if (at < 0) return "";
  const all = [body[at].replace(start, "")];
  for (let i = at + 1; i < body.length; i += 1) {
    if (FIELD.test(body[i])) break;
    all.push(body[i]);
  }
  while (all.length && all[all.length - 1].trim() === "") all.pop();
  return all.join("\n");
}

/**
 * The decisions, each with the section's Why and Source. A section runs from its heading to the next heading of any
 * level; the field after Why ends it (a bold name), whatever stands between the name and its colon.
 */
function decisionsOf(src: string | null): IntentDecision[] {
  const lines = (src ?? "").split("\n");
  const heads: { id: string; text: string; at: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^###\s+(DEC-[\w.-]+):\s*(.+?)\s*$/) ?? lines[i].match(/^##\s+(DEC-[\w.-]+)\s*[—–:-]\s*(.+?)\s*$/);
    if (m) heads.push({ id: m[1], text: m[2].trim(), at: i });
  }
  return heads.map((h) => {
    let end = lines.length;
    for (let i = h.at + 1; i < lines.length; i += 1) if (ANY_HEADING.test(lines[i])) { end = i; break; }
    const body = lines.slice(h.at + 1, end);
    return { id: h.id, text: h.text, why: fieldOf(body, "Why"), source: fieldOf(body, "Source") };
  });
}

/**
 * The lane's records, read from its worktree first. A lane whose worktree was retired is read from `branch` in
 * its place: what the lane committed stays there.
 */
export function parseIntent(area: string, slug: string, opts: { root?: string; branch?: { repo: string; ref: string } } = {}): {
  decisions: IntentDecision[];
  criteria: { id: string; text: string }[];
  invariants: { id: string; text: string }[];
  references: { path: string; why: string }[];
  /** the lane's overall statement and its declared judge, read from the same qa.md the AC come from */
  overall: OverallLine;
} {
  const seg = areaSegment(area);
  const configured = readAreas().areas[area]?.local_path;
  const roots = [...(opts.root ? [opts.root] : []), ...(configured ? [configured] : []), process.cwd()];
  const branch = opts.branch && !(opts.root && existsSync(opts.root)) ? opts.branch : undefined;

  const read = (rel: string): string | null => {
    if (branch) {
      const shown = showFile(branch.repo, branch.ref, rel);
      if (shown !== null) return shown;
    }
    for (const root of roots) {
      const p = join(root, rel);
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
    return null;
  };
  const readIntent = (file: string): string | null => {
    const fromRoot = read(join("_docs", "intent", seg, slug, file));
    if (fromRoot !== null) return fromRoot;
    const p = join(intentRoot(), seg, slug, file);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };

  const lines = (src: string | null) => (src ?? "").split("\n");
  const pick = (src: string | null, re: RegExp) =>
    lines(src).flatMap((line) => {
      const m = line.match(re);
      return m ? [{ id: m[1], text: m[2].trim() }] : [];
    });

  const decisionSrc = readIntent("decision.md");
  const decisions = decisionsOf(decisionSrc);

  const invariants = [
    ...pick(decisionSrc, /^-\s+(INV-[\w.-]+)\s*(?:\([^)]*\))?:\s*(.+?)\s*$/),
    ...pick(readIntent("invariant.md"), HEADING),
  ];

  const qaSrc = read(join("_docs", "qa", seg, slug, "qa.md"));
  const criteria = [
    ...pick(qaSrc, /^-\s+(AC-\d+)(?:\s*\([^)]*\))?:\s*(.+?)\s*$/),
    ...pick(readIntent("qa.md"), HEADING),
  ];

  const refSrc = read(join("_docs", "reference", seg, slug, "reference.md")) ?? readIntent("reference.md");
  const references = lines(refSrc).flatMap((line) => {
    const m = line.match(/^-\s*`([^`]+)`\s*[—–:-]?\s*(.*)$/);
    return m ? [{ path: m[1], why: m[2].trim() }] : [];
  });

  return { decisions, criteria, invariants, references, overall: overallLineOf(qaSrc) };
}

export function slugOf(rec: BacklogRecord): string {
  return rec.idd_id.toLowerCase();
}
