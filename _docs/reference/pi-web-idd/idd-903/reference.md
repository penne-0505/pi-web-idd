---
title: agent が書く文章の作法を skill にする — 下調べで見たもの
status: active
created_at: 2026-08-27
updated_at: 2026-08-27
references:
  - "_docs/intent/pi-web-idd/idd-903/decision.md"
  - "_docs/qa/pi-web-idd/idd-903/qa.md"
related_issues:
  - 5
related_prs: []
---

<!-- Canonical path: _docs/reference/pi-web-idd/idd-903/reference.md -->
<!-- 本 lane の reference は API 仕様ではなく下調べ (S1) の閲覧記録。各行は `- `path` — なぜ見たか`。 -->

## Overview

- IDD-903 (agent が書く文章の作法を skill にする) の下調べで参照したファイルと、その理由の記録

## 下調べで見たもの

- `packages/idd-core/src/plan/prep.ts` — plannerBrief が `<writing>` 節に作法を inline で持つ現状と、brief の生成箇所を確認
- `packages/idd-core/src/plan/exec.ts` — executorBrief に作法の節が無いこと、契約 (DEC/AC/INV) を parseIntent から埋め込む構造を確認
- `packages/idd-core/src/intent/parse.ts` — DEC/AC/INV 見出しの parse 規則 (`^### DEC-..: 一文` 等) と、見出しの一文がそのまま UI / executor brief に出る経路を確認
- `packages/idd-core/src/plan/ship.ts` — DEC の本文が PR body に流用される経路 (DEC-694 の内部語彙チェック) を確認
- `packages/idd-core/src/agent/inbound.ts` — questions / ready の受け口 (agentAskQuestions / agentReady) の payload を確認
- `lib/idd-ui/server/agent-runner.ts` — planner session が lane worktree を cwd として spawn されることを確認 (skill discovery の起点)
- `lib/idd-ui/server/state.ts` — buildState / buildLaneDetail が parseIntent の decisions / criteria を GO card / review card にそのまま載せることを確認
- `components/idd/cards/index.tsx` — GoCard が decisions / criteria を IdList に渡す構造を確認
- `components/idd/cards/parts.tsx` — IdList が id 34px 固定 + text flex の 1 行で描くことを確認 (折り返しの発生箇所)
- `components/idd/InboxPanel.tsx` / `lib/idd-ui/scale.ts` — 判断面の幅 (readWidth 1040px) と文字サイズ (FS.md = 1rem) を確認
- `_docs/intent/pi-web-idd/idd-902/decision.md` — 課題の実例 (DEC-664) と decision.md の構造の先例を確認
- `_docs/qa/pi-web-idd/idd-902/qa.md` — 課題の実例 (QA-1) と qa_schema: 5 / Checks 表の先例を確認
- `_docs/reference/pi-web-idd/idd-902/reference.md` — reference.md の形式 (一行列挙) の先例を確認
- `_docs/standards/templates/intent.md` — DEC/INV の採番規約 (repo 全体で一意、最大値 + 1) と必須 field を確認
- `_docs/standards/templates/qa.md` — 現行 qa template が qa_schema: 5 であることを確認 (prep.ts の qa_schema: 3 指示との不整合を発見)
- `scripts/validate-intent.ts` / `scripts/validate-qa.ts` — 必須見出し・必須 field・legacy schema は warning のみで fail しないことを確認
- `scripts/check-docs.sh` — 完了条件の検証内容を確認し、変更前に緑である baseline を確認
- `starter/.agents/skills/prep/SKILL.md` — この repo が出荷する skill の形式 (frontmatter の name / description) を確認
- `_meta/extended-idd-design/ui-findings.md` — 「planner の出力に書式と長さの制約が要る」という要求の出どころを確認
- `_meta/extended-idd-design/stages.md` — S1 / S2 の段階定義と質問 batch の作法を確認
- `_docs/intent/IddCore/idd-core/decision.md` — DEC-672 (brief の自己完結の不変条件) と Anchors field の先例、DEC 採番の現最大値 (DEC-700) を確認
- `node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js` — pi が skill を `<cwd>/.pi/skills` と設定パスから読むことを確認
- `node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js` — `.agents/skills` を cwd から git root まで遡って project skill として読む経路 (project trust 必須) を確認
- `node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js` — `.agents/skills` が trust 対象の project resource であることを確認
- `lib/project-trust.ts` と `~/.pi/agent/trust.json` — lane の worktree が trust 済み (`/home/penne/dev/active` が nearest entry) であることを確認

## Verification

- 関連 QA: `_docs/qa/pi-web-idd/idd-903/qa.md`
