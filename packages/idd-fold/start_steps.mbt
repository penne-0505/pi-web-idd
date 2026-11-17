// The startup stages' next step: whether a lane's planner, executor or plan review starts, waits, or is left alone.
//
// The decision belongs here, from the ledger's rows and the facts the caller read (C-205-1). The caller keeps the
// readings of the outside world (the runner, the worktree, git, the intent column) and the effects themselves: the
// spawn, the brief, the writes. This side answers the order they go in, which lane starts, and why a lane waits or is
// skipped. A reading the caller cannot make is handed in as a fact, so a failure changes the answer here and never
// sends the caller back to its own reading.
//
// The running counts are this side's too (C-205-2): the session records are handed over as facts, and the lanes'
// terminal records are the rows, so the number a slot's cap is measured against cannot be counted two ways.
//
// The executor's start keeps the order it had (C-205-3): the session is spawned, the start is written, and a start
// that did not go through takes the session back.

// ---------- the steps, as the caller runs them ----------

///|
/// A step that writes a record.
fn st_write(event : String, attrs : Json) -> Json {
  json_object([
    ("do", Json::string("write")),
    ("event", Json::string(event)),
    ("attrs", attrs),
  ])
}

///|
/// A step that calls a helper: its answer comes back under `fact`, so the next answer reads what it answered. A
/// helper's failure is not thrown unless the step says so: the answer's `error` decides, as the tried reads did.
fn st_call_item(
  helper : String,
  site : String,
  args : Json,
  fatal : Bool,
) -> Json {
  json_object([
    ("do", Json::string("call")),
    ("helper", Json::string(helper)),
    ("site", Json::string(site)),
    ("fact", Json::string("call|" + helper + "|" + site)),
    ("keep", Json::null()),
    ("args", args),
    ("fatal", Json::boolean(fatal)),
  ])
}

///|
/// A helper the caller calls with no arguments.
fn st_call(helper : String, site : String) -> Json {
  st_call_item(helper, site, Json::null(), false)
}

///|
/// A helper the caller calls with the arguments the answer builds.
fn st_call_args(helper : String, site : String, args : Json) -> Json {
  st_call_item(helper, site, args, false)
}

///|
/// A helper whose failure is thrown out of the driver, as the call it replaces did.
fn st_call_fatal(helper : String, site : String) -> Json {
  st_call_item(helper, site, Json::null(), true)
}

///|
/// The answer's action: the lane's step is done for this pass.
fn st_action(action : String) -> Json {
  json_object([("do", Json::string("action")), ("action", Json::string(action))])
}

///|
/// The answer's action, with the reason the caller reports for the lane.
fn st_action_reason(action : String, reason : String) -> Json {
  json_object([
    ("do", Json::string("action")),
    ("action", Json::string(action)),
    ("reason", Json::string(reason)),
  ])
}

///|
/// The answer's action for a stage that waits rather than fails (room, the cap, a replacement under way): the lane
/// starts by itself once the wait is over, so the stage says so in its own answer and the caller reads no words.
fn st_action_wait(reason : String) -> Json {
  json_object([
    ("do", Json::string("action")),
    ("action", Json::string("skipped")),
    ("reason", Json::string(reason)),
    ("wait", Json::boolean(true)),
  ])
}

///|
/// The answer's action, with the failure the caller reports for the lane.
fn st_action_error(action : String, error : String) -> Json {
  json_object([
    ("do", Json::string("action")),
    ("action", Json::string(action)),
    ("error", Json::string(error)),
  ])
}

///|
/// The answer: the steps to run, in order.
fn st_steps(steps : Array[Json]) -> Json {
  json_object([("steps", Json::array(steps))])
}

// ---------- the rows and the facts ----------

///|
/// A lane's own rows, in the order they were written.
fn st_rows_of(rows : Array[DerivedRow], lane : String) -> Array[DerivedRow] {
  let out : Array[DerivedRow] = []
  for row in rows {
    if row.idd_id == lane {
      out.push(row)
    }
  }
  out
}

///|
/// Whether any of a lane's rows is the event the name is.
fn st_has(rows : Array[DerivedRow], event : DerivedEvent) -> Bool {
  for row in rows {
    if row.event == event {
      return true
    }
  }
  false
}

///|
/// How many of a lane's rows are the event the name is.
fn st_count(rows : Array[DerivedRow], event : DerivedEvent) -> Int {
  let mut n = 0
  for row in rows {
    if row.event == event {
      n = n + 1
    }
  }
  n
}

