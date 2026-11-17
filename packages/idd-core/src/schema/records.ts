
export interface BacklogRecord {
  idd_id: string;
  parent_id: string | null;
  created_at: string;
  linear_issue_url: string | null;
  /** Linear's own id of the Issue (a UUID), for a lane taken in from Linear */
  linear_issue_id?: string;
  gh_issue_url: string | null;
  pull_req_url: string | null;
  source_type: "linear" | "github";
  context: string;
  title: string;
  area: string;
  priority_snapshot?: Record<string, unknown>;
  /**
   * the same-repo dependencies the tracker reported when the Issue was taken in (closed ones included, as read then);
   * absent on rows written before intake kept them, and on an Issue that reported none
   */
  blockers?: IssueBlocker[];
}

export interface LifecycleRecord {
  event: string;
  idd_id: string;
  at: string;
  attrs?: Record<string, unknown>;
}

export interface PendingReview {
  review_id: string;
  detected_at: string;
  candidate: { source_type: string; linear_issue_url?: string; gh_issue_url?: string; title: string; context: string; area: string };
  suspected_duplicate_of: string[];
  detection_method: "url" | "semantic";
  detection_reason: string;
}

export interface PendingQuestionBatch {
  idd_id: string;
  batch_id: string;
  asked_at: string;
  questions: {
    question_id: string;
    question: string;
    context: string;
    options: {
      index: number;
      label: string;
      description?: string;
      /** absent in batches asked before options carried a recommendation */
      recommendation?: "recommended" | "acceptable" | "not_recommended";
      rationale?: string;
    }[];
  }[];
}

/** the value of `answered_by` on an answer, and of the mark on a close, when the mechanism answered in a person's place */
export const ROUTED_BY = "router";

/** one quote an answer rests on, and where the engine found it: a Choice's field, the Issue's text, or a norm under `_docs/standards/` */
export interface PendingAnswerBasis {
  source: "choice" | "issue" | "norm";
  /** a Choice's id, or a path under the lane's worktree (norm); empty for the Issue */
  ref: string;
  /** the Choice's field the quote is in (chosen, why, anchored, free); empty for the Issue and a norm */
  field?: string;
  quote: string;
}

export interface PendingAnswer {
  idd_id: string;
  batch_id: string;
  question_id: string;
  answered_at: string;
  selection: { index?: number; label: string };
  reason?: string | null;
  notes?: string | null;
  /** `router` when the mechanism answered in a person's place; absent on a person's answer, and on every older row */
  answered_by?: typeof ROUTED_BY;
  /** a mechanism row: the role and the model the answer came from */
  router?: { role: string; model: string };
  /** a mechanism row: the quotes the engine found in the material, at least one */
  basis?: PendingAnswerBasis[];
}

export interface ExecutorProgress {
  idd_id: string;
  updated_at: string;
  current_step: string;
  qa_status: { qa_id: string; status: string }[];
  recent_activity: string[];
}

/** how the tracker last reported a blocker: closed ones (whatever the reason) do not hold an Issue back */
export type BlockerState = "open" | "closed" | "unknown";

/** a dependency the tracker reports on an Issue, as the tracker described it */
export interface IssueBlocker {
  /** #12 for GitHub, APP-1234 for Linear */
  ref: string;
  title: string;
  url: string;
  state: BlockerState;
  /** owner/name (GitHub) or team key (Linear) the blocker is in */
  scope: string;
  /** the blocker is in another repo / team: read, but not followed */
  outOfScope: boolean;
}

/** an Issue a filtered intake left out because a same-repo dependency is still open */
export interface HeldIssue {
  source: "github" | "linear";
  area: string;
  /** #12 or APP-1234 */
  ref: string;
  title: string;
  url: string;
  /** why the run held it back */
  reason: string;
  /** the blockers it waits on, in the tracker's own words */
  blockers: IssueBlocker[];
}

export interface CronRunRecord {
  cron_run_id: string;
  started_at: string;
  completed_at: string;
  intake_count: number;
  duplicates_detected: number;
  backlog_added_ids: string[];
  s1_failed_ids: string[];
  failure_details: { idd_id?: string; reason?: string }[];
  /** each capped stage after the tick's stages ran: its cap, the lanes holding it, and the lanes waiting for it */
  slot_waits?: CronSlotWait[];
  /** the Issues the run held back for an open tracker dependency */
  held?: HeldIssue[];
  /** blockers in another repo / team the run read but did not follow */
  ignored_blockers?: { ref: string; title: string; blocker: IssueBlocker }[];
}

export interface CronSlotWait {
  slot: string;
  cap: number;
  running: number;
  /** since: when the lane came to be ready to start the stage; waited_min: minutes from then to the run */
  lanes: { id: string; since: string; waited_min: number }[];
}

export interface SessionRecord {
  idd_id: string;
  planner_session_id?: string;
  executor_session_id?: string;
  started_at: string;
  worktree_path: string;
  branch: string;
  model?: string;
  /** pi (in-process RPC) or claude (headless CLI). Absent on records written before roles.yaml drove the runner */
  harness?: string;
  /** the session carries a fix of the PR's feedback or a send-back, not the lane's implementation */
  kind?: "fix";
  /** the intent-record shape the planner was briefed under (`state` for the v2 shape); absent on older sessions */
  records_shape?: string;
}
