---
title: 拡張 IDD UI の view / state 層の設計判断
status: active
intent_schema: 3
created_at: 2026-08-27
updated_at: 2026-08-27
references: []
related_issues: []
related_prs: []
---

<!-- Canonical path: _docs/intent/IddUi/lib/decision.md -->

# 拡張 IDD UI の view / state 層の設計判断

## Context

設計の正本は `_meta/extended-idd-design/`（handoff）で、そこが state file の schema・event 一覧・envelope・stage 定義を持つ。本文書はその設計を pi-web 上の TypeScript として実装するときに、handoff には書かれていない実装側の判断を記録する。

対象は `lib/idd-ui/`（view 型 / 尺度 / fixture / server 側の fold）、`lib/build-stamp.ts`、`app/api/idd/*`。UI 側の見せ方の判断は `_docs/intent/IddUi/components/decision.md` に置く。

engine 側（`packages/idd-core`）の判断は `_docs/intent/IddCore/idd-core/decision.md`。旧 `lib/idd/` は IddCore DEC-652 で削除済み。

## Decisions

### DEC-601: UI が消費する view model を ledger record と分けて server 側で fold する

- **What**: `lib/idd-ui/types.ts` は ledger の生 record ではなく「そのまま描ける形」を定義し、`lib/idd-ui/server/state.ts` が backlog / lifecycle / pending-* / executor-progress / cron-run を読んで fold する。UI component は state file の存在も schema も知らない。
- **Why**: handoff の state file は append-only の event 列で、UI が必要とするのは「現在の状態」である。fold を client に置くと全 event を送ることになり、schema 変更のたびに UI が壊れる。server 側に境界を 1 枚置けば、handoff の schema が動いても差分はその 1 枚に閉じる。
- **Change freedom**: view 型のフィールド、fold の実装、endpoint の分割は自由。「UI component が生 record を触らない」だけが不変。
- **Why not**（生 record を返して client で fold）: schema 変更の影響が全 component に散る。
- **Anchors**: `lib/idd-ui/types.ts`、`lib/idd-ui/server/state.ts`、`app/api/idd/state/route.ts`

### DEC-602: 文字は rem、レイアウトは px。rem の基準を 16px に置く

- **What**: `lib/idd-ui/scale.ts` の `FS`（7 段）を rem、`SIZE` を px で持つ。`html { font-size }` は 16px。
- **Why**: 文字は画面密度と OS 設定に追従してほしいが、余白の階段（4 / 8 / 12 / 16 / 24 / 48）はグルーピングの意味を担っているので追従させたくない。WQHD で 14px 基準では小さすぎたため、個別に直値を上げるのではなく基準ごと上げた（1 箇所で全体が動く）。
- **Change freedom**: 段の数と値、基準 px は自由。「文字は rem / レイアウトは px」「直値を書かず尺度を経由する」だけが不変。
- **Anchors**: `lib/idd-ui/scale.ts`、`app/globals.css`

### DEC-603: state file が無い環境では source を明示して fixture に落ちる

- **What**: `GET /api/idd/state` は state file が無ければ `source: "empty"` を返し、`hooks/useIddState.ts` が fixture に切り替える。どちらで動いているかは常に `source` で判別できる。
- **Why**: pipeline（cron / planner / executor）が動く前に UI を完成させる必要があった。実データが 1 lane しか無い間、5 種の card と 5 群の sidebar を同時に確認する手段が他にない。黙って空表示にすると「壊れている」と区別が付かないため、落ちたことを値で示す。
- **Change freedom**: fixture の内容、切替の持ち方は自由。「落ちたことが `source` で分かる」だけが不変。
- **Revisit when**: 実 lane が常時 10 本規模になったら fixture 経路ごと削除する。
- **Anchors**: `lib/idd-ui/fixtures.ts`、`hooks/useIddState.ts`、`lib/idd-ui/server/state.ts`

### DEC-604: DEC / QA は event ではなく intent file から parse する

