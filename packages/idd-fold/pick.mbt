// The stages' answer to "do you pick this lane up?".
//
// Each stage of the tick reads the ledger and asks whether the lane is its business now. The answer decides what
// the engine moves, so it is folded here, once, and the TypeScript reading stays off the running path (C-199-1).
// Every stage asks its own question, at the moment it asks it: a table read at the start of a pass would answer
// for a moment the tick has already left (C-199-2).
//
// What the ledger does not hold is handed in as a fact: whether a session exists, whether the repo publishes,
// what the worktree's head is, what the lane has spent, how deep the lane is, and the readings of the outside
// world (C-199-3). The judgement reads the rows and those facts only, so the same ledger and the same facts always
// give the same answer.

///|
/// The stages that ask whether they pick a lane up.
pub(all) enum PickStage {
  Planner
  Executor
  Check
  SubmitPrep
  SubmitPush
  Land
  LandLedger
  LandCarry
  LandCarryLedger
  AutoGo
  Budget
  Blocker
  PrFeedback
  Watch
  Stall
}

///|
/// The stage a caller names, or nothing when it names a stage nobody knows.
fn pick_stage_of(name : String) -> PickStage? {
  match name {
    "prep" => Some(Planner)
    "exec" => Some(Executor)
    "check" => Some(Check)
    "submit_prep" => Some(SubmitPrep)
    "submit_push" => Some(SubmitPush)
    "land" => Some(Land)
    "land_ledger" => Some(LandLedger)
    "land_carry" => Some(LandCarry)
    "land_carry_ledger" => Some(LandCarryLedger)
    "auto_go" => Some(AutoGo)
    "budget" => Some(Budget)
    "blocker" => Some(Blocker)
    "pr_feedback" => Some(PrFeedback)
    "watch" => Some(Watch)
    "stall" => Some(Stall)
    _ => None
  }
}

///|
/// The answer of a stage: whether it picks the lane up, and why it leaves it when it does not.
pub(all) struct PickAnswer {
  pick : Bool
  reason : String?
  branch : String?
}

///|
/// The answer that picks the lane up.
fn picked() -> PickAnswer {
  { pick: true, reason: None, branch: None, }
}

///|
/// The answer that leaves the lane, and the reason it says on the card.
fn left(reason : String) -> PickAnswer {
  { pick: false, reason: Some(reason), branch: None, }
}

///|
/// The answer that picks the lane up, with the step the stage takes.
fn picked_with(branch : String) -> PickAnswer {
  { pick: true, reason: None, branch: Some(branch), }
}

///|
/// The answer, as the caller reads it.
fn pick_answer_json(answer : PickAnswer) -> Json {
  let fields : Array[(String, Json)] = [("pick", Json::boolean(answer.pick))]
  match answer.reason {
    Some(reason) => fields.push(("reason", Json::string(reason)))
    None => ()
  }
  match answer.branch {
    Some(branch) => fields.push(("branch", Json::string(branch)))
    None => ()
  }
  json_object(fields)
}

///|
/// Whether a place is the root, or a dir's own place (a module with no file mark): the outside a lane must not
/// move alone.
fn is_root_or_dir_place(place : Json) -> Bool {
  let kind = text_of(field(place, "kind"))
  if kind == "root" || kind == "dir" {
    return true
  }
  kind == "module" && !has_key(place, "file")
}

///|
/// Whether the choice the id names has a root or dir place among its places.
fn choice_is_root_or_dir(choices : Json, id : String) -> Bool {
  for choice in array_of(choices) {
    if text_of(field(choice, "id")) != id {
      continue
    }
    for place in array_of(field(choice, "places")) {
      if is_root_or_dir_place(place) {
        return true
      }
    }
  }
  false
}

///|
/// Whether the lane's own rows supersede a choice that has a root or dir place.
fn lane_supersedes_root(facts : Json) -> Bool {
  let choices = field(facts, "choices")
  for row in array_of(field(facts, "laneRows")) {
    for id in strings_of(field(row, "supersedes")) {
      if choice_is_root_or_dir(choices, id) {
        return true
      }
    }
  }
  false
}

