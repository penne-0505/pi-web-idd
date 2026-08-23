# Case: blocked-verification

## Scenario

検証に必要な外部環境、権限、アカウント、デバイス、またはデータが不足し、round の
verdict が BLOCKED になる。

## Initial State

- `TODO.md` に `Size >= M` または `Risk >= Medium` のタスクがある。
- qa.md は存在し、Checks が定義されている。
- 必須検証の一部が実行できない。

## Agent Task

実行できた確認と blocker を分けて QA round に記録し、verdict を `BLOCKED` にして
タスクを TODO に残す。

## Expected Documents Touched

- `_docs/qa/<Area>/<slug>/qa.md` (round の追記)
- `TODO.md` (タスクは残る)

## Expected QA Behavior

- round の Commands には実行できたものだけを記録し、実行済み evidence と未実行項目を
  分離する。
- blocker、必要な入力、次アクションが具体的である (BLOCKED では必須)。
- Intent Delta / R2 は BLOCKED でも省略しない。
- `qa_status` を `blocked` にする。

## Expected Decision / Invariant Behavior

- blocker の存在を理由に DEC 記録やポインタ設置を省略しない (実装済みの判断は
  検証と独立に記録できる)。

## Expected TODO.md Behavior

- `BLOCKED` のまま TODO を削除しない (タスクは負債を持って閉じられない)。
- ユーザー入力が必要なら、一言で現状を伝えて指示を待つ (勝手に代替検証を発明しない)。

## Expected Validator Behavior

- `validate-qa` が verdict `BLOCKED` と `qa_status: blocked` の一致を検査する。
- 実行できる validator (`./scripts/check-docs.sh`) は実行する。

## Failure Modes to Watch

- blocker を曖昧にする。
- 未実行テストを成功扱いにする。
- `BLOCKED` verification なのに完了扱いにする。
- BLOCKED を理由に round の他フィールド (Intent Delta 等) まで省略する。