///|
/// The lanes the rows name, once each, in the order they first appear.
fn st_lanes(rows : Array[DerivedRow]) -> Array[String] {
  let seen : Map[String, Bool] = Map([])
  let out : Array[String] = []
  for row in rows {
    if seen.get(row.idd_id) is None {
      seen.set(row.idd_id, true)
      out.push(row.idd_id)
    }
  }
  out
}

///|
/// Whether a lane is closed or put on hold: its startup stage leaves it alone.
fn st_closed(rows : Array[DerivedRow]) -> Bool {
  st_has(rows, EvLaneClose) || st_has(rows, EvS1Defer)
}

///|
/// The text of a fact the caller answered, or the empty string.
fn st_text(value : Json, id : String) -> String {
  js_string_opt(field(value, id), "")
}

///|
/// Whether a fact is a false or a missing answer: both read the same way.
fn st_yes(facts : Json, id : String) -> Bool {
  js_truthy(field(facts, id))
}

///|
/// A whole number a fact holds, or zero.
fn st_int(facts : Json, id : String) -> Int {
  match int_of(field(facts, id)) {
    Some(n) => n
    None => 0
  }
}

///|
/// A named step's answer, as the caller keeps it: the object the helper answered.
fn st_answer(facts : Json, helper : String, site : String) -> Json {
  let kept = field(facts, "call|" + helper + "|" + site)
  field(kept, "result")
}

///|
/// Whether the helper named by the site has been called already.
fn st_called(facts : Json, helper : String, site : String) -> Bool {
  fact_given(facts, "call|" + helper + "|" + site)
}

///|
/// A slot's cap, never below zero.
fn st_capacity(limit : Int, running : Int) -> Int {
  let left = limit - running
  if left > 0 {
    left
  } else {
    0
  }
}

// ---------- the running counts ----------

///|
/// The sessions that still hold a slot of the stage: the lane's rows do not end them yet (C-205-2).
fn st_running_sessions(
  rows : Array[DerivedRow],
  facts : Json,
  stage : String,
) -> Int {
  let sessions = array_of(field(facts, "sessions"))
  let ended : Array[DerivedEvent] = if stage == "executor" {
    [EvS2Result, EvLaneClose]
  } else {
    [EvS1Ready, EvS1Defer, EvLaneClose]
  }
  let mut n = 0
  for session in sessions {
    // a session spawned to carry a fix is not a lane's implementation slot
    if stage == "executor" && st_text(session, "kind") == "fix" {
      continue
    }
    let id = st_text(session, "idd_id")
    if id == "" {
      continue
    }
    let lane_rows = st_rows_of(rows, id)
    let mut over = false
    for event in ended {
      if st_has(lane_rows, event) {
        over = true
      }
    }
    if !over {
      n = n + 1
    }
  }
  n
}

///|
/// How many lanes are at the stage now: the sessions that still hold a slot, or the plan reviews still running.
pub fn start_running(
  rows : Array[DerivedRow],
  facts : Json,
  stage : String,
) -> Int {
  if stage != "plan_review" {
    return st_running_sessions(rows, facts, stage)
  }
  let mut n = 0
  for lane in st_lanes(rows) {
    let lane_rows = st_rows_of(rows, lane)
    if st_closed(lane_rows) {
      continue
    }
    let phase = plan_review_phase(lane_rows)
    if st_text(phase, "phase") == "running" {
      n = n + 1
    }
  }
  n
}

// ---------- the planner's start ----------

///|
/// Whether a lane's planner may start, and the steps that start it: the slot it waits for, its worktree, the session,
/// its record, the brief it is handed.
pub fn start_prep(rows : Array[DerivedRow], facts : Json) -> Json {
  let running = st_running_sessions(rows, facts, "planner")
  let capacity = st_capacity(st_int(facts, "limit"), running)
  let steps : Array[Json] = []
  // the engine is being replaced with code this process has not loaded: the start waits for the replacement
  let hold = st_text(facts, "hold")
  if hold != "" {
    steps.push(st_action_wait(hold))
    return st_steps(steps)
  }
  if !st_yes(facts, "runner") {
    steps.push(st_action_reason("skipped", "no runner"))
    return st_steps(steps)
  }
  if st_int(facts, "started") >= capacity {
    steps.push(st_action_wait("concurrency cap"))
    return st_steps(steps)
  }
  if !st_prep_worktree(facts, steps, "prep") {
    return st_steps(steps)
  }
  if !st_prep_spawn(facts, steps) {
    return st_steps(steps)
  }
  if !st_prep_call(facts, steps, "record_session") {
    return st_steps(steps)
  }
  if !st_prep_call(facts, steps, "record_quota_fallbacks") {
    return st_steps(steps)
  }
  if !st_prep_call(facts, steps, "deliver") {
    return st_steps(steps)
  }
  steps.push(st_action("started"))
  st_steps(steps)
}

