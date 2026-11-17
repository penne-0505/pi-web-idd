import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentRunner, type PrFeedbackItem, type ReplyDraft } from "../agent/port.ts";
import { deriveStage, laneHeld } from "../ledger/derive.ts";
import { stagePick } from "../ledger/pick.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { acceptedOf, reviewLoopState } from "../ledger/review-loop.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { stateDir } from "../paths.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/** how much of a comment the lifecycle keeps; the whole text is in the feedback file */
const QUOTE_CHARS = 400;

export interface PrFeedbackResult {
  recorded: { iddId: string; items: number }[];
  errors: { iddId: string; error: string }[];
}

export interface PrRepliesResult {
  queued: { iddId: string; outboundId?: string; parts: number; followups: number }[];
  errors: { iddId: string; error: string }[];
}

export interface ReceivedItem {
  ref: string;
  id: string;
  kind: PrFeedbackItem["kind"];
  author: string;
  url: string;
  quote: string;
  thread_id?: string;
  path?: string;
  line?: number | null;
}

interface Rejected { ref: string; claim: string; reason?: string; followup?: boolean; no_request?: boolean }

const closed = (evs: LifecycleRecord[]) => evs.some((e) => e.event === "lane_close" || e.event === "s3_defer");

function lastIndex(evs: LifecycleRecord[], name: string): number {
  for (let i = evs.length - 1; i >= 0; i -= 1) if (evs[i].event === name) return i;
  return -1;
}

/** the lane's PR, from the last time it was created or updated */
export function prOf(evs: LifecycleRecord[]): { repo: string; pr: number; url: string } | null {
  const i = lastIndex(evs, "s4_pr_created");
  const url = i >= 0 ? String(evs[i].attrs?.pr_url ?? "") : "";
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? { repo: m[1], pr: Number(m[2]), url } : null;
}

/** every piece of feedback the lane has taken in, so it is never taken in twice */
export function seenFeedback(evs: LifecycleRecord[]): Set<string> {
  const seen = new Set<string>();
  for (const e of evs) {
    if (e.event !== "s4_review_comment_received") continue;
    for (const it of (e.attrs?.items as ReceivedItem[] | undefined) ?? []) seen.add(String(it.id));
  }
  return seen;
}

/** the lane waits on its PR: pushed, not merged, and no work of its own in flight */
export function waitingOnPr(evs: LifecycleRecord[]): boolean {
  const d = deriveStage(evs);
  return d.group === "waiting" && d.stageDone === 5 && d.stageCurrent === null && lastIndex(evs, "s4_pr_created") >= 0;
}

/** the last batch of feedback is done with: its replies were posted or discarded, or there were none to draft */
export function lastBatchAnswered(evs: LifecycleRecord[], runner: { outboundStatus?: (id: string) => { status: string } | null }): boolean {
  const fbAt = lastIndex(evs, "s4_review_comment_received");
  if (fbAt < 0) return true;
  const qAt = lastIndex(evs, "s4_replies_queued");
  if (qAt < fbAt) return false;
  const id = evs[qAt].attrs?.outbound_id;
  if (!id) return true;
  // a runner that cannot tell whether the card was dealt with waits, rather than risk the card never posting
  if (!runner.outboundStatus) return false;
  const st = runner.outboundStatus(String(id))?.status;
  // a record that is gone cannot be answered any more
  return st === undefined || st === "posted" || st === "discarded";
}

function where(it: { path?: string; line?: number | null }): string {
  return it.path ? `${it.path}${it.line ? `:${it.line}` : ""}` : "";
}

function renderFeedback(repo: string, pr: number, head: string, items: (PrFeedbackItem & { ref: string })[]): string {
  const kinds: Record<PrFeedbackItem["kind"], string> = { thread: "インラインの指摘", review: "レビュー本文", comment: "PR へのコメント", ci: "CI の失敗" };
  return [
    `# PR ${repo}#${pr} に届いた指摘（head ${head.slice(0, 9)}）`,
    "",
    ...items.flatMap((it) => [
      `## ${it.ref} ${kinds[it.kind]} · ${it.author}${where(it) ? ` · ${where(it)}` : ""}`,
      "",
      ...(it.url ? [`URL: ${it.url}`, ""] : []),
      it.body.trim(),
      "",
    ]),
  ].join("\n");
}

