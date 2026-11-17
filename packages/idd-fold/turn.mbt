// The lane's turn and the waits around it.
//
// A lane's turn answers "whose move is it", and the waits answer "what is it waiting for, and since when".
// The tick reads them to choose the lane to move, the card reads them to show whose move it is, and the write
// side reads them to refuse a step the lane may not take. So the reading is folded here, once, and the
// TypeScript reading stays off the running path (C-199-1).
//
// What the record cannot answer is handed in: the runtime's reading of Claude Code's windows, whether an
// envelope waits for the lane, and whether the lane's ship card can be built. The judgement reads the rows and
// those facts only, so the same ledger and the same facts always give the same answer (C-199-3).

///|
/// The runtime's reading of Claude Code's windows.
pub(all) enum QuotaReading {
  /// no wait is put on top: the stage is the record's own answer
  NoOverlay
  /// the record alone decides
  Record
  /// the windows let a lane start now
  Free
  /// the windows hold a lane; the reset and the reason are the reading's
  Busy(Double?, String)
  /// the reading could not be made
  Unknown
}

///|
/// The quota reading and the clock it was read at.
pub(all) struct QuotaFact {
  reading : QuotaReading
  now_ms : Double
}

///|
/// The facts a lane's turn needs that the record does not hold.
pub(all) struct TurnFacts {
  /// what the watch's reading answered for the lane: the role it waits on, or nothing
  awaited_agent : Json
  /// an envelope is queued for the lane and not delivered
  pending_envelope : Bool
  /// the lane's ship card can be built; nothing when the card is not the ship card
  card_buildable : Bool?
  /// the runtime's reading of the windows
  quota : QuotaFact
}

///|
/// The ISO time of a UNIX second count, as the host reads it.
extern "js" fn host_iso_of_unix(seconds : Double) -> String = "(s) => new Date(s * 1000).toISOString()"

///|
/// The minute a reset falls on, in JST, as the host reads it.
extern "js" fn host_jst_minute(iso : String) -> String = "(iso) => new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')"

///|
/// The review loop's states that mean a run or a fix is working for the lane now.
fn is_agent_loop_state(name : String) -> Bool {
  match name {
    "running_map" => true
    "running_blind" => true
    "running_triage" => true
    "running_confirm" => true
    "running_device" => true
    "running_checks" => true
    "fixing" => true
    "awaiting_merge" => true
    _ => false
  }
}

///|
/// Whether a value is the null the boundary gives a field the row does not carry.
fn is_null(value : Json) -> Bool {
  match value {
    Json::Null => true
    _ => false
  }
}

///|
/// The row's own time, as the record wrote it: a row without a time reads as none.
fn row_at_text(row : DerivedRow) -> String {
  if row.at == "null" {
    ""
  } else {
    row.at
  }
}

///|
/// The wait for Claude Code's windows a lane's last word is: whether it still holds, and the reset the
/// display reads.
fn quota_hold_of(last : DerivedRow?, quota : QuotaFact) -> (Bool, String?) {
  match last {
    None => (false, None)
    Some(row) =>
      if row.event != EvClaudeQuotaWait {
        (false, None)
      } else {
        let own = match row.attrs.resets_at {
          Json::Number(number, ..) => Some(host_iso_of_unix(number))
          _ => None
        }
        match quota.reading {
          NoOverlay => (false, None)
          Record => (true, own)
          Free => (false, None)
          Busy(resets_at, _) =>
            match resets_at {
              Some(seconds) => (true, Some(host_iso_of_unix(seconds)))
              None => (true, None)
            }
          Unknown => {
            let passed = match row.attrs.resets_at {
              Json::Number(number, ..) => number * 1000.0 <= quota.now_ms
              _ => false
            }
            (!passed, own)
          }
        }
      }
  }
}

