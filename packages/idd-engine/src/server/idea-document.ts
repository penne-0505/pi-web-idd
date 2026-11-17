/**
 * The idea document: reading the contract a conversation keeps its idea in, deriving what the whole screen shows
 * from it, and writing back the few fields the engine owns (gate records, `status` / `frozen_at`, and an exit
 * row's state and result).
 *
 * The document is the one place the idea's state lives. This module never keeps a copy: every read parses the
 * file again, and a section or a row that does not follow the contract comes back as a value with the reason,
 * next to the parts that did read, so a screen can show what is there and what is not.
 *
 * The contract itself is `docs/idea-document.md`. The fields the engine writes are limited to the gate record
 * lines, the two frontmatter keys, and the exit rows' state and result; the agent's own text is left alone.
 */
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";

/** the sections the template names, in the order it names them */
export const IDEA_SECTIONS = [
  "経緯",
  "既存の確認",
  "目的",
  "ゴール",
  "非ゴール",
  "想定作業内容サマリ",
  "未決",
  "ゲート記録",
  "出口",
] as const;

/** the marks an agent may write for a section, and the fallback the engine derives without one */
export type SectionMark = "まだ" | "詰めている" | "決まった";
export const SECTION_MARKS: readonly SectionMark[] = ["まだ", "詰めている", "決まった"];

/** what a section shows: the agent's mark, or what the body says when no mark is written */
export type SectionState = SectionMark;

/** the stage the whole document is at, derived from the gate records */
export type IdeaStage = "探索" | "ゲート1" | "凍結" | "出口";

/** the four points gate 2 freezes */
export const IDEA_FROZEN_SECTIONS = ["目的", "ゴール", "非ゴール", "想定作業内容サマリ"] as const;

export type ExitEffect = "外へ出る" | "手元を変える";
export type ExitOperation = "issues" | "repo" | "file";
export type ExitState = "下書き" | "承認済み" | "実行済み" | "失敗";
export type FileChange = "作成" | "追記" | "置換";

export interface IdeaSectionRead {
  name: string;
  mark: SectionMark | null;
  /** the mark the screen shows: the agent's, or what the body implies */
  state: SectionState;
  body: string;
  /** a reason the section's own mark could not be read (the body still reads) */
  reason?: string;
}

export interface GateRecord {
  gate: 1 | 2;
  date: string | null;
  action: "approve" | "redo";
  reason?: string;
  fingerprint?: string;
  /** the line as it was read, for showing what the document holds */
  line: string;
}

export interface ExitIssue {
  id: string;
  title: string;
  depends: string[];
  labels: string[];
  body: string;
  /** the created Issue's number, read from the result text */
  number: number | null;
  result: string;
}

export interface ExitRow {
  id: string;
  title: string;
  effect: ExitEffect;
  operation: ExitOperation;
  target: string;
  reversibility: string;
  state: ExitState;
  result: string;
  issues?: ExitIssue[];
  visibility?: "public" | "private";
  description?: string;
  change?: FileChange;
  content?: string;
  before?: string;
  after?: string;
  /** false when the row does not follow the contract; `reason` says why and the row is never executed */
  readable: boolean;
  reason?: string;
}

export interface IdeaUnreadable {
  /** the section or the row the reason belongs to */
  where: string;
  reason: string;
}

export interface IdeaDocument {
  path: string;
  /** the frontmatter as it was parsed; a file without one reads as an empty table */
  frontmatter: Record<string, unknown>;
  slug: string | null;
  status: string | null;
  target: string | null;
  createdAt: string | null;
  frozenAt: string | null;
  sections: IdeaSectionRead[];
  undecided: string[];
  gates: GateRecord[];
  exits: ExitRow[];
  /** the places the document declares for a hand-side exit to write in */
  places: string[];
  /** whether the frozen four points still match the fingerprint gate 2 recorded */
  frozenIntact: boolean;
  /** whether gate 1 and gate 2 are approved: the four points are frozen by the records */
  frozen: boolean;
  /** whether the exit section cannot be read at all (an old `exit` field, a broken body) */
  exitsReadable: boolean;
  unreadable: IdeaUnreadable[];
  stage: IdeaStage;
}

interface FrontmatterSplit {
  front: string | null;
  body: string;
  /** the raw frontmatter text, so a write can put a key back where it was */
  bodyStart: number;
}

