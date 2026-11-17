// The mainline merge before a lane's first review, in the fold's own words.
//
// The wider promise — that these answers are the ones the tick gave before the fold took the decision over — is held
// by the live engine's passes over the tick (`packages/idd-core/test/review-pre-merge.test.mjs`). These say what the
// fold does with the facts a caller hands in, one branch at a time.

///|
/// One derived row out of its JSON text.
fn pm_row(text : String) -> DerivedRow {
  derived_row_of(
    @json.parse(text) catch {
      error => abort("テストの行が JSON ではありません: \{error}")
    },
  )
}

///|
/// A lane's rows out of their JSON texts.
fn pm_rows(texts : Array[String]) -> Array[DerivedRow] {
  let rows : Array[DerivedRow] = []
  for text in texts {
    rows.push(pm_row(text))
  }
  rows
}

///|
/// A lane whose executor started, and whose review has not begun.
fn pm_lane() -> Array[DerivedRow] {
  pm_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-23T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-23T10:01:00.000Z\",\"attrs\":{\"started_from_commit\":\"base\"}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-23T10:02:00.000Z\",\"attrs\":{}}",
  ])
}

///|
/// The facts that say the lane is in this merge's scope, with the readings a branch did not move.
fn pm_fact_list() -> Array[(String, Json)] {
  [
    ("hasLocation||", Json::boolean(true)),
    ("publishes||", Json::boolean(false)),
    ("hasLocalPath||", Json::boolean(true)),
    ("hasWorkBase||", Json::boolean(true)),
    ("baseReadable||", Json::boolean(true)),
    ("hasReviewBase||", Json::boolean(true)),
    ("head||", Json::string("head")),
    ("mainTip||", Json::string("tip")),
    ("readError||", Json::string("")),
    (
      "ancestor||",
      json_object([
        ("headHas", Json::boolean(false)),
        ("baseHas", Json::boolean(false)),
      ]),
    ),
    ("ancestorError||", Json::string("")),
    ("runnerPresent||", Json::boolean(true)),
    ("busy||", Json::boolean(false)),
    ("busyError||", Json::string("")),
  ]
}

///|
/// The same facts as one object.
fn pm_facts() -> Json {
  json_object(pm_fact_list())
}

///|
/// The facts of a lane, with one reading replaced, and another added when it is named.
fn pm_with(key : String, value : Json, extras : Array[(String, Json)]) -> Json {
  let out : Array[(String, Json)] = []
  let known = pm_fact_list()
  for pair in known {
    if pair.0 == key {
      out.push((key, value))
    } else {
      out.push(pair)
    }
  }
  let mut replaced = false
  for pair in known {
    if pair.0 == key {
      replaced = true
    }
  }
  if !replaced {
    out.push((key, value))
  }
  for pair in extras {
    out.push(pair)
  }
  json_object(out)
}

///|
test "a repo that publishes is left alone" {
  let facts = pm_with("publishes||", Json::boolean(true), [])
  inspect(
    pre_merge(pm_lane(), facts).stringify(),
    content=(
      #|{"do":"action","action":"none"}
    ),
  )
}

///|
test "a head that carries the mainline, and a review origin that does too, is left alone" {
  let facts = pm_with(
    "ancestor||",
    json_object([
      ("headHas", Json::boolean(true)),
      ("baseHas", Json::boolean(true)),
    ]),
    [],
  )
  inspect(
    pre_merge(pm_lane(), facts).stringify(),
    content=(
      #|{"do":"action","action":"none"}
    ),
  )
}

///|
test "an executor that merged the mainline itself reads the review origin, then records the move" {
  let ancestor = json_object([
    ("headHas", Json::boolean(true)),
    ("baseHas", Json::boolean(false)),
  ])
  inspect(
    pre_merge(pm_lane(), pm_with("ancestor||", ancestor, [])).stringify(),
    content=(
      #|{"do":"call","helper":"review_base","site":"head_has","fact":"call|review_base|head_has","keep":null,"args":null,"fatal":false,"reread":false}
    ),
  )
  let read = pm_with("ancestor||", ancestor, [
    (
      "call|review_base|head_has",
      json_object([
        ("result", json_object([("reviewBase", Json::string("rb"))])),
      ]),
    ),
  ])
  inspect(
    pre_merge(pm_lane(), read).stringify(),
    content=(
      #|{"do":"call","helper":"record_executor_merge","site":"head_has","fact":"call|record_executor_merge|head_has","keep":{"head":"head","mainline":"tip"},"args":{"head":"head","mainline":"tip","reviewBase":"rb"},"fatal":false,"reread":false}
    ),
  )
}