///|
/// The lane's stage, with the runtime's wait for Claude Code's windows put on top. The wait is an observation
/// and not a record, so it comes in as a fact and the record's own answer is what it is put on top of.
fn stage_with_quota(
  events : Array[DerivedRow],
  quota : QuotaFact,
) -> StageAnswer {
  let rows = without_note_rows(events)
  let stage = progress_of(rows)
  if rows.length() == 0 {
    return stage
  }
  let last = rows[rows.length() - 1]
  if last.event != EvClaudeQuotaWait {
    return stage
  }
  if stage.decision is Some(_) {
    return stage
  }
  if stage.group != Prep && stage.group != Impl {
    return stage
  }
  if stage.blocked_by == Some(PLANNER_REVISING) ||
    stage.blocked_by == Some(PLANNER_SENT_BACK) {
    return stage
  }
  let hold = quota_hold_of(Some(last), quota)
  if !hold.0 {
    return stage
  }
  let when = match hold.1 {
    Some(reset) => "、リセット " + host_jst_minute(reset) + " JST"
    None => ""
  }
  {
    group: stage.group,
    stage_done: stage.stage_done,
    stage_current: stage.stage_current,
    blocked_by: Some(
      "Claude の枠待ち（" +
      js_string_opt(last.attrs.stage, "") +
      when +
      "）",
    ),
    decision: stage.decision,
  }
}

///|
/// Whether the answer row answers the question row. A question that carries no id needs any answer after it,
/// and a question that carries one needs an answer that carries the same one. A question whose id is null is
/// an id of its own: an answer that carries no id does not answer it (C-201-4).
fn batch_answers(asked : RowAttrs, answered : RowAttrs) -> Bool {
  if !asked.batch_id_present {
    return true
  }
  answered.batch_id_present &&
  js_scalar_equal(answered.batch_id, asked.batch_id)
}

///|
/// The index of the oldest batch asked after `since` that penne has not answered, or -1. A batch is matched by
/// its id, so an answer to one batch never counts for another; a batch that carries no id needs any answer
/// after it.
fn oldest_unanswered(events : Array[DerivedRow], since : Int) -> Int {
  let mut i = if since + 1 > 0 { since + 1 } else { 0 }
  while i < events.length() {
    if events[i].event == EvQuestionBatchAsked {
      let mut answered = false
      let mut j = i + 1
      while j < events.length() {
        if events[j].event == EvQuestionBatchAnswered &&
          batch_answers(events[i].attrs, events[j].attrs) {
          answered = true
          break
        }
        j = j + 1
      }
      if !answered {
        return i
      }
    }
    i = i + 1
  }
  -1
}

///|
/// Every batch asked after `since` with no answer after it, oldest first.
fn unanswered_questions(
  events : Array[DerivedRow],
  since : Int,
) -> Array[(Int, String)] {
  let out : Array[(Int, String)] = []
  let mut i = if since + 1 > 0 { since + 1 } else { 0 }
  while i < events.length() {
    if events[i].event == EvQuestionBatchAsked {
      let mut answered = false
      let mut j = i + 1
      while j < events.length() {
        if events[j].event == EvQuestionBatchAnswered &&
          batch_answers(events[i].attrs, events[j].attrs) {
          answered = true
          break
        }
        j = j + 1
      }
      if !answered {
        out.push((i, row_at_text(events[i])))
      }
    }
    i = i + 1
  }
  out
}

///|
/// The last index of the work events, or -1 when none of them ran.
fn last_of_work(events : Array[DerivedRow], kinds : Array[DerivedEvent]) -> Int {
  let mut found = -1
  for kind in kinds {
    let at = last_event_index(events, kind)
    if at > found {
      found = at
    }
  }
  found
}

///|
/// The work handed to the executor, as the events that name it. A rejection is not among them by its name: it is
/// the executor's work only when it sends the lane back to its implementation (`last_executor_work`).
fn executor_work() -> Array[DerivedEvent] {
  [
    EvS2Start,
    EvS2FixSent,
    EvS4VerifyUserJudgmentAnswered,
    EvS2ReviewBaseInstructed,
    EvS2RecordsInstructed,
  ]
}

///|
/// The work handed to the planner, as the events that name it. A return to the plan is not among them by its name:
/// which rows are one is `returns_to_plan`'s answer (`last_planner_work`).
fn planner_work() -> Array[DerivedEvent] {
  [EvLaneOpen, EvS0RequeueGo, EvS1PlanReviewDone, EvS1ReviseRequested]
}

///|
/// The index of the last rejection that sends the lane back to its implementation, or -1.
fn last_implementation_reject(events : Array[DerivedRow]) -> Int {
  let mut i = events.length() - 1
  while i >= 0 {
    if events[i].event == EvS3Reject && !returns_to_plan(events[i]) {
      return i
    }
    i = i - 1
  }
  -1
}

