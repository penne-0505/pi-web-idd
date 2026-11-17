// The review loop's next step, in the fold's own words.
//
// The step's answer is written next to the call, so a change in what the loop steps on shows up here (the MoonBit
// rules 4). The wider promise — that this answer is the same one the TypeScript reading gives — is held by the
// cross-check against a real ledger (`packages/idd-fold/crosscheck.mjs`) and by the committed fixtures
// (`packages/idd-core/test/`).

///|
/// One JSON value out of its text.
fn step_json(text : String) -> Json {
  @json.parse(text) catch {
    error => abort("テストの JSON が読めません: \{error}")
  }
}

///|
/// One derived row out of its JSON text.
fn step_row(text : String) -> DerivedRow {
  derived_row_of(step_json(text))
}

///|
/// The facts a caller hands in, as the fold reads them.
fn no_facts() -> StepFacts {
  step_facts_of(Json::object(Map([])))
}

///|
/// The facts of a repo whose review slot is declared, which every start of a review round reads.
fn review_on_facts() -> StepFacts {
  step_facts_of(
    json_object([
      ("reviewOn", Json::boolean(true)),
      ("blindFits", Json::boolean(true)),
    ]),
  )
}

///|
/// The lane that waits for its device check: the step is the device's start.
fn device_lane() -> Array[DerivedRow] {
  [
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-19T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-19T10:01:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-19T10:02:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-19T10:03:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_converged\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":{}}",
    ),
  ]
}

///|
/// The lane whose review is over: the loop steps on it no more.
fn done_lane() -> Array[DerivedRow] {
  let rows = device_lane()
  rows.push(
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_device_skipped\",\"at\":\"2026-10-19T10:05:00.000Z\",\"attrs\":{\"reason\":\"pipeline.device_check が未宣言\"}}",
    ),
  )
  rows
}

///|
/// The lane that resumed a stored fix: the escalation carried the state the fix is sent from, and penne's
/// continue put it back.
fn stored_fix_lane(stored : String) -> Array[DerivedRow] {
  [
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-19T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-19T10:01:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-19T10:02:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-19T10:03:00.000Z\",\"attrs\":{\"outcome\":\"success\"}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_triage_done\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"accepted\":[{\"ref\":\"F-1\",\"severity\":\"must\",\"claim\":\"c\",\"fix\":\"f\"}]}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_escalated\",\"at\":\"2026-10-19T10:05:00.000Z\",\"attrs\":{\"reason\":\"段を起動できない\",\"retry_state\":" +
      stored +
      "}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_resumed\",\"at\":\"2026-10-19T10:06:00.000Z\",\"attrs\":{\"decision\":\"continue\",\"note\":\"続けて\"}}",
    ),
  ]
}

///|
/// The facts a fix is sent with: the envelope it went out as, the refs it is for, and the how-to-fix.
fn fix_facts() -> StepFacts {
  step_facts_of(
    json_object([
      ("envelopeId", Json::string("E-1")),
      ("acceptedRefs", Json::array([Json::string("F-1")])),
      ("hows", Json::array([Json::string("F-1")])),
    ]),
  )
}

///|
test "a lane that waits for its device check is sent to the device" {
  let facts = step_facts_of(
    json_object([
      ("deviceOn", Json::boolean(true)),
      (
        "verdict",
        json_object([
          ("action", Json::string("check")),
          ("judge", Json::string("viewer")),
          ("pictures", Json::number(2.0)),
        ]),
      ),
    ]),
  )
  inspect(
    next_step_of(device_lane(), facts).stringify(),
    content=(
      #|{"leg":"device","action":"start","attrs":{},"stage":"device"}
    ),
  )
}

///|
test "a lane whose review is over is not stepped on" {
  inspect(
    next_step_of(done_lane(), no_facts()).stringify(),
    content=(
      #|{"leg":"wait","action":"nothing","attrs":{}}
    ),
  )
}

