---
title: "QA: agent が書く文章の作法を skill にする"
status: active
qa_status: verified
risk: Low
qa_schema: 5
created_at: 2026-08-27
updated_at: 2026-08-27
references:
  - "_docs/intent/pi-web-idd/idd-903/decision.md"
  - "_docs/reference/pi-web-idd/idd-903/reference.md"
related_issues:
  - 5
related_prs: []
---

# QA: `agent が書く文章の作法を skill にする`

<!-- Canonical path: _docs/qa/pi-web-idd/idd-903/qa.md -->

## Acceptance Criteria

- AC-001: skill が `.agents/skills/` にあり frontmatter を持つ
- AC-002: skill が人間向け文章全般と card 用の長さ上限を定める
- AC-003: planner brief に作法の要点と skill 参照が両方ある
- AC-004: executor brief に skill 参照がある
- AC-005: planner brief の qa_schema 指示が 5 になっている
- AC-006: IDD-902 の見出しが書き直され card の 1 行に収まる
- AC-007: spawn した session の skills 一覧にその skill が載る
- AC-008: `./scripts/check-docs.sh` が通る

## Checks

| ID | Source | Requirement / Invariant | Check Type | Command / File | Status |
| --- | --- | --- | --- | --- | --- |
| AC-001 | DEC-741 | skill file と frontmatter の存在 | unit | `lib/idd-ui/server/writing-skill.test.mjs` (新規。repo root の `.agents/skills/*/SKILL.md` を読む) | verified |
| AC-002 | DEC-743 | skill の内容が対象範囲と長さ上限を含む | manual | skill file を目視 (作法の各項目と 40 文字の目安を含むこと) | verified |
| AC-003 | DEC-742 | planner brief に要点と参照 | unit | 同上 test file で `plannerBrief()` の出力を検査 | verified |
| AC-004 | DEC-742 | executor brief に参照 | unit | 同上 test file で `executorBrief()` の出力を検査 | verified |
| AC-005 | DEC-745 | qa_schema 指示が 5 | unit | 同上 test file | verified |
| AC-006 | DEC-744 | IDD-902 見出しの書き直しと非折り返し | manual | `next dev` + fixture で card を目視。各行の文字数も確認 | verified |
| AC-007 | DEC-741 | session で skill が discovery される | manual | lane worktree を cwd に session を起こし skills 一覧を確認 | verified |
| AC-008 | DEC-742 | docs validator 緑 | validator | `./scripts/check-docs.sh` | verified |
| INV-010 | DEC-742 | inline と skill の非矛盾 | diff-review | brief の `<writing>` 節と skill の要点を突合 | verified |
| INV-011 | DEC-741 | skill 配置が discovery 経路内 | diff-review | `.agents/skills/` が repo の git root 直下にあること (AC-001 と同時に確認) | verified |

## Rounds

### Round 1 (2026-08-27)

- **Intent Delta**: None: DEC-741〜705 の範囲内で実装。契約の追加・変更なし
- **R2**: 非発動 (契約変更なし、risk Low)
- **Verdict**: PASS

実施内容:

- `.agents/skills/writing/SKILL.md` を新設 (DEC-741)。frontmatter の name / description を持ち、対象を人間向けの文章全般 (DEC / AC / INV 見出し、質問の選択肢、commit message、PR 本文、README、docs) とし、card に出る文字列は 40 文字前後で 1 行に収める物差しを定めた (DEC-743 / DEC-744)
- `plannerBrief()` の `<writing>` 節は要点を残し、末尾に `.agents/skills/writing/SKILL.md` への参照を 1 行追加。`<format>` の `qa_schema: 3` を 5 に修正 (DEC-742 / DEC-745)
- `executorBrief()` に `<writing>` 節を追加し、同じ skill 参照を載せた (DEC-742)
- IDD-902 の decision.md / qa.md の DEC / AC / INV 見出しを作法どおりに書き直し (DEC-744)。判断の内容 (What / Why / Checks / Rounds) は不変
- unit: `lib/idd-ui/server/writing-skill.test.mjs` (AC-001 / AC-003 / AC-004 / AC-005)。`@idd/core` は `idd-core-alias.loader.mjs` の resolve hook で node --test から解決
- manual: `IDD_STATE_DIR=/tmp/idd-903-fixture next dev -p 30243` で実機確認。GO card の DEC / AC 各行と lane detail の INV 各行が 1 行 (高さ 24px) で描画されることを目視 (AC-006)。`DefaultResourceLoader` で lane worktree を cwd に skill 一覧を取得し `writing` が載ることを確認 (AC-007)
- validator: `./scripts/check-docs.sh` 緑 (AC-008)。`node_modules/.bin/tsc --noEmit` も緑
- diff-review: brief の `<writing>` 節と skill の要点を突合し非矛盾を確認 (INV-010)。`.agents/skills/` が repo の git root 直下にあり discovery 経路内であることを確認 (INV-011)
