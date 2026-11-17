// The lane's per-round line, and the lane that goes back to its plan.
//
// The wider promise — that the lines are the ones the TypeScript reading gave, from the ledger's fields only —
// is held by the fixture test (`packages/idd-core/test/round-trace.test.mjs`). These say what a line holds and
// how the replan view reads a lane that went back.

///|
fn trace_row(event : String, attrs : String) -> DerivedRow {
  card_row(
    "{\"idd_id\":\"IDD-1\",\"event\":\"" +
    event +
    "\",\"at\":\"2026-10-01T00:00:00.000Z\",\"attrs\":" +
    attrs +
    "}",
  )
}

///|
/// Two rounds: the first accepts a must and a should naming one file each and changed two files, the second
/// accepts a should in the same file as the first and changed one file outside the plan's scope.
fn trace_lane() -> Array[DerivedRow] {
  [
    trace_row("s2_start", "{}"),
    trace_row(
      "s2_result", "{\"outcome\":\"success\",\"changed_files\":[\"a/x.ts\",\"b/y.ts\"]}",
    ),
    trace_row(
      "s2_triage_done", "{\"kind\":\"blind\",\"round\":1,\"accepted\":[{\"severity\":\"must\",\"path\":\"a/x.ts\"},{\"severity\":\"should\",\"path\":\"b/y.ts\"},{\"severity\":\"nit\",\"path\":\"c.ts\"}]}",
    ),
    trace_row(
      "s2_triage_done", "{\"kind\":\"confirm\",\"round\":1,\"accepted\":[{\"severity\":\"should\",\"path\":\"a/x.ts\"}]}",
    ),
    trace_row(
      "s2_result", "{\"outcome\":\"success\",\"changed_files\":[\"z/out.ts\"]}",
    ),
    trace_row(
      "s2_triage_done", "{\"kind\":\"blind\",\"round\":2,\"accepted\":[{\"severity\":\"should\",\"path\":\"a/x.ts\"}]}",
    ),
  ]
}

///|
/// The rows with the GO of a plan that named `scope` ahead of them.
fn with_go(rows : Array[DerivedRow], scope : String) -> Array[DerivedRow] {
  let out = [trace_row("s1_go", "{\"plan_scope\":" + scope + "}")]
  for row in rows {
    out.push(row)
  }
  out
}

///|
test "a round's line holds the accepted counts, the named files and the changed files" {
  let line = round_trace(with_go(trace_lane(), "[\"a/\",\"b/y.ts\"]"))
  inspect(
    line.stringify(),
    content=(
      #|[{"cycle":0,"round":1,"kind":"blind","accepted_must":1,"accepted_should":1,"named_files":["a/x.ts","b/y.ts"],"changed_files":2,"outside_scope":[]},{"cycle":0,"round":2,"kind":"blind","accepted_must":0,"accepted_should":1,"named_files":["a/x.ts"],"changed_files":1,"outside_scope":["z/out.ts"]}]
    ),
  )
}

///|
/// A round with a feedback, a confirm and a device judgement, then a replan, then the rounds numbered again from 1.
fn folded_lane() -> Array[DerivedRow] {
  [
    trace_row("s2_start", "{}"),
    trace_row(
      "s2_result", "{\"outcome\":\"success\",\"changed_files\":[\"a/x.ts\",\"b/y.ts\"]}",
    ),
    trace_row(
      "s2_triage_done", "{\"kind\":\"feedback\",\"round\":1,\"accepted\":[{\"severity\":\"must\",\"path\":\"a/x.ts\"}]}",
    ),
    trace_row(
      "s2_triage_done", "{\"kind\":\"confirm\",\"round\":1,\"accepted\":[{\"severity\":\"must\",\"path\":\"q.ts\"}]}",
    ),
    trace_row(
      "s2_result", "{\"outcome\":\"success\",\"changed_files\":[\"z/out.ts\"]}",
    ),
    trace_row(
      "s2_triage_done", "{\"kind\":\"device\",\"round\":1,\"accepted\":[{\"severity\":\"should\",\"path\":\"b/y.ts\"},{\"severity\":\"should\",\"path\":\"a/x.ts\"}]}",
    ),
    trace_row("s1_replan_requested", "{}"),
    trace_row(
      "s2_triage_done", "{\"kind\":\"blind\",\"round\":1,\"accepted\":[{\"severity\":\"should\",\"path\":\"n.ts\"}]}",
    ),
  ]
}

