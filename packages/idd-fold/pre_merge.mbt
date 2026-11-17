// The mainline merge before a lane's first review: what the tick does with the lane, and the record it writes.
//
// The decision belongs here, from the lane's rows and the observations the caller gathered (C-205-5). The caller
// keeps the reading of the outside world (git, the runner, the lane's lock) and the effects (the merge, the
// envelope, the writes); this side answers which of them to do, in which order, and what the action is. A fall of a
// git read is handed in as a fact, so a failure changes the answer here and never sends the caller back to its own
// reading.
//
// The order the caller runs the steps in is this side's answer, but the effects keep the order they had: the
// conflict's record, then the envelope, then the instructed record; the origin's move, then the merge; the records
// check, then the merge-only head's skip (which is a different reading, `merge_only_skip`).

///|
/// A step's own name, as the caller runs it.
fn pm_write_step(event : String, attrs : Json) -> Json {
  json_object([
    ("do", Json::string("write")),
    ("event", Json::string(event)),
    ("attrs", attrs),
  ])
}

///|
/// A record the caller writes, and the pass it ends at: the instruction that was just sent leaves the lane waiting
/// for the executor, and a later look is what lets the review go on.
fn pm_write_end(event : String, attrs : Json, action : String) -> Json {
  json_object([
    ("do", Json::string("write")),
    ("event", Json::string(event)),
    ("attrs", attrs),
    ("action", Json::string(action)),
  ])
}

///|
/// A helper the caller calls; its answer comes back under `fact`, so the next step reads what it answered. The
/// helper's failure is not thrown: the answer's `error` decides, as the tried reads did.
fn pm_call_step(
  helper : String,
  site : String,
  keep : Json,
  args : Json,
) -> Json {
  json_object([
    ("do", Json::string("call")),
    ("helper", Json::string(helper)),
    ("site", Json::string(site)),
    ("fact", Json::string("call|" + helper + "|" + site)),
    ("keep", keep),
    ("args", args),
    ("fatal", Json::boolean(false)),
    ("reread", Json::boolean(false)),
  ])
}

///|
/// The answer's action: the lane's step is done for this pass.
fn pm_action(action : String) -> Json {
  json_object([("do", Json::string("action")), ("action", Json::string(action))])
}

///|
/// The answer's action, with the failure the caller reports for the lane.
fn pm_action_error(action : String, error : String) -> Json {
  json_object([
    ("do", Json::string("action")),
    ("action", Json::string(action)),
    ("error", Json::string(error)),
  ])
}

///|
/// A reading the answer asks for: a name with nothing else to say about it.
fn pm_need(kind : String) -> FactNeed {
  need_of(kind, "", "")
}

///|
/// The text of a fact the caller answered, or the empty string.
fn pm_text(facts : Json, id : String) -> String {
  js_string_opt(field(facts, id), "")
}

///|
/// Whether a fact is a false or a missing answer: both read the same way.
fn pm_yes(facts : Json, id : String) -> Bool {
  js_truthy(field(facts, id))
}

///|
/// A named step's answer, as the caller keeps it: the object the helper answered.
fn pm_answer(facts : Json, helper : String, site : String) -> Json {
  let kept = field(facts, "call|" + helper + "|" + site)
  field(kept, "result")
}

///|
/// Whether the helper named by the site has been called already.
fn pm_called(facts : Json, helper : String, site : String) -> Bool {
  fact_given(facts, "call|" + helper + "|" + site)
}

///|
/// Whether any row is the event the name is.
fn pm_any(rows : Array[DerivedRow], event : DerivedEvent) -> Bool {
  for row in rows {
    if row.event == event {
      return true
    }
  }
  false
}

///|
/// Whether two rebuild failures are the same one: the same side to blame, for the same files. The reason's words are
/// left out on purpose: they carry a scratch path and the command's own output, which differ from one pass to the next
/// for the same failure, and a record per pass would never stop.
fn pm_same_failure(a : Json, b : Json) -> Bool {
  js_string_opt(field(a, "cause"), "") == js_string_opt(field(b, "cause"), "") &&
  js_strings(field(a, "paths")) == js_strings(field(b, "paths"))
}

