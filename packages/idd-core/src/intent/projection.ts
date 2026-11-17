/**
 * Drawing the A projections of the v2 records: the markdown files a repo's tree holds beside the state. The
 * function is a pure function of the folded state: it reads no file, no clock and no environment, so drawing the
 * same state twice gives the same bytes, and a check can tell a hand-edited projection from a stale one. The mark
 * on the first line says the file is drawn, not written; the check and the draw verb name the same constant.
 *
 * The state is the whole input, and the state is free text written by people and agents: a body line may look like
 * a heading. Every such line is either folded onto one line or indented as a continuation, so the only lines that
 * start with `## ` are the Choice headings the drawing itself makes (INV-106-4). The one exception is the summary
 * section of overview.md, which is handed to a reader on its own and therefore keeps its line breaks: there the
 * lines that start with `#` are escaped.
 */

import {
  FREE_WHILE_WHY, OVERVIEW_PURPOSE_ID, type ChoiceStatus, type IntentActor, type Place,
} from "./records.ts";
import type { ProjectDecisionView, ProjectView } from "./project.ts";
import type { ChoiceHistoryEntry, ChoiceView, PurposeView } from "./store.ts";

/** the one mark the first line of every drawn file carries; the draw verb and the projection check share it */
export const PROJECTION_MARK =
  "<!-- propter: 状態から描いた写しです。手で直さないでください。直した内容は次の描き直しで消えます -->";

export const OVERVIEW_FILENAME = "overview.md";
export const INDEX_FILENAME = "index.md";
export const PURPOSE_FILENAME = (id: string): string => `${id}.md`;
export const PROJECT_FILENAME = (id: string): string => `${id}.md`;

export interface ProjectionFile {
  name: string;
  content: string;
}

/** LF only: a state string may carry a CR from a document that was written on another system */
function lf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** a value that goes on one line: its newlines and runs of whitespace become one space */
function fold(value: string): string {
  return lf(value).replace(/\s+/g, " ").trim();
}

function firstLine(text: string): string {
  return fold(lf(text).split("\n")[0] ?? "");
}

/**
 * The order of two identifiers, without a locale. A string is cut into runs of digits and runs of other
 * characters; a digit run is compared as a number without `Number` (by its digits with the leading zeros
 * dropped, then as a string, so a number too long for a double keeps its order). Two strings that differ only in
 * the leading zeros of a run are ordered by the original strings, so `P-01` and `P-1` keep a stable, distinct
 * order. Different strings never compare equal.
 */
export function compareProjectionIds(a: string, b: string): number {
  const ta = runs(a);
  const tb = runs(b);
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i += 1) {
    const x = ta[i];
    const y = tb[i];
    if (x.digits && y.digits) {
      const xz = x.value.replace(/^0+/, "") || "0";
      const yz = y.value.replace(/^0+/, "") || "0";
      if (xz.length !== yz.length) return xz.length < yz.length ? -1 : 1;
      if (xz !== yz) return xz < yz ? -1 : 1;
      continue;
    }
    if (x.value !== y.value) return x.value < y.value ? -1 : 1;
  }
  if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function runs(text: string): { value: string; digits: boolean }[] {
  const out: { value: string; digits: boolean }[] = [];
  for (const m of text.matchAll(/\d+|\D+/g)) out.push({ value: m[0], digits: /^\d/.test(m[0]) });
  return out;
}

/** code unit order, for paths */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** the active and unconfirmed Choices are the ones the projections draw in full */
function isLive(status: ChoiceStatus): boolean {
  return status === "active" || status === "unconfirmed";
}

/** active and unconfirmed first (by id), then superseded (by id), then dropped (by id) */
function compareChoices(a: ChoiceView, b: ChoiceView): number {
  const rank = (s: ChoiceStatus): number => (s === "dropped" ? 2 : s === "superseded" ? 1 : 0);
  return rank(a.status) - rank(b.status) || compareProjectionIds(a.id, b.id);
}

/** an actor of a history entry: the lane, or the session that is the lane's outside */
function actorLabel(by: IntentActor): string {
  return "lane" in by ? `lane ${fold(by.lane)}` : `session ${fold(by.session)}`;
}

/** a field whose body may run several lines: the first line follows the label, the rest are indented */
function field(label: string, body: string): string[] {
  const lines = lf(body).split("\n").map((line, i) => (i === 0 || line === "" ? line : `  ${line}`));
  return [`- ${label}: ${lines[0] ?? ""}`, ...lines.slice(1)];
}

