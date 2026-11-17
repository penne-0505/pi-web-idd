// One row's `attrs`, as the derivations read them.
//
// `attrs` is a free append-only log: a row carries whatever its writer recorded, and each reader picks the keys
// it decides with. Read through `field(attrs, "…")`, a key is a string, so a key spelled wrong answers the same
// null as a row that never carried it, and a reader's mistake looks like an old record. The keys the derivations
// read are declared here, once: a read names a declared key, so a key no declaration holds is a build error, and
// a row's keys no reader declared are dropped at the boundary instead of being kept for a reader nobody declares.
//
// What a value means is still the reader's: the same key is read as text in one place and as a whole number in
// another, and the TypeScript fold's rules for that stay with the readers (`js_val.mbt`), so a row's malformed
// value reads the same on both sides.

///|
/// The fields of a lifecycle row's `attrs` the derivations read, each as it came in.
pub(all) struct RowAttrs {
  accepted : Json
  after_push : Json
  awaiting : Json
  batch_id : Json
  /// whether the row carries the `batch_id` field at all: a field that is not there and a field that is null
  /// are two different questions, and only the first one needs any answer (C-201-4)
  batch_id_present : Bool
  blocking : Json
  boundaries : Json
  boundary_refs : Json
  branch_gone : Json
  by : Json
  can_send_back : Json
  cause : Json
  causes : Json
  changed_files : Json
  /// the checks before the convergence: each check's row as the record keeps it
  checks : Json
  cycle_files : Json
  children : Json
  close : Json
  close_on : Json
  /// the convergence the checks before it held back, carried on their start
  converge : Json
  corrections : Json
  cost : Json
  decision : Json
  depth : Json
  depends_on : Json
  diff_scope : Json
  error : Json
  error_keys : Json
  escalated_claims : Json
  extras : Json
  failed : Json
  failed_runs : Json
  fallbacks : Json
  files : Json
  /// the failures the checks before the convergence found the lane made, as musts for the fix
  findings : Json
  gave_up : Json
  head : Json
  high_allowed : Json
  /// whether the row carries the `inherit` field at all: a re-check that took results over from an earlier tip
  /// is told apart from one that ran every check (C-202-1)
  inherit_present : Bool
  judge : Json
  kind : Json
  last_event : Json
  limit : Json
  main_tip : Json
  mainline : Json
  max_fix_rounds : Json
  max_should_fix : Json
  merge_target : Json
  merged_commit : Json
  /// whether the row carries the `moved` field at all: a check that started on a pair of its own, after the mainline moved
  /// past the pair the failure was counted on, is that pair's first check and not a re-check of the old one (C-232-1)
  moved_present : Bool
  must : Json
  new_blocking : Json
  /// where a rejection at the review sends the lane: `s1_rethink` is its plan, `s2_retry` its implementation, and a row
  /// that names none (an old one) is the implementation
  next_stage : Json
  no_open_pr : Json
  note : Json
  opponents : Json
  oscillations : Json
  outcome : Json
  plan_records : Json
  /// the paths the plan named as the ones to touch, as the GO recorded them (a GO of a plan with no list has none)
  plan_scope : Json
  outbound_id : Json
  /// the worktree a kept's record names, as the next pass compares it
  path : Json
  pr_number : Json
  /// whether the row carries the `pr_number` field at all: a row without it has no number, one that carries null
  /// has 0, and the two answers differ (C-201-4)
  pr_number_present : Bool
  pr_url : Json
  quota_wait : Json
  reason : Json
  /// why a conflict's generated files could not be made again, as the conflict's record carries it (C-266-2)
  rebuild_failure : Json
  resets_at : Json
  refs : Json
  rejected : Json
  requeued_from : Json
  /// the state the checks before the convergence hold back, carried on their start
  resume_state : Json
  retry_state : Json
  records_shape : Json
  role : Json
  round : Json
  routes : Json
  run_id : Json
  run_ids : Json
  run_labels : Json
  run_roles : Json
  runs : Json
  start_failed : Json
  model : Json
  sent_back : Json
  should : Json
  signed : Json
  since : Json
  /// where a fix comes from, when it is not the review's judgement (`checks`)
  source : Json
  stale_reason : Json
  stage : Json
  unresolved_boundaries : Json
  unresolved_must : Json
  unresolved_refs : Json
  unresolved_requests : Json
  unresolved_should : Json
  whole_run_ids : Json
}