///|
/// Whether the plan the lane shows now has a draft that supersedes a choice that has a root or dir place.
fn draft_supersedes_root(events : Array[DerivedRow], facts : Json) -> Bool {
  let choices = field(facts, "choices")
  let mut ready : DerivedRow? = None
  for row in events {
    if row.event == EvS1Ready {
      ready = Some(row)
    }
  }
  let records = match ready {
    Some(row) => row.attrs.plan_records
    None => Json::null()
  }
  for draft in array_of(field(records, "choices")) {
    let supersedes = field(draft, "supersedes")
    for id in strings_of(field(supersedes, "ids")) {
      if choice_is_root_or_dir(choices, id) {
        return true
      }
    }
  }
  false
}

///|
/// Whether the plan the lane shows now has a review that finished without failing.
fn current_plan_reviewed(events : Array[DerivedRow]) -> Bool {
  let mut last_ready = -1
  let mut i = 0
  while i < events.length() {
    if events[i].event == EvS1Ready {
      last_ready = i
    }
    i = i + 1
  }
  if last_ready < 0 {
    return false
  }
  let mut j = last_ready + 1
  while j < events.length() {
    if events[j].event == EvS1PlanReviewDone &&
      !js_truthy(events[j].attrs.failed) {
      return true
    }
    j = j + 1
  }
  false
}

///|
/// The planner's start: a lane in the prep stage whose planner owes a new ready.
fn pick_planner(
  events : Array[DerivedRow],
  facts : Json,
  quota : QuotaFact,
) -> PickAnswer {
  if js_truthy(field(facts, "hasSession")) {
    return left("planner の session がある")
  }
  let stage = stage_with_quota(events, quota)
  if stage.group != Prep {
    return left("段が prep ではない")
  }
  if stage.decision is Some(_) {
    return left("card が上がっている")
  }
  picked()
}

///|
/// The executor's start: a lane in the impl stage whose executor has not started yet.
fn pick_executor(
  events : Array[DerivedRow],
  facts : Json,
  quota : QuotaFact,
) -> PickAnswer {
  if js_truthy(field(facts, "hasSession")) {
    return left("executor の session がある")
  }
  if stage_with_quota(events, quota).group != Impl {
    return left("段が impl ではない")
  }
  picked()
}

///|
/// The S3 check: a lane whose review loop is done and whose S3 has not run yet.
fn pick_check(
  events : Array[DerivedRow],
  _facts : Json,
  _quota : QuotaFact,
) -> PickAnswer {
  if last_event_index(events, EvS2Result) <= last_event_index(events, EvS3Ready) {
    return left("S2 の結果が S3 の準備より前")
  }
  if loop_state_name(review_loop_state(events)) != "done" {
    return left("レビューが収束していない")
  }
  if lane_held(events) {
    return left("保留されている")
  }
  picked()
}

///|
/// The submit's preparation: a loop lane whose S3 is ready and whose submit has not started yet.
fn pick_submit_prep(
  events : Array[DerivedRow],
  _facts : Json,
  quota : QuotaFact,
) -> PickAnswer {
  let stage = stage_with_quota(events, quota)
  if stage.group == Impl && stage.stage_done == 4 {
    return picked_with("reopen")
  }
  if !is_loop_lane(events) {
    return left("ループの lane ではない")
  }
  if lane_held(events) {
    return left("保留されている")
  }
  if event_ran(events, EvLaneClose) ||
    event_ran(events, EvS1Defer) ||
    event_ran(events, EvS3Defer) {
    return left("lane が閉じている")
  }
  if loop_state_name(review_loop_state(events)) != "done" {
    return left("レビューが収束していない")
  }
  let ready = last_event_index(events, EvS3Ready)
  if ready < 0 {
    return left("S3 の準備がまだない")
  }
  let ok = last_event_index(events, EvS3Ok)
  let started = last_event_index(events, EvS4SubmitStarted)
  let latest = if ok > started { ok } else { started }
  if ready < latest {
    return left("S3 はもう始まっている")
  }
  if last_event_index(events, EvS4VerifyUserJudgmentAnswered) > ready {
    return left("差し戻しの返答を待っている")
  }
  picked_with("prepare")
}

