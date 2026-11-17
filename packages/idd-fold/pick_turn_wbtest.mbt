// The pick and turn readings' own tests: the answer is written next to the call.
//
// These say what the two readings do, in the fold's own words. The wider promise — that this answer is the same
// one the TypeScript reading gave — is held by the cross-check against a real ledger
// (`packages/idd-fold/crosscheck.mjs`) and against the committed fixtures (`packages/idd-core/test/`).

///|
/// One derived row out of its JSON text.
fn derived(text : String) -> DerivedRow {
  derived_row_of(
    @json.parse(text) catch {
      error => abort("テストの行が JSON ではありません: \{error}")
    },
  )
}

///|
/// The reading of Claude Code's windows the tests use: the record alone decides.
fn record_quota() -> QuotaFact {
  { reading: Record, now_ms: 0.0, }
}

///|
/// The answer of a stage, as the caller reads it.
fn picked_json(answer : PickAnswer) -> String {
  pick_answer_json(answer).stringify()
}

///|
/// The turn of a lane, as the caller reads it.
fn turn_json(events : Array[DerivedRow], facts : TurnFacts) -> String {
  match lane_turn_text(events, facts) {
    Some(text) => text
    None => ""
  }
}

///|
/// The facts a turn reads when nothing outside the record is known.
fn plain_turn_facts() -> TurnFacts {
  {
    awaited_agent: Json::null(),
    pending_envelope: false,
    card_buildable: None,
    quota: record_quota(),
  }
}

///|
test "a lane whose rows are all notes is left, and the answer is an answer" {
  let rows = [
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_stall_instructed\",\"at\":\"2026-10-22T10:00:00.000Z\",\"attrs\":{}}",
    ),
  ]
  inspect(
    picked_json(pick_of(Stall, rows, json_object([]), record_quota())),
    content=(
      #|{"pick":true}
    ),
  )
  inspect(
    picked_json(pick_of(Blocker, rows, json_object([]), record_quota())),
    content=(
      #|{"pick":false,"reason":"blocker を待つ lane ではない"}
    ),
  )
}

///|
test "a question whose batch id is null is not answered by an answer that carries none" {
  let rows = [
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"question_batch_asked\",\"at\":\"2026-10-22T10:00:00.000Z\",\"attrs\":{\"batch_id\":null}}",
    ),
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"question_batch_answered\",\"at\":\"2026-10-22T10:05:00.000Z\",\"attrs\":{}}",
    ),
  ]
  inspect(
    oldest_unanswered(rows, -1).to_string(),
    content=(
      #|0
    ),
  )
  inspect(
    unanswered_questions(rows, -1).length().to_string(),
    content=(
      #|1
    ),
  )
}

///|
test "a question that carries no id is answered by any answer after it" {
  let rows = [
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"question_batch_asked\",\"at\":\"2026-10-22T10:00:00.000Z\",\"attrs\":{}}",
    ),
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"question_batch_answered\",\"at\":\"2026-10-22T10:05:00.000Z\",\"attrs\":{}}",
    ),
  ]
  inspect(
    oldest_unanswered(rows, -1).to_string(),
    content=(
      #|-1
    ),
  )
}

///|
test "a question with an id is answered only by an answer with the same id" {
  let rows = [
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"question_batch_asked\",\"at\":\"2026-10-22T10:00:00.000Z\",\"attrs\":{\"batch_id\":\"b1\"}}",
    ),
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"question_batch_answered\",\"at\":\"2026-10-22T10:05:00.000Z\",\"attrs\":{\"batch_id\":\"b2\"}}",
    ),
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"question_batch_answered\",\"at\":\"2026-10-22T10:06:00.000Z\",\"attrs\":{\"batch_id\":\"b1\"}}",
    ),
  ]
  inspect(
    oldest_unanswered(rows, -1).to_string(),
    content=(
      #|-1
    ),
  )
}

///|
/// A row of the planning stage that carries the batch id the test names (empty: none).
fn plan_row(event : String, batch : String) -> DerivedRow {
  let attrs = if batch == "" { "{}" } else { "{\"batch_id\":\"\{batch}\"}" }
  derived(
    "{\"idd_id\":\"IDD-1\",\"event\":\"\{event}\",\"at\":\"2026-10-22T10:00:00.000Z\",\"attrs\":\{attrs}}",
  )
}

