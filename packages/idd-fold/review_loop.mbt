// The S2 review loop, read from the lifecycle alone — the one derivation the engine, the CLI and the tick
// use. It stands on the judgements its TS readers share: the accepted reading (a judgement plus the fixes it
// checks), the pass's policy, the send-backs for a conflict, stagnation, and the fix caps. Those five are here
// and only here, because a second copy on the running path lets the loop close while the submit card still
// lists leftovers (C-191-2).
//
// The answer is JSON because the caller is on the other side: it hands rows in once and reads the loop's answer
// back. What a row carried is handed back as it came (an accepted item, a stored retry state): the record is an
// append-only log, and this side only says what it means.

///|
/// accepted should at or below this ends the loop (one nit-like should is tolerated); an accepted must never is
const ACCEPTED_LIMIT : Int = 1

///|
/// safety cap on fix rounds; reaching it escalates instead of looping on
const MAX_FIX_ROUNDS : Int = 8

///|
/// consecutive failures to start a stage before the loop asks penne

///|
/// how long a lane whose stage could not start waits before the next try
const START_RETRY_MS : Double = 300000.0

///|
/// the shoulds one `triage`-value judgement may recommend fixing before penne is asked
const DEFAULT_MAX_SHOULD_FIX : Int = 2

///|
/// How deep a lane's change goes: the depth a round recorded on its first blind.
pub(all) enum Depth {
  Shallow
  Standard
  Deep
} derive(Eq)

///|
/// The depth a value names, or nothing when it names none of the three.
fn depth_of(value : Json) -> Depth? {
  match value {
    Json::String(text) =>
      if text == "shallow" {
        Some(Shallow)
      } else if text == "standard" {
        Some(Standard)
      } else if text == "deep" {
        Some(Deep)
      } else {
        None
      }
    _ => None
  }
}

///|
/// What the depth of a lane decides: the one table every stage count is read from.
pub(all) struct DepthRow {
  plan_review : Int
  blind : Int
  // the spec checks a blind round or the last review starts beside it, on the same head (C-223-2)
  spec : Int
  final_review : Bool
  fix_rounds : Int
  auto_go : Bool
  // the shape judge the plan review starts beside its reviewers (C-252-1): one run at the deepest depth, none below
  shape : Int
}

///|
/// The one depth table.
fn depth_row(depth : Depth) -> DepthRow {
  match depth {
    Shallow =>
      {
        plan_review: 1,
        blind: 1,
        spec: 1,
        final_review: true,
        fix_rounds: 1,
        auto_go: true,
        shape: 0,
      }
    Standard =>
      {
        plan_review: 2,
        blind: 2,
        spec: 1,
        final_review: true,
        fix_rounds: 2,
        auto_go: false,
        shape: 0,
      }
    Deep =>
      {
        plan_review: 2,
        blind: 2,
        spec: 1,
        final_review: true,
        fix_rounds: 3,
        auto_go: false,
        shape: 1,
      }
  }
}

///|
/// The depth table as the TypeScript side reads it: one object per depth, so the counts are not written twice.
pub fn depth_table_json() -> String {
  let out : Array[Json] = []
  for pair in [("shallow", Shallow), ("standard", Standard), ("deep", Deep)] {
    let row = depth_row(pair.1)
    out.push(
      Json::object(
        Map([
          ("depth", Json::string(pair.0)),
          ("planReview", Json::number(row.plan_review.to_double())),
          ("blind", Json::number(row.blind.to_double())),
          ("spec", Json::number(row.spec.to_double())),
          ("finalReview", Json::boolean(row.final_review)),
          ("fixRounds", Json::number(row.fix_rounds.to_double())),
          ("autoGo", Json::boolean(row.auto_go)),
          ("shape", Json::number(row.shape.to_double())),
        ]),
      ),
    )
  }
  Json::array(out).stringify()
}

///|
/// The review kinds a round can have.
pub(all) enum ReviewKind {
  Blind
  Final
  Device
  Kept
  OtherReviewKind(String)
} derive(Eq)

///|
/// The review kind's own text.
fn review_kind_text(kind : ReviewKind) -> String {
  match kind {
    Blind => "blind"
    Final => "final"
    Device => "device"
    Kept => "kept"
    OtherReviewKind(text) => text
  }
}

///|
/// What a triage judges.
pub(all) enum TriageKind {
  TrieBlind
  TrieFinal
  TrieDevice
  TrieKept
  TrieConfirm
  TrieFeedback
  OtherTriageKind(String)
} derive(Eq)

///|
/// The triage kind a value names.
fn triage_kind_of(value : Json) -> TriageKind {
  match value {
    Json::String(text) =>
      if text == "blind" {
        TrieBlind
      } else if text == "final" {
        TrieFinal
      } else if text == "device" {
        TrieDevice
      } else if text == "kept" {
        TrieKept
      } else if text == "confirm" {
        TrieConfirm
      } else if text == "feedback" {
        TrieFeedback
      } else {
        OtherTriageKind(text)
      }
    _ => OtherTriageKind(js_string(value))
  }
}

///|
/// One route a map drew.
priv struct RiskRoute {
  id : String
  paths : Array[String]
  question : String
  harms : Array[String]
}

///|
/// The routes a value holds, as a record keeps them: every field checked, a route without a file or a question
/// left out, the rest defaulted.
fn routes_of(value : Json) -> Array[RiskRoute] {
  let out : Array[RiskRoute] = []
  for item in array_of(value) {
    match item {
      Json::Object(_) => {
        let paths : Array[String] = []
        for p in array_of(field(item, "paths")) {
          match p {
            Json::String(text) => if text == "" { () } else { paths.push(text) }
            _ => ()
          }
        }
        let question = match field(item, "question") {
          Json::String(text) => if text == "" { continue } else { text }
          _ => continue
        }
        if paths.length() == 0 {
          continue
        }
        let harms : Array[String] = []
        for h in array_of(field(item, "harms")) {
          match h {
            Json::String(text) =>
              if text == "authority" ||
                text == "irreversible" ||
                text == "shown_vs_sent" {
                harms.push(text)
              }
            _ => ()
          }
        }
        let id = match non_empty_text(field(item, "id")) {
          Some(text) => text
          None => "R-" + (out.length() + 1).to_string()
        }
        out.push({ id, paths, question, harms, })
      }
      _ => ()
    }
  }
  out
}

///|
/// One route as the answer carries it.
fn route_json(route : RiskRoute) -> Json {
  Json::object(
    Map([
      ("id", Json::string(route.id)),
      ("paths", Json::array(route.paths.map(Json::string))),
      ("question", Json::string(route.question)),
      ("harms", Json::array(route.harms.map(Json::string))),
    ]),
  )
}

///|
/// A lane the order check waits on.
priv struct OrderOpponent {
  lane : String
  head : String?
  files : Array[String]
}

///|
/// The opponents an order wait recorded, as the record holds them.
fn order_opponents_of(attrs : RowAttrs) -> Array[OrderOpponent] {
  order_opponents_json(attrs.opponents)
}

///|
/// The opponents an array holds, as the record holds them.
fn order_opponents_json(value : Json) -> Array[OrderOpponent] {
  let out : Array[OrderOpponent] = []
  for o in array_of(value) {
    match o {
      Json::Object(_) => {
        let lane = non_empty_text(field(o, "lane"))
        match lane {
          None => ()
          Some(lane) =>
            out.push({
              lane,
              head: non_empty_text(field(o, "head")),
              files: js_strings(field(o, "files")),
            })
        }
      }
      _ => ()
    }
  }
  out
}

///|
/// One opponent as the answer carries it.
fn opponent_json(o : OrderOpponent) -> Json {
  let fields : Array[(String, Json)] = [("lane", Json::string(o.lane))]
  match o.head {
    Some(head) => fields.push(("head", Json::string(head)))
    None => ()
  }
  fields.push(("files", Json::array(o.files.map(Json::string))))
  json_object(fields)
}

///|
/// The accepted items a judgement recorded, as they came.
fn accepted_of(attrs : RowAttrs) -> Array[Json] {
  match attrs.accepted {
    Json::Array(items) => items
    _ => []
  }
}

///|
/// One piece of a glob scope entry.
priv enum GlobPart {
  Lit(Char)
  // `*`: any run of characters inside one path segment
  Star
  // `**`: any run of characters, segments included
  DeepStar
}

///|
/// A glob as its pieces: `**` is one piece, `*` another, every other character stands for itself.
fn glob_parts(glob : String) -> Array[GlobPart] {
  let chars = glob.to_array()
  let out : Array[GlobPart] = []
  let mut i = 0
  while i < chars.length() {
    if chars[i] == '*' {
      if i + 1 < chars.length() && chars[i + 1] == '*' {
        out.push(DeepStar)
        i = i + 2
      } else {
        out.push(Star)
        i = i + 1
      }
    } else {
      out.push(Lit(chars[i]))
      i = i + 1
    }
  }
  out
}

///|
/// Whether the pieces from `at` match the text from `pos` to its end.
fn glob_matches(
  parts : Array[GlobPart],
  at : Int,
  text : Array[Char],
  pos : Int,
) -> Bool {
  if at == parts.length() {
    return pos == text.length()
  }
  match parts[at] {
    Lit(c) =>
      pos < text.length() &&
      text[pos] == c &&
      glob_matches(parts, at + 1, text, pos + 1)
    Star => {
      let mut p = pos
      while true {
        if glob_matches(parts, at + 1, text, p) {
          return true
        }
        if p < text.length() && text[p] != '/' {
          p = p + 1
        } else {
          return false
        }
      }
      false
    }
    DeepStar => {
      let mut p = pos
      while p <= text.length() {
        if glob_matches(parts, at + 1, text, p) {
          return true
        }
        p = p + 1
      }
      false
    }
  }
}

///|
/// The directory part of a path, with its trailing `/`; a file at the repo root has none.
fn parent_dir(path : String) -> String? {
  let mut at = path.length() - 1
  while at >= 0 {
    if path[at] == '/' {
      return Some(path[:at + 1].to_owned())
    }
    at = at - 1
  }
  None
}

///|
/// Whether a file is a test: it sits under a `test` or `tests` directory, or its name marks it as one. Which tests a
/// plan needs is left to the implementer, so a test is never counted outside the plan's scope.
fn is_test_file(file : String) -> Bool {
  let parts = file.split("/").map(fn(p) { p.to_owned() }).collect()
  let name = parts[parts.length() - 1]
  let mut under_test_dir = false
  for i = 0; i < parts.length() - 1; i = i + 1 {
    if parts[i] == "test" || parts[i] == "tests" || parts[i] == "__tests__" {
      under_test_dir = true
    }
  }
  under_test_dir ||
  name.contains(".test.") ||
  name.contains(".spec.") ||
  name.has_suffix("_test.mbt") ||
  name.has_suffix("_wbtest.mbt") ||
  name.has_suffix("_test.go")
}

///|
/// Whether a file a round changed lies inside the plan's scope. An entry with a `*` is a glob (`*` inside one
/// segment, `**` across segments, and a trailing `/` holds everything under it); any other entry that ends in `/`
/// names a directory and holds everything under it, and the rest name one file. A file entry also names its module,
/// the directory it sits in: the files beside it are inside, because how a plan's module is split into files is the
/// implementer's to choose. A test file is inside wherever it is. A file at the repo root has no module. A file entry
/// that is the tail of another entry (`src/a.ts` beside `packages/x/src/a.ts`) is the same file written from the repo
/// root, not a second place: it names the file itself and no module.
fn in_scope(file : String, scope : Array[String]) -> Bool {
  if is_test_file(file) {
    return true
  }
  let text = file.to_array()
  let dir = parent_dir(file)
  for entry in scope {
    if entry.contains("*") {
      let glob = if entry.has_suffix("/") { entry + "**" } else { entry }
      if glob_matches(glob_parts(glob), 0, text, 0) {
        return true
      }
    } else if entry.has_suffix("/") {
      if file.has_prefix(entry) {
        return true
      }
    } else if file == entry {
      return true
    } else if dir is Some(d) &&
      parent_dir(entry) == Some(d) &&
      !is_root_alias(entry, scope) {
      return true
    }
  }
  false
}

///|
/// Whether a file entry is another entry written from the repo root: some other entry ends with `/` and then this one.
/// The GO records a name a plan wrote under its module both ways (`packages/x/src/a.ts` and `src/a.ts`), and only the
/// first is where the plan's module is.
fn is_root_alias(entry : String, scope : Array[String]) -> Bool {
  let tail = "/" + entry
  for other in scope {
    if other != entry && !other.contains("*") && other.has_suffix(tail) {
      return true
    }
  }
  false
}

///|
/// Two texts compared by their UTF-16 code units, the order a JavaScript `sort()` gives. MoonBit's own comparison of
/// two strings weighs their lengths first, so it does not give the order the TypeScript side reads.
fn compare_units(a : String, b : String) -> Int {
  let shorter = if a.length() < b.length() { a.length() } else { b.length() }
  let mut i = 0
  while i < shorter {
    let x = a.code_unit_at(i).to_int()
    let y = b.code_unit_at(i).to_int()
    if x != y {
      return if x < y { -1 } else { 1 }
    }
    i = i + 1
  }
  a.length() - b.length()
}

///|
/// A list of file names, each once, in the order of their text.
fn sorted_unique(files : Array[String]) -> Array[String] {
  let sorted = files.copy()
  sorted.sort_by(compare_units)
  let out : Array[String] = []
  for file in sorted {
    if out.length() == 0 || out[out.length() - 1] != file {
      out.push(file)
    }
  }
  out
}

///|
/// A round's line while the judgements of the round are folded into it.
priv struct TraceLine {
  cycle : Int
  round : Double
  kind : String
  mut must : Int
  mut should : Int
  named : Array[String]
  changed : Int
  outside : Array[String]
}

///|
/// The files of a result the round lines count: the cycle's own (`cycle_files`, written only for a lane that went
/// back to its plan, the files it changed since the cycle started), else the whole list the lane changed
/// (`changed_files`). A previous cycle's file is not outside the plan this cycle runs under.
fn cycle_or_changed(attrs : RowAttrs) -> Json {
  match attrs.cycle_files {
    Json::Array(_) => attrs.cycle_files
    _ => attrs.changed_files
  }
}

///|
/// One line per round of a lane, read from the ledger's own fields and nothing else. A round is named by its cycle
/// (how many rows that send the lane back to its plan came before it, `returns_to_plan`: a return numbers the rounds again from 1) and its number;
/// the judgements the review loop recorded (`s2_triage_done`) for one round, a re-judgement (`confirm`) left out,
/// are one line at the place of the first of them. The line holds the cycle and the round, the must / should
/// findings its judgements accepted (added up), the files those findings named (each once), and — as of its first
/// judgement — the kind, the number of files the last `s2_result` before it changed in the round's cycle (`cycle_or_changed`), and the ones of them outside
/// the scope the last GO before it recorded (`plan_scope`: the files the plan named as the ones to touch, as that
/// GO took them; a round is measured against the plan it ran under, and a GO that recorded none puts no file
/// outside). The same rows give the same lines, and the lines are as many as the rounds.
fn round_trace(events : Array[DerivedRow]) -> Json {
  let lines : Array[TraceLine] = []
  let mut changed : Array[String] = []
  let mut scope : Array[String] = []
  let mut cycle = 0
  for e in events {
    if e.event == EvS1Go {
      scope = js_strings(e.attrs.plan_scope)
      continue
    }
    if returns_to_plan(e) {
      cycle = cycle + 1
      continue
    }
    if e.event == EvS2Result {
      changed = sorted_unique(js_strings(cycle_or_changed(e.attrs)))
      continue
    }
    if e.event != EvS2TriageDone || event_kind(e.attrs) is TrieConfirm {
      continue
    }
    let mut must = 0
    let mut should = 0
    let named : Array[String] = []
    for item in accepted_of(e.attrs) {
      let severity = js_string(field(item, "severity"))
      if severity == "must" || severity == "should" {
        if severity == "must" {
          must = must + 1
        } else {
          should = should + 1
        }
        match field(item, "path") {
          Json::String(path) => if path != "" { named.push(path) }
          _ => ()
        }
      }
    }
    let round = js_num(e.attrs.round)
    let mut found : TraceLine? = None
    for line in lines {
      if line.cycle == cycle && line.round == round {
        found = Some(line)
        break
      }
    }
    match found {
      Some(line) => {
        line.must = line.must + must
        line.should = line.should + should
        for path in named {
          line.named.push(path)
        }
      }
      None => {
        let outside : Array[String] = []
        if scope.length() > 0 {
          for file in changed {
            if !in_scope(file, scope) {
              outside.push(file)
            }
          }
        }
        lines.push({
          cycle,
          round,
          kind: js_string(kind_or(e.attrs.kind)),
          must,
          should,
          named,
          changed: changed.length(),
          outside,
        })
      }
    }
  }
  Json::array(
    lines.map(fn(line) {
      json_object([
        ("cycle", Json::number(line.cycle.to_double())),
        ("round", Json::number(line.round)),
        ("kind", Json::string(line.kind)),
        ("accepted_must", Json::number(line.must.to_double())),
        ("accepted_should", Json::number(line.should.to_double())),
        (
          "named_files",
          Json::array(sorted_unique(line.named).map(Json::string)),
        ),
        ("changed_files", Json::number(line.changed.to_double())),
        ("outside_scope", Json::array(line.outside.map(Json::string))),
      ])
    }),
  )
}

