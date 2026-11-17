// The boundary the caller uses: rows in, folded records out.
//
// The caller reads the columns and hands a row over once; the fold keeps it, so a read costs what was added
// rather than the whole column. The rows are named by the caller's own numbers, because the same row is read
// again by every card that shows a Choice and must be folded once, not handed over and parsed again each
// time. Everything that crosses is a string of JSON: the row in, the folded records back.

///|
/// What the boundary refuses: a row the caller named but never handed over, a pair that is not a row, and a
/// string that is not JSON. All of them are failures the caller sees, never a folded answer.
pub(all) suberror FoldError {
  MissingRow(Int)
  BadPair(String)
  BadJson(@json.ParseError)
  /// a step this side does not answer yet: the caller is told, never answered with a guess
  NotYet(String)
}

///|
/// The lifecycle rows this side holds, by the caller's numbers.
let lifecycle_rows : Map[Int, LifecycleRow] = Map([])

///|
/// The same rows as the derivations read them, by the caller's numbers.
let lifecycle_derived : Map[Int, DerivedRow] = Map([])

///|
/// The intent rows this side holds, by the caller's numbers.
let intent_rows : Map[Int, IntentRow] = Map([])

///|
/// JSON from the caller, as a value; a string that is not JSON is a failure, not an empty reading.
fn parse_json(text : String) -> Json raise FoldError {
  @json.parse(text) catch {
    error => raise BadJson(error)
  }
}

///|
/// The pairs `[[row number, the row], ...]` a caller hands over.
fn rows_of(text : String) -> Array[(Int, Json)] raise FoldError {
  let parsed = parse_json(text)
  let out : Array[(Int, Json)] = []
  for item in array_of(parsed) {
    let pair = array_of(item)
    match (pair.get(0), pair.get(1)) {
      (Some(number), Some(row)) =>
        match int_of(number) {
          Some(id) => out.push((id, row))
          None => raise BadPair(item.stringify())
        }
      _ => raise BadPair(item.stringify())
    }
  }
  out
}

///|
/// A non-negative whole number written as decimal digits, or nothing.
fn decimal_of(text : String) -> Int? {
  if text.length() == 0 {
    return None
  }
  let mut value = 0
  for ch in text {
    let digit = ch.to_int() - 48
    if digit < 0 || digit > 9 {
      return None
    }
    value = value * 10 + digit
  }
  Some(value)
}

///|
/// The row numbers a caller names, in the order it names them: a space-separated list of decimal numbers. It is
/// not JSON because it is written and read on every answer, and a pass over a lane's prefixes writes thousands.
fn ids_of(text : String) -> Array[Int] raise FoldError {
  let out : Array[Int] = []
  let mut i = 0
  let length = text.length()
  while i < length {
    while i < length && text.at(i) == ' ' {
      i = i + 1
    }
    if i >= length {
      break
    }
    let start = i
    while i < length && text.at(i) != ' ' {
      i = i + 1
    }
    match decimal_of(text[start:i].to_owned()) {
      Some(id) => out.push(id)
      None => raise BadPair(text[start:i].to_owned())
    }
  }
  out
}

///|
/// Hand over the lifecycle rows this side does not hold yet.
pub fn put_lifecycle(text : String) -> Unit raise FoldError {
  for pair in rows_of(text) {
    lifecycle_rows.set(pair.0, lifecycle_row_of(pair.1))
    lifecycle_derived.set(pair.0, derived_row_of(pair.1))
  }
}

///|
/// Hand over the intent rows this side does not hold yet.
pub fn put_intent(text : String) -> Unit raise FoldError {
  for pair in rows_of(text) {
    intent_rows.set(pair.0, intent_row_of(pair.1))
  }
}

