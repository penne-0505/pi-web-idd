---
title: "QA: README を拡張 IDD 本体のものに書き直す"
status: active
qa_status: planned
risk: Low
qa_schema: 5
created_at: 2026-08-27
updated_at: 2026-08-27
references:
  - "_docs/intent/pi-web-idd/idd-904/decision.md"
  - "_docs/reference/pi-web-idd/idd-904/reference.md"
related_issues:
  - 7
related_prs: []
---

# QA: `README を拡張 IDD 本体のものに書き直す`

<!-- Canonical path: _docs/qa/pi-web-idd/idd-904/qa.md -->

## Acceptance Criteria

- AC-001 (QA-1): README.md の冒頭が、この repo = 拡張 IDD の pipeline と判断 UI の説明になっている (intent template の説明が冒頭に来ない)
- AC-002 (QA-2): README から `npm run dev` (port 30141)、`IDD_STATE_DIR` / `IDD_INTENT_DIR` / `IDD_AGENT_BASE_URL` の意味、`idd intake` / `idd tick` の実行に辿り着ける
- AC-003 (QA-3): S0 取り込み → S1 下調べ → GO → S2 実装 → S3 衝突確認 → S4 提出の流れが書かれ、未実装のもの (意味類似の重複判定、cron 登録、verifier agent、衝突の解消、Linear 取り込み) が未実装と明記されている
- AC-004 (QA-4): 実装済みと書かれた段階・コマンド・env var がコードの現状と一致する (S3 / S4 は実装済み。起票文の「S3 / S4 未実装」は陳腐化している)
- AC-005 (QA-5): template 由来の規約説明 (最小ループ / DEC / validator / check-docs.sh) が残っている
- AC-006 (QA-6): 日本語部と英語部が同じ構成で存在する
- AC-007 (QA-7): 派生元 pi-web の attribution (MIT) が残っている
- AC-008: `_meta/extended-idd-design/` を設計の正本、`_docs/intent/` を判断の記録として示している
- AC-009: `./scripts/check-docs.sh` が通る (doc-links validator を含む)
- AC-010: `README.ja.md` / `README.zh-CN.md` / `README.ru.md` が削除されている (DEC-726)

## Checks

| ID | Source | Requirement / Invariant | Check Type | Command / File | Status |
| --- | --- | --- | --- | --- | --- |
| AC-001 | DEC-721 | 冒頭が拡張 IDD の説明 | manual | README.md の冒頭 2 節を目視 | planned |
| AC-002 | decision.md | 動かし方の記載 | manual | README の記載どおりに辿れるか目視 | planned |
| AC-003 | DEC-724 | 流れと未実装の明記 | manual | 該当節を目視 (未実装 5 件の列挙) | planned |
| AC-004 | INV-013 | 記述とコードの一致 | diff-review | `packages/idd-cli/bin/idd.ts` / `paths.ts` / `token.ts` / `app/api/idd/` と README 記述を突き合わせる | planned |
| AC-005 | INV-014 | 規約説明の温存 | diff-review | 新 README に最小ループ / DEC / validator の説明があること | planned |
| AC-006 | DEC-723 | 2 部構成 | manual | 日本語部と英語部の見出し構成を突き合わせる | planned |
| AC-007 | DEC-722 | attribution | manual | MIT / 派生元の記載を目視 | planned |
| AC-008 | decision.md | 正本の案内 | manual | 該当 1 文の存在を目視 | planned |
| AC-009 | decision.md | docs CI | validator | `./scripts/check-docs.sh` | planned |
| AC-010 | DEC-726 | 翻訳 3 ファイルの削除 | diff-review | `git status` で 3 ファイルの削除を確認 | planned |

## Rounds

<!-- 追記専用。実装後に Round を追記する。 -->
