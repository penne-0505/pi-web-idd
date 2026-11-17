
import { execFileSync } from "node:child_process";

import type { BlockerState } from "../schema/records.ts";

/** a dependency the GitHub list reported on an Issue */
export interface GithubBlocker {
  /** the node's number, or the number its url names; null when the node named neither */
  number: number | null;
  title: string;
  url: string;
  /** owner/name the blocker is in, from `repository.nameWithOwner` or the url; null when it named neither */
  repo: string | null;
  state: BlockerState;
}

export interface GithubIssue {
  number: number;
  title: string;
  url: string;
  body: string;
  createdAt: string;
  labels: string[];
  /** the Issues this Issue is blocked by, as the same call read them (a missing state is filled in) */
  blockers: GithubBlocker[];
  /** the call returned more blockers than it read (its `totalCount` is larger than its nodes) */
  blockersTruncated: boolean;
}

interface RawBlocker {
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  repository?: { nameWithOwner?: string } | null;
}

/** the owner/name a GitHub Issue url names (`/<owner>/<name>/issues/<n>`), or null when it names none */
function repoOfBlockerUrl(url: string | undefined): string | null {
  const m = /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/issues\/\d+\/?$/.exec(url ?? "");
  return m ? m[1] : null;
}

/** the Issue number a GitHub Issue url names, or null when it names none */
function numberOfBlockerUrl(url: string | undefined): number | null {
  const m = /\/issues\/(\d+)\/?$/.exec(url ?? "");
  return m ? Number(m[1]) : null;
}

interface RawIssue {
  number: number;
  title: string;
  url: string;
  body?: string;
  createdAt: string;
  labels?: { name: string }[];
  blockedBy?: { nodes?: RawBlocker[] | null; totalCount?: number | null } | null;
}

/** gh's GraphQL enum is OPEN / CLOSED; anything else is not a state this module trusts */
function blockerState(raw: string | undefined): BlockerState {
  const s = (raw ?? "").trim().toUpperCase();
  if (s === "OPEN") return "open";
  if (s === "CLOSED") return "closed";
  return "unknown";
}

/**
 * One blocker's state, closed ones included, read with the repo named (a bare number resolves against the
 * caller's cwd repo). null when gh cannot answer; the caller reads that as an unreadable blocker, not a closed one.
 */