///|
/// Fold the lifecycle rows the caller names into the lanes' states, as JSON.
pub fn lane_states(ids : String) -> String raise FoldError {
  let states : Map[String, LaneState] = Map([])
  for id in ids_of(ids) {
    let row = match lifecycle_rows.get(id) {
      Some(row) => row
      None => raise MissingRow(id)
    }
    note_lane_row(states, row)
  }
  lane_states_json(states).stringify()
}

///|
/// Fold the intent rows the caller names, as one viewer sees them, into today's records, as JSON.
pub fn fold_records(
  ids : String,
  viewer : String,
  states : String,
) -> String raise FoldError {
  let rows : Array[IntentRow] = []
  for id in ids_of(ids) {
    let row = match intent_rows.get(id) {
      Some(row) => row
      None => raise MissingRow(id)
    }
    rows.push(row)
  }
  let seen = match parse_json(viewer) {
    Json::String(lane) => Some(lane)
    _ => None
  }
  fold_records_of(rows, seen, lane_states_of(parse_json(states)))
}

///|
/// The rows a caller names, in the order it names them, as the derivations read them. A reading asked twice (the
/// stage's answer and the loop's answer over one lane are the same rows) is kept by the names it was asked under:
/// the rows do not move, and reading the numbers again is the most expensive part of a small answer.
let derived_cache : Map[String, (Array[DerivedRow], Array[Int]?)] = Map([])

///|
/// The most readings the cache keeps: a pass over a lane's prefixes asks many, and the ones a screen comes back to
/// are the lanes it shows.
const DERIVED_CACHE_KEPT : Int = 96

///|
/// The rows the derivations read for a lane that went back to its plan: the implementation era (from the lane's
/// first `s1_go` up to the last row that sent it back, `returns_to_plan`) is left out, so the lane reads as it did at the plan
/// stage and every "has this ever run" reading (the GO, the executor's start, the review loop's rounds) starts
/// again. A budget extension in that era is kept (the raised limit holds after the lane came back). The ledger
/// itself is not changed: the rows of that era stay for the readers that name the whole lane (`round_trace`). A lane
/// with no replan is read as it is.
///
/// This is the places (in the caller's rows) of the rows the view keeps, or nothing when it keeps them all. A caller
/// that hands an index in, or reads one out, counts in the caller's rows (the ledger's order, as its `ids` name them),
/// not in the view's, so `index_reading` and `ledger_index` carry an index across.
fn replan_kept(rows : Array[DerivedRow]) -> Array[Int]? {
  let last_replan : Map[String, Int] = Map([])
  for i, row in rows {
    if returns_to_plan(row) {
      last_replan.set(row.idd_id, i)
    }
  }
  if last_replan.length() == 0 {
    return None
  }
  let first_go : Map[String, Int] = Map([])
  for i, row in rows {
    if row.event == EvS1Go && first_go.get(row.idd_id) is None {
      first_go.set(row.idd_id, i)
    }
  }
  let kept : Array[Int] = []
  for i, row in rows {
    let dropped = match
      (last_replan.get(row.idd_id), first_go.get(row.idd_id)) {
      (Some(replan), Some(go)) => go <= i && i < replan
      _ => false
    }
    // a raised budget is the lane's own record, not a reading of the era that was dropped: `lane_budget` reads the last
    // extension from the back, so keeping it holds the raised limit after the lane came back to its plan
    if !dropped || row.event == EvLaneBudgetExtended {
      kept.push(i)
    }
  }
  if kept.length() == rows.length() {
    None
  } else {
    Some(kept)
  }
}

///|
/// The rows the derivations read for those a lane that went back left in: `replan_kept`'s places, in the rows' order.
fn replan_view(rows : Array[DerivedRow]) -> Array[DerivedRow] {
  match replan_kept(rows) {
    None => rows
    Some(kept) => kept.map(fn(i) { rows[i] })
  }
}

