# Agent Workflow Evals

このディレクトリは、自動テストというより agent 行動の回帰確認用 golden task 集です。
Claude Code、Codex、汎用 coding agent に同じケースを渡したとき、`TODO.md` と `_docs/` の
運用規約 — 常時 ON のループ (`TODO (AC) → 実装 → Intent Delta → QA round`)、DEC / INV、
コメント allowlist、R1 / R2 — を守れるかを確認します。規範の正典は
`_docs/standards/` であり、本ディレクトリは検証素材にすぎません。

ワークフロー系ケースは原則同じ構造で書かれています (概念系ケースは短縮形を許容)。

- Scenario / Initial State / Agent Task
- Expected Documents Touched
- Expected QA Behavior (round のフィールド: Intent Delta / R2 / Verdict)
- Expected Decision / Invariant Behavior
- Expected TODO.md Behavior
- Expected Validator Behavior
- Failure Modes to Watch

将来は、ケースごとの期待差分を固定し、自動比較 runner に接続できる形へ拡張できます。
現時点では、人間が agent の出力と差分をレビューするための基準として使います。

## Cases

ループと深さ:

- [small-bug](cases/small-bug.md) — 最小深さでもループの存在は無条件
- [medium-feature](cases/medium-feature.md) — `Size >= M` の Plan / planned QA / R2
- [breaking-change](cases/breaking-change.md) — `Risk High` の深さ要件
- [high-risk-change-verification](cases/high-risk-change-verification.md) — 完了前 verdict 必須
- [blocked-verification](cases/blocked-verification.md) — BLOCKED の扱い
- [silent-intent-delta-omission](cases/silent-intent-delta-omission.md) — 無言の省略の機械検出

intent と記録:

- [intentional-omission-risk](cases/intentional-omission-risk.md) — 意図的省略の宣言
- [comment-allowlist-triage](cases/comment-allowlist-triage.md) — 散文の行き先は DEC
- [rationale-preserving-change](cases/rationale-preserving-change.md) — 値でなく why を守る
- [misleading-optimization](cases/misleading-optimization.md) — 構造でなく判断理由をレビュー
- [experimental-baseline](cases/experimental-baseline.md) — 実験値を永久仕様にしない
- [intent-mining-adoption](cases/intent-mining-adoption.md) — 後付け導入での意図採掘

レビュー:

- [r2-reconstruction-flow](cases/r2-reconstruction-flow.md) — R2 PENDING の受け渡し

QA 記録の整合:

- [bug-regression-test](cases/bug-regression-test.md)
- [refactor-behavior-preservation](cases/refactor-behavior-preservation.md)
- [qa-prep-from-intent](cases/qa-prep-from-intent.md)
- [qa-status-verdict-mismatch](cases/qa-status-verdict-mismatch.md)
- [legacy-verification-append](cases/legacy-verification-append.md) — 旧 schema は見える未完了

構造と安全:

- [archive-flow](cases/archive-flow.md) — archive は plan のみ
- [malformed-todo-heading](cases/malformed-todo-heading.md)
- [historical-prompt-not-operational](cases/historical-prompt-not-operational.md)
- [agent-workflow-misbehavior-check](cases/agent-workflow-misbehavior-check.md) — Risk 自動下限
- [template-version-migration](cases/template-version-migration.md)

## Expected Invariants

全ケース共通の不変条件は [expected-invariants.md](expected-invariants.md) を参照してください。
