// Where a lane stands, from its record alone, plus the readings that decide it.
//
// This is the answer the runtime's quota overlay is put on top of: the stage a lane waits to start, the card it
// waits on, and whether anything holds it. It is derived here, and only here, because the tick's next step, the
// screen's card and the write side's refusal all read it (C-191-1). The overlay (a wait on Claude Code's windows,
// read from the runtime now) stays with the caller: it is an observation, not a record.

///|
/// The label of a prep lane whose planner owes a new ready after the review's findings.
const PLANNER_REVISING : String = "査読の指摘を反映中"

///|
/// The label of a prep lane whose planner owes penne's instruction.
const PLANNER_SENT_BACK : String = "penne の指示を反映中"

///|
/// The larger of two integers.
fn max_int(a : Int, b : Int) -> Int {
  if a > b {
    a
  } else {
    b
  }
}

///|
/// The lane groups the screen sorts lanes by.
pub(all) enum LaneGroup {
  Judge
  Prep
  Impl
  Waiting
  Closed
} derive(Eq)

///|
/// The group's own text.
fn lane_group_text(group : LaneGroup) -> String {
  match group {
    Judge => "judge"
    Prep => "prep"
    Impl => "impl"
    Waiting => "waiting"
    Closed => "closed"
  }
}

///|
/// The kind of card a lane waits on.
pub(all) enum DecisionKind {
  Duplicate
  Granularity
  Question
  Go
  Review
  Ship
  Stuck
  Requeue
} derive(Eq)

///|
/// The decision's own text.
fn decision_kind_text(decision : DecisionKind) -> String {
  match decision {
    Duplicate => "duplicate"
    Granularity => "granularity"
    Question => "question"
    Go => "go"
    Review => "review"
    Ship => "ship"
    Stuck => "stuck"
    Requeue => "requeue"
  }
}

///|
/// Where a lane stands.
pub(all) struct StageAnswer {
  group : LaneGroup
  stage_done : Int
  stage_current : Int?
  blocked_by : String?
  decision : DecisionKind?
}

///|
/// A stage as the caller reads it.
fn stage_json(stage : StageAnswer) -> Json {
  let fields : Array[(String, Json)] = [
    ("group", Json::string(lane_group_text(stage.group))),
    ("stageDone", Json::number(stage.stage_done.to_double())),
  ]
  match stage.stage_current {
    Some(current) =>
      fields.push(("stageCurrent", Json::number(current.to_double())))
    None => fields.push(("stageCurrent", Json::null()))
  }
  match stage.blocked_by {
    Some(text) => fields.push(("blockedBy", Json::string(text)))
    None => ()
  }
  match stage.decision {
    Some(decision) =>
      fields.push(("decision", Json::string(decision_kind_text(decision))))
    None => ()
  }
  json_object(fields)
}

///|
/// The last index of an event, or -1.
fn last_event_index(events : Array[DerivedRow], event : DerivedEvent) -> Int {
  let mut found = -1
  let mut i = events.length() - 1
  while i >= 0 {
    if events[i].event == event {
      found = i
      break
    }
    i = i - 1
  }
  found
}

///|
/// Whether the record holds an event at all.
fn event_ran(events : Array[DerivedRow], event : DerivedEvent) -> Bool {
  last_event_index(events, event) >= 0
}

///|
/// The first row of an event.
fn first_of(events : Array[DerivedRow], event : DerivedEvent) -> DerivedRow? {
  let mut found : DerivedRow? = None
  for e in events {
    match found {
      Some(_) => ()
      None => if e.event == event { found = Some(e) }
    }
  }
  found
}

///|
/// A lane's budget: the default, or what penne raised it to last.
fn lane_budget(events : Array[DerivedRow], base : Double) -> Double {
  let mut i = events.length() - 1
  while i >= 0 {
    if events[i].event == EvLaneBudgetExtended {
      match events[i].attrs.limit {
        Json::Number(raised, ..) => if raised > 0.0 { return raised }
        _ => ()
      }
    }
    i = i - 1
  }
  base
}

///|
/// A lane stopped for its spend and not given more budget since.
fn lane_over_budget(events : Array[DerivedRow]) -> (Double, Double)? {
  let at = last_event_index(events, EvLaneOverBudget)
  if at < 0 || at < last_event_index(events, EvLaneBudgetExtended) {
    return None
  }
  if lane_budget_idle(events) || lane_budget_idle(prefix_rows(events, at)) {
    return None
  }
  let attrs = events[at].attrs
  Some((js_num(attrs.cost), js_num(attrs.limit)))
}

