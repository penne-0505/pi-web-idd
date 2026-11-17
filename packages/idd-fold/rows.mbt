// A row, read out of the JSON the caller handed over.
//
// The rows are handed over once and kept: the caller reads the columns with its own incremental reader and
// sends a row the fold has not been given yet, so a read costs the added rows rather than the whole column
// (the same reason the caller's own reader keeps what it parsed). A row keeps the fields the fold decides
// with, and the fields the fold only hands back (`forms`, `origin`, `by`, `at`) as the JSON they came as, so
// the answer carries what was written and not this side's rendering of it.

///|
/// One Purpose a lane's GO named, as the lane state keeps it.
priv struct LifecyclePurpose {
  id : String
  name : String?
}

///|
/// One lifecycle row: the lane it belongs to, what happened, when, and the lane's GO purposes.
priv struct LifecycleRow {
  idd_id : String
  event : LifecycleEvent
  at : Stamp
  /// the `lane_close` outcome, as written: `merged` and `local` are the two that land the lane
  outcome : LaneOutcome
  /// the Purposes an `s1_go` named; nothing when the row carries no list at all
  purposes : Array[LifecyclePurpose]?
}

///|
/// One entry of a raise's `supersedes` list.
priv struct Supersede {
  id : String
  grounds : String?
}

///|
/// One intent row. The fields the fold does not decide with are kept as written, to be handed back.
priv struct IntentRow {
  event : IntentEvent
  at : Stamp
  at_present : Bool
  by_json : Json
  by_present : Bool
  by_lane : String?
  id : String?
  statement : String?
  origin_text : String?
  name : String?
  status : IntentStatus
  grounds : String?
  purpose : String?
  forms : Json
  place : Json
  why : String?
  anchored : String?
  free : String?
  revisit : String?
  verification : Array[String]?
  visibility : Visibility
  supersedes : Array[Supersede]
  no_why_not : String?
  moves : Array[PlaceMove]
  kind : RowKind
  choices : Array[String]?
  reason : String?
  change : String?
  harm : Int?
  always_must : Bool
  origin_json : Json
}

///|
/// The Purposes an `s1_go` names: each keeps the id it names, and the name when it gives one.
fn purposes_of(value : Json) -> Array[LifecyclePurpose]? {
  match value {
    Json::Array(items) => {
      let out : Array[LifecyclePurpose] = []
      for item in items {
        match trimmed_of(field(item, "id")) {
          None => ()
          Some(id) => out.push({ id, name: trimmed_of(field(item, "name")), })
        }
      }
      Some(out)
    }
    _ => None
  }
}

///|
/// One lifecycle row out of its JSON.
fn lifecycle_row_of(value : Json) -> LifecycleRow {
  let event = lifecycle_event_of(string_of(field(value, "event")))
  let purposes = match event {
    S1Go => purposes_of(field(field(value, "attrs"), "purposes"))
    _ => None
  }
  {
    idd_id: string_of(field(value, "idd_id")),
    event,
    at: stamp_of(field(value, "at")),
    outcome: lane_outcome_of(field(field(value, "attrs"), "outcome")),
    purposes,
  }
}

///|
/// The lane a row's own `by` names, or nothing. A row written before `by` existed carries none.
fn lane_of(value : Json) -> String? {
  match object_of(value) {
    None => None
    Some(_) =>
      match field(value, "lane") {
        Json::String(lane) => if lane == "" { None } else { Some(lane) }
        Json::False => None
        Json::Number(number, ..) =>
          if number == 0.0 {
            None
          } else {
            Some(js_string(field(value, "lane")))
          }
        Json::Null => None
        other => Some(js_string(other))
      }
  }
}

///|
/// The ids a raise's `supersedes` list names, each with the grounds it gives.
fn supersedes_of(value : Json) -> Array[Supersede] {
  let out : Array[Supersede] = []
  for item in array_of(value) {
    match trimmed_of(field(item, "id")) {
      None => ()
      Some(id) => out.push({ id, grounds: trimmed_of(field(item, "grounds")), })
    }
  }
  out
}

///|
/// The moves a `places_moved` row carries: a from and a to, both written.
fn moves_of(value : Json) -> Array[PlaceMove] {
  let out : Array[PlaceMove] = []
  for item in array_of(value) {
    match (trimmed_of(field(item, "from")), trimmed_of(field(item, "to"))) {
      (Some(from), Some(to)) => out.push({ from, to, })
      _ => ()
    }
  }
  out
}

///|
/// The verification anchors a raise names: the strings among them, as written.
fn verification_of(value : Json) -> Array[String]? {
  match value {
    Json::Array(items) =>
      if items.length() == 0 {
        None
      } else {
        let out : Array[String] = []
        for item in items {
          match item {
            Json::String(text) =>
              if text.trim() == "" {
                ()
              } else {
                out.push(text)
              }
            _ => ()
          }
        }
        Some(out)
      }
    _ => None
  }
}

///|
/// The harm a harm example declares: only 1, 2 and 3 stand for a weight.
fn harm_of(value : Json) -> Int? {
  match int_of(value) {
    Some(weight) =>
      if weight == 1 || weight == 2 || weight == 3 {
        Some(weight)
      } else {
        None
      }
    None => None
  }
}

///|
/// One intent row out of its JSON.
fn intent_row_of(value : Json) -> IntentRow {
  let choices = match field(value, "choices") {
    Json::Array(_) => Some(strings_of(field(value, "choices")))
    _ => None
  }
  {
    event: intent_event_of(string_of(field(value, "event"))),
    at: stamp_of(field(value, "at")),
    at_present: has_key(value, "at"),
    by_json: field(value, "by"),
    by_present: has_key(value, "by"),
    by_lane: lane_of(field(value, "by")),
    id: trimmed_of(field(value, "id")),
    statement: trimmed_of(field(value, "statement")),
    origin_text: trimmed_of(field(value, "origin")),
    name: trimmed_of(field(value, "name")),
    status: intent_status_of(field(value, "status")),
    grounds: trimmed_of(field(value, "grounds")),
    purpose: trimmed_of(field(value, "purpose")),
    forms: field(value, "forms"),
    place: field(value, "place"),
    why: trimmed_of(field(value, "why")),
    anchored: trimmed_of(field(value, "anchored")),
    free: trimmed_of(field(value, "free")),
    revisit: trimmed_of(field(value, "revisit")),
    verification: verification_of(field(value, "verification")),
    visibility: visibility_of(field(value, "visibility")),
    supersedes: supersedes_of(field(value, "supersedes")),
    no_why_not: trimmed_of(field(value, "no_why_not")),
    moves: moves_of(field(value, "moves")),
    kind: row_kind_of(field(value, "kind")),
    choices,
    reason: trimmed_of(field(value, "reason")),
    change: trimmed_of(field(value, "change")),
    harm: harm_of(field(value, "harm")),
    always_must: match field(value, "always_must") {
      Json::True => true
      _ => false
    },
    origin_json: field(value, "origin"),
  }
}