///|
/// The index of the last work handed to the executor, or -1.
fn last_executor_work(events : Array[DerivedRow]) -> Int {
  max_int(
    last_of_work(events, executor_work()),
    last_implementation_reject(events),
  )
}

///|
/// The index of the last work handed to the planner, or -1. `kinds` is the planner's work, with any event the caller
/// counts beside it.
fn last_planner_work(
  events : Array[DerivedRow],
  kinds : Array[DerivedEvent],
) -> Int {
  max_int(last_of_work(events, kinds), last_return_to_plan(events))
}

///|
/// The index of the last answer after `since`, or -1.
fn last_answer_after(events : Array[DerivedRow], since : Int) -> Int {
  let mut found = -1
  let mut i = events.length() - 1
  while i > since {
    if events[i].event == EvQuestionBatchAnswered {
      found = i
      break
    }
    i = i - 1
  }
  found
}

///|
/// The work handed to the agent whose question the lane is on now, with the role it was handed to, or nothing.
fn question_boundary(
  events : Array[DerivedRow],
  quota : QuotaFact,
) -> (Int, String)? {
  if event_ran(events, EvS2Start) {
    let last_result = last_event_index(events, EvS2Result)
    let ask_since = last_executor_work(events)
    if ask_since > last_result {
      return Some((ask_since, "executor"))
    }
    return None
  }
  let stage = stage_with_quota(events, quota)
  if stage.group != Prep {
    return None
  }
  if stage.decision is Some(_) {
    return None
  }
  match stage.blocked_by {
    Some(text) =>
      if text != PLANNER_REVISING && text != PLANNER_SENT_BACK {
        return None
      }
    None => ()
  }
  Some((last_planner_work(events, planner_work()), "planner"))
}

///|
/// The batch a lane is waiting on penne for: the oldest question with no answer since the work it is on now,
/// with the role that was handed the work and the index of the question.
fn awaiting_question(
  events : Array[DerivedRow],
  quota : QuotaFact,
) -> (Int, String)? {
  match question_boundary(events, quota) {
    None => None
    Some((index, role)) => {
      let at = oldest_unanswered(events, index)
      if at < 0 {
        None
      } else {
        Some((at, role))
      }
    }
  }
}

///|
/// The role a lane is waiting on and the index of the event that handed it the work, or nothing.
fn awaited_agent(
  events : Array[DerivedRow],
  quota : QuotaFact,
) -> (Int, String)? {
  if awaiting_question(events, quota) is Some(_) {
    return None
  }
  if event_ran(events, EvS2Start) {
    let last_result = last_event_index(events, EvS2Result)
    let ask_since = last_executor_work(events)
    if ask_since <= last_result {
      return None
    }
    let after = last_answer_after(events, ask_since)
    let since = if after > ask_since { after } else { ask_since }
    return Some((since, "executor"))
  }
  let stage = stage_with_quota(events, quota)
  if stage.group != Prep {
    return None
  }
  if stage.decision is Some(_) {
    return None
  }
  match stage.blocked_by {
    Some(text) =>
      if text != PLANNER_REVISING && text != PLANNER_SENT_BACK {
        return None
      }
    None => ()
  }
  let kinds = planner_work()
  kinds.push(EvQuestionBatchAnswered)
  Some((last_planner_work(events, kinds), "planner"))
}

///|
/// Whose turn the lane is on: the agent's, penne's, another lane's, the outside's, or the engine's. A closed
/// lane is on nobody's turn.
fn lane_turn_text(events : Array[DerivedRow], facts : TurnFacts) -> String? {
  let stage = stage_with_quota(events, facts.quota)
  if stage.group == Closed {
    return None
  }
  // the agent: the watch says so, or work is queued
  if !is_null(facts.awaited_agent) {
    return Some("agent")
  }
  if facts.pending_envelope {
    return Some("agent")
  }
  // penne: an unanswered question the lane is waiting on outranks a run the engine thinks is working
  if awaiting_question(events, facts.quota) is Some(_) {
    return Some("penne")
  }
  // the agent: a review or plan-review run is working
  let phase = text_of(field(plan_review_phase(events), "phase"))
  if phase == "running" || phase == "revising" || phase == "sent_back" {
    return Some("agent")
  }
  if event_ran(events, EvS2Start) {
    let state = loop_state_name(review_loop_state(events))
    if is_agent_loop_state(state) {
      return Some("agent")
    }
  }
  // penne: a card is up. A ship card only counts when it can actually be built
  if stage.decision is Some(decision) {
    if decision != Ship || facts.card_buildable != Some(false) {
      return Some("penne")
    }
  }
  // another lane's turn: waiting for the lanes ahead, or for a dependency
  if event_ran(events, EvS2Start) &&
    loop_state_name(review_loop_state(events)) == "awaiting_order" {
    return Some("lane")
  }
  if stage.group == Waiting &&
    events.length() > 0 &&
    events[events.length() - 1].event == EvBlockedByDependency {
    return Some("lane")
  }
  // outside: waiting on something outside the pipeline (a PR's answer, the import's collection)
  if stage.group == Waiting {
    return Some("outside")
  }
  Some("engine")
}

