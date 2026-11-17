
export type Stage = "intake" | "prep" | "impl" | "review" | "ship";

export const STAGE_ORDER: Stage[] = ["intake", "prep", "impl", "review", "ship"];

export type LaneGroup = "judge" | "prep" | "impl" | "waiting" | "closed";

/** the words of the lane list's sections; the inbox's summary of what is running uses the same */
export const LANE_SECTION_LABEL: Record<LaneGroup, string> = {
  judge: "判断待ち",
  prep: "下調べ中",
  impl: "実装中",
  waiting: "待機中",
  closed: "終端 (直近)",
};

export type DecisionKind = "duplicate" | "granularity" | "question" | "go" | "review" | "ship" | "stuck" | "requeue";

/** a card penne answered today, as the Inbox's list reads it (an `outbound` card is one kind of its own) */
export interface AnsweredCard {
  kind: DecisionKind | "outbound";
  /** the lane the card belonged to, when it has one (an outbound card may not) */
  iddId?: string;
  /** the lane's or the post's title, when it is known */
  title?: string;
  /** when penne answered it (ISO) */
  at: string;
}

/** the day's spend, split the way the budget reads it: `budget` is what the lane budgets count, `subscription` the Claude Code API equivalent */
export interface TodayCost {
  /** the JST day (YYYY-MM-DD) the two sums are for */
  day: string;
  budget: number;
  subscription: number;
}

/** a lane's spend as the lane list and its detail show it, apart from the subscription's API-equivalent part */
export interface LaneCostView {
  budget: number;
  subscription: number;
}

export interface SourceRef {
  kind: "linear" | "github" | "pr" | "lane" | "file";
  label: string;
  url?: string;
}

export interface LaneRow {
  iddId: string;
  title: string;
  group: LaneGroup;
  decision?: DecisionKind;
  stageDone: number;
  stageCurrent: number | null;
  elapsed: string;
  source?: SourceRef;
  blockedBy?: string;
  priorityTop?: boolean;
  faded?: boolean;
  activity?: "live" | "stalled" | "unstarted";
  /** the review loop's rounds, one row per judgement (empty for a lane with no review records) */
  reviewRounds?: import("@idd/core").ReviewRound[];
  /** the lane's spend, from the same reader the budget uses: the budget's value and the subscription's part apart */
  cost?: LaneCostView;
}

export interface LaneSection {
  group: LaneGroup;
  label: string;
  /** the lanes listed under it */
  count: number;
  /** a working stage: the lanes holding one of its slots now, which is what `cap` limits */
  running?: number;
  cap?: number;
  /** the lanes ready for the stage but held back by its cap; absent when none waits */
  wait?: SlotWaitCount;
  /** the group's other capped stages that hold lanes back by their cap (only the ones with a lane waiting) */
  stages?: { label: string; running: number; cap: number; wait: SlotWaitCount; hint?: string }[];
  collapsed?: boolean;
}

/** lanes waiting for a stage's cap: how many, and the minutes the longest of them has waited */
export interface SlotWaitCount {
  count: number;
  longestMin: number;
}

/** the lane is ready for a stage and held back only by its cap (the words say 上限待ち: 枠 is Claude's windows) */
export interface LaneSlotWait {
  label: string;
  cap: number;
  /** minutes since the lane came to be ready for the stage */
  minutes: number;
}

export interface CronRun {
  startedAt: string;
  finishedAt: string;
  failures: { iddId: string; reason: string }[];
  breakdown?: { intake: number; duplicates: number; newLanes: number };
}

export interface UndeliveredCount {
  total: number;
  failed: number;
}
export type OptionRecommendation = import("@idd/core").Recommendation;

export interface QuestionOption {
  index: number;
  label: string;
  /** what picking the option does; absent when the label alone says it */
  description?: string;
  /** how strongly the asking agent recommends this option; absent in the older form */
  recommendation?: OptionRecommendation;
  /** why, in 1-2 sentences from what the agent checked */
  rationale?: string;
}

export interface StateFact {
  label: string;
  value: string;
  ref?: SourceRef;
}

/**
 * The words a card is read by, in one set of six fields for every kind of card (the sentence form of
 * `_docs/standards/human-facing.md`). Which cards carry it is the engine's choice; the screen draws what it is given.
 * `selfReported` marks words that rest on what an agent wrote about its own work (a plan's summary, a report), so
 * they are never drawn with the same face as words that rest on the records.
 */
export interface CardText {
  /** 1. what is decided, as one question */
  decide: string;
  /** 2. the recommendation, and what it rests on (a settled rule, a record, a measurement, a guess) */
  recommend: { text: string; basis: string; selfReported: boolean };
  /** 3. for each option, what changes; who it reaches and whether it can be undone are the engine's words */
  outcomes: { option: string; changes: string; reaches: string; reversible: string }[];
  /** 4. up to three facts the judgment needs, each with where it comes from; records first */
  facts: { text: string; source: string; selfReported: boolean }[];
  /** 5. what the engine had already decided when the card was made, so it need not be decided again */
  settled: { text: string; source: string }[];
  /** 6. where to read more: links only */
  links: { label: string; path: string }[];
  /** the translator wrote the words / the engine put them together from the raw material */
  by: "translated" | "raw";
}

/**
 * How an operation is signed, as the engine decides it: not at all, by a passkey only, or by a passkey or the PIN.
 * The screen reads this field and holds no list of the operations that need a signature (C-265-2).
 */
export type OperationSignature = "none" | "passkey" | "passkey_or_pin";

