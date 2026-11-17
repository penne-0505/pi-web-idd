// The events the fold reads, as a closed type.
//
// A row's `event` is a name that comes from a file, so the boundary reads it once and turns it into one
// of these. A name the fold has no reading for keeps its own value (`OtherLifecycle` / `OtherIntent`): the
// columns hold old rows and rows written by hand, and both folds skip a name they do not read. The gain is
// that a name the fold *does* read is a variant, so the fold can be written with every variant listed and
// no catch-all — adding a variant then stops the build until the fold says what it does with it.

///|
/// The lifecycle's events: the ones the lane state reads, and every other name as it came in.
pub(all) enum LifecycleEvent {
  LaneClose
  S1Defer
  S3Defer
  S1Go
  OtherLifecycle(String)
}

///|
/// The intent column's events: the ones the records fold reads, and every other name as it came in.
pub(all) enum IntentEvent {
  PurposeRaised
  PurposeRestated
  PurposeConfirmed
  PurposeRetired
  PurposeWithdrawn
  ChoiceRaised
  ChoiceSuperseded
  ChoiceReanchored
  PlacesMoved
  PlacesModule
  ChoiceConfirmed
  ChoiceDropped
  Waive
  HarmExampleAdded
  OtherIntent(String)
}

///|
/// The lifecycle event a name stands for. A name the fold does not read is kept as it is.
fn lifecycle_event_of(name : String) -> LifecycleEvent {
  match name {
    "lane_close" => LaneClose
    "s1_defer" => S1Defer
    "s3_defer" => S3Defer
    "s1_go" => S1Go
    other => OtherLifecycle(other)
  }
}

///|
/// The intent event a name stands for. A name the fold does not read is kept as it is.
fn intent_event_of(name : String) -> IntentEvent {
  match name {
    "purpose_raised" => PurposeRaised
    "purpose_restated" => PurposeRestated
    "purpose_confirmed" => PurposeConfirmed
    "purpose_retired" => PurposeRetired
    "purpose_withdrawn" => PurposeWithdrawn
    "choice_raised" => ChoiceRaised
    "choice_superseded" => ChoiceSuperseded
    "choice_reanchored" => ChoiceReanchored
    "places_moved" => PlacesMoved
    "places_module" => PlacesModule
    "choice_confirmed" => ChoiceConfirmed
    "choice_dropped" => ChoiceDropped
    "waive" => Waive
    "harm_example_added" => HarmExampleAdded
    other => OtherIntent(other)
  }
}
