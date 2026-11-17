// The push's next step: what the tick does with one lane at the submit card, and the record it writes.
//
// The tick's push stage decides here, from the lane's rows and the observations the caller gathered (C-202-1).
// The answer is a closed set of steps, and the caller runs them in the order they come: it writes the record,
// calls the helper, re-reads the ledger where the answer says so, and puts the lane in the stage's result. What
// it does not do is decide (C-202-2).
//
// The observations are the readings of the outside world: the saved submit, the push that reached the branch
// without its record, what the review last saw, whether the public branch already carries the change, and what
// GitHub and git answered. Each is a value; the readings stay in the TypeScript, and this side reads their
// answers (C-202-3). A reading the caller has not taken yet is named as a need, and the caller reads only those.
//
// The step a name nobody wrote a handling for cannot be written: every step is one of `SubmitDo`, and every
// name of a record this side writes is a value of `SubmitEvent`.

///|
/// What one step of the push stage does.
pub(all) enum SubmitDo {
  /// write the record the step names, with its attrs
  SubmitWrite
  /// call the helper the step names; its answer comes back under the step's `fact`
  SubmitCall
  /// put the lane into one of the stage's result's lists
  SubmitResult
  /// re-read the ledger and ask again: the record just written is what the rest of the answer reads
  SubmitAgain
  /// nothing more for this lane on this pass
  SubmitEnd
}

///|
/// The records this side writes on the push stage.
pub(all) enum SubmitEvent {
  /// the lane waits at the card for penne: the submit is checked, or a push needs a new PR
  PushHeld
}

///|
/// The stage's result lists a step may put the lane into.
pub(all) enum SubmitField {
  Ready
  Recorded
  Held
  Merged
  Errors
}

///|
/// The step's own name, as the caller runs it.
fn submit_do_text(kind : SubmitDo) -> String {
  match kind {
    SubmitWrite => "write"
    SubmitCall => "call"
    SubmitResult => "result"
    SubmitAgain => "again"
    SubmitEnd => "end"
  }
}

///|
/// The record's own name.
fn submit_event_text(event : SubmitEvent) -> String {
  match event {
    PushHeld => "s4_push_held"
  }
}

///|
/// The result list's own name.
fn submit_field_text(field : SubmitField) -> String {
  match field {
    Ready => "ready"
    Recorded => "recorded"
    Held => "held"
    Merged => "merged"
    Errors => "errors"
  }
}

///|
/// A step that writes a record.
fn submit_write(event : SubmitEvent, attrs : Json) -> Json {
  json_object([
    ("do", Json::string(submit_do_text(SubmitWrite))),
    ("event", Json::string(submit_event_text(event))),
    ("attrs", attrs),
  ])
}

///|
/// A step that calls a helper, with what the answer reads back after it.
fn submit_call(
  helper : String,
  site : String,
  keep : Json,
  args : Json,
  fatal : Bool,
) -> Json {
  submit_call_item(helper, site, keep, args, fatal, false)
}

///|
/// A step that calls a helper whose answer the rest of the answer reads from a ledger read anew (the record of a
/// push that reached the branch without it changes what the lane is).
fn submit_call_reread(
  helper : String,
  site : String,
  keep : Json,
  args : Json,
  fatal : Bool,
) -> Json {
  submit_call_item(helper, site, keep, args, fatal, true)
}

///|
/// The call's step with whether the ledger is read again after it.
fn submit_call_item(
  helper : String,
  site : String,
  keep : Json,
  args : Json,
  fatal : Bool,
  reread : Bool,
) -> Json {
  json_object([
    ("do", Json::string(submit_do_text(SubmitCall))),
    ("helper", Json::string(helper)),
    ("site", Json::string(site)),
    ("fact", Json::string("call|" + helper + "|" + site)),
    ("keep", keep),
    ("args", args),
    ("fatal", Json::boolean(fatal)),
    ("reread", Json::boolean(reread)),
  ])
}

///|
/// A step that puts the lane into a result list.
fn submit_result(field : SubmitField, idd : String) -> Json {
  json_object([
    ("do", Json::string(submit_do_text(SubmitResult))),
    ("field", Json::string(submit_field_text(field))),
    ("id", Json::string(idd)),
  ])
}