/**
 * The findings the last judgement accepted, whose weight and handling the person may correct; sent as `payload[field]`.
 * Each carries the handlings it may be given and, for every one, whether the fix then takes it (`inFix`): the engine
 * reads that from the loop's own answer, so a screen lists the refs a press sends to the fix by looking them up (C-272-3).
 * A press sends `{ ref, severity, action }` of a handling that is not `current`.
 */
export interface OperationCorrections {
  field: string;
  findings: {
    ref: string;
    /** the weight the finding stands at now, and the one the judgement gave when a person set another */
    severity: string;
    judgedSeverity?: string;
    /** the handling it stands at now, and whether the fix as it stands takes it */
    action: "fix" | "followup" | "skip";
    inFix: boolean;
    claim: string;
    path?: string;
    handlings: { action: "fix" | "followup" | "skip"; severity: "must" | "should" | "nit"; inFix: boolean; current: boolean }[];
  }[];
}

/** the reversals the person settles with a side or a written boundary; sent as `payload[field]` */
export interface OperationBoundaries {
  field: string;
  reversals: { ref: string; claim: string; path?: string; priorRef: string; prior: string; current: string }[];
}

/** what the person supplies for an operation, besides the fixed payload the engine names */
export type OperationInput =
  | { kind: "none" }
  /**
   * one line of text sent as `payload[field]`; `required` means an empty line is not sent. `corrections` and `boundaries`
   * declare the per-finding choices that ride the same request beside the line: the screen sends them under the declared
   * field, and no others (the stuck card's continue and accept)
   */
  | { kind: "text"; field: string; required: boolean; corrections?: OperationCorrections; boundaries?: OperationBoundaries }
  /** a choice among a question's options, with an optional reason or a free answer */
  | { kind: "answer" }
  /** the submit card's editable text (the PR's title and body, the commit message); `sends` names what goes out */
  | { kind: "draft" }
  /**
   * the lanes the person leaves on a batch signature: `offered` is every lane the engine will sign for, each with the
   * head and the whole close, and the request carries `payload[field]` as the chosen ones of these, unchanged. A lane
   * the screen sends that is not offered here is not one the operation named.
   */
  | { kind: "lanes"; field: string; offered: { iddId: string; head: string; close: { repo: string; issue: number; comment: string } | null }[] };

/**
 * A condition on the person's input that the engine names and cannot check itself (it does not see the edit in
 * progress). The screen shows whether the input now meets it; the decide door and the passkey challenge decide in the end.
 */
export type OperationCondition =
  /** the check this approval rests on is good until `until` */
  | { id: "fresh"; until: string; why: string }
  /** a push's commit message: not empty while the draft is pending, and past the vocabulary check of the repo */
  | { id: "commit_message"; vocabAllow: string[]; pendingDraft: boolean }
  /** a PR's title is not empty */
  | { id: "pr_title" }
  /** the text is still the one that was checked */
  | { id: "checked_text"; title: string; body: string }
  /** a post: its title is not empty */
  | { id: "post_title" }
  /** a review other than Approve needs a body */
  | { id: "review_body" }
  /** a PR body update differs from the PR now */
  | { id: "body_changed"; baseTitle: string; baseBody: string }
  /** replies: at least one reply is written and not yet posted (`posted` per reply, in the card's order) */
  | { id: "replies_to_post"; posted: boolean[] }
  /** at least one lane is left on the batch */
  | { id: "lanes_kept" };

/**
 * One thing the person can do with a card now. The engine decides whether it exists, whether it is held and why,
 * what it needs, what it sends and whether it is signed; the screen decides its words, place and key.
 */
export interface CardOperation {
  /** the handle the screen binds its words and place to; an id the screen does not know is drawn generically */
  id: string;
  /** which door it goes to: the decide door, the put-off door, or the engine's reload door */
  door: "decide" | "snooze" | "reload";
  /** the decide action (empty for the other doors) */
  action: string;
  /** the part of the request the engine fixes; the screen adds the person's input */
  payload: Record<string, unknown>;
  input: OperationInput;
  /** for a `draft` input: which parts of the draft the request carries */
  sends?: { commit: boolean; pr: boolean };
  /** why the operation cannot be given at all now, whatever the person writes (absent: nothing holds it) */
  hold?: { reason: string; blocking?: import("./cards/ship-text.ts").BlockingFailure[] };
  /** the conditions on the input, which the screen shows against what is written now */
  conditions?: OperationCondition[];
  signature: OperationSignature;
  /** the effect cannot be taken back or leaves this machine: the screen keeps a line of what it did */
  irreversible: boolean;
  /** the card stays after the press (a check, a rewrite of one Purpose) */
  keepsCard?: boolean;
  /** the Purposes the press confirms: the request carries these and no others (DEC-112-1) */
  confirms?: { purposes: { id: string; statement: string; name?: string; raisedStatement?: string; origin?: string }[] };
  /** the press needs a reason written first (the engine refuses it without one) */
  needsReason?: boolean;
  /** what the approval is, for an approval with kinds (the submit card's) */
  variant?: string;
  /**
   * The key of the confirm this operation goes through, from the engine. It covers the operation itself, the card's
   * material and the lines the confirm shows, so a confirm opened over one answer never sends another. The screen adds
   * only what the person wrote (C-265-8).
   */
  confirmKey: string;
}

/** what the engine gives the screen to draw a card of a kind it has no shape for: plain rows, keyed not worded */
export interface DecisionMaterial {
  key: string;
  value: string;
}

/**
 * The judgment a card waits for and the operations that answer it, in the same response as the card (C-265-1).
 * The screen draws a card of any `waiting` from this and its materials, and never derives an operation from a field.
 */
