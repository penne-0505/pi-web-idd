/**
 * The granularity proposal: the planner's judgement, made after its survey and before it writes the request,
 * of whether this lane stays one lane, becomes children, or merges into an Issue that already exists. Splitting
 * and merging both change how many signatures a change takes, so either waits for a person however shallow the
 * lane is; a "single" judgement changes nothing and only leaves its reason in the record. The questions, the
 * fixed costs and the report's shape travel in the planner's brief, and the one place that reads a proposal back
 * is here, so the stage, the card and the report agree on what a proposal is.
 */

import { laneAnswer } from "../intent/moonbit-fold.ts";
import type { LifecycleRecord } from "../schema/records.ts";

export type GranularityKind = "single" | "split" | "merge";

/**
 * The event a proposal is written under while the stage is stopped (roles.yaml `pipeline.granularity` is not `on`).
 * The proposal is kept so a later measurement can read what planners asked for, but nothing reads it back as a
 * proposal: `granularityProposalOf` looks only at `s1_granularity_proposed`, so a stopped stage's proposal never puts
 * a card in front of a person, never holds the lane, and never asks for the "1本" reason. Recording it under its own
 * name also keeps turning the stage back on from turning those old proposals into cards.
 */
export const GRANULARITY_RECORDED_EVENT = "s1_granularity_recorded";

/** one child of a split: what it is for, its whole sentence, the places it touches and the children it comes after */
export interface GranularityChild {
  title: string;
  /** the child's 完了の形の全体 1 文 (the 9-granularity axis: a duty is one independently judgeable finish) */
  whole: string;
  places: string[];
  /** the 0-based indices of the children that must land before it (the ordered children of 9.3.4) */
  after: number[];
}

export interface GranularityProposal {
  kind: GranularityKind;
  /** why the planner judged so: for "single", the "1本" reason the ready keeps */
  reason: string;
  children?: GranularityChild[];
  mergeTarget?: { ref: string; title?: string };
}

/** the most children one parent may have (9.6); more is a sign the intake's slicing is wrong, not a split */
export const GRANULARITY_CHILD_LIMIT = 4;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function refusal(problem: string): { ok: false; error: string } {
  return { ok: false, error: problem };
}

/**
 * The proposal as the planner sent it. An empty kind, an empty reason, a split with no child or a child missing
 * its title / whole / places, and a merge with no target are refused here, before the record is written: the card
 * shows these fields, so a missing one is a card with a hole. More children than the limit are taken as they are
 * (the card shows them as a re-slicing, never as an approvable split): refusing at the report would push the
 * planner to squeeze the children or fall back to one lane, and the signal would be lost.
 */
export function normalizeGranularity(raw: unknown): { ok: true; proposal: GranularityProposal } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return refusal('粒度の案は JSON の object で送ってください: {"kind":"single|split|merge","reason":"..."}');
  const obj = raw as Record<string, unknown>;
  const kind = text(obj.kind);
  if (kind !== "single" && kind !== "split" && kind !== "merge") return refusal(`kind は single / split / merge のどれかにしてください: ${kind || "（空）"}`);
  const reason = text(obj.reason);
  if (!reason) return refusal("案の理由（reason）を 1 文で書いてください");
  if (kind === "single") return { ok: true, proposal: { kind, reason } };
  if (kind === "merge") {
    const target = obj.merge_target ?? obj.mergeTarget;
    const ref = text(target && typeof target === "object" && !Array.isArray(target) ? (target as Record<string, unknown>).ref : target);
    if (!ref) return refusal("合流の案には合流の先（merge_target）が要ります");
    const title = target && typeof target === "object" && !Array.isArray(target) ? text((target as Record<string, unknown>).title) : "";
    return { ok: true, proposal: { kind, reason, mergeTarget: { ref, ...(title ? { title } : {}) } } };
  }
  if (!Array.isArray(obj.children) || obj.children.length === 0) return refusal("分割の案には子（children）が 1 つ以上要ります");
  const rawChildren = obj.children;
  const children: GranularityChild[] = [];
  for (let i = 0; i < rawChildren.length; i += 1) {
    const raw = rawChildren[i];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return refusal(`children[${i}] は object で書いてください`);
    const c = raw as Record<string, unknown>;
    const title = text(c.title);
    const whole = text(c.whole);
    const places = Array.isArray(c.places) ? c.places.map(text).filter(Boolean) : [];
    if (!title) return refusal(`children[${i}] の title を書いてください`);
    if (!whole) return refusal(`children[${i}] の whole（完了の形の全体 1 文）を書いてください`);
    if (!places.length) return refusal(`children[${i}] の places（触る Place）を 1 つ以上書いてください`);
    const afterRaw = c.after === undefined || c.after === null ? [] : Array.isArray(c.after) ? c.after : [c.after];
    const after = afterRaw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n < rawChildren.length && n !== i);
    children.push({ title, whole, places, after });
  }
  return { ok: true, proposal: { kind, reason, children } };
}

/** the proposal's own `at` beside it, so a reader can tell when it came */
export interface ProposedGranularity extends GranularityProposal {
  at: string;
}

function proposalFrom(record: LifecycleRecord): GranularityProposal | null {
  const attrs = record.attrs ?? {};
  const normalized = normalizeGranularity({ kind: attrs.kind, reason: attrs.reason, children: attrs.children, merge_target: attrs.merge_target });
  return normalized.ok ? normalized.proposal : null;
}

/** the lane's last granularity proposal, or null when it made none (an older brief's lane) */
export function granularityProposalOf(events: { event: string; at?: string; attrs?: Record<string, unknown> }[]): ProposedGranularity | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event !== "s1_granularity_proposed") continue;
    const proposal = proposalFrom(events[i] as LifecycleRecord);
    return proposal ? { ...proposal, at: String(events[i].at ?? "") } : null;
  }
  return null;
}

/** the person's answer to the lane's last proposal, or null when it has none since */
export function granularityAnswerOf(events: { event: string; at?: string; attrs?: Record<string, unknown> }[]): { decision: GranularityAnswer; instruction: string; at: string } | null {
  let proposed = -1;
  for (let i = 0; i < events.length; i += 1) if (events[i].event === "s1_granularity_proposed") proposed = i;
  if (proposed < 0) return null;
  for (let i = events.length - 1; i > proposed; i -= 1) {
    if (events[i].event !== "s1_granularity_answered") continue;
    const a = events[i].attrs ?? {};
    const decision = text(a.decision);
    if (decision !== "approve" && decision !== "single" && decision !== "revise") continue;
    return { decision, instruction: text(a.instruction), at: String(events[i].at ?? "") };
  }
  return null;
}

export type GranularityAnswer = "approve" | "single" | "revise";

/**
 * Whether the lane stands on an unanswered split / merge proposal: the stage turns this into the person's card,
 * and the watch and the turn read the same answer through `deriveStage`. A "single" proposal changes nothing, so
 * it never waits.
 */
export function granularityWaiting(events: { event: string; attrs?: Record<string, unknown> }[]): boolean {
  // the same answer the stage reads, folded by the MoonBit derivation, so a proposal cannot be a card in one place
  // and not in the other (C-191-1)
  return laneAnswer<boolean>("granularity_waiting", events as LifecycleRecord[]);
}

/** whether a proposal may be taken as a split: a "merge" is never approved as a split, and over the limit the card
 * shows a re-slicing of the intake instead */
export function granularityApprovable(proposal: GranularityProposal): boolean {
  if (proposal.kind === "single") return false;
  if (proposal.kind === "merge") return true;
  return (proposal.children?.length ?? 0) <= GRANULARITY_CHILD_LIMIT;
}
