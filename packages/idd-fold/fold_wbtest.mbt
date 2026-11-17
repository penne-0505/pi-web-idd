// The fold's own tests: one case at a time, with the answer written next to the call.
//
// These say what the fold does, in the fold's own words. The wider promise — that this answer is the same one
// the TypeScript fold gave — is held by the cross-check against committed fixtures (the TypeScript test group)
// and against a real ledger (`crosscheck.mjs`).

///|
/// One intent row out of its JSON text.
fn row(text : String) -> IntentRow {
  intent_row_of(
    @json.parse(text) catch {
      error => abort("テストの行が JSON ではありません: \{error}")
    },
  )
}

///|
/// One lifecycle row out of its JSON text.
fn event(text : String) -> LifecycleRow {
  lifecycle_row_of(
    @json.parse(text) catch {
      error => abort("テストの行が JSON ではありません: \{error}")
    },
  )
}

///|
/// The lane states of the given lifecycle rows.
fn states_of(events : Array[LifecycleRow]) -> Map[String, LaneState] {
  let states : Map[String, LaneState] = Map([])
  for row in events {
    note_lane_row(states, row)
  }
  states
}

///|
/// The Places as the JSON the answer carries them as.
fn places_json(places : Array[Place]) -> String {
  let writer = JsonWriter::new()
  writer.items(places, write_place)
  writer.text()
}

///|
/// The records the given rows fold into, as one viewer sees them.
fn folded(
  rows : Array[IntentRow],
  viewer : String?,
  states : Map[String, LaneState],
) -> String {
  fold_records_of(rows, viewer, states)
}

///|
test "a merge lands the lane at the earliest lane_close" {
  let states = states_of([
    event(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_close\",\"at\":\"2026-10-18T10:00:00.000Z\",\"attrs\":{\"outcome\":\"merged\"}}",
    ),
    event(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_close\",\"at\":\"2026-10-18T09:00:00.000Z\",\"attrs\":{\"outcome\":\"merged\"}}",
    ),
  ])
  inspect(
    lane_states_json(states).stringify(),
    content=(
      #|{"IDD-1":{"mergedAt":"2026-10-18T09:00:00.000Z","endedAt":"2026-10-18T09:00:00.000Z"}}
    ),
  )
}

///|
test "a lane that ended without landing has no merge" {
  let states = states_of([
    event(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_close\",\"at\":\"2026-10-18T10:00:00.000Z\",\"attrs\":{\"outcome\":\"aborted\"}}",
    ),
  ])
  inspect(
    lane_states_json(states).stringify(),
    content=(
      #|{"IDD-1":{"endedAt":"2026-10-18T10:00:00.000Z"}}
    ),
  )
}

///|
test "a defer ends the lane" {
  let states = states_of([
    event(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s3_defer\",\"at\":\"2026-10-18T10:00:00.000Z\",\"attrs\":{}}",
    ),
  ])
  inspect(
    lane_states_json(states).stringify(),
    content=(
      #|{"IDD-1":{"endedAt":"2026-10-18T10:00:00.000Z"}}
    ),
  )
}

///|
test "the GO's purposes add up in the order they were written" {
  let states = states_of([
    event(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-18T10:00:00.000Z\",\"attrs\":{\"purposes\":[{\"id\":\"P-4\",\"name\":\"記録\"}]}}",
    ),
    event(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-18T11:00:00.000Z\",\"attrs\":{\"purposes\":[{\"id\":\"P-8\"},{\"id\":\"\"}]}}",
    ),
  ])
  inspect(
    lane_states_json(states).stringify(),
    content=(
      #|{"IDD-1":{"purposes":[{"id":"P-4","name":"記録"},{"id":"P-8"}]}}
    ),
  )
}

///|
test "a lane's row is effective to the lane until it ends, to others after it merges" {
  let states = states_of([
    event(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_close\",\"at\":\"2026-10-18T10:00:00.000Z\",\"attrs\":{\"outcome\":\"merged\"}}",
    ),
  ])
  let rows = [
    row(
      "{\"event\":\"purpose_raised\",\"at\":\"2026-10-18T09:00:00.000Z\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"P-4\",\"statement\":\"前\",\"origin\":\"plan\"}",
    ),
    row(
      "{\"event\":\"purpose_raised\",\"at\":\"2026-10-18T11:00:00.000Z\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"P-5\",\"statement\":\"後\",\"origin\":\"plan\"}",
    ),
  ]
  inspect(
    folded(rows, Some("IDD-1"), states),
    content=(
      #|{"purposes":[{"id":"P-4","statement":"前","origin":"plan","status":"active","raised":{"by":{"lane":"IDD-1"},"at":"2026-10-18T09:00:00.000Z"}}],"choices":[],"waives":[],"harmExamples":[]}
    ),
  )
  inspect(
    folded(rows, None, states),
    content=(
      #|{"purposes":[{"id":"P-4","statement":"前","origin":"plan","status":"active","raised":{"by":{"lane":"IDD-1"},"at":"2026-10-18T09:00:00.000Z"}}],"choices":[],"waives":[],"harmExamples":[]}
    ),
  )
}