///|
test "the judgements of one round are one line, and a replan numbers its rounds apart from the old ones" {
  inspect(
    round_trace(with_go(folded_lane(), "[\"a/\"]")).stringify(),
    content=(
      #|[{"cycle":0,"round":1,"kind":"feedback","accepted_must":1,"accepted_should":2,"named_files":["a/x.ts","b/y.ts"],"changed_files":2,"outside_scope":["b/y.ts"]},{"cycle":1,"round":1,"kind":"blind","accepted_must":0,"accepted_should":1,"named_files":["n.ts"],"changed_files":1,"outside_scope":["z/out.ts"]}]
    ),
  )
}

///|
test "a GO that recorded no scope, or none at all, puts no file outside the plan" {
  let none = round_trace(trace_lane()).stringify()
  let bare = round_trace(with_go(trace_lane(), "[]")).stringify()
  let plain = [trace_row("s1_go", "{}")]
  for row in trace_lane() {
    plain.push(row)
  }
  let old = round_trace(plain).stringify()
  inspect(none == bare && bare == old, content="true")
  inspect(
    none.contains("\"outside_scope\":[\"z/out.ts\"]").to_string(),
    content="false",
  )
}

///|
test "the same rows give the same lines" {
  let scope = "[\"a/\"]"
  inspect(
    round_trace(with_go(trace_lane(), scope)).stringify() ==
    round_trace(with_go(trace_lane(), scope)).stringify(),
    content="true",
  )
}

///|
/// Each round is measured against the scope of the last GO before it, so a plan that went back and was gone through
/// again changes what a later round is measured against and leaves the earlier lines as they were.
test "a round is measured against the plan its GO recorded, and a replan's second GO does not move the earlier rounds" {
  let rows = [
    trace_row("s1_go", "{\"plan_scope\":[\"a/\"]}"),
    trace_row("s2_result", "{\"changed_files\":[\"a/x.ts\",\"z/out.ts\"]}"),
    trace_row(
      "s2_triage_done", "{\"kind\":\"blind\",\"round\":1,\"accepted\":[]}",
    ),
    trace_row("s1_replan_requested", "{}"),
    trace_row("s1_go", "{\"plan_scope\":[\"z/\"]}"),
    trace_row("s2_result", "{\"changed_files\":[\"a/x.ts\",\"z/out.ts\"]}"),
    trace_row(
      "s2_triage_done", "{\"kind\":\"blind\",\"round\":1,\"accepted\":[]}",
    ),
  ]
  inspect(
    round_trace(rows).stringify(),
    content=(
      #|[{"cycle":0,"round":1,"kind":"blind","accepted_must":0,"accepted_should":0,"named_files":[],"changed_files":2,"outside_scope":["z/out.ts"]},{"cycle":1,"round":1,"kind":"blind","accepted_must":0,"accepted_should":0,"named_files":[],"changed_files":2,"outside_scope":["a/x.ts"]}]
    ),
  )
}