///|
/// The rejected items a judgement recorded.
fn rejected_of(attrs : RowAttrs) -> Array[Json] {
  let out : Array[Json] = []
  for item in array_of(attrs.rejected) {
    match field(item, "claim") {
      Json::String(_) => out.push(item)
      _ => ()
    }
  }
  out
}

///|
/// A finding the triage found undoing an earlier round's fix.
priv struct Oscillation {
  ref_text : String
  severity : String
  claim : String
  path : String?
  reason : String?
  prior_ref : String
  prior : String
  current : String
}

///|
/// The reversals a triage recorded; a malformed entry is skipped, not trusted.
fn oscillations_of(attrs : RowAttrs) -> Array[Oscillation] {
  let out : Array[Oscillation] = []
  for o in array_of(attrs.oscillations) {
    match o {
      Json::Object(_) =>
        out.push({
          ref_text: text_of(field(o, "ref")),
          severity: text_of(field(o, "severity")),
          claim: text_of(field(o, "claim")),
          prior_ref: text_of(field(o, "prior_ref")),
          prior: text_of(field(o, "prior")),
          current: text_of(field(o, "current")),
          path: non_empty_text(field(o, "path")),
          reason: non_empty_text(field(o, "reason")),
        })
      _ => ()
    }
  }
  out
}

///|
/// One reversal as the answer carries it.
fn oscillation_json(o : Oscillation) -> Json {
  let fields : Array[(String, Json)] = [
    ("ref", Json::string(o.ref_text)),
    ("severity", Json::string(o.severity)),
    ("claim", Json::string(o.claim)),
    ("prior_ref", Json::string(o.prior_ref)),
    ("prior", Json::string(o.prior)),
    ("current", Json::string(o.current)),
  ]
  match o.path {
    Some(path) => fields.push(("path", Json::string(path)))
    None => ()
  }
  match o.reason {
    Some(reason) => fields.push(("reason", Json::string(reason)))
    None => ()
  }
  json_object(fields)
}

///|
/// Penne's decision on a reversal, recorded with the continue.
priv struct BoundaryDecision {
  ref_text : String
  choice : String
  text : String
}

///|
/// The decisions a `s2_review_resumed` recorded.
fn boundaries_of(attrs : RowAttrs) -> Array[BoundaryDecision] {
  let out : Array[BoundaryDecision] = []
  for b in array_of(attrs.boundaries) {
    match b {
      Json::Object(_) => {
        let choice = field(b, "choice")
        let known = is_text(choice, "prior") ||
          is_text(choice, "current") ||
          is_text(choice, "custom")
        match field(b, "ref") {
          Json::String(found) =>
            if known {
              out.push({
                ref_text: found,
                choice: text_of(choice),
                text: text_of(field(b, "text")),
              })
            }
          _ => ()
        }
      }
      _ => ()
    }
  }
  out
}

///|
/// Penne's correction of one accepted finding: the weight and the handling she set on the stuck card.
priv struct Correction {
  ref_text : String
  severity : String
  action : String
  reason : String
}

///|
/// The corrections a `s2_review_resumed` recorded. An entry that names no ref, a weight or a handling the loop does
/// not know, or a must put off is skipped, not trusted: a must is the weight of what is fixed now.
fn corrections_of(attrs : RowAttrs) -> Array[Correction] {
  let out : Array[Correction] = []
  for c in array_of(attrs.corrections) {
    match c {
      Json::Object(_) => {
        let severity = text_of(field(c, "severity"))
        let action = text_of(field(c, "action"))
        let known = (
            severity == "must" || severity == "should" || severity == "nit"
          ) &&
          (action == "fix" || action == "followup" || action == "skip") &&
          (severity != "must" || action == "fix")
        match non_empty_text(field(c, "ref")) {
          Some(found) =>
            if known {
              out.push({
                ref_text: found,
                severity,
                action,
                reason: text_of(field(c, "reason")),
              })
            }
          None => ()
        }
      }
      _ => ()
    }
  }
  out
}

///|
/// The round and kind a finding came from.
priv struct RefScope {
  round : Double
  kind : String
}

///|
/// The key a ref is compared under.
fn ref_key(reference : String, scope : RefScope?) -> String {
  let slash = last_index_of(reference, "/")
  if slash >= 0 {
    match scope {
      Some(_) => reference
      None => reference[slash + 1:].to_owned()
    }
  } else {
    match scope {
      Some(s) => number_text(s.round) + "-" + s.kind + "/" + reference
      None => reference
    }
  }
}

///|
/// A number as the TypeScript writes one into a key: no trailing `.0`.
fn number_text(value : Double) -> String {
  value.to_string()
}

///|
/// The last index of `needle` in `text`, or -1.
fn last_index_of(text : String, needle : String) -> Int {
  let mut found = -1
  let mut from = 0
  while from <= text.length() {
    let sub = text[from:].to_owned()
    match sub.find(needle) {
      Some(i) => {
        found = from + i
        from = found + 1
      }
      None => break
    }
  }
  found
}

///|
/// A judgement's kind and round, as its refs are scoped.
fn scope_of(attrs : RowAttrs) -> RefScope {
  { round: js_num(attrs.round), kind: kind_text(attrs.kind, "blind"), }
}

///|
/// `a.kind ?? "blind"` as text.
fn kind_text(value : Json, fallback : String) -> String {
  match value {
    Json::Null => fallback
    Json::String(text) => text
    _ => js_string(value)
  }
}

///|
/// The judging kind a row names, as a closed value.
fn event_kind(attrs : RowAttrs) -> TriageKind {
  triage_kind_of(kind_or(attrs.kind))
}

///|
/// `(a.kind ?? "blind") === "blind"`.
fn kind_is_blind(attrs : RowAttrs) -> Bool {
  event_kind(attrs) is TrieBlind
}

///|
/// The judgement a `s2_review_resumed` at `r` answered: the last judgement recorded before it.
fn judgement_before(events : Array[DerivedRow], r : Int) -> Int {
  let mut j = r - 1
  while j >= 0 {
    if events[j].event == EvS2TriageDone && !js_truthy(events[j].attrs.failed) {
      return j
    }
    j = j - 1
  }
  -1
}

///|
/// A finding read with penne's correction in place of the judgement's weight and handling.
fn corrected_item(item : Json, c : Correction) -> Json {
  // the weight the judgement gave stays beside the one penne set, so a must put off still reads as a must that was
  let judged = with_text_field(
    item,
    "judged_severity",
    text_of(field(item, "severity")),
  )
  let weighed = with_text_field(
    with_text_field(judged, "severity", c.severity),
    "action",
    c.action,
  )
  let marked = with_field(weighed, "corrected", Json::boolean(true))
  if c.reason == "" {
    marked
  } else {
    with_text_field(marked, "correction_reason", c.reason)
  }
}

///|
/// The weight the judgement gave, when penne set another: the field a card and a leftover carry beside the weight she set.
fn judged_weight_fields(item : Json) -> Array[(String, Json)] {
  match non_empty_text(field(item, "judged_severity")) {
    Some(judged) =>
      if judged != text_of(field(item, "severity")) {
        [("judgedSeverity", Json::string(judged))]
      } else {
        []
      }
    None => []
  }
}

///|
/// Whether penne corrected a finding to one that is not fixed now and not followed up either: set aside.
fn is_set_aside(item : Json) -> Bool {
  js_truthy(field(item, "corrected")) && !fixes_now(item)
}

///|
/// What a judgement accepted, with penne's corrections read in place of its own weight and handling.
///
/// A correction reaches a finding two ways. The judgement the stuck card was about is corrected by the ref the card
/// showed. A later judgement names the correction a finding repeats (`correction_ref`, which it writes when the
/// finding has the same nature as one penne decided), and reads that correction. What an earlier round sent to the fix
/// is not added back: a fix that did not hold is found again by a later blind, from the diff.
fn accepted_at(events : Array[DerivedRow], i : Int) -> Array[Json] {
  let a = if i >= 0 && i < events.length() {
    events[i].attrs
  } else {
    row_attrs_of(Json::null())
  }
  let base = accepted_of(a)
  let scoped : Array[Json] = match pass_policy(events, i).depth {
    Some(_) => {
      let scope = scope_of(a)
      let out : Array[Json] = []
      for x in base {
        out.push(
          with_text_field(
            x,
            "ref",
            ref_key(text_of(field(x, "ref")), Some(scope)),
          ),
        )
      }
      out
    }
    None => base
  }
  // the corrections of every answer, in the order they were given: a later one on the same ref wins
  let answers : Array[(Int, Int, Correction)] = []
  let mut r = 0
  while r < events.length() {
    if events[r].event == EvS2ReviewResumed {
      let target = judgement_before(events, r)
      for c in corrections_of(events[r].attrs) {
        answers.push((target, r, c))
      }
    }
    r = r + 1
  }
  if answers.length() == 0 {
    return scoped
  }
  let out : Array[Json] = []
  for x in scoped {
    let found = text_of(field(x, "ref"))
    let cited = text_of(field(x, "correction_ref"))
    let mut hit : Correction? = None
    for answer in answers {
      let direct = answer.0 == i && answer.2.ref_text == found
      let repeats = cited != "" && answer.1 < i && answer.2.ref_text == cited
      if direct || repeats {
        hit = Some(answer.2)
      }
    }
    match hit {
      Some(c) => out.push(corrected_item(x, c))
      None => out.push(x)
    }
  }
  out
}

///|
/// Whether a list of strings holds one.
fn contains_text(values : Array[String], text : String) -> Bool {
  let mut found = false
  for value in values {
    if value == text {
      found = true
    }
  }
  found
}

///|
/// The smaller of two integers.
fn min_int(a : Int, b : Int) -> Int {
  if a < b {
    a
  } else {
    b
  }
}

///|
/// Whether an accepted item is fixed by this change: a must always is, and so is anything whose recommended
/// handling is `fix` or is not readable at all.
fn fixes_now(item : Json) -> Bool {
  if is_text(field(item, "severity"), "must") {
    return true
  }
  let action = field(item, "action")
  !is_text(action, "followup") && !is_text(action, "skip")
}

///|
/// A finding the judgement left for a follow-up.
fn is_followup(item : Json) -> Bool {
  is_text(field(item, "action"), "followup") && !fixes_now(item)
}

///|
/// Whether a fix not made for an S4 pass takes the item: what this change's fix takes, but a nit only when penne
/// corrected it to fix. A nit the judgement left is never sent; one penne chose to fix is.
fn in_fix_scope(item : Json) -> Bool {
  fixes_now(item) &&
  (
    !is_text(field(item, "severity"), "nit") ||
    js_truthy(field(item, "corrected"))
  )
}

///|
/// The accepted must / should counts a close condition reads. A nit penne corrected to fix counts as a must: what a
/// person chose to have fixed is not left to a close.
fn fix_counts(items : Array[Json]) -> (Int, Int) {
  let mut must = 0
  let mut should = 0
  for item in items {
    if fixes_now(item) {
      if is_text(field(item, "severity"), "must") ||
        (
          is_text(field(item, "severity"), "nit") &&
          js_truthy(field(item, "corrected"))
        ) {
        must = must + 1
      } else if is_text(field(item, "severity"), "should") {
        should = should + 1
      }
    }
  }
  (must, should)
}

///|
/// The loop may close: no accepted must at all, and at most ACCEPTED_LIMIT accepted should.
fn within_limit(must : Int, should : Int) -> Bool {
  must == 0 && should <= ACCEPTED_LIMIT
}

///|
/// How many items a list has of must or should.
fn blocking(items : Array[Json]) -> Int {
  let mut n = 0
  for item in items {
    if is_text(field(item, "severity"), "must") ||
      is_text(field(item, "severity"), "should") {
      n = n + 1
    }
  }
  n
}

///|
/// How the pass that holds event `i` closes and how many fix rounds it may send.
pub(all) struct PassPolicy {
  close_on_must : Bool
  close_on_fix : Bool
  max_fix_rounds : Int?
  max_should_fix : Int?
  depth : Depth?
  start : Int
}

///|
/// Where the pass of the loop that holds event `i` began.
fn pass_start_at(events : Array[DerivedRow], i : Int) -> Int {
  let mut j = min_int(i, events.length() - 1)
  while j >= 0 {
    let e = events[j]
    if e.event == EvS4ReviewCommentReceived || e.event == EvS2ReviewSkipped {
      return j
    }
    if (e.event == EvS2ReviewStarted || e.event == EvS2MapStarted) &&
      kind_is_blind(e.attrs) {
      let conflict = e.event == EvS2ReviewStarted &&
        is_text(e.attrs.diff_scope, "conflict")
      let mut first = j
      let mut k = j - 1
      while k >= 0 {
        let prev = events[k]
        if prev.event == EvS4ReviewCommentReceived ||
          prev.event == EvS2ReviewSkipped {
          break
        }
        if prev.event == EvS2ReviewConverged && !conflict {
          break
        }
        if (prev.event == EvS2ReviewStarted || prev.event == EvS2MapStarted) &&
          kind_is_blind(prev.attrs) {
          first = k
        }
        k = k - 1
      }
      return first
    }
    j = j - 1
  }
  -1
}

///|
/// The pass's policy: what its first blind recorded, or the loop's oldest reading.
fn pass_policy(events : Array[DerivedRow], i : Int) -> PassPolicy {
  let start = pass_start_at(events, i)
  if start < 0 ||
    events[start].event == EvS4ReviewCommentReceived ||
    events[start].event == EvS2ReviewSkipped {
    return {
      close_on_must: false,
      close_on_fix: false,
      max_fix_rounds: None,
      max_should_fix: None,
      depth: None,
      start,
    }
  }
  let mut j = start
  let last = min_int(i, events.length() - 1)
  while j <= last {
    let e = events[j]
    if e.event == EvS2ReviewStarted && kind_is_blind(e.attrs) {
      return {
        close_on_must: is_text(e.attrs.close_on, "must"),
        close_on_fix: is_text(e.attrs.close_on, "must_and_fix"),
        max_fix_rounds: whole_at_least_one(e.attrs.max_fix_rounds),
        max_should_fix: whole_at_least_one(e.attrs.max_should_fix),
        depth: depth_of(e.attrs.depth),
        start,
      }
    }
    j = j + 1
  }
  {
    close_on_must: false,
    close_on_fix: false,
    max_fix_rounds: None,
    max_should_fix: None,
    depth: None,
    start,
  }
}

///|
/// Whether the judgement at `i` lets the loop close with these counts of what it sent to the fix.
fn closes_at(events : Array[DerivedRow], i : Int, counts : (Int, Int)) -> Bool {
  let p = pass_policy(events, i)
  if p.close_on_fix {
    return counts.0 == 0 && counts.1 == 0
  }
  if p.close_on_must {
    return counts.0 == 0
  }
  within_limit(counts.0, counts.1)
}

