// The review loop's judgements, decided from the ledger's rows and the observations the caller hands over.
//
// The loop's next step is a judgement, and a judgement two implementations hold is a judgement the tick and the
// screen can disagree about (P-4). So the judgement lives here, in the fold, and the caller hands over what only
// it can read: git's answers (a tree, a trial merge, an ancestry), the records check's output, the lane's Risk,
// and the lane's own position. What the caller reads is never a decision: a fact is a value, and the branch that
// reads it is here.
//
// A fact is named by an id, so the same question is the same fact and the caller can answer it once. A fact the
// judgement does not need is never read: the answer carries the facts it still wants (`needs`), and the caller
// reads only those and asks again. The Risk is the one that matters most: it is read when the rows and the other
// facts cannot decide alone, and not before (C-200-1, C-200-2).
//
// The card's four choices come out of one answer: the same rows and the same observations, read once (C-200-3).

///|
/// The review loop's policy, as roles.yaml writes it: the parts the judgements read.
pub(all) struct JudgePolicy {
  extras_first_round : Int
  extras_high_risk : Int
  high_risk_when : String
  final_extra : String
  final_when : String
  final_scope : String
  order_wait_hours : Double
  order_exclude_files : Array[String]
}

///|
/// The policy as the caller reads it.
fn judge_policy_of(value : Json) -> JudgePolicy {
  let extras = field(value, "extras")
  {
    extras_first_round: js_num(field(extras, "first_round")).to_int(),
    extras_high_risk: js_num(field(extras, "high_risk")).to_int(),
    high_risk_when: js_string(field(value, "highRiskWhen")),
    final_extra: js_string(field(value, "finalExtra")),
    final_when: js_string(field(value, "finalWhen")),
    final_scope: js_string(field(value, "finalScope")),
    order_wait_hours: js_num(field(value, "orderWaitHours")),
    order_exclude_files: js_strings(field(value, "orderExcludeFiles")),
  }
}

///|
/// A fact the judgement needs from outside the ledger: the kind of reading and the values it is asked about.
pub(all) struct FactNeed {
  id : String
  kind : String
  a : String
  b : String
}

///|
/// The id a fact is answered under: its kind and the values it is asked about, so the same question is one fact.
fn fact_id(kind : String, a : String, b : String) -> String {
  kind + "|" + a + "|" + b
}

///|
/// The need for one fact.
fn need_of(kind : String, a : String, b : String) -> FactNeed {
  { id: fact_id(kind, a, b), kind, a, b, }
}

///|
/// Whether the caller has answered a fact.
fn fact_given(facts : Json, id : String) -> Bool {
  has_key(facts, id)
}

///|
/// The value of a fact the caller answered.
fn fact_value(facts : Json, id : String) -> Json {
  field(facts, id)
}

///|
/// A fact the caller answered as a yes or a no.
fn fact_yes(facts : Json, id : String) -> Bool {
  js_truthy(field(facts, id))
}

///|
/// The facts the answer still wants, as the caller reads them.
fn needs_json(needs : Array[FactNeed]) -> Json {
  Json::array(
    needs.map(fn(n) {
      json_object([
        ("id", Json::string(n.id)),
        ("kind", Json::string(n.kind)),
        ("a", Json::string(n.a)),
        ("b", Json::string(n.b)),
      ])
    }),
  )
}

///|
/// An answer that is not yet one: the facts it still wants.
fn pending(needs : Array[FactNeed]) -> Json {
  json_object([("needs", needs_json(needs))])
}

///|
/// An answer with the facts it still wants beside it.
fn answered(needs : Array[FactNeed], fields : Array[(String, Json)]) -> Json {
  let all : Array[(String, Json)] = []
  for pair in fields {
    all.push(pair)
  }
  all.push(("needs", needs_json(needs)))
  json_object(all)
}

///|
/// The Risk, when the caller has answered it; otherwise the need to read it.
fn risk_of(facts : Json, needs : Array[FactNeed]) -> Bool? {
  let id = fact_id("risk", "", "")
  if fact_given(facts, id) {
    Some(fact_yes(facts, id))
  } else {
    needs.push(need_of("risk", "", ""))
    None
  }
}

///|
/// The row a derivation makes for itself: the lane it belongs to, the event, and the fields it carries.
fn synthetic_row(
  events : Array[DerivedRow],
  event : String,
  attrs : Json,
) -> DerivedRow {
  {
    idd_id: if events.length() > 0 {
      events[events.length() - 1].idd_id
    } else {
      ""
    },
    event: derived_event_of(event),
    at: "",
    attrs: row_attrs_of(attrs),
  }
}

///|
/// The rows with one more row at the end.
fn rows_with(
  events : Array[DerivedRow],
  extra : DerivedRow,
) -> Array[DerivedRow] {
  let out : Array[DerivedRow] = []
  for e in events {
    out.push(e)
  }
  out.push(extra)
  out
}

///|
/// The last review round of the loop that recorded the head it read (a blind or a final, never the device check).
fn last_review_round(events : Array[DerivedRow]) -> (Int, String)? {
  let mut i = events.length() - 1
  while i >= 0 {
    let e = events[i]
    if e.event == EvS2ReviewStarted && !is_text(e.attrs.kind, "device") {
      match non_empty_text(e.attrs.head) {
        Some(head) => return Some((i, head))
        None => return None
      }
    }
    i = i - 1
  }
  None
}