///|
/// A step that puts a failure into the stage's result.
fn submit_error(idd : String, error : String) -> Json {
  json_object([
    ("do", Json::string(submit_do_text(SubmitResult))),
    ("field", Json::string(submit_field_text(Errors))),
    ("id", Json::string(idd)),
    ("error", Json::string(error)),
  ])
}

///|
/// A step that asks the caller to read the ledger again.
fn submit_again() -> Json {
  json_object([("do", Json::string(submit_do_text(SubmitAgain)))])
}

///|
/// The step that ends this lane's pass.
fn submit_end() -> Json {
  json_object([("do", Json::string(submit_do_text(SubmitEnd)))])
}

///|
/// The facts this side asked for and did not get.
fn submit_pending(needs : Array[FactNeed]) -> Json {
  json_object([("needs", needs_json(needs))])
}

///|
/// The answer, as the caller reads it: the steps, or the facts it still wants.
fn submit_answer(steps : Array[Json], needs : Array[FactNeed]) -> Json {
  if needs.length() > 0 {
    submit_pending(needs)
  } else {
    json_object([("steps", Json::array(steps))])
  }
}

///|
/// One observation, or nothing (and the need for it) when the caller has not taken it.
fn submit_fact(
  facts : Json,
  needs : Array[FactNeed],
  kind : String,
  idd : String,
  extra : String,
) -> Json? {
  let id = fact_id(kind, idd, extra)
  if has_key(facts, id) {
    Some(field(facts, id))
  } else {
    needs.push(need_of(kind, idd, extra))
    None
  }
}

///|
/// The observation as a value, or the need for it: a step that cannot be decided without it is not taken.
fn fact_or_pending(
  facts : Json,
  needs : Array[FactNeed],
  kind : String,
  idd : String,
  extra : String,
) -> Json {
  match submit_fact(facts, needs, kind, idd, extra) {
    Some(value) => value
    None => Json::null()
  }
}

///|
/// The text of a value, or nothing.
fn opt_text(value : Json) -> String? {
  match value {
    Json::String(text) => Some(text)
    _ => None
  }
}

///|
/// Whether the answer is there at all (a field the caller left out is not a no).
fn given(value : Json) -> Bool {
  match value {
    Json::Null => false
    _ => true
  }
}

///|
/// The host's cut of a text: the first `max` characters, as the TypeScript's `slice` takes them.
extern "js" fn host_text_cut(text : String, max : Int) -> String = "(t, n) => t.slice(0, n)"

///|
/// The call's answer and what the answer read back after it.
fn call_answer(facts : Json, helper : String, site : String) -> Json? {
  let id = "call|" + helper + "|" + site
  if has_key(facts, id) {
    Some(field(facts, id))
  } else {
    None
  }
}

///|
/// Whether the error of a call is on hand: the caller saw it fail.
fn call_error(facts : Json, helper : String, site : String) -> Json? {
  let id = "err|" + helper + "|" + site
  if has_key(facts, id) {
    Some(field(facts, id))
  } else {
    None
  }
}

///|
/// The latest row of the event, or -1.
fn submit_last_row(events : Array[DerivedRow], event : DerivedEvent) -> Int {
  let mut i = events.length() - 1
  while i >= 0 {
    if events[i].event == event {
      return i
    }
    i = i - 1
  }
  -1
}

///|
/// The rows of the lane's last submit: from its last `s4_submit_started` on (all of them when it never started).
fn submit_round(events : Array[DerivedRow]) -> Array[DerivedRow] {
  let started = submit_last_row(events, EvS4SubmitStarted)
  // the TypeScript reads the round as `evs.slice(started)`, whose `started` of -1 is the lane's last row alone
  let from = if started >= 0 {
    started
  } else if events.length() > 0 {
    events.length() - 1
  } else {
    0
  }
  let out : Array[DerivedRow] = []
  let mut i = from
  while i < events.length() {
    out.push(events[i])
    i = i + 1
  }
  out
}

///|
/// A hold the tick recorded for good after the push of this head.
fn submit_stopped_after_push(round : Array[DerivedRow], head : String) -> Bool {
  let mut i = round.length() - 1
  while i >= 0 {
    let row = round[i]
    if row.event == EvS4PushHeld &&
      js_truthy(row.attrs.after_push) &&
      text_of(row.attrs.head) == head {
      return true
    }
    i = i - 1
  }
  false
}

