// What penne's correction does to the review loop's readings: a finding she put off is not sent to the fix, is not
// an unresolved must, and waits as a follow-up; a finding a later judgement repeats is read with the same correction.
//
// The lane is the shape of IDD-205's second and third rounds: two musts put off on the stuck card, then the next
// round's judgement saying the same two again. The real ledger's rows are held by
// `packages/idd-core/test/review-corrections.test.mjs`.

///|
/// One lifecycle row of the lane, as text.
fn corr_row(event : String, minute : Int, attrs : String) -> String {
  "{\"idd_id\":\"IDD-1\",\"event\":\"" +
  event +
  "\",\"at\":\"2026-10-01T00:" +
  (if minute < 10 { "0" } else { "" }) +
  minute.to_string() +
  ":00.000Z\",\"attrs\":" +
  attrs +
  "}"
}

///|
/// A lane stopped after its second round: three musts accepted, the answer not yet given.
fn corr_stopped() -> Array[String] {
  [
    corr_row("s2_start", 0, "{\"started_from_commit\":\"c0\"}"),
    corr_row("s2_result", 1, "{\"outcome\":\"success\"}"),
    corr_row(
      "s2_review_started", 2, "{\"kind\":\"blind\",\"round\":2,\"run_ids\":[\"b\"],\"head\":\"aaaa\",\"depth\":\"standard\"}",
    ),
    corr_row(
      "s2_triage_done",
      3,
      "{\"kind\":\"blind\",\"round\":2,\"accepted\":[" +
      "{\"ref\":\"F-1\",\"severity\":\"must\",\"claim\":\"one\",\"path\":\"a.mbt\",\"action\":\"fix\"}," +
      "{\"ref\":\"F-4\",\"severity\":\"must\",\"claim\":\"four\",\"path\":\"b.ts\",\"action\":\"fix\"}," +
      "{\"ref\":\"F-6\",\"severity\":\"must\",\"claim\":\"six\",\"path\":\"c.ts\",\"action\":\"fix\"}]}",
    ),
    corr_row("s2_review_escalated", 4, "{\"reason\":\"x\"}"),
  ]
}

///|
/// Several runs of rows as one lane.
fn corr_lane(parts : Array[Array[String]]) -> Array[DerivedRow] {
  let texts : Array[String] = []
  for part in parts {
    for text in part {
      texts.push(text)
    }
  }
  card_rows(texts)
}

///|
/// Each finding as `ref:severity:action`, one text.
fn corr_describe(items : Array[Json]) -> String {
  let out : Array[String] = []
  for x in items {
    out.push(
      text_of(field(x, "ref")) +
      ":" +
      text_of(field(x, "severity")) +
      ":" +
      text_of(field(x, "action")),
    )
  }
  out.join(" ")
}

///|
/// The answer that puts F-4 off as a follow-up and F-6 aside.
fn corr_answer() -> String {
  corr_row(
    "s2_review_resumed",
    5,
    "{\"decision\":\"continue\",\"note\":\"n\",\"at_by\":\"user\",\"corrections\":[" +
    "{\"ref\":\"2-blind/F-4\",\"severity\":\"should\",\"action\":\"followup\",\"reason\":\"後に回す\"}," +
    "{\"ref\":\"2-blind/F-6\",\"severity\":\"nit\",\"action\":\"skip\"}," +
    "{\"ref\":\"2-blind/F-1\",\"severity\":\"must\",\"action\":\"followup\"}]}",
  )
}

///|
/// The next round, whose judgement says F-4 and F-6 again as new refs of its own.
fn corr_next() -> Array[String] {
  [
    corr_row("s2_fix_sent", 6, "{\"round\":2,\"refs\":[\"2-blind/F-1\"]}"),
    corr_row("s2_result", 7, "{\"outcome\":\"success\"}"),
    corr_row(
      "s2_review_started", 8, "{\"kind\":\"blind\",\"round\":3,\"run_ids\":[\"b\"],\"head\":\"bbbb\",\"depth\":\"standard\"}",
    ),
    corr_row(
      "s2_triage_done",
      9,
      "{\"kind\":\"blind\",\"round\":3,\"accepted\":[" +
      "{\"ref\":\"F-5\",\"severity\":\"must\",\"claim\":\"four again\",\"path\":\"b.ts\",\"action\":\"fix\",\"correction_ref\":\"2-blind/F-4\"}," +
      "{\"ref\":\"F-7\",\"severity\":\"must\",\"claim\":\"new\",\"path\":\"d.ts\",\"action\":\"fix\"}]," +
      "\"prior\":[{\"ref\":\"2-blind/F-4\"},{\"ref\":\"2-blind/F-6\"}]}",
    ),
  ]
}