///|
test "a row without by folds for everyone" {
  let rows = [
    row(
      "{\"event\":\"purpose_raised\",\"at\":\"2026-10-18T09:00:00.000Z\",\"id\":\"P-1\",\"statement\":\"概要\",\"origin\":\"plan\"}",
    ),
  ]
  inspect(
    folded(rows, None, Map([])),
    content=(
      #|{"purposes":[{"id":"P-1","statement":"概要","origin":"plan","status":"active","raised":{"at":"2026-10-18T09:00:00.000Z"}}],"choices":[],"waives":[],"harmExamples":[]}
    ),
  )
}

///|
test "a purpose's name comes from the lane's GO, then from the row" {
  let states = states_of([
    event(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-18T10:00:00.000Z\",\"attrs\":{\"purposes\":[{\"id\":\"P-4\",\"name\":\"記録\"}]}}",
    ),
  ])
  let rows = [
    row(
      "{\"event\":\"purpose_raised\",\"at\":\"2026-10-18T09:00:00.000Z\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"P-4\",\"statement\":\"文\",\"origin\":\"plan\",\"status\":\"proposed\"}",
    ),
    row(
      "{\"event\":\"purpose_retired\",\"at\":\"2026-10-18T09:30:00.000Z\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"P-4\",\"grounds\":\"済んだ\"}",
    ),
  ]
  inspect(
    folded(rows, Some("IDD-1"), states),
    content=(
      #|{"purposes":[{"id":"P-4","statement":"文","origin":"plan","name":"記録","status":"retired","raised":{"by":{"lane":"IDD-1"},"at":"2026-10-18T09:00:00.000Z"},"grounds":"済んだ"}],"choices":[],"waives":[],"harmExamples":[]}
    ),
  )
}

///|
test "a person's restatement replaces a proposal's sentence and keeps the planner's" {
  let states = states_of([])
  let rows = [
    row(
      "{\"event\":\"purpose_raised\",\"at\":\"2026-10-18T09:00:00.000Z\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"P-4\",\"statement\":\"計画役の文\",\"origin\":\"plan\",\"status\":\"proposed\"}",
    ),
    row(
      "{\"event\":\"purpose_restated\",\"at\":\"2026-10-18T09:10:00.000Z\",\"by\":{\"session\":\"inbox\"},\"id\":\"P-4\",\"statement\":\"人の文\"}",
    ),
    row(
      "{\"event\":\"purpose_restated\",\"at\":\"2026-10-18T09:20:00.000Z\",\"by\":{\"session\":\"inbox\"},\"id\":\"P-4\",\"statement\":\"人の文 2\"}",
    ),
  ]
  inspect(
    folded(rows, Some("IDD-1"), states),
    content=(
      #|{"purposes":[{"id":"P-4","statement":"人の文 2","origin":"plan","raised_statement":"計画役の文","restated":{"by":{"session":"inbox"},"at":"2026-10-18T09:20:00.000Z"},"status":"proposed","raised":{"by":{"lane":"IDD-1"},"at":"2026-10-18T09:00:00.000Z"}}],"choices":[],"waives":[],"harmExamples":[]}
    ),
  )
  inspect(
    folded(rows, None, states),
    content=(
      #|{"purposes":[],"choices":[],"waives":[],"harmExamples":[]}
    ),
  )
}