///|
/// A hold that stops the tick for good after the push at `pushedAt` (a PR it could not settle, or none open).
fn submit_stopped_after_push_at(
  rows : Array[DerivedRow],
  pushed_at : Int,
) -> Bool {
  if pushed_at < 0 {
    return false
  }
  let mut i = rows.length() - 1
  while i > pushed_at {
    let row = rows[i]
    if row.event == EvS4PushHeld &&
      (js_truthy(row.attrs.after_push) || js_truthy(row.attrs.no_open_pr)) {
      return true
    }
    i = i - 1
  }
  false
}

///|
/// Whether the tick held this head already on the round.
fn submit_held_here(round : Array[DerivedRow], head : String) -> Bool {
  let mut found = false
  for row in round {
    if row.event == EvS4PushHeld && text_of(row.attrs.head) == head {
      found = true
    }
  }
  found
}

///|
/// How long a push to an open PR whose update could not be recorded waits before the tick tries again.
let submit_retry_ms : Double = 600000.0

///|
/// Whether the failure after the push is recent enough that the tick does not try again yet.
fn submit_failed_just_now(
  facts : Json,
  needs : Array[FactNeed],
  idd : String,
  started : String,
  now : Double,
) -> Bool {
  let at = text_of(fact_or_pending(facts, needs, "shipFailedAt", idd, started))
  if at == "" {
    return false
  }
  now - host_date_ms(at) < submit_retry_ms
}

///|
/// Whether a checked submit of this head waits for penne's approval on the card: not invalidated, not made for
/// other settings, and still inside its approval window.
fn submit_ready_at(
  saved : Json,
  needs : Array[FactNeed],
  facts : Json,
  idd : String,
  head : String,
  now : Double,
) -> Bool {
  if text_of(field(saved, "status")) != "prepared" ||
    text_of(field(saved, "head")) != head ||
    text_of(field(saved, "mode")) != "publish" ||
    js_num(field(saved, "blocking")) > 0.0 {
    return false
  }
  let expires = host_date_ms(text_of(field(saved, "expiresAt")))
  if !(expires > now) {
    return false
  }
  if !js_truthy(fact_or_pending(facts, needs, "location", idd, "")) {
    return false
  }
  let outdated = fact_or_pending(facts, needs, "outdated", idd, "")
  if js_truthy(field(outdated, "threw")) {
    return false
  }
  match opt_text(field(outdated, "reason")) {
    Some(_) => false
    None => true
  }
}

///|
/// What the settling of a push came to, as steps: the record it writes and the stage result it puts the lane in.
fn submit_settled_steps(idd : String, keep : Json, done : Json) -> Array[Json] {
  let steps : Array[Json] = []
  let head = text_of(field(keep, "head"))
  let has_pr = js_truthy(field(keep, "hasPr"))
  let what = text_of(field(keep, "what"))
  let ok = js_truthy(field(done, "ok"))
  let error = text_of(field(done, "error"))
  if !ok && js_truthy(field(done, "lockRefused")) {
    // the repo's lock held for its checks is a wait: neither an error nor a hold (DEC-2328)
    return steps
  }
  if !ok && js_truthy(field(done, "permanent")) {
    let reason = "push の後の確認で止まりました: " +
      host_text_cut(error, 300) +
      "。原因を直してから、提出前確認のカードで承認してください"
    steps.push(
      submit_write(
        PushHeld,
        json_object([
          ("head", Json::string(head)),
          ("reason", Json::string(reason)),
          ("after_push", Json::boolean(true)),
        ]),
      ),
    )
    steps.push(submit_result(Held, idd))
    return steps
  }
  if !ok {
    steps.push(submit_error(idd, if error == "" { what } else { error }))
    return steps
  }
  if js_truthy(field(done, "merged")) {
    steps.push(submit_result(Merged, idd))
    return steps
  }
  if has_pr && text_of(field(done, "prUrl")) == "" {
    let previous = field(done, "previousPr")
    let reason = if text_of(field(previous, "state")) == "MERGED" {
      "push しましたが、前の PR #" +
      js_number(field(previous, "number")).to_int().to_string() +
      " は merge 済みで、この push はそれより後の変更です。PR を作るには提出前確認のカードで承認してください"
    } else {
      "push しましたが、開いている PR がありません（前の PR は閉じています）。PR を作るには提出前確認のカードで承認してください"
    }
    let fields : Array[(String, Json)] = [
      ("head", Json::string(head)),
      ("reason", Json::string(reason)),
      ("no_open_pr", Json::boolean(true)),
    ]
    if given(previous) {
      fields.push(
        ("previous_pr", Json::number(js_num(field(previous, "number")))),
      )
      let state = text_of(field(previous, "state"))
      if state != "" {
        fields.push(("previous_pr_state", Json::string(state)))
      }
      let previous_head = text_of(field(previous, "headRefOid"))
      if previous_head != "" {
        fields.push(("previous_pr_head", Json::string(previous_head)))
      }
    }
    steps.push(submit_write(PushHeld, json_object(fields)))
    steps.push(submit_result(Held, idd))
    return steps
  }
  steps.push(submit_result(Recorded, idd))
  steps
}