///|
/// Whether the round recorded at `index` added the High role and ran to the end.
fn round_read_high(events : Array[DerivedRow], index : Int) -> Bool {
  if index < 0 || index >= events.length() {
    return false
  }
  let a = events[index].attrs
  if !contains_text(js_strings(a.extras), "high_risk") {
    return false
  }
  match a.high_allowed {
    Json::True => return true
    _ => ()
  }
  if role_changed_in(a.fallbacks) {
    return false
  }
  let mut findings : RowAttrs? = None
  let mut i = index + 1
  while i < events.length() {
    if events[i].event == EvS2ReviewFindings {
      findings = Some(events[i].attrs)
      break
    }
    i = i + 1
  }
  match findings {
    Some(attrs) => {
      if role_changed_in(attrs.fallbacks) {
        return false
      }
      !(js_num(attrs.failed_runs) > 0.0)
    }
    None => true
  }
}

///|
/// Whether a whole-diff round at this head was read by the High role and ran to the end.
fn high_read_at(events : Array[DerivedRow], head : String) -> Bool {
  let mut i = 0
  let mut found = -1
  while i < events.length() {
    let e = events[i]
    if e.event == EvS2ReviewStarted && js_string(e.attrs.head) == head {
      found = i
      break
    }
    i = i + 1
  }
  if found < 0 {
    return false
  }
  round_read_high(events, found)
}

///|
/// Whether the final review reads this lane as High: its own Risk, or every lane under `final_extra: all`, or a
/// depth-bearing pass, whose final is the senior role's alone.
fn final_high_known(events : Array[DerivedRow], policy : JudgePolicy) -> Bool {
  policy.final_extra == "all" ||
  pass_policy(events, events.length() - 1).depth is Some(_)
}

///|
/// The final review may be skipped when the lane's tree is the one a whole-diff blind already read and judged.
fn final_skip_at(
  events : Array[DerivedRow],
  policy : JudgePolicy,
  head : String,
  facts : Json,
  needs : Array[FactNeed],
) -> String? {
  let settled = match settled_head(events) {
    Some(settled) => settled
    None => return None
  }
  let tree_id = fact_id("sameTree", settled, head)
  if !fact_given(facts, tree_id) {
    needs.push(need_of("sameTree", settled, head))
    return None
  }
  if !fact_yes(facts, tree_id) {
    return None
  }
  if policy.high_risk_when == "last" &&
    policy.extras_high_risk > 0 &&
    final_high_known(events, policy) &&
    !high_read_at(events, settled) {
    return None
  }
  if policy.high_risk_when == "last" &&
    policy.extras_high_risk > 0 &&
    !final_high_known(events, policy) {
    let high = match risk_of(facts, needs) {
      Some(high) => high
      None => return None
    }
    if high && !high_read_at(events, settled) {
      return None
    }
  }
  Some(settled)
}

///|
/// The final review is not needed under `review_final.when: behaviour` when nothing a behaviour file holds changed
/// since the last review round read the lane.
fn final_not_needed_at(
  events : Array[DerivedRow],
  policy : JudgePolicy,
  head : String,
  facts : Json,
  needs : Array[FactNeed],
) -> (String, String)? {
  if policy.final_when != "behaviour" {
    return None
  }
  if policy.high_risk_when == "last" && policy.extras_high_risk > 0 {
    if final_high_known(events, policy) {
      return None
    }
    let high = match risk_of(facts, needs) {
      Some(high) => high
      None => return None
    }
    if high {
      return None
    }
  }
  let since = match last_review_round(events) {
    Some((_, since)) => since
    None => return None
  }
  let id = fact_id("behaviour", since, head)
  if !fact_given(facts, id) {
    needs.push(need_of("behaviour", since, head))
    return None
  }
  match fact_value(facts, id) {
    Json::Array(items) =>
      if items.length() == 0 {
        Some(
          (
            "修正が挙動のファイルに触れていないので、最後のレビューを省いた",
            since,
          ),
        )
      } else {
        None
      }
    _ => None
  }
}

///|
/// Whether the final review shows the whole diff: under `high_risk_when: last` an increment is only shown when the
/// round it starts from was read by the High role; otherwise the earlier changes have not been seen. `None` means the
/// answer is waiting on the lane's Risk.
fn whole_for_unread_at(
  events : Array[DerivedRow],
  policy : JudgePolicy,
  head : String,
  facts : Json,
  needs : Array[FactNeed],
) -> Bool? {
  // only an increment's scope can leave part of the diff unseen
  if policy.final_scope != "increment" {
    return Some(false)
  }
  match last_review_round(events) {
    Some((index, since)) =>
      if since != head &&
        policy.high_risk_when == "last" &&
        policy.extras_high_risk > 0 {
        let high = if final_high_known(events, policy) {
          true
        } else {
          match risk_of(facts, needs) {
            Some(high) => high
            None => return None
          }
        }
        Some(high && !round_read_high(events, index))
      } else {
        Some(false)
      }
    None => Some(false)
  }
}

