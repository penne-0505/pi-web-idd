// The ledger's remaining readings, in the fold's own words.
//
// The wider promise — that these answers are the ones the TypeScript reading gave — is held by the fixture test
// (`packages/idd-core/test/ledger-reads.test.mjs`) and against a real ledger (`crosscheck.mjs`). These say what each
// reading does with rows and facts a real ledger may not carry.

///|
/// One derived row out of its JSON text.
fn read_row(text : String) -> DerivedRow {
  derived_row_of(
    @json.parse(text) catch {
      error => abort("テストの行が JSON ではありません: \{error}")
    },
  )
}

///|
/// A lane's rows out of their JSON texts.
fn read_rows(texts : Array[String]) -> Array[DerivedRow] {
  let rows : Array[DerivedRow] = []
  for text in texts {
    rows.push(read_row(text))
  }
  rows
}

///|
test "a lane waits on its PR until a later submit, push, failure or result moves it on" {
  let rows = read_rows([
    "{\"idd_id\":\"L\",\"event\":\"s4_submit_started\",\"at\":\"2026-10-24T09:00:00+09:00\",\"attrs\":{}}",
    "{\"idd_id\":\"L\",\"event\":\"s4_pr_created\",\"at\":\"2026-10-24T09:01:00+09:00\",\"attrs\":{\"pr_number\":7,\"pr_url\":\"u\"}}",
  ])
  inspect(
    awaiting_merge_answer(rows).stringify(),
    content=(
      #|{"waiting":true,"prNumber":7,"prUrl":"u"}
    ),
  )
  // a result after the PR was created moves the lane on: it no longer waits on that PR
  let moved = read_rows([
    "{\"idd_id\":\"L\",\"event\":\"s4_pr_created\",\"at\":\"2026-10-24T09:01:00+09:00\",\"attrs\":{\"pr_number\":7}}",
    "{\"idd_id\":\"L\",\"event\":\"s2_result\",\"at\":\"2026-10-24T09:02:00+09:00\",\"attrs\":{}}",
  ])
  inspect(
    awaiting_merge_answer(moved).stringify(),
    content=(
      #|{"waiting":false}
    ),
  )
  // a row without a number has none: a null number is 0, and 0 is a number the close can read
  let no_number = read_rows([
    "{\"idd_id\":\"L\",\"event\":\"s4_pr_created\",\"at\":\"2026-10-24T09:01:00+09:00\",\"attrs\":{\"pr_url\":\"u\"}}",
  ])
  inspect(
    awaiting_merge_answer(no_number).stringify(),
    content=(
      #|{"waiting":false}
    ),
  )
  let null_number = read_rows([
    "{\"idd_id\":\"L\",\"event\":\"s4_pr_created\",\"at\":\"2026-10-24T09:01:00+09:00\",\"attrs\":{\"pr_number\":null}}",
  ])
  inspect(
    awaiting_merge_answer(null_number).stringify(),
    content=(
      #|{"waiting":true,"prNumber":0,"prUrl":""}
    ),
  )
}

///|
test "a lane penne took out is discarded, and one closed by hand is not" {
  let stopped = read_rows([
    "{\"idd_id\":\"L\",\"event\":\"s1_defer\",\"at\":\"2026-10-24T09:00:00+09:00\",\"attrs\":{}}",
  ])
  inspect(
    lane_ends_answer(stopped).stringify(),
    content=(
      #|{"finally":true,"discarded":true}
    ),
  )
  let redone = read_rows([
    "{\"idd_id\":\"L\",\"event\":\"lane_close\",\"at\":\"2026-10-24T09:00:00+09:00\",\"attrs\":{\"outcome\":\"redone\"}}",
  ])
  inspect(
    lane_ends_answer(redone).stringify(),
    content=(
      #|{"finally":true,"discarded":true}
    ),
  )
  let merged = read_rows([
    "{\"idd_id\":\"L\",\"event\":\"lane_close\",\"at\":\"2026-10-24T09:00:00+09:00\",\"attrs\":{\"outcome\":\"merged\"}}",
  ])
  inspect(
    lane_ends_answer(merged).stringify(),
    content=(
      #|{"finally":true,"discarded":false}
    ),
  )
  // a hold at S3 says the lane may be taken up again: its worktree is not retired
  let held = read_rows([
    "{\"idd_id\":\"L\",\"event\":\"s3_defer\",\"at\":\"2026-10-24T09:00:00+09:00\",\"attrs\":{}}",
  ])
  inspect(
    lane_ends_answer(held).stringify(),
    content=(
      #|{"finally":false,"discarded":false}
    ),
  )
}

