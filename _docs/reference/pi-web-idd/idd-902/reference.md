---
title: outbox の未達を UI に出す — 下調べで見たもの
status: active
created_at: 2026-08-27
updated_at: 2026-08-27
references:
  - "_docs/intent/pi-web-idd/idd-902/decision.md"
  - "_docs/qa/pi-web-idd/idd-902/qa.md"
related_issues:
  - 4
related_prs: []
---

<!-- Canonical path: _docs/reference/pi-web-idd/idd-902/reference.md -->
<!-- 本 lane の reference は API 仕様ではなく下調べ (S1) の閲覧記録。各行は `- `path` — なぜ見たか`。 -->

## Overview

- IDD-902 (outbox の未達を UI に出す) の下調べで参照したファイルと、その理由の記録

## 下調べで見たもの

- `packages/idd-core/src/agent/outbox.ts` — OutboxRecord / pendingEnvelopes() / deliverPending() の定義。未達 (= delivered_at null) の意味と error フィールドの所在を確認
- `packages/idd-core/src/ledger/write.ts` — queueEnvelope が outbox.jsonl に delivered_at: null で積む経路を確認
- `app/api/idd/deliver/route.ts` — GET が既に {pending} を返すが UI から未使用、POST は cron 起動の配送であることを確認
- `lib/idd-ui/server/state.ts` — buildState() / buildLaneDetail() が view model の組み立て場所。件数を載せる候補 (DEC-666)
- `app/api/idd/state/route.ts` — Inbox 側レスポンスの出口。Cache-Control: no-store を確認
- `app/api/idd/lane/[id]/route.ts` — lane detail レスポンスの出口を確認
- `components/idd/InboxPanel.tsx` — 「判断キュー」見出し行と CronStatus (DEC-635 の先例) の配置を確認
- `components/idd/LaneDetail.tsx` — lane detail 見出し (phaseLabel Chip / branch・area・since 行) の構造を確認
- `components/idd/InboxTab.tsx` — Inbox が useIddState の state.items を使う流れを確認
- `components/idd/LaneTab.tsx` — lane detail が mount 時 1 回のみ fetch (ポーリングなし) であることを確認
- `hooks/useIddState.ts` — /api/idd/state を 15 秒ポーリングしていることを確認
- `lib/idd-ui/types.ts` — LaneDetailView / InboxItem の型。件数フィールドの追加先を確認
- `lib/idd-ui/server/agent-runner.ts` — 配送 runner (pi session への prompt 注入、DEC-659/662) を確認
- `packages/idd-core/src/intent/parse.ts` — DEC/QA/INV 見出しと reference 行の parse 形式、intent 解決パス (area + title-slug) を確認 (DEC-668 の論点)
- `packages/idd-core/src/agent/inbound.ts` — questions / ready の受け口 (agentAskQuestions / agentReady) の payload を確認
- `_meta/extended-idd-design/ui-findings.md` — 判断キュー周辺の表示規約 (chrome を読ませない等) を確認
- `_docs/standards/templates/intent.md` — DEC/INV の採番規約 (リポジトリ全体で一意、最大値 + 1) を確認
- `scripts/validate-intent.ts` / `scripts/validate-qa.ts` / `scripts/validate-frontmatter.ts` — 文書の canonical path と必須構造 (q6 の論点) を確認
- `/tmp/idd-live-state/outbox.jsonl` — 実データで IDD-901 の 2 件が delivered_at: null のまま滞留していることを確認 (課題の実在チェック)
- `/tmp/idd-live-state/backlog.jsonl` — この lane の area が penne-0505/pi-web-idd であることを確認 (DEC-668 の論点)

## Verification

- 関連 QA: `_docs/qa/pi-web-idd/idd-902/qa.md`
