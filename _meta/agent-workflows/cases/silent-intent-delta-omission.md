# Case: silent-intent-delta-omission

## Scenario

agent がコード変更を終え、QA round を書かずに (または Intent Delta を書かずに) タスクを
閉じようとする。ループの presence は無条件であり、validator は「diff があるのに宣言が
ない」を意味判断なしに error にする。

## Initial State

- `TODO.md` にタスクがあり、実装 diff は完成している。
- QA 文書 (qa.md または maintenance.md) に対応する round がまだない。

## Agent Task

`close` skill を実行し、QA round と Intent Delta を記録してからタスクの完了可否を
判断する。

## Expected Documents Touched

- `_docs/qa/<Area>/<slug>/qa.md` または `_docs/qa/<Area>/maintenance.md`
- Intent Delta が `DEC-xxx 新設` の場合: `_docs/intent/<Area>/<slug>/decision.md`

## Expected QA Behavior

- code diff と同じ変更単位に QA 文書の変更が含まれる。
- Intent Delta は三値のいずれかで、`None` には必ず理由が付く。

## Expected Decision / Invariant Behavior

- 「ドキュメントは後でまとめて」とせず、変更単位ごとに宣言する。ターン終端で未対応が
  残った場合は、作業を始めずに一言だけ現状を伝え、次の指示で処理する。

## Expected TODO.md Behavior

- round と verdict の揃っていないタスクを TODO から消さない。

## Expected Validator Behavior

- `validate-intent-delta` が「code / sensitive 変更があるのに QA 文書の変更がない」diff を
  error にする (CI では `DD_DELTA_BASE` により PR base との diff を検査する)。
- `validate-qa` が round 内の Intent Delta の presence と裸の `None` を検査する。

## Failure Modes to Watch

- 実装だけ commit し、QA round を「次のターンで」と先送りしたままタスクを閉じる。
- 裸の `None` や「特になし」で宣言欄を埋める。
- validator を通すためだけの空虚な round を書く (Commands に実行していないコマンドを
  書く)。