///|
test "a merge that is needed takes the lane's lock before it reads anything else" {
  inspect(
    pre_merge(pm_lane(), pm_facts()).stringify(),
    content=(
      #|{"do":"call","helper":"lock_lane","site":"merge","fact":"call|lock_lane|merge","keep":null,"args":null,"fatal":false,"reread":false}
    ),
  )
}

///|
test "a head that cannot be read is a skip with the reading's own reason, and the review goes on" {
  let facts = pm_with("head||", Json::string(""), [])
  inspect(
    pre_merge(pm_lane(), facts).stringify(),
    content=(
      #|{"do":"write","event":"s2_review_base_skipped","attrs":{"reason":"レビュー前の merge に要る commit を読めません: "},"action":"proceed"}
    ),
  )
}

///|
test "a skip the head and mainline could not be read for is written once, and the next pass goes on" {
  let lane = pm_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-23T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-23T10:01:00.000Z\",\"attrs\":{\"started_from_commit\":\"base\"}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-23T10:02:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_base_skipped\",\"at\":\"2026-10-23T10:03:00.000Z\",\"attrs\":{\"reason\":\"レビュー前の merge に要る commit を読めません: \"}}",
  ])
  // a mainline that cannot be read reads the same way: both commits go, and the skip carries neither
  inspect(
    pre_merge(lane, pm_with("mainTip||", Json::string(""), [])).stringify(),
    content=(
      #|{"do":"action","action":"proceed"}
    ),
  )
}

///|
test "a skip whose reason changed is written again: only the same head, mainline and reason is one skip" {
  let lane = pm_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-23T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-23T10:01:00.000Z\",\"attrs\":{\"started_from_commit\":\"base\"}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-23T10:02:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_base_skipped\",\"at\":\"2026-10-23T10:03:00.000Z\",\"attrs\":{\"reason\":\"別の理由\"}}",
  ])
  inspect(
    pre_merge(lane, pm_with("head||", Json::string(""), [])).stringify(),
    content=(
      #|{"do":"write","event":"s2_review_base_skipped","attrs":{"reason":"レビュー前の merge に要る commit を読めません: "},"action":"proceed"}
    ),
  )
}

///|
test "a merge that conflicts puts the lane to the executor once, before the instruction's record" {
  let lane = pm_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-23T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-23T10:01:00.000Z\",\"attrs\":{\"started_from_commit\":\"base\"}}",
  ])
  let held = json_object([
    ("result", json_object([("held", Json::boolean(true))])),
  ])
  let conflicted = json_object([
    (
      "result",
      json_object([
        ("clean", Json::boolean(true)),
        ("onBranch", Json::boolean(true)),
        ("headStill", Json::boolean(true)),
        ("conflict", Json::boolean(true)),
        ("files", Json::array([Json::string("app.txt")])),
      ]),
    ),
  ])
  let facts = pm_with("lock_lane||", Json::boolean(true), [
    ("call|lock_lane|merge", held),
    ("call|read_merge_state|merge", conflicted),
  ])
  inspect(
    pre_merge(lane, facts).stringify(),
    content=(
      #|{"do":"write","event":"s2_review_base_conflict","attrs":{"head":"head","mainline":"tip","files":["app.txt"],"awaiting":true}}
    ),
  )
}

///|
test "a merge that goes in reads the origin, then merges, then records it" {
  let lane = pm_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-23T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-23T10:01:00.000Z\",\"attrs\":{\"started_from_commit\":\"base\"}}",
  ])
  let held = json_object([
    ("result", json_object([("held", Json::boolean(true))])),
  ])
  let clean = json_object([
    (
      "result",
      json_object([
        ("clean", Json::boolean(true)),
        ("onBranch", Json::boolean(true)),
        ("headStill", Json::boolean(true)),
        ("conflict", Json::boolean(false)),
        ("files", Json::array([])),
        ("tree", Json::string("tree")),
      ]),
    ),
  ])
  let facts = pm_with("lock_lane||", Json::boolean(true), [
    ("call|lock_lane|merge", held),
    ("call|read_merge_state|merge", clean),
  ])
  inspect(
    pre_merge(lane, facts).stringify(),
    content=(
      #|{"do":"call","helper":"review_base","site":"merge","fact":"call|review_base|merge","keep":null,"args":null,"fatal":false,"reread":false}
    ),
  )
}

