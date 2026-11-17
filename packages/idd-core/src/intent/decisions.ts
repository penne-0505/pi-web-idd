import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { placeMatches, placeOf } from "./places.ts";

/**
 * Where the records are read from. A worktree is read off the disk; a lane whose worktree was retired is read from
 * the rev it left behind, so what the lane committed stays readable. Unreadable sources (no worktree, a rev git
 * does not know, a directory that is not a repo) answer empty rather than throwing: the index is an aid, and a
 * record it cannot read must not hold a report or a review.
 */
export type DecisionSource = { root: string } | { repo: string; ref: string };

export interface DecisionDoc {
  /** repo-relative path of the document, as `_docs/intent/<area>/<slug>/decision.md` */
  doc: string;
  text: string;
}

export interface ParsedDecision {
  id: string;
  title: string;
  /** the paths (places) the Anchors of this DEC name */
  places: string[];
  /** the first sentence of the Why, `""` when the DEC carries none */
  why: string;
  /** the DEC numbers a `Superseded by` field names at its head; empty when it names none or has no field */
  supersededBy: string[];
  /** whether the DEC carries an Anchors field at all */
  hasAnchors: boolean;
  /** the Anchors field says None: the DEC governs no file on purpose */
  anchorsNone: boolean;
}

export interface DecisionCandidate {
  id: string;
  title: string;
  /** the first sentence of the DEC's Why */
  why: string;
  doc: string;
  /** the queried paths this DEC's Anchors matched */
  files: string[];
}

export interface DecisionIndexResult {
  /** the number of candidates, always: 0 when nothing matched or the records could not be read */
  count: number;
  /** how many otherwise-matching DECs a `Superseded by` field kept out of the candidates */
  dropped: number;
  candidates: DecisionCandidate[];
}

const DEC_H3 = /^###\s+(DEC-[\w.-]+):\s*(.+?)\s*$/;
const DEC_H2 = /^##\s+(DEC-[\w.-]+)\s*[—–:-]\s*(.+?)\s*$/;

/**
 * The heading of one DEC, in the two forms the repo writes (`### DEC-x: title`, or `## DEC-x — title`). The one
 * reader of a heading: the index and the migration both go through it, so a DEC the index can find is a DEC the
 * migration reads as the same section. Null when the line is no heading.
 */
export function decisionHeading(line: string): { id: string; title: string } | null {
  const m = line.match(DEC_H3) ?? line.match(DEC_H2);
  return m ? { id: m[1], title: m[2].trim() } : null;
}

/** one whole DEC identifier in any of the three forms, at the head of a value */
const RECORD_AT_HEAD =
  /^(DEC-(?:\d+(?:-[1-9]\d*)?|[A-Za-z][A-Za-z0-9_-]*-[1-9]\d*))(?![\w.-])/;
const HEADING = /^#{1,6}\s/;
// 欄は行頭の `- **Name**:` だけを読む。語の有無で判定すると、Anchors の値や字下げした項目に
// `**Why**` を含む行が Why 欄と誤読され、Anchors が読まれないままこの DEC が索引から消える。
// 記録検査の `readDecisionFields` (`scripts/intent-readings.ts`) と同じ字面を読む。
const ANCHORS_FIELD = /^-\s+\*\*Anchors\*\*:\s*(.*)$/;
const WHY_FIELD = /^-\s+\*\*Why\*\*:\s*(.*)$/;
const SUPERSEDED_FIELD = /^-\s+\*\*Superseded by\*\*:\s*(.*)$/;
/** a field line as `parseIntent`'s `fieldOf` reads one: the bold name, an optional `（…）`, then a colon */
const FIELD = /^-\s+\*\*([^*]+?)\*\*(?:（[^）]*）|\([^)]*\))?\s*[:：]\s?(.*)$/;
/** one whole DEC identifier in any of the three forms, at the head of a value */
const INV_LINE = /^-\s+(INV-[\w.-]+)\s*\(from\s+(DEC-[\w.-]+)\)\s*[:：]\s*(.+?)\s*$/;