///|
test "a must put off on the stuck card is not sent to the fix" {
  let rows = corr_lane([corr_stopped(), [corr_answer()]])
  inspect(
    fix_scope(rows).stringify(),
    content="{\"source\":\"review\",\"all\":false,\"accepted\":[{\"ref\":\"2-blind/F-1\",\"severity\":\"must\",\"claim\":\"one\",\"path\":\"a.mbt\",\"action\":\"fix\"}],\"note\":\"n\",\"boundaries\":[]}",
  )
}

///|
test "a correction that keeps a must off the fix is not read" {
  let rows = corr_lane([corr_stopped(), [corr_answer()]])
  inspect(
    corr_describe(accepted_at(rows, 3)),
    content=(
      #|2-blind/F-1:must:fix 2-blind/F-4:should:followup 2-blind/F-6:nit:skip
    ),
  )
}

///|
test "a put-off finding is a follow-up and a set-aside one is a leftover, not a follow-up" {
  let rows = corr_lane([corr_stopped(), [corr_answer()]])
  inspect(
    unfixed_of(rows, 3, None, "", false).stringify(),
    content="{\"accepted\":[{\"ref\":\"2-blind/F-1\",\"severity\":\"must\",\"claim\":\"one\",\"path\":\"a.mbt\",\"action\":\"fix\"}],\"questions\":[],\"reversals\":[]}",
  )
  inspect(
    followups_of(rows).stringify(),
    content=(
      #|[{"severity":"must","claim":"one","path":"a.mbt","round":2,"source":"unsent"},{"severity":"should","claim":"four","judgedSeverity":"must","path":"b.ts","round":2}]
    ),
  )
  inspect(
    submit_leftovers(rows).stringify(),
    content=(
      #|[{"severity":"must","claim":"one","path":"a.mbt","action":"fix"},{"severity":"nit","claim":"six","path":"c.ts","action":"skip","judgedSeverity":"must"}]
    ),
  )
}

///|
test "a later judgement that repeats a corrected finding reads it with the correction" {
  let rows = corr_lane([corr_stopped(), [corr_answer()], corr_next()])
  let t = rows.length() - 1
  let counts = fix_counts(accepted_at(rows, t))
  inspect(
    counts.0.to_string() + "/" + counts.1.to_string(),
    content=(
      #|1/0
    ),
  )
  inspect(
    corr_describe(accepted_at(rows, t)),
    content=(
      #|3-blind/F-5:should:followup 3-blind/F-7:must:fix
    ),
  )
  inspect(
    followups_of(rows).stringify(),
    content=(
      #|[{"severity":"should","claim":"four","judgedSeverity":"must","path":"b.ts","round":2},{"severity":"must","claim":"new","path":"d.ts","round":3,"source":"unsent"}]
    ),
  )
  inspect(
    unfixed_of(rows, t, None, "", false).stringify(),
    content=(
      #|{"accepted":[{"ref":"3-blind/F-7","severity":"must","claim":"new","path":"d.ts","action":"fix"}],"questions":[],"reversals":[]}
    ),
  )
}

///|
test "what an earlier round sent is not added back to the next judgement" {
  let rows = corr_lane([corr_stopped(), [corr_answer()], corr_next()])
  let t = rows.length() - 1
  inspect(
    corr_describe(accepted_at(rows, t)),
    content=(
      #|3-blind/F-5:should:followup 3-blind/F-7:must:fix
    ),
  )
  inspect(
    fix_scope(rows).stringify(),
    content="{\"source\":\"review\",\"all\":false,\"accepted\":[{\"ref\":\"3-blind/F-7\",\"severity\":\"must\",\"claim\":\"new\",\"path\":\"d.ts\",\"action\":\"fix\"}],\"note\":\"\",\"boundaries\":[]}",
  )
}

///|
test "an answer with no corrections reads as it always did" {
  let rows = corr_lane([
    corr_stopped(),
    [
      corr_row(
        "s2_review_resumed", 5, "{\"decision\":\"continue\",\"note\":\"\"}",
      ),
    ],
  ])
  inspect(
    corr_describe(accepted_at(rows, 3)),
    content=(
      #|2-blind/F-1:must:fix 2-blind/F-4:must:fix 2-blind/F-6:must:fix
    ),
  )
}

