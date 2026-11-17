// Why a landing check failed: the environment the check ran in, or the change itself.
//
// The tick runs the first kind again by itself and sends the second back to the executor; a person is asked only to
// sign. Both the tick and the screen read this answer, so it is decided once, here, from the record and the run the
// check wrote (C-202-1). The words a check's detail carries are the harness's own: a line the harness wrote when it
// cut the run by time or output, and the lock of a check running beside it.

///|
/// The detail a blocking check is skipped with after the copy's setup failed: a consequence, not a failure of its own.
let skipped_after_setup : String = "準備に失敗したので回していません"

///|
/// Whether every character of the text is a digit or a dot (`[\d.]+` in the harness's own words).
fn every_digit_or_dot(text : String) -> Bool {
  let mut ok = true
  for c in text {
    if !((c >= '0' && c <= '9') || c == '.') {
      ok = false
    }
  }
  ok
}

///|
/// How the harness's own words stop a check: by its time limit.
fn cut_by_time(detail : String) -> Bool {
  let head = "時間の上限（"
  let tail = " 分）で打ち切りました"
  for line in detail.split("\n") {
    let text = line.to_owned()
    if text.has_prefix(head) && text.length() > head.length() + tail.length() {
      let size = text.length()
      let middle = text[head.length():size - tail.length()].to_owned()
      if text[size - tail.length():].to_owned() == tail &&
        middle.length() > 0 &&
        every_digit_or_dot(middle) {
        return true
      }
    }
  }
  false
}

///|
/// The kind a structure row says it is (`increase`, `unmeasured`, `weakened`); empty for any other row. The run that
/// counted wrote it, so a reader never takes the kind from the words of the detail (C-253-1).
fn structure_kind_of(check : Json) -> String {
  text_of(field(field(check, "structure"), "kind"))
}

///|
/// Whether a structure row that could not be counted lacked the mainline tip's side.
fn lacks_mainline_side(check : Json) -> Bool {
  for side in array_of(field(field(check, "structure"), "sides")) {
    if text_of(side) == "mainline" {
      return true
    }
  }
  false
}

///|
/// Whether the row is a count that grew or a declaration that holds less: what the merge commit's own tree decides, so
/// the same tree counts the same again.
fn is_structural(check : Json) -> Bool {
  let kind = structure_kind_of(check)
  kind == "increase" || kind == "weakened"
}

///|
/// Why a check's detail says the environment, not the command, stopped it; nothing when the command itself failed. A
/// structure row is read from the sides it says it lacked: the mainline tip's tree holds none of the lane's change, so
/// a count missing there is the environment's or the declaration's, and one missing only in the merge commit's tree is
/// the change's (C-253-3).
fn environment_reason_of(check : Json) -> String? {
  let detail = text_of(field(check, "detail"))
  let name = text_of(field(check, "name"))
  match structure_kind_of(check) {
    "unmeasured" =>
      return if lacks_mainline_side(check) {
        Some(name + " の本流の先端の数を測れませんでした")
      } else {
        None
      }
    "increase" | "weakened" => return None
    _ => ()
  }
  if cut_by_time(detail) {
    return Some(name + " が時間の上限で打ち切られました")
  }
  if detail.contains("出力が上限を超えたので打ち切りました") {
    return Some(name + " の出力が上限を超えました")
  }
  if detail.contains("lockRefused") ||
    detail.contains(
      "検査が走っています。終わってからやり直してください",
    ) {
    return Some(name + " が並走する検査の lock に当たりました")
  }
  None
}

///|
/// The texts of a JSON array of names, in order.
fn names_of(value : Json) -> Array[String] {
  let out : Array[String] = []
  for item in array_of(value) {
    out.push(text_of(item))
  }
  out
}

///|
/// The tests the check of this name failed on in the round before, when the record carries that round (it checked the
/// same head at the same mainline tip); empty when it carries none.
fn earlier_tests_of(saved : Json, name : String) -> Array[String] {
  for entry in array_of(field(saved, "earlierFailed")) {
    if text_of(field(entry, "name")) == name {
      return names_of(field(entry, "tests"))
    }
  }
  []
}

///|
/// Whether the two lists name one test in common.
fn shares_a_test(now : Array[String], earlier : Array[String]) -> Bool {
  for name in now {
    if earlier.contains(name) {
      return true
    }
  }
  false
}

///|
/// The first names of a list, and how many were left out.
fn some_names(names : Array[String]) -> String {
  let shown = 3
  let out : Array[String] = []
  for name in names {
    if out.length() < shown {
      out.push(name)
    }
  }
  let text = out.join("、")
  if names.length() > shown {
    text + " ほか " + (names.length() - shown).to_string() + " 件"
  } else {
    text
  }
}

///|
/// Why a failed check did not fail on the same tests as the round before it, when both rounds name the tests they
/// failed on and share none: the change breaks a test the same way every time it runs, so a failure that moved to other
/// tests is the machine's. A round that names no test (cut by time or output, the first of the group, or a record of
/// another group) says nothing of the kind, and the failure stays the change's.
fn moved_tests_reason_of(saved : Json, check : Json) -> String? {
  let now = names_of(field(check, "failedTests"))
  let name = text_of(field(check, "name"))
  let earlier = earlier_tests_of(saved, name)
  if now.length() == 0 || earlier.length() == 0 || shares_a_test(now, earlier) {
    return None
  }
  Some(
    name +
    " の落ちたテストが前の回と重なりません（今回: " +
    some_names(now) +
    " / 前の回: " +
    some_names(earlier) +
    "）",
  )
}

///|
/// Why a landing check failed, as far as the record and the run that wrote it tell. Null for a record that did not
/// fail.
pub fn land_failure(saved : Json, run : Json) -> String {
  land_failure_json(saved, run).stringify()
}

