// The landing's readings, from a lane's record alone.
//
// These four answers decide whether penne may sign an approval on the landing card, what the lane's screen
// says the landing waits on, what the tick's step may do, and which head S3 and R2 last looked at. Each of them
// is read by several callers, so the answer comes from here and nowhere else: a second reading would let the
// card offer a signature for a lane the tick refuses to merge, at the one step that cannot be taken back
// (P-4). What is not in the rows stays with the callers: the signature's key (`passkey.ts` / `pin.ts`), the
// git tree the head is compared with, and the manifest (`C-195-2`).

///|
/// The events after an approval that take it back: penne's own send-back, the harness's on a conflict, new work
/// the executor returned, and a new S3 round.
fn kills_approval(event : DerivedEvent) -> Bool {
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
    EvS2ChecksDone => false
    EvS2ChecksStarted => false
    EvS2ConfirmDone => false
    EvS2ConfirmStarted => false
    EvS2DeviceDone => false
    EvS2DeviceSkipped => false
    EvS2DeviceStarted => false
    EvS2ExecutorWaitEnded => false
    EvS2ExecutorWaiting => false
    EvS2FixSent => true
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
    EvS2Result => true
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
    EvS3Ready => true
    EvS3Reject => false
    EvS4LandApprovalDropped => true
    EvS4LandApproved => false
    EvS4LandConflict => false
    EvS4LandHold => false
    EvS4LandMerged => false
    EvS4Merged => false
    EvS4PrCreated => false
    EvS4ReviewCommentReceived => false
    EvS4ShipFailed => false
    EvS4SubmitStarted => true
    EvS4VerifyUserJudgmentAnswered => true
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
/// The close an approval recorded, or nothing when it recorded none. The fields are part of the signed content,
/// so a record without them is an approval that never covered a close.
fn approval_close(raw : Json) -> Json? {
  match raw {
    Json::Object(_) => ()
    _ => return None
  }
  let repo = text_of(field(raw, "repo"))
  let issue = js_number(field(raw, "issue"))
  let comment = text_of(field(raw, "comment"))
  if repo == "" || comment == "" {
    return None
  }
  if issue.is_nan() || issue != issue.floor() || issue.is_inf() || issue <= 0.0 {
    return None
  }
  Some(
    json_object([
      ("repo", Json::string(repo)),
      ("issue", Json::number(issue)),
      ("comment", Json::string(comment)),
      ("url", Json::string(text_of(field(raw, "url")))),
    ]),
  )
}

///|
/// The approval in force for a lane, or null: the last `s4_land_approved` while nothing after it took it back
/// and while the lane still stands at the head it approved. Only an approval whose signature was checked counts,
/// so a row without the mark is not read as one (DEC-1690). `at` is the row's place in the rows handed over, so a
/// caller looking for what came before the approval keeps looking at its own column.
fn land_approval(events : Array[DerivedRow]) -> Json {
  let at = last_event_index(events, EvS4LandApproved)
  if at < 0 {
    return Json::null()
  }
  let attrs = events[at].attrs
  if !is_signed(attrs) {
    return Json::null()
  }
  let mut i = at + 1
  while i < events.length() {
    if kills_approval(events[i].event) {
      return Json::null()
    }
    i = i + 1
  }
  let head = match non_empty_text(attrs.head) {
    Some(head) => head
    None => return Json::null()
  }
  let fields : Array[(String, Json)] = [
    ("head", Json::string(head)),
    ("at", Json::number(at.to_double())),
  ]
  match approval_close(attrs.close) {
    Some(close) => fields.push(("close", close))
    None => ()
  }
  json_object(fields)
}

///|
/// Why the approved landing has not gone in yet, read by the card: the last `s4_land_hold`'s reason, or the
/// empty string when the lane carries none.
fn land_hold(events : Array[DerivedRow]) -> String {
  let at = last_event_index(events, EvS4LandHold)
  if at < 0 {
    return ""
  }
  js_string_opt(events[at].attrs.reason, "")
}

///|
/// The head S3 and R2 last looked at, as `{commit, by}`, or null: the head the R2 of this S3 reviewed, or,
/// without one, the head the loop's last review looked at, or the head the submit was opened at. A round skipped
/// because the head was only the mainline merged in stands where a review round would, so the head it stood for
/// is read as the review's head. `by` is the words the caller's sentence puts in front of it.
fn reviewed_head(events : Array[DerivedRow]) -> Json {
  let r2 = last_event_index(events, EvS3R2Started)
  if r2 > last_event_index(events, EvS3Ready) {
    match non_empty_text(events[r2].attrs.head) {
      Some(head) => return head_answer(head, "R2 が見た")
      None => ()
    }
  }
  let review = last_event_index(events, EvS2ReviewStarted)
  let skipped = last_event_index(events, EvS2ReviewMergedSkipped)
  let reviewed = if skipped > review { skipped } else { review }
  if reviewed >= 0 {
    match non_empty_text(events[reviewed].attrs.head) {
      Some(head) => return head_answer(head, "最後のレビューが見た")
      None => ()
    }
  }
  let opened = last_event_index(events, EvS4SubmitStarted)
  if opened >= 0 {
    match non_empty_text(events[opened].attrs.head) {
      Some(head) =>
        return head_answer(head, "提出前確認を開いたときの")
      None => ()
    }
  }
  Json::null()
}

///|
/// The head that was reviewed and who looked at it, as the caller reads it.
fn head_answer(commit : String, by : String) -> Json {
  json_object([("commit", Json::string(commit)), ("by", Json::string(by))])
}
