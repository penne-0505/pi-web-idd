// intent: DEC-650 — engine 側の型は handoff の state file schema をそのまま写す (view model はここに置かない)

export interface BacklogRecord {
  idd_id: string;
  parent_id: string | null;
  created_at: string;
  linear_issue_url: string | null;
  gh_issue_url: string | null;
  pull_req_url: string | null;
  source_type: "linear" | "github";
  context: string;
  title: string;
  area: string;
  priority_snapshot?: Record<string, unknown>;
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
  questions: { question_id: string; question: string; context: string; options: { index: number; label: string; description?: string }[] }[];
}

export interface PendingAnswer {
  idd_id: string;
  batch_id: string;
  question_id: string;
}

export interface ExecutorProgress {
  idd_id: string;
  updated_at: string;
  current_step: string;
  qa_status: { qa_id: string; status: string }[];
  recent_activity: string[];
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
}

export interface SessionRecord {
  idd_id: string;
  planner_session_id?: string;
  executor_session_id?: string;
  started_at: string;
  worktree_path: string;
  branch: string;
  model?: string;
}
