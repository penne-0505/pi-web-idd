---
title: 拡張 IDD engine (@idd/core) の境界と構成
status: active
intent_schema: 3
created_at: 2026-08-27
updated_at: 2026-08-27
references: []
related_issues: []
related_prs: []
---

<!-- Canonical path: _docs/intent/IddCore/idd-core/decision.md -->

# 拡張 IDD engine (@idd/core) の境界と構成

## Context

本 repo は pi-web v0.8.9 の固定派生（Workspace DEC-001）として始まり、当初は「拡張 IDD の web UI」だけを持っていた。実際に pipeline を回すには取り込み（S0）・下調べ（S1）・実装（S2）・衝突確認（S3）・提出（S4）の実体が要るが、それらは Meltly 側（`~/dev/00_meltly/sync-tools/`）の Python 実装と、その置き場所に依存した構造として存在している。

本 repo をその依存から切り離し、拡張 IDD 本体として成立させる。設計の正本は `_meta/extended-idd-design/`（handoff）で変わらない。

UI 側の判断は `_docs/intent/IddUi/`。

## Decisions

### DEC-650: engine を UI から独立した層として `packages/idd-core` に置く

- **What**: ledger の読み書き・stage 判定・intent の parse・worktree の観測・envelope の生成を `packages/idd-core`（`@idd/core`）に置く。engine は Next.js も React も知らず、外界として知ってよいのは state dir と intent root（`IDD_STATE_DIR` / `IDD_INTENT_DIR`）だけ。import の向きは常に UI → engine の一方向で、engine から UI 側の module を参照しない。
- **Why**: pipeline の実体は UI の付属物ではなく、cron / CLI / 別の front からも使われる。pi-web fork のコードに混ぜると、engine の再利用が fork ごと引きずる形になる。view model（`LaneRow` / `InboxItem` など）は表示の都合で毎日変わるのに対し、ledger の schema は handoff に紐づく。変化の速度が違うものを同じ層に置かない。
- **Change freedom**: package 内の module 分割、公開する関数、package 名は自由。「engine が UI を参照しない」「外界が state dir と intent root に閉じている」の 2 点だけが不変。
- **Why not**（最初から別 repo に切る）: 契約（event の attrs、view に必要な field）がまだ日単位で動いており、この段階で repo を割ると engine と UI の往復が毎回 2 repo・2 PR になる。境界さえ守っていれば `git subtree split -P packages/idd-core` で後から切り出せる。
- **Revisit when**: pi-web fork 以外から engine を使う必要が出た時点、または contract が安定して往復が減った時点で独立 repo へ切り出す。
- **Anchors**: `packages/idd-core/src/index.ts`（公開面）、`lib/idd-ui/server/state.ts`（UI 側の消費点）、`tsconfig.json`（`@idd/core` の path）

### DEC-651: view model への畳み込みは UI 側に残す

- **What**: `buildState` / `buildLaneDetail`（ledger → `LaneRow` / `InboxItem` / `LaneDetailView`）と event の表示名対応表は `lib/idd-ui/server/` に残し、engine には移さない。
- **Why**: これらは「どう見せるか」の判断そのもの（IddUi DEC-608 / DEC-631 など）であって、pipeline の実体ではない。engine に置くと、表示都合の変更が engine の API を揺らす。
- **Change freedom**: 畳み込みの実装と置き場所（UI 内での module 分割）は自由。「表示都合の型が engine の公開面に現れない」だけが不変。
- **Anchors**: `lib/idd-ui/server/state.ts`、`lib/idd-ui/server/events-display.ts`

### DEC-652: 旧 13-event 実装と msync への shell out を削除し、handoff schema に一本化する

- **What**: `lib/idd/`（`ledger-io.ts` / `lifecycle-schema.ts` / `worker-pool.ts` とその test）と `/api/idd/{lanes,lifecycle,workers}` を削除する。lane の状態・event の書き込みは `@idd/core`（handoff の 41 event / `lifecycle-<repo>.jsonl`）だけが持つ。
- **Why**: 旧実装は Meltly 側 Python の部分移植で、13 event / `ledger-<repo>.jsonl` という**非互換の schema** を持っていた。同じ「lane の状態」に正本が 2 つあると、どちらを信じるかが実装ごとに分かれる。設計の SSOT は handoff（`_meta/extended-idd-design/`）と決めており、食い違う実装は統合ではなく破棄する。`/api/idd/lifecycle` の msync CLI shell out も、`POST /api/idd/decide` が同じ役割を handoff schema で果たすため二重になっていた。これを消すことで Meltly のツールチェーンへの最後の直接依存が切れる。
- **Change freedom**: 削除後の再実装の形は自由。「lane の状態の正本を 2 つ持たない」「外部 CLI に状態変更を委譲しない」だけが不変。
- **Why not**（両者を変換層で繋ぐ）: 13 event と 41 event は粒度が違い、変換は情報を捏造するか捨てるかのどちらかになる。どちらも履歴の信頼性を壊す。
- **Anchors**: `packages/idd-core/src/ledger/`（一本化後の正本）、`app/api/idd/decide/route.ts`

## Consequences / Impact

- `lib/idd-ui/server/` から ledger の読み書きが消え、UI 側は engine の公開面だけを見る。state file の schema 変更は engine に閉じる。
- `packages/*` を npm workspace として追加した。`@idd/core` は TypeScript のまま解決される（build 段階を持たない）ため、Next の bundler がそのまま取り込む。
- engine 側にも本 repo の docs 規約（コメントは DEC ポインタのみ）がそのまま適用される。

## Quality Implications

- **DEC-650 が守る品質**: engine が UI の都合で歪まない。破ると: 表示の変更が pipeline の API を揺らし、切り出しが不可能になる。
- **DEC-652 が守る品質**: lane の状態の正本が 1 つに保たれる。破ると: UI と CLI が別の履歴を見て、同じ lane に矛盾した判断を下す。
- **DEC-651 が守る品質**: engine の公開面が handoff の schema だけに対応する。破ると: view model が engine の契約に混ざり、別 front から使えなくなる。

## Intent-derived Invariants

- INV-005 (from DEC-650): `packages/idd-core` から UI 側（`app/` `components/` `hooks/` `lib/`）の module を import しない。

## Rollback / Follow-ups

- **worker pool の再実装**: DEC-652 で `lib/idd/worker-pool.ts` を消したため、Workspace DEC-004 / DEC-007 が宣言した「pi session = persistent worker」の実体は現在存在しない。S1 / S2 の実装時に handoff の `agents.md` に沿って engine 側へ書き直す。

- **Rollback**: `packages/idd-core` を `lib/idd-ui/server/` へ戻せば、workspace 追加前の構成に復帰する（依存は一方向なので機械的に戻せる）。
- **Follow-ups**:
  - `config/areas.json` と S0（取り込み）を engine 側に実装する
  - engine の入口として `packages/idd-cli` を足し、cron から叩けるようにする
