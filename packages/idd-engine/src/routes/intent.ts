import {
  attachIssues, checkState, confirmChoice, confirmPurpose, detachIssues, dropChoice, foldProjectRows, foldRows, intentColumnPath,
  laneStates, listRecords, lookupChoices, projectStatuses, projectionViewFor, promoteDecision, raiseChoice, raiseProject,
  raiseProposal, raisePurpose, readBacklog, readLifecycle, readRows, reanchor, recordIssueState, resolveAreaKey, retirePurpose,
  riskView, setProjectDecision, showProject, showRecord, supersede, syncRepo, updateProject, viewerLane, waive,
  type IntentActor, type OpResult,
} from "@idd/core";

import { json } from "../http.ts";
import { authorize } from "../server/agent-auth";

/** what the store answers; the route adds nothing of its own to it */
type DoorResult = OpResult;

/** the two ways an intent call names itself: an id (a lane) or a session (the lane's outside) */
interface Caller {
  actor: IntentActor;
  repo: string;
}

/**
 * Who is calling and for which repo. An `idd_id` makes it a lane's call, and the repo is the lane's area; a
 * session without a lane is the outside, and the repo it names is resolved to a registry key (the key itself,
 * a short name, or the GitHub owner/name). A call that names neither, or a lane the backlog does not hold, is
 * refused before anything is read or written.
 */
