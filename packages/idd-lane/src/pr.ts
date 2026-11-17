import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { postedReplyUrls } from "./outbound.ts";
import { expandHome } from "./paths.ts";
import type { LabelSwap } from "./repos.ts";

function gh(args: string[], input?: string): string {
  return execFileSync(process.env.IDD_GH_BIN?.trim() || "gh", args, { encoding: "utf8", timeout: 120000, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], ...(input !== undefined ? { input } : {}) });
}

export interface PrContext {
  number: number;
  repo: string;
  title: string;
  author: string;
  base: string;
  head_ref: string;
  head: string;
  state: string;
  draft: boolean;
  mergeable: string;
  labels: string[];
  files: number;
  additions: number;
  deletions: number;
  reviews: { author: string; state: string; submitted_at: string }[];
  threads: { total: number; unresolved: number };
  comments_since: number;
  written: string[];
}

/** Fetch body, comments, reviews and threads into <out>/ as files; returns a summary. */
export function fetchPrContext(repo: string, number: number, out: string, opts: { since?: string } = {}): PrContext {
  const dir = resolve(expandHome(out));
  mkdirSync(dir, { recursive: true });
  const view = JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", "title,author,baseRefName,headRefName,headRefOid,state,isDraft,mergeable,labels,changedFiles,additions,deletions,body,comments,reviews"])) as {
    title: string; author: { login: string }; baseRefName: string; headRefName: string; headRefOid: string; state: string; isDraft: boolean; mergeable: string;
    labels: { name: string }[]; changedFiles: number; additions: number; deletions: number; body: string;
    comments: { author: { login: string }; createdAt: string; body: string }[];
    reviews: { author: { login: string }; state: string; submittedAt: string; body: string }[];
  };
  const written: string[] = [];
  const w = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); written.push(p); };
  w("body.md", view.body ?? "");
  w("meta.json", `${JSON.stringify({ number, repo, title: view.title, author: view.author.login, base: view.baseRefName, head_ref: view.headRefName, head: view.headRefOid, state: view.state, draft: view.isDraft, mergeable: view.mergeable, labels: view.labels.map((l) => l.name), fetched_at: new Date().toISOString() }, null, 2)}\n`);
  const comments = view.comments ?? [];
  w("comments.md", comments.map((c) => `${c.author.login} ${c.createdAt}\n${c.body}\n---`).join("\n"));
  w("comments.json", `${JSON.stringify(comments.map((c) => ({ author: c.author.login, created_at: c.createdAt, body: c.body })), null, 2)}\n`);
  const since = opts.since ? comments.filter((c) => c.createdAt > opts.since!) : [];
  if (opts.since) w("comments-since.md", since.map((c) => `${c.author.login} ${c.createdAt}\n${c.body}\n---`).join("\n"));
  w("reviews.md", (view.reviews ?? []).map((r) => `${r.author.login} ${r.state} ${r.submittedAt}\n${r.body}\n---`).join("\n"));
  // review threads (inline) with resolved state
  const q = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(last:100){nodes{id isResolved isOutdated path line comments(last:50){nodes{author{login} createdAt body}}}}}}}`;
  const [owner, name] = repo.split("/");
  let threads: { id: string; isResolved: boolean; isOutdated: boolean; path: string; line: number | null; comments: { nodes: { author: { login: string }; createdAt: string; body: string }[] } }[] = [];
  try {
    const res = JSON.parse(gh(["api", "graphql", "-f", `query=${q}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${number}`])) as { data: { repository: { pullRequest: { reviewThreads: { nodes: typeof threads } } } } };
    threads = res.data.repository.pullRequest.reviewThreads.nodes ?? [];
  } catch { threads = []; }
  w("threads.json", `${JSON.stringify(threads.map((t) => ({ id: t.id, resolved: t.isResolved, outdated: t.isOutdated, path: t.path, line: t.line, comments: t.comments.nodes.map((c) => ({ author: c.author.login, created_at: c.createdAt, body: c.body })) })), null, 2)}\n`);
  w("threads.md", threads.map((t) => `### ${t.path}:${t.line ?? "?"} ${t.isResolved ? "[resolved]" : "[open]"}${t.isOutdated ? " [outdated]" : ""}\n${t.comments.nodes.map((c) => `- ${c.author.login} ${c.createdAt}: ${c.body.replace(/\n/g, "\n  ")}`).join("\n")}\n`).join("\n"));
  return {
    number, repo, title: view.title, author: view.author.login, base: view.baseRefName, head_ref: view.headRefName, head: view.headRefOid, state: view.state, draft: view.isDraft, mergeable: view.mergeable,
    labels: view.labels.map((l) => l.name), files: view.changedFiles, additions: view.additions, deletions: view.deletions,
    reviews: (view.reviews ?? []).map((r) => ({ author: r.author.login, state: r.state, submitted_at: r.submittedAt })),
    threads: { total: threads.length, unresolved: threads.filter((t) => !t.isResolved).length },
    comments_since: since.length, written,
  };
}