///|
/// The same answer as a value, for the landing's next step, which reads its kind and its checks.
pub fn land_failure_json(saved : Json, run : Json) -> Json {
  // a run of this group that ended without a result (its process died, its copy's lock could not be taken, it was
  // stopped from outside) left no check to read: the group is checked again (C-144-7)
  let saved_head = text_of(field(saved, "head"))
  let saved_tip = text_of(field(saved, "mainTip"))
  let run_of_group = match field(run, "status") {
    Json::String(_) =>
      if !given_value(saved) ||
        (
          text_of(field(run, "head")) == saved_head &&
          text_of(field(run, "mainTip")) == saved_tip
        ) {
        true
      } else {
        false
      }
    _ => false
  }
  let status = text_of(field(run, "status"))
  // a record of a landing that could not be rebuilt is newer than a run of the same group that began before it: that
  // run ended without a result for an earlier try, and does not stand for this one. Only a run that began after the
  // record was taken (so the record was not written again since) is read over it; a run that says no start does not win
  let run_after_record = if is_unbuilt_land(saved) {
    let started = host_date_ms(text_of(field(run, "started_at")))
    let taken = host_date_ms(
      text_of(field(field(saved, "rebuildFailure"), "at")),
    )
    !started.is_nan() && !taken.is_nan() && started > taken
  } else {
    true
  }
  if run_of_group &&
    run_after_record &&
    (status == "failed" || status == "stopped") {
    let reason = match opt_text(field(run, "error")) {
      Some(text) => text
      None => "検査の run が結果を残さずに終わりました"
    }
    return json_object([
      ("kind", Json::string("environment")),
      ("reason", Json::string(reason)),
      ("noResult", Json::boolean(true)),
    ])
  }
  if is_unbuilt_land(saved) {
    return unbuilt_cause(field(saved, "rebuildFailure"))
  }
  if !given_value(saved) || js_num(field(saved, "blocking")) == 0.0 {
    return Json::null()
  }
  let failing : Array[Json] = []
  for check in array_of(field(saved, "checks")) {
    let severity = text_of(field(check, "severity"))
    let state = text_of(field(check, "status"))
    if severity == "blocking" && state != "pass" && state != "not-applicable" {
      failing.push(check)
    }
  }
  if failing.length() == 0 {
    return Json::null()
  }
  let reasons : Array[String] = []
  let mut every_environment = true
  let mut any_reason = false
  for check in failing {
    let state = text_of(field(check, "status"))
    let reason = if state == "fail" {
      match environment_reason_of(check) {
        Some(text) => Some(text)
        // a structure row is read from its kind and sides alone: the tests its detail names are not its failure
        None =>
          if structure_kind_of(check) == "" {
            moved_tests_reason_of(saved, check)
          } else {
            None
          }
      }
    } else if state == "skipped" &&
      text_of(field(check, "detail")) == skipped_after_setup {
      Some("")
    } else {
      None
    }
    match reason {
      Some(text) => {
        if text != "" {
          any_reason = true
        }
        reasons.push(text)
      }
      None => every_environment = false
    }
  }
  // every failure has to be the environment's for the record to be: one check the change itself failed is the
  // executor's to fix, whatever stopped the others
  if every_environment && any_reason {
    let kept : Array[Json] = []
    for text in reasons {
      if text != "" {
        kept.push(Json::string(text))
      }
    }
    return json_object([
      ("kind", Json::string("environment")),
      ("reason", Json::string(join_texts(kept, "、"))),
    ])
  }
  let fields = [
    ("kind", Json::string("real")),
    ("checks", Json::array(failing)),
  ]
  // a count that grew, or a declaration that holds less, is the tree's: it is sent back without the check again
  for check in failing {
    if is_structural(check) {
      fields.push(("structural", Json::boolean(true)))
      break
    }
  }
  json_object(fields)
}

///|
/// Whether the record is a landing whose generated files could not be made again: it carries the failure and has neither
/// a merge commit nor a conflict, so no check ran and nothing can be approved. A record from before this
/// reading that carries both a merge commit and the failure was checked as it was, and is read as the checks say.
fn is_unbuilt_land(saved : Json) -> Bool {
  given_value(field(saved, "rebuildFailure")) &&
  !given_value(field(saved, "mergeCommit")) &&
  array_of(field(saved, "conflict")).length() == 0
}

///|
/// The failure of a landing that could not be rebuilt: the environment's when the command could not be run here, which
/// the same group tries again by the checks' own number and wait; the change's otherwise (the build refused the merged
/// sources, or wrote none of the declared files), which the same group would build the same way, so it is sent back
/// without a second try. The failure itself rides along for the send-back and the wait.
fn unbuilt_cause(failure : Json) -> Json {
  if text_of(field(failure, "cause")) == "environment" {
    let paths = join_texts(array_of(field(failure, "paths")), ", ")
    return json_object([
      ("kind", Json::string("environment")),
      (
        "reason",
        Json::string(
          "生成物（" +
          paths +
          "）をこの環境では作り直せませんでした",
        ),
      ),
      ("rebuild", failure),
    ])
  }
  json_object([
    ("kind", Json::string("real")),
    ("checks", Json::array([])),
    ("rebuild", failure),
  ])
}

///|
/// Whether the value is there at all (an empty record and a missing one are different questions here).
fn given_value(value : Json) -> Bool {
  match value {
    Json::Null => false
    Json::Object(fields) => fields.length() > 0
    _ => true
  }
}

///|
/// The texts joined, with the separator between them.
fn join_texts(items : Array[Json], separator : String) -> String {
  let mut out = ""
  let mut first = true
  for item in items {
    if !first {
      out = out + separator
    }
    out = out + text_of(item)
    first = false
  }
  out
}
