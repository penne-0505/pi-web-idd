// The landing's four readings, in the fold's own words.
//
// The wider promise — that these answers are the ones the TypeScript reading gave — is held by the fixture test
// (`packages/idd-core/test/land-reads-moonbit.test.mjs`) and against a real ledger (`crosscheck.mjs`). These say
// what each reading does with a row the ledger does not carry.

///|
/// One derived row out of its JSON text.
fn derived_row(text : String) -> DerivedRow {
  derived_row_of(
    @json.parse(text) catch {
      error => abort("テストの行が JSON ではありません: \{error}")
    },
  )
}

///|
/// A lane's rows out of their JSON texts.
fn derived_rows(texts : Array[String]) -> Array[DerivedRow] {
  let rows : Array[DerivedRow] = []
  for text in texts {
    rows.push(derived_row(text))
  }
  rows
}

///|
test "an approval without the signature's mark is no approval, and a signed one carries its place and close" {
  let unmarked = derived_rows([
    "{\"idd_id\":\"L\",\"event\":\"s4_land_approved\",\"at\":\"2026-10-19T09:00:00+09:00\",\"attrs\":{\"head\":\"aaa\"}}",
    "{\"idd_id\":\"L\",\"event\":\"s4_land_approved\",\"at\":\"2026-10-19T09:01:00+09:00\",\"attrs\":{\"signed\":\"true\",\"head\":\"aaa\"}}",
  ])
  inspect(
    land_approval(unmarked).stringify(),
    content=(
      #|null
    ),
  )
  let signed = derived_rows([
    "{\"idd_id\":\"L\",\"event\":\"s2_start\",\"at\":\"2026-10-19T09:00:00+09:00\",\"attrs\":{}}",
    "{\"idd_id\":\"L\",\"event\":\"s4_land_approved\",\"at\":\"2026-10-19T09:01:00+09:00\",\"attrs\":{\"signed\":true,\"head\":\"bbb\",\"close\":{\"repo\":\"r\",\"issue\":\"7\",\"comment\":\"c\",\"url\":\"u\"}}}",
  ])
  inspect(
    land_approval(signed).stringify(),
    content=(
      #|{"head":"bbb","at":1,"close":{"repo":"r","issue":7,"comment":"c","url":"u"}}
    ),
  )
  // a close that is an array, or an issue that is not a whole number above 0, is no close the tick may run
  let broken = derived_rows([
    "{\"idd_id\":\"L\",\"event\":\"s4_land_approved\",\"at\":\"2026-10-19T09:00:00+09:00\",\"attrs\":{\"signed\":true,\"head\":\"bbb\",\"close\":[]}}",
    "{\"idd_id\":\"L\",\"event\":\"s4_land_approved\",\"at\":\"2026-10-19T09:01:00+09:00\",\"attrs\":{\"signed\":true,\"head\":\"bbb\",\"close\":{\"repo\":\"r\",\"issue\":0,\"comment\":\"c\"}}}",
  ])
  inspect(
    land_approval(broken).stringify(),
    content=(
      #|{"head":"bbb","at":1}
    ),
  )
}

///|
test "an event after the approval takes it back, and a head that is not a non-empty string is no approval" {
  let killed = derived_rows([
    "{\"idd_id\":\"L\",\"event\":\"s4_land_approved\",\"at\":\"2026-10-19T09:00:00+09:00\",\"attrs\":{\"signed\":true,\"head\":\"bbb\"}}",
    "{\"idd_id\":\"L\",\"event\":\"s4_land_approval_dropped\",\"at\":\"2026-10-19T09:01:00+09:00\",\"attrs\":{}}",
  ])
  inspect(
    land_approval(killed).stringify(),
    content=(
      #|null
    ),
  )
  let empty_head = derived_rows([
    "{\"idd_id\":\"L\",\"event\":\"s4_land_approved\",\"at\":\"2026-10-19T09:00:00+09:00\",\"attrs\":{\"signed\":true,\"head\":\"\"}}",
    "{\"idd_id\":\"L\",\"event\":\"s4_land_approved\",\"at\":\"2026-10-19T09:01:00+09:00\",\"attrs\":{\"signed\":true,\"head\":42}}",
  ])
  inspect(
    land_approval(empty_head).stringify(),
    content=(
      #|null
    ),
  )
}

