/**
 * One reader for the lane's intent, so every place that reads it sees the same Choices. A v1 lane is read from
 * decision.md as before; a v2 lane is read from the plan report's drafts before its GO, and from the intent column
 * after. The AC and the references come from qa.md and reference.md for both shapes. Handing a role its Choices is
 * a file drawn from this one reading, the same way the harm examples and the AC states are handed over.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readLifecycle } from "../ledger/read.ts";
import { replanView } from "../ledger/derive.ts";
import { stateDir } from "../paths.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";
import { areaSegment, parseIntent, slugOf, type OverallLine } from "../intent/parse.ts";
import { foldRows, intentColumnPath, laneStates, planChoiceIds, readRows, type ChoiceHistoryEntry, type IntentRow } from "../intent/store.ts";
import type { ChoiceForms, ChoiceStatus, Place } from "../intent/records.ts";
import { readyPlanRecordsOf } from "../agent/intent-impact.ts";
import { laneRecordShape, type RecordShape } from "./record-shape.ts";

/** one Choice as a reader sees it, whatever shape it was written in */
export interface LaneChoice {
  id: string;
  text: string;
  forms?: ChoiceForms;
  why: string;
  anchored?: string;
  free?: string;
  /** when to revisit: for a stopgap, the follow-up Issue the real fix is raised in */
  revisit?: string;
  place?: Place[];
  purpose?: string;
  purpose_statement?: string;
  status?: ChoiceStatus;
  /** the record's Source field, for a v1 decision read from decision.md */
  source?: string;
  /** the disposal the plan report declared for this Choice, when one was */
  disposal?: string;
  /** true when the GO has not happened yet: the id is the one the raise would take */
  planned?: boolean;
}

export interface LaneIntent {
  decisions: LaneChoice[];
  criteria: { id: string; text: string }[];
  invariants: { id: string; text: string }[];
  references: { path: string; why: string }[];
  /** the lane's overall statement and its declared judge (qa.md の全体の行), for the device stage */
  overall: OverallLine;
  shape: RecordShape;
}

export interface LaneIntentOpts {
  root?: string;
  branch?: { repo: string; ref: string };
  events?: LifecycleRecord[];
}

const isLaneChoice = (history: ChoiceHistoryEntry[], lane: string): boolean =>
  history.some((h) => (h.event === "created" || h.event === "re-anchored") && "lane" in h.by && h.by.lane === lane);

/** the fields a planned draft and a written Choice share, in the one order the reader shows them */
function choiceFields(id: string, c: Pick<LaneChoice, "forms" | "why" | "anchored" | "free" | "revisit" | "place" | "purpose">): LaneChoice {
  return {
    id,
    text: c.forms?.chosen ?? "",
    forms: c.forms,
    why: c.why,
    anchored: c.anchored,
    ...(c.free ? { free: c.free } : {}),
    place: c.place,
    purpose: c.purpose,
    ...(c.revisit ? { revisit: c.revisit } : {}),
  };
}

/** the drafts of the last ready, shown by the ids their raises would take */
function plannedChoices(repo: string, lane: string, events: LifecycleRecord[]): LaneChoice[] {
  const records = readyPlanRecordsOf(events);
  if (!records?.choices.length) return [];
  const ids = planChoiceIds(repo, lane, records.choices.length);
  return records.choices.map((c, i) => ({
    ...choiceFields(`${ids[i]}（予定）`, c),
    ...(c.supersedes?.ids.length ? { disposal: `supersede ${c.supersedes.ids.join(", ")}` } : {}),
    planned: true,
  }));
}

/** the Choices the lane raised or re-anchored, read from its own view of the column */
function writtenChoices(repo: string, lane: string, events: LifecycleRecord[]): LaneChoice[] {
  const rows: IntentRow[] = readRows(intentColumnPath(repo));
  const folded = foldRows(rows, lane, laneStates(events));
  const byId = new Map(folded.purposes.map((p) => [p.id, p]));
  const out: LaneChoice[] = [];
  for (const c of folded.choices) {
    if (!isLaneChoice(c.history, lane)) continue;
    const purpose = byId.get(c.purpose);
    out.push({
      ...choiceFields(c.id, c),
      ...(purpose ? { purpose_statement: purpose.statement } : {}),
      status: c.status,
    });
  }
  return out;
}

/** whether the GO has been recorded for this lane */
function hasGo(events: LifecycleRecord[]): boolean {
  return replanView(events).some((e) => e.event === "s1_go");
}