///|
/// Whether the final review may be skipped: the head a whole-diff blind read, or the behaviour files that did not
/// change. The card reads the same answer without the depth's guard, so both are answered here (C-200-3).
fn final_review_answer(
  events : Array[DerivedRow],
  args : Json,
  needs : Array[FactNeed],
) -> Json {
  let policy = judge_policy_of(field(args, "policy"))
  let facts = field(args, "facts")
  let head = js_string(field(args, "head"))
  let depth = pass_policy(events, events.length() - 1).depth
  // the loop skips the final when the tree is one a whole-diff blind read; the card reads it without the depth's
  // guard, so both answers are here
  let skip = final_skip_at(events, policy, head, facts, needs)
  match skip {
    Some(settled) =>
      return answered(needs, [
        (
          "skip",
          json_object([
            ("kind", Json::string("settled")),
            ("settled", Json::string(settled)),
            (
              "reason",
              Json::string(
                "差分全体を見たレビューから head が変わっていないので、最後のレビューを省いた",
              ),
            ),
          ]),
        ),
        ("wholeForUnread", Json::boolean(false)),
      ])
    None => ()
  }
  if depth is Some(_) {
    // a depth-bearing pass always runs its last review, but what it is shown is the same question the loop asks
    let whole = match whole_for_unread_at(events, policy, head, facts, needs) {
      Some(whole) => whole
      None => return pending(needs)
    }
    return answered(needs, [
      ("skip", Json::null()),
      ("wholeForUnread", Json::boolean(whole)),
    ])
  }
  let behaviour = match
    final_not_needed_at(events, policy, head, facts, needs) {
    Some((reason, since)) =>
      json_object([
        ("kind", Json::string("behaviour")),
        ("since", Json::string(since)),
        ("reason", Json::string(reason)),
      ])
    None => Json::null()
  }
  let whole_for_unread = match
    whole_for_unread_at(events, policy, head, facts, needs) {
    Some(whole) => whole
    None => return pending(needs)
  }
  answered(needs, [
    ("skip", behaviour),
    ("wholeForUnread", Json::boolean(whole_for_unread)),
  ])
}

///|
/// Which extra role lists a blind round adds, from the policy the round starts under.
fn round_extras_answer(
  events : Array[DerivedRow],
  args : Json,
  needs : Array[FactNeed],
) -> Json {
  let policy = judge_policy_of(field(args, "policy"))
  let facts = field(args, "facts")
  let kind = js_string(field(args, "kind"))
  let conflict = js_truthy(field(args, "conflict"))
  let out : Array[String] = []
  // a kept check and the device check add no review_blind extra
  if kind != "kept" && kind != "device" {
    if policy.extras_first_round > 0 && kind == "blind" && !conflict {
      out.push("first_round")
    }
    if policy.extras_high_risk > 0 {
      if policy.high_risk_when == "last" {
        // a final reads the lane as `final_extra` says (every lane under `all`); a conflict scope round reads its
        // real Risk
        let mut add = false
        if kind == "final" {
          if final_high_known(events, policy) {
            add = true
          } else {
            let high = match risk_of(facts, needs) {
              Some(high) => high
              None => return pending(needs)
            }
            add = high
          }
        }
        if !add && conflict {
          let high = match risk_of(facts, needs) {
            Some(high) => high
            None => return pending(needs)
          }
          add = high
        }
        if add {
          out.push("high_risk")
        }
      } else {
        // the High role's extra went to a final already: the blind rounds keep it off
        let mut spent = false
        if kind == "final" {
          let start = pass_policy(events, events.length() - 1).start
          let mut i = start + 1
          while i < events.length() {
            let e = events[i]
            if e.event == EvS2ReviewStarted &&
              js_string(e.attrs.kind) == "final" &&
              contains_text(js_strings(e.attrs.extras), "high_risk") {
              spent = true
              break
            }
            i = i + 1
          }
        }
        if kind == "blind" || !spent {
          let high = match risk_of(facts, needs) {
            Some(high) => high
            None => return pending(needs)
          }
          if high {
            out.push("high_risk")
          }
        }
      }
    }
  }
  answered(needs, [("extras", Json::array(out.map(Json::string)))])
}

///|
/// One record the judgement wants written, as the caller reads it.
fn record_step(event : String, attrs : Json) -> Json {
  json_object([
    ("kind", Json::string("record")),
    ("event", Json::string(event)),
    ("attrs", attrs),
  ])
}