///|
/// The answer of the push stage for one lane: the steps to run, or the facts still wanted.
///
/// The lane is the rows handed over (one lane's), and the facts are the caller's readings. The two questions the
/// stage asked before this one (whether it picks the lane up, and whether the lane has a head) are asked by the
/// caller, since they are the stage's own picks (C-199-2).
pub fn submit_step(events : Array[DerivedRow], facts : Json) -> String {
  let needs : Array[FactNeed] = []
  let steps = submit_steps(events, facts, needs)
  let answer = match steps {
    None => submit_pending(needs)
    Some(items) => submit_answer(items, needs)
  }
  answer.stringify()
}

///|
/// The steps of one lane, or nothing when a fact was missing (the needs are collected on the way).
fn submit_steps(
  events : Array[DerivedRow],
  facts : Json,
  needs : Array[FactNeed],
) -> Array[Json]? {
  if events.length() == 0 {
    return Some([submit_end()])
  }
  let idd = events[events.length() - 1].idd_id
  let head = text_of(fact_or_pending(facts, needs, "head", idd, ""))
  let now = js_num(fact_or_pending(facts, needs, "now", idd, ""))
  let started = submit_last_row(events, EvS4SubmitStarted)
  let round = submit_round(events)
  // a helper already answered: the answer is read where that call's step leads, and the branches before the call
  // are not read again. The old reading took no second look at the file a write had changed, and the answer the
  // helper gave is the one the lane goes on with (C-202-2)
  match call_answer(facts, "propose_admitted", "checked") {
    Some(answer) => {
      let has_pr = given(fact_or_pending(facts, needs, "pr", idd, ""))
      return Some(
        submit_after_proposed(
          idd,
          head,
          has_pr,
          field(answer, "result"),
          facts,
          needs,
        ),
      )
    }
    None => ()
  }
  for site in ["unsaved", "retry", "ready", "checked", "fresh"] {
    match call_answer(facts, "settle_pushed", site) {
      Some(answer) =>
        return Some(
          submit_settled_steps(
            idd,
            field(answer, "keep"),
            field(answer, "result"),
          ),
        )
      None => ()
    }
  }
  match call_answer(facts, "draft_commit_message", "unreviewed") {
    Some(_) => return Some([submit_end()])
    None => ()
  }
  match call_answer(facts, "draft_commit_message", "ready") {
    Some(answer) => {
      if text_of(field(answer, "result")) == "drafted" {
        return Some([submit_result(Ready, idd), submit_end()])
      }
      return Some([submit_end()])
    }
    None => ()
  }
  match call_answer(facts, "draft_commit_message", "fresh") {
    Some(_) => return Some([submit_result(Ready, idd), submit_end()])
    None => ()
  }
  let merged_pr_done = match call_answer(facts, "settle_merged_pr", "merged") {
    Some(answer) =>
      if given(field(answer, "result")) {
        return Some([submit_result(Merged, idd), submit_end()])
      } else {
        true
      }
    None => false
  }
  let saved = fact_or_pending(facts, needs, "proposal", idd, "")
  let unsaved = fact_or_pending(facts, needs, "unsaved", idd, "")
  let has_unsaved = given(unsaved)
  let outdated = if has_unsaved {
    js_truthy(fact_or_pending(facts, needs, "unsavedOutdated", idd, ""))
  } else {
    false
  }
  // a push that reached GitHub but was not saved: put on record with its own token, and the lane goes on as one
  // pushed at that commit. The pair is done with its own re-read of the ledger before anything below reads it
  let pair_done = call_answer(facts, "record_unsaved_push", "outdated")
    is Some(_) &&
    call_answer(facts, "settle_unsaved", "outdated") is Some(_)
  if has_unsaved && outdated && !pair_done {
    match call_error(facts, "record_unsaved_push", "outdated") {
      Some(failure) =>
        if js_truthy(field(failure, "lockRefused")) {
          return Some([submit_end()])
        } else {
          return Some([
            submit_error(
              idd,
              "記録の無い push を記録できません: " +
              host_text_cut(text_of(field(failure, "error")), 300),
            ),
            submit_end(),
          ])
        }
      None =>
        match call_answer(facts, "record_unsaved_push", "outdated") {
          Some(_) =>
            // the record is written, the settle is next
            match call_error(facts, "settle_unsaved", "outdated") {
              Some(failure) =>
                if js_truthy(field(failure, "lockRefused")) {
                  return Some([submit_end()])
                } else {
                  return Some([
                    submit_error(
                      idd,
                      "記録の無い push を記録できません: " +
                      host_text_cut(text_of(field(failure, "error")), 300),
                    ),
                    submit_end(),
                  ])
                }
              None =>
                match call_answer(facts, "settle_unsaved", "outdated") {
                  Some(_) => return Some([submit_again()])
                  None =>
                    return Some([
                      submit_call_reread(
                        "settle_unsaved",
                        "outdated",
                        json_object([("id", Json::string(idd))]),
                        json_object([("id", Json::string(idd))]),
                        false,
                      ),
                    ])
                }
            }
          None =>
            return Some([
              submit_call(
                "record_unsaved_push",
                "outdated",
                json_object([("id", Json::string(idd))]),
                json_object([("id", Json::string(idd)), ("unsaved", unsaved)]),
                false,
              ),
            ])
        }
    }
  }
  let pr = fact_or_pending(facts, needs, "pr", idd, "")
  let has_pr = given(pr)
  let pushed_at = submit_last_row(round, EvS4Pushed)
  if has_unsaved && !outdated {
    // its token can still finish it: the push is put on record and settled like one the tick pushed
    match call_error(facts, "record_unsaved_push", "unsaved") {
      Some(failure) =>
        return Some(
          submit_failed(
            idd, failure, "記録の無い push を記録できません", false,
          ),
        )
      None =>
        match call_answer(facts, "record_unsaved_push", "unsaved") {
          None =>
            return Some([
              submit_call(
                "record_unsaved_push",
                "unsaved",
                json_object([("id", Json::string(idd))]),
                json_object([("id", Json::string(idd)), ("unsaved", unsaved)]),
                true,
              ),
            ])
          Some(_) => ()
        }
    }
    if submit_stopped_after_push(round, head) {
      return Some([submit_end()])
    }
    if submit_failed_just_now(facts, needs, idd, started.to_string(), now) {
      return Some([submit_end()])
    }
    return Some(
      submit_settle(
        idd,
        "unsaved",
        head,
        has_pr,
        "push の後始末に失敗しました",
        text_of(field(unsaved, "token")),
        facts,
      ),
    )
  }
  let retry_reason = if pushed_at >= 0 &&
    has_pr &&
    text_of(field(saved, "status")) == "pushed" &&
    text_of(field(saved, "head")) == head &&
    !submit_stopped_after_push_at(round, pushed_at) {
    true
  } else {
    false
  }
  if pushed_at >= 0 &&
    !retry_reason &&
    (!given(saved) || text_of(field(saved, "head")) == head) {
    return Some([submit_end()])
  }
  if retry_reason {
    if submit_failed_just_now(facts, needs, idd, started.to_string(), now) {
      return Some([submit_end()])
    }
    return Some(
      submit_settle(
        idd,
        "retry",
        text_of(field(saved, "head")),
        has_pr,
        "PR の確認に失敗しました",
        text_of(field(saved, "token")),
        facts,
      ),
    )
  }
  let held_here = submit_held_here(round, head)
  if !held_here {
    // a public change the last review did not see is not got ready by the tick (the card names it)
    let unreviewed = fact_or_pending(facts, needs, "unreviewed", idd, "")
    if given(unreviewed) {
      let fields : Array[(String, Json)] = [
        ("head", Json::string(head)),
        ("reason", Json::string(text_of(field(unreviewed, "reason")))),
        ("unreviewed", Json::boolean(true)),
        ("reviewed_head", Json::string(text_of(field(unreviewed, "seen")))),
      ]
      let out : Array[Json] = [
        submit_write(PushHeld, json_object(fields)),
        submit_result(Held, idd),
      ]
      let mut drafted = false
      if submit_ready_at(saved, needs, facts, idd, head, now) {
        if !js_truthy(fact_or_pending(facts, needs, "carries", idd, "")) {
          out.push(
            submit_call(
              "draft_commit_message",
              "unreviewed",
              json_object([("id", Json::string(idd))]),
              json_object([
                ("id", Json::string(idd)),
                ("head", Json::string(head)),
                ("saved", saved),
              ]),
              true,
            ),
          )
          drafted = true
        }
      }
      if !drafted {
        out.push(submit_end())
      }
      return Some(out)
    }
  }
  if submit_ready_at(saved, needs, facts, idd, head, now) {
    // checked already for this head (by the tick, or by penne from the card): it waits for the card
    if js_truthy(fact_or_pending(facts, needs, "carries", idd, "")) {
      return Some(
        submit_settle(
          idd,
          "ready",
          head,
          has_pr,
          "PR の確認に失敗しました",
          text_of(field(saved, "token")),
          facts,
        ),
      )
    }
    return Some(submit_draft_ready(idd, head, saved, false, facts))
  }
  if held_here {
    return Some([submit_end()])
  }
  if has_pr && !js_truthy(fact_or_pending(facts, needs, "unpublished", idd, "")) {
    // a lane whose PR was merged at what it last pushed, with nothing public since: the merge is recorded and the
    // lane goes to the reclaim
    match call_error(facts, "settle_merged_pr", "merged") {
      Some(failure) =>
        return Some([
          submit_error(
            idd,
            "PR の状態を確かめられません: " +
            host_text_cut(text_of(field(failure, "error")), 300),
          ),
          submit_end(),
        ])
      None => ()
    }
    if !merged_pr_done {
      return Some([
        submit_call(
          "settle_merged_pr",
          "merged",
          json_object([("id", Json::string(idd))]),
          json_object([("id", Json::string(idd))]),
          false,
        ),
      ])
    }
  }
  // a new PR's card starts from the drafted title and body: wait for the draft the tick asks for right before this
  let pr_draft = fact_or_pending(facts, needs, "prDraft", idd, "")
  if !js_truthy(fact_or_pending(facts, needs, "openPr", idd, "")) &&
    js_truthy(fact_or_pending(facts, needs, "runnerDraft", idd, "")) &&
    !given(pr_draft) &&
    !js_truthy(
      fact_or_pending(facts, needs, "prDraftFailed", idd, started.to_string()),
    ) {
    return Some([submit_end()])
  }
  let view = fact_or_pending(facts, needs, "submitView", idd, "")
  if !given(view) {
    return Some([submit_end()])
  }
  let draft = if given(pr_draft) {
    pr_draft
  } else {
    json_object([
      ("title", Json::string(text_of(field(view, "title")))),
      ("body", Json::string(text_of(field(view, "body")))),
    ])
  }
  match call_error(facts, "propose_admitted", "checked") {
    Some(failure) =>
      return Some([
        submit_error(idd, host_text_cut(text_of(field(failure, "error")), 300)),
        submit_end(),
      ])
    None => ()
  }
  Some([
    submit_call(
      "propose_admitted",
      "checked",
      json_object([("id", Json::string(idd))]),
      json_object([
        ("id", Json::string(idd)),
        ("pr", draft),
        ("gone", fact_or_pending(facts, needs, "gone", idd, "")),
      ]),
      false,
    ),
  ])
}