///|
test "a withdrawn proposal is neither a proposal nor active, and keeps its grounds" {
  let states = states_of([])
  let rows = [
    row(
      "{\"event\":\"purpose_raised\",\"at\":\"2026-10-18T09:00:00.000Z\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"P-4\",\"statement\":\"文\",\"origin\":\"plan\",\"status\":\"proposed\"}",
    ),
    row(
      "{\"event\":\"purpose_withdrawn\",\"at\":\"2026-10-18T09:10:00.000Z\",\"by\":{\"session\":\"inbox\"},\"id\":\"P-4\",\"grounds\":\"出典に無い\"}",
    ),
    row(
      "{\"event\":\"purpose_raised\",\"at\":\"2026-10-18T09:20:00.000Z\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"P-5\",\"statement\":\"active\",\"origin\":\"plan\"}",
    ),
    row(
      "{\"event\":\"purpose_withdrawn\",\"at\":\"2026-10-18T09:30:00.000Z\",\"by\":{\"session\":\"inbox\"},\"id\":\"P-5\",\"grounds\":\"効かない\"}",
    ),
  ]
  inspect(
    folded(rows, Some("IDD-1"), states),
    content=(
      #|{"purposes":[{"id":"P-4","statement":"文","origin":"plan","status":"withdrawn","raised":{"by":{"lane":"IDD-1"},"at":"2026-10-18T09:00:00.000Z"},"grounds":"出典に無い"},{"id":"P-5","statement":"active","origin":"plan","status":"active","raised":{"by":{"lane":"IDD-1"},"at":"2026-10-18T09:20:00.000Z"}}],"choices":[],"waives":[],"harmExamples":[]}
    ),
  )
}

///|
test "a Choice keeps its history as the column writes it" {
  let rows = [
    row(
      "{\"event\":\"choice_raised\",\"at\":\"2026-10-18T09:00:00.000Z\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"C-1-1\",\"purpose\":\"P-4\",\"forms\":{\"chosen\":\"形\",\"rejected\":[]},\"place\":[{\"path\":\"a/b.mbt\",\"kind\":\"file\"}],\"why\":\"理由\",\"anchored\":\"契約\",\"status\":\"unconfirmed\"}",
    ),
    row(
      "{\"event\":\"choice_reanchored\",\"at\":\"2026-10-18T09:10:00.000Z\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"C-1-1\",\"place\":[{\"path\":\"a\",\"kind\":\"module\"}]}",
    ),
    row(
      "{\"event\":\"choice_confirmed\",\"at\":\"2026-10-18T09:20:00.000Z\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"C-1-1\"}",
    ),
    row(
      "{\"event\":\"choice_dropped\",\"at\":\"2026-10-18T09:30:00.000Z\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"C-1-1\",\"grounds\":\"要らない\"}",
    ),
  ]
  inspect(
    folded(rows, Some("IDD-1"), Map([])),
    content=(
      #|{"purposes":[],"choices":[{"id":"C-1-1","purpose":"P-4","forms":{"chosen":"形","rejected":[]},"place":[{"path":"a","kind":"module"}],"why":"理由","anchored":"契約","free":"why を保つ限り自由","visibility":"private","status":"active","origin":{"by":"agent"},"history":[{"at":"2026-10-18T09:00:00.000Z","event":"created","by":{"lane":"IDD-1"}},{"at":"2026-10-18T09:10:00.000Z","event":"re-anchored","by":{"lane":"IDD-1"}},{"at":"2026-10-18T09:20:00.000Z","event":"confirmed","by":{"lane":"IDD-1"}}],"waives":[]}],"waives":[],"harmExamples":[]}
    ),
  )
}

///|
test "a supersede keeps the old Choice's body and names its successor" {
  let rows = [
    row(
      "{\"event\":\"choice_raised\",\"at\":\"2026-10-18T09:00:00.000Z\",\"by\":null,\"id\":\"C-1-1\",\"purpose\":\"P-4\",\"forms\":{\"chosen\":\"古い\",\"rejected\":[]},\"place\":[],\"why\":\"理由\",\"anchored\":\"契約\"}",
    ),
    row(
      "{\"event\":\"choice_raised\",\"at\":\"2026-10-18T09:10:00.000Z\",\"by\":null,\"id\":\"C-2-1\",\"purpose\":\"P-4\",\"forms\":{\"chosen\":\"新しい\",\"rejected\":[]},\"place\":[],\"why\":\"理由\",\"anchored\":\"契約\",\"supersedes\":[{\"id\":\"C-1-1\",\"grounds\":\"置き換え\"}]}",
    ),
  ]
  inspect(
    folded(rows, None, Map([])),
    content=(
      #|{"purposes":[],"choices":[{"id":"C-1-1","purpose":"P-4","forms":{"chosen":"古い","rejected":[]},"place":[],"why":"理由","anchored":"契約","free":"why を保つ限り自由","visibility":"private","status":"superseded","origin":{"by":"agent"},"history":[{"at":"2026-10-18T09:00:00.000Z","event":"created","by":null},{"at":"2026-10-18T09:10:00.000Z","event":"superseded","by":null,"grounds":"置き換え","successor":"C-2-1"}],"waives":[]},{"id":"C-2-1","purpose":"P-4","forms":{"chosen":"新しい","rejected":[]},"place":[],"why":"理由","anchored":"契約","free":"why を保つ限り自由","visibility":"private","status":"active","origin":{"by":"agent"},"history":[{"at":"2026-10-18T09:10:00.000Z","event":"created","by":null}],"waives":[]}],"waives":[],"harmExamples":[]}
    ),
  )
}

