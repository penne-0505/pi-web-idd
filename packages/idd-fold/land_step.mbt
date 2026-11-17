// The landing's next step: what the tick does with one lane at the landing, and the record it writes.
//
// The tick's landing stage decides here, from the lane's rows and the observations the caller gathered (C-202-1).
// The answer is a closed set of steps, and the caller runs them in the order they come: it writes the record, calls
// the helper, reads the ledger again where the answer says so, and puts the lane in the stage's result. What it does
// not do is decide (C-202-2).
//
// Two readings are answered. `carry` is an approval still in force that the pass carries out: the merge goes in, the
// lane closes, or the lane is held or sent back. `scan` is a lane at the landing's card: the check that failed is
// settled (the environment is checked again, the change is sent back to the executor, or a person is asked to
// decide), or a fresh check is started. The pass's order — which lanes, in which order, and where the approval
// sweep runs — is the caller's, as the push stage's lane loop is.
//
// The observations are the readings of the outside world: the approval in force, the lane's head and the mainline's
// tip, git's answer about what the work_base branch carries, the saved record, the run the check wrote, and what the
// guards said. Each is a value; the readings stay in the TypeScript, and this side reads their answers (C-202-3). A
// reading the caller has not taken yet is named as a need, and the caller reads only those.

///|
/// What one step of the landing stage does.
pub(all) enum LandDo {
  /// write the record the step names, with its attrs
  LandWrite
  /// call the helper the step names; its answer comes back under the step's `fact`
  LandCall
  /// put the lane into one of the stage's result's lists
  LandResult
  /// nothing more for this lane on this pass
  LandEnd
}

///|
/// Which reading of a lane the caller asks for.
pub(all) enum LandMode {
  /// an approval still in force that the pass carries out
  LandCarry
  /// a lane at the landing's card: settle the failed check, or check it afresh
  LandScan
}

///|
/// The step's own name, as the caller runs it.
fn land_do_text(kind : LandDo) -> String {
  match kind {
    LandWrite => "write"
    LandCall => "call"
    LandResult => "result"
    LandEnd => "end"
  }
}

///|
/// The reading a caller's name asks for. A name outside the two is the card's reading, which is the wider one.
fn land_mode_of(name : String) -> LandMode {
  match name {
    "carry" => LandCarry
    _ => LandScan
  }
}

///|
/// A step that writes a record.
fn land_write(event : String, attrs : Json) -> Json {
  json_object([
    ("do", Json::string(land_do_text(LandWrite))),
    ("event", Json::string(event)),
    ("attrs", attrs),
  ])
}

///|
/// A step that calls a helper. The landing's answers do not read the ledger anew in the middle of a lane: the pass
/// re-reads it between its own steps, and the sweep is a call of its own.
fn land_call(helper : String, site : String, keep : Json, args : Json) -> Json {
  json_object([
    ("do", Json::string(land_do_text(LandCall))),
    ("helper", Json::string(helper)),
    ("site", Json::string(site)),
    ("fact", Json::string("call|" + helper + "|" + site)),
    ("keep", keep),
    ("args", args),
    ("fatal", Json::boolean(true)),
    ("reread", Json::boolean(false)),
  ])
}

///|
/// A result step's shared fields.
fn land_result_fields(
  field_name : String,
  idd : String,
) -> Array[(String, Json)] {
  [
    ("do", Json::string(land_do_text(LandResult))),
    ("field", Json::string(field_name)),
    ("id", Json::string(idd)),
  ]
}

///|
/// A lane the pass merged (or carried out).
fn land_merged_result(idd : String, committed : String?) -> Json {
  let fields = land_result_fields("merged", idd)
  fields.push(
    (
      "committed",
      match committed {
        Some(text) => Json::string(text)
        None => Json::null()
      },
    ),
  )
  json_object(fields)
}

///|
/// A lane the pass holds, with the reason the record carries.
fn land_held_result(idd : String, reason : String) -> Json {
  let fields = land_result_fields("held", idd)
  fields.push(("reason", Json::string(reason)))
  json_object(fields)
}

///|
/// A lane whose lane landed on an error.
fn land_error_result(idd : String, error : String) -> Json {
  let fields = land_result_fields("errors", idd)
  fields.push(("error", Json::string(error)))
  json_object(fields)
}

///|
/// A lane a check is reading now. The text is what the card says while it runs, or nothing when the pass only knows
/// the run is going.
fn land_checking_result(idd : String, what : String?) -> Json {
  let fields = land_result_fields("checking", idd)
  fields.push(
    (
      "checking",
      match what {
        Some(text) => Json::string(text)
        None => Json::null()
      },
    ),
  )
  json_object(fields)
}

///|
/// The checked results a check took over from an earlier mainline tip.
fn land_inherited_result(idd : String, carried : Json) -> Json {
  let fields = land_result_fields("inherited", idd)
  fields.push(("inherit", carried))
  json_object(fields)
}

///|
/// A lane checked and left for penne's approval on the card.
fn land_prepared_result(idd : String) -> Json {
  json_object(land_result_fields("prepared", idd))
}

///|
/// A lane sent back because its head and the mainline conflict, or because its check failed.
fn land_sent_back_result(idd : String) -> Json {
  json_object(land_result_fields("sentBack", idd))
}

///|
/// The step that ends this lane's pass.
fn land_end() -> Json {
  json_object([("do", Json::string(land_do_text(LandEnd)))])
}

///|
/// The answer, as the caller reads it: the steps, or the facts it still wants.
fn land_answer(steps : Array[Json], needs : Array[FactNeed]) -> Json {
  if needs.length() > 0 {
    pending(needs)
  } else {
    json_object([("steps", Json::array(steps))])
  }
}