///|
/// The stop penne is asked for when one judgement recommends more should fixes than the pass's cap.
fn over_cap_stop(attrs : RowAttrs, p : PassPolicy) -> String? {
  if !p.close_on_fix {
    return None
  }
  let over : Array[Json] = []
  for item in accepted_of(attrs) {
    if is_text(field(item, "severity"), "should") && fixes_now(item) {
      over.push(item)
    }
  }
  let max = match p.max_should_fix {
    Some(cap) => cap
    None => DEFAULT_MAX_SHOULD_FIX
  }
  if over.length() <= max {
    return None
  }
  let mut list = ""
  let mut first = true
  for item in over {
    if first {
      first = false
    } else {
      list = list + " / "
    }
    list = list +
      text_of(field(item, "ref")) +
      "（" +
      text_of(field(item, "severity")) +
      "）" +
      text_of(field(item, "claim"))
  }
  Some(
    "1 回の判定で fix を勧めた should が " +
    over.length().to_string() +
    " 件（この回の上限 " +
    max.to_string() +
    " 件）。境目を決めてください: " +
    list,
  )
}

///|
/// Where the pass began, when it began at feedback on the PR.
fn feedback_pass_at(events : Array[DerivedRow], i : Int) -> Int {
  let at = pass_start_at(events, i)
  if at >= 0 && events[at].event == EvS4ReviewCommentReceived {
    at
  } else {
    -1
  }
}

///|
/// Whether a blind of the review loop ever started.
fn blind_ever_ran(events : Array[DerivedRow]) -> Bool {
  let mut found = false
  for e in events {
    if e.event == EvS2ReviewStarted {
      found = true
    }
  }
  found
}

///|
/// A send-back for a conflict with the mainline.
priv struct ConflictSendBack {
  index : Int
  head : String?
}

///|
/// The send-backs for a conflict with the mainline, in the order they were recorded.
fn conflict_send_backs(events : Array[DerivedRow]) -> Array[ConflictSendBack] {
  let out : Array[ConflictSendBack] = []
  let mut latest_check = ""
  let mut submit_head : String? = None
  let mut i = 0
  while i < events.length() {
    let e = events[i]
    if e.event == EvS3CheckConflict {
      latest_check = "conflict"
    } else if e.event == EvS3CheckClean {
      latest_check = "clean"
    } else if e.event == EvS4SubmitStarted {
      submit_head = non_empty_text(e.attrs.head)
    } else if e.event == EvS4LandConflict {
      out.push({ index: i, head: non_empty_text(e.attrs.head), })
    } else if e.event == EvS4VerifyUserJudgmentAnswered &&
      is_text(e.attrs.outcome, "revise") &&
      !is_text(e.attrs.by, "harness") &&
      latest_check == "conflict" {
      out.push({ index: i, head: submit_head, })
    }
    i = i + 1
  }
  out
}

///|
/// Whether the next blind started now would be the pass's first.
fn first_blind_of_pass(events : Array[DerivedRow]) -> Bool {
  let mut i = events.length() - 1
  while i >= 0 {
    let e = events[i]
    if e.event == EvS4ReviewCommentReceived ||
      e.event == EvS2ReviewSkipped ||
      e.event == EvS2ReviewConverged {
      return true
    }
    if e.event == EvS2ReviewStarted && kind_is_blind(e.attrs) {
      return false
    }
    i = i - 1
  }
  true
}

///|
/// The index of the judgement of the PR's feedback the current pass began with, or -1.
fn feedback_triage_at(events : Array[DerivedRow]) -> Int {
  let fb = feedback_pass_at(events, events.length() - 1)
  if fb < 0 {
    return -1
  }
  let mut found = -1
  let mut i = fb + 1
  while i < events.length() {
    let e = events[i]
    if e.event == EvS2TriageDone &&
      is_text(e.attrs.kind, "feedback") &&
      !js_truthy(e.attrs.failed) {
      found = i
    }
    i = i + 1
  }
  found
}

///|
/// Whether the judgement at `i` belongs to an S4 pass.
fn s4_triage(events : Array[DerivedRow], i : Int) -> Bool {
  if i < 0 || i >= events.length() {
    return false
  }
  match event_kind(events[i].attrs) {
    TrieFeedback => true
    TrieConfirm => feedback_pass_at(events, i) >= 0
    TrieBlind => false
    TrieFinal => false
    TrieDevice => false
    TrieKept => false
    OtherTriageKind(_) => false
  }
}

///|
/// An event that hands the executor a fix to make.
fn begins_fix_round(e : DerivedRow) -> Bool {
  if e.event == EvS2FixSent || (e.event == EvS3Reject && !returns_to_plan(e)) {
    return true
  }
  e.event == EvS4VerifyUserJudgmentAnswered &&
  !is_text(e.attrs.outcome, "sub_todo")
}

///|
/// Which of the loop's fix-round caps it has reached.
priv enum FixCap {
  CapLane(Int, Int)
  CapPass(Int, Int, Int)
}

///|
/// The fix-round cap the loop has reached, or nothing while another fix may still go.
fn fix_cap_reached(events : Array[DerivedRow], for_forecast : Bool) -> FixCap? {
  let mut fixes = 0
  for e in events {
    if e.event == EvS2FixSent {
      fixes = fixes + 1
    }
  }
  if fixes >= MAX_FIX_ROUNDS {
    return Some(CapLane(fixes, MAX_FIX_ROUNDS))
  }
  let policy = pass_policy(events, events.length() - 1)
  let cap = match policy.max_fix_rounds {
    None => return None
    Some(cap) => cap
  }
  let mut in_pass = 0
  let mut i = 0
  while i < events.length() {
    if i > policy.start && events[i].event == EvS2FixSent {
      in_pass = in_pass + 1
    }
    i = i + 1
  }
  if in_pass < cap {
    return None
  }
  if for_forecast {
    let mut last_start = -1
    let mut j = events.length() - 1
    while j >= 0 {
      if begins_fix_round(events[j]) {
        last_start = j
        break
      }
      j = j - 1
    }
    if last_start < 0 || events[last_start].event != EvS2FixSent {
      return None
    }
  }
  Some(CapPass(in_pass, cap, policy.start))
}

///|
/// A judgement's key in the stagnation reading: its file and its words.
fn finding_key(item : Json) -> String {
  let path = match field(item, "path") {
    Json::Null => ""
    other => js_string(other)
  }
  path + "|" + js_string(field(item, "claim"))
}

///|
/// Stagnation: the same accepted claim comes back after two fixes, or the accepted must / should count did not
/// go down between the triages of the current pass's fix loop.
fn stagnation(events : Array[DerivedRow]) -> String? {
  let triages : Array[Int] = []
  let mut i = 0
  while i < events.length() {
    let e = events[i]
    if e.event == EvS2TriageDone && !js_truthy(e.attrs.failed) {
      triages.push(i)
    }
    i = i + 1
  }
  let fixed = fn(i : Int) -> Array[Json] {
    let all = s4_triage(events, i)
    let out : Array[Json] = []
    for item in accepted_at(events, i) {
      let takes = if all { fixes_now(item) } else { in_fix_scope(item) }
      if takes {
        out.push(item)
      }
    }
    out
  }
  let seen : Map[String, Int] = Map([])
  for t in triages {
    for item in fixed(t) {
      let key = finding_key(item)
      let n = match seen.get(key) {
        Some(n) => n + 1
        None => 1
      }
      seen.set(key, n)
      if n >= 3 {
        return Some(
          "同じ指摘が修正後も戻ってくる: " +
          js_string(field(item, "claim")),
        )
      }
    }
  }
  let start = pass_start_at(events, events.length() - 1)
  let send_backs : Array[Int] = conflict_send_backs(events)
    .map(fn(b) { b.index })
    .filter(fn(at) { at > start })
  let base = if send_backs.length() > 0 {
    send_backs[send_backs.length() - 1]
  } else {
    start
  }
  let in_pass = triages.filter(fn(t) { t > base })
  if in_pass.length() >= 3 {
    let recent = [
      in_pass[in_pass.length() - 3],
      in_pass[in_pass.length() - 2],
      in_pass[in_pass.length() - 1],
    ]
    let no_should = pass_policy(events, events.length() - 1).close_on_fix
    let a = if s4_triage(events, recent[0]) {
      fixed(recent[0]).length()
    } else {
      blocking(accepted_at(events, recent[0]).filter(fixes_now))
    }
    let b = if s4_triage(events, recent[1]) {
      fixed(recent[1]).length()
    } else {
      blocking(accepted_at(events, recent[1]).filter(fixes_now))
    }
    let c = if s4_triage(events, recent[2]) {
      fixed(recent[2]).length()
    } else {
      blocking(accepted_at(events, recent[2]).filter(fixes_now))
    }
    let floor = if s4_triage(events, recent[2]) || no_should {
      0
    } else {
      ACCEPTED_LIMIT
    }
    if c >= b && b >= a && c > floor {
      let label = if s4_triage(events, recent[2]) {
        "受理済みの指摘"
      } else {
        "受理済みの must / should "
      }
      return Some(
        label +
        "が減らない（" +
        a.to_string() +
        " → " +
        b.to_string() +
        " → " +
        c.to_string() +
        "）",
      )
    }
  }
  match fix_cap_reached(events, false) {
    Some(CapLane(fixes, _)) =>
      Some("修正が " + fixes.to_string() + " 巡に達した（上限）")
    Some(CapPass(fixes, cap, cap_start)) => {
      let last = if triages.length() > 0 {
        Some(triages[triages.length() - 1])
      } else {
        None
      }
      let open : Array[Json] = []
      match last {
        Some(last) =>
          if last > cap_start {
            for item in fixed(last) {
              if !is_text(field(item, "severity"), "nit") ||
                js_truthy(field(item, "corrected")) {
                open.push(item)
              }
            }
          }
        None => ()
      }
      let mut list = ""
      let mut first = true
      for item in open {
        if first {
          first = false
        } else {
          list = list + " / "
        }
        list = list +
          text_of(field(item, "ref")) +
          "（" +
          text_of(field(item, "severity")) +
          "）" +
          text_of(field(item, "claim"))
      }
      let started : DerivedRow? = match last {
        None => None
        Some(last) => {
          let mut found : DerivedRow? = None
          let mut j = last - 1
          while j >= 0 {
            if events[j].event == EvS2ReviewStarted {
              found = Some(events[j])
              break
            }
            j = j - 1
          }
          found
        }
      }
      let high_final = match (last, started) {
        (Some(last), Some(started)) =>
          is_text(events[last].attrs.kind, "final") &&
          (match started.attrs.extras {
            Json::Array(items) => {
              let mut found = false
              for item in items {
                if is_text(item, "high_risk") {
                  found = true
                }
              }
              found
            }
            _ => false
          })
        _ => false
      }
      let tail = if high_final {
        "。High の最後のレビューの指摘が残っています"
      } else {
        ""
      }
      Some(
        "修正が " +
        fixes.to_string() +
        " 巡に達した（この回の上限 " +
        cap.to_string() +
        " 巡）" +
        tail +
        "。境目を決めてください" +
        (if list == "" { "" } else { ": " + list }),
      )
    }
    None => None
  }
}

///|
/// A result the executor sent back without working.
fn is_returned_result(e : DerivedRow) -> Bool {
  if e.event != EvS2Result {
    return false
  }
  is_text(e.attrs.outcome, "failed") &&
  (match e.attrs.changed_files {
    Json::Array(items) => items.length() == 0
    _ => false
  })
}

///|
/// The name a stored state answers with.
fn raw_state_name(value : Json) -> String {
  state_name_text(raw_state(value))
}

///|
/// One state of the review loop.
priv enum LoopState {
  LIdle
  LStartBlind(ReviewKind, Double, Json?, Bool)
  LRunningMap(ReviewKind, Double, String, String?)
  LRunningBlind(Json, Double, Array[String])
  LStartTriage(Json, Double, Array[String])
  LRunningTriage(Json, Double, String)
  LSendFix(Double)
  LFixing(Double)
  LStartConfirm(Double)
  LRunningConfirm(Double, String)
  LStartDevice(Double)
  LRunningDevice(Double, String)
  LConverge
  /// the repo's required checks run at the head before the loop converges: the run's id and the head
  LRunningChecks(String, String)
  LAwaitingHandFix(Double)
  LAwaitingRecordsFix(Double)
  LRecheckIntent(Double)
  LAwaitingMerge(Double)
  LAwaitingOrder(Double, Array[OrderOpponent])
  LEscalated(String, Json?, Json?)
  LDone
  LStored(Json)
}

///|
/// The name a stored state carries: the 21 the loop answers with, and any other as it came (a row written by an
/// older writer, or by hand). A stored retry state is handed back as it came, so its name is read closed here.
pub(all) enum StateName {
  SIdle
  SStartBlind
  SRunningMap
  SRunningBlind
  SStartTriage
  SRunningTriage
  SSendFix
  SFixing
  SStartConfirm
  SRunningConfirm
  SStartDevice
  SRunningDevice
  SConverge
  SRunningChecks
  SAwaitingHandFix
  SAwaitingRecordsFix
  SRecheckIntent
  SAwaitingMerge
  SAwaitingOrder
  SEscalated
  SDone
  SUnknown(String)
} derive(Eq)

///|
/// The name's own text.
fn state_name_text(name : StateName) -> String {
  match name {
    SIdle => "idle"
    SStartBlind => "start_blind"
    SRunningMap => "running_map"
    SRunningBlind => "running_blind"
    SStartTriage => "start_triage"
    SRunningTriage => "running_triage"
    SSendFix => "send_fix"
    SFixing => "fixing"
    SStartConfirm => "start_confirm"
    SRunningConfirm => "running_confirm"
    SStartDevice => "start_device"
    SRunningDevice => "running_device"
    SConverge => "converge"
    SRunningChecks => "running_checks"
    SAwaitingHandFix => "awaiting_hand_fix"
    SAwaitingRecordsFix => "awaiting_records_fix"
    SRecheckIntent => "recheck_intent"
    SAwaitingMerge => "awaiting_merge"
    SAwaitingOrder => "awaiting_order"
    SEscalated => "escalated"
    SDone => "done"
    SUnknown(text) => text
  }
}

///|
/// The name a text stands for.
fn state_name_of_text(text : String) -> StateName {
  match text {
    "idle" => SIdle
    "start_blind" => SStartBlind
    "running_map" => SRunningMap
    "running_blind" => SRunningBlind
    "start_triage" => SStartTriage
    "running_triage" => SRunningTriage
    "send_fix" => SSendFix
    "fixing" => SFixing
    "start_confirm" => SStartConfirm
    "running_confirm" => SRunningConfirm
    "start_device" => SStartDevice
    "running_device" => SRunningDevice
    "converge" => SConverge
    "running_checks" => SRunningChecks
    "awaiting_hand_fix" => SAwaitingHandFix
    "awaiting_records_fix" => SAwaitingRecordsFix
    "recheck_intent" => SRecheckIntent
    "awaiting_merge" => SAwaitingMerge
    "awaiting_order" => SAwaitingOrder
    "escalated" => SEscalated
    "done" => SDone
    other => SUnknown(other)
  }
}

///|
/// The name a stored state JSON carries.
fn raw_state(value : Json) -> StateName {
  state_name_of_text(text_of(field(value, "state")))
}

///|
/// The kind a text names.
fn review_kind_of(text : String) -> ReviewKind {
  match text {
    "blind" => Blind
    "final" => Final
    "device" => Device
    "kept" => Kept
    other => OtherReviewKind(other)
  }
}

