---
title: Intent / Decision Title
status: active  # allowed: proposed | active | superseded | obsolete
intent_schema: 3
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
references:
  - "_docs/plan/<Area>/<slug>/plan.md"
  - "_docs/qa/<Area>/<slug>/qa.md"
related_issues: []
related_prs: []
---

<!-- Canonical path: _docs/intent/<Area>/<slug>/decision.md -->
<!-- 設計判断の why / why not を記録する恒久文書。archive しません。 -->
<!-- DEC / INV の ID はリポジトリ全体で一意。採番は既存 ID の最大値 + 1。 -->
<!-- 書いてよいもの: why 成分、判断履歴。書かないもの: 現在値の言い換え、コードから再構成できる how。 -->

## Context
- 背景と課題

## Decisions

### DEC-XXX: Decision title

- **What**: 採用した方針・設計 (現在値の羅列ではなく、選択した意味)
- **Why**: 解決する問題、守る性質、避ける失敗との因果
- **Change freedom**: Why を保つ限り変更できる実装方式・値・構造
<!-- Optional fields: `- **Why not**: 一見妥当に見える不採用案と、その案では目的を満たせない理由`, `- **Revisit when**: 再検討を可能にする証拠・条件` -->

## Consequences / Impact
- 影響範囲（API/データ/セキュリティ/パフォーマンス など）

## Quality Implications
- この判断が守るべき品質条件
- 破ると起きる回帰・運用リスク
- QA (qa.md) の Checks で確認すべき観点

## Intent-derived Invariants
<!-- 任意。active decision 下で実装方式が変わっても破れない結果だけを書く。比較条件、現行値、migration 中だけの保全条件を INV にしない。0 件なら None。 -->
None
<!-- 必要な場合の形式: `- INV-XXX (from DEC-XXX): 実装方式が変わっても破れない結果` -->

## Rollback / Follow-ups
- ロールバック方針や追加フォロー項目
