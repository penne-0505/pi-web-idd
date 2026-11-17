import type { DraftedSection } from "../config/conventions.ts";
import type { RouteCall, RouteReply } from "./question-routing.ts";

/**
 * A role refused for Claude Code's subscription windows, and the role (roles.yaml `fallback`) the runtime ran in
 * its place. Not a wait: the stage started, on the fallback.
 */
export interface QuotaFallback {
  role: string;
  fallback: string;
  reason: string;
  /** UNIX seconds: when the windows let the role run again */
  resets_at?: number;
  /** the fallback was already one of the stage's runs, so no run of its own was started for this role */
  folded?: boolean;
  /** the kind of failure that moved the run: quota, provider, or timeout. Absent reads as quota (older records) */
  kind?: "quota" | "provider" | "timeout";
  /** the provider the run was pinned to, when the role wrote a provider column */
  provider?: string;
}

/**
 * Claude Code's subscription windows as a stage's start reads them: the reason a Claude lane may not start now and
 * from when it may, or null when they let it start (a file with no observation included). The reading itself is
 * the lane's own (its `quotaBlockOf`); core never reads the file or the thresholds (C-133-3). A runtime without
 * the method cannot be asked, and a throw is a read that failed: the caller reads the record's own reset then, so
 * the four readers of a lane's wait still answer alike (C-133-2).
 */
export type QuotaWindowBlock = { reason: string; resetsAt?: number };

/**
 * A role the canary watches: the pipeline slots' pi roles, with the model and thinking a lane would run them on.
 * The lane resolves them (its roles.yaml is the one place the pipeline's models are set), so core never reads a
 * model list of its own.
 */
export interface CanaryRole {
  role: string;
  /** the call target the question is asked with */
  model: string;
  /** the model definition the call target came from: the record's file is one per role and model definition */
  modelName?: string;
  thinking: string;
}

/** one of the canary's questions, as the lane is asked it: the prompt carries the fixture's text, no tools do */
export interface CanaryRunTask {
  id: string;
  kind: "read" | "json" | "diff";
  prompt: string;
}