///|
test "a conflict the executor was just put to ends the pass at awaiting, not at the review" {
  let lane = pm_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-23T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-23T10:01:00.000Z\",\"attrs\":{\"started_from_commit\":\"base\"}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_base_conflict\",\"at\":\"2026-10-23T10:02:00.000Z\",\"attrs\":{\"head\":\"head\",\"mainline\":\"tip\",\"files\":[\"app.txt\"],\"awaiting\":true}}",
  ])
  let held = json_object([
    ("result", json_object([("held", Json::boolean(true))])),
  ])
  let conflicted = json_object([
    (
      "result",
      json_object([
        ("clean", Json::boolean(true)),
        ("onBranch", Json::boolean(true)),
        ("headStill", Json::boolean(true)),
        ("conflict", Json::boolean(true)),
        ("files", Json::array([Json::string("app.txt")])),
      ]),
    ),
  ])
  let sent = json_object([
    ("result", json_object([("ok", Json::boolean(true))])),
  ])
  let facts = pm_with("lock_lane||", Json::boolean(true), [
    ("call|lock_lane|merge", held),
    ("call|read_merge_state|merge", conflicted),
    ("call|conflict_envelope|conflict", sent),
  ])
  inspect(
    pre_merge(lane, facts).stringify(),
    content=(
      #|{"do":"write","event":"s2_review_base_instructed","attrs":{"head":"head","mainline":"tip","files":["app.txt"]},"action":"awaiting"}
    ),
  )
}

///|
/// The rows and facts of a lane that has the merge's lock and has read the merge: `read` is what the read answered,
/// and `extras` the answers of the steps after it.
fn pm_read_facts(
  read : Json,
  extras : Array[(String, Json)],
) -> (Array[DerivedRow], Json) {
  let lane = pm_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-23T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-23T10:01:00.000Z\",\"attrs\":{\"started_from_commit\":\"base\"}}",
  ])
  let held = json_object([
    ("result", json_object([("held", Json::boolean(true))])),
  ])
  let answers : Array[(String, Json)] = [
    ("call|lock_lane|merge", held),
    ("call|read_merge_state|merge", json_object([("result", read)])),
  ]
  for pair in extras {
    answers.push(pair)
  }
  (lane, pm_with("lock_lane||", Json::boolean(true), answers))
}

///|
/// What a merge read answers: a merge that conflicted on generated files alone, or one that touched them.
fn pm_generated_read(conflict : Bool) -> Json {
  json_object([
    ("clean", Json::boolean(true)),
    ("onBranch", Json::boolean(true)),
    ("headStill", Json::boolean(true)),
    ("conflict", Json::boolean(conflict)),
    (
      "files",
      if conflict {
        Json::array([Json::string("dist/app.js")])
      } else {
        Json::array([])
      },
    ),
    ("tree", Json::string("tree")),
    ("outputs", Json::array([Json::string("dist/app.js")])),
    ("generatedOnly", Json::boolean(conflict)),
    ("rebuild", Json::boolean(!conflict)),
  ])
}

///|
test "a conflict on generated files alone is made again before anything is merged or sent" {
  let (lane, facts) = pm_read_facts(pm_generated_read(true), [])
  inspect(
    pre_merge(lane, facts).stringify(),
    content=(
      #|{"do":"call","helper":"rebuild_generated","site":"merge","fact":"call|rebuild_generated|merge","keep":null,"args":{"tree":"tree","outputs":["dist/app.js"]},"fatal":false,"reread":false}
    ),
  )
  let rebuilt = json_object([
    ("result", json_object([("tree", Json::string("rebuilt"))])),
  ])
  let (lane2, facts2) = pm_read_facts(pm_generated_read(true), [
    ("call|rebuild_generated|merge", rebuilt),
  ])
  inspect(
    pre_merge(lane2, facts2).stringify(),
    content=(
      #|{"do":"call","helper":"review_base","site":"merge","fact":"call|review_base|merge","keep":null,"args":null,"fatal":false,"reread":false}
    ),
  )
  let origin = json_object([
    ("result", json_object([("reviewBase", Json::string("rb"))])),
  ])
  let (lane3, facts3) = pm_read_facts(pm_generated_read(true), [
    ("call|rebuild_generated|merge", rebuilt),
    ("call|review_base|merge", origin),
  ])
  inspect(
    pre_merge(lane3, facts3).stringify(),
    content=(
      #|{"do":"call","helper":"merge_mainline","site":"merge","fact":"call|merge_mainline|merge","keep":{"head":"head","mainline":"tip"},"args":{"head":"head","mainline":"tip","tree":"rebuilt","reviewBase":"rb"},"fatal":false,"reread":false}
    ),
  )
}