export interface CardDecision {
  /** what the lane waits for, as the engine names it */
  waiting: string;
  operations: CardOperation[];
  material: DecisionMaterial[];
}

interface InboxCommon {
  /** the judgment the card waits for and the operations that answer it (set by the engine on every card it returns) */
  decision?: CardDecision;
  /** the card's six fields (set on the GO card; absent on the kinds that do not carry them yet) */
  text?: CardText;
  laneTitle?: string;
  source?: SourceRef;
  handoffNote?: string;
  /** set while "あとで" keeps the card out of the front (ISO time it comes back) */
  snoozedUntil?: string;
  /** set while the card is put to sleep (ISO time it was); it never comes back by itself */
  sleptAt?: string;
  /** when the inbox asks whether to bring a sleeping card back (absent once it asks no more) */
  sleepNoticeAt?: string;
  /** how many times penne kept it asleep when asked */
  sleepStep?: number;
  /**
   * when the lane came to this decision (the time of the event it came with), so a later card of the same kind on
   * the same lane is a new decision that does not take over a put-off or a sleep. Absent on the cards whose own id
   * already tells them apart (a question batch, a duplicate, an outbound draft)
   */
  appearedAt?: string;
  /** the engine recorded a notice for this card, at this time (the card waited longer than the setting) */
  waitNoticeAt?: string;
}

interface InboxBase extends InboxCommon {
  iddId: string;
}

export interface DuplicateItem extends InboxBase {
  kind: "duplicate";
  reviewId: string;
  incoming: { title: string; ref: SourceRef };
  existing: { title: string; ref: SourceRef; stage?: { done: number; current: number | null } };
  similarity: number;
  reason: string;
  shared?: string[];
}

export interface QuestionEntry {
  questionId: string;
  question: string;
  facts: StateFact[];
  options: QuestionOption[];
}

export interface QuestionItem extends InboxBase {
  kind: "question";
  batchId: string;
  open: QuestionEntry[];
  askedTotal: number;
  answeredCount: number;
  primaryRef?: SourceRef;
}

/** the planner's three lines for someone who has not read the code: how things stand, what the lane does, what it makes better */
export interface PlainSummary {
  situation: string;
  action: string;
  outcome: string;
}

/** one proposed Purpose the GO card and the lane detail show: what it would say and where it came from */
export interface PurposeProposalView {
  id: string;
  statement: string;
  origin: string;
  /** the short handle the agent gave the proposal, when it gave one; the card shows it beside the statement */
  name?: string;
  /** the sentence the planner wrote, present once a person rewrote `statement`; the card shows both */
  raisedStatement?: string;
}

/** the planner's answer for one kind of harm; the GO card and the lane detail show all six as a table */
export interface RiskTableRow {
  kind: string;
  label: string;
  touches: boolean;
  reason: string;
}

/** one existing DEC the planner judged, as the GO card and the lane detail read it */
export interface IntentImpactRowView {
  id: string;
  /** the title read from the record document; absent when it could not be read */
  title?: string;
  /** keep = Why を保つ / within_freedom = Change freedom の範囲で変える / change_why = Why を変える */
  effect: "keep" | "within_freedom" | "change_why";
  reason: string;
  /** the DEC was not among the candidates the touched paths pulled */
  outsideCandidates?: boolean;
}

/** the planner's report of the impact on existing DECs: the rows it judged, and how many candidates the paths pulled */
export interface IntentImpactView {
  count: number;
  paths: string[];
  rows: IntentImpactRowView[];
}

/** one kind of harm the lane's own change touched, from the repo's declaration of dangerous paths */
export interface RiskPathHitView {
  kind: string;
  label: string;
  /** the matching paths of the lane's own change (capped when it touched many) */
  paths: string[];
  /** how many paths matched in all (a moved-from and a moved-to path count as two) */
  total: number;
}

/**
 * The last review round's matching of the lane's own change against the repo's `risk_paths` declaration: the kinds
 * and paths it fell under, beside the risk the lane had declared then. Absent for a lane none of whose rounds hit.
 */
export interface RiskMatchView {
  declared: string;
  hits: RiskPathHitView[];
}

export interface GranularityChildView {
  title: string;
  /** the child's 完了の形の全体 1 文 (a duty is one independently judgeable finish) */
  whole: string;
  places: string[];
  /** the 0-based indices of the children that must land before it */
  after: number[];
}

/** the lane waits on a person's answer to its split / merge proposal, made before it writes the request */
export interface GranularityItem extends InboxBase {
  kind: "granularity";
  title: string;
  proposal: {
    kind: "split" | "merge";
    reason: string;
    /** the children of a split, in the order the planner put them */
    children?: GranularityChildView[];
    /** the Issue or lane a merge joins into */
    mergeTarget?: { ref: string; title?: string };
    /** false when the split has more children than the limit: the card shows a re-slicing instead of an approval */
    approvable: boolean;
    limit: number;
  };
}

/** an open lane that declared a place this lane declared: the pairs of places, listed up to a cap */
export interface OverlapView {
  lane: string;
  title: string;
  /** a side declared nothing, so the pair was matched on the paths its Issue's text names */
  provisional: boolean;
  hits: { path: string; other: string; kind: "same" | "nested" | "sibling" }[];
  /** pairs beyond the ones listed */
  more: number;
}

