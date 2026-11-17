// The checks a repo runs at the lane's head before the review loop converges (`checks_before_converge`), in the fold's
// own words: where the loop goes on each record of the checks, and what the step writes. The promise that the
// TypeScript reading gives the same answer is held by `packages/idd-core/test/review-loop-converge-checks.test.mjs`.

///|
/// A lane whose final review found nothing to fix, with the rows given after it.
fn checks_lane(more : Array[String]) -> Array[DerivedRow] {
  let rows = [
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-11-13T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-11-13T10:01:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_result\",\"at\":\"2026-11-13T10:02:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_started\",\"at\":\"2026-11-13T10:03:00.000Z\",\"attrs\":{\"kind\":\"final\",\"round\":1,\"run_ids\":[\"F1\"],\"head\":\"H\"}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_findings\",\"at\":\"2026-11-13T10:04:00.000Z\",\"attrs\":{\"kind\":\"final\",\"round\":1,\"files\":[]}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_triage_done\",\"at\":\"2026-11-13T10:05:00.000Z\",\"attrs\":{\"kind\":\"final\",\"round\":1,\"accepted\":[],\"rejected\":[],\"escalated_claims\":[]}}",
  ]
  for row in more {
    rows.push(row)
  }
  rows.map(step_row)
}

///|
/// The facts of a repo that runs its checks before the convergence, at head H.
fn checks_facts(extra : Array[(String, Json)]) -> StepFacts {
  let fields : Array[(String, Json)] = [
    ("checksOn", Json::boolean(true)),
    (
      "at",
      json_object([
        ("worktree", Json::string("/w")),
        ("base", Json::string("b")),
        ("head", Json::string("H")),
      ]),
    ),
  ]
  for field in extra {
    fields.push(field)
  }
  step_facts_of(json_object(fields))
}

///|
test "the convergence starts the checks at the head, and records the run it started" {
  let lane = checks_lane([])
  inspect(loop_state_name(review_loop_state(lane)), content="converge")
  inspect(
    next_step_of(lane, checks_facts([])).stringify(),
    content=(
      #|{"leg":"checks","action":"start","attrs":{},"stage":"checks"}
    ),
  )
  inspect(
    next_step_of(
      lane,
      checks_facts([
        (
          "runs",
          Json::array([
            json_object([
              ("state", Json::string("running")),
              ("runIds", Json::array([Json::string("C1")])),
            ]),
          ]),
        ),
      ]),
    ).stringify(),
    content=(
      #|{"leg":"checks","action":"write","attrs":{"run_id":"C1","head":"H"},"event":"s2_checks_started"}
    ),
  )
  // a repo that does not run them converges as before
  inspect(
    next_step_of(lane, no_facts()).stringify(),
    content=(
      #|{"leg":"converge","action":"write","attrs":{},"event":"s2_review_converged"}
    ),
  )
}

