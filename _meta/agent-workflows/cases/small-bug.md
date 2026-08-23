# small-bug

## Scenario

`Size < M` かつ `Risk: Low` の小さなバグ修正。設計判断は自明で、Plan は不要。
ループの存在は無条件であり、省略できるのは深さだけである。

## Initial State

- `TODO.md` の Backlog または Ready に `Size: XS` か `Size: S` の Bug タスクがある。
- タスクの `Plan` は `None`、`QA` は `_docs/qa/<Area>/maintenance.md` を指す。
- `Steps` に対象ファイルと確認手順が直接書かれている。

## Agent Task

タスクの Steps に従ってバグを修正し、maintenance.md へ QA round を 1 つ追記して
タスクを閉じる。

## Expected Documents Touched

- 必須: 対象コードまたは対象ドキュメント
- 必須: `_docs/qa/<Area>/maintenance.md` (round の追記)
- 不要: `_docs/plan/<Area>/<slug>/plan.md`、slug 専用の qa.md

## Expected QA Behavior

- round は数行でよいが、Commands / AC Coverage / Intent Delta / R2 / Verdict を欠かさない。
- Intent Delta は自明修正なら理由付き `None:` か `applied: DEC-xxx`。裸の `None` は不可。
- R2 は発動条件 (DEC 新設 / `Size >= M` / `Risk High`) に該当しないため「非発動」。
- Regression risk がある場合は regression test または no-test rationale を残す。

## Expected Decision / Invariant Behavior

- 自明な小規模修正のためだけに DEC / INV を新設しない。
- 修正中に非自明な判断 (意図的省略・境界の選択) が現れた場合だけ DEC を作り、
  Intent Delta を `DEC-xxx 新設` に切り替える (この場合 R2 が発動する)。

## Expected TODO.md Behavior

- verdict が PASS になった後、対象タスクを `TODO.md` から削除する。
- Done / Archived セクションを作らない。
- 発見した追加作業があれば、新規 ID で Backlog に追加する。

## Expected Validator Behavior

- `validate-todo` が `Plan: None` と maintenance.md への QA path を許容する。
- `validate-qa` が round の必須フィールドと裸の `None` を検査する。
- `validate-intent-delta` が「code diff があるのに QA 変更がない」を検出する。

## Failure Modes to Watch

- 「小さい変更だから」と QA round 自体を省略する (深さではなく存在を削っている)。
- Intent Delta を書かずに閉じる、または裸の `None` で埋める。
- 小規模タスクなのに slug 専用の qa.md や Plan ディレクトリを作る (過剰な深さ)。
- 完了タスクを Done セクションへ移動する。
- `rm` / `git rm` で不要ファイルを削除する。
