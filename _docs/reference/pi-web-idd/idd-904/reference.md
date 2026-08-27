---
title: README を拡張 IDD 本体のものに書き直す — 下調べで見たもの
status: active
created_at: 2026-08-27
updated_at: 2026-08-27
references:
  - "_docs/intent/pi-web-idd/idd-904/decision.md"
  - "_docs/qa/pi-web-idd/idd-904/qa.md"
related_issues:
  - 7
related_prs: []
---

<!-- Canonical path: _docs/reference/pi-web-idd/idd-904/reference.md -->
<!-- 本 lane の reference は API 仕様ではなく下調べ (S1) の閲覧記録。各行は `- `path` — なぜ見たか`。 -->

## Overview

- IDD-904 (README を拡張 IDD 本体のものに書き直す) の下調べで参照したファイルと、その理由の記録

## 下調べで見たもの

- `README.md` — 書き換え対象。現状は template 説明 (日本語 → 英語) + 上流 pi-web README 全文の 3 部構成であることを確認
- `README.ja.md` / `README.zh-CN.md` / `README.ru.md` — 上流 pi-web 由来の翻訳ファイル。扱いを質問 q2 で確認し「削除」の回答を得た (DEC-726)
- `_meta/extended-idd-design/README.md` — 設計の正本 (SSOT) の宣言と、実装済み / 既知の穴の一覧。README に書く「この repo は何か」の根拠
- `_meta/extended-idd-design/stages.md` — S0 Intake / S1 Planner Prep / S2 Executor / S3 Integration Check / S4 Ship の定義。全体の流れの節の根拠
- `packages/idd-core/src/paths.ts` — `IDD_STATE_DIR` (既定 `<cwd>/state`) と `IDD_INTENT_DIR` (既定 `<cwd>/_docs/intent`) の意味と既定値
- `packages/idd-core/src/agent/token.ts` — `IDD_AGENT_BASE_URL` (agent の書き戻し先、既定 `http://127.0.0.1:$PORT`) と `IDD_AGENT_TOKEN` の存在を確認
- `packages/idd-cli/bin/idd.ts` — CLI の口は `idd intake` (engine 直接) と `idd tick` (`POST /api/idd/tick` 経由) の 2 つであることを確認
- `packages/idd-core/src/intake/run.ts` — S0 の実体 (GitHub issue を backlog.jsonl へ)。意味類似の重複判定は `DuplicateDetector` の口だけで未接続、cron-run 記録は書くが scheduler は無いことを確認
- `packages/idd-core/src/config/areas.ts` — area config の schema。`source_type_priority: "linear"` は型に在るが intake は `githubAreas()` のみ読む (Linear 取り込みは未実装) ことを確認
- `config/areas.json` — 実際の area 設定例 (GitHub 由来、label `idd-ready` で filter)
- `app/api/idd/` — 実在する endpoint を棚卸し: state / lane / decide / prep / exec / check / ship / tick / deliver / intake / resume / close / agent/*
- `_docs/intent/IddCore/idd-core/decision.md` — DEC-688〜700 で S3 (衝突の機械判定) / S4 (提出) / tick の連結が実装済みと確認。起票文の「S3 / S4 未実装」は陳腐化と判断。DEC-693 (verifier agent 未実装) / DEC-688 (衝突の解消は未実装) も確認。DEC 採番の現行最大値 700 を確認
- `_docs/intent/pi-web-idd/idd-902/decision.md` — 本 repo における decision.md の full schema の先例 (6 節構成、What/Why/Change freedom)
- `_docs/qa/pi-web-idd/idd-902/qa.md` — qa.md の先例 (AC / Checks 表 / Rounds)。INV の現行最大値 009 を確認
- `_docs/reference/pi-web-idd/idd-902/reference.md` — 本 reference の形式の先例 (一行形式)
- `_docs/standards/document_contracts.md` — frontmatter 必須キー、新規 qa は `qa_schema: 5`、恒久文書の置き場規約を確認
- `_docs/standards/templates/qa.md` — qa_status: planned での雛形 (Checks の Status: planned、Rounds 空可) を確認
- `scripts/check-docs.sh` — 完了条件の検証 script の構成 (frontmatter / todo / doc-links / intent / qa / comments validator) を確認
- `scripts/validate-intent.ts` — intent_schema 3 の必須見出し 6 節と DEC 必須を確認
- `scripts/validate-qa.ts` / `scripts/validate-frontmatter.ts` — `qa_schema` の許容値 (2..5) と planned 時の要件を確認
- `scripts/validate-doc-links.ts` — README 内のリンクが検証対象になることを確認 (新 README のリンク切れは CI 赤になる)
- `components/idd/` / `lib/idd-ui/` — 判断 UI の実在 (Inbox / lane detail / card) を確認
- `package.json` — `npm run dev` = `next dev -H 127.0.0.1 -p 30141` であることを確認
- `CONTEXT.md` — pi-web 派生元の context 文書が残っていることを確認
- `git log` — S2/S3/S4 の実装 merge (PR #9) と tick 連結の履歴を確認

## Verification

- 関連 QA: `_docs/qa/pi-web-idd/idd-904/qa.md`