///|
/// How many times the same lane head and mainline tip are checked again when the change itself failed: once, because
/// a second run of the same tree adds only "it failed again" to the first (C-232-1).
let land_real_recheck_max : Int = 1

///|
/// The ticks of the group's re-checks of one kind: a line that took results over from an earlier tip, or that started
/// the group's first check after the mainline moved, is not one of them, and a line without the kind's mark is the
/// environment's, as every line written before the mark was.
fn land_rechecks(
  events : Array[DerivedRow],
  head : String,
  main_tip : String,
  real : Bool,
) -> Array[DerivedRow] {
  let out : Array[DerivedRow] = []
  for row in events {
    if row.event == EvS4LandRecheck &&
      text_of(row.attrs.head) == head &&
      text_of(row.attrs.main_tip) == main_tip &&
      !row.attrs.inherit_present &&
      !row.attrs.moved_present &&
      (text_of(row.attrs.cause) == "real") == real {
      out.push(row)
    }
  }
  out
}

///|
/// A landing the tick held, recorded once for a lane head and reason.
fn land_held_steps(
  events : Array[DerivedRow],
  idd : String,
  head : String,
  reason : String,
) -> Array[Json] {
  let mut last : DerivedRow? = None
  for row in events {
    if row.event == EvS4LandHeld {
      last = Some(row)
    }
  }
  let same = match last {
    Some(row) =>
      text_of(row.attrs.head) == head && text_of(row.attrs.reason) == reason
    None => false
  }
  if same {
    [land_held_result(idd, reason)]
  } else {
    [
      land_write(
        "s4_land_held",
        json_object([
          ("head", Json::string(head)),
          ("reason", Json::string(reason)),
        ]),
      ),
      land_held_result(idd, reason),
    ]
  }
}

///|
/// The steps of a lane whose head and the mainline conflict: the approval is dropped, the check forgotten, and the
/// lane is sent back once.
fn land_conflict_steps(
  idd : String,
  head : String,
  branch : String,
  main_tip : String,
  files : Json,
) -> Array[Json] {
  [
    land_write(
      "s4_land_approval_dropped",
      json_object([
        ("reason", Json::string("本流と衝突しました")),
        ("head", Json::string(head)),
      ]),
    ),
    land_call(
      "invalidate_land",
      "approved",
      json_object([("id", Json::string(idd))]),
      json_object([("id", Json::string(idd))]),
    ),
    land_call(
      "send_back_land_conflict",
      "approved",
      json_object([("id", Json::string(idd))]),
      json_object([
        ("id", Json::string(idd)),
        ("branch", Json::string(branch)),
        ("files", files),
        ("head", Json::string(head)),
        ("mainTip", Json::string(main_tip)),
      ]),
    ),
    land_error_result(
      idd, "本流と衝突するので merge しません。差し戻しました",
    ),
    land_end(),
  ]
}

///|
/// How a landing whose generated files could not be made again came to be read: from the record the ledger holds, from
/// the first try of its group that the pass has just made, or from a check again whose line is written with the steps.
priv enum UnbuiltTry {
  Recorded
  Fresh
  Retried(Json)
}

///|
/// What a landing whose generated files could not be made again leads to. It is the one decision of the failure's
/// kind and of the next step for each kind, so the fresh check, the settle, and the approved re-check only apply it:
/// the change's failure is sent back once; the environment's is waited out, tried again by the checks' own number and
/// wait, and handed to a person once the tries are used up.
priv enum UnbuiltNext {
  SendBack
  Hold(String)
  Wait
  Retry(Int)
}

///|
/// The decision itself, from the failure's own cause and the tries the group has had. None when the time it waits on is
/// still to be observed.
fn land_unbuilt_next(
  events : Array[DerivedRow],
  facts : Json,
  needs : Array[FactNeed],
  idd : String,
  head : String,
  main_tip : String,
  failure : Json,
  attempt : UnbuiltTry,
  max_rechecks : Int,
  recheck_interval_ms : Double,
) -> UnbuiltNext? {
  let cause = unbuilt_cause(failure)
  // the same group builds the same way: the change's failure is not tried a second time
  if text_of(field(cause, "kind")) != "environment" {
    return Some(SendBack)
  }
  let past = land_rechecks(events, head, main_tip, false)
  // a check again the pass has just made is written with these steps: it counts here, unless its line starts the count of
  // a group the mainline moved to
  let counted = match attempt {
    Retried(row) => if given(field(row, "moved")) { 0 } else { 1 }
    Recorded | Fresh => 0
  }
  let tries = past.length() + counted
  if tries >= max_rechecks {
    return Some(
      Hold(
        "環境由来の失敗で " +
        max_rechecks.to_string() +
        " 回検査し直しても通らないので、人の判断を待ちます（" +
        text_of(field(cause, "reason")) +
        "）",
      ),
    )
  }
  match attempt {
    Fresh | Retried(_) => Some(Wait)
    Recorded => {
      // the failure to rebuild is the record's own, taken when the landing was planned
      let taken = host_date_ms(text_of(field(failure, "at")))
      let asked = if past.length() > 0 {
        host_date_ms(row_at_text(past[past.length() - 1]))
      } else {
        host_date_ms("")
      }
      let mut last_failure = 0.0
      if !taken.is_nan() && taken > last_failure {
        last_failure = taken
      }
      if !asked.is_nan() && asked > last_failure {
        last_failure = asked
      }
      let now = match submit_fact(facts, needs, "now", idd, "") {
        Some(value) => js_num(value)
        None => return None
      }
      if last_failure > 0.0 && now - last_failure < recheck_interval_ms {
        Some(Wait)
      } else {
        Some(Retry(tries + 1))
      }
    }
  }
}