///|
test "a lane that resumed a stored fix sends the fix" {
  inspect(
    next_step_of(
      stored_fix_lane("{\"state\":\"send_fix\",\"round\":2}"),
      fix_facts(),
    ).stringify(),
    content=(
      #|{"leg":"send_fix","action":"write","attrs":{"round":2,"refs":["F-1"],"envelope_id":"E-1","how_refs":["F-1"]},"event":"s2_fix_sent"}
    ),
  )
}

///|
test "a stored state nobody knows waits" {
  inspect(
    next_step_of(
      stored_fix_lane("{\"state\":\"a_state_of_the_future\"}"),
      no_facts(),
    ).stringify(),
    content=(
      #|{"leg":"wait","action":"nothing","attrs":{}}
    ),
  )
}

///|
/// The lane whose map is running: the routes it drew are the ones the blind will read.
fn running_map_lane() -> Array[DerivedRow] {
  [
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-19T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-19T10:01:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-19T10:02:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-19T10:03:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_map_started\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"run_id\":\"M1\",\"head\":\"abc123\"}}",
    ),
  ]
}

///|
/// The facts of a finished map run, as the runner's port answered it.
fn map_run_facts(run : String) -> StepFacts {
  step_facts_of(step_json("{\"runs\":[" + run + "]}"))
}

///|
test "a map whose run changed no role writes no fallbacks and no report it did not tell of" {
  inspect(
    next_step_of(
      running_map_lane(),
      map_run_facts("{\"state\":\"done\",\"routes\":[{\"id\":\"r1\"}]}"),
    ).stringify(),
    content=(
      #|{"leg":"map","action":"write","attrs":{"kind":"blind","round":1,"routes":[{"id":"r1"}],"head":"abc123"},"event":"s2_map_done"}
    ),
  )
}

///|
test "a map whose run changed a role writes the fallbacks and both reports it told of" {
  inspect(
    next_step_of(
      running_map_lane(),
      map_run_facts(
        "{\"state\":\"done\",\"routes\":[],\"reportMd\":\"/m.md\",\"reportJson\":\"/m.json\",\"fallbacks\":[{\"role\":\"r\",\"fallback\":\"q\"}]}",
      ),
    ).stringify(),
    content=(
      #|{"leg":"map","action":"write","attrs":{"kind":"blind","round":1,"routes":[],"report_md":"/m.md","report_json":"/m.json","head":"abc123","fallbacks":[{"role":"r","fallback":"q"}]},"event":"s2_map_done"}
    ),
  )
}

///|
test "a lane that resumed a stored blind start starts the blind instead of failing" {
  inspect(
    next_step_of(
      stored_fix_lane(
        "{\"state\":\"start_blind\",\"kind\":\"blind\",\"round\":3}",
      ),
      review_on_facts(),
    ).stringify(),
    content=(
      #|{"leg":"blind","action":"start","attrs":{},"stage":"blind"}
    ),
  )
}

///|
test "a stored final blind start starts the final" {
  inspect(
    next_step_of(
      stored_fix_lane(
        "{\"state\":\"start_blind\",\"kind\":\"final\",\"round\":4}",
      ),
      review_on_facts(),
    ).stringify(),
    content=(
      #|{"leg":"blind","action":"start","attrs":{},"stage":"final"}
    ),
  )
}

///|
test "a stored kept start converges without the check it named" {
  inspect(
    next_step_of(
      stored_fix_lane(
        "{\"state\":\"start_blind\",\"kind\":\"kept\",\"round\":5}",
      ),
      no_facts(),
    ).stringify(),
    content=(
      #|{"leg":"converge","action":"write","attrs":{"kept_skipped":"守られたかの確かめ（R2）を外した"},"event":"s2_review_converged"}
    ),
  )
}

///|
/// The lane whose confirm is running: the fix it was sent for is what the confirm reports on.
fn running_confirm_lane() -> Array[DerivedRow] {
  [
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-19T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-19T10:01:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-19T10:02:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-19T10:03:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_findings\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"files\":[\"/r1.json\"]}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_triage_started\",\"at\":\"2026-10-19T10:05:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"run_id\":\"T1\"}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_triage_done\",\"at\":\"2026-10-19T10:06:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"accepted\":[{\"ref\":\"F-1\",\"severity\":\"must\",\"claim\":\"c\",\"fix\":\"f\"}]}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_fix_sent\",\"at\":\"2026-10-19T10:07:00.000Z\",\"attrs\":{\"round\":1,\"refs\":[\"F-1\"],\"envelope_id\":\"E-1\"}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_confirm_started\",\"at\":\"2026-10-19T10:08:00.000Z\",\"attrs\":{\"round\":1,\"run_id\":\"C1\"}}",
    ),
  ]
}