///|
test "a row that points at a standing Choice as its successor keeps both bodies" {
  let rows = [
    row(
      "{\"event\":\"choice_raised\",\"at\":\"2026-10-18T09:00:00.000Z\",\"by\":null,\"id\":\"C-1-1\",\"purpose\":\"P-4\",\"forms\":{\"chosen\":\"古い\",\"rejected\":[]},\"place\":[],\"why\":\"理由\",\"anchored\":\"契約\"}",
    ),
    row(
      "{\"event\":\"choice_raised\",\"at\":\"2026-10-18T09:10:00.000Z\",\"by\":null,\"id\":\"C-2-1\",\"purpose\":\"P-4\",\"forms\":{\"chosen\":\"新しい\",\"rejected\":[]},\"place\":[],\"why\":\"理由\",\"anchored\":\"契約\"}",
    ),
    row(
      "{\"event\":\"choice_superseded\",\"at\":\"2026-10-18T09:20:00.000Z\",\"by\":null,\"id\":\"C-2-1\",\"supersedes\":[{\"id\":\"C-1-1\",\"grounds\":\"今も有効な後継\"}]}",
    ),
  ]
  inspect(
    folded(rows, None, Map([])),
    content=(
      #|{"purposes":[],"choices":[{"id":"C-1-1","purpose":"P-4","forms":{"chosen":"古い","rejected":[]},"place":[],"why":"理由","anchored":"契約","free":"why を保つ限り自由","visibility":"private","status":"superseded","origin":{"by":"agent"},"history":[{"at":"2026-10-18T09:00:00.000Z","event":"created","by":null},{"at":"2026-10-18T09:20:00.000Z","event":"superseded","by":null,"grounds":"今も有効な後継","successor":"C-2-1"}],"waives":[]},{"id":"C-2-1","purpose":"P-4","forms":{"chosen":"新しい","rejected":[]},"place":[],"why":"理由","anchored":"契約","free":"why を保つ限り自由","visibility":"private","status":"active","origin":{"by":"agent"},"history":[{"at":"2026-10-18T09:10:00.000Z","event":"created","by":null}],"waives":[]}],"waives":[],"harmExamples":[]}
    ),
  )
}

///|
test "a landed lane's moves rewrite the Places that still stand on the old path" {
  let rows = [
    row(
      "{\"event\":\"choice_raised\",\"at\":\"2026-10-18T09:00:00.000Z\",\"by\":null,\"id\":\"C-1-1\",\"purpose\":\"P-4\",\"forms\":{\"chosen\":\"形\",\"rejected\":[]},\"place\":[{\"path\":\"a/\",\"kind\":\"module\"},{\"path\":\"a/b.mbt\",\"kind\":\"file\"}],\"why\":\"理由\",\"anchored\":\"契約\"}",
    ),
    row(
      "{\"event\":\"places_moved\",\"at\":\"2026-10-18T09:10:00.000Z\",\"by\":null,\"moves\":[{\"from\":\"a/\",\"to\":\"c/\"}]}",
    ),
  ]
  inspect(
    folded(rows, None, Map([])),
    content=(
      #|{"purposes":[],"choices":[{"id":"C-1-1","purpose":"P-4","forms":{"chosen":"形","rejected":[]},"place":[{"path":"c/","kind":"module"},{"path":"c/","kind":"module","file":"c/b.mbt"}],"why":"理由","anchored":"契約","free":"why を保つ限り自由","visibility":"private","status":"active","origin":{"by":"agent"},"history":[{"at":"2026-10-18T09:00:00.000Z","event":"created","by":null},{"at":"2026-10-18T09:10:00.000Z","event":"re-anchored","by":null}],"waives":[]}],"waives":[],"harmExamples":[]}
    ),
  )
}