///|
/// A lane that only waits starts no work that spends, so its budget is not judged.
fn lane_budget_idle(events : Array[DerivedRow]) -> Bool {
  let kept : Array[DerivedRow] = []
  for e in events {
    if e.event != EvLaneOverBudget {
      kept.push(e)
    }
  }
  let stage = progress_of(kept)
  stage.group == Waiting && stage.stage_done == 5
}

///|
/// The last halt the stall watch recorded for the lane.
fn lane_halt(events : Array[DerivedRow]) -> Json? {
  let at = last_event_index(events, EvLaneStallDetected)
  if at < 0 {
    return None
  }
  let mut since = 0
  for
    event in [
      EvLaneStallResumed,
      EvS4VerifyUserJudgmentAnswered,
      EvS3Reject,
      EvS2Result,
      EvS1Ready,
      EvS1ReplanRequested,
      EvS1ReviseRequested,
    ] {
    since = max_int(since, last_event_index(events, event))
  }
  if at < since {
    return None
  }
  let a = events[at].attrs
  let last = a.last_event
  let is_object = match last {
    Json::Object(_) => true
    _ => false
  }
  let last_event = if is_object {
    js_string_opt(field(last, "event"), events[at].at)
  } else {
    events[at].at
  }
  let last_at = if is_object {
    js_string_opt(field(last, "at"), events[at].at)
  } else {
    events[at].at
  }
  let causes : Array[Json] = []
  match a.causes {
    Json::Array(items) =>
      for item in items {
        causes.push(Json::string(js_string(item)))
      }
    _ => ()
  }
  Some(
    json_object([
      ("stage", Json::string(js_string_opt(a.stage, ""))),
      ("since", Json::string(js_string_opt(a.since, events[at].at))),
      (
        "lastEvent",
        json_object([
          ("event", Json::string(last_event)),
          ("at", Json::string(last_at)),
        ]),
      ),
      ("reason", Json::string(js_string_opt(a.reason, ""))),
      ("causes", Json::array(causes)),
      ("canSendBack", Json::boolean(js_truthy(a.can_send_back))),
    ]),
  )
}

///|
/// An executor / planner session that stopped without answering and was not resumed since.
fn lane_stall(events : Array[DerivedRow]) -> Json? {
  let at = last_event_index(events, EvLaneStalled)
  if at < 0 {
    return None
  }
  let mut since = 0
  for event in [EvS2Result, EvS1Ready, EvQuestionBatchAsked, EvLaneStallResumed] {
    since = max_int(since, last_event_index(events, event))
  }
  if at < since {
    return None
  }
  let a = events[at].attrs
  Some(
    json_object([
      ("role", Json::string(js_string_opt(a.role, "agent"))),
      ("cause", Json::string(js_string_opt(a.cause, ""))),
      ("reason", Json::string(js_string_opt(a.reason, ""))),
    ]),
  )
}

///|
/// A lane held for penne: no stage starts more work for it.
fn lane_held(events : Array[DerivedRow]) -> Bool {
  lane_over_budget(events) is Some(_) ||
  lane_stall(events) is Some(_) ||
  lane_halt(events) is Some(_)
}

///|
/// The reviews one lane start, or one send-back by penne, may run on its own: the first, and one more to check the
/// planner's fix. Past it a plan with findings left goes to penne's GO as it stands.
const PLAN_REVIEW_ROUNDS : Int = 2

///|
/// The reviews started since penne's last send-back (or since the lane began).
fn plan_review_rounds_run(events : Array[DerivedRow], sent_back : Int) -> Int {
  let mut n = 0
  let mut i = sent_back + 1
  while i < events.length() {
    if events[i].event == EvS1PlanReviewStarted {
      n = n + 1
    }
    i = i + 1
  }
  n
}

///|
/// What a finished review sent back to the planner: nothing when it failed or answered that nothing is to be fixed.
fn plan_review_actionable(attrs : RowAttrs) -> Double {
  if js_truthy(attrs.failed) {
    return 0.0
  }
  match attrs.sent_back {
    Json::False => 0.0
    Json::True => js_num(attrs.must)
    _ => js_num(attrs.must) + js_num(attrs.should)
  }
}