///|
/// The call that sends a lane back for a landing whose generated files the change cannot make again, with the paths and
/// the build's output.
fn land_unbuilt_send_back(
  site : String,
  idd : String,
  branch : String,
  head : String,
  main_tip : String,
  failure : Json,
) -> Json {
  land_call(
    "send_back_land_check_failure",
    site,
    json_object([
      ("id", Json::string(idd)),
      ("head", Json::string(head)),
      (
        "names",
        Json::string(
          "生成物の作り直し（" +
          join_texts(array_of(field(failure, "paths")), ", ") +
          "）",
        ),
      ),
    ]),
    json_object([
      ("id", Json::string(idd)),
      ("branch", Json::string(branch)),
      ("head", Json::string(head)),
      ("mainTip", Json::string(main_tip)),
      ("checks", Json::array([])),
      ("rebuild", failure),
    ]),
  )
}

///|
/// The steps a landing that could not be rebuilt leads to, from the one decision (`land_unbuilt_next`). `site` is the
/// path asking: an approval's re-check (`approved`) drops the approval first, so an unbuilt record is never carried
/// out, and the lane is then settled like any other. `reason` is the words the record or the try carries for the card.
fn land_unbuilt_steps(
  events : Array[DerivedRow],
  facts : Json,
  needs : Array[FactNeed],
  site : String,
  idd : String,
  branch : String,
  head : String,
  main_tip : String,
  reason : String,
  failure : Json,
  attempt : UnbuiltTry,
  max_rechecks : Int,
  recheck_interval_ms : Double,
) -> Array[Json]? {
  let next = match
    land_unbuilt_next(
      events, facts, needs, idd, head, main_tip, failure, attempt, max_rechecks,
      recheck_interval_ms,
    ) {
    Some(value) => value
    None => return None
  }
  let approved = site == "approved"
  let steps : Array[Json] = []
  if approved {
    steps.push(
      land_write(
        "s4_land_approval_dropped",
        json_object([
          ("reason", Json::string("生成物を作り直せませんでした")),
          ("head", Json::string(head)),
        ]),
      ),
    )
  }
  // what the pass did is reported; a record only waited on is not
  let acted = approved ||
    (match attempt {
      Recorded => false
      Fresh | Retried(_) => true
    })
  match next {
    SendBack =>
      steps.push(
        land_unbuilt_send_back(site, idd, branch, head, main_tip, failure),
      )
    Hold(why) => {
      steps.append(land_unbuilt_tried(attempt))
      steps.append(land_held_steps(events, idd, head, why))
      steps.push(land_end())
    }
    Wait => {
      steps.append(land_unbuilt_tried(attempt))
      if acted {
        steps.push(land_held_result(idd, reason))
      }
      steps.push(land_end())
    }
    Retry(number) =>
      if approved {
        // the approval is dropped, so the next tick settles the lane and tries again
        steps.push(land_held_result(idd, reason))
        steps.push(land_end())
      } else {
        steps.push(
          land_call(
            "prepare_land",
            "settle",
            json_object([
              ("id", Json::string(idd)),
              ("head", Json::string(head)),
              ("mainTip", Json::string(main_tip)),
              ("branch", Json::string(branch)),
              ("reason", field(unbuilt_cause(failure), "reason")),
              ("cause", Json::string("environment")),
              ("attempt", Json::number(number.to_double())),
            ]),
            json_object([
              ("id", Json::string(idd)),
              ("signed", Json::boolean(false)),
            ]),
          ),
        )
      }
  }
  Some(steps)
}

///|
/// The line a check again leaves in the ledger, written with the steps its answer leads to.
fn land_unbuilt_tried(attempt : UnbuiltTry) -> Array[Json] {
  match attempt {
    Retried(row) => [land_write("s4_land_recheck", row)]
    Recorded | Fresh => []
  }
}

///|
/// The steps an advance's answer leads to: the merge went in, waits, or failed.
fn land_advance_steps(idd : String, done : Json) -> Array[Json] {
  let held_reason = field(done, "held")
  if given(held_reason) {
    return [land_held_result(idd, text_of(held_reason)), land_end()]
  }
  if js_truthy(field(done, "ok")) {
    let committed = text_of(field(done, "committed"))
    let at = if committed == "" { None } else { Some(committed) }
    return [land_merged_result(idd, at), land_end()]
  }
  if given(field(done, "error")) {
    return [land_error_result(idd, text_of(field(done, "error"))), land_end()]
  }
  [land_end()]
}

///|
/// The steps the check an approval waits on leaves: a run started, a conflict, a landing that could not be rebuilt, or a
/// reason it could not start.
fn land_approved_prepare_steps(
  events : Array[DerivedRow],
  facts : Json,
  needs : Array[FactNeed],
  idd : String,
  head : String,
  branch : String,
  main_tip : String,
  done : Json,
  max_rechecks : Int,
  recheck_interval_ms : Double,
) -> Array[Json]? {
  let error = text_of(field(done, "error"))
  if error != "" {
    return Some([land_error_result(idd, error), land_end()])
  }
  if js_truthy(field(done, "checking")) {
    let steps : Array[Json] = []
    if given(field(done, "inherit")) {
      steps.push(land_inherited_result(idd, field(done, "inherit")))
    }
    let waiting = text_of(field(done, "waiting"))
    let what = if waiting == "" {
      "検査中です。終わると次の tick が merge します"
    } else {
      waiting
    }
    steps.push(land_checking_result(idd, Some(what)))
    steps.push(land_end())
    return Some(steps)
  }
  let conflicts = array_of(field(done, "conflict"))
  if conflicts.length() > 0 {
    return Some(
      land_conflict_steps(idd, head, branch, main_tip, Json::array(conflicts)),
    )
  }
  // the generated files of the approved group could not be made again after the mainline moved
  if is_unbuilt_land(done) {
    let (built_head, built_tip) = land_built_group(head, main_tip, done)
    return land_unbuilt_steps(
      events,
      facts,
      needs,
      "approved",
      idd,
      branch,
      built_head,
      built_tip,
      text_of(field(done, "reason")),
      field(done, "rebuildFailure"),
      Fresh,
      max_rechecks,
      recheck_interval_ms,
    )
  }
  let reason = text_of(field(done, "reason"))
  let error = if reason == "" {
    "検査を始められませんでした"
  } else {
    reason
  }
  Some([land_error_result(idd, error), land_end()])
}

