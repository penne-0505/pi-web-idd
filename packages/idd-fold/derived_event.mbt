// The lifecycle's event names the derivations read, as a closed type.
//
// A row's `event` comes from a file, so the boundary reads it once and turns it into one of these. A name
// the derivations have no reading for keeps its own text (`EvUnknown`): the column holds old rows and rows
// written by hand, and the derivations read past a name they do not know. The gain is that a name they do
// read is a variant, so every dispatch lists every variant and no catch-all: adding a variant then stops
// the build until the derivation says what it does with it (the norm for the fold's events, C-191-3).

///|
/// The lifecycle events the lane state, stage and review loop read, and every other name as it came in.
pub(all) enum DerivedEvent {
  EvBlockedByDependency
  EvClaudeQuotaWait
  EvFixPlanDone
  EvFixPlanStarted
  EvShapeStarted
  EvShapeJudged
  EvLaneBudgetExtended
  EvLaneClose
  EvLaneOpen
  EvLaneOverBudget
  EvLaneStallDetected
  EvLaneStallInstructed
  EvLaneStallResumed
  EvLaneStalled
  EvLaneStartSkipped
  EvLaneWaitNotified
  EvLaneWorktreeKept
  EvLaneWorktreeRetired
  EvQuestionBatchAnswered
  EvQuestionBatchAsked
  EvS0RequeueGo
  EvS1BaseAdvanced
  EvS1Defer
  EvS1Go
  EvS1GranularityAnswered
  EvS1GranularityProposed
  EvS1GranularityRecorded
  EvS1PlanReviewDone
  EvS1PlanReviewSkipped
  EvS1PlanReviewStarted
  EvS1Ready
  EvS1RecoveryAttempt
  EvS1ReplanRequested
  EvS1ReviseRequested
  EvS2ChecksDone
  EvS2ChecksStarted
  EvS2ConfirmDone
  EvS2ConfirmStarted
  EvS2DeviceDone
  EvS2DeviceSkipped
  EvS2DeviceStarted
  EvS2ExecutorWaitEnded
  EvS2ExecutorWaiting
  EvS2FixSent
  EvS2HandFixed
  EvS2IntentChecked
  EvS2MapDone
  EvS2MapDropped
  EvS2MapHeadMoved
  EvS2MapStarted
  EvS2OrderLimit
  EvS2OrderPassed
  EvS2OrderReleased
  EvS2OrderUnknown
  EvS2OrderWaiting
  EvS2PlanWritten
  EvS2RecordsConflict
  EvS2RecordsInstructed
  EvS2RecordsReopened
  EvS2RecoveryAttempt
  EvS2Result
  EvS2ReviewBaseConflict
  EvS2ReviewBaseInstructed
  EvS2ReviewBaseMerged
  EvS2ReviewBaseSkipped
  EvS2ReviewConverged
  EvS2ReviewEscalated
  EvS2ReviewFindings
  EvS2ReviewMergedSkipped
  EvS2ReviewResumed
  EvS2ReviewRunFailed
  EvS2ReviewSkipped
  EvS2ReviewStarted
  EvS2Start
  EvS2TriageDone
  EvS2TriageStarted
  EvS3CheckClean
  EvS3CheckConflict
  EvS3CheckInProgress
  EvS3Defer
  EvS3FollowupsNotWritten
  EvS3FollowupsWritten
  EvS3Ok
  EvS3PlanArchiveFailed
  EvS3PlanArchived
  EvS3PlanRefsFixed
  EvS3R2Done
  EvS3R2NotRecorded
  EvS3R2Recorded
  EvS3R2Skipped
  EvS3R2Started
  EvS3Ready
  EvS3Reject
  EvS4LandApprovalDropped
  EvS4LandApproved
  EvS4LandConflict
  EvS4LandHeld
  EvS4LandHold
  EvS4LandMerged
  EvS4LandRecheck
  EvS4Merged
  EvS4PrCreated
  EvS4PrDraftFailed
  EvS4PushHeld
  EvS4Pushed
  EvS4RepliesQueued
  EvS4ReviewCommentReceived
  EvS4Revise
  EvS4ShipFailed
  EvS4SubmitOpenFailed
  EvS4SubmitStarted
  EvS4VerifyUserJudgmentAnswered
  EvUnknown(String)
} derive(Eq)