function backquoted(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** the first sentence of a Why, the `。` kept; the whole text when it has none */
export function firstSentence(text: string): string {
  const t = text.trim();
  const i = t.indexOf("。");
  return i >= 0 ? t.slice(0, i + 1) : t;
}

/**
 * The DEC identifiers a `Superseded by` value names at its head, separated by `、` or `,`. An identifier is read as
 * one whole word in any of the three forms the repo writes: `DEC-701` (bare), `DEC-088-1` (lane) and
 * `DEC-IddCore-2` (hand-written area). Reading stops at the first token that is not such a word, so prose, an empty
 * value and a malformed identifier all read as no successor at all. A bare identifier is never read out of the head
 * of a longer one (`DEC-088` is not a name of `DEC-088-1`). Those DECs stay in the index: dropping a DEC on a field
 * we could not read would lose a still-binding contract.
 */
export function supersededIdsOf(value: string): string[] {
  const out: string[] = [];
  let rest = value.trim();
  for (;;) {
    const m = RECORD_AT_HEAD.exec(rest);
    if (!m) break;
    out.push(m[1]);
    rest = rest.slice(m[0].length).replace(/^[、,]\s*/, "");
  }
  return out;
}

/** whether an Anchors value is the explicit `None` that says the DEC governs no file (a reason may follow it) */
export function anchorsNoneOf(value: string): boolean {
  const head = value.replace(/（[^）]*）|\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  return /^(None|なし|N\/A)$/i.test(head);
}

/**
 * The DECs of one decision document: the heading (`### DEC-x: title`, or `## DEC-x — title`), the paths of its
 * Anchors, the first sentence of its Why, and the DEC numbers its `Superseded by` field names. The Anchors are read
 * on their own line, or as the indented list that follows it, until the next item of the decision or the next
 * heading. Every path form `placeOf` knows is read the same way here.
 */
export function parseDecisionDoc(doc: string, text: string, root?: string): ParsedDecision[] {
  const out: ParsedDecision[] = [];
  let current: ParsedDecision | null = null;
  let inAnchors = false;
  for (const line of text.split("\n")) {
    const heading = decisionHeading(line);
    if (heading) {
      current = { id: heading.id, title: heading.title, places: [], why: "", supersededBy: [], hasAnchors: false, anchorsNone: false };
      out.push(current);
      inAnchors = false;
      continue;
    }
    if (!current) continue;
    const anchors = ANCHORS_FIELD.exec(line);
    if (anchors) {
      current.hasAnchors = true;
      inAnchors = true;
      if (anchorsNoneOf(anchors[1])) current.anchorsNone = true;
      for (const tok of backquoted(anchors[1])) {
        const p = placeOf(tok, root);
        if (p) current.places.push(p);
      }
      continue;
    }
    const superseded = SUPERSEDED_FIELD.exec(line);
    if (superseded) {
      if (!current.supersededBy.length) current.supersededBy = supersededIdsOf(superseded[1]);
      inAnchors = false;
      continue;
    }
    const why = WHY_FIELD.exec(line);
    if (why) {
      if (!current.why) current.why = firstSentence(why[1]);
      inAnchors = false;
      continue;
    }
    // an Anchors written as an indented list goes on until a line back at the margin or a heading
    if (inAnchors && /^\s+\S/.test(line) && !HEADING.test(line)) {
      for (const tok of backquoted(line)) {
        const p = placeOf(tok, root);
        if (p) current.places.push(p);
      }
      continue;
    }
    inAnchors = false;
  }
  return out;
}

/** one item of a DEC's Why not: the form the decision left out, and why it was left out */
export interface WhyNotEntry {
  /** the name in `（…）` after `Why not`; "" when the field carries none */
  form: string;
  reason: string;
}

/** one invariant a DEC's document ties to it by a `from` field */
export interface DecisionInvariant {
  id: string;
  text: string;
}

/**
 * One decision as the new screen's tab draws it: the same five fields the v2 projection orders, read from the
 * current document. Place is the Anchors value as written, Why the whole field (the index's first-sentence reading
 * stays in `parseDecisionDoc`), Why not each dropped form with its reason, Anchored the document's INV lines that
 * name this DEC in `from`, and Free the Change freedom. What has no place here: the projection carries no field for
 * it, so writing one would leave a column the migration cannot fill.
 */
export interface DecisionFields {
  id: string;
  title: string;
  /** the Anchors value as written, `（）` kept; "" when the DEC has no Anchors field */
  place: string;
  /** the whole Why, continuation lines kept */
  why: string;
  whyNot: WhyNotEntry[];
  anchored: DecisionInvariant[];
  /** the Change freedom as written; "" when the DEC has none */
  free: string;
  /** whether the DEC carries an Anchors field at all */
  hasPlace: boolean;
}

/** the form in the `（…）` between a field's bold name and its colon; "" when the line carries none */
function fieldForm(line: string, name: string): string {
  const nameEnd = line.indexOf(name) + name.length + 2;
  const rest = line.slice(nameEnd);
  const colon = rest.search(/[:：]/);
  const between = colon >= 0 ? rest.slice(0, colon) : rest;
  const m = /^\s*(?:（([^）]*)）|\(([^)]*)\))\s*$/.exec(between);
  return m ? (m[1] ?? m[2] ?? "") : "";
}

/** the value of a field with the given bold name, from its own line until the next field line */
function fieldBody(body: string[], name: string): { found: boolean; form: string; value: string } {
  for (let i = 0; i < body.length; i += 1) {
    const m = FIELD.exec(body[i]);
    if (!m || m[1] !== name) continue;
    const all = [m[2]];
    for (let j = i + 1; j < body.length; j += 1) {
      if (FIELD.test(body[j])) break;
      all.push(body[j]);
    }
    while (all.length && all[all.length - 1].trim() === "") all.pop();
    return { found: true, form: fieldForm(body[i], name), value: all.join("\n").trim() };
  }
  return { found: false, form: "", value: "" };
}

/** every continuation of a repeated field line (a DEC may carry several Why not entries) */
function fieldBodies(body: string[], name: string): { form: string; value: string }[] {
  const out: { form: string; value: string }[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const m = FIELD.exec(body[i]);
    if (!m || m[1] !== name) continue;
    const all = [m[2]];
    for (let j = i + 1; j < body.length; j += 1) {
      if (FIELD.test(body[j])) break;
      all.push(body[j]);
    }
    while (all.length && all[all.length - 1].trim() === "") all.pop();
    out.push({ form: fieldForm(body[i], name), value: all.join("\n").trim() });
  }
  return out;
}

/**
 * One whole decision document as the new screen's tab reads it: each DEC's five fields, in the document's own
 * order. The invariants live in the document's closing section, not inside a DEC, so they are read from the whole
 * text and tied to the DEC named in their `from`. The index's `parseDecisionDoc` is left as it is: its Anchors and
 * Superseded by readings are shared with the records check through the sample table (DEC-9226).
 */
export function parseDecisionFields(text: string): DecisionFields[] {
  const lines = text.split("\n");
  const heads: { id: string; title: string; at: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(DEC_H3) ?? lines[i].match(DEC_H2);
    if (m) heads.push({ id: m[1], title: m[2].trim(), at: i });
  }
  const invariantsOf = new Map<string, DecisionInvariant[]>();
  for (const line of lines) {
    const m = INV_LINE.exec(line);
    if (!m) continue;
    invariantsOf.set(m[2], [...(invariantsOf.get(m[2]) ?? []), { id: m[1], text: m[3] }]);
  }
  return heads.map((h) => {
    let end = lines.length;
    for (let i = h.at + 1; i < lines.length; i += 1) if (HEADING.test(lines[i])) { end = i; break; }
    const body = lines.slice(h.at + 1, end);
    const anchors = fieldBody(body, "Anchors");
    // v1 writes the place as Anchors; a v2-shaped record writes Place. Either is the tab's Place.
    const place = anchors.found ? anchors : fieldBody(body, "Place");
    const why = fieldBody(body, "Why");
    const change = fieldBody(body, "Change freedom");
    // v1 writes the range as Change freedom; a v2-shaped record writes Free. Either is the tab's Free.
    const free = change.found ? change : fieldBody(body, "Free");
    return {
      id: h.id,
      title: h.title,
      place: place.value,
      why: why.value,
      whyNot: fieldBodies(body, "Why not").map((x) => ({ form: x.form, reason: x.value })),
      anchored: invariantsOf.get(h.id) ?? [],
      free: free.value,
      hasPlace: place.found,
    };
  });
}

function underIntent(root: string): string[] {
  return decisionDocsUnder(join(root, "_docs", "intent"), root);
}

/**
 * The decision.md documents a closed lane's move left behind: the same relative path under
 * `_docs/archives/intent/`. A binding contract must not vanish when its document moves, so both the lookup by id
 * and the candidate index read this place too.
 */
function underArchivedIntent(root: string): string[] {
  return decisionDocsUnder(join(root, "_docs", "archives", "intent"), root);
}

function decisionDocsUnder(base: string, root: string): string[] {
  if (!existsSync(base)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && basename(entry.name) === "decision.md") found.push(relative(root, p).split("\\").join("/"));
    }
  };
  walk(base);
  return found.sort();
}