export interface GoItem extends InboxBase {
  kind: "go";
  title: string;
  /** the depth the lane's plan declared, raised by what the engine can read; absent on a ready that declared none */
  depth?: "shallow" | "standard" | "deep";
  /** why the engine did not record the GO itself (a shallow lane it left to a person); absent when none was needed */
  notAuto?: string;
  /** absent when the planner's ready came without the three lines (the older form) */
  summary?: PlainSummary;
  /** the planner's six-kind table from its last ready; absent on a ready that came without one (an older ready) */
  riskTable?: RiskTableRow[];
  /** the planner's report of the impact on existing intent; absent on a ready that came without one (an older ready) */
  intentImpact?: IntentImpactView;
  decisions: { id: string; text: string; why?: string; source?: string }[];
  criteria: { id: string; text: string }[];
  /** the lane's proposed Purposes, which the GO press confirms in the same record */
  purposeProposals?: PurposeProposalView[];
  priorityTop?: boolean;
  intentPath?: string;
  /** where the lane's plan is, for the card's "詳しく見る場所" */
  planPath?: string;
  /** the work branch moved into the plan's places after the plan was made (from the lane's record, not from git) */
  baseAdvance?: { to: string; files: string[]; more: number; known: boolean };
  /** other open lanes that declared a place this lane declared (from the records; it moves no stage and no GO); absent when none */
  overlaps?: OverlapView[];
  /**
   * the lane's recorded dependencies that have not landed: the engine refuses the GO, so the card shows what it
   * waits for in place of the button (open: the tracker says so; unknown: the tracker could not be read)
   */
  blockedBy?: { reason: string; items: { ref: string; title: string; url: string; state: "open" | "unknown"; lane?: string }[] };
  planReview?: {
    /** reviewed: findings recorded / failed: the review lane broke / skipped: no plan_review slot */
    state: "reviewed" | "failed" | "skipped";
    must: number;
    should: number;
    nit: number;
    /** source: the role (comma-joined when several raised it) */
    findings: { severity: string; claim: string; path: string; source?: string }[];
    /** each run of the review, one per role of pipeline.plan_review (empty for a review recorded before the runs were listed) */
    runs?: { role: string; model?: string; failed: boolean; error?: string }[];
    note?: string;
    /**
     * each review of the plan since the lane began or penne last sent it back, oldest first, with the must / should
     * it left (a nit is a count only); the fields above are the last one
     */
    rounds?: { state: "reviewed" | "failed" | "skipped"; must: number; should: number; nit: number; findings: { severity: string; claim: string; path: string; source?: string }[]; note?: string }[];
    /**
     * every review of the plan since the lane began, and each time penne sent the plan back, oldest first (the
     * rounds above are only those since the last send-back); sentBack is what the review's own record says of
     * whether it sent the plan back to the planner, absent when the record does not say
     */
    history?: ({ kind: "round"; state: "reviewed" | "failed" | "skipped"; must: number; should: number; sentBack?: boolean } | { kind: "revise" })[];
    /** the rounds are spent and the last one still raised findings: a GO is taken only with the reason for passing them */
    needsReason?: boolean;
  };
}

export type CriterionState = "done" | "doing" | "todo";

export interface DiffLine {
  marker: "+" | "-" | null;
  code: string;
  lineNo?: string;
}

export interface ReviewItem extends InboxBase {
  kind: "review";
  target: { title: string; ref: SourceRef };
  conflictWith?: { title: string; ref: SourceRef };
  diffFiles?: string[];
  /**
   * every changed file with its own diff, as the engine read them. The engine builds the card's material from this and
   * does not send it on: the answer carries the material, not a second copy of the lines.
   */
  diffs?: {
    file: string;
    fileIndex: number;
    fileTotal: number;
    before: DiffLine[];
    after: DiffLine[];
    omitted?: { before: number; after: number };
    /** git could not give this file's diff (the reason): its lines are a notice, not a diff */
    unread?: string;
  }[];
  /** the lane's branch: where the whole of a file whose lines the card cut can be read */
  diffBranch?: string;
  /** the lane's base cannot be read (its parent ended and left nothing): no diff is counted, and this says why */
  baseNote?: string;
  criteria: { id: string; text: string; state: CriterionState }[];
}