export function readBlockerState(repo: string, number: number): BlockerState | null {
  let out: string;
  try {
    out = execFileSync("gh", ["api", "--method", "GET", `repos/${repo}/issues/${number}`], {
      encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  try {
    const state = String((JSON.parse(out) as { state?: string }).state ?? "").toLowerCase();
    if (state === "open") return "open";
    if (state === "closed") return "closed";
    return null;
  } catch {
    return null;
  }
}

export function listIssues(repo: string, labels: string[], limit = 50): GithubIssue[] {
  const args = [
    "issue", "list",
    "--repo", repo,
    "--state", "open",
    "--limit", String(limit),
    "--json", "number,title,url,body,createdAt,labels,blockedBy",
  ];
  for (const label of labels) args.push("--label", label);

  let out: string;
  try {
    out = execFileSync("gh", args, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new Error(`gh issue list ${repo}: ${(err as Error).message}`);
  }

  const parsed = JSON.parse(out) as RawIssue[];
  return parsed.map((issue) => {
    const read = blockersOf(issue.blockedBy, repo);
    return {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      body: issue.body ?? "",
      createdAt: issue.createdAt,
      labels: (issue.labels ?? []).map((l) => l.name),
      blockers: read.blockers,
      blockersTruncated: read.truncated,
    };
  });
}

/** the blockers one `blockedBy` connection names, each placed by repo and number (the list and the single read share this) */
function blockersOf(blockedBy: RawIssue["blockedBy"], repo: string): { blockers: GithubBlocker[]; truncated: boolean } {
  const nodes = blockedBy?.nodes ?? [];
  const blockers: GithubBlocker[] = [];
  for (const b of nodes) {
    // gh 2.101 drops `repository` from a blocker; the url names the Issue, so it is the fallback
    const namedRepo = typeof b.repository?.nameWithOwner === "string" ? b.repository.nameWithOwner : "";
    const repoName = namedRepo || repoOfBlockerUrl(b.url);
    const number = typeof b.number === "number" ? b.number : numberOfBlockerUrl(b.url);
    // a node that named neither a repo nor a number cannot be placed: it holds rather than being dropped
    const unreadable = repoName === null || number === null;
    let state: BlockerState = unreadable ? "unknown" : blockerState(b.state);
    // the list carries a same-repo blocker's state; only when it did not is that one blocker read again
    if (repoName !== null && number !== null && b.state === undefined && repoName.toLowerCase() === repo.toLowerCase()) {
      state = readBlockerState(repoName, number) ?? "unknown";
    }
    // an unplaced node keeps no repo: the scope stays empty, so a reader sees it was not placed
    blockers.push({ number, title: b.title ?? "", url: b.url ?? "", repo: repoName !== null && number !== null ? repoName : null, state });
  }
  const total = blockedBy?.totalCount;
  return { blockers, truncated: typeof total === "number" && total > nodes.length };
}

/** one Issue of the REST dependencies list (`.../dependencies/blocked_by`): the fields this module reads */
interface RawDependency {
  number?: number;
  title?: string;
  html_url?: string;
  state?: string;
  /** https://api.github.com/repos/<owner>/<name> */
  repository_url?: string;
}

/** how many dependencies one GET reads; more than that is reported as truncated, and the Issue is held like a long list */
const DEPENDENCIES_PAGE = 100;

/**
 * The dependencies of one Issue read by number, so a lane taken in by name keeps them too and its GO waits on them.
 * Read with the REST list of the Issue's blockers (only ever a GET, like the Issue itself), which carries each
 * blocker's state. A gh that cannot answer leaves the Issue with none: naming an Issue still takes it in, and its GO
 * then has no recorded dependency to wait on.
 */
function readIssueBlockers(repo: string, number: number): { blockers: GithubBlocker[]; truncated: boolean } {
  let out: string;
  try {
    out = execFileSync("gh", ["api", "--method", "GET", `repos/${repo}/issues/${number}/dependencies/blocked_by`, "-f", `per_page=${DEPENDENCIES_PAGE}`], {
      encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return { blockers: [], truncated: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { blockers: [], truncated: false };
  }
  if (!Array.isArray(parsed)) return { blockers: [], truncated: false };
  const blockers: GithubBlocker[] = (parsed as RawDependency[]).map((d) => {
    const fromApi = /\/repos\/([\w.-]+\/[\w.-]+)\/?$/.exec(d.repository_url ?? "");
    const repoName = fromApi ? fromApi[1] : repoOfBlockerUrl(d.html_url);
    const num = typeof d.number === "number" ? d.number : numberOfBlockerUrl(d.html_url);
    const placed = repoName !== null && num !== null;
    const state = String(d.state ?? "").toLowerCase();
    return {
      number: num, title: d.title ?? "", url: d.html_url ?? "", repo: placed ? repoName : null,
      state: !placed ? "unknown" : state === "open" ? "open" : state === "closed" ? "closed" : "unknown",
    };
  });
  return { blockers, truncated: blockers.length >= DEPENDENCIES_PAGE };
}

interface RawRestIssue {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  created_at: string;
  state: string;
  labels?: ({ name?: string } | string)[];
  pull_request?: unknown;
}

/** an Issue read by number: found, not an open Issue of that repo, or transferred to another place */
export type IssueRead = { issue: GithubIssue } | { missing: true } | { movedTo: string; title: string };

/**
 * One Issue by number, whatever its labels. Missing when the repo has no such Issue, or the number is a pull
 * request or a closed Issue. gh follows the redirect of a transferred Issue, so an answer from another place than
 * the one asked for is reported as moved, not as an Issue of this repo. Only ever a GET.
 */
export function readIssue(repo: string, number: number): IssueRead {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number < 1) return { missing: true };
  let out: string;
  try {
    out = execFileSync("gh", ["api", "--method", "GET", `repos/${repo}/issues/${number}`], {
      encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (/HTTP (404|410)\b/.test(stderr)) return { missing: true };
    throw new Error(`gh api ${repo}#${number}: ${stderr.trim() || (err as Error).message}`);
  }
  const issue = JSON.parse(out) as RawRestIssue;
  if (issue.pull_request || issue.state !== "open") return { missing: true };
  const asked = `https://github.com/${repo}/issues/${number}`;
  if (String(issue.html_url ?? "").toLowerCase() !== asked.toLowerCase()) {
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/i.exec(String(issue.html_url ?? ""));
    return { movedTo: m ? `${m[1]}#${m[2]}` : String(issue.html_url ?? ""), title: issue.title ?? "" };
  }
  const deps = readIssueBlockers(repo, number);
  return { issue: {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    body: issue.body ?? "",
    createdAt: issue.created_at,
    labels: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
    // an Issue named by number is not held at intake, but its dependencies ride with the lane: its GO waits on them
    blockers: deps.blockers,
    blockersTruncated: deps.truncated,
  } };
}