///|
/// Whether a conflict for this head and mainline is on record already. A conflict that comes with a rebuild failure is
/// on record only when a record of this head and mainline carries the same failure: a record without it, or with
/// another one, does not say why this rebuild could not be made.
fn pm_conflict_seen(
  rows : Array[DerivedRow],
  head : String,
  mainline : String,
  failure : Json,
) -> Bool {
  for row in rows {
    if row.event == EvS2ReviewBaseConflict &&
      js_string_opt(row.attrs.head, "") == head &&
      js_string_opt(row.attrs.mainline, "") == mainline &&
      (
        !js_truthy(failure) ||
        pm_same_failure(row.attrs.rebuild_failure, failure)
      ) {
      return true
    }
  }
  false
}

///|
/// Whether this skip, for this head and mainline, is on record already.
fn pm_skip_seen(
  rows : Array[DerivedRow],
  head : String,
  mainline : String,
  reason : String,
) -> Bool {
  for row in rows {
    if row.event == EvS2ReviewBaseSkipped &&
      js_string_opt(row.attrs.head, "") == head &&
      js_string_opt(row.attrs.mainline, "") == mainline &&
      js_string_opt(row.attrs.reason, "") == reason {
      return true
    }
  }
  false
}

///|
/// The record a skip writes, and the pass it ends at: the reason, and the commits it was read from when it had
/// them. The review goes on after the skip, so the step answers that itself; a pass that stopped at the write would
/// be asked again for the same skip and write it again.
fn pm_skip_record(reason : String, head : String, mainTip : String) -> Json {
  let fields : Array[(String, Json)] = [("reason", Json::string(reason))]
  if head != "" {
    fields.push(("head", Json::string(head)))
  }
  if mainTip != "" {
    fields.push(("mainline", Json::string(mainTip)))
  }
  pm_write_end("s2_review_base_skipped", json_object(fields), "proceed")
}

///|
/// The lane's head and the mainline's tip, as the caller read them: a pair, or the reason they could not be read.
/// Both are read in one try by the caller, so one failure carries one text.
fn pm_head_and_tip(facts : Json, needs : Array[FactNeed]) -> (String, String)? {
  if !fact_given(facts, "head||") {
    needs.push(pm_need("head"))
    return None
  }
  if !fact_given(facts, "mainTip||") {
    needs.push(pm_need("mainTip"))
    return None
  }
  let head = pm_text(facts, "head||")
  let tip = pm_text(facts, "mainTip||")
  if head == "" || tip == "" {
    return Some(("", ""))
  }
  Some((head, tip))
}