/**
 * Take in what came to each waiting lane's PR since the last look: reviews, comments and thread comments
 * (the PR author's own included; only the harness's replies are left out), and failed checks. What is
 * recorded here enters the review loop at the triage.
 */
export async function runPrFeedback(): Promise<PrFeedbackResult> {
  const result: PrFeedbackResult = { recorded: [], errors: [] };
  const runner = getAgentRunner();
  if (!runner?.fetchPrFeedback) return result;
  const all = readLifecycle();
  for (const rec of readBacklog()) {
    const evs = all.filter((e) => e.idd_id === rec.idd_id);
    // the stage asks its own question, at the moment it asks it (C-199-2). The replies to the last batch are
    // posted or discarded first: a new batch would take their place, and its push would move the head the replies
    // were drafted against, so they could never be posted.
    if (!stagePick("pr_feedback", evs, { lastBatchAnswered: lastBatchAnswered(evs, runner) }).pick) continue;
    const pr = prOf(evs);
    if (!pr) continue;
    try {
      const fb = await runner.fetchPrFeedback(pr.repo, pr.pr);
      const seen = seenFeedback(evs);
      const fresh = fb.items.filter((it) => !seen.has(it.id)).map((it, i) => ({ ...it, ref: `C-${i + 1}` }));
      if (!fresh.length) continue;
      const n = evs.filter((e) => e.event === "s4_review_comment_received").length + 1;
      const dir = join(stateDir(), "pipeline", "feedback", rec.idd_id, String(n));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "feedback.md");
      writeFileSync(file, renderFeedback(pr.repo, pr.pr, fb.head, fresh));
      const items: ReceivedItem[] = fresh.map((it) => ({
        ref: it.ref, id: it.id, kind: it.kind, author: it.author, url: it.url, quote: it.body.trim().slice(0, QUOTE_CHARS),
        ...(it.thread_id ? { thread_id: it.thread_id, path: it.path, line: it.line ?? null } : {}),
      }));
      await appendLifecycle("s4_review_comment_received", rec.idd_id, { repo: pr.repo, pr: pr.pr, head: fb.head, files: [file], items });
      result.recorded.push({ iddId: rec.idd_id, items: items.length });
    } catch (err) {
      result.errors.push({ iddId: rec.idd_id, error: String(err).slice(0, 300) });
    }
  }
  return result;
}

/**
 * The accepted requests no confirm found fixed: the fixes the last judgement sent and no confirm after them
 * reported resolved, plus the ones no fix carried at all (penne took the lane on as it stood).
 */
export function unconfirmedFixes(evs: LifecycleRecord[], triageAt: number, pushedAt: number): Set<string> {
  const accepted = acceptedOf(evs[triageAt]?.attrs).map((a) => a.ref);
  let confirm: LifecycleRecord | undefined;
  for (let i = triageAt + 1; i < pushedAt; i += 1) if (evs[i].event === "s2_confirm_done" && !evs[i].attrs?.failed) confirm = evs[i];
  if (!confirm) return new Set(accepted);
  const open = new Set((Array.isArray(confirm.attrs?.unresolved_refs) ? confirm.attrs.unresolved_refs : []).map(String));
  return new Set(accepted.filter((ref) => open.has(ref)));
}

/** one ref's judgement, as the last judgement of the batch left it: the accept / reject and how it is answered */
export interface DraftDecision {
  ref: string;
  verdict: "accept" | "reject";
  severity?: string;
  claim: string;
  reason?: string;
  action?: string;
  followup?: boolean;
  no_request?: boolean;
}

/**
 * The last judgement of each ref in the batch. The confirm's leftovers judge the same C refs again, so their
 * decision replaces the feedback judgement's; the reply comes from whichever judgement came last.
 */