///|
/// The stage's decision and the awaited role, as one line.
fn plan_wait_line(events : Array[DerivedRow]) -> String {
  let stage = stage_with_quota(events, record_quota())
  let decision = match stage.decision {
    Some(Question) => "question"
    Some(_) => "other"
    None => "none"
  }
  let role = match awaited_agent(events, record_quota()) {
    Some((_, role)) => role
    None => "nobody"
  }
  "decision=\{decision} awaited=\{role}"
}

///|
test "a planning lane whose only batch was answered is the planner's turn, not a person's" {
  let open = plan_row("lane_open", "")
  let asked = plan_row("question_batch_asked", "b1")
  let answered = plan_row("question_batch_answered", "b1")
  inspect(
    plan_wait_line([open, asked]),
    content=(
      #|decision=question awaited=nobody
    ),
  )
  inspect(
    plan_wait_line([open, asked, answered]),
    content=(
      #|decision=none awaited=planner
    ),
  )
}

///|
test "a planning lane that asked again after the answer, or answered one of two, is still a person's turn" {
  let open = plan_row("lane_open", "")
  inspect(
    plan_wait_line([
      open,
      plan_row("question_batch_asked", "b1"),
      plan_row("question_batch_answered", "b1"),
      plan_row("question_batch_asked", "b2"),
    ]),
    content=(
      #|decision=question awaited=nobody
    ),
  )
  inspect(
    plan_wait_line([
      open,
      plan_row("question_batch_asked", "b1"),
      plan_row("question_batch_asked", "b2"),
      plan_row("question_batch_answered", "b2"),
    ]),
    content=(
      #|decision=question awaited=nobody
    ),
  )
}

///|
test "a lane whose planner waits for the review's findings carries the label the turn reads" {
  let rows = [
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-22T10:00:00.000Z\",\"attrs\":{}}",
    ),
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_ready\",\"at\":\"2026-10-22T10:01:00.000Z\",\"attrs\":{}}",
    ),
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_plan_review_done\",\"at\":\"2026-10-22T10:02:00.000Z\",\"attrs\":{\"must\":1}}",
    ),
  ]
  inspect(
    match stage_with_quota(rows, record_quota()).blocked_by {
      Some(label) => label
      None => ""
    },
    content=(
      #|査読の指摘を反映中
    ),
  )
  inspect(
    turn_json(rows, plain_turn_facts()),
    content=(
      #|agent
    ),
  )
}

///|
/// A shallow lane at the GO whose plan was reviewed, with the Purposes the lane's facts name.
fn auto_go_answer(purposes : String) -> String {
  let rows = [
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-22T10:00:00.000Z\",\"attrs\":{}}",
    ),
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_ready\",\"at\":\"2026-10-22T10:01:00.000Z\",\"attrs\":{\"depth\":\"shallow\"}}",
    ),
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_plan_review_started\",\"at\":\"2026-10-22T10:02:00.000Z\",\"attrs\":{\"run_ids\":[\"r\"]}}",
    ),
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_plan_review_done\",\"at\":\"2026-10-22T10:03:00.000Z\",\"attrs\":{\"must\":0}}",
    ),
  ]
  let facts = @json.parse(
    "{\"lane\":\"IDD-1\",\"depth\":\"shallow\",\"blocked\":false,\"purposes\":\{purposes},\"choices\":[],\"laneRows\":[]}",
  ) catch {
    error =>
      abort("テストの facts が JSON ではありません: \{error}")
  }
  picked_json(pick_of(AutoGo, rows, facts, record_quota()))
}

///|
test "a lane that withdrew its own Purpose proposal is left to a person, so s1_revise stays the way on" {
  inspect(
    auto_go_answer("[]"),
    content=(
      #|{"pick":true}
    ),
  )
  inspect(
    auto_go_answer("[{\"status\":\"withdrawn\",\"raisedBy\":\"IDD-1\"}]"),
    content=(
      #|{"pick":false,"reason":"取り下げた Purpose の案がある（GO は人が押す）"}
    ),
  )
  inspect(
    auto_go_answer("[{\"status\":\"withdrawn\",\"raisedBy\":\"IDD-2\"}]"),
    content=(
      #|{"pick":true}
    ),
  )
}