///|
test "a rebuild that failed on a generated-only conflict puts the executor to it, and the record says why" {
  let failure = json_object([
    ("cause", Json::string("build")),
    ("reason", Json::string("failed")),
    ("paths", Json::array([Json::string("dist/app.js")])),
  ])
  let failed = json_object([("result", json_object([("failure", failure)]))])
  let (lane, facts) = pm_read_facts(pm_generated_read(true), [
    ("call|rebuild_generated|merge", failed),
  ])
  inspect(
    pre_merge(lane, facts).stringify(),
    content=(
      #|{"do":"write","event":"s2_review_base_conflict","attrs":{"head":"head","mainline":"tip","files":["dist/app.js"],"awaiting":true,"rebuild_failure":{"cause":"build","reason":"failed","paths":["dist/app.js"]}}}
    ),
  )
}

///|
/// A rebuild failure answered for the generated-only conflict, with the cause and the paths the test names.
fn pm_failed_answer(cause : String, reason : String) -> Json {
  let failure = json_object([
    ("cause", Json::string(cause)),
    ("reason", Json::string(reason)),
    ("paths", Json::array([Json::string("dist/app.js")])),
  ])
  json_object([("result", json_object([("failure", failure)]))])
}

///|
/// The conflict's record of a head and mainline the lane was already put to, with a failure or none.
fn pm_conflict_row(failure : String) -> String {
  "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_base_conflict\",\"at\":\"2026-10-23T10:03:00.000Z\",\"attrs\":{\"head\":\"head\",\"mainline\":\"tip\",\"files\":[\"dist/app.js\"],\"awaiting\":true" +
  failure +
  "}}"
}

///|
test "a conflict record without the failure does not stand for the failure of this rebuild" {
  let (lane, facts) = pm_read_facts(pm_generated_read(true), [
    ("call|rebuild_generated|merge", pm_failed_answer("build", "failed")),
  ])
  lane.push(pm_row(pm_conflict_row("")))
  inspect(
    pre_merge(lane, facts).stringify(),
    content=(
      #|{"do":"write","event":"s2_review_base_conflict","attrs":{"head":"head","mainline":"tip","files":["dist/app.js"],"awaiting":true,"rebuild_failure":{"cause":"build","reason":"failed","paths":["dist/app.js"]}}}
    ),
  )
}

///|
test "a conflict record with another cause does not stand for this one" {
  let (lane, facts) = pm_read_facts(pm_generated_read(true), [
    ("call|rebuild_generated|merge", pm_failed_answer("environment", "no tool")),
  ])
  lane.push(
    pm_row(
      pm_conflict_row(
        ",\"rebuild_failure\":{\"cause\":\"build\",\"reason\":\"failed\",\"paths\":[\"dist/app.js\"]}",
      ),
    ),
  )
  inspect(
    pre_merge(lane, facts).stringify(),
    content=(
      #|{"do":"write","event":"s2_review_base_conflict","attrs":{"head":"head","mainline":"tip","files":["dist/app.js"],"awaiting":true,"rebuild_failure":{"cause":"environment","reason":"no tool","paths":["dist/app.js"]}}}
    ),
  )
}