function oneLine(label: string, value: string): string {
  return `- ${label}: ${fold(value)}`;
}

function placeLabel(place: Place): string {
  // the marks stay with the module: the reader of the copy sees which file the Choice was written against
  const file = place.file ? `, file: \`${fold(place.file)}\`` : "";
  const symbols = place.symbols?.length ? `, symbols: ${place.symbols.map((s) => `\`${fold(s)}\``).join(", ")}` : "";
  return `\`${fold(place.path)}\` (${place.kind}${file}${symbols})`;
}

/** the Why not section: one item per rejected form, or the no-why-not reason when none was given */
function whyNotLines(c: ChoiceView): string[] {
  if (c.forms.rejected.length) {
    const out = ["- Why not:"];
    for (const r of c.forms.rejected) {
      const body = lf(r.fails_because).split("\n");
      out.push(`  - ${fold(r.form)}: ${body[0] ?? ""}`);
      for (const line of body.slice(1)) out.push(line === "" ? "" : `    ${line}`);
    }
    return out;
  }
  const reason = c.waives[0]?.reason ?? "";
  return field("Why not", reason);
}

function historyLabel(h: ChoiceHistoryEntry): string {
  const parts = [`${fold(h.at)} ${h.event}（${actorLabel(h.by)}）`];
  if (h.event === "superseded") {
    if (h.successor) parts.push(`後継 ${fold(h.successor)}`);
    if (h.grounds) parts.push(`Grounds: ${fold(h.grounds)}`);
  } else if (h.event === "dropped" && h.grounds) {
    parts.push(`Grounds: ${fold(h.grounds)}`);
  }
  return parts.join(" / ");
}

function originLabel(c: ChoiceView): string {
  const o = c.origin;
  const who = o.by === "human" ? `human${o.question ? `（質問 ${fold(o.question)}）` : ""}` : "agent";
  const migrated = o.migrated
    ? `（移行: \`${fold(o.migrated.doc)}\` / ${fold(o.migrated.purpose_from)}${o.migrated.source ? ` / Source: ${fold(o.migrated.source)}` : ""}）`
    : "";
  return `${who}${migrated}（visibility: ${c.visibility}）`;
}

function choiceSection(c: ChoiceView): string[] {
  const successor = [...c.history].reverse().find((h) => h.event === "superseded")?.successor;
  const suffix = c.status === "active"
    ? ""
    : c.status === "superseded"
      ? ` [superseded${successor ? ` → ${fold(successor)}` : ""}]`
      : ` [${c.status}]`;
  const lines = [`## ${fold(c.id)}: ${fold(c.forms.chosen)}${suffix}`];
  lines.push("- Place:");
  for (const place of c.place) lines.push(`  - ${placeLabel(place)}`);
  lines.push(...field("Why", c.why));
  lines.push(...whyNotLines(c));
  lines.push(...field("Anchored", c.anchored));
  lines.push(...field("Free", c.free || FREE_WHILE_WHY));
  if (c.revisit) lines.push(...field("Revisit", c.revisit));
  lines.push(oneLine("origin", originLabel(c)));
  lines.push("- history:");
  for (const h of c.history) lines.push(`  - ${historyLabel(h)}`);
  return lines;
}

function purposeFile(p: PurposeView, choices: ChoiceView[]): ProjectionFile {
  const lines = [`# ${fold(p.id)}: ${firstLine(p.statement)}`];
  if (lf(p.statement).includes("\n")) lines.push(...field("statement", p.statement));
  if (p.name) lines.push(oneLine("name", p.name));
  lines.push(oneLine("origin", p.origin));
  lines.push(oneLine("status", p.status));
  // a person's restatement replaced the sentence above: the one the raise wrote stays readable
  // put back to the raise's own sentence, it would only repeat the heading
  if (p.raised_statement !== undefined && p.raised_statement.trim() !== p.statement.trim()) lines.push(...field("raised_statement", p.raised_statement));
  if ((p.status === "retired" || p.status === "withdrawn") && p.grounds) lines.push(oneLine("grounds", p.grounds));
  for (const c of [...choices].sort(compareChoices)) lines.push("", ...choiceSection(c));
  return file(PURPOSE_FILENAME(p.id), lines);
}