///|
test "a Waive and a harm example fold as they are written" {
  let rows = [
    row(
      "{\"event\":\"waive\",\"at\":\"2026-10-18T09:00:00.000Z\",\"by\":{\"session\":\"s-1\"},\"kind\":\"applied\",\"choices\":[\"C-1-1\"],\"reason\":\"触らない\",\"change\":\"a\"}",
    ),
    row(
      "{\"event\":\"harm_example_added\",\"at\":\"2026-10-18T09:10:00.000Z\",\"by\":null,\"id\":\"H-1\",\"statement\":\"消えた\",\"harm\":3,\"always_must\":true}",
    ),
    row(
      "{\"event\":\"harm_example_added\",\"at\":\"2026-10-18T09:20:00.000Z\",\"by\":null,\"id\":\"H-2\",\"statement\":\"重さが無い\",\"harm\":4}",
    ),
  ]
  inspect(
    folded(rows, None, Map([])),
    content=(
      #|{"purposes":[],"choices":[],"waives":[{"kind":"applied","choices":["C-1-1"],"reason":"触らない","change":"a","at":"2026-10-18T09:00:00.000Z","by":{"session":"s-1"}}],"harmExamples":[{"id":"H-1","statement":"消えた","harm":3,"alwaysMust":true,"at":"2026-10-18T09:10:00.000Z","by":null}]}
    ),
  )
}

///|
test "an unreadable at is compared in the host's string order" {
  let states = states_of([
    event(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_close\",\"at\":\"b\",\"attrs\":{\"outcome\":\"merged\"}}",
    ),
    event(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_close\",\"at\":\"aa\",\"attrs\":{\"outcome\":\"merged\"}}",
    ),
  ])
  inspect(
    lane_states_json(states).stringify(),
    content=(
      #|{"IDD-1":{"mergedAt":"aa","endedAt":"aa"}}
    ),
  )
  let rows = [
    row(
      "{\"event\":\"purpose_raised\",\"at\":\"b\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"P-2\",\"statement\":\"後\",\"origin\":\"plan\"}",
    ),
    row(
      "{\"event\":\"purpose_raised\",\"at\":\"aa\",\"by\":{\"lane\":\"IDD-1\"},\"id\":\"P-1\",\"statement\":\"前\",\"origin\":\"plan\"}",
    ),
  ]
  inspect(
    folded(rows, None, states),
    content=(
      #|{"purposes":[{"id":"P-1","statement":"前","origin":"plan","status":"active","raised":{"by":{"lane":"IDD-1"},"at":"aa"}}],"choices":[],"waives":[],"harmExamples":[]}
    ),
  )
}

///|
test "a row of a name the fold does not read changes nothing" {
  let rows = [
    row(
      "{\"event\":\"something_new\",\"at\":\"2026-10-18T09:00:00.000Z\",\"by\":null,\"id\":\"P-1\",\"statement\":\"読まない\"}",
    ),
  ]
  inspect(
    folded(rows, None, Map([])),
    content=(
      #|{"purposes":[],"choices":[],"waives":[],"harmExamples":[]}
    ),
  )
}

///|
test "a Place is read as its module" {
  inspect(
    places_json(
      places_of(
        @json.parse(
          "[{\"path\":\"a/b.mbt\",\"kind\":\"file\",\"symbols\":[\"f\"]},{\"path\":\"a\",\"kind\":\"dir\"},{\"path\":\"/\",\"kind\":\"root\"},{\"path\":\"a/\",\"kind\":\"module\"}]",
        ),
      ),
    ),
    content=(
      #|[{"path":"a/","kind":"module","file":"a/b.mbt","symbols":["f"]},{"path":"a","kind":"module"},{"path":"/","kind":"root"},{"path":"a/","kind":"module"}]
    ),
  )
}

///|
test "a moved Place follows the file it marks, and a root Place never moves" {
  let places = places_of(
    @json.parse(
      "[{\"path\":\"a/\",\"kind\":\"module\",\"file\":\"a/b.mbt\"},{\"path\":\"a/\",\"kind\":\"module\"},{\"path\":\"/\",\"kind\":\"root\"}]",
    ),
  )
  let moves : Array[PlaceMove] = [{ from: "a/", to: "c/", }]
  inspect(
    match moved_places(places, moves) {
      Some(moved) => places_json(moved)
      None => "no move touched a Place"
    },
    content=(
      #|[{"path":"c/","kind":"module","file":"c/b.mbt"},{"path":"c/","kind":"module"},{"path":"/","kind":"root"}]
    ),
  )
}