/** one answer of a canary run, with the usage the model reported */
export interface CanaryRunAnswer {
  text: string;
  usd?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** one conflicted file as the batch hands it to the role that judges: the three sides and git's marked text */
export interface LandConflictFile {
  path: string;
  base: string | null;
  /** the file as the mainline with the earlier lanes laid on it holds it */
  ours: string | null;
  /** the file as the incoming lane holds it */
  theirs: string | null;
  /** git's merge of the three, with the conflict markers in it */
  marked: string;
}

/** what one side decided: the plan and the acceptance criteria its lane wrote, as texts */
export interface LandConflictSide {
  lane: string;
  title: string;
  decided: { path: string; text: string }[];
}

/**
 * Why the generated files that conflict beside the sources were not made again from the merged sources: what the judge
 * is told, apart from what it decides on (C-261-8). `environment`: the command could not be run here, so a person
 * mends the environment; `build`: the command ran and refused the sources, or did not write the declared file, so the
 * sources are what to fix. It explains the conflict and changes no condition for a resolution.
 */
export interface LandRebuildFailureInfo {
  cause: "environment" | "build";
  paths: string[];
  reason: string;
}

export interface LandConflictInput {
  files: LandConflictFile[];
  incoming: LandConflictSide;
  earlier: LandConflictSide[];
  /** present only when the conflicted generated files in `files` could not be made again; never a reason to resolve differently */
  rebuildFailure?: LandRebuildFailureInfo;
}

/**
 * The answer to a conflict: a resolution that keeps what both lanes decided, with the file texts and the grounds that
 * show it, or the reason the two cannot both stand as they are.
 */
export type LandConflictAnswer =
  | { decision: "keeps"; files: { path: string; content: string; why: string }[]; rationale: string }
  | { decision: "changes"; reason: string };

export interface SpawnResult {
  sessionId: string;
  /** provider/modelId (or the harness's own model id) the session was started with */
  model?: string;
  /** which harness runs the session: pi (in-process RPC) or claude (headless CLI) */
  harness?: string;
  /**
   * the prompt cache hold the session's run resolved to (the role's, the repo's, or the run kind's default), so
   * the brief builder can wrap long checks for a 5-minute run without walking the role / repo order itself.
   */
  cacheTtl?: "1h" | "5m";
  /** the slot's role was refused for the windows and its fallback runs the session */
  fallbacks?: QuotaFallback[];
}

export interface PlanReviewFinding {
  severity: "must" | "should" | "nit";
  path: string;
  claim: string;
  evidence: string;
  /** the reviewer's recommended handling and how often it is expected, on the stages whose report carries them */
  action?: "fix" | "followup" | "skip";
  frequency?: string;
  /** the role (or roles, comma-joined once folded) that raised it */
  source?: string;
}

/**
 * A mark a tool leaves in a run's record when it refuses the agent the means to look at something: a model that
 * cannot read images, a shell or an outbound door the role does not have. The mark is bound to the tool and to the
 * shape of its own result, so a document or a piece of code that merely quotes the words is not a detection.
 */
export interface MissingMeansMarker {
  /** names the mark in a finding and tells one detection from another */
  id: string;
  /** the tool whose own result carries the mark; matched case-insensitively (pi's `read` and Claude's `Read` are one tool) */
  tool: string;
  /** the result's text starts with this, which is what ties the mark to the tool's answer rather than to text it read */
  prefix: string;
  /** the result also carries this text (optional) */
  note?: string;
}

/** one mark of a tool refusing the agent the means, read out of a stage run's or a conversation's record */
export interface MissingMeansFinding {
  /** the lane the record belongs to: a stage run's lane id, or a conversation's lane id */
  run: string;
  /** the role that ran it, as its record names it */
  role?: string;
  /** the tool call, so two looks at the same file are told apart and re-reading one is not a new finding */
  call: string;
  /** the file the agent tried to look at, as a repo-relative path when the run's work area holds it */
  path?: string;
  /** which mark matched: `image` for the built-in one, or a configured marker's id */
  marker: string;
  /** the tool that was refused */
  tool: string;
  /** 1 文: what the tool answered */
  note: string;
}

/** one run of the plan review, per role of pipeline.plan_review */
export interface PlanReviewRun {
  runId: string;
  role?: string;
  model?: string;
  /** this run is the shape judge (the review's closing counts it apart from the reviewers) */
  shape?: boolean;
}

export type PlanReviewStatus =
  | { state: "running" }
  | { state: "failed"; error: string }
  | { state: "done"; findings: PlanReviewFinding[]; reportMd: string; fallbacks?: QuotaFallback[] };

export type ReviewStage = "blind" | "final" | "spec" | "triage" | "feedback" | "confirm" | "feedback_confirm" | "feedback_leftovers" | "device" | "map" | "fix_plan" | "shape";

/**
 * The harms that justify recommending a fix for a should in the `triage` value: silently dropped user data or
 * wording (`data_loss`), a stopped engine or tick (`halt`), other lanes dragged in (`cross_lane`).
 */
export type FixBasis = "data_loss" | "halt" | "cross_lane";
export const FIX_BASIS: readonly FixBasis[] = ["data_loss", "halt", "cross_lane"];

/** the extra role lists of review_blind a round may add: the first round of a pass (and a conflict round), and a high-risk lane's */
export type ReviewExtra = "first_round" | "high_risk";

/** a route of a large diff, from the map written before its blind round: the files a value passes through */
export interface RiskRoute {
  id: string;
  paths: string[];
  question: string;
  harms: ("authority" | "irreversible" | "shown_vs_sent")[];
}


export interface TriageDecision {
  ref: string;
  verdict: "accept" | "reject" | "escalate";
  severity: "must" | "should" | "nit";
  claim: string;
  path?: string;
  /** accept: what the fix has to achieve, written as a goal rather than a means */
  fix?: string;
  reason?: string;
  /** accept must / should: who is affected, in which situation, and what happens */
  impact?: string;
  /** accept: the handling the judge recommends after checking the finding itself (a must is always `fix`) */
  action?: "fix" | "followup" | "skip";
  /** accept should, Issue lane: which harm justifies a recommended fix; a fix without it (or without impact) is read as a follow-up */
  fix_basis?: FixBasis;
  /** reject: outside this change, but worth an Issue of its own */
  followup?: boolean;
  /** reject, PR feedback: the item asks for nothing (a summary, a greeting, an approval), so it gets no reply */
  no_request?: boolean;
  /** the finding undoes an earlier round's fix: that round's ref, and the two positions for penne to choose between */
  reverts?: { prior_ref: string; prior: string; current: string };
  /** review triage: the reviewer runs (report directory names) the finding came from, all of them when merged */
  from?: string[];
  /** review triage: the severity the reviewer gave, the heaviest when merged. The harness sets it from the report; the judgement is never handed it */
  reported_severity?: "must" | "should" | "nit";
  /** review triage: the ref of penne's correction this accepted finding repeats; the finding is then read with that correction's weight and handling */
  correction_ref?: string;
  /** review lane triage: the should is worth putting in the review body */
  report?: boolean;
}

/** a piece of feedback on the lane's own PR: a review body, a comment, a thread comment, or a failed check */
export interface PrFeedbackItem {
  id: string;
  kind: "thread" | "review" | "comment" | "ci";
  author: string;
  body: string;
  url: string;
  created_at: string;
  thread_id?: string;
  path?: string;
  line?: number | null;
}

export interface ReplyDraft {
  ref: string;
  label: string;
  quote: string;
  thread_id?: string;
  url?: string;
  draft: string;
  resolve: boolean;
}

export type ReviewRunStatus =
  | { state: "running" }
  | { state: "failed"; error: string }
  | {
    state: "done";
    reportJson: string;
    reportMd: string;
    /** blind / final / device, and the new findings of a confirm */
    findings?: PlanReviewFinding[];
    /** triage */
    decisions?: TriageDecision[];
    /** confirm */
    items?: { ref: string; resolved: boolean; evidence?: string }[];
    /** device: the run decided the change needs no device check, and why */
    skipped?: string;
    /** map: the routes a value or decision passes through, in the map's order */
    routes?: RiskRoute[];
    /** the report's own overall call (approve / request-changes / hold for the review format) */
    verdict?: string;
    /** the run changed roles or providers while it ran; the engine keeps this on the stage's closing record */
    fallbacks?: QuotaFallback[];
  };

/** how an agent session stands: running, or stopped with how its last turn ended (stopped: a person stopped it) */
export type SessionStatus =
  | { state: "running" }
  | { state: "stopped"; cause: "error" | "interrupted" | "finished" | "stopped"; error?: string; at: string }
  /** its next message waits for Claude Code's subscription windows: not a stop (resetsAt: UNIX seconds) */
  | { state: "quota_wait"; reason: string; resetsAt?: number; at: string }
  | { state: "unknown" };

export interface AgentRunner {
  deliver(sessionId: string, text: string, opts?: { cwd?: string; type?: string }): Promise<void>;
  sessionStatus?(sessionId: string): Promise<SessionStatus>;
  /**
   * Whether Claude Code's windows hold a lane from starting now, read the way the stage's start reads them, or null
   * when they let one start. The lane's own reading, handed over so core's readers decide the wait the same way the
   * start does (C-133-3). Left out when the runtime cannot tell; a throw is a failed read.
   */
  quotaBlock?(): QuotaWindowBlock | null;
  /**
   * The role and model that judge a lane's questions, or null when the setting's key is left out: the tick then
   * routes nothing and every question stays a person's.
   */
  questionRouting?(): { role: string; model: string } | null;
  /**
   * Ask the judge about a batch against its material, one shot in a child process with read-only tools. It returns the
   * judge's text; core reads, checks and records what it says. A throw is a failure the batch survives as a person's.
   */
  routeQuestions?(call: RouteCall): Promise<RouteReply>;
  /** ask for a tick, best effort: the answers were just recorded, and the planner's word waits for delivery */
  kickTick?(): void;
  /** some session of the runtime, the lane's or not, is working in this directory now */
  cwdBusy?(cwd: string): boolean;
  /** a session waiting for the windows gets its next chance: the runtime starts it when they allow it (true when it did) */
  wakeSession?(sessionId: string): Promise<boolean>;
  /** what an agent session has cost so far (USD), from its own record */
  sessionCost?(sessionId: string): Promise<number>;
  /**
   * A cheap fingerprint (a size and update time) of the record an agent session's cost is read from: the cost reader
   * re-reads the session only when it changes. Null when the session has no record. Kept optional so a runtime that
   * does not read a session's day split can leave both this and `sessionDailyCost` out (DEC-9142).
   */
  sessionRecordFingerprint?(sessionId: string): string | null;
  /**
   * What an agent session has cost so far, split by the JST day each reply was written. Its `cost` is the same total
   * `sessionCost` returns. Null when the session has no record. Declared on the port so the engine's runner, whose
   * object is typed `AgentRunner`, is checked for it.
   */
  sessionDailyCost?(sessionId: string): { cost: number; daily: { day: string; cost: number }[] } | null;
  /**
   * The pipeline's pi roles the canary watches, as roles.yaml sets them now. Optional: a runtime that cannot name
   * them runs no canary, and the stage is skipped.
   */
  canaryRoles?(): CanaryRole[];
  /**
   * One canary question, asked of the role's model with the role's own thinking and no tools: one shot, no session.
   * A run that cannot answer throws; the canary records it and goes on, so no throw here may stop the tick.
   *
   * The run never readies the role's agent dir: the canary calls `canaryPrepare` once a day before the role's
   * questions, and a question's `total_ms` is the runner's whole run, not the preparation and not the model's own
   * reply time.
   */
  canaryRun?(opts: { role: string; model: string; modelName?: string; thinking: string; task: CanaryRunTask; timeoutMs: number }): Promise<CanaryRunAnswer>;
  /**
   * Ready one canary role's agent dir before its day's questions: the dir carries the model's routing and price, and
   * building it runs pi's catalog (which can fetch a gateway's price list). A runtime prepares it the way it prepares
   * a conversation's dir, outside its own loop, so the wait holds no other caller of the runtime.
   *
   * The canary calls this once per role per day: the day's record keeps that the dir was readied, and the day's later
   * tries ask straight away. This waits inside what is left of the tick's canary limit, before a question starts, so
   * the preparation is never part of a question's `total_ms`. A throw, or a wait past the limit, is that role's
   * failure: its questions are recorded as not asked, and the tick's other stages see nothing from it.
   */
  canaryPrepare?(opts: { role: string; modelName?: string }): Promise<void>;
  /**
   * Judge a conflict between a lane and the lanes laid on the mainline before it, and write the resolution only when it
   * can be shown to leave what both lanes decided as it is (C-247-5). The material is the conflicted files (base, both
   * sides and git's marked text) and the plan and acceptance criteria each side wrote. A runtime without it, or an
   * answer that changes what a side decided, leaves the lane out of the batch: nothing is guessed.
   */
  resolveLandConflict?(input: LandConflictInput): Promise<LandConflictAnswer>;