///|
/// The event a name stands for. A name no derivation reads is kept as it is.
fn derived_event_of(name : String) -> DerivedEvent {
  match name {
    "blocked_by_dependency" => EvBlockedByDependency
    "claude_quota_wait" => EvClaudeQuotaWait
    "fix_plan_done" => EvFixPlanDone
    "fix_plan_started" => EvFixPlanStarted
    "s2_shape_started" => EvShapeStarted
    "s2_shape_judged" => EvShapeJudged
    "lane_budget_extended" => EvLaneBudgetExtended
    "lane_close" => EvLaneClose
    "lane_open" => EvLaneOpen
    "lane_over_budget" => EvLaneOverBudget
    "lane_stall_detected" => EvLaneStallDetected
    "lane_stall_instructed" => EvLaneStallInstructed
    "lane_stall_resumed" => EvLaneStallResumed
    "lane_stalled" => EvLaneStalled
    "lane_start_skipped" => EvLaneStartSkipped
    "lane_wait_notified" => EvLaneWaitNotified
    "lane_worktree_kept" => EvLaneWorktreeKept
    "lane_worktree_retired" => EvLaneWorktreeRetired
    "question_batch_answered" => EvQuestionBatchAnswered
    "question_batch_asked" => EvQuestionBatchAsked
    "s0_requeue_go" => EvS0RequeueGo
    "s1_base_advanced" => EvS1BaseAdvanced
    "s1_defer" => EvS1Defer
    "s1_go" => EvS1Go
    "s1_granularity_answered" => EvS1GranularityAnswered
    "s1_granularity_proposed" => EvS1GranularityProposed
    "s1_granularity_recorded" => EvS1GranularityRecorded
    "s1_plan_review_done" => EvS1PlanReviewDone
    "s1_plan_review_skipped" => EvS1PlanReviewSkipped
    "s1_plan_review_started" => EvS1PlanReviewStarted
    "s1_ready" => EvS1Ready
    "s1_recovery_attempt" => EvS1RecoveryAttempt
    "s1_replan_requested" => EvS1ReplanRequested
    "s1_revise_requested" => EvS1ReviseRequested
    "s2_checks_done" => EvS2ChecksDone
    "s2_checks_started" => EvS2ChecksStarted
    "s2_confirm_done" => EvS2ConfirmDone
    "s2_confirm_started" => EvS2ConfirmStarted
    "s2_device_done" => EvS2DeviceDone
    "s2_device_skipped" => EvS2DeviceSkipped
    "s2_device_started" => EvS2DeviceStarted
    "s2_executor_wait_ended" => EvS2ExecutorWaitEnded
    "s2_executor_waiting" => EvS2ExecutorWaiting
    "s2_fix_sent" => EvS2FixSent
    "s2_hand_fixed" => EvS2HandFixed
    "s2_intent_checked" => EvS2IntentChecked
    "s2_map_done" => EvS2MapDone
    "s2_map_dropped" => EvS2MapDropped
    "s2_map_head_moved" => EvS2MapHeadMoved
    "s2_map_started" => EvS2MapStarted
    "s2_order_limit" => EvS2OrderLimit
    "s2_order_passed" => EvS2OrderPassed
    "s2_order_released" => EvS2OrderReleased
    "s2_order_unknown" => EvS2OrderUnknown
    "s2_order_waiting" => EvS2OrderWaiting
    "s2_plan_written" => EvS2PlanWritten
    "s2_records_conflict" => EvS2RecordsConflict
    "s2_records_instructed" => EvS2RecordsInstructed
    "s2_records_reopened" => EvS2RecordsReopened
    "s2_recovery_attempt" => EvS2RecoveryAttempt
    "s2_result" => EvS2Result
    "s2_review_base_conflict" => EvS2ReviewBaseConflict
    "s2_review_base_instructed" => EvS2ReviewBaseInstructed
    "s2_review_base_merged" => EvS2ReviewBaseMerged
    "s2_review_base_skipped" => EvS2ReviewBaseSkipped
    "s2_review_converged" => EvS2ReviewConverged
    "s2_review_escalated" => EvS2ReviewEscalated
    "s2_review_findings" => EvS2ReviewFindings
    "s2_review_merged_skipped" => EvS2ReviewMergedSkipped
    "s2_review_resumed" => EvS2ReviewResumed
    "s2_review_run_failed" => EvS2ReviewRunFailed
    "s2_review_skipped" => EvS2ReviewSkipped
    "s2_review_started" => EvS2ReviewStarted
    "s2_start" => EvS2Start
    "s2_triage_done" => EvS2TriageDone
    "s2_triage_started" => EvS2TriageStarted
    "s3_check_clean" => EvS3CheckClean
    "s3_check_conflict" => EvS3CheckConflict
    "s3_check_in_progress" => EvS3CheckInProgress
    "s3_defer" => EvS3Defer
    "s3_followups_not_written" => EvS3FollowupsNotWritten
    "s3_followups_written" => EvS3FollowupsWritten
    "s3_ok" => EvS3Ok
    "s3_plan_archive_failed" => EvS3PlanArchiveFailed
    "s3_plan_archived" => EvS3PlanArchived
    "s3_plan_refs_fixed" => EvS3PlanRefsFixed
    "s3_r2_done" => EvS3R2Done
    "s3_r2_not_recorded" => EvS3R2NotRecorded
    "s3_r2_recorded" => EvS3R2Recorded
    "s3_r2_skipped" => EvS3R2Skipped
    "s3_r2_started" => EvS3R2Started
    "s3_ready" => EvS3Ready
    "s3_reject" => EvS3Reject
    "s4_land_approval_dropped" => EvS4LandApprovalDropped
    "s4_land_approved" => EvS4LandApproved
    "s4_land_conflict" => EvS4LandConflict
    "s4_land_held" => EvS4LandHeld
    "s4_land_hold" => EvS4LandHold
    "s4_land_merged" => EvS4LandMerged
    "s4_land_recheck" => EvS4LandRecheck
    "s4_merged" => EvS4Merged
    "s4_pr_created" => EvS4PrCreated
    "s4_pr_draft_failed" => EvS4PrDraftFailed
    "s4_push_held" => EvS4PushHeld
    "s4_pushed" => EvS4Pushed
    "s4_replies_queued" => EvS4RepliesQueued
    "s4_review_comment_received" => EvS4ReviewCommentReceived
    "s4_revise" => EvS4Revise
    "s4_ship_failed" => EvS4ShipFailed
    "s4_submit_open_failed" => EvS4SubmitOpenFailed
    "s4_submit_started" => EvS4SubmitStarted
    "s4_verify_user_judgment_answered" => EvS4VerifyUserJudgmentAnswered
    other => EvUnknown(other)
  }
}

