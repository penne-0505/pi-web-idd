/**
 * A Project: a unit larger than an Issue, kept in the same append-only column as the Purposes and the Choices. The
 * state is the rows; everything a reader sees (the list, one Project, the brief of a lane that belongs to it, the
 * copy under `_docs/intent/`) is folded from them here. This file is pure: it reads no file, no clock and no
 * environment, and it never decides who may see a row — the caller hands in the rows one viewer sees (`effectiveRows`
 * in `store.ts`), so a lane's own Project rows reach nobody else before the lane lands.
 *
 * The MoonBit fold does not read these rows: it skips an event it has no reading for, and a Project is no part of
 * what the screens and the write side decide a Choice by. The one rule it shares with this fold — which row a viewer
 * sees — is the single `effectiveRows`.
 */

import type { RejectedForm } from "./records.ts";
import type { IntentRow, Raised } from "./store.ts";

/** Linear's status types: the meaning is taken over, the words are Linear's own */
export type ProjectState = "backlog" | "planned" | "started" | "paused" | "completed" | "canceled";

export const PROJECT_STATES: readonly ProjectState[] = ["backlog", "planned", "started", "paused", "completed", "canceled"];

/** the two states only a person sets: a Project is closed by a person, never by a lane or by the count of closed Issues */
export const PROJECT_CLOSING_STATES: readonly ProjectState[] = ["completed", "canceled"];

export const PROJECT_EVENTS = {
  raised: "project_raised",
  updated: "project_updated",
  decision: "project_decision_set",
  attached: "project_issue_attached",
  detached: "project_issue_detached",
  issueState: "project_issue_state",
  /** the outside's own state of an Issue, as the sync read it (never a person's word, never a lane's) */
  external: "project_issue_external",
} as const;

export function isProjectId(id: string): boolean {
  return /^PRJ-\d+$/.test(id);
}

export function isProjectDecisionId(id: string): boolean {
  return /^PD-\d+-\d+$/.test(id);
}

/** the number a Project id carries (`PRJ-3` is 3) */
export function projectNumber(id: string): number | null {
  const m = /^PRJ-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

export interface ProjectDecisionView {
  id: string;
  /** the chosen form: a line that stays after the decision has moved to a Choice */
  chosen: string;
  /** the reason and the forms thrown away; absent once the decision moved, so the body lives in one place only */
  why?: string;
  rejected?: RejectedForm[];
  noWhyNot?: string;
  /** the Choice the decision moved to; the Choice is where the body is read from */
  movedTo?: string;
  raised: Raised;
}

export interface ProjectView {
  id: string;
  name: string;
  /** the one Purpose the Project points at; its statement is read from the Purpose, never copied here */
  purpose: string;
  /** what finishing looks like, in a user's words */
  doneWhen: string;
  state: ProjectState;
  /** the free text of the document */
  body: string;
  decisions: ProjectDecisionView[];
  /** the Issue refs that belong to the Project, in the order they were attached */
  issues: string[];
  raised: Raised;
  /** the last row that changed the Project's own fields */
  updated: Raised;
}

/** a person's record that an Issue is closed (or open again); the last row for an Issue decides */
export interface IssueStateView {
  issue: string;
  closed: boolean;
  at: string;
  by: Raised["by"];
}

export interface FoldedProjects {
  projects: ProjectView[];
  issueStates: IssueStateView[];
  /** the outside's state of an Issue as the sync last read it; a person's record and a landing both rank above it */
  externalStates: IssueStateView[];
}

export type ProjectShape<T> = { ok: true; value: T } | { ok: false; error: string };

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ---- the issue refs ----

const GH_ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/i;
const LINEAR_ISSUE_URL = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/.*)?$/i;
const GH_REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const LINEAR_IDENTIFIER = /^([A-Za-z][A-Za-z0-9]*-\d+)$/;

/**
 * The one name an Issue is kept under: `owner/name#N` for GitHub (owner and name lower-cased, since GitHub reads
 * them so) and `APP-1234` for Linear. A URL, either ref form, or a bare number (read in `defaultRepo`) all come to
 * the same string, so the Issue a backlog row names and the Issue a person typed meet.
 */