///|
/// A lane that went back to its plan carries, on a result, the files of the cycle it runs now beside the whole list it
/// changed; the round line counts the cycle's, so what the first plan's cycle changed is not outside the second plan.
test "a cycle's own files are what a round after a return to the plan is measured on, and a result without them reads the whole list" {
  let rows = [
    trace_row("s1_go", "{\"plan_scope\":[\"a/\"]}"),
    trace_row("s2_result", "{\"changed_files\":[\"a/x.ts\"]}"),
    trace_row(
      "s2_triage_done", "{\"kind\":\"blind\",\"round\":1,\"accepted\":[]}",
    ),
    trace_row("s1_replan_requested", "{}"),
    trace_row("s1_go", "{\"plan_scope\":[\"b/\"]}"),
    trace_row(
      "s2_result", "{\"changed_files\":[\"a/x.ts\",\"b/y.ts\",\"z/out.ts\"],\"cycle_files\":[\"b/y.ts\",\"z/out.ts\"]}",
    ),
    trace_row(
      "s2_triage_done", "{\"kind\":\"blind\",\"round\":1,\"accepted\":[]}",
    ),
    trace_row(
      "s2_result", "{\"changed_files\":[\"a/x.ts\",\"b/y.ts\",\"z/out.ts\"]}",
    ),
    trace_row(
      "s2_triage_done", "{\"kind\":\"blind\",\"round\":2,\"accepted\":[]}",
    ),
  ]
  inspect(
    round_trace(rows).stringify(),
    content=(
      #|[{"cycle":0,"round":1,"kind":"blind","accepted_must":0,"accepted_should":0,"named_files":[],"changed_files":1,"outside_scope":[]},{"cycle":1,"round":1,"kind":"blind","accepted_must":0,"accepted_should":0,"named_files":[],"changed_files":2,"outside_scope":["z/out.ts"]},{"cycle":1,"round":2,"kind":"blind","accepted_must":0,"accepted_should":0,"named_files":[],"changed_files":3,"outside_scope":["a/x.ts","z/out.ts"]}]
    ),
  )
}

///|
test "file names are ordered by their code units, not by their length" {
  inspect(
    sorted_unique(["lib/x.ts", "docs/a.md", "lib/p/q/x.ts", "docs/a.md", "a"]).join(
      "|",
    ),
    content="a|docs/a.md|lib/p/q/x.ts|lib/x.ts",
  )
}

///|
test "a scope entry with a star matches inside one segment, two stars across segments, and a slash holds the directory" {
  let rows = [
    trace_row(
      "s1_go", "{\"plan_scope\":[\"packages/*/test/\",\"lib/**/x.ts\",\"docs/*.md\"]}",
    ),
    trace_row(
      "s2_result", "{\"changed_files\":[\"packages/core/test/a/b.mjs\",\"packages/core/src/c.ts\",\"packages/tool/d.mjs\",\"lib/p/q/x.ts\",\"lib/x.ts\",\"docs/a.md\",\"docs/sub/a.md\"]}",
    ),
    trace_row(
      "s2_triage_done", "{\"kind\":\"blind\",\"round\":1,\"accepted\":[]}",
    ),
  ]
  inspect(
    field(array_of(round_trace(rows))[0], "outside_scope").stringify(),
    content=(
      #|["docs/sub/a.md","lib/x.ts","packages/core/src/c.ts","packages/tool/d.mjs"]
    ),
  )
}

///|
/// The files outside the plan's scope of a one-round lane whose plan named `scope` and whose round changed `files`.
fn outside_of(scope : String, files : String) -> String {
  let rows = [
    trace_row("s1_go", "{\"plan_scope\":" + scope + "}"),
    trace_row("s2_result", "{\"changed_files\":" + files + "}"),
    trace_row(
      "s2_triage_done", "{\"kind\":\"blind\",\"round\":1,\"accepted\":[]}",
    ),
  ]
  field(array_of(round_trace(rows))[0], "outside_scope").stringify()
}

///|
test "a file beside a named file is inside the plan, a file of another module is outside" {
  // a new file of the module the plan named is the implementer's own split
  inspect(
    outside_of("[\"packages/x/a.ts\"]", "[\"packages/x/b.ts\"]"),
    content="[]",
  )
  // a module the plan did not name stays outside, and so does a deeper directory of the named one
  inspect(
    outside_of(
      "[\"packages/x/a.ts\"]", "[\"packages/y/b.ts\",\"packages/x/sub/c.ts\"]",
    ),
    content=(
      #|["packages/x/sub/c.ts","packages/y/b.ts"]
    ),
  )
}

///|
test "a test file is inside the plan wherever it sits" {
  inspect(
    outside_of(
      "[\"packages/x/a.ts\"]", "[\"packages/z/test/a.test.mjs\",\"packages/z/b.test.ts\",\"packages/z/b_wbtest.mbt\",\"packages/z/tests/c.ts\",\"packages/z/c.ts\"]",
    ),
    content=(
      #|["packages/z/c.ts"]
    ),
  )
}