///|
/// The order check before a lane's first review: whether it waits for the lanes ahead, and the records the wait
/// leaves. The trial merges are git's answers, and the lane's own head is read by the caller.
fn order_gate_answer(
  events : Array[DerivedRow],
  args : Json,
  needs : Array[FactNeed],
) -> Json {
  let policy = judge_policy_of(field(args, "policy"))
  let facts = field(args, "facts")
  let now = js_num(field(args, "now"))
  let order_at = js_num(field(args, "orderAt"))
  let in_scope = js_truthy(field(args, "inScope"))
  let prior = array_of(field(args, "prior"))
  let unreadable = js_strings(field(args, "unreadable"))
  let steps : Array[Json] = []
  let done = fn(steps : Array[Json]) -> Json {
    answered(needs, [
      ("wait", Json::boolean(false)),
      ("steps", Json::array(steps)),
    ])
  }
  // 0 (or less) turns the whole order check off
  if policy.order_wait_hours <= 0.0 {
    return done(steps)
  }
  // only a repo that does not publish and a lane on the work branch is ordered
  if !in_scope {
    return done(steps)
  }
  // a lane whose order is settled for good is never checked again
  let mut determined = false
  for e in events {
    if e.event == EvS2OrderPassed ||
      e.event == EvS2OrderUnknown ||
      e.event == EvS2OrderLimit {
      determined = true
    }
  }
  if determined {
    return done(steps)
  }
  // the lane's own head is git's answer
  let head_id = fact_id("head", "", "")
  if !fact_given(facts, head_id) {
    needs.push(need_of("head", "", ""))
    return pending(needs)
  }
  let own_head = js_string(fact_value(facts, head_id))
  // the lane's own head cannot be read: no answer, so no wait, and the reason is left once
  if own_head == "" {
    let mut seen = false
    for e in events {
      if e.event == EvS2OrderUnknown {
        seen = true
      }
    }
    if !seen {
      steps.push(
        record_step(
          "s2_order_unknown",
          json_object([
            ("reason", Json::string("lane の head を読めません")),
            ("order_at", Json::number(order_at)),
          ]),
        ),
      )
    }
    return done(steps)
  }
  // the wait's own limit counts from the first wait and is not reset when the opponent changes
  let mut waited : Int = -1
  let mut i = events.length() - 1
  while i >= 0 {
    if events[i].event == EvS2OrderWaiting {
      waited = i
      break
    }
    i = i - 1
  }
  let waited_opponents = if waited >= 0 {
    order_opponents_of(events[waited].attrs)
  } else {
    []
  }
  let waited_at = if waited >= 0 {
    let attrs = events[waited].attrs
    match attrs.since {
      Json::Null => events[waited].at
      other => js_string(other)
    }
  } else {
    ""
  }
  if waited >= 0 && waited_at != "" {
    let since_ms = host_date_ms(waited_at)
    if !since_ms.is_nan() &&
      now - since_ms >= policy.order_wait_hours * 3600_000.0 {
      steps.push(
        record_step(
          "s2_order_limit",
          json_object([
            ("since", Json::string(waited_at)),
            ("head", Json::string(own_head)),
            ("opponents", Json::array(waited_opponents.map(opponent_json))),
            ("order_at", Json::number(order_at)),
          ]),
        ),
      )
      return done(steps)
    }
  }
  let own_head_at_wait = if waited >= 0 {
    match events[waited].attrs.head {
      Json::Null => ""
      other => js_string(other)
    }
  } else {
    ""
  }
  // the opponents of the last wait, by lane
  let cached : Map[String, OrderOpponent] = Map([])
  for o in waited_opponents {
    cached.set(o.lane, o)
  }
  // the opponents this lane conflicts with
  let hits : Array[Json] = []
  let mut unknown = unreadable.length() > 0
  for p in prior {
    let lane = js_string(field(p, "lane"))
    let head = js_string(field(p, "head"))
    let known = cached.get(lane)
    // the head of neither side moved: the earlier trial merge still stands, and is not taken again
    if known is Some(_) &&
      own_head_at_wait == own_head &&
      known.unwrap().head == Some(head) {
      if known.unwrap().files.length() > 0 {
        hits.push(
          json_object([
            ("lane", Json::string(lane)),
            ("head", Json::string(head)),
            ("files", Json::array(known.unwrap().files.map(Json::string))),
          ]),
        )
      }
      continue
    }
    let id = fact_id("trialMerge", own_head, head)
    // every trial merge is asked for in one round: a lane with many opponents asks once, not once per round
    if !fact_given(facts, id) {
      needs.push(need_of("trialMerge", own_head, head))
      continue
    }
    let merge = fact_value(facts, id)
    match merge {
      Json::Null => {
        // a merge git could not answer is an opponent that does not conflict
        unknown = true
        continue
      }
      _ => ()
    }
    let files : Array[String] = []
    if js_truthy(field(merge, "conflict")) {
      for f in js_strings(field(merge, "files")) {
        if !contains_text(policy.order_exclude_files, f) {
          files.push(f)
        }
      }
    }
    if files.length() > 0 {
      hits.push(
        json_object([
          ("lane", Json::string(lane)),
          ("head", Json::string(head)),
          ("files", Json::array(files.map(Json::string))),
        ]),
      )
    }
  }
  // an opponent whose trial merge has not been read yet: answer after all of them are collected
  if needs.length() > 0 {
    return pending(needs)
  }
  if hits.length() == 0 {
    let mut seen = false
    for e in events {
      if e.event == EvS2OrderUnknown {
        seen = true
      }
    }
    if unknown && !seen {
      let opponents : Array[Json] = []
      for p in prior {
        opponents.push(
          json_object([
            ("lane", Json::string(js_string(field(p, "lane")))),
            ("head", Json::string(js_string(field(p, "head")))),
          ]),
        )
      }
      for lane in unreadable {
        opponents.push(json_object([("lane", Json::string(lane))]))
      }
      steps.push(
        record_step(
          "s2_order_unknown",
          json_object([
            ("head", Json::string(own_head)),
            ("opponents", Json::array(opponents)),
            ("order_at", Json::number(order_at)),
          ]),
        ),
      )
    }
    if waited >= 0 {
      steps.push(
        record_step(
          "s2_order_released",
          json_object([
            ("since", Json::string(waited_at)),
            ("head", Json::string(own_head)),
            ("opponents", Json::array(waited_opponents.map(opponent_json))),
            ("order_at", Json::number(order_at)),
          ]),
        ),
      )
    }
    steps.push(
      record_step(
        "s2_order_passed",
        json_object([
          ("head", Json::string(own_head)),
          ("order_at", Json::number(order_at)),
        ]),
      ),
    )
    return done(steps)
  }
  // the same wait is not written twice; a new opponent or a moved head writes the wait afresh, keeping the first
  // wait's clock
  let mut changed = false
  if waited >= 0 {
    if own_head_at_wait != own_head ||
      hits.length() != waited_opponents.length() {
      changed = true
    } else {
      let mut i = 0
      while i < hits.length() {
        let h = hits[i]
        let lane = js_string(field(h, "lane"))
        let o = cached.get(lane)
        if o is None {
          changed = true
        } else {
          let head = js_string(field(h, "head"))
          let files = js_strings(field(h, "files"))
          let same = o.unwrap().head == Some(head) &&
            o.unwrap().files.join("\u0000") == files.join("\u0000")
          if !same {
            changed = true
          }
        }
        i = i + 1
      }
    }
  }
  if waited < 0 || changed {
    steps.push(
      record_step(
        "s2_order_waiting",
        json_object([
          ("head", Json::string(own_head)),
          (
            "since",
            Json::string(
              if waited >= 0 {
                waited_at
              } else {
                host_iso_time(now)
              },
            ),
          ),
          ("opponents", Json::array(hits)),
        ]),
      ),
    )
  }
  answered(needs, [("wait", Json::boolean(true)), ("steps", Json::array(steps))])
}