///|
test "a conflict record with the same failure is not written again, whatever the reason's words" {
  let (lane, facts) = pm_read_facts(pm_generated_read(true), [
    ("call|rebuild_generated|merge", pm_failed_answer("build", "in /tmp/b2")),
  ])
  lane.push(
    pm_row(
      pm_conflict_row(
        ",\"rebuild_failure\":{\"cause\":\"build\",\"reason\":\"in /tmp/a1\",\"paths\":[\"dist/app.js\"]}",
      ),
    ),
  )
  inspect(
    pre_merge(lane, facts).stringify(),
    content=(
      #|{"do":"call","helper":"conflict_envelope","site":"conflict","fact":"call|conflict_envelope|conflict","keep":{"head":"head","mainline":"tip"},"args":{"head":"head","mainline":"tip","files":["dist/app.js"]},"fatal":false,"reread":false}
    ),
  )
}

///|
test "a conflict without a failure is still written once, and a failure-free record stands for it" {
  let (lane, facts) = pm_read_facts(
    json_object([
      ("clean", Json::boolean(true)),
      ("onBranch", Json::boolean(true)),
      ("headStill", Json::boolean(true)),
      ("conflict", Json::boolean(true)),
      ("files", Json::array([Json::string("app.txt")])),
      ("tree", Json::string("tree")),
    ]),
    [],
  )
  lane.push(pm_row(pm_conflict_row("")))
  inspect(
    pre_merge(lane, facts).stringify(),
    content=(
      #|{"do":"call","helper":"conflict_envelope","site":"conflict","fact":"call|conflict_envelope|conflict","keep":{"head":"head","mainline":"tip"},"args":{"head":"head","mainline":"tip","files":["app.txt"]},"fatal":false,"reread":false}
    ),
  )
}

///|
test "a conflict the executor was put to already gets the failure on a record that lets the review go on" {
  let (lane, facts) = pm_read_facts(pm_generated_read(true), [
    ("call|rebuild_generated|merge", pm_failed_answer("build", "failed")),
    ("call|advance_origin|conflict", json_object([("result", json_object([]))])),
  ])
  lane.push(pm_row(pm_conflict_row("")))
  lane.push(
    pm_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_base_instructed\",\"at\":\"2026-10-23T10:04:00.000Z\",\"attrs\":{\"head\":\"head\",\"mainline\":\"tip\",\"files\":[\"dist/app.js\"]}}",
    ),
  )
  inspect(
    pre_merge(lane, facts).stringify(),
    content=(
      #|{"do":"write","event":"s2_review_base_conflict","attrs":{"head":"head","mainline":"tip","files":["dist/app.js"],"awaiting":false,"rebuild_failure":{"cause":"build","reason":"failed","paths":["dist/app.js"]}}}
    ),
  )
}

///|
test "a rebuild that failed on a merge git made goes in with the tree git made, and carries the reason" {
  let failure = json_object([
    ("cause", Json::string("environment")),
    ("reason", Json::string("no tool")),
    ("paths", Json::array([Json::string("dist/app.js")])),
  ])
  let failed = json_object([("result", json_object([("failure", failure)]))])
  let origin = json_object([
    ("result", json_object([("reviewBase", Json::string("rb"))])),
  ])
  let (lane, facts) = pm_read_facts(pm_generated_read(false), [
    ("call|rebuild_generated|merge", failed),
    ("call|review_base|merge", origin),
  ])
  inspect(
    pre_merge(lane, facts).stringify(),
    content=(
      #|{"do":"call","helper":"merge_mainline","site":"merge","fact":"call|merge_mainline|merge","keep":{"head":"head","mainline":"tip"},"args":{"head":"head","mainline":"tip","tree":"tree","reviewBase":"rb","rebuildFailure":{"cause":"environment","reason":"no tool","paths":["dist/app.js"]}},"fatal":false,"reread":false}
    ),
  )
}

///|
test "a conflict the caller did not read as generated-only is the executor's and is not made again" {
  let read = json_object([
    ("clean", Json::boolean(true)),
    ("onBranch", Json::boolean(true)),
    ("headStill", Json::boolean(true)),
    ("conflict", Json::boolean(true)),
    (
      "files",
      Json::array([Json::string("dist/app.js"), Json::string("src.mbt")]),
    ),
    ("tree", Json::string("tree")),
    ("generatedOnly", Json::boolean(false)),
  ])
  let (lane, facts) = pm_read_facts(read, [])
  inspect(
    pre_merge(lane, facts).stringify(),
    content=(
      #|{"do":"write","event":"s2_review_base_conflict","attrs":{"head":"head","mainline":"tip","files":["dist/app.js","src.mbt"],"awaiting":true}}
    ),
  )
}
