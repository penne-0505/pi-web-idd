import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A read-only Linear client. It sends only the query documents fixed in this file: there is no function that
 * takes a document from the caller, so nothing built here can be a mutation. The key stays in a closure and is
 * scrubbed from every message this module produces.
 */

export interface LinearBlocker {
  identifier: string;
  title: string;
  url: string;
  teamKey: string;
  /** the WorkflowState type: triage / backlog / unstarted / started / completed / canceled / duplicate */
  stateType: string;
}

export interface LinearIssue {
  /** Linear's own id (a UUID); it stays when the Issue moves to another team and its identifier changes */
  id: string;
  identifier: string;
  title: string;
  description: string;
  /** https://linear.app/<org>/issue/<IDENTIFIER>, without the title slug, so a renamed Issue keeps its URL */
  url: string;
  teamKey: string;
  state: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  /** the team's estimate, as Linear's number; null when the Issue has none (a T-shirt team still answers a number) */
  estimate: number | null;
  /** Linear's priority number: 0 none, 1 Urgent, 2 High, 3 Medium, 4 Low. Shown, never used to take an Issue in */
  priority: number;
  /** the Issues whose `blocks` relation names this one, as the assigned list read them */
  blockers: LinearBlocker[];
  /** the Issue's relation connection returned more relations than it read */
  blockersTruncated: boolean;
}

/** a Project of a Linear team, as the sync of Projects reads it */
export interface LinearProject {
  id: string;
  name: string;
  description: string;
  url: string;
}

/** an Issue as the sync of Projects reads it: whether it is done, and the Project it is in */
export interface LinearSyncIssue {
  identifier: string;
  /** the state's type is completed, canceled or duplicate (the types the intake counts as done too) */
  closed: boolean;
  projectId: string | null;
}

export type LinearFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

const ISSUE_FIELDS = `id identifier title description url createdAt updatedAt estimate priority team { key } state { name } labels { nodes { name } }`;
/** the Issue behind a relation: only what a blocker is named and held by (its state's type says whether it is done) */
const RELATION_FIELDS = `id identifier title url team { key } state { name type }`;
const RELATIONS = `inverseRelations(first: 50) { nodes { type issue { ${RELATION_FIELDS} } } pageInfo { hasNextPage } }`;

/** what the sync of Projects reads of an Issue: no text, no relations, so the pages are light */
const SYNC_ISSUE_FIELDS = `identifier state { type } project { id }`;

const QUERIES = Object.freeze({
  assignedIssues: `query AssignedIssues($states: [String!], $first: Int!, $after: String) {
  viewer {
    assignedIssues(first: $first, after: $after, filter: { state: { name: { in: $states } } }, orderBy: createdAt) {
      nodes { ${ISSUE_FIELDS} ${RELATIONS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`,
  unassignedIssues: `query UnassignedIssues($teams: [String!], $states: [String!], $first: Int!, $after: String) {
  issues(first: $first, after: $after, filter: { assignee: { null: true }, team: { key: { in: $teams } }, state: { name: { in: $states } } }, orderBy: createdAt) {
    nodes { ${ISSUE_FIELDS} ${RELATIONS} }
    pageInfo { hasNextPage endCursor }
  }
}`,
  issueByIdentifier: `query IssueByIdentifier($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`,
  teamProjects: `query TeamProjects($team: String!, $first: Int!, $after: String) {
  teams(filter: { key: { eq: $team } }, first: 1) {
    nodes { projects(first: $first, after: $after) { nodes { id name description url } pageInfo { hasNextPage endCursor } } }
  }
}`,
  projectIssues: `query ProjectIssues($id: String!, $first: Int!, $after: String) {
  project(id: $id) { issues(first: $first, after: $after) { nodes { ${SYNC_ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }
}`,
  syncIssueByIdentifier: `query SyncIssueByIdentifier($id: String!) {
  issue(id: $id) { ${SYNC_ISSUE_FIELDS} }
}`,
});

type QueryName = keyof typeof QUERIES;

/** every document is a plain query; a document that could write is refused before anything is sent */
function queryDocument(name: QueryName): string {
  const doc = QUERIES[name];
  if (!/^query\s/.test(doc) || /\bmutation\b|\bsubscription\b/i.test(doc)) throw new Error(`Linear: ${name} は読み取りの query ではありません`);
  return doc;
}

export function linearKeyPath(): string {
  return process.env.IDD_LINEAR_KEY_FILE?.trim() || join(homedir(), ".config", "idd", "linear-api-key");
}