///|
/// The review loop's own events: the words the loop reads, and the ones that note something on a lane
/// without moving it (the same two lists the TypeScript keeps, `REVIEW_EVENTS` and `LANE_NOTE_EVENTS`).
fn is_review_event(event : DerivedEvent) -> Bool {
  match event {
    EvBlockedByDependency => false
    EvClaudeQuotaWait => false
    EvFixPlanDone => false
    EvFixPlanStarted => false
    EvShapeStarted => false
    EvShapeJudged => false
    EvLaneBudgetExtended => false
    EvLaneClose => false
    EvLaneOpen => false
    EvLaneOverBudget => false
    EvLaneStallDetected => false
    EvLaneStallInstructed => false
    EvLaneStallResumed => false
    EvLaneStalled => false
    EvLaneWaitNotified => false
    EvLaneStartSkipped => false
    EvQuestionBatchAsked => false
    EvS0RequeueGo => false
    EvS1BaseAdvanced => false
    EvS1Defer => false
    EvS1Go => false
    EvS1GranularityAnswered => false
    EvS1GranularityProposed => false
    EvS1GranularityRecorded => false
    EvS1PlanReviewDone => false
    EvS1PlanReviewSkipped => false
    EvS1PlanReviewStarted => false
    EvS1Ready => false
    EvS1ReplanRequested => false
    EvS1ReviseRequested => false
    EvS2ChecksDone => true
    EvS2ChecksStarted => true
    EvS2ConfirmDone => true
    EvS2ConfirmStarted => true
    EvS2DeviceDone => true
    EvS2DeviceSkipped => true
    EvS2DeviceStarted => true
    EvS2ExecutorWaitEnded => false
    EvS2ExecutorWaiting => false
    EvS2FixSent => true
    EvS2HandFixed => true
    EvS2IntentChecked => true
    EvS2MapDone => true
    EvS2MapDropped => true
    EvS2MapHeadMoved => true
    EvS2MapStarted => true
    EvS2OrderLimit => true
    EvS2OrderPassed => true
    EvS2OrderReleased => true
    EvS2OrderUnknown => true
    EvS2OrderWaiting => true
    EvS2RecordsConflict => true
    EvS2RecordsInstructed => true
    EvS2RecordsReopened => true
    EvS2Result => false
    EvS2ReviewBaseConflict => true
    EvS2ReviewBaseMerged => false
    EvS2ReviewBaseSkipped => false
    EvS2ReviewConverged => true
    EvS2ReviewEscalated => true
    EvS2ReviewFindings => true
    EvS2ReviewMergedSkipped => true
    EvS2ReviewResumed => true
    EvS2ReviewRunFailed => false
    EvS2ReviewSkipped => true
    EvS2ReviewStarted => true
    EvS2Start => false
    EvS2TriageDone => true
    EvS2TriageStarted => true
    EvS3CheckClean => false
    EvS3CheckConflict => false
    EvS3Defer => false
    EvS3Ok => false
    EvS3PlanArchiveFailed => false
    EvS3PlanRefsFixed => false
    EvS3R2Done => false
    EvS3R2NotRecorded => false
    EvS3R2Recorded => false
    EvS3R2Skipped => false
    EvS3R2Started => false
    EvS3Ready => false
    EvS3Reject => false
    EvS4LandApprovalDropped => false
    EvS4LandApproved => false
    EvS4LandConflict => false
    EvS4LandHold => false
    EvS4LandMerged => false
    EvS4Merged => false
    EvS4PrCreated => false
    EvS4ReviewCommentReceived => true
    EvS4ShipFailed => false
    EvS4SubmitStarted => false
    EvS4VerifyUserJudgmentAnswered => false
    EvLaneWorktreeKept => false
    EvLaneWorktreeRetired => false
    EvQuestionBatchAnswered => false
    EvS1RecoveryAttempt => false
    EvS2PlanWritten => false
    EvS2RecoveryAttempt => false
    EvS2ReviewBaseInstructed => false
    EvS3CheckInProgress => false
    EvS3FollowupsNotWritten => false
    EvS3FollowupsWritten => false
    EvS3PlanArchived => false
    EvS4LandHeld => false
    EvS4LandRecheck => false
    EvS4PrDraftFailed => false
    EvS4PushHeld => false
    EvS4Pushed => false
    EvS4RepliesQueued => false
    EvS4Revise => false
    EvS4SubmitOpenFailed => false
    EvUnknown(_) => false
  }
}

