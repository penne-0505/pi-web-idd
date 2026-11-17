// One lifecycle row as the derivations read it.
//
// The fold keeps its own reading of a row (`LifecycleRow` in `rows.mbt`): the few fields it decides with. A
// derivation reads different fields, and it reads them from `attrs`, which is a free append-only log. So the
// row is read twice from the same JSON, once for each reading, and neither reading decides for the other.

///|
/// One lifecycle row: the lane, what happened, when, and the fields of `attrs` the derivations read.
pub(all) struct DerivedRow {
  idd_id : String
  event : DerivedEvent
  at : String
  attrs : RowAttrs
}

///|
/// One row out of the JSON the caller handed over.
fn derived_row_of(value : Json) -> DerivedRow {
  {
    idd_id: js_string(field(value, "idd_id")),
    event: derived_event_of(js_string(field(value, "event"))),
    at: js_string(field(value, "at")),
    attrs: row_attrs_of(field(value, "attrs")),
  }
}

///|
/// Whether a row sends the lane back to its plan: the card's "計画から考え直す" (`s1_replan_requested`), or a rejection
/// at the review that records the plan as where it goes (`s3_reject` with `next_stage` `s1_rethink`). A rejection
/// that names no place, or any other, sends the lane back to its implementation.
fn returns_to_plan(row : DerivedRow) -> Bool {
  row.event == EvS1ReplanRequested ||
  (row.event == EvS3Reject && is_text(row.attrs.next_stage, "s1_rethink"))
}

///|
/// The index of the last row that sends the lane back to its plan, or -1.
fn last_return_to_plan(rows : Array[DerivedRow]) -> Int {
  let mut i = rows.length() - 1
  while i >= 0 {
    if returns_to_plan(rows[i]) {
      return i
    }
    i = i - 1
  }
  -1
}

///|
/// The first `n` rows: the derivations ask the same question of a lane's record as it stood at each step.
fn prefix_rows(rows : Array[DerivedRow], n : Int) -> Array[DerivedRow] {
  let out : Array[DerivedRow] = []
  let mut i = 0
  while i < n && i < rows.length() {
    out.push(rows[i])
    i = i + 1
  }
  out
}

///|
/// The rows without the ones that only note something on the lane.
fn without_note_rows(rows : Array[DerivedRow]) -> Array[DerivedRow] {
  let out : Array[DerivedRow] = []
  for row in rows {
    if !is_note_event(row.event) {
      out.push(row)
    }
  }
  out
}
