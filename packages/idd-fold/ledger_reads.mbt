// The ledger's remaining readings: a lane's PR, its end, the worktree to retire, the PR text to draft, and the
// lanes intake leaves out.
//
// The tick's remaining stages and intake decide from these, and the decisions belong here so a screen and a pass
// read the same answer (C-205-6). What the rows do not hold is handed in as a fact: whether a lane has a
// worktree path, whether its repo has a local path, whether the worktree is still on disk, whether a repo publishes,
// whether the runner can draft PR text, whether a PR is open on the record, and whether a lane's kept record already
// says what this pass would say.

///|
/// Whether a row ends its lane for good: closed, stopped at GO, or put on hold at S3. The list intake reads.
fn ended_event(event : DerivedEvent) -> Bool {
  match event {
    EvUnknown(_) => false
    EvBlockedByDependency => false
    EvClaudeQuotaWait => false
    EvFixPlanDone => false
    EvFixPlanStarted => false
    EvShapeStarted => false
    EvShapeJudged => false
    EvLaneBudgetExtended => false
    EvLaneClose => true
    EvLaneOpen => false
    EvLaneOverBudget => false
    EvLaneStallDetected => false
    EvLaneStallInstructed => false
    EvLaneStallResumed => false
    EvLaneStalled => false
    EvLaneWaitNotified => false
    EvLaneStartSkipped => false
    EvLaneWorktreeKept => false
    EvLaneWorktreeRetired => false
    EvQuestionBatchAnswered => false
    EvQuestionBatchAsked => false
    EvS0RequeueGo => false
    EvS1BaseAdvanced => false
    EvS1Defer => true
    EvS1Go => false
    EvS1GranularityAnswered => false
    EvS1GranularityProposed => false
    EvS1GranularityRecorded => false
    EvS1PlanReviewDone => false
    EvS1PlanReviewSkipped => false
    EvS1PlanReviewStarted => false
    EvS1Ready => false
    EvS1RecoveryAttempt => false
    EvS1ReplanRequested => false
    EvS1ReviseRequested => false
    EvS2ChecksDone => false
    EvS2ChecksStarted => false
    EvS2ConfirmDone => false
    EvS2ConfirmStarted => false
    EvS2DeviceDone => false
    EvS2DeviceSkipped => false
    EvS2DeviceStarted => false
    EvS2ExecutorWaitEnded => false
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
    EvS2PlanWritten => false
    EvS2RecordsConflict => false
    EvS2RecordsInstructed => false
    EvS2RecordsReopened => false
    EvS2RecoveryAttempt => false
    EvS2Result => false
    EvS2ReviewBaseConflict => false
    EvS2ReviewBaseInstructed => false
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
    EvS3CheckInProgress => false
    EvS3Defer => true
    EvS3FollowupsNotWritten => false
    EvS3FollowupsWritten => false
    EvS3Ok => false
    EvS3PlanArchiveFailed => false
    EvS3PlanArchived => false
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
    EvS4LandHeld => false
    EvS4LandHold => false
    EvS4LandMerged => false
    EvS4LandRecheck => false
    EvS4Merged => false
    EvS4PrCreated => false
    EvS4PrDraftFailed => false
    EvS4PushHeld => false
    EvS4Pushed => false
    EvS4RepliesQueued => false
    EvS4ReviewCommentReceived => false
    EvS4Revise => false
    EvS4ShipFailed => false
    EvS4SubmitOpenFailed => false
    EvS4SubmitStarted => false
    EvS4VerifyUserJudgmentAnswered => false
  }
}

