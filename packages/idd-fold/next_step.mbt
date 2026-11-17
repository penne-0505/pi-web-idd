// The review loop's next step: the leg a lane steps on, and the record that leg writes.
//
// The tick advances every lane's review loop by at most one step. Which step that is, and what the step writes on
// the ledger, are decided here, from the lane's rows and the facts the caller gathered (C-201-1). The caller runs
// the step: it starts the runs, writes the files and delivers the envelopes. What it does not do is decide.
//
// The answer is a closed type. A leg nobody wrote a handling for does not compile, and an event name nobody
// declared cannot be written (the MoonBit rules 3 and 4).

///|
/// The leg of the review loop a lane steps on next.
pub(all) enum NextLeg {
  /// the map: the route a large diff is read by
  Map
  /// the blind: the review round itself
  Blind
  /// the judgement: the triage that reads the blind's findings
  Triage
  /// the fix: what the judgement's accepted findings are sent as
  SendFix
  /// the confirm: what checks the fix
  Confirm
  /// the device check: what reads the lane's own screen
  Device
  /// the checks before the convergence: the repo's required checks at the head
  Checks
  /// the convergence: the lane's review is over
  Converge
  /// the hand to penne: the lane waits for a person
  Escalate
  /// a helper that stays in the TypeScript
  Helper
  /// nothing this tick
  Wait
}

///|
/// The event the next step writes.
pub(all) enum StepEvent {
  MapStarted
  MapDone
  MapDropped
  MapHeadMoved
  ReviewStarted
  ReviewFindings
  ReviewSkipped
  ReviewConverged
  ReviewEscalated
  TriageStarted
  TriageDone
  FixSent
  ConfirmStarted
  ConfirmDone
  DeviceStarted
  DeviceDone
  DeviceSkipped
  OrderReleased
  RecordsInstructed
  ChecksStarted
  ChecksDone
}

///|
/// What the loop does next.
pub(all) enum NextAction {
  /// write the record and stop
  Write
  /// start a run of the named stage and stop
  Start
  /// call the helper and stop
  Call
  /// do nothing this tick
  Nothing
}

///|
/// The run a leg started or waited for, as the runner's port answers it.
pub(all) struct StepRun {
  /// "running", "done" or "failed"
  state : String
  /// the failure's text
  error : String
  /// the routes the map drew
  routes : Array[Json]
  /// the report the run wrote, as markdown, or nothing when the runner told of none
  report_md : String?
  /// the report the run wrote, as a file, or nothing when the runner told of none
  report_json : String?
  /// the roles that stood in for the ones that were wanted
  fallbacks : Json
  /// the ids of the runs that were started
  run_ids : Array[String]
  /// the ids of the runs that read the whole diff
  whole_diff : Array[String]
  /// the runner told of the whole-diff runs it kept: an empty list it told of is not the same as none told of
  whole_diff_given : Bool
  /// the role each run read as
  run_roles : Array[String]
  /// the label each run read as
  run_labels : Array[String]
  /// the runner told of the labels: an empty list is not the same as none told of
  run_labels_given : Bool
  /// the findings the run read, as the runner reports them
  findings : Array[Json]
  /// why the run skipped what it was asked to check
  skipped : String?
  /// how many routes the round read
  route_count : Int?
  /// the routes did not fit in the round's copies
  routes_over_cap : Bool
}

///|
/// The facts the next step reads that the ledger does not hold. Every field is the caller's reading of the
/// outside world: the runner's port, the git, the policy and the slots. The answer is decided by the rows and
/// these alone, so the same ledger and the same facts always give the same step (C-201-2).
pub(all) struct StepFacts {
  /// the policy the tick reads
  policy : ReviewPolicy
  /// the review slot is declared
  review_on : Bool
  /// the device slot is declared
  device_on : Bool
  /// the map slot is declared
  map_on : Bool
  /// the blind's copies fit
  blind_fits : Bool
  /// the map's slot is free
  map_fits : Bool
  /// the triage's slot is free
  triage_fits : Bool
  /// the confirm's slot is free
  confirm_fits : Bool
  /// the lane's worktree, base and head
  at : At?
  /// the lane's risk, as its whole change reads it
  risk : Risk?
  /// the round the last review read
  since : Since?
  /// the round the mainline's merge alone would skip
  merge_only_skip : MergeOnlySkip?
  /// the final review the lane may skip
  final_skip : FinalSkip?
  /// the fixes the mainline brought since the last round
  merge_since : MergeSince?
  /// the mainline the lane merged in
  conflict_merge : ConflictMerge?
  /// the base the round reads after a conflict
  review_base : String?
  /// the depth of the round
  round_depth : Depth?
  /// the roles the round adds
  extras : Array[String]?
  /// why the map was not needed
  map_skipped : String?
  /// the repo's overview the round is shown
  overview : String?
  /// the pre-review merge's answer: "none", "busy" or "awaiting"
  pre_merge : String?
  /// the executor's work is still moving
  executor_wait : ExecutorWait?
  /// the runs the leg waits for or reads
  runs : Array[StepRun]
  /// the map run this step just started
  map_run : StepRun?
  /// the map was already asked for on this head: a start that named no run is not asked for again
  map_tried : Bool
  /// the round's copies fit the slot, counting the routes the map drew
  route_blind_fits : Bool
  /// the round adds the senior role and penne let its fallback run
  allow_high_fallback : Bool
  /// a final shown an increment would leave earlier changes unseen
  whole_for_unread : Bool
  /// the fix rounds the depth's table gives the round
  depth_fix_rounds : Int?
  /// the report a device check writes for a picture set it could not read
  report_path : String?
  /// the file naming what a confirm did not report on
  missing_file : String?
  /// the envelope the fix went out as
  envelope_id : String?
  /// the how-to-fix the reviewer wrote, by ref
  hows : Array[String]
  /// the refs the fix goes out for
  accepted_refs : Array[String]
  /// the boundary fixes the fix goes out with
  boundary_items : Array[Json]
  /// the refs the confirm was handed
  scope_refs : Array[String]
  /// the caller told of the list it handed the confirm: an empty list it told of is written, as the record always did
  scope_refs_given : Bool
  /// the boundary refs the confirm was handed
  boundary_refs : Array[String]
  /// the findings the judgement accepted
  accepted : Array[Json]
  /// the findings the judgement rejected
  rejected : Array[Json]
  /// the claims the judgement put to penne
  escalated_claims : Array[String]
  /// the reversals the judgement recorded
  oscillations : Array[Json]
  /// the marks of the lane's own records that show a tool refusing the means
  means : Array[Json]
  /// the device check's verdict
  verdict : Json?
  /// the judge's name
  judge : String
  /// the number of pictures the device check reads
  pictures : Int?
  /// the reason the device check's pictures are of another head
  stale_reason : String?
  /// the findings the device check found
  device_findings : Array[Json]
  /// the refs the confirm left open
  unresolved : Array[String]
  /// the refs the confirm did not report on
  missing : Array[String]
  /// the severity of every ref the confirm knew of
  severities : Array[(String, String)]
  /// the errors the records check found
  records_errors : Array[Json]
  /// the head the records check found the errors on
  records_head : String
  /// the envelope the instruction went out as
  queued : Bool
  /// the repo runs its required checks at the head before the loop converges (`checks_before_converge`)
  checks_on : Bool
  /// what a convergence the caller decided (a final it skipped) writes, carried past the checks
  converge_attrs : Json?
  /// what the checks' run found, one row a check
  check_rows : Array[Json]
  /// the commit the failures were compared at (the public base's tip, or the lane's base when the run checked the
  /// head's own tree)
  check_base : String?
  /// the state the checks hold back, when it is not the convergence (a round the mainline's merge alone skips)
  resume_state : Json?
  /// why a run the repo's heavy checks kept out has waited too long: it is then put to penne
  check_wait_over : String?
}

///|
/// The policy the tick reads.
pub(all) struct ReviewPolicy {
  close_on_must : Bool
  close_on_fix : Bool
  max_fix_rounds : Int?
  max_should_fix : Int?
  should_default : String
  high_risk_when : String
  high_risk_extra : Int
  high_risk_roles : Array[String]
  final_scope : String
  after_merge : String
  final_when : String
}

///|
/// The lane's worktree, base and head.
pub(all) struct At {
  worktree : String
  base : String
  head : String
}

///|
/// The lane's risk, as its whole change reads it.
pub(all) struct Risk {
  risk : String
  /// the declared risky paths the lane's change touched, in the shape the record keeps them
  hits : Json
  high : Bool
}

