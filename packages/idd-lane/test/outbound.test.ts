import { describe, expect, test, beforeEach } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  approveOutbound, buildRewriteArgs, createOutbound, discardOutbound, ghPoster, listOutbound, outboundContentFor, pendingOutbound, postOutboundNow, postedReplyUrls, proposedBody, proposedTitle, readOutbound,
  type Poster, type Rewriter,
} from "../src/outbound.ts";
import { parseRoles } from "../src/roles.ts";
import { approveSigned } from "./passkey-approval.ts";
import { tmpDir } from "./helpers/tmp.ts";

beforeEach(() => {
  process.env.IDD_STATE_DIR = tmpDir("idd-out-");
});

const okRewriter: Rewriter = async (_kind, text) => ({ text: `清書: ${text}`, role: "rewriter", model: "openrouter/x/y" });
const failRewriter: Rewriter = async () => { throw new Error("timeout"); };

describe("outbound", () => {
  test("queues the draft with the one-shot rewrite, and falls back to the draft when the rewrite fails", async () => {
    const a = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "T", body: "下書き" }, okRewriter);
    expect(a.status).toBe("ready");
    expect(a.draft).toBe("下書き");
    expect(proposedBody(a)).toBe("清書: 下書き");
    expect(a.rewrittenTitle).toBeUndefined();
    expect(proposedTitle(a)).toBe("T");
    const b = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "T", body: "下書き" }, failRewriter);
    expect(b.rewritten).toBeUndefined();
    expect(b.rewrittenTitle).toBeUndefined();
    expect(b.rewrite?.error).toMatch(/timeout/);
    expect(proposedBody(b)).toBe("下書き");
    expect(pendingOutbound().map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("posts exactly the approved text, records the url, and never posts before approval", async () => {
    const calls: { title: string; body: string }[] = [];
    const poster: Poster = async (_rec, final) => { calls.push(final); return { url: "https://github.com/o/r/issues/1" }; };
    const rec = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "T", body: "b" }, okRewriter);
    expect(calls).toEqual([]);
    const done = await approveSigned(rec.id, { title: "直した題", body: "penne が直した本文" }, poster);
    expect(calls).toEqual([{ title: "直した題", body: "penne が直した本文" }]);
    expect(done.status).toBe("posted");
    expect(done.posted?.url).toBe("https://github.com/o/r/issues/1");
    expect(pendingOutbound()).toEqual([]);
    await expect(approveSigned(rec.id, { title: "x", body: "y" }, poster)).rejects.toThrow(/posted/);
  });

  test("an Issue's close is queued without a rewrite, and only the approval posts it", async () => {
    // a failing rewriter is never called: the close one-liner is written by the harness
    const rec = await createOutbound({ kind: "gh-issue-close", target: { repo: "o/r", issue: 7 }, title: "Issue #7 を閉じる", body: "work 側へ取り込みました", noRewrite: true }, failRewriter);
    expect(rec.kind).toBe("gh-issue-close");
    expect(rec.rewritten).toBeUndefined();
    expect(pendingOutbound().map((r) => r.id)).toEqual([rec.id]);
    const dir = tmpDir("idd-gh-");
    const bin = join(dir, "gh");
    const log = join(dir, "args.txt");
    writeFileSync(bin, `#!/bin/bash\nprintf '%s\\n' "$@" > ${log}\n`);
    chmodSync(bin, 0o755);
    process.env.IDD_GH_BIN = bin;
    try {
      const done = await approveSigned(rec.id, { title: rec.title, body: rec.draft });
      expect(done.status).toBe("posted");
      expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["issue", "close", "7", "--repo", "o/r", "--reason", "completed", "--comment", rec.draft]);
      expect(done.posted?.url).toBe("https://github.com/o/r/issues/7");
    } finally { delete process.env.IDD_GH_BIN; }
  });

  test("a failed post stays pending with the error and can be retried; discard removes it from the inbox", async () => {
    const rec = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "T", body: "b", noRewrite: true }, okRewriter);
    expect(rec.rewrite).toBeUndefined();
    const failed = await approveSigned(rec.id, { title: "T", body: "b" }, async () => { throw new Error("HTTP 422"); });
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/422/);
    expect(pendingOutbound().map((r) => r.id)).toEqual([rec.id]);
    discardOutbound(rec.id);
    expect(readOutbound(rec.id)?.status).toBe("discarded");
    expect(pendingOutbound()).toEqual([]);
  });

  test("a second approval while the first is posting does not post twice, and a broken record does not break the list", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const slow: Poster = () => new Promise((r) => { calls += 1; release = () => r({ url: "https://github.com/o/r/issues/2" }); });
    const rec = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "T", body: "b", noRewrite: true }, okRewriter);
    const first = approveSigned(rec.id, { title: "T", body: "b" }, slow);
    await expect(approveSigned(rec.id, { title: "T", body: "b" }, slow)).rejects.toThrow(/投稿中/);
    expect(() => discardOutbound(rec.id)).toThrow(/投稿中/);
    release();
    expect((await first).status).toBe("posted");
    expect(calls).toBe(1);
    writeFileSync(join(process.env.IDD_STATE_DIR as string, "outbound", "OUT-broken.json"), "{");
    expect(pendingOutbound()).toEqual([]);
  });

  test("a record left mid-post by a crash comes back to the inbox and can be posted again on purpose", async () => {
    const rec = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "T", body: "b", noRewrite: true }, okRewriter);
    const p = join(process.env.IDD_STATE_DIR as string, "outbound", `${rec.id}.json`);
    writeFileSync(p, JSON.stringify({ ...rec, status: "posting" }));
    expect(pendingOutbound().map((r) => r.status)).toEqual(["posting"]);
    const done = await approveSigned(rec.id, { title: "T", body: "b" }, async () => ({ url: "https://github.com/o/r/issues/3" }));
    expect(done.status).toBe("posted");
  });

  test("a repository description must be one line", async () => {
    const rec = await createOutbound({ kind: "gh-repo", target: {}, title: "demo", body: "説明" }, okRewriter);
    await expect(approveSigned(rec.id, { title: "demo", body: "1 行目\n2 行目" }, async () => ({ url: "https://github.com/o/demo" }))).rejects.toThrow(/1 行/);
  });

  test("rejects drafts without a target and unknown kinds", async () => {
    await expect(createOutbound({ kind: "gh-issue", target: {}, title: "T", body: "b" }, okRewriter)).rejects.toThrow(/--repo/);
    await expect(createOutbound({ kind: "gh-repo", target: {}, title: "bad name!", body: "b" }, okRewriter)).rejects.toThrow(/リポジトリ名/);
    await expect(createOutbound({ kind: "slack" as never, target: {}, title: "T", body: "b" }, okRewriter)).rejects.toThrow(/未知の kind/);
  });

  test("the rewrite runs pi without tools, norm documents or a session", () => {
    const role = parseRoles("models:\n  openrouter-google-gemini-3.8-flash:\n    model: openrouter/google/gemini-3.8-flash\nroles:\n  rewriter: { model: openrouter-google-gemini-3.8-flash, thinking: low }").roles.rewriter;
    const args = buildRewriteArgs(role, "gh-issue", "本文", undefined, "本文の題");
    for (const flag of ["--no-tools", "--no-context-files", "--no-session", "--no-extensions", "--no-skills"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("");
    expect(args[args.length - 1]).toContain("<propter-system-message>");
    expect(args[args.length - 1]).toContain('<draft title="本文の題">本文</draft>');
    expect(args[args.indexOf("--model") + 1]).toBe("openrouter/google/gemini-3.8-flash");
  });

  test("an Issue rewrite's first line becomes the title and never the body", async () => {
    const seen: (string | undefined)[] = [];
    const rewriter: Rewriter = async (_kind, _text, _ctx, title) => { seen.push(title); return { text: "整えた題\n\n整えた本文", role: "rewriter", model: "m" }; };
    const rec = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "下書きの題", body: "下書きの本文" }, rewriter);
    expect(seen).toEqual(["下書きの題"]);
    expect(rec.title).toBe("下書きの題");
    expect(rec.rewrittenTitle).toBe("整えた題");
    expect(rec.rewritten).toBe("整えた本文");
    expect(proposedTitle(rec)).toBe("整えた題");
    expect(proposedBody(rec)).toBe("整えた本文");
    expect(proposedBody(rec).includes("整えた題")).toBe(false);
  });

  test("the Issue instruction carries the draft title, escaped, inside the draft tag", () => {
    const role = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  rewriter: { model: x-y, thinking: low }").roles.rewriter;
    const msg = buildRewriteArgs(role, "gh-issue", "本文", undefined, '題 "引用" <tag> & more');
    expect(msg[msg.length - 1]).toContain('<draft title="題 &quot;引用&quot; &lt;tag&gt; &amp; more">本文</draft>');
  });

  test("an output that is not title + body is kept whole and gets no title", async () => {
    const unreadable = [
      // 見出し・コードフェンス・水平線・HTML コメント
      "## 背景\n\n本文", "# 背景\n\n本文", "```\n\n本文", "~~~\n\n本文", "---\n\n本文", "<!-- メモ -->\n\n本文",
      // 箇条・引用・ラベル付きの題・引用符の題
      "- 項目\n\n本文", "* 項目\n\n本文", "1. 手順\n\n本文", "> 引用\n\n本文", "title: 題\n\n本文", '"引用符の題"\n\n本文',
      // 前置き・素の本文の 1 行目・1 文の段落と次の段落
      "以下に本文を示します：\n\n本文", "起動時のカタログ取得が遅いのは、毎回取りに行っているからです。\n\n本文", "最初の段落です。\n\n次の段落。",
      "題\nすぐ本文", "題", "題\n\n", "x".repeat(121) + "\n\n本文",
    ];
    for (const out of unreadable) {
      const rec = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "下書きの題", body: "下書きの本文" }, async () => ({ text: out, role: "rewriter", model: "m" }));
      expect(rec.rewritten).toBe(out);
      expect(rec.rewrittenTitle).toBeUndefined();
      expect(proposedTitle(rec)).toBe("下書きの題");
    }
  });

  test("only an Issue rewrite is split; a review, a repo and the replies keep the first line", async () => {
    const out = "1 行目\n\n残り";
    const rw: Rewriter = async () => ({ text: out, role: "rewriter", model: "m" });
    const review = await createOutbound({ kind: "gh-pr-review", target: { repo: "o/r", pr: 1, expectHead: "abc1234" }, title: "レビュー", body: "本文" }, rw);
    const repo = await createOutbound({ kind: "gh-repo", target: {}, title: "demo", body: "説明" }, rw);
    const replies = await createOutbound({ kind: "gh-pr-replies", target: { repo: "o/r", pr: 1, expectHead: "abc1234" }, title: "返信", body: "", parts: [{ ref: "C-1", label: "rev", quote: "q", draft: "下書き", resolve: false }] }, rw);
    expect(review.rewritten).toBe(out);
    expect(repo.rewritten).toBe(out);
    expect(replies.parts?.[0].rewritten).toBe(out);
    expect(review.rewrittenTitle).toBeUndefined();
    expect(repo.rewrittenTitle).toBeUndefined();
    const role = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  rewriter: { model: x-y, thinking: low }").roles.rewriter;
    for (const kind of ["gh-pr-review", "gh-repo", "gh-pr-replies"] as const) {
      const msg = buildRewriteArgs(role, kind, "本文", undefined, "題");
      expect(msg[msg.length - 1]).toContain("<draft>本文</draft>");
      expect(msg[msg.length - 1]).not.toContain("title=");
    }
  });

  test("the review rewrite shapes the plain wording and never writes a request", () => {
    const role = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  rewriter: { model: x-y, thinking: low }").roles.rewriter;
    const args = buildRewriteArgs(role, "gh-pr-review", "下書き");
    const msg = args[args.length - 1];
    expect(msg).not.toContain("依頼は 1 文で言い切る");
    expect(msg).toContain("依頼の形（「〜してください」「ご検討ください」）にしない");
    expect(msg).toContain("何がずれているかと根拠の箇所だけを書く");
  });

  test("what the repo asks for goes to the rewriter along with its rules", async () => {
    const role = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  rewriter: { model: x-y, thinking: low }").roles.rewriter;
    const args = buildRewriteArgs(role, "gh-issue", "本文", "## 対外文書の言語\nenで書く。");
    expect(args[args.length - 1]).toContain("<repo-conventions>");
    expect(args[args.length - 1]).toContain("enで書く。");
    const seen: (string | undefined)[] = [];
    const rewriter: Rewriter = async (_kind, text, context) => { seen.push(context); return { text, role: "rewriter", model: "m" }; };
    await createOutbound({ kind: "gh-issue", target: { repo: "a/b" }, title: "T", body: "b", context: "CTX" }, rewriter);
    expect(seen).toEqual(["CTX"]);
  });

  test("the lane a draft is for reaches the rewriter, so its ledger line can name the lane", async () => {
    const seen: (string | undefined)[] = [];
    const rewriter: Rewriter = async (_kind, text, _context, _title, repo, lane) => { seen.push(`${repo} ${lane}`); return { text, role: "rewriter", model: "m" }; };
    await createOutbound({ kind: "gh-issue", target: { repo: "a/b" }, title: "T", body: "b", lane: "IDD-3" }, rewriter);
    expect(seen).toEqual(["a/b IDD-3"]);
  });

  test("a follow-up Issue's draft keeps the lane that asked for it, and the lane is no part of what the signature covers", async () => {
    const draft = (lane?: string) => createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "T", body: "b", noRewrite: true, ...(lane ? { lane } : {}) });
    const mine = await draft("IDD-3");
    const outside = await draft();
    expect(readOutbound(mine.id)?.lane).toBe("IDD-3");
    expect(readOutbound(outside.id)).not.toHaveProperty("lane");
    // the same content signs the same, whichever lane asked: the record's id is the only thing apart
    const text = { title: "T", body: "b" };
    expect({ ...outboundContentFor(mine, text), id: "x" }).toEqual({ ...outboundContentFor(outside, text), id: "x" });
    expect(listOutbound().filter((r) => r.lane === "IDD-3").map((r) => r.id)).toEqual([mine.id]);
  });
});