///|
/// The ends after which a lane's worktree is retired. Narrower than `ended_event`: a hold at S3 says the lane may be
/// taken up again, so its worktree stays.
fn final_end_of(event : DerivedEvent) -> Bool {
  match event {
    EvUnknown(_) => false
    EvBlockedByDependency => false
    EvClaudeQuotaWait => false
    EvFixPlanDone => false
    EvFixPlanStarted => false
    EvShapeStarted => false
    EvShapeJudged => false
    EvLaneBudgetExtended => false
    EvLaneClose => true
    EvLaneOpen => false
    EvLaneOverBudget => false
    EvLaneStallDetected => false
    EvLaneStallInstructed => false
    EvLaneStallResumed => false
    EvLaneStalled => false
    EvLaneWaitNotified => false
    EvLaneStartSkipped => false
    EvLaneWorktreeKept => false
    EvLaneWorktreeRetired => false
    EvQuestionBatchAnswered => false
    EvQuestionBatchAsked => false
    EvS0RequeueGo => false
    EvS1BaseAdvanced => false
    EvS1Defer => true
    EvS1Go => false
    EvS1GranularityAnswered => false
    EvS1GranularityProposed => false
    EvS1GranularityRecorded => false
    EvS1PlanReviewDone => false
    EvS1PlanReviewSkipped => false
    EvS1PlanReviewStarted => false
    EvS1Ready => false
    EvS1RecoveryAttempt => false
    EvS1ReplanRequested => false
    EvS1ReviseRequested => false
    EvS2ChecksDone => false
    EvS2ChecksStarted => false
    EvS2ConfirmDone => false
    EvS2ConfirmStarted => false
    EvS2DeviceDone => false
    EvS2DeviceSkipped => false
    EvS2DeviceStarted => false
    EvS2ExecutorWaitEnded => false
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
    EvS2PlanWritten => false
    EvS2RecordsConflict => false
    EvS2RecordsInstructed => false
    EvS2RecordsReopened => false
    EvS2RecoveryAttempt => false
    EvS2Result => false
    EvS2ReviewBaseConflict => false
    EvS2ReviewBaseInstructed => false
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
    EvS3CheckInProgress => false
    EvS3Defer => false
    EvS3FollowupsNotWritten => false
    EvS3FollowupsWritten => false
    EvS3Ok => false
    EvS3PlanArchiveFailed => false
    EvS3PlanArchived => false
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
    EvS4LandHeld => false
    EvS4LandHold => false
    EvS4LandMerged => false
    EvS4LandRecheck => false
    EvS4Merged => false
    EvS4PrCreated => false
    EvS4PrDraftFailed => false
    EvS4PushHeld => false
    EvS4Pushed => false
    EvS4RepliesQueued => false
    EvS4ReviewCommentReceived => false
    EvS4Revise => false
    EvS4ShipFailed => false
    EvS4SubmitOpenFailed => false
    EvS4SubmitStarted => false
    EvS4VerifyUserJudgmentAnswered => false
  }
}

///|
/// The last row of the kind the name is, or nothing.
fn read_last_of_event(
  rows : Array[DerivedRow],
  event : DerivedEvent,
) -> DerivedRow? {
  let mut found : DerivedRow? = None
  for row in rows {
    if row.event == event {
      found = Some(row)
    }
  }
  found
}

///|
/// The index of the last row of the kind the name is, or -1.
fn read_last_index_of(rows : Array[DerivedRow], event : DerivedEvent) -> Int {
  let mut found = -1
  let mut i = 0
  while i < rows.length() {
    if rows[i].event == event {
      found = i
    }
    i = i + 1
  }
  found
}

///|
/// Whether any row is the event the name is.
fn read_any_of_event(rows : Array[DerivedRow], event : DerivedEvent) -> Bool {
  for row in rows {
    if row.event == event {
      return true
    }
  }
  false
}

///|
/// `Number.isFinite`.
fn finite_number(number : Double) -> Bool {
  !number.is_nan() && !number.is_inf()
}

///|
/// The lane's PR, while the lane waits on it: the PR its last `s4_pr_created` names, when no later submit, push,
/// ship failure or result has moved the lane on. A lane whose PR was found merged at the card waits too (a fix
/// only in the records).
pub fn awaiting_merge_answer(rows : Array[DerivedRow]) -> Json {
  let created = match read_last_of_event(rows, EvS4PrCreated) {
    Some(row) => row
    None => return pr_waiting_none()
  }
  if read_any_of_event(rows, EvLaneClose) {
    return pr_waiting_none()
  }
  let since = [
    read_last_index_of(rows, EvS4SubmitStarted),
    read_last_index_of(rows, EvS4Pushed),
    read_last_index_of(rows, EvS4ShipFailed),
    read_last_index_of(rows, EvS2Result),
  ]
  let mut moved_on = 0
  for index in since {
    if index > moved_on {
      moved_on = index
    }
  }
  if read_last_index_of(rows, EvS4PrCreated) < moved_on &&
    read_last_index_of(rows, EvS4Merged) < moved_on {
    return pr_waiting_none()
  }
  // Number(attrs?.pr_number): a row without the field has no number, one that carries null has 0
  let number = if created.attrs.pr_number_present {
    js_number(created.attrs.pr_number)
  } else {
    @double.not_a_number
  }
  if !finite_number(number) {
    return pr_waiting_none()
  }
  json_object([
    ("waiting", Json::boolean(true)),
    ("prNumber", Json::number(number)),
    (
      "prUrl",
      Json::string(
        match created.attrs.pr_url {
          Json::Null => ""
          other => js_string(other)
        },
      ),
    ),
  ])
}

///|
/// The answer of a lane that does not wait on a PR.
fn pr_waiting_none() -> Json {
  json_object([("waiting", Json::boolean(false))])
}

