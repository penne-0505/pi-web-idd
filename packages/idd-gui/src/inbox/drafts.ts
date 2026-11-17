/**
 * What penne has edited on the cards, held in one place per card key.
 *
 * The engine's state is read again every few seconds (and right after a signature). If a read replaced a field
 * penne is writing in, the edit would vanish, and the next → would sign the text she had already changed. So a read
 * replaces only the fields she has not touched. The key of a submit carries its head: what was written for one head
 * is not carried to the next.
 */
import type { InboxItem, LandBatchItem, OutboundItem, ShipItem } from "../engine/contract";
import { shipCardKey } from "../engine/contract";
import { batchDraftFor, outboundDraftFor, shipDraftFor, type BatchDraft, type OutboundDraft, type OutboundReplyDraft, type ShipDraft } from "./approval";
import { itemKey } from "./deck";
import { stuckFindingsOf, validPicks, type FindingAction, type StuckPicks } from "./stuck-findings";

export interface ShipEntry {
  draft: ShipDraft;
  touched: { title: boolean; body: boolean; commitMessage: boolean };
}

export interface OutboundEntry {
  draft: OutboundDraft;
  touched: { title: boolean; body: boolean; replies: Set<string>; event: boolean; labels: boolean };
}

export interface DraftState {
  ship: Record<string, ShipEntry>;
  outbound: Record<string, OutboundEntry>;
  /** the lanes taken off each batch card, by the card's key (C-247-1) */
  batch: Record<string, BatchDraft>;
  /** the names penne typed for a GO card's proposed Purposes, by `iddId:proposalId` */
  goNames: Record<string, string>;
  /** the reason penne wrote for passing a GO over a must the plan review left, by lane (`iddId`) */
  goReasons: Record<string, string>;
  /** the handling penne picked for each finding of a stopped review card, by lane then ref (C-272-1) */
  stuckPicks: Record<string, Record<string, FindingAction>>;
}

export function emptyDrafts(): DraftState {
  return { ship: {}, outbound: {}, batch: {}, goNames: {}, goReasons: {}, stuckPicks: {} };
}

/** what penne picked on one lane's stopped card: no entry for a finding she left as it stands */
export function stuckPicksOf(state: DraftState, iddId: string): StuckPicks {
  return state.stuckPicks[iddId] ?? {};
}

/** pick a handling for one finding, or take the pick off again when it is the one already picked */
export function setStuckPick(state: DraftState, iddId: string, ref: string, action: FindingAction): DraftState {
  const held = { ...stuckPicksOf(state, iddId) };
  if (held[ref] === action) delete held[ref];
  else held[ref] = action;
  return { ...state, stuckPicks: { ...state.stuckPicks, [iddId]: held } };
}

/** the key one proposed Purpose's typed name is held under */
export function goNamesKey(iddId: string, proposalId: string): string {
  return `${iddId}:${proposalId}`;
}

/** the names shown for one GO card's proposals: what penne typed, or an empty line */
export function goNamesOf(state: DraftState, iddId: string, proposals: { id: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of proposals ?? []) out[p.id] = state.goNames[goNamesKey(iddId, p.id)] ?? "";
  return out;
}

export function setGoName(state: DraftState, iddId: string, proposalId: string, value: string): DraftState {
  return { ...state, goNames: { ...state.goNames, [goNamesKey(iddId, proposalId)]: value } };
}

/** the reason held for one lane's GO: what penne wrote, or an empty line */
export function goReasonOf(state: DraftState, iddId: string): string {
  return state.goReasons[iddId] ?? "";
}

export function setGoReason(state: DraftState, iddId: string, value: string): DraftState {
  return { ...state, goReasons: { ...state.goReasons, [iddId]: value } };
}

export function shipEntryOf(state: DraftState, item: ShipItem): ShipEntry {
  return state.ship[shipCardKey(item)] ?? { draft: shipDraftFor(item), touched: { title: false, body: false, commitMessage: false } };
}

/** the lanes taken off a batch card, or none taken off */
export function batchDraftOf(state: DraftState, item: LandBatchItem): BatchDraft {
  return state.batch[itemKey(item)] ?? batchDraftFor();
}

/** take one lane off the batch card, or put it back */
export function setBatchLane(state: DraftState, item: LandBatchItem, iddId: string, off: boolean): DraftState {
  const held = new Set(batchDraftOf(state, item).off);
  if (off) held.add(iddId);
  else held.delete(iddId);
  return { ...state, batch: { ...state.batch, [itemKey(item)]: { off: held } } };
}

export function outboundEntryOf(state: DraftState, item: OutboundItem): OutboundEntry {
  return state.outbound[itemKey(item)] ?? { draft: outboundDraftFor(item), touched: { title: false, body: false, replies: new Set<string>(), event: false, labels: false } };
}

function mergeReplies(shown: OutboundReplyDraft[], touched: ReadonlySet<string>, incoming: OutboundReplyDraft[]): OutboundReplyDraft[] {
  const byRef = new Map(shown.map((r) => [r.ref, r]));
  return incoming.map((r) => {
    const held = byRef.get(r.ref);
    return held && touched.has(r.ref) ? { ...r, body: held.body, resolve: held.resolve } : r;
  });
}