///|
/// The state a stored state carries, read back as the loop's own state. A stored state is the state the loop was
/// in when it stopped, so it answers with the step that state answers with. A name nobody knows is kept as it
/// came and answers with nothing.
fn stored_loop_state(value : Json) -> LoopState? {
  match raw_state(value) {
    SIdle => Some(LIdle)
    SStartBlind =>
      Some(
        LStartBlind(
          review_kind_of(text_of(field(value, "kind"))),
          js_num(field(value, "round")),
          match field(value, "map") {
            Json::Object(_) => Some(field(value, "map"))
            _ => None
          },
          js_truthy(field(value, "allowHighFallback")),
        ),
      )
    SRunningMap =>
      Some(
        LRunningMap(
          review_kind_of(text_of(field(value, "kind"))),
          js_num(field(value, "round")),
          text_or(field(value, "runId"), ""),
          non_empty_text(field(value, "head")),
        ),
      )
    SRunningBlind =>
      Some(
        LRunningBlind(
          field(value, "kind"),
          js_num(field(value, "round")),
          strings_of(field(value, "runIds")),
        ),
      )
    SStartTriage =>
      Some(
        LStartTriage(
          field(value, "kind"),
          js_num(field(value, "round")),
          strings_of(field(value, "inputs")),
        ),
      )
    SRunningTriage =>
      Some(
        LRunningTriage(
          field(value, "kind"),
          js_num(field(value, "round")),
          text_or(field(value, "runId"), ""),
        ),
      )
    SSendFix => Some(LSendFix(js_num(field(value, "round"))))
    SFixing => Some(LFixing(js_num(field(value, "round"))))
    SStartConfirm => Some(LStartConfirm(js_num(field(value, "round"))))
    SRunningConfirm =>
      Some(
        LRunningConfirm(
          js_num(field(value, "round")),
          text_or(field(value, "runId"), ""),
        ),
      )
    SStartDevice => Some(LStartDevice(js_num(field(value, "round"))))
    SRunningDevice =>
      Some(
        LRunningDevice(
          js_num(field(value, "round")),
          text_or(field(value, "runId"), ""),
        ),
      )
    SConverge => Some(LConverge)
    SRunningChecks =>
      Some(
        LRunningChecks(
          text_or(field(value, "runId"), ""),
          text_or(field(value, "head"), ""),
        ),
      )
    SAwaitingHandFix => Some(LAwaitingHandFix(js_num(field(value, "round"))))
    SAwaitingRecordsFix =>
      Some(LAwaitingRecordsFix(js_num(field(value, "round"))))
    SRecheckIntent => Some(LRecheckIntent(js_num(field(value, "round"))))
    SAwaitingMerge => Some(LAwaitingMerge(js_num(field(value, "round"))))
    SAwaitingOrder =>
      Some(
        LAwaitingOrder(
          js_num(field(value, "round")),
          order_opponents_json(field(value, "opponents")),
        ),
      )
    SEscalated =>
      Some(
        LEscalated(
          text_of(field(value, "reason")),
          match field(value, "retry") {
            Json::Object(_) => Some(field(value, "retry"))
            _ => None
          },
          match field(value, "quotaWait") {
            Json::Object(_) => Some(field(value, "quotaWait"))
            _ => None
          },
        ),
      )
    SDone => Some(LDone)
    SUnknown(_) => None
  }
}

///|
/// The name a state answers with.
fn loop_state_name(state : LoopState) -> String {
  match state {
    LIdle => "idle"
    LStartBlind(_, _, _, _) => "start_blind"
    LRunningMap(_, _, _, _) => "running_map"
    LRunningBlind(_, _, _) => "running_blind"
    LStartTriage(_, _, _) => "start_triage"
    LRunningTriage(_, _, _) => "running_triage"
    LSendFix(_) => "send_fix"
    LFixing(_) => "fixing"
    LStartConfirm(_) => "start_confirm"
    LRunningConfirm(_, _) => "running_confirm"
    LStartDevice(_) => "start_device"
    LRunningDevice(_, _) => "running_device"
    LConverge => "converge"
    LRunningChecks(_, _) => "running_checks"
    LAwaitingHandFix(_) => "awaiting_hand_fix"
    LAwaitingRecordsFix(_) => "awaiting_records_fix"
    LRecheckIntent(_) => "recheck_intent"
    LAwaitingMerge(_) => "awaiting_merge"
    LAwaitingOrder(_, _) => "awaiting_order"
    LEscalated(_, _, _) => "escalated"
    LDone => "done"
    LStored(json) => raw_state_name(json)
  }
}

///|
/// One state as the answer carries it.
fn loop_state_json(state : LoopState) -> Json {
  match state {
    LIdle => json_object([("state", Json::string("idle"))])
    LStartBlind(kind, round, map, allow_high_fallback) => {
      let fields : Array[(String, Json)] = [
        ("state", Json::string("start_blind")),
        ("kind", Json::string(review_kind_text(kind))),
        ("round", Json::number(round)),
      ]
      match map {
        Some(map) => fields.push(("map", map))
        None => ()
      }
      if allow_high_fallback {
        fields.push(("allowHighFallback", Json::boolean(true)))
      }
      json_object(fields)
    }
    LRunningMap(kind, round, run_id, head) => {
      let fields : Array[(String, Json)] = [
        ("state", Json::string("running_map")),
        ("kind", Json::string(review_kind_text(kind))),
        ("round", Json::number(round)),
        ("runId", Json::string(run_id)),
      ]
      match head {
        Some(head) => fields.push(("head", Json::string(head)))
        None => ()
      }
      json_object(fields)
    }
    LRunningBlind(kind, round, run_ids) =>
      json_object([
        ("state", Json::string("running_blind")),
        ("kind", kind),
        ("round", Json::number(round)),
        ("runIds", Json::array(run_ids.map(Json::string))),
      ])
    LStartTriage(kind, round, inputs) =>
      json_object([
        ("state", Json::string("start_triage")),
        ("kind", kind),
        ("round", Json::number(round)),
        ("inputs", Json::array(inputs.map(Json::string))),
      ])
    LRunningTriage(kind, round, run_id) =>
      json_object([
        ("state", Json::string("running_triage")),
        ("kind", kind),
        ("round", Json::number(round)),
        ("runId", Json::string(run_id)),
      ])
    LSendFix(round) =>
      json_object([
        ("state", Json::string("send_fix")),
        ("round", Json::number(round)),
      ])
    LFixing(round) =>
      json_object([
        ("state", Json::string("fixing")),
        ("round", Json::number(round)),
      ])
    LStartConfirm(round) =>
      json_object([
        ("state", Json::string("start_confirm")),
        ("round", Json::number(round)),
      ])
    LRunningConfirm(round, run_id) =>
      json_object([
        ("state", Json::string("running_confirm")),
        ("round", Json::number(round)),
        ("runId", Json::string(run_id)),
      ])
    LStartDevice(round) =>
      json_object([
        ("state", Json::string("start_device")),
        ("round", Json::number(round)),
      ])
    LRunningDevice(round, run_id) =>
      json_object([
        ("state", Json::string("running_device")),
        ("round", Json::number(round)),
        ("runId", Json::string(run_id)),
      ])
    LConverge => json_object([("state", Json::string("converge"))])
    LRunningChecks(run_id, head) =>
      json_object([
        ("state", Json::string("running_checks")),
        ("runId", Json::string(run_id)),
        ("head", Json::string(head)),
      ])
    LAwaitingHandFix(round) =>
      json_object([
        ("state", Json::string("awaiting_hand_fix")),
        ("round", Json::number(round)),
      ])
    LAwaitingRecordsFix(round) =>
      json_object([
        ("state", Json::string("awaiting_records_fix")),
        ("round", Json::number(round)),
      ])
    LRecheckIntent(round) =>
      json_object([
        ("state", Json::string("recheck_intent")),
        ("round", Json::number(round)),
      ])
    LAwaitingMerge(round) =>
      json_object([
        ("state", Json::string("awaiting_merge")),
        ("round", Json::number(round)),
      ])
    LAwaitingOrder(round, opponents) =>
      json_object([
        ("state", Json::string("awaiting_order")),
        ("round", Json::number(round)),
        ("opponents", Json::array(opponents.map(opponent_json))),
      ])
    LEscalated(reason, retry, quota_wait) => {
      let fields : Array[(String, Json)] = [
        ("state", Json::string("escalated")),
        ("reason", Json::string(reason)),
      ]
      match retry {
        Some(retry) => fields.push(("retry", retry))
        None => ()
      }
      match quota_wait {
        Some(wait) => fields.push(("quotaWait", wait))
        None => ()
      }
      json_object(fields)
    }
    LDone => json_object([("state", Json::string("done"))])
    LStored(json) => json
  }
}

///|
/// Where a depth-bearing round goes after its judgement, by the depth's table.
fn new_order_triage(
  events : Array[DerivedRow],
  i : Int,
  depth : Depth,
  round : Double,
) -> LoopState {
  let accepted = accepted_at(events, i)
  let mut any_fix = false
  for item in accepted {
    if fixes_now(item) {
      any_fix = true
    }
  }
  if !any_fix {
    let row = depth_row(depth)
    // a kept judgement is read for the lanes that ran the kept check before it was removed (R2, 2026-10-22):
    // no depth runs it any more, so the round after the final review converges
    match event_kind(events[i].attrs) {
      TrieDevice => return LDone
      TrieKept => return LConverge
      TrieFinal => return LConverge
      TrieBlind | TrieConfirm | TrieFeedback | OtherTriageKind(_) =>
        if row.final_review {
          return LStartBlind(Final, round, None, false)
        } else {
          return LConverge
        }
    }
  }
  match stagnation(events) {
    Some(stuck) => LEscalated(stuck, None, None)
    None => LSendFix(round)
  }
}

///|
/// Where the loop goes on after a stop that only the last judgement's questions caused.
fn after_question(events : Array[DerivedRow], round : Double) -> LoopState? {
  let mut t = events.length() - 1
  while t >= 0 {
    let name = events[t].event
    if name == EvS2TriageDone {
      break
    }
    if name != EvS2ReviewEscalated && is_review_event(name) {
      return None
    }
    t = t - 1
  }
  if t < 0 {
    return None
  }
  let a = events[t].attrs
  if js_truthy(a.failed) ||
    oscillations_of(a).length() > 0 ||
    js_strings(a.escalated_claims).length() == 0 {
    return None
  }
  if s4_triage(events, t) {
    let mut any = false
    for item in accepted_of(a) {
      if fixes_now(item) {
        any = true
      }
    }
    if any {
      return None
    }
    return if event_kind(a) is TrieFeedback {
      Some(LDone)
    } else {
      Some(LStartBlind(Final, round, None, false))
    }
  }
  let c = fix_counts(accepted_of(a))
  if !closes_at(events, t, c) {
    return None
  }
  match event_kind(a) {
    TrieFinal => Some(LConverge)
    TrieDevice => Some(LDone)
    TrieBlind => Some(LStartBlind(Final, round, None, false))
    TrieKept => Some(LStartBlind(Final, round, None, false))
    TrieConfirm => Some(LStartBlind(Final, round, None, false))
    TrieFeedback => Some(LStartBlind(Final, round, None, false))
    OtherTriageKind(_) => Some(LStartBlind(Final, round, None, false))
  }
}

///|
/// The state the loop was in just before the last `started` event of a stage.
fn before(events : Array[DerivedRow], started : DerivedEvent) -> LoopState? {
  let mut i = events.length() - 1
  while i >= 0 {
    if events[i].event == started {
      return Some(review_loop_state(prefix_rows(events, i)))
    }
    i = i - 1
  }
  None
}

///|
/// Whether the newest records send-back is still waiting on the executor. The wait and the instruction that went with
/// it are two records, so a send-back whose instruction could not be written leaves the wait alone on the record. A
/// skipped round that stands after it did not read anything, but the errors are not answered yet, so it cannot close
/// the review; the next tick writes the instruction again (DEC-2402) and the executor's answer rechecks.
fn records_send_back_open(events : Array[DerivedRow]) -> Bool {
  let mut i = events.length() - 1
  while i >= 0 {
    let e = events[i]
    if e.event == EvS2RecordsConflict {
      return true
    }
    if e.event == EvS2RecordsInstructed {
      return false
    }
    i = i - 1
  }
  false
}

///|
/// The checks' names the checks' record sends to the fix, in its order.
fn check_names_of(a : RowAttrs) -> Array[String] {
  let out : Array[String] = []
  for f in array_of(a.findings) {
    let reference = text_of(field(f, "ref"))
    let name = if reference.has_prefix("checks/") {
      reference.unsafe_substring(start=7, end=reference.length())
    } else {
      reference
    }
    if name != "" {
      out.push(name)
    }
  }
  out
}

///|
/// The checks that could not be compared, as the stop names them: each with what the run said of it.
fn uncompared_of(a : RowAttrs) -> Array[String] {
  let out : Array[String] = []
  for r in array_of(a.checks) {
    let status = field(r, "status")
    if is_text(status, "pass") || is_text(status, "not-applicable") {
      continue
    }
    if is_text(status, "fail") && is_text(field(r, "verdict"), "preexisting") {
      continue
    }
    let name = js_string_opt(field(r, "name"), "")
    let phrase = match field(r, "phrase") {
      Json::String(text) => text
      _ => ""
    }
    out.push(if phrase != "" { name + "（" + phrase + "）" } else { name })
  }
  out
}

///|
/// What the checks' record says of the tree they failed on, as a sentence of a stop: the first failed row's note
/// (the run checked the head merged with the public base's tip), or nothing.
fn tree_note_of(a : RowAttrs) -> String {
  for r in array_of(a.checks) {
    if !is_text(field(r, "status"), "fail") {
      continue
    }
    match field(r, "tree_note") {
      Json::String(note) => if note != "" { return note + "。" }
      _ => ()
    }
  }
  ""
}

///|
/// The names joined as one list of the sentence.
fn joined(names : Array[String], sep : String) -> String {
  let mut out = ""
  let mut first = true
  for name in names {
    if first {
      first = false
    } else {
      out = out + sep
    }
    out = out + name
  }
  out
}

///|
/// Where the checks before the convergence leave the loop: a run that did not finish stops for penne and runs again
/// on a continue; a failure the lane made goes to the fix, unless the fix rounds are spent (then penne decides); a
/// failure that could not be compared stops for penne; nothing the lane made converges.
fn checks_done_state(
  events : Array[DerivedRow],
  last : Int,
  a : RowAttrs,
  round : Double,
) -> LoopState {
  if js_truthy(a.failed) {
    return LEscalated(
      "収束の前の必須の検査を回せなかった: " +
      js_string_opt(a.error, ""),
      Some(loop_state_json(checks_return_state(events, last))),
      None,
    )
  }
  if is_text(a.outcome, "pass") {
    return checks_return_state(events, last)
  }
  if is_text(a.outcome, "new") {
    return match fix_cap_reached(prefix_rows(events, last + 1), false) {
      None => LSendFix(round)
      Some(cap) => {
        let (fixes, limit) = match cap {
          CapLane(fixes, _) => (fixes, "（上限）")
          CapPass(fixes, cap, _) =>
            (fixes, "（この回の上限 " + cap.to_string() + " 巡）")
        }
        LEscalated(
          "収束の前の必須の検査が lane の変更で落ちた（" +
          joined(check_names_of(a), "、") +
          "）。" +
          tree_note_of(a) +
          "修正が " +
          fixes.to_string() +
          " 巡に達した" +
          limit +
          "。続けると検査の失敗を手直しに送り、受け入れると収束する",
          None,
          None,
        )
      }
    }
  }
  LEscalated(
    "収束の前の必須の検査を比べる base（公開 base の先端。取れなかったときは lane の分岐元）と比べられなかった: " +
    joined(uncompared_of(a), "、") +
    "。" +
    tree_note_of(a) +
    "続けると検査を回し直し、受け入れると収束する",
    None,
    None,
  )
}

///|
/// Where the loop goes once the checks whose record is at `d` have spoken for the head: the state the checks held
/// back when their start carried one (a round the mainline's merge alone skipped), the convergence otherwise.
fn checks_return_state(events : Array[DerivedRow], d : Int) -> LoopState {
  let mut i = d - 1
  while i >= 0 {
    if events[i].event == EvS2ChecksStarted {
      let back = events[i].attrs.resume_state
      return if back is Json::Object(_) && has_key(back, "state") {
        LStored(back)
      } else {
        LConverge
      }
    }
    i = i - 1
  }
  LConverge
}