///|
/// The push's preparation: a lane at the submit card of a repo that publishes.
fn pick_submit_push(
  events : Array[DerivedRow],
  facts : Json,
  quota : QuotaFact,
) -> PickAnswer {
  if !js_truthy(field(facts, "publishes")) {
    return left("公開しない repo")
  }
  if lane_held(events) {
    return left("保留されている")
  }
  if stage_with_quota(events, quota).decision != Some(Ship) {
    return left("提出前確認の段にない")
  }
  if has_key(facts, "hasWorktree") && !js_truthy(field(facts, "hasWorktree")) {
    return left("worktree がない")
  }
  if has_key(facts, "hasHead") && !js_truthy(field(facts, "hasHead")) {
    return left("head がない")
  }
  picked()
}

///|
/// The landing's check: a lane at the submit card of a repo that does not publish.
fn pick_land(
  events : Array[DerivedRow],
  facts : Json,
  quota : QuotaFact,
) -> PickAnswer {
  if lane_held(events) {
    return left("保留されている")
  }
  if event_ran(events, EvLaneClose) {
    return left("lane が閉じている")
  }
  if !js_truthy(field(facts, "hasLocation")) {
    return left("置き場所がない")
  }
  if js_truthy(field(facts, "publishes")) {
    return left("公開する repo は push を通す")
  }
  if !is_null(land_approval(events)) {
    return left("署名済みの承認がある")
  }
  if stage_with_quota(events, quota).decision != Some(Ship) {
    return left("提出前確認の段にない")
  }
  picked()
}

///|
/// The landing's own question read from the ledger alone: a held lane, a closed lane, a lane whose signature
/// is still in force (it belongs to the carried approvals) and a lane not at the submit confirmation are left
/// before the caller reads where the lane lives (C-202-5).
fn pick_land_ledger(
  events : Array[DerivedRow],
  quota : QuotaFact,
) -> PickAnswer {
  if lane_held(events) {
    return left("保留されている")
  }
  if event_ran(events, EvLaneClose) {
    return left("lane が閉じている")
  }
  if !is_null(land_approval(events)) {
    return left("署名済みの承認がある")
  }
  if stage_with_quota(events, quota).decision != Some(Ship) {
    return left("提出前確認の段にない")
  }
  picked()
}

///|
/// The landing's carried approval: a lane of a repo that does not publish, whose signature is still in force.
fn pick_land_carry(
  events : Array[DerivedRow],
  facts : Json,
  _quota : QuotaFact,
) -> PickAnswer {
  if lane_held(events) {
    return left("保留されている")
  }
  if event_ran(events, EvLaneClose) {
    return left("lane が閉じている")
  }
  if !js_truthy(field(facts, "hasLocation")) {
    return left("置き場所がない")
  }
  if js_truthy(field(facts, "publishes")) {
    return left("公開する repo は push を通す")
  }
  if is_null(land_approval(events)) {
    return left("署名済みの承認がない")
  }
  picked()
}

///|
/// The landing's carried approval, read from the ledger alone: a held lane, a closed lane and a lane with no
/// signature in force are left before the caller reads where the lane lives. That reading touches a file per
/// lane, and a lane this stage would leave anyway has no reason to cost one (C-202-5).
fn pick_land_carry_ledger(events : Array[DerivedRow]) -> PickAnswer {
  if lane_held(events) {
    return left("保留されている")
  }
  if event_ran(events, EvLaneClose) {
    return left("lane が閉じている")
  }
  if is_null(land_approval(events)) {
    return left("署名済みの承認がない")
  }
  picked()
}