function gitLines(repo: string, args: string[]): string[] | null {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function showFile(repo: string, ref: string, rel: string): string | null {
  try {
    return execFileSync("git", ["-C", repo, "show", `${ref}:${rel}`], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/**
 * Every decision document under `_docs/intent/`, from the worktree or from a rev. Unreadable answers empty: the
 * caller keeps going with 0 candidates. The docs are returned in a stable order (by path), so an index built twice
 * from the same source reads the same.
 */
export function readDecisionDocs(source: DecisionSource): DecisionDoc[] {
  return readDocsAt(source, "_docs/intent");
}

/** the same, for the decision.md documents a closed lane moved under `_docs/archives/intent/` */
export function readArchivedDecisionDocs(source: DecisionSource): DecisionDoc[] {
  return readDocsAt(source, "_docs/archives/intent");
}

function readDocsAt(source: DecisionSource, place: string): DecisionDoc[] {
  if ("root" in source) {
    if (!existsSync(source.root)) return [];
    const docs = place === "_docs/intent" ? underIntent(source.root) : underArchivedIntent(source.root);
    return docs.flatMap((doc) => {
      try {
        return [{ doc, text: readFileSync(join(source.root, doc), "utf8") }];
      } catch {
        return [];
      }
    });
  }
  const listed = gitLines(source.repo, ["ls-tree", "-r", "--name-only", source.ref, "--", place]);
  if (!listed) return [];
  return listed.filter((rel) => basename(rel) === "decision.md").sort().flatMap((doc) => {
    const text = showFile(source.repo, source.ref, doc);
    return text === null ? [] : [{ doc, text }];
  });
}

/** normalize a doc path for comparison: no leading `./`, forward slashes only */
function normDoc(p: string): string {
  return p.replace(/^\.\//, "").split("\\").join("/");
}

/**
 * The DECs whose Anchors hold one of `paths`, read from one source. The live place and the archive are both read,
 * so a contract whose decision.md a closed lane moved still reaches the planner and the engine.
 * Every candidate of every matching DEC is kept: no cap, no recency cut, no symbol narrowing. The judgement of
 * which candidate matters is the reader's. `excludeDocs` drops documents the caller knows are not "existing" for
 * it (the planner's own lane); `excludeIds` drops single DECs.
 */
export function decisionIndex(opts: {
  source: DecisionSource;
  paths: string[];
  /** the root bare file names in Anchors are checked against (a worktree), when one is available */
  root?: string;
  excludeDocs?: string[];
  excludeIds?: string[];
}): DecisionIndexResult {
  const docs = [...readDecisionDocs(opts.source), ...readArchivedDecisionDocs(opts.source)];
  const excludedDocs = new Set((opts.excludeDocs ?? []).map(normDoc));
  const excludedIds = new Set(opts.excludeIds ?? []);
  const wanted = opts.paths.filter(Boolean);
  const candidates: DecisionCandidate[] = [];
  let dropped = 0;
  for (const { doc, text } of docs) {
    if (excludedDocs.has(normDoc(doc))) continue;
    for (const dec of parseDecisionDoc(doc, text, opts.root)) {
      if (excludedIds.has(dec.id)) continue;
      const files = [...new Set(wanted.filter((f) => dec.places.some((p) => placeMatches(f, p))))];
      if (!files.length) continue;
      // a Superseded by field the reader could not turn into a number leaves the DEC in the index (INV-2321):
      // dropping a contract on a field we cannot read loses it silently, which is the harm the field prevents
      if (dec.supersededBy.length) { dropped += 1; continue; }
      candidates.push({ id: dec.id, title: dec.title, why: dec.why, doc, files });
    }
  }
  candidates.sort((a, b) => compareIds(a.id, b.id) || a.id.localeCompare(b.id));
  return { count: candidates.length, dropped, candidates };
}

/**
 * The reading order of the three identifier forms: bare numbers first, then lane identifiers (by lane number, then
 * serial), then hand-written area identifiers (by area name, then serial). A form the reader does not know sorts
 * last, so it cannot displace a known one.
 */
export function compareIds(a: string, b: string): number {
  const ka = sortKeyOf(a);
  const kb = sortKeyOf(b);
  for (let i = 0; i < ka.length; i += 1) {
    const c = ka[i] < kb[i] ? -1 : ka[i] > kb[i] ? 1 : 0;
    if (c) return c;
  }
  return 0;
}

function sortKeyOf(id: string): [number, number, string, number] {
  const rest = id.replace(/^(?:DEC|INV)-/, "");
  const lane = /^(\d+)-([1-9]\d*)$/.exec(rest);
  if (lane) return [1, Number(lane[1]), "", Number(lane[2])];
  const area = /^([A-Za-z][A-Za-z0-9_-]*)-([1-9]\d*)$/.exec(rest);
  if (area) return [2, 0, area[1], Number(area[2])];
  const bare = /^(\d+)$/.exec(rest);
  if (bare) return [0, Number(bare[1]), "", 0];
  return [3, 0, id, 0];
}

/**
 * The paths an Issue's title and body name: every backquoted word that is a place, and, when the text uses none,
 * the whitespace-separated words that carry a slash and read as a path. This is the first pull a planner gets; the
 * survey usually names more, and the planner pulls again with `idd intent decisions`.
 */
export function pathsInText(text: string, root?: string): string[] {
  const out = new Set<string>();
  const add = (tok: string) => {
    const p = placeOf(tok, root);
    if (p) out.add(p);
  };
  for (const m of text.matchAll(/`([^`\n]+)`/g)) add(m[1]);
  if (!out.size) {
    for (const tok of text.split(/\s+/)) if (tok.includes("/")) add(tok.replace(/[),.;:]+$/, ""));
  }
  return [...out].sort();
}

/**
 * The title and document of a DEC by its number, read from the whole record set (every area, every lane, live and
 * archived). The number alone must resolve: a DEC of another lane is defined in that lane's document, which a
 * reader of this lane alone cannot see. Null when no document holds it or the records cannot be read.
 */
export function decisionRecord(source: DecisionSource, id: string, root?: string): { id: string; title: string; doc: string } | null {
  for (const { doc, text } of [...readDecisionDocs(source), ...readArchivedDecisionDocs(source)]) {
    for (const dec of parseDecisionDoc(doc, text, root)) {
      if (dec.id === id) return { id: dec.id, title: dec.title, doc };
    }
  }
  return null;
}

/** the title and document of several DECs, read once; ids that no document holds are absent */
export function decisionRecords(source: DecisionSource, ids: string[], root?: string): Map<string, { title: string; doc: string }> {
  const wanted = new Set(ids);
  const found = new Map<string, { title: string; doc: string }>();
  if (!wanted.size) return found;
  for (const { doc, text } of [...readDecisionDocs(source), ...readArchivedDecisionDocs(source)]) {
    for (const dec of parseDecisionDoc(doc, text, root)) {
      if (wanted.has(dec.id) && !found.has(dec.id)) found.set(dec.id, { title: dec.title, doc });
    }
  }
  return found;
}

/**
 * The files a diff touched, repo-relative, or null when git cannot answer (not a repo, a rev it does not know).
 * Renames are not followed: what matters is the paths the change left behind.
 */
export function diffFilePaths(repo: string, base: string, head: string): string[] | null {
  return gitLines(repo, ["diff", "--name-only", "--no-renames", base, head]);
}

/** one DEC an Anchors audit names, with the kind of reading problem it has */
export interface AnchorsAuditEntry {
  id: string;
  doc: string;
}

/** the Anchors a reader could not turn into a place, and the places that are not in the repo */
export interface AnchorsAudit {
  /** DECs with no Anchors field at all */
  missing: AnchorsAuditEntry[];
  /** DECs whose Anchors names no path and does not say None, so the index silently cannot reach them */
  unreadable: AnchorsAuditEntry[];
  /** read places that do not exist under the root */
  missing_paths: { id: string; doc: string; path: string }[];
}

/**
 * The DECs whose Anchors the index cannot or does not reach, in three kinds, so a reader can find and fix them.
 * `None` is a reading, not a failure: it says the DEC governs no file on purpose. A place is reported as missing
 * only against a worktree root; from a rev there is no disk to check.
 */
export function auditAnchors(source: DecisionSource, root?: string): AnchorsAudit {
  const checkRoot = root ?? ("root" in source ? source.root : undefined);
  const audit: AnchorsAudit = { missing: [], unreadable: [], missing_paths: [] };
  for (const { doc, text } of readDecisionDocs(source)) {
    for (const dec of parseDecisionDoc(doc, text, checkRoot)) {
      if (!dec.hasAnchors) { audit.missing.push({ id: dec.id, doc }); continue; }
      if (!dec.places.length) {
        if (!dec.anchorsNone) audit.unreadable.push({ id: dec.id, doc });
        continue;
      }
      if (!checkRoot) continue;
      for (const p of dec.places) {
        const path = p.replace(/\/$/, "");
        if (path && !existsSync(join(checkRoot, path))) audit.missing_paths.push({ id: dec.id, doc, path: p });
      }
    }
  }
  return audit;
}

/**
 * One candidate as the single line a brief's index prints: number, title, the first sentence of the Why, document,
 * and the matched files.
 */
export function decisionIndexLine(c: DecisionCandidate): string {
  const why = c.why ? ` — ${c.why}` : "";
  return `- ${c.id} ${c.title}${why} — ${c.doc}（${c.files.join(", ")}）`;
}

/** the candidate index as the markdown a brief hands over, with how many superseded DECs it left out */
export function renderDecisionIndex(index: DecisionIndexResult): string {
  const lines: string[] = [];
  if (index.dropped) lines.push(`（置き換え済みの DEC を ${index.dropped} 個外した）`);
  if (!index.candidates.length) {
    lines.push("該当する既存の DEC は無い。Anchors を grep して自分で探してもよい。");
  } else {
    lines.push(...index.candidates.map(decisionIndexLine));
  }
  return lines.join("\n");
}
