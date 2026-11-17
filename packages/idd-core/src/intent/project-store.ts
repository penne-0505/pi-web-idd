/**
 * The writes and the reads of the Projects. Every write runs inside the column's one lock (`runWrite`), re-reads the
 * column there and appends exactly the rows it decided on, the same as the writes of a Choice. The reads fold the
 * Projects for one viewer and join them to what the ledger knows of the Issues: the lanes that landed (and posted
 * the Issue's close) and a person's record that an Issue is closed.
 */

import { projectionConfigOf, readAreas } from "../config/areas.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";
import {
  PROJECT_CLOSING_STATES, PROJECT_EVENTS, completionCandidate, issueRefOfRecord, issueStatuses, normalizeDecisionBody,
  normalizeIssueRef, normalizeProjectBody, normalizeProjectPatch, projectNumber, projectOfIssue,
  type FoldedProjects, type ProjectIssueStatus, type ProjectView,
} from "./project.ts";
import { normalizeChoiceBody, type IntentActor } from "./records.ts";
import {
  baseRow, effectiveRows, endRefusal, foldPendingProjectRows, foldProjectRows, foldRows, intentColumnPath, intentProjectName, laneStates, prepareChoice,
  purposeRefusal, raisedByLane, readRows, runWrite, viewerLane, type IntentRow, type LaneState, type OpResult,
} from "./store.ts";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** the GitHub repo a bare Issue number is read in: the area's linked repo, else the key itself */
export function githubRepoOf(repo: string): string {
  return readAreas().areas[repo]?.linked_repo ?? repo;
}

/** the next `PRJ-<n>`: counted over the whole column, rows a viewer cannot see yet included */
function nextProjectId(rows: IntentRow[]): string {
  let max = 0;
  for (const row of rows) {
    const n = row.event === PROJECT_EVENTS.raised ? projectNumber(text(row.id) ?? "") : null;
    if (n !== null) max = Math.max(max, n);
  }
  return `PRJ-${max + 1}`;
}