///|
test "a finished confirm writes the report it read and counts what blocks" {
  let facts = step_facts_of(
    step_json(
      "{\"runs\":[{\"state\":\"done\",\"reportJson\":\"/c.json\",\"reportMd\":\"/c.md\",\"fallbacks\":[{\"role\":\"r\"}],\"findings\":[{\"severity\":\"must\",\"claim\":\"c\"}]}],\"severities\":[{\"ref\":\"F-1\",\"severity\":\"must\"}],\"unresolved\":[\"F-1\"],\"missing\":[\"F-3\"]}",
    ),
  )
  inspect(
    next_step_of(running_confirm_lane(), facts).stringify(),
    content=(
      #|{"leg":"confirm","action":"write","attrs":{"round":1,"files":["/c.json"],"report_md":"/c.md","fallbacks":[{"role":"r"}],"unresolved_must":1,"unresolved_should":1,"new_blocking":1,"unresolved_refs":["F-1","F-3"]},"event":"s2_confirm_done"}
    ),
  )
}

///|
/// The lane whose device check is running: the pictures it read are what the record keeps.
fn running_device_lane() -> Array[DerivedRow] {
  let rows = device_lane()
  rows.push(
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_device_started\",\"at\":\"2026-10-19T10:05:00.000Z\",\"attrs\":{\"round\":1,\"run_id\":\"D1\",\"judge\":\"viewer\"}}",
    ),
  )
  rows
}

///|
test "a finished device check writes its report and the reason it skipped what it could not read" {
  let facts = step_facts_of(
    step_json(
      "{\"runs\":[{\"state\":\"done\",\"reportJson\":\"/d.json\",\"reportMd\":\"/d.md\",\"skipped\":\"why\"}],\"judge\":\"viewer\"}",
    ),
  )
  inspect(
    next_step_of(running_device_lane(), facts).stringify(),
    content=(
      #|{"leg":"device","action":"write","attrs":{"round":1,"blocking":0,"files":["/d.json"],"judge":"viewer","report_md":"/d.md","skipped_reason":"why"},"event":"s2_device_done"}
    ),
  )
}

///|
test "a device check with no picture set writes a must and the count of pictures" {
  let facts = step_facts_of(
    step_json(
      "{\"deviceOn\":true,\"verdict\":{\"action\":\"must\",\"reason\":\"r\"},\"pictures\":3}",
    ),
  )
  inspect(
    next_step_of(device_lane(), facts).stringify(),
    content=(
      #|{"leg":"device","action":"write","attrs":{"round":1,"blocking":1,"judge":"viewer","pictures":3,"findings":[{"severity":"must","claim":"r"}]},"event":"s2_device_done"}
    ),
  )
}

///|
test "a review whose runs all failed keeps the kept kind it retries from" {
  let rows : Array[DerivedRow] = [
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-19T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-19T10:01:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-19T10:02:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-19T10:03:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_started\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":{\"kind\":\"kept\",\"round\":1,\"run_ids\":[\"B1\"]}}",
    ),
  ]
  inspect(
    next_step_of(
      rows,
      map_run_facts("{\"state\":\"failed\",\"error\":\"boom\"}"),
    ).stringify(),
    content=(
      #|{"leg":"blind","action":"write","attrs":{"reason":"レビューがすべて失敗: boom","retry_state":{"state":"start_blind","kind":"kept","round":1}},"event":"s2_review_escalated"}
    ),
  )
}