///|
/// The head and the mainline tip a try of the landing was made on: the answer's own, else the ones asked.
fn land_built_group(
  head : String,
  main_tip : String,
  done : Json,
) -> (String, String) {
  let built_head = match opt_text(field(done, "head")) {
    Some(text) if text != "" => text
    _ => head
  }
  let built_tip = match opt_text(field(done, "mainTip")) {
    Some(text) if text != "" => text
    _ => main_tip
  }
  (built_head, built_tip)
}

///|
/// The steps an approval the pass carries out leads to, from the lane's rows and the observations.
pub fn land_carry_steps(
  events : Array[DerivedRow],
  facts : Json,
  needs : Array[FactNeed],
  max_rechecks : Int,
  recheck_interval_ms : Double,
) -> Array[Json]? {
  if events.length() == 0 {
    return Some([land_end()])
  }
  let idd = events[events.length() - 1].idd_id
  let mut closed = false
  for row in events {
    if row.event == EvLaneClose {
      closed = true
    }
  }
  if closed {
    return Some([land_merged_result(idd, None), land_end()])
  }
  // the send-back of a landing that could not be rebuilt answered: the approval it dropped is no longer in the ledger, so
  // the answer is read before the approval is looked for
  match call_answer(facts, "send_back_land_check_failure", "approved") {
    Some(answer) =>
      return Some(
        land_sent_steps(
          events,
          idd,
          "approved",
          field(answer, "keep"),
          field(answer, "result"),
        ),
      )
    None => ()
  }
  let approval = match submit_fact(facts, needs, "approval", idd, "") {
    Some(value) => value
    None => return None
  }
  if !given(approval) {
    return Some([land_end()])
  }
  let location = match submit_fact(facts, needs, "location", idd, "") {
    Some(value) => value
    None => return None
  }
  if !js_truthy(location) {
    return Some([
      land_error_result(idd, "lane が見つかりません"),
      land_end(),
    ])
  }
  let head = text_of(field(approval, "head"))
  let cur = match submit_fact(facts, needs, "cur", idd, "") {
    Some(value) => text_of(value)
    None => return None
  }
  if head != cur {
    return Some([
      land_write(
        "s4_land_approval_dropped",
        json_object([
          ("reason", Json::string("lane の head が変わりました")),
          ("head", Json::string(head)),
        ]),
      ),
      land_error_result(
        idd, "承認の後に lane の commit が進んだので、承認を外しました",
      ),
      land_end(),
    ])
  }
  let main_tip = match submit_fact(facts, needs, "mainTip", idd, "") {
    Some(value) => text_of(value)
    None => return None
  }
  let branch = match submit_fact(facts, needs, "branch", idd, "") {
    Some(value) => text_of(value)
    None => return None
  }
  // a helper already answered: its answer is read where that call's step leads, and the branches before it are not
  // read again (C-202-2)
  match call_answer(facts, "close_landed", "carried") {
    Some(answer) => {
      let done = field(answer, "result")
      if !js_truthy(field(done, "ok")) {
        let reason = text_of(field(done, "reason"))
        let error = if reason == "" {
          "lane を閉じられませんでした"
        } else {
          reason
        }
        return Some([land_error_result(idd, error), land_end()])
      }
      let commit = text_of(field(field(answer, "keep"), "commit"))
      return Some([land_merged_result(idd, Some(commit)), land_end()])
    }
    None => ()
  }
  match call_answer(facts, "advance_land", "carry") {
    Some(answer) =>
      return Some(land_advance_steps(idd, field(answer, "result")))
    None => ()
  }
  match call_answer(facts, "prepare_land", "approved") {
    Some(answer) =>
      return land_approved_prepare_steps(
        events,
        facts,
        needs,
        idd,
        head,
        branch,
        main_tip,
        field(answer, "result"),
        max_rechecks,
        recheck_interval_ms,
      )
    None => ()
  }
  let ancestor = match submit_fact(facts, needs, "ancestor", idd, "") {
    Some(value) => js_truthy(value)
    None => return None
  }
  let blocker = match submit_fact(facts, needs, "checkouts", idd, "") {
    Some(value) => value
    None => return None
  }
  let hold_steps = fn(reason : String) {
    [
      land_call(
        "note_land_hold",
        "carried",
        json_object([
          ("id", Json::string(idd)),
          ("head", Json::string(head)),
          ("reason", Json::string(reason)),
        ]),
        json_object([
          ("id", Json::string(idd)),
          ("head", Json::string(head)),
          ("reason", Json::string(reason)),
        ]),
      ),
      land_held_result(idd, reason),
      land_end(),
    ]
  }
  if ancestor {
    if given(blocker) {
      return Some(hold_steps(text_of(blocker)))
    }
    let saved = match submit_fact(facts, needs, "saved", idd, "") {
      Some(value) => value
      None => return None
    }
    let saved_commit = text_of(field(saved, "mergeCommit"))
    let carried = match
      submit_fact(facts, needs, "mergeCommitCarried", idd, "") {
      Some(value) => js_truthy(value)
      None => return None
    }
    let commit = if saved_commit != "" && carried { saved_commit } else { head }
    return Some([
      land_call(
        "close_landed",
        "carried",
        json_object([
          ("id", Json::string(idd)),
          ("commit", Json::string(commit)),
        ]),
        json_object([
          ("id", Json::string(idd)),
          ("commit", Json::string(commit)),
        ]),
      ),
    ])
  }
  if given(blocker) {
    return Some(hold_steps(text_of(blocker)))
  }
  let ready = match submit_fact(facts, needs, "ready", idd, "") {
    Some(value) => value
    None => return None
  }
  if given(ready) && text_of(field(ready, "head")) == head {
    let blocked = match submit_fact(facts, needs, "blocked", idd, "") {
      Some(value) => value
      None => return None
    }
    if given(blocked) {
      return Some([land_error_result(idd, text_of(blocked)), land_end()])
    }
    return Some([
      land_call(
        "advance_land",
        "carry",
        json_object([("id", Json::string(idd)), ("head", Json::string(head))]),
        json_object([
          ("id", Json::string(idd)),
          ("head", Json::string(head)),
          ("mergeCommit", Json::string(text_of(field(ready, "mergeCommit")))),
          ("mainTip", Json::string(text_of(field(ready, "mainTip")))),
        ]),
      ),
    ])
  }
  let saved = match submit_fact(facts, needs, "saved", idd, "") {
    Some(value) => value
    None => return None
  }
  let saved_here = given(saved) &&
    text_of(field(saved, "status")) == "prepared" &&
    text_of(field(saved, "head")) == head &&
    text_of(field(saved, "mainTip")) == main_tip
  let conflicts = array_of(field(saved, "conflict"))
  if saved_here && conflicts.length() > 0 {
    return Some(
      land_conflict_steps(idd, head, branch, main_tip, Json::array(conflicts)),
    )
  }
  // a record of the approved group that was never built: the approval does not stand for it, and the failure is read as
  // every other path reads it
  if saved_here && is_unbuilt_land(saved) {
    return land_unbuilt_steps(
      events,
      facts,
      needs,
      "approved",
      idd,
      branch,
      head,
      main_tip,
      text_of(field(saved, "reason")),
      field(saved, "rebuildFailure"),
      Recorded,
      max_rechecks,
      recheck_interval_ms,
    )
  }
  let blocking = js_num(field(saved, "blocking"))
  if saved_here && blocking > 0.0 {
    return Some([
      land_write(
        "s4_land_approval_dropped",
        json_object([
          ("reason", Json::string("必須の検査が落ちました")),
          ("head", Json::string(head)),
        ]),
      ),
      land_write(
        "s4_land_check_failed",
        json_object([
          ("head", Json::string(head)),
          ("blocking", Json::number(blocking)),
        ]),
      ),
      land_error_result(
        idd,
        "必須の検査が落ちたので merge しません（" +
        blocking.to_int().to_string() +
        " 件）",
      ),
      land_end(),
    ])
  }
  Some([
    land_call(
      "prepare_land",
      "approved",
      json_object([("id", Json::string(idd))]),
      json_object([("id", Json::string(idd)), ("signed", Json::boolean(true))]),
    ),
  ])
}