///|
/// The identity of an error the records check found: its rule and its id, not the diagnostic text.
fn finding_keys(findings : Array[Json]) -> Array[String] {
  findings.map(fn(f) {
    js_string(field(f, "rule")) + "\u0000" + js_string(field(f, "id"))
  })
}

///|
/// The rule and the id of a stored key.
fn finding_id_of(key : String) -> String {
  let parts : Array[String] = []
  let mut current = ""
  for ch in key {
    if ch.to_int() == 0 {
      parts.push(current)
      current = ""
    } else {
      current = current + ch.to_string()
    }
  }
  parts.push(current)
  let rule = if parts.length() > 0 { parts[0] } else { "" }
  let id = if parts.length() > 1 { parts[1] } else { "" }
  rule + "\u0000" + id
}

///|
/// The keys of the errors the last records send-back carried.
fn last_sent_keys(events : Array[DerivedRow]) -> Array[String] {
  let mut i = events.length() - 1
  while i >= 0 {
    if events[i].event == EvS2RecordsConflict {
      return js_strings(events[i].attrs.error_keys)
    }
    i = i - 1
  }
  []
}

///|
/// Whether every error the check just found was carried by the last records send-back.
fn same_records_errors(
  events : Array[DerivedRow],
  findings : Array[Json],
) -> Bool {
  let sent = last_sent_keys(events)
  if sent.length() == 0 {
    return false
  }
  let ids : Array[String] = sent.map(finding_id_of)
  for key in finding_keys(findings) {
    if !contains_text(ids, key) {
      return false
    }
  }
  true
}

///|
/// What the records check answered: clean, errors, or a check that could not answer.
fn records_outcome(check : Json) -> (String, Array[Json], String) {
  (
    js_string(field(check, "outcome")),
    array_of(field(check, "findings")),
    js_string(field(check, "reason")),
  )
}

