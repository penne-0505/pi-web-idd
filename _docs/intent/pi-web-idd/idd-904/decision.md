---
title: README を拡張 IDD 本体のものに書き直す — 設計判断
status: active
intent_schema: 3
created_at: 2026-08-27
updated_at: 2026-08-27
references:
  - "_docs/qa/pi-web-idd/idd-904/qa.md"
  - "_docs/reference/pi-web-idd/idd-904/reference.md"
related_issues:
  - 7
related_prs: []
---

<!-- Canonical path: _docs/intent/pi-web-idd/idd-904/decision.md -->

# README を拡張 IDD 本体のものに書き直す — 設計判断

## Context

`README.md` は intent template の説明がそのまま残り、末尾に上流 pi-web の README が全文残っている。repo の実体は pi-web v0.8.9 の固定派生 + 拡張 IDD の engine (`packages/idd-core` / `packages/idd-cli`) + 判断 UI (`components/idd`) で、README からはそれが読み取れない。

起票文は「S3 / S4 は未実装」とするが、下調べで陳腐化を確認した。S3 check / S4 ship / tick 連結は PR #9 と DEC-688〜692, DEC-700 で実装済み。実際に未実装なのは、意味類似の重複判定 (`DuplicateDetector` の口のみ) / cron 登録 (scheduler 不在。cron-run 記録は書く) / verifier agent (DEC-693 で人間が兼ねる暫定) / 衝突の解消 (検出のみ) / Linear 取り込み (config schema のみ) の 5 件。

下調べ中の質問回答: q1 = 上流 README 全文は短い attribution 節に畳む、q2 = 上流の翻訳 README 3 ファイルは削除する。

## Decisions

### DEC-721: README の主題は拡張 IDD 本体に切り替える

- **What**: README.md の本体を「この repo は何か (起票を lane にし、planner が下調べ、人間が GO を判断、executor が実装する pipeline と判断 UI)」「動かし方」「全体の流れ S0-S4」の説明にする。intent template の説明を冒頭に置かない。
- **Why**: 現状の README ではこの repo が何をするものかが分からない (lane の問題意識)。README は repo の顔であり、実体と主題がずれたままだと読み手を全員誤導する。
- **Change freedom**: 節の構成・順序・表現は自由。主題が拡張 IDD 本体であることだけが不変。
- **Anchors**: `README.md`

### DEC-722: 上流 pi-web README は attribution 節に畳む

- **What**: 末尾の上流 pi-web README 全文は残さず、派生元 (pi-web v0.8.9) へのリンクと MIT ライセンスの attribution 節に畳む (質問 q1 の回答: 短い attribution 節に畳む)。
- **Why**: 全文を残すと「この repo は pi-web 本体か派生か」が読めず、DEC-721 の主題切り替えが不完全になる。attribution は lane の指示と MIT の要件で残す。
- **Change freedom**: attribution 節の文面・配置は自由。派生関係と MIT が読み取れることだけが不変。
- **Anchors**: `README.md`

### DEC-723: 日本語 / 英語の 2 部構成を同じ構成で維持する

- **What**: README.md は日本語部と英語部の 2 部構成とし、両者を同じ構成にする (lane の指示どおり)。
- **Why**: lane が「英語版も同じ構成で残す」と指定している。日本語が primary の読者 (owner) と英語の読者の両方を、内容のずれなしに維持する。
- **Change freedom**: 言語の順序 (現状は日本語が先) と案内文は自由。2 言語が同じ構成であることだけが不変。
- **Anchors**: `README.md`

### DEC-724: 実装状態はコードの現状に合わせ、未実装を明記する

- **What**: 段階の説明はコードの現状に合わせる。S3 / S4 は実装済みとして書く。意味類似の重複判定 / cron 登録 / verifier agent / 衝突の解消 / Linear 取り込みの 5 件は未実装と明記する。
- **Why**: 起票文の「S3 / S4 未実装」は PR #9 で陳腐化した。未実装を実装済みと書くのも、その逆も、README を判断材料として信頼できなくする (lane の注意どおり)。
- **Change freedom**: 未実装の示し方 (一覧・注記) は自由。実装状態がコードと一致することだけが不変。
- **Anchors**: `README.md`、`packages/idd-core/src/intake/run.ts`、`packages/idd-cli/bin/idd.ts`、`app/api/idd/`

### DEC-725: template 規約はこの repo の開発規約として残す

- **What**: template 由来の規約説明 (最小ループ / DEC / validator / `check-docs.sh`) は削除せず、「この repo 自身が従う開発規約」として残す (lane の注意どおり)。
- **Why**: この repo は今もその規約で動いており、docs CI がそれを強制している。規約の説明が消えると、contributor が従うべきループの入口を失う。
- **Change freedom**: 節の位置・分量は自由。規約の説明が消えないことだけが不変。
- **Anchors**: `README.md`、`_docs/standards/`

### DEC-726: 上流の翻訳 README 3 ファイルは削除する

- **What**: `README.ja.md` / `README.zh-CN.md` / `README.ru.md` を削除する (質問 q2 の回答: 削除する)。
- **Why**: 3 ファイルは上流 pi-web の説明であり、この repo の説明と食い違う。README.md が日本語 / 英語を内包するので、翻訳ファイルは役割を持たない (DEC-723)。
- **Change freedom**: 削除の契機とコミットの切り方は自由。
- **Anchors**: `README.ja.md`、`README.zh-CN.md`、`README.ru.md`

## Consequences / Impact

- README.md がこの repo の顔として拡張 IDD を説明し、英語読者は同ファイル内の英語部を読む
- 上流の翻訳 3 ファイルが消える。上流 pi-web の README は attribution のリンクから辿る形になる
- README の実装状態の記述はコードの現状に縛られる (INV-013)。未実装 5 件が実装されたら README の更新が要る
- README 内のリンクは doc-links validator の検査対象。新しいリンクを切らせると CI が赤になる

## Quality Implications

- README 冒頭から repo の実体が分かること (QA-1)。分からないままだと本 lane の目的を達していない
- 動かし方に README から辿り着けること (QA-2)。env var とコマンドの説明が欠けると動かせない
- 未実装が未実装と読めること (QA-3) と、記述がコードと一致すること (QA-4)。ずれると README が判断材料として腐る
- 規約説明 (QA-5) と attribution (QA-7) が残ること。消すと lane の注意と MIT の要件に反する
- 2 言語が同じ構成であること (QA-6)。ずれると片方の読者が古い情報を読む
- 確認観点は `_docs/qa/pi-web-idd/idd-904/qa.md` の Checks に対応

## Intent-derived Invariants

- INV-013 (from DEC-724): README の段階・コマンド・env var の記述はコードの現状と一致させ、実装予定を実装済みと書かない
- INV-014 (from DEC-725): 最小ループ / DEC / validator の規約説明を README から削除しない
- INV-015 (from DEC-722): 派生元 pi-web の attribution (派生関係と MIT) を README から削除しない

## Rollback / Follow-ups

- ロールバックは README.md の差し戻しと翻訳 3 ファイルの復元のみ。コードへの影響はない
- 未実装 5 件 (意味類似の重複判定 / cron 登録 / verifier agent / 衝突の解消 / Linear 取り込み) の実装時に README の未実装一覧を更新する (恒久の保守点)
- `QUICKSTART.md` (template 由来) の扱いは本 lane の scope 外。必要なら別 lane で判断する