  /**
   * a PR title and body for the submit card, written in the repo's language and after its templates; `revise` is a
   * rewrite of a body that is already up, which may lack the template's sections or carry a mark the new draft may not
   */
  draftPrText?(opts: { repo: string; material: string; lane?: string; revise?: boolean }): Promise<{ title: string; body: string; model: string; conventions?: DraftedSection[] }>;
  /** the commit message of a push for the submit card, written after the repo's own commit rules (its AGENTS.md, CLAUDE.md, rules) */
  draftCommitMessage?(opts: { repo: string; material: string; lane?: string }): Promise<{ message: string; model: string; conventions?: DraftedSection[] }>;
  /**
   * Start a session for a pipeline slot. `laneId` is the Issue lane (IDD-035) the agent reports as: the runtime
   * puts it (and the token) in the agent's bash environment, so the report CLI can send without arguments.
   */
  spawn?(opts: { role: string; cwd: string; laneId?: string; sessionId?: string }): Promise<SpawnResult>;
  /**
   * take back a session spawned for a start the engine then refused (the lane's stage no longer took it, or the lane
   * gate stayed busy): the session is stopped and what its spawn recorded is removed, so nothing resumes or lists it.
   * Never called for a session that was given a message.
   */
  discard?(sessionId: string): Promise<void>;
  /**
   * Stop one of a lane's sessions where it stands: a Claude conversation is stopped as a person stops it (its
   * supervisor is told, so nothing resumes it), a pi session is shut down in this process. Used when a lane is
   * taken out (ignored, redone) or when a tick catches up with one that was taken out from the CLI.
   */
  stopSession?(sessionId: string): Promise<void>;
  /** stop one of a lane's ad-hoc runs (a review round, a plan review) and take its review copy down */
  stopRun?(runId: string): Promise<void> | void;
  /**
   * start a one-shot review of the planner's documents, one run per role of pipeline.plan_review. A role that
   * could not start is listed in `failed`; it throws only when none started. A role refused for Claude's windows
   * that ran on its fallback is listed in `fallbacks` (folded when the fallback was already one of the runs).
   * recordsShape: a v2 lane's review reads the plan report's Choice drafts instead of decision.md (DEC-119-6);
   *   the engine's adapter must carry it to the lane, so a dropped field sends a v1 task to a v2 lane
   */
  startPlanReview?(opts: { iddId: string; worktree: string; inputs: string[]; attempt: number; roles?: number; norms?: string[]; iddNorms?: string[]; recordsShape?: "docs" | "state"; /** the lane's depth asks for the shape judge beside the reviewers (the depth table's `shape`) */ withShape?: boolean }): Promise<{ runs: PlanReviewRun[]; failed?: { role?: string; model?: string; error: string; shape?: boolean }[]; fallbacks?: QuotaFallback[] }>;
  planReviewStatus?(runId: string): PlanReviewStatus;
  /** fold the findings of parallel reviews into one list: the same finding from two runs is kept once */
  mergeFindings?(lists: PlanReviewFinding[][]): PlanReviewFinding[];
  /**
   * start the S2 review loop's runs; blind / final may start several (one per role of the slot, or with the
   * places of a map one per place and a generic one). A map of a diff below the threshold starts nothing and says why in skipped.
   * wholeDiff: in a mapped round, the runs that read the whole diff (the others read only their place's files).
   * fallbacks: a role refused for Claude's windows that ran on its fallback role.
   * norms: an Issue lane's points where the harness's rules come before the repo's, which the runs are told as knowledge
   * iddNorms: the IDD norms the lane ran under, told as knowledge (not an override of the repo's norms)
   * extras: blind / final: which of review_blind's extra role lists this round adds (the runtime names the roles)
   * scope: blind / final: what the runs are shown. `increment`: base..head is only the fixes since the last review,
   * read with their callers; `conflict`: only the hunks `merge` resolved (base..head is the lane's whole change on
   * the new base); absent: the whole diff base..head. In an increment, `merge` is a mainline merge among the fixes
   * (shown by its resolution) and `laneBase` where the lane's whole change starts (its file names go with the brief)
   * shouldDefault: triage of an Issue lane's pass that closes on musts alone: shoulds are left for a follow-up by default
   * existingFollowups: the triage of a conflict scope round is handed the follow-ups already written: the same
   * content is not reported again (the list file is among `inputs`)
   * noFallbackRoles: a Claude Code role that must not be swapped for its fallback (a High lane's final: the High role
   *   waits for the windows instead). The refusal is thrown as by checkClaudeRoles, so nothing starts
   * recordsShape: a v2 lane's rounds read the lane's Choices, not decision.md (DEC-119-6)
   */
  startReviewRun?(opts: { iddId: string; stage: ReviewStage; round: number; worktree: string; base: string; head: string; inputs: string[]; routes?: RiskRoute[]; norms?: string[]; iddNorms?: string[]; extras?: ReviewExtra[]; scope?: "increment" | "conflict"; merge?: string; laneBase?: string; shouldDefault?: "followup"; existingFollowups?: boolean; noFallbackRoles?: string[]; overview?: string; laneKind?: "issue" | "review"; hasPlan?: boolean; roleCount?: number; onlyHighRisk?: boolean; spec?: { count: number; inputs: string[] }; recordsShape?: "docs" | "state" }): Promise<{ runIds: string[]; skipped?: string; wholeDiff?: string[]; fallbacks?: QuotaFallback[]; runRoles?: string[]; runLabels?: string[]; routeCount?: number; routesOverCap?: boolean }>;
  reviewRunStatus?(runId: string): ReviewRunStatus;
  /** why this diff gets no map (below the threshold, no slot), or null when it does: asked before a map slot is taken */
  riskMapSkipReason?(opts: { worktree: string; base: string; head: string }): string | null;
  /**
   * review lanes (someone else's PR): a review copy of the PR, and moving it when the author pushes. A move or
   * removal names the copy the lane recorded (its path and the name it was cut with), which may lie outside
   * today's review root; a removal that fails throws, and a copy already gone is not a failure
   */
  preparePrWorktree?(opts: { repo: string; pr: number; name: string }): Promise<{ path: string; head: string; base: string }>;
  movePrWorktree?(opts: { repo: string; pr: number; path: string; name?: string }): { head: string; base: string };
  removePrWorktree?(opts: { repo: string; pr?: number; path: string; name?: string }): void;
  prStatus?(repo: string, pr: number): { head: string; state: "OPEN" | "MERGED" | "CLOSED"; title: string; url: string };
  /** the PR's title and body as GitHub has them now */
  prText?(repo: string, pr: number): { title: string; body: string };
  /** PR body, comments and reviews written to files the triage can read */
  fetchPrContext?(repo: string, pr: number, out: string): { files: string[] };
  /** the lane's own PR: the reviews and comments on it (its author's included, the harness's replies left out), and the failed checks */
  fetchPrFeedback?(repo: string, pr: number): Promise<{ author: string; head: string; items: PrFeedbackItem[] }>;
  /**
   * The records of the named lanes (a stage run's lane id, or a conversation's session id) that show a tool refusing
   * the agent the means to look at something. Optional: a runtime that cannot read a lane's records leaves the
   * detections out, and the judgement starts without them.
   */
  missingMeans?(opts: { ids: string[]; markers?: MissingMeansMarker[] }): MissingMeansFinding[];
  /** queue a draft on the outbound card, and read back what penne did with it */
  queueOutbound?(opts:
    | { kind: "gh-pr-review"; target: { repo: string; pr: number; expectHead: string; event: "comment" | "request-changes" | "approve" }; title: string; body: string; source: string; lane?: string }
    | { kind: "gh-pr-replies"; target: { repo: string; pr: number; expectHead: string }; title: string; parts: ReplyDraft[]; source: string; lane?: string }
    | { kind: "gh-issue"; target: { repo: string }; title: string; body: string; source: string; lane?: string }
    /** the one-liner that closes a GitHub Issue after its lane was landed into the work side's mainline */
    | { kind: "gh-issue-close"; target: { repo: string; issue: number }; title: string; body: string; source: string }
    /** an update of an existing PR's text: the card shows it against baseTitle / baseBody, read again before the write */
    | { kind: "gh-pr-body"; target: { repo: string; pr: number; baseTitle: string; baseBody: string }; title: string; body: string; source: string }): Promise<{ id: string }>;
  /**
   * post a `gh-issue-close` record now, without an outbound approval: the landing approval signed the close (its
   * destination and one-liner), and the tick posts it as the last step of the landing. Only this kind is taken, so
   * the door is not a way around the signature for another write; the landing's path is its only caller.
   */
  postOutbound?(opts: { kind: "gh-issue-close"; target: { repo: string; issue: number }; title: string; body: string; source: string }): Promise<{ id: string; status: "posted" | "failed"; url?: string; error?: string }>;
  outboundStatus?(id: string): { status: "ready" | "posting" | "posted" | "failed" | "discarded"; event?: string; url?: string } | null;
  /**
   * The follow-up Issue drafts the named lane raised (`idd out draft --kind gh-issue` from that lane), whatever penne
   * did with them except discarding: read only, it posts and approves nothing. The Issue lane's judgement is handed
   * this list, so an old form kept as a stopgap is accepted only when a draft that exists records it. A runner that
   * cannot read the drafts leaves it out, and the judgement is handed no list (so it cannot take a draft as present).
   */
  laneFollowupDrafts?(iddId: string): { id: string; title: string; body: string; status: string; url?: string }[];
}

let runner: AgentRunner | null = null;

export function setAgentRunner(next: AgentRunner | null): void {
  runner = next;
}

export function getAgentRunner(): AgentRunner | null {
  return runner;
}