///|
/// The lane's end, as the retire stage and the stop of a discarded lane read it: whether a final end closed the
/// lane, and whether penne took it out without its work.
pub fn lane_ends_answer(rows : Array[DerivedRow]) -> Json {
  let mut finally_end = false
  let mut discarded = false
  for row in rows {
    if final_end_of(row.event) {
      finally_end = true
    }
    if row.event == EvS1Defer {
      discarded = true
    }
    if row.event == EvLaneClose {
      match row.attrs.outcome {
        Json::String(text) =>
          if text == "aborted" || text == "dropped" || text == "redone" {
            discarded = true
          }
        _ => ()
      }
    }
  }
  json_object([
    ("finally", Json::boolean(finally_end)),
    ("discarded", Json::boolean(discarded)),
  ])
}

///|
/// Whether the pass retires this lane's worktree: an ended lane with a session's worktree, a repo that has a local
/// path and a work base, and a worktree still on disk.
pub fn retire_pick_answer(rows : Array[DerivedRow], facts : Json) -> Json {
  let mut finally_end = false
  for row in rows {
    if final_end_of(row.event) {
      finally_end = true
    }
  }
  let pick = finally_end &&
    js_truthy(field(facts, "hasWorktreePath")) &&
    js_truthy(field(facts, "hasLocalPath")) &&
    js_truthy(field(facts, "hasWorkBase")) &&
    js_truthy(field(facts, "exists"))
  json_object([("pick", Json::boolean(pick))])
}

///|
/// Whether this pass writes the kept's record: the last `lane_worktree_kept` said the same path for the same reason
/// already, and a lane held across ticks leaves one row rather than a row per tick.
pub fn retire_kept_answer(rows : Array[DerivedRow], facts : Json) -> Json {
  let last = match read_last_of_event(rows, EvLaneWorktreeKept) {
    Some(row) => row
    None => return json_object([("write", Json::boolean(true))])
  }
  let same = js_scalar_equal(last.attrs.reason, field(facts, "reason")) &&
    js_scalar_equal(last.attrs.path, field(facts, "path"))
  json_object([("write", Json::boolean(!same))])
}

///|
/// Whether the pass drafts PR text for this lane: a repo that publishes, a runner that drafts, no text drafted for
/// this submit yet, no PR open on the record, and a submit view and linked repo to write from.
pub fn pr_draft_pick_answer(rows : Array[DerivedRow], facts : Json) -> Json {
  let material = need_of("prDraftMaterial", "", "")
  let pick = js_truthy(field(facts, "publishes")) &&
    js_truthy(field(facts, "hasDraftRunner")) &&
    !js_truthy(field(facts, "hasPrDraft")) &&
    read_last_index_of(rows, EvS4PrDraftFailed) <=
    read_last_index_of(rows, EvS4SubmitStarted) &&
    !js_truthy(field(facts, "openPr"))
  if !pick {
    return json_object([("pick", Json::boolean(false))])
  }
  match fact_given(facts, material.id) {
    false => pending([material])
    true => {
      let read = fact_value(facts, material.id)
      json_object([
        (
          "pick",
          Json::boolean(
            js_truthy(field(read, "hasView")) &&
            js_truthy(field(read, "hasRepo")),
          ),
        ),
      ])
    }
  }
}

///|
/// The lanes intake leaves out because their lane ended, each with the time of its last end: the host's instant, or
/// null where the row's `at` is not a time.
pub fn closed_lanes_answer(rows : Array[DerivedRow]) -> Json {
  let closed : Map[String, Double] = Map([])
  let order : Array[String] = []
  for row in rows {
    if !ended_event(row.event) {
      continue
    }
    let at = host_date_ms(row.at)
    match closed.get(row.idd_id) {
      None => {
        closed.set(row.idd_id, at)
        order.push(row.idd_id)
      }
      Some(prev) =>
        if prev.is_nan() {
          closed.set(row.idd_id, at)
        } else if !at.is_nan() && at > prev {
          closed.set(row.idd_id, at)
        }
    }
  }
  let items : Array[Json] = []
  for id in order {
    let at = match closed.get(id) {
      Some(found) => found
      None => @double.not_a_number
    }
    items.push(
      json_object([
        ("idd", Json::string(id)),
        ("at", if at.is_nan() { Json::null() } else { Json::number(at) }),
      ]),
    )
  }
  Json::array(items)
}

///|
/// The lanes whose Issue was landed into the work side's mainline: a close that names its merge commit.
pub fn landed_lanes_answer(rows : Array[DerivedRow]) -> Json {
  let ids : Array[Json] = []
  for row in rows {
    if row.event == EvLaneClose && js_truthy(row.attrs.merged_commit) {
      ids.push(Json::string(row.idd_id))
    }
  }
  Json::array(ids)
}

///|
/// The events after which a lane no longer goes on, as intake reads them.
pub fn lane_ended_events_json() -> Json {
  Json::array([
    Json::string("lane_close"),
    Json::string("s1_defer"),
    Json::string("s3_defer"),
  ])
}

///|
/// The ends after which a lane's worktree is retired, as the storage sweep and the storage judgement read them.
pub fn final_end_events_json() -> Json {
  Json::array([Json::string("lane_close"), Json::string("s1_defer")])
}