///|
/// The rows a caller names, in the order it names them, with nothing left out (no replan view).
fn derived_rows_whole(ids : String) -> Array[DerivedRow] raise FoldError {
  let rows : Array[DerivedRow] = []
  for id in ids_of(ids) {
    match lifecycle_derived.get(id) {
      Some(row) => rows.push(row)
      None => raise MissingRow(id)
    }
  }
  rows
}

///|
/// The rows a caller names, in the order it names them, as the derivations read them, with the places the view
/// keeps (nothing when it keeps every row).
fn derived_view_named(
  ids : String,
) -> (Array[DerivedRow], Array[Int]?) raise FoldError {
  match derived_cache.get(ids) {
    Some(found) => found
    None => {
      let rows = derived_rows_whole(ids)
      if derived_cache.length() >= DERIVED_CACHE_KEPT {
        derived_cache.clear()
      }
      let viewed = replan_view(rows)
      let kept = replan_kept(rows)
      derived_cache.set(ids, (viewed, kept))
      (viewed, kept)
    }
  }
}

///|
/// What an answer that takes the caller's index reads: the rows, the index in them, and the places to carry an index
/// it returns back to the caller's rows. An index a view row stands at is turned into its place in the view. An index
/// of a row the view left out (the first plan's era, which a caller can still name) is answered from the whole lane,
/// where it is already the caller's own and so is every index it returns. No index counts as the view's last row.
fn index_reading(
  ids : String,
  rows : Array[DerivedRow],
  kept : Array[Int]?,
  at : Int?,
) -> (Array[DerivedRow], Int, Array[Int]?) raise FoldError {
  match kept {
    None =>
      (
        rows,
        match at {
          Some(i) => i
          None => rows.length() - 1
        },
        None,
      )
    Some(places) =>
      match at {
        None => (rows, rows.length() - 1, kept)
        Some(i) => {
          if i < 0 {
            return (rows, i, kept)
          }
          let mut found = -1
          for p, place in places {
            if place == i {
              found = p
              break
            }
          }
          if found >= 0 {
            (rows, found, kept)
          } else {
            (derived_rows_whole(ids), i, None)
          }
        }
      }
  }
}

///|
/// The caller's index for an index in the rows an answer read: a view row's place in the caller's rows, or the index
/// itself when the answer read the whole lane or names no row.
fn ledger_index(kept : Array[Int]?, index : Int) -> Int {
  match kept {
    Some(places) =>
      if index >= 0 && index < places.length() {
        places[index]
      } else {
        index
      }
    None => index
  }
}

///|
/// The index an argument names, or nothing when the caller names none.
fn arg_index_opt(args : Json, key : String) -> Int? {
  match arg(args, key) {
    Json::Null => None
    other => Some(js_num(other).to_int())
  }
}

///|
/// The arguments a caller hands to one answer, as a value. An answer with no arguments is handed as the empty
/// string, so the common case does not parse anything.
fn args_of(text : String) -> Json raise FoldError {
  if text == "" {
    Json::null()
  } else {
    parse_json(text)
  }
}

///|
/// An argument's field.
fn arg(args : Json, key : String) -> Json {
  field(args, key)
}

///|
/// The index an argument names.
fn arg_index(args : Json, key : String) -> Int {
  js_num(arg(args, key)).to_int()
}

///|
/// The pass policy a caller hands in.
fn policy_of(args : Json) -> PassPolicy {
  {
    close_on_must: is_text(arg(args, "closeOnMust"), "true") ||
    js_truthy(arg(args, "closeOnMust")),
    close_on_fix: js_truthy(arg(args, "closeOnFix")),
    max_fix_rounds: whole_at_least_one(arg(args, "maxFixRounds")),
    max_should_fix: whole_at_least_one(arg(args, "maxShouldFix")),
    depth: depth_of(arg(args, "depth")),
    start: arg_index(args, "start"),
  }
}

