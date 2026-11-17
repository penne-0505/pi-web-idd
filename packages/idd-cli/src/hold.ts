import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { deriveStage, prOf, readAreas, readBacklog, readHolds, readLifecycle, type HoldRecord } from "../../idd-core/src/index.ts";
import { agentBaseUrl, inboxCardUrl } from "../../idd-core/src/agent/token.ts";
import { HOLD_SENTENCE, planHold, WAIT_SENTENCE, type HoldPlan } from "../../idd-lane/src/boundary.ts";
import { createOutbound, expandHome, listOutbound, requestingLane, type OutboundRecord } from "../../idd-lane/src/index.ts";
import { postJsonWithRetry } from "./lane-commands.ts";

/**
 * `idd hold`: what a lane's agent hands over at the boundary, and where it stands.
 *
 *   idd hold run gh|git ARGS...   the shim's door. 0: taken in hand (the answer is on stdout). 86: not taken, said why on
 *                                 stderr. 87: not the table's to answer, run the real command.
 *   idd hold status               the lane's own holds and where each stands. Reads only.
 *
 * Nothing here pushes, posts or opens a card as approved. A push and a PR's text go to the engine, which writes them
 * where the submit card reads them; a post is drafted as an outbound card. Both wait for a person's signature.
 */

export const HOLD_REFUSED = 86;
export const HOLD_PASS = 87;

const NO_SUBMIT = "この lane には提出の段がないので預かれません。必要なら報告に書いて人に渡してください";

function said(code: number, stream: "stdout" | "stderr", text: string): number {
  process[stream].write(`${text}\n`);
  return code;
}

const refused = (command: string, why: string): number => said(HOLD_REFUSED, "stderr", `idd-lane: ${command} は預かれません。${why}`);
const taken = (command: string, what: string): number => said(0, "stdout", `idd-lane: ${command} は${HOLD_SENTENCE}。${what}状態は「idd hold status」で読めます。${WAIT_SENTENCE}`);

/** gh as the lane's agent cannot run it: the shim's own directory is left out, so a read the shim refuses can be made here */
function realGh(args: string[]): string {
  const realPath = process.env.IDD_LANE_REAL_PATH?.trim();
  const res = spawnSync(process.env.IDD_GH_BIN?.trim() || "gh", args, { encoding: "utf8", env: realPath ? { ...process.env, PATH: realPath } : process.env, timeout: 30_000 });
  if (res.status !== 0) throw new Error((res.stderr || res.error?.message || `gh ${args[0]} が失敗しました`).trim().slice(0, 300));
  return res.stdout;
}

function readBody(path: string): string {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(expandHome(path)), "utf8");
}

const OPEN_STATES = new Set<OutboundRecord["status"]>(["ready", "posting", "failed"]);

/** what this lane has handed over so far, from the engine's holds and the lane's outbound drafts */
function holdsOf(lane: string): { holds: HoldRecord[]; drafts: OutboundRecord[] } {
  return { holds: readHolds(lane), drafts: listOutbound().filter((r) => r.source === sourceOf(lane)) };
}

const sourceOf = (lane: string): string => `idd hold ${lane}`;

function cardLines(card: string | undefined): string {
  return card ? `受信箱の送出カード ${card} で、` : "";
}

