import { readBacklog } from "../ledger/read.ts";
import { canonicalLinearUrl } from "./linear.ts";
import { ignoreLane, ignoreTargetOfLane, issueKeyOf, listIgnored, readIgnores, refOfIssueUrl, setIgnored, type IgnoreTarget } from "./ignore.ts";
import { closedLaneIds, listIntakeCandidates, parseIssueRef, type IssueRef, type LinearIntakeDeps } from "./run.ts";

const GH_ISSUE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/;

function linearIdentifierOf(url: string): string | null {
  const m = /\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)$/.exec(canonicalLinearUrl(url));
  return m ? m[1].toUpperCase() : null;
}

/** whether a URL is the Issue a ref names (a bare number matches that number in any repo) */
function urlMatches(url: string, ref: IssueRef): boolean {
  if ("identifier" in ref) return linearIdentifierOf(url) === ref.identifier;
  const gh = GH_ISSUE.exec(url);
  return Boolean(gh) && Number(gh![2]) === ref.number && (!ref.repo || gh![1] === ref.repo);
}

const repoOf = (url: string) => GH_ISSUE.exec(url)?.[1];

/** the one Issue among the found, or an error when a bare ref names Issues in more than one place */
function one<T extends { url: string }>(found: T[], token: string): T | { error: string } | null {
  const urls = [...new Set(found.map((f) => f.url))];
  if (!urls.length) return null;
  if (urls.length > 1) return { error: `${token} に当たる起票が複数あります（${urls.join(", ")}）。owner/name#N で指定してください` };
  return found.filter((f) => f.url === urls[0]).pop()!;
}

