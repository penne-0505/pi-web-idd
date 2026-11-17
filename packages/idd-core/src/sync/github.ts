import { execFile } from "node:child_process";

import type { TrackerReader } from "./reader.ts";
import type { ExtIssue, ExtProject, ExtSnapshot } from "./types.ts";

/**
 * GitHub as the outside: a propter Project is a milestone (its number is the pair, so a rename keeps it), an Issue's
 * Project is the Issue's milestone, and an Issue is open or closed. Everything goes through `gh`, which is already
 * signed in; the engine holds no token of its own. Only GET paths are asked for, with no field and no method.
 */

export type GhRun = (args: string[]) => Promise<string>;

export const runGhApi: GhRun = (args) =>
  new Promise((resolve, reject) => {
    execFile(process.env.IDD_GH_BIN?.trim() || "gh", args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr).trim() || err.message));
      resolve(String(stdout));
    });
  });

const PAGE = 100;
/** pages read at most: more than this is reported as truncated, and the Issues propter holds are then read one by one */
const MAX_PAGES = 10;

interface RawMilestone {
  number?: number;
  title?: string;
  description?: string | null;
  html_url?: string;
}

interface RawIssue {
  number?: number;
  state?: string;
  pull_request?: unknown;
  milestone?: { number?: number } | null;
}

function one<T>(text: string): T {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("gh の応答が object ではありません");
  return value as T;
}

/** whether `gh api` failed because GitHub answered that there is no such thing (404, or 410 for a deleted Issue) */
const isAbsent = (err: unknown): boolean => /\bHTTP (404|410)\b/.test(err instanceof Error ? err.message : String(err));

function json<T>(text: string): T {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("gh の応答が一覧ではありません");
  return value as T;
}

/** the number of `owner/name#N` when the ref is this repo's, else null */
export function numberOfRef(ref: string, repo: string): number | null {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref);
  return m && m[1].toLowerCase() === repo.toLowerCase() ? Number(m[2]) : null;
}

export function createGithubReader(repo: string, run: GhRun = runGhApi): TrackerReader {
  async function pages<T>(path: string, query: string): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const got = json<T[]>(await run(["api", `${path}?${query}&per_page=${PAGE}&page=${page}`]));
      items.push(...got);
      if (got.length < PAGE) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  return {
    tracker: "github",
    owns: (ref) => numberOfRef(ref, repo) !== null,

    async read(refs): Promise<ExtSnapshot> {
      const milestones = await pages<RawMilestone>(`repos/${repo}/milestones`, "state=all");
      const issues = await pages<RawIssue>(`repos/${repo}/issues`, "state=all");
      const projects: ExtProject[] = milestones.items.flatMap((m) =>
        typeof m.number === "number" ? [{ id: String(m.number), name: m.title ?? "", body: m.description ?? "", ...(m.html_url ? { url: m.html_url } : {}) }] : []);
      const out: ExtIssue[] = issues.items.flatMap((i) => {
        if (typeof i.number !== "number" || i.pull_request) return [];
        return [{
          ref: `${repo.toLowerCase()}#${i.number}`, closed: i.state === "closed",
          projectId: typeof i.milestone?.number === "number" ? String(i.milestone.number) : null,
        }];
      });
      // The list is cut at MAX_PAGES, and the newest Issues come first, so an Issue propter holds can sit beyond it. Each
      // one no page showed is read by its number: found, it is compared like any other; answered "no such Issue", it is
      // gone; failed (or a pull request), it is unread, and nothing is concluded from it.
      const have = new Set(out.map((i) => i.ref));
      const unread: string[] = [];
      for (const ref of new Set(refs)) {
        const n = numberOfRef(ref, repo);
        if (n === null || have.has(`${repo.toLowerCase()}#${n}`)) continue;
        try {
          const got = one<RawIssue>(await run(["api", `repos/${repo}/issues/${n}`]));
          if (got.number !== n || got.pull_request) { unread.push(ref); continue; }
          out.push({
            ref: `${repo.toLowerCase()}#${n}`, closed: got.state === "closed",
            projectId: typeof got.milestone?.number === "number" ? String(got.milestone.number) : null,
          });
        } catch (err) {
          if (!isAbsent(err)) unread.push(ref);
        }
      }
      return { projects, issues: out, truncated: milestones.truncated || issues.truncated, projectsTruncated: milestones.truncated, ...(unread.length ? { unread } : {}) };
    },
  };
}