///|
/// The step a lane stands on, as the text two readings compare: the turn, the group, the stage done and the
/// wait.
fn turn_step(events : Array[DerivedRow], facts : TurnFacts) -> String {
  let stage = stage_with_quota(events, facts.quota)
  let turn = match lane_turn_text(events, facts) {
    Some(text) => text
    None => ""
  }
  let blocked = match stage.blocked_by {
    Some(text) => text
    None => ""
  }
  turn +
  "\u0000" +
  lane_group_text(stage.group) +
  "\u0000" +
  stage.stage_done.to_string() +
  "\u0000" +
  blocked
}

///|
/// When the lane came to the step it is on now: the time of the event its last stretch at the same step
/// began with. The tail is shortened one record at a time while the step is unchanged, so a record that moves
/// no lane does not restart the clock. Penne's resume starts a fresh clock.
fn turn_since_text(events : Array[DerivedRow], facts : TurnFacts) -> String? {
  if events.length() == 0 {
    return None
  }
  let want = turn_step(events, facts)
  let mut i = events.length()
  while i > 1 && turn_step(prefix_rows(events, i - 1), facts) == want {
    i = i - 1
  }
  let mut since = row_at_text(events[i - 1])
  let mut resumed : DerivedRow? = None
  for row in events {
    if row.event == EvLaneStallResumed {
      resumed = Some(row)
    }
  }
  match resumed {
    Some(row) => {
      let since_ms = host_date_ms(since)
      let resumed_ms = host_date_ms(row.at)
      if !since_ms.is_nan() && !resumed_ms.is_nan() && resumed_ms > since_ms {
        since = row.at
      }
    }
    None => ()
  }
  Some(since)
}

///|
/// When the lane came to the decision it waits at: the time of the event its last stretch at that decision
/// began with.
fn decision_since_text(
  events : Array[DerivedRow],
  quota : QuotaFact,
) -> String? {
  let stage = stage_with_quota(events, quota)
  let decision = match stage.decision {
    Some(kind) => kind
    None => return None
  }
  let mut i = events.length()
  while i > 1 &&
        stage_with_quota(prefix_rows(events, i - 1), quota).decision ==
        Some(decision) {
    i = i - 1
  }
  Some(row_at_text(events[i - 1]))
}

///|
/// The rules the write side checks an event's name against the lane's stage with. One rule may answer to more
/// than one name (both of the GO answers), and a rule added without its wording beside it does not build
/// (C-202-4).
pub(all) enum StrictRule {
  RuleGo
  RuleReplan
  RuleGranularity
  RuleDefer
  RuleLaneClose
  RuleS2Start
  RuleS4SubmitStarted
}

///|
/// The strict events: one table of name and rule, and the only place a name is written. The gate's question
/// (`strict_event_of`), the refusal's wording (`refusal_of`) and the caller's list (`strict_events_json`) all read
/// this table, so a name added here is both checked and listed, and a rule added without its wording does not
/// build (C-202-4).
let strict_events : Array[(String, StrictRule)] = [
  ("s1_go", RuleGo),
  ("s1_revise_requested", RuleGo),
  ("s1_replan_requested", RuleReplan),
  ("s1_granularity_answered", RuleGranularity),
  ("s1_defer", RuleDefer),
  ("lane_close", RuleLaneClose),
  ("s2_start", RuleS2Start),
  ("s4_submit_started", RuleS4SubmitStarted),
]

///|
/// Whether a name is one of the strict events: the gate's own question, answered from the one table.
pub fn strict_event_is(name : String) -> Bool {
  match strict_event_of(name) {
    Some(_) => true
    None => false
  }
}