///|
/// A row's `attrs`, read through the declaration above. A key the declaration does not hold is dropped, and a row
/// without attrs has nothing at every key.
fn row_attrs_of(value : Json) -> RowAttrs {
  {
    accepted: field(value, "accepted"),
    after_push: field(value, "after_push"),
    no_open_pr: field(value, "no_open_pr"),
    branch_gone: field(value, "branch_gone"),
    awaiting: field(value, "awaiting"),
    batch_id: field(value, "batch_id"),
    batch_id_present: has_key(value, "batch_id"),
    blocking: field(value, "blocking"),
    boundaries: field(value, "boundaries"),
    boundary_refs: field(value, "boundary_refs"),
    by: field(value, "by"),
    can_send_back: field(value, "can_send_back"),
    cause: field(value, "cause"),
    causes: field(value, "causes"),
    changed_files: field(value, "changed_files"),
    checks: field(value, "checks"),
    cycle_files: field(value, "cycle_files"),
    children: field(value, "children"),
    close: field(value, "close"),
    close_on: field(value, "close_on"),
    converge: field(value, "converge"),
    corrections: field(value, "corrections"),
    cost: field(value, "cost"),
    decision: field(value, "decision"),
    depth: field(value, "depth"),
    depends_on: field(value, "depends_on"),
    diff_scope: field(value, "diff_scope"),
    error: field(value, "error"),
    error_keys: field(value, "error_keys"),
    escalated_claims: field(value, "escalated_claims"),
    extras: field(value, "extras"),
    failed: field(value, "failed"),
    failed_runs: field(value, "failed_runs"),
    fallbacks: field(value, "fallbacks"),
    files: field(value, "files"),
    findings: field(value, "findings"),
    gave_up: field(value, "gave_up"),
    head: field(value, "head"),
    high_allowed: field(value, "high_allowed"),
    inherit_present: has_key(value, "inherit"),
    judge: field(value, "judge"),
    kind: field(value, "kind"),
    last_event: field(value, "last_event"),
    limit: field(value, "limit"),
    main_tip: field(value, "main_tip"),
    mainline: field(value, "mainline"),
    max_fix_rounds: field(value, "max_fix_rounds"),
    max_should_fix: field(value, "max_should_fix"),
    merge_target: field(value, "merge_target"),
    merged_commit: field(value, "merged_commit"),
    moved_present: has_key(value, "moved"),
    must: field(value, "must"),
    new_blocking: field(value, "new_blocking"),
    next_stage: field(value, "next_stage"),
    note: field(value, "note"),
    opponents: field(value, "opponents"),
    oscillations: field(value, "oscillations"),
    outcome: field(value, "outcome"),
    plan_records: field(value, "plan_records"),
    plan_scope: field(value, "plan_scope"),
    outbound_id: field(value, "outbound_id"),
    path: field(value, "path"),
    pr_number: field(value, "pr_number"),
    pr_number_present: has_key(value, "pr_number"),
    pr_url: field(value, "pr_url"),
    quota_wait: field(value, "quota_wait"),
    reason: field(value, "reason"),
    rebuild_failure: field(value, "rebuild_failure"),
    resets_at: field(value, "resets_at"),
    refs: field(value, "refs"),
    rejected: field(value, "rejected"),
    requeued_from: field(value, "requeued_from"),
    resume_state: field(value, "resume_state"),
    retry_state: field(value, "retry_state"),
    records_shape: field(value, "records_shape"),
    role: field(value, "role"),
    round: field(value, "round"),
    routes: field(value, "routes"),
    run_id: field(value, "run_id"),
    run_ids: field(value, "run_ids"),
    run_labels: field(value, "run_labels"),
    run_roles: field(value, "run_roles"),
    runs: field(value, "runs"),
    start_failed: field(value, "start_failed"),
    model: field(value, "model"),
    sent_back: field(value, "sent_back"),
    should: field(value, "should"),
    signed: field(value, "signed"),
    since: field(value, "since"),
    source: field(value, "source"),
    stale_reason: field(value, "stale_reason"),
    stage: field(value, "stage"),
    unresolved_boundaries: field(value, "unresolved_boundaries"),
    unresolved_must: field(value, "unresolved_must"),
    unresolved_refs: field(value, "unresolved_refs"),
    unresolved_requests: field(value, "unresolved_requests"),
    unresolved_should: field(value, "unresolved_should"),
    whole_run_ids: field(value, "whole_run_ids"),
  }
}

///|
/// `row.attrs.signed === true`: the signature's mark is the boolean, never the word.
fn is_signed(attrs : RowAttrs) -> Bool {
  match attrs.signed {
    Json::True => true
    _ => false
  }
}
