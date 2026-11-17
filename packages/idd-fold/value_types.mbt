// The values the fold keeps as state, as closed types.
//
// A column's line is written by many hands: a status, a kind or an outcome may hold a value no writer today
// knows. Keeping them as `String` lets a value be added without the fold saying what it does with it — the
// compiler cannot see a missing case in a string. So each becomes a closed type here, and a value the type does
// not name keeps its own text as one variant (`Other…`), which is what the TypeScript fold hands through. The
// gain: adding a variant stops `moon check --deny-warn` until every match says what it does with it (C-191-3).

///|
/// A Choice's status.
pub(all) enum ChoiceStatus {
  ChoiceActive
  ChoiceUnconfirmed
  ChoiceSuperseded
  ChoiceDropped
  OtherChoiceStatus(String)
} derive(Eq)

///|
/// The status's own text.
fn choice_status_text(status : ChoiceStatus) -> String {
  match status {
    ChoiceActive => "active"
    ChoiceUnconfirmed => "unconfirmed"
    ChoiceSuperseded => "superseded"
    ChoiceDropped => "dropped"
    OtherChoiceStatus(text) => text
  }
}

///|
/// Whether a status is one of the two the fold still moves: an active or an unconfirmed Choice.
fn choice_status_open(status : ChoiceStatus) -> Bool {
  match status {
    ChoiceActive => true
    ChoiceUnconfirmed => true
    ChoiceSuperseded => false
    ChoiceDropped => false
    OtherChoiceStatus(_) => false
  }
}

///|
/// A Purpose's status.
pub(all) enum PurposeStatus {
  StatusActive
  StatusProposed
  StatusRetired
  StatusWithdrawn
  OtherPurposeStatus(String)
} derive(Eq)

///|
/// The status's own text.
fn purpose_status_text(status : PurposeStatus) -> String {
  match status {
    StatusActive => "active"
    StatusProposed => "proposed"
    StatusRetired => "retired"
    StatusWithdrawn => "withdrawn"
    OtherPurposeStatus(text) => text
  }
}

///|
/// A Waive's kind.
pub(all) enum WaiveKind {
  WaiveApplied
  WaiveNoChoice
  OtherWaiveKind(String)
} derive(Eq)

///|
/// The kind's own text.
fn waive_kind_text(kind : WaiveKind) -> String {
  match kind {
    WaiveApplied => "applied"
    WaiveNoChoice => "no-choice"
    OtherWaiveKind(text) => text
  }
}

///|
/// A Place's kind, as a row writes it.
pub(all) enum PlaceKind {
  PlaceRoot
  PlaceModule
  PlaceFile
  PlaceDir
  OtherPlaceKind(String)
} derive(Eq)

///|
/// The kind's own text.
fn place_kind_text(kind : PlaceKind) -> String {
  match kind {
    PlaceRoot => "root"
    PlaceModule => "module"
    PlaceFile => "file"
    PlaceDir => "dir"
    OtherPlaceKind(text) => text
  }
}

///|
/// The kind a text names.
fn place_kind_of(value : Json) -> PlaceKind {
  match value {
    Json::String(text) =>
      if text == "root" {
        PlaceRoot
      } else if text == "module" {
        PlaceModule
      } else if text == "file" {
        PlaceFile
      } else if text == "dir" {
        PlaceDir
      } else {
        OtherPlaceKind(text)
      }
    other => OtherPlaceKind(js_string(other))
  }
}

///|
/// A `lane_close` outcome.
pub(all) enum LaneOutcome {
  OutcomeMerged
  OutcomeLocal
  OutcomeAborted
  OutcomeDropped
  OtherLaneOutcome(String)
} derive(Eq)

///|
/// The outcome a text names.
fn lane_outcome_of(value : Json) -> LaneOutcome {
  match value {
    Json::String(text) =>
      if text == "merged" {
        OutcomeMerged
      } else if text == "local" {
        OutcomeLocal
      } else if text == "aborted" {
        OutcomeAborted
      } else if text == "dropped" {
        OutcomeDropped
      } else {
        OtherLaneOutcome(text)
      }
    other => OtherLaneOutcome(js_string(other))
  }
}

///|
/// A row's own `status`, as a raise writes it. The fold only decides with `proposed` and `unconfirmed`; anything
/// else keeps its text.
pub(all) enum IntentStatus {
  IntentProposed
  IntentUnconfirmed
  OtherIntentStatus(String)
} derive(Eq)

///|
/// The status a value names.
fn intent_status_of(value : Json) -> IntentStatus {
  match value {
    Json::String(text) =>
      if text == "proposed" {
        IntentProposed
      } else if text == "unconfirmed" {
        IntentUnconfirmed
      } else {
        OtherIntentStatus(text)
      }
    other => OtherIntentStatus(js_string(other))
  }
}

///|
/// A raise's visibility. The answer only ever says `public` or `private`; the value the row wrote is kept here.
pub(all) enum Visibility {
  VisibilityPublic
  OtherVisibility(String)
} derive(Eq)

///|
/// The visibility a value names.
fn visibility_of(value : Json) -> Visibility {
  match value {
    Json::String(text) =>
      if text == "public" {
        VisibilityPublic
      } else {
        OtherVisibility(text)
      }
    other => OtherVisibility(js_string(other))
  }
}

///|
/// The visibility the answer carries: a row's `public` is public, everything else is private.
fn visibility_text(visibility : Visibility) -> String {
  match visibility {
    VisibilityPublic => "public"
    OtherVisibility(_) => "private"
  }
}

///|
/// A Waive row's own `kind`, as the raise wrote it.
pub(all) enum RowKind {
  RowApplied
  RowNoChoice
  OtherRowKind(String)
} derive(Eq)

///|
/// The kind a value names.
fn row_kind_of(value : Json) -> RowKind {
  match value {
    Json::String(text) =>
      if text == "applied" {
        RowApplied
      } else if text == "no-choice" {
        RowNoChoice
      } else {
        OtherRowKind(text)
      }
    other => OtherRowKind(js_string(other))
  }
}