- **What**: GO 待ちの card と lane detail が出す DEC / QA の見出しは、lifecycle event の `dec_count` などの数ではなく `_docs/intent/**` の本文から拾う。見出しの書式は `^#{2,3}\s*((?:DEC|QA|INV)-[\w.]+)\s*[—–:-]?\s*(.+?)$`。書式が崩れていたら空で返し、数だけの表示に落ちる。
- **Why**: handoff の open-questions #16 の B 案。event に本文を持たせると ledger が肥大し、intent が更新されても event は追随しない。`executor-progress-*.json` を event ではなく file で持つ判断（handoff）と同じ思想。
- **Change freedom**: 正規表現、fallback の見せ方は自由。「本文の出所は intent file、event には数まで」が不変。
- **Why not**（event に本文を載せる）: append-only の ledger に可変の本文を載せると、正本が二重化する。
- **Anchors**: `lib/idd-ui/server/state.ts`（parseIntent）

### DEC-605: 判断 1 押下 = ledger 1 append。lock 下で書き、失敗を成功に見せない

- **What**: `POST /api/idd/decide` は 1 押下につき `lifecycle-<repo>.jsonl` へ 1 件だけ append する。書き込みは `proper-lockfile`（pi-web の他機能と同じ）で直列化し、失敗したら `ok:false` を返す。UI は成功するまで queue から札を消さない。
- **Why**: Workspace INV-002（1 button 押下 = 1 ledger event）の履行。楽観更新すると「記録されていないのに判断が済んだように見える」状態が生まれ、ledger が唯一の履歴である以上それは復元不能な齟齬になる。
- **Change freedom**: lock の実装、endpoint の分割、event の attrs は自由。「1 押下 = 1 append」「append できなければ成功を返さない」だけが不変。
- **Anchors**: `lib/idd-ui/server/write.ts`、`app/api/idd/decide/route.ts`

### DEC-606: envelope は outbox に積むまでを担い、agent への注入は別 layer に置く

- **What**: 判断を記録したあと、envelope XML を `state/outbox/<id>.xml` に書き、`outbox.jsonl` に `delivered_at: null` で積む。agent への注入はこの層では行わない。
- **Why**: handoff の open-questions #1（envelope をどう agent に届けるか）が未検証。記録と送信を分けておけば、送信方式が決まっても書き込み側は変わらない。未達が `delivered_at` に残るので、UI が「届いたつもり」を表示せずに済む。
- **Change freedom**: outbox の置き場所と形式は自由。「記録と送信を分ける」「未達が観測できる」だけが不変。
- **Revisit when**: open-questions #1 が解決したら、配信 layer を足して本 DEC を更新する。
- **Anchors**: `lib/idd-ui/server/write.ts`

### DEC-607: 触っているファイルは worktree の git から取り、起点が取れなければ空を返す

- **What**: lane detail の「いま書かれているもの」は、`planner/executor-sessions.jsonl` の `worktree_path` で `git diff --numstat` を実行して作る。起点は `s2_start` の `started_from_commit`、無ければ既定ブランチとの merge-base。どちらも取れなければ空を返す。結果は 5 秒だけ memo 化する。
- **Why**: `executor-progress.recent_activity` は自然文なのでファイル一覧の代わりにならない（あれは stream 側で使う）。実物を見に行けば、executor がまだ progress を書いていない段階でも現況が出る。起点が不明なときに全ファイルを出すと嘘になるため、空の方が正しい。
- **Change freedom**: memo の長さ、diff の取り方は自由。「実物から取る」「起点が無いときは空」だけが不変。
- **Anchors**: `lib/idd-ui/server/lane-work.ts`

### DEC-608: lifecycle event は動詞ひとつの見出しと 4 つの形に写し、節目の間は既定で畳む

- **What**: 41 種の event を `EVENT_META` で「動詞ひとつの見出し + kind（節目 / 自分の判断 / agent の動き / 失敗）」に対応させ、添える値は event ごとに 1 つまで。節目と自分の判断だけを既定で出し、その間の agent の動きは 1 行に畳む。
- **Why**: event 名をそのまま出すと UI が「読まないと分からない」ものになる。lane detail を開く動機は「今どうなっているか」なので、既定は畳む側に置く。「なぜこうなったか」を追うときだけ開けばよい。
- **Change freedom**: 見出しの語、値の選び方、畳む単位は自由。「event 名を露出しない」「既定で畳む」だけが不変。
- **Why not**（全 event を時系列でそのまま出す）: 1 lane あたり数十件になり、節目が埋もれる。
- **Anchors**: `lib/idd-ui/server/events-display.ts`、`components/idd/LaneDetail.tsx`

