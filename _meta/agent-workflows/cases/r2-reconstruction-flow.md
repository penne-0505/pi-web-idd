# Case: r2-reconstruction-flow

## Scenario

前のセッションが DEC 新設を伴う変更を閉じ、QA round に `R2: PENDING` を書いて
`TODO.md` に R2 タスクを積んだ。次のセッション (実装時の文脈を自然に持たない agent) が
そのタスクを拾い、再構成テストを実行する。

## Initial State

- `TODO.md` に R2 タスクがあり、対象の diff (commit 範囲) と QA 文書が指定されている。
- 対象 qa.md の最終 round は `R2: PENDING`。
- 実装セッションの会話文脈は存在しない (これが隔離の primitive である)。

## Agent Task

R2 タスクを拾い、workflow.md の固定設問 4 問に「diff とリポジトリ内の docs・コードだけ」
から答え、結果と gap を QA round に追記する。

## Expected Documents Touched

- `_docs/qa/<Area>/<slug>/qa.md` (R2 結果の round 追記、PENDING の解消)
- gap があった場合: `TODO.md` に DEC 修繕タスクを追加

## Expected QA Behavior

- 固定設問に沿って答える: (1) 変更の why の再構成 (2) 根拠 DEC とその十分性
  (3) 壊さず拡張するための条件と、その根拠が docs にあったか (4) 再構成できなかった箇所。
- 再構成できなかった箇所・推測で補った箇所を gap として明示する。gap ゼロを装わない。
- この R2 実行自体も 1 round であり、Intent Delta (通常 `None:` か `applied:`) と
  Verdict を持つ。

## Expected Decision / Invariant Behavior

- gap は「docs の欠陥の発見」であり、agent がその場で DEC を推測で補筆して埋めない。
  修繕タスクとして積み、根拠 (実装者の意図) が必要なら user に確認する。
- 固定設問に実装セッションの文脈を追記しない。

## Expected TODO.md Behavior

- R2 タスクは完了後に削除する。gap 由来の修繕タスクは別 ID で Backlog に追加する。

## Expected Validator Behavior

- `validate-qa` が R2 フィールドの presence と PENDING の滞留 (>30 日 warning) を検査する。
- R2 の中身の質は validator では判定しない (R2 自体が質の検査である)。

## Failure Modes to Watch

- 実装 commit の message や会話ログ的な情報源から答えを写し、再構成テストの意味を失う。
- gap を発見したのに、修繕タスクを積まず口頭報告だけで終える。
- gap を埋めるために推測で DEC を書き足す (推測は記録ではなく質問にする)。
- PENDING を放置し続ける (滞留 warning を無視する)。
