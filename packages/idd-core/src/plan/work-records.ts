import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { readProgress } from "../ledger/read.ts";
import { stateDir } from "../paths.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/**
 * The key two reports name the same criterion by. A plan writes `AC-001` and an executor has written `AC-01`, so a
 * plain `AC-<digits>` id is compared by its number; an id of any other shape is compared as written. This is the
 * mainline's normalisation (Issue #110), kept here so every fold of the AC states compares ids the same way.
 */
export function criterionKey(id: string): string {
  const m = /^([A-Za-z]+)-(\d+)$/.exec(id.trim());
  return m ? `${m[1]}-${Number(m[2])}` : id.trim();
}

/** the five words an AC's state can carry */
export type AcStatus = "planned" | "covered" | "verified" | "deferred" | "not-applicable";

/** one AC's current state, folded from a lane's reports */
export interface AcState {
  id: string;
  status: AcStatus;
  evidence?: string;
  reason?: string;
  at?: string;
  /** read from an `s2_result` written before this record existed (the report carried no evidence column) */
  legacy?: true;
}

/** the screen's criteria list: the qa.md statements with the folded state of each */
export function criteriaStates(
  criteria: { id: string; text: string }[],
  states: AcState[],
): { id: string; text: string; state: "done" | "doing" | "todo" }[] {
  const byId = new Map(states.map((s) => [criterionKey(s.id), s]));
  return criteria.map((c) => ({ ...c, state: criterionStateOf(byId.get(criterionKey(c.id)) ?? { id: c.id, status: "planned" }) }));
}

/** one row of a repo's append-only work column */
export interface WorkRow {
  event: string;
  at: string;
  repo: string;
  [key: string]: unknown;
}

/** a report's view of one AC as it was sent */
export interface ReportedItem {
  id: string;
  status: AcStatus;
  evidence?: string;
  reason?: string;
  /** a `verified` the report sent with no evidence, recorded as covered: it does not take back a backed confirmation */
  downgraded?: true;
}

function nowIso(): string {
  return new Date().toISOString();
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** the column for a repo: its own file, named so two keys can never flatten onto one */
export function workColumnPath(repo: string): string {
  return join(stateDir(), `work-${encodeURIComponent(repo)}.jsonl`);
}

export function readWorkRows(path: string): WorkRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try {
        const parsed: unknown = JSON.parse(l);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as WorkRow] : [];
      } catch {
        return [];
      }
    });
}

/**
 * The five words, read from what a report or a row carries. The two words the older CLI sent are read onto the
 * newer ones (`todo` onto planned, `in_progress` onto covered), so a record written before this existed is not lost.
 */
export function normalizeAcStatus(raw: unknown): AcStatus | null {
  const word = text(raw);
  switch (word) {
    case "planned":
    case "todo":
      return "planned";
    case "covered":
    case "in_progress":
      return "covered";
    case "verified":
      return "verified";
    case "deferred":
      return "deferred";
    case "not-applicable":
      return "not-applicable";
    default:
      return null;
  }
}