///|
/// Where a lane stands in the plan review.
fn plan_review_phase(events : Array[DerivedRow]) -> Json {
  let ready = last_event_index(events, EvS1Ready)
  if ready < 0 || last_event_index(events, EvS1Go) >= 0 {
    return json_object([("phase", Json::string("none"))])
  }
  // a return to the plan (the card's "計画から考え直す", or "方針へ戻す" at the review) sends the plan back the way
  // penne's revise does: the plan reviewed before it is not the one the lane now waits on
  let sent_back = max_int(
    last_event_index(events, EvS1ReviseRequested),
    last_return_to_plan(events),
  )
  if sent_back > ready {
    return json_object([("phase", Json::string("sent_back"))])
  }
  let after = fn(i : Int) -> Int { if i > sent_back { i } else { -1 } }
  let started = after(last_event_index(events, EvS1PlanReviewStarted))
  let done = after(last_event_index(events, EvS1PlanReviewDone))
  let skipped = after(last_event_index(events, EvS1PlanReviewSkipped))
  // a review nobody declared cannot be asked again, so a skip after a must stands as the review's end: the card opens
  // and the GO needs a reason (the must stays unconfirmed). Only a round started after the skip is a review to wait
  // for, running
  let fix_awaits_round = done >= 0 &&
    ready > done &&
    plan_review_actionable(events[done].attrs) > 0.0 &&
    started > skipped
  if skipped >= 0 && skipped > done && !fix_awaits_round {
    return json_object([
      ("phase", Json::string("reviewed")),
      ("failed", Json::boolean(false)),
      ("actionable", Json::number(0.0)),
    ])
  }
  if started > done {
    let a = events[started].attrs
    let run_ids : Array[Json] = []
    match a.run_ids {
      Json::Array(items) =>
        for item in items {
          let text = js_string(item)
          if text != "" {
            run_ids.push(Json::string(text))
          }
        }
      _ =>
        if js_truthy(a.run_id) {
          run_ids.push(Json::string(js_string(a.run_id)))
        }
    }
    return json_object([
      ("phase", Json::string("running")),
      ("runIds", Json::array(run_ids)),
    ])
  }
  if done < 0 {
    return json_object([("phase", Json::string("waiting"))])
  }
  let attrs = events[done].attrs
  let failed = js_truthy(attrs.failed)
  let actionable = plan_review_actionable(attrs)
  if actionable > 0.0 && ready < done {
    return json_object([("phase", Json::string("revising"))])
  }
  // the planner fixed what the review sent back: the fix is reviewed before GO, until the rounds are spent
  if actionable > 0.0 &&
    plan_review_rounds_run(events, sent_back) < PLAN_REVIEW_ROUNDS {
    return json_object([("phase", Json::string("waiting"))])
  }
  json_object([
    ("phase", Json::string("reviewed")),
    ("failed", Json::boolean(failed)),
    ("actionable", Json::number(actionable)),
  ])
}

///|
/// Whether the lane's last granularity proposal is a split / merge nobody answered.
fn granularity_waiting(events : Array[DerivedRow]) -> Bool {
  let mut proposed = -1
  let mut i = 0
  while i < events.length() {
    if events[i].event == EvS1GranularityProposed {
      proposed = i
    }
    i = i + 1
  }
  if proposed < 0 {
    return false
  }
  let kind = match granularity_kind_of(events[proposed].attrs) {
    Some(kind) => kind
    None => return false
  }
  if kind == "single" {
    return false
  }
  let mut answered = false
  let mut j = events.length() - 1
  while j > proposed {
    if events[j].event == EvS1GranularityAnswered {
      let decision = events[j].attrs.decision
      if is_text(decision, "approve") ||
        is_text(decision, "single") ||
        is_text(decision, "revise") {
        answered = true
        break
      }
    }
    j = j - 1
  }
  !answered
}