function splitFrontmatter(text: string): FrontmatterSplit {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { front: null, body: normalized, bodyStart: 0 };
  return { front: match[1], body: normalized.slice(match[0].length), bodyStart: match[0].length };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * A fence opening line: three or more backticks, optionally followed by an info string. The info string may
 * hold anything except a backtick (CommonMark), so ```` ````` text ```` and ```` ```js title ```` both open a
 * fence. Requiring a single non-space token made a two-word info string look like body text, and then the
 * matching close line opened a new fence and swallowed every heading after it.
 */
const FENCE_OPEN = /^(`{3,})([^`]*)$/;

/**
 * The lines a backtick fence covers. An idea's body text may hold its own headings, so a line that only looks
 * like a section or a row boundary must not be read as one while it sits inside a fence. The opening and closing
 * lines are marked too, so a caller that scans headings skips them; the fence's content is still part of a body.
 */
function fenceMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let open = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (open > 0) {
      mask[i] = true;
      if (new RegExp(`^\`{${open},}\\s*$`).test(lines[i])) open = 0;
      continue;
    }
    const fence = FENCE_OPEN.exec(lines[i]);
    if (fence) { open = fence[1].length; mask[i] = true; }
  }
  return mask;
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** the section bodies, keyed by the heading name, in the order the document holds them */
function readSectionBodies(body: string): { name: string; body: string; offset: number }[] {
  const lines = body.split("\n");
  const fenced = fenceMask(lines);
  const out: { name: string; body: string; offset: number }[] = [];
  let current: { name: string; lines: string[]; offset: number } | null = null;
  const flush = () => {
    if (!current) return;
    out.push({ name: current.name, body: current.lines.join("\n").trim(), offset: current.offset });
    current = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (!fenced[i]) {
      const match = /^##\s+(.+?)\s*$/.exec(lines[i]);
      if (match) {
        flush();
        current = { name: match[1].trim(), lines: [], offset: i + 1 };
        continue;
      }
    }
    if (current) current.lines.push(lines[i]);
  }
  flush();
  return out;
}

function isSectionMark(value: unknown): value is SectionMark {
  return typeof value === "string" && (SECTION_MARKS as readonly string[]).includes(value);
}

function deriveState(mark: SectionMark | null, body: string): SectionState {
  if (mark) return mark;
  return body.trim() ? "詰めている" : "まだ";
}

/** the top-level bullet items of a section, one line each, with nested bullets left out */
function readBullets(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s/.test(line)) continue;
    const match = /^[-*]\s+(.*)$/.exec(line);
    if (!match) continue;
    const text = match[1].trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * One gate record line, in the engine's own shape or in either shape an older document used. The contract's
 * shapes may have no bullet (`ゲート 1 (2026-10-05): 承認`, `ゲート 1: 2026-09-25 承認`,
 * `ゲート 1（やり直し）: 2026-09-25 理由`), so the bullet is optional. A separator is required so a prose line
 * that merely names a gate is not read as a record.
 */
