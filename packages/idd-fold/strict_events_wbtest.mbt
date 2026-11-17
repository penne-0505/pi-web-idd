// The write side's strict events' own tests: one table of name and rule is what the gate, the refusal's wording
// and the display all read.
//
// The promise that adding a rule to the closed type without its wording stops the build is the compiler's, held by
// the exhaustive match in `refusal_of`. The promise that adding a name cannot be checked without being listed is
// the table's: `strict_event_of` and `strict_events_json` both read the same table, so there is no second list to
// forget. What is written here is that the display names exactly the table's names in its order, that every table
// name is a strict event the gate checks, that a name outside the table is let through, and that the refusal reads
// the rule the table names.

///|
test "the gate's list is the eight events the write side checks, in the order the refusal reads them" {
  inspect(
    strict_events_json(),
    content=(
      #|["s1_go","s1_revise_requested","s1_replan_requested","s1_granularity_answered","s1_defer","lane_close","s2_start","s4_submit_started"]
    ),
  )
  inspect(strict_events.length(), content="8")
}

///|
test "every name in the table is a strict event the gate checks" {
  for entry in strict_events {
    inspect(strict_event_is(entry.0), content="true")
  }
  inspect(strict_event_is("s4_push_held"), content="false")
  inspect(strict_event_is("s3_ok"), content="false")
  inspect(strict_event_is(""), content="false")
}

///|
test "a name outside the table is not a strict event, so the write side lets it through" {
  inspect(
    match strict_event_of("s4_push_held") {
      Some(_) => "strict"
      None => ""
    },
    content="",
  )
  let rows = [
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-22T10:00:00.000Z\",\"attrs\":{}}",
    ),
  ]
  inspect(
    match
      refusal_of(
        strict_event_of("s4_push_held"),
        stage_with_quota(rows, record_quota()),
        rows,
      ) {
      Some(text) => text
      None => ""
    },
    content="",
  )
}

///|
test "the refusal reads the rule the table names" {
  let rows = [
    derived(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-22T10:00:00.000Z\",\"attrs\":{}}",
    ),
  ]
  let stage = stage_with_quota(rows, record_quota())
  // a lane that is not at GO: the GO rule's wording answers, and the close rule lets the name through
  inspect(
    match refusal_of(Some(RuleGo), stage, rows) {
      Some(text) => text
      None => ""
    },
    content="この lane は GO 待ちではありません（画面を更新してください）",
  )
  inspect(
    match refusal_of(Some(RuleLaneClose), stage, rows) {
      Some(text) => text
      None => ""
    },
    content="",
  )
}