///|
/// Whether the row only notes something on the lane: the stage reads past it.
fn is_note_event(event : DerivedEvent) -> Bool {
  match event {
    EvBlockedByDependency => false
    EvClaudeQuotaWait => false
    EvFixPlanDone => true
    EvFixPlanStarted => true
    EvShapeStarted => true
    EvShapeJudged => true
    EvLaneBudgetExtended => false
    EvLaneClose => false
    EvLaneOpen => false
    EvLaneOverBudget => false
    EvLaneStallDetected => false
    EvLaneStallInstructed => true
    EvLaneStallResumed => false
    EvLaneStalled => false
    EvLaneWaitNotified => true
    EvLaneStartSkipped => true
    EvQuestionBatchAsked => false
    EvS0RequeueGo => false
    EvS1BaseAdvanced => true
    EvS1Defer => false
    EvS1Go => false
    EvS1GranularityAnswered => false
    EvS1GranularityProposed => false
    EvS1GranularityRecorded => false
    EvS1PlanReviewDone => false
    EvS1PlanReviewSkipped => false
    EvS1PlanReviewStarted => false
    EvS1Ready => false
    EvS1ReplanRequested => false
    EvS1ReviseRequested => false
    EvS2ChecksDone => false
    EvS2ChecksStarted => false
    EvS2ConfirmDone => false
    EvS2ConfirmStarted => false
    EvS2DeviceDone => false
    EvS2DeviceSkipped => false
    EvS2DeviceStarted => false
    EvS2ExecutorWaitEnded => true
    EvS2ExecutorWaiting => false
    EvS2FixSent => false
    EvS2HandFixed => false
    EvS2IntentChecked => false
    EvS2MapDone => false
    EvS2MapDropped => false
    EvS2MapHeadMoved => false
    EvS2MapStarted => false
    EvS2OrderLimit => false
    EvS2OrderPassed => false
    EvS2OrderReleased => false
    EvS2OrderUnknown => false
    EvS2OrderWaiting => false
    EvS2RecordsConflict => false
    EvS2RecordsInstructed => false
    EvS2RecordsReopened => false
    EvS2Result => false
    EvS2ReviewBaseConflict => false
    EvS2ReviewBaseMerged => false
    EvS2ReviewBaseSkipped => false
    EvS2ReviewConverged => false
    EvS2ReviewEscalated => false
    EvS2ReviewFindings => false
    EvS2ReviewMergedSkipped => false
    EvS2ReviewResumed => false
    EvS2ReviewRunFailed => false
    EvS2ReviewSkipped => false
    EvS2ReviewStarted => false
    EvS2Start => false
    EvS2TriageDone => false
    EvS2TriageStarted => false
    EvS3CheckClean => false
    EvS3CheckConflict => false
    EvS3Defer => false
    EvS3Ok => false
    EvS3PlanArchiveFailed => false
    EvS3PlanRefsFixed => false
    EvS3R2Done => false
    EvS3R2NotRecorded => false
    EvS3R2Recorded => false
    EvS3R2Skipped => false
    EvS3R2Started => false
    EvS3Ready => false
    EvS3Reject => false
    EvS4LandApprovalDropped => false
    EvS4LandApproved => false
    EvS4LandConflict => false
    EvS4LandHold => false
    EvS4LandMerged => false
    EvS4Merged => false
    EvS4PrCreated => false
    EvS4ReviewCommentReceived => false
    EvS4ShipFailed => false
    EvS4SubmitStarted => false
    EvS4VerifyUserJudgmentAnswered => false
    EvLaneWorktreeKept => false
    EvLaneWorktreeRetired => false
    EvQuestionBatchAnswered => false
    EvS1RecoveryAttempt => false
    EvS2PlanWritten => false
    EvS2RecoveryAttempt => false
    EvS2ReviewBaseInstructed => false
    EvS3CheckInProgress => false
    EvS3FollowupsNotWritten => false
    EvS3FollowupsWritten => false
    EvS3PlanArchived => false
    EvS4LandHeld => false
    EvS4LandRecheck => false
    EvS4PrDraftFailed => false
    EvS4PushHeld => false
    EvS4Pushed => false
    EvS4RepliesQueued => false
    EvS4Revise => false
    EvS4SubmitOpenFailed => false
    EvUnknown(_) => false
  }
}