///|
/// The pass's approval sweep, then the lane's own steps: a lane the sweep carried out is left.
fn land_after_carry(
  events : Array[DerivedRow],
  facts : Json,
  needs : Array[FactNeed],
  idd : String,
  site : String,
  max_rechecks : Int,
  recheck_interval_ms : Double,
) -> Array[Json]? {
  match call_answer(facts, "carry_sweep", site) {
    None =>
      Some([
        land_call(
          "carry_sweep",
          site,
          json_object([("id", Json::string(idd))]),
          json_object([("id", Json::string(idd))]),
        ),
      ])
    Some(_) => {
      let attempted = match submit_fact(facts, needs, "attempted", idd, "") {
        Some(value) => js_truthy(value)
        None => return None
      }
      if attempted {
        return Some([land_end()])
      }
      if site == "settle" {
        land_settle_steps(
          events, facts, needs, idd, max_rechecks, recheck_interval_ms,
        )
      } else {
        land_fresh_steps(
          events, facts, needs, idd, max_rechecks, recheck_interval_ms,
        )
      }
    }
  }
}

///|
/// Whether a record of the lane's head, checked at an earlier mainline tip, failed on what the head's tree decides.
fn land_failed_on_tree(behind : Json) -> Bool {
  if !given(behind) {
    return false
  }
  let cause = land_failure_json(behind, Json::null())
  text_of(field(cause, "kind")) == "real" &&
  js_truthy(field(cause, "structural"))
}

