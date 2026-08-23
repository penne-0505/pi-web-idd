# breaking-change

## Scenario

既存 API やデータ形式を変更する破壊的変更。migration / rollback / compatibility を明記する
必要があり、`Risk High` の深さ要件と R2 が発動する。

## Initial State

- `TODO.md` に `Size: M` 以上の Refactor または Enhance タスクがある。
- `Risk` は High (互換性・データ損失・migration に関わるため、証明がない限り下げない)。
- `Plan` は `_docs/plan/<Area>/<slug>/plan.md` を指す。既存 guide / reference が影響を受ける。

## Agent Task

Plan に migration、rollback、compatibility を追記し、qa.md を `qa_status: planned` で
準備してから実装し、rollback / recovery / data safety の確認を経て verdict を出す。

## Expected Documents Touched

- `_docs/plan/<Area>/<slug>/plan.md`
- `_docs/intent/<Area>/<slug>/decision.md`
- `_docs/qa/<Area>/<slug>/qa.md`
- `_docs/reference/<Area>/<slug>/reference.md` (影響を受ける場合)
- 必要に応じて `_docs/guide/<Area>/<slug>/usage.md`

## Expected QA Behavior

- Checks に rollback / recovery / security / data safety / compatibility の確認手段を含める。
- `Risk High` のため完了前の verdict が必須。migration / rollback / compatibility の
  evidence なしに PASS を出さない。
- `Risk High` のため R2 が発動する (`R2: PENDING` + TODO への R2 タスク、または同期形)。
- 延期した compatibility check には理由と follow-up を残し、verdict を PARTIAL にする。

## Expected Decision / Invariant Behavior

- migration、compatibility、rollback の判断は `DEC-*` として理由と Change freedom を残す。
  実際に検討した棄却案があれば Why not に書く。
- 移行中も常に守る必要がある安全条件がある場合だけ `INV-*` を定義する。移行中だけの
  保全条件は INV にしない。
- 古い reference を active のまま残さず、`status` で廃止を表す。

## Expected TODO.md Behavior

- verdict のないまま完了扱いにしない。FAIL / BLOCKED ならタスクを残す。
- 移行後の follow-up と R2 タスクは別 ID で Backlog に追加する。

## Expected Validator Behavior

- `validate-todo` が Size / Risk の深さ要件 (Plan / QA) を確認する。
- `validate-qa` が qa frontmatter、round フィールド、verdict と `qa_status` の一致を検査する。
- `validate-doc-links` が更新 references のリンク切れを検出しない。

## Failure Modes to Watch

- rollback 方針なしで破壊的変更を進める。
- High を Medium に過小申告する (作業量ではなく失敗時の影響で判断する)。
- 互換性リスクの判断を intent に残さない。
- R2 を発動させずに閉じる。
- 古い reference を active のまま放置する。