export interface ShipItem extends InboxBase {
  proposal?: import("@idd/core").ProposeView | null;
  review?: import("@idd/core").SubmitReview;
  kind: "ship";
  /** the last round's hit of the repo's dangerous-path declaration (absent when none hit) */
  riskMatch?: RiskMatchView;
  title: string;
  branch: { from: string; to: string; repo: string };
  pr: {
    title: string;
    body: { text: string; flagged?: { original: string }; issue?: boolean }[];
    commits: string[];
    /** words the repo allows in its public text (config/repos.yaml public_vocabulary_allow) */
    vocabAllow?: string[];
    /** the drafted PR body the card starts from, when the draft came back */
    draftBody?: string;
  };
  checks: { label: string; ok: boolean; reason?: string; key?: "commit-convention" }[];
  /** the repo's declared commit form with the recent public commits; the screen judges the message penne edits by it */
  commitConvention?: { convention: import("@idd/core/plan/vocab.ts").CommitConvention; precedents: string[] };
  /** the submit was pushed on penne's approval; a lane without an open PR waits for the card to approve its PR */
  pushed?: { branch: string; commit: string };
  /** why the tick did not get the current head ready for the card, or (when pushed) what stopped the tick after the push */
  pushHeld?: string;
  /** the lane's PR while nothing on record says it is no longer open: a push goes to it with its title and body left as they are */
  existingPr?: { url: string; number: number };
  /** pushed to the lane's PR, whose check after the push failed for a passing cause: the tick asks again */
  prCheckFailed?: string;
  /** the pushed submit no longer matches the destination or settings: the card checks it again, and makes no PR from it */
  recheck?: string;
  /** the commit message drafted for the lane's head, which penne approves (or rewrites) before the push */
  commit?: { draft?: string; model?: string; failed?: string; pending?: true; start?: string };
  /** why the card cannot be signed as it stands (the same reasons the tick holds the push and the landing for) */
  blocked?: { reasons: string[] };
  /**
   * the checks the landing or the submit record ran without holding the signature (`severity: non-blocking`), each
   * with the line of its output that says why. The engine folds them once, from the record's checks, so both screens
   * warn near the heading without reading the record themselves. Absent when none failed
   */
  checkWarnings?: import("./check-warning.ts").CheckWarning[];
  /** checked while the lane's public branch was gone: its last PR (merged, or closed unmerged); it goes out as a new branch with a new PR */
  branchGone?: { merged: boolean; pr?: number };
  /** the lane's head as the card was built: a check made at another head cannot be approved */
  head?: string;
  /**
   * the lane's repo does not publish (`publish: false`): the card shows the landing into the work side's mainline
   * instead of a push and a PR, with the checked merge commit and the checks
   */
  land?: import("@idd/core").LandRecord | null;
  /** why the landing cannot be made now (a dirty checkout, an open branch) */
  landBlocked?: string;
  /** the lane adds nothing public (records alone): the landing refuses its approval, so the card offers no signature */
  recordsOnly?: { reason: string };
  /** a landing check of this lane is running in its own run: nothing is checked yet, so the card asks for nothing (C-144-8) */
  landChecking?: string;
  /** penne approved the landing and the merge is owed: the card says so and does not ask for the approval again */
  landPending?: { hold?: string };
  /**
   * the saved conflict forecast for the landing card: what the mainline check found and which other cards would
   * conflict if they landed first. A hint for the order of approvals; absent when none was taken or it is stale.
   */
  conflictForecast?: import("@idd/core").LandForecast;
  /**
   * the open lanes waiting, before their first review, for this lane's landing to go in: the approval releases
   * them. Added by the engine from the wait records; absent when none waits. A lane carries its place among the
   * lanes it collides with.
   */
  waitingLanes?: { lane: string; files: string[]; rank?: number }[];
}

/** one lane on the batch card: what penne signs for it (its head and its Issue close) and what is known of its merge */
export interface LandBatchLaneView {
  iddId: string;
  title: string;
  /** the head penne signs for */
  head: string;
  branch: string;
  source?: SourceRef;
  /** the Issue the same signature closes: the destination and the one-liner posted with it */
  close?: { repo: string; issue: number; comment: string };
  /** this lane's trial merge with the mainline and with the other lanes of the card, when one was taken */
  conflictForecast?: import("@idd/core").LandForecast;
}

/** a lane the batch left out, and why: the reason is what the lane's own card says too */
export interface LandBatchDropView {
  iddId: string;
  kind: string;
  reason: string;
}

/** a change the harness made to a lane's merge after the signature: the files, the diff and the grounds that it keeps the meaning */
export interface LandBatchRebuildFailureView {
  iddId: string;
  /** `environment`: the tool or the time was not there; `build`: the merged sources did not build */
  cause: "environment" | "build";
  reason: string;
  paths: string[];
}

export interface LandBatchConversionView {
  iddId: string;
  kind: "resolved" | "redrawn" | "rebuilt";
  files: { path: string; diff: string }[];
  rationale: string;
}

/**
 * The lanes waiting on one work clone's mainline as one card (C-247-1). Its `iddId` is the batch's id, not a lane's.
 * One signature over the lanes left on it lays them on the mainline together; a lane taken off stays on its own card.
 * While a signed batch of this mainline is under way the card says so and offers no signature.
 */
export interface LandBatchItem extends InboxBase {
  kind: "land-batch";
  title: string;
  /** the work clone the batch lands in, and the repo and branch the signature names */
  repo: string;
  repoName: string;
  workBase: string;
  lanes: LandBatchLaneView[];
  running?: { phase: string; lanes: string[]; checking: boolean; reason?: string };
  /** what the signed batch before this card did: the lanes left out, the conversions, the lanes landed */
  last?: { landed: string[]; dropped: LandBatchDropView[]; conversions: LandBatchConversionView[]; rebuildFailures?: LandBatchRebuildFailureView[]; reason?: string };
  /** the batch has ended and no lane waits on it: the card stays for a day to read what the harness converted, and offers no signature */
  settled?: boolean;
}

export interface OutboundItem extends InboxBase {
  kind: "outbound";
  outKind: "gh-issue" | "gh-repo" | "gh-pr-review" | "gh-pr-replies" | "gh-pr-body" | "gh-issue-close";
  /** gh-pr-body: the PR's title and body the card compares with (read again right before the write) */
  baseTitle?: string;
  baseBody?: string;
  /** gh-pr-replies: one reply per piece of feedback on the lane's PR */
  replies?: { ref: string; label: string; quote: string; url?: string; thread: boolean; draft: string; proposed: string; resolve: boolean; posted: boolean }[];
  /** gh-pr-review: the event the draft suggests; penne picks the final one on the card */
  event?: "comment" | "request-changes" | "approve";
  /** gh-pr-review: the labels the repo swaps with each kind of review (config/repos.yaml review_labels) */
  labelRules?: Partial<Record<"comment" | "request-changes" | "approve", { remove: string[]; add: string[] }>>;
  /** where it goes, e.g. "GitHub Issue · owner/name" */
  targetLabel: string;
  title: string;
  draft: string;
  proposed: string;
  rewrittenBy?: string;
  rewriteError?: string;
  lastError?: string;
  createdAt: string;
}