///|
test "a file at the repo root has no module, so a root file beside it is outside" {
  inspect(outside_of("[\"a.ts\"]", "[\"a.ts\",\"b.ts\"]"), content="[\"b.ts\"]")
}

///|
test "a root-relative alias of a named file names the file, not a module" {
  // the GO records `src/a.ts` named under `packages/x/` as both paths; `src/` is no module of the plan
  inspect(
    outside_of(
      "[\"packages/x/src/a.ts\",\"src/a.ts\"]", "[\"packages/x/src/b.ts\",\"src/a.ts\",\"src/unrelated.ts\"]",
    ),
    content=(
      #|["src/unrelated.ts"]
    ),
  )
}

///|
/// A lane stopped at its card after its GO, then sent back to its plan.
fn replan_lane(replanned : Bool) -> Array[DerivedRow] {
  let rows = [
    trace_row("lane_open", "{}"),
    trace_row("s1_ready", "{}"),
    trace_row("s1_go", "{}"),
  ]
  for row in card_lane(false) {
    rows.push(row)
  }
  if replanned {
    rows.push(trace_row("s1_replan_requested", "{}"))
  }
  rows
}

///|
test "a lane that went back to its plan reads as a plan sent back, the old rounds left out" {
  let rows = replan_view(replan_lane(true))
  inspect(
    plan_review_phase(rows).stringify(),
    content=(
      #|{"phase":"sent_back"}
    ),
  )
  inspect(
    event_ran(rows, EvS1Go).to_string() +
    "," +
    event_ran(rows, EvS2Start).to_string(),
    content="false,false",
  )
  inspect(
    replan_view(replan_lane(false)).length() == replan_lane(false).length(),
    content="true",
  )
}

///|
test "the view's places are the caller's indexes of the rows it keeps" {
  // lane_open, s1_ready, s1_go | the dropped era | s1_replan_requested
  let rows = replan_lane(true)
  let kept = replan_kept(rows)
  inspect(
    match kept {
      Some(places) => places.map(fn(i) { i.to_string() }).join(",")
      None => "all"
    },
    content="0,1,10",
  )
}

///|
test "an index in the caller's rows turns into a place in the view, and back" {
  let rows = replan_lane(true)
  let kept = replan_kept(rows)
  let view = replan_view(rows)
  // the last row (the replan) is the view's last place whatever the era's length
  let last = rows.length() - 1
  let (read, at, back) = index_reading("", view, kept, Some(last))
  inspect(
    (read.length() == view.length()).to_string() +
    "," +
    at.to_string() +
    "," +
    ledger_index(back, at).to_string() +
    "," +
    last.to_string(),
    content="true,2,10,10",
  )
  // no index is the view's last row, still carried back to the caller's index
  let (_, at_last, back_last) = index_reading("", view, kept, None)
  inspect(
    at_last.to_string() + "," + ledger_index(back_last, at_last).to_string(),
    content="2,10",
  )
  // an index that names no row (the "before everything" -1) is left as it is
  inspect(ledger_index(kept, -1).to_string(), content="-1")
}

///|
test "a lane that never went back keeps its indexes" {
  let rows = replan_lane(false)
  inspect(
    match replan_kept(rows) {
      Some(_) => "view"
      None => "all"
    },
    content="all",
  )
  let (_, at, back) = index_reading("", rows, None, Some(2))
  inspect(
    at.to_string() + "," + ledger_index(back, 5).to_string(),
    content="2,5",
  )
}

///|
test "the lane that went back keeps every row for the lines" {
  inspect(
    round_trace(replan_lane(true)).stringify().length() > 2,
    content="true",
  )
}

///|
test "a lane that went back reads a second GO and a second start as new ones" {
  let rows = replan_lane(true)
  rows.push(trace_row("s1_ready", "{}"))
  rows.push(trace_row("s1_go", "{}"))
  let view = replan_view(rows)
  inspect(
    event_ran(view, EvS1Go).to_string() +
    "," +
    event_ran(view, EvS2Start).to_string(),
    content="true,false",
  )
}

///|
test "the card offers the replan as an answer of its own" {
  let needs : Array[FactNeed] = []
  let answer = stuck_outcomes_answer(card_lane(false), card_args(), needs)
  inspect(
    field(field(answer, "replan"), "to").stringify(),
    content=(
      #|"plan"
    ),
  )
}

