// Comparing two rows' instants.
//
// The fold asks whether a row was written before a lane merged or ended, and which of two instants came
// first. The answer decides what a viewer sees, so it must be the answer the TypeScript fold gives: the
// same `Date.parse`, and the same fallback to comparing the strings when a value is not a readable time.
// The parse itself is the one thing that is carried over the boundary: reading a date is the host's rule,
// not the fold's, and a second reading of dates here would be a second answer.
//
// The string fallback goes over the boundary for the same reason. The comparison the TypeScript fold makes
// (`a <= b`) is the host's own ordering of strings, and MoonBit's `Compare` for `String` is not that order:
// it compares the lengths first, so `"b"` sorts below `"aa"` here and above it there. A row whose `at`
// cannot be read would then land on one side of a boundary for one viewer and on the other side for the
// other. So the ordering is asked of the host too, and only the branch between the two comparisons stays
// on this side.

///|
/// `Date.parse`, as the host reads it: milliseconds from the epoch, or NaN when the value is not a time.
extern "js" fn host_date_ms(text : String) -> Double = "(text) => { const ms = Date.parse(text); return Number.isNaN(ms) ? NaN : ms; }"

///|
/// The host's ordering of two strings: -1 when `a` comes first, 1 when `b` does, 0 when they are equal.
extern "js" fn host_text_order(a : String, b : String) -> Int = "(a, b) => { return a < b ? -1 : a > b ? 1 : 0; }"

///|
/// `new Date(ms).toISOString()`: the host's own rendering of an instant, as the order check writes it down.
extern "js" fn host_iso_time(ms : Double) -> String = "(ms) => new Date(ms).toISOString()"

///|
/// One row's `at`, kept both as it was written (it is handed back to the caller as it came) and as the
/// instant it names.
priv struct Stamp {
  json : Json
  text : String
  ms : Double
}

///|
/// The stamp of a row's `at` field.
fn stamp_of(value : Json) -> Stamp {
  let text = string_of(value)
  { json: value, text, ms: host_date_ms(text), }
}

///|
/// Whether `a` is at or before `b`: by the instant when both are readable times, else in the host's string order.
fn stamp_le(a : Stamp, b : Stamp) -> Bool {
  if !a.ms.is_nan() && !b.ms.is_nan() {
    a.ms <= b.ms
  } else {
    host_text_order(a.text, b.text) <= 0
  }
}

///|
/// Whether `a` is strictly after `b`, read the same way as `stamp_le`.
fn stamp_after(a : Stamp, b : Stamp) -> Bool {
  if !a.ms.is_nan() && !b.ms.is_nan() {
    a.ms > b.ms
  } else {
    host_text_order(a.text, b.text) > 0
  }
}

///|
/// The earlier of two stamps; the first one when they name the same instant.
fn earlier_stamp(a : Stamp?, b : Stamp) -> Stamp {
  match a {
    None => b
    Some(first) => if stamp_le(first, b) { first } else { b }
  }
}