/** the engine's reading of why the stall watch halted a lane, as the stuck card shows it */
export interface StallHaltView {
  /** the step the lane stood on (the stage's name) */
  stage: string;
  /** when the lane came to that step (ISO) */
  since: string;
  /** the last record that does not move a lane, by its display name */
  lastEvent: { name: string; at: string };
  reason: string;
  /** the causes an instruction has already been sent for */
  causes: string[];
  /** the lane has an executor session to send back */
  canSendBack: boolean;
}

export interface StuckItem extends InboxBase {
  kind: "stuck";
  title: string;
  reason: string;
  /** the engine's reading of a stop it found and handed to penne */
  halt?: StallHaltView;
  /**
   * accepted must / should that are still open, and claims the triage asked penne about. The `ref` names a finding in the
   * correction penne may send for it: a weight and a handling set on the card ride the one answer that stops here
   */
  open: { ref: string; severity: string; claim: string; path?: string }[];
  /**
   * every finding the last judgement accepted, with the handling each stands at and may be given (C-272-1). `open` stays
   * for the old screen until it is removed; a screen that lets a person decide the findings reads this
   */
  accepted?: import("@idd/core").AcceptedFinding[];
  escalated: string[];
  /**
   * the note written on this stop is recorded as the answer to the judgement's one question and is handed to later
   * judgements and spec checks: the card names its one line so, and asks for no instruction to the fix there
   */
  noteAnswersQuestion?: boolean;
  /**
   * findings the triage found undoing an earlier round's fix, still waiting for penne: the earlier ref and the two
   * positions. Continuing needs a side picked or written for each (or a note)
   */
  oscillations: { ref: string; claim: string; path?: string; priorRef: string; prior: string; current: string }[];
  rejected: { claim: string; reason?: string }[];
  fixRounds: number;
  /**
   * how many items "続ける" without a note sends to the fix as the record stands (the findings and the reversals it
   * carries). 0 means a continue sends no fix: the loop does not wake the executor, and the review goes on without one
   * (it converges when nothing else is left). Absent when the continue retries a stage or the lane has no answer to read
   */
  continueFixes?: number;
  /**
   * where each button takes the lane, read from the transition the loop then runs: "continue" without a note, with
   * a note, and "go on as it is". Absent for a lane stopped outside the review loop (a stall, the budget)
   */
  onContinue?: import("@idd/core").StuckOutcome;
  onContinueWithNote?: import("@idd/core").StuckOutcome;
  onAccept?: import("@idd/core").StuckOutcome;
  /** where "自分で直す" takes the lane: its hand turn, where the engine starts nothing */
  onHandFix?: import("@idd/core").StuckOutcome;
  /** "計画から考え直す": the lane goes back to its plan */
  onReplan?: import("@idd/core").StuckOutcome;
  /**
   * the shape judge's recommendation among the five answers, with the grounds it names: each names a round, a file
   * or a count the ledger holds. Absent when the judge did not run (the card then has the answers it always had),
   * and for a stop outside the review loop
   */
  recommendation?: { choice: "continue" | "accept" | "replan"; reasons: { kind: "round" | "accepted" | "file" | "outside" | "changed"; ref: string; text: string }[]; shape?: string };
  /** the lane waits at penne's hand turn: the card shows only the "直した" answer */
  handTurn?: boolean;
  /** why the budget stop left musts behind: what the last fix did */
  history?: { sideFindings?: string[] };
  /** set when an executor / planner session stopped without answering, rather than the review loop */
  stall?: { role: string; reason: string };
  /**
   * set when the lane stopped for passing its budget. `parts` is what the budget counted; `subscription` is the
   * Claude Code spend (subscription, API equivalent), shown apart and not counted
   */
  budget?: { cost: number; limit: number; parts: { label: string; cost: number }[]; subscription: { label: string; cost: number }[] };
}

export interface RequeueItem extends InboxBase {
  kind: "requeue";
  title: string;
  /** the closed lane this Issue was taken in from, and how it ended */
  from: string;
  closed?: { outcome: string; reason?: string; at: string };
  context: string;
}

/**
 * Whether the code a long-lived process loaded still matches the checkout under it. The engine remembers where it
 * started; the screen shows the answer, and the engine uses it to decide whether a replacement is worth asking for.
 */
export interface EngineStaleView {
  /** the commit the engine started from; absent when git could not be read */
  startCommit?: string;
  /** when the engine started (ISO 8601) */
  startedAt: string;
  /** the checkout's head now; absent when git could not be read */
  head?: string;
  /** the engine's own code changed under it, so the running process no longer matches the checkout */
  stale: boolean;
  /** git could not answer: the staleness is unknown, and nothing is replaced */
  unknown?: boolean;
  /** first-parent merges taken in since the start, and the commits that are not merges */
  landings?: number;
  commits?: number;
  /** why a replacement is not being asked for now (waiting on conversations, not the unit's main process, ...) */
  hold?: string;
}

/** one failed rebuild, as the screen shows it */
export interface GuiStaleFailure {
  code: number;
  at: string;
  /** build: the build's exit was not 0; restart: the build went through but the screen was not restarted; interrupted: the build was cut off before it finished */
  kind?: "build" | "restart" | "interrupted";
}

/** the screen's own staleness: whether the build it runs was made from the head's code */
export interface GuiStaleView {
  stale: boolean;
  /** the commit the running screen answers with; absent when it could not be told */
  runningCommit?: string;
  /** the commit the build on disk was made from; absent when it carries none */
  buildCommit?: string;
  /** the rebuild is running now */
  building?: boolean;
  /** the last rebuild failed; the running screen is the earlier build */
  failed?: GuiStaleFailure;
}

/** one conversation open in the engine, as the reload card lists it */
export interface OpenConversationView {
  sessionId: string;
  title: string;
  mode?: string;
}