/**
 * Apply a read of the engine's state: every card present keeps its edits, every field penne has not touched takes
 * the fresh value, and a card that is gone (or a submit at another head) leaves nothing behind.
 */
export function applyDrafts(state: DraftState, items: InboxItem[]): DraftState {
  const ship: Record<string, ShipEntry> = {};
  const outbound: Record<string, OutboundEntry> = {};
  const batch: Record<string, BatchDraft> = {};
  // a name typed for a proposal that is no longer a proposal of this lane's GO is let go with the card
  const keptNames = new Set<string>();
  // a reason written for a GO is let go with the card, and kept across every read while the card stays
  const keptReasons = new Set<string>();
  // a pick is kept while its finding is still on the card with that handling, and let go with the card
  const stuckPicks: Record<string, Record<string, FindingAction>> = {};
  for (const item of items) {
    if (item.kind === "stuck") {
      const kept = validPicks(stuckFindingsOf(item), state.stuckPicks[item.iddId] ?? {});
      if (Object.keys(kept).length) stuckPicks[item.iddId] = { ...kept };
    }
    if (item.kind !== "go") continue;
    keptReasons.add(item.iddId);
    for (const p of item.purposeProposals ?? []) keptNames.add(goNamesKey(item.iddId, p.id));
  }
  for (const item of items) {
    if (item.kind === "ship") {
      const key = shipCardKey(item);
      const incoming = shipDraftFor(item);
      const existing = state.ship[key];
      ship[key] = existing
        ? {
          draft: {
            title: existing.touched.title ? existing.draft.title : incoming.title,
            body: existing.touched.body ? existing.draft.body : incoming.body,
            commitMessage: existing.touched.commitMessage ? existing.draft.commitMessage : incoming.commitMessage,
          },
          touched: existing.touched,
        }
        : { draft: incoming, touched: { title: false, body: false, commitMessage: false } };
    } else if (item.kind === "land-batch") {
      // a lane that left the card is let go from the set: only the lanes the card still offers can be off
      const key = itemKey(item);
      const offered = new Set(item.lanes.map((l) => l.iddId));
      batch[key] = { off: new Set([...(state.batch[key]?.off ?? [])].filter((id) => offered.has(id))) };
    } else if (item.kind === "outbound") {
      const key = itemKey(item);
      const incoming = outboundDraftFor(item);
      const existing = state.outbound[key];
      outbound[key] = existing
        ? {
          draft: {
            title: existing.touched.title ? existing.draft.title : incoming.title,
            body: existing.touched.body ? existing.draft.body : incoming.body,
            event: existing.touched.event ? existing.draft.event : incoming.event,
            labelsOff: existing.touched.labels ? existing.draft.labelsOff : incoming.labelsOff,
            replies: existing.draft.replies.length ? mergeReplies(existing.draft.replies, existing.touched.replies, incoming.replies) : incoming.replies,
          },
          touched: existing.touched,
        }
        : { draft: incoming, touched: { title: false, body: false, replies: new Set<string>(), event: false, labels: false } };
    }
  }
  return {
    ship,
    outbound,
    batch,
    goNames: Object.fromEntries(Object.entries(state.goNames).filter(([key]) => keptNames.has(key))),
    goReasons: Object.fromEntries(Object.entries(state.goReasons).filter(([key]) => keptReasons.has(key))),
    stuckPicks,
  };
}

export function setShipField(state: DraftState, item: ShipItem, field: keyof ShipDraft, value: string): DraftState {
  const key = shipCardKey(item);
  const entry = shipEntryOf(state, item);
  return { ...state, ship: { ...state.ship, [key]: { draft: { ...entry.draft, [field]: value }, touched: { ...entry.touched, [field]: true } } } };
}

export function setOutboundField(state: DraftState, item: OutboundItem, patch: Partial<OutboundDraft>): DraftState {
  const key = itemKey(item);
  const entry = outboundEntryOf(state, item);
  const touched = { ...entry.touched, ...patchTouched(patch) };
  return { ...state, outbound: { ...state.outbound, [key]: { draft: { ...entry.draft, ...patch }, touched } } };
}

export function setOutboundReply(state: DraftState, item: OutboundItem, ref: string, patch: Partial<OutboundReplyDraft>): DraftState {
  const entry = outboundEntryOf(state, item);
  const replies = entry.draft.replies.map((r) => (r.ref === ref ? { ...r, ...patch } : r));
  const touched = { ...entry.touched, replies: new Set([...entry.touched.replies, ref]) };
  return { ...state, outbound: { ...state.outbound, [itemKey(item)]: { draft: { ...entry.draft, replies }, touched } } };
}

function patchTouched(patch: Partial<OutboundDraft>): Partial<OutboundEntry["touched"]> {
  const out: Partial<OutboundEntry["touched"]> = {};
  if ("title" in patch) out.title = true;
  if ("body" in patch) out.body = true;
  if ("event" in patch) out.event = true;
  if ("labelsOff" in patch) out.labels = true;
  if ("replies" in patch) out.replies = new Set(patch.replies?.map((r) => r.ref) ?? []);
  return out;
}
