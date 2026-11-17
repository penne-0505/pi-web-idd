import {
  buildSubmit, laneBase, laneBaseMissing, laneBranchSource, laneDiffAll, laneDiffFiles, laneIntent, laneLedgerChoices, laneCost, readBacklog, readLifecycle, readSessions, readSubmitReadings,
} from "@idd/core";
import type {
  BacklogRecord, CostPart, DailyCost, LaneIntent, LaneIntentOpts, LifecycleRecord, SubmitReadings, SubmitView,
} from "@idd/core";

/**
 * The state and Work answers mix two kinds of value. What the ledger says is cheap once the columns are read
 * incrementally, and it is what penne's own judgment just wrote, so it must be read at the moment of the answer.
 * What git and the lane's own worktree say — the submit card's checks and branch, the review card's diff, the
 * closed lanes' DEC counts — costs seconds per lane (a synchronous `git` per call), and what the lane costs is
 * read from its conversation files. Reading those inside an answer is what made one answer take twenty seconds
 * and block the judgment door behind it.
 *
 * So those three readings are handed in instead of taken. The engine's answer passes what the last derivation
 * found; the derivation itself passes the readers below and records what they answered. Both sides run the same
 * `buildState` / `buildWork` over the same ledger, so the answer differs from a whole derivation only in the
 * values that were handed in — and those are the ones the contract allows to lag by one interval.
 */
export interface LaneCostView {
  total: number;
  subscription: CostPart[];
  daily: DailyCost[];
}

export interface ReviewDiffView {
  baseNote?: string;
  /** whether the lane's base could be read; the diff fields only exist when it could */
  compared: boolean;
  diffFiles?: string[];
  /** every changed file with its own diff, read by the core's `laneDiffAll` (the one reading of the lane's diff): the review card is read file by file from it */
  diffs?: ReturnType<typeof laneDiffAll>;
  /** the lane's branch, where the whole of a file the card cut can be read */
  branch?: string;
}

/** where a lane's work can be read once its worktree is gone: the branch it left behind, in its repo */
export interface LaneBranch {
  repo: string;
  ref: string;
}

export interface DerivedDeps {
  intent(rec: BacklogRecord, opts: LaneIntentOpts): LaneIntent;
  /** the branch a retired worktree left behind; `undefined` while the worktree is still there */
  laneRef(rec: BacklogRecord): LaneBranch | undefined;
  submit(iddId: string): SubmitView | null;
  reviewDiff(iddId: string, events: LifecycleRecord[]): ReviewDiffView;
  cost(iddId: string, events: LifecycleRecord[]): Promise<LaneCostView>;
}

/** the lane's worktree, from its last session: the place its records and its diff are read from */
export function laneRootOf(iddId: string): string | undefined {
  const executor = readSessions("executor").filter((r) => r.idd_id === iddId).pop();
  if (executor?.worktree_path) return executor.worktree_path;
  const planner = readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  return planner?.worktree_path;
}

/**
 * A lane's intent is the same answer for every reader that asks with the same view of the lane: the lane id, the
 * worktree it is read in, and the branch it is read from when the worktree is gone. The events are not part of the
 * key: a caller that passes them and one that lets the reader take them itself see the same lane's records.
 */
export function laneIntentKey(rec: { idd_id: string }, opts: LaneIntentOpts): string {
  return [rec.idd_id, opts.root ?? "", opts.branch?.repo ?? "", opts.branch?.ref ?? ""].join("\u0000");
}

/** the readings a derivation finds, as the answer's own process hands them back */
export interface DerivedOverlay {
  /** when the derivation ran (a diagnostic; the answer's own times are not read from it) */
  at: string;
  /**
   * how many derivations this process has landed, from 0. A new number is a new picture of git and the worktrees,
   * so a reader that watches for the answer to move compares this rather than the time it carries: two derivations
   * in the same millisecond are two different pictures, and one overlay read twice is one.
   */
  revision: number;
  /** the submit card's git readings, per lane: the card itself is built at the answer from these and the ledger */
  submit: Record<string, SubmitReadings | null>;
  intent: Record<string, LaneIntent>;
  laneRef: Record<string, LaneBranch | null>;
  reviewDiff: Record<string, ReviewDiffView>;
  cost: Record<string, LaneCostView>;
}

export function emptyOverlay(): DerivedOverlay {
  return { at: "", revision: 0, submit: {}, intent: {}, laneRef: {}, reviewDiff: {}, cost: {} };
}

export function isEmptyOverlay(overlay: DerivedOverlay): boolean {
  return !overlay.at;
}

