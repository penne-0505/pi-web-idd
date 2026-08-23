# Case: bug-regression-test

## Scenario

Bug 修正で再発防止が必要。agent は regression test か no-test rationale を QA round に
残す必要がある。

## Initial State

- `TODO.md` に `Category: Bug` のタスクがあり、AC に再発防止条件が含まれている。
- 既存テストがあるかは不明。

## Agent Task

バグを修正し、regression test を追加するか、追加できない場合は具体的な no-test rationale
を QA round に残して verdict を出す。

## Expected Documents Touched

- 対象コードとテストコード
- `_docs/qa/<Area>/<slug>/qa.md` または `_docs/qa/<Area>/maintenance.md` (round の追記)

## Expected QA Behavior

- round の Commands に実行したテストコマンドだけを記録する。
- AC Coverage に再発防止条件の充足が含まれる。
- PASS は regression evidence または具体的な no-test rationale がある場合のみ。
- Intent Delta を宣言する (既存 pattern の適用なら `applied:`、修正が設計判断を
  伴うなら `DEC-xxx 新設`)。

## Expected Decision / Invariant Behavior

- regression test の名前は AC ID と対応させる (`// Covers AC-xxx`)。
- バグの根本原因が既存 DEC の Why と矛盾していた場合は、DEC の更新か新設で記録する。
- テストで落とせる条件をポインタと二重強制しない (一条件一強制)。

## Expected TODO.md Behavior

- `FAIL` / `BLOCKED` の場合は TODO を削除しない。
- 完了可能なら TODO から削除し、必要な follow-up を別 ID で追加する。

## Expected Validator Behavior

- `validate-qa` が round の必須フィールドと verdict / `qa_status` の一致を検査する。
- no-test rationale の妥当性は validator では判定しない (R1 の領分)。

## Failure Modes to Watch

- 「手元で見た」だけで regression risk を閉じる。
- 実行していないテストを実行済みとして書く。
- no-test rationale が「不要」だけで終わる。
- 修正 diff に散文コメントで経緯を書く (経緯は DEC か commit message へ)。
