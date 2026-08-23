# medium-feature

## Scenario

`Size >= M` の通常機能追加。実装前に Plan と QA 計画が必要で、確定した判断を intent に
記録し、完了時に R2 が発動する。

## Initial State

- `TODO.md` に `Size: M` 以上の Feat または Enhance タスクがある (`Size M` 以上は原則
  `Risk: Medium` 以上)。
- `Plan` は `_docs/plan/<Area>/<slug>/plan.md` を指し、対応ファイルが存在する。
- `QA` は `_docs/qa/<Area>/<slug>/qa.md` を指す。

## Agent Task

`prep` で TODO / Plan / 既存 DEC を整列させ、qa.md を `qa_status: planned` で書き始めて
から実装し、`close` で QA round・Intent Delta・R2 を記録してタスクの完了可否を判断する。

## Expected Documents Touched

- `_docs/plan/<Area>/<slug>/plan.md`
- `_docs/intent/<Area>/<slug>/decision.md`
- `_docs/qa/<Area>/<slug>/qa.md`
- 必要な場合のみ: `_docs/guide/<Area>/<slug>/usage.md` / `_docs/reference/<Area>/<slug>/reference.md`

## Expected QA Behavior

- qa.md は実装前に Acceptance Criteria と Checks 表を持つ (`qa_status: planned`)。
- 実装後に Round を追記する: 実行したコマンド、AC 充足、Intent Delta、R2、Verdict。
  planned の Checks を結果に合わせて書き換えない。
- `Size >= M` のため R2 が発動する: round に `R2: PENDING` を書き、`TODO.md` に
  R2 タスクを積む (同期形が使える環境では completion 前実行でもよい)。

## Expected Decision / Invariant Behavior

- 実装前に既存 DEC を grep し、既存判断の再発明を避ける。
- 機能の核となる設計判断は repo 一意の `DEC-*` として What / Why / Change freedom を持つ。
- 判断を体現するコードに `// intent: DEC-xxx — <因果>` ポインタを置く。
- INV は別実装でも守るべき結果がある場合だけ追加する。0 件でも正常。
- guide / reference は必要な場合のみ作り、未実装仕様を書かない。

## Expected TODO.md Behavior

- verdict が PASS または accepted PARTIAL になるまでタスクを削除しない。
- R2 タスクと追加作業は Backlog に別 ID で追加する。

## Expected Validator Behavior

- `validate-todo` が Plan / QA path と Area 一致を確認する。
- `validate-qa` が round の必須フィールド、`qa_status` と verdict の一致、R2 の presence
  (`Size >= M` での非発動宣言は不整合) を検査する。
- `validate-intent` が DEC の必須構造と ID 一意性を確認する。
- `validate-comments` がポインタ形式と散文コメント禁止を確認する。

## Failure Modes to Watch

- 実装後に qa.md を一括で書き、planned だったかのように整形する。
- `Plan` を `_docs/plan/<Area>/<slug>.md` のような非 canonical path に置く。
- DEC を作ったのに R2 を「非発動」として閉じる。
- ポインタを置かず、判断がコードから到達不能になる。
- guide / reference に未検証の仕様を書く。