///|
test "a budget raised in the era that was left out holds after the lane came back" {
  let rows = replan_lane(false)
  rows.insert(4, trace_row("lane_budget_extended", "{\"limit\":42.0}"))
  rows.push(trace_row("s1_replan_requested", "{}"))
  let view = replan_view(rows)
  inspect(lane_budget(view, 10.0).to_string(), content="42")
  inspect(
    event_ran(view, EvS1Go).to_string() +
    "," +
    event_ran(view, EvS2Start).to_string(),
    content="false,false",
  )
  inspect(loop_state_name(review_loop_state(view)), content="idle")
}

///|
/// A lane that went through its plan and its GO, ran, and was rejected at the review with `attrs` on the rejection.
fn rejected_lane(attrs : String) -> Array[DerivedRow] {
  [
    trace_row("lane_open", "{}"),
    trace_row("s1_ready", "{}"),
    trace_row("s1_go", "{}"),
    trace_row("s2_start", "{}"),
    trace_row("s2_result", "{\"outcome\":\"success\"}"),
    trace_row("s3_ready", "{}"),
    trace_row("s3_reject", attrs),
  ]
}

///|
test "a rejection that records the plan sends the lane back to it, and any other does not" {
  let to_plan = "{\"next_stage\":\"s1_rethink\"}"
  inspect(
    [
      returns_to_plan(rejected_lane(to_plan)[6]),
      returns_to_plan(rejected_lane("{\"next_stage\":\"s2_retry\"}")[6]),
      returns_to_plan(rejected_lane("{}")[6]),
      returns_to_plan(rejected_lane("{\"next_stage\":7}")[6]),
      returns_to_plan(trace_row("s1_replan_requested", "{}")),
      returns_to_plan(trace_row("s1_revise_requested", "{}")),
    ]
    .map(fn(b) { b.to_string() })
    .join(","),
    content="true,false,false,false,true,false",
  )
}

///|
test "a lane rejected to its plan stands at the plan sent back, and the planner is the one waited on" {
  let rows = replan_view(rejected_lane("{\"next_stage\":\"s1_rethink\"}"))
  inspect(
    plan_review_phase(rows).stringify(),
    content=(
      #|{"phase":"sent_back"}
    ),
  )
  inspect(
    event_ran(rows, EvS1Go).to_string() +
    "," +
    event_ran(rows, EvS2Start).to_string(),
    content="false,false",
  )
  let stage = progress_of(rows)
  inspect(
    stage.stage_done.to_string() + "," + lane_group_text(stage.group),
    content="1,prep",
  )
  // the planner owes the plan since the rejection, and the executor is owed nothing
  inspect(
    last_planner_work(rows, planner_work()).to_string() +
    "," +
    last_executor_work(rows).to_string(),
    content="2,-1",
  )
}

///|
test "a lane rejected to its implementation stays in it, and the executor is the one waited on" {
  for attrs in ["{\"next_stage\":\"s2_retry\"}", "{}"] {
    let rows = replan_view(rejected_lane(attrs))
    inspect(rows.length(), content="7")
    inspect(plan_review_phase(rows).stringify(), content="{\"phase\":\"none\"}")
    inspect(
      last_executor_work(rows).to_string() +
      "," +
      begins_fix_round(rows[6]).to_string(),
      content="6,true",
    )
  }
}

///|
test "the rounds after a rejection to the plan are numbered again from 1, and one to the implementation moves no cycle" {
  let round_1 = "{\"kind\":\"blind\",\"round\":1,\"accepted\":[]}"
  let rows = rejected_lane("{\"next_stage\":\"s1_rethink\"}")
  rows.push(trace_row("s2_triage_done", round_1))
  let back = rejected_lane("{\"next_stage\":\"s2_retry\"}")
  back.push(trace_row("s2_triage_done", round_1))
  let cycles = fn(rows : Array[DerivedRow]) -> String {
    array_of(round_trace(rows))
    .map(fn(line) { field(line, "cycle").stringify() })
    .join(",")
  }
  inspect(cycles(rows), content="1")
  inspect(cycles(back), content="0")
}