///|
test "a judgement start records the marks of a tool refusing the means" {
  let rows = running_map_lane()
  rows[rows.length() - 1] = step_row(
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_findings\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"files\":[\"/r1.json\"]}}",
  )
  let facts = step_facts_of(
    step_json(
      "{\"triageFits\":true,\"runs\":[{\"state\":\"done\",\"runIds\":[\"T1\"],\"fallbacks\":[{\"role\":\"r\"}]}],\"means\":[{\"rule\":\"r\"}]}",
    ),
  )
  inspect(
    next_step_of(rows, facts).stringify(),
    content=(
      #|{"leg":"triage","action":"write","attrs":{"kind":"blind","round":1,"run_id":"T1","missing_means":[{"rule":"r"}],"fallbacks":[{"role":"r"}]},"event":"s2_triage_started"}
    ),
  )
}

///|
/// The lane whose executor has reported and no round has begun.
fn fresh_lane() -> Array[DerivedRow] {
  [
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-19T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-19T10:01:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-19T10:02:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-19T10:03:00.000Z\",\"attrs\":{}}",
    ),
  ]
}

///|
/// The facts a round's start reads: the slot is declared, a copy fits, and the lane stands at one head.
fn start_facts() -> StepFacts {
  step_facts_of(
    json_object([
      ("reviewOn", Json::boolean(true)),
      ("mapOn", Json::boolean(true)),
      ("mapFits", Json::boolean(true)),
      ("blindFits", Json::boolean(true)),
      ("routeBlindFits", Json::boolean(true)),
      (
        "at",
        json_object([
          ("worktree", Json::string("/wt")),
          ("base", Json::string("b0")),
          ("head", Json::string("h1")),
        ]),
      ),
    ]),
  )
}

///|
test "the first review of a large diff runs the map before the blind" {
  inspect(
    next_step_of(fresh_lane(), start_facts()).stringify(),
    content=(
      #|{"leg":"blind","action":"start","attrs":{},"stage":"map"}
    ),
  )
}

///|
test "a review slot nobody declared skips the round" {
  let facts = step_facts_of(
    json_object([
      ("reviewOn", Json::boolean(false)),
      ("blindFits", Json::boolean(true)),
    ]),
  )
  inspect(
    next_step_of(fresh_lane(), facts).stringify(),
    content=(
      #|{"leg":"blind","action":"write","attrs":{"reason":"pipeline.review_blind が未宣言"},"event":"s2_review_skipped"}
    ),
  )
}

///|
test "the round the map ran before records its runs and the routes it read" {
  let rows = fresh_lane()
  rows.push(
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_map_started\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"run_id\":\"M1\",\"head\":\"h1\"}}",
    ),
  )
  rows.push(
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_map_done\",\"at\":\"2026-10-19T10:05:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"routes\":[{\"id\":\"r1\",\"paths\":[\"a.ts\"],\"question\":\"q\",\"harms\":[]}],\"head\":\"h1\"}}",
    ),
  )
  let facts = step_facts_of(
    json_object([
      ("reviewOn", Json::boolean(true)),
      ("mapOn", Json::boolean(true)),
      ("mapFits", Json::boolean(true)),
      ("blindFits", Json::boolean(true)),
      ("routeBlindFits", Json::boolean(true)),
      ("mapSkipped", Json::string("small")),
      (
        "at",
        json_object([
          ("worktree", Json::string("/wt")),
          ("base", Json::string("b0")),
          ("head", Json::string("h1")),
        ]),
      ),
      (
        "runs",
        Json::array([
          json_object([
            ("state", Json::string("started")),
            ("runIds", Json::array([Json::string("B1")])),
            ("runLabels", Json::array([Json::string("r1")])),
            ("wholeDiff", Json::array([Json::string("B1")])),
            ("routeCount", Json::number(1.0)),
          ]),
        ]),
      ),
    ]),
  )
  inspect(
    next_step_of(rows, facts).stringify(),
    content=(
      #|{"leg":"blind","action":"write","attrs":{"kind":"blind","round":1,"run_ids":["B1"],"head":"h1","run_labels":["r1"],"mapped_routes":1,"route_count":1,"whole_run_ids":["B1"],"map_skipped":"small"},"event":"s2_review_started"}
    ),
  )
}