/** the next `PD-<project number>-<n>`: counted over the whole column, so two lanes never take the same key */
function nextDecisionKey(rows: IntentRow[], projectId: string): string {
  const prefix = `PD-${projectNumber(projectId) ?? 0}-`;
  let max = 0;
  for (const row of rows) {
    const key = row.event === PROJECT_EVENTS.decision ? text(row.decision) : null;
    if (!key || !key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${prefix}${max + 1}`;
}

/** what the write sees of the Projects: the viewer's own side, so a lane finds the Project it raised before it lands */
function projectsSeenBy(ctx: { rows: IntentRow[]; states: Map<string, LaneState> }, actor: IntentActor): FoldedProjects {
  return foldProjectRows(ctx.rows, viewerLane(actor), ctx.states);
}

/** the Projects with the running lanes' unlanded changes in them: what a writer that compared to something it read must check against */
function projectsWithPending(ctx: { rows: IntentRow[]; states: Map<string, LaneState> }): ProjectView[] {
  return foldPendingProjectRows(ctx.rows, ctx.states).projects;
}

function projectRefusal(projects: ProjectView[], id: string | null): { project: ProjectView } | { error: string } {
  if (!id) return { error: "id が空です" };
  const project = projects.find((p) => p.id === id);
  return project ? { project } : { error: `Project ${id} はありません` };
}

/** closing a Project is a person's word: a lane neither sets completed or canceled nor reopens a Project a person closed */
function closingRefusal(actor: IntentActor, from: string | null, to: string | undefined): string | null {
  if (!("lane" in actor)) return null;
  const closing = PROJECT_CLOSING_STATES as readonly string[];
  if (to && closing.includes(to)) return `Project を ${to} にできるのは lane の外（人）だけです`;
  if (from && closing.includes(from) && to) return `Project は ${from} です。開き直せるのは lane の外（人）だけです`;
  return null;
}

export async function raiseProject(input: { repo: string; actor: IntentActor; body?: unknown }): Promise<OpResult<{ id: string; state: string }>> {
  return runWrite<{ id: string; state: string }>(input.repo, input.actor, ({ rows, events, states }) => {
    const ended = endRefusal(input.actor, events);
    if (ended) return { result: { ok: false, error: ended } };
    const body = normalizeProjectBody(input.body);
    if (!body.ok) return { result: { ok: false, error: body.error } };
    const closing = closingRefusal(input.actor, null, body.value.state);
    if (closing) return { result: { ok: false, error: closing } };
    const refusal = purposeRefusal(foldRows(rows, viewerLane(input.actor), states), body.value.purpose);
    if (refusal) return { result: { ok: false, error: refusal } };
    const id = nextProjectId(rows);
    const state = body.value.state ?? "planned";
    return {
      result: { ok: true, id, state },
      append: {
        ...baseRow(input.repo, input.actor, PROJECT_EVENTS.raised),
        id, name: body.value.name, purpose: body.value.purpose, done_when: body.value.doneWhen, state,
        ...(body.value.body ? { body: body.value.body } : {}),
      },
    };
  });
}

/**
 * `expectBody` is for a writer that compared the body to something it read earlier (the sync): the write is refused,
 * inside the same lock that appends, when the body is no longer that. It is no part of the entrance a person or a
 * lane reaches.
 */
export async function updateProject(input: { repo: string; actor: IntentActor; id?: unknown; patch?: unknown; expectBody?: string }): Promise<OpResult<{ id: string; state: string }>> {
  return runWrite<{ id: string; state: string }>(input.repo, input.actor, (ctx) => {
    const ended = endRefusal(input.actor, ctx.events);
    if (ended) return { result: { ok: false, error: ended } };
    const found = projectRefusal(projectsSeenBy(ctx, input.actor).projects, text(input.id));
    if ("error" in found) return { result: { ok: false, error: found.error } };
    if (input.expectBody !== undefined && (projectsWithPending(ctx).find((p) => p.id === found.project.id)?.body ?? found.project.body) !== input.expectBody) return { result: { ok: false, error: `${found.project.id} の本文が読んだ後に変わっています` } };
    const patch = normalizeProjectPatch(input.patch);
    if (!patch.ok) return { result: { ok: false, error: patch.error } };
    const closing = closingRefusal(input.actor, found.project.state, patch.value.state);
    if (closing) return { result: { ok: false, error: closing } };
    if (patch.value.purpose) {
      const refusal = purposeRefusal(foldRows(ctx.rows, viewerLane(input.actor), ctx.states), patch.value.purpose);
      if (refusal) return { result: { ok: false, error: refusal } };
    }
    const { doneWhen, ...rest } = patch.value;
    return {
      result: { ok: true, id: found.project.id, state: patch.value.state ?? found.project.state },
      append: {
        ...baseRow(input.repo, input.actor, PROJECT_EVENTS.updated),
        id: found.project.id, ...rest, ...(doneWhen ? { done_when: doneWhen } : {}),
      },
    };
  });
}

/**
 * Whether any Choice row of the whole column was raised from this decision. A move by a lane that has not landed is
 * invisible to the viewer's fold, so a write that must not meet it (a second move, a revision the fold would drop once
 * the move lands) counts the column, as nextChoiceId does. A move by a lane that ended without landing never takes
 * effect, so it does not count: it would otherwise block the decision for good. A merged move and the move of a lane
 * still running do count.
 */
function decisionMovedInColumn(rows: IntentRow[], states: Map<string, LaneState>, projectId: string, decisionId: string): boolean {
  const landed = new Set(effectiveRows(rows, null, states));
  return rows.some((row) => {
    const byLane = raisedByLane(row.by);
    if (byLane && states.get(byLane)?.endedAt && !landed.has(row)) return false;
    const from = row.event === "choice_raised" ? row.from_decision : null;
    return from !== null && typeof from === "object" && !Array.isArray(from)
      && (from as Record<string, unknown>).project === projectId && (from as Record<string, unknown>).decision === decisionId;
  });
}

/** write a decision of a Project: a new one when no key is given, a revision of that decision when one is */
export async function setProjectDecision(input: {
  repo: string; actor: IntentActor; id?: unknown; decision?: unknown; body?: unknown;
}): Promise<OpResult<{ id: string; decision: string; created: boolean }>> {
  return runWrite<{ id: string; decision: string; created: boolean }>(input.repo, input.actor, (ctx) => {
    const ended = endRefusal(input.actor, ctx.events);
    if (ended) return { result: { ok: false, error: ended } };
    const found = projectRefusal(projectsSeenBy(ctx, input.actor).projects, text(input.id));
    if ("error" in found) return { result: { ok: false, error: found.error } };
    const body = normalizeDecisionBody(input.body);
    if (!body.ok) return { result: { ok: false, error: body.error } };
    const given = input.decision === undefined || input.decision === null ? null : text(input.decision);
    if (input.decision !== undefined && input.decision !== null && !given) return { result: { ok: false, error: "決定の ID が空です" } };
    if (given) {
      const old = found.project.decisions.find((d) => d.id === given);
      if (!old) return { result: { ok: false, error: `決定 ${given} は Project ${found.project.id} にありません` } };
      if (old.movedTo) return { result: { ok: false, error: `決定 ${given} は Choice ${old.movedTo} に移っています。直すのはその Choice です` } };
      if (decisionMovedInColumn(ctx.rows, ctx.states, found.project.id, given)) return { result: { ok: false, error: `決定 ${given} は既に別の Choice が移しています。直すのはその Choice です` } };
    }
    const key = given ?? nextDecisionKey(ctx.rows, found.project.id);
    return {
      result: { ok: true, id: found.project.id, decision: key, created: !given },
      append: {
        ...baseRow(input.repo, input.actor, PROJECT_EVENTS.decision),
        id: found.project.id, decision: key, chosen: body.value.chosen, why: body.value.why, rejected: body.value.rejected,
        ...(body.value.noWhyNot ? { no_why_not: body.value.noWhyNot } : {}),
      },
    };
  });
}

/** the refs a caller named, each in its one canonical form; the first one that cannot be read is the error */
function refsOf(raw: unknown, repo: string): { refs: string[] } | { error: string } {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  if (!list.length) return { error: "Issue の参照を 1 つ以上渡してください" };
  const refs: string[] = [];
  for (const item of list) {
    const ref = normalizeIssueRef(item, githubRepoOf(repo));
    if (!ref.ok) return { error: ref.error };
    if (!refs.includes(ref.value)) refs.push(ref.value);
  }
  return { refs };
}

/** `expectOwner` is the same kind of guard as `expectBody`: the Project (or "" for none) the Issues belonged to when the writer read them */
export async function attachIssues(input: { repo: string; actor: IntentActor; id?: unknown; issues?: unknown; expectOwner?: string }): Promise<OpResult<{ id: string; attached: string[]; already: string[]; moved: { issue: string; from: string }[] }>> {
  return runWrite<{ id: string; attached: string[]; already: string[]; moved: { issue: string; from: string }[] }>(input.repo, input.actor, (ctx) => {
    const ended = endRefusal(input.actor, ctx.events);
    if (ended) return { result: { ok: false, error: ended } };
    const projects = projectsSeenBy(ctx, input.actor).projects;
    const found = projectRefusal(projects, text(input.id));
    if ("error" in found) return { result: { ok: false, error: found.error } };
    const named = refsOf(input.issues, input.repo);
    if ("error" in named) return { result: { ok: false, error: named.error } };
    // a writer that compared to something it read (the sync) decides on the running lanes' unlanded rows too: an Issue a
    // lane moved elsewhere is not "already here" just because the landed rows still say so, or it would end up elsewhere once the lane lands
    const guarded = input.expectOwner !== undefined;
    const seen = guarded ? projectsWithPending(ctx) : projects;
    const holds = (refs: string[]) => refs.filter((r) => (seen.find((p) => p.id === found.project.id) ?? found.project).issues.includes(r));
    const already = holds(named.refs);
    const attached = named.refs.filter((r) => !already.includes(r));
    // one Issue belongs to one Project: attaching it here takes it from the one that held it
    const moved = attached.flatMap((issue) => {
      const from = projectOfIssue(seen, issue);
      return from ? [{ issue, from: from.id }] : [];
    });
    if (guarded && attached.some((issue) => (projectOfIssue(seen, issue)?.id ?? "") !== input.expectOwner)) {
      return { result: { ok: false, error: `${attached.join(", ")} の所属が読んだ後に変わっています` } };
    }
    const result = { ok: true as const, id: found.project.id, attached, already, moved };
    if (!attached.length) return { result };
    return { result, append: { ...baseRow(input.repo, input.actor, PROJECT_EVENTS.attached), id: found.project.id, issues: attached } };
  });
}

/** `expectOwner` guards the same way as in `attachIssues`: the Project the writer read the Issues in, which must still hold them (the running lanes' unlanded rows counted) */
export async function detachIssues(input: { repo: string; actor: IntentActor; id?: unknown; issues?: unknown; expectOwner?: string }): Promise<OpResult<{ id: string; detached: string[] }>> {
  return runWrite<{ id: string; detached: string[] }>(input.repo, input.actor, (ctx) => {
    const ended = endRefusal(input.actor, ctx.events);
    if (ended) return { result: { ok: false, error: ended } };
    const found = projectRefusal(projectsSeenBy(ctx, input.actor).projects, text(input.id));
    if ("error" in found) return { result: { ok: false, error: found.error } };
    const named = refsOf(input.issues, input.repo);
    if ("error" in named) return { result: { ok: false, error: named.error } };
    const missing = named.refs.filter((r) => !found.project.issues.includes(r));
    if (missing.length) return { result: { ok: false, error: `Project ${found.project.id} に属していない Issue です: ${missing.join(", ")}` } };
    if (input.expectOwner !== undefined) {
      const seen = projectsWithPending(ctx);
      if (input.expectOwner !== found.project.id || named.refs.some((issue) => projectOfIssue(seen, issue)?.id !== found.project.id)) {
        return { result: { ok: false, error: `${named.refs.join(", ")} の所属が読んだ後に変わっています` } };
      }
    }
    return {
      result: { ok: true, id: found.project.id, detached: named.refs },
      append: { ...baseRow(input.repo, input.actor, PROJECT_EVENTS.detached), id: found.project.id, issues: named.refs },
    };
  });
}

/** one row of an Issue's closed-or-open state, written from outside the lanes: `laneRefusal` is what a lane that tries gets */
async function writeIssueState(
  input: { repo: string; actor: IntentActor; issue?: unknown; closed?: unknown },
  event: string,
  laneRefusal: string,
): Promise<OpResult<{ issue: string; closed: boolean }>> {
  return runWrite<{ issue: string; closed: boolean }>(input.repo, input.actor, () => {
    if ("lane" in input.actor) return { result: { ok: false, error: laneRefusal } };
    if (typeof input.closed !== "boolean") return { result: { ok: false, error: "closed は true か false にしてください" } };
    const ref = normalizeIssueRef(input.issue, githubRepoOf(input.repo));
    if (!ref.ok) return { result: { ok: false, error: ref.error } };
    return {
      result: { ok: true, issue: ref.value, closed: input.closed },
      append: { ...baseRow(input.repo, input.actor, event), issue: ref.value, closed: input.closed },
    };
  });
}

/**
 * A person's record that an Issue is closed (or open again). Propter learns of a close its own landing posted, and of
 * nothing else: an Issue closed by hand, in Linear, or through a card that was not posted here is closed only because
 * a person says so. A lane never writes it, so a lane cannot make its own Project a candidate for completion.
 */
export const recordIssueState = (input: { repo: string; actor: IntentActor; issue?: unknown; closed?: unknown }) =>
  writeIssueState(input, PROJECT_EVENTS.issueState, "Issue が閉じたことを記録できるのは lane の外（人）だけです");

/** the session name the sync writes under: not a lane, so it may record what the outside says and nothing a lane could not */
export const SYNC_SESSION = "tracker-sync";

/**
 * What the outside says of an Issue's state, as the sync read it. It ranks below a person's record and a landing's
 * close (`issueStatuses`), and only a writer outside the lanes may write it, so a lane cannot make its own Project a
 * candidate for completion.
 */
export const recordExternalIssueState = (input: { repo: string; actor: IntentActor; issue?: unknown; closed?: unknown }) =>
  writeIssueState(input, PROJECT_EVENTS.external, "外の状態を記録できるのは lane の外（同期）だけです");

/**
 * Move a decision of a Project into a Choice, in one row. The Choice's fields default to the decision's own (the
 * chosen form and the forms thrown away, the reason, the Project's Purpose); the caller adds what only the code knows
 * (the Place and anchored) and may override any field. The Choice row names the decision it came from, so the Project's
 * decision lets go of its body and points at the Choice from the moment the row is read.
 */
export async function promoteDecision(input: {
  repo: string; actor: IntentActor; id?: unknown; decision?: unknown; body?: unknown;
}): Promise<OpResult<{ id: string; project: string; decision: string; status: string }>> {
  return runWrite<{ id: string; project: string; decision: string; status: string }>(input.repo, input.actor, (ctx) => {
    const ended = endRefusal(input.actor, ctx.events);
    if (ended) return { result: { ok: false, error: ended } };
    const found = projectRefusal(projectsSeenBy(ctx, input.actor).projects, text(input.id));
    if ("error" in found) return { result: { ok: false, error: found.error } };
    const key = text(input.decision);
    const decision = key ? found.project.decisions.find((d) => d.id === key) : undefined;
    if (!decision) return { result: { ok: false, error: `決定 ${key ?? "(空)"} は Project ${found.project.id} にありません` } };
    if (decision.movedTo) return { result: { ok: false, error: `決定 ${decision.id} は既に Choice ${decision.movedTo} に移っています` } };
    if (decisionMovedInColumn(ctx.rows, ctx.states, found.project.id, decision.id)) return { result: { ok: false, error: `決定 ${decision.id} は既に別の Choice が移しています` } };
    const payload = input.body !== null && typeof input.body === "object" && !Array.isArray(input.body) ? (input.body as Record<string, unknown>) : null;
    if (!payload) return { result: { ok: false, error: "Choice の本文は表で書いてください（Place と anchored が要ります）" } };
    const merged = {
      purpose: found.project.purpose,
      forms: { chosen: decision.chosen, rejected: decision.rejected ?? [] },
      why: decision.why,
      ...(decision.noWhyNot ? { no_why_not: decision.noWhyNot } : {}),
      ...payload,
    };
    const body = normalizeChoiceBody(merged);
    if (!body.ok) return { result: { ok: false, error: body.error } };
    const folded = foldRows(ctx.rows, viewerLane(input.actor), ctx.states);
    const refusal = purposeRefusal(folded, body.value.purpose);
    if (refusal) return { result: { ok: false, error: refusal } };
    const prep = prepareChoice(ctx.rows, input.actor, body.value, projectionConfigOf(input.repo).visibility_default);
    if (!prep.ok) return { result: prep };
    return {
      result: { ok: true, id: prep.id, project: found.project.id, decision: decision.id, status: prep.status },
      append: {
        ...baseRow(input.repo, input.actor, "choice_raised"),
        ...prep.fields,
        from_decision: { project: found.project.id, decision: decision.id },
      },
    };
  });
}

// ---- the reads ----

/**
 * The Issues a landing closed, by ref: a lane that posted the close of its Issue (`s4_land_issue_close_posted`) names
 * the Issue's backlog row, and the row names the ref. A lane that landed without posting a close (a repo that turned
 * the signed close off, or a Linear lane) closes nothing here.
 */
export function landedIssues(backlog: BacklogRecord[], events: LifecycleRecord[]): Map<string, string> {
  const posted = new Set(events.filter((e) => e.event === "s4_land_issue_close_posted").map((e) => e.idd_id));
  const landed = new Map<string, string>();
  for (const rec of backlog) {
    if (!posted.has(rec.idd_id)) continue;
    const ref = issueRefOfRecord(rec);
    if (ref) landed.set(ref, rec.idd_id);
  }
  return landed;
}

export interface ProjectStatusView extends ProjectView {
  /** every Issue of the Project with whether it is closed and how propter knows */
  issueStatuses: ProjectIssueStatus[];
  closedCount: number;
  /** every Issue is closed and a person has not closed the Project: a candidate only, the state is unchanged */
  completionCandidate: boolean;
  /** where the drawn copy of the Project stands in the repo's tree */
  document: string;
}

/** the Projects one viewer sees, each joined to the ledger's knowledge of its Issues */
export function projectStatuses(repo: string, actor: IntentActor | null, opts: { pending?: boolean } = {}): ProjectStatusView[] {
  const rows = readRows(intentColumnPath(repo));
  const states = laneStates(readLifecycle());
  const folded = opts.pending ? foldPendingProjectRows(rows, states) : foldProjectRows(rows, viewerLane(actor), states);
  const backlog = readBacklog();
  const landed = landedIssues(backlog, readLifecycle());
  const titles = new Map<string, string>();
  for (const rec of backlog) {
    const ref = issueRefOfRecord(rec);
    if (ref) titles.set(ref, rec.title);
  }
  const dir = `_docs/intent/${intentProjectName(repo)}`;
  return folded.projects.map((p) => {
    const statuses = issueStatuses(p, { issueStates: folded.issueStates, landed, titles, externalStates: folded.externalStates });
    return {
      ...p,
      issueStatuses: statuses,
      closedCount: statuses.filter((s) => s.closed).length,
      completionCandidate: completionCandidate(p, statuses),
      document: `${dir}/${p.id}.md`,
    };
  });
}

export function showProject(input: { repo: string; actor: IntentActor | null; id: string }): OpResult<{ project: ProjectStatusView }> {
  const id = text(input.id);
  if (!id) return { ok: false, error: "id が空です" };
  const project = projectStatuses(input.repo, input.actor).find((p) => p.id === id);
  return project ? { ok: true, project } : { ok: false, error: `Project ${id} はありません` };
}

/** the Project a lane's Issue belongs to, seen from the lane's own side; null when the lane has no Issue or none holds it */
export function projectOfLane(repo: string, rec: Pick<BacklogRecord, "idd_id" | "gh_issue_url" | "linear_issue_url">): ProjectView | null {
  const ref = issueRefOfRecord(rec);
  if (!ref) return null;
  const rows = readRows(intentColumnPath(repo));
  return projectOfIssue(foldProjectRows(rows, rec.idd_id, laneStates(readLifecycle())).projects, ref);
}
