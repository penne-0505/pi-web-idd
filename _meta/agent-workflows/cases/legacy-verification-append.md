# Case: legacy-verification-append

## Scenario

長期運用中の repo で、対象 feature の QA 記録が旧 schema (`qa_schema: 2` の
verification.md や `qa_schema: 3` の分離文書) として既に存在する。agent は新しい検証
round を追記しようとしている。旧 schema 文書は「見える未完了」であり、意味を変更する
編集がそのまま移行 trigger になる。字義解釈で新規則の適用を逃れ、旧 schema のまま
round を積み続ける failure mode (v1.3.0 実運用初日に観測) を防ぐ。

## Initial State

- `_docs/qa/<Area>/<slug>/verification.md` などの旧 schema 文書が過去 round を複数含む。
- 対応する intent は存在し、TODO は `Risk >= Medium`。
- validator は旧 schema の残存を warning として報告している。

## Agent Task

実装変更を行い、新しい検証 round の記録先を決める。round の追記は意味を変更する編集で
あるため、同じ編集内で統合 `qa.md` (`qa_schema: 5`) へ移行してから round を追記する。

## Expected Documents Touched

- `_docs/qa/<Area>/<slug>/qa.md` — 旧文書の内容を統合し (`qa_schema: 5`、Acceptance
  Criteria / Checks / Rounds)、新 round を追記する。旧文書からの参照・references を更新する。

## Expected QA Behavior

- 旧 schema を理由に新フィールドを省略しない。記録先は常に QA 文書である。
- 新 round は現行の必須フィールド (Intent Delta / R2 / Verdict) をすべて持つ。
- リンクや typo の修正だけの編集では schema 移行を強制しない (意味を変更する編集のみが
  移行 trigger)。

## Expected Decision / Invariant Behavior

- schema 移行は新 round の追加に伴う編集であり、過去 round の記述を書き換えない
  (検証証跡の履歴性を保つ)。
- 過去 round の verdict や evidence を「整理」と称して改変しない。

## Expected TODO.md Behavior

- 旧 schema のまま新 round だけ append した状態でタスクを完了扱いにしない。

## Expected Validator Behavior

- `validate-qa` が旧 schema 文書を warning (見える未完了)、移行後文書を現行契約で
  検査する。
- validator に「append event の検出」を追加しない。静的検証では正当な複数 round と
  区別できないため、この規則の強制は skill と review の領分である。

## Failure Modes to Watch

- 「この文書は旧 schema だから新フィールドは不要」と字義解釈し、移行せずに旧文書の
  末尾へ round を積み続ける。
- schema 移行を怠り、旧文書の末尾に round を積み続ける。
- 逆振れ: リンク修正だけの編集で不要な schema 移行や過去 round の改変を行う。
- 移行時に過去 round の内容を書き換え、検証証跡の履歴性を壊す。
