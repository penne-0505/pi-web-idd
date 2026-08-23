---
title: pi-web-idd workspace 判断（正本）
status: active
intent_schema: 3
created_at: 2026-08-23
updated_at: 2026-08-23
references: []
related_issues: []
related_prs: []
---

<!-- Canonical path: _docs/intent/Workspace/pi-web-idd-workspace/decision.md -->

# pi-web-idd workspace DEC（正本）

本 repo は agegr/pi-web v0.8.9 からの独立 fork に IDD template を載せて、Meltly IDD pipeline の pi worker 管理層 + web UI を構築する場所である。本文書は repo 全体を横断する判断の台帳として維持する。

## Context

- 派生元: [agegr/pi-web](https://github.com/agegr/pi-web) v0.8.9 (SHA `2a6e537`)。MIT ライセンス。Next.js 16 + React 19 + TypeScript の localhost web UI。
- IDD template: penne-0505/intent_driven_dev_template（本 repo の初期構造）
- 起点となる痛み: Meltly の IDD fan-out（`~/dev/00_meltly/sync-tools/fan-out/`）で pi を 1 タスク 1 spawn する cold-start パターンを試したところ、GLM 5.3:xhigh の推論が 5 分 timeout に収まらず 2 件連続失敗（2026-08-23 09:54 観測）。pi-web を調査した結果、AgentSessionWrapper が既に「1 session = 1 in-process pi 実体」を実装しており、これを persistent worker として使えることが判明した。
- 従来設計との対応: sync-tools/ui/（Python + FastAPI、Agent 3 が構築）は本 repo が同等機能を持った時点で廃止（DEC-005）。lifecycle event 名の contract（msync 側の naming: `lane_open`, `s1_ready`, `s2_result`, ...）を本 repo が承継する。

## Decisions

### DEC-001: pi-web v0.8.9 の完全固定派生（upstream 追従なし）

- **What**: 派生元 pi-web v0.8.9（SHA `2a6e537`, MIT）を固定 base とし、以降 upstream（agegr/pi-web）の変更は一切取り込まない。auto merge も cherry-pick も行わない。`upstream-frozen` remote は MIT attribution 目的の reference として保持するが、fetch も基本行わない（clone 直後の状態から動かさない）。
- **Why**: 本 repo は「pi-web の runtime を借りて IDD dashboard + worker 管理層を作る」目的であって、pi-web 本体の開発を追随する意味がない。追随を選択肢として残すと、本 repo 内での pi-web ファイルの改変（例: comment の IDD 化）を将来の cherry-pick 衝突コストで縛ることになり、IDD 化の自由度を失う。「取り込まないことを最初から約束する」方が判断の一貫性が高い。
- **Change freedom**: pi-web 由来ファイルの改変は自由（comment の IDD スタイル化、DEC 化、削除等）。「upstream の HEAD を merge / cherry-pick しない」だけが不変。
- **Why not**（cherry-pick 経路を残す）: 上記 Why の通り、選択肢を残すこと自体がコストになる。真に必要な upstream fix が出た場合は、その時点で本 repo に独立に実装する（cherry-pick せず自分の判断で書く）。
- **Revisit when**: pi-web の runtime が本 repo の目的に対して致命的に不足するようになり、かつ pi-web v0.8.10+ でその欠陥が解消された場合。その場合も cherry-pick ではなく、必要部分のコード転記 + DEC で由来を明記する形を取る。
- **Anchors**: `.git/config`（remote は upstream-frozen として reference 保持、fetch/merge の運用なし）

### DEC-003: msync 系 overlay 機構は導入しない（client data 境界なし）

- **What**: 本 repo は個人プロジェクトで client データを持たない。sync-tools 相当の overlay / export / propose / approve 機構は導入しない。git commit と push は直接行い、GitHub PR は通常の gh CLI で作る。
- **Why**: msync は Meltly の client repo に対する「先方に見せない overlay」を安全に運用するための機構（Meltly-side DEC-006 参照）。client boundary が存在しない本 repo では overhead だけが増える。
- **Change freedom**: 通常の git 運用の詳細は自由。「msync/overlay 機構を本 repo 内に持ち込まない」だけが不変。
- **Why not**（msync を再利用）: 「client boundary 無しの msync」は概念上意味を持たない（unused overlay の管理コストだけが残る）。
- **Anchors**: `.gitignore`（通常構成、overlay 用の追加 exclude なし）

### DEC-004: pi session = persistent worker（cold-start 廃止）

- **What**: Meltly の IDD fan-out は pi プロセスを 1 タスク 1 spawn の cold-start パターンで動かしていた。本 repo の IDD 拡張は、pi-web の AgentSessionWrapper（`lib/rpc-manager.ts`、`globalThis.__piSessions` に keyed）が既に「1 session = 1 in-process pi 実体」を実現しているため、これを persistent worker として使い、fan-out 相当の処理を「N session を open のまま保ち、タスクを enqueue する」形に置き換える。
- **Why**: cold-start コスト（毎回数秒 × N lane）を消し、live worker status を pi-web 上で観測できる。従来の Python fan-out.py は subprocess 起動を毎回行うため、5 分 timeout に GLM 5.3:xhigh の深い推論が収まらないケースを 2 件観測（2026-08-23）。persistent session であれば timeout の意味自体が変わる（session は生きたまま、prompt 完了を待つだけ）。加えて pi-web の既存 idle timeout（10 分）と `globalThis.__piStartLocks` の並行制御をそのまま活用できる。
- **Change freedom**: worker pool のサイズ、role 割当（planner / executor / verifier 等）、session 割当ポリシーは自由。「session を使い捨てない」だけが不変。
- **Why not**（fan-out.py の subprocess 方式を維持）: cold-start のコストと timeout 逼迫が実測で問題化している。既に pi-web に persistent session 基盤があるのに二重の実装を並走させる合理性がない。
- **Anchors**: `lib/rpc-manager.ts`（pi-web 既存、無改変）、これから追加する `lib/idd/worker-pool.ts`、`app/api/idd/workers/*`

### DEC-005: Meltly 側 sync-tools/ui/（Python）は deprecated 予定

- **What**: `~/dev/00_meltly/sync-tools/ui/` にある Python + FastAPI の IDD dashboard は、本 repo の pi-web 拡張が同等以上の機能を持った時点で廃止する。廃止までは並存させ、以下を本 repo が承継する:
  - lifecycle event 名の contract（msync 側の naming: `lifecycle_lane_open`, `lifecycle_s1_ready`, `lifecycle_s1_go`, `lifecycle_s1_defer`, `lifecycle_s2_start`, `lifecycle_s2_blocked`, `lifecycle_s2_result`, `lifecycle_s3_ready`, `lifecycle_s3_ok`, `lifecycle_s3_reject`, `lifecycle_s4_submitted`, `lifecycle_s4_merged`, `lifecycle_lane_close`）
  - state machine（21 states across S0-S4、cross-lane surface として integration matrix / DEC ID collision）
  - button 集合と各 state における承認境界（DEC-006 系: S1 GO / S3 OK / S4 approval が per-action 承認）
- **Why**: 単一の IDD dashboard を持つ方が保守負担・混乱が少ない。pi-web 拡張は worker 管理層と一体化しているため、Python 側で二重に持つ意味がなくなる。ただし承継が完了するまでは Python 側が生きていた方が観測を絶やさずに済む。
- **Change freedom**: 廃止のタイミング（本 repo のどの機能が揃った時点か）は自由。「lifecycle event 名と state machine と承認境界の contract を承継する」だけが不変。
- **Anchors**: `~/dev/00_meltly/sync-tools/ui/`（承継元、この repo 外）、`~/dev/00_meltly/sync-tools/lib/lifecycle.py`（schema SSOT）、本 repo の `lib/idd/lifecycle-schema.ts`（承継先、これから作成）

### DEC-006: 承認境界は pi-web の per-action button と一致させる（Meltly 側 DEC-006 の承継）

- **What**: 対外境界（Meltly repo への push / PR / レビュー依頼 / export 承認）は per-action の人間承認を通す。本 repo の IDD dashboard では button 押下 = 承認発行として扱い、button 押下 event を承継元の msync ledger に `lifecycle_*` として記録する。auto batch approval は行わない。
- **Why**: Meltly-side DEC-006 の直接承継。承認の per-action 性は Meltly の client-facing 制約であり、UI が pi-web に載っても本質は変わらない。
- **Change freedom**: 承認 UI（button の見た目、confirm dialog の有無）は自由。「1 button 押下 = 1 承認、batch 化しない」だけが不変。
- **Anchors**: これから作成する `components/IDDLaneButtons.tsx`、`app/api/idd/lifecycle/route.ts`（msync CLI を shell 経由で叩く endpoint）

### DEC-007: worker pool は role-aware な pi session registry として lib/idd/worker-pool.ts に実装

- **What**: DEC-004 で宣言した「pi session = persistent worker」を実体化する薄い registry を `lib/idd/worker-pool.ts` に置く。pool の unit は `WorkerDescriptor { id, role, status, model, currentTask?, updatedAt }` で、id は pi 側 AgentSession の session id と 1:1 に対応する。pool state はプロセス内 in-memory Map で保持し、Next.js の hot-reload を跨ぐため `globalThis.__iddWorkerPool` に置く（pi-web の `globalThis.__piSessions` パターンと同型）。role は `planner` / `executor` の 2 種を初期集合とし、model は role ごとに設定する（planner=Kimi 想定、executor=v4 Flash 想定、ただし model 名は runtime で切替可能）。
- **Why**: DEC-004 は方針の宣言であり、実装上は「どの session が誰の role で、いま何をしていて、次のタスクをどこに渡すか」の状態管理が必要になる。この責務を pi-web の `AgentSessionWrapper` に混ぜると内部変更のたびに壊れやすくなるので、addon layer として lib/idd/ 側に閉じ込める。pool を registry として最小化し、実際の session 起動・prompt 送信は既存の `lib/rpc-manager.ts` の API に委譲する。
- **Change freedom**: role の集合、model 割当、task 配布ポリシー（round-robin / priority / manual）、task queue の有無、`WorkerDescriptor` の追加フィールドは自由。「pool は AgentSession の id を鍵にして role/status を addon で持つ」「globalThis に置いて hot-reload を跨ぐ」「rpc-manager を書き換えず上に載る」の 3 点だけが不変。
- **Why not**（pi-web の AgentSessionWrapper を継承して role 情報を持たせる）: 内部 signature 変更のたびに拡張側が壊れる負担が上乗せされる。
- **Revisit when**: role が 3 種以上に増える、task queue が単純な list より複雑な要件（priority, dependency graph）を持つ、または worker の物理配置が multi-machine に広がった時点で pool の設計を見直す。
- **Anchors**: `lib/idd/worker-pool.ts`（本 DEC の実装本体）、`lib/rpc-manager.ts`（pi-web 側、無改変）、`app/api/idd/workers/route.ts`（pool の read 用 GET endpoint）

## Consequences / Impact

- **upstream 追従なし**（DEC-001）: `.git/config` の `upstream-frozen` remote は attribution 目的の reference のみで、fetch / merge の運用はしない。pi-web 由来ファイルの改変は自由。
- **msync 不在**（DEC-003）: 通常の `git add`, `git commit`, `gh pr create` で運用。secret scan は個人 responsibility（gitleaks を任意で pre-commit hook として設置可）。
- **worker pool 設計**（DEC-004）: `lib/idd/worker-pool.ts` に role 別 session 群を保持。planner 1 session, executor 2 session の 3 スロット初期構成想定。role 変更は再起動不要（session の model 切替で対応）。
- **Python UI 承継**（DEC-005）: event 名 mismatch（Agent 3 UI と Agent 1 msync の食い違い、2026-08-23 発見）は本 repo の TypeScript 実装で msync 側に合わせることで解消する。

## Quality Implications

- **DEC-001 が守る品質**: 本 repo の判断が pi-web upstream の判断に上書きされない。破ると: 追跡 cost が発生し、fork の意図が上流に振り回される。
- **DEC-004 が守る品質**: worker の live status が観測できる、cold-start による timeout 失敗が起きない。破ると: fan-out.py 時代の 2 件失敗が再発する。
- **DEC-005/006 が守る品質**: Meltly 側の承認境界を本 repo の UI が正しく代替する。破ると: 対外操作の per-action 承認が抜けて client 側の履歴に予期せぬ操作が入り得る（Meltly 契約リスク）。

## Intent-derived Invariants

- INV-002 (from DEC-006): 1 button 押下 = 1 ledger event。UI の batch mode を後から追加する場合も、内部で N 回に分解して個別 event を書く。

## Rollback / Follow-ups

- **Rollback（全体）**: 本 repo の実装が意図通り動かなかった場合、`~/dev/00_meltly/sync-tools/fan-out/` + `~/dev/00_meltly/sync-tools/ui/`（Python 版）の 2 系統に戻す。fan-out.py 側の GLM 5.3:xhigh は使わず、`IDD_FAN_OUT_PREP_MODEL` を `ollama-cloud/deepseek-v4-flash:0731` などの高速 model に fallback させる（timeout 問題の緩和）。Rollback の判断は本 repo の稼働 1 週間で「pi session の安定性 / dashboard の使い勝手」の 2 軸で行う。
- **Follow-ups**:
  - pi-web の AGENTS.md / CONTEXT.md を本 repo の README / AGENTS.md へ 派生 attribution 付きで手動 merge
  - `lib/idd/lifecycle-schema.ts` の作成（Meltly 側 `lib/lifecycle.py` の TypeScript 移植）
  - `app/api/idd/lifecycle/route.ts` の作成（msync CLI shell out）
  - `lib/idd/worker-pool.ts` の設計と DEC 追加（DEC-007 想定）
  - Meltly 側 Python UI の停止条件を DEC-005 の内訳として明文化