export function lastDecisions(evs: LifecycleRecord[], fbAt: number, endAt = evs.length): Map<string, DraftDecision> {
  const out = new Map<string, DraftDecision>();
  for (let i = fbAt + 1; i < endAt; i += 1) {
    const e = evs[i];
    if (e.event !== "s2_triage_done" || e.attrs?.failed) continue;
    const kind = String(e.attrs?.kind ?? "");
    if (kind !== "feedback" && kind !== "confirm") continue;
    for (const a of acceptedOf(e.attrs)) {
      out.set(a.ref, { ref: a.ref, verdict: "accept", severity: a.severity, claim: a.claim, ...(a.reason ? { reason: a.reason } : {}), ...(a.action ? { action: a.action } : {}) });
    }
    const rej = Array.isArray(e.attrs?.rejected) ? (e.attrs.rejected as Rejected[]) : [];
    for (const r of rej) out.set(r.ref, { ref: r.ref, verdict: "reject", claim: r.claim, ...(r.reason ? { reason: r.reason } : {}), ...(r.followup ? { followup: true } : {}), ...(r.no_request ? { no_request: true } : {}) });
  }
  return out;
}

/** the refs the batch fixed and a confirm after that fix found resolved */
export function confirmedFixes(evs: LifecycleRecord[], fbAt: number, endAt = evs.length): Set<string> {
  const refsAt = (i: number) => (Array.isArray(evs[i].attrs?.refs) ? (evs[i].attrs?.refs as unknown[]).map(String) : []);
  const lastFix = new Map<string, number>();
  for (let i = fbAt + 1; i < endAt; i += 1) if (evs[i].event === "s2_fix_sent") for (const r of refsAt(i)) lastFix.set(r, i);
  const out = new Set<string>();
  for (const [ref, at] of lastFix) {
    let confirmAt = -1;
    for (let j = at + 1; j < endAt; j += 1) if (evs[j].event === "s2_confirm_done" && !evs[j].attrs?.failed) confirmAt = j;
    if (confirmAt < 0) continue;
    const open = new Set((Array.isArray(evs[confirmAt].attrs?.unresolved_refs) ? (evs[confirmAt].attrs?.unresolved_refs as unknown[]) : []).map(String));
    if (!open.has(ref)) out.add(ref);
  }
  return out;
}

/**
 * One reply per piece of feedback, from the last judgement of its ref: a fix the confirm found resolved, a
 * follow-up (accepted or rejected), a skip, or a rejection. A fix no confirm confirmed, and a request the
 * judgement left to penne, get an empty draft for penne to write; an item that asked for nothing gets none.
 */
export function replyDrafts(items: ReceivedItem[], decisions: Map<string, DraftDecision>, commit?: string, confirmed: Set<string> = new Set()): ReplyDraft[] {
  return items.filter((it) => it.kind !== "ci" && !decisions.get(it.ref)?.no_request).map((it) => {
    const d = decisions.get(it.ref);
    let draft = "";
    let resolve = false;
    if (d?.verdict === "accept") {
      if (d.action === "followup") draft = `この PR では直さず、別の Issue で扱います。${d.reason ?? ""}`;
      else if (d.action === "skip") draft = `対応していません。${d.reason ?? ""}`;
      else if (confirmed.has(it.ref)) {
        draft = commit ? `${d.claim} を直しました（${commit.slice(0, 7)}）。` : `${d.claim} を直しました。`;
        resolve = Boolean(it.thread_id);
      }
    } else if (d?.verdict === "reject") {
      draft = d.followup ? `この PR では直さず、別の Issue で扱います。${d.reason ?? ""}` : `直していません。${d.reason ?? ""}`;
    }
    return {
      ref: it.ref,
      label: `${it.author}${where(it) ? ` · ${where(it)}` : it.kind === "review" ? " のレビュー" : " のコメント"}`,
      quote: it.quote,
      ...(it.thread_id ? { thread_id: it.thread_id } : {}),
      ...(it.url ? { url: it.url } : {}),
      draft: draft.trim(),
      resolve,
    };
  });
}

/**
 * After the feedback is judged, and after the fixes are pushed when there were any, draft one reply per
 * piece of feedback on a single outbound card, and an Issue draft for each follow-up. Nothing is posted
 * here: penne approves the card.
 */