/** as intake names it, and as the lists show it (#12) */
function parsed(token: string): IssueRef | { error: string } {
  return parseIssueRef(token.trim().replace(/^#(?=\d+$)/, "")) ?? { error: `Issue は番号か owner/name#N、Linear の識別子（APP-1234）で指定してください: ${token}` };
}

/** where an ignore names its target: a lane (with its Issue when it has one), or an Issue that no lane holds */
export type ResolvedIgnore =
  /**
   * The token was the lane's own ID. A lane already closed is refused and nothing is written (the lane's own close
   * is what the caller asked for, and a half done lane is not what the list is for); a ref is the way onto the list.
   */
  | { via: "lane"; lane: string; target: IgnoreTarget | null }
  /**
   * The token named an Issue. Its open lane, if it has one, is closed first; when every lane of it is closed, the
   * Issue only goes on the list (that is how a ref puts an Issue on after its lane's close, or after a close whose
   * list write failed).
   */
  | { via: "issue"; target: IgnoreTarget; lane?: string };

/**
 * What `idd ignore` and the lane list's screen name: a lane of the backlog (by its own IDD id, or by the Issue it
 * was taken in from) or an Issue with no lane (from the list, or from what intake reads now). A bare number is
 * taken only when one repo has it across all three. A lane's ID is read as a lane before anything else: Linear's
 * identifiers have the same shape (`IDD-034` names the lane, not a Linear team IDD's Issue). A lane's ID and an
 * Issue's ref are told apart in what they do to the lane: the ID closes that lane (and is refused when it cannot),
 * a ref closes the Issue's open lane when there is one and puts the Issue on the list either way.
 */
export async function resolveIgnoreTarget(token: string, deps: LinearIntakeDeps = {}): Promise<ResolvedIgnore | { error: string }> {
  const named = readBacklog().find((r) => r.idd_id === token.trim());
  if (named) return { via: "lane", lane: named.idd_id, target: ignoreTargetOfLane(named) };

  const first = parsed(token);
  if ("error" in first) return first;
  let ref: IssueRef = first;
  let listed: Awaited<ReturnType<typeof listIntakeCandidates>> | undefined;
  const candidates = async () => (listed ??= await listIntakeCandidates(deps));
  if ("number" in ref && !ref.repo) {
    const bare = ref;
    const urls = [
      ...readBacklog().flatMap((rec) => { const k = issueKeyOf(rec); return k ? [k.url] : []; }),
      ...readIgnores().map((r) => r.url),
      ...(await candidates()).candidates.map((c) => c.url),
    ].filter((u) => urlMatches(u, bare));
    const repos = [...new Set(urls.map(repoOf).filter((r): r is string => Boolean(r)))];
    if (repos.length > 1) return { error: `#${bare.number} は ${repos.join(", ")} にあります。owner/name#${bare.number} で指定してください` };
    if (repos.length === 1) ref = { repo: repos[0], number: bare.number };
  }
  const laneRecs = readBacklog().flatMap((rec) => {
    const key = issueKeyOf(rec);
    return key && urlMatches(key.url, ref) ? [{ url: key.url, rec }] : [];
  });
  const lanes = one(laneRecs, token);
  if (lanes && "error" in lanes) return lanes;
  // the Issue's lanes: an open one is closed first, and only an open one
  if (lanes) {
    const closed = closedLaneIds();
    const open = laneRecs.filter((l) => !closed.has(l.rec.idd_id));
    const newest = laneRecs[laneRecs.length - 1].rec;
    const target = ignoreTargetOfLane(newest);
    if (!target) return { error: `${token} の起票が lane の記録にありません` };
    return { via: "issue", target, ...(open.length ? { lane: open[open.length - 1].rec.idd_id } : {}) };
  }

  const lines = one(readIgnores().filter((r) => urlMatches(r.url, ref)), token);
  if (lines && "error" in lines) return lines;
  if (lines) return { via: "issue", target: { source: lines.source, url: lines.url, ...(lines.linear_id ? { linearId: lines.linear_id } : {}), ref: lines.ref, title: lines.title, ...(lines.area ? { area: lines.area } : {}) } };

  const list = await candidates();
  const found = one(list.candidates.filter((c) => urlMatches(c.url, ref)), token);
  if (found && "error" in found) return found;
  // Linear's id goes on the line with the URL: the Issue keeps it when it moves to another team
  if (found) return { via: "issue", target: { source: found.source, url: found.url, ...(found.linearId ? { linearId: found.linearId } : {}), ref: found.ref, title: found.title, area: found.area } };
  const why = list.failures.length ? `（読めなかった取り込み元: ${list.failures.map((f) => f.area).join(", ")}）` : "";
  return { error: `${token} は lane にも取り込みの候補にもありません${why}` };
}

/** the Issue on the list a ref names, to take off: looked up on the list alone */
function resolveListed(token: string): IgnoreTarget | { error: string } {
  const ref = parsed(token);
  if ("error" in ref) return ref;
  const found = one(listIgnored().filter((i) => urlMatches(i.url, ref)), token);
  if (!found) return { error: `${token} は無視リストにありません` };
  if ("error" in found) return found;
  const line = [...readIgnores()].reverse().find((r) => r.url === found.url);
  return { source: found.source, url: found.url, ...(line?.linear_id ? { linearId: line.linear_id } : {}), ref: found.ref, title: found.title, ...(found.area ? { area: found.area } : {}) };
}

/** what one `idd ignore` / screen write did, for the caller's own words */
export type IgnoreRefResult =
  | {
    ok: true;
    /** the list changed (false: already on it, or a lane with no Issue to put on) */
    changed: boolean;
    /** the Issue put on the list; absent for a lane taken in from no Issue */
    target?: IgnoreTarget;
    /** the lane that was closed, if the ref named one */
    lane?: string;
    /** the lane was closed, but a part that goes with it was not */
    warning?: string;
  }
  | {
    ok: false;
    error: string;
    /** an open lane this ref would close: the caller has to have it confirmed (the screen's confirm step) */
    needsConfirm?: string;
  };

/** how the caller stands to the lane a ref would close */
export interface IgnoreConfirm {
  /**
   * The lane the caller was told this ref would close (the screen's confirm). `null`: the caller was told no lane
   * is at stake. Left out, the caller needs no confirmation: the CLI's `idd ignore` is a person's own command.
   */
  confirmedLane?: string | null;
}

/**
 * `idd ignore` / `idd unignore` and the screen: the ref is resolved, then the lane closed (when the ref named an
 * Issue with an open lane) before its Issue goes on the list. Taking off is looked up on the list alone and never
 * touches a lane. With `confirmedLane`, a lane is closed only when it is the one the caller was told about: an
 * unconfirmed or stale write is refused before anything is written, so a press can never close a lane the screen
 * did not show.
 */
export async function ignoreByRef(action: "ignore" | "unignore", token: string, deps: LinearIntakeDeps & IgnoreConfirm = {}): Promise<IgnoreRefResult> {
  const { confirmedLane, ...intakeDeps } = deps;
  if (action === "unignore") {
    const target = resolveListed(token);
    if ("error" in target) return { ok: false, error: target.error };
    const off = await setIgnored("unignore", target);
    return off.ok ? { ok: true, changed: off.changed, target: off.target } : { ok: false, error: off.error };
  }
  const named = await resolveIgnoreTarget(token, intakeDeps);
  if ("error" in named) return { ok: false, error: named.error };
  // what this ref would close, against what the caller was told: a mismatch is refused with the lane to confirm.
  // A lane's own ID that is closed already closes nothing (the close is refused on its own), so it is not at stake
  const atStake = named.via === "lane"
    ? (closedLaneIds().has(named.lane) ? null : named.lane)
    : (named.lane ?? null);
  if (confirmedLane !== undefined && (atStake ?? null) !== (confirmedLane ?? null)) {
    if (atStake) return { ok: false, error: `${atStake} を閉じます。確認してからもう一度押してください`, needsConfirm: atStake };
    return { ok: false, error: `${confirmedLane} は既に閉じています。起票だけを載せるには、もう一度押してください` };
  }
  const close = async (lane: string, target: IgnoreTarget | null): Promise<IgnoreRefResult> => {
    const r = await ignoreLane(lane);
    if (!r.ok) return { ok: false, error: r.error ?? `${lane} を閉じられませんでした` };
    // a refused close writes nothing to the list; the lane's own line (if it has an Issue) is what was written here
    return {
      ok: true,
      changed: r.list?.ok ? r.list.changed : false,
      lane,
      ...(target ? { target } : {}),
      ...(r.warning ? { warning: r.warning } : {}),
    };
  };
  // the lane's own ID: that lane is what the caller asked for, and a close that is refused writes nothing
  if (named.via === "lane") return close(named.lane, named.target);
  // an Issue's ref: its open lane is closed first; with every lane closed it only goes on the list
  if (named.lane) return close(named.lane, named.target);
  const on = await setIgnored("ignore", named.target);
  return on.ok ? { ok: true, changed: on.changed, target: on.target } : { ok: false, error: on.error };
}

/** what an ignore of a ref would do, from the state alone: the screen asks this before it presses */
export interface IgnorePreview {
  /** which form the token took: the lane's own ID, or an Issue's ref */
  via: "lane" | "issue";
  /** the open lane the ignore would close, and whose sessions and runs it would stop */
  lane?: string;
  /** a lane of that Issue (or the lane the ID names) that is closed already */
  closed?: string;
  ref?: string;
  title?: string;
}

export function ignorePreview(token: string): IgnorePreview | { error: string } {
  const named = readBacklog().find((r) => r.idd_id === token.trim());
  if (named) {
    const closed = closedLaneIds().has(named.idd_id);
    return {
      via: "lane",
      ...(closed ? { closed: named.idd_id } : { lane: named.idd_id }),
      ref: refOfIssueUrl(issueKeyOf(named)?.url ?? "") || named.idd_id,
      title: named.title,
    };
  }
  const ref = parsed(token);
  if ("error" in ref) return { error: ref.error };
  const laneRecs = readBacklog().flatMap((rec) => {
    const key = issueKeyOf(rec);
    return key && urlMatches(key.url, ref) ? [{ url: key.url, rec }] : [];
  });
  if (!laneRecs.length) return { via: "issue" };
  const closed = closedLaneIds();
  const newest = laneRecs[laneRecs.length - 1].rec;
  const open = laneRecs.filter((l) => !closed.has(l.rec.idd_id));
  return {
    via: "issue",
    ...(open.length ? { lane: open[open.length - 1].rec.idd_id } : { closed: newest.idd_id }),
    ref: refOfIssueUrl(issueKeyOf(newest)?.url ?? ""),
    title: newest.title,
  };
}
