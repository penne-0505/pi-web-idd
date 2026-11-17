import type { LifecycleRecord } from "../schema/records.ts";

/**
 * The depth table and its readings, held by the copies that are measured against the MoonBit fold.
 *
 * Two values sit here, and neither is read from the fold: `DEPTH_TABLE_TS` is the table the TypeScript held as a
 * literal before the migration (`1c0e041c` removed it), and `DEPTH_TABLE_REFERENCE` is the table the copies answer
 * with. They differ at one point only, the decision penne took on 2026-10-19 that every depth runs the senior role's
 * final review: `shallow` and `standard` went from `false` to `true` for `finalReview`. The TypeScript would have
 * carried that decision too had it still held the rows, and the copies keep it, so the values below are the answer
 * of the retired TS derivation and not a copy of the fold's current rows.
 *
 * The running path reads the one table MoonBit writes (`plan/depth.ts`), and it stays that way: two tables on the
 * running path let the plan review's roles and the loop's stages disagree on how many reviews a depth gets. A copy
 * that read that module would share the table with the fold, and a wrong table on the MoonBit side would make the
 * fold and the copy take the same number of reviews: the comparison would show nothing (C-206-1, C-206-2). This
 * module reads no part of the fold, not even a type, so a change to the MoonBit rows shows up as a difference the
 * tests can see.
 */

/** how deep a lane goes; named here so no copy reaches `plan/depth.ts` for the type */
export type Depth = "shallow" | "standard" | "deep";

/** what a depth decides, as far as the copies read it */
export interface DepthRow {
  /** the roles the plan review runs */
  planReview: number;
  /** the roles the per-round review runs */
  blind: number;
  /** the spec checks a blind round, and the last review, start beside it on the same head */
  spec: number;
  /** whether the high-risk role runs as the last review */
  finalReview: boolean;
  /** the fix rounds a round may send before it asks penne */
  fixRounds: number;
  /** whether the engine may record the GO itself */
  autoGo: boolean;
  /** the shape judge runs the plan review starts beside its reviewers (C-252-1) */
  shape: number;
}

/** the rows as the TypeScript held them before the migration, the last review of a shallow or standard lane off; the spec check came after */
export const DEPTH_TABLE_TS: Record<Depth, Omit<DepthRow, "spec" | "shape">> = {
  shallow: { planReview: 1, blind: 1, finalReview: false, fixRounds: 1, autoGo: true },
  standard: { planReview: 2, blind: 2, finalReview: false, fixRounds: 2, autoGo: false },
  deep: { planReview: 2, blind: 2, finalReview: true, fixRounds: 3, autoGo: false },
};

/** the rows the copies answer with: the same table with the 2026-10-19 decision (every depth runs the last review) and the spec check of 2026-10-26 (one beside every blind round), and the shape judge (one beside the deep plan review) */
export const DEPTH_TABLE_REFERENCE: Record<Depth, DepthRow> = {
  shallow: { planReview: 1, blind: 1, spec: 1, finalReview: true, fixRounds: 1, autoGo: true, shape: 0 },
  standard: { planReview: 2, blind: 2, spec: 1, finalReview: true, fixRounds: 2, autoGo: false, shape: 0 },
  deep: { planReview: 2, blind: 2, spec: 1, finalReview: true, fixRounds: 3, autoGo: false, shape: 1 },
};

export function isDepthReference(v: unknown): v is Depth {
  return v === "shallow" || v === "standard" || v === "deep";
}

/**
 * The depth a lane declared in its ready, as the TypeScript read it: the last ready before the last GO, and not a
 * ready written after the GO.
 */
export function recordedDepthReference(events: LifecycleRecord[]): Depth | undefined {
  let go = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === "s1_go") { go = i; break; }
  const from = go >= 0 ? go - 1 : events.length - 1;
  for (let i = from; i >= 0; i -= 1) {
    if (events[i].event !== "s1_ready") continue;
    const d = events[i].attrs?.depth;
    return isDepthReference(d) ? d : undefined;
  }
  return undefined;
}