///|
/// The round the last review read.
pub(all) struct Since {
  index : Int
  head : String
}

///|
/// The round the mainline's merge alone would skip.
pub(all) struct MergeOnlySkip {
  head : String
}

///|
/// The final review the lane may skip.
pub(all) struct FinalSkip {
  settled : String
}

///|
/// The fixes the mainline brought since the last round.
pub(all) struct MergeSince {
  merge : String
}

///|
/// The mainline the lane merged in.
pub(all) struct ConflictMerge {
  mainline : String
  merge : String
  record_only : Bool
}

///|
/// The executor's work is still moving.
pub(all) struct ExecutorWait {
  reason : String
  head : String
}

///|
/// A run out of the runner's port's answer.
fn step_run_of(value : Json) -> StepRun {
  {
    // a run the runner says nothing of has not finished: the loop reads a state it was not told as running
    state: match present_text(field(value, "state")) {
      Some(text) => text
      None => "running"
    },
    error: text_of(field(value, "error")),
    routes: array_of(field(value, "routes")),
    report_md: present_text(field(value, "reportMd")),
    report_json: present_text(field(value, "reportJson")),
    fallbacks: field(value, "fallbacks"),
    run_ids: strings_of(field(value, "runIds")),
    whole_diff: strings_of(field(value, "wholeDiff")),
    whole_diff_given: has_key(value, "wholeDiff"),
    run_roles: strings_of(field(value, "runRoles")),
    run_labels: strings_of(field(value, "runLabels")),
    run_labels_given: has_key(value, "runLabels"),
    findings: array_of(field(value, "findings")),
    skipped: present_text(field(value, "skipped")),
    route_count: match int_of(field(value, "routeCount")) {
      Some(count) => Some(count)
      None => None
    },
    routes_over_cap: js_truthy(field(value, "routesOverCap")),
  }
}

///|
/// A policy out of the caller's answer.
fn review_policy_of(value : Json) -> ReviewPolicy {
  let extras = field(value, "extras")
  let roles = field(value, "extraRoles")
  {
    close_on_must: js_truthy(field(value, "closeOnMust")),
    close_on_fix: js_truthy(field(value, "closeOnFix")),
    max_fix_rounds: match int_of(field(value, "maxFixRounds")) {
      Some(rounds) => Some(rounds)
      None => None
    },
    max_should_fix: match int_of(field(value, "maxShouldFix")) {
      Some(fixes) => Some(fixes)
      None => None
    },
    should_default: text_of(field(value, "shouldDefault")),
    high_risk_when: text_of(field(value, "highRiskWhen")),
    high_risk_extra: js_num(field(extras, "high_risk")).to_int(),
    high_risk_roles: strings_of(field(roles, "high_risk")),
    final_scope: text_of(field(value, "finalScope")),
    after_merge: text_of(field(value, "afterMerge")),
    final_when: text_of(field(value, "finalWhen")),
  }
}

///|
/// The facts as the caller hands them in.
fn step_facts_of(args : Json) -> StepFacts {
  let runs : Array[StepRun] = []
  for item in array_of(field(args, "runs")) {
    runs.push(step_run_of(item))
  }
  let map_run = match field(args, "mapRun") {
    Json::Object(_) => Some(step_run_of(field(args, "mapRun")))
    _ => None
  }
  let severities : Array[(String, String)] = []
  for item in array_of(field(args, "severities")) {
    severities.push(
      (text_of(field(item, "ref")), text_of(field(item, "severity"))),
    )
  }
  {
    policy: review_policy_of(field(args, "policy")),
    review_on: js_truthy(field(args, "reviewOn")),
    device_on: js_truthy(field(args, "deviceOn")),
    map_on: js_truthy(field(args, "mapOn")),
    blind_fits: js_truthy(field(args, "blindFits")),
    map_fits: js_truthy(field(args, "mapFits")),
    triage_fits: js_truthy(field(args, "triageFits")),
    confirm_fits: js_truthy(field(args, "confirmFits")),
    at: match field(args, "at") {
      Json::Object(_) =>
        Some({
          worktree: text_of(field(field(args, "at"), "worktree")),
          base: text_of(field(field(args, "at"), "base")),
          head: text_of(field(field(args, "at"), "head")),
        })
      _ => None
    },
    risk: match field(args, "risk") {
      Json::Object(_) =>
        Some({
          risk: text_of(field(field(args, "risk"), "risk")),
          hits: field(field(args, "risk"), "hits"),
          high: js_truthy(field(field(args, "risk"), "high")),
        })
      _ => None
    },
    since: match field(args, "since") {
      Json::Object(_) =>
        Some({
          index: js_num(field(field(args, "since"), "index")).to_int(),
          head: text_of(field(field(args, "since"), "head")),
        })
      _ => None
    },
    merge_only_skip: match field(args, "mergeOnlySkip") {
      Json::Object(_) =>
        Some({ head: text_of(field(field(args, "mergeOnlySkip"), "head")), })
      _ => None
    },
    final_skip: match field(args, "finalSkip") {
      Json::Object(_) =>
        Some({ settled: text_of(field(field(args, "finalSkip"), "settled")), })
      _ => None
    },
    merge_since: match field(args, "mergeSince") {
      Json::Object(_) =>
        Some({ merge: text_of(field(field(args, "mergeSince"), "merge")), })
      _ => None
    },
    conflict_merge: match field(args, "conflictMerge") {
      Json::Object(_) =>
        Some({
          mainline: text_of(field(field(args, "conflictMerge"), "mainline")),
          merge: text_of(field(field(args, "conflictMerge"), "merge")),
          record_only: js_truthy(
            field(field(args, "conflictMerge"), "recordOnly"),
          ),
        })
      _ => None
    },
    review_base: match field(args, "reviewBase") {
      Json::Null => None
      other => Some(js_string(other))
    },
    round_depth: depth_of(field(args, "roundDepth")),
    extras: match field(args, "extras") {
      Json::Array(_) => Some(strings_of(field(args, "extras")))
      _ => None
    },
    map_skipped: match field(args, "mapSkipped") {
      Json::Null => None
      other => Some(js_string(other))
    },
    overview: match field(args, "overview") {
      Json::Null => None
      other => Some(js_string(other))
    },
    pre_merge: match field(args, "preMerge") {
      Json::Null => None
      other => Some(js_string(other))
    },
    executor_wait: match field(args, "executorWait") {
      Json::Object(_) =>
        Some({
          reason: text_of(field(field(args, "executorWait"), "reason")),
          head: text_of(field(field(args, "executorWait"), "head")),
        })
      _ => None
    },
    runs,
    map_run,
    map_tried: js_truthy(field(args, "mapTried")),
    route_blind_fits: js_truthy(field(args, "routeBlindFits")),
    allow_high_fallback: js_truthy(field(args, "allowHighFallback")),
    whole_for_unread: js_truthy(field(args, "wholeForUnread")),
    depth_fix_rounds: match int_of(field(args, "depthFixRounds")) {
      Some(rounds) => Some(rounds)
      None => None
    },
    report_path: present_text(field(args, "reportPath")),
    missing_file: present_text(field(args, "missingFile")),
    envelope_id: match field(args, "envelopeId") {
      Json::Null => None
      other => Some(js_string(other))
    },
    hows: strings_of(field(args, "hows")),
    accepted_refs: strings_of(field(args, "acceptedRefs")),
    boundary_items: array_of(field(args, "boundaryItems")),
    scope_refs: strings_of(field(args, "scopeRefs")),
    scope_refs_given: js_truthy(field(args, "scopeRefsGiven")),
    boundary_refs: strings_of(field(args, "boundaryRefs")),
    accepted: array_of(field(args, "accepted")),
    rejected: array_of(field(args, "rejected")),
    escalated_claims: strings_of(field(args, "escalatedClaims")),
    oscillations: array_of(field(args, "oscillations")),
    means: array_of(field(args, "means")),
    verdict: match field(args, "verdict") {
      Json::Null => None
      other => Some(other)
    },
    judge: text_of(field(args, "judge")),
    pictures: match int_of(field(args, "pictures")) {
      Some(count) => Some(count)
      None => None
    },
    stale_reason: match field(args, "staleReason") {
      Json::Null => None
      other => Some(js_string(other))
    },
    device_findings: array_of(field(args, "deviceFindings")),
    unresolved: strings_of(field(args, "unresolved")),
    missing: strings_of(field(args, "missing")),
    severities,
    records_errors: array_of(field(args, "recordsErrors")),
    records_head: text_of(field(args, "recordsHead")),
    queued: js_truthy(field(args, "queued")),
    checks_on: js_truthy(field(args, "checksOn")),
    converge_attrs: match field(args, "convergeAttrs") {
      Json::Object(_) => Some(field(args, "convergeAttrs"))
      _ => None
    },
    check_rows: array_of(field(args, "checkRows")),
    check_base: present_text(field(args, "checkBase")),
    resume_state: match field(args, "resumeState") {
      Json::Object(_) => Some(field(args, "resumeState"))
      _ => None
    },
    check_wait_over: present_text(field(args, "checkWaitOver")),
  }
}