///|
/// The merge before the first review, as a step or the facts it still wants.
pub fn pre_merge(rows : Array[DerivedRow], facts : Json) -> Json {
  let needs : Array[FactNeed] = []
  // the lane's own scope: a repo that publishes, a lane with no place or work base, a base that is a parent or an
  // external copy, and a lane without a review origin are not this merge's
  for
    name in [
      "hasLocation", "publishes", "hasLocalPath", "hasWorkBase", "baseReadable",
      "hasReviewBase",
    ] {
    if !fact_given(facts, name + "||") {
      needs.push(pm_need(name))
    }
  }
  if needs.length() > 0 {
    return pending(needs)
  }
  if !pm_yes(facts, "hasLocation||") ||
    pm_yes(facts, "publishes||") ||
    !pm_yes(facts, "hasLocalPath||") ||
    !pm_yes(facts, "hasWorkBase||") ||
    !pm_yes(facts, "baseReadable||") ||
    !pm_yes(facts, "hasReviewBase||") {
    return pm_action("none")
  }
  // the commits: a lane or a mainline that cannot be read is a skip with its reason
  let pair = match pm_head_and_tip(facts, needs) {
    Some(found) => found
    None => return pending(needs)
  }
  let (head, mainTip) = pair
  if head == "" || mainTip == "" {
    return pm_skip(
      rows,
      facts,
      "レビュー前の merge に要る commit を読めません: " +
      pm_text(facts, "readError||"),
      head,
      mainTip,
    )
  }
  // whether the head, and the review origin, already carry the mainline's tip
  if !fact_given(facts, "ancestor||") {
    needs.push(pm_need("ancestor"))
    return pending(needs)
  }
  if !js_truthy(field(facts, "ancestor||")) {
    return pm_skip(
      rows,
      facts,
      "レビュー前の merge の要否を git が答えられません: " +
      pm_text(facts, "ancestorError||"),
      head,
      mainTip,
    )
  }
  let headHas = js_truthy(field(field(facts, "ancestor||"), "headHas"))
  let baseHas = js_truthy(field(field(facts, "ancestor||"), "baseHas"))
  if headHas && baseHas {
    return pm_action("none")
  }
  if headHas {
    // the executor merged the mainline itself: only the review origin moves
    if !pm_called(facts, "review_base", "head_has") {
      return pm_call_step("review_base", "head_has", Json::null(), Json::null())
    }
    let read = pm_answer(facts, "review_base", "head_has")
    if pm_text(read, "error") != "" {
      return pm_skip(
        rows,
        facts,
        "起点を進められません: " + pm_text(read, "error"),
        head,
        mainTip,
      )
    }
    if !pm_called(facts, "record_executor_merge", "head_has") {
      return pm_call_step(
        "record_executor_merge",
        "head_has",
        json_object([
          ("head", Json::string(head)),
          ("mainline", Json::string(mainTip)),
        ]),
        json_object([
          ("head", Json::string(head)),
          ("mainline", Json::string(mainTip)),
          ("reviewBase", field(read, "reviewBase")),
        ]),
      )
    }
    let wrote = pm_answer(facts, "record_executor_merge", "head_has")
    if pm_text(wrote, "error") != "" {
      return pm_skip(
        rows,
        facts,
        "起点の記録を書けません: " + pm_text(wrote, "error"),
        head,
        mainTip,
      )
    }
    return pm_action("merged")
  }
  // a merge is needed: wait out a session at work in the lane, as the base receive does
  if !fact_given(facts, "runnerPresent||") {
    needs.push(pm_need("runnerPresent"))
    return pending(needs)
  }
  if !pm_yes(facts, "runnerPresent||") {
    return pm_skip(
      rows, facts, "agent の runtime が無いので、この worktree で session が動いていないか確かめられません",
      head, mainTip,
    )
  }
  if !fact_given(facts, "busy||") {
    needs.push(pm_need("busy"))
    return pending(needs)
  }
  if js_truthy(field(facts, "busyError||")) {
    return pm_skip(
      rows,
      facts,
      "worktree の session の有無を確かめられません: " +
      pm_text(facts, "busyError||"),
      head,
      mainTip,
    )
  }
  if pm_yes(facts, "busy||") {
    return pm_action("busy")
  }
  // the lane's own lock, held for what follows: the caller lets it go when the lane's steps are done
  if !pm_called(facts, "lock_lane", "merge") {
    return pm_call_step("lock_lane", "merge", Json::null(), Json::null())
  }
  let lock = pm_answer(facts, "lock_lane", "merge")
  if !js_truthy(field(lock, "held")) {
    return pm_skip(
      rows,
      facts,
      "lane の lock を取れません: " + pm_text(lock, "error"),
      head,
      mainTip,
    )
  }
  // what the merge needs to find: a clean worktree on the lane's branch, at the head it was read at, and what
  // git's merge-tree answers. The reads are one step: a read that throws is the merge's failure, as the tried
  // block around them was.
  if !pm_called(facts, "read_merge_state", "merge") {
    return pm_call_step("read_merge_state", "merge", Json::null(), Json::null())
  }
  let read = pm_answer(facts, "read_merge_state", "merge")
  if pm_text(read, "error") != "" {
    return pm_skip(
      rows,
      facts,
      "レビュー前の本流の merge に失敗しました: " +
      pm_text(read, "error"),
      head,
      mainTip,
    )
  }
  if !js_truthy(field(read, "clean")) {
    return pm_skip(
      rows, facts, "lane に未 commit の変更があります", head, mainTip,
    )
  }
  if !js_truthy(field(read, "onBranch")) {
    return pm_skip(
      rows, facts, "lane の worktree が lane の branch にありません", head,
      mainTip,
    )
  }
  if !js_truthy(field(read, "headStill")) {
    return pm_skip(
      rows, facts, "lane の head が変わりました", head, mainTip,
    )
  }
  if js_truthy(field(read, "unreadable")) {
    return pm_skip(
      rows,
      facts,
      "merge-tree が答えられません: " + pm_text(read, "mergeError"),
      head,
      mainTip,
    )
  }
  // generated files are a function of the sources of the tree, so a conflict on them alone holds no decision: the
  // merge is made from the tree git wrote and those files are made again from its sources (C-266-1). A conflict
  // with a source in it goes to the executor as it always did, and nothing is made again from it. The caller reads
  // which of the two a conflict is, and whether a merge that did not conflict touched a generated file (C-266-4).
  let conflicted = js_truthy(field(read, "conflict"))
  let rebuild = if conflicted {
    js_truthy(field(read, "generatedOnly"))
  } else {
    js_truthy(field(read, "rebuild"))
  }
  if conflicted && !rebuild {
    return pm_conflict(rows, facts, head, mainTip, read, Json::null())
  }
  let mut tree = field(read, "tree")
  let mut failure = Json::null()
  if rebuild {
    if !pm_called(facts, "rebuild_generated", "merge") {
      return pm_call_step(
        "rebuild_generated",
        "merge",
        Json::null(),
        json_object([
          ("tree", field(read, "tree")),
          ("outputs", field(read, "outputs")),
        ]),
      )
    }
    let rebuilt = pm_answer(facts, "rebuild_generated", "merge")
    if js_truthy(field(rebuilt, "failure")) {
      // a rebuild that could not be made leaves the result what it was without the declaration (C-266-2): the
      // conflict goes to the executor, and a merge git made goes in as git made it. The reason is carried on
      // whichever record follows, with whether the environment or the build is to blame
      failure = field(rebuilt, "failure")
      if conflicted {
        return pm_conflict(rows, facts, head, mainTip, read, failure)
      }
    } else if js_truthy(field(rebuilt, "tree")) {
      tree = field(rebuilt, "tree")
    }
  }
  // the merge itself: the origin moves, then the merge goes in, then its record
  if !pm_called(facts, "review_base", "merge") {
    return pm_call_step("review_base", "merge", Json::null(), Json::null())
  }
  let origin = pm_answer(facts, "review_base", "merge")
  if pm_text(origin, "error") != "" {
    return pm_skip(
      rows,
      facts,
      "起点を進められません: " + pm_text(origin, "error"),
      head,
      mainTip,
    )
  }
  if !pm_called(facts, "merge_mainline", "merge") {
    let args : Array[(String, Json)] = [
      ("head", Json::string(head)),
      ("mainline", Json::string(mainTip)),
      ("tree", tree),
      ("reviewBase", field(origin, "reviewBase")),
    ]
    if js_truthy(failure) {
      args.push(("rebuildFailure", failure))
    }
    return pm_call_step(
      "merge_mainline",
      "merge",
      json_object([
        ("head", Json::string(head)),
        ("mainline", Json::string(mainTip)),
      ]),
      json_object(args),
    )
  }
  let merged = pm_answer(facts, "merge_mainline", "merge")
  if pm_text(merged, "error") != "" {
    return pm_skip(
      rows,
      facts,
      "レビュー前の本流の merge に失敗しました: " +
      pm_text(merged, "error"),
      head,
      mainTip,
    )
  }
  pm_action("merged")
}