///|
test "the landing's hold is the last hold's reason, as text" {
  let rows = derived_rows([
    "{\"idd_id\":\"L\",\"event\":\"s4_land_hold\",\"at\":\"2026-10-19T09:00:00+09:00\",\"attrs\":{\"reason\":\"dirty\"}}",
    "{\"idd_id\":\"L\",\"event\":\"s4_land_hold\",\"at\":\"2026-10-19T09:01:00+09:00\",\"attrs\":{\"reason\":42}}",
  ])
  inspect(
    land_hold(rows),
    content=(
      #|42
    ),
  )
  inspect(
    land_hold(
      derived_rows([
        "{\"idd_id\":\"L\",\"event\":\"s2_start\",\"at\":\"2026-10-19T09:00:00+09:00\",\"attrs\":{}}",
      ]),
    ),
    content="",
  )
}

///|
test "the head S3 and R2 last saw is the R2's, the review's, or the submit's, in that order" {
  let r2 = derived_rows([
    "{\"idd_id\":\"L\",\"event\":\"s2_review_started\",\"at\":\"2026-10-19T09:00:00+09:00\",\"attrs\":{\"head\":\"review\"}}",
    "{\"idd_id\":\"L\",\"event\":\"s3_ready\",\"at\":\"2026-10-19T09:01:00+09:00\",\"attrs\":{}}",
    "{\"idd_id\":\"L\",\"event\":\"s3_r2_started\",\"at\":\"2026-10-19T09:02:00+09:00\",\"attrs\":{\"head\":\"r2\"}}",
  ])
  inspect(
    reviewed_head(r2).stringify(),
    content=(
      #|{"commit":"r2","by":"R2 が見た"}
    ),
  )
  let review = derived_rows([
    "{\"idd_id\":\"L\",\"event\":\"s2_review_started\",\"at\":\"2026-10-19T09:00:00+09:00\",\"attrs\":{\"head\":\"review\"}}",
    "{\"idd_id\":\"L\",\"event\":\"s3_ready\",\"at\":\"2026-10-19T09:01:00+09:00\",\"attrs\":{}}",
    "{\"idd_id\":\"L\",\"event\":\"s3_r2_started\",\"at\":\"2026-10-19T09:02:00+09:00\",\"attrs\":{}}",
  ])
  inspect(
    reviewed_head(review).stringify(),
    content=(
      #|{"commit":"review","by":"最後のレビューが見た"}
    ),
  )
  let opened = derived_rows([
    "{\"idd_id\":\"L\",\"event\":\"s2_review_started\",\"at\":\"2026-10-19T09:00:00+09:00\",\"attrs\":{}}",
    "{\"idd_id\":\"L\",\"event\":\"s4_submit_started\",\"at\":\"2026-10-19T09:01:00+09:00\",\"attrs\":{\"head\":\"opened\"}}",
  ])
  inspect(
    reviewed_head(opened).stringify(),
    content=(
      #|{"commit":"opened","by":"提出前確認を開いたときの"}
    ),
  )
  let none = derived_rows([
    "{\"idd_id\":\"L\",\"event\":\"s2_review_started\",\"at\":\"2026-10-19T09:00:00+09:00\",\"attrs\":{}}",
  ])
  inspect(
    reviewed_head(none).stringify(),
    content=(
      #|null
    ),
  )
}

///|
test "a row's attrs are read through the declaration, and a key it does not hold is dropped" {
  let attrs = row_attrs_of(
    @json.parse(
      "{\"head\":\"aaa\",\"signed\":true,\"reason\":42,\"not_declared\":\"x\"}",
    ),
  )
  inspect(
    attrs.head.stringify(),
    content=(
      #|"aaa"
    ),
  )
  inspect(
    is_signed(attrs),
    content=(
      #|true
    ),
  )
  inspect(
    attrs.reason.stringify(),
    content=(
      #|42
    ),
  )
  // an attrs that is not an object, and a row that carries none, read every declared field as nothing
  let none = row_attrs_of(Json::string("broken"))
  inspect(
    none.head.stringify(),
    content=(
      #|null
    ),
  )
  inspect(
    is_signed(none),
    content=(
      #|false
    ),
  )
}