///|
/// The leg's own name.
fn next_leg_text(leg : NextLeg) -> String {
  match leg {
    Map => "map"
    Blind => "blind"
    Triage => "triage"
    SendFix => "send_fix"
    Confirm => "confirm"
    Device => "device"
    Checks => "checks"
    Converge => "converge"
    Escalate => "escalate"
    Helper => "helper"
    Wait => "wait"
  }
}

///|
/// The event's own name.
fn step_event_text(event : StepEvent) -> String {
  match event {
    MapStarted => "s2_map_started"
    MapDone => "s2_map_done"
    MapDropped => "s2_map_dropped"
    MapHeadMoved => "s2_map_head_moved"
    ReviewStarted => "s2_review_started"
    ReviewFindings => "s2_review_findings"
    ReviewSkipped => "s2_review_skipped"
    ReviewConverged => "s2_review_converged"
    ReviewEscalated => "s2_review_escalated"
    TriageStarted => "s2_triage_started"
    TriageDone => "s2_triage_done"
    FixSent => "s2_fix_sent"
    ConfirmStarted => "s2_confirm_started"
    ConfirmDone => "s2_confirm_done"
    DeviceStarted => "s2_device_started"
    DeviceDone => "s2_device_done"
    DeviceSkipped => "s2_device_skipped"
    OrderReleased => "s2_order_released"
    RecordsInstructed => "s2_records_instructed"
    ChecksStarted => "s2_checks_started"
    ChecksDone => "s2_checks_done"
  }
}

///|
/// The action's own name.
fn next_action_text(action : NextAction) -> String {
  match action {
    Write => "write"
    Start => "start"
    Call => "call"
    Nothing => "nothing"
  }
}

///|
/// The answer, as the caller reads it.
fn next_step_json(
  leg : NextLeg,
  action : NextAction,
  event : StepEvent?,
  attrs : Json,
  stage : String?,
) -> Json {
  let fields : Array[(String, Json)] = [
    ("leg", Json::string(next_leg_text(leg))),
    ("action", Json::string(next_action_text(action))),
    ("attrs", attrs),
  ]
  match event {
    Some(written) =>
      fields.push(("event", Json::string(step_event_text(written))))
    None => ()
  }
  match stage {
    Some(name) => fields.push(("stage", Json::string(name)))
    None => ()
  }
  json_object(fields)
}

///|
/// The answer of a step that writes nothing.
fn next_nothing(leg : NextLeg) -> Json {
  next_step_json(leg, Nothing, None, Json::object(Map([])), None)
}

///|
/// The answer of a step that writes a record.
fn next_write(leg : NextLeg, event : StepEvent, attrs : Json) -> Json {
  next_step_json(leg, Write, Some(event), attrs, None)
}

///|
/// The answer of a step that starts a run.
fn next_start(leg : NextLeg, stage : String) -> Json {
  next_step_json(leg, Start, None, Json::object(Map([])), Some(stage))
}

///|
/// The answer of a step that calls a helper.
fn next_call(leg : NextLeg) -> Json {
  next_step_json(leg, Call, None, Json::object(Map([])), None)
}

///|
/// The index of the last row of the kind, or -1.
fn last_row_of(events : Array[DerivedRow], kind : DerivedEvent) -> Int {
  let mut i = events.length() - 1
  while i >= 0 {
    if events[i].event == kind {
      return i
    }
    i = i - 1
  }
  -1
}

///|
/// The attrs a step writes, with the fields that are not there left out.
fn attrs_of(fields : Array[(String, Json)]) -> Json {
  json_object(fields)
}

///|
/// A text field the caller gave, or nothing. An absent field and an empty text are different things: the record
/// leaves out the one the runner did not tell of, and keeps the empty one it did.
fn present_text(value : Json) -> String? {
  match value {
    Json::String(text) => Some(text)
    _ => None
  }
}

///|
/// Whether the field should be written at all.
fn push_present(
  fields : Array[(String, Json)],
  key : String,
  value : String?,
) -> Unit {
  match value {
    Some(text) => fields.push((key, Json::string(text)))
    None => ()
  }
}

///|
/// The run's report, written under the name the record gives it. A run that wrote no report leaves the field out.
fn push_reports(fields : Array[(String, Json)], run : StepRun) -> Unit {
  push_present(fields, "report_md", run.report_md)
  push_present(fields, "report_json", run.report_json)
}

///|
/// The roles that stood in for the ones that were wanted. A round every wanted role ran leaves the field out: the
/// absence is what reads as "no role changed", so an empty list is not written.
fn push_fallbacks(fields : Array[(String, Json)], fallbacks : Json) -> Unit {
  match fallbacks {
    Json::Array(items) =>
      if items.length() > 0 {
        fields.push(("fallbacks", fallbacks))
      }
    _ => ()
  }
}

///|
/// The blind's findings: the files the finished runs wrote, the runs that did not finish, and the routes the
/// whole-diff blind left unread.
fn blind_findings(
  events : Array[DerivedRow],
  facts : StepFacts,
  kind : String,
  round : Double,
) -> Json {
  let files : Array[Json] = []
  let fallbacks : Array[Json] = []
  let mut failed = 0
  let mut done = 0
  for run in facts.runs {
    if run.state == "done" {
      done = done + 1
      match run.report_json {
        Some(path) => files.push(Json::string(path))
        None => ()
      }
      match run.fallbacks {
        Json::Array(items) =>
          for item in items {
            fallbacks.push(item)
          }
        _ => ()
      }
    } else {
      failed = failed + 1
    }
  }
  let fields : Array[(String, Json)] = [
    ("kind", Json::string(kind)),
    ("round", Json::number(round)),
    ("files", Json::array(files)),
    ("failed_runs", Json::number(failed.to_double())),
  ]
  let started = last_row_of(events, EvS2ReviewStarted)
  let unread = unread_routes_of(events, facts, started)
  if unread.length() > 0 {
    fields.push(("unread_routes", Json::array(unread.map(Json::string))))
  }
  if fallbacks.length() > 0 {
    fields.push(("fallbacks", Json::array(fallbacks)))
  }
  attrs_of(fields)
}

///|
/// The label each run of the round's start carries, in the order the runs were started. A round that wrote none has
/// no label for any run.
fn started_run_labels(
  events : Array[DerivedRow],
  started : Int,
) -> Array[String] {
  let out : Array[String] = []
  if started < 0 {
    return out
  }
  match events[started].attrs.run_labels {
    Json::Array(items) =>
      for item in items {
        match item {
          Json::String(text) => out.push(text)
          _ => ()
        }
      }
    _ => ()
  }
  out
}

///|
/// The label of the runs of a round's spec check: they read the lane against its plan, beside the blinds, and a round
/// is judged on its blinds having run (C-223-2).
let spec_label : String = "spec"

///|
/// Whether the run at this index of the round's start is a spec check.
fn is_spec_run(labels : Array[String], index : Int) -> Bool {
  index < labels.length() && labels[index] == spec_label
}

///|
/// The routes the whole-diff blind left unread: a route whose own run did not finish, and the whole-diff run did
/// not stand in for it.
fn unread_routes_of(
  events : Array[DerivedRow],
  facts : StepFacts,
  started : Int,
) -> Array[String] {
  let out : Array[String] = []
  if started < 0 {
    return out
  }
  let whole = events[started].attrs.whole_run_ids
  match whole {
    Json::Array(_) => ()
    _ => return out
  }
  let label_list = started_run_labels(events, started)
  let mut i = 0
  while i < facts.runs.length() {
    let run = facts.runs[i]
    let whole_run = match whole {
      Json::Array(items) => {
        let mut found = false
        for item in items {
          if js_string(item) == run_id_of(run) {
            found = true
          }
        }
        found
      }
      _ => false
    }
    if run.state != "done" && !whole_run && !is_spec_run(label_list, i) {
      if i < label_list.length() {
        out.push(label_list[i])
      } else if run.run_ids.length() > 0 {
        out.push(run.run_ids[0])
      }
    }
    i = i + 1
  }
  out
}