///|
/// The pass policy as the caller reads it.
fn policy_json(policy : PassPolicy) -> Json {
  let fields : Array[(String, Json)] = [
    ("closeOnMust", Json::boolean(policy.close_on_must)),
    ("closeOnFix", Json::boolean(policy.close_on_fix)),
  ]
  match policy.max_fix_rounds {
    Some(cap) => fields.push(("maxFixRounds", Json::number(cap.to_double())))
    None => ()
  }
  match policy.max_should_fix {
    Some(cap) => fields.push(("maxShouldFix", Json::number(cap.to_double())))
    None => ()
  }
  match policy.depth {
    Some(Shallow) => fields.push(("depth", Json::string("shallow")))
    Some(Standard) => fields.push(("depth", Json::string("standard")))
    Some(Deep) => fields.push(("depth", Json::string("deep")))
    None => ()
  }
  fields.push(("start", Json::number(policy.start.to_double())))
  json_object(fields)
}

///|
/// A send-back as the caller reads it.
fn conflict_send_back_json(back : ConflictSendBack) -> Json {
  let fields : Array[(String, Json)] = [
    ("index", Json::number(back.index.to_double())),
  ]
  match back.head {
    Some(head) => fields.push(("head", Json::string(head)))
    None => ()
  }
  json_object(fields)
}

///|
/// A boundary decision as the caller reads it.
fn boundary_json(boundary : BoundaryDecision) -> Json {
  json_object([
    ("ref", Json::string(boundary.ref_text)),
    ("choice", Json::string(boundary.choice)),
    ("text", Json::string(boundary.text)),
  ])
}

///|
/// A correction as the caller reads it.
fn correction_json(correction : Correction) -> Json {
  json_object([
    ("ref", Json::string(correction.ref_text)),
    ("severity", Json::string(correction.severity)),
    ("action", Json::string(correction.action)),
    ("reason", Json::string(correction.reason)),
  ])
}

///|
/// A fix cap as the caller reads it.
fn fix_cap_json(cap : FixCap, kept : Array[Int]?) -> Json {
  match cap {
    CapLane(fixes, limit) =>
      json_object([
        ("scope", Json::string("lane")),
        ("fixes", Json::number(fixes.to_double())),
        ("cap", Json::number(limit.to_double())),
      ])
    CapPass(fixes, limit, start) =>
      json_object([
        ("scope", Json::string("pass")),
        ("fixes", Json::number(fixes.to_double())),
        ("cap", Json::number(limit.to_double())),
        ("start", Json::number(ledger_index(kept, start).to_double())),
      ])
  }
}

///|
/// The labels a prep lane waits on while its planner works: the one it owes a new ready after the review's
/// findings, and the one it owes penne's instruction. They are declared once, here, and the stage that writes
/// them and the turn that reads them take them from here (C-201-5).
pub fn planner_waits_json() -> String {
  Json::array([Json::string(PLANNER_REVISING), Json::string(PLANNER_SENT_BACK)]).stringify()
}

///|
/// The review loop's event names, as the TypeScript's `REVIEW_EVENTS` lists them.
pub fn review_events_json() -> String {
  let names : Array[Json] = []
  for
    event in [
      "s2_review_started", "s2_review_findings", "s2_triage_started", "s2_triage_done",
      "s2_fix_sent", "s2_confirm_started", "s2_confirm_done", "s2_review_converged",
      "s2_review_escalated", "s2_review_resumed", "s2_review_skipped", "s2_review_merged_skipped",
      "s2_device_started", "s2_device_done", "s2_device_skipped", "s4_review_comment_received",
      "s2_map_started", "s2_map_done", "s2_map_dropped", "s2_map_head_moved", "s2_hand_fixed",
      "s2_review_base_conflict", "s2_order_waiting", "s2_order_passed", "s2_order_released",
      "s2_order_limit", "s2_order_unknown", "s2_intent_checked", "s2_records_conflict",
      "s2_records_instructed", "s2_records_reopened", "s2_checks_started", "s2_checks_done",
    ] {
    names.push(Json::string(event))
  }
  Json::array(names).stringify()
}