/** one row's items, read back into reported items; a row without a readable id is skipped */
export function itemsOfRow(row: WorkRow): ReportedItem[] {
  if (!Array.isArray(row.items)) return [];
  return (row.items as unknown[]).flatMap((raw) => {
    if (raw === null || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const id = text(item.id);
    const status = normalizeAcStatus(item.status);
    if (!id || !status) return [];
    return [{
      id,
      status,
      ...(text(item.evidence) ? { evidence: text(item.evidence) as string } : {}),
      ...(text(item.reason) ? { reason: text(item.reason) as string } : {}),
      ...(item.downgraded === true ? { downgraded: true as const } : {}),
    }];
  });
}

/**
 * Fold the `ac_reported` rows of one lane, oldest first, into each AC's current state. A report names a subset:
 * an AC a row does not name keeps the state the row before it left. `before` cuts at a time, so the verification
 * log can ask what a lane had at a stage's own moment without reading rows written later.
 */
export function foldAcRows(rows: WorkRow[], lane: string, before?: string): AcState[] {
  const byId = new Map<string, AcState>();
  for (const row of rows) {
    if (row.event !== "ac_reported") continue;
    if (row.lane !== lane) continue;
    if (row.repo !== undefined && typeof row.repo !== "string") continue;
    if (before && typeof row.at === "string" && row.at > before) continue;
    for (const item of itemsOfRow(row)) {
      const key = criterionKey(item.id);
      const prev = byId.get(key);
      // a `verified` with no evidence is recorded as covered, but a report that merely failed to add evidence does
      // not take back a confirmation an earlier report backed: only an explicit unconfirmed word does (INV-105-1)
      if (item.status === "covered" && item.downgraded && prev && isVerified(prev)) continue;
      byId.set(key, {
        id: item.id,
        status: item.status,
        ...(item.evidence ? { evidence: item.evidence } : {}),
        ...(item.reason ? { reason: item.reason } : {}),
        ...(typeof row.at === "string" ? { at: row.at } : {}),
        ...(prev?.legacy ? { legacy: true as const } : {}),
      });
    }
  }
  return [...byId.values()];
}

/**
 * Fold a lane's `s2_result` records (oldest first) for a lane that has no `ac_reported` row yet: the
 * `qa_verified` list is verified, `qa_unverified` is planned. These carry no evidence column, so a verified
 * read from here is marked `legacy` and is shown as it always was.
 */
export function foldResultEvents(events: LifecycleRecord[], before?: string): AcState[] {
  const byId = new Map<string, AcState>();
  for (const e of events) {
    if (e.event !== "s2_result") continue;
    if (before && e.at > before) continue;
    const verified = Array.isArray(e.attrs?.qa_verified) ? (e.attrs!.qa_verified as unknown[]).map(String) : [];
    const unverified = Array.isArray(e.attrs?.qa_unverified) ? (e.attrs!.qa_unverified as unknown[]).map(String) : [];
    const evidence = e.attrs?.qa_evidence && typeof e.attrs.qa_evidence === "object" ? (e.attrs.qa_evidence as Record<string, unknown>) : {};
    for (const id of verified) {
      const ev = text(evidence[id]);
      byId.set(criterionKey(id), { id, status: "verified", ...(ev ? { evidence: ev } : {}), at: e.at, ...(ev ? {} : { legacy: true as const }) });
    }
    for (const id of unverified) {
      const key = criterionKey(id);
      if (byId.get(key)?.status === "verified") byId.delete(key);
      byId.set(key, { id, status: "planned", at: e.at });
    }
  }
  return [...byId.values()];
}

/** whether a state counts as confirmed: a verified with evidence, or one read from an older result record */
export function isVerified(state: AcState): boolean {
  return state.status === "verified" && (Boolean(state.evidence) || state.legacy === true);
}

/** the screen's three states, from an AC's own state */
export function criterionStateOf(state: AcState): "done" | "doing" | "todo" {
  if (isVerified(state)) return "done";
  if (state.status === "covered") return "doing";
  return "todo";
}

/** every AC of the lane is confirmed, or says it does not apply; no AC at all is not "all confirmed" */
export function allCriteriaVerified(criteria: { id: string }[], states: AcState[]): boolean {
  if (!criteria.length) return false;
  const byId = new Map(states.map((s) => [criterionKey(s.id), s]));
  return criteria.every((c) => {
    const state = byId.get(criterionKey(c.id));
    if (!state) return false;
    return isVerified(state) || state.status === "not-applicable";
  });
}

/**
 * Read a report's items through the evidence rule: a verified with no evidence (blank included) is recorded as
 * covered, and its id is returned so the intake can warn. The report itself is still accepted.
 */
export function normalizeReportedItems(
  input: { id: string; status: string; evidence?: string; reason?: string }[],
): { items: ReportedItem[]; dropped: string[] } {
  const items: ReportedItem[] = [];
  const dropped: string[] = [];
  for (const raw of input) {
    const id = text(raw.id);
    const status = normalizeAcStatus(raw.status);
    if (!id || !status) continue;
    const evidence = text(raw.evidence);
    if (status === "verified" && !evidence) {
      dropped.push(id);
      items.push({ id, status: "covered", downgraded: true });
      continue;
    }
    items.push({ id, status, ...(evidence ? { evidence } : {}), ...(text(raw.reason) ? { reason: text(raw.reason) as string } : {}) });
  }
  return { items, dropped };
}

/** the warning the intake returns when a verified was recorded as covered */
export function evidenceWarning(dropped: string[]): string | undefined {
  if (!dropped.length) return undefined;
  return `evidence の無い verified は確認済みにできないので covered として記録しました: ${dropped.join(", ")}。evidence はテストの名前か、実行した命令と結果を \`--evidence '${dropped[0]}=...'\` の形で添えて送り直してください`;
}

export interface WorkFailure {
  ok: false;
  error: string;
}

/** append one row to a repo's work column, holding the column's lock while it writes */
export async function appendWorkRow(repo: string, row: Omit<WorkRow, "at" | "repo"> & { at?: string }): Promise<{ ok: true } | WorkFailure> {
  if (!text(repo)) return { ok: false, error: "repo が空です" };
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = workColumnPath(repo);
  appendFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 200, minTimeout: 5, maxTimeout: 100, factor: 1 } });
  try {
    appendFileSync(path, `${JSON.stringify({ ...row, at: row.at ?? nowIso(), repo })}\n`, "utf8");
    return { ok: true };
  } finally {
    await release();
  }
}

/**
 * The lane's current AC states: its own reports if it has any, otherwise the older result records and the progress
 * note. Every place that reads which criteria are confirmed goes through here, so the card, the detail, the
 * submit check and the closing record cannot disagree (DEC-105-1, DEC-109-2). `before` cuts the appends at a time;
 * the note is one overwritten moment with no history, so it is read only for the lane's current state.
 */
export function acStatesForLane(input: {
  lane: string;
  rows: WorkRow[];
  events: LifecycleRecord[];
  before?: string;
}): AcState[] {
  const folded = foldAcRows(input.rows, input.lane, input.before);
  if (folded.length) return folded;
  const laneRows = input.rows.some((r) => r.event === "ac_reported" && r.lane === input.lane);
  if (laneRows) return folded;
  const laneEvents = input.events.filter((e) => e.idd_id === input.lane);
  const byKey = new Map(foldResultEvents(laneEvents, input.before).map((s) => [criterionKey(s.id), s]));
  const hasResults = laneEvents.some((e) => e.event === "s2_result" && (!input.before || e.at <= input.before));
  if (!input.before) {
    const note = readProgress(input.lane);
    for (const q of note?.qa_status ?? []) {
      if (!q || typeof q.qa_id !== "string") continue;
      if (q.status === "in_progress" && !byKey.has(criterionKey(q.qa_id))) byKey.set(criterionKey(q.qa_id), { id: q.qa_id, status: "covered" });
    }
    // a verified the note carries is the lane's only confirmation when no result named it
    if (!hasResults) {
      for (const q of note?.qa_status ?? []) {
        if (!q || typeof q.qa_id !== "string" || q.status !== "verified") continue;
        byKey.set(criterionKey(q.qa_id), { id: q.qa_id, status: "verified", legacy: true });
      }
    }
  }
  return [...byKey.values()];
}

export function workRowsOfLane(rows: WorkRow[], lane: string): WorkRow[] {
  return rows.filter((r) => r.lane === lane);
}