///|
/// The worktree the planner starts in: a place out of space holds the lane back, a repo with no place has none.
fn st_prep_worktree(facts : Json, steps : Array[Json], site : String) -> Bool {
  if !st_called(facts, "ensure_worktree", site) {
    steps.push(st_call("ensure_worktree", site))
    return false
  }
  let work = st_answer(facts, "ensure_worktree", site)
  if js_truthy(field(work, "none")) {
    steps.push(st_action_reason("skipped", "area has no local_path"))
    return false
  }
  let error = st_text(work, "error")
  if error != "" {
    let held = st_text(work, "hold")
    if held != "" {
      steps.push(st_action_wait(held))
    } else {
      steps.push(st_action_reason("skipped", "worktree: " + error))
    }
    return false
  }
  true
}

///|
/// The session, and its failure: a Claude Code window's wait is recorded before the lane is skipped.
fn st_prep_spawn(facts : Json, steps : Array[Json]) -> Bool {
  if !st_called(facts, "spawn", "prep") {
    steps.push(st_call("spawn", "prep"))
    return false
  }
  let spawned = st_answer(facts, "spawn", "prep")
  let error = st_text(spawned, "error")
  if error == "" {
    return true
  }
  let quota = field(spawned, "quota")
  if js_truthy(quota) {
    if !st_called(facts, "record_quota_wait", "prep") {
      steps.push(st_call("record_quota_wait", "prep"))
      return false
    }
    steps.push(
      st_action_reason("skipped", "claude quota: " + st_text(quota, "reason")),
    )
    return false
  }
  steps.push(st_action_reason("skipped", error))
  false
}

///|
/// One helper the planner's start calls; a failure the helper answered ends the start as its error did.
fn st_prep_call(facts : Json, steps : Array[Json], helper : String) -> Bool {
  if !st_called(facts, helper, "prep") {
    steps.push(st_call(helper, "prep"))
    return false
  }
  let answer = st_answer(facts, helper, "prep")
  let error = st_text(answer, "error")
  if error != "" {
    let quota = field(answer, "quota")
    if js_truthy(quota) {
      if !st_called(facts, "record_quota_wait", "prep") {
        steps.push(st_call("record_quota_wait", "prep"))
        return false
      }
      steps.push(
        st_action_reason("skipped", "claude quota: " + st_text(quota, "reason")),
      )
      return false
    }
    steps.push(st_action_reason("skipped", error))
    return false
  }
  true
}

// ---------- the executor's start ----------

