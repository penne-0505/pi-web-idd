# Agent session の役割分担

拡張 IDD で使う 6 種類の agent session。すべて pi session として実装 (pi は agent harness、agent harness ごとに複数 provider をサポートする形なので実装時に切り替え可能)。

## Agent 一覧

| Agent | Model | 存在形態 | area 別? | 主な役割 |
| --- | --- | --- | --- | --- |
| Orchestrator | (非 AI code) | cron session 内、cron 起動時のみ | 単一 | S0 intake + S1 planner spawn 制御 |
| Planner | GLM 5.3 xhigh | orchestrator が spawn | 単一 (lane 別に spawn) | intent (DEC/INV/QA/reference) 生成 |
| Executor | opencode go v4flash (fallback: ollama cloud v4flash) | 常駐 supervisor が pickup | 単一 (lane 別に spawn) | 実装作業 |
| Integrator | GLM 5.3 xhigh | event trigger spawn | area 別 | S3 conflict 分析・解決 |
| Verifier | GLM 5.3 medium | event trigger spawn | area 別 | S4 Phase A の rewrite / PR body verify |
| Responder | opencode go v4flash | event trigger spawn | area 別 | S4 Phase B の CI / review comment 対応 |

## 詳細

### Orchestrator (非 AI, cron session 内 code)

- 位置づけ: 全体の司令塔
- 実装: pi-web-idd server 内の Node.js 関数群
- 動作:
  - 5:30 cron (or 手動 trigger) で起動
  - S0 の intake 処理を実行 (Linear/GitHub 取得、重複判定、backlog append)
  - S1 で並列 planner を spawn (priority sort 済み、並列度上限 5)
  - 全 planner の完了を集約
  - `cron-run-<timestamp>.json` summary を書き出して session 終了

### Planner (GLM 5.3 xhigh)

- lane ごとに独立 spawn (S1 で並列)
- 各 lane 用に git worktree を切ってから起動
- intent 文書 4 種を `_docs/intent/<Area>/<slug>/` に生成:
  - `decision.md` (DEC)
  - `invariant.md` (INV)
  - `qa.md` (QA)
  - `reference.md` (reference)
- 完了時 `s1_ready` event 発火
- 情報不足時 `pending_question` batch を発して人間回答待ち (batch 内最大 5 問、選択肢 1-5 + その他)

### Executor (opencode go v4flash)

- pi-web-idd server 内の常駐 supervisor (Node.js) が `s1_go` event を watch
- event 検出時に executor pi session を spawn
- 独立 git worktree で作業 (S1 で切ったものを引き継ぎ)
- 実装 loop: QA 消化順 → 変更 → test → commit
- commit message は IDD 形式 (`intent: DEC-042.1 — <要約>`)
- 並列度上限: `IDD_EXECUTOR_CONCURRENCY=3` (env)
- 失敗時:
  - モデル応答不能 → ollama cloud v4flash に fallback
  - test 失敗 → self recovery 3 回まで
  - 情報不足 → S1 質問機構を流用

### Integrator (GLM 5.3 xhigh)

- **area 別に 1 Integrator** (`dayseum-app` 用と `medo` 用を分離)
- **event trigger spawn** (常駐しない): `s3_ready` event で spawn
- executor から handoff を受け取る (intent + diff + side_findings + 対立 lane info)
- `git merge-tree` cascading check (upstream + queued s3_ok lanes)
- 3 態度で判定:
  - **1: mechanical resolve** — 自動解消 commit → re-check
  - **2: sub todo spawn** — 新 lane 起票 (parent_id 付き, priority Level 1) → executor spawn → S2 loop
  - **3: user 判断** — `defer / reject / anyway_push` を人間に問う
- 検査結果 clean の場合は人間 review 待ちに (人間判定は Integrator の外)

### Verifier (GLM 5.3 medium)

- **area 別** (Integrator と同じ)
- **event trigger spawn** (常駐しない)
- S4 Phase A の rewrite/生成した全成果物を最終チェック
- 検査内容 4 項目:
  - **IDD leak check**: 機械 rule で除去しきれなかった IDD 語彙 (`DEC-`, `INV-`, `QA-`, `IDD-`, `_docs/intent/` 等) が残ってないか
  - **Semantic completeness**: rewrite で重要な情報 (数字/制約) が失われてないか
  - **PR body ↔ commits alignment**: PR body が commit の実態を反映しているか
  - **Style conformance**: area 慣習 (Meltly の Conventional Commits format 等) に沿っているか
- 3 態度で判定:
  - **1: clean** — push へ進む
  - **2: mechanical fix** — 見落とし規則ベース修正 → re-verify (loop)
  - **3: user 判断** — `defer / proceed anyway / revise` を人間に問う

### Responder (opencode go v4flash)

- **area 別** (Integrator / Verifier と同じ)
- **event trigger spawn** (常駐しない): `s4_ci_failed` / `s4_review_comment_received` で spawn
- S4 Phase B の event 対応
- 3 態度で判定:
  - **1: mechanical fix** — 軽微修正 commit + push (条件: 変更 line ≤30, file ≤3, INV/QA 影響なし)
  - **2: sub todo spawn** — Integrator と同じ pattern (新 lane 起票 → S2 loop)
  - **3: user 判断** — `defer / reject / revise / sub_todo` を人間に問う
- 返答 comment を自動 post (態度別に安全策あり)

## 3 態度パターンの意味 (共通)

Integrator / Verifier / Responder はいずれも「AI が判断できる範囲は AI が処理、判断困難は人間に投げる」の設計。

- **態度 1 (mechanical fix or resolve)**: AI が確信を持って処理できるケース。人間介在ゼロ
- **態度 2 (sub todo spawn)**: AI が「別 lane として本格対応が必要」と判定するケース。fractal 構造に落とす
- **態度 3 (user 判断)**: AI が確信を持てない、方針レベルの判定が必要。envelope で人間に選択肢を投げる

この共通パターンは pi-web-idd の実装で **agent-agnostic な 3-verdict framework** として抽象化できる可能性あり (実装時判断)。

## Session 永続性

すべての agent session は disk 永続化 + resume 可能にする:

- `state/planner-sessions.jsonl`
- `state/executor-sessions.jsonl`
- (Integrator / Verifier / Responder は event trigger spawn なので session 永続化の必要性が低いが、long-running な場合は同様に永続化)

server 再起動時、jsonl を read → 該当 pi session を resume して待機再開。