///|
/// The records check between the review's end and S3: whether the lane goes on, or is sent back to the executor.
fn records_check_answer(
  events : Array[DerivedRow],
  args : Json,
  needs : Array[FactNeed],
) -> Json {
  let facts = field(args, "facts")
  let head = js_string(field(args, "head"))
  let head_error = js_string(field(args, "headError"))
  let has_check = js_truthy(field(args, "hasCheck"))
  let steps : Array[Json] = []
  // there is nothing to check: the head is not even read, and a skipped round still closes the review for this head
  if !has_check {
    steps.push(json_object([("kind", Json::string("verdict"))]))
    return answered(needs, [("steps", Json::array(steps))])
  }
  if head_error != "" {
    // the lane's own head or origin cannot be read: the check cannot run, and the lane goes on
    steps.push(
      record_step(
        "s2_intent_checked",
        json_object([
          ("outcome", Json::string("unavailable")),
          (
            "reason",
            Json::string(
              "検査に要る head を読めません: " + head_error,
            ),
          ),
        ]),
      ),
    )
    steps.push(json_object([("kind", Json::string("verdict"))]))
    return answered(needs, [("steps", Json::array(steps))])
  }
  let id = fact_id("recordsCheck", "", "")
  if !fact_given(facts, id) {
    needs.push(need_of("recordsCheck", "", ""))
    return pending(needs)
  }
  let (outcome, findings, reason) = records_outcome(fact_value(facts, id))
  if outcome != "errors" {
    let attrs : Array[(String, Json)] = [
      ("outcome", Json::string(outcome)),
      ("head", Json::string(head)),
    ]
    if outcome == "unavailable" {
      attrs.push(("reason", Json::string(reason)))
    }
    steps.push(record_step("s2_intent_checked", json_object(attrs)))
    steps.push(
      json_object([
        ("kind", Json::string("verdict")),
        ("head", Json::string(head)),
      ]),
    )
    return answered(needs, [("steps", Json::array(steps))])
  }
  if same_records_errors(events, findings) {
    let attrs : Array[(String, Json)] = [
      ("outcome", Json::string("errors")),
      ("sent_back", Json::boolean(false)),
      ("head", Json::string(head)),
      ("remaining", Json::array(findings)),
      (
        "reason",
        Json::string(
          "前の差し戻しで送ったのと同じ error だけが残った",
        ),
      ),
    ]
    steps.push(record_step("s2_intent_checked", json_object(attrs)))
    steps.push(
      json_object([
        ("kind", Json::string("verdict")),
        ("head", Json::string(head)),
      ]),
    )
    return answered(needs, [("steps", Json::array(steps))])
  }
  // the lane goes back to the executor once, with the errors the check found
  steps.push(
    record_step(
      "s2_records_conflict",
      json_object([
        ("awaiting", Json::boolean(true)),
        ("head", Json::string(head)),
        ("errors", Json::array(findings)),
        ("error_keys", Json::array(finding_keys(findings).map(Json::string))),
      ]),
    ),
  )
  steps.push(
    json_object([
      ("kind", Json::string("envelope")),
      ("findings", Json::array(findings)),
    ]),
  )
  steps.push(
    json_object([
      ("kind", Json::string("verdict")),
      ("head", Json::string(head)),
    ]),
  )
  steps.push(
    record_step(
      "s2_records_instructed",
      json_object([
        ("head", Json::string(head)),
        ("errors", Json::array(findings)),
      ]),
    ),
  )
  answered(needs, [("steps", Json::array(steps))])
}

///|
/// The step after the executor answered the records send-back: only records changed, or code outside the records
/// place changed and the review's rounds run again.
fn records_recheck_answer(
  events : Array[DerivedRow],
  args : Json,
  needs : Array[FactNeed],
) -> Json {
  let facts = field(args, "facts")
  let head = js_string(field(args, "head"))
  let head_error = js_string(field(args, "headError"))
  let has_check = js_truthy(field(args, "hasCheck"))
  let steps : Array[Json] = []
  // the head the last send-back carried
  let mut from = ""
  let mut i = events.length() - 1
  while i >= 0 {
    if events[i].event == EvS2RecordsInstructed {
      from = js_string(events[i].attrs.head)
      break
    }
    i = i - 1
  }
  if from == "" {
    let mut j = events.length() - 1
    while j >= 0 {
      if events[j].event == EvS2RecordsConflict {
        from = js_string(events[j].attrs.head)
        break
      }
      j = j - 1
    }
  }
  if head_error != "" {
    // the answer cannot be told apart from a code change: the review's rounds run again
    steps.push(
      record_step(
        "s2_records_reopened",
        json_object([
          ("since_head", Json::string(from)),
          ("reason", Json::string("head を読めません: " + head_error)),
        ]),
      ),
    )
    return answered(needs, [("steps", Json::array(steps))])
  }
  // the files outside the records place that changed, or nothing when git cannot answer
  let changed_id = fact_id("outsideRecords", from, head)
  if !fact_given(facts, changed_id) {
    needs.push(need_of("outsideRecords", from, head))
    return pending(needs)
  }
  let changed = fact_value(facts, changed_id)
  let changed_files = match changed {
    Json::Array(_) => js_strings(changed)
    _ => {
      steps.push(
        record_step(
          "s2_records_reopened",
          json_object([
            ("since_head", Json::string(from)),
            ("head", Json::string(head)),
            (
              "reason",
              Json::string(
                "記録の置き場の外が変わったかを git が答えられなかった",
              ),
            ),
          ]),
        ),
      )
      return answered(needs, [("steps", Json::array(steps))])
    }
  }
  let shown : Array[String] = []
  let mut shown_count = 0
  for name in changed_files {
    if shown_count < 20 {
      shown.push(name)
      shown_count = shown_count + 1
    }
  }
  // the round a head that is only the mainline merged in does not need
  let skip = match last_review_round(events) {
    Some((_, since)) => {
      let skip_id = fact_id("mergeOnlySkip", since, head)
      if !fact_given(facts, skip_id) {
        needs.push(need_of("mergeOnlySkip", since, head))
        return pending(needs)
      }
      fact_value(facts, skip_id)
    }
    None => Json::null()
  }
  let skipped = match skip {
    Json::Null => false
    other => !js_string(field(other, "head")).is_empty()
  }
  if changed_files.length() > 0 && !skipped {
    steps.push(
      record_step(
        "s2_records_reopened",
        json_object([
          ("since_head", Json::string(from)),
          ("head", Json::string(head)),
          ("files", Json::array(shown.map(Json::string))),
        ]),
      ),
    )
    return answered(needs, [("steps", Json::array(steps))])
  }
  if !has_check {
    steps.push(
      record_step(
        "s2_intent_checked",
        json_object([
          ("outcome", Json::string("clean")),
          ("head", Json::string(head)),
        ]),
      ),
    )
  } else {
    let id = fact_id("recordsCheck", "", "")
    if !fact_given(facts, id) {
      needs.push(need_of("recordsCheck", "", ""))
      return pending(needs)
    }
    let (outcome, findings, reason) = records_outcome(fact_value(facts, id))
    if outcome == "errors" && !same_records_errors(events, findings) {
      // the merge brought errors the last send-back did not carry: the executor is told
      steps.push(
        record_step(
          "s2_records_conflict",
          json_object([
            ("awaiting", Json::boolean(true)),
            ("head", Json::string(head)),
            ("errors", Json::array(findings)),
            (
              "error_keys",
              Json::array(finding_keys(findings).map(Json::string)),
            ),
          ]),
        ),
      )
      steps.push(
        json_object([
          ("kind", Json::string("envelope")),
          ("findings", Json::array(findings)),
        ]),
      )
      steps.push(
        record_step(
          "s2_records_instructed",
          json_object([
            ("head", Json::string(head)),
            ("errors", Json::array(findings)),
          ]),
        ),
      )
      return answered(needs, [("steps", Json::array(steps))])
    }
    let attrs : Array[(String, Json)] = [
      ("outcome", Json::string(outcome)),
      ("head", Json::string(head)),
      ("sent_back", Json::boolean(false)),
    ]
    if outcome == "unavailable" {
      attrs.push(("reason", Json::string(reason)))
    }
    if outcome == "errors" {
      attrs.push(("remaining", Json::array(findings)))
      attrs.push(("reason", Json::string("戻した後にも残った error")))
    }
    steps.push(record_step("s2_intent_checked", json_object(attrs)))
  }
  if skipped {
    steps.push(
      json_object([
        ("kind", Json::string("merge_skip")),
        ("skip", skip),
        ("sinceHead", Json::string(from)),
      ]),
    )
  }
  answered(needs, [("steps", Json::array(steps))])
}