///|
/// Whether a lane's executor may start, and the steps that start it: the start it is allowed to write, its worktree,
/// the plan records, the contract, the records commit, the session, the start record, the brief.
pub fn start_exec(rows : Array[DerivedRow], facts : Json) -> Json {
  let lane = st_text(facts, "lane")
  let lane_rows = st_rows_of(rows, lane)
  let running = st_running_sessions(rows, facts, "executor")
  let capacity = st_capacity(st_int(facts, "limit"), running)
  let steps : Array[Json] = []
  if !st_yes(facts, "runner") {
    steps.push(st_action_reason("skipped", "no runner"))
    return st_steps(steps)
  }
  if st_int(facts, "started") >= capacity {
    steps.push(st_action_wait("concurrency cap"))
    return st_steps(steps)
  }
  // the lane may have been aborted or sent back since the list was read: nothing is made or spawned for it
  if !st_called(facts, "transition_refusal", "s2_start") {
    steps.push(st_call("transition_refusal", "s2_start"))
    return st_steps(steps)
  }
  let refusal = st_answer(facts, "transition_refusal", "s2_start")
  let refused = st_text(refusal, "reason")
  if refused != "" {
    steps.push(st_action_reason("skipped", "s2_start: " + refused))
    return st_steps(steps)
  }
  if !st_prep_worktree(facts, steps, "exec") {
    return st_steps(steps)
  }
  // a v2 lane writes its plan report's drafts and disposals to the column before its executor starts
  let shape_state = st_ready_shape(lane_rows) == "state" ||
    st_text(facts, "sessionShape") == "state"
  if shape_state && !st_has(lane_rows, EvS2PlanWritten) {
    if st_plan_records(lane_rows) is None {
      steps.push(
        st_action_reason(
          "skipped", "plan records: s1_ready か plan_records がありません",
        ),
      )
      return st_steps(steps)
    }
    if !st_called(facts, "write_plan_records", "exec") {
      steps.push(st_call("write_plan_records", "exec"))
      return st_steps(steps)
    }
    let wrote = st_answer(facts, "write_plan_records", "exec")
    let error = st_text(wrote, "error")
    if error != "" {
      steps.push(st_action_reason("skipped", "plan records: " + error))
      return st_steps(steps)
    }
    if !st_yes(wrote, "ok") {
      steps.push(st_action_reason("skipped", "plan records: " + error))
      return st_steps(steps)
    }
    if !js_truthy(field(wrote, "done")) {
      steps.push(
        st_action_reason("skipped", "plan records: 書き終えていません"),
      )
      return st_steps(steps)
    }
    steps.push(st_write("s2_plan_written", field(wrote, "attrs")))
    return st_steps(steps)
  }
  // a lane whose records hold no decision but do hold a condition still has a contract to implement
  if !st_called(facts, "read_contract", "exec") {
    steps.push(st_call_fatal("read_contract", "exec"))
    return st_steps(steps)
  }
  if js_truthy(field(st_answer(facts, "read_contract", "exec"), "empty")) {
    steps.push(st_action_reason("skipped", "contract is empty"))
    return st_steps(steps)
  }
  // the planner's records are committed before the executor moves: they are not in the published diff
  if !st_called(facts, "commit_records", "exec") {
    steps.push(st_call("commit_records", "exec"))
    return st_steps(steps)
  }
  let committed = st_answer(facts, "commit_records", "exec")
  let commit_error = st_text(committed, "error")
  if commit_error != "" {
    steps.push(st_action_reason("skipped", commit_error))
    return st_steps(steps)
  }
  // the spawn runs outside the lane gate: the start is checked inside it afterwards
  if !st_called(facts, "spawn", "exec") {
    steps.push(st_call("spawn", "exec"))
    return st_steps(steps)
  }
  let spawned = st_answer(facts, "spawn", "exec")
  let spawn_error = st_text(spawned, "error")
  if spawn_error != "" {
    let quota = field(spawned, "quota")
    if js_truthy(quota) {
      if !st_called(facts, "record_quota_wait", "exec") {
        steps.push(st_call("record_quota_wait", "exec"))
        return st_steps(steps)
      }
      steps.push(
        st_action_reason("skipped", "claude quota: " + st_text(quota, "reason")),
      )
      return st_steps(steps)
    }
    steps.push(st_action_reason("skipped", spawn_error))
    return st_steps(steps)
  }
  // the start's record: the session is recorded first, and a start that did not go through takes it back
  if !st_called(facts, "write_start", "exec") {
    steps.push(st_call("write_start", "exec"))
    return st_steps(steps)
  }
  let started = st_answer(facts, "write_start", "exec")
  let start_error = st_text(started, "error")
  let start_refused = st_text(started, "reason")
  let failed = if start_error != "" { start_error } else { start_refused }
  if failed != "" {
    if !st_called(facts, "discard_session", "exec") {
      steps.push(st_call("discard_session", "exec"))
      return st_steps(steps)
    }
    let discarded = st_answer(facts, "discard_session", "exec")
    steps.push(
      st_action_reason(
        "skipped",
        "s2_start: " + failed + st_text(discarded, "left"),
      ),
    )
    return st_steps(steps)
  }
  if !st_called(facts, "deliver", "exec") {
    steps.push(st_call("deliver", "exec"))
    return st_steps(steps)
  }
  let delivered = st_answer(facts, "deliver", "exec")
  let deliver_error = st_text(delivered, "error")
  if deliver_error != "" {
    steps.push(st_action_reason("skipped", deliver_error))
    return st_steps(steps)
  }
  steps.push(st_action("started"))
  st_steps(steps)
}

///|
/// The shape the lane's last ready was planned under.
fn st_ready_shape(rows : Array[DerivedRow]) -> String {
  let at = last_row_of(rows, EvS1Ready)
  if at < 0 {
    return "docs"
  }
  if js_string_opt(rows[at].attrs.records_shape, "") == "state" {
    "state"
  } else {
    "docs"
  }
}