export function normalizeIssueRef(raw: unknown, defaultRepo: string): ProjectShape<string> {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return { ok: false, error: "Issue の参照が空です" };
  const gh = GH_ISSUE_URL.exec(input) ?? GH_REF.exec(input);
  if (gh) return { ok: true, value: `${gh[1].toLowerCase()}#${gh[2]}` };
  const linearUrl = LINEAR_ISSUE_URL.exec(input);
  if (linearUrl) return { ok: true, value: linearUrl[1].toUpperCase() };
  const linear = LINEAR_IDENTIFIER.exec(input);
  if (linear) return { ok: true, value: linear[1].toUpperCase() };
  const number = /^#?(\d+)$/.exec(input);
  if (number) {
    if (!defaultRepo) return { ok: false, error: `番号だけでは Issue を決められません（repo を決められない）: ${input}` };
    return { ok: true, value: `${defaultRepo.toLowerCase()}#${number[1]}` };
  }
  return { ok: false, error: `Issue の参照を読めません（URL・owner/name#N・APP-1234・番号のどれか）: ${input}` };
}

/** the ref of the Issue a backlog row was taken in from, or null for a row with no Issue */
export function issueRefOfRecord(rec: { gh_issue_url?: string | null; linear_issue_url?: string | null }): string | null {
  for (const url of [rec.linear_issue_url, rec.gh_issue_url]) {
    if (!url) continue;
    const ref = normalizeIssueRef(url, "");
    if (ref.ok) return ref.value;
  }
  return null;
}

// ---- the shape of what a caller writes ----

export interface ProjectBody {
  name: string;
  purpose: string;
  doneWhen: string;
  state?: ProjectState;
  body?: string;
}

export interface ProjectPatch {
  name?: string;
  purpose?: string;
  doneWhen?: string;
  state?: ProjectState;
  body?: string;
}

function stateOf(raw: unknown): ProjectShape<ProjectState | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw === "string" && (PROJECT_STATES as readonly string[]).includes(raw)) return { ok: true, value: raw as ProjectState };
  return { ok: false, error: `state は ${PROJECT_STATES.join(" / ")} のどれかにしてください: ${String(raw)}` };
}

/** free text that may be empty: absent is fine, a non-string is not */
function freeText(raw: unknown, name: string): ProjectShape<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, error: `${name} は文字列にしてください` };
  return { ok: true, value: raw.replace(/\r\n?/g, "\n").trim() };
}

/** the body of a Project raise: a name, the Purpose, and what finishing looks like are required */
export function normalizeProjectBody(raw: unknown): ProjectShape<ProjectBody> {
  const o = asRecord(raw);
  if (!o) return { ok: false, error: "project の本文は表で書いてください" };
  const name = text(o.name);
  if (!name) return { ok: false, error: "必須の欄 name が空です" };
  const purpose = text(o.purpose);
  if (!purpose) return { ok: false, error: "必須の欄 purpose が空です" };
  const doneWhen = text(o.done_when);
  if (!doneWhen) return { ok: false, error: "必須の欄 done_when が空です" };
  const state = stateOf(o.state);
  if (!state.ok) return state;
  const body = freeText(o.body, "body");
  if (!body.ok) return body;
  return {
    ok: true,
    value: { name, purpose, doneWhen, ...(state.value ? { state: state.value } : {}), ...(body.value ? { body: body.value } : {}) },
  };
}

/** the body of a Project change: at least one of the fields, each checked as the raise checks it */
export function normalizeProjectPatch(raw: unknown): ProjectShape<ProjectPatch> {
  const o = asRecord(raw);
  if (!o) return { ok: false, error: "project の変更は表で書いてください" };
  const patch: ProjectPatch = {};
  for (const [key, field] of [["name", "name"], ["purpose", "purpose"], ["done_when", "doneWhen"]] as const) {
    if (o[key] === undefined || o[key] === null) continue;
    const value = text(o[key]);
    if (!value) return { ok: false, error: `${key} は空でない文字列にしてください` };
    patch[field] = value;
  }
  const state = stateOf(o.state);
  if (!state.ok) return state;
  if (state.value) patch.state = state.value;
  // the document may be emptied: an empty body is a change, an absent one is not
  const body = freeText(o.body, "body");
  if (!body.ok) return body;
  if (body.value !== undefined) patch.body = body.value;
  if (!Object.keys(patch).length) return { ok: false, error: "name・purpose・done_when・state・body の少なくとも 1 つを渡してください" };
  return { ok: true, value: patch };
}

export interface DecisionBody {
  chosen: string;
  why: string;
  rejected: RejectedForm[];
  noWhyNot?: string;
}