///|
/// The device check's record: the findings it read, the files it wrote, and the judge that read them.
fn device_done_attrs(facts : StepFacts, run : StepRun, round : Double) -> Json {
  let fields : Array[(String, Json)] = [
    ("round", Json::number(round)),
    ("blocking", Json::number(blocking_of(run.findings).to_double())),
  ]
  match run.report_json {
    Some(path) => fields.push(("files", Json::array([Json::string(path)])))
    None => ()
  }
  if facts.judge != "" {
    fields.push(("judge", Json::string(facts.judge)))
  }
  // a person judges their lane: the role's findings stay on the record for their submit card, never sent to a fix
  if facts.judge == "human" {
    fields.push(("findings", Json::array(facts.device_findings)))
  }
  match facts.stale_reason {
    Some(reason) => fields.push(("stale_reason", Json::string(reason)))
    None => ()
  }
  push_present(fields, "report_md", run.report_md)
  push_present(fields, "skipped_reason", run.skipped)
  push_fallbacks(fields, run.fallbacks)
  attrs_of(fields)
}

///|
/// The findings of a finished run that block: the ones whose severity is must.
fn blocking_of(findings : Array[Json]) -> Int {
  let mut blocking = 0
  for finding in findings {
    let severity = text_of(field(finding, "severity"))
    if severity == "must" || severity == "should" {
      blocking = blocking + 1
    }
  }
  blocking
}

///|
/// The id of the run a step names, or the empty text one a run without an id is written as (the runner's answer
/// a start reads is not assumed to carry one).
fn run_id_of(run : StepRun) -> String {
  if run.run_ids.length() > 0 {
    run.run_ids[0]
  } else {
    ""
  }
}

///|
/// The fix rounds a pass runs when the config says nothing: the legacy cap the loop has always used.
let legacy_max_fix_rounds : Int = 8

///|
/// The text of a depth.
fn step_depth_text(depth : Depth) -> String {
  match depth {
    Shallow => "shallow"
    Standard => "standard"
    Deep => "deep"
  }
}

///|
/// Whether a run's label names a map route (`r1`, `r12`): the labels the round's mapped copies are counted by.
fn is_route_label(text : String) -> Bool {
  if text.length() < 2 || text.at(0) != 'r' {
    return false
  }
  let mut i = 1
  while i < text.length() {
    let code = text.at(i).to_int()
    if code < 48 || code > 57 {
      return false
    }
    i = i + 1
  }
  true
}

///|
/// The depth a lane recorded on its plan: the last `s1_ready` before its `s1_go`, as the loop reads it.
fn recorded_depth_of(events : Array[DerivedRow]) -> Depth? {
  let mut go = -1
  let mut i = events.length() - 1
  while i >= 0 {
    if events[i].event == EvS1Go {
      go = i
      break
    }
    i = i - 1
  }
  let from = if go >= 0 { go - 1 } else { events.length() - 1 }
  let mut j = from
  while j >= 0 {
    let e = events[j]
    if e.event == EvS1Ready {
      return depth_of(e.attrs.depth)
    }
    j = j - 1
  }
  None
}

///|
/// The routes the round is shown: the map's, when this round is one the map is read for.
fn start_routes(mapped : Bool, map : Json?) -> Array[Json] {
  if !mapped {
    return []
  }
  match map {
    Some(value) => array_of(field(value, "routes"))
    None => []
  }
}

///|
/// The head the map was drawn at, when the state carries one.
fn map_head_of(map : Json?) -> String? {
  match map {
    Some(value) => non_empty_text(field(value, "head"))
    None => None
  }
}

///|
/// The blind's start: whether the mainline's map runs first, the round a head that moved is drawn again for, the
/// review a slot nobody declared is skipped for, and the record the start writes.
fn next_start_blind(
  kind : ReviewKind,
  round : Double,
  map : Json?,
  allow_high_fallback : Bool,
  events : Array[DerivedRow],
  facts : StepFacts,
) -> Json {
  let kind_text = review_kind_text(kind)
  // the kept check went with R2: a kept start a stored state still names converges as an undeclared check did
  if kind_text == "kept" {
    return next_write(
      Converge,
      ReviewConverged,
      attrs_of([
        (
          "kept_skipped",
          Json::string("守られたかの確かめ（R2）を外した"),
        ),
      ]),
    )
  }
  // the review slot is not declared and no blind ever ran: the round is skipped, and the lane goes on to S3
  if !facts.review_on && !blind_ever_ran(events) {
    return next_write(
      Blind,
      ReviewSkipped,
      attrs_of([("reason", Json::string("pipeline.review_blind が未宣言"))]),
    )
  }
  // the fix the last round sent left the head where that round read it: the round would read the same code again, so
  // penne decides (a continue sends the fix again, an accept closes the review) rather than the loop reviewing it twice
  if kind_text == "blind" {
    match facts.at {
      Some(a) =>
        if unmoved_after_fix(events, a.head) {
          return next_write(
            Escalate,
            ReviewEscalated,
            attrs_of([
              (
                "reason",
                Json::string(
                  "手直しで head が変わらなかった（" +
                  a.head +
                  "）。同じ head をもう一度レビューしない。続ける（手直しを送り直す）か、受け入れるか、自分で直すかを決めてください",
                ),
              ),
              ("head", Json::string(a.head)),
            ]),
          )
        }
      None => ()
    }
  }
  // the head the map was drawn at moved: the map is drawn again before the round reads the diff
  if kind_text == "blind" {
    match facts.at {
      Some(a) =>
        match map_head_of(map) {
          Some(head) =>
            if head != a.head {
              return next_write(
                Blind,
                MapHeadMoved,
                attrs_of([
                  ("kind", Json::string(kind_text)),
                  ("round", Json::number(round)),
                  ("map_head", Json::string(head)),
                  ("head", Json::string(a.head)),
                ]),
              )
            }
          None => ()
        }
      None => ()
    }
  }
  if !facts.blind_fits {
    return next_nothing(Blind)
  }
  // without the lane's own revs the start readings cannot be taken: the start is named, as it always was, and
  // the caller's own read is what fails the stage
  let at = match facts.at {
    Some(found) => found
    None =>
      return next_start(
        Blind,
        if kind_text == "final" {
          "final"
        } else {
          "blind"
        },
      )
  }
  // the map run this step started answers the map's own record
  match facts.map_run {
    Some(run) =>
      if run.state == "failed" {
        return next_write(
          Blind,
          MapDone,
          attrs_of([
            ("kind", Json::string(kind_text)),
            ("round", Json::number(round)),
            ("failed", Json::boolean(true)),
            ("error", Json::string(run.error)),
            ("routes", Json::array([])),
          ]),
        )
      } else if run.run_ids.length() > 0 {
        let fields : Array[(String, Json)] = [
          ("kind", Json::string(kind_text)),
          ("round", Json::number(round)),
          ("run_id", Json::string(run_id_of(run))),
          ("head", Json::string(at.head)),
        ]
        push_fallbacks(fields, run.fallbacks)
        return next_write(Blind, MapStarted, attrs_of(fields))
      }
    None => ()
  }
  // the map runs before the pass's first blind (never before a conflict round): a diff the runner says needs no
  // map, or a slot that cannot take it, starts the blind without one
  let conflict = match facts.conflict_merge {
    Some(m) => m.record_only
    None => false
  }
  let mapped = kind_text == "blind" && !conflict && first_blind_of_pass(events)
  let skipped_map = match facts.map_skipped {
    Some(text) => text.length() > 0
    None => false
  }
  if mapped && map is None && facts.map_on && !facts.map_tried && !skipped_map {
    if !facts.map_fits {
      return next_nothing(Blind)
    }
    return next_start(Blind, "map")
  }
  let routes = start_routes(mapped, map)
  if routes.length() > 0 && !facts.route_blind_fits {
    return next_nothing(Blind)
  }
  if facts.runs.length() > 0 {
    return next_write(
      Blind,
      ReviewStarted,
      review_started_attrs(
        kind, round, at, map, mapped, allow_high_fallback, events, facts,
      ),
    )
  }
  next_start(Blind, if kind_text == "final" { "final" } else { "blind" })
}

