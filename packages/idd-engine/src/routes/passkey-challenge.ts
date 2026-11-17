import { json } from "../http.ts";
import { requestHost, requestOriginHost } from "../request-connection.ts";
import { acceptedOriginsHint, batchGroups, batchPressLanes, createChallenge, findInstructionProposal, isPasskeyRpId, landBatchContentFor, landContentFor, laneLocations, localCompleteContentFor, pageHostsMatch, passkeyCount, passkeyCredentialIds, passkeyRpId, pressedGroup, readLand, readProposal, shipContentFor, shipSignatureRequired } from "@idd/core";
import { labelsFromPayload, outboundContentFor, readOutbound, resolveOutboundFinal } from "@idd/lane";
import { instructionApprovalContentOf } from "../server/instruction-cards";
import { shipApprovalOf } from "../server/ui-session";
import { needsSignature } from "../server/action-classes";


const REVIEW_EVENTS = ["comment", "request-changes", "approve"] as const;

/**
 * The challenge the inbox page signs before an approval that can change the work side's mainline or leave this
 * machine. The content is built from the approval's own fields through the same builders the gates use, so the
 * signature covers exactly what will be written: `required: false` only for an approval that writes nothing (a
 * record-on-pr, and an approval already carried out), and `registered: 0` when no passkey has been registered yet
 * (the page then offers registration instead of signing).
 */
export async function POST(req: Request) {
  let body: { action?: unknown; payload?: Record<string, unknown>; rpId?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON を読めません" }, { status: 400 });
  }
  const action = String(body.action ?? "");
  const payload = body.payload ?? {};
  // the page names the RP ID it runs under. A request with none keeps answering as the local one, so the
  // existing GUI (which sends none) sees the same challenge as before; a named one must be a configured RP ID
  const requestedRpId = body.rpId === undefined ? passkeyRpId() : String(body.rpId).trim().toLowerCase();
  if (!isPasskeyRpId(requestedRpId)) {
    return json({ ok: false, error: `この RP ID では署名できません。受ける画面は ${acceptedOriginsHint()} です` }, { status: 400 });
  }
  // the RP ID the page names has to be the host the request itself names: naming another host's RP ID is refused
  if (!namedRpIdMatchesRequest(req, requestedRpId)) {
    return json({ ok: false, error: `この RP ID は要求の Host / Origin と合いません。受ける画面は ${acceptedOriginsHint()} です` }, { status: 400 });
  }
  const challengeFor = (content: unknown): Record<string, unknown> => challengeBody(content, requestedRpId);
  // whether a signature is asked for at all comes from the one classification the engine's answer and the decide door read
  // (C-265-9). What stays here is the content each signed action's challenge is made over, and the exemptions of the one
  // action whose need depends on its saved state (a record-on-pr writes nothing)
  if (!needsSignature(action)) return json({ ok: false, error: "署名の要る操作ではありません" }, { status: 400 });
  try {
    if (action === "s4_verify_clean") {
      const approval = shipApprovalOf(payload);
      const iddId = String(payload.iddId ?? "");
      const token = String(payload.token ?? "");
      // the lane's saved state decides whether a signature is asked for (a record-on-pr and an approval already
      // carried out ask for none), so the page and the approval agree. Nothing outbound is answered before the
      // passkey state is read
      if (!shipSignatureRequired(iddId, token, approval)) return json({ ok: true, required: false });
      // a state file that cannot be read is an error here, not an empty set of keys
      const registered = passkeyCount();
      if (!registered) return json({ ok: true, required: true, registered: 0 });
      // a repo that does not publish has a landing record instead of a submit: the signature covers the checked
      // lane head, the work side's mainline branch and the Issue close it carries
      const land = readLand(iddId);
      if (land) return json({ ok: true, required: true, registered, ...challengeFor(landContentFor(land)) });
      const saved = readProposal(iddId);
      if (!saved) return json({ ok: false, error: "提出の記録がありません。検査し直してください" }, { status: 400 });
      // no public change: the records are committed to the work side's mainline, and the lane head is what is signed
      if (saved.mode === "local") return json({ ok: true, required: true, registered, ...challengeFor(localCompleteContentFor(saved)) });
      const loc = laneLocations(iddId);
      if (!loc) return json({ ok: false, error: "提出の記録がありません。検査し直してください" }, { status: 400 });
      const content = shipContentFor(iddId, saved, loc, approval);
      return json({ ok: true, required: true, registered, ...challengeFor(content) });
    }
    if (action === "land_batch_approve") {
      // one signature over the batch card: the lanes left on it, each with the head and the Issue close the card
      // showed, and the repo and mainline branch they go to. A state file that cannot be read is an error here, as
      // for a single landing
      const registered = passkeyCount();
      if (!registered) return json({ ok: true, required: true, registered: 0 });
      const group = batchGroups().find((g) => g.id === String(payload.batch ?? ""));
      if (!group) return json({ ok: false, error: "この本流に取り込みを待つ lane がありません。画面を読み直してください" }, { status: 400 });
      // the heads and closes are the ones the card showed: a head or a close the person did not see is never put in a
      // challenge, and one that changed since is dropped from the batch after the signature, not replaced by today's
      const pressed = pressedGroup(group, batchPressLanes(payload.lanes));
      if (!pressed.ok) return json({ ok: false, error: pressed.error }, { status: 400 });
      return json({ ok: true, required: true, registered, ...challengeFor(landBatchContentFor(pressed.group)) });
    }
    if (action === "outbound_approve") {
      // posting always goes outside: a state file that cannot be read is an error, not an empty set of keys
      const registered = passkeyCount();
      if (!registered) return json({ ok: true, required: true, registered: 0 });
      const id = String(payload.iddId ?? "");
      const rec = readOutbound(id);
      if (!rec) return json({ ok: false, error: `投稿の記録がありません: ${id}` }, { status: 400 });
      const event = REVIEW_EVENTS.includes(String(payload.event) as (typeof REVIEW_EVENTS)[number]) ? (payload.event as "comment" | "request-changes" | "approve") : undefined;
      const parts = Array.isArray(payload.parts)
        ? (payload.parts as { ref?: unknown; body?: unknown; resolve?: unknown }[]).map((p) => ({ ref: String(p?.ref ?? ""), body: String(p?.body ?? ""), resolve: p?.resolve === true }))
        : undefined;
      const labels = labelsFromPayload(payload.labels);
      const resolved = resolveOutboundFinal(rec, { title: String(payload.title ?? ""), body: String(payload.body ?? ""), ...(event ? { event } : {}), ...(parts ? { parts } : {}), ...(labels ? { labels } : {}) });
      if (!resolved.ok) return json({ ok: false, error: resolved.error }, { status: 400 });
      const content = outboundContentFor(rec, resolved.text, resolved.event);
      return json({ ok: true, required: true, registered, ...challengeFor(content) });
    }
    if (action === "instruction_approve") {
      // approving a proposal changes the instructions every later run and conversation reads: it is signed, by a
      // passkey only (a PIN is not offered), over the proposal as it stands now
      const registered = passkeyCount();
      if (!registered) return json({ ok: true, required: true, registered: 0 });
      const id = String(payload.proposal ?? "");
      const proposal = findInstructionProposal(id);
      if (!proposal) return json({ ok: false, error: `その案はありません: ${id}` }, { status: 400 });
      return json({ ok: true, required: true, registered, ...challengeFor(instructionApprovalContentOf(proposal)) });
    }
    if (action === "instruction_reject") {
      // putting a proposal away deletes its text before the user has read it if an agent does it: it is signed over the
      // proposal and the reason, by a passkey only
      const registered = passkeyCount();
      if (!registered) return json({ ok: true, required: true, registered: 0 });
      const id = String(payload.proposal ?? "");
      const proposal = findInstructionProposal(id);
      if (!proposal) return json({ ok: false, error: `その案はありません: ${id}` }, { status: 400 });
      const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
      if (!reason) return json({ ok: false, error: "見送る理由を書いてください" }, { status: 400 });
      return json({ ok: true, required: true, registered, ...challengeFor(instructionApprovalContentOf(proposal, { reason })) });
    }
    return json({ ok: false, error: "署名の要る操作ではありません" }, { status: 400 });
  } catch (error) {
    return json({ ok: false, error: String(error) }, { status: 500 });
  }
}

