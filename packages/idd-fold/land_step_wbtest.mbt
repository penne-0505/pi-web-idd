// The landing's next step: the closed set of steps the fold answers, held as inline snapshots.
//
// The cross-language answer is held by `packages/idd-core/test/land-step.test.mjs` and by the cross-check over a real
// ledger. What is written here is the fold's own answer, so a change to the steps' shape or to the order of the
// records is a diff beside the case that changed.

///|
/// The rows of a lane at the landing's card.
fn landing_rows() -> Array[DerivedRow] {
  derived_rows([
    "{\"idd_id\":\"IDD-1\",\"event\":\"lane_open\",\"at\":\"2026-10-23T10:00:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s2_start\",\"at\":\"2026-10-23T10:01:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s3_ok\",\"at\":\"2026-10-23T10:02:00.000Z\",\"attrs\":{}}",
    "{\"idd_id\":\"IDD-1\",\"event\":\"s4_submit_started\",\"at\":\"2026-10-23T10:03:00.000Z\",\"attrs\":{}}",
  ])
}

///|
test "a lane at the card asks for the approval sweep before its own check" {
  let facts = json_object([
    ("checked|IDD-1|", Json::null()),
    ("runEnded|IDD-1|", Json::boolean(false)),
    ("behind|IDD-1|", Json::null()),
    ("stacked|IDD-1|", Json::null()),
    ("unreviewed|IDD-1|", Json::null()),
  ])
  inspect(
    land_step(landing_rows(), facts, "scan", 3, 120000.0),
    content=(
      #|{"steps":[{"do":"call","helper":"carry_sweep","site":"fresh","fact":"call|carry_sweep|fresh","keep":{"id":"IDD-1"},"args":{"id":"IDD-1"},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "a check that passed leaves the lane where it is" {
  let facts = json_object([
    (
      "checked|IDD-1|",
      json_object([
        ("status", Json::string("prepared")),
        ("blocking", Json::number(0.0)),
      ]),
    ),
  ])
  inspect(
    land_step(landing_rows(), facts, "scan", 3, 120000.0),
    content=(
      #|{"steps":[{"do":"end"}]}
    ),
  )
}

///|
test "a lane with no approval is left by the carried approvals" {
  let facts = json_object([("approval|IDD-1|", Json::null())])
  inspect(
    land_step(landing_rows(), facts, "carry", 3, 120000.0),
    content=(
      #|{"steps":[{"do":"end"}]}
    ),
  )
}

///|
test "an approval whose lane moved drops the approval before anything is merged" {
  let facts = json_object([
    (
      "approval|IDD-1|",
      json_object([
        ("head", Json::string("a".repeat(40))),
        ("at", Json::number(1.0)),
      ]),
    ),
    ("location|IDD-1|", Json::boolean(true)),
    ("cur|IDD-1|", Json::string("b".repeat(40))),
  ])
  inspect(
    land_step(landing_rows(), facts, "carry", 3, 120000.0),
    content=(
      #|{"steps":[{"do":"write","event":"s4_land_approval_dropped","attrs":{"reason":"lane の head が変わりました","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},{"do":"result","field":"errors","id":"IDD-1","error":"承認の後に lane の commit が進んだので、承認を外しました"},{"do":"end"}]}
    ),
  )
}

///|
test "a fact the caller has not taken yet is named as a need, and no step is answered without it" {
  let facts = json_object([])
  inspect(
    land_step(landing_rows(), facts, "carry", 3, 120000.0),
    content=(
      #|{"needs":[{"id":"approval|IDD-1|","kind":"approval","a":"IDD-1","b":""}]}
    ),
  )
}

///|
/// The facts of a lane whose record has one blocking check the change itself failed.
fn change_failed_facts() -> Json {
  change_failed_facts_started(None)
}

///|
/// The same facts, and the answer of the check again that started on the mainline tip the caller names.
fn change_failed_facts_started(started_tip : String?) -> Json {
  let started = match started_tip {
    Some(tip) =>
      [
        (
          "call|prepare_land|settle",
          json_object([
            (
              "result",
              json_object([
                ("checking", Json::boolean(true)),
                ("head", Json::string("a".repeat(40))),
                ("mainTip", Json::string(tip)),
              ]),
            ),
            (
              "keep",
              json_object([
                ("id", Json::string("IDD-1")),
                ("head", Json::string("a".repeat(40))),
                ("mainTip", Json::string("c".repeat(40))),
                ("branch", Json::string("work-main")),
                (
                  "reason",
                  Json::string("変更の失敗と読んだ検査 test:lane"),
                ),
                ("cause", Json::string("real")),
                ("attempt", Json::number(2.0)),
              ]),
            ),
          ]),
        ),
      ]
    None => []
  }
  json_object(
    [
      ("branch|IDD-1|", Json::string("work-main")),
      ("head|IDD-1|", Json::string("a".repeat(40))),
      ("now|IDD-1|", Json::number(1000000000.0)),
      (
        "checked|IDD-1|",
        json_object([
          ("head", Json::string("a".repeat(40))),
          ("mainTip", Json::string("c".repeat(40))),
          ("blocking", Json::number(1.0)),
          (
            "checks",
            Json::array([
              json_object([
                ("name", Json::string("test:lane")),
                ("status", Json::string("fail")),
                ("severity", Json::string("blocking")),
                ("detail", Json::string("1 tests failed:\n✖ boom")),
              ]),
            ]),
          ),
        ]),
      ),
      ("run|IDD-1|", Json::null()),
      ("runChecking|IDD-1|", Json::boolean(false)),
      ("attempted|IDD-1|", Json::boolean(false)),
      ("call|carry_sweep|settle", json_object([("result", Json::null())])),
      ..started,
    ],
  )
}

///|
/// The landing's rows with one check again of the same group written, with the cause's mark or without it.
fn landing_rows_rechecked(cause : String?) -> Array[DerivedRow] {
  landing_rows_rechecked_marked(cause, false)
}

///|
/// The same row, and with `moved` when it is the first check of a pair the mainline moved to.
fn landing_rows_rechecked_marked(
  cause : String?,
  moved : Bool,
) -> Array[DerivedRow] {
  let rows = landing_rows()
  let head = "a".repeat(40)
  let main_tip = "c".repeat(40)
  let mark = match cause {
    Some(text) => ",\"cause\":\"" + text + "\""
    None => ""
  }
  let mark = if moved {
    mark + ",\"moved\":{\"from_main_tip\":\"" + "d".repeat(40) + "\"}"
  } else {
    mark
  }
  for
    row in derived_rows([
      "{\"idd_id\":\"IDD-1\",\"event\":\"s4_land_recheck\",\"at\":\"2026-10-23T10:04:00.000Z\",\"attrs\":{\"head\":\"" +
      head +
      "\",\"main_tip\":\"" +
      main_tip +
      "\"" +
      mark +
      ",\"attempt\":1}}",
    ]) {
    rows.push(row)
  }
  rows
}

///|
test "a check the change failed is run again on the same group before it is sent back" {
  inspect(
    land_step(landing_rows(), change_failed_facts(), "scan", 3, 120000.0),
    content=(
      #|{"steps":[{"do":"call","helper":"prepare_land","site":"settle","fact":"call|prepare_land|settle","keep":{"id":"IDD-1","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mainTip":"cccccccccccccccccccccccccccccccccccccccc","branch":"work-main","reason":"変更の失敗と読んだ検査 test:lane を、同じ head と本流の先端で検査し直します","cause":"real","attempt":1},"args":{"id":"IDD-1","signed":false},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "a check the change failed again after the check again is sent back" {
  inspect(
    land_step(
      landing_rows_rechecked(Some("real")),
      change_failed_facts(),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"call","helper":"send_back_land_check_failure","site":"settle","fact":"call|send_back_land_check_failure|settle","keep":{"id":"IDD-1","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","names":"test:lane"},"args":{"id":"IDD-1","branch":"work-main","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mainTip":"cccccccccccccccccccccccccccccccccccccccc","checks":[{"name":"test:lane","status":"fail","severity":"blocking","detail":"1 tests failed:\n✖ boom"}]},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "a check again written without the mark is the environment's, and leaves the change's one" {
  inspect(
    land_step(
      landing_rows_rechecked(None),
      change_failed_facts(),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"call","helper":"prepare_land","site":"settle","fact":"call|prepare_land|settle","keep":{"id":"IDD-1","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mainTip":"cccccccccccccccccccccccccccccccccccccccc","branch":"work-main","reason":"変更の失敗と読んだ検査 test:lane を、同じ head と本流の先端で検査し直します","cause":"real","attempt":1},"args":{"id":"IDD-1","signed":false},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "the first check of a pair the mainline moved to is not that pair's check again" {
  inspect(
    land_step(
      landing_rows_rechecked_marked(Some("real"), true),
      change_failed_facts(),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"call","helper":"prepare_land","site":"settle","fact":"call|prepare_land|settle","keep":{"id":"IDD-1","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mainTip":"cccccccccccccccccccccccccccccccccccccccc","branch":"work-main","reason":"変更の失敗と読んだ検査 test:lane を、同じ head と本流の先端で検査し直します","cause":"real","attempt":1},"args":{"id":"IDD-1","signed":false},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "the check again started on the group the count read is written under that group" {
  inspect(
    land_step(
      landing_rows(),
      change_failed_facts_started(Some("c".repeat(40))),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"write","event":"s4_land_recheck","attrs":{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","main_tip":"cccccccccccccccccccccccccccccccccccccccc","reason":"変更の失敗と読んだ検査 test:lane","cause":"real","attempt":2}},{"do":"result","field":"checking","id":"IDD-1","checking":null},{"do":"end"}]}
    ),
  )
}

///|
test "the check again started on a tip the mainline moved to is written as that group's first" {
  inspect(
    land_step(
      landing_rows(),
      change_failed_facts_started(Some("d".repeat(40))),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"write","event":"s4_land_recheck","attrs":{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","main_tip":"dddddddddddddddddddddddddddddddddddddddd","reason":"変更の失敗と読んだ検査 test:lane","cause":"real","attempt":1,"moved":{"from_main_tip":"cccccccccccccccccccccccccccccccccccccccc"}}},{"do":"result","field":"checking","id":"IDD-1","checking":null},{"do":"end"}]}
    ),
  )
}

///|
/// A record of the lane's head with one failing structure row: `placed` says whether it fits the mainline tip
/// (`checked`) or was checked at an earlier one (`behind`).
fn structure_failed_facts(
  placed : String,
  row_structure : Json,
  swept : Bool,
) -> Json {
  let record = json_object([
    ("head", Json::string("a".repeat(40))),
    ("mainTip", Json::string("c".repeat(40))),
    ("blocking", Json::number(1.0)),
    (
      "checks",
      Json::array([
        json_object([
          ("name", Json::string("structure/duplicate-tokens")),
          ("status", Json::string("fail")),
          ("severity", Json::string("blocking")),
          ("detail", Json::string("本流 10 / 取り込み 12（+2）")),
          ("structure", row_structure),
        ]),
      ]),
    ),
  ])
  let fields = [
    ("branch|IDD-1|", Json::string("work-main")),
    ("head|IDD-1|", Json::string("a".repeat(40))),
    ("now|IDD-1|", Json::number(1000000000.0)),
    ("checked|IDD-1|", if placed == "checked" { record } else { Json::null() }),
    ("runEnded|IDD-1|", Json::boolean(false)),
    ("behind|IDD-1|", if placed == "behind" { record } else { Json::null() }),
    ("stacked|IDD-1|", Json::null()),
    ("unreviewed|IDD-1|", Json::null()),
    ("run|IDD-1|", Json::null()),
    ("runChecking|IDD-1|", Json::boolean(false)),
    ("attempted|IDD-1|", Json::boolean(false)),
  ]
  if swept {
    fields.push(
      ("call|carry_sweep|settle", json_object([("result", Json::null())])),
    )
  }
  json_object(fields)
}

///|
fn increase_kind() -> Json {
  json_object([
    ("kind", Json::string("increase")),
    ("command", Json::array([Json::string("node"), Json::string("count.mjs")])),
  ])
}

///|
fn unmeasured_kind(sides : Array[String]) -> Json {
  let items : Array[Json] = []
  for side in sides {
    items.push(Json::string(side))
  }
  json_object([
    ("kind", Json::string("unmeasured")),
    ("sides", Json::array(items)),
  ])
}

///|
test "a count that grew is sent back at once, without the check again" {
  inspect(
    land_step(
      landing_rows(),
      structure_failed_facts("checked", increase_kind(), true),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"call","helper":"send_back_land_check_failure","site":"settle","fact":"call|send_back_land_check_failure|settle","keep":{"id":"IDD-1","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","names":"structure/duplicate-tokens"},"args":{"id":"IDD-1","branch":"work-main","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mainTip":"cccccccccccccccccccccccccccccccccccccccc","checks":[{"name":"structure/duplicate-tokens","status":"fail","severity":"blocking","detail":"本流 10 / 取り込み 12（+2）","structure":{"kind":"increase","command":["node","count.mjs"]}}]},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "a record of the head that fell on a count at an earlier tip is settled, not checked afresh" {
  inspect(
    land_step(
      landing_rows(),
      structure_failed_facts("behind", increase_kind(), false),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"call","helper":"carry_sweep","site":"settle","fact":"call|carry_sweep|settle","keep":{"id":"IDD-1"},"args":{"id":"IDD-1"},"fatal":true,"reread":false}]}
    ),
  )
  inspect(
    land_step(
      landing_rows(),
      structure_failed_facts("behind", increase_kind(), true),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"call","helper":"send_back_land_check_failure","site":"settle","fact":"call|send_back_land_check_failure|settle","keep":{"id":"IDD-1","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","names":"structure/duplicate-tokens"},"args":{"id":"IDD-1","branch":"work-main","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mainTip":"cccccccccccccccccccccccccccccccccccccccc","checks":[{"name":"structure/duplicate-tokens","status":"fail","severity":"blocking","detail":"本流 10 / 取り込み 12（+2）","structure":{"kind":"increase","command":["node","count.mjs"]}}]},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "a record of the head at an earlier tip that failed on anything else is checked afresh" {
  inspect(
    land_step(
      landing_rows(),
      structure_failed_facts("behind", unmeasured_kind(["merged"]), false),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"call","helper":"carry_sweep","site":"fresh","fact":"call|carry_sweep|fresh","keep":{"id":"IDD-1"},"args":{"id":"IDD-1"},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "a count that could not be taken on the mainline's side is the environment's, and is checked again" {
  inspect(
    land_step(
      landing_rows(),
      structure_failed_facts("checked", unmeasured_kind(["mainline"]), true),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"call","helper":"prepare_land","site":"settle","fact":"call|prepare_land|settle","keep":{"id":"IDD-1","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mainTip":"cccccccccccccccccccccccccccccccccccccccc","branch":"work-main","reason":"structure/duplicate-tokens の本流の先端の数を測れませんでした","cause":"environment","attempt":1},"args":{"id":"IDD-1","signed":false},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "a count that could not be taken only on the merge commit's side is the change's, checked again once" {
  inspect(
    land_step(
      landing_rows(),
      structure_failed_facts("checked", unmeasured_kind(["merged"]), true),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"call","helper":"prepare_land","site":"settle","fact":"call|prepare_land|settle","keep":{"id":"IDD-1","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mainTip":"cccccccccccccccccccccccccccccccccccccccc","branch":"work-main","reason":"変更の失敗と読んだ検査 structure/duplicate-tokens を、同じ head と本流の先端で検査し直します","cause":"real","attempt":1},"args":{"id":"IDD-1","signed":false},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "the kind of a structure row is read from its field, not from the words of its detail" {
  let words = json_object([
    ("name", Json::string("structure/duplicate-tokens")),
    ("status", Json::string("fail")),
    ("severity", Json::string("blocking")),
    (
      "detail",
      Json::string("時間の上限（5 分）で打ち切りました"),
    ),
    ("structure", unmeasured_kind(["merged"])),
  ])
  let saved = json_object([
    ("head", Json::string("a".repeat(40))),
    ("mainTip", Json::string("c".repeat(40))),
    ("blocking", Json::number(1.0)),
    ("checks", Json::array([words])),
  ])
  inspect(
    land_failure(saved, Json::null()),
    content=(
      #|{"kind":"real","checks":[{"name":"structure/duplicate-tokens","status":"fail","severity":"blocking","detail":"時間の上限（5 分）で打ち切りました","structure":{"kind":"unmeasured","sides":["merged"]}}]}
    ),
  )
}

///|
/// The facts of a lane whose record failed `test:lane` on the test it names, with the round before it on the test named
/// there (when it names one).
fn named_tests_facts(now : String, earlier : String?) -> Json {
  let check = json_object([
    ("name", Json::string("test:lane")),
    ("status", Json::string("fail")),
    ("severity", Json::string("blocking")),
    ("detail", Json::string("1 tests failed")),
    ("failedTests", Json::array([Json::string(now)])),
  ])
  let fields = [
    ("head", Json::string("a".repeat(40))),
    ("mainTip", Json::string("c".repeat(40))),
    ("blocking", Json::number(1.0)),
    ("checks", Json::array([check])),
  ]
  match earlier {
    Some(name) =>
      fields.push(
        (
          "earlierFailed",
          Json::array([
            json_object([
              ("name", Json::string("test:lane")),
              ("tests", Json::array([Json::string(name)])),
            ]),
          ]),
        ),
      )
    None => ()
  }
  json_object([
    ("branch|IDD-1|", Json::string("work-main")),
    ("head|IDD-1|", Json::string("a".repeat(40))),
    ("now|IDD-1|", Json::number(1000000000.0)),
    ("checked|IDD-1|", json_object(fields)),
    ("run|IDD-1|", Json::null()),
    ("runChecking|IDD-1|", Json::boolean(false)),
    ("attempted|IDD-1|", Json::boolean(false)),
    ("call|carry_sweep|settle", json_object([("result", Json::null())])),
  ])
}

///|
test "a failure that moved to other tests after the check again is the environment's, checked again" {
  inspect(
    land_step(
      landing_rows_rechecked(Some("real")),
      named_tests_facts("wait-run", Some("steer")),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"call","helper":"prepare_land","site":"settle","fact":"call|prepare_land|settle","keep":{"id":"IDD-1","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mainTip":"cccccccccccccccccccccccccccccccccccccccc","branch":"work-main","reason":"test:lane の落ちたテストが前の回と重なりません（今回: wait-run / 前の回: steer）","cause":"environment","attempt":1},"args":{"id":"IDD-1","signed":false},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "a failure on the same test after the check again is sent back" {
  inspect(
    land_step(
      landing_rows_rechecked(Some("real")),
      named_tests_facts("steer", Some("steer")),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"call","helper":"send_back_land_check_failure","site":"settle","fact":"call|send_back_land_check_failure|settle","keep":{"id":"IDD-1","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","names":"test:lane"},"args":{"id":"IDD-1","branch":"work-main","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mainTip":"cccccccccccccccccccccccccccccccccccccccc","checks":[{"name":"test:lane","status":"fail","severity":"blocking","detail":"1 tests failed","failedTests":["steer"]}]},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "a failure with no round before it to compare with is the change's, checked again once" {
  inspect(
    land_step(
      landing_rows(),
      named_tests_facts("steer", None),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"call","helper":"prepare_land","site":"settle","fact":"call|prepare_land|settle","keep":{"id":"IDD-1","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mainTip":"cccccccccccccccccccccccccccccccccccccccc","branch":"work-main","reason":"変更の失敗と読んだ検査 test:lane を、同じ head と本流の先端で検査し直します","cause":"real","attempt":1},"args":{"id":"IDD-1","signed":false},"fatal":true,"reread":false}]}
    ),
  )
}

///|
test "a failure that moved to other tests is checked again three times, then waits for a person" {
  let rows = landing_rows()
  let head = "a".repeat(40)
  let main_tip = "c".repeat(40)
  for attempt in 1..<=3 {
    let line = "{\"idd_id\":\"IDD-1\",\"event\":\"s4_land_recheck\",\"at\":\"2026-10-23T10:0" +
      (3 + attempt).to_string() +
      ":00.000Z\",\"attrs\":{\"head\":\"" +
      head +
      "\",\"main_tip\":\"" +
      main_tip +
      "\",\"cause\":\"environment\",\"attempt\":" +
      attempt.to_string() +
      "}}"
    for row in derived_rows([line]) {
      rows.push(row)
    }
  }
  inspect(
    land_step(
      rows,
      named_tests_facts("wait-run", Some("steer")),
      "scan",
      3,
      120000.0,
    ),
    content=(
      #|{"steps":[{"do":"write","event":"s4_land_held","attrs":{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reason":"環境由来の失敗で 3 回検査し直しても通らないので、人の判断を待ちます（test:lane の落ちたテストが前の回と重なりません（今回: wait-run / 前の回: steer））"}},{"do":"result","field":"held","id":"IDD-1","reason":"環境由来の失敗で 3 回検査し直しても通らないので、人の判断を待ちます（test:lane の落ちたテストが前の回と重なりません（今回: wait-run / 前の回: steer））"},{"do":"end"}]}
    ),
  )
}