///|
/// The checks' record a stop penne's answer at `last` answered was over: walking back over the stops (and over a fix
/// of the checks' failures that left the head where it was, which stops right after it), the record the loop stopped
/// at. -1 when the stop was over anything else.
fn checks_stop_at(events : Array[DerivedRow], last : Int) -> Int {
  let mut stopped = false
  let mut i = last - 1
  while i >= 0 {
    let e = events[i]
    if is_review_event(e.event) {
      if e.event == EvS2ReviewEscalated {
        stopped = true
      } else if e.event == EvS2ReviewResumed {
        ()
      } else if e.event == EvS2FixSent &&
        is_text(e.attrs.source, "checks") &&
        stopped {
        ()
      } else {
        // the stop may be derived and not yet on record (an answer can come before the stop is written)
        return if e.event == EvS2ChecksDone { i } else { -1 }
      }
    }
    i = i - 1
  }
  -1
}

///|
/// The checks' record whose failures a fix sent now carries: the loop's last word is that record, or a stop over it
/// and penne's answers (a fix of those failures that left the head where it was included). -1 for a fix of anything
/// else.
fn checks_fix_at(events : Array[DerivedRow]) -> Int {
  let mut stopped = false
  let mut i = events.length() - 1
  while i >= 0 {
    let e = events[i]
    if is_review_event(e.event) {
      if e.event == EvS2ReviewEscalated {
        stopped = true
      } else if e.event == EvS2ReviewResumed {
        ()
      } else if e.event == EvS2FixSent &&
        is_text(e.attrs.source, "checks") &&
        stopped {
        ()
      } else {
        return if e.event == EvS2ChecksDone &&
          is_text(e.attrs.outcome, "new") &&
          !js_truthy(e.attrs.failed) {
          i
        } else {
          -1
        }
      }
    }
    i = i - 1
  }
  -1
}

///|
/// Whether the checks before the convergence have spoken for `head`: the last finished run of that head found nothing
/// the lane made, or penne accepted after it. A run of another head, or none, has not.
fn checks_settled(events : Array[DerivedRow], head : String) -> Bool {
  let mut d = -1
  let mut i = events.length() - 1
  while i >= 0 {
    let e = events[i]
    if e.event == EvS2ChecksDone && is_text(e.attrs.head, head) {
      d = i
      break
    }
    i = i - 1
  }
  if d < 0 {
    return false
  }
  if is_text(events[d].attrs.outcome, "pass") &&
    !js_truthy(events[d].attrs.failed) {
    return true
  }
  // a run that could not run, or found what penne then accepted: the accept answers for the head
  let mut k = d + 1
  while k < events.length() {
    if events[k].event == EvS2ReviewResumed &&
      is_text(events[k].attrs.decision, "accept") {
      return true
    }
    k = k + 1
  }
  false
}

///|
/// What the convergence writes: after checks that passed, what the convergence they held back would have written
/// (carried on their start) and the head they spoke for; otherwise what the caller gives (a final skipped), or the
/// reason of a continue with nothing left to fix.
fn converge_attrs_of(events : Array[DerivedRow], given : Json?) -> Json {
  let mut last = events.length() - 1
  while last >= 0 && !is_review_event(events[last].event) {
    last = last - 1
  }
  if last >= 0 &&
    events[last].event == EvS2ChecksDone &&
    is_text(events[last].attrs.outcome, "pass") &&
    !js_truthy(events[last].attrs.failed) {
    let fields = carried_converge(events, last)
    fields.push(
      ("checks_head", Json::string(js_string_opt(events[last].attrs.head, ""))),
    )
    return json_object(fields)
  }
  // an accept on a stop over the checks: the convergence they held back is written as it would have been
  if last >= 0 &&
    events[last].event == EvS2ReviewResumed &&
    is_text(events[last].attrs.decision, "accept") {
    let over = checks_stop_at(events, last)
    if over >= 0 {
      let fields = carried_converge(events, over)
      fields.push(
        (
          "checks_accepted",
          Json::string(js_string_opt(events[over].attrs.head, "")),
        ),
      )
      return json_object(fields)
    }
  }
  match given {
    Some(attrs) => attrs
    None =>
      match zero_fix_marks(events) {
        Some(marks) => marks
        None => json_object([])
      }
  }
}

///|
/// What the start of the checks whose record is at `d` carried of the convergence they held back.
fn carried_converge(
  events : Array[DerivedRow],
  d : Int,
) -> Array[(String, Json)] {
  let mut s = d - 1
  while s >= 0 && events[s].event != EvS2ChecksStarted {
    s = s - 1
  }
  let fields : Array[(String, Json)] = []
  if s >= 0 {
    match events[s].attrs.converge {
      Json::Object(map) =>
        for key, value in map {
          fields.push((key, value))
        }
      _ => ()
    }
  }
  fields
}

///|
/// The review loop's state, read from the lifecycle alone.
fn review_loop_state(events : Array[DerivedRow]) -> LoopState {
  let names = events
  let mut last_result = -1
  let mut last_ready = -1
  let mut last_comment = -1
  let mut last = -1
  let mut fix_sends = 0
  let mut i = 0
  while i < names.length() {
    let e = names[i]
    if e.event == EvS2Result {
      last_result = i
    }
    if e.event == EvS3Ready {
      last_ready = i
    }
    if e.event == EvS4ReviewCommentReceived {
      last_comment = i
    }
    if is_review_event(e.event) {
      last = i
    }
    if e.event == EvS2FixSent {
      fix_sends = fix_sends + 1
    }
    i = i + 1
  }
  if last_result < 0 {
    return LIdle
  }
  if last_ready > last_result && last_comment < last_ready {
    return LDone
  }
  let round = (fix_sends + conflict_send_backs(events).length() + 1).to_double()
  if last < 0 {
    if is_returned_result(events[last_result]) {
      return LIdle
    }
    return LStartBlind(Blind, 1.0, None, false)
  }
  let ev = events[last]
  let a = ev.attrs
  if last_result > last && ev.event != EvS2ReviewSkipped {
    if ev.event == EvS2FixSent {
      if pass_policy(events, last).depth is Some(_) {
        return LStartBlind(Blind, round, None, false)
      }
      // a fix of the checks' failures sent no finding a confirm could check: the whole diff is reviewed again
      if is_text(a.source, "checks") {
        return LStartBlind(Blind, round, None, false)
      }
      return LStartConfirm(round - 1.0)
    }
    if ev.event == EvS2ReviewBaseConflict {
      return LStartBlind(Blind, round, None, false)
    }
    if ev.event == EvS2RecordsConflict || ev.event == EvS2RecordsInstructed {
      return LRecheckIntent(round)
    }
    let ended = ev.event == EvS2ReviewConverged ||
      ev.event == EvS2DeviceDone ||
      ev.event == EvS2DeviceSkipped
    let at_done = loop_state_name(
        review_loop_state(prefix_rows(events, last + 1)),
      ) ==
      "done"
    if ended || at_done {
      let mut sent_back = false
      let mut k = last + 1
      while k < last_result {
        let e = names[k]
        if e.event == EvS4VerifyUserJudgmentAnswered ||
          (e.event == EvS3Reject && !returns_to_plan(e)) {
          sent_back = true
        }
        k = k + 1
      }
      if sent_back {
        return LStartBlind(Blind, round, None, false)
      }
    }
  }
  match ev.event {
    EvS2ReviewStarted =>
      LRunningBlind(
        kind_json_or(a, "blind"),
        js_num(a.round),
        js_strings(a.run_ids),
      )
    EvS2ReviewBaseConflict =>
      if a.awaiting is Json::True {
        LAwaitingMerge(round)
      } else {
        LStartBlind(Blind, round, None, false)
      }
    EvS2ExecutorWaitEnded => LIdle
    EvS2ExecutorWaiting => LIdle
    EvS2ReviewBaseMerged => LIdle
    EvS2ReviewBaseSkipped => LIdle
    EvS2OrderWaiting => LAwaitingOrder(round, order_opponents_of(a))
    EvS2OrderPassed => LStartBlind(Blind, round, None, false)
    EvS2OrderReleased => LStartBlind(Blind, round, None, false)
    EvS2OrderLimit => LStartBlind(Blind, round, None, false)
    EvS2OrderUnknown => LStartBlind(Blind, round, None, false)
    EvS2MapStarted => {
      let kind = if is_text(a.kind, "final") { Final } else { Blind }
      LRunningMap(
        kind,
        js_num(a.round),
        text_or(a.run_id, ""),
        non_empty_text(a.head),
      )
    }
    EvS2MapDone => {
      let kind = if is_text(a.kind, "final") { Final } else { Blind }
      let map_fields : Array[(String, Json)] = [
        ("routes", Json::array(routes_of(a.routes).map(route_json))),
      ]
      match non_empty_text(a.head) {
        Some(head) => map_fields.push(("head", Json::string(head)))
        None => ()
      }
      LStartBlind(kind, js_num(a.round), Some(json_object(map_fields)), false)
    }
    EvS2MapHeadMoved => {
      let kind = if is_text(a.kind, "final") { Final } else { Blind }
      LStartBlind(kind, js_num(a.round), None, false)
    }
    EvS2MapDropped => {
      let kind = if is_text(a.kind, "final") { Final } else { Blind }
      LStartBlind(
        kind,
        js_num(a.round),
        Some(json_object([("routes", Json::array([]))])),
        false,
      )
    }
    EvS2ReviewFindings =>
      LStartTriage(
        kind_json_or(a, "blind"),
        js_num(a.round),
        js_strings(a.files),
      )
    EvS4ReviewCommentReceived =>
      LStartTriage(Json::string("feedback"), round, js_strings(a.files))
    EvS2TriageStarted =>
      LRunningTriage(
        kind_json_or(a, "blind"),
        js_num(a.round),
        text_or(a.run_id, ""),
      )
    EvS2TriageDone => triage_done_state(events, last, a, round)
    EvS2FixSent => LFixing(round - 1.0)
    EvS2ConfirmStarted =>
      LRunningConfirm(js_num(a.round), text_or(a.run_id, ""))
    EvS2ConfirmDone => confirm_done_state(events, last, a, round)
    EvS2ReviewEscalated => {
      let retry_json = a.retry_state
      let retry = match retry_json {
        Json::Object(_) =>
          if has_key(retry_json, "state") {
            Some(retry_json)
          } else {
            None
          }
        _ => None
      }
      let q = a.quota_wait
      let quota = match q {
        Json::Object(_) => {
          let reason = field(q, "reason")
          match reason {
            Json::String(text) => {
              let fields : Array[(String, Json)] = []
              match field(q, "role") {
                Json::String(role) => fields.push(("role", Json::string(role)))
                _ => ()
              }
              match field(q, "resets_at") {
                Json::Number(number, ..) =>
                  fields.push(("resetsAt", Json::number(number)))
                _ => ()
              }
              fields.push(("reason", Json::string(text)))
              Some(json_object(fields))
            }
            _ => None
          }
        }
        _ => None
      }
      LEscalated(js_string_opt(a.reason, ""), retry, quota)
    }
    EvS2ReviewResumed => resumed_state(events, last, a, round)
    EvS2IntentChecked => LDone
    EvS2RecordsConflict => LAwaitingRecordsFix(round)
    EvS2RecordsInstructed => LAwaitingRecordsFix(round)
    EvS2RecordsReopened => LStartBlind(Blind, round, None, false)
    EvS2ReviewConverged => LStartDevice(round)
    EvS2ReviewSkipped => LStartDevice(round)
    EvS2ChecksStarted =>
      LRunningChecks(text_or(a.run_id, ""), text_or(a.head, ""))
    EvS2ChecksDone => checks_done_state(events, last, a, round)
    EvS2ReviewMergedSkipped =>
      if records_send_back_open(events) {
        LAwaitingRecordsFix(round)
      } else {
        LDone
      }
    EvS2HandFixed => LStartBlind(Blind, round, None, false)
    EvS2DeviceStarted => LRunningDevice(js_num(a.round), text_or(a.run_id, ""))
    EvS2DeviceDone =>
      if js_truthy(a.failed) {
        let error = js_string_opt(a.error, "")
        LEscalated(
          "絵の見比べに失敗: " + error,
          stored_state(before(events, EvS2DeviceStarted)),
          None,
        )
      } else if is_text(a.judge, "human") {
        LDone
      } else if js_num(a.blocking) > 0.0 {
        LStartTriage(
          Json::string("device"),
          js_num(a.round),
          js_strings(a.files),
        )
      } else {
        LDone
      }
    EvS2DeviceSkipped => LDone
    EvBlockedByDependency => LIdle
    EvClaudeQuotaWait => LIdle
    EvFixPlanDone => LIdle
    EvFixPlanStarted => LIdle
    EvShapeStarted => LIdle
    EvShapeJudged => LIdle
    EvLaneBudgetExtended => LIdle
    EvLaneClose => LIdle
    EvLaneOpen => LIdle
    EvLaneOverBudget => LIdle
    EvLaneStallDetected => LIdle
    EvLaneStallInstructed => LIdle
    EvLaneStallResumed => LIdle
    EvLaneStalled => LIdle
    EvLaneWaitNotified => LIdle
    EvLaneStartSkipped => LIdle
    EvQuestionBatchAsked => LIdle
    EvS0RequeueGo => LIdle
    EvS1BaseAdvanced => LIdle
    EvS1Defer => LIdle
    EvS1Go => LIdle
    EvS1GranularityAnswered => LIdle
    EvS1GranularityProposed => LIdle
    EvS1GranularityRecorded => LIdle
    EvS1PlanReviewDone => LIdle
    EvS1PlanReviewSkipped => LIdle
    EvS1PlanReviewStarted => LIdle
    EvS1Ready => LIdle
    EvS1ReplanRequested => LIdle
    EvS1ReviseRequested => LIdle
    EvS2Result => LIdle
    EvS2ReviewRunFailed => LIdle
    EvS2Start => LIdle
    EvS3CheckClean => LIdle
    EvS3CheckConflict => LIdle
    EvS3Defer => LIdle
    EvS3Ok => LIdle
    EvS3PlanArchiveFailed => LIdle
    EvS3PlanRefsFixed => LIdle
    EvS3R2Done => LIdle
    EvS3R2NotRecorded => LIdle
    EvS3R2Recorded => LIdle
    EvS3R2Skipped => LIdle
    EvS3R2Started => LIdle
    EvS3Ready => LIdle
    EvS3Reject => LIdle
    EvS4LandApprovalDropped => LIdle
    EvS4LandApproved => LIdle
    EvS4LandConflict => LIdle
    EvS4LandHold => LIdle
    EvS4LandMerged => LIdle
    EvS4Merged => LIdle
    EvS4PrCreated => LIdle
    EvS4ShipFailed => LIdle
    EvS4SubmitStarted => LIdle
    EvS4VerifyUserJudgmentAnswered => LIdle
    EvLaneWorktreeKept => LIdle
    EvLaneWorktreeRetired => LIdle
    EvQuestionBatchAnswered => LIdle
    EvS1RecoveryAttempt => LIdle
    EvS2PlanWritten => LIdle
    EvS2RecoveryAttempt => LIdle
    EvS2ReviewBaseInstructed => LIdle
    EvS3CheckInProgress => LIdle
    EvS3FollowupsNotWritten => LIdle
    EvS3FollowupsWritten => LIdle
    EvS3PlanArchived => LIdle
    EvS4LandHeld => LIdle
    EvS4LandRecheck => LIdle
    EvS4PrDraftFailed => LIdle
    EvS4PushHeld => LIdle
    EvS4Pushed => LIdle
    EvS4RepliesQueued => LIdle
    EvS4Revise => LIdle
    EvS4SubmitOpenFailed => LIdle
    EvUnknown(_) => LIdle
  }
}

///|
/// `a.kind ?? "blind"` as the JSON the answer carries (a hand-written value keeps its own type).
fn kind_json_or(attrs : RowAttrs, fallback : String) -> Json {
  match attrs.kind {
    Json::Null => Json::string(fallback)
    other => other
  }
}

///|
/// `String(value ?? "")`.
fn js_string_opt(value : Json, fallback : String) -> String {
  match value {
    Json::Null => fallback
    _ => js_string(value)
  }
}

///|
/// A state stored in a record, handed back as it came.
fn stored_state(state : LoopState?) -> Json? {
  match state {
    Some(found) => Some(loop_state_json(found))
    None => None
  }
}