///|
/// Whether the round about to start comes right after a fix (the loop's last row is the fix, and the executor's result
/// is in) and the head is the one the last round read: the fix changed nothing a review has not read. A lane whose
/// last round has no head on record is never read as unmoved.
fn unmoved_after_fix(events : Array[DerivedRow], head : String) -> Bool {
  if head == "" || last_loop_event(events) != EvS2FixSent {
    return false
  }
  let mut s = events.length() - 1
  while s >= 0 {
    if events[s].event == EvS2ReviewStarted &&
      !is_text(events[s].attrs.kind, "device") {
      break
    }
    s = s - 1
  }
  if s < 0 {
    return false
  }
  match events[s].attrs.head {
    Json::String(read) => read == head
    _ => false
  }
}

///|
/// The record a round's start writes: the runs it started, the diff the round reads, and the pass's shape.
fn review_started_attrs(
  kind : ReviewKind,
  round : Double,
  at : At,
  map : Json?,
  mapped : Bool,
  allow_high_fallback : Bool,
  events : Array[DerivedRow],
  facts : StepFacts,
) -> Json {
  let run = facts.runs[0]
  let kind_text = review_kind_text(kind)
  let fields : Array[(String, Json)] = [
    ("kind", Json::string(kind_text)),
    ("round", Json::number(round)),
    ("run_ids", Json::array(run.run_ids.map(Json::string))),
    ("head", Json::string(at.head)),
  ]
  if run.run_roles.length() > 0 {
    fields.push(("run_roles", Json::array(run.run_roles.map(Json::string))))
  }
  if run.run_labels.length() > 0 {
    fields.push(("run_labels", Json::array(run.run_labels.map(Json::string))))
  }
  let extras = match facts.extras {
    Some(list) => list
    None => []
  }
  let new_high = facts.policy.high_risk_when == "last" &&
    facts.policy.high_risk_extra > 0
  if new_high && extras.contains("high_risk") && allow_high_fallback {
    fields.push(("high_allowed", Json::boolean(true)))
  }
  let routes = start_routes(mapped, map)
  if routes.length() > 0 {
    let mapped_routes = if run.run_labels_given {
      let mut count = 0
      for label in run.run_labels {
        if is_route_label(label) {
          count = count + 1
        }
      }
      count
    } else {
      routes.length()
    }
    fields.push(("mapped_routes", Json::number(mapped_routes.to_double())))
    let route_count = match run.route_count {
      Some(count) => count
      None => routes.length()
    }
    fields.push(("route_count", Json::number(route_count.to_double())))
    if run.routes_over_cap {
      fields.push(("routes_over_cap", Json::boolean(true)))
    }
    let whole = if run.whole_diff_given { run.whole_diff } else { run.run_ids }
    fields.push(("whole_run_ids", Json::array(whole.map(Json::string))))
  }
  match facts.map_skipped {
    Some(text) =>
      if text.length() > 0 {
        fields.push(("map_skipped", Json::string(text)))
      }
    None => ()
  }
  if extras.length() > 0 {
    fields.push(("extras", Json::array(extras.map(Json::string))))
  }
  // the diff the round reads: the fixes since the last round, or the hunks a mainline merge resolved
  if kind_text == "final" &&
    facts.policy.final_scope == "increment" &&
    !facts.whole_for_unread {
    match facts.since {
      Some(since) =>
        if since.head != at.head {
          fields.push(("diff_base", Json::string(since.head)))
          match facts.merge_since {
            Some(m) => fields.push(("merge", Json::string(m.merge)))
            None => ()
          }
          fields.push(("diff_scope", Json::string("increment")))
        }
      None => ()
    }
  }
  if kind_text == "blind" && facts.policy.after_merge == "conflict" {
    match facts.since {
      Some(_) =>
        match facts.conflict_merge {
          Some(m) => {
            match facts.review_base {
              Some(base) => fields.push(("review_base", Json::string(base)))
              None => ()
            }
            fields.push(("merge", Json::string(m.merge)))
            if m.record_only {
              fields.push(("diff_scope", Json::string("conflict")))
            }
          }
          None => ()
        }
      None => ()
    }
  }
  // a depth-bearing lane's first blind records the depth the pass runs under
  if kind_text == "blind" &&
    first_blind_of_pass(events) &&
    recorded_depth_of(events) is Some(_) {
    match facts.round_depth {
      Some(depth) => {
        fields.push(("depth", Json::string(step_depth_text(depth))))
        match facts.depth_fix_rounds {
          Some(rounds) =>
            fields.push(("max_fix_rounds", Json::number(rounds.to_double())))
          None => ()
        }
        fields.push(("close_on", Json::string("must")))
      }
      None => ()
    }
  }
  // a pass with no depth closes the way the config says, recorded when the pass begins
  if kind_text == "blind" &&
    pass_policy(events, events.length() - 1).depth is None &&
    !(recorded_depth_of(events) is Some(_) && first_blind_of_pass(events)) {
    match facts.policy.max_fix_rounds {
      Some(cap) =>
        if cap != legacy_max_fix_rounds {
          fields.push(("max_fix_rounds", Json::number(cap.to_double())))
        }
      None => ()
    }
    if facts.policy.should_default == "followup" {
      fields.push(("close_on", Json::string("must")))
    }
    if facts.policy.should_default == "triage" {
      fields.push(("close_on", Json::string("must_and_fix")))
      match facts.policy.max_should_fix {
        Some(cap) =>
          fields.push(("max_should_fix", Json::number(cap.to_double())))
        None => ()
      }
    }
  }
  match facts.risk {
    Some(risk) => {
      fields.push(("risk", Json::string(risk.risk)))
      match risk.hits {
        Json::Array(items) =>
          fields.push(
            ("risk_match", json_object([("hits", Json::array(items))])),
          )
        _ => ()
      }
    }
    None => ()
  }
  // the final review a continue with nothing left to fix started: the record says the loop came here without a fix
  if kind_text == "final" {
    match zero_fix_marks(events) {
      Some(marks) => {
        fields.push(("after_zero_fix", Json::boolean(true)))
        fields.push(("after_zero_fix_reason", field(marks, "reason")))
      }
      None => ()
    }
  }
  push_fallbacks(fields, run.fallbacks)
  attrs_of(fields)
}

///|
/// The event of the last row the review loop reads, or the lane's opening when there is none.
fn last_loop_event(events : Array[DerivedRow]) -> DerivedEvent {
  let mut i = events.length() - 1
  while i >= 0 {
    if is_review_event(events[i].event) {
      return events[i].event
    }
    i = i - 1
  }
  EvLaneOpen
}

///|
/// The next step of the review loop for one lane: the leg it steps on, and the record that leg writes.
fn next_step_of(
  events : Array[DerivedRow],
  facts : StepFacts,
) -> Json raise FoldError {
  next_step_for(review_loop_state(events), events, facts)
}