///|
test "a head the map was drawn at moved is drawn again" {
  let rows = fresh_lane()
  rows.push(
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_map_done\",\"at\":\"2026-10-19T10:05:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"routes\":[],\"head\":\"h0\"}}",
    ),
  )
  inspect(
    next_step_of(rows, start_facts()).stringify(),
    content=(
      #|{"leg":"blind","action":"write","attrs":{"kind":"blind","round":1,"map_head":"h0","head":"h1"},"event":"s2_map_head_moved"}
    ),
  )
}

///|
test "a run the runner told nothing of has not finished" {
  let rows : Array[DerivedRow] = [
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-19T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-19T10:01:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-19T10:02:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-19T10:03:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_started\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"run_ids\":[\"B1\"]}}",
    ),
  ]
  inspect(
    next_step_of(
      rows,
      map_run_facts("{\"reportJson\":\"/b.json\",\"runIds\":[\"B1\"]}"),
    ).stringify(),
    content=(
      #|{"leg":"blind","action":"nothing","attrs":{}}
    ),
  )
}

///|
test "a run without an id records the empty id instead of stopping the fold" {
  let rows = running_map_lane()
  rows[rows.length() - 1] = step_row(
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_findings\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"files\":[\"/r1.json\"]}}",
  )
  let facts = step_facts_of(
    json_object([
      ("triageFits", Json::boolean(true)),
      ("runs", Json::array([json_object([("state", Json::string("done"))])])),
    ]),
  )
  inspect(
    next_step_of(rows, facts).stringify(),
    content=(
      #|{"leg":"triage","action":"write","attrs":{"kind":"blind","round":1,"run_id":""},"event":"s2_triage_started"}
    ),
  )
}

///|
test "a done run that wrote no report is a run that finished, and the round goes to its judgement" {
  let rows : Array[DerivedRow] = [
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-19T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-19T10:01:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-19T10:02:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-19T10:03:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_started\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"run_ids\":[\"B1\",\"B2\"]}}",
    ),
  ]
  let facts = step_facts_of(
    json_object([
      (
        "runs",
        Json::array([
          json_object([
            ("state", Json::string("done")),
            ("runIds", Json::array([Json::string("B1")])),
          ]),
          json_object([
            ("state", Json::string("done")),
            ("reportJson", Json::string("/b.json")),
            ("runIds", Json::array([Json::string("B2")])),
          ]),
        ]),
      ),
    ]),
  )
  inspect(
    next_step_of(rows, facts).stringify(),
    content=(
      #|{"leg":"blind","action":"write","attrs":{"kind":"blind","round":1,"files":["/b.json"],"failed_runs":0},"event":"s2_review_findings"}
    ),
  )
}

///|
test "a High final whose High role did not finish is put to penne" {
  let rows : Array[DerivedRow] = [
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-19T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-19T10:01:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-19T10:02:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-19T10:03:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_started\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":{\"kind\":\"final\",\"round\":2,\"run_ids\":[\"F1\",\"F2\"],\"run_roles\":[\"high\",\"r\"]}}",
    ),
  ]
  let facts = step_facts_of(
    json_object([
      (
        "policy",
        json_object([
          ("highRiskWhen", Json::string("last")),
          (
            "extras",
            json_object([
              ("first_round", Json::number(1.0)),
              ("high_risk", Json::number(1.0)),
            ]),
          ),
          (
            "extraRoles",
            json_object([
              ("first_round", Json::array([])),
              ("high_risk", Json::array([Json::string("high")])),
            ]),
          ),
        ]),
      ),
      (
        "runs",
        Json::array([
          json_object([
            ("state", Json::string("failed")),
            ("error", Json::string("x")),
            ("runIds", Json::array([Json::string("F1")])),
          ]),
          json_object([
            ("state", Json::string("done")),
            ("reportJson", Json::string("/f.json")),
            ("runIds", Json::array([Json::string("F2")])),
          ]),
        ]),
      ),
    ]),
  )
  inspect(
    next_step_of(rows, facts).stringify(),
    content=(
      #|{"leg":"blind","action":"write","attrs":{"reason":"High のレビュー（high）が完走しなかったので、巡を判定に回さない","retry_state":{"state":"start_blind","kind":"final","round":2}},"event":"s2_review_escalated"}
    ),
  )
}