export async function runPrReplies(): Promise<PrRepliesResult> {
  const result: PrRepliesResult = { queued: [], errors: [] };
  const runner = getAgentRunner();
  if (!runner?.queueOutbound || !runner.prStatus) return result;
  const all = readLifecycle();
  for (const rec of readBacklog()) {
    const evs = all.filter((e) => e.idd_id === rec.idd_id);
    if (closed(evs) || laneHeld(evs)) continue;
    const fbAt = lastIndex(evs, "s4_review_comment_received");
    if (fbAt < 0 || lastIndex(evs, "s4_replies_queued") > fbAt) continue;
    const triageAt = evs.findIndex((e, i) => i > fbAt && e.event === "s2_triage_done" && e.attrs?.kind === "feedback" && !e.attrs?.failed);
    if (triageAt < 0) continue;
    // a question to penne is answered on the stuck card first
    const loop = reviewLoopState(evs).state;
    if (loop === "escalated") continue;
    const pushedAt = lastIndex(evs, "s4_pr_created");
    // fixes are replied to with the commit that carries them, so the replies wait for the push. What waits is a
    // fix that was sent (or is about to be, after penne's continue); a pass penne closed as it stood pushes nothing
    const fixing = loop === "send_fix" || evs.some((e, i) => i > triageAt && e.event === "s2_fix_sent");
    if (fixing && pushedAt < triageAt) continue;
    const pr = prOf(evs);
    if (!pr) continue;
    try {
      const status = runner.prStatus(pr.repo, pr.pr);
      if (status.state !== "OPEN") {
        await appendLifecycle("s4_replies_queued", rec.idd_id, { skipped: `PR が ${status.state}` });
        continue;
      }
      const items = (evs[fbAt].attrs?.items as ReceivedItem[] | undefined) ?? [];
      // the judgements that answer this batch: the feedback judgement and the confirm's leftovers before the push
      const endAt = fixing ? pushedAt : evs.length;
      const decisions = lastDecisions(evs, fbAt, endAt);
      const resolved = confirmedFixes(evs, fbAt, endAt);
      const commit = fixing ? String(evs[pushedAt].attrs?.commit ?? "") || undefined : undefined;
      const parts = replyDrafts(items, decisions, commit, resolved);
      let outboundId: string | undefined;
      if (parts.length) {
        ({ id: outboundId } = await runner.queueOutbound({
          kind: "gh-pr-replies",
          target: { repo: pr.repo, pr: pr.pr, expectHead: status.head },
          title: `PR #${pr.pr} への返信`,
          parts,
          source: rec.idd_id,
          lane: rec.idd_id,
        }));
      }
      // a request sent to another Issue gets a draft of its own; both the accepted follow-up and the rejected one
      const followups = [...decisions.values()].filter((d) => (d.verdict === "accept" && d.action === "followup") || (d.verdict === "reject" && d.followup));
      const followupIds: string[] = [];
      for (const d of followups) {
        const it = items.find((i) => i.ref === d.ref);
        const { id } = await runner.queueOutbound({
          kind: "gh-issue",
          target: { repo: pr.repo },
          title: d.claim,
          body: ["## 背景", d.reason ?? "", "", "## 参照", `- 元の指摘: ${it?.url ?? pr.url}`, `- PR: ${pr.url}`].join("\n").trim(),
          source: rec.idd_id,
          lane: rec.idd_id,
        });
        followupIds.push(id);
      }
      await appendLifecycle("s4_replies_queued", rec.idd_id, {
        ...(outboundId ? { outbound_id: outboundId } : { skipped: "返信するものが無い" }),
        parts: parts.length,
        followup_ids: followupIds,
        head: status.head,
      });
      result.queued.push({ iddId: rec.idd_id, ...(outboundId ? { outboundId } : {}), parts: parts.length, followups: followupIds.length });
    } catch (err) {
      result.errors.push({ iddId: rec.idd_id, error: String(err).slice(0, 300) });
    }
  }
  return result;
}