async function deposit(lane: string, command: string, plan: HoldPlan): Promise<number> {
  const token = process.env.IDD_HOLD_TOKEN?.trim();
  switch (plan.op) {
    case "push":
    case "pr-create": {
      if (!token) return refused(command, "預かりを記録できません（IDD_HOLD_TOKEN がありません）");
      const posted = await postJsonWithRetry(`${agentBaseUrl()}/api/idd/agent/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ idd_id: lane, kind: plan.op, ...(plan.op === "pr-create" ? { title: plan.title, body: plan.body } : {}) }),
      });
      if (posted.error !== undefined) return refused(command, `預かりを記録できませんでした（${String(posted.error).slice(0, 200)}）`);
      if (!posted.response?.ok || posted.data.ok === false) {
        return refused(command, `預かりを記録できませんでした（${typeof posted.data.error === "string" ? posted.data.error : `HTTP ${posted.response?.status ?? 0}`}）`);
      }
      if (plan.op === "push") {
        return taken(command, "受信箱の提出前確認のカードで人が署名すると、propter が lane の branch を push します。push 先と対象は propter が決めるので、引数は使いません。");
      }
      const left = plan.ignored.length ? `${plan.ignored.join(" ")} は預かっていません。` : "";
      const draft = plan.title ? "題名と本文は、提出前確認のカードの PR の初期値になります。" : "題名が無いので、カードの PR の題名と本文は propter の下書きになります。";
      return taken(command, `受信箱の提出前確認のカードで人が署名すると、propter が PR を作ります。${draft}${left}`);
    }
    default:
      return outboundDeposit(lane, command, plan);
  }
}

function repoOf(lane: string, given: string | undefined): string {
  if (given) return given;
  const rec = readBacklog().find((r) => r.idd_id === lane);
  const linked = rec ? readAreas().areas[rec.area]?.linked_repo : undefined;
  if (linked) return linked;
  return realGh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
}

/**
 * The PR a `gh pr edit` names: a number, a URL (whose repository is the PR's own), or (named nothing) the lane's own
 * open PR, which comes with its own repository: a number is only the lane's with the repository it was made in.
 */
function prNamedBy(lane: string, given: string | undefined): { pr: number; repo?: string; own?: true } | null {
  if (!given) {
    const own = prOf(readLifecycle().filter((e) => e.idd_id === lane));
    return own ? { pr: own.pr, repo: own.repo, own: true } : null;
  }
  if (/^\d+$/.test(given)) return { pr: Number(given) };
  const url = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(given);
  return url ? { repo: url[1], pr: Number(url[2]) } : null;
}

async function outboundDeposit(lane: string, command: string, plan: HoldPlan): Promise<number> {
  const source = sourceOf(lane);
  try {
    if (plan.op === "pr-edit") {
      const named = prNamedBy(lane, plan.pr);
      if (!named) return refused(command, "PR の番号が分かりません。番号か URL を指定してください");
      // naming nothing means the lane's own PR; pairing its number with another repository would sign a different PR's text
      if (named.own && named.repo && plan.repo && named.repo.toLowerCase() !== plan.repo.toLowerCase()) {
        return refused(command, `PR を指定していないので lane の PR（${named.repo}）になりますが、--repo は ${plan.repo} です。PR の番号か URL を指定してください`);
      }
      // the card's target is the repository the argv names: a URL's own, never the lane's repository standing in for it
      if (named.repo && plan.repo && named.repo.toLowerCase() !== plan.repo.toLowerCase()) {
        return refused(command, `PR の URL の repo（${named.repo}）と --repo（${plan.repo}）が食い違います`);
      }
      // the lane's own PR is in the repository it was made in, spelled as that record has it
      const repo = repoOf(lane, named.own ? named.repo : plan.repo ?? named.repo);
      const pr = named.pr;
      // a title given alone leaves the body as GitHub has it
      const body = plan.body ?? JSON.parse(realGh(["pr", "view", String(pr), "--repo", repo, "--json", "body"])).body ?? "";
      const rec = await createOutbound({ kind: "gh-pr-body", target: { repo, pr }, title: plan.title ?? "", body, noRewrite: true, source });
      return taken(command, `${cardLines(rec.id)}人が確認・署名すると PR #${pr} の題名と本文が書き換わります。${inboxCardUrl(rec.id)} `);
    }
    if (plan.op === "issue-create") {
      const repo = repoOf(lane, plan.repo);
      const rec = await createOutbound({ kind: "gh-issue", target: { repo, ...(plan.labels.length ? { labels: plan.labels } : {}) }, title: plan.title, body: plan.body, noRewrite: true, source });
      const left = plan.ignored.length ? `${plan.ignored.join(" ")} は預かっていません。` : "";
      return taken(command, `${cardLines(rec.id)}人が確認・署名すると ${repo} に Issue ができます。${left}${inboxCardUrl(rec.id)} `);
    }
    if (plan.op === "thread-reply") {
      const head = JSON.parse(realGh(["pr", "view", String(plan.pr), "--repo", plan.repo, "--json", "headRefOid"])).headRefOid as string;
      const original = JSON.parse(realGh(["api", `repos/${plan.repo}/pulls/comments/${plan.commentId}`])) as { body?: string; user?: { login?: string }; html_url?: string };
      const rec = await createOutbound({
        kind: "gh-pr-replies",
        target: { repo: plan.repo, pr: plan.pr, expectHead: head },
        title: `#${plan.pr} のレビューへの返信`,
        body: "",
        noRewrite: true,
        source,
        parts: [{ ref: `comment:${plan.commentId}`, label: original.user?.login ?? "レビュー", quote: String(original.body ?? ""), comment_id: plan.commentId, draft: plan.body, resolve: false, ...(original.html_url ? { url: original.html_url } : {}) }],
      });
      return taken(command, `${cardLines(rec.id)}人が確認・署名すると PR #${plan.pr} の comment ${plan.commentId} の返信として付きます。${inboxCardUrl(rec.id)} `);
    }
    if (plan.op === "thread-act") {
      const found = JSON.parse(realGh(["api", "graphql", "-f", "query=query($id:ID!){node(id:$id){... on PullRequestReviewThread{path pullRequest{number headRefOid repository{nameWithOwner}} comments(first:1){nodes{body url author{login}}}}}}", "-f", `id=${plan.threadId}`])) as {
        data?: { node?: { path?: string; pullRequest?: { number: number; headRefOid: string; repository: { nameWithOwner: string } }; comments?: { nodes?: { body?: string; url?: string; author?: { login?: string } }[] } } | null };
      };
      const node = found.data?.node;
      if (!node?.pullRequest) return refused(command, "スレッドを読めませんでした（id が違うか、読む権限がありません）");
      const first = node.comments?.nodes?.[0];
      const pr = node.pullRequest;
      const rec = await createOutbound({
        kind: "gh-pr-replies",
        target: { repo: pr.repository.nameWithOwner, pr: pr.number, expectHead: pr.headRefOid },
        title: `#${pr.number} のレビューへの${plan.resolve ? "解決" : "返信"}`,
        body: "",
        noRewrite: true,
        source,
        parts: [{ ref: `thread:${plan.threadId}`, label: first?.author?.login ?? "レビュー", quote: String(first?.body ?? ""), thread_id: plan.threadId, draft: plan.body ?? "", resolve: plan.resolve, ...(first?.url ? { url: first.url } : {}) }],
      });
      const what = plan.resolve ? "スレッドの解決は、返信の本文をカードに書いたうえで署名すると行われます。" : "人が確認・署名するとスレッドに返信が付きます。";
      return taken(command, `${cardLines(rec.id)}${what}${inboxCardUrl(rec.id)} `);
    }
  } catch (err) {
    return refused(command, `預かりを記録できませんでした（${(err instanceof Error ? err.message : String(err)).slice(0, 200)}）`);
  }
  return refused(command, "この操作は表にありません");
}

async function run(args: string[]): Promise<number> {
  const [tool, ...rest] = args;
  if (tool !== "gh" && tool !== "git") return said(2, "stderr", "usage: idd hold run gh|git ARGS...");
  const command = `${tool} ${rest.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ")}`.trim();
  const lane = requestingLane();
  const inBacklog = Boolean(lane) && readBacklog().some((r) => r.idd_id === lane);
  let plan: HoldPlan;
  try {
    plan = planHold(tool, rest, readBody);
  } catch (err) {
    return refused(command, err instanceof Error ? err.message : String(err));
  }
  if (plan.op === "pass") return HOLD_PASS;
  if (plan.op === "follow-up") {
    // only a lane that handed something over waits on it; a read of someone else's PR is the real command's
    if (!lane || !inBacklog) return HOLD_PASS;
    const { holds, drafts } = holdsOf(lane);
    return holds.length || drafts.length ? said(HOLD_REFUSED, "stderr", `idd-lane: ${command} は実行しません。${WAIT_SENTENCE}。預けた申請の状態は「idd hold status」で読めます`) : HOLD_PASS;
  }
  if (plan.op === "refuse") return refused(command, `${plan.reason}。表にない書き込みは預からないので、必要なら報告に書いて人に渡してください`);
  if (!lane || !inBacklog) return refused(command, NO_SUBMIT);
  return deposit(lane, command, plan);
}

function stateOfHold(lane: string, hold: HoldRecord): { state: string; detail: string } {
  const events = readLifecycle().filter((e) => e.idd_id === lane);
  // hold.at is UTC with ms, a lifecycle at has an offset and whole seconds: compare instants, never the strings
  const heldAt = Date.parse(hold.at);
  const after = events.filter((e) => Date.parse(e.at) > heldAt).map((e) => e.event);
  if (hold.kind === "push" ? after.includes("s4_pushed") : after.includes("s4_pr_created")) return { state: "done", detail: hold.kind === "push" ? "push を行いました" : "PR を作りました" };
  if (deriveStage(events).decision === "ship") return { state: "card_open", detail: "受信箱の提出前確認のカードで、人の署名を待っています" };
  return { state: "held", detail: "預かりました。提出前確認のカードが開くまでレビューと検査が進みます" };
}

const OUTBOUND_STATE: Record<OutboundRecord["status"], { state: string; detail: string }> = {
  ready: { state: "card_open", detail: "受信箱の送出カードで、人の署名を待っています" },
  posting: { state: "posting", detail: "署名を受けて投稿しています" },
  posted: { state: "done", detail: "投稿しました" },
  failed: { state: "failed", detail: "投稿に失敗しました。受信箱の送出カードから人が再試行できます" },
  discarded: { state: "discarded", detail: "人が破棄しました" },
};

/** this lane's own holds only: the lane is the environment's, never an argument */
function status(): number {
  const lane = requestingLane();
  if (!lane) return said(1, "stderr", "IDD_ID も IDD_RUN_LANE もありません。状態は、ハーネスが渡す環境でだけ読めます");
  const { holds, drafts } = holdsOf(lane);
  const rows = [
    ...holds.map((h) => ({ id: h.id, kind: h.kind, at: h.at, ...(h.title ? { title: h.title } : {}), ...stateOfHold(lane, h) })),
    ...drafts.map((d) => ({ id: d.id, kind: d.kind, at: d.created_at, title: d.title, ...OUTBOUND_STATE[d.status], ...(d.posted ? { url: d.posted.url } : {}), ...(d.error ? { error: d.error } : {}), ...(OPEN_STATES.has(d.status) ? { card: inboxCardUrl(d.id) } : {}) })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  process.stdout.write(`${JSON.stringify({ lane, holds: rows, next: WAIT_SENTENCE }, null, 2)}\n`);
  return 0;
}

export async function runHoldCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "run") return run(rest);
  if (sub === "status") return status();
  return said(2, "stderr", "usage: idd hold status | run gh|git ARGS...");
}