/** a Choice whose Purpose is not in the state still gets its file, so nothing is dropped from the projection */
function orphanPurposeFile(id: string, choices: ChoiceView[]): ProjectionFile {
  const lines = [`# ${fold(id)}: Purpose が状態にありません`];
  for (const c of [...choices].sort(compareChoices)) lines.push("", ...choiceSection(c));
  return file(PURPOSE_FILENAME(id), lines);
}

/** the summary section keeps its line breaks; a line that starts with `#` is escaped so it cannot read as a heading */
function escapedSummary(statement: string): string[] {
  return lf(statement).split("\n").map((line) => (line.startsWith("#") ? `\\${line}` : line));
}

/**
 * A Project's file: the fields in a fixed order, the free text with its heading-looking lines escaped, one section per
 * decision, and the Issues. A decision that moved to a Choice is a pointer only (the Choice's status beside it), so the
 * body is read in one place; a pointer to a Choice that was replaced or dropped says so, and the check names it.
 */
function projectFile(p: ProjectView, choices: ChoiceView[]): ProjectionFile {
  const lines = [`# ${fold(p.id)}: ${firstLine(p.name)}`];
  lines.push(oneLine("Purpose", p.purpose ? `[${fold(p.purpose)}](${PURPOSE_FILENAME(fold(p.purpose))})` : "（なし）"));
  lines.push(oneLine("state", p.state));
  lines.push(...field("done when", p.doneWhen));
  lines.push("", "## 本文");
  lines.push(...(p.body ? escapedSummary(p.body) : ["（本文はまだありません）"]));
  lines.push("", "## 決定");
  if (!p.decisions.length) lines.push("（決定はまだありません）");
  for (const d of p.decisions) lines.push(...decisionSection(d, choices));
  lines.push("", "## Issue");
  if (!p.issues.length) lines.push("（属す Issue はまだありません）");
  for (const issue of p.issues) lines.push(`- ${fold(issue)}`);
  return file(PROJECT_FILENAME(p.id), lines);
}

function decisionSection(d: ProjectDecisionView, choices: ChoiceView[]): string[] {
  const lines = [`### ${fold(d.id)}: ${fold(d.chosen)}${d.movedTo ? ` [→ ${fold(d.movedTo)}]` : ""}`];
  if (d.movedTo) {
    const target = choices.find((c) => c.id === d.movedTo);
    const status = !target
      ? "Choice が状態にありません"
      : target.status === "superseded"
        ? `superseded${supersededBy(target) ? ` → ${fold(supersededBy(target) as string)}` : ""}`
        : target.status;
    lines.push(oneLine("移し先", `${fold(d.movedTo)}（${status}）。本文は移し先の Choice にある`));
    return lines;
  }
  lines.push(...field("Why", d.why ?? ""));
  if (d.rejected?.length) {
    lines.push("- Why not:");
    for (const r of d.rejected) {
      const body = lf(r.fails_because).split("\n");
      lines.push(`  - ${fold(r.form)}: ${body[0] ?? ""}`);
      for (const line of body.slice(1)) lines.push(line === "" ? "" : `    ${line}`);
    }
  } else {
    lines.push(...field("Why not", d.noWhyNot ?? ""));
  }
  return lines;
}

function supersededBy(c: ChoiceView): string | undefined {
  return [...c.history].reverse().find((h) => h.event === "superseded")?.successor;
}