///|
/// The steps of a helper's failure that the caller handles as the stage's error (a lock refusal is a wait).
fn submit_failed(
  idd : String,
  failure : Json,
  label : String,
  lock_waits : Bool,
) -> Array[Json] {
  if lock_waits && js_truthy(field(failure, "lockRefused")) {
    return [submit_end()]
  }
  [
    submit_error(
      idd,
      label + ": " + host_text_cut(text_of(field(failure, "error")), 300),
    ),
    submit_end(),
  ]
}

///|
/// The steps of a push whose follow-up the tick owes: settle it with its token, or the steps its answer leads to.
fn submit_settle(
  idd : String,
  site : String,
  head : String,
  has_pr : Bool,
  what : String,
  token : String,
  facts : Json,
) -> Array[Json] {
  let keep_fields : Array[(String, Json)] = [
    ("id", Json::string(idd)),
    ("head", Json::string(head)),
    ("hasPr", Json::boolean(has_pr)),
    ("what", Json::string(what)),
  ]
  match call_answer(facts, "settle_pushed", site) {
    None =>
      [
        submit_call(
          "settle_pushed",
          site,
          json_object(keep_fields),
          json_object([
            ("id", Json::string(idd)),
            ("token", Json::string(token)),
          ]),
          false,
        ),
      ]
    Some(answer) =>
      submit_settled_steps(idd, field(answer, "keep"), field(answer, "result"))
  }
}