/** a gh that logs its arguments, answers the calls the replies make, and fails on a marker */
function fakeGh(head: string): { log: () => string[][]; failOn: (marker: string | null) => void } {
  const dir = tmpDir("idd-fakegh-");
  const logFile = join(dir, "calls.jsonl");
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
const all = args.join(" ");
const failFile = ${JSON.stringify(join(dir, "fail"))};
const fail = fs.existsSync(failFile) ? fs.readFileSync(failFile, "utf8") : "";
if (fail && all.includes(fail)) { console.error("boom"); process.exit(1); }
if (args[0] === "pr" && args[1] === "view") { console.log(JSON.stringify({ headRefOid: ${JSON.stringify(head)} })); process.exit(0); }
if (args[0] === "pr" && args[1] === "comment") { console.log("https://github.com/o/r/pull/1#issuecomment-9"); process.exit(0); }
if (all.includes("addPullRequestReviewThreadReply")) { const t = args.find((a) => a.startsWith("t=")); console.log(JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { url: "https://github.com/o/r/pull/1#r-" + t.slice(2) } } } })); process.exit(0); }
if (args[0] === "api" && all.includes("/replies")) { console.log(JSON.stringify({ html_url: "https://github.com/o/r/pull/1#discussion_r5" })); process.exit(0); }
console.log("{}");
`);
  chmodSync(bin, 0o755);
  process.env.IDD_GH_BIN = bin;
  const failOn = (marker: string | null) => writeFileSync(join(dir, "fail"), marker ?? "");
  return { failOn, log: () => { try { return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]); } catch { return []; } } };
}

describe("replies to feedback on penne's own PR", () => {
  const parts = [
    { ref: "C-1", label: "rev · a.ts:3", quote: "ここが壊れる", thread_id: "T1", draft: "直しました（abc1234）", resolve: true },
    { ref: "C-2", label: "rev · b.ts:5", quote: "命名を変えては", thread_id: "T2", draft: "変えません: 公開の API 名です", resolve: false },
    { ref: "C-3", label: "rev のレビュー", quote: "全体として 1 点", draft: "テストを足しました", resolve: true },
  ];
  const target = { repo: "o/r", pr: 1, expectHead: "abc1234" };

  test("each part is rewritten on its own with what it answers, and only a thread keeps a resolve", async () => {
    const seen: string[] = [];
    const rw: Rewriter = async (_k, text, ctx) => { seen.push(String(ctx)); return { text: `清書: ${text}`, role: "rewriter", model: "m" }; };
    const rec = await createOutbound({ kind: "gh-pr-replies", target, title: "PR #1 への返信", body: "", parts }, rw);
    expect(rec.parts?.map((p) => p.rewritten)).toEqual(["清書: 直しました（abc1234）", "清書: 変えません: 公開の API 名です", "清書: テストを足しました"]);
    expect(seen[0]).toContain("ここが壊れる");
    expect(rec.parts?.map((p) => p.resolve)).toEqual([true, false, false]);
  });

  test("thread replies go to their threads, a resolve only where penne kept it, the rest into one quoting PR comment", async () => {
    const gh = fakeGh("abc1234ffff");
    const rec = await createOutbound({ kind: "gh-pr-replies", target, title: "PR #1 への返信", body: "", parts, noRewrite: true });
    const done = await approveSigned(rec.id, { title: rec.title, body: "", parts: [
      { ref: "C-1", body: "直しました（abc1234）", resolve: true },
      { ref: "C-2", body: "変えません: 公開の API 名です", resolve: true },
      { ref: "C-3", body: "テストを足しました", resolve: true },
    ] });
    expect(done.status).toBe("posted");
    const calls = gh.log();
    const replies = calls.filter((a) => a.join(" ").includes("addPullRequestReviewThreadReply")).map((a) => a.find((x) => x.startsWith("t=")));
    expect(replies).toEqual(["t=T1", "t=T2"]);
    // C-2 is a rejected thread: penne cannot resolve it from the card, since the card said it stays open
    const resolves = calls.filter((a) => a.join(" ").includes("resolveReviewThread")).map((a) => a.find((x) => x.startsWith("t=")));
    expect(resolves).toEqual(["t=T1"]);
    const comment = calls.find((a) => a[0] === "pr" && a[1] === "comment");
    expect(comment).toBeDefined();
    const bodyFile = comment![comment!.indexOf("--body-file") + 1];
    expect(readFileSync(bodyFile, "utf8")).toContain("> ここが壊れる".replace("ここが壊れる", "全体として 1 点"));
    expect(readOutbound(rec.id)?.parts?.every((p) => p.posted_url)).toBe(true);
    // what was posted is known by url, so the next look at the PR does not take it in as feedback
    expect([...postedReplyUrls("o/r", 1)].sort()).toEqual(["https://github.com/o/r/pull/1#issuecomment-9", "https://github.com/o/r/pull/1#r-T1", "https://github.com/o/r/pull/1#r-T2"]);
    expect(postedReplyUrls("o/r", 2).size).toBe(0);
  });

  test("a reply named by its REST comment id is posted as a reply to that comment, never as a PR comment", async () => {
    const gh = fakeGh("abc1234");
    const rec = await createOutbound({ kind: "gh-pr-replies", target, title: "PR #1 への返信", body: "", parts: [{ ref: "comment:5", label: "rev", quote: "ここが壊れる", comment_id: "5", draft: "直しました", resolve: false }], noRewrite: true });
    const done = await approveSigned(rec.id, { title: rec.title, body: "", parts: [{ ref: "comment:5", body: "直しました", resolve: false }] });
    expect(done.status).toBe("posted");
    const calls = gh.log();
    const reply = calls.find((a) => a[0] === "api" && a.join(" ").includes("/replies"));
    expect(reply).toEqual(["api", "-X", "POST", "repos/o/r/pulls/1/comments/5/replies", "-f", "body=直しました"]);
    expect(calls.some((a) => a[0] === "pr" && a[1] === "comment")).toBe(false);
    expect(readOutbound(rec.id)?.parts?.[0].posted_url).toBe("https://github.com/o/r/pull/1#discussion_r5");
  });

  test("the comment a reply goes under is part of what the signature covers", async () => {
    fakeGh("abc1234");
    const rec = await createOutbound({ kind: "gh-pr-replies", target, title: "PR #1 への返信", body: "", parts: [{ ref: "comment:5", label: "rev", quote: "q", comment_id: "5", draft: "ok", resolve: false }], noRewrite: true });
    const final = { title: rec.title, body: "", parts: [{ ref: "comment:5", body: "ok", resolve: false }] };
    const a = outboundContentFor(rec, { title: rec.title, body: "", parts: final.parts });
    const b = outboundContentFor({ ...rec, parts: rec.parts?.map((p) => ({ ...p, comment_id: "6" })) }, { title: rec.title, body: "", parts: final.parts });
    expect(a).not.toEqual(b);
  });

  test("nothing is posted when the PR head moved since the draft", async () => {
    const gh = fakeGh("fff0000");
    const rec = await createOutbound({ kind: "gh-pr-replies", target, title: "PR #1 への返信", body: "", parts, noRewrite: true });
    const done = await approveSigned(rec.id, { title: rec.title, body: "", parts: [{ ref: "C-1", body: "直しました", resolve: true }] });
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/head が変わっています/);
    expect(gh.log().some((a) => a.join(" ").includes("addPullRequestReviewThreadReply"))).toBe(false);
  });

  test("a retry after a partial failure posts only what is left, and an empty reply is skipped", async () => {
    const gh = fakeGh("abc1234");
    const rec = await createOutbound({ kind: "gh-pr-replies", target, title: "PR #1 への返信", body: "", parts, noRewrite: true });
    const final = { title: rec.title, body: "", parts: [
      { ref: "C-1", body: "直しました", resolve: true },
      { ref: "C-2", body: "", resolve: false },
      { ref: "C-3", body: "テストを足しました", resolve: false },
    ] };
    gh.failOn("pr comment");
    expect((await approveSigned(rec.id, final)).status).toBe("failed");
    gh.failOn(null);
    expect((await approveSigned(rec.id, final)).status).toBe("posted");
    const replies = gh.log().filter((a) => a.join(" ").includes("addPullRequestReviewThreadReply"));
    expect(replies.length).toBe(1);
    expect(gh.log().filter((a) => a[0] === "pr" && a[1] === "comment").length).toBe(2);
  });

  test("an approval with every reply left empty is refused", async () => {
    fakeGh("abc1234");
    const rec = await createOutbound({ kind: "gh-pr-replies", target, title: "PR #1 への返信", body: "", parts, noRewrite: true });
    await expect(approveSigned(rec.id, { title: rec.title, body: "", parts: [{ ref: "C-1", body: " ", resolve: true }] })).rejects.toThrow(/1 件も/);
    expect(ghPoster).toBeDefined();
  });
});

describe("the landing's signed close posts at once", () => {
  const closeDraft = { kind: "gh-issue-close" as const, target: { repo: "o/r", issue: 7 }, title: "Issue #7 を閉じる", body: "work 側へ取り込みました", source: "IDD-1", noRewrite: true };
  const okPoster: Poster = async () => ({ url: "https://github.com/o/r/issues/7" });

  test("a failed immediate post stays a failed card with its reason; a success does not stay in the inbox", async () => {
    const failed = await postOutboundNow(closeDraft, async () => { throw new Error("HTTP 422"); });
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/422/);
    expect(pendingOutbound().map((r) => r.id)).toEqual([failed.id]);
    const ok = await postOutboundNow(closeDraft, okPoster);
    expect(ok.status).toBe("posted");
    expect(ok.posted?.url).toBe("https://github.com/o/r/issues/7");
    expect(pendingOutbound().map((r) => r.id)).toEqual([failed.id]);
    // only a gh-issue-close is taken: the door is not a way around the signature
    await expect(postOutboundNow({ ...closeDraft, kind: "gh-issue" as never }, okPoster)).rejects.toThrow(/gh-issue-close/);
  });

  test("the immediate post never runs the rewriter either", async () => {
    const rec = await postOutboundNow(closeDraft, okPoster);
    expect(rec.rewritten).toBeUndefined();
    expect(rec.rewrite).toBeUndefined();
  });

  test("a failed immediate close is retried through the signed outbound approval", async () => {
    const failed = await postOutboundNow(closeDraft, async () => { throw new Error("HTTP 422"); });
    await expect(approveOutbound(failed.id, { title: failed.title, body: failed.draft })).rejects.toThrow(/署名/);
    const done = await approveSigned(failed.id, { title: failed.title, body: failed.draft }, okPoster);
    expect(done.status).toBe("posted");
    expect(pendingOutbound()).toEqual([]);
  });

  test("while the immediate post runs the record is out of the inbox and cannot be approved or discarded", async () => {
    let started: () => void = () => {};
    const startedP = new Promise<void>((r) => { started = r; });
    let release: () => void = () => {};
    const poster: Poster = () => new Promise((resolve) => { started(); release = () => resolve({ url: "https://github.com/o/r/issues/7" }); });
    const pending = postOutboundNow(closeDraft, poster);
    await startedP;
    expect(pendingOutbound()).toEqual([]);
    const rec = listOutbound("posting")[0];
    expect(rec).toBeDefined();
    await expect(approveOutbound(rec.id, { title: rec.title, body: rec.draft })).rejects.toThrow(/投稿中/);
    expect(() => discardOutbound(rec.id)).toThrow(/投稿中/);
    release();
    expect((await pending).status).toBe("posted");
    // it left the posting set: a discard now refuses because it is posted, not because it is in flight
    expect(() => discardOutbound(rec.id)).toThrow(/投稿済み/);
  });
});

describe("a review only goes out against the head it was written for", () => {
  test("nothing is posted when the PR head moved since the review card was made", async () => {
    const gh = fakeGh("abc1234ffff");
    const rec = await createOutbound({ kind: "gh-pr-review", target: { repo: "o/r", pr: 1, expectHead: "9999999" }, title: "PR #1 のレビュー", body: "本文", noRewrite: true });
    const done = await approveSigned(rec.id, { title: rec.title, body: "本文", event: "comment" });
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/head が変わっています/);
    expect(gh.log().some((a) => a[0] === "pr" && a[1] === "review")).toBe(false);
  });
});