export function parseGateLine(line: string): GateRecord | null {
  const match = /^\s*(?:[-*]\s+)?ゲート\s*([12])(.*)$/.exec(line);
  if (!match) return null;
  const gate = Number(match[1]) as 1 | 2;
  const rest = match[2];
  if (!/[:：]/.test(rest)) return null;
  const date = /(\d{4}-\d{2}-\d{2})/.exec(rest)?.[1] ?? null;
  const redo = rest.includes("やり直し");
  const approve = rest.includes("承認");
  if (!redo && !approve) return null;
  const fingerprint = /指紋\s*[:：]?\s*([0-9a-fA-F]{8,})/.exec(rest)?.[1];
  let reason: string | undefined;
  if (redo) {
    const after = /\d{4}-\d{2}-\d{2}/.test(rest) ? rest.replace(/^.*?\d{4}-\d{2}-\d{2}/, "") : rest;
    // only the old form's own `（やり直し）` marker is dropped: parentheses in the reason itself are kept
    const cleaned = after
      .replace(/[（(]\s*やり直し\s*[）)]/g, "")
      .replace(/やり直し/g, "")
      .replace(/^[\s:：—–-]+/, "")
      .replace(/理由\s*[:：]?\s*/, "")
      .trim();
    if (cleaned) reason = cleaned;
  }
  return {
    gate,
    date,
    action: redo ? "redo" : "approve",
    ...(reason ? { reason } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    line: line.trim(),
  };
}

interface FieldValue {
  value: string;
  /** true when the value came from a fenced block */
  fenced: boolean;
}

/**
 * The `- name: value` fields of a line range. An empty inline value takes the next fenced block, so a body with
 * its own blank lines and headings still reads. Lines that are neither fields nor fences are returned as `rest`.
 */
function readFields(lines: readonly string[], from: number, to: number): { fields: Map<string, FieldValue>; rest: string[] } {
  const fields = new Map<string, FieldValue>();
  const rest: string[] = [];
  const fenced = fenceMask(lines);
  let i = from;
  while (i < to) {
    const line = lines[i];
    const match = /^-\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
    // a `- name:` line inside a fence is body text, not a field: a fenced sample must not shadow the real one
    if (!match || fenced[i]) {
      const trimmed = line.trim();
      if (trimmed) rest.push(line);
      i += 1;
      continue;
    }
    const name = match[1].trim();
    const inline = match[2];
    if (inline.trim()) {
      fields.set(name, { value: inline.trim(), fenced: false });
      i += 1;
      continue;
    }
    // an empty value takes the next fenced block when one follows, else it is empty
    let j = i + 1;
    while (j < to && !lines[j].trim()) j += 1;
    const fence = j < to ? FENCE_OPEN.exec(lines[j]) : null;
    if (!fence) {
      fields.set(name, { value: "", fenced: false });
      i += 1;
      continue;
    }
    const ticks = fence[1].length;
    const openLine = lines[j];
    const closing = new RegExp(`^\`{${ticks},}\\s*$`);
    const content: string[] = [];
    let k = j + 1;
    for (; k < to; k += 1) {
      if (closing.test(lines[k])) break;
      content.push(lines[k]);
    }
    const label = openLine.replace(/^`+/, "").trim();
    fields.set(name, { value: content.join("\n").replace(/\n+$/, ""), fenced: true });
    void label;
    i = k < to ? k + 1 : to;
  }
  return { fields, rest };
}

function parseDependencies(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]") return [];
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return inner.split(",").map((part) => part.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

function parseLabels(value: string | undefined): string[] {
  return parseDependencies(value);
}

function issueNumberFromResult(result: string): number | null {
  const match = /#(\d+)/.exec(result) ?? /\/(?:issues|pull)\/(\d+)/.exec(result);
  return match ? Number(match[1]) : null;
}

/** `### EXIT-1: what it does` — the id and the one-line what */
function parseExitHeading(line: string): { id: string; title: string } | null {
  const match = /^###\s+(?:\[([^\]]+)\]|(\S+?))\s*[:：]\s*(.+?)\s*$/.exec(line);
  if (!match) return null;
  return { id: (match[1] ?? match[2]).trim(), title: match[3].trim() };
}

function parseIssueHeading(line: string): { id: string; title: string } | null {
  const match = /^####\s+(?:\[([^\]]+)\]|(\S+?))\s*[:：]\s*(.+?)\s*$/.exec(line);
  if (!match) return null;
  return { id: (match[1] ?? match[2]).trim(), title: match[3].trim() };
}

const EFFECT_OF: Record<ExitOperation, ExitEffect> = { issues: "外へ出る", repo: "外へ出る", file: "手元を変える" };

function isExitOperation(value: string): value is ExitOperation {
  return value === "issues" || value === "repo" || value === "file";
}

function isExitState(value: string): value is ExitState {
  return value === "下書き" || value === "承認済み" || value === "実行済み" || value === "失敗";
}

function isExitEffect(value: string): value is ExitEffect {
  return value === "外へ出る" || value === "手元を変える";
}

function readExitRows(body: string): ExitRow[] {
  const bounds = sectionRange(body.split("\n"), "出口");
  if (!bounds) return [];
  const lines = body.split("\n");
  const fenced = fenceMask(lines);
  const rows: ExitRow[] = [];
  let i = bounds.from;
  while (i < bounds.to) {
    const heading = fenced[i] ? null : parseExitHeading(lines[i]);
    if (!heading) { i += 1; continue; }
    const rowStart = i;
    let i2 = i + 1;
    const issueRanges: { heading: { id: string; title: string }; from: number; to: number }[] = [];
    while (i2 < bounds.to && (fenced[i2] || !/^###\s+/.test(lines[i2]))) {
      const issue = fenced[i2] ? null : parseIssueHeading(lines[i2]);
      if (issue) {
        let end = i2 + 1;
        while (end < bounds.to && (fenced[end] || (!/^####\s+/.test(lines[end]) && !/^###\s+/.test(lines[end])))) end += 1;
        issueRanges.push({ heading: issue, from: i2 + 1, to: end });
        i2 = end;
      } else {
        i2 += 1;
      }
    }
    void rowStart;
    // the row's own fields stop at the first `####`: an Issue's `- 結果:` must not land on the row
    let firstIssue = i2;
    for (let k = i + 1; k < i2; k += 1) if (!fenced[k] && /^####\s+/.test(lines[k])) { firstIssue = k; break; }
    const { fields, rest } = readFields(lines, i + 1, firstIssue);
    const row = buildExitRow(heading, fields, rest, lines, issueRanges);
    rows.push(row);
    i = i2;
  }
  // a duplicated id is ambiguous: the reader takes the first and the writer the last, so neither may run
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  for (const row of rows) {
    if ((counts.get(row.id) ?? 0) > 1) {
      row.readable = false;
      row.reason = `${row.reason ? `${row.reason}。` : ""}行の id が重複しています: ${row.id}`;
    }
  }
  return rows;
}

function buildExitRow(
  heading: { id: string; title: string },
  fields: Map<string, FieldValue>,
  rest: string[],
  lines: readonly string[],
  issueRanges: { heading: { id: string; title: string }; from: number; to: number }[],
): ExitRow {
  const sheet = (name: string): string => fields.get(name)?.value ?? "";
  const effectText = sheet("効果");
  const operationText = sheet("操作");
  const target = sheet("どこに");
  const reversibility = sheet("戻し方");
  const stateText = sheet("状態");
  const result = sheet("結果");
  const problems: string[] = [];
  // the result column is part of the contract; without it a run would report nothing back to the document
  if (!fields.has("結果")) problems.push("結果 がありません");
  const effect = isExitEffect(effectText) ? effectText : "外へ出る";
  if (!isExitEffect(effectText)) problems.push(`効果を読めません: ${effectText || "(空)"}`);
  const operation = isExitOperation(operationText) ? operationText : "issues";
  if (!isExitOperation(operationText)) problems.push(`操作を読めません: ${operationText || "(空)"}`);
  if (!target) problems.push("どこに がありません");
  if (!reversibility) problems.push("戻し方 がありません");
  const state = isExitState(stateText) ? stateText : "下書き";
  if (!isExitState(stateText)) problems.push(`状態を読めません: ${stateText || "(空)"}`);
  if (isExitEffect(effectText) && isExitOperation(operationText) && effectText !== EFFECT_OF[operationText]) {
    problems.push(`効果が操作と違います: ${effectText} / ${operationText}`);
  }

  const row: ExitRow = {
    id: heading.id,
    title: heading.title,
    effect,
    operation,
    target,
    reversibility,
    state,
    result,
    readable: problems.length === 0,
    ...(problems.length ? { reason: problems.join("。") } : {}),
  };

  if (operation === "issues") {
    const issues: ExitIssue[] = [];
    const ids = new Set(issueRanges.map((range) => range.heading.id));
    for (const range of issueRanges) {
      const parsed = readFields(lines, range.from, range.to);
      if (!parsed.fields.has("結果")) problems.push(`Issue ${range.heading.id} の結果 がありません`);
      const bodyText = parsed.fields.get("本文")?.value ?? "";
      const issueResult = parsed.fields.get("結果")?.value ?? "";
      const depends = parseDependencies(parsed.fields.get("依存")?.value);
      for (const dep of depends) if (!ids.has(dep) || dep === range.heading.id) problems.push(`依存が同じ行の Issue を指していません: ${dep}`);
      issues.push({
        id: range.heading.id,
        title: range.heading.title,
        depends,
        labels: parseLabels(parsed.fields.get("ラベル")?.value),
        body: bodyText || parsed.rest.join("\n").trim(),
        number: issueNumberFromResult(issueResult),
        result: issueResult,
      });
    }
    if (!issues.length) problems.push("Issue が 1 件もありません");
    for (const issue of issues) if (!issue.body.trim()) problems.push(`Issue ${issue.id} の本文がありません`);
    // a duplicated Issue id is ambiguous: the writer credits the first match, so a result can land on the other
    const seenIssues = new Map<string, number>();
    for (const issue of issues) seenIssues.set(issue.id, (seenIssues.get(issue.id) ?? 0) + 1);
    for (const [id, count] of seenIssues) if (count > 1) problems.push(`Issue の id が重複しています: ${id}`);
    row.issues = issues;
  } else if (operation === "repo") {
    const visibilityText = sheet("公開");
    if (visibilityText !== "public" && visibilityText !== "private") problems.push(`公開を読めません: ${visibilityText || "(空)"}`);
    else row.visibility = visibilityText;
    const description = sheet("説明");
    if (!description.trim()) problems.push("説明がありません");
    else row.description = description;
  } else {
    const changeText = sheet("変更");
    if (changeText !== "作成" && changeText !== "追記" && changeText !== "置換") problems.push(`変更を読めません: ${changeText || "(空)"}`);
    else {
      row.change = changeText;
      if (changeText === "置換") {
        const before = sheet("前");
        const after = sheet("後");
        if (!before) problems.push("置換の 前 がありません");
        if (!after) problems.push("置換の 後 がありません");
        row.before = before;
        row.after = after;
      } else {
        const content = sheet("本文");
        if (!content) problems.push(`${changeText} の 本文 がありません`);
        row.content = content;
      }
    }
  }
  void rest;
  if (problems.length) {
    row.readable = false;
    row.reason = problems.join("。");
  }
  return row;
}

/**
 * The gate 2 approval the records currently support. A gate 1 line recorded after it reopens the exploration, so
 * an earlier gate 2 approval no longer stands: the last gate 2 line must come after the last gate 1 line, and that
 * gate 1 line must itself be an approval (a redo is not something to freeze on). Without those order checks a redo
 * would leave the old approval alive when the four points happen to be unchanged.
 */
export function effectiveGate2(gates: readonly GateRecord[]): GateRecord | undefined {
  let lastGate1 = -1;
  let lastGate2 = -1;
  for (let i = 0; i < gates.length; i += 1) {
    if (gates[i].gate === 1) lastGate1 = i;
    if (gates[i].gate === 2) lastGate2 = i;
  }
  if (lastGate2 < 0 || lastGate2 < lastGate1) return undefined;
  if (lastGate1 < 0 || gates[lastGate1].action !== "approve") return undefined;
  return gates[lastGate2].action === "approve" ? gates[lastGate2] : undefined;
}

function deriveStage(gates: readonly GateRecord[], frozenIntact: boolean, exits: readonly ExitRow[]): IdeaStage {
  const gate1 = [...gates].reverse().find((record) => record.gate === 1);
  const gate1Approved = gate1?.action === "approve";
  if (!gate1Approved) return "探索";
  if (!effectiveGate2(gates)) return "ゲート1";
  if (frozenIntact && exits.length > 0 && exits.every((row) => row.readable && row.state === "実行済み")) return "出口";
  return "凍結";
}

/**
 * The stage the first `index + 1` gate records support, read exactly as the whole document's stage is. The exits
 * are left out, so the answer is always one of 探索 / ゲート1 / 凍結: a record's own line is what stage it stands
 * at, and the same redo/override order that voids a freeze for the whole document voids it here too. The screen
 * never derives this itself; it shows the value the engine read.
 */
export function stageAfterGate(gates: readonly GateRecord[], index: number): IdeaStage {
  return deriveStage(gates.slice(0, index + 1), false, []);
}

/** the four points' text, normalized so a trailing blank line does not move the fingerprint */
export function ideaFourPointText(sections: readonly IdeaSectionRead[]): string {
  return IDEA_FROZEN_SECTIONS
    .map((name) => {
      const found = sections.find((section) => section.name === name);
      return `${name}\n${(found?.body ?? "").replace(/[ \t]+$/gm, "").trim()}`;
    })
    .join("\n\n");
}

/** the fingerprint gate 2 records: the four points' text, hashed */
export function ideaFourPointHash(document: IdeaDocument): string {
  return createHash("sha256").update(ideaFourPointText(document.sections)).digest("hex");
}

/** parse a document's text; `path` is only carried for the answer, the text is what is read */
export function parseIdeaDocument(text: string, path = ""): IdeaDocument {
  const unreadable: IdeaUnreadable[] = [];
  const { front, body } = splitFrontmatter(text);
  let frontmatter: Record<string, unknown> = {};
  if (front !== null) {
    try {
      frontmatter = asRecord(yamlLoad(front));
    } catch (error) {
      unreadable.push({ where: "frontmatter", reason: `frontmatter を読めません: ${error instanceof Error ? error.message : String(error)}` });
    }
  } else {
    unreadable.push({ where: "frontmatter", reason: "frontmatter がありません" });
  }

  const bodies = readSectionBodies(body);
  const markTable = asRecord(frontmatter.sections);
  const sections: IdeaSectionRead[] = IDEA_SECTIONS.map((name) => {
    const found = bodies.find((entry) => entry.name === name);
    const rawMark = markTable[name];
    const mark = isSectionMark(rawMark) ? rawMark : null;
    if (rawMark !== undefined && !isSectionMark(rawMark)) {
      unreadable.push({ where: `節 ${name}`, reason: `印を読めません: ${String(rawMark)}` });
    }
    const sectionBody = found?.body ?? "";
    return {
      name,
      mark,
      state: deriveState(mark, sectionBody),
      body: sectionBody,
      ...(rawMark !== undefined && !isSectionMark(rawMark) ? { reason: `印を読めません: ${String(rawMark)}` } : {}),
    };
  });
  for (const name of IDEA_SECTIONS) {
    if (!bodies.some((entry) => entry.name === name)) unreadable.push({ where: `節 ${name}`, reason: "節がありません" });
  }

  const undecidedSection = sections.find((section) => section.name === "未決");
  const undecided = undecidedSection ? readBullets(undecidedSection.body) : [];

  const gateSection = sections.find((section) => section.name === "ゲート記録");
  const gates: GateRecord[] = [];
  if (gateSection) {
    for (const line of gateSection.body.split("\n")) {
      const record = parseGateLine(line);
      if (record) gates.push(record);
    }
  }

  const hasOldExit = frontmatter.exit !== undefined;
  const exits: ExitRow[] = [];
  let exitsReadable = true;
  if (hasOldExit) {
    exitsReadable = false;
    unreadable.push({ where: "節 出口", reason: "古い形です。frontmatter の exit を出口の行に書き換えてください" });
  } else if (!bodies.some((entry) => entry.name === "出口")) {
    exitsReadable = false;
    unreadable.push({ where: "節 出口", reason: "出口の節がありません" });
  } else {
    exits.push(...readExitRows(body));
    for (const row of exits) {
      if (!row.readable) unreadable.push({ where: `出口の行 ${row.id}`, reason: row.reason ?? "読めません" });
    }
  }

  const placesRaw = Array.isArray(frontmatter.places) ? frontmatter.places : [];
  const places = placesRaw.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);

  // the fingerprint is checked against the four points as they read now; a gate 2 approval without one cannot be
  // confirmed, so its freeze is treated as broken. A gate 2 approval a later gate 1 line overrode, or one sitting
  // on a gate 1 redo, is not the gate 2 approval the records support, so it cannot keep the freeze intact either.
  const gate2 = effectiveGate2(gates);
  const frozenIntact = gate2?.fingerprint ? gate2.fingerprint === ideaFourPointHashFromSections(sections) : false;

  const stage = deriveStage(gates, frozenIntact, exits);
  return {
    path,
    frontmatter,
    slug: stringField(frontmatter.slug),
    status: stringField(frontmatter.status),
    target: stringField(frontmatter.target),
    createdAt: stringField(frontmatter.created_at ?? frontmatter.createdAt),
    frozenAt: stringField(frontmatter.frozen_at),
    sections,
    undecided,
    gates,
    exits,
    places,
    frozenIntact,
    frozen: stage === "凍結" || stage === "出口",
    exitsReadable,
    unreadable,
    stage,
  };
}

function ideaFourPointHashFromSections(sections: readonly IdeaSectionRead[]): string {
  return createHash("sha256").update(ideaFourPointText(sections)).digest("hex");
}

// ---- writing: the engine-owned fields only ----

function applyFieldValue(lines: string[], from: number, to: number, name: string, value: string): { lines: string[]; found: boolean } {
  const pattern = new RegExp(`^-\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  const fenced = fenceMask(lines);
  for (let i = from; i < to; i += 1) {
    // a `- name:` line inside a fence is a sample in body text: the real field is the one outside the fence
    if (fenced[i]) continue;
    if (!pattern.test(lines[i].trim())) continue;
    const inline = /^-\s*[^:]+?:\s*(.*)$/.exec(lines[i])?.[1] ?? "";
    if (inline.trim()) {
      const out = [...lines];
      out[i] = `- ${name}: ${value}`;
      // an inline field that turns multi-line cannot stay inline: keep the first line and drop the rest as a fence
      if (value.includes("\n")) out[i] = `- ${name}:`;
      if (value.includes("\n")) out.splice(i + 1, 0, "````text", ...value.split("\n"), "````");
      return { lines: out, found: true };
    }
    let j = i + 1;
    while (j < to && !lines[j].trim()) j += 1;
    const fence = j < to ? /^(`{3,})/.exec(lines[j]) : null;
    if (!fence) {
      const out = [...lines];
      out[i] = value.includes("\n") ? `- ${name}:` : `- ${name}: ${value}`;
      if (value.includes("\n")) out.splice(i + 1, 0, "````text", ...value.split("\n"), "````");
      return { lines: out, found: true };
    }
    const ticks = fence[1];
    const closing = new RegExp(`^\`{${ticks.length},}\\s*$`);
    let k = j + 1;
    while (k < to && !closing.test(lines[k])) k += 1;
    const before = lines.slice(0, j + 1);
    const after = lines.slice(k < to ? k : to);
    return { lines: [...before, ...value.split("\n"), ...after], found: true };
  }
  return { lines, found: false };
}

/**
 * The exit row's field range: only the rows inside the 出口 section count. A `### id:` heading elsewhere in the
 * document (an agent's body text) must not become the write-back destination, or a run would answer success
 * while the real row stayed a draft.
 */
function exitRowRange(lines: string[], exitId: string): { from: number; to: number } | null {
  const bounds = sectionRange(lines, "出口", bodyStartLine(lines));
  if (!bounds) return null;
  const fenced = fenceMask(lines);
  let from = -1;
  for (let i = bounds.from; i < bounds.to; i += 1) {
    if (fenced[i]) continue;
    const heading = parseExitHeading(lines[i]);
    if (heading) {
      if (heading.id === exitId) { from = i + 1; continue; }
      if (from >= 0) return { from, to: i };
      continue;
    }
    if (from >= 0 && /^##\s+/.test(lines[i])) return { from, to: i };
  }
  return from >= 0 ? { from, to: bounds.to } : null;
}

function issueRange(lines: string[], issueId: string): { from: number; to: number } | null {
  const fenced = fenceMask(lines);
  let from = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const heading = parseIssueHeading(lines[i]);
    if (heading) {
      if (heading.id === issueId) { from = i + 1; continue; }
      if (from >= 0) return { from, to: i };
      continue;
    }
    if (from >= 0 && (/^###\s+/.test(lines[i]) || /^##\s+/.test(lines[i]))) return { from, to: i };
  }
  return from >= 0 ? { from, to: lines.length } : null;
}

/** the section body line range (from the heading to the next `##`), searching from `start` */
function sectionRange(lines: string[], name: string, start = 0): { from: number; to: number } | null {
  const fenced = fenceMask(lines);
  let from = -1;
  for (let i = start; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    if (new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`).test(lines[i])) { from = i + 1; continue; }
    if (from >= 0 && /^##\s+/.test(lines[i])) return { from, to: i };
  }
  return from >= 0 ? { from, to: lines.length } : null;
}

/** the first line after a leading frontmatter block, so a `##` inside the frontmatter is not a heading */
function bodyStartLine(lines: readonly string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^---\s*$/.test(lines[i])) return i + 1;
  }
  return 0;
}

/** today in the shape the gate record uses */
export function gateDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** the one line a gate record writes; `approve` on gate 2 carries the four points' fingerprint */
export function formatGateLine(record: { gate: 1 | 2; action: "approve" | "redo"; reason?: string; fingerprint?: string; date?: string }): string {
  const date = record.date ?? gateDate();
  if (record.action === "redo") {
    // a reason is folded to one line: a newline in it would let the reason inject a second gate record
    const reason = record.reason?.replace(/\s*\n\s*/g, " ").trim();
    return `- ゲート ${record.gate}: ${date} やり直し${reason ? ` — ${reason}` : ""}`;
  }
  const fingerprint = record.gate === 2 && record.fingerprint ? ` 指紋 ${record.fingerprint}` : "";
  return `- ゲート ${record.gate}: ${date} 承認${fingerprint}`;
}

/** add one gate record line to the ゲート記録 section, making the section when the document has none */
export function addGateRecord(text: string, record: { gate: 1 | 2; action: "approve" | "redo"; reason?: string; fingerprint?: string; date?: string }): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const line = formatGateLine(record);
  const range = sectionRange(lines, "ゲート記録", bodyStartLine(lines));
  if (!range) {
    const suffix = lines.length && lines[lines.length - 1].trim() ? ["", "## ゲート記録", "", line] : ["## ゲート記録", "", line];
    return [...lines, ...suffix].join("\n");
  }
  // insert before the section's trailing blank lines, so the line joins the list
  let at = range.to;
  while (at > range.from && !lines[at - 1].trim()) at -= 1;
  return [...lines.slice(0, at), line, ...lines.slice(at)].join("\n");
}

/** set one exit row's state (and result when given) without touching the agent's text; a missing field is an error */
export function setExitState(text: string, exitId: string, state: ExitState, result?: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const range = exitRowRange(lines, exitId);
  if (!range) throw new Error(`出口の節に実行する行がありません: ${exitId}`);
  const stateWrite = applyFieldValue(lines, range.from, range.to, "状態", state);
  if (!stateWrite.found) throw new Error(`出口の行の 状態 を書けません: ${exitId}`);
  let out = stateWrite.lines;
  if (result !== undefined) {
    const again = exitRowRange(out, exitId);
    if (!again) throw new Error(`出口の節に実行する行がありません: ${exitId}`);
    const resultWrite = applyFieldValue(out, again.from, again.to, "結果", result);
    if (!resultWrite.found) throw new Error(`出口の行の 結果 を書けません: ${exitId}`);
    out = resultWrite.lines;
  }
  return out.join("\n");
}

/** set one Issue's result inside an exit row, without touching the agent's text; a missing field is an error */
export function setIssueResult(text: string, exitId: string, issueId: string, result: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const rowRange = exitRowRange(lines, exitId);
  if (!rowRange) throw new Error(`出口の節に実行する行がありません: ${exitId}`);
  // the issue headings are inside the row's range; search the whole text within that range
  const slice = lines.slice(rowRange.from, rowRange.to);
  const issue = issueRange(slice, issueId);
  if (!issue) throw new Error(`出口の行に Issue がありません: ${exitId} / ${issueId}`);
  const absolute = { from: rowRange.from + issue.from, to: rowRange.from + issue.to };
  const written = applyFieldValue(lines, absolute.from, absolute.to, "結果", result);
  if (!written.found) throw new Error(`Issue ${issueId} の 結果 を書けません`);
  return written.lines.join("\n");
}

/** set the two frontmatter keys the engine owns */
export function setFrontmatterFields(text: string, patch: { status?: string; frozen_at?: string | null }): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return text;
  const lines = match[1].split("\n");
  const set = (key: string, value: string): void => {
    const index = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
    if (index >= 0) lines[index] = `${key}: ${value}`;
    else lines.push(`${key}: ${value}`);
  };
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.frozen_at !== undefined) set("frozen_at", patch.frozen_at ?? "");
  const replaced = `---\n${lines.join("\n")}\n---\n`;
  return replaced + normalized.slice(match[0].length);
}

/** replace a document with `text` through a temp file, so a reader never sees half a document */
export function writeIdeaText(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/** the exit row as the signature covers it: everything except the state and the result */
export function exitRowSigned(row: ExitRow): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: row.id,
    effect: row.effect,
    operation: row.operation,
    target: row.target,
    title: row.title,
    reversibility: row.reversibility,
  };
  if (row.operation === "issues") {
    base.issues = (row.issues ?? []).map((issue) => ({
      id: issue.id,
      title: issue.title,
      depends: [...issue.depends],
      labels: [...issue.labels],
      body: issue.body,
      // an Issue that was already made is signed by its number: re-pointing the result is caught at the gate
      number: issue.number,
    }));
  } else if (row.operation === "repo") {
    base.repo = { visibility: row.visibility ?? null, description: row.description ?? "" };
  } else {
    base.file = {
      change: row.change ?? null,
      content: row.content ?? null,
      before: row.before ?? null,
      after: row.after ?? null,
    };
  }
  return base;
}

/** whether the row can be run: it reads, it is a draft or a failure, and it is not left half-run */
export function rowRunnable(row: ExitRow): boolean {
  return row.readable && (row.state === "下書き" || row.state === "失敗");
}

/** an approval target summary: the count, the kind breakdown and the irreversible rows */
export function summarizeExits(rows: readonly ExitRow[]): { total: number; outbound: number; local: number; irreversible: number; interrupted: number } {
  let outbound = 0;
  let local = 0;
  let irreversible = 0;
  let interrupted = 0;
  for (const row of rows) {
    if (row.effect === "外へ出る") outbound += 1;
    else local += 1;
    if (row.reversibility.trim() === "戻せない") irreversible += 1;
    if (row.state === "承認済み") interrupted += 1;
  }
  return { total: rows.length, outbound, local, irreversible, interrupted };
}

/**
 * One exit row as the screen reads it: the same five fields whatever the operation is, plus the operation's own
 * content, and the reason when the row does not follow the contract. A row that was left `承認済み` by a run that
 * stopped is marked, so a screen shows it as interrupted instead of as an approval penne made.
 */
export function exitRowStatus(row: ExitRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    effect: row.effect,
    operation: row.operation,
    target: row.target,
    reversibility: row.reversibility,
    state: row.state,
    result: row.result,
    readable: row.readable,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.state === "承認済み" ? { interrupted: true } : {}),
    ...(row.issues ? { issues: row.issues.map((issue) => ({ id: issue.id, title: issue.title, depends: [...issue.depends], labels: [...issue.labels], body: issue.body, number: issue.number, result: issue.result })) } : {}),
    ...(row.operation === "repo" ? { repo: { visibility: row.visibility ?? null, description: row.description ?? "" } } : {}),
    ...(row.operation === "file" ? { file: { change: row.change ?? null, content: row.content ?? null, before: row.before ?? null, after: row.after ?? null } } : {}),
  };
}