/** the key from LINEAR_API_KEY, else from the key file; null (with the reason) when neither has one */
export function readLinearKey(): { key: string } | { key: null; reason: string } {
  const fromEnv = process.env.LINEAR_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv };
  const path = linearKeyPath();
  if (!existsSync(path)) return { key: null, reason: `Linear の鍵がありません（LINEAR_API_KEY か ${path}）` };
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return { key: null, reason: `Linear の鍵のファイルを読めません（${path}）` };
  }
  return text ? { key: text } : { key: null, reason: `Linear の鍵のファイルが空です（${path}）` };
}

/**
 * One spelling per Linear Issue: https, lower-case host, upper-case identifier, no title slug.
 * https://Linear.app/org/issue/app-1/some-title -> https://linear.app/org/issue/APP-1
 */
export function canonicalLinearUrl(url: string): string {
  if (typeof url !== "string") return "";
  const m = /^https?:\/\/linear\.app\/([^/?#]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/i.exec(url.trim());
  return m ? `https://linear.app/${m[1]}/issue/${m[2].toUpperCase()}` : url.trim();
}

interface RawRelation {
  type?: string;
  issue?: RawNode | null;
}

interface RawNode {
  id?: string;
  name?: string;
  project?: { id?: string } | null;
  identifier?: string;
  title?: string;
  description?: string | null;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  estimate?: number | null;
  priority?: number | null;
  team?: { key?: string } | null;
  state?: { name?: string; type?: string } | null;
  labels?: { nodes?: { name?: string }[] } | null;
  inverseRelations?: { nodes?: RawRelation[] | null; pageInfo?: { hasNextPage?: boolean } | null } | null;
}

type RawError = { message?: string; extensions?: { code?: string; userPresentableMessage?: string } };

/** one connection of Issues and the cursor that follows it; both list queries answer in this shape */
type RawConnection = { nodes?: RawNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };

interface RawPage {
  data?: { viewer?: { assignedIssues?: RawConnection } };
  errors?: RawError[];
}

interface RawIssuesPage {
  data?: { issues?: RawConnection } | null;
  errors?: RawError[];
}

interface RawOne {
  data?: { issue?: RawNode | null } | null;
  errors?: RawError[];
}

interface RawProjectsPage {
  data?: { teams?: { nodes?: { projects?: RawConnection }[] } | null } | null;
  errors?: RawError[];
}

interface RawProjectIssuesPage {
  data?: { project?: { issues?: RawConnection } | null } | null;
  errors?: RawError[];
}

export interface LinearClient {
  listAssignedIssues(opts: { states: string[]; limit?: number; pageSize?: number }): Promise<{ issues: LinearIssue[]; truncated: boolean }>;
  /** the open Issues of these teams that have no assignee at all, read only when a repo asks for them */
  listUnassignedIssues(opts: { teams: string[]; states: string[]; limit?: number; pageSize?: number }): Promise<{ issues: LinearIssue[]; truncated: boolean }>;
  /** one Issue by its identifier (APP-1234), whoever it is assigned to and whatever its state; null when Linear has none */
  getIssue(identifier: string): Promise<LinearIssue | null>;
  /** the Projects of one team, whole (the sync of Projects pairs them with propter's by name and then by id) */
  listTeamProjects(opts: { team: string; limit?: number; pageSize?: number }): Promise<{ projects: LinearProject[]; truncated: boolean }>;
  /** the Issues one Project holds, with whether each is done */
  listProjectIssues(opts: { project: string; limit?: number; pageSize?: number }): Promise<{ issues: LinearSyncIssue[]; truncated: boolean }>;
  /** one Issue by its identifier, for the sync; null when Linear has none */
  getSyncIssue(identifier: string): Promise<LinearSyncIssue | null>;
}

function toIssue(n: RawNode): LinearIssue | null {
  if (!n.identifier || !n.url) return null;
  // an Issue is blocked by the Issues whose `blocks` relation points at it (Linear names the reverse side)
  const blockers = (n.inverseRelations?.nodes ?? []).flatMap((r) => {
    if ((r.type ?? "").toLowerCase() !== "blocks") return [];
    const i = r.issue;
    if (!i?.identifier || !i.url) return [];
    return [{
      identifier: i.identifier,
      title: i.title ?? "",
      url: canonicalLinearUrl(i.url),
      teamKey: i.team?.key ?? i.identifier.split("-")[0],
      stateType: (i.state?.type ?? "").toLowerCase(),
    }];
  });
  return {
    id: n.id ?? "",
    identifier: n.identifier,
    title: n.title ?? "",
    description: n.description ?? "",
    url: canonicalLinearUrl(n.url),
    teamKey: n.team?.key ?? n.identifier.split("-")[0],
    state: n.state?.name ?? "",
    labels: (n.labels?.nodes ?? []).map((l) => l.name ?? "").filter(Boolean),
    createdAt: n.createdAt ?? "",
    updatedAt: n.updatedAt ?? "",
    estimate: typeof n.estimate === "number" ? n.estimate : null,
    priority: typeof n.priority === "number" ? n.priority : 0,
    blockers,
    blockersTruncated: Boolean(n.inverseRelations?.pageInfo?.hasNextPage),
  };
}

function toProject(n: RawNode): LinearProject | null {
  return n.id ? { id: n.id, name: n.name ?? "", description: n.description ?? "", url: n.url ?? "" } : null;
}

/** Linear's WorkflowState types that mean the Issue is done; the names are each team's own */
export const LINEAR_DONE_TYPES: ReadonlySet<string> = new Set(["completed", "canceled", "duplicate"]);
const isDone = (type: string | undefined): boolean => type !== undefined && LINEAR_DONE_TYPES.has(type);

function toSyncIssue(n: RawNode): LinearSyncIssue | null {
  if (!n.identifier) return null;
  return { identifier: n.identifier.toUpperCase(), closed: isDone(n.state?.type), projectId: n.project?.id ?? null };
}

/** Linear answers an identifier it does not know with an input error rather than a null issue */
function isNotFound(e: RawError): boolean {
  return /not found|could not find/i.test(`${e.message ?? ""} ${e.extensions?.userPresentableMessage ?? ""}`);
}

/** the errors of a parsed body, or none when the body is not the shape Linear answers with */
function readErrors(body: unknown): RawError[] {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  return Array.isArray(errors) ? (errors as RawError[]) : [];
}

/**
 * An HTTP refusal. `errors` carries Linear's own words when a 400 body had them, so a caller can treat "not found"
 * as an absent Issue; `message` is what a failure line shows.
 */
class LinearRefusal extends Error {
  readonly status: number;
  readonly errors: RawError[];
  constructor(status: number, errors: RawError[], message: string) {
    super(message);
    this.name = "LinearRefusal";
    this.status = status;
    this.errors = errors;
  }
}

class LinearTimeout extends Error {}

/** settles with `work`, or rejects once `signal` aborts, even when `work` never settles */
function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new LinearTimeout());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LinearTimeout());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