///|
/// Where an answer takes a lane stopped in the loop, found by appending it to the record and following the same
/// transition the loop runs.
fn answer_outcome(
  events : Array[DerivedRow],
  decision : String,
  note : String,
  device_on : Bool,
  skips_final : Bool,
) -> Json? {
  let prior = loop_state_json(review_loop_state(events))
  if !is_text(field(prior, "state"), "escalated") {
    return None
  }
  if decision == "hand_fix" {
    return Some(json_object([("to", Json::string("hand"))]))
  }
  // the lane goes back to its plan: no round is run, the plan is reviewed and gone through the GO again
  if decision == "replan" {
    return Some(json_object([("to", Json::string("plan"))]))
  }
  // the answer is appended to the record, and the transition runs on the record as it stands then
  let evs = rows_with(
    events,
    synthetic_row(
      events,
      "s2_review_resumed",
      json_object([
        ("decision", Json::string(decision)),
        ("note", Json::string(note)),
      ]),
    ),
  )
  let t = answered_judgement_at(evs, evs.length() - 1)
  let left_of = fn(fix : RowAttrs?) -> Json {
    if t < 0 {
      return json_object([
        ("accepted", Json::number(0.0)),
        ("questions", Json::number(0.0)),
        ("reversals", Json::number(0.0)),
      ])
    }
    let unfixed = unfixed_of(
      evs,
      t,
      fix,
      if decision == "accept" {
        ""
      } else {
        note
      },
      s4_triage(evs, t),
    )
    json_object([
      (
        "accepted",
        Json::number(array_of(field(unfixed, "accepted")).length().to_double()),
      ),
      (
        "questions",
        Json::number(array_of(field(unfixed, "questions")).length().to_double()),
      ),
      (
        "reversals",
        Json::number(array_of(field(unfixed, "reversals")).length().to_double()),
      ),
    ])
  }
  let retry = has_key(prior, "retry") && decision == "continue"
  let retry_out = {
    let fields : Array[(String, Json)] = [("to", Json::string("retry"))]
    if has_key(prior, "quotaWait") {
      fields.push(("highFallback", Json::boolean(true)))
    }
    json_object(fields)
  }
  let mut s = loop_state_json(review_loop_state(evs))
  // a stop over the checks before the convergence: a continue runs them again (a cap stop sends their failures,
  // below), an accept goes where the checks were taking the lane (the convergence, or a round the mainline's merge
  // skipped)
  let over_checks = checks_stop_at(evs, evs.length() - 1) >= 0
  if over_checks &&
    decision == "continue" &&
    !is_text(field(s, "state"), "send_fix") {
    return Some(json_object([("to", Json::string("checks"))]))
  }
  if over_checks &&
    decision == "accept" &&
    is_text(field(s, "state"), "start_blind") {
    return Some(
      json_object([
        ("to", Json::string("close")),
        ("device", Json::string("none")),
        ("left", left_of(None)),
      ]),
    )
  }
  if is_text(field(s, "state"), "send_fix") {
    if retry {
      return Some(retry_out)
    }
    let scope = fix_scope(evs)
    let refs = scope_refs(scope)
    let boundaries = array_of(field(scope, "boundaries"))
    let fix = synthetic_row(
      evs,
      "s2_fix_sent",
      json_object([
        ("refs", Json::array(refs.map(Json::string))),
        (
          "boundary_refs",
          Json::array(
            boundaries.map(fn(b) { Json::string(js_string(field(b, "ref"))) }),
          ),
        ),
      ]),
    )
    let fields : Array[(String, Json)] = [
      ("to", Json::string("fix")),
      ("all", Json::boolean(js_truthy(field(scope, "all")))),
      ("refs", Json::array(refs.map(Json::string))),
      ("boundaries", Json::number(boundaries.length().to_double())),
      ("note", Json::boolean(js_string(field(scope, "note")).trim() != "")),
      ("left", left_of(Some(fix.attrs))),
    ]
    return Some(json_object(fields))
  }
  if is_text(field(s, "state"), "start_blind") &&
    is_text(field(s, "kind"), "final") {
    if !skips_final {
      return Some(
        if retry {
          retry_out
        } else {
          json_object([("to", Json::string("final")), ("left", left_of(None))])
        },
      )
    }
    evs.push(synthetic_row(evs, "s2_review_converged", Json::null()))
    s = loop_state_json(review_loop_state(evs))
  }
  if is_text(field(s, "state"), "converge") {
    evs.push(synthetic_row(evs, "s2_review_converged", Json::null()))
    s = loop_state_json(review_loop_state(evs))
  }
  let retry_device = retry &&
    is_text(field(field(prior, "retry"), "state"), "start_device")
  if is_text(field(s, "state"), "start_device") && !retry_device {
    let device = if !device_on {
      "none"
    } else {
      let mut started = false
      for e in events {
        if e.event == EvS2DeviceStarted {
          started = true
        }
      }
      if started {
        "again"
      } else {
        "first"
      }
    }
    return Some(
      json_object([
        ("to", Json::string("close")),
        ("device", Json::string(device)),
        ("left", left_of(None)),
      ]),
    )
  }
  if is_text(field(s, "state"), "done") && !retry {
    return Some(
      json_object([
        ("to", Json::string("close")),
        ("device", Json::string("none")),
        ("left", left_of(None)),
      ]),
    )
  }
  Some(retry_out)
}