///|
test "a failure the lane made goes to the fix as a must; one the base has as well converges; one not compared stops" {
  let started = "{\"idd_id\":\"IDD-1\",\"event\":\"s2_checks_started\",\"at\":\"2026-11-13T10:06:00.000Z\",\"attrs\":{\"run_id\":\"C1\",\"head\":\"H\"}}"
  let running = checks_lane([started])
  inspect(loop_state_name(review_loop_state(running)), content="running_checks")
  inspect(
    match review_loop_label(review_loop_state(running), None) {
      Some(label) => label
      None => ""
    },
    content="検査中",
  )
  let done = next_step_of(
    running,
    step_facts_of(
      json_object([
        ("runs", Json::array([json_object([("state", Json::string("done"))])])),
        (
          "checkRows",
          Json::array([
            json_object([
              ("name", Json::string("test")),
              ("status", Json::string("fail")),
              ("verdict", Json::string("new")),
              (
                "phrase",
                Json::string("この lane で新しく落ちた 1 件（x）"),
              ),
              ("failures", Json::array([Json::string("x")])),
              ("tail", Json::string("x [E]")),
            ]),
          ]),
        ),
      ]),
    ),
  )
  inspect(
    done.stringify(),
    content=(
      #|{"leg":"checks","action":"write","attrs":{"run_id":"C1","head":"H","outcome":"new","checks":[{"name":"test","status":"fail","verdict":"new","phrase":"この lane で新しく落ちた 1 件（x）","failures":["x"],"tail":"x [E]"}],"findings":[{"ref":"checks/test","severity":"must","claim":"収束の前の必須の検査 test が落ちた: この lane で新しく落ちた 1 件（x）","impact":"既存の検査・テストを落とす（提出の検査で止まる）","fix":"必須の検査 test が通るように直す（比べた base では落ちない失敗だけが対象。比べた base は公開 base の先端で、取れなかったときは lane の分岐元）。\n落ちたもの: x\n出力の末尾:\nx [E]","action":"fix"}]},"event":"s2_checks_done"}
    ),
  )
  let found = checks_lane([
    started,
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_checks_done\",\"at\":\"2026-11-13T10:07:00.000Z\",\"attrs\":" +
    field(done, "attrs").stringify() +
    "}",
  ])
  inspect(
    loop_state_json(review_loop_state(found)).stringify(),
    content="{\"state\":\"send_fix\",\"round\":1}",
  )
  inspect(field(fix_scope(found), "source").stringify(), content="\"checks\"")
  let unknown = checks_lane([
    started, "{\"idd_id\":\"IDD-1\",\"event\":\"s2_checks_done\",\"at\":\"2026-11-13T10:07:00.000Z\",\"attrs\":{\"run_id\":\"C1\",\"head\":\"H\",\"outcome\":\"unknown\",\"checks\":[{\"name\":\"test\",\"status\":\"fail\",\"verdict\":\"unknown\",\"phrase\":\"比べられない\"}]}}",
  ])
  inspect(
    loop_state_json(review_loop_state(unknown)).stringify(),
    content="{\"state\":\"escalated\",\"reason\":\"収束の前の必須の検査を比べる base（公開 base の先端。取れなかったときは lane の分岐元）と比べられなかった: test（比べられない）。続けると検査を回し直し、受け入れると収束する\"}",
  )
  let passed = checks_lane([
    started, "{\"idd_id\":\"IDD-1\",\"event\":\"s2_checks_done\",\"at\":\"2026-11-13T10:07:00.000Z\",\"attrs\":{\"run_id\":\"C1\",\"head\":\"H\",\"outcome\":\"pass\",\"checks\":[]}}",
  ])
  inspect(
    next_step_of(passed, checks_facts([])).stringify(),
    content=(
      #|{"leg":"converge","action":"write","attrs":{"checks_head":"H"},"event":"s2_review_converged"}
    ),
  )
}

///|
test "a run kept out too long stops for penne; an accept there answers for the head, and a held-back round comes back" {
  let started = "{\"idd_id\":\"IDD-1\",\"event\":\"s2_checks_started\",\"at\":\"2026-11-13T10:06:00.000Z\",\"attrs\":{\"run_id\":\"C1\",\"head\":\"H\",\"resume_state\":{\"state\":\"start_blind\",\"kind\":\"blind\",\"round\":2}}}"
  let waiting = checks_lane([started])
  inspect(
    checks_run_step(
      "C1",
      "H",
      step_facts_of(
        json_object([
          (
            "runs",
            Json::array([json_object([("state", Json::string("busy"))])]),
          ),
          ("checkWaitOver", Json::string("lock が空かない")),
        ]),
      ),
    ).stringify(),
    content=(
      #|{"leg":"checks","action":"write","attrs":{"run_id":"C1","head":"H","failed":true,"error":"lock が空かない"},"event":"s2_checks_done"}
    ),
  )
  let failed = checks_lane([
    started, "{\"idd_id\":\"IDD-1\",\"event\":\"s2_checks_done\",\"at\":\"2026-11-13T10:07:00.000Z\",\"attrs\":{\"run_id\":\"C1\",\"head\":\"H\",\"failed\":true,\"error\":\"lock が空かない\"}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_escalated\",\"at\":\"2026-11-13T10:08:00.000Z\",\"attrs\":{\"reason\":\"r\"}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_review_resumed\",\"at\":\"2026-11-13T10:09:00.000Z\",\"attrs\":{\"decision\":\"accept\"}}",
  ])
  inspect(
    loop_state_json(review_loop_state(failed)).stringify(),
    content="{\"state\":\"start_blind\",\"kind\":\"blind\",\"round\":2}",
  )
  inspect(checks_settled(failed, "H"), content="true")
  inspect(waiting.length(), content="7")
}