export function createLinearClient(key: string, opts: { fetch?: LinearFetch; timeoutMs?: number } = {}): LinearClient {
  const send: LinearFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? 20000;
  const scrub = (msg: string) => (key ? msg.split(key).join("[redacted]") : msg);
  const late = () => new Error(`Linear API: ${Math.round(timeoutMs / 1000)} 秒で応答がありませんでした`);

  /**
   * A 400 reads Linear's own errors out of its body, so the reason names both the status and the refusal.
   * Every other status is the status alone (401 and 403 keep the key hint). A body that is not JSON is the status alone.
   */
  async function post(name: QueryName, variables: Record<string, unknown>): Promise<unknown> {
    const body = JSON.stringify({ query: queryDocument(name), variables });
    // one deadline for the request and its body, so a server that stalls mid-answer stops too
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Awaited<ReturnType<LinearFetch>>;
    try {
      res = await withDeadline(send(LINEAR_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: key },
        body,
        signal,
      }), signal);
    } catch (err) {
      if (err instanceof LinearTimeout || signal.aborted) throw late();
      throw new Error(scrub(`Linear API に接続できません: ${(err as Error)?.message ?? String(err)}`));
    }
    if (!res.ok && res.status !== 400) {
      const hint = res.status === 401 || res.status === 403 ? "（鍵が無効か権限がありません）" : "";
      throw new Error(`Linear API: HTTP ${res.status}${hint}`);
    }
    let parsed: unknown;
    try {
      parsed = await withDeadline(res.json(), signal);
    } catch (err) {
      if (err instanceof LinearTimeout) throw late();
      throw new Error(res.ok ? "Linear API: 応答が JSON ではありません" : `Linear API: HTTP ${res.status}`);
    }
    if (!res.ok) {
      const errors = readErrors(parsed);
      const detail = errors.map((e) => e.message ?? "error").join("; ");
      throw new LinearRefusal(res.status, errors, detail ? scrub(`Linear API: HTTP ${res.status}: ${detail}`) : `Linear API: HTTP ${res.status}`);
    }
    return parsed;
  }

  const failed = (errors: RawError[]) => new Error(scrub(`Linear API: ${errors.map((e) => e.message ?? "error").join("; ")}`));

  /**
   * Follow one connection by its cursor, up to `limit`, turning each node by `convert` (a node it cannot read is left
   * out). `read` pulls the connection out of an answer (and names it), so a page that lost the connection is told
   * apart from a last page.
   */
  async function pageNodes<T>(
    name: QueryName,
    base: Record<string, unknown>,
    limit: number,
    pageSize: number,
    convert: (n: RawNode) => T | null,
    read: (answer: unknown) => { conn: RawConnection | undefined; errors?: RawError[]; missing: string },
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let after: string | null = null;
    for (;;) {
      const first = Math.max(1, Math.min(pageSize, limit - items.length));
      const answer = await post(name, { ...base, first, after });
      const got = read(answer);
      if (got.errors?.length) throw failed(got.errors);
      if (!got.conn) throw new Error(`Linear API: ${got.missing} が応答にありません`);
      for (const n of got.conn.nodes ?? []) {
        const item = convert(n);
        if (item) items.push(item);
      }
      const more = Boolean(got.conn.pageInfo?.hasNextPage && got.conn.pageInfo.endCursor);
      if (!more) return { items, truncated: false };
      if (items.length >= limit) return { items: items.slice(0, limit), truncated: true };
      after = got.conn.pageInfo!.endCursor!;
    }
  }

  /** one node by its identifier; a 400 that only says Linear has no such node is an absent one (null), not a failure */
  async function getNode<T>(name: QueryName, identifier: string, convert: (n: RawNode) => T | null): Promise<T | null> {
    let one: RawOne;
    try {
      one = (await post(name, { id: identifier })) as RawOne;
    } catch (err) {
      if (err instanceof LinearRefusal && err.errors.length && err.errors.every(isNotFound)) return null;
      throw err;
    }
    // a partial answer (a node together with errors, say a resolver that failed) is never read as a whole Issue: a field
    // that failed would read as "no Project" and be taken for the outside's value
    if (one.errors?.length && (one.data?.issue || !one.errors.every(isNotFound))) throw failed(one.errors);
    const node = one.data?.issue;
    if (node) return convert(node);
    if (!one.errors?.length && one.data?.issue !== null) throw new Error("Linear API: issue が応答にありません");
    return null;
  }

  /** a page's items under the name its caller's result gives them */
  const named = async <K extends string, T>(key: K, page: Promise<{ items: T[]; truncated: boolean }>): Promise<Record<K, T[]> & { truncated: boolean }> => {
    const { items, truncated } = await page;
    return { [key]: items, truncated } as Record<K, T[]> & { truncated: boolean };
  };

  return {
    // both lists read the same per-Issue fields and relations, so the complexity limit bites the same way:
    // Linear refused a 50-wide page of either query and answers a 10-wide one
    async listAssignedIssues({ states, limit = 100, pageSize = 10 }) {
      return named("issues", pageNodes("assignedIssues", { states }, limit, pageSize, toIssue, (answer) => {
        const page = answer as RawPage;
        return { conn: page.data?.viewer?.assignedIssues, errors: page.errors, missing: "assignedIssues" };
      }));
    },

    async listUnassignedIssues({ teams, states, limit = 100, pageSize = 10 }) {
      return named("issues", pageNodes("unassignedIssues", { teams, states }, limit, pageSize, toIssue, (answer) => {
        const page = answer as RawIssuesPage;
        return { conn: page.data?.issues ?? undefined, errors: page.errors, missing: "issues" };
      }));
    },

    async listTeamProjects({ team, limit = 250, pageSize = 25 }) {
      return named("projects", pageNodes("teamProjects", { team }, limit, pageSize, toProject, (answer) => {
        const page = answer as RawProjectsPage;
        return { conn: page.data?.teams?.nodes?.[0]?.projects, errors: page.errors, missing: `チーム ${team} の Project` };
      }));
    },

    async listProjectIssues({ project, limit = 500, pageSize = 25 }) {
      return named("issues", pageNodes("projectIssues", { id: project }, limit, pageSize, toSyncIssue, (answer) => {
        const page = answer as RawProjectIssuesPage;
        return { conn: page.data?.project?.issues, errors: page.errors, missing: "Project の Issue" };
      }));
    },

    getSyncIssue: (identifier) => getNode("syncIssueByIdentifier", identifier, toSyncIssue),

    getIssue: (identifier) => getNode("issueByIdentifier", identifier, toIssue),
  };
}