///|
/// The automatic GO: a shallow lane at the GO card whose plan may be moved on its own.
fn pick_auto_go(
  events : Array[DerivedRow],
  facts : Json,
  quota : QuotaFact,
) -> PickAnswer {
  if event_ran(events, EvS1Go) ||
    event_ran(events, EvLaneClose) ||
    event_ran(events, EvS1Defer) {
    return left("GO の記録がある")
  }
  if stage_with_quota(events, quota).decision != Some(Go) {
    return left("GO 待ちの lane ではない")
  }
  if js_truthy(field(facts, "blocked")) {
    return left("blocker が着地するまで GO できない")
  }
  let depth = text_of(field(facts, "depth"))
  if depth != "shallow" {
    return left("深さが浅くないので、GO は人が押す")
  }
  if event_ran(events, EvQuestionBatchAsked) {
    return left("計画役が計画の間に質問を出した")
  }
  let lane = text_of(field(facts, "lane"))
  for purpose in array_of(field(facts, "purposes")) {
    if text_of(field(purpose, "status")) == "proposed" &&
      text_of(field(purpose, "raisedBy")) == lane {
      return left(
        "この lane が立てた未確認の Purpose の案がある",
      )
    }
    // a withdrawal sends the plan back in the same press; one still on the GO stage means that send-back did not
    // write, and after the planner reports again the person reads the plan that answers the withdrawal
    if text_of(field(purpose, "status")) == "withdrawn" &&
      text_of(field(purpose, "raisedBy")) == lane {
      return left(
        "取り下げた Purpose の案がある（GO は人が押す）",
      )
    }
  }
  if lane_supersedes_root(facts) {
    return left("root か dir の Choice を Supersede する案がある")
  }
  if draft_supersedes_root(events, facts) {
    return left("root か dir の Choice を Supersede する案がある")
  }
  if !current_plan_reviewed(events) {
    return left("いまの計画の査読が済んでいない")
  }
  picked()
}

///|
/// The budget's stop: a lane that spends more than its budget.
fn pick_budget(
  events : Array[DerivedRow],
  facts : Json,
  quota : QuotaFact,
) -> PickAnswer {
  let stage = stage_with_quota(events, quota)
  if stage.group == Closed {
    return left("lane が閉じている")
  }
  if stage.decision == Some(Stuck) {
    return left("止まっている")
  }
  if lane_budget_idle(events) {
    return left("待つだけの lane")
  }
  let cost = js_num(field(facts, "cost"))
  let limit = lane_budget(events, js_num(field(facts, "base")))
  if cost <= limit {
    return left("予算之内")
  }
  picked()
}

///|
/// The blocker's wait: a lane whose executor returned, or that waits on a dependency, or that waits at the GO.
fn pick_blocker(
  events : Array[DerivedRow],
  facts : Json,
  quota : QuotaFact,
) -> PickAnswer {
  if events.length() == 0 {
    return left("記録がない")
  }
  if lane_has_ended(events) {
    return left("lane が終わっている")
  }
  let rows = without_note_rows(events)
  // a lane whose rows are all notes has no last word to read: the TypeScript's `undefined` is written here as
  // nothing, so the answer is the same on both sides (C-201-3)
  let last : DerivedRow? = if rows.length() == 0 {
    None
  } else {
    Some(rows[rows.length() - 1])
  }
  match last {
    Some(row) => {
      if is_returned_result(row) {
        return picked()
      }
      if row.event == EvBlockedByDependency {
        return picked()
      }
    }
    None => ()
  }
  if js_truthy(field(facts, "hasBlockers")) &&
    stage_with_quota(events, quota).decision == Some(Go) {
    return picked()
  }
  left("blocker を待つ lane ではない")
}

///|
/// The PR's feedback: a lane waiting on its PR whose last batch of replies is done with.
fn pick_pr_feedback(
  events : Array[DerivedRow],
  facts : Json,
  quota : QuotaFact,
) -> PickAnswer {
  if event_ran(events, EvLaneClose) || event_ran(events, EvS3Defer) {
    return left("lane が閉じている")
  }
  if lane_held(events) {
    return left("保留されている")
  }
  let stage = stage_with_quota(events, quota)
  if stage.group != Waiting ||
    stage.stage_done != 5 ||
    stage.stage_current is Some(_) {
    return left("PR を待つ段ではない")
  }
  if last_event_index(events, EvS4PrCreated) < 0 {
    return left("PR がない")
  }
  if has_key(facts, "lastBatchAnswered") &&
    !js_truthy(field(facts, "lastBatchAnswered")) {
    return left("前の指摘への返信がまだ終わっていない")
  }
  picked()
}