/** a decision of a Project: the chosen form, why, and the forms thrown away (or the reason there are none) */
export function normalizeDecisionBody(raw: unknown): ProjectShape<DecisionBody> {
  const o = asRecord(raw);
  if (!o) return { ok: false, error: "決定の本文は表で書いてください" };
  const chosen = text(o.chosen);
  if (!chosen) return { ok: false, error: "必須の欄 chosen が空です" };
  const why = text(o.why);
  if (!why) return { ok: false, error: "必須の欄 why が空です" };
  const rawRejected = o.rejected;
  if (rawRejected !== undefined && rawRejected !== null && !Array.isArray(rawRejected)) {
    return { ok: false, error: "rejected は一覧で書いてください" };
  }
  const rejected: RejectedForm[] = [];
  for (const item of Array.isArray(rawRejected) ? rawRejected : []) {
    const i = asRecord(item);
    const form = i ? text(i.form) : null;
    const fails = i ? text(i.fails_because) : null;
    if (!form || !fails) return { ok: false, error: "rejected の各項には form と fails_because の両方が要ります" };
    rejected.push({ form, fails_because: fails });
  }
  const noWhyNot = o.no_why_not === undefined || o.no_why_not === null ? null : text(o.no_why_not);
  if (o.no_why_not !== undefined && o.no_why_not !== null && !noWhyNot) return { ok: false, error: "no_why_not は空でない文字列にしてください" };
  if (!rejected.length && !noWhyNot) return { ok: false, error: "rejected が空なら no_why_not に理由を書いてください" };
  return { ok: true, value: { chosen, why, rejected, ...(noWhyNot ? { noWhyNot } : {}) } };
}

// ---- the fold ----

function actorOf(row: IntentRow): Raised["by"] {
  return row.by;
}

function issuesOfRow(row: IntentRow): string[] {
  const list = Array.isArray(row.issues) ? (row.issues as unknown[]) : [];
  return list.flatMap((v) => (typeof v === "string" && v.trim() ? [v.trim()] : []));
}

/**
 * The Projects of the rows one viewer sees, folded in the column's order. A Project's fields take the last row that
 * names them; a decision is created by its first row and revised by later ones until it moves to a Choice; an Issue
 * belongs to the Project that attached it last, so attaching it to a second Project takes it from the first.
 */
export function foldProjects(rows: IntentRow[]): FoldedProjects {
  const projects = new Map<string, ProjectView>();
  const owner = new Map<string, string>();
  const attachedAt = new Map<string, number>();
  const issueStates = new Map<string, IssueStateView>();
  const externalStates = new Map<string, IssueStateView>();
  let order = 0;
  for (const row of rows) {
    const at = row.at;
    const by = actorOf(row);
    switch (row.event) {
      case PROJECT_EVENTS.raised: {
        const id = text(row.id);
        if (!id || projects.has(id)) break;
        const state = stateOf(row.state);
        projects.set(id, {
          id,
          name: text(row.name) ?? "",
          purpose: text(row.purpose) ?? "",
          doneWhen: text(row.done_when) ?? "",
          state: state.ok && state.value ? state.value : "planned",
          body: typeof row.body === "string" ? row.body.trim() : "",
          decisions: [],
          issues: [],
          raised: { by, at },
          updated: { by, at },
        });
        break;
      }
      case PROJECT_EVENTS.updated: {
        const p = projects.get(text(row.id) ?? "");
        if (!p) break;
        const name = text(row.name);
        if (name) p.name = name;
        const purpose = text(row.purpose);
        if (purpose) p.purpose = purpose;
        const doneWhen = text(row.done_when);
        if (doneWhen) p.doneWhen = doneWhen;
        const state = stateOf(row.state);
        if (state.ok && state.value) p.state = state.value;
        if (typeof row.body === "string") p.body = row.body.trim();
        p.updated = { by, at };
        break;
      }
      case PROJECT_EVENTS.decision: {
        const p = projects.get(text(row.id) ?? "");
        const key = text(row.decision);
        const chosen = text(row.chosen);
        if (!p || !key || !chosen) break;
        const found = p.decisions.find((d) => d.id === key);
        // a decision that moved is read from its Choice: a later row cannot put the body back here
        if (found?.movedTo) break;
        const why = text(row.why) ?? "";
        const rejected = Array.isArray(row.rejected)
          ? (row.rejected as unknown[]).flatMap((r): RejectedForm[] => {
            const o = asRecord(r);
            const form = o ? text(o.form) : null;
            const fails = o ? text(o.fails_because) : null;
            return form && fails ? [{ form, fails_because: fails }] : [];
          })
          : [];
        const noWhyNot = text(row.no_why_not);
        const next: ProjectDecisionView = {
          id: key, chosen, why, rejected, ...(noWhyNot ? { noWhyNot } : {}), raised: found ? found.raised : { by, at },
        };
        if (found) p.decisions[p.decisions.indexOf(found)] = next;
        else p.decisions.push(next);
        break;
      }
      case "choice_raised": {
        // a Choice raised from a decision carries where it came from: the decision keeps the pointer and lets go of the body
        const from = asRecord(row.from_decision);
        const choice = text(row.id);
        const p = from ? projects.get(text(from.project) ?? "") : undefined;
        const d = p ? p.decisions.find((x) => x.id === text(from?.decision)) : undefined;
        if (!p || !d || !choice) break;
        p.decisions[p.decisions.indexOf(d)] = { id: d.id, chosen: d.chosen, raised: d.raised, movedTo: choice };
        break;
      }
      case PROJECT_EVENTS.attached: {
        const id = text(row.id);
        if (!id || !projects.has(id)) break;
        for (const issue of issuesOfRow(row)) {
          if (owner.get(issue) === id) continue;
          owner.set(issue, id);
          attachedAt.set(issue, order);
          order += 1;
        }
        break;
      }
      case PROJECT_EVENTS.detached: {
        const id = text(row.id);
        if (!id) break;
        for (const issue of issuesOfRow(row)) if (owner.get(issue) === id) owner.delete(issue);
        break;
      }
      case PROJECT_EVENTS.issueState: {
        const issue = text(row.issue);
        if (!issue || typeof row.closed !== "boolean") break;
        issueStates.set(issue, { issue, closed: row.closed, at, by });
        break;
      }
      case PROJECT_EVENTS.external: {
        const issue = text(row.issue);
        if (!issue || typeof row.closed !== "boolean") break;
        externalStates.set(issue, { issue, closed: row.closed, at, by });
        break;
      }
      default:
        break;
    }
  }
  for (const [issue, id] of [...owner].sort((a, b) => (attachedAt.get(a[0]) ?? 0) - (attachedAt.get(b[0]) ?? 0))) {
    projects.get(id)?.issues.push(issue);
  }
  return { projects: [...projects.values()], issueStates: [...issueStates.values()], externalStates: [...externalStates.values()] };
}