///|
/// The kind of a granularity proposal, or nothing when the record is not a usable one.
fn granularity_kind_of(attrs : RowAttrs) -> String? {
  let kind = match attrs.kind {
    Json::String(text) => text.trim().to_owned()
    _ => return None
  }
  if kind != "single" && kind != "split" && kind != "merge" {
    return None
  }
  let reason = match attrs.reason {
    Json::String(text) => text.trim().to_owned()
    _ => ""
  }
  if reason == "" {
    return None
  }
  if kind == "merge" {
    let target = attrs.merge_target
    let target_ref = match target {
      Json::Object(_) => text_of(field(target, "ref")).trim().to_owned()
      Json::String(text) => text.trim().to_owned()
      _ => ""
    }
    if target_ref == "" {
      return None
    }
    return Some(kind)
  }
  if kind == "split" {
    let children = match attrs.children {
      Json::Array(items) =>
        if items.length() == 0 {
          return None
        } else {
          items
        }
      _ => return None
    }
    for child in children {
      match child {
        Json::Object(_) => ()
        _ => return None
      }
      let title = match field(child, "title") {
        Json::String(text) => text.trim().to_owned()
        _ => ""
      }
      let whole = match field(child, "whole") {
        Json::String(text) => text.trim().to_owned()
        _ => ""
      }
      let mut places = 0
      match field(child, "places") {
        Json::Array(items) =>
          for item in items {
            match item {
              Json::String(text) => if text.trim() != "" { places = places + 1 }
              _ => ()
            }
          }
        _ => ()
      }
      if title == "" || whole == "" || places == 0 {
        return None
      }
    }
    return Some(kind)
  }
  Some(kind)
}

///|
/// The reason a stopped reading gives: the text its card carries.
fn escalated_reason(state : LoopState) -> String? {
  match state {
    LEscalated(reason, _, _) => Some(reason)
    LIdle => None
    LStartBlind(_, _, _, _) => None
    LRunningMap(_, _, _, _) => None
    LRunningBlind(_, _, _) => None
    LStartTriage(_, _, _) => None
    LRunningTriage(_, _, _) => None
    LSendFix(_) => None
    LFixing(_) => None
    LStartConfirm(_) => None
    LRunningConfirm(_, _) => None
    LStartDevice(_) => None
    LRunningDevice(_, _) => None
    LConverge => None
    LRunningChecks(_, _) => None
    LAwaitingHandFix(_) => None
    LAwaitingRecordsFix(_) => None
    LRecheckIntent(_) => None
    LAwaitingMerge(_) => None
    LAwaitingOrder(_, _) => None
    LDone => None
    LStored(stored) =>
      if raw_state(stored) is SEscalated {
        match field(stored, "reason") {
          Json::String(reason) => Some(reason)
          _ => None
        }
      } else {
        None
      }
  }
}