///|
/// The plan records a lane's last ready carries, or nothing when it carries none.
fn st_plan_records(rows : Array[DerivedRow]) -> Json? {
  let at = last_row_of(rows, EvS1Ready)
  if at < 0 {
    return None
  }
  match rows[at].attrs.plan_records {
    Json::Object(_) => Some(rows[at].attrs.plan_records)
    _ => None
  }
}

// ---------- the plan review's start ----------

///|
/// Whether a lane's plan review starts, waits, is skipped, or reports the runs' end.
pub fn start_plan_review(rows : Array[DerivedRow], facts : Json) -> Json {
  let lane = st_text(facts, "lane")
  let lane_rows = st_rows_of(rows, lane)
  if st_closed(lane_rows) || lane_held(lane_rows) {
    return st_steps([st_action("none")])
  }
  let phase = plan_review_phase(lane_rows)
  let name = st_text(phase, "phase")
  if name == "waiting" {
    return st_plan_review_waiting(rows, lane_rows, facts)
  }
  if name == "running" {
    return st_plan_review_running(lane_rows, facts)
  }
  st_steps([st_action("none")])
}

///|
/// A lane whose review has not started: the slot it waits for, the planner's worktree, the runs.
fn st_plan_review_waiting(
  rows : Array[DerivedRow],
  lane_rows : Array[DerivedRow],
  facts : Json,
) -> Json {
  let steps : Array[Json] = []
  if !st_yes(facts, "declared") {
    // the plan this ready carries was already recorded as skipped: the record says it once, and the ticks after wait
    // for the slot without writing it again (a phase that reads the skip as the review's end never gets here; this stays
    // so a phase that waits again cannot write it twice)
    if last_row_of(lane_rows, EvS1PlanReviewSkipped) >
      last_row_of(lane_rows, EvS1Ready) {
      return st_steps([st_action("waiting")])
    }
    steps.push(
      st_write(
        "s1_plan_review_skipped",
        json_object([
          ("reason", Json::string("pipeline.plan_review が未宣言")),
        ]),
      ),
    )
    steps.push(st_action("skipped"))
    return st_steps(steps)
  }
  let running = start_running(rows, facts, "plan_review")
  // the lanes this pass already started hold slots too: the rows the caller handed in do not carry them
  if !st_yes(facts, "runnerStart") ||
    running + st_int(facts, "started") >= st_int(facts, "limit") {
    return st_steps([st_action("waiting")])
  }
  if !st_called(facts, "planner_worktree", "start") {
    return st_steps([st_call("planner_worktree", "start")])
  }
  let planner = st_answer(facts, "planner_worktree", "start")
  if js_truthy(field(planner, "none")) {
    let error = "planner の worktree が記録にありません"
    steps.push(st_plan_review_failed(error))
    steps.push(st_action_error("error", error))
    return st_steps(steps)
  }
  if !st_called(facts, "start_runs", "start") {
    return st_steps([st_call("start_runs", "start")])
  }
  let started = st_answer(facts, "start_runs", "start")
  let quota = field(started, "quota")
  if js_truthy(quota) {
    // waiting for Claude Code's windows is not a failed review: the lane waits and the next tick tries again
    if !st_called(facts, "record_quota_wait", "start") {
      return st_steps([st_call("record_quota_wait", "start")])
    }
    return st_steps([st_action("waiting")])
  }
  let error = st_text(started, "error")
  if error != "" {
    steps.push(st_plan_review_failed(error))
    steps.push(st_action_error("error", error))
    return st_steps(steps)
  }
  let attempt = st_count(lane_rows, EvS1PlanReviewStarted) + 1
  steps.push(
    st_write("s1_plan_review_started", st_started_attrs(started, attempt)),
  )
  steps.push(st_action("started"))
  st_steps(steps)
}

///|
/// The record a review that could not start leaves: never a block on the GO.
fn st_plan_review_failed(error : String) -> Json {
  st_write(
    "s1_plan_review_done",
    json_object([
      ("failed", Json::boolean(true)),
      ("error", Json::string(error)),
    ]),
  )
}

