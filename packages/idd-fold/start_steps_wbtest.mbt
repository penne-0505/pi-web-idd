// The startup stages' answers, in the fold's own words.
//
// The wider promise — that these answers are the ones the tick gave before the fold took the decision over — is held
// by the engine's own tests over the stages (`packages/idd-core/test/plan-review.test.mjs`, `slot-wait.test.mjs`).
// These say what the fold does with the rows and the facts a caller hands in, one branch at a time.

///|
/// One derived row out of its JSON text.
fn ss_row(text : String) -> DerivedRow {
  derived_row_of(
    @json.parse(text) catch {
      error => abort("テストの行が JSON ではありません: \{error}")
    },
  )
}

///|
/// Rows out of their JSON texts.
fn ss_rows(texts : Array[String]) -> Array[DerivedRow] {
  let rows : Array[DerivedRow] = []
  for text in texts {
    rows.push(ss_row(text))
  }
  rows
}

///|
/// A lane waiting for its planner: a backlog row was taken in.
fn ss_lane() -> Array[DerivedRow] {
  ss_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-24T10:00:00.000Z\",\"attrs\":{}}",
  ])
}

///|
/// The facts of a planner's start, with nothing read yet.
fn ss_prep_facts() -> Array[(String, Json)] {
  [
    ("lane", Json::string("IDD-1")),
    ("area", Json::string("demo")),
    ("limit", Json::number(1.0)),
    ("started", Json::number(0.0)),
    ("hold", Json::string("")),
    ("runner", Json::boolean(true)),
    ("sessions", Json::array([])),
  ]
}

///|
/// The facts as one object, with one replaced and the named ones added.
fn ss_facts(
  base : Array[(String, Json)],
  replaced : Array[(String, Json)],
  extras : Array[(String, Json)],
) -> Json {
  let out : Array[(String, Json)] = []
  for pair in base {
    let mut kept = true
    for other in replaced {
      if other.0 == pair.0 {
        out.push(other)
        kept = false
      }
    }
    if kept {
      out.push(pair)
    }
  }
  for extra in extras {
    out.push(extra)
  }
  json_object(out)
}

///|
/// A helper's answer, as the caller keeps it under its fact.
fn ss_kept(answer : Json) -> Json {
  json_object([("result", answer)])
}

///|
/// One answer's text, so a test names the step it expects.
fn ss_text(answer : Json) -> String {
  answer.stringify()
}

///|
test "a planner with no runner is skipped before any worktree is made" {
  let facts = ss_facts(ss_prep_facts(), [("runner", Json::boolean(false))], [])
  inspect(
    ss_text(start_prep(ss_lane(), facts)),
    content=(
      #|{"steps":[{"do":"action","action":"skipped","reason":"no runner"}]}
    ),
  )
}

///|
test "a planner waits when the replacement of the engine holds it" {
  let facts = ss_facts(
    ss_prep_facts(),
    [("hold", Json::string("engine を入れ替えています"))],
    [],
  )
  inspect(
    ss_text(start_prep(ss_lane(), facts)),
    content=(
      #|{"steps":[{"do":"action","action":"skipped","reason":"engine を入れ替えています","wait":true}]}
    ),
  )
}

///|
test "a planner with a full slot waits for the cap, counted from the session records" {
  let sessions = Json::array([json_object([("idd_id", Json::string("IDD-9"))])])
  let facts = ss_facts(ss_prep_facts(), [("sessions", sessions)], [])
  inspect(
    ss_text(start_prep(ss_lane(), facts)),
    content=(
      #|{"steps":[{"do":"action","action":"skipped","reason":"concurrency cap","wait":true}]}
    ),
  )
}

///|
test "a planner's start reads its worktree, its session, its record, its fallbacks and its brief in that order" {
  let work = ss_kept(
    json_object([
      ("path", Json::string("/work")),
      ("branch", Json::string("idd/IDD-1")),
    ]),
  )
  let spawned = ss_kept(json_object([("sessionId", Json::string("P-1"))]))
  let facts = ss_facts(ss_prep_facts(), [], [
    ("call|ensure_worktree|prep", work),
    ("call|spawn|prep", spawned),
    (
      "call|record_session|prep",
      ss_kept(json_object([("ok", Json::boolean(true))])),
    ),
    (
      "call|record_quota_fallbacks|prep",
      ss_kept(json_object([("ok", Json::boolean(true))])),
    ),
    ("call|deliver|prep", ss_kept(json_object([("ok", Json::boolean(true))]))),
  ])
  inspect(
    ss_text(start_prep(ss_lane(), facts)),
    content=(
      #|{"steps":[{"do":"action","action":"started"}]}
    ),
  )
}