///|
/// The state after a judgement.
fn triage_done_state(
  events : Array[DerivedRow],
  last : Int,
  a : RowAttrs,
  round : Double,
) -> LoopState {
  if js_truthy(a.failed) {
    return LEscalated(
      "判定に失敗: " + js_string_opt(a.error, ""),
      stored_state(before(events, EvS2TriageStarted)),
      None,
    )
  }
  let stops : Array[String] = []
  match over_cap_stop(a, pass_policy(events, last)) {
    Some(stop) => stops.push(stop)
    None => ()
  }
  if oscillations_of(a).length() > 0 {
    stops.push(
      "修正が往復している（前の巡の修正を打ち消す指摘がある）。境目を決めてください",
    )
  }
  if js_strings(a.escalated_claims).length() > 0 {
    stops.push("判定が penne の判断を求めた指摘がある")
  }
  if stops.length() > 0 {
    let mut reason = ""
    let mut first = true
    for stop in stops {
      if first {
        first = false
      } else {
        reason = reason + "\n"
      }
      reason = reason + stop
    }
    return LEscalated(reason, None, None)
  }
  match pass_policy(events, last).depth {
    Some(depth) => return new_order_triage(events, last, depth, round)
    None => ()
  }
  if s4_triage(events, last) {
    let accepted = accepted_of(a)
    let mut any = false
    for item in accepted {
      if fixes_now(item) {
        any = true
      }
    }
    if !any {
      if event_kind(a) is TrieFeedback {
        return LDone
      }
      return LStartBlind(Final, round, None, false)
    }
    match stagnation(events) {
      Some(stuck) => LEscalated(stuck, None, None)
      None => LSendFix(round)
    }
  } else {
    let c = fix_counts(accepted_of(a))
    if closes_at(events, last, c) {
      match event_kind(a) {
        TrieFinal => return LConverge
        TrieDevice => return LDone
        TrieBlind => return LStartBlind(Final, round, None, false)
        TrieKept => return LStartBlind(Final, round, None, false)
        TrieConfirm => return LStartBlind(Final, round, None, false)
        TrieFeedback => return LStartBlind(Final, round, None, false)
        OtherTriageKind(_) => return LStartBlind(Final, round, None, false)
      }
    }
    match stagnation(events) {
      Some(stuck) => LEscalated(stuck, None, None)
      None => LSendFix(round)
    }
  }
}

///|
/// The state after a confirm.
fn confirm_done_state(
  events : Array[DerivedRow],
  last : Int,
  a : RowAttrs,
  round : Double,
) -> LoopState {
  if js_truthy(a.failed) {
    return LEscalated(
      "確認に失敗: " + js_string_opt(a.error, ""),
      stored_state(before(events, EvS2ConfirmStarted)),
      None,
    )
  }
  let clean = js_num(a.new_blocking) == 0.0 &&
    js_num(a.unresolved_requests) == 0.0 &&
    js_num(a.unresolved_boundaries) == 0.0
  let s4_pass = feedback_pass_at(events, last) >= 0
  let must = js_num(a.unresolved_must)
  let should = js_num(a.unresolved_should)
  let tolerable = if s4_pass || pass_policy(events, last).close_on_fix {
    must == 0.0 && should == 0.0
  } else {
    within_limit(must.to_int(), should.to_int())
  }
  if clean && tolerable {
    return LStartBlind(Final, round, None, false)
  }
  LStartTriage(Json::string("confirm"), js_num(a.round), js_strings(a.files))
}

///|
/// The state penne's answer leaves.
fn resumed_state(
  events : Array[DerivedRow],
  last : Int,
  a : RowAttrs,
  round : Double,
) -> LoopState {
  let decision = a.decision
  // an accept on a stop over the checks takes the head as answered for and goes where the checks were taking it
  if is_text(decision, "accept") {
    let over = checks_stop_at(events, last)
    return if over >= 0 { checks_return_state(events, over) } else { LConverge }
  }
  if is_text(decision, "hand_fix") {
    return LAwaitingHandFix(round)
  }
  let prior = review_loop_state(prefix_rows(events, last))
  let prior_json = loop_state_json(prior)
  if raw_state(prior_json) is SEscalated {
    let retry = field(prior_json, "retry")
    if retry is Json::Object(_) && has_key(retry, "state") {
      let quota = field(prior_json, "quotaWait")
      if quota is Json::Object(_) && raw_state(retry) is SStartBlind {
        return LStored(
          with_field(retry, "allowHighFallback", Json::boolean(true)),
        )
      }
      return LStored(retry)
    }
  }
  // a stop over the checks before the convergence: a continue sends the failures the lane made to the fix (the cap
  // stop), or runs the checks again (one that could not be compared). No judgement is answered there
  let checked = checks_stop_at(events, last)
  if checked >= 0 {
    return if is_text(events[checked].attrs.outcome, "new") &&
      !js_truthy(events[checked].attrs.failed) {
      LSendFix(round)
    } else {
      checks_return_state(events, checked)
    }
  }
  if text_of(a.note).trim() == "" {
    match after_question(prefix_rows(events, last), round) {
      Some(next) => return next
      None => ()
    }
  }
  // the answer left nothing for this change's fix (penne's corrections set every finding aside or off to a follow-up,
  // no reversal waits for its boundary, and no note answers a question the judgement asked; after a stop right after a
  // fix, the note and boundaries that fix carried count, as `fix_scope` carries them): a fix of nothing would
  // wake the planner and the executor for a head that does not move, so the loop goes where a judgement with nothing
  // to fix goes, without a stop: the final review after a blind or a confirm (its own skip decides whether it runs),
  // convergence after a final, the end after a device check or PR feedback. The records the loop then writes say why
  // (`zero_fix_marks`)
  if sends_nothing(prefix_rows(events, last + 1)) {
    return after_zero_fix(events, last, round)
  }
  LSendFix(round)
}

///|
/// Where the loop goes after penne's continue left nothing to fix: where the judgement it answered goes when it sends
/// nothing to the fix and stops for nothing, by the pass's own order (a depth's table, an S4 pass, or the loop's).
fn after_zero_fix(
  events : Array[DerivedRow],
  last : Int,
  round : Double,
) -> LoopState {
  let t = last_judgement(prefix_rows(events, last + 1))
  if t < 0 {
    return LConverge
  }
  let kind = event_kind(events[t].attrs)
  if s4_triage(events, t) {
    return if kind is TrieFeedback {
      LDone
    } else {
      LStartBlind(Final, round, None, false)
    }
  }
  match pass_policy(events, t).depth {
    Some(depth) =>
      match kind {
        TrieDevice => LDone
        TrieKept => LConverge
        TrieFinal => LConverge
        TrieBlind | TrieConfirm | TrieFeedback | OtherTriageKind(_) =>
          if depth_row(depth).final_review {
            LStartBlind(Final, round, None, false)
          } else {
            LConverge
          }
      }
    None =>
      match kind {
        TrieFinal => LConverge
        TrieDevice => LDone
        TrieBlind
        | TrieKept
        | TrieConfirm
        | TrieFeedback
        | OtherTriageKind(_) => LStartBlind(Final, round, None, false)
      }
  }
}

///|
/// Whether penne's answer at `last` went on from a stop that retries a stage (a failure, a window wait): the answer
/// retries it and sends no fix, so it is no continue with nothing to fix.
fn answers_retry(events : Array[DerivedRow], last : Int) -> Bool {
  let prior = loop_state_json(review_loop_state(prefix_rows(events, last)))
  if raw_state(prior) is SEscalated {
    let retry = field(prior, "retry")
    return retry is Json::Object(_) && has_key(retry, "state")
  }
  false
}

///|
/// The answer right before the retry stop penne's answer at `last` answered (only stops between), or -1: the stage
/// the stop retries was the one that answer led to.
fn answer_before_retry_stop(events : Array[DerivedRow], last : Int) -> Int {
  let mut i = last - 1
  let mut stopped = false
  while i >= 0 {
    let e = events[i].event
    if is_review_event(e) {
      if e == EvS2ReviewEscalated {
        stopped = true
      } else if e == EvS2ReviewResumed && stopped {
        return i
      } else {
        return -1
      }
    }
    i = i - 1
  }
  -1
}

///|
/// The last judgement on record that did not fail, or -1.
fn last_judgement(events : Array[DerivedRow]) -> Int {
  let mut t = events.length() - 1
  while t >= 0 {
    if events[t].event == EvS2TriageDone && !js_truthy(events[t].attrs.failed) {
      return t
    }
    t = t - 1
  }
  -1
}

///|
/// The fix right before the stop penne's answer at `r` answered (only stops between), or -1: the stop came after a fix
/// and before the next round, as the stop of a head the fix did not move does.
fn fix_before_stop(events : Array[DerivedRow], r : Int) -> Int {
  let mut i = r - 1
  let mut stopped = false
  while i >= 0 {
    let e = events[i].event
    if is_review_event(e) {
      if e == EvS2ReviewEscalated {
        stopped = true
      } else if e == EvS2FixSent && stopped {
        return i
      } else {
        return -1
      }
    }
    i = i - 1
  }
  -1
}

///|
/// The answer the fix before the stop answered at `r` was sent from (the loop row right before that fix), or -1.
fn answer_before_fix_stop(events : Array[DerivedRow], r : Int) -> Int {
  let f = fix_before_stop(events, r)
  if f < 0 {
    return -1
  }
  let mut i = f - 1
  while i >= 0 {
    if is_review_event(events[i].event) {
      return if events[i].event == EvS2ReviewResumed { i } else { -1 }
    }
    i = i - 1
  }
  -1
}

///|
/// Whether a fix sent now, after penne's answer, would carry nothing: a judgement is on record, and it leaves no
/// accepted finding in the fix's scope, no reversal with its boundary, and no question that penne's note answers (the
/// note is then the instruction the fix carries). A lane with no judgement on record is never read as empty: there
/// is nothing to count the fix against.
fn sends_nothing(events : Array[DerivedRow]) -> Bool {
  let t = last_judgement(events)
  if t < 0 {
    return false
  }
  let scope = fix_scope(events)
  if array_of(field(scope, "accepted")).length() > 0 ||
    array_of(field(scope, "boundaries")).length() > 0 {
    return false
  }
  let note = match field(scope, "note") {
    Json::String(text) => text.trim()
    _ => ""
  }
  !(note != "" && js_strings(events[t].attrs.escalated_claims).length() > 0)
}

///|
/// The reason a record the loop writes right after penne's continue with nothing left to fix carries: the convergence
/// that ends the review there (told apart from an accept, which writes no reason), or the final review it starts. None
/// for every other record, which writes what it always did.
fn zero_fix_marks(events : Array[DerivedRow]) -> Json? {
  let mut last = events.length() - 1
  while last >= 0 && !is_review_event(events[last].event) {
    last = last - 1
  }
  if last < 0 || events[last].event != EvS2ReviewResumed {
    return None
  }
  if is_text(events[last].attrs.decision, "accept") ||
    is_text(events[last].attrs.decision, "hand_fix") {
    return None
  }
  // a continue on a stop over the checks answers no judgement: it runs them again or sends their failures
  if checks_stop_at(events, last) >= 0 {
    return None
  }
  // an answer that only retried a stage the zero-fix continue led to (a final whose start failed) carries that
  // continue's reason on: the record the retried stage writes is still the one the continue reached
  if answers_retry(events, last) {
    let earlier = answer_before_retry_stop(events, last)
    return if earlier < 0 {
      None
    } else {
      zero_fix_marks(prefix_rows(events, earlier + 1))
    }
  }
  if !sends_nothing(prefix_rows(events, last + 1)) {
    return None
  }
  Some(
    json_object([
      (
        "reason",
        Json::string(
          "「続ける」の後に直す対象が 0 件のため、手直しを送らなかった",
        ),
      ),
      ("fix_targets", Json::number(0.0)),
    ]),
  )
}

///|
/// Whether any recorded switch changed the role that read a round.
fn role_changed_in(fallbacks : Json) -> Bool {
  match fallbacks {
    Json::Array(items) => {
      let mut changed = false
      for f in items {
        if js_truthy(f) &&
          !js_scalar_equal(field(f, "role"), field(f, "fallback")) {
          changed = true
        }
      }
      changed
    }
    _ => false
  }
}

///|
/// The head the last whole-diff blind read, when its judgement is within the limit.
fn settled_head(events : Array[DerivedRow]) -> String? {
  let mut s = events.length() - 1
  while s >= 0 {
    if events[s].event == EvS2ReviewStarted &&
      !is_text(events[s].attrs.kind, "device") {
      break
    }
    s = s - 1
  }
  if s < 0 {
    return None
  }
  let a = events[s].attrs
  match a.whole_run_ids {
    Json::Array(_) => return None
    _ => ()
  }
  let head = match a.head {
    Json::String(text) => if text == "" { return None } else { text }
    _ => return None
  }
  if role_changed_in(a.fallbacks) {
    return None
  }
  let mut findings : RowAttrs? = None
  let mut i = s + 1
  while i < events.length() {
    if events[i].event == EvS2ReviewFindings {
      findings = Some(events[i].attrs)
      break
    }
    i = i + 1
  }
  match findings {
    Some(attrs) => if js_num(attrs.failed_runs) > 0.0 { return None }
    None => ()
  }
  match findings {
    Some(attrs) => if role_changed_in(attrs.fallbacks) { return None }
    None => ()
  }
  let mut fixed_after = false
  let mut j = s + 1
  while j < events.length() {
    if events[j].event == EvS2FixSent {
      fixed_after = true
    }
    j = j + 1
  }
  if fixed_after {
    return None
  }
  let kind = a.kind
  let mut t = -1
  let mut k = s + 1
  while k < events.length() {
    let e = events[k]
    if e.event == EvS2TriageDone &&
      !js_truthy(e.attrs.failed) &&
      js_scalar_equal(kind_or(e.attrs.kind), kind_or(kind)) {
      t = k
      break
    }
    k = k + 1
  }
  if t < 0 {
    return None
  }
  let ta = events[t].attrs
  if oscillations_of(ta).length() > 0 || s4_triage(events, t) {
    return None
  }
  let c = fix_counts(accepted_at(events, t))
  if closes_at(events, t, c) {
    Some(head)
  } else {
    None
  }
}

///|
/// `a.kind ?? "blind"` as a value compared with `===`.
fn kind_or(value : Json) -> Json {
  match value {
    Json::Null => Json::string("blind")
    other => other
  }
}

///|
/// Where a fix comes from.
pub(all) enum FixSource {
  SrcReview
  SrcPr
  SrcPrLeftovers
  SrcChecks
}

///|
/// The source's own text.
fn fix_source_text(source : FixSource) -> String {
  match source {
    SrcReview => "review"
    SrcPr => "pr"
    SrcPrLeftovers => "pr_leftovers"
    SrcChecks => "checks"
  }
}