///|
/// The watch's resume: a lane waiting on an agent whose session stopped.
fn pick_watch(
  events : Array[DerivedRow],
  facts : Json,
  quota : QuotaFact,
) -> PickAnswer {
  let stage = stage_with_quota(events, quota)
  if stage.group == Closed {
    return left("lane が閉じている")
  }
  if stage.decision == Some(Stuck) {
    return left("止まっている")
  }
  let awaited = text_of(field(facts, "awaitedRole"))
  if awaited == "" {
    return left("待っている agent がない")
  }
  if js_truthy(field(facts, "pendingFixEnvelope")) {
    return left("修正の封筒がまだ配ってない")
  }
  let role = text_of(field(facts, "targetRole"))
  if role == "" {
    return left("起こす session がない")
  }
  if role != awaited {
    return left("起こす session の役が待ちの役と違う")
  }
  picked()
}

///|
/// The stall watch: a lane on the engine's turn that stood on the same step too long.
fn pick_stall(
  events : Array[DerivedRow],
  facts : Json,
  quota : QuotaFact,
) -> PickAnswer {
  if events.length() == 0 {
    return left("記録がない")
  }
  let stage = stage_with_quota(events, quota)
  if stage.group == Closed {
    return left("lane が閉じている")
  }
  if js_truthy(field(facts, "reloadHold")) && stage.group == Prep {
    return left("入れ替えの待ち")
  }
  if lane_held(events) {
    return left("保留されている")
  }
  let turn_facts : TurnFacts = {
    awaited_agent: field(facts, "awaitedAgent"),
    pending_envelope: js_truthy(field(facts, "pendingEnvelope")),
    card_buildable: match field(facts, "cardBuildable") {
      Json::True => Some(true)
      Json::False => Some(false)
      _ => None
    },
    quota,
  }
  if lane_turn_text(events, turn_facts) != Some("engine") {
    return left("engine の番ではない")
  }
  if js_truthy(field(facts, "waitingSlot")) {
    return left("枠待ち")
  }
  let rows = without_note_rows(events)
  // a lane whose rows are all notes has no last word to read: the TypeScript's `undefined` is written here as
  // nothing, so the answer is the same on both sides (C-201-3)
  let last : DerivedRow? = if rows.length() == 0 {
    None
  } else {
    Some(rows[rows.length() - 1])
  }
  if quota_hold_of(last, quota).0 {
    return left("Claude の枠待ち")
  }
  if js_truthy(field(facts, "worktreeBusy")) {
    return left("worktree が動いている")
  }
  picked()
}

///|
/// The answer of the stage a caller names, or nothing when it names a stage nobody knows.
fn pick_of(
  stage : PickStage,
  events : Array[DerivedRow],
  facts : Json,
  quota : QuotaFact,
) -> PickAnswer {
  match stage {
    Planner => pick_planner(events, facts, quota)
    Executor => pick_executor(events, facts, quota)
    Check => pick_check(events, facts, quota)
    SubmitPrep => pick_submit_prep(events, facts, quota)
    SubmitPush => pick_submit_push(events, facts, quota)
    Land => pick_land(events, facts, quota)
    LandLedger => pick_land_ledger(events, quota)
    LandCarry => pick_land_carry(events, facts, quota)
    LandCarryLedger => pick_land_carry_ledger(events)
    AutoGo => pick_auto_go(events, facts, quota)
    Budget => pick_budget(events, facts, quota)
    Blocker => pick_blocker(events, facts, quota)
    PrFeedback => pick_pr_feedback(events, facts, quota)
    Watch => pick_watch(events, facts, quota)
    Stall => pick_stall(events, facts, quota)
  }
}

///|
/// The lanes whose signature is still in force, in the order the ledger records it: the last approval of each
/// lane, in the order the approvals were written.
fn land_order(events : Array[DerivedRow]) -> Array[String] {
  let seen : Map[String, Bool] = Map([])
  let order : Array[String] = []
  let mut i = events.length() - 1
  while i >= 0 {
    let row = events[i]
    if row.event == EvS4LandApproved && seen.get(row.idd_id) is None {
      seen.set(row.idd_id, true)
      order.push(row.idd_id)
    }
    i = i - 1
  }
  let out : Array[String] = []
  let mut j = order.length() - 1
  while j >= 0 {
    out.push(order[j])
    j = j - 1
  }
  out
}