function callerOf(iddId: string, session: string, repoGiven: string): Caller | { error: string } {
  if (iddId) {
    const rec = readBacklog().find((r) => r.idd_id === iddId);
    if (!rec) return { error: `unknown lane: ${iddId}` };
    const key = resolveAreaKey(rec.area);
    return { actor: { lane: iddId }, repo: "error" in key ? rec.area : key.key };
  }
  if (!session) return { error: "session を指定してください" };
  if (!repoGiven) return { error: "repo を指定してください" };
  const key = resolveAreaKey(repoGiven);
  if ("error" in key) return { error: key.error };
  return { actor: { session }, repo: key.key };
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * `idd project sync`: the same function the tick's stage runs, asked for now (the interval does not hold it back). It reads
 * the outside and writes nothing to it. A lane does not ask for it: it takes the outside's changes into the Projects
 * of the whole repo, which is no lane's to start.
 */
async function projectSync(caller: Caller): Promise<DoorResult> {
  if ("lane" in caller.actor) return { ok: false, error: "外の取り込みを回せるのは lane の外だけです" };
  const result = await syncRepo(caller.repo, { force: true });
  return result.error ? { ok: false, error: result.error } : { ok: true, ...result };
}

/** the action names the door takes, mapped to the store's operations */
function dispatch(action: string, caller: Caller, payload: Record<string, unknown>): Promise<DoorResult> {
  const { actor, repo } = caller;
  switch (action) {
    case "raise_purpose":
      return raisePurpose({ repo, actor, statement: payload.statement, origin: payload.origin, id: payload.id, name: payload.name });
    case "confirm_purpose":
      return confirmPurpose({ repo, actor, id: payload.id, name: payload.name });
    case "retire_purpose":
      return retirePurpose({ repo, actor, id: payload.id, grounds: payload.grounds });
    case "raise_choice":
      return raiseChoice({ repo, actor, body: payload });
    case "supersede":
      return supersede({ repo, actor, ids: payload.ids, grounds: payload.grounds, body: payload.choice, by: payload.by });
    case "reanchor":
      return reanchor({ repo, actor, id: payload.id, place: payload.place, anchored: payload.anchored });
    case "confirm_choice":
      return confirmChoice({ repo, actor, id: payload.id });
    case "drop_choice":
      return dropChoice({ repo, actor, id: payload.id, grounds: payload.grounds });
    case "waive":
      return waive({ repo, actor, kind: payload.kind, choices: payload.choices, reason: payload.reason, change: payload.change });
    case "project_raise":
      return raiseProject({ repo, actor, body: payload });
    case "project_update":
      return updateProject({ repo, actor, id: payload.id, patch: payload.patch });
    case "project_decide":
      return setProjectDecision({ repo, actor, id: payload.id, decision: payload.decision, body: payload.body });
    case "project_attach":
      return attachIssues({ repo, actor, id: payload.id, issues: payload.issues });
    case "project_detach":
      return detachIssues({ repo, actor, id: payload.id, issues: payload.issues });
    case "project_issue_state":
      return recordIssueState({ repo, actor, issue: payload.issue, closed: payload.closed });
    case "project_sync":
      return projectSync(caller);
    case "project_promote":
      // the decision's move into a Choice is the Choice's own raise: one row, so the pointer and the Choice stand together
      return promoteDecision({ repo, actor, id: payload.id, decision: payload.decision, body: payload.body });
    case "propose":
      // a proposal writes nothing but its own row: it applies nothing and moves no stage
      return raiseProposal({ repo, actor, kind: payload.kind, reason: payload.reason, body: payload.body });
    default:
      return Promise.resolve({ ok: false, error: `未知の action: ${action}` });
  }
}

/** the write door: the agent token is checked first, then the caller and repo are resolved, then the store decides */
export async function POST(req: Request): Promise<Response> {
  if (!authorize(req)) return json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body: { action?: unknown; idd_id?: unknown; session?: unknown; repo?: unknown; payload?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON を読めません" }, { status: 400 });
  }
  const action = asText(body.action) ?? "";
  const caller = callerOf(asText(body.idd_id) ?? "", asText(body.session) ?? "", asText(body.repo) ?? "");
  if ("error" in caller) return json({ ok: false, error: caller.error }, { status: 400 });
  const payload = body.payload !== null && typeof body.payload === "object" && !Array.isArray(body.payload)
    ? (body.payload as Record<string, unknown>)
    : {};
  const result = await dispatch(action, caller, payload);
  return json(result, { status: result.ok ? 200 : 400 });
}

/**
 * The read door: it asks for no token, writes nothing (neither the column nor the lifecycle), and resolves the
 * repo from `repo`, or from the lane's area when only a lane is named. `lane` doubles as the viewer: a lane's
 * records are visible to that lane before they merge.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const op = asText(url.searchParams.get("op")) ?? "";
  const lane = asText(url.searchParams.get("lane")) ?? "";
  const repoGiven = asText(url.searchParams.get("repo")) ?? "";
  let repo: string;
  if (repoGiven) {
    const key = resolveAreaKey(repoGiven);
    if ("error" in key) return json({ ok: false, error: key.error }, { status: 400 });
    repo = key.key;
  } else if (lane) {
    const rec = readBacklog().find((r) => r.idd_id === lane);
    if (!rec) return json({ ok: false, error: `unknown lane: ${lane}` }, { status: 400 });
    const key = resolveAreaKey(rec.area);
    repo = "error" in key ? rec.area : key.key;
  } else {
    return json({ ok: false, error: "repo か lane を指定してください" }, { status: 400 });
  }
  const actor: IntentActor | null = lane ? { lane } : null;
  if (op === "lookup") {
    const paths = url.searchParams.getAll("path");
    return json({ ok: true, choices: lookupChoices({ repo, actor, paths }) });
  }
  if (op === "show") {
    return json(showRecord({ repo, actor, id: asText(url.searchParams.get("id")) ?? "" }));
  }
  if (op === "records") {
    return json({ ok: true, ...listRecords({ repo, actor, kind: asText(url.searchParams.get("kind")) ?? "", status: asText(url.searchParams.get("status")) ?? "" }) });
  }
  if (op === "risk") {
    // the declaration and the approved examples from one reader; no token is asked for and nothing is written
    return json({ ok: true, ...riskView(repo, actor) });
  }
  if (op === "projection") {
    // the drawn text is a function of the state alone: the door reads the column and writes nothing. The same
    // assembly is what the landing draws from, so the two can never disagree about one state.
    return json({ ok: true, ...projectionViewFor(repo, lane || null) });
  }
  if (op === "projects") {
    // the Projects one viewer sees, each with its Issues and whether it reads as a candidate for completion; nothing is written
    return json({ ok: true, projects: projectStatuses(repo, actor) });
  }
  if (op === "project") {
    return json(showProject({ repo, actor, id: asText(url.searchParams.get("id")) ?? "" }));
  }
  if (op === "check") {
    // the state alone: the tree rules need the caller's worktree, which only the CLI has, so they are not here
    const rows = readRows(intentColumnPath(repo));
    const events = readLifecycle();
    const laneEvents = lane ? events.filter((e) => e.idd_id === lane) : [];
    const states = laneStates(events);
    const folded = foldRows(rows, viewerLane(actor), states);
    const { projects } = foldProjectRows(rows, viewerLane(actor), states);
    return json({ ok: true, ...checkState({ rows, folded, lane: lane || null, events: laneEvents, projects }) });
  }
  return json({ ok: false, error: `未知の op: ${op}` }, { status: 400 });
}