///|
/// What the tick does with a lane whose check failed, or whose run ended without a result.
pub fn land_settle_steps(
  events : Array[DerivedRow],
  facts : Json,
  needs : Array[FactNeed],
  idd : String,
  max_rechecks : Int,
  recheck_interval_ms : Double,
) -> Array[Json]? {
  // a helper already answered: its answer is read where that call's step leads, and the branches before it are not
  // read again (C-202-2)
  // the send-back is read before the check's answer: a check again that met the change's failure to rebuild leads to
  // it, so both answers stand together and the later one is the send-back
  match call_answer(facts, "send_back_land_check_failure", "settle") {
    Some(answer) =>
      return Some(
        land_sent_steps(
          events,
          idd,
          "settle",
          field(answer, "keep"),
          field(answer, "result"),
        ),
      )
    None => ()
  }
  match call_answer(facts, "prepare_land", "settle") {
    Some(answer) =>
      return land_settle_prepare_steps(
        events,
        facts,
        needs,
        idd,
        field(answer, "keep"),
        field(answer, "result"),
        max_rechecks,
        recheck_interval_ms,
      )
    None => ()
  }
  let checked = match submit_fact(facts, needs, "checked", idd, "") {
    Some(value) => value
    None => return None
  }
  // a record of this head that failed on its own tree at an earlier mainline tip is the failure whatever the new tip's
  // run is doing: it is read before the run's ending or its being under way (C-253-2)
  let behind = if given(checked) {
    Json::null()
  } else {
    match submit_fact(facts, needs, "behind", idd, "") {
      Some(value) => value
      None => return None
    }
  }
  let from_behind = land_failed_on_tree(behind)
  let checked = if from_behind { behind } else { checked }
  let run = match submit_fact(facts, needs, "run", idd, "") {
    Some(value) => value
    None => return None
  }
  let head_fact = match submit_fact(facts, needs, "head", idd, "") {
    Some(value) => text_of(value)
    None => return None
  }
  let head = match opt_text(field(checked, "head")) {
    Some(text) => text
    None =>
      match opt_text(field(run, "head")) {
        Some(text) => text
        None => head_fact
      }
  }
  let main_tip = match opt_text(field(checked, "mainTip")) {
    Some(text) => text
    None =>
      match opt_text(field(run, "mainTip")) {
        Some(text) => text
        None => ""
      }
  }
  let branch = match submit_fact(facts, needs, "branch", idd, "") {
    Some(value) => text_of(value)
    None => return None
  }
  let run_checking = match submit_fact(facts, needs, "runChecking", idd, "") {
    Some(value) => js_truthy(value)
    None => return None
  }
  if run_checking && !from_behind {
    return Some([land_checking_result(idd, None), land_end()])
  }
  let cause = land_failure_json(checked, run)
  if !given(cause) {
    return Some([land_end()])
  }
  let real = text_of(field(cause, "kind")) == "real"
  let checks = array_of(field(cause, "checks"))
  let names : Array[Json] = []
  for check in checks {
    names.push(Json::string(text_of(field(check, "name"))))
  }
  // a landing whose generated files could not be made again ran no check: the one decision of such a landing reads it
  let rebuild = field(cause, "rebuild")
  if given(rebuild) {
    return land_unbuilt_steps(
      events,
      facts,
      needs,
      "settle",
      idd,
      branch,
      head,
      main_tip,
      text_of(field(checked, "reason")),
      rebuild,
      Recorded,
      max_rechecks,
      recheck_interval_ms,
    )
  }
  let past = land_rechecks(events, head, main_tip, real)
  // a count that grew is the head's tree, not the load of a run: the check again would count the same, so it is not
  // asked for before the send-back (C-253-2)
  let structural = js_truthy(field(cause, "structural"))
  if real && (structural || past.length() >= land_real_recheck_max) {
    // the same group failed again after the check again, or the tree itself failed: the change is the executor's to fix
    let send_args = [
      ("id", Json::string(idd)),
      ("branch", Json::string(branch)),
      ("head", Json::string(head)),
      ("mainTip", Json::string(main_tip)),
      ("checks", Json::array(checks)),
    ]
    return Some([
      land_call(
        "send_back_land_check_failure",
        "settle",
        json_object([
          ("id", Json::string(idd)),
          ("head", Json::string(head)),
          ("names", Json::string(join_texts(names, ", "))),
        ]),
        json_object(send_args),
      ),
    ])
  }
  if !real && past.length() >= max_rechecks {
    let reason = "環境由来の失敗で " +
      max_rechecks.to_string() +
      " 回検査し直しても通らないので、人の判断を待ちます（" +
      text_of(field(cause, "reason")) +
      "）"
    let steps = land_held_steps(events, idd, head, reason)
    steps.push(land_end())
    return Some(steps)
  }
  if !js_truthy(field(cause, "noResult")) {
    let ended_text = text_of(field(run, "ended_at"))
    let ended = if text_of(field(run, "head")) == head &&
      text_of(field(run, "mainTip")) == main_tip {
      host_date_ms(ended_text)
    } else {
      host_date_ms("")
    }
    let asked_text = if past.length() > 0 {
      row_at_text(past[past.length() - 1])
    } else {
      ""
    }
    let asked = host_date_ms(asked_text)
    let mut last_failure = 0.0
    if !ended.is_nan() && ended > last_failure {
      last_failure = ended
    }
    if !asked.is_nan() && asked > last_failure {
      last_failure = asked
    }
    let now = match submit_fact(facts, needs, "now", idd, "") {
      Some(value) => js_num(value)
      None => return None
    }
    if last_failure > 0.0 && now - last_failure < recheck_interval_ms {
      return Some([land_end()])
    }
  }
  let recheck_reason = if real {
    Json::string(
      "変更の失敗と読んだ検査 " +
      join_texts(names, ", ") +
      " を、同じ head と本流の先端で検査し直します",
    )
  } else {
    field(cause, "reason")
  }
  Some([
    land_call(
      "prepare_land",
      "settle",
      json_object([
        ("id", Json::string(idd)),
        ("head", Json::string(head)),
        ("mainTip", Json::string(main_tip)),
        ("branch", Json::string(branch)),
        ("reason", recheck_reason),
        ("cause", Json::string(if real { "real" } else { "environment" })),
        ("attempt", Json::number(past.length().to_double() + 1.0)),
      ]),
      json_object([("id", Json::string(idd)), ("signed", Json::boolean(false))]),
    ),
  ])
}