///|
/// The one door the derivations answer through: the operation, the rows it reads, and its arguments. An
/// operation the caller does not know is a failure the caller sees, never an empty answer.
pub fn lane_answer(
  op : String,
  ids : String,
  args : String,
) -> String raise FoldError {
  let (rows, kept) = derived_view_named(ids)
  let a = args_of(args)
  match op {
    "stage" => stage_json(stage_with_quota(rows, quota_fact_of(a))).stringify()
    "lane_ended" => Json::boolean(lane_has_ended(rows)).stringify()
    "lane_landed" => Json::boolean(lane_landed(rows)).stringify()
    "lane_held" => Json::boolean(lane_held(rows)).stringify()
    "lane_budget_idle" => Json::boolean(lane_budget_idle(rows)).stringify()
    "lane_budget" =>
      Json::number(lane_budget(rows, js_num(arg(a, "base")))).stringify()
    "lane_over_budget" =>
      match lane_over_budget(rows) {
        Some(budget) =>
          json_object([
            ("cost", Json::number(budget.0)),
            ("limit", Json::number(budget.1)),
          ]).stringify()
        None => Json::null().stringify()
      }
    "lane_stall" =>
      match lane_stall(rows) {
        Some(found) => found.stringify()
        None => Json::null().stringify()
      }
    "lane_halt" =>
      match lane_halt(rows) {
        Some(found) => found.stringify()
        None => Json::null().stringify()
      }
    "plan_review_phase" => plan_review_phase(rows).stringify()
    "granularity_waiting" =>
      Json::boolean(granularity_waiting(rows)).stringify()
    "state" => loop_state_json(review_loop_state(rows)).stringify()
    "next_step" => next_step_of(rows, step_facts_of(a)).stringify()
    "converge_step" => converge_step(rows, step_facts_of(a)).stringify()
    "checks_stop" => {
      let d = checks_stop_at(rows, rows.length())
      if d < 0 {
        Json::null().stringify()
      } else {
        let attrs = rows[d].attrs
        json_object([
          ("head", attrs.head),
          ("outcome", attrs.outcome),
          ("failed", attrs.failed),
          ("error", attrs.error),
          ("checks", attrs.checks),
          ("findings", attrs.findings),
        ]).stringify()
      }
    }
    "submit_step" => submit_step(rows, field(a, "facts"))
    "pre_merge" => pre_merge(rows, field(a, "facts")).stringify()
    "start_prep" => start_prep(rows, field(a, "facts")).stringify()
    "start_exec" => start_exec(rows, field(a, "facts")).stringify()
    "start_plan_review" =>
      start_plan_review(rows, field(a, "facts")).stringify()
    "start_counts" =>
      json_object([
        (
          "running",
          Json::number(
            start_running(
              rows,
              field(a, "facts"),
              js_string(field(field(a, "facts"), "stage")),
            ).to_double(),
          ),
        ),
      ]).stringify()
    "land_failure" => land_failure(field(a, "saved"), field(a, "run"))
    "land_step" =>
      land_step(
        rows,
        field(a, "facts"),
        js_string(arg(a, "mode")),
        js_num(arg(a, "maxRechecks")).to_int(),
        js_num(arg(a, "recheckIntervalMs")),
      )
    "planner_waits" => planner_waits_json()
    "depth_table" => depth_table_json()
    "review_events" => review_events_json()
    "loop_label" => {
      let st = review_loop_state(rows)
      json_object([
        ("name", Json::string(loop_state_name(st))),
        (
          "label",
          match review_loop_label(st, None) {
            Some(label) => Json::string(label)
            None => Json::null()
          },
        ),
      ]).stringify()
    }
    "accepted_of" =>
      Json::array(accepted_of(row_attrs_of(arg(a, "attrs")))).stringify()
    "rejected_of" =>
      Json::array(rejected_of(row_attrs_of(arg(a, "attrs")))).stringify()
    "oscillations_of" =>
      Json::array(
        oscillations_of(row_attrs_of(arg(a, "attrs"))).map(oscillation_json),
      ).stringify()
    "boundaries_of" =>
      Json::array(
        boundaries_of(row_attrs_of(arg(a, "attrs"))).map(boundary_json),
      ).stringify()
    "routes_of" =>
      Json::array(routes_of(arg(a, "attrs")).map(route_json)).stringify()
    "order_opponents_of" =>
      Json::array(
        order_opponents_of(row_attrs_of(arg(a, "attrs"))).map(opponent_json),
      ).stringify()
    "ref_key" => {
      let scope = match arg(a, "scope") {
        Json::Object(_) =>
          Some({
            round: js_num(field(arg(a, "scope"), "round")),
            kind: js_string_opt(field(arg(a, "scope"), "kind"), ""),
          })
        _ => None
      }
      Json::string(ref_key(js_string(arg(a, "ref")), scope)).stringify()
    }
    "fixes_now" => Json::boolean(fixes_now(arg(a, "item"))).stringify()
    "is_followup" => Json::boolean(is_followup(arg(a, "item"))).stringify()
    "fix_counts" => {
      let counts = fix_counts(array_of(arg(a, "items")))
      json_object([
        ("must", Json::number(counts.0.to_double())),
        ("should", Json::number(counts.1.to_double())),
      ]).stringify()
    }
    "within_limit" =>
      Json::boolean(within_limit(arg_index(a, "must"), arg_index(a, "should"))).stringify()
    "blocking" =>
      Json::number(blocking(array_of(arg(a, "items"))).to_double()).stringify()
    "pass_policy" => {
      let (read, at, back) = index_reading(
        ids,
        rows,
        kept,
        arg_index_opt(a, "i"),
      )
      let policy = pass_policy(read, at)
      policy_json({ ..policy, start: ledger_index(back, policy.start), }).stringify()
    }
    "closes_at" => {
      let (read, at, _) = index_reading(ids, rows, kept, arg_index_opt(a, "i"))
      Json::boolean(
        closes_at(read, at, (arg_index(a, "must"), arg_index(a, "should"))),
      ).stringify()
    }
    "over_cap_stop" =>
      match
        over_cap_stop(
          row_attrs_of(arg(a, "attrs")),
          policy_of(arg(a, "policy")),
        ) {
        Some(stop) => Json::string(stop).stringify()
        None => Json::null().stringify()
      }
    "feedback_pass_at" => {
      let (read, at, back) = index_reading(
        ids,
        rows,
        kept,
        arg_index_opt(a, "i"),
      )
      Json::number(ledger_index(back, feedback_pass_at(read, at)).to_double()).stringify()
    }
    "blind_ever_ran" => Json::boolean(blind_ever_ran(rows)).stringify()
    "conflict_send_backs" =>
      Json::array(
        conflict_send_backs(rows).map(fn(back) {
          conflict_send_back_json({
            ..back,
            index: ledger_index(kept, back.index),
          })
        }),
      ).stringify()
    "first_blind_of_pass" =>
      Json::boolean(first_blind_of_pass(rows)).stringify()
    "feedback_triage_at" =>
      Json::number(ledger_index(kept, feedback_triage_at(rows)).to_double()).stringify()
    "s4_triage" => {
      let (read, at, _) = index_reading(
        ids,
        rows,
        kept,
        Some(arg_index(a, "i")),
      )
      Json::boolean(s4_triage(read, at)).stringify()
    }
    "begins_fix_round" => {
      let row : DerivedRow = {
        idd_id: "",
        event: derived_event_of(js_string(arg(a, "event"))),
        at: "",
        attrs: row_attrs_of(arg(a, "attrs")),
      }
      Json::boolean(begins_fix_round(row)).stringify()
    }
    "fix_cap" =>
      match fix_cap_reached(rows, js_truthy(arg(a, "forForecast"))) {
        Some(cap) => fix_cap_json(cap, kept).stringify()
        None => Json::null().stringify()
      }
    "stagnation" =>
      match stagnation(rows) {
        Some(stuck) => Json::string(stuck).stringify()
        None => Json::null().stringify()
      }
    "is_returned_result" => {
      let row : DerivedRow = {
        idd_id: "",
        event: derived_event_of(js_string(arg(a, "event"))),
        at: "",
        attrs: row_attrs_of(arg(a, "attrs")),
      }
      Json::boolean(is_returned_result(row)).stringify()
    }
    "role_changed_in" =>
      Json::boolean(role_changed_in(arg(a, "fallbacks"))).stringify()
    "settled_head" =>
      match settled_head(rows) {
        Some(head) => Json::string(head).stringify()
        None => Json::null().stringify()
      }
    "fix_scope" => fix_scope(rows).stringify()
    "zero_fix_marks" =>
      match zero_fix_marks(rows) {
        Some(marks) => marks.stringify()
        None => Json::null().stringify()
      }
    "answered_judgement_at" => {
      let (read, at, back) = index_reading(
        ids,
        rows,
        kept,
        Some(arg_index(a, "r")),
      )
      Json::number(
        ledger_index(back, answered_judgement_at(read, at)).to_double(),
      ).stringify()
    }
    "fix_after" => {
      let (read, at, back) = index_reading(
        ids,
        rows,
        kept,
        Some(arg_index(a, "i")),
      )
      Json::number(ledger_index(back, fix_after(read, at)).to_double()).stringify()
    }
    "unfixed_of" => {
      let (read, at, _) = index_reading(
        ids,
        rows,
        kept,
        Some(arg_index(a, "t")),
      )
      let fix = match arg(a, "fix") {
        Json::Null => None
        other => Some(row_attrs_of(other))
      }
      unfixed_of(
        read,
        at,
        fix,
        js_string(arg(a, "note")),
        js_truthy(arg(a, "s4")),
      ).stringify()
    }
    "followups_of" => followups_of(rows).stringify()
    "should_fix_counts" => should_fix_counts(rows).stringify()
    "submit_leftovers" => submit_leftovers(rows).stringify()
    "review_rounds" => review_rounds(rows).stringify()
    "closed_by_penne" => Json::boolean(closed_by_penne(rows)).stringify()
    "start_retry_waiting" =>
      Json::boolean(start_retry_waiting(rows, js_num(arg(a, "now")))).stringify()
    "start_failures" =>
      Json::number(start_failures(rows).to_double()).stringify()
    "is_loop_lane" => Json::boolean(is_loop_lane(rows)).stringify()
    "accepted_at" => {
      let (read, at, _) = index_reading(
        ids,
        rows,
        kept,
        Some(arg_index(a, "i")),
      )
      Json::array(accepted_at(read, at)).stringify()
    }
    "corrections_of" =>
      Json::array(
        corrections_of(row_attrs_of(arg(a, "attrs"))).map(correction_json),
      ).stringify()
    "stage_pick" =>
      match pick_stage_of(js_string(arg(a, "stage"))) {
        Some(stage) =>
          pick_answer_json(
            pick_of(stage, rows, field(a, "facts"), quota_fact_of(a)),
          ).stringify()
        None => raise BadPair("知らない段: " + js_string(arg(a, "stage")))
      }
    "land_order" => Json::array(land_order(rows).map(Json::string)).stringify()
    "awaiting_merge" => awaiting_merge_answer(rows).stringify()
    "lane_ends" => lane_ends_answer(rows).stringify()
    "retire_pick" => retire_pick_answer(rows, field(a, "facts")).stringify()
    "retire_kept" => retire_kept_answer(rows, field(a, "facts")).stringify()
    "pr_draft_pick" => pr_draft_pick_answer(rows, field(a, "facts")).stringify()
    "closed_lanes" => closed_lanes_answer(rows).stringify()
    "landed_lanes" => landed_lanes_answer(rows).stringify()
    "lane_ended_events" => lane_ended_events_json().stringify()
    "final_end_events" => final_end_events_json().stringify()
    "lane_turn" =>
      match lane_turn_text(rows, turn_facts_of(a)) {
        Some(text) => Json::string(text).stringify()
        None => Json::null().stringify()
      }
    "turn_since" =>
      match turn_since_text(rows, turn_facts_of(a)) {
        Some(text) => Json::string(text).stringify()
        None => Json::null().stringify()
      }
    "awaiting_question" =>
      match awaiting_question(rows, quota_fact_of(a)) {
        Some((index, role)) =>
          json_object([
            ("role", Json::string(role)),
            ("index", Json::number(ledger_index(kept, index).to_double())),
          ]).stringify()
        None => Json::null().stringify()
      }
    "awaited_agent" =>
      match awaited_agent(rows, quota_fact_of(a)) {
        Some((since, role)) =>
          json_object([
            ("role", Json::string(role)),
            ("since", Json::number(ledger_index(kept, since).to_double())),
          ]).stringify()
        None => Json::null().stringify()
      }
    "oldest_unanswered" => {
      let (read, at, back) = index_reading(ids, rows, kept, Some(arg_since(a)))
      Json::number(ledger_index(back, oldest_unanswered(read, at)).to_double()).stringify()
    }
    "awaiting_answer" => {
      let (read, at, _) = index_reading(ids, rows, kept, Some(arg_since(a)))
      Json::boolean(oldest_unanswered(read, at) >= 0).stringify()
    }
    "unanswered_questions" => {
      let (read, at, back) = index_reading(ids, rows, kept, Some(arg_since(a)))
      Json::array(
        unanswered_questions(read, at).map(fn(pair) {
          json_object([
            ("index", Json::number(ledger_index(back, pair.0).to_double())),
            ("at", Json::string(pair.1)),
          ])
        }),
      ).stringify()
    }
    "decision_since" =>
      match decision_since_text(rows, quota_fact_of(a)) {
        Some(text) => Json::string(text).stringify()
        None => Json::null().stringify()
      }
    "transition_refusal" =>
      match
        refusal_of(
          strict_event_of(js_string(arg(a, "event"))),
          stage_with_quota(rows, quota_fact_of(a)),
          rows,
        ) {
        Some(text) => Json::string(text).stringify()
        None => Json::null().stringify()
      }
    "strict_events" => strict_events_json()
    "strict_event" =>
      Json::boolean(strict_event_is(js_string(arg(a, "event")))).stringify()
    "land_approval" => land_approval(rows).stringify()
    "land_hold" => Json::string(land_hold(rows)).stringify()
    "reviewed_head" => reviewed_head(rows).stringify()
    "final_review" => {
      let needs : Array[FactNeed] = []
      final_review_answer(rows, a, needs).stringify()
    }
    "round_extras" => {
      let needs : Array[FactNeed] = []
      round_extras_answer(rows, a, needs).stringify()
    }
    "order_gate" => {
      let needs : Array[FactNeed] = []
      order_gate_answer(rows, a, needs).stringify()
    }
    "records_check" => {
      let needs : Array[FactNeed] = []
      records_check_answer(rows, a, needs).stringify()
    }
    "records_recheck" => {
      let needs : Array[FactNeed] = []
      records_recheck_answer(rows, a, needs).stringify()
    }
    "round_trace" =>
      // the whole lane, the implementation era a replan left out of the other readings included
      round_trace(derived_rows_whole(ids)).stringify()
    "stuck_outcomes" => {
      let needs : Array[FactNeed] = []
      stuck_outcomes_answer(rows, a, needs).stringify()
    }
    _ => raise BadPair("知らない操作: " + op)
  }
}
