---
title: agent が書く文章の作法を skill にする — 設計判断
status: active
intent_schema: 3
created_at: 2026-08-27
updated_at: 2026-08-27
references:
  - "_docs/qa/pi-web-idd/idd-903/qa.md"
  - "_docs/reference/pi-web-idd/idd-903/reference.md"
related_issues:
  - 5
related_prs: []
---

<!-- Canonical path: _docs/intent/pi-web-idd/idd-903/decision.md -->

# agent が書く文章の作法を skill にする — 設計判断

## Context

UI は DEC / QA の見出しを parse して card にそのまま出す (`packages/idd-core/src/intent/parse.ts` → `lib/idd-ui/server/state.ts` → `components/idd/cards/`)。planner の文章の質がそのまま判断面の質になる。IDD-902 の成果物は読ませる文章だった: QA-1 は条件と実装記述が 1 文に混ざり card で 2 行に折り返し、DEC-664 は読点で 3 節を継いで括弧で出典を付けた。

現状の作法は plannerBrief の `<writing>` 節 (`packages/idd-core/src/plan/prep.ts`) に inline で 3 行あるだけで、executorBrief には無い。書式と長さの制約が要るという要求自体は `_meta/extended-idd-design/ui-findings.md` に既にある。

下調べ中の質問回答: q1 = IDD-902 の成果物を実際に書き直す、q2 = inline 維持 + skill 併設、q3 = その他 (IDD 成果物や PR 本文、README など人間向けに記述する文章)、q4 = qa_schema 指示をこの lane で直す。

下調べの副産物: plannerBrief が指示する `qa_schema: 3` は古く、現行 template と IDD-902 の実績は `qa_schema: 5` (validator は 3 を legacy warning として受け、fail はしない)。

## Decisions

### DEC-701: 作法は pi skill として `.agents/skills/` に置く

- **What**: 文章の作法を pi の skill 形式 (frontmatter の name / description を持つ SKILL.md) として repo root の `.agents/skills/` に新設する。planner / executor session は lane worktree を cwd に起ち、pi は `.agents/skills` を cwd から git root まで遡って project skill として読む (project trust 下。この host は `/home/penne/dev/active` が trust 済み)。
- **Why**: 作法が prep.ts の文字列リテラルにあると、例や物差しを持てず、直すたびに code change になる。skill なら description が session の system prompt に載り、agent が自分から file を読みにいける。
- **Change freedom**: skill 名・内部構成・例の選び方は自由。session の cwd から pi の discovery が届く位置にあることだけが不変。
- **Anchors**: `.agents/skills/` (新設)

### DEC-702: brief の inline 作法は残し skill 参照を足す

- **What**: plannerBrief の `<writing>` 節は要点を残したまま、末尾に skill file への参照を 1 行足す。executorBrief にも同じ参照を足す。作法の正本 (完全版) は skill とし、inline は要点の写しとする。
- **Why**: DEC-672 の不変条件 (「UI が要求する書式が指示に含まれる」) があるため brief から作法を消せない (質問 q2 の回答: inline 維持 + skill 併設)。かといって 2 か所が独立に本文を持つと乖離するので、正本を skill に決めて inline は写しと位置づける。
- **Change freedom**: 参照の文言、inline に残す要点の粒度は自由。inline が skill と矛盾しないこと、完全版が skill にだけあることが不変。
- **Anchors**: `packages/idd-core/src/plan/prep.ts` (plannerBrief)、`packages/idd-core/src/plan/exec.ts` (executorBrief)

### DEC-703: 作法は人間向けの文章全般に適用する

- **What**: skill の対象は DEC / AC / INV 見出しと質問の選択肢に限らず、commit message、PR 本文、README など人間向けに書く文章全般とする。card に出る文字列には別の節で長さの上限を定める。
- **Why**: 判断面の質は見出しだけで決まらない。DEC の本文は ship が PR body に流用し、README も agent が書く。1 主張 1 文・出典を混ぜない・修飾を落とすという原則は文章種をまたいで効く (質問 q3 の回答: 人間向けに記述する文章全般)。
- **Change freedom**: 文章種ごとの個別ルールの有無は自由。人間向けの文章すべてが対象であることだけが不変。

### DEC-704: card に出る文字列は 1 行に収める

- **What**: DEC / AC / INV 見出しと質問の選択肢 label は Inbox card の 1 行 (IdList の text 列) に収まる長さで書く。目安は実測で 40 文字前後。物差しとして IDD-902 の decision.md / qa.md の見出しを作法どおりに書き直す。
- **Why**: UI は見出しを parse して 1 行でそのまま出し、折り返しの実例が IDD-902 の QA-1。書き直しは lane の完了の目安であり (質問 q1 の回答: 実際に書き直す)、作法の妥当性の検証を兼ねる。
- **Change freedom**: 40 は実測ベースの目安であり厳密な上限ではない。card で折り返さないことが不変の性質。
- **Anchors**: `_docs/intent/pi-web-idd/idd-902/decision.md`、`_docs/qa/pi-web-idd/idd-902/qa.md` (書き直し対象)

### DEC-705: brief の qa_schema 指示を現行の 5 に合わせる

- **What**: plannerBrief の `<format>` が指示する `qa_schema: 3` を、現行 template に合わせて 5 に直す。
- **Why**: 現行 template と IDD-902 の実績は `qa_schema: 5` で、3 は validator の legacy warning を毎回出す。brief が古い指示を出し続けると warning 持ちの文書が量産される (下調べで発見。質問 q4 の回答: この lane で直す)。
- **Change freedom**: template の版が上がれば追従する。brief が現行と異なる schema を指示しないことだけが不変。
- **Anchors**: `packages/idd-core/src/plan/prep.ts` (plannerBrief)

## Consequences / Impact

- この repo に `.agents/skills/` が新設される。pi はこれを trust 対象の project resource と見なすので、clone した他環境では初回に trust 確認が出うる
- planner / executor の brief 文字列が変わる。効くのは変更後に spawn された session からで、稼働中の session は変わらない
- IDD-902 の decision.md / qa.md の見出しが変わる。判断の内容は変えず、ledger や session file には触れない
- 作法の更新は skill と brief inline の 2 か所を触る必要がある (INV-010)。乖離は QA の diff-review で検知する

## Quality Implications

- card の各行が折り返さないこと (AC-006)。折り返すままだと本 lane の目的を達していない
- skill が session に discovery されること (AC-007)。載らなければ「brief から参照される」が成立しない
- brief の inline と skill が矛盾しないこと (INV-010)。矛盾すると planner が brief 優先で古い作法に従う
- 確認観点は `_docs/qa/pi-web-idd/idd-903/qa.md` の Checks に対応

## Intent-derived Invariants

- INV-010 (from DEC-702): 作法の完全版は skill file にのみ存在し、brief の inline は要点の写しと参照に留まる
- INV-011 (from DEC-701): skill は planner / executor session の cwd から pi の `.agents/skills` discovery が届く位置に置く

## Rollback / Follow-ups

- ロールバックは skill file の削除と brief 文字列の復元。IDD-902 の文書の書き直しは戻さない (判断の内容は不変で、表記の更新のみ)
- starter/ 側の template に同種の skill を同梱するかは別 lane (本 lane はこの repo の runtime の話)
- review (S3) 以降の brief への参照追加は、必要が観測されてから別途検討する