///|
/// The step of one state of the loop: the leg the lane steps on, and the record that leg writes. Every state the
/// loop has is answered here, so a state nobody wrote an answer for stops the build instead of falling into a
/// quiet default (the MoonBit rules 3).
fn next_step_for(
  state : LoopState,
  events : Array[DerivedRow],
  facts : StepFacts,
) -> Json raise FoldError {
  match state {
    LIdle => next_nothing(Wait)
    LDone => next_nothing(Wait)
    // the fix is with the executor, and the hand fix is with penne: the loop waits for either of them
    LFixing(_) => next_nothing(Wait)
    LAwaitingHandFix(_) => next_nothing(Wait)
    // a continue that left nothing to fix and ends the review here converges with its reason on record; any other
    // convergence writes none. A repo that runs its checks before the convergence runs them first
    LConverge => converge_step(events, facts)
    LRunningChecks(run_id, head) => checks_run_step(run_id, head, facts)
    LEscalated(reason, retry, quota) => {
      // a High role's window wait is tried again on each tick, without penne (DEC-2766): the state it stopped in is
      // the state it steps in, and the same reader answers it
      match quota {
        Some(_) =>
          match retry {
            Some(stored) => return next_stored_step(stored, events, facts)
            None => ()
          }
        None => ()
      }
      // the stop is on record already when the loop's own last row is the stop: a row that only notes something on
      // the lane (a judge's note, a window wait) does not move the loop, so it makes no new stop
      if last_loop_event(events) == EvS2ReviewEscalated {
        next_nothing(Escalate)
      } else {
        let fields : Array[(String, Json)] = [("reason", Json::string(reason))]
        match retry {
          Some(state) => fields.push(("retry_state", state))
          None => ()
        }
        next_write(Escalate, ReviewEscalated, attrs_of(fields))
      }
    }
    LAwaitingOrder(_, _) =>
      next_write(
        Blind,
        OrderReleased,
        attrs_of([
          ("reason", Json::string("pipeline.review_blind が未宣言")),
        ]),
      )
    LAwaitingMerge(_) => next_call(Helper)
    LAwaitingRecordsFix(_) => {
      let conflict = last_row_of(events, EvS2RecordsConflict)
      let instructed = last_row_of(events, EvS2RecordsInstructed)
      if conflict < 0 || (instructed >= 0 && instructed > conflict) {
        next_nothing(Helper)
      } else if facts.queued {
        next_write(
          Helper,
          RecordsInstructed,
          attrs_of([
            ("head", Json::string(facts.records_head)),
            ("errors", Json::array(facts.records_errors)),
          ]),
        )
      } else {
        next_call(Helper)
      }
    }
    LRecheckIntent(_) => next_call(Helper)
    LRunningMap(kind, round, _, head) => {
      let status = if facts.runs.length() == 0 {
        None
      } else {
        Some(facts.runs[0])
      }
      match status {
        None => next_nothing(Map)
        Some(run) =>
          if run.state == "running" {
            next_nothing(Map)
          } else {
            let fields : Array[(String, Json)] = [
              ("kind", Json::string(review_kind_text(kind))),
              ("round", Json::number(round)),
            ]
            if run.state == "failed" {
              fields.push(("failed", Json::boolean(true)))
              fields.push(("error", Json::string(run.error)))
              fields.push(("routes", Json::array([])))
            } else {
              fields.push(("routes", Json::array(run.routes)))
              push_reports(fields, run)
            }
            match head {
              Some(at) => fields.push(("head", Json::string(at)))
              None => ()
            }
            if run.state == "done" {
              push_fallbacks(fields, run.fallbacks)
            }
            next_write(Map, MapDone, attrs_of(fields))
          }
      }
    }
    LRunningBlind(kind, round, _) =>
      next_running_blind(events, facts, text_of(kind), round)
    LRunningDevice(round, _) => {
      let status = if facts.runs.length() == 0 {
        None
      } else {
        Some(facts.runs[0])
      }
      match status {
        None => next_nothing(Device)
        Some(run) =>
          if run.state == "running" {
            next_nothing(Device)
          } else if run.state == "failed" {
            next_write(
              Device,
              DeviceDone,
              attrs_of([
                ("round", Json::number(round)),
                ("failed", Json::boolean(true)),
                ("error", Json::string(run.error)),
              ]),
            )
          } else {
            next_write(Device, DeviceDone, device_done_attrs(facts, run, round))
          }
      }
    }
    LRunningTriage(kind, round, _) => {
      let status = if facts.runs.length() == 0 {
        None
      } else {
        Some(facts.runs[0])
      }
      match status {
        None => next_nothing(Triage)
        Some(run) =>
          if run.state == "running" {
            next_nothing(Triage)
          } else if run.state == "failed" {
            next_write(
              Triage,
              TriageDone,
              attrs_of([
                ("kind", Json::string(text_of(kind))),
                ("round", Json::number(round)),
                ("failed", Json::boolean(true)),
                ("error", Json::string(run.error)),
              ]),
            )
          } else {
            let fields : Array[(String, Json)] = [
              ("kind", Json::string(text_of(kind))),
              ("round", Json::number(round)),
            ]
            match run.report_md {
              Some(path) => fields.push(("report_md", Json::string(path)))
              None => ()
            }
            push_fallbacks(fields, run.fallbacks)
            fields.push(("accepted", Json::array(facts.accepted)))
            fields.push(("rejected", Json::array(facts.rejected)))
            fields.push(
              (
                "escalated_claims",
                Json::array(facts.escalated_claims.map(Json::string)),
              ),
            )
            if facts.oscillations.length() > 0 {
              fields.push(("oscillations", Json::array(facts.oscillations)))
            }
            next_write(Triage, TriageDone, attrs_of(fields))
          }
      }
    }
    LRunningConfirm(round, _) => {
      let status = if facts.runs.length() == 0 {
        None
      } else {
        Some(facts.runs[0])
      }
      match status {
        None => next_nothing(Confirm)
        Some(run) =>
          if run.state == "running" {
            next_nothing(Confirm)
          } else if run.state == "failed" {
            next_write(
              Confirm,
              ConfirmDone,
              attrs_of([
                ("round", Json::number(round)),
                ("failed", Json::boolean(true)),
                ("error", Json::string(run.error)),
              ]),
            )
          } else {
            next_write(
              Confirm,
              ConfirmDone,
              confirm_done_attrs(events, facts, run, round),
            )
          }
      }
    }
    LStartTriage(kind, round, _) =>
      if !facts.triage_fits {
        next_nothing(Triage)
      } else if facts.runs.length() > 0 {
        let fields : Array[(String, Json)] = [
          ("kind", Json::string(text_of(kind))),
          ("round", Json::number(round)),
          ("run_id", Json::string(run_id_of(facts.runs[0]))),
        ]
        if facts.means.length() > 0 {
          fields.push(("missing_means", Json::array(facts.means)))
        }
        push_fallbacks(fields, facts.runs[0].fallbacks)
        next_write(Triage, TriageStarted, attrs_of(fields))
      } else {
        next_start(Triage, triage_stage_of(events, text_of(kind)))
      }
    LStartConfirm(round) =>
      if !facts.confirm_fits {
        next_nothing(Confirm)
      } else if facts.runs.length() > 0 {
        let fields : Array[(String, Json)] = [
          ("round", Json::number(round)),
          ("run_id", Json::string(run_id_of(facts.runs[0]))),
        ]
        if facts.scope_refs.length() > 0 || facts.scope_refs_given {
          fields.push(
            ("scope_refs", Json::array(facts.scope_refs.map(Json::string))),
          )
        }
        if facts.boundary_refs.length() > 0 {
          fields.push(
            (
              "boundary_refs",
              Json::array(facts.boundary_refs.map(Json::string)),
            ),
          )
        }
        push_fallbacks(fields, facts.runs[0].fallbacks)
        next_write(Confirm, ConfirmStarted, attrs_of(fields))
      } else {
        // an S4 pass's confirm checks the reviewers' requests: it runs as the feedback's own confirm
        next_start(
          Confirm,
          if feedback_pass_at(events, events.length() - 1) >= 0 {
            "feedback_confirm"
          } else {
            "confirm"
          },
        )
      }
    LStartDevice(round) => next_start_device(facts, round)
    LSendFix(round) =>
      if facts.envelope_id is None {
        next_call(SendFix)
      } else {
        let fields : Array[(String, Json)] = [
          ("round", Json::number(round)),
          ("refs", Json::array(facts.accepted_refs.map(Json::string))),
          (
            "envelope_id",
            Json::string(
              match facts.envelope_id {
                Some(id) => id
                None => ""
              },
            ),
          ),
          ("how_refs", Json::array(facts.hows.map(Json::string))),
        ]
        if facts.boundary_refs.length() > 0 {
          fields.push(
            (
              "boundary_refs",
              Json::array(facts.boundary_refs.map(Json::string)),
            ),
          )
          fields.push(("boundaries", Json::array(facts.boundary_items)))
        }
        // a fix of the checks' failures says so: no confirm reads it, the next round reviews the whole diff
        if is_text(field(fix_scope(events), "source"), "checks") {
          fields.push(("source", Json::string("checks")))
        }
        next_write(SendFix, FixSent, attrs_of(fields))
      }
    // the blind's start: whether the map runs first, the round a moved head is drawn again for, the review a slot
    // nobody declared is skipped for, and the record the start writes, all from the rows and the facts
    LStartBlind(kind, round, map, allow_high_fallback) =>
      next_start_blind(kind, round, map, allow_high_fallback, events, facts)
    LStored(stored) => next_stored_step(stored, events, facts)
  }
}

///|
/// The step of a stored state: the state it carries is answered by the branch that state answers with, so a lane
/// that resumed a stopped stage takes the step it would have taken. A name nobody knows waits, and the stored
/// state is kept as it came.
fn next_stored_step(
  stored : Json,
  events : Array[DerivedRow],
  facts : StepFacts,
) -> Json raise FoldError {
  match stored_loop_state(stored) {
    Some(state) => next_step_for(state, events, facts)
    None => next_nothing(Wait)
  }
}

