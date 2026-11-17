---
title: Plan Title
status: proposed  # allowed: proposed | active | superseded | obsolete
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
references:
  - "_docs/qa/<Area>/<slug>/qa.md"
related_issues: []
related_prs: []
---

<!-- Canonical path: _docs/plan/<Area>/<slug>/plan.md -->
<!-- 作業指示ではなく、実装役が人に聞き返さずに着手できる依頼。欄と入場条件の正は `_docs/standards/brief.md`。 -->
<!-- 合意済み仕様のみを記載。破壊的変更時は status や updated_at を必ず更新してください。 -->
<!-- Risk >= Medium では _docs/qa/<Area>/<slug>/qa.md を実装前に qa_status: planned で作成してください。 -->

## 依頼

<!-- 1〜3 文。活動ではなく終わりの状態で書く。正解が原物にあるならその所在をここに書く。 -->

- 何をしてほしいか。終わりの状態で。

## 意図

<!-- Purpose から引く。出典（Issue・Purpose の id・人の回答）を持つ文だけを書く。計画役が補った動機は「推測」と明示するか質問にする。 -->
<!-- 症状と原因を分けて書く（`_docs/standards/solving.md` の R1）。原因が Issue の範囲を越えるなら、実装に入らず立て直しを提案する。 -->

- なぜ頼むのか。この lane の価値がどこにあるか。
- 症状: Issue が述べていること。
- 原因: 出典を持つか、推測と明示する。

## 重要なコンテクスト

<!-- 事実ではなく、lane のコンテクスト文書（_docs/context/<Area>/<slug>/context.md）の所在だけを書く。事実はその文書に書き、欄には写さない。入場条件と書き手（計画役と実装役）の正は `_docs/standards/brief.md` の「重要なコンテクスト」。 -->

- 重要なコンテクストの文書: `_docs/context/<Area>/<slug>/context.md`

## 裁量

<!-- 原理は 1 文。禁止だけを書かない。触る場所は backquote の path で始まる箇条書きで書く。 -->

- 原理: 挙げていない場面に延びる 1 文。
- 自由にしてよい: 部品の分け方、file 構成、テストの形、など。
- 触る範囲:
  - `path/to/file.ts` — 触ってよい場所。
  - `path/outside/` — 範囲外の隣接領域。
- 守ること: 破ると取り返しがつかないものだけ。各 1 行の why 付き。

## 完了の形

<!-- 全体は列挙では満たせない 1 文。判定者は実装役以外（人・絵を見る役・device_check）。床は状態の記述で 3〜6 項目。 -->

- 全体: 実装役以外が判定する 1 文。
- 床:
  - 状態の記述。

## 戻す条件

<!-- 止まって人（か計画役）に返す条件と、返し方。入力・手段の不足は必ず入れる。 -->

- 止まって返す条件と、返し方。