function overviewFile(purposes: PurposeView[], choices: ChoiceView[], projects: ProjectView[]): ProjectionFile {
  const lines = ["## 概要"];
  const top = purposes.find((p) => p.id === OVERVIEW_PURPOSE_ID && p.status === "active");
  if (top) lines.push(...escapedSummary(top.statement));
  else lines.push(`概要の Purpose（${OVERVIEW_PURPOSE_ID}）がまだありません`);
  lines.push("", "## 組まれ方");
  const rooted = choices
    .filter((c) => isLive(c.status) && c.place.some((p) => p.kind === "root"))
    .sort((a, b) => compareProjectionIds(a.id, b.id));
  for (const c of rooted) {
    const mark = c.status === "unconfirmed" ? " [unconfirmed]" : "";
    lines.push(`### ${fold(c.id)}: ${fold(c.forms.chosen)}${mark}`);
    lines.push(...field("Why", c.why));
    lines.push(...whyNotLines(c));
    lines.push(...field("Anchored", c.anchored));
    lines.push(...field("Free", c.free || FREE_WHILE_WHY));
    lines.push(`- Purpose: [${fold(c.purpose)}](${PURPOSE_FILENAME(fold(c.purpose))})`);
  }
  lines.push("", "## Purpose");
  for (const p of [...purposes].filter((x) => x.status === "active").sort((a, b) => compareProjectionIds(a.id, b.id))) {
    const count = choices.filter((c) => c.purpose === p.id && isLive(c.status)).length;
    const name = p.name ? ` ${fold(p.name)}` : "";
    lines.push(`- [${fold(p.id)}](${PURPOSE_FILENAME(fold(p.id))})${name}: ${firstLine(p.statement)} — origin: ${fold(p.origin)} / 有効な Choice: ${count} 件`);
  }
  // a repo with no Project draws no section: its overview is the text it always was
  if (projects.length) {
    lines.push("", "## Project");
    for (const p of [...projects].sort((a, b) => compareProjectionIds(a.id, b.id))) {
      lines.push(`- [${fold(p.id)}](${PROJECT_FILENAME(fold(p.id))}) ${firstLine(p.name)} [${p.state}] — Purpose: ${fold(p.purpose)} / Issue: ${p.issues.length} 件 / 決定: ${p.decisions.length} 件`);
    }
  }
  return file(OVERVIEW_FILENAME, lines);
}

function indexFile(choices: ChoiceView[]): ProjectionFile {
  const live = choices.filter((c) => isLive(c.status));
  const paths = new Set<string>();
  for (const c of live) for (const place of c.place) paths.add(place.path);
  const ordered = [...paths].sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : compareStrings(a, b)));
  const lines: string[] = [];
  for (const path of ordered) {
    if (lines.length) lines.push("");
    lines.push(`## \`${fold(path)}\``);
    const here = live.filter((c) => c.place.some((p) => p.path === path)).sort((a, b) => compareProjectionIds(a.id, b.id));
    for (const c of here) {
      const place = c.place.find((p) => p.path === path) as Place;
      const file = place.file ? ` file: \`${fold(place.file)}\`` : "";
      const symbols = place.symbols?.length ? ` symbols: ${place.symbols.map((s) => `\`${fold(s)}\``).join(", ")}` : "";
      const mark = c.status === "unconfirmed" ? " [unconfirmed]" : "";
      lines.push(`- [${fold(c.id)}](${PURPOSE_FILENAME(fold(c.purpose))}): ${fold(c.forms.chosen)}${file}${symbols}${mark}`);
    }
  }
  return file(INDEX_FILENAME, lines);
}

function file(name: string, lines: string[]): ProjectionFile {
  const raw = [PROJECTION_MARK, ...lines].join("\n");
  return { name, content: raw.replace(/\n*$/, "\n") };
}

export interface ProjectionInput {
  purposes: PurposeView[];
  choices: ChoiceView[];
  /** the Projects of the same state; absent draws none, and a repo with none draws what it always drew */
  projects?: ProjectView[];
}

/**
 * Every file of the A projection, sorted by name. An empty state draws nothing: a repo with no records does not
 * get an empty overview.md and index.md. A Choice whose Purpose is not in the state still gets a file, so the
 * number of Choice headings always matches the state.
 */
export function projectRecords(input: ProjectionInput): ProjectionFile[] {
  const projects = input.projects ?? [];
  if (!input.purposes.length && !input.choices.length && !projects.length) return [];
  const purposes = [...input.purposes].sort((a, b) => compareProjectionIds(a.id, b.id));
  const byPurpose = new Map<string, ChoiceView[]>();
  for (const c of input.choices) {
    const list = byPurpose.get(c.purpose) ?? [];
    list.push(c);
    byPurpose.set(c.purpose, list);
  }
  const files: ProjectionFile[] = [];
  const known = new Set(purposes.map((p) => p.id));
  for (const p of purposes) files.push(purposeFile(p, byPurpose.get(p.id) ?? []));
  for (const id of [...byPurpose.keys()].filter((id) => !known.has(id)).sort(compareProjectionIds)) {
    files.push(orphanPurposeFile(id, byPurpose.get(id) ?? []));
  }
  for (const p of [...projects].sort((a, b) => compareProjectionIds(a.id, b.id))) files.push(projectFile(p, input.choices));
  files.push(overviewFile(purposes, input.choices, projects));
  files.push(indexFile(input.choices));
  return files.sort((a, b) => compareStrings(a.name, b.name));
}