/** the readers the answer's own process uses: every one of them reads git, the worktree or the conversations */
export const REAL_DERIVED: DerivedDeps = {
  intent: (rec, opts) => laneIntent(rec, opts),
  /**
   * the branch of a lane whose worktree is gone. `laneBranchSource` asks git whether the branch is still there,
   * one process per lane: that read belongs to the derivation, not to an answer.
   */
  laneRef: (rec) => {
    const executor = readSessions("executor").filter((r) => r.idd_id === rec.idd_id).pop();
    const planner = readSessions("planner").filter((r) => r.idd_id === rec.idd_id).pop();
    const worktree = executor?.worktree_path ?? planner?.worktree_path;
    return laneBranchSource(rec.area, worktree, executor?.branch ?? planner?.branch);
  },
  submit: (iddId) => buildSubmit(iddId),
  reviewDiff: (iddId, events) => {
    const root = laneRootOf(iddId);
    const startedFrom = events.find((e) => e.event === "s2_start")?.attrs?.started_from_commit;
    const baseNote = laneBaseMissing(iddId);
    const base = root && !baseNote ? laneBase(root, typeof startedFrom === "string" ? startedFrom : undefined) : null;
    if (!root || !base) return { ...(baseNote ? { baseNote } : {}), compared: false };
    const executor = readSessions("executor").filter((r) => r.idd_id === iddId).pop();
    const planner = readSessions("planner").filter((r) => r.idd_id === iddId).pop();
    const branch = executor?.branch ?? planner?.branch;
    return {
      ...(baseNote ? { baseNote } : {}),
      compared: true,
      diffFiles: laneDiffFiles(root, base),
      diffs: laneDiffAll(root, base),
      ...(branch ? { branch } : {}),
    };
  },
  cost: (iddId, events) => laneCost(iddId, events),
};

/**
 * The Choices as the ledger holds them now. A judgment rewrites them (a planner re-readies the lane, a judgement
 * comes back), so a card that shows the Choices of the last derivation up to half a minute later shows penne a GO or a
 * merge over Choices the ledger no longer says. The docs half of the intent may lag; the column may not.
 */
function withLedgerChoices(intent: LaneIntent, iddId: string, events?: LifecycleRecord[]): LaneIntent {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  if (!rec) return intent;
  const ledger = laneLedgerChoices(rec, events ?? readLifecycle().filter((e) => e.idd_id === iddId));
  return ledger ? { ...intent, decisions: ledger } : intent;
}

/**
 * The answer's side: the readings that cost git and a lane's worktree come from the last derivation, and the rest is
 * read at the moment of the answer. A lane the derivation did not reach — it moved to the submit card, or into the
 * closed lanes' cut, after the derivation ran — is answered by reading it here rather than by leaving its card or
 * its values out: a card that silently disappears is worse than one whose git readings are a few seconds late, and
 * the lane is in the next derivation anyway.
 *
 * The one exception is the stretch before a derivation has ever landed (a process that just started, or one whose
 * derivation was never started at all): there is nothing to answer from, and the doors fall back to the readers
 * themselves. That is the behavior these doors had before, slowed by the columns rather than broken — and it ends
 * with the first derivation, which the engine asks for at its start.
 */
export function replayDerived(overlay: DerivedOverlay): DerivedDeps {
  if (isEmptyOverlay(overlay)) return REAL_DERIVED;
  return {
    intent: (rec, opts) => {
      const held = overlay.intent[laneIntentKey(rec, opts)];
      return held ? withLedgerChoices(held, rec.idd_id, opts.events) : REAL_DERIVED.intent(rec, opts);
    },
    laneRef: (rec) => (rec.idd_id in overlay.laneRef ? overlay.laneRef[rec.idd_id] ?? undefined : REAL_DERIVED.laneRef(rec)),
    submit: (iddId) => {
      if (!(iddId in overlay.submit)) return REAL_DERIVED.submit(iddId);
      const readings = overlay.submit[iddId];
      if (!readings) return null;
      const intent = readings.intent ? withLedgerChoices(readings.intent, iddId) : undefined;
      return buildSubmit(iddId, intent ? { ...readings, intent } : readings);
    },
    reviewDiff: (iddId, events) => overlay.reviewDiff[iddId] ?? REAL_DERIVED.reviewDiff(iddId, events),
    cost: async (iddId, events) => overlay.cost[iddId] ?? REAL_DERIVED.cost(iddId, events),
  };
}

/** the derivation's side: run the real readers, and keep what each one answered under the key the answer asks with */
export function recordingDerived(at = new Date().toISOString()): { deps: DerivedDeps; overlay: DerivedOverlay } {
  const overlay = emptyOverlay();
  overlay.at = at;
  const deps: DerivedDeps = {
    intent: (rec, opts) => {
      const key = laneIntentKey(rec, opts);
      const hit = overlay.intent[key];
      if (hit) return hit;
      const value = REAL_DERIVED.intent(rec, opts);
      overlay.intent[key] = value;
      return value;
    },
    laneRef: (rec) => {
      const key = rec.idd_id;
      if (key in overlay.laneRef) return overlay.laneRef[key] ?? undefined;
      const value = REAL_DERIVED.laneRef(rec);
      overlay.laneRef[key] = value ?? null;
      return value;
    },
    submit: (iddId) => {
      if (iddId in overlay.submit) {
        const readings = overlay.submit[iddId];
        return readings ? buildSubmit(iddId, readings) : null;
      }
      // only the readings are kept: the card is built from them and the ledger, so a judgment written after this
      // derivation is in the card the answer shows
      const readings = readSubmitReadings(iddId);
      overlay.submit[iddId] = readings.worktree ? readings : null;
      return buildSubmit(iddId, readings);
    },
    reviewDiff: (iddId, events) => {
      const hit = overlay.reviewDiff[iddId];
      if (hit) return hit;
      const value = REAL_DERIVED.reviewDiff(iddId, events);
      overlay.reviewDiff[iddId] = value;
      return value;
    },
    cost: async (iddId, events) => {
      const hit = overlay.cost[iddId];
      if (hit) return hit;
      const value = await REAL_DERIVED.cost(iddId, events);
      overlay.cost[iddId] = value;
      return value;
    },
  };
  return { deps, overlay };
}
