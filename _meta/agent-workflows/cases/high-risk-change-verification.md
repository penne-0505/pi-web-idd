# Case: high-risk-change-verification

## Scenario

認証、権限、データ安全性、migration などに関わる High risk 変更。完了前の verdict が
必須であり、R2 も発動する。

## Initial State

- `TODO.md` に `Risk: High` または `Risk: Critical` のタスクがある。
- Plan / Intent / qa.md (`qa_status: planned` 以降) が存在する。
- 検証 round はまだ記録されていない。

## Agent Task

実装後に rollback / recovery / security / data safety の確認を実行または明記し、
QA round に verdict を出し、R2 を発動させる。

## Expected Documents Touched

- `_docs/qa/<Area>/<slug>/qa.md` (round の追記)
- `TODO.md` (R2 タスクと follow-up)
- 必要に応じて `_docs/plan/<Area>/<slug>/plan.md` / `_docs/intent/<Area>/<slug>/decision.md`

## Expected QA Behavior

- rollback / recovery / security / data safety の確認が Checks と round の evidence に
  現れる。省略する項目には理由を残す。
- 未確認リスクは残リスクとして round に記録され、verdict は PASS にならない
  (`PARTIAL` / `FAIL` / `BLOCKED` では残リスクと次アクションが必須)。
- `Risk High` のため R2 が発動する (`R2: PENDING` + TODO への R2 タスク、または同期形)。

## Expected Decision / Invariant Behavior

- security / data safety 上の判断 (何を守り、何を許容したか) は DEC に残す。
- 移行中だけの保全条件を INV にしない。

## Expected TODO.md Behavior

- verdict がないまま完了扱いにしない。`FAIL` / `BLOCKED` なら TODO を残す。
- R2 タスクを Backlog に積む。

## Expected Validator Behavior

- `validate-qa` が verdict と `qa_status` の一致、round の必須フィールド、High risk での
  R2 presence を検査する。
- `validate-todo` が Risk 深さ要件 (Intent / QA) を確認する。

## Failure Modes to Watch

- High risk を Medium として過小申告する。
- rollback や recovery を「不要」の一言で済ませる。
- verdict なしで TODO を削除する。
- R2 を発動させずに閉じる。