///|
/// A blind round that started two blinds and a spec check beside them, labelled as the runner writes them.
fn spec_round_lane() -> Array[DerivedRow] {
  [
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-19T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-19T10:01:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-19T10:02:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-19T10:03:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_started\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"run_ids\":[\"B1\",\"B2\",\"S1\"],\"run_labels\":[\"\",\"\",\"spec\"]}}",
    ),
  ]
}

///|
/// One finished or failed run of the round, by the state it ended in.
fn spec_round_run(state : String, id : String, report : String) -> Json {
  let fields : Array[(String, Json)] = [
    ("state", Json::string(state)),
    ("runIds", Json::array([Json::string(id)])),
  ]
  if state == "done" {
    fields.push(("reportJson", Json::string(report)))
  } else {
    fields.push(("error", Json::string(id + " failed")))
  }
  json_object(fields)
}

///|
test "a round's spec check report reaches the judgement beside the blinds' reports" {
  let facts = step_facts_of(
    json_object([
      (
        "runs",
        Json::array([
          spec_round_run("done", "B1", "/b1.json"),
          spec_round_run("done", "B2", "/b2.json"),
          spec_round_run("done", "S1", "/s1.json"),
        ]),
      ),
    ]),
  )
  inspect(
    next_step_of(spec_round_lane(), facts).stringify(),
    content=(
      #|{"leg":"blind","action":"write","attrs":{"kind":"blind","round":1,"files":["/b1.json","/b2.json","/s1.json"],"failed_runs":0},"event":"s2_review_findings"}
    ),
  )
}

///|
test "a spec check that finished does not stand in for blinds that all failed" {
  let facts = step_facts_of(
    json_object([
      (
        "runs",
        Json::array([
          spec_round_run("failed", "B1", ""),
          spec_round_run("failed", "B2", ""),
          spec_round_run("done", "S1", "/s1.json"),
        ]),
      ),
    ]),
  )
  inspect(
    next_step_of(spec_round_lane(), facts).stringify(),
    content=(
      #|{"leg":"blind","action":"write","attrs":{"reason":"レビューがすべて失敗: B1 failed / B2 failed","retry_state":{"state":"start_blind","kind":"blind","round":1}},"event":"s2_review_escalated"}
    ),
  )
}

///|
test "a spec check that failed leaves the round to its blinds and counts the failed run" {
  let facts = step_facts_of(
    json_object([
      (
        "runs",
        Json::array([
          spec_round_run("done", "B1", "/b1.json"),
          spec_round_run("done", "B2", "/b2.json"),
          spec_round_run("failed", "S1", ""),
        ]),
      ),
    ]),
  )
  inspect(
    next_step_of(spec_round_lane(), facts).stringify(),
    content=(
      #|{"leg":"blind","action":"write","attrs":{"kind":"blind","round":1,"files":["/b1.json","/b2.json"],"failed_runs":1},"event":"s2_review_findings"}
    ),
  )
}

///|
test "every depth runs one spec check beside its blinds" {
  inspect(
    depth_table_json(),
    content=(
      #|[{"depth":"shallow","planReview":1,"blind":1,"spec":1,"finalReview":true,"fixRounds":1,"autoGo":true,"shape":0},{"depth":"standard","planReview":2,"blind":2,"spec":1,"finalReview":true,"fixRounds":2,"autoGo":false,"shape":0},{"depth":"deep","planReview":2,"blind":2,"spec":1,"finalReview":true,"fixRounds":3,"autoGo":false,"shape":1}]
    ),
  )
}

///|
/// The lane the loop stopped for penne, with the rows that came after the stop as given.
fn stopped_lane(
  stop_attrs : String,
  after : Array[String],
) -> Array[DerivedRow] {
  let rows = [
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-19T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-10-19T10:01:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-19T10:02:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-10-19T10:03:00.000Z\",\"attrs\":{\"outcome\":\"success\"}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_escalated\",\"at\":\"2026-10-19T10:04:00.000Z\",\"attrs\":" +
      stop_attrs +
      "}",
    ),
  ]
  for event in after {
    rows.push(
      step_row(
        "{\"idd_id\":\"IDD-1\",\"event\":\"\{event}\",\"at\":\"2026-10-19T10:05:00.000Z\",\"attrs\":{}}",
      ),
    )
  }
  rows
}