export type ReviewEvent = "approve" | "comment" | "request-changes";

/** The AI marker a review body must not carry; `idd pr post` checks it too, before it makes the card. */
export const AI_MARKER = "🤖 AIが作成したPR本文です";

export interface PostOptions {
  event: ReviewEvent;
  bodyFile: string;
  /** refuse to post unless the PR head equals this sha (prefix ok) */
  expectHead: string;
  /**
   * labels changed along with the post (the repo's review_labels, or what penne kept of them on the
   * card). Made only when the PR carries one of `onlyWith` (default: the labels it takes off), so a
   * PR that is not waiting for review keeps its labels; with nothing to take off, always made.
   */
  labels?: LabelSwap & { onlyWith?: string[] };
  dryRun?: boolean;
}

export interface PostResult {
  number: number;
  event: ReviewEvent;
  head: string;
  posted: boolean;
  labels_before: string[];
  labels_after: string[];
  first_line: string;
  /** the review went out but the label swap failed: reported, not thrown, so nobody posts the review again */
  label_error?: string;
}

/** Post a review as the gh-authenticated user. Head is verified first; labels change only as `labels` says. */
export function postReview(repo: string, number: number, opts: PostOptions): PostResult {
  const body = readFileSync(resolve(expandHome(opts.bodyFile)), "utf8");
  // an approve may go without a body ("approve only"); comments and change requests need one
  if (!body.trim() && opts.event !== "approve") throw new Error("本文が空です");
  if (body.includes(AI_MARKER)) throw new Error("本文に AI マーカーが残っています");
  const view = JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid,labels"])) as { headRefOid: string; labels: { name: string }[] };
  if (!view.headRefOid.startsWith(opts.expectHead)) throw new Error(`head が変わっています: 期待 ${opts.expectHead} / 実際 ${view.headRefOid.slice(0, 9)}。取り直してから投稿してください`);
  const labelsBefore = view.labels.map((l) => l.name);
  const firstLine = body.split("\n").find((l) => l.trim()) ?? "";
  if (opts.dryRun) return { number, event: opts.event, head: view.headRefOid, posted: false, labels_before: labelsBefore, labels_after: labelsBefore, first_line: firstLine };
  const flag = opts.event === "approve" ? "--approve" : opts.event === "comment" ? "--comment" : "--request-changes";
  gh(["pr", "review", String(number), "--repo", repo, flag, ...(body.trim() ? ["--body-file", resolve(expandHome(opts.bodyFile))] : [])]);
  let labelsAfter = labelsBefore;
  let labelError: string | undefined;
  const swap = opts.labels;
  const onlyWith = swap?.onlyWith ?? swap?.remove ?? [];
  if (swap && (!onlyWith.length || onlyWith.some((l) => labelsBefore.includes(l)))) {
    const remove = swap.remove.filter((l) => labelsBefore.includes(l));
    if (remove.length || swap.add.length) {
      try {
        gh(["pr", "edit", String(number), "--repo", repo, ...remove.flatMap((l) => ["--remove-label", l]), ...swap.add.flatMap((l) => ["--add-label", l])]);
        labelsAfter = [...new Set(labelsBefore.filter((l) => !remove.includes(l)).concat(swap.add))];
      } catch (err) {
        const e = err as { stderr?: unknown; message?: string };
        labelError = String(e.stderr ?? "").trim() || e.message || String(err);
      }
    }
  }
  return { number, event: opts.event, head: view.headRefOid, posted: true, labels_before: labelsBefore, labels_after: labelsAfter, first_line: firstLine, ...(labelError ? { label_error: labelError } : {}) };
}

