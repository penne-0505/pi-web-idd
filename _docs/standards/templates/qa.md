---
title: "QA: <Feature>"
status: active
qa_status: planned
risk: Medium
qa_schema: 5
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
references:
  - "_docs/intent/<Area>/<slug>/decision.md"
  - "_docs/plan/<Area>/<slug>/plan.md"
related_issues: []
related_prs: []
---

# QA: `<Feature>`

<!-- Canonical path: _docs/qa/<Area>/<slug>/qa.md -->
<!-- 計画 (実装前) と検証記録 (実装後) の単一文書。qa_status がライフサイクルを表す:
     planned -> in-progress -> verified | partial | failed | blocked -->
<!-- Verdict / qa_status mapping: PASS -> verified, PARTIAL -> partial, FAIL -> failed, BLOCKED -> blocked -->
<!-- 微小変更 (Intent Delta が applied / None のみ) はこの雛形を使わず、
     _docs/qa/<Area>/maintenance.md へ Round を 1 つ追記する。 -->

## Acceptance Criteria

<!-- TODO と同期。AC-001 形式の安定 ID を振る。 -->

- AC-001:

## Checks

<!-- 各 AC / 適用 INV をどう確認するかを実装前に書く。実装後に書き換えない。 -->

| ID | Source | Requirement / Invariant | Check Type | Command / File | Status |
| --- | --- | --- | --- | --- | --- |
| AC-001 | TODO | ... | unit \| validator \| manual \| diff-review | ... | planned |

<!-- Status: planned | covered | verified | deferred (要理由) | not-applicable -->
<!-- INV 行は対応 intent に INV が存在する場合のみ。 -->

## Rounds

<!-- 追記専用。過去の round を結果に合わせて書き換えない。 -->

### Round 1 (YYYY-MM-DD)

- **Commands**:

  ```bash
  # 実際に実行したコマンドのみを書く
  ```

- **AC Coverage**: AC-001 ...
- **Intent Delta**: DEC-xxx 新設 | applied: DEC-xxx | None: <理由>
- **R2**: PENDING | RECONSTRUCTED | gap: <...> | 非発動
  <!-- 発動条件: DEC 新設 / Size >= M / Risk High。非該当なら「非発動」と書く。 -->
- **Verdict**: PASS | PARTIAL | FAIL | BLOCKED
  <!-- PARTIAL / FAIL / BLOCKED では残リスクと次アクションを必須で書く。 -->
