import {
  anchorsNoneOf, compareIds, decisionHeading, parseDecisionDoc, readDecisionDocs, type DecisionDoc, type ParsedDecision,
} from "./decisions.ts";
import { placeOf } from "./places.ts";
import {
  FREE_WHILE_WHY, normalizeChoiceBody, normalizePlace, type ChoiceBody, type ChoiceStatus, type Place, type RaisedChoiceStatus,
} from "./records.ts";
import type { ChoiceView, PurposeView } from "./store.ts";

/**
 * Reading the old decision documents and planning the v2 records they become. The plan is a pure function of the
 * documents and two tables (the Purpose list and the assignment); it never touches the disk or the network, and it
 * writes nothing. The caller decides where the documents come from and where the plan goes.
 *
 * The whole point is that a record whose Purpose is unknown is never written: one such record blocks the entire
 * run, because a Choice with an estimated Purpose is indistinguishable from a verified one once it is a row.
 */

/** one field of a DEC section: the name as written (parentheses kept) and its body, continuation lines included */
export interface LegacyField {
  name: string;
  body: string;
}

/** one INV line, with the DEC its parenthetical names (or null when it names none) */
export interface LegacyInv {
  id: string;
  text: string;
  from: string | null;
  doc: string;
  created?: string;
}

/** how a DEC's Anchors were read: as the index reads them, repaired, `None`, or nothing readable at all */
export type AnchorsNote = "read" | "fixed" | "none" | "unreadable";

/** one DEC section of a decision document, with every field it carries */
export interface LegacyDec {
  id: string;
  doc: string;
  title: string;
  created?: string;
  what: string;
  why: string;
  free?: string;
  revisit?: string;
  source?: string;
  /** the Places the Anchors name, with symbols; a root Place when nothing was readable */
  anchors: Place[];
  anchorsNote: AnchorsNote;
  supersededBy: string[];
  /** whether the section carries a `Superseded by` field at all (prose alone still counts as carrying one) */
  hasSuperseded: boolean;
  whyNots: LegacyField[];
  /** the fields 7.1's table does not name, in document order, names as written */
  extra: LegacyField[];
  invs: LegacyInv[];
}

export interface LegacyRecords {
  decs: LegacyDec[];
  orphanInvs: LegacyInv[];
}

const ROOT: Place = { path: "/", kind: "root" };
const ANY_HEADING = /^#{1,6}\s/;
/** an INV line, read the same shape `parse.ts` reads (`- INV-x (…): text`, the colon required) */
const INV_LINE = /^-\s+(INV-[\w.-]+)\s*(?:\(([^)]*)\))?:\s*(.+?)\s*$/;
/** a code identifier: a word of letters/digits/`_`/`$`, dotted, as `foldRows` or `AppTheme.primary` */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
/** the canonical names that map onto a field of the Choice; the first exact match wins */
const CANONICAL = ["What", "Why", "Change freedom", "Revisit when", "Source", "Anchors", "Superseded by"];