### DEC-609: state / intent の根は環境変数で差し替え、path だけの module に分ける

- **What**: `IDD_STATE_DIR` / `IDD_INTENT_DIR` で根を差し替えられるようにし、その解決だけを `lib/idd-ui/server/state-paths.ts` に置く。
- **Why**: 実 ledger を汚さずに書き込み経路を検証する必要がある。根の解決を state.ts に置くと lane-work.ts との間に循環 import ができるため、path だけの module に分けた。
- **Change freedom**: 変数名、既定値は自由。「根を差し替えられる」「path 解決が循環を作らない」だけが不変。
- **Anchors**: `lib/idd-ui/server/state-paths.ts`

### DEC-610: build の刻印を画面隅に出す

- **What**: `app/`, `components/`, `hooks/`, `lib/` の最終更新時刻から MMDD-HHmm の刻印を作り、画面右下に極小で常時表示する。5 秒だけ memo 化する。
- **Why**: 出先の端末（特に携帯）は cache が強く、見ているものが最新の build かどうかを判別する手段が無かった。判別できないと、直した / 直っていないの議論が成立しない。
- **Change freedom**: 形式、置き場所、精度は自由。「どの build を見ているかが画面上で判別できる」だけが不変。
- **Anchors**: `lib/build-stamp.ts`、`app/layout.tsx`

### DEC-611: handoff に無い event 名は暫定で置き、決まり次第 rename する

- **What**: S4 の態度 3 に対する「回答」を記録する event が handoff に無いため `s4_verify_user_judgment_answered` を、agent への発言（interjection）を記録するか未決のため `s2_interjection` を、暫定で使う。
- **Why**: open-questions #13 / #15 が未解決。UI 側の実装を止めるより、暫定名で記録しておいて後から rename する方が、少なくとも「判断が起きた事実」が残る。記録しない選択は、後から復元できない。
- **Change freedom**: 暫定名は自由（rename 前提）。「判断が起きたら何らかの event を残す」だけが不変。
- **Revisit when**: open-questions #13 / #15 が解決した時点で rename し、本 DEC を更新する。
- **Anchors**: `lib/idd-ui/server/write.ts`

## Consequences / Impact

- state file の schema 変更は `lib/idd-ui/server/` に閉じる（DEC-601）。UI component は影響を受けない。
- 判断の記録は lock 下の同期書き込みになるため、押下から UI 反映まで数十 ms の待ちが出る（DEC-605）。UI 側はこれを「記録中」の状態として見せる。
- envelope の配信 layer が未実装のため、`state/outbox/` は溜まり続ける（DEC-606）。open-questions #1 の解決までは手動で捌く。
- fixture 経路が残るため、`source` を見ずに実装すると mock を実データと誤認しうる（DEC-603）。

## Quality Implications

- **DEC-605 が守る品質**: ledger が判断の唯一の履歴であり続ける。破ると: UI 上は済んだ判断が ledger に無い状態が生まれ、pipeline 全体の再現性が失われる。
- **DEC-604 が守る品質**: intent の本文の正本が 1 箇所に保たれる。破ると: event と intent file が食い違い、どちらが正しいか決められなくなる。
- **DEC-607 が守る品質**: 表示は常に実物に対応する。破ると: 存在しない変更を見て判断することになる。

## Intent-derived Invariants

- INV-003 (from DEC-605): 判断の押下 1 回につき lifecycle event を 1 件だけ append し、append が失敗した押下を成功として UI に返さない。

## Rollback / Follow-ups

- **Rollback**: `lib/idd-ui/` 一式と `app/api/idd/{state,lane,decide}` を削除すれば、pi-web の既存機能はそのまま残る（既存 shell への追加点は components 側 DEC-633 の 3 箇所のみ）。
- **Follow-ups**:
  - open-questions #1 の解決後に envelope 配信 layer を足す（DEC-606）
  - open-questions #13 / #15 の解決後に暫定 event 名を rename する（DEC-611）
  - 実 lane が 10 本規模になった時点で fixture 経路を削除する（DEC-603）