///|
test "the worktree is retired only when every fact the pass gathered is there" {
  let ended = read_rows([
    "{\"idd_id\":\"L\",\"event\":\"lane_close\",\"at\":\"2026-10-24T09:00:00+09:00\",\"attrs\":{}}",
  ])
  let all = @json.parse(
    "{\"hasWorktreePath\":true,\"hasLocalPath\":true,\"hasWorkBase\":true,\"exists\":true}",
  ) catch {
    error => abort("テストの事実が JSON ではありません: \{error}")
  }
  inspect(
    retire_pick_answer(ended, all).stringify(),
    content=(
      #|{"pick":true}
    ),
  )
  let missing = @json.parse(
    "{\"hasWorktreePath\":true,\"hasLocalPath\":true,\"hasWorkBase\":true,\"exists\":false}",
  ) catch {
    error => abort("テストの事実が JSON ではありません: \{error}")
  }
  inspect(
    retire_pick_answer(ended, missing).stringify(),
    content=(
      #|{"pick":false}
    ),
  )
}

///|
test "the kept's record is written once for one path and one reason" {
  let rows = read_rows([
    "{\"idd_id\":\"L\",\"event\":\"lane_worktree_kept\",\"at\":\"2026-10-24T09:00:00+09:00\",\"attrs\":{\"path\":\"/w\",\"reason\":\"session\"}}",
  ])
  let same = @json.parse("{\"path\":\"/w\",\"reason\":\"session\"}") catch {
    error => abort("テストの事実が JSON ではありません: \{error}")
  }
  inspect(
    retire_kept_answer(rows, same).stringify(),
    content=(
      #|{"write":false}
    ),
  )
  let other = @json.parse("{\"path\":\"/w\",\"reason\":\"dirty\"}") catch {
    error => abort("テストの事実が JSON ではありません: \{error}")
  }
  inspect(
    retire_kept_answer(rows, other).stringify(),
    content=(
      #|{"write":true}
    ),
  )
}

///|
test "the PR text is drafted only once the submit view and the repo are there, and read only then" {
  let rows = read_rows([
    "{\"idd_id\":\"L\",\"event\":\"s4_submit_started\",\"at\":\"2026-10-24T09:00:00+09:00\",\"attrs\":{}}",
  ])
  let base = @json.parse(
    "{\"publishes\":true,\"hasDraftRunner\":true,\"hasPrDraft\":false,\"openPr\":false}",
  ) catch {
    error => abort("テストの事実が JSON ではありません: \{error}")
  }
  inspect(
    pr_draft_pick_answer(rows, base).stringify(),
    content=(
      #|{"needs":[{"id":"prDraftMaterial||","kind":"prDraftMaterial","a":"","b":""}]}
    ),
  )
  let read = @json.parse(
    "{\"publishes\":true,\"hasDraftRunner\":true,\"hasPrDraft\":false,\"openPr\":false,\"prDraftMaterial||\":{\"hasView\":true,\"hasRepo\":true}}",
  ) catch {
    error => abort("テストの事実が JSON ではありません: \{error}")
  }
  inspect(
    pr_draft_pick_answer(rows, read).stringify(),
    content=(
      #|{"pick":true}
    ),
  )
  // a draft that failed after this submit keeps the card on the plain list
  let failed = read_rows([
    "{\"idd_id\":\"L\",\"event\":\"s4_submit_started\",\"at\":\"2026-10-24T09:00:00+09:00\",\"attrs\":{}}",
    "{\"idd_id\":\"L\",\"event\":\"s4_pr_draft_failed\",\"at\":\"2026-10-24T09:01:00+09:00\",\"attrs\":{\"error\":\"boom\"}}",
  ])
  inspect(
    pr_draft_pick_answer(failed, base).stringify(),
    content=(
      #|{"pick":false}
    ),
  )
}

///|
test "a closed lane keeps the later of its ends, and an unreadable time is no time" {
  let rows = read_rows([
    "{\"idd_id\":\"A\",\"event\":\"s1_defer\",\"at\":\"2026-10-24T09:00:00+09:00\",\"attrs\":{}}",
    "{\"idd_id\":\"B\",\"event\":\"lane_close\",\"at\":\"読めない\",\"attrs\":{}}",
    "{\"idd_id\":\"A\",\"event\":\"lane_close\",\"at\":\"2026-10-24T10:00:00+09:00\",\"attrs\":{}}",
  ])
  inspect(
    closed_lanes_answer(rows).stringify(),
    content=(
      #|[{"idd":"A","at":1792803600000},{"idd":"B","at":null}]
    ),
  )
}