/** the v1 decisions as the one reader's Choices */
function docChoices(decisions: ReturnType<typeof parseIntent>["decisions"]): LaneChoice[] {
  return decisions.map((d) => ({ id: d.id, text: d.text, why: d.why, source: d.source }));
}

/**
 * The lane's intent, read the one way. The shape decides the source of the Choices; the AC and the references always
 * come from the repo's qa.md and reference.md.
 */
export function laneIntent(rec: BacklogRecord, opts: LaneIntentOpts = {}): LaneIntent {
  const events = opts.events ?? readLifecycle().filter((e) => e.idd_id === rec.idd_id);
  const docs = laneIntentDocs(rec, { ...opts, events });
  const ledger = laneLedgerChoices(rec, events);
  return { ...docs, decisions: ledger ?? docs.decisions };
}

/**
 * The half of the intent the repo's documents hold: decision.md for a v1 lane, and qa.md / reference.md for both
 * shapes. Reading it reads the lane's worktree, so a derivation takes it and the answer replays what it found.
 * `decisions` is empty for a v2 lane, whose Choices live in the ledger (`laneLedgerChoices`).
 */
export function laneIntentDocs(rec: BacklogRecord, opts: LaneIntentOpts = {}): LaneIntent {
  const base = parseIntent(rec.area, slugOf(rec), { ...(opts.root ? { root: opts.root } : {}), ...(opts.branch ? { branch: opts.branch } : {}) });
  const events = opts.events ?? readLifecycle().filter((e) => e.idd_id === rec.idd_id);
  const shape = laneRecordShape(rec.idd_id, events);
  return shape === "docs"
    ? { decisions: docChoices(base.decisions), criteria: base.criteria, invariants: base.invariants, references: base.references, overall: base.overall, shape }
    : { decisions: [], criteria: base.criteria, invariants: [], references: base.references, overall: base.overall, shape };
}

/**
 * The Choices the ledger holds for the lane, folded from the intent column (or the ready's drafts before the GO), or
 * null for a v1 lane, whose Choices are in its decision.md. This is the part a judgment writes, so a card reads it
 * at the moment it answers rather than from what a derivation found: the next Choices are what penne decides on.
 */
export function laneLedgerChoices(rec: BacklogRecord, events: LifecycleRecord[]): LaneChoice[] | null {
  if (laneRecordShape(rec.idd_id, events) === "docs") return null;
  return hasGo(events) ? writtenChoices(rec.area, rec.idd_id, events) : plannedChoices(rec.area, rec.idd_id, events);
}

/** the markdown one Choice is drawn as, for a role's input */
function choiceLines(c: LaneChoice): string[] {
  const lines = [`## ${c.id}: ${c.text || "(題なし)"}`];
  if (c.purpose) lines.push(`- purpose: ${c.purpose}${c.purpose_statement ? ` ${c.purpose_statement}` : ""}`);
  if (c.place?.length) lines.push(`- place: ${c.place.map((p) => `${p.kind} ${p.path}${p.file ? ` (file ${p.file}${p.symbols?.length ? `, ${p.symbols.join(", ")}` : ""})` : p.symbols?.length ? ` (${p.symbols.join(", ")})` : ""}`).join(", ")}`);
  for (const key of ["why", "anchored", "free", "revisit"] as const) if (c[key]) lines.push(`- ${key}: ${c[key]}`);
  if (c.status) lines.push(`- status: ${c.status}`);
  if (c.disposal) lines.push(`- 処置: ${c.disposal}`);
  for (const r of c.forms?.rejected ?? []) lines.push(`- rejected: ${r.form} — ${r.fails_because}`);
  lines.push("");
  return lines;
}

/**
 * Draw the lane's Choices where a stage reads its inputs, or undefined when the lane has none (a lane with no
 * Choice gets no such input). The file is drawn from the one reader, so the reviewer and the judgement see the
 * same Choices the GO card and the executor's contract do.
 */
export function writeLaneChoicesFile(rec: BacklogRecord, label: string): string | undefined {
  const intent = laneIntent(rec);
  if (!intent.decisions.length) return undefined;
  const seg = areaSegment(rec.area);
  const dir = join(stateDir(), "pipeline", "lane-choices");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${seg}-${rec.idd_id}-${label}.md`);
  writeFileSync(file, [
    `# ${rec.idd_id} の Choice（${intent.shape === "docs" ? "decision.md" : intent.decisions.some((d) => d.planned) ? "計画の草案" : "意図の列"}）`,
    "",
    ...intent.decisions.flatMap(choiceLines),
  ].join("\n"));
  return file;
}