///|
/// The stage the judgement runs as: the PR's own feedback, the leftovers of an S4 confirm, or the plain triage.
fn triage_stage_of(events : Array[DerivedRow], kind : String) -> String {
  if kind == "feedback" {
    return "feedback"
  }
  if kind == "confirm" && feedback_pass_at(events, events.length() - 1) >= 0 {
    return "feedback_leftovers"
  }
  "triage"
}

///|
/// The confirm's record: what it left open, what it did not report on, and what it found.
fn confirm_done_attrs(
  events : Array[DerivedRow],
  facts : StepFacts,
  run : StepRun,
  round : Double,
) -> Json {
  let severity_of = fn(name : String) -> String {
    for pair in facts.severities {
      if pair.0 == name {
        return pair.1
      }
    }
    "should"
  }
  // a ref the confirm did not report on is as open as one it reported unresolved: the list is the fix's refs
  let open : Array[String] = []
  for name in facts.unresolved {
    open.push(name)
  }
  for name in facts.missing {
    open.push(name)
  }
  let mut must = 0
  let mut should = 0
  for name in open {
    match severity_of(name) {
      "must" => must = must + 1
      "should" => should = should + 1
      _ => ()
    }
  }
  let fields : Array[(String, Json)] = [("round", Json::number(round))]
  let files : Array[Json] = []
  match run.report_json {
    Some(path) => files.push(Json::string(path))
    None => ()
  }
  match facts.missing_file {
    Some(path) => files.push(Json::string(path))
    None => ()
  }
  if files.length() > 0 {
    fields.push(("files", Json::array(files)))
  }
  push_present(fields, "report_md", run.report_md)
  push_fallbacks(fields, run.fallbacks)
  fields.push(("unresolved_must", Json::number(must.to_double())))
  fields.push(("unresolved_should", Json::number(should.to_double())))
  fields.push(
    ("new_blocking", Json::number(blocking_of(run.findings).to_double())),
  )
  fields.push(("unresolved_refs", Json::array(open.map(Json::string))))
  if facts.boundary_refs.length() > 0 {
    let mut count = 0
    for name in open {
      for boundary in facts.boundary_refs {
        if boundary == name {
          count = count + 1
        }
      }
    }
    fields.push(("unresolved_boundaries", Json::number(count.to_double())))
  }
  // an S4 pass's confirm is handed the reviewers' requests: the ones it left open are counted apart
  if feedback_pass_at(events, events.length() - 1) >= 0 {
    let mut requests = 0
    let mut nits = 0
    for name in open {
      if facts.scope_refs.contains(name) {
        requests = requests + 1
      }
      if severity_of(name) == "nit" {
        nits = nits + 1
      }
    }
    fields.push(("unresolved_requests", Json::number(requests.to_double())))
    fields.push(("unresolved_nit", Json::number(nits.to_double())))
    // the list of what it did not report on is the S4 pass's, as the record always carried it
    if facts.missing.length() > 0 {
      fields.push(
        ("missing_refs", Json::array(facts.missing.map(Json::string))),
      )
    }
  }
  attrs_of(fields)
}

///|
/// The device check's step: it is skipped when the slot is not declared, and the verdict decides the rest.
fn next_start_device(facts : StepFacts, round : Double) -> Json {
  if !facts.device_on {
    return next_write(
      Device,
      DeviceSkipped,
      attrs_of([("reason", Json::string("pipeline.device_check が未宣言"))]),
    )
  }
  match facts.verdict {
    None => next_nothing(Device)
    Some(verdict) => {
      let action = text_of(field(verdict, "action"))
      if action == "skip" {
        next_write(
          Device,
          DeviceSkipped,
          attrs_of([("reason", Json::string(text_of(field(verdict, "reason"))))]),
        )
      } else if action == "must" {
        // the report the stage writes for a missing picture set is the caller's file: the record keeps the count,
        // the finding and that file
        let fields : Array[(String, Json)] = [
          ("round", Json::number(round)),
          ("blocking", Json::number(1.0)),
          ("judge", Json::string("viewer")),
        ]
        // the number of pictures is the caller's reading of the picture set, written as it read it
        fields.push(
          (
            "pictures",
            Json::number(
              match facts.pictures {
                Some(count) => count.to_double()
                None => 0.0
              },
            ),
          ),
        )
        match facts.report_path {
          Some(path) =>
            fields.push(("files", Json::array([Json::string(path)])))
          None => ()
        }
        fields.push(
          (
            "findings",
            Json::array([
              json_object([
                ("severity", Json::string("must")),
                ("claim", Json::string(text_of(field(verdict, "reason")))),
              ]),
            ]),
          ),
        )
        next_write(Device, DeviceDone, attrs_of(fields))
      } else if facts.runs.length() > 0 {
        let fields : Array[(String, Json)] = [
          ("round", Json::number(round)),
          ("run_id", Json::string(run_id_of(facts.runs[0]))),
          ("judge", Json::string(facts.judge)),
        ]
        match facts.pictures {
          Some(count) =>
            fields.push(("pictures", Json::number(count.to_double())))
          None => ()
        }
        match facts.stale_reason {
          Some(reason) => fields.push(("stale_reason", Json::string(reason)))
          None => ()
        }
        push_fallbacks(fields, facts.runs[0].fallbacks)
        next_write(Device, DeviceStarted, attrs_of(fields))
      } else {
        next_start(Device, "device")
      }
    }
  }
}

///|
/// The blind's step: the round's findings, or the escalation the round's failures bring.
fn next_running_blind(
  events : Array[DerivedRow],
  facts : StepFacts,
  kind : String,
  round : Double,
) -> Json {
  let mut running = false
  for run in facts.runs {
    if run.state == "running" {
      running = true
    }
  }
  if running {
    return next_nothing(Blind)
  }
  let started = last_row_of(events, EvS2ReviewStarted)
  let whole = if started < 0 {
    Json::null()
  } else {
    events[started].attrs.whole_run_ids
  }
  let whole_ids : Array[String] = []
  match whole {
    Json::Array(items) =>
      for item in items {
        match item {
          Json::String(text) => whole_ids.push(text)
          _ => ()
        }
      }
    _ => ()
  }
  // the whole-diff blind did not finish: the routes are dropped and the round is drawn again
  if whole_ids.length() > 0 {
    let mut whole_done = false
    for run in facts.runs {
      if run.state == "done" &&
        run.run_ids.length() > 0 &&
        whole_ids.contains(run.run_ids[0]) {
        whole_done = true
      }
    }
    if !whole_done {
      return next_write(
        Blind,
        MapDropped,
        attrs_of([
          ("kind", Json::string(kind)),
          ("round", Json::number(round)),
          (
            "reason",
            Json::string(
              "差分全体を読む blind が終わらなかったので、地図なしで起こし直す",
            ),
          ),
        ]),
      )
    }
  }
  // a round that ran no blind to the end reads nothing a judgement is for, whatever its spec check found
  let labels = started_run_labels(events, started)
  let mut files = 0
  let mut at = 0
  while at < facts.runs.length() {
    if facts.runs[at].state == "done" && !is_spec_run(labels, at) {
      files = files + 1
    }
    at = at + 1
  }
  if files == 0 {
    let reasons : Array[String] = []
    let mut failed_at = 0
    while failed_at < facts.runs.length() {
      let run = facts.runs[failed_at]
      if run.state == "failed" && !is_spec_run(labels, failed_at) {
        reasons.push(run.error)
      }
      failed_at = failed_at + 1
    }
    return next_write(
      Blind,
      ReviewEscalated,
      attrs_of([
        (
          "reason",
          Json::string("レビューがすべて失敗: " + reasons.join(" / ")),
        ),
        (
          "retry_state",
          json_object([
            ("state", Json::string("start_blind")),
            (
              "kind",
              Json::string(
                if kind == "final" {
                  "final"
                } else if kind == "kept" {
                  "kept"
                } else {
                  "blind"
                },
              ),
            ),
            ("round", Json::number(round)),
          ]),
        ),
      ]),
    )
  }
  // under `high_risk_when: last` a High lane's final is judged only when the High role ran to the end: a run
  // that failed, or one the windows swapped to its fallback, is put to penne as a retry
  if kind == "final" &&
    started >= 0 &&
    facts.policy.high_risk_when == "last" &&
    facts.policy.high_risk_extra > 0 &&
    !started_high_allowed(events, started) {
    let roles = events[started].attrs.run_roles
    let at : Array[Int] = []
    let mut i = 0
    while i < facts.runs.length() {
      let role = match roles {
        Json::Array(items) =>
          if i < items.length() {
            js_string(items[i])
          } else {
            ""
          }
        _ => ""
      }
      if facts.policy.high_risk_roles.contains(role) {
        at.push(i)
      }
      i = i + 1
    }
    let mut incomplete = false
    for index in at {
      if index >= facts.runs.length() || facts.runs[index].state != "done" {
        incomplete = true
      }
    }
    if at.length() > 0 && incomplete {
      return next_write(
        Blind,
        ReviewEscalated,
        attrs_of([
          (
            "reason",
            Json::string(
              "High のレビュー（" +
              facts.policy.high_risk_roles.join(", ") +
              "）が完走しなかったので、巡を判定に回さない",
            ),
          ),
          (
            "retry_state",
            json_object([
              ("state", Json::string("start_blind")),
              ("kind", Json::string("final")),
              ("round", Json::number(round)),
            ]),
          ),
        ]),
      )
    }
  }
  next_write(Blind, ReviewFindings, blind_findings(events, facts, kind, round))
}