function backquotes(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** the document's own date, from the frontmatter's `created_at`; undefined when it cannot be read */
function documentCreatedAt(text: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!front) return undefined;
  const line = front[1].split(/\r?\n/).find((l) => /^created_at\s*:/.test(l));
  if (!line) return undefined;
  const value = line.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

/**
 * One field line: `- **Name**: body`, the name as written (a parenthetical after the bold is part of it) and the
 * colon required. The parentheses may nest, which no regular expression can read to the matching close, so the
 * line is walked: `- **Why not**（一覧を提出の増分（publish）にする）: …` is one field, not the continuation of the
 * field above it. Null when the line is not a field (an unbalanced parenthetical included).
 */
function parseFieldLine(line: string): { name: string; body: string } | null {
  const head = /^-\s+\*\*([^*]+?)\*\*/.exec(line);
  if (!head) return null;
  let name = head[1].trim();
  const skip = (from: number): number => from + (/^\s*/.exec(line.slice(from))?.[0].length ?? 0);
  let at = skip(head[0].length);
  const open = line[at];
  if (open === "（" || open === "(") {
    const close = open === "（" ? "）" : ")";
    let depth = 0;
    let end = -1;
    for (let i = at; i < line.length; i += 1) {
      const c = line[i];
      if (c === open) depth += 1;
      else if (c === close) { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    name = `${name}${line.slice(at, end + 1).trim()}`;
    at = skip(end + 1);
  }
  if (line[at] !== ":" && line[at] !== "：") return null;
  return { name, body: line.slice(at + 1).replace(/^\s/, "") };
}

/** the fields of one section body: a field runs until the next field line, continuation lines kept */
function fieldsOf(lines: string[]): LegacyField[] {
  const out: LegacyField[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const f = parseFieldLine(lines[i]);
    if (!f) continue;
    const { name } = f;
    const body = [f.body];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      // a field ends at the next field, the next heading, or an INV record line: an INV sits after the fields,
      // and folding its backticked words into the Anchors body would hang its identifiers on the last path
      if (parseFieldLine(lines[j]) || ANY_HEADING.test(lines[j]) || INV_LINE.test(lines[j])) break;
      body.push(lines[j]);
    }
    while (body.length && body[body.length - 1].trim() === "") body.pop();
    out.push({ name, body: body.join("\n") });
    i = j - 1;
  }
  return out;
}

/** the sections of one document, each with its heading and its field lines */
function sectionsOf(text: string): { id: string; title: string; lines: string[] }[] {
  const lines = text.split("\n");
  const heads: { id: string; title: string; at: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const h = decisionHeading(lines[i]);
    if (h) heads.push({ id: h.id, title: h.title, at: i });
  }
  return heads.map((h) => {
    let end = lines.length;
    for (let i = h.at + 1; i < lines.length; i += 1) {
      if (ANY_HEADING.test(lines[i])) { end = i; break; }
    }
    return { id: h.id, title: h.title, lines: lines.slice(h.at + 1, end) };
  });
}

/** the parent DEC an INV's parenthetical names, or null */
function invFrom(paren: string | undefined): string | null {
  if (!paren) return null;
  const m = /from\s+(DEC-[\w.-]+)/.exec(paren);
  return m ? m[1] : null;
}

/** the Places the index read from an Anchors value, with each path's symbols from the words that follow it */
function placesWithSymbols(parsed: ParsedDecision, raw: string | null, root: string): Place[] {
  const paths = [...new Set(parsed.places)];
  const symbols = new Map<string, string[]>();
  let current: string | null = null;
  for (const token of backquotes(raw ?? "")) {
    const path = placeOf(token, root);
    if (path) {
      current = path;
      if (!symbols.has(path)) symbols.set(path, []);
      continue;
    }
    if (current && IDENT.test(token)) symbols.get(current)?.push(token);
  }
  return paths.flatMap((path) => {
    const syms = [...new Set(symbols.get(path) ?? [])];
    const one = normalizePlace({ path, kind: path.endsWith("/") ? "dir" : "file", ...(syms.length ? { symbols: syms } : {}) });
    return one.ok ? [one.value] : [];
  });
}

/** the paths a broken Anchors value names, after dropping parentheses and splitting on the separators seen in the docs */
function repairedAnchors(raw: string | null, root: string): Place[] {
  if (raw === null) return [];
  const stripped = raw.replace(/（[^）]*）|\([^)]*\)/g, " ").replace(/`/g, " ");
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const word of stripped.split(/[、,・\s]+/)) {
    const path = placeOf(word.trim(), root);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const one = normalizePlace({ path, kind: path.endsWith("/") ? "dir" : "file" });
    if (one.ok) out.push(one.value);
  }
  return out;
}

/** the Anchors of one DEC: the index's reading first, then the repair, then root, with how it was read */
function resolveAnchors(parsed: ParsedDecision, raw: string | null, root: string): { places: Place[]; note: AnchorsNote } {
  const read = placesWithSymbols(parsed, raw, root);
  if (read.length) return { places: read, note: "read" };
  if (raw !== null && anchorsNoneOf(raw)) return { places: [ROOT], note: "none" };
  const repaired = repairedAnchors(raw, root);
  if (repaired.length) return { places: repaired, note: "fixed" };
  return { places: [ROOT], note: "unreadable" };
}

/** one DEC section and every field it carries, from the index's parse and this module's field reading */
function legacyDec(doc: DecisionDoc, parsed: ParsedDecision, root: string): LegacyDec {
  const fields = fieldsOf(sectionsOf(doc.text).find((s) => s.id === parsed.id)?.lines ?? []);
  const first = (name: string): LegacyField | undefined => fields.find((f) => f.name === name);
  const isWhyNot = (f: LegacyField): boolean => f.name === "Why not" || /^Why not\s*[（(]/.test(f.name);
  const canonical = new Set<string>();
  const extra: LegacyField[] = [];
  for (const f of fields) {
    if (isWhyNot(f)) continue;
    if (CANONICAL.includes(f.name) && !canonical.has(f.name)) { canonical.add(f.name); continue; }
    extra.push(f);
  }
  const { places, note } = resolveAnchors(parsed, first("Anchors")?.body ?? null, root);
  const created = documentCreatedAt(doc.text);
  return {
    id: parsed.id,
    doc: doc.doc,
    title: parsed.title,
    ...(created ? { created } : {}),
    what: first("What")?.body ?? "",
    why: first("Why")?.body ?? "",
    ...(first("Change freedom") ? { free: first("Change freedom")?.body } : {}),
    ...(first("Revisit when") ? { revisit: first("Revisit when")?.body } : {}),
    ...(first("Source") ? { source: first("Source")?.body } : {}),
    anchors: places,
    anchorsNote: note,
    supersededBy: parsed.supersededBy,
    hasSuperseded: first("Superseded by") !== undefined || parsed.supersededBy.length > 0,
    whyNots: fields.filter(isWhyNot),
    extra,
    invs: [],
  };
}

/**
 * Every DEC of every decision document under the root, plus the INV lines whose parent DEC no document holds.
 * The PiWebInherited documents are read the same way: they govern files of this same tree, so their records move
 * into this repo's column too.
 */
export function readLegacyRecords(opts: { root: string }): LegacyRecords {
  const decs: LegacyDec[] = [];
  const invs: LegacyInv[] = [];
  for (const doc of readDecisionDocs({ root: opts.root })) {
    const parsed = parseDecisionDoc(doc.doc, doc.text, opts.root);
    const created = documentCreatedAt(doc.text);
    // one LegacyDec per heading: a repeated heading stays two entries, for the plan to report as a duplicate
    for (const p of parsed) decs.push(legacyDec(doc, p, opts.root));
    for (const line of doc.text.split("\n")) {
      const m = INV_LINE.exec(line);
      if (!m) continue;
      invs.push({ id: m[1], text: m[3], from: invFrom(m[2]), doc: doc.doc, ...(created ? { created } : {}) });
    }
  }
  const decIds = new Set(decs.map((d) => d.id));
  for (const inv of invs) {
    if (inv.from !== null && decIds.has(inv.from)) {
      const parent = decs.find((d) => d.id === inv.from);
      parent?.invs.push(inv);
    }
  }
  const orphanInvs = invs.filter((inv) => inv.from === null || !decIds.has(inv.from));
  return { decs, orphanInvs };
}

/** one Purpose the migration raises, as the caller's list carries it */
export interface PurposeSeed {
  id: string;
  name: string;
  statement: string;
  origin: string;
}

/** one entry of the person's review of a DEC */
export interface ReviewEntry {
  alive: string;
  purpose?: string;
  rejected?: { mode: string; note?: string };
}

export type ConvertOp =
  | { type: "raise_purpose"; id: string; name: string; statement: string; origin: string }
  | { type: "raise_choice"; id: string; body: ChoiceBody }
  | { type: "supersede"; id: string; ids: string[]; grounds: string; body: ChoiceBody }
  | { type: "drop_choice"; id: string; grounds: string };

/** a condition that stops the whole run: a record whose Purpose or body cannot be settled before writing */
export interface Blocker {
  reason: string;
  ids: string[];
}

export interface ConversionReport {
  /** the DEC headings read, blocked ones included */
  decs: number;
  purposes: number;
  /** the DECs that become a Choice, by the status they are raised with */
  choices: { unconfirmed: number; active: number; dropped: number };
  /** INV lines folded into their parent DEC's anchored */
  invs_folded: number;
  /** INV lines whose parent DEC no document holds */
  invs_orphan: number;
  no_why_not: number;
  /** the successor and the DECs it replaces */
  superseded: { successor: string; ids: string[] }[];
  /** DECs whose Superseded by names nothing the documents hold */
  successor_missing: string[];
  /** the second and later successors a Superseded by names */
  successor_extra: string[];
  /** the supersedes not attached because the review drops the DEC they would replace, by successor */
  successor_dropped: { successor: string; ids: string[] }[];
  /** the supersedes dropped to break a cycle */
  cycles: string[];
  /** DECs whose broken Anchors were repaired */
  anchors_fixed: string[];
  /** DECs left at root because no path could be read */
  anchors_unreadable: string[];
  /** DECs left at root because their Anchors say None (or there is no field) */
  anchors_none: string[];
  /** ids in the assignment or the review that no document holds */
  assignment_extra: string[];
}

export interface ConversionPlan {
  blocked: boolean;
  blockers: Blocker[];
  ops: ConvertOp[];
  report: ConversionReport;
}

export interface PlanInput {
  records: LegacyRecords;
  purposes: PurposeSeed[];
  assignment: Record<string, string>;
  review?: Record<string, ReviewEntry>;
  /** whether a path is a directory on the tree; without it every readable path is a file */
  isDir?: (path: string) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** the first sentence of a Why not body: up to the first `。` or ` — ` */
function firstSentenceOf(text: string): string {
  const dot = text.indexOf("。");
  const dash = text.indexOf(" — ");
  let cut = -1;
  if (dot >= 0) cut = dot + 1;
  if (dash >= 0 && (cut < 0 || dash < cut)) cut = dash;
  return cut >= 0 ? text.slice(0, cut).trim() : text;
}

/** the inner text of a parenthetical a Why not's name ends with, or null; the parentheses may nest, like the field line */
function parenTailOf(name: string): string | null {
  const head = /^Why not\s*/.exec(name);
  if (!head) return null;
  const rest = name.slice(head[0].length);
  const open = rest[0];
  if (open !== "（" && open !== "(") return null;
  const close = open === "（" ? "）" : ")";
  let depth = 0;
  let end = -1;
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i];
    if (c === open) depth += 1;
    else if (c === close) { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end !== rest.length - 1) return null;
  const inner = rest.slice(1, end).trim();
  return inner || null;
}

/** one Why not field as a rejected form */
function rejectedOf(field: LegacyField): { form: string; fails_because: string } {
  const form = parenTailOf(field.name) ?? firstSentenceOf(field.body);
  return { form: form || firstSentenceOf(field.body), fails_because: field.body };
}

/** the body of a DEC's Choice, before the plan decides its status and migration mark */
function decChoiceBody(dec: LegacyDec, purpose: string, status: RaisedChoiceStatus, purposeFrom: "移行時の割り当て" | "人の見直し"): ChoiceBody {
  const whyFields = dec.extra.filter((f) => f.name.startsWith("Why"));
  const anchoredFields = dec.extra.filter((f) => !f.name.startsWith("Why"));
  const why = [dec.why, ...whyFields.map((f) => `${f.name}: ${f.body}`)].join("\n\n");
  const anchored = [
    `What: ${dec.what}`,
    ...anchoredFields.map((f) => `${f.name}: ${f.body}`),
    ...dec.invs.map((inv) => `${inv.id}: ${inv.text}`),
  ].join("\n\n");
  const rejected = dec.whyNots.map(rejectedOf);
  return {
    purpose,
    id: dec.id,
    forms: { chosen: dec.title, rejected },
    place: dec.anchors,
    why,
    anchored,
    visibility: "private",
    status,
    ...(dec.free ? { free: dec.free } : {}),
    ...(dec.revisit ? { revisit: dec.revisit } : {}),
    ...(rejected.length === 0 ? { no_why_not: "移行: 元の DEC に Why not の欄が無い" } : {}),
    migration: {
      doc: dec.doc,
      purpose_from: purposeFrom,
      ...(dec.source ? { source: dec.source } : {}),
      ...(dec.created ? { created: dec.created } : {}),
    },
  };
}

/** the body of a parentless INV's Choice: its text stands as both the chosen form and the anchor */
function orphanInvBody(inv: LegacyInv, purpose: string): ChoiceBody {
  return {
    purpose,
    id: inv.id,
    forms: { chosen: inv.text, rejected: [] },
    place: [ROOT],
    why: "移行: 親の DEC が無い INV。Why は元の記録に無い",
    anchored: inv.text,
    visibility: "private",
    status: "unconfirmed",
    no_why_not: "移行: 元の DEC に Why not の欄が無い",
    migration: { doc: inv.doc, purpose_from: "移行時の割り当て", ...(inv.created ? { created: inv.created } : {}) },
  };
}

/** a Place whose marked file the caller's tree knows as a directory becomes that dir's own module, with no mark */
function withDir(place: Place, isDir?: (path: string) => boolean): Place {
  if (!isDir || !place.file || !isDir(place.file)) return place;
  const one = normalizePlace({ path: `${place.file}/`, kind: "dir" });
  return one.ok ? one.value : place;
}

/**
 * The whole plan, built before anything is written: the Purpose raises, the Choice raises (supersedes attached to
 * the successor), and the drops. A record whose Purpose cannot be settled goes into `blockers` instead of the op
 * list, and one blocker stops the whole run; the other records' ops are still built so a dry run shows everything.
 */
export function planConversion(input: PlanInput): ConversionPlan {
  const blockers = new Map<string, Set<string>>();
  const addBlocker = (reason: string, id: string): void => {
    const set = blockers.get(reason) ?? new Set<string>();
    set.add(id);
    blockers.set(reason, set);
  };
  const report: ConversionReport = {
    decs: input.records.decs.length,
    purposes: input.purposes.length,
    choices: { unconfirmed: 0, active: 0, dropped: 0 },
    invs_folded: 0,
    invs_orphan: input.records.orphanInvs.length,
    no_why_not: 0,
    superseded: [],
    successor_missing: [],
    successor_extra: [],
    successor_dropped: [],
    cycles: [],
    anchors_fixed: [],
    anchors_unreadable: [],
    anchors_none: [],
    assignment_extra: [],
  };

  // --- the Purpose list ---
  const purposeById = new Map<string, PurposeSeed>();
  const seenPurpose = new Set<string>();
  for (const raw of input.purposes as unknown[]) {
    const p = isRecord(raw) ? raw : null;
    const id = p ? nonEmpty(p.id) : null;
    const label = id ?? "(欄の欠けた Purpose)";
    if (!p || !id || !nonEmpty(p.name) || !nonEmpty(p.statement) || !nonEmpty(p.origin)) {
      addBlocker("bad_purpose_entry", label);
      continue;
    }
    if (!/^P-\d+$/.test(id) || seenPurpose.has(id)) {
      addBlocker("bad_purpose_entry", id);
      continue;
    }
    seenPurpose.add(id);
    purposeById.set(id, { id, name: String(p.name).trim(), statement: String(p.statement).trim(), origin: String(p.origin).trim() });
  }

  // --- duplicate ids among the records ---
  const decCount = new Map<string, number>();
  for (const dec of input.records.decs) decCount.set(dec.id, (decCount.get(dec.id) ?? 0) + 1);
  const duplicateDecs = new Set([...decCount].filter(([, n]) => n > 1).map(([id]) => id));
  const orphanCount = new Map<string, number>();
  for (const inv of input.records.orphanInvs) orphanCount.set(inv.id, (orphanCount.get(inv.id) ?? 0) + 1);
  const documentIds = new Set([...decCount.keys(), ...orphanCount.keys()]);
  for (const id of duplicateDecs) addBlocker("duplicate_id", id);
  for (const [id, n] of orphanCount) {
    if (n > 1 || decCount.has(id)) addBlocker("duplicate_id", id);
  }
  const duplicateOrphanInvs = new Set([...orphanCount.keys()].filter((id) => duplicateDecs.has(id) || (orphanCount.get(id) ?? 0) > 1));

  // --- ids the caller's tables name that no document holds ---
  const extras = new Set<string>();
  for (const id of Object.keys(input.assignment)) if (!documentIds.has(id)) extras.add(id);
  for (const id of Object.keys(input.review ?? {})) if (!documentIds.has(id)) extras.add(id);
  report.assignment_extra = [...extras].sort(compareIds);

  // --- the review's own values ---
  const review = input.review ?? {};
  for (const [id, raw] of Object.entries(review)) {
    if (!documentIds.has(id)) continue;
    const entry = isRecord(raw) ? (raw as ReviewEntry) : null;
    if (!entry) { addBlocker("unknown_review_value", id); continue; }
    if (entry.alive !== "alive" && entry.alive !== "dead") addBlocker("unknown_review_value", id);
    const mode = entry.rejected?.mode;
    if (entry.rejected && mode !== "keep" && mode !== "none") addBlocker("unknown_review_value", id);
  }

  /** the Purpose a record settles on: the review's own when it names one, else the assignment */
  const purposeFor = (id: string): { purpose: string | null; fromReview: boolean } => {
    const entry = review[id];
    const reviewed = entry ? nonEmpty(entry.purpose) : null;
    if (reviewed && reviewed !== "__undecided__") return { purpose: reviewed, fromReview: true };
    const assigned = nonEmpty(input.assignment[id]);
    return { purpose: assigned, fromReview: false };
  };

  // --- each DEC's body, status and predecessors ---
  interface DecEntry {
    id: string;
    body: ChoiceBody;
    drop: boolean;
    /** the DEC ids this entry replaces, empty when it is a plain raise */
    preds: string[];
  }
  const entries = new Map<string, DecEntry>();
  const allDocIds = documentIds;
  for (const dec of input.records.decs) {
    if (duplicateDecs.has(dec.id)) continue;
    const rawEntry = review[dec.id];
    const entry = isRecord(rawEntry) ? (rawEntry as ReviewEntry) : undefined;
    // a malformed review entry is a blocker: the record neither gets an op nor a silent unconfirmed status
    if (rawEntry !== undefined && !entry) continue;
    if (entry && (entry.alive !== "alive" && entry.alive !== "dead")) continue;
    if (entry?.rejected && entry.rejected.mode !== "keep" && entry.rejected.mode !== "none") continue;
    const { purpose, fromReview } = purposeFor(dec.id);
    if (!purpose) { addBlocker("missing_assignment", dec.id); continue; }
    if (!purposeById.has(purpose)) { addBlocker("unknown_purpose", dec.id); continue; }
    const status: RaisedChoiceStatus = entry?.alive === "alive" && fromReview ? "active" : "unconfirmed";
    const body = decChoiceBody(
      { ...dec, anchors: dec.anchors.map((p) => withDir(p, input.isDir)) },
      purpose,
      status,
      fromReview ? "人の見直し" : "移行時の割り当て",
    );
    const checked = normalizeChoiceBody(body);
    if (!checked.ok) { addBlocker("invalid_body", dec.id); continue; }
    const value = checked.value;
    if (value.forms.rejected.length === 0) report.no_why_not += 1;
    if (entry?.alive === "dead") report.choices.dropped += 1;
    else if (status === "active") report.choices.active += 1;
    else report.choices.unconfirmed += 1;
    entries.set(dec.id, { id: dec.id, body: value, drop: entry?.alive === "dead", preds: [] });
  }

  // --- the supersedes, resolved against the documents ---
  const pendingPreds = new Map<string, string[]>();
  for (const dec of input.records.decs) {
    const entry = entries.get(dec.id);
    if (!entry || (!dec.hasSuperseded && dec.supersededBy.length === 0)) continue;
    const named = [...new Set(dec.supersededBy)];
    const present = named.filter((id) => allDocIds.has(id));
    if (present.length === 0) { report.successor_missing.push(dec.id); continue; }
    for (const extra of present.slice(1)) if (!report.successor_extra.includes(extra)) report.successor_extra.push(extra);
    const successor = present.find((id) => entries.has(id));
    if (!successor) { report.successor_missing.push(dec.id); continue; }
    // a DEC the review saw as dead is raised and then dropped, and the door takes a supersede only while the
    // replaced Choice is still active or unconfirmed. Attaching the supersede would have the run refused right
    // after the drop, with the column half written; the drop wins and the skipped link is reported
    if (entry.drop) {
      const skipped = report.successor_dropped.find((s) => s.successor === successor);
      if (skipped) skipped.ids.push(dec.id);
      else report.successor_dropped.push({ successor, ids: [dec.id] });
      continue;
    }
    const list = pendingPreds.get(successor) ?? [];
    list.push(dec.id);
    pendingPreds.set(successor, list);
  }

  // --- a raise order that puts every replaced DEC before its successor ---
  const ordered: string[] = [];
  const placed = new Set<string>();
  const remaining = input.records.decs.map((d) => d.id).filter((id) => entries.has(id) && !placed.has(id));
  while (remaining.length) {
    const readyAt = remaining.findIndex((id) => (pendingPreds.get(id) ?? []).every((p) => placed.has(p)));
    if (readyAt >= 0) {
      const id = remaining.splice(readyAt, 1)[0];
      ordered.push(id);
      placed.add(id);
      continue;
    }
    // a cycle: raise the first of it plainly, dropping the supersedes it cannot attach
    const id = remaining.shift() as string;
    for (const p of pendingPreds.get(id) ?? []) {
      if (!placed.has(p)) report.cycles.push(`${id} -> ${p}`);
    }
    pendingPreds.set(id, (pendingPreds.get(id) ?? []).filter((p) => placed.has(p)));
    ordered.push(id);
    placed.add(id);
  }

  // --- the operation list: Purposes, Choices (supersedes attached), drops, then parentless INVs ---
  const ops: ConvertOp[] = [];
  for (const p of [...purposeById.values()].sort((a, b) => compareIds(a.id, b.id))) {
    ops.push({ type: "raise_purpose", id: p.id, name: p.name, statement: p.statement, origin: p.origin });
  }
  for (const id of ordered) {
    const entry = entries.get(id) as DecEntry;
    const preds = pendingPreds.get(id) ?? [];
    if (preds.length) {
      ops.push({ type: "supersede", id, ids: preds, grounds: "移行: 元の DEC の Superseded by の欄", body: entry.body });
      report.superseded.push({ successor: id, ids: preds });
    } else {
      ops.push({ type: "raise_choice", id, body: entry.body });
    }
    if (entry.drop) {
      const note = review[id]?.rejected?.note;
      ops.push({ type: "drop_choice", id, grounds: `移行: 人の見直しで死んでいると判断した${note ? ` — ${note}` : ""}` });
    }
  }
  for (const inv of [...input.records.orphanInvs].sort((a, b) => compareIds(a.id, b.id))) {
    if (duplicateOrphanInvs.has(inv.id)) continue;
    const purpose = nonEmpty(input.assignment[inv.id]);
    if (!purpose) { addBlocker("missing_assignment", inv.id); continue; }
    if (!purposeById.has(purpose)) { addBlocker("unknown_purpose", inv.id); continue; }
    const checked = normalizeChoiceBody(orphanInvBody(inv, purpose));
    if (!checked.ok) { addBlocker("invalid_body", inv.id); continue; }
    report.no_why_not += 1;
    ops.push({ type: "raise_choice", id: inv.id, body: checked.value });
  }

  // --- the Anchors and folded INV reports ---
  for (const dec of input.records.decs) {
    if (dec.anchorsNote === "fixed") report.anchors_fixed.push(dec.id);
    else if (dec.anchorsNote === "unreadable") report.anchors_unreadable.push(dec.id);
    else if (dec.anchorsNote === "none") report.anchors_none.push(dec.id);
  }
  report.invs_folded = input.records.decs.reduce((n, d) => n + d.invs.length, 0);

  const blockerList: Blocker[] = [...blockers].map(([reason, ids]) => ({ reason, ids: [...ids].sort(compareIds) }));
  return { blocked: blockerList.length > 0, blockers: blockerList, ops, report };
}

/** the state the read door hands back: the folded Purposes and Choices */
export interface StateRecords {
  purposes: PurposeView[];
  choices: ChoiceView[];
}

/**
 * One supersede the plan would attach but the state does not take: the replaced Choice is already superseded or
 * dropped there, and the door accepts a replacement only while the replaced Choice is active or unconfirmed. Sending
 * it would stop the run half written, so the pair is left out and reported for a person to settle.
 */
export interface SkippedSupersede {
  /** the Choice the document would have replaced */
  id: string;
  /** the state's own status for it: superseded or dropped */
  status: ChoiceStatus;
  /** the successor the state already holds (absent when the Choice was dropped, which has no successor) */
  state_successor?: string;
  /** the successor the document names */
  document_successor: string;
}

export interface PendingResult {
  blocked: boolean;
  blockers: Blocker[];
  /** the ops that are still missing from the state, in plan order */
  ops: ConvertOp[];
  /** ids a record already holds with a body other than the plan's (the run leaves them alone) */
  differing: string[];
  /** the supersedes these ops carry, with the pairs the state no longer takes taken out */
  superseded: { successor: string; ids: string[] }[];
  /** the pairs left out because the state has already settled the replaced Choice */
  supersede_skipped: SkippedSupersede[];
}

/** whether the state's readable body differs from the plan's: status and history are the state's own */
function bodyDiffers(body: ChoiceBody, c: ChoiceView): boolean {
  if (body.purpose !== c.purpose) return true;
  if (body.forms.chosen !== c.forms.chosen) return true;
  if (JSON.stringify(body.forms.rejected) !== JSON.stringify(c.forms.rejected)) return true;
  if (JSON.stringify(body.place) !== JSON.stringify(c.place)) return true;
  if (body.why !== c.why) return true;
  if (body.anchored !== c.anchored) return true;
  if ((body.free ?? FREE_WHILE_WHY) !== c.free) return true;
  if ((body.revisit ?? undefined) !== c.revisit) return true;
  return false;
}

/**
 * The plan against the state: the ops the column does not hold yet. An id that is already there is not written
 * again — that is what makes a rerun of the same input add no row, and what lets a run that stopped
 * halfway be sent again from where it stopped. A Purpose that is already there under another statement, or that
 * is not active, is a blocker instead: the Choices chained to it would take on a meaning no one chose. A body that
 * differs only in a lane's later work is left as it is and reported.
 *
 * A supersede whose replaced Choice the state has already settled (superseded or dropped) is not sent either: the
 * door takes a replacement only while the replaced Choice is active or unconfirmed, so the run would be refused and
 * stop half written. The pair is left off and reported instead, and a successor whose every replaced Choice is
 * settled stands without a replacement.
 */
export function pendingOps(input: { plan: ConversionPlan; state: StateRecords }): PendingResult {
  const purposesById = new Map(input.state.purposes.map((p) => [p.id, p]));
  const choicesById = new Map(input.state.choices.map((c) => [c.id, c]));
  const blockers = new Map<string, Set<string>>();
  const addBlocker = (reason: string, id: string): void => {
    const set = blockers.get(reason) ?? new Set<string>();
    set.add(id);
    blockers.set(reason, set);
  };
  const ops: ConvertOp[] = [];
  const differing: string[] = [];
  const superseded: { successor: string; ids: string[] }[] = [];
  const supersedeSkipped: SkippedSupersede[] = [];

  for (const op of input.plan.ops) {
    if (op.type === "raise_purpose") {
      const p = purposesById.get(op.id);
      if (!p) { ops.push(op); continue; }
      if (p.statement !== op.statement) { addBlocker("state_purpose_conflict", op.id); continue; }
      if (p.status !== "active") { addBlocker("state_purpose_conflict", op.id); continue; }
      if (p.name !== op.name || p.origin !== op.origin) differing.push(op.id);
      continue;
    }
    if (op.type === "raise_choice" || op.type === "supersede") {
      const c = choicesById.get(op.id);
      if (!c) {
        if (op.type === "raise_choice") { ops.push(op); continue; }
        // a supersede whose replaced Choice the state has settled is dropped from the call, id by id: the replaced
        // side is off the state's reading already, so sending the link would change nothing and only be refused
        const usable: string[] = [];
        for (const oldId of op.ids) {
          const old = choicesById.get(oldId);
          if (!old || old.status === "active" || old.status === "unconfirmed") { usable.push(oldId); continue; }
          const stateSuccessor = old.history.reduce<string | undefined>((found, h) => (h.event === "superseded" ? h.successor : found), undefined);
          supersedeSkipped.push({
            id: oldId,
            status: old.status,
            ...(stateSuccessor ? { state_successor: stateSuccessor } : {}),
            document_successor: op.id,
          });
        }
        if (usable.length) {
          ops.push({ ...op, ids: usable });
          superseded.push({ successor: op.id, ids: usable });
        } else {
          // every replaced Choice is settled: the successor stands as a plain raise, keeping its status from the plan
          ops.push({ type: "raise_choice", id: op.id, body: op.body });
        }
        continue;
      }
      if (bodyDiffers(op.body, c)) differing.push(op.id);
      continue;
    }
    const c = choicesById.get(op.id);
    if (!c) { ops.push(op); continue; }
    // the raise is already in the column: only the drop is left, and only while the Choice is still unconfirmed
    if (c.status === "unconfirmed") ops.push(op);
  }

  const planBlockers = new Map(input.plan.blockers.map((b) => [b.reason, new Set(b.ids)]));
  for (const [reason, ids] of blockers) {
    const set = planBlockers.get(reason) ?? new Set<string>();
    for (const id of ids) set.add(id);
    planBlockers.set(reason, set);
  }
  const blockerList: Blocker[] = [...planBlockers].map(([reason, ids]) => ({ reason, ids: [...ids].sort(compareIds) }));
  supersedeSkipped.sort((a, b) => compareIds(a.document_successor, b.document_successor) || compareIds(a.id, b.id));
  return {
    blocked: blockerList.length > 0,
    blockers: blockerList,
    ops,
    differing: [...new Set(differing)].sort(compareIds),
    superseded,
    supersede_skipped: supersedeSkipped,
  };
}
