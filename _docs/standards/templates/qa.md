---
title: "QA: <Feature>"
status: active
qa_status: planned
risk: Medium
qa_schema: 5
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
references:
  - "_docs/reference/<Area>/<slug>/reference.md"
related_issues: []
related_prs: []
---

# QA: `<Feature>`

<!-- Canonical path: _docs/qa/<Area>/<slug>/qa.md -->
<!-- references に plan.md は書かない（plan は archive へ移る使い捨ての文書で、恒久の記録から指さない）。 -->
<!-- AC と Checks（実装前）と、lane の外の手の変更の検証記録（Rounds）の単一文書。qa_status がライフサイクルを表す:
     planned -> in-progress -> verified | partial | failed | blocked -->
<!-- Verdict / qa_status mapping: PASS -> verified, PARTIAL -> partial, FAIL -> failed, BLOCKED -> blocked -->
<!-- lane の qa.md は AC と Checks だけを書き、Round を書かない（検証ログは Harness が持つ）。qa_status は planned のまま。 -->
<!-- lane の外の小さな手の変更はこの雛形を使わず、_docs/qa/<Area>/maintenance.md へ Round を 1 つ追記する。 -->

## Acceptance Criteria

<!-- AC-001 形式の安定 ID を振る。AC の文の条件は _docs/standards/work.md の「受け入れ条件（AC）」。 -->
<!-- 全体の行は AC の番号を振らない。判定者は実装役以外。実装役の自己申告で満たしたとしない。Checks の表には床の行だけを書く。 -->
<!-- 判定者の語は Harness が読む（収束後の device_check の段）: 「人」は compare/ に絵があるときだけ役を起こし、指摘を提出前確認の card に並べる。「絵を見る役」は役を起こして全体 1 文と compare/ の絵を見比べ、must / should を判定を通して修正に回す。走らせない語は書かない。 -->

- 全体: <列挙では満たせない 1 文>（判定: <実装役以外。人 か 絵を見る役>）
- AC-001:

## Checks

<!-- 各 AC をどう確認するかを実装前に書く。実装後に書き換えない。INV の行は書かない（守る性質は Choice の anchored にある）。 -->

| ID | Source | Requirement | Check Type | Command / File | Status |
| --- | --- | --- | --- | --- | --- |
| AC-001 | Issue | ... | unit \| validator \| manual \| diff-review | ... | planned |

<!-- Status: planned | covered | verified | deferred (要理由) | not-applicable -->

## Rounds

<!-- lane は Round を書かない。見出しは qa の検査（qa_schema 5）が必須にするので置く。 -->
<!-- lane の外の手の変更だけが Round を追記する。追記専用。過去の round を結果に合わせて書き換えない。 -->

### Round 1 (YYYY-MM-DD)

- **Commands**:

  ```bash
  # 実際に実行したコマンドと結果だけを書く
  ```

- **AC Coverage**: AC-001 ...
- **Risk**: <Low | Medium | High | Critical。この Round の変更だけの Risk。repo が `risk_paths` に宣言したパスに触れたら High 以上>
- **Choice**: <この変更で口から記録した Choice の id と操作（raise / reanchor / supersede / confirm / drop）。口を使えないときは「案: <案を置いた場所か件数>」。無ければこの欄を書かない>
- **Waive**: applied: <Choice の id>（補足） | no-choice: <理由>
  <!-- Choice を書かない理由。Choice の欄の記録で変更を説明しきれるときは書かなくてよい。Choice と Waive のどちらも無い Round は検査が落とす。 -->
- **Verdict**: PASS | PARTIAL | FAIL | BLOCKED
  <!-- PARTIAL / FAIL / BLOCKED では残る危険と次の手を必ず書く。 -->