///|
/// The rule a name is checked by, or nothing when the write side lets the name through as it is: the one table
/// above is what decides both whether the name is strict and which rule it is checked by.
fn strict_event_of(name : String) -> StrictRule? {
  for entry in strict_events {
    if entry.0 == name {
      return Some(entry.1)
    }
  }
  None
}

///|
/// The gate's list, as the caller reads it: the names of the one table, in its order.
fn strict_events_json() -> String {
  Json::array(strict_events.map(fn(entry) { Json::string(entry.0) })).stringify()
}

///|
/// The rules of the write side: which stage may take which event, and what the caller is told when it may
/// not. A name outside the strict events is not asked here: the write side writes it as it is. The wording is
/// written for every rule the table names, so a rule added there without its wording does not build (C-202-4).
fn refusal_of(
  rule : StrictRule?,
  stage : StageAnswer,
  events : Array[DerivedRow],
) -> String? {
  let reload = "（画面を更新してください）"
  match rule {
    None => None
    Some(RuleGo) =>
      if stage.decision == Some(Go) {
        None
      } else {
        Some("この lane は GO 待ちではありません" + reload)
      }
    Some(RuleReplan) =>
      // only the review loop's own stop: a budget, a stall and a halt are answered by their own cards
      if stage.decision == Some(Stuck) &&
        is_text(
          field(loop_state_json(review_loop_state(events)), "state"),
          "escalated",
        ) {
        None
      } else {
        Some("この lane は要判断で止まっていません" + reload)
      }
    Some(RuleGranularity) =>
      if stage.decision == Some(Granularity) {
        None
      } else {
        Some(
          "この lane は粒度の案への答え待ちではありません" +
          reload,
        )
      }
    Some(RuleDefer) => {
      let before_go = if stage.group == Prep {
        true
      } else {
        stage.group == Judge &&
        (
          stage.decision == Some(Go) ||
          stage.decision == Some(Question) ||
          stage.decision == Some(Requeue)
        )
      }
      if before_go {
        None
      } else {
        Some(
          "GO の前の lane だけ見送れます。GO の後は lane の中止を使ってください" +
          reload,
        )
      }
    }
    Some(RuleLaneClose) =>
      if stage.group != Closed {
        None
      } else {
        Some("この lane は既に閉じています" + reload)
      }
    Some(RuleS2Start) => {
      let started = event_ran(events, EvS2Start)
      if stage.group == Impl && stage.stage_done == 2 && !started {
        None
      } else {
        Some(
          "GO の後で executor をまだ起動していない lane ではありません",
        )
      }
    }
    Some(RuleS4SubmitStarted) =>
      if stage.group == Impl && stage.stage_done == 4 {
        None
      } else {
        Some(
          "S3 を通って提出前確認を待つ lane ではありません" +
          reload,
        )
      }
  }
}

///|
/// The quota reading as the caller hands it in: the reading, the clock it was read at, and the way the
/// wait is put on top of the record's answer.
fn quota_fact_of(args : Json) -> QuotaFact {
  let quota = field(args, "quota")
  if is_null(quota) {
    return { reading: NoOverlay, now_ms: 0.0, }
  }
  let mode = text_of(field(quota, "mode"))
  let reading = match mode {
    "free" => Free
    "busy" => {
      let resets = match field(quota, "resetsAt") {
        Json::Number(number, ..) => Some(number)
        _ => None
      }
      Busy(resets, text_of(field(quota, "reason")))
    }
    "unknown" => Unknown
    "record" => Record
    _ => NoOverlay
  }
  { reading, now_ms: js_num(field(quota, "now")), }
}

///|
/// The facts of a lane's turn as the caller hands them in.
fn turn_facts_of(args : Json) -> TurnFacts {
  let card = field(args, "cardBuildable")
  {
    awaited_agent: field(args, "awaitedAgent"),
    pending_envelope: js_truthy(field(args, "pendingEnvelope")),
    card_buildable: match card {
      Json::True => Some(true)
      Json::False => Some(false)
      _ => None
    },
    quota: quota_fact_of(args),
  }
}

///|
/// The index a caller names, or -1 when it names none.
fn arg_since(args : Json) -> Int {
  match field(args, "since") {
    Json::Null => -1
    other => js_num(other).to_int()
  }
}