///|
test "a stop is written once: the judge's notes after it do not make a new stop" {
  let stop = "{\"reason\":\"収束しない\"}"
  inspect(
    next_step_of(stopped_lane(stop, []), no_facts()).stringify(),
    content=(
      #|{"leg":"escalate","action":"nothing","attrs":{}}
    ),
  )
  inspect(
    next_step_of(
      stopped_lane(stop, ["s2_shape_started", "s2_shape_judged"]),
      no_facts(),
    ).stringify(),
    content=(
      #|{"leg":"escalate","action":"nothing","attrs":{}}
    ),
  )
}

///|
test "a stop with a retry state and a window wait steps on its stored state after a note" {
  let stop = "{\"reason\":\"枠待ち\",\"retry_state\":{\"state\":\"start_blind\",\"kind\":\"final\",\"round\":1},\"quota_wait\":{\"reason\":\"枠\"}}"
  inspect(
    next_step_of(stopped_lane(stop, ["s2_shape_judged"]), review_on_facts()).stringify(),
    content=(
      #|{"leg":"blind","action":"start","attrs":{},"stage":"final"}
    ),
  )
}

///|
/// A depth-bearing lane after one round: the round read `h1`, its judgement accepted `findings`, and `tail` follows.
fn fixed_round_lane(
  findings : String,
  tail : Array[String],
) -> Array[DerivedRow] {
  let rows = [
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_ready\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{\"depth\":\"standard\"}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s1_go\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{\"outcome\":\"success\"}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_started\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"run_ids\":[\"B1\"],\"head\":\"h1\",\"depth\":\"standard\",\"max_fix_rounds\":2,\"close_on\":\"must\"}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_findings\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"files\":[],\"failed_runs\":0}}",
    ),
    step_row(
      "{\"idd_id\":\"IDD-1\",\"event\":\"s2_triage_done\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{\"kind\":\"blind\",\"round\":1,\"accepted\":" +
      findings +
      ",\"rejected\":[],\"escalated_claims\":[]}}",
    ),
  ]
  for line in tail {
    rows.push(step_row(line))
  }
  rows
}

