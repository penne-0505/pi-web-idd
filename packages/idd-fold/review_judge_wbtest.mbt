// The card's own question: which facts its four choices need to be answered.
//
// The wider promise — that the card's answer is the one the TypeScript reading gave — is held by the fixture
// test (`packages/idd-core/test/review-judge.test.mjs`) and against a real ledger (`crosscheck.mjs`). These say
// what the card asks the caller for, and when.

///|
/// One derived row out of its JSON text.
fn card_row(text : String) -> DerivedRow {
  derived_row_of(
    @json.parse(text) catch {
      error => abort("テストの行が JSON ではありません: \{error}")
    },
  )
}

///|
/// A lane's rows out of their JSON texts.
fn card_rows(texts : Array[String]) -> Array[DerivedRow] {
  let rows : Array[DerivedRow] = []
  for text in texts {
    rows.push(card_row(text))
  }
  rows
}

///|
/// The card's answer for a lane that stopped at its triage: a blind round with one should finding, escalated by a
/// question (so continuing leads to the final review) or by nothing (so continuing leads to the fix).
fn card_lane(question : Bool) -> Array[DerivedRow] {
  let escalated = if question { ",\"escalated_claims\":[\"q\"]" } else { "" }
  card_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-01T00:00:00.000Z\",\"attrs\":{\"started_from_commit\":\"c0\"}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-01T00:01:00.000Z\",\"attrs\":{\"outcome\":\"success\"}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_started\",\"at\":\"2026-10-01T00:02:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"run_ids\":[\"b\"],\"head\":\"aaaa\"}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_findings\",\"at\":\"2026-10-01T00:03:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"files\":[\"/b.json\"],\"failed_runs\":0}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_triage_started\",\"at\":\"2026-10-01T00:04:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"run_id\":\"t\"}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_triage_done\",\"at\":\"2026-10-01T00:05:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1," +
    "\"accepted\":[{\"ref\":\"F-2\",\"severity\":\"should\",\"claim\":\"c\",\"path\":\"a.ts\",\"fix\":\"f\"}]" +
    escalated +
    "}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_escalated\",\"at\":\"2026-10-01T00:06:00.000Z\",\"attrs\":{\"reason\":\"x\"}}",
  ])
}

///|
/// The card's arguments, as the caller hands them over: the policy and whether the device check is declared.
fn card_args() -> Json {
  @json.parse(
    "{\"policy\":{\"extras\":{\"first_round\":1,\"high_risk\":1},\"highRiskWhen\":\"last\",\"finalExtra\":\"high\",\"finalWhen\":\"behaviour\",\"finalScope\":\"increment\",\"orderWaitHours\":6,\"orderExcludeFiles\":[\"TODO.md\"]},\"deviceOn\":true}",
  ) catch {
    error =>
      abort("テストの policy が JSON ではありません: \{error}")
  }
}

///|
test "the card asks for the lane's head only when its answer reaches the final review" {
  let needs : Array[FactNeed] = []
  let answer = stuck_outcomes_answer(card_lane(true), card_args(), needs)
  inspect(
    answer.stringify(),
    content=(
      #|{"needs":[{"id":"head||","kind":"head","a":"","b":""}]}
    ),
  )
}

///|
test "a card whose answer goes to the fix asks for no fact at all" {
  let needs : Array[FactNeed] = []
  let answer = stuck_outcomes_answer(card_lane(false), card_args(), needs)
  inspect(
    answer.stringify().contains("\"needs\":[]").to_string(),
    content=(
      #|true
    ),
  )
}

///|
test "a head the caller cannot read keeps the final review" {
  let rows = card_lane(true)
  let head = fact_id("head", "", "")
  let same_tree = fact_id("sameTree", "aaaa", "aaaa")
  let behaviour = fact_id("behaviour", "aaaa", "aaaa")
  let args = fn(facts : Json) -> Json {
    json_object([
      ("policy", field(card_args(), "policy")),
      ("deviceOn", Json::boolean(true)),
      ("facts", facts),
    ])
  }
  let needs_unreadable : Array[FactNeed] = []
  let unreadable = stuck_outcomes_answer(
    rows,
    args(json_object([(head, Json::string(""))])),
    needs_unreadable,
  )
  let needs_readable : Array[FactNeed] = []
  let readable = stuck_outcomes_answer(
    rows,
    args(
      json_object([
        (head, Json::string("aaaa")),
        (same_tree, Json::boolean(true)),
        (behaviour, Json::array([])),
        (fact_id("risk", "", ""), Json::boolean(false)),
      ]),
    ),
    needs_readable,
  )
  inspect(
    js_string(field(field(unreadable, "continue"), "to")) +
    "," +
    js_string(field(field(readable, "continue"), "to")),
    content=(
      #|final,close
    ),
  )
}