///|
/// The refs a fix's scope names.
fn scope_refs(scope : Json) -> Array[String] {
  let out : Array[String] = []
  for item in array_of(field(scope, "accepted")) {
    out.push(js_string(field(item, "ref")))
  }
  out
}

///|
/// The four choices the stuck card offers, out of one answer: the same rows and the same observations, read once.
fn stuck_outcomes_answer(
  events : Array[DerivedRow],
  args : Json,
  needs : Array[FactNeed],
) -> Json {
  let policy = judge_policy_of(field(args, "policy"))
  let facts = field(args, "facts")
  let device_on = js_truthy(field(args, "deviceOn"))
  // the card only shows for a lane the loop stopped at: the state is read before the facts, so a lane that is
  // not waiting for penne costs no Risk and no git
  if !is_text(
      field(loop_state_json(review_loop_state(events)), "state"),
      "escalated",
    ) {
    return answered(needs, [("continue", Json::null())])
  }
  // the final's skip is only read by an answer that reaches the final: a lane the loop stopped at elsewhere
  // reads no Risk and no git. Only a continue reaches the final, so the state is read once.
  let mut reaches_final = false
  for pair in [("continue", "")] {
    let marked = rows_with(
      events,
      synthetic_row(
        events,
        "s2_review_resumed",
        json_object([
          ("decision", Json::string(pair.0)),
          ("note", Json::string(pair.1)),
        ]),
      ),
    )
    let s = loop_state_json(review_loop_state(marked))
    if is_text(field(s, "state"), "start_blind") &&
      is_text(field(s, "kind"), "final") {
      reaches_final = true
    }
  }
  // the facts the final's skip needs: the lane's own head (git's answer, asked only by an answer that reaches the
  // final), the tree a whole-diff blind read, and the behaviour files that did not move
  let mut skips_final = false
  if reaches_final {
    let head_id = fact_id("head", "", "")
    if !fact_given(facts, head_id) {
      needs.push(need_of("head", "", ""))
    } else {
      // a head the caller cannot read never skips the final review
      let head = js_string(fact_value(facts, head_id))
      if head != "" {
        let settled = final_skip_at(events, policy, head, facts, needs)
        let behaviour = final_not_needed_at(events, policy, head, facts, needs)
        skips_final = settled is Some(_) || behaviour is Some(_)
      }
    }
    if needs.length() > 0 {
      return pending(needs)
    }
  }
  let plain = answer_outcome(events, "continue", "", device_on, skips_final)
  let noted = answer_outcome(
    events, "continue", "補足", device_on, skips_final,
  )
  let accept = answer_outcome(events, "accept", "", device_on, skips_final)
  let hand_fix = answer_outcome(events, "hand_fix", "", device_on, skips_final)
  let replan = answer_outcome(events, "replan", "", device_on, skips_final)
  match (plain, noted, accept, hand_fix, replan) {
    (Some(plain), Some(noted), Some(accept), Some(hand_fix), Some(replan)) =>
      answered(needs, [
        ("continue", plain),
        ("continueWithNote", noted),
        ("accept", accept),
        ("handFix", hand_fix),
        ("replan", replan),
      ])
    _ => answered(needs, [("continue", Json::null())])
  }
}