///|
/// Whether the round starting at `started` was let run with the High role's fallback (penne allowed it), or is a
/// record nobody can tell the role of: a round without the record reads as one the role did not complete.
fn started_high_allowed(events : Array[DerivedRow], started : Int) -> Bool {
  if started < 0 {
    return false
  }
  js_truthy(events[started].attrs.high_allowed)
}

///|
/// How many failures of one check the checks' record keeps.
let check_failures_kept : Int = 20

///|
/// The first `n` of the values.
fn first_strings(values : Array[String], n : Int) -> Array[String] {
  let out : Array[String] = []
  for value in values {
    if out.length() >= n {
      break
    }
    out.push(value)
  }
  out
}

///|
/// A row's text field, when it is a non-empty string.
fn row_text(row : Json, key : String) -> String? {
  match field(row, key) {
    Json::String(text) => if text == "" { None } else { Some(text) }
    _ => None
  }
}

///|
/// One check's row as the checks' record keeps it: its name and status, what the comparison found, and why it failed.
fn check_row_record(row : Json) -> Json {
  let failures = first_strings(
    strings_of(field(row, "failures")),
    check_failures_kept,
  )
  let fields : Array[(String, Json)] = [
    ("name", Json::string(text_of(field(row, "name")))),
    ("status", Json::string(text_of(field(row, "status")))),
  ]
  match row_text(row, "verdict") {
    Some(verdict) => fields.push(("verdict", Json::string(verdict)))
    None => ()
  }
  match row_text(row, "phrase") {
    Some(phrase) => fields.push(("phrase", Json::string(phrase)))
    None => ()
  }
  if failures.length() > 0 {
    fields.push(("failures", Json::array(failures.map(Json::string))))
  }
  if !is_text(field(row, "status"), "pass") {
    match row_text(row, "tree_note") {
      Some(note) => fields.push(("tree_note", Json::string(note)))
      None => ()
    }
    match row_text(row, "tail") {
      Some(tail) => fields.push(("tail", Json::string(tail)))
      None => ()
    }
  }
  json_object(fields)
}

///|
/// A failure the lane made, as a must the fix carries: what failed and how, and the tail of the check's output.
fn check_finding(row : Json) -> Json {
  let name = text_of(field(row, "name"))
  let failures = first_strings(
    strings_of(field(row, "failures")),
    check_failures_kept,
  )
  let phrase = match row_text(row, "phrase") {
    Some(text) => text
    None => "この lane で新しく落ちた"
  }
  let lines : Array[String] = [
    "必須の検査 " +
    name +
    " が通るように直す（比べた base では落ちない失敗だけが対象。比べた base は公開 base の先端で、取れなかったときは lane の分岐元）。",
  ]
  // the run checked the head merged with the public base's tip: what failed may come from that tip's commits
  match row_text(row, "tree_note") {
    Some(note) => lines.push(note + "。")
    None => ()
  }
  if failures.length() > 0 {
    lines.push("落ちたもの: " + joined(failures, " / "))
  }
  match row_text(row, "tail") {
    Some(tail) => lines.push("出力の末尾:\n" + tail)
    None => ()
  }
  json_object([
    ("ref", Json::string("checks/" + name)),
    ("severity", Json::string("must")),
    (
      "claim",
      Json::string(
        "収束の前の必須の検査 " + name + " が落ちた: " + phrase,
      ),
    ),
    (
      "impact",
      Json::string(
        "既存の検査・テストを落とす（提出の検査で止まる）",
      ),
    ),
    ("fix", Json::string(joined(lines, "\n"))),
    ("action", Json::string("fix")),
  ])
}

///|
/// What a run of the checks found: a failure the lane made (`new`) goes to the fix; a row that is neither passed, not
/// applicable nor failing the same at the base it was compared with (a failure not compared, a check that did not
/// run, a copy that could not be prepared) is `unknown`; nothing else holds the loop.
fn checks_outcome(rows : Array[Json]) -> String {
  for row in rows {
    if is_text(field(row, "status"), "fail") &&
      is_text(field(row, "verdict"), "new") {
      return "new"
    }
  }
  for row in rows {
    let status = field(row, "status")
    if is_text(status, "pass") || is_text(status, "not-applicable") {
      continue
    }
    if is_text(status, "fail") && is_text(field(row, "verdict"), "preexisting") {
      continue
    }
    return "unknown"
  }
  "pass"
}

///|
/// The convergence's step: a repo that runs its checks before the loop converges runs them at the head unless they
/// already spoke for it (passed, or penne accepted after them); the convergence is written once they have. The step
/// the convergence state answers with, and the one a final the loop skipped asks for (`converge_attrs`: what it would
/// write).
fn converge_step(events : Array[DerivedRow], facts : StepFacts) -> Json {
  let attrs = converge_attrs_of(events, facts.converge_attrs)
  if !facts.checks_on {
    return next_write(Converge, ReviewConverged, attrs)
  }
  match facts.at {
    None => next_start(Checks, "checks")
    Some(at) =>
      if checks_settled(events, at.head) {
        next_write(Converge, ReviewConverged, attrs)
      } else if facts.runs.length() == 0 {
        next_start(Checks, "checks")
      } else {
        let fields : Array[(String, Json)] = [
          ("run_id", Json::string(run_id_of(facts.runs[0]))),
          ("head", Json::string(at.head)),
        ]
        match attrs {
          Json::Object(map) =>
            if map.length() > 0 {
              fields.push(("converge", attrs))
            }
          _ => ()
        }
        match facts.resume_state {
          Some(back) => fields.push(("resume_state", back))
          None => ()
        }
        next_write(Checks, ChecksStarted, attrs_of(fields))
      }
  }
}

///|
/// The step of the checks' run: wait while it runs, start again a run the repo's checks kept out, and record what it
/// found.
fn checks_run_step(run_id : String, head : String, facts : StepFacts) -> Json {
  if facts.runs.length() == 0 {
    return next_nothing(Checks)
  }
  let run = facts.runs[0]
  if run.state == "running" {
    return next_nothing(Checks)
  }
  // a run the repo's heavy checks kept out past its wait's limit is put to penne as a run that could not run
  if run.state == "busy" {
    return match facts.check_wait_over {
      Some(reason) =>
        next_write(
          Checks,
          ChecksDone,
          attrs_of([
            ("run_id", Json::string(run_id)),
            ("head", Json::string(head)),
            ("failed", Json::boolean(true)),
            ("error", Json::string(reason)),
          ]),
        )
      None => next_start(Checks, "checks")
    }
  }
  if run.state == "failed" {
    return next_write(
      Checks,
      ChecksDone,
      attrs_of([
        ("run_id", Json::string(run_id)),
        ("head", Json::string(head)),
        ("failed", Json::boolean(true)),
        ("error", Json::string(run.error)),
      ]),
    )
  }
  let rows = facts.check_rows
  let found : Array[Json] = []
  for row in rows {
    if is_text(field(row, "status"), "fail") &&
      is_text(field(row, "verdict"), "new") {
      found.push(check_finding(row))
    }
  }
  let fields : Array[(String, Json)] = [
    ("run_id", Json::string(run_id)),
    ("head", Json::string(head)),
    ("outcome", Json::string(checks_outcome(rows))),
    ("checks", Json::array(rows.map(check_row_record))),
  ]
  match facts.check_base {
    Some(base) => fields.push(("base", Json::string(base)))
    None => ()
  }
  if found.length() > 0 {
    fields.push(("findings", Json::array(found)))
  }
  next_write(Checks, ChecksDone, attrs_of(fields))
}