///|
/// The started record: the runs, the attempt, the roles that did not start, and the ones that stood in.
fn st_started_attrs(answer : Json, attempt : Int) -> Json {
  let ids : Array[Json] = []
  let runs : Array[Json] = []
  for run in array_of(field(answer, "runs")) {
    let id = st_text(run, "runId")
    ids.push(Json::string(id))
    let fields : Array[(String, Json)] = [("run_id", Json::string(id))]
    let role = st_text(run, "role")
    if role != "" {
      fields.push(("role", Json::string(role)))
    }
    let model = st_text(run, "model")
    if model != "" {
      fields.push(("model", Json::string(model)))
    }
    if js_truthy(field(run, "shape")) {
      fields.push(("shape", Json::boolean(true)))
    }
    runs.push(json_object(fields))
  }
  let fields : Array[(String, Json)] = [
    ("run_ids", Json::array(ids)),
    ("runs", Json::array(runs)),
    ("attempt", Json::number(attempt.to_double())),
  ]
  let failed = field(answer, "failed")
  match failed {
    Json::Array(items) =>
      if items.length() > 0 {
        fields.push(("start_failed", failed))
      }
    _ => ()
  }
  let fallbacks = field(answer, "fallbacks")
  match fallbacks {
    Json::Array(items) =>
      if items.length() > 0 {
        fields.push(("fallbacks", fallbacks))
      }
    _ => ()
  }
  json_object(fields)
}

///|
/// The run ids a started record names.
fn st_run_ids(started : Json) -> Array[String] {
  let ids : Array[String] = []
  match field(started, "run_ids") {
    Json::Array(items) =>
      for item in items {
        let text = js_string(item)
        if text != "" {
          ids.push(text)
        }
      }
    _ => ()
  }
  if ids.length() > 0 {
    return ids
  }
  let one = st_text(started, "run_id")
  if one != "" {
    ids.push(one)
  }
  ids
}

///|
/// The runs a started record lists, by id: the role and the model each read as.
fn st_run_meta(started : Json, ids : Array[String]) -> Array[Json] {
  let listed = array_of(field(started, "runs"))
  let out : Array[Json] = []
  for id in ids {
    let mut role = ""
    let mut model = ""
    let mut shape = false
    for row in listed {
      if st_text(row, "run_id") == id {
        role = st_text(row, "role")
        model = st_text(row, "model")
        shape = js_truthy(field(row, "shape"))
      }
    }
    if model == "" && ids.length() == 1 {
      model = st_text(started, "model")
    }
    let fields : Array[(String, Json)] = [("run_id", Json::string(id))]
    if role != "" {
      fields.push(("role", Json::string(role)))
    }
    if model != "" {
      fields.push(("model", Json::string(model)))
    }
    if shape {
      fields.push(("shape", Json::boolean(true)))
    }
    out.push(json_object(fields))
  }
  out
}

///|
/// The name a run reads as: a role run by more than one model keeps both, so a finding is traceable to its run.
fn st_run_label(
  run : Json,
  index : Int,
  role_runs : Map[String, Int],
) -> String {
  let role = st_text(run, "role")
  let model = st_text(run, "model")
  if role != "" {
    let same = match role_runs.get(role) {
      Some(n) => n
      None => 0
    }
    if same > 1 && model != "" {
      return role + "/" + model
    }
    return role
  }
  if model != "" {
    return model
  }
  "run-" + (index + 1).to_string()
}

///|
/// How many findings of a severity a list holds.
fn st_severity_count(findings : Array[Json], severity : String) -> Int {
  let mut n = 0
  for finding in findings {
    if st_text(finding, "severity") == severity {
      n = n + 1
    }
  }
  n
}

///|
/// A run's own attrs: its id, the role and the model it read as.
fn st_run_fields(run : Json) -> Array[(String, Json)] {
  let fields : Array[(String, Json)] = [
    ("run_id", Json::string(st_text(run, "run_id"))),
  ]
  let role = st_text(run, "role")
  if role != "" {
    fields.push(("role", Json::string(role)))
  }
  let model = st_text(run, "model")
  if model != "" {
    fields.push(("model", Json::string(model)))
  }
  if js_truthy(field(run, "shape")) {
    fields.push(("shape", Json::boolean(true)))
  }
  fields
}

///|
/// The runs that did not finish, each named by its label and the error it ended with.
fn st_failed_parts(
  per_run : Array[Json],
  role_runs : Map[String, Int],
) -> Array[String] {
  let parts : Array[String] = []
  let mut j = 0
  while j < per_run.length() {
    if js_truthy(field(per_run[j], "failed")) {
      parts.push(
        st_run_label(per_run[j], j, role_runs) +
        ": " +
        st_text(per_run[j], "error"),
      )
    }
    j = j + 1
  }
  parts
}