/** the Project an Issue ref belongs to, or null */
export function projectOfIssue(projects: ProjectView[], issue: string): ProjectView | null {
  return projects.find((p) => p.issues.includes(issue)) ?? null;
}

// ---- the completion candidate ----

export interface ProjectIssueStatus {
  issue: string;
  closed: boolean;
  /** how propter knows it is closed: a landing posted the close, a person recorded it, or the sync read it closed outside */
  via?: "landing" | "recorded" | "external";
  lane?: string;
  title?: string;
}

/**
 * The Issues of a Project with whether each is closed. A person's record decides when there is one (closed, or open
 * again after a close); otherwise a landing that posted the close does; then the outside's own state the sync read (an
 * Issue closed by hand or in Linear counts once the sync has seen it). Any other Issue is open: an ignored Issue stays
 * open until a person closes it. The outside's state ranks last and only a close of it counts, so it never reopens an
 * Issue a person or a landing closed, and it never closes one a person reopened.
 */
export function issueStatuses(
  project: Pick<ProjectView, "issues">,
  input: { issueStates: IssueStateView[]; landed: Map<string, string>; titles?: Map<string, string>; externalStates?: IssueStateView[] },
): ProjectIssueStatus[] {
  const external = new Map((input.externalStates ?? []).map((s) => [s.issue, s]));
  const recorded = new Map(input.issueStates.map((s) => [s.issue, s]));
  return project.issues.map((issue) => {
    const title = input.titles?.get(issue);
    const record = recorded.get(issue);
    const lane = input.landed.get(issue);
    if (record) {
      return { issue, closed: record.closed, ...(record.closed ? { via: "recorded" as const } : {}), ...(lane ? { lane } : {}), ...(title ? { title } : {}) };
    }
    if (lane) return { issue, closed: true, via: "landing" as const, lane, ...(title ? { title } : {}) };
    if (external.get(issue)?.closed) return { issue, closed: true, via: "external" as const, ...(title ? { title } : {}) };
    return { issue, closed: false, ...(title ? { title } : {}) };
  });
}

/**
 * Whether the Project reads as a candidate for completion: it has an Issue, every Issue is closed, and a person has
 * not already closed the Project. A candidate changes no state; the Project becomes completed only when a person says so.
 */
export function completionCandidate(project: Pick<ProjectView, "state">, issues: ProjectIssueStatus[]): boolean {
  if ((PROJECT_CLOSING_STATES as readonly string[]).includes(project.state)) return false;
  return issues.length > 0 && issues.every((i) => i.closed);
}