///|
/// The steps the send-back of the change's failure leaves: sent back once, or held for a person with the checks named.
/// An approval's re-check reports the send-back as the error that stopped its merge.
fn land_sent_steps(
  events : Array[DerivedRow],
  idd : String,
  site : String,
  keep : Json,
  answered : Json,
) -> Array[Json] {
  if js_truthy(answered) {
    if site == "approved" {
      return [
        land_error_result(
          idd, "生成物を作り直せないので merge しません。差し戻しました",
        ),
        land_end(),
      ]
    }
    return [land_sent_back_result(idd), land_end()]
  }
  let head = text_of(field(keep, "head"))
  let reason = "取り込みの検査が同じ head（" +
    host_text_cut(head, 7) +
    "）で 2 回落ちたので、人の判断を待ちます（" +
    text_of(field(keep, "names")) +
    "）"
  let steps = land_held_steps(events, idd, head, reason)
  steps.push(land_end())
  steps
}

///|
/// The line a check again leaves in the ledger. It names the pair the check actually started on: the mainline can move
/// between the count and the call, and a pair of its own is counted from its first line, marked as moved so it is not
/// one of the re-checks.
fn land_recheck_row(keep : Json, done : Json, cause : String) -> Json {
  let (started_head, started_tip) = land_built_group(
    text_of(field(keep, "head")),
    text_of(field(keep, "mainTip")),
    done,
  )
  let same_group = started_head == text_of(field(keep, "head")) &&
    started_tip == text_of(field(keep, "mainTip"))
  let attempt = if same_group {
    field(keep, "attempt")
  } else {
    Json::number(1.0)
  }
  let fields = [
    ("head", Json::string(started_head)),
    ("main_tip", Json::string(started_tip)),
    ("reason", field(keep, "reason")),
    ("cause", Json::string(cause)),
    ("attempt", attempt),
  ]
  if !same_group {
    fields.push(
      ("moved", json_object([("from_main_tip", field(keep, "mainTip"))])),
    )
  }
  json_object(fields)
}

///|
/// The steps the settle's check leaves: a run started (and its ask recorded), a conflict, a hold, or a failure.
fn land_settle_prepare_steps(
  events : Array[DerivedRow],
  facts : Json,
  needs : Array[FactNeed],
  idd : String,
  keep : Json,
  done : Json,
  max_rechecks : Int,
  recheck_interval_ms : Double,
) -> Array[Json]? {
  let error = text_of(field(done, "error"))
  if error != "" {
    if js_truthy(field(done, "lockRefused")) {
      return Some([land_end()])
    }
    return Some([land_error_result(idd, error), land_end()])
  }
  // a try that met the failure to rebuild is read by the one decision of such a landing, with the line it leaves
  if is_unbuilt_land(done) {
    let failure = field(done, "rebuildFailure")
    let (built_head, built_tip) = land_built_group(
      text_of(field(keep, "head")),
      text_of(field(keep, "mainTip")),
      done,
    )
    let row = land_recheck_row(
      keep,
      done,
      text_of(field(unbuilt_cause(failure), "kind")),
    )
    return land_unbuilt_steps(
      events,
      facts,
      needs,
      "settle",
      idd,
      text_of(field(keep, "branch")),
      built_head,
      built_tip,
      text_of(field(done, "reason")),
      failure,
      Retried(row),
      max_rechecks,
      recheck_interval_ms,
    )
  }
  if js_truthy(field(done, "checking")) {
    if given(field(done, "waiting")) {
      return Some([land_end()])
    }
    let recheck_cause = match opt_text(field(keep, "cause")) {
      Some(text) => text
      None => "environment"
    }
    return Some([
      land_write("s4_land_recheck", land_recheck_row(keep, done, recheck_cause)),
      land_checking_result(idd, None),
      land_end(),
    ])
  }
  let conflicts = array_of(field(done, "conflict"))
  if conflicts.length() > 0 {
    return Some([
      land_call(
        "send_back_land_conflict",
        "settle",
        json_object([("id", Json::string(idd))]),
        json_object([
          ("id", Json::string(idd)),
          ("branch", field(keep, "branch")),
          ("files", Json::array(conflicts)),
          ("head", Json::string(text_of(field(done, "head")))),
          ("mainTip", Json::string(text_of(field(done, "mainTip")))),
        ]),
      ),
      land_sent_back_result(idd),
      land_end(),
    ])
  }
  if given(field(done, "reason")) {
    return Some([
      land_held_result(idd, text_of(field(done, "reason"))),
      land_end(),
    ])
  }
  Some([land_end()])
}