///|
test "a continue whose corrections leave nothing to fix starts the final review with its reason, and an accept converges with none" {
  let stop = "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_escalated\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{\"reason\":\"上限\"}}"
  let findings = "[{\"ref\":\"F-1\",\"severity\":\"must\",\"claim\":\"c\",\"action\":\"fix\"}]"
  let answer = fn(decision : String) {
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_resumed\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{\"decision\":\"" +
    decision +
    "\",\"note\":\"境目だけ\",\"corrections\":[{\"ref\":\"1-blind/F-1\",\"severity\":\"should\",\"action\":\"skip\",\"reason\":\"範囲の外\"}]}}"
  }
  // the High role's final review starts, and its record says no fix was sent before it
  let final_facts = step_facts_of(
    step_json(
      "{\"reviewOn\":true,\"blindFits\":true,\"at\":{\"worktree\":\"/w\",\"base\":\"b\",\"head\":\"h1\"},\"extras\":[\"high_risk\"],\"policy\":{\"highRiskWhen\":\"last\",\"extras\":{\"first_round\":0,\"high_risk\":1},\"extraRoles\":{\"first_round\":[],\"high_risk\":[\"h\"]}},\"runs\":[{\"state\":\"started\",\"runIds\":[\"F1\"],\"runRoles\":[\"h\"]}]}",
    ),
  )
  inspect(
    next_step_of(
      fixed_round_lane(findings, [stop, answer("continue")]),
      final_facts,
    ).stringify(),
    content=(
      #|{"leg":"blind","action":"write","attrs":{"kind":"final","round":1,"run_ids":["F1"],"head":"h1","run_roles":["h"],"extras":["high_risk"],"after_zero_fix":true,"after_zero_fix_reason":"「続ける」の後に直す対象が 0 件のため、手直しを送らなかった"},"event":"s2_review_started"}
    ),
  )
  inspect(
    next_step_of(
      fixed_round_lane(findings, [stop, answer("accept")]),
      no_facts(),
    ).stringify(),
    content=(
      #|{"leg":"converge","action":"write","attrs":{},"event":"s2_review_converged"}
    ),
  )
}

///|
test "a fix that left the head where the last round read it stops for penne instead of reading it again" {
  let findings = "[{\"ref\":\"F-1\",\"severity\":\"must\",\"claim\":\"c\",\"action\":\"fix\"}]"
  let rows = fixed_round_lane(findings, [
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_fix_sent\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{\"round\":1,\"refs\":[\"1-blind/F-1\"],\"envelope_id\":\"fix-IDD-1-r1\",\"how_refs\":[]}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{\"outcome\":\"success\"}}",
  ])
  let at = fn(head : String) {
    step_facts_of(
      json_object([
        ("reviewOn", Json::boolean(true)),
        ("blindFits", Json::boolean(true)),
        (
          "at",
          json_object([
            ("worktree", Json::string("/w")),
            ("base", Json::string("b")),
            ("head", Json::string(head)),
          ]),
        ),
      ]),
    )
  }
  inspect(
    next_step_of(rows, at("h1")).stringify(),
    content=(
      #|{"leg":"escalate","action":"write","attrs":{"reason":"手直しで head が変わらなかった（h1）。同じ head をもう一度レビューしない。続ける（手直しを送り直す）か、受け入れるか、自分で直すかを決めてください","head":"h1"},"event":"s2_review_escalated"}
    ),
  )
  inspect(
    next_step_of(rows, at("h2")).stringify(),
    content=(
      #|{"leg":"blind","action":"start","attrs":{},"stage":"blind"}
    ),
  )
}

///|
test "after the stop of a head the fix left, a continue that sets every finding aside sends no fix again" {
  let findings = "[{\"ref\":\"F-1\",\"severity\":\"should\",\"claim\":\"e\",\"action\":\"fix\"},{\"ref\":\"F-2\",\"severity\":\"must\",\"claim\":\"g\",\"action\":\"fix\"}]"
  let row = fn(event : String, attrs : String) {
    "{\"idd_id\":\"IDD-1\",\"event\":\"" +
    event +
    "\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":" +
    attrs +
    "}"
  }
  let rows = fixed_round_lane(findings, [
    row("s2_review_escalated", "{\"reason\":\"上限\"}"),
    row("s2_review_resumed", "{\"decision\":\"continue\",\"note\":\"直す\"}"),
    row(
      "s2_fix_sent", "{\"round\":1,\"refs\":[\"1-blind/F-1\",\"1-blind/F-2\"],\"envelope_id\":\"fix-IDD-1-r1\",\"how_refs\":[]}",
    ),
    row("s2_result", "{\"outcome\":\"success\"}"),
    row(
      "s2_review_escalated", "{\"reason\":\"手直しで head が変わらなかった（h1）\",\"head\":\"h1\"}",
    ),
    row(
      "s2_review_resumed", "{\"decision\":\"continue\",\"note\":\"\",\"corrections\":[{\"ref\":\"1-blind/F-1\",\"severity\":\"should\",\"action\":\"skip\",\"reason\":\"r\"},{\"ref\":\"1-blind/F-2\",\"severity\":\"should\",\"action\":\"skip\",\"reason\":\"r\"}]}",
    ),
  ])
  let facts = step_facts_of(
    step_json(
      "{\"reviewOn\":true,\"blindFits\":true,\"at\":{\"worktree\":\"/w\",\"base\":\"b\",\"head\":\"h1\"},\"runs\":[{\"state\":\"started\",\"runIds\":[\"F1\"]}]}",
    ),
  )
  inspect(
    next_step_of(rows, facts).stringify(),
    content=(
      #|{"leg":"blind","action":"write","attrs":{"kind":"final","round":2,"run_ids":["F1"],"head":"h1","after_zero_fix":true,"after_zero_fix_reason":"「続ける」の後に直す対象が 0 件のため、手直しを送らなかった"},"event":"s2_review_started"}
    ),
  )
}
