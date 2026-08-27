// intent: DEC-654 — GitHub の起票は gh CLI 経由で読む。engine 側に token を持ち込まない

import { execFileSync } from "node:child_process";

export interface GithubIssue {
  number: number;
  title: string;
  url: string;
  body: string;
  createdAt: string;
  labels: string[];
}

interface RawIssue {
  number: number;
  title: string;
  url: string;
  body?: string;
  createdAt: string;
  labels?: { name: string }[];
}

export function listIssues(repo: string, labels: string[], limit = 50): GithubIssue[] {
  const args = [
    "issue", "list",
    "--repo", repo,
    "--state", "open",
    "--limit", String(limit),
    "--json", "number,title,url,body,createdAt,labels",
  ];
  for (const label of labels) args.push("--label", label);

  let out: string;
  try {
    out = execFileSync("gh", args, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new Error(`gh issue list ${repo}: ${(err as Error).message}`);
  }

  const parsed = JSON.parse(out) as RawIssue[];
  return parsed.map((issue) => ({
    number: issue.number,
    title: issue.title,
    url: issue.url,
    body: issue.body ?? "",
    createdAt: issue.createdAt,
    labels: (issue.labels ?? []).map((l) => l.name),
  }));
}