/** one request the engine is still answering, as the reload card lists it */
export interface WaitingRequestView {
  method: string;
  /** the request's path; the query is never kept or shown */
  path: string;
  /** when the request began (ISO 8601) */
  startedAt: string;
  /** the handler has returned and its answer is on its way; false while the handler still runs */
  sending: boolean;
}

/**
 * The card that asks penne to make way for a replacement: close the open conversations, or wait out the requests
 * still being answered. It carries no lane: nothing on record is decided by it. Its id is fixed and `appearedAt` is
 * when the wait passed its limit, so a card put off or put to sleep does not carry over to the next wait.
 */
export interface ReloadItem extends InboxBase {
  kind: "reload";
  title: string;
  /** what the replacement waits on: conversations penne can close, or requests only the handlers can finish */
  waiting: "conversations" | "requests";
  /** the conversations still open, with their titles and modes (empty when waiting on requests) */
  open: OpenConversationView[];
  /** the requests still being answered (empty when waiting on conversations) */
  requests: WaitingRequestView[];
  /** how long the replacement has waited (ms) */
  waitedMs: number;
}

/** an Issue intake leaves out (the ignore list) */
export interface IgnoredIssueView {
  ref: string;
  title: string;
  url: string;
  source: "github" | "linear";
  area?: string;
  at: string;
  /** user, or `ignore` when a lane's stop put it on (`s1_defer` / `lane_abort` in older records) */
  by: string;
  lane?: string;
}

export interface StorageItem extends InboxCommon {  kind: "storage";
  cleanup: boolean;
  minFreeGb: number;
  freeBytes: number;
  totalBytes: number;
  /** the biggest places, for a person who has not read the code */
  topPlaces: { label: string; bytes: number }[];
  /** the next candidates the sweep would delete, and their total size */
  candidateCount: number;
  candidateBytes: number;
  /** lines shown when the sweep is off: what turning it on would free */
  offNote?: string;
  /** the lanes the start hold is keeping from cutting a worktree */
  heldLanes: string[];
  archive?: { dir: string; visible: boolean };
}

export type InboxItem = DuplicateItem | QuestionItem | GranularityItem | GoItem | ReviewItem | ShipItem | LandBatchItem | OutboundItem | StuckItem | RequeueItem | StorageItem | ReloadItem | ProposalItem | SyncConflictItem;

/**
 * A unit propter and an outside tracker both changed to different values. Neither value was taken: the card shows the
 * outside's value now, the value both last agreed on, and propter's value now, and it answers nothing. It writes nothing
 * to the outside and asks for no signature; it closes by itself at the next sync once either side is back to the same value.
 */
export interface SyncConflictItem extends InboxCommon {
  kind: "sync_conflict";
  /** the registry key of the repo the Project or Issue belongs to */
  repo: string;
  /** the id the sync gave the unit; the same unit has the same id, so the card is not stacked twice */
  conflictId: string;
  unit: "project_body" | "issue_project";
  /** `PRJ-1` or the Issue ref */
  subject: string;
  /** what the unit is, in a person's words ("PRJ-1 の本文") */
  label: string;
  external: string;
  base: string;
  propter: string;
}

/**
 * One open proposal as a card of its own. A proposal is read from the column, not folded, so it is not tied to a
 * lane: a chat session may raise one and a lane that has ended keeps its harm example. The handle is one line; the
 * body is the current content beside the proposed one, built by the engine.
 */
export interface ProposalItem extends InboxCommon {
  kind: "proposal";
  proposalId: string;
  proposalKind: "overview" | "root_supersede" | "root_reanchor" | "harm_example" | "instruction_add" | "instruction_change" | "instruction_retire" | "instruction_session";
  /** the registry key of the repo the proposal is about; an instruction proposal has no repo and carries `INSTRUCTION_CARD_REPO` */
  repo: string;
  /** the lane that raised it; absent for a session's proposal (its key comes from the proposal's own id) */
  iddId?: string;
  /** the one-line handle (about 40 characters) */
  handle: string;
  /** why the agent raised it */
  reason: string;
  /** the content now, and the proposed content; the labels and values are the kind's own rows */
  before: { label: string; value: string }[];
  after: { label: string; value: string }[];
  from: { lane?: string; session?: string; at: string };
  /** when an approval takes effect: now, or when the lane that raised it is merged */
  effect: "now" | "on_merge";
  /** a line the card says beside the proposal (an add proposal's ask to review a long list of instructions) */
  notice?: string;
}

/**
 * The `repo` an instruction proposal's card carries: the user's instructions belong to no repo, and the card's key
 * (`proposal-<repo>-<id>`) needs one stable value.
 */
export const INSTRUCTION_CARD_REPO = "instruction";

export interface TimelineEntry {
  /** a key that stays the same across reads, so an opened row stays opened when rows come and go */
  key?: string;
  time: string;
  title: string;
  detail?: string;
  kind: "agent" | "user" | "warn" | "mark";
  folded?: number;
  items?: TimelineEntry[];
}

/** a spend: `total` and `parts` are what the budget counts; `subscription` is the Claude Code spend (API equivalent), shown apart */
export interface CostView {
  total: number;
  parts: { label: string; cost: number }[];
  subscription: { label: string; cost: number }[];
}

/** one move of a Claude Code reply: the text it wrote, a tool it called, the error it ended on */
export interface ClaudeMove {
  kind: "text" | "tool" | "error";
  body: string;
  tool?: string;
}