///|
/// The conflict's record: the commits and files it was read at, whether the lane waits for the executor, and, when
/// generated files alone conflicted and could not be made again, why (which of the environment and the build failed).
fn pm_conflict_attrs(
  head : String,
  mainTip : String,
  files : Json,
  awaiting : Bool,
  failure : Json,
) -> Json {
  let fields : Array[(String, Json)] = [
    ("head", Json::string(head)),
    ("mainline", Json::string(mainTip)),
    ("files", files),
    ("awaiting", Json::boolean(awaiting)),
  ]
  if js_truthy(failure) {
    fields.push(("rebuild_failure", failure))
  }
  json_object(fields)
}

///|
/// A merge that conflicts: the executor is put to it once, and a later look lets the review begin. The instruction
/// goes out once per lane, and a send that cannot be made leaves the wait on record for the next pass to try again.
fn pm_conflict(
  rows : Array[DerivedRow],
  facts : Json,
  head : String,
  mainTip : String,
  tree : Json,
  failure : Json,
) -> Json {
  let seen = pm_conflict_seen(rows, head, mainTip, failure)
  let instructed = pm_any(rows, EvS2ReviewBaseInstructed)
  if !instructed {
    if !seen {
      return pm_write_step(
        "s2_review_base_conflict",
        pm_conflict_attrs(head, mainTip, field(tree, "files"), true, failure),
      )
    }
    if !pm_called(facts, "conflict_envelope", "conflict") {
      return pm_call_step(
        "conflict_envelope",
        "conflict",
        json_object([
          ("head", Json::string(head)),
          ("mainline", Json::string(mainTip)),
        ]),
        json_object([
          ("head", Json::string(head)),
          ("mainline", Json::string(mainTip)),
          ("files", field(tree, "files")),
        ]),
      )
    }
    let sent = pm_answer(facts, "conflict_envelope", "conflict")
    if pm_text(sent, "error") != "" {
      // the wait is recorded but the instruction did not go out: the lane waits, and the next pass tries again
      return pm_action_error(
        "awaiting",
        "解消の指示を積めませんでした: " + pm_text(sent, "error"),
      )
    }
    if !pm_any(rows, EvS2ReviewBaseInstructed) {
      return pm_write_end(
        "s2_review_base_instructed",
        json_object([
          ("head", Json::string(head)),
          ("mainline", Json::string(mainTip)),
          ("files", field(tree, "files")),
        ]),
        "awaiting",
      )
    }
    return pm_action("awaiting")
  }
  // already put to the executor, and it still conflicts (or the send could not be made): advance the origin past
  // the mainline the lane already carries, record the conflict once, and let the review go on
  if !pm_called(facts, "advance_origin", "conflict") {
    return pm_call_step(
      "advance_origin",
      "conflict",
      Json::null(),
      json_object([
        ("head", Json::string(head)),
        ("mainline", Json::string(mainTip)),
      ]),
    )
  }
  if !seen {
    return pm_write_step(
      "s2_review_base_conflict",
      pm_conflict_attrs(head, mainTip, field(tree, "files"), false, failure),
    )
  }
  pm_action("proceed")
}

///|
/// The review goes on without the merge. The origin first moves past the mainline the lane's head already carries
/// (DEC-2404), then the skip is recorded once for the head, the mainline and the reason.
fn pm_skip(
  rows : Array[DerivedRow],
  facts : Json,
  reason : String,
  head : String,
  mainTip : String,
) -> Json {
  if head != "" && mainTip != "" && !pm_called(facts, "advance_origin", "skip") {
    return pm_call_step(
      "advance_origin",
      "skip",
      Json::null(),
      json_object([
        ("head", Json::string(head)),
        ("mainline", Json::string(mainTip)),
      ]),
    )
  }
  // the same skip, for the same head, mainline and reason, is written once: a caller that comes back to all this
  // again (a head it still cannot read, a merge it still cannot make) goes on to the review
  if pm_skip_seen(rows, head, mainTip, reason) {
    return pm_action("proceed")
  }
  pm_skip_record(reason, head, mainTip)
}