export function prHead(repo: string, number: number): string {
  return (JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid"])) as { headRefOid: string }).headRefOid;
}

/** the PR's title and body as GitHub has them now */
export function prText(repo: string, number: number): { title: string; body: string } {
  const v = JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", "title,body"])) as { title?: string; body?: string };
  return { title: String(v.title ?? ""), body: String(v.body ?? "") };
}

/** Write the PR's body from a file, and its title when one is given. */
export function editPrText(repo: string, number: number, opts: { bodyFile: string; title?: string }): void {
  gh(["pr", "edit", String(number), "--repo", repo, ...(opts.title !== undefined ? ["--title", opts.title] : []), "--body-file", resolve(expandHome(opts.bodyFile))]);
}

export function ensureDir(p: string): string {
  const abs = resolve(expandHome(p));
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  return abs;
}

export interface PrStatus { head: string; state: "OPEN" | "MERGED" | "CLOSED"; title: string; url: string }

export function prStatus(repo: string, number: number): PrStatus {
  const v = JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid,state,title,url"])) as { headRefOid: string; state: string; title: string; url: string };
  return { head: v.headRefOid, state: (["OPEN", "MERGED", "CLOSED"].includes(v.state) ? v.state : "OPEN") as PrStatus["state"], title: v.title, url: v.url };
}

export type FeedbackKind = "thread" | "review" | "comment" | "ci";

export interface FeedbackItem {
  /** stable across polls: the GitHub node id of the comment / review, or the check name at a head */
  id: string;
  kind: FeedbackKind;
  author: string;
  body: string;
  url: string;
  created_at: string;
  /** thread: the review thread a reply goes to, and where it points */
  thread_id?: string;
  path?: string;
  line?: number | null;
}

interface RawAuthor { login?: string }
interface RawComment { id: string; url: string; author: RawAuthor | null; createdAt: string; body: string }
export interface RawPrFeedback {
  author: RawAuthor | null;
  headRefOid: string;
  comments: { nodes: RawComment[] };
  reviews: { nodes: (RawComment & { state: string; submittedAt?: string })[] };
  reviewThreads: { nodes: { id: string; isResolved: boolean; path: string; line: number | null; comments: { nodes: RawComment[] } }[] };
}
export interface RawCheck { name: string; bucket?: string; state?: string; link?: string }

/**
 * What the lane has to answer: review bodies, comments, the comments of unresolved threads that still wait
 * for an answer (the last word is not the harness's reply), and failed checks. The PR author's own comments
 * count too, since on a solo repo the reviewer is the author; only what the harness posted (`ours`, by url)
 * is left out.
 */
export function feedbackFrom(raw: RawPrFeedback, checks: RawCheck[], ours: Set<string> = new Set()): { author: string; head: string; items: FeedbackItem[] } {
  const author = raw.author?.login ?? "";
  const login = (a: RawAuthor | null) => a?.login ?? "ghost";
  const notOurs = (c: RawComment) => !ours.has(c.url) && c.body.trim() !== "";
  const items: FeedbackItem[] = [];
  for (const r of raw.reviews?.nodes ?? []) {
    if (notOurs(r)) items.push({ id: r.id, kind: "review", author: login(r.author), body: r.body, url: r.url, created_at: r.submittedAt ?? r.createdAt });
  }
  for (const c of raw.comments?.nodes ?? []) {
    if (notOurs(c)) items.push({ id: c.id, kind: "comment", author: login(c.author), body: c.body, url: c.url, created_at: c.createdAt });
  }
  for (const t of raw.reviewThreads?.nodes ?? []) {
    const cs = t.comments?.nodes ?? [];
    if (t.isResolved || !cs.length || ours.has(cs[cs.length - 1].url)) continue;
    for (const c of cs.filter(notOurs)) {
      items.push({ id: c.id, kind: "thread", author: login(c.author), body: c.body, url: c.url, created_at: c.createdAt, thread_id: t.id, path: t.path, line: t.line });
    }
  }
  for (const ch of checks) {
    const failed = ch.bucket ? ch.bucket === "fail" : ["FAILURE", "ERROR", "TIMED_OUT"].includes(String(ch.state));
    if (failed) items.push({ id: `ci:${ch.name}@${raw.headRefOid}`, kind: "ci", author: "ci", body: `${ch.name} が失敗`, url: ch.link ?? "", created_at: "" });
  }
  return { author, head: raw.headRefOid, items };
}

/** the failed log of a check run, cut to the tail; empty when it cannot be read */
function failedLog(repo: string, link: string): string {
  const run = /\/actions\/runs\/(\d+)/.exec(link)?.[1];
  if (!run) return "";
  try {
    const out = gh(["run", "view", run, "--repo", repo, "--log-failed"]);
    return out.split("\n").slice(-120).join("\n");
  } catch {
    return "";
  }
}

/** Read the PR's feedback for its author (see feedbackFrom); failed checks carry the tail of their log. */
export async function fetchPrFeedback(repo: string, number: number): Promise<{ author: string; head: string; items: FeedbackItem[] }> {
  const q = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){author{login} headRefOid comments(last:100){nodes{id url author{login} createdAt body}} reviews(last:100){nodes{id url author{login} createdAt submittedAt state body}} reviewThreads(last:100){nodes{id isResolved path line comments(last:50){nodes{id url author{login} createdAt body}}}}}}}`;
  const [owner, name] = repo.split("/");
  const res = JSON.parse(gh(["api", "graphql", "-f", `query=${q}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${number}`])) as { data: { repository: { pullRequest: RawPrFeedback } } };
  let checks: RawCheck[] = [];
  try {
    checks = JSON.parse(gh(["pr", "checks", String(number), "--repo", repo, "--json", "name,bucket,state,link"])) as RawCheck[];
  } catch (err) {
    // gh exits non-zero when a check failed or none exist; the JSON is still on stdout
    const out = String((err as { stdout?: string }).stdout ?? "").trim();
    try { checks = out ? (JSON.parse(out) as RawCheck[]) : []; } catch { checks = []; }
  }
  const fb = feedbackFrom(res.data.repository.pullRequest, checks, postedReplyUrls(repo, number));
  for (const it of fb.items) if (it.kind === "ci" && it.url) it.body = `${it.body}\n\n${failedLog(repo, it.url)}`.trim();
  return fb;
}

/** Reply in a review thread, and resolve it when asked. Returns the reply's url. */
export function replyToThread(threadId: string, body: string, resolveIt: boolean): string {
  const m = `mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{url}}}`;
  const res = JSON.parse(gh(["api", "graphql", "-f", `query=${m}`, "-f", `t=${threadId}`, "-f", `b=${body}`])) as { data: { addPullRequestReviewThreadReply: { comment: { url: string } } } };
  if (resolveIt) {
    gh(["api", "graphql", "-f", "query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}", "-f", `t=${threadId}`]);
  }
  return res.data.addPullRequestReviewThreadReply.comment.url;
}

/** A reply to one review comment by its REST id: GitHub puts it in that comment's thread. Returns its url. */
export function replyToComment(repo: string, number: number, commentId: string, body: string): string {
  const res = JSON.parse(gh(["api", "-X", "POST", `repos/${repo}/pulls/${number}/comments/${commentId}/replies`, "-f", `body=${body}`])) as { html_url?: string };
  if (!res.html_url) throw new Error("返信の URL を読めません");
  return res.html_url;
}

/** A comment on the PR itself (the conversation tab). Returns its url. */
export function commentOnPr(repo: string, number: number, bodyFile: string): string {
  const out = gh(["pr", "comment", String(number), "--repo", repo, "--body-file", resolve(expandHome(bodyFile))]);
  return out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("https://")).pop() ?? `https://github.com/${repo}/pull/${number}`;
}