///|
/// The steps of a checked submit that waits for the card: nothing is pushed, but the commit message is drafted
/// once for the head.
fn submit_draft_ready(
  idd : String,
  head : String,
  saved : Json,
  fresh : Bool,
  facts : Json,
) -> Array[Json] {
  let site = if fresh { "fresh" } else { "ready" }
  match call_answer(facts, "draft_commit_message", site) {
    None =>
      [
        submit_call(
          "draft_commit_message",
          site,
          json_object([("id", Json::string(idd))]),
          json_object([
            ("id", Json::string(idd)),
            ("head", Json::string(head)),
            ("saved", saved),
          ]),
          true,
        ),
      ]
    Some(answer) => {
      let drafted = text_of(field(answer, "result")) == "drafted"
      if drafted || fresh {
        [submit_result(Ready, idd), submit_end()]
      } else {
        [submit_end()]
      }
    }
  }
}

///|
/// The steps once the check answered: a refusal it carries, the record it hands back already pushed, a submit with
/// nothing public to push, and the steps a checked submit leads to.
fn submit_after_proposed(
  idd : String,
  head : String,
  has_pr : Bool,
  proposed : Json,
  facts : Json,
  needs : Array[FactNeed],
) -> Array[Json] {
  if given(field(proposed, "error")) {
    if js_truthy(field(proposed, "notSaved")) ||
      js_truthy(field(proposed, "lockRefused")) {
      return [submit_end()]
    }
    return [
      submit_write(
        PushHeld,
        json_object([
          ("head", Json::string(head)),
          ("reason", Json::string(text_of(field(proposed, "error")))),
        ]),
      ),
      submit_result(Held, idd),
      submit_end(),
    ]
  }
  if text_of(field(proposed, "status")) != "prepared" {
    return submit_settle(
      idd,
      "checked",
      head,
      has_pr,
      "PR の確認に失敗しました",
      text_of(field(proposed, "token")),
      facts,
    )
  }
  if text_of(field(proposed, "mode")) == "local" ||
    js_num(field(proposed, "blocking")) > 0.0 {
    let reason = if text_of(field(proposed, "mode")) == "local" {
      "公開 branch とも公開本流とも差が無い（記録の回収とローカル完了は提出前確認で行う）"
    } else {
      "必須検査が通っていない: " +
      text_of(field(proposed, "blockingSummary"))
    }
    return [
      submit_write(
        PushHeld,
        json_object([
          ("head", Json::string(head)),
          ("reason", Json::string(reason)),
        ]),
      ),
      submit_result(Held, idd),
      submit_end(),
    ]
  }
  submit_fresh(idd, head, proposed, has_pr, facts, needs)
}

///|
/// The steps of a submit the check just made: one whose branch already carries it is put on record at once (a fix
/// only in the records), any other waits for the card with the commit message drafted once for the head.
fn submit_fresh(
  idd : String,
  head : String,
  checked : Json,
  has_pr : Bool,
  facts : Json,
  needs : Array[FactNeed],
) -> Array[Json] {
  let token = text_of(field(checked, "token"))
  if js_truthy(fact_or_pending(facts, needs, "carriesOf", idd, token)) {
    return submit_settle(
      idd, "fresh", head, has_pr, "PR の確認に失敗しました", token, facts,
    )
  }
  submit_draft_ready(idd, head, checked, true, facts)
}
