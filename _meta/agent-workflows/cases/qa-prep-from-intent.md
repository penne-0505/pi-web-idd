# Case: qa-prep-from-intent

## Scenario

`Risk >= Medium` のタスクで、Plan と Intent は存在するが qa.md が未作成。agent は
実装を始める前に、intent の判断と AC から QA 計画 (`qa_status: planned`) を作る必要がある。

## Initial State

- `TODO.md` に `Size: M` 以上または `Risk: Medium` 以上のタスクがある。
- `Plan` は `_docs/plan/<Area>/<slug>/plan.md` を、`Intent` は
  `_docs/intent/<Area>/<slug>/decision.md` を指す。
- `QA` の指す `_docs/qa/<Area>/<slug>/qa.md` がまだ存在しない。

## Agent Task

`prep` skill を実行し、TODO / Plan / Intent から qa.md を `qa_status: planned` で作成する。
実装はまだ始めない。

## Expected Documents Touched

- `_docs/qa/<Area>/<slug>/qa.md` (新規、`qa_schema: 5`)
- 必要な場合のみ `TODO.md` (QA path の確定)

## Expected QA Behavior

- Acceptance Criteria が TODO の AC と対応している。
- Checks 表が各 AC (と適用 INV) に確認手段 (unit / validator / manual / diff-review) と
  Status (`planned`) を割り当てている。
- 影響を受ける既存 `DEC-*` を把握したうえで Checks を書く (intent を読まずに一般的な
  テスト項目だけを並べない)。
- Rounds はまだ空でよい。実装前に verdict を書かない。

## Expected Decision / Invariant Behavior

- Intent に `INV-*` がなければ INV 行を作らない (0 件は正常)。
- Intent に存在しない INV を Checks にでっち上げない。

## Expected TODO.md Behavior

- `QA` フィールドが `_docs/qa/<Area>/<slug>/qa.md` を指す (`None` は不可)。
- タスクは完了扱いにしない。

## Expected Validator Behavior

- `validate-qa` が frontmatter (`qa_status: planned` / `risk`)、必須節、references を検証する。
- `validate-todo` が QA path と Area 一致、Risk 深さ要件を検証する。

## Failure Modes to Watch

- intent を読まずに一般的なテスト項目だけを書く。
- Checks に AC がない、または Intent に存在しない INV を作る。
- 実装後にまとめて qa.md を作り、planned 段階を偽装する。
- references に root-relative canonical path を使わない。