///|
/// Where a lane stands, from the record alone (the quota wait overlaid by the caller).
fn progress_of(events : Array[DerivedRow]) -> StageAnswer {
  let last = events.length() - 1
  if event_ran(events, EvLaneClose) {
    return {
      group: Closed,
      stage_done: 5,
      stage_current: None,
      blocked_by: None,
      decision: None,
    }
  }
  if event_ran(events, EvS1Defer) || event_ran(events, EvS3Defer) {
    return {
      group: Closed,
      stage_done: 2,
      stage_current: None,
      blocked_by: None,
      decision: None,
    }
  }
  let requeued_from = match first_of(events, EvLaneOpen) {
    Some(row) => row.attrs.requeued_from
    None => Json::null()
  }
  match lane_over_budget(events) {
    Some(budget) => {
      let stage = if event_ran(events, EvS2Start) { 2 } else { 1 }
      return {
        group: Judge,
        stage_done: stage,
        stage_current: Some(stage),
        blocked_by: Some(
          "費用が予算を超えた（$" +
          host_to_fixed2(budget.0) +
          " / $" +
          host_to_fixed2(budget.1) +
          "）",
        ),
        decision: Some(Stuck),
      }
    }
    None => ()
  }
  match lane_stall(events) {
    Some(stall) => {
      let stage = if event_ran(events, EvS2Start) { 2 } else { 1 }
      return {
        group: Judge,
        stage_done: stage,
        stage_current: Some(stage),
        blocked_by: Some(
          js_string_opt(field(stall, "role"), "") +
          " が止まった: " +
          js_string_opt(field(stall, "reason"), ""),
        ),
        decision: Some(Stuck),
      }
    }
    None => ()
  }
  match lane_halt(events) {
    Some(halt) => {
      let stage = if event_ran(events, EvS2Start) { 2 } else { 1 }
      return {
        group: Judge,
        stage_done: stage,
        stage_current: Some(stage),
        blocked_by: Some(
          "engine が進められない: " +
          js_string_opt(field(halt, "reason"), ""),
        ),
        decision: Some(Stuck),
      }
    }
    None => ()
  }
  if js_truthy(requeued_from) && !event_ran(events, EvS0RequeueGo) {
    return {
      group: Judge,
      stage_done: 0,
      stage_current: Some(0),
      blocked_by: Some(js_string(requeued_from) + " の取り込み直し"),
      decision: Some(Requeue),
    }
  }
  let latest = fn(event : DerivedEvent) -> Int {
    last_event_index(events, event)
  }
  if latest(EvS4Merged) > max_int(latest(EvS4SubmitStarted), latest(EvS2Result)) {
    return {
      group: Waiting,
      stage_done: 5,
      stage_current: Some(5),
      blocked_by: Some("本流の受け入れ・記録回収"),
      decision: None,
    }
  }
  if latest(EvS4VerifyUserJudgmentAnswered) >
    max_int(latest(EvS2Result), latest(EvS4SubmitStarted)) {
    return {
      group: Impl,
      stage_done: 2,
      stage_current: Some(2),
      blocked_by: None,
      decision: None,
    }
  }
  if event_ran(events, EvS2Start) {
    let reading = review_loop_state(events)
    if loop_state_name(reading) == "escalated" {
      return {
        group: Judge,
        stage_done: 2,
        stage_current: Some(2),
        blocked_by: escalated_reason(reading),
        decision: Some(Stuck),
      }
    }
    if loop_state_name(reading) == "awaiting_hand_fix" {
      return {
        group: Judge,
        stage_done: 2,
        stage_current: Some(2),
        blocked_by: Some("人の手番（自分で直す）"),
        decision: Some(Stuck),
      }
    }
    if loop_state_name(reading) == "awaiting_order" {
      return {
        group: Waiting,
        stage_done: 2,
        stage_current: Some(2),
        blocked_by: review_loop_label(reading, None),
        decision: None,
      }
    }
    let name = loop_state_name(reading)
    if name != "idle" && name != "done" {
      return {
        group: Impl,
        stage_done: 2,
        stage_current: Some(2),
        blocked_by: review_loop_label(reading, None),
        decision: None,
      }
    }
  }
  if is_loop_lane(events) &&
    latest(EvS3Ready) > max_int(latest(EvS3Ok), latest(EvS4SubmitStarted)) {
    let r2 = latest(EvS3R2Started) > latest(EvS3Ready) &&
      max_int(latest(EvS3R2Done), latest(EvS3R2Skipped)) < latest(EvS3R2Started)
    return {
      group: Impl,
      stage_done: 3,
      stage_current: Some(3),
      blocked_by: Some(if r2 { "R2 中" } else { "提出の準備中" }),
      decision: None,
    }
  }
  let new_work = if is_loop_lane(events) {
    max_int(latest(EvS4VerifyUserJudgmentAnswered), latest(EvS2FixSent))
  } else {
    latest(EvS2Result)
  }
  if event_ran(events, EvS4PrCreated) &&
    latest(EvS4PrCreated) >
    max_int(
      max_int(latest(EvS4SubmitStarted), latest(EvS4ShipFailed)),
      max_int(new_work, latest(EvS3Ready)),
    ) {
    let pr = events[latest(EvS4PrCreated)].attrs.pr_number
    return {
      group: Waiting,
      stage_done: 5,
      stage_current: None,
      blocked_by: Some(
        if js_truthy(pr) {
          "PR #" + js_string(pr)
        } else {
          "PR"
        },
      ),
      decision: None,
    }
  }
  if last >= 0 && events[last].event == EvBlockedByDependency {
    let dep = events[last].attrs.depends_on
    let blocked_by = match dep {
      Json::Array(items) =>
        if items.length() > 0 {
          Some(js_string(items[0]))
        } else {
          None
        }
      _ => None
    }
    return {
      group: Waiting,
      stage_done: 2,
      stage_current: Some(2),
      blocked_by,
      decision: None,
    }
  }
  if latest(EvS3Ready) > latest(EvS4SubmitStarted) &&
    latest(EvS3Ok) < latest(EvS3Ready) {
    return {
      group: Judge,
      stage_done: 3,
      stage_current: Some(3),
      blocked_by: None,
      decision: Some(Review),
    }
  }
  if event_ran(events, EvS4SubmitStarted) &&
    latest(EvS4SubmitStarted) >
    max_int(max_int(latest(EvS2Result), latest(EvS2FixSent)), latest(EvS3Ready)) {
    return {
      group: Judge,
      stage_done: 4,
      stage_current: Some(4),
      blocked_by: None,
      decision: Some(Ship),
    }
  }
  if event_ran(events, EvS3Ready) {
    if !event_ran(events, EvS3Ok) {
      return {
        group: Judge,
        stage_done: 3,
        stage_current: Some(3),
        blocked_by: None,
        decision: Some(Review),
      }
    }
    return {
      group: Impl,
      stage_done: 4,
      stage_current: Some(4),
      blocked_by: None,
      decision: None,
    }
  }
  if event_ran(events, EvS2Start) {
    let reading = review_loop_state(events)
    if loop_state_name(reading) == "escalated" {
      return {
        group: Judge,
        stage_done: 2,
        stage_current: Some(2),
        blocked_by: escalated_reason(reading),
        decision: Some(Stuck),
      }
    }
    if loop_state_name(reading) == "awaiting_hand_fix" {
      return {
        group: Judge,
        stage_done: 2,
        stage_current: Some(2),
        blocked_by: Some("人の手番（自分で直す）"),
        decision: Some(Stuck),
      }
    }
    return {
      group: Impl,
      stage_done: 2,
      stage_current: Some(2),
      blocked_by: review_loop_label(reading, None),
      decision: None,
    }
  }
  if event_ran(events, EvS1Go) {
    return {
      group: Impl,
      stage_done: 2,
      stage_current: Some(2),
      blocked_by: None,
      decision: None,
    }
  }
  if granularity_waiting(events) {
    return {
      group: Judge,
      stage_done: 1,
      stage_current: Some(1),
      blocked_by: None,
      decision: Some(Granularity),
    }
  }
  if event_ran(events, EvS1Ready) {
    let review = plan_review_phase(events)
    let phase = text_of(field(review, "phase"))
    if phase == "waiting" {
      return {
        group: Prep,
        stage_done: 1,
        stage_current: Some(1),
        blocked_by: Some("plan 査読待ち"),
        decision: None,
      }
    }
    if phase == "running" {
      return {
        group: Prep,
        stage_done: 1,
        stage_current: Some(1),
        blocked_by: Some("plan 査読中"),
        decision: None,
      }
    }
    if phase == "revising" {
      return {
        group: Prep,
        stage_done: 1,
        stage_current: Some(1),
        blocked_by: Some(PLANNER_REVISING),
        decision: None,
      }
    }
    if phase == "sent_back" {
      return {
        group: Prep,
        stage_done: 1,
        stage_current: Some(1),
        blocked_by: Some(PLANNER_SENT_BACK),
        decision: None,
      }
    }
    return {
      group: Judge,
      stage_done: 2,
      stage_current: None,
      blocked_by: None,
      decision: Some(Go),
    }
  }
  // The question gate is open while a batch asked since the planner was last handed work has no answer: the same
  // boundary rule `awaiting_question` uses, written here without reading the stage (C-274-1).
  if oldest_unanswered(events, last_planner_work(events, planner_work())) >= 0 {
    return {
      group: Judge,
      stage_done: 1,
      stage_current: Some(1),
      blocked_by: None,
      decision: Some(Question),
    }
  }
  if event_ran(events, EvLaneOpen) {
    return {
      group: Prep,
      stage_done: 1,
      stage_current: Some(1),
      blocked_by: None,
      decision: None,
    }
  }
  {
    group: Prep,
    stage_done: 0,
    stage_current: Some(0),
    blocked_by: None,
    decision: None,
  }
}

///|
/// Whether any row ends the lane.
fn lane_has_ended(events : Array[DerivedRow]) -> Bool {
  event_ran(events, EvLaneClose) ||
  event_ran(events, EvS1Defer) ||
  event_ran(events, EvS3Defer)
}

///|
/// Whether the lane's work landed in the work side's mainline.
fn lane_landed(events : Array[DerivedRow]) -> Bool {
  let mut landed = false
  for e in events {
    if e.event == EvS4LandMerged || e.event == EvS4Merged {
      landed = true
    }
    if e.event == EvLaneClose && js_truthy(e.attrs.merged_commit) {
      landed = true
    }
  }
  landed
}
