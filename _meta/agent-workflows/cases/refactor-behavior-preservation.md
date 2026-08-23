# Case: refactor-behavior-preservation

## Scenario

Refactor タスクで外部挙動を変えずに内部構造を整理する。agent は behavior-preservation
checks を優先し、影響する DEC の Change freedom の範囲内で作業する必要がある。

## Initial State

- `TODO.md` に `Category: Refactor` のタスクがある (`Risk: Medium` 以上)。
- 対象モジュールの公開挙動や既存 tests がある。
- 対象コードに `// intent: DEC-xxx` ポインタが置かれている場合がある。

## Agent Task

既存挙動と既存 DEC の Why を保ったまま refactor し、qa.md の Checks と round に
behavior-preservation の evidence を残す。

## Expected Documents Touched

- 対象コード
- `_docs/qa/<Area>/<slug>/qa.md`
- 必要な場合のみ `_docs/intent/<Area>/<slug>/decision.md` (Change freedom 内の構造変更なら
  DEC の更新は不要)

## Expected QA Behavior

- Checks に behavior-preservation の確認手段 (既存テスト / snapshot / golden / manual QA)
  が含まれる。
- round の Intent Delta は、既存判断の範囲内なら `applied: DEC-xxx`。Change freedom を
  超える変更を行った場合は DEC の更新・新設として宣言する。
- `Size >= M` または `Risk High` なら R2 が発動する。

## Expected Decision / Invariant Behavior

- refactor で移動・書き換えたコードのポインタコメントを維持する (判断が生きている限り
  ポインタも生きる)。
- 影響する DEC の Why に照らして構造変更の妥当性を確認する。INV があれば別実装でも
  守られていることを検証する。
- brittle test (内部構造や変数名を固定するテスト) を追加しない。

## Expected TODO.md Behavior

- 検証が `PASS` または accepted `PARTIAL` になるまで TODO を削除しない。

## Expected Validator Behavior

- `validate-comments` が移動後のポインタ形式を検査する (ポインタの置き忘れ自体は
  機械検出できず、R1 / R2 の領分)。
- `validate-qa` が round フィールドと verdict 整合を検査する。

## Failure Modes to Watch

- 内部構造の説明だけで挙動維持を確認しない。
- refactor 中にポインタコメントを落とし、判断がコードから到達不能になる。
- unrelated refactor を混ぜる。
- test failures を「refactor なので無関係」として放置する。