/** a Claude Code lane's conversation (a planner / executor), or a lane's short stages on Claude Code, from the lane's own record */
export interface ClaudeTranscriptView {
  label: string;
  running: boolean;
  /** the reply being written: when it started (ISO), for a clock that counts up */
  runningSince?: string;
  /** each reply as a row, the moves folded under it */
  timeline: TimelineEntry[];
  /** the last moves of the reply being written, newest last; none while no reply is being written */
  recent: ClaudeMove[];
}

/** the subscription's windows as last observed: only the ones not yet reset */
export interface ClaudeQuotaView {
  windows: { name: string; label: string; utilization: number; resets?: string }[];
  observed: string;
  rejected?: boolean;
}

export interface LaneDetailView {
  iddId: string;
  title: string;
  group: LaneGroup;
  phaseLabel: string;
  source?: SourceRef;
  branch: string;
  area: string;
  since: string;
  /** the planner's three plain lines from its last ready, when it wrote them */
  summary?: PlainSummary;
  /** the planner's six-kind table from its last ready, when it wrote one */
  riskTable?: RiskTableRow[];
  /** the planner's report of the impact on existing intent, when its ready carried one */
  intentImpact?: IntentImpactView;
  /** the last review round's hit of the repo's dangerous-path declaration (absent when none hit) */
  riskMatch?: RiskMatchView;
  undelivered: UndeliveredCount;
  priorityTop?: boolean;
  /** the lane's PR while the lane is open: penne can ask for a proposed update of its body */
  pr?: { url: string; number: number };
  contract: {
    decisions: { id: string; text: string; why?: string; source?: string }[];
    criteria: { id: string; text: string; state: CriterionState }[];
    invariants?: { id: string; text: string }[];
  };
  work?: {
    files: { path: string; delta: string }[];
    stream: { time: string; kind: string; body: string; live?: boolean }[];
    /** why no changed files are counted: the lane's base cannot be read (its parent ended and left nothing) */
    note?: string;
  };
  references?: { path: string; why: string }[];
  timeline: TimelineEntry[];
  /** harness is set for a Claude Code session; a pi one has none */
  agents: { role: string; sessionId: string; state: string; harness?: "claude" }[];
  /** the lane's proposed Purposes, which a GO from this detail would confirm */
  purposeProposals?: PurposeProposalView[];
  pending?: DecisionKind;
  /** set only when a Claude Code lane works for this lane */
  claude?: ClaudeTranscriptView[];
  cost?: CostView;
  /** the lane's spend from the same reader the budget uses, for every lane (the budget's value and the subscription apart) */
  spend?: LaneCostView;
  quota?: ClaudeQuotaView;
  /** while preparing or implementing: whether its session is running now, pi or Claude Code alike */
  activity?: "live" | "stalled" | "unstarted";
  /** while preparing or implementing: when the stage's session started (ISO) */
  stageSince?: string;
  /** while preparing or implementing: the lanes holding the stage's slots against its cap */
  concurrency?: { label: string; count: number; cap: number };
  /** set while the lane waits for a stage's cap */
  slotWait?: LaneSlotWait;
  /** set while the lane waits, before its first review, for the lanes ahead of it to land */
  orderWait?: { opponents: { lane: string; files: string[] }[]; rank?: number };
  /** the landing is approved and the merge is still owed: why the tick waits (a repo that does not publish) */
  landWait?: string;
  /** the review loop's rounds, one row per judgement (empty for a lane with no review records) */
  reviewRounds?: import("@idd/core").ReviewRound[];
}

/** a review lane (someone else's PR) as its detail tab shows it */
export interface ReviewLaneDetailView {
  kind: "review";
  iddId: string;
  title: string;
  group: LaneGroup;
  phaseLabel: string;
  /** set when the lane stopped and needs penne */
  stuck?: string;
  since: string;
  pr: {
    repo: string;
    number: number;
    url: string;
    /** the head the lane is looking at now */
    head?: string;
    /** where the PR branched off (the base of the review copy) */
    base?: string;
    /** the head reviewed before the author's last push, which the confirm compares against */
    previousHead?: string;
  };
  rounds: number;
  timeline: TimelineEntry[];
  /** each stage's report: the blind reviews, the triage and the confirm, per round */
  reports: { round: number; stage: "map" | "blind" | "triage" | "confirm"; label: string; path: string }[];
  cost: CostView;
  /** the lane's spend from the same reader the budget uses (the budget's value and the subscription's part apart) */
  spend?: LaneCostView;
  /** set only when a stage ran on Claude Code */
  claude?: ClaudeTranscriptView[];
  quota?: ClaudeQuotaView;
  /** the latest draft, and whether its outbound card is still waiting in the inbox; suggested is the word shown */
  draft?: { outboundId: string; onCard: boolean; suggested?: string };
  /** set while the lane waits for the review rounds' cap */
  slotWait?: LaneSlotWait;
}

/** the key of a card in a list: a lane-bound card names its lane, the low-space card does not */
export function inboxKey(item: InboxItem): string {
  // a proposal's key comes from the proposal itself: two of one lane's proposals are two cards (INV-112-6)
  if (item.kind === "proposal") return `proposal-${item.repo}-${item.proposalId}`;
  // a conflict belongs to a Project or an Issue, not to a lane; its id already names the repo and the unit
  if (item.kind === "sync_conflict") return `sync_conflict-${item.conflictId}`;
  return "iddId" in item ? `${item.kind}-${item.iddId}` : item.kind;
}

/** the lane a card is tied to, or undefined for a card that is tied to none (the low-space card, a session's proposal) */
export function inboxLaneId(item: InboxItem): string | undefined {
  if (item.kind === "proposal") return item.iddId;
  return "iddId" in item ? item.iddId : undefined;
}