/**
 * The RP ID a request names, checked the same way the inbox's challenge door checks it: it has to be one the
 * settings accept, and it has to be the host the request itself names. Shared so another challenge door (the idea
 * exits) refuses the same requests with the same words.
 */
export function resolveRequestedRpId(req: Request, raw: unknown): { ok: true; rpId: string } | { ok: false; error: string } {
  const requested = raw === undefined ? passkeyRpId() : String(raw).trim().toLowerCase();
  if (!isPasskeyRpId(requested)) return { ok: false, error: `この RP ID では署名できません。受ける画面は ${acceptedOriginsHint()} です` };
  if (!namedRpIdMatchesRequest(req, requested)) return { ok: false, error: `この RP ID は要求の Host / Origin と合いません。受ける画面は ${acceptedOriginsHint()} です` };
  return { ok: true, rpId: requested };
}

/** the RP ID the page names has to be the host the request itself names (loopback names are the same page) */
export function namedRpIdMatchesRequest(req: Request, rpId: string): boolean {
  const originHost = requestOriginHost(req);
  if (originHost) return pageHostsMatch(originHost, rpId);
  const host = requestHost(req);
  return host ? pageHostsMatch(host, rpId) : true;
}

/**
 * What the page needs to make the signature: the challenge, its one-time nonce, the keys of its RP ID, and the
 * content the challenge was made over.
 *
 * The content comes back because a signer that cannot read the confirm stage (the terminal's PIN approval) has to
 * show what it is signing. The challenge is `SHA-256(contentHash + nonce)`, so a caller that shows this content and
 * rebuilds the challenge from it can tell whether the two are the same before anyone types a PIN. The screen's own
 * rows are built from its state, so an extra field changes nothing there.
 */
export function challengeBody(content: unknown, rpId: string): Record<string, unknown> {
  const { nonce, challenge, expiresAt } = createChallenge(content);
  return {
    nonce,
    challenge,
    expiresAt,
    rpId,
    content,
    allowCredentials: passkeyCredentialIds(rpId).map((id) => ({ id, type: "public-key" })),
  };
}
