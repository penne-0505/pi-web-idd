
import { json } from "../http.ts";
import { applyDecision, approvalGateOpen, approveBatch, batchPressLanes, approveGranularity, approveInstructionProposal, consumeNonce, findInstructionProposal, approveProposal, ignoreLane, ignorePendingReview, INBOX_SESSION, laneHasEnded, proposalAnsweredEnvelope, queueEnvelope, readLifecycle, redoLane, rejectInstructionProposal, approveSessionProposal, rejectProposal, resolveAreaKey, runShip, openSubmitAfterS3, prepareSubmit, proposePrBodyUpdate, verifyApprovalSignature, type AfterDecision } from "@idd/core";
import { ensureAgentRunner } from "../server/agent-runner";
import { settleConsultsAfterAnswer } from "../server/consult.ts";
import { approveOutbound, discardOutbound, labelsFromPayload } from "@idd/lane";
import { instructionApprovalContentOf } from "../server/instruction-cards";
import { applySessionException } from "../server/instruction-session";
import { shipApprovalOf } from "../server/ui-session";
import { unclassifiedActions } from "../server/action-classes";
import { kickTickAfterDecision, kickTickAfterRecord, runDecisionFollowUps } from "../server/tick-kick";


export async function POST(req: Request) {
  let body: { action?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON を読めません" }, { status: 400 });
  }
  if (!body.action) return json({ ok: false, error: "action が空" }, { status: 400 });
  // a decision the engine's classification does not name is neither outbound nor local: it is refused rather than let out
  // without a decision about its signature (C-265-2)
  if (unclassifiedActions([body.action]).length) return json({ ok: false, error: `未対応の action: ${body.action}（engine の分類に無い操作は受けません）` }, { status: 400 });

  try {
    // 送出カード: penne の承認でだけ投稿する。エージェント側の道具には承認の口が無い
    if (body.action === "outbound_approve" || body.action === "outbound_discard") {
      const payload = body.payload ?? {};
      const id = String(payload.iddId ?? "");
      if (body.action === "outbound_discard") {
        discardOutbound(id);
        kickTickAfterDecision(body.action, true);
        return json({ ok: true });
      }
      const event = ["comment", "request-changes", "approve"].includes(String(payload.event)) ? (payload.event as "comment" | "request-changes" | "approve") : undefined;
      const parts = Array.isArray(payload.parts)
        ? (payload.parts as { ref?: unknown; body?: unknown; resolve?: unknown }[]).map((p) => ({ ref: String(p?.ref ?? ""), body: String(p?.body ?? ""), resolve: p?.resolve === true }))
        : undefined;
      const labels = labelsFromPayload(payload.labels);
      const rec = await approveOutbound(id, {
        title: String(payload.title ?? ""), body: String(payload.body ?? ""),
        ...(event ? { event } : {}), ...(parts ? { parts } : {}), ...(labels ? { labels } : {}),
        ...(typeof payload.nonce === "string" ? { nonce: payload.nonce } : {}),
        ...(payload.assertion && typeof payload.assertion === "object" ? { assertion: payload.assertion } : {}),
        ...(payload.pinProof && typeof payload.pinProof === "object" ? { pinProof: payload.pinProof } : {}),
      });
      kickTickAfterDecision(body.action, rec.status === "posted");
      return json(
        rec.status === "posted" ? { ok: true, url: rec.posted?.url, ...(rec.posted?.warning ? { warning: rec.posted.warning } : {}) } : { ok: false, error: rec.error ?? "投稿に失敗しました" },
        { status: rec.status === "posted" ? 200 : 502 },
      );
    }
    if (body.action === "s4_prepare" || body.action === "s4_verify_clean") {
      const payload = body.payload ?? {};
      const id = String(payload.iddId ?? "");
      if (body.action === "s4_prepare") {
        // only checks: the push waits for penne's approval on the card. The tick drafts the commit message of the push
        const view = await prepareSubmit(id, payload.pr as { title: string; body: string } | undefined, { start: false });
        if (!("error" in view)) kickTickAfterRecord();
        return json("error" in view ? { ok: false, error: view.error } : { ok: true, view }, { status: "error" in view ? 400 : 200 });
      }
      // the push goes out with the commit message penne approved on the card, and a new PR with its title and body
      const result = await runShip(id, String(payload.token ?? ""), shipApprovalOf(payload));
      kickTickAfterDecision(body.action, result.ok);
      return json(result, { status: result.ok ? 200 : 400 });
    }
    // One signature over the batch card: the lanes left on it are laid on the mainline together, checked once, and
    // landed by the tick from here on (C-247-1, C-247-2). The signature is checked over exactly the lanes it names.
    if (body.action === "land_batch_approve") {
      ensureAgentRunner();
      const payload = body.payload ?? {};
      const signed = shipApprovalOf(payload);
      const result = await approveBatch({
        batch: String(payload.batch ?? ""), lanes: batchPressLanes(payload.lanes),
        ...(signed.nonce ? { nonce: signed.nonce } : {}), assertion: signed.assertion, pinProof: signed.pinProof,
      });
      kickTickAfterDecision(body.action, result.ok);
      return json(
        result.ok ? { ok: true, phase: result.batch.phase, landed: result.landed, dropped: result.batch.dropped.map((d) => ({ iddId: d.iddId, reason: d.reason })) } : { ok: false, error: result.error },
        { status: result.ok ? 200 : 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    // a proposed update of a PR's body: only a card is queued, nothing is written to the PR
    if (body.action === "pr_body_propose") {
      // the draft and the card go through the runtime's runner
      ensureAgentRunner();
      const r = await proposePrBodyUpdate(String(body.payload?.iddId ?? ""));
      return json(r, { status: r.ok ? 200 : 400 });
    }
    // An instruction proposal's answer is the user's alone: approving it is the one call that changes the instructions in
    // force (a conversation's agent can only file the proposal). No lane is involved, so nothing is queued to one.
    // The approval carries the user's passkey signature over the proposal as it stands: the agent token and a plain
    // request are not a proof, so an agent that can reach this door still cannot approve its own proposal. A
    // rejection changes nothing in force, but it deletes the proposal's text and scope from the open file, which an
    // agent that reached this door could do before the user read it: so it carries the same signature, over the
    // proposal and the reason it is put away with.
    if (body.action === "instruction_reject") {
      const payload = body.payload ?? {};
      const id = String(payload.proposal ?? "");
      const proposal = findInstructionProposal(id);
      if (!proposal) return json({ ok: false, error: `その案はありません: ${id}` }, { status: 400, headers: { "Cache-Control": "no-store" } });
      const nonce = typeof payload.nonce === "string" ? payload.nonce : undefined;
      const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
      if (!reason) return json({ ok: false, error: "見送る理由を書いてください" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      const content = instructionApprovalContentOf(proposal, { reason });
      const signed = await verifyApprovalSignature({ nonce, assertion: payload.assertion, content, compareContent: true });
      if (!signed.ok) return json({ ok: false, error: signed.reason }, { status: 403, headers: { "Cache-Control": "no-store" } });
      const gate = approvalGateOpen(nonce, content);
      if (!gate.ok) return json({ ok: false, error: gate.reason }, { status: 403, headers: { "Cache-Control": "no-store" } });
      try {
        const r = rejectInstructionProposal(id, reason);
        return json(r.ok ? { ok: true, id, kind: r.proposal.kind, effect: "none" } : r, { status: r.ok ? 200 : 400, headers: { "Cache-Control": "no-store" } });
      } finally {
        consumeNonce(nonce);
      }
    }
    if (body.action === "instruction_approve") {
      const payload = body.payload ?? {};
      const id = String(payload.proposal ?? "");
      const proposal = findInstructionProposal(id);
      if (!proposal) return json({ ok: false, error: `その案はありません: ${id}` }, { status: 400, headers: { "Cache-Control": "no-store" } });
      const nonce = typeof payload.nonce === "string" ? payload.nonce : undefined;
      const content = instructionApprovalContentOf(proposal);
      // the passkey's own check only: a PIN's proof is never read here
      const signed = await verifyApprovalSignature({ nonce, assertion: payload.assertion, content, compareContent: true });
      if (!signed.ok) return json({ ok: false, error: signed.reason }, { status: 403, headers: { "Cache-Control": "no-store" } });
      const gate = approvalGateOpen(nonce, content);
      if (!gate.ok) return json({ ok: false, error: gate.reason }, { status: 403, headers: { "Cache-Control": "no-store" } });
      try {
        // a session proposal changes one conversation's own list, which the engine writes; every other kind changes the instructions
        const r = proposal.kind === "session" ? approveSessionProposal(id, applySessionException) : approveInstructionProposal(id);
        return json(r.ok ? { ok: true, id, kind: r.proposal.kind, effect: "next_start" } : r, { status: r.ok ? 200 : 400, headers: { "Cache-Control": "no-store" } });
      } finally {
        consumeNonce(nonce);
      }
    }
    // A proposal's answer is penne's alone: it is not a stage's decision, so the lane gate is not taken and the
    // core function is called beside the table (as `ignore` is). The word goes back to the lane that raised it
    // when that lane is still open; failing to queue it never fails the answer.
    if (body.action === "proposal_approve" || body.action === "proposal_reject") {
      const payload = body.payload ?? {};
      const key = resolveAreaKey(String(payload.repo ?? ""));
      if ("error" in key) return json({ ok: false, error: key.error }, { status: 400, headers: { "Cache-Control": "no-store" } });
      const approver = { session: INBOX_SESSION };
      const approved = body.action === "proposal_approve";
      const r = approved
        ? await approveProposal({ repo: key.key, proposal: payload.proposal, approver })
        : await rejectProposal({ repo: key.key, proposal: payload.proposal, reason: payload.reason, approver });
      if (!r.ok) return json(r, { status: 400, headers: { "Cache-Control": "no-store" } });
      let warning: string | undefined;
      if (r.origin.lane && !laneHasEnded(r.origin.lane, readLifecycle())) {
        try {
          await queueEnvelope(r.origin.lane, "info_update", proposalAnsweredEnvelope({ id: r.id, kind: r.kind }, approved, String(payload.reason ?? ""), r.effect));
          kickTickAfterRecord();
        } catch (err) {
          warning = `案の答えは記録しましたが、伝言を積めませんでした: ${String(err).slice(0, 200)}`;
        }
      }
      return json({ ...r, ...(warning ? { warning } : {}) }, { status: 200, headers: { "Cache-Control": "no-store" } });
    }
    // Approving a granularity proposal closes the lane: the children are opened by a person from a later Issue, so
    // the approval puts the parent's Issue on the ignore list like `ignore` does, and its sessions and runs stop.
    // The child limit is checked in core, so a card that was built before the proposal changed cannot approve an
    // over-limit split. Like `ignore`, it is called beside the ledger's table and holds the gate only for its writes.
    if (body.action === "granularity_approve") {
      ensureAgentRunner();
      const r = await approveGranularity(String(body.payload?.iddId ?? body.payload?.id ?? ""));
      if (r.ok) kickTickAfterRecord();
      return json(r, { status: r.ok ? 200 : 400, headers: { "Cache-Control": "no-store" } });
    }
    // `ignore` and `lane_redo` are not decisions of the ledger's table: they close a lane and either put its Issue
    // on the ignore list or open a new lane from it, so they are called here. The runner is put in first: stopping
    // the lane's sessions and runs right here is half of what they do, and the server's first ignore must not run
    // without it. Each holds the lane gate only for its own writes.
    if (body.action === "ignore" || body.action === "lane_redo") {
      ensureAgentRunner();
      const payload = body.payload ?? {};
      const reviewId = String(payload.reviewId ?? "");
      const r = body.action === "lane_redo"
        ? await redoLane(String(payload.iddId ?? ""))
        : reviewId
          ? await ignorePendingReview(reviewId)
          // the reason a card sends (the re-take card's drop) is what the lane's close records
          : await ignoreLane(String(payload.iddId ?? ""), { reason: String(payload.reason ?? "") });
      if (r.ok) kickTickAfterRecord();
      return json(r, { status: r.ok ? 200 : 400, headers: { "Cache-Control": "no-store" } });
    }
    const result = await applyDecision(body.action, body.payload ?? {});
    // an answered batch may have no open question left: settle the consults without holding the answer back.
    // The cleanup is housekeeping, so its failure is logged and dropped rather than rejecting here.
    if (result.ok && body.action === "answer") settleConsultsAfterAnswer();
    let ship: unknown;
    let warning: string | undefined;
    if (result.ok && body.action === "s3_ok") {
      // the pass is recorded; a submit card that did not open (a busy gate) is said on the screen, and the tick opens it
      const opened = await openSubmitAfterS3(String(body.payload?.iddId ?? ""));
      if ("view" in opened) ship = opened.view;
      else warning = opened.warning;
    }
    // the executor after a GO and the queued envelopes start under the tick's lock; a running tick takes them instead
    if (result.ok) ensureAgentRunner();
    const after: AfterDecision = await runDecisionFollowUps(body.action, result.ok);
    return json({ ...result, delivery: after.delivery, ship, started: after.started, ...(after.deferred ? { deferred: after.deferred } : {}), ...(warning ? { warning } : {}) }, {
      status: result.ok ? 200 : 400,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return json({ ok: false, error: String(error) }, { status: 500 });
  }
}