///|
/// What a fix sent now carries.
fn fix_scope(events : Array[DerivedRow]) -> Json {
  // the failures the checks before the convergence found the lane made: the fix carries them as musts, with the newest
  // note penne wrote since
  let d = checks_fix_at(events)
  if d >= 0 {
    let mut note = ""
    let mut k = events.length() - 1
    while k > d && note.trim() == "" {
      if events[k].event == EvS2ReviewResumed {
        note = js_string_opt(events[k].attrs.note, "")
      }
      k = k - 1
    }
    return json_object([
      ("source", Json::string(fix_source_text(SrcChecks))),
      ("all", Json::boolean(false)),
      ("accepted", Json::array(array_of(events[d].attrs.findings))),
      ("note", Json::string(note)),
      ("boundaries", Json::array([])),
    ])
  }
  let mut t = -1
  let mut i = 0
  while i < events.length() {
    if events[i].event == EvS2TriageDone {
      t = i
    }
    i = i + 1
  }
  let all = if t >= 0 { s4_triage(events, t) } else { false }
  let source = if t >= 0 && is_text(events[t].attrs.kind, "feedback") {
    SrcPr
  } else if all {
    SrcPrLeftovers
  } else {
    SrcReview
  }
  let accepted_all = if t >= 0 { accepted_at(events, t) } else { [] }
  let accepted : Array[Json] = []
  for item in accepted_all {
    let takes = if all { fixes_now(item) } else { in_fix_scope(item) }
    if takes {
      accepted.push(item)
    }
  }
  let mut r = -1
  let mut j = 0
  while j < events.length() {
    if events[j].event == EvS2ReviewResumed {
      r = j
    }
    j = j + 1
  }
  let answered = if r > t { Some(events[r].attrs) } else { None }
  let mut decided = match answered {
    Some(attrs) => boundaries_of(attrs)
    None => []
  }
  let mut note = match answered {
    Some(attrs) => js_string_opt(attrs.note, "")
    None => ""
  }
  // an answer that only went on from a stop right after a fix (the head the fix left did not move) sends that fix
  // again: what the answer before the fix said goes with it, unless this answer says something of its own
  if r > t {
    let mut at = r
    while note.trim() == "" || decided.length() == 0 {
      let before = answer_before_fix_stop(events, at)
      if before <= t {
        break
      }
      if note.trim() == "" {
        note = js_string_opt(events[before].attrs.note, "")
      }
      if decided.length() == 0 {
        decided = boundaries_of(events[before].attrs)
      }
      at = before
    }
  }
  let triage_attrs = if t >= 0 {
    events[t].attrs
  } else {
    row_attrs_of(Json::null())
  }
  let boundaries : Array[Json] = []
  for o in oscillations_of(triage_attrs) {
    let mut text = ""
    for b in decided {
      if b.ref_text == o.ref_text {
        text = b.text
      }
    }
    boundaries.push(
      with_field(oscillation_json(o), "decision", Json::string(text)),
    )
  }
  json_object([
    ("source", Json::string(fix_source_text(source))),
    ("all", Json::boolean(all)),
    ("accepted", Json::array(accepted)),
    ("note", Json::string(note)),
    ("boundaries", Json::array(boundaries)),
  ])
}

///|
/// The judgement penne's answer at `r` answered, or -1.
fn answered_judgement_at(events : Array[DerivedRow], r : Int) -> Int {
  let mut i = r - 1
  while i >= 0 {
    let e = events[i]
    if !is_review_event(e.event) {
      i = i - 1
      continue
    }
    if e.event == EvS2ReviewEscalated {
      if js_truthy(e.attrs.retry_state) {
        return -1
      }
      i = i - 1
      continue
    }
    if e.event == EvS2TriageDone && !js_truthy(e.attrs.failed) {
      return i
    }
    return -1
  }
  -1
}

///|
/// The fix recorded right after event `i`, when one was.
fn fix_after(events : Array[DerivedRow], i : Int) -> Int {
  let mut j = i + 1
  while j < events.length() {
    let e = events[j]
    if !is_review_event(e.event) ||
      e.event == EvS2ReviewEscalated ||
      e.event == EvS2ReviewResumed {
      j = j + 1
      continue
    }
    if e.event == EvS2FixSent {
      return j
    }
    return -1
  }
  -1
}

///|
/// The refs the fix right after a judgement was sent to fix.
fn sent_refs(
  events : Array[DerivedRow],
  i : Int,
  fix : RowAttrs?,
) -> Array[String] {
  match fix {
    None => []
    Some(attrs) =>
      match attrs.refs {
        Json::Array(_) => js_strings(attrs.refs)
        _ => {
          let out : Array[String] = []
          for item in accepted_at(events, i) {
            if in_fix_scope(item) {
              out.push(text_of(field(item, "ref")))
            }
          }
          out
        }
      }
  }
}

///|
/// What a judgement left unfixed, read from the fix sent right after it.
fn unfixed_of(
  events : Array[DerivedRow],
  t : Int,
  fix : RowAttrs?,
  note : String,
  s4 : Bool,
) -> Json {
  let a = if t >= 0 && t < events.length() {
    events[t].attrs
  } else {
    row_attrs_of(Json::null())
  }
  let refs = sent_refs(events, t, fix)
  let bounds = match fix {
    Some(attrs) =>
      match attrs.boundary_refs {
        Json::Array(_) => js_strings(attrs.boundary_refs)
        _ => oscillations_of(a).map(fn(o) { o.ref_text })
      }
    None => []
  }
  let accepted : Array[Json] = []
  for item in accepted_at(events, t) {
    let found = text_of(field(item, "ref"))
    if !contains_text(refs, found) &&
      !is_followup(item) &&
      !is_set_aside(item) &&
      !(s4 && is_text(field(item, "action"), "skip")) {
      accepted.push(item)
    }
  }
  let has_fix = fix is Some(_)
  let questions = if has_fix && note.trim() != "" {
    []
  } else {
    js_strings(a.escalated_claims)
  }
  let reversals : Array[Json] = []
  for o in oscillations_of(a) {
    if !contains_text(bounds, o.ref_text) {
      reversals.push(oscillation_json(o))
    }
  }
  json_object([
    ("accepted", Json::array(accepted)),
    ("questions", Json::array(questions.map(Json::string))),
    ("reversals", Json::array(reversals)),
  ])
}

///|
/// What the fix right after a judgement was sent to fix and nothing showed fixed.
fn unsettled_of(events : Array[DerivedRow], t : Int) -> Json {
  let none = json_object([
    ("unconfirmed", Json::boolean(false)),
    ("accepted", Json::array([])),
    ("reversals", Json::array([])),
  ])
  let f = fix_after(events, t)
  if f < 0 {
    return none
  }
  let mut later_judgement = false
  let mut i = f + 1
  while i < events.length() {
    if events[i].event == EvS2TriageDone && !js_truthy(events[i].attrs.failed) {
      later_judgement = true
    }
    i = i + 1
  }
  if later_judgement {
    return none
  }
  let mut c = -1
  let mut j = events.length() - 1
  while j > f {
    if events[j].event == EvS2ConfirmDone && !js_truthy(events[j].attrs.failed) {
      c = j
      break
    }
    j = j - 1
  }
  let a = events[t].attrs
  let fix = Some(events[f].attrs)
  let refs = sent_refs(events, t, fix)
  let u = unfixed_of(events, t, fix, "", s4_triage(events, t))
  let u_reversals = array_of(field(u, "reversals")).map(fn(o) {
    text_of(field(o, "ref"))
  })
  let sent : Array[Json] = []
  for item in accepted_at(events, t) {
    if contains_text(refs, text_of(field(item, "ref"))) {
      sent.push(item)
    }
  }
  let bounds : Array[Oscillation] = []
  for o in oscillations_of(a) {
    if !contains_text(u_reversals, o.ref_text) {
      bounds.push(o)
    }
  }
  if c < 0 {
    return json_object([
      ("unconfirmed", Json::boolean(true)),
      ("accepted", Json::array(sent)),
      ("reversals", Json::array(bounds.map(oscillation_json))),
    ])
  }
  let open = js_strings(events[c].attrs.unresolved_refs)
  let kept : Array[Json] = []
  for item in sent {
    if contains_text(open, text_of(field(item, "ref"))) {
      kept.push(item)
    }
  }
  let kept_bounds : Array[Json] = []
  for o in bounds {
    if contains_text(open, o.ref_text) {
      kept_bounds.push(oscillation_json(o))
    }
  }
  json_object([
    ("unconfirmed", Json::boolean(false)),
    ("accepted", Json::array(kept)),
    ("reversals", Json::array(kept_bounds)),
  ])
}

///|
/// The refs the confirm after this fix reported unresolved.
fn open_after_fix(events : Array[DerivedRow], fix : Int) -> Array[String] {
  let open : Array[String] = []
  if fix < 0 {
    return open
  }
  let mut j = fix + 1
  while j < events.length() {
    let name = events[j].event
    if name == EvS2FixSent || name == EvS2TriageDone {
      break
    }
    if name == EvS2ConfirmDone && !js_truthy(events[j].attrs.failed) {
      for found in js_strings(events[j].attrs.unresolved_refs) {
        if !contains_text(open, found) {
          open.push(found)
        }
      }
    }
    j = j + 1
  }
  open
}

///|
/// The follow-ups of the current pass.
fn followups_of(events : Array[DerivedRow]) -> Json {
  let start = pass_start_at(events, events.length() - 1)
  let judges : Array[Int] = []
  let mut i = 0
  while i < events.length() {
    let e = events[i]
    if i > start && e.event == EvS2TriageDone && !js_truthy(e.attrs.failed) {
      let judged = match event_kind(e.attrs) {
        TrieBlind => true
        TrieFinal => true
        TrieConfirm => true
        TrieDevice => true
        TrieKept => true
        TrieFeedback => false
        OtherTriageKind(_) => false
      }
      let is_confirm = event_kind(e.attrs) is TrieConfirm
      if judged && !(is_confirm && feedback_pass_at(events, i) >= 0) {
        judges.push(i)
      }
    }
    i = i + 1
  }
  let sent_of : Map[Int, Array[String]] = Map([])
  let fixed : Array[String] = []
  for judge in judges {
    let fix_index = fix_after(events, judge)
    let fix = if fix_index >= 0 { Some(events[fix_index].attrs) } else { None }
    let refs = sent_refs(events, judge, fix)
    sent_of.set(judge, refs)
    let open = open_after_fix(events, fix_index)
    for item in accepted_at(events, judge) {
      let found = text_of(field(item, "ref"))
      if contains_text(refs, found) && !contains_text(open, found) {
        let key = finding_key(item)
        if !contains_text(fixed, key) {
          fixed.push(key)
        }
      }
    }
  }
  let out : Array[Json] = []
  let seen : Array[String] = []
  // the refs already listed: a finding that repeats a corrected one is the same follow-up, worded again
  let listed : Array[String] = []
  for judge in judges {
    let refs = match sent_of.get(judge) {
      Some(refs) => refs
      None => []
    }
    for item in accepted_at(events, judge) {
      let key = finding_key(item)
      if contains_text(seen, key) || contains_text(fixed, key) {
        continue
      }
      let cited = text_of(field(item, "correction_ref"))
      if cited != "" && contains_text(listed, cited) {
        continue
      }
      let where_path = match non_empty_text(field(item, "path")) {
        Some(path) => [("path", Json::string(path))]
        None => []
      }
      let extra : Array[(String, Json)] = []
      if has_key(item, "line") {
        extra.push(("line", field(item, "line")))
      }
      match events[judge].attrs.round {
        Json::Number(number, ..) => extra.push(("round", Json::number(number)))
        _ => ()
      }
      let severity = text_of(field(item, "severity"))
      let claim = text_of(field(item, "claim"))
      let action = field(item, "action")
      if is_followup(item) {
        seen.push(key)
        listed.push(text_of(field(item, "ref")))
        let fields : Array[(String, Json)] = [
          ("severity", Json::string(severity)),
          ("claim", Json::string(claim)),
        ]
        for pair in judged_weight_fields(item) {
          fields.push(pair)
        }
        for pair in where_path {
          fields.push(pair)
        }
        for pair in extra {
          fields.push(pair)
        }
        out.push(json_object(fields))
      } else if (severity == "must" || severity == "should") &&
        !is_text(action, "skip") &&
        !contains_text(refs, text_of(field(item, "ref"))) {
        seen.push(key)
        listed.push(text_of(field(item, "ref")))
        let fields : Array[(String, Json)] = [
          ("severity", Json::string(severity)),
          ("claim", Json::string(claim)),
        ]
        for pair in judged_weight_fields(item) {
          fields.push(pair)
        }
        for pair in where_path {
          fields.push(pair)
        }
        for pair in extra {
          fields.push(pair)
        }
        fields.push(("source", Json::string("unsent")))
        out.push(json_object(fields))
      }
    }
    for r in rejected_of(events[judge].attrs) {
      if !js_truthy(field(r, "followup")) {
        continue
      }
      let claim = text_of(field(r, "claim"))
      let key = "|" + claim
      if contains_text(seen, key) || contains_text(fixed, key) {
        continue
      }
      seen.push(key)
      let severity = {
        let raw = js_string_opt(field(r, "severity"), "should")
        if raw == "" {
          "should"
        } else {
          raw
        }
      }
      let fields : Array[(String, Json)] = [
        ("severity", Json::string(severity)),
        ("claim", Json::string(claim)),
      ]
      match non_empty_text(field(r, "reason")) {
        Some(reason) => fields.push(("reason", Json::string(reason)))
        None => ()
      }
      out.push(json_object(fields))
    }
  }
  Json::array(out)
}

///|
/// The shoulds the current pass's judgements accepted and the ones they recommended fixing.
fn should_fix_counts(events : Array[DerivedRow]) -> Json {
  let start = pass_start_at(events, events.length() - 1)
  let by_key : Map[String, (Bool, Bool)] = Map([])
  let mut i = 0
  while i < events.length() {
    let e = events[i]
    if i > start && e.event == EvS2TriageDone && !js_truthy(e.attrs.failed) {
      let judged = match event_kind(e.attrs) {
        TrieBlind => true
        TrieFinal => true
        TrieConfirm => true
        TrieDevice => true
        TrieKept => true
        TrieFeedback => false
        OtherTriageKind(_) => false
      }
      let is_confirm = event_kind(e.attrs) is TrieConfirm
      if judged && !(is_confirm && feedback_pass_at(events, i) >= 0) {
        for item in accepted_at(events, i) {
          if !is_text(field(item, "severity"), "should") {
            continue
          }
          let key = finding_key(item)
          let current = match by_key.get(key) {
            Some(found) => found
            None => (false, false)
          }
          let fix = current.0 ||
            (
              is_text(field(item, "action"), "fix") &&
              js_truthy(field(item, "fix_basis"))
            )
          let without = current.1 ||
            (!fix && is_text(field(item, "claimed_action"), "fix"))
          by_key.set(key, (fix, without))
        }
      }
    }
    i = i + 1
  }
  let mut accepted = 0
  let mut fix = 0
  let mut without = 0
  for pair in by_key.to_array() {
    accepted = accepted + 1
    if pair.1.0 {
      fix = fix + 1
    } else if pair.1.1 {
      without = without + 1
    }
  }
  json_object([
    ("accepted", Json::number(accepted.to_double())),
    ("fix", Json::number(fix.to_double())),
    ("fixWithoutBasis", Json::number(without.to_double())),
  ])
}

///|
/// The judgement penne's answer at `t` records, when one was recorded right after it.
fn answer_to(events : Array[DerivedRow], t : Int) -> Int {
  let mut i = t + 1
  while i < events.length() {
    let e = events[i]
    if !is_review_event(e.event) || e.event == EvS2ReviewEscalated {
      i = i + 1
      continue
    }
    if e.event == EvS2ReviewResumed && answered_judgement_at(events, i) == t {
      return i
    }
    return -1
  }
  -1
}

