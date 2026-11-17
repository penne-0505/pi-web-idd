/**
 * The new screen's Work response, as the engine's door returns it. Declared apart from the engine's state reading,
 * so the screen's bundle can take the types without the server's code (the screen's boundary test builds the bundle
 * and looks for node modules; a type is erased before that).
 *
 * The screen draws only what the engine sends here (DEC-103-1): the stage spans, the bundle, the turn, the waits.
 * The fields the engine has no value for yet (the forecast, the usual length, the anomaly, the urgent flag) are
 * declared so the places exist, and the engine leaves them undefined (DEC-103-2).
 */

import type { DecisionKind, StageSpan } from "@idd/core";
import type { HeldIssue } from "@idd/core";

import type { SourceRef } from "./types.ts";

/** the two parts of the lane column: what runs now, and what the engine wakes next */
export type WorkBundle = "running" | "next";

/** what a column row is: an Issue lane, someone else's PR under review, or an Issue held for a dependency (no lane) */
export type WorkKind = "issue" | "review" | "hold";

/** a lane or Issue this row waits on, with the lane it belongs to when one is known */
export interface WorkWaitRef {
  ref: SourceRef;
  lane?: string;
  title?: string;
  /** the files the order wait collides on; the order wait is a note, not one of these */
  files?: string[];
}

export interface WorkLaneView {
  kind: WorkKind;
  id: string;
  /** the repo (repos.yaml key); a hold carries its area */
  repo: string;
  ref?: SourceRef;
  title: string;
  bundle: WorkBundle;
  /** whose turn it is, when the lane waits on a person (DEC-103-5) */
  turn?: DecisionKind;
  activity?: "live" | "stalled" | "unstarted";
  /** the wait in words (the order wait, the slot wait, the PR); never a dependency line (DEC-103-7) */
  note?: string;
  spans: StageSpan[];
  waitsFor: WorkWaitRef[];
  /** the engine has no forecast yet; the place stands, the value is not sent (DEC-103-2) */
  eta?: string;
  usual?: number;
  anomaly?: boolean;
  urgent?: boolean;
}

export interface WorkDoneView {
  id: string;
  repo: string;
  ref?: SourceRef;
  title: string;
  closedAt?: string;
  outcome: string;
  /** the DECs the lane made */
  decisions: number;
}

export interface WorkRepoView {
  /** the repos.yaml key, or a repo's own name for a review lane outside the settings */
  id: string;
  name: string;
  running: number;
  /** the lanes at a person's turn */
  waiting: number;
  /** a repo with something to mind: its rows carry a turn */
  attention: boolean;
}

export interface WorkView {
  now: string;
  repos: WorkRepoView[];
  lanes: WorkLaneView[];
  done: WorkDoneView[];
  /** the Issues intake held for a dependency (also when no lane exists): a next row each (DEC-1769) */
  holds: HeldIssue[];
}

/** one DEC as the Work screen's DEC tab draws it, in the v2 projection's field order (DEC-103-6) */
export interface DecisionTabView {
  id: string;
  title: string;
  /** Place: the Anchors value as written; "" when the DEC has none */
  place: string;
  /** Why: the whole field */
  why: string;
  /** Why not: each dropped form and its reason */
  whyNot: { form: string; reason: string }[];
  /** Anchored: the invariants the document ties to this DEC */
  anchored: { id: string; text: string }[];
  /** Free: the Change freedom */
  free: string;
  hasPlace: boolean;
}

export interface WorkDecisionsView {
  lane: string;
  /** the DECs the lane's own document made */
  own: DecisionTabView[];
  /** the DECs the lane touches, not narrowed (DEC-2801) */
  existing: DecisionTabView[];
  /** how many superseded DECs the index left out */
  dropped: number;
  /** the paths the existing DECs were pulled for */
  paths: string[];
}

/** one acceptance criterion of a lane's record: the qa.md statement and the state folded from the reports */
export interface WorkAcceptanceView {
  id: string;
  statement: string;
  status: string;
  evidence?: string;
  at?: string;
}

/** one entry of the lane's verification log, derived from its records */
export interface WorkVerificationEntryView {
  at: string;
  stage: string;
  commands: string[];
  acceptance: { done: number; total: number; open: string[] };
  verdict: string;
  who: string;
  next?: string;
}

/** one place-attached finding, as the read endpoints show it */
export interface WorkFindingView {
  id: string;
  lane: string;
  round?: number;
  path: string;
  lines: [number, number] | null;
  commit: string;
  severity: string;
  claim: string;
  status: string;
  reason?: string;
  fixLane?: string;
  disposedBy?: string;
}

/** one lane's record: its AC states, its verification log, the findings it placed and the ones handed to it */
export interface WorkRecordView {
  lane: string;
  acceptance: WorkAcceptanceView[];
  log: WorkVerificationEntryView[];
  findings: {
    placed: WorkFindingView[];
    delivered: WorkFindingView[];
    disposals: { id: string; action: string; reason?: string }[];
  };
}

/** the open findings that hold the given paths */
export interface WorkFindingsView {
  repo: string;
  paths: string[];
  findings: WorkFindingView[];
}