///|
test "a worktree a place cannot make holds the lane back with the place's own reason" {
  let facts = ss_facts(ss_prep_facts(), [], [
    (
      "call|ensure_worktree|prep",
      ss_kept(
        json_object([
          ("error", Json::string("no space")),
          ("hold", Json::string("空きが足りません")),
        ]),
      ),
    ),
  ])
  inspect(
    ss_text(start_prep(ss_lane(), facts)),
    content=(
      #|{"steps":[{"do":"action","action":"skipped","reason":"空きが足りません","wait":true}]}
    ),
  )
}

///|
/// The facts of an executor's start.
fn ss_exec_facts() -> Array[(String, Json)] {
  [
    ("lane", Json::string("IDD-1")),
    ("area", Json::string("demo")),
    ("limit", Json::number(1.0)),
    ("started", Json::number(0.0)),
    ("runner", Json::boolean(true)),
    ("sessionShape", Json::string("state")),
    ("sessions", Json::array([])),
  ]
}

///|
test "an executor with a full slot waits for the cap and says so itself" {
  let facts = ss_facts(ss_exec_facts(), [("started", Json::number(1.0))], [])
  inspect(
    ss_text(start_exec(ss_lane(), facts)),
    content=(
      #|{"steps":[{"do":"action","action":"skipped","reason":"concurrency cap","wait":true}]}
    ),
  )
}

///|
test "a v2 lane writes its plan records before its session is spawned" {
  let lane = ss_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-24T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_ready\",\"at\":\"2026-10-24T10:01:00.000Z\",\"attrs\":{\"records_shape\":\"state\",\"plan_records\":{\"choices\":[],\"existing\":[]}}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-24T10:02:00.000Z\",\"attrs\":{}}",
  ])
  let facts = ss_facts(ss_exec_facts(), [], [
    ("call|transition_refusal|s2_start", ss_kept(json_object([]))),
    (
      "call|ensure_worktree|exec",
      ss_kept(
        json_object([
          ("path", Json::string("/work")),
          ("branch", Json::string("idd/IDD-1")),
        ]),
      ),
    ),
  ])
  inspect(
    ss_text(start_exec(lane, facts)),
    content=(
      #|{"steps":[{"do":"call","helper":"write_plan_records","site":"exec","fact":"call|write_plan_records|exec","keep":null,"args":null,"fatal":false}]}
    ),
  )
}

///|
test "an executor whose start was refused takes its session back and keeps the refusal's words" {
  let lane = ss_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-24T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_ready\",\"at\":\"2026-10-24T10:01:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-24T10:02:00.000Z\",\"attrs\":{}}",
  ])
  let ok = json_object([("ok", Json::boolean(true))])
  let facts = ss_facts(
    ss_exec_facts(),
    [("sessionShape", Json::string("docs"))],
    [
      ("call|transition_refusal|s2_start", ss_kept(json_object([]))),
      (
        "call|ensure_worktree|exec",
        ss_kept(
          json_object([
            ("path", Json::string("/work")),
            ("branch", Json::string("idd/IDD-1")),
          ]),
        ),
      ),
      ("call|read_contract|exec", ss_kept(json_object([]))),
      (
        "call|commit_records|exec",
        ss_kept(json_object([("base", Json::string("base"))])),
      ),
      (
        "call|spawn|exec",
        ss_kept(json_object([("sessionId", Json::string("E-1"))])),
      ),
      (
        "call|write_start|exec",
        ss_kept(
          json_object([
            ("reason", Json::string("lane は中止されました")),
          ]),
        ),
      ),
      (
        "call|discard_session|exec",
        ss_kept(json_object([("left", Json::string(""))])),
      ),
    ],
  )
  inspect(
    ss_text(start_exec(lane, facts)),
    content=(
      #|{"steps":[{"do":"action","action":"skipped","reason":"s2_start: lane は中止されました"}]}
    ),
  )
  let _ = ok
}

///|
/// The facts of a plan review.
fn ss_review_facts() -> Array[(String, Json)] {
  [
    ("lane", Json::string("IDD-1")),
    ("limit", Json::number(1.0)),
    ("started", Json::number(0.0)),
    ("declared", Json::boolean(true)),
    ("runnerStart", Json::boolean(true)),
    ("runnerStatus", Json::boolean(true)),
  ]
}

///|
/// A lane whose planner readied its documents.
fn ss_review_lane() -> Array[DerivedRow] {
  ss_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-24T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_ready\",\"at\":\"2026-10-24T10:01:00.000Z\",\"attrs\":{}}",
  ])
}