///|
/// A lane whose review runs: the runs' states, the counts the closing record keeps, and the send-back it opens.
fn st_plan_review_running(lane_rows : Array[DerivedRow], facts : Json) -> Json {
  if !st_yes(facts, "runnerStatus") {
    return st_steps([st_action("waiting")])
  }
  let at = last_row_of(lane_rows, EvS1PlanReviewStarted)
  let started = if at < 0 {
    Json::null()
  } else {
    let row = lane_rows[at]
    let fields : Array[(String, Json)] = [
      ("run_ids", row.attrs.run_ids),
      ("run_id", row.attrs.run_id),
      ("runs", row.attrs.runs),
      ("start_failed", row.attrs.start_failed),
      ("model", row.attrs.model),
    ]
    json_object(fields)
  }
  let ids = st_run_ids(started)
  // a run still answering leaves the lane where it is
  for id in ids {
    if !st_called(facts, "run_status", id) {
      return st_steps([
        st_call_args(
          "run_status",
          id,
          json_object([("runId", Json::string(id))]),
        ),
      ])
    }
    if st_text(st_answer(facts, "run_status", id), "state") == "running" {
      return st_steps([st_action("waiting")])
    }
  }
  let meta = st_run_meta(started, ids)
  let role_runs : Map[String, Int] = Map([])
  for run in meta {
    let role = st_text(run, "role")
    if role != "" {
      let count = match role_runs.get(role) {
        Some(n) => n
        None => 0
      }
      role_runs.set(role, count + 1)
    }
  }
  // the run each finished list belongs to, and the runs that did not finish
  let per_run : Array[Json] = []
  let done : Array[Int] = []
  // the shape judge is a condition of its own: its run is counted apart from the reviewers' (C-252-5)
  let mut shape_runs = 0
  let mut shape_done = 0
  let mut failed = 0
  let mut i = 0
  while i < meta.length() {
    let run = meta[i]
    let status = st_answer(facts, "run_status", st_text(run, "run_id"))
    let fields = st_run_fields(run)
    if st_text(status, "state") == "done" {
      let findings = array_of(field(status, "findings"))
      fields.push(
        ("must", Json::number(st_severity_count(findings, "must").to_double())),
      )
      fields.push(
        (
          "should",
          Json::number(st_severity_count(findings, "should").to_double()),
        ),
      )
      fields.push(
        ("nit", Json::number(st_severity_count(findings, "nit").to_double())),
      )
      let report = field(status, "reportMd")
      match report {
        Json::String(_) => fields.push(("report_md", report))
        _ => ()
      }
      done.push(i)
      if js_truthy(field(run, "shape")) {
        shape_runs = shape_runs + 1
        shape_done = shape_done + 1
      }
    } else {
      if js_truthy(field(run, "shape")) {
        shape_runs = shape_runs + 1
      }
      fields.push(("failed", Json::boolean(true)))
      fields.push(("error", Json::string(st_text(status, "error"))))
      failed = failed + 1
    }
    per_run.push(json_object(fields))
    i = i + 1
  }
  for run in array_of(field(started, "start_failed")) {
    let fields : Array[(String, Json)] = []
    let role = st_text(run, "role")
    if role != "" {
      fields.push(("role", Json::string(role)))
    }
    let model = st_text(run, "model")
    if model != "" {
      fields.push(("model", Json::string(model)))
    }
    if js_truthy(field(run, "shape")) {
      fields.push(("shape", Json::boolean(true)))
      shape_runs = shape_runs + 1
    }
    fields.push(("failed", Json::boolean(true)))
    fields.push(("error", Json::string(st_text(run, "error"))))
    per_run.push(json_object(fields))
    failed = failed + 1
  }
  let steps : Array[Json] = []
  // no reviewer finished, whatever the shape judge did: the review is a failure, which never blocks GO. A judge that
  // finished does not stand in for a reviewer that did not, nor the other way round.
  if done.length() - shape_done == 0 {
    let parts = st_failed_parts(per_run, role_runs)
    let error = if parts.length() > 0 {
      parts.join(" / ")
    } else {
      "査読の run が記録にありません"
    }
    steps.push(
      st_write(
        "s1_plan_review_done",
        json_object([
          ("run_ids", Json::array(ids.map(Json::string))),
          ("failed", Json::boolean(true)),
          ("error", Json::string(error)),
          ("runs", Json::array(per_run)),
        ]),
      ),
    )
    steps.push(st_action("finished"))
    return st_steps(steps)
  }
  // the finished runs' findings, each named by the run that read it; one run folds nothing
  if !st_called(facts, "merge_findings", "review") {
    let lists : Array[Json] = []
    for index in done {
      let run = meta[index]
      let status = st_answer(facts, "run_status", st_text(run, "run_id"))
      let source = st_run_label(run, index, role_runs)
      let items : Array[Json] = []
      for finding in array_of(field(status, "findings")) {
        if st_text(finding, "source") != "" {
          items.push(finding)
        } else {
          items.push(with_text_field(finding, "source", source))
        }
      }
      lists.push(Json::array(items))
    }
    return st_steps([
      st_call_item(
        "merge_findings",
        "review",
        json_object([("lists", Json::array(lists))]),
        true,
      ),
    ])
  }
  let findings = array_of(
    field(st_answer(facts, "merge_findings", "review"), "findings"),
  )
  // a send-back needs the plan the planner is told to correct: the reading stays with the caller
  if !st_called(facts, "has_plan", "review") {
    return st_steps([st_call_fatal("has_plan", "review")])
  }
  let sent_back = st_severity_count(findings, "must") > 0
  // the reports, in the runs' order, and the fallbacks they took
  let reports : Array[Json] = []
  let report_md : Array[Json] = []
  let fallbacks : Array[Json] = []
  for index in done {
    let run = meta[index]
    let status = st_answer(facts, "run_status", st_text(run, "run_id"))
    let fields : Array[(String, Json)] = [
      ("role", Json::string(st_run_label(run, index, role_runs))),
    ]
    let model = st_text(run, "model")
    if model != "" {
      fields.push(("model", Json::string(model)))
    }
    let report = field(status, "reportMd")
    match report {
      Json::String(_) => {
        fields.push(("report_md", report))
        report_md.push(report)
      }
      _ => report_md.push(Json::null())
    }
    reports.push(json_object(fields))
    for fallback in array_of(field(status, "fallbacks")) {
      fallbacks.push(fallback)
    }
  }
  let kept : Array[Json] = []
  for finding in findings {
    if kept.length() >= 12 {
      break
    }
    let fields : Array[(String, Json)] = [
      ("severity", field(finding, "severity")),
      ("path", field(finding, "path")),
      ("claim", field(finding, "claim")),
    ]
    let source = field(finding, "source")
    match source {
      Json::String(_) => fields.push(("source", source))
      _ => ()
    }
    kept.push(json_object(fields))
  }
  let attrs : Array[(String, Json)] = [
    ("run_ids", Json::array(ids.map(Json::string))),
    ("must", Json::number(st_severity_count(findings, "must").to_double())),
    ("should", Json::number(st_severity_count(findings, "should").to_double())),
    ("nit", Json::number(st_severity_count(findings, "nit").to_double())),
    ("sent_back", Json::boolean(sent_back)),
    ("reports", Json::array(reports)),
    ("runs", Json::array(per_run)),
    ("findings", Json::array(kept)),
  ]
  let first = st_run_at(meta, done[0])
  let first_status = st_answer(facts, "run_status", st_text(first, "run_id"))
  match field(first_status, "reportMd") {
    Json::String(_) =>
      attrs.push(("report_md", field(first_status, "reportMd")))
    _ => ()
  }
  if failed > 0 {
    attrs.push(("failed_runs", Json::number(failed.to_double())))
  }
  if fallbacks.length() > 0 {
    attrs.push(("fallbacks", Json::array(fallbacks)))
  }
  // a shape judge that was asked for and did not finish leaves a review that did not answer in full. A plan sent back
  // is reviewed again before the GO, so the failure is recorded only when nothing sends it back.
  if shape_runs > 0 && shape_done == 0 && !sent_back {
    attrs.push(("failed", Json::boolean(true)))
    attrs.push(
      (
        "error",
        Json::string(
          "形の判断が走り切れなかった: " +
          st_failed_parts(per_run, role_runs).join(" / "),
        ),
      ),
    )
  }
  steps.push(st_write("s1_plan_review_done", json_object(attrs)))
  if sent_back {
    steps.push(
      st_call_item(
        "queue_envelope",
        "review",
        json_object([
          ("findings", Json::array(findings)),
          ("reports", Json::array(report_md)),
          (
            "hasPlan",
            Json::boolean(
              st_yes(st_answer(facts, "has_plan", "review"), "hasPlan"),
            ),
          ),
        ]),
        true,
      ),
    )
  }
  steps.push(st_action("finished"))
  st_steps(steps)
}

///|
/// The run at an index of the runs the started record lists.
fn st_run_at(runs : Array[Json], index : Int) -> Json {
  if index >= 0 && index < runs.length() {
    runs[index]
  } else {
    Json::null()
  }
}