///|
/// A lane stopped with two nits whose handling is fix; the answer corrects only the first, to a nit that is fixed.
fn corr_nits() -> Array[Array[String]] {
  [
    [
      corr_row("s2_start", 0, "{\"started_from_commit\":\"c0\"}"),
      corr_row("s2_result", 1, "{\"outcome\":\"success\"}"),
      corr_row(
        "s2_review_started", 2, "{\"kind\":\"blind\",\"round\":2,\"run_ids\":[\"b\"],\"head\":\"aaaa\",\"depth\":\"standard\"}",
      ),
      corr_row(
        "s2_triage_done",
        3,
        "{\"kind\":\"blind\",\"round\":2,\"accepted\":[" +
        "{\"ref\":\"F-1\",\"severity\":\"should\",\"claim\":\"one\",\"path\":\"a.mbt\",\"action\":\"followup\"}," +
        "{\"ref\":\"F-2\",\"severity\":\"nit\",\"claim\":\"two\",\"path\":\"b.ts\",\"action\":\"fix\"}]}",
      ),
      corr_row("s2_review_escalated", 4, "{\"reason\":\"x\"}"),
    ],
    [
      corr_row(
        "s2_review_resumed",
        5,
        "{\"decision\":\"continue\",\"note\":\"n\",\"at_by\":\"user\",\"corrections\":[" +
        "{\"ref\":\"2-blind/F-1\",\"severity\":\"nit\",\"action\":\"fix\"}]}",
      ),
    ],
  ]
}

///|
test "a nit penne corrected to fix is sent to the fix and counted as a must; a nit left alone is not" {
  let rows = corr_lane(corr_nits())
  inspect(
    corr_describe(array_of(field(fix_scope(rows), "accepted"))),
    content="2-blind/F-1:nit:fix",
  )
  let (must, should) = fix_counts(accepted_at(rows, 3))
  inspect(must.to_string() + "/" + should.to_string(), content="1/0")
}

///|
test "a finding the judgement left for later is sent to the fix when penne corrects it to fix" {
  // F-1 is a should the judgement sent to a follow-up (corr_nits); penne corrects it to a should that is fixed
  let rows = corr_lane([
    corr_nits()[0],
    [
      corr_row(
        "s2_review_resumed",
        5,
        "{\"decision\":\"continue\",\"note\":\"n\",\"at_by\":\"user\",\"corrections\":[" +
        "{\"ref\":\"2-blind/F-1\",\"severity\":\"should\",\"action\":\"fix\"}]}",
      ),
    ],
  ])
  inspect(
    corr_describe(array_of(field(fix_scope(rows), "accepted"))),
    content=(
      #|2-blind/F-1:should:fix
    ),
  )
  inspect(
    followups_of(rows).stringify(),
    content=(
      #|[{"severity":"should","claim":"one","path":"a.mbt","round":2,"source":"unsent"}]
    ),
  )
}

///|
test "a corrected finding keeps the weight the judgement gave, and a follow-up and a leftover carry it" {
  let rows = corr_lane([corr_stopped(), [corr_answer()]])
  inspect(
    followups_of(rows).stringify(),
    content=(
      #|[{"severity":"must","claim":"one","path":"a.mbt","round":2,"source":"unsent"},{"severity":"should","claim":"four","judgedSeverity":"must","path":"b.ts","round":2}]
    ),
  )
  inspect(
    submit_leftovers(rows).stringify(),
    content=(
      #|[{"severity":"must","claim":"one","path":"a.mbt","action":"fix"},{"severity":"nit","claim":"six","path":"c.ts","action":"skip","judgedSeverity":"must"}]
    ),
  )
  inspect(
    accepted_at(rows, 3).map(fn(x) { x.stringify() }).join("\n"),
    content=(
      #|{"ref":"2-blind/F-1","severity":"must","claim":"one","path":"a.mbt","action":"fix"}
      #|{"ref":"2-blind/F-4","severity":"should","claim":"four","path":"b.ts","action":"followup","judged_severity":"must","corrected":true,"correction_reason":"後に回す"}
      #|{"ref":"2-blind/F-6","severity":"nit","claim":"six","path":"c.ts","action":"skip","judged_severity":"must","corrected":true}
    ),
  )
}