///|
test "a plan review nobody declared is skipped with a record, not left waiting" {
  let facts = ss_facts(
    ss_review_facts(),
    [("declared", Json::boolean(false))],
    [],
  )
  inspect(
    ss_text(start_plan_review(ss_review_lane(), facts)),
    content=(
      #|{"steps":[{"do":"write","event":"s1_plan_review_skipped","attrs":{"reason":"pipeline.plan_review が未宣言"}},{"do":"action","action":"skipped"}]}
    ),
  )
}

///|
test "a plan review waits for its cap, counting the lanes this pass already started" {
  let facts = ss_facts(ss_review_facts(), [("started", Json::number(1.0))], [])
  inspect(
    ss_text(start_plan_review(ss_review_lane(), facts)),
    content=(
      #|{"steps":[{"do":"action","action":"waiting"}]}
    ),
  )
}

///|
test "a plan review with no runner waits without a record" {
  let facts = ss_facts(
    ss_review_facts(),
    [("runnerStart", Json::boolean(false))],
    [],
  )
  inspect(
    ss_text(start_plan_review(ss_review_lane(), facts)),
    content=(
      #|{"steps":[{"do":"action","action":"waiting"}]}
    ),
  )
}

///|
/// A lane whose first review sent back a must, whose planner readied the fix, and whose slot is no longer declared.
fn ss_fixed_after_must(skipped : Int) -> Array[DerivedRow] {
  let texts = [
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-24T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_ready\",\"at\":\"2026-10-24T10:01:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_plan_review_started\",\"at\":\"2026-10-24T10:02:00.000Z\",\"attrs\":{\"run_ids\":[\"r\"]}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_plan_review_done\",\"at\":\"2026-10-24T10:03:00.000Z\",\"attrs\":{\"must\":1}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_ready\",\"at\":\"2026-10-24T10:04:00.000Z\",\"attrs\":{}}",
  ]
  let mut n = 0
  while n < skipped {
    texts.push(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_plan_review_skipped\",\"at\":\"2026-10-24T10:05:00.000Z\",\"attrs\":{}}",
    )
    n = n + 1
  }
  ss_rows(texts)
}

///|
test "a fix after a must is skipped once, then opens GO for a reason instead of waiting" {
  let facts = ss_facts(
    ss_review_facts(),
    [("declared", Json::boolean(false))],
    [],
  )
  inspect(
    ss_text(plan_review_phase(ss_fixed_after_must(0))),
    content=(
      #|{"phase":"waiting"}
    ),
  )
  inspect(
    ss_text(start_plan_review(ss_fixed_after_must(0), facts)),
    content=(
      #|{"steps":[{"do":"write","event":"s1_plan_review_skipped","attrs":{"reason":"pipeline.plan_review が未宣言"}},{"do":"action","action":"skipped"}]}
    ),
  )
  // the skip cannot be asked again: the phase is the review's end, with the must unanswered, and nothing is written twice
  inspect(
    ss_text(plan_review_phase(ss_fixed_after_must(1))),
    content=(
      #|{"phase":"reviewed","failed":false,"actionable":0}
    ),
  )
  inspect(
    ss_text(start_plan_review(ss_fixed_after_must(1), facts)),
    content=(
      #|{"steps":[{"do":"action","action":"none"}]}
    ),
  )
}

///|
test "a round started after the skip is running, not reviewed" {
  let texts = [
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-24T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_ready\",\"at\":\"2026-10-24T10:01:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_plan_review_started\",\"at\":\"2026-10-24T10:02:00.000Z\",\"attrs\":{\"run_ids\":[\"r\"]}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_plan_review_done\",\"at\":\"2026-10-24T10:03:00.000Z\",\"attrs\":{\"must\":1}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_ready\",\"at\":\"2026-10-24T10:04:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_plan_review_skipped\",\"at\":\"2026-10-24T10:05:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s1_plan_review_started\",\"at\":\"2026-10-24T10:06:00.000Z\",\"attrs\":{\"run_ids\":[\"r2\"]}}",
  ]
  inspect(
    ss_text(plan_review_phase(ss_rows(texts))),
    content=(
      #|{"phase":"running","runIds":["r2"]}
    ),
  )
}

///|
test "a skipped review with no must raised before it still opens GO" {
  inspect(
    ss_text(
      plan_review_phase(
        ss_rows([
          "{\"idd_id\":\"IDD-1\",\"event\":\"s1_ready\",\"at\":\"2026-10-24T10:01:00.000Z\",\"attrs\":{}}",
          "{\"idd_id\":\"IDD-1\",\"event\":\"s1_plan_review_skipped\",\"at\":\"2026-10-24T10:02:00.000Z\",\"attrs\":{}}",
        ]),
      ),
    ),
    content=(
      #|{"phase":"reviewed","failed":false,"actionable":0}
    ),
  )
}