///|
/// What the submit card lists as accepted but not fixed.
fn submit_leftovers(events : Array[DerivedRow]) -> Json {
  let start = pass_start_at(events, events.length() - 1)
  let mut last = -1
  let mut i = events.length() - 1
  while i > start {
    if events[i].event == EvS2TriageDone && !js_truthy(events[i].attrs.failed) {
      last = i
      break
    }
    i = i - 1
  }
  if last < 0 {
    return Json::array([])
  }
  let judgements : Array[Int] = [last]
  let mut t = 0
  while t < events.length() {
    if t > start &&
      t != last &&
      events[t].event == EvS2TriageDone &&
      !js_truthy(events[t].attrs.failed) &&
      answer_to(events, t) >= 0 {
      judgements.push(t)
    }
    t = t + 1
  }
  let out : Array[Json] = []
  let seen : Array[String] = []
  let aside : Array[String] = []
  let key_of = fn(item : Json) -> String { finding_key(item) }
  for t in judgements {
    let r = answer_to(events, t)
    let note = if r >= 0 && !is_text(events[r].attrs.decision, "accept") {
      js_string_opt(events[r].attrs.note, "")
    } else {
      ""
    }
    let sent = unsettled_of(events, t)
    let mark = if js_truthy(field(sent, "unconfirmed")) {
      "（修正に回したが、直ったかを確かめずに進めた）"
    } else {
      "（確認で直っていないと分かった）"
    }
    for item in array_of(field(sent, "accepted")) {
      let key = key_of(item)
      if contains_text(seen, key) {
        continue
      }
      seen.push(key)
      let claim = text_of(field(item, "claim")) + mark
      out.push(leftover_json(item, claim))
    }
    for o in array_of(field(sent, "reversals")) {
      let key = finding_key(o)
      if contains_text(seen, key) {
        continue
      }
      seen.push(key)
      let claim = text_of(field(o, "claim")) + mark
      out.push(leftover_json(o, claim))
    }
    let fix_index = fix_after(events, t)
    let fix = if fix_index >= 0 { Some(events[fix_index].attrs) } else { None }
    let left = unfixed_of(events, t, fix, note, s4_triage(events, t))
    for item in array_of(field(left, "accepted")) {
      let key = key_of(item)
      if contains_text(seen, key) {
        continue
      }
      seen.push(key)
      out.push(leftover_json(item, text_of(field(item, "claim"))))
    }
    // what penne set aside on the stuck card is not fixed and not followed up, so the submit card lists it as she
    // decided it; a finding that repeats it by citation is the same entry
    for item in accepted_at(events, t) {
      if !is_set_aside(item) || is_followup(item) {
        continue
      }
      let found = text_of(field(item, "ref"))
      let cited = text_of(field(item, "correction_ref"))
      if contains_text(aside, found) ||
        (cited != "" && contains_text(aside, cited)) {
        continue
      }
      aside.push(found)
      if cited != "" {
        aside.push(cited)
      }
      let key = key_of(item)
      if contains_text(seen, key) {
        continue
      }
      seen.push(key)
      out.push(leftover_json(item, text_of(field(item, "claim"))))
    }
    for o in array_of(field(left, "reversals")) {
      let key = finding_key(o)
      if contains_text(seen, key) {
        continue
      }
      seen.push(key)
      let prior_ref = text_of(field(o, "prior_ref"))
      let lead = if prior_ref != "" {
        prior_ref + " の"
      } else {
        "前の巡の"
      }
      let claim = text_of(field(o, "claim")) +
        "（" +
        lead +
        "修正と往復。境目は決めず、今のコードのまま進めた）"
      out.push(leftover_json(o, claim))
    }
    for q in js_strings(field(left, "questions")) {
      if contains_text(seen, q) {
        continue
      }
      seen.push(q)
      out.push(
        json_object([
          ("severity", Json::string("判断")),
          (
            "claim",
            Json::string(
              q +
              "（判定が penne の判断を求めた指摘。直す指示を出さずに進めた）",
            ),
          ),
        ]),
      )
    }
  }
  Json::array(out)
}

///|
/// One leftover as the card carries it.
fn leftover_json(item : Json, claim : String) -> Json {
  let fields : Array[(String, Json)] = [
    ("severity", Json::string(text_of(field(item, "severity")))),
    ("claim", Json::string(claim)),
  ]
  match non_empty_text(field(item, "path")) {
    Some(path) => fields.push(("path", Json::string(path)))
    None => ()
  }
  match non_empty_text(field(item, "action")) {
    Some(action) => fields.push(("action", Json::string(action)))
    None => ()
  }
  match non_empty_text(field(item, "fix_basis")) {
    Some(basis) => fields.push(("fixBasis", Json::string(basis)))
    None => ()
  }
  for pair in judged_weight_fields(item) {
    fields.push(pair)
  }
  json_object(fields)
}

///|
/// The counts of every judgement of the review loop.
fn review_rounds(events : Array[DerivedRow]) -> Json {
  let out : Array[Json] = []
  let mut i = 0
  while i < events.length() {
    let e = events[i]
    if e.event != EvS2TriageDone || js_truthy(e.attrs.failed) {
      i = i + 1
      continue
    }
    let accepted = accepted_at(events, i)
    let mut must = 0
    let mut should = 0
    let mut nit = 0
    for item in accepted {
      if is_text(field(item, "severity"), "must") {
        must = must + 1
      } else if is_text(field(item, "severity"), "should") {
        should = should + 1
      } else if is_text(field(item, "severity"), "nit") {
        nit = nit + 1
      }
    }
    let fix_index = fix_after(events, i)
    let fix = if fix_index >= 0 { Some(events[fix_index].attrs) } else { None }
    let refs = sent_refs(events, i, fix)
    let mut fixed = 0
    if fix_index >= 0 {
      let mut next = events.length()
      let mut j = fix_index + 1
      while j < events.length() {
        if events[j].event == EvS2FixSent {
          next = j
          break
        }
        j = j + 1
      }
      let mut confirm = -1
      let mut k = fix_index + 1
      while k < next {
        if events[k].event == EvS2ConfirmDone &&
          !js_truthy(events[k].attrs.failed) {
          confirm = k
        }
        k = k + 1
      }
      if confirm >= 0 {
        let open = js_strings(events[confirm].attrs.unresolved_refs)
        for item in accepted {
          if contains_text(refs, text_of(field(item, "ref"))) &&
            !contains_text(open, text_of(field(item, "ref"))) {
            fixed = fixed + 1
          }
        }
      }
    }
    out.push(
      json_object([
        ("round", Json::number(js_num(e.attrs.round))),
        ("kind", Json::string(kind_text(e.attrs.kind, "blind"))),
        ("must", Json::number(must.to_double())),
        ("should", Json::number(should.to_double())),
        ("nit", Json::number(nit.to_double())),
        ("open", Json::number((accepted.length() - fixed).to_double())),
      ]),
    )
    i = i + 1
  }
  Json::array(out)
}

///|
/// Whether penne's answer closed the review in this pass.
fn closed_by_penne(events : Array[DerivedRow]) -> Bool {
  let start = pass_start_at(events, events.length() - 1)
  let closes = fn(r : Int) -> Bool {
    r > start &&
    r < events.length() &&
    events[r].event == EvS2ReviewResumed &&
    (
      is_text(events[r].attrs.decision, "accept") ||
      (answered_judgement_at(events, r) >= 0 && fix_after(events, r) < 0)
    )
  }
  let review_before = fn(i : Int) -> Int {
    let mut j = i - 1
    while j >= 0 {
      if is_review_event(events[j].event) {
        return j
      }
      j = j - 1
    }
    -1
  }
  let close_verdict = fn(c : Int) -> Bool {
    closed_at(events, start, closes, c)
  }
  let mut converged = -1
  let mut i = 0
  while i < events.length() {
    if events[i].event == EvS2ReviewConverged {
      converged = i
    }
    i = i + 1
  }
  if converged > start {
    return close_verdict(converged)
  }
  closes(review_before(events.length()))
}

///|
/// Whether the close at converge `c` was penne's.
fn closed_at(
  events : Array[DerivedRow],
  start : Int,
  closes : (Int) -> Bool,
  c : Int,
) -> Bool {
  let mut r = c - 1
  while r >= 0 {
    if is_review_event(events[r].event) {
      break
    }
    r = r - 1
  }
  if !closes(r) {
    return false
  }
  if answered_judgement_at(events, r) >= 0 {
    return true
  }
  let mut prev = -1
  let mut i = r - 1
  while i > start {
    if events[i].event == EvS2ReviewConverged {
      prev = i
      break
    }
    i = i - 1
  }
  let mut fixed_since = false
  let mut k = prev + 1
  while k < r {
    if events[k].event == EvS2FixSent {
      fixed_since = true
    }
    k = k + 1
  }
  if prev < 0 || fixed_since {
    return true
  }
  closed_at(events, start, closes, prev)
}

///|
/// The label the lane list shows while the loop runs.
fn review_loop_label(state : LoopState, rank : Int?) -> String? {
  match state {
    LStartBlind(kind, round, _, _) =>
      if kind == Final {
        Some("最後のレビュー待ち")
      } else {
        Some("レビュー待ち（" + round.to_string() + " 巡目）")
      }
    LRunningBlind(kind, round, _) =>
      if is_text(kind, "final") {
        Some("最後のレビュー中")
      } else if is_text(kind, "device") {
        Some("絵の見比べ中")
      } else {
        Some("レビュー中（" + round.to_string() + " 巡目）")
      }
    LRunningMap(_, _, _, _) => Some("危ない経路の下調べ中")
    LStartTriage(kind, _, _) =>
      if is_text(kind, "feedback") {
        Some("PR の指摘の判定中")
      } else {
        Some("指摘の判定中")
      }
    LRunningTriage(kind, _, _) =>
      if is_text(kind, "feedback") {
        Some("PR の指摘の判定中")
      } else {
        Some("指摘の判定中")
      }
    LSendFix(round) => Some("修正中（" + round.to_string() + " 巡目）")
    LFixing(round) => Some("修正中（" + round.to_string() + " 巡目）")
    LStartConfirm(_) => Some("修正の確認中")
    LRunningConfirm(_, _) => Some("修正の確認中")
    LAwaitingMerge(_) => Some("衝突の解消中")
    LAwaitingRecordsFix(_) => Some("記録の直し待ち")
    LRecheckIntent(_) => Some("記録の再検査中")
    LAwaitingOrder(_, opponents) => {
      let mut lanes = ""
      let mut first_lane = true
      for o in opponents {
        if first_lane {
          first_lane = false
        } else {
          lanes = lanes + "、"
        }
        lanes = lanes + o.lane
      }
      if lanes == "" {
        lanes = "先の lane"
      }
      let files : Array[String] = []
      for o in opponents {
        for file in o.files {
          if !contains_text(files, file) {
            files.push(file)
          }
        }
      }
      let mut shown = ""
      let mut at = 0
      while at < files.length() && at < 3 {
        if at > 0 {
          shown = shown + "、"
        }
        shown = shown + files[at]
        at = at + 1
      }
      if files.length() > 3 {
        shown = shown + " ほか " + (files.length() - 3).to_string() + " 件"
      }
      let parts : Array[String] = []
      match rank {
        Some(rank) => parts.push(rank.to_string() + " 番目")
        None => ()
      }
      if files.length() > 0 {
        parts.push(shown)
      }
      let mut inside = ""
      let mut first_part = true
      for part in parts {
        if first_part {
          first_part = false
        } else {
          inside = inside + "・"
        }
        inside = inside + part
      }
      Some(
        lanes +
        " の取り込みを待っている" +
        (if parts.length() > 0 { "（" + inside + "）" } else { "" }),
      )
    }
    LStartDevice(_) => Some("絵の見比べ中")
    LRunningDevice(_, _) => Some("絵の見比べ中")
    LRunningChecks(_, _) => Some("検査中")
    LIdle => None
    LConverge => None
    LAwaitingHandFix(_) => None
    LEscalated(_, _, _) => None
    LDone => None
    LStored(stored) => label_of_json(stored)
  }
}

///|
/// The label a stored state's own fields give (a retry state handed back as it came, or the answer of a lane).
fn label_of_json(value : Json) -> String? {
  match raw_state(value) {
    SStartBlind =>
      if is_text(field(value, "kind"), "final") {
        Some("最後のレビュー待ち")
      } else {
        Some(
          "レビュー待ち（" +
          js_num(field(value, "round")).to_string() +
          " 巡目）",
        )
      }
    SRunningBlind =>
      if is_text(field(value, "kind"), "final") {
        Some("最後のレビュー中")
      } else if is_text(field(value, "kind"), "device") {
        Some("絵の見比べ中")
      } else {
        Some(
          "レビュー中（" +
          js_num(field(value, "round")).to_string() +
          " 巡目）",
        )
      }
    SRunningMap => Some("危ない経路の下調べ中")
    SStartTriage =>
      if is_text(field(value, "kind"), "feedback") {
        Some("PR の指摘の判定中")
      } else {
        Some("指摘の判定中")
      }
    SRunningTriage =>
      if is_text(field(value, "kind"), "feedback") {
        Some("PR の指摘の判定中")
      } else {
        Some("指摘の判定中")
      }
    SSendFix =>
      Some(
        "修正中（" +
        js_num(field(value, "round")).to_string() +
        " 巡目）",
      )
    SFixing =>
      Some(
        "修正中（" +
        js_num(field(value, "round")).to_string() +
        " 巡目）",
      )
    SStartConfirm => Some("修正の確認中")
    SRunningConfirm => Some("修正の確認中")
    SAwaitingMerge => Some("衝突の解消中")
    SAwaitingRecordsFix => Some("記録の直し待ち")
    SRecheckIntent => Some("記録の再検査中")
    SAwaitingOrder => {
      let opponents = order_opponents_of(row_attrs_of(value))
      let mut lanes = ""
      let mut first_lane = true
      for o in opponents {
        if first_lane {
          first_lane = false
        } else {
          lanes = lanes + "、"
        }
        lanes = lanes + o.lane
      }
      if lanes == "" {
        lanes = "先の lane"
      }
      let files : Array[String] = []
      for o in opponents {
        for file in o.files {
          if !contains_text(files, file) {
            files.push(file)
          }
        }
      }
      let mut shown = ""
      let mut at = 0
      while at < files.length() && at < 3 {
        if at > 0 {
          shown = shown + "、"
        }
        shown = shown + files[at]
        at = at + 1
      }
      if files.length() > 3 {
        shown = shown + " ほか " + (files.length() - 3).to_string() + " 件"
      }
      Some(
        lanes +
        " の取り込みを待っている" +
        (if files.length() > 0 { "（" + shown + "）" } else { "" }),
      )
    }
    SStartDevice => Some("絵の見比べ中")
    SRunningDevice => Some("絵の見比べ中")
    SRunningChecks => Some("検査中")
    SIdle => None
    SConverge => None
    SAwaitingHandFix => None
    SEscalated => None
    SDone => None
    SUnknown(_) => None
  }
}

///|
/// Whether the lane's last failed start is too recent to try again.
fn start_retry_waiting(events : Array[DerivedRow], now : Double) -> Bool {
  if start_failures(events) == 0 {
    return false
  }
  let mut last = -1
  let mut i = events.length() - 1
  while i >= 0 {
    if events[i].event == EvS2ReviewRunFailed {
      last = i
      break
    }
    i = i - 1
  }
  if last < 0 {
    return false
  }
  let at = host_date_ms(events[last].at)
  !at.is_nan() && now - at < START_RETRY_MS
}

///|
/// Consecutive start failures since the last loop event.
fn start_failures(events : Array[DerivedRow]) -> Int {
  let mut n = 0
  let mut i = events.length() - 1
  while i >= 0 {
    if events[i].event == EvS2ReviewRunFailed {
      n = n + 1
      i = i - 1
      continue
    }
    if is_review_event(events[i].event) || events[i].event == EvS2Result {
      break
    }
    i = i - 1
  }
  n
}

///|
/// Whether a lane goes through this loop.
fn is_loop_lane(events : Array[DerivedRow]) -> Bool {
  let mut found = false
  for e in events {
    if is_review_event(e.event) {
      found = true
    }
  }
  found
}

///|
/// One row of the loop's own tests: the lane, the event, and the time only, so a test says what the state machine
/// does rather than what a step wrote into the row.
fn review_test_row(event : String) -> DerivedRow {
  {
    idd_id: "IDD-1",
    event: derived_event_of(event),
    at: "2026-01-01T00:00:00.000Z",
    attrs: row_attrs_of(json_object([])),
  }
}

///|
test "a skipped round above a records wait that was never instructed does not close the review" {
  inspect(
    loop_state_name(
      review_loop_state([
        review_test_row("s2_result"),
        review_test_row("s2_records_conflict"),
        review_test_row("s2_review_merged_skipped"),
      ]),
    ),
    content=(
      #|awaiting_records_fix
    ),
  )
}

///|
test "a skipped round above a records wait whose instruction went out still waits for the executor" {
  inspect(
    loop_state_name(
      review_loop_state([
        review_test_row("s2_result"),
        review_test_row("s2_records_conflict"),
        review_test_row("s2_review_merged_skipped"),
        review_test_row("s2_records_instructed"),
      ]),
    ),
    content=(
      #|awaiting_records_fix
    ),
  )
}

///|
test "a skipped round above an answered records send-back closes the review" {
  inspect(
    loop_state_name(
      review_loop_state([
        review_test_row("s2_result"),
        review_test_row("s2_records_instructed"),
        review_test_row("s2_intent_checked"),
        review_test_row("s2_review_merged_skipped"),
      ]),
    ),
    content=(
      #|done
    ),
  )
}