///|
/// What the tick does with a lane it checks afresh.
pub fn land_fresh_steps(
  events : Array[DerivedRow],
  facts : Json,
  needs : Array[FactNeed],
  idd : String,
  max_rechecks : Int,
  recheck_interval_ms : Double,
) -> Array[Json]? {
  // the send-back of a landing that could not be rebuilt already answered: it is read where that call's step leads,
  // and the branches before it are not read again (C-202-2)
  match call_answer(facts, "send_back_land_check_failure", "scan") {
    Some(answer) =>
      return Some(
        land_sent_steps(
          events,
          idd,
          "scan",
          field(answer, "keep"),
          field(answer, "result"),
        ),
      )
    None => ()
  }
  let branch = match submit_fact(facts, needs, "branch", idd, "") {
    Some(value) => text_of(value)
    None => return None
  }
  match call_answer(facts, "prepare_land", "scan") {
    None =>
      Some([
        land_call(
          "prepare_land",
          "scan",
          json_object([("id", Json::string(idd))]),
          json_object([
            ("id", Json::string(idd)),
            ("signed", Json::boolean(false)),
          ]),
        ),
      ])
    Some(answer) => {
      let done = field(answer, "result")
      let error = text_of(field(done, "error"))
      if error != "" {
        if js_truthy(field(done, "lockRefused")) {
          return Some([land_end()])
        }
        return Some([land_error_result(idd, error), land_end()])
      }
      if js_truthy(field(done, "checking")) {
        let steps : Array[Json] = []
        if given(field(done, "inherit")) {
          steps.push(land_inherited_result(idd, field(done, "inherit")))
        }
        if !given(field(done, "waiting")) {
          steps.push(land_checking_result(idd, None))
        }
        steps.push(land_end())
        return Some(steps)
      }
      let conflicts = array_of(field(done, "conflict"))
      if conflicts.length() > 0 {
        return Some([
          land_call(
            "send_back_land_conflict",
            "scan",
            json_object([("id", Json::string(idd))]),
            json_object([
              ("id", Json::string(idd)),
              ("branch", Json::string(branch)),
              ("files", Json::array(conflicts)),
              ("head", Json::string(text_of(field(done, "head")))),
              ("mainTip", Json::string(text_of(field(done, "mainTip")))),
            ]),
          ),
          land_sent_back_result(idd),
          land_end(),
        ])
      }
      // a landing whose generated files could not be made again is read by the one decision of such a landing
      if is_unbuilt_land(done) {
        return land_unbuilt_steps(
          events,
          facts,
          needs,
          "scan",
          idd,
          branch,
          text_of(field(done, "head")),
          text_of(field(done, "mainTip")),
          text_of(field(done, "reason")),
          field(done, "rebuildFailure"),
          Fresh,
          max_rechecks,
          recheck_interval_ms,
        )
      }
      if given(field(done, "reason")) {
        return Some([
          land_held_result(idd, text_of(field(done, "reason"))),
          land_end(),
        ])
      }
      let steps : Array[Json] = []
      if given(field(done, "inherit")) {
        steps.push(land_inherited_result(idd, field(done, "inherit")))
      }
      steps.push(land_prepared_result(idd))
      steps.push(land_end())
      return Some(steps)
    }
  }
}

///|
/// The steps of a lane at the landing's card: the check failed, or the lane is checked now.
pub fn land_scan_steps(
  events : Array[DerivedRow],
  facts : Json,
  needs : Array[FactNeed],
  max_rechecks : Int,
  recheck_interval_ms : Double,
) -> Array[Json]? {
  if events.length() == 0 {
    return Some([land_end()])
  }
  let idd = events[events.length() - 1].idd_id
  // the approval sweep already ran: the lane's own steps are read from its answer, and the branches before it are
  // not read again (C-202-2)
  if call_answer(facts, "carry_sweep", "settle") is Some(_) {
    if js_truthy(fact_or_pending(facts, needs, "attempted", idd, "")) {
      return Some([land_end()])
    }
    return land_settle_steps(
      events, facts, needs, idd, max_rechecks, recheck_interval_ms,
    )
  }
  if call_answer(facts, "carry_sweep", "fresh") is Some(_) {
    if js_truthy(fact_or_pending(facts, needs, "attempted", idd, "")) {
      return Some([land_end()])
    }
    return land_fresh_steps(
      events, facts, needs, idd, max_rechecks, recheck_interval_ms,
    )
  }
  let checked = match submit_fact(facts, needs, "checked", idd, "") {
    Some(value) => value
    None => return None
  }
  if given(checked) &&
    js_num(field(checked, "blocking")) == 0.0 &&
    !is_unbuilt_land(checked) {
    return Some([land_end()])
  }
  if given(checked) {
    return land_after_carry(
      events, facts, needs, idd, "settle", max_rechecks, recheck_interval_ms,
    )
  }
  // the mainline moved after the head's record failed on its own tree: the record no longer fits the tip, but the count
  // it failed on is still the head's, so the lane is settled from it instead of waiting on, or checking afresh for, the
  // new tip (C-253-2)
  let behind = match submit_fact(facts, needs, "behind", idd, "") {
    Some(value) => value
    None => return None
  }
  if land_failed_on_tree(behind) {
    return land_after_carry(
      events, facts, needs, idd, "settle", max_rechecks, recheck_interval_ms,
    )
  }
  let run_ended = match submit_fact(facts, needs, "runEnded", idd, "") {
    Some(value) => js_truthy(value)
    None => return None
  }
  if run_ended {
    return land_after_carry(
      events, facts, needs, idd, "settle", max_rechecks, recheck_interval_ms,
    )
  }
  let stacked = match submit_fact(facts, needs, "stacked", idd, "") {
    Some(value) => value
    None => return None
  }
  if given(stacked) {
    return Some([land_held_result(idd, text_of(stacked)), land_end()])
  }
  let unreviewed = match submit_fact(facts, needs, "unreviewed", idd, "") {
    Some(value) => value
    None => return None
  }
  if given(unreviewed) {
    return Some([
      land_held_result(idd, text_of(field(unreviewed, "reason"))),
      land_end(),
    ])
  }
  land_after_carry(
    events, facts, needs, idd, "fresh", max_rechecks, recheck_interval_ms,
  )
}

///|
/// The landing's answer for one lane: the steps to run, or the facts still wanted.
pub fn land_step(
  events : Array[DerivedRow],
  facts : Json,
  mode : String,
  max_rechecks : Int,
  recheck_interval_ms : Double,
) -> String {
  let needs : Array[FactNeed] = []
  let steps = match land_mode_of(mode) {
    LandCarry =>
      land_carry_steps(events, facts, needs, max_rechecks, recheck_interval_ms)
    LandScan =>
      land_scan_steps(events, facts, needs, max_rechecks, recheck_interval_ms)
  }
  match steps {
    None => pending(needs).stringify()
    Some(items) => land_answer(items, needs).stringify()
  }
}
