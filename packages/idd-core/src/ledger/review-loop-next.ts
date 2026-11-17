import { laneAnswer } from "../intent/moonbit-fold.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/**
 * The review loop's next step: the leg a lane steps on, and the record that leg writes.
 *
 * The step is decided by the MoonBit fold (`packages/idd-fold/next_step.mbt`), from the lane's rows and the facts
 * the caller gathered (C-201-1). The caller runs the step: it starts the runs, writes the files and delivers the
 * envelopes. A fold that cannot be read is a failure the caller sees, never a second reading in TypeScript.
 *
 * The facts are what the ledger does not hold: the runner's port, the git, the policy and the slots. Every field is
 * optional, because a fact the caller did not gather is not a fact (C-201-2): the fold reads the ones that are
 * there, and a fact it needs and does not have is a step it does not take.
 */

/** the leg of the review loop a lane steps on next */
export type NextLeg = "map" | "blind" | "triage" | "send_fix" | "confirm" | "device" | "checks" | "converge" | "escalate" | "helper" | "wait";

/** what the loop does next */
export type NextAction = "write" | "start" | "call" | "nothing";

/** the step itself */
export interface NextStep {
  /** the leg the lane steps on */
  leg: NextLeg;
  /** what the leg does */
  action: NextAction;
  /** the event the step writes, when it writes one */
  event?: string;
  /** the attrs the step writes */
  attrs: Record<string, unknown>;
  /** the stage the step starts a run of, when it starts one */
  stage?: string;
}

/** the policy the tick reads */
export interface StepPolicy {
  closeOnMust?: boolean;
  closeOnFix?: boolean;
  maxFixRounds?: number;
  maxShouldFix?: number;
  shouldDefault?: string;
  highRiskWhen?: string;
  finalScope?: string;
  afterMerge?: string;
  finalWhen?: string;
  extras?: { first_round?: number; high_risk?: number };
  extraRoles?: { first_round?: string[]; high_risk?: string[] };
}

/** a run, as the runner's port answers it */
export interface StepRunFact {
  state?: string;
  error?: string;
  routes?: unknown[];
  reportMd?: string | null;
  reportJson?: string | null;
  fallbacks?: unknown;
  runIds?: string[];
  wholeDiff?: string[];
  runRoles?: string[];
  runLabels?: string[];
  /** the findings the run read, as the runner reports them */
  findings?: unknown[];
  /** why the run skipped what it was asked to check */
  skipped?: string;
  routeCount?: number;
  routesOverCap?: boolean;
}

/** the facts the next step reads that the ledger does not hold */
export interface StepFacts {
  policy?: StepPolicy;
  reviewOn?: boolean;
  deviceOn?: boolean;
  mapOn?: boolean;
  blindFits?: boolean;
  mapFits?: boolean;
  triageFits?: boolean;
  confirmFits?: boolean;
  at?: { worktree: string; base: string; head: string };
  risk?: { risk: string; hits?: unknown[]; high: boolean };
  since?: { index: number; head: string };
  mergeOnlySkip?: { head: string };
  finalSkip?: { settled: string };
  mergeSince?: { merge: string };
  conflictMerge?: { mainline: string; merge: string; recordOnly: boolean };
  reviewBase?: string;
  roundDepth?: string;
  extras?: string[];
  mapSkipped?: string;
  overview?: string;
  preMerge?: string;
  executorWait?: { reason: string; head: string };
  runs?: StepRunFact[];
  /** the map run the step just started */
  mapRun?: StepRunFact;
  /** the map was already asked for on this head: a start that named no run is not asked for again */
  mapTried?: boolean;
  /** the round's copies fit the slot, counting the routes the map drew */
  routeBlindFits?: boolean;
  /** the round adds the senior role and penne let its fallback run */
  allowHighFallback?: boolean;
  /** a final shown an increment would leave earlier changes unseen */
  wholeForUnread?: boolean;
  /** the fix rounds the depth's table gives the round */
  depthFixRounds?: number;
  /** the report a device check writes for a picture set it could not read */
  reportPath?: string | null;
  /** the file naming what a confirm did not report on */
  missingFile?: string | null;
  envelopeId?: string;
  hows?: string[];
  acceptedRefs?: string[];
  boundaryItems?: unknown[];
  scopeRefs?: string[];
  /** the caller told of the list it handed the confirm: an empty list it told of is written */
  scopeRefsGiven?: boolean;
  boundaryRefs?: string[];
  accepted?: unknown[];
  rejected?: unknown[];
  escalatedClaims?: string[];
  prior?: unknown[];
  oscillations?: unknown[];
  means?: unknown[];
  verdict?: { action: string; reason?: string; judge?: string; pictures?: number; stale?: string };
  judge?: string;
  pictures?: number;
  staleReason?: string;
  deviceFindings?: unknown[];
  unresolved?: string[];
  missing?: string[];
  severities?: { ref: string; severity: string }[];
  recordsErrors?: unknown[];
  recordsHead?: string;
  queued?: boolean;
  /** the repo runs its required checks at the head before the loop converges (`checks_before_converge`) */
  checksOn?: boolean;
  /** what a convergence the caller decided (a final it skipped) writes, carried past the checks */
  convergeAttrs?: Record<string, unknown>;
  /** what the checks' run found, one row a check: name, status, the comparison's verdict and phrase, failures, tail */
  checkRows?: {
    name: string; status: string; verdict?: string; phrase?: string; failures?: string[];
    /** a failed row of a run that checked the head merged with the public base's tip: what that means for the fix */
    tree_note?: string;
    tail?: string;
  }[];
  /** the commit the failures were compared at (the public base's tip when the run built the submit tree, else the lane's base) */
  checkBase?: string;
  /** the state the checks hold back, when it is not the convergence (a round the mainline's merge alone skips) */
  resumeState?: Record<string, unknown>;
  /** why a run the repo's heavy checks kept out has waited too long: it is then put to penne */
  checkWaitOver?: string;
}

/**
 * The next step of the review loop for one lane, as the fold answers it.
 */
export function reviewNextStep(events: LifecycleRecord[], facts: StepFacts = {}): NextStep {
  return laneAnswer<NextStep>("next_step", events, facts as unknown as Record<string, unknown>);
}

/**
 * The convergence's step, asked where the loop converges without being in the convergence state (a final the loop
 * skipped): the checks run first in a repo that runs them before the loop converges. The same step the convergence
 * state answers with.
 */
export function convergeStep(events: LifecycleRecord[], facts: StepFacts = {}): NextStep {
  return laneAnswer<NextStep>("converge_step", events, facts as unknown as Record<string, unknown>);
}
