# 拡張 IDD の 5 段階

## S0: Intake

**目的**: Linear / GitHub から起票済み issue を拾い、backlog に追加

**trigger**:
- 主: 朝 5:30 JST cron
- 副: 会話中 LLM 経由の手動 trigger (skill + `/api/idd/intake`)

**source scope**:
- **Linear (Meltly)**: `status ∈ {Todo, Backlog}` かつ `label ∈ ["skill/app-frontend", "skill/backend"]` (allowlist 明示列挙)
- **GitHub (個人)**: `repo ∈ ["penne-0505/medo", "penne-0505/pi-web-idd", ...]` (allowlist) かつ `label = "idd-ready"`

**重複判定**:
- 第 1 段階: URL 完全一致 (機械)
- 第 2 段階: 意味類似 (AI が判定、cron session 内 LLM 使用)
- 疑いあり → `pending_review_open` → 人間判定 UI で保留

**pending_review 判定 3 択**:
- **merge**: 新規を既存 lane の sub_todo として backlog に追加 (parent_id 付き)
- **anyway_go**: 新規を独立 lane として backlog 追加
- **delete**: source 側処理 (Linear: Duplicate status + relation / GitHub: close + duplicate label + comment)

**応答なし**: 持ち越し (次 cron で再検出しないフィルタ)

## S1: Planner Prep

**目的**: 各 lane について planner が下調べ (DEC/INV/QA/reference 生成)

**trigger**: S0 完了直後、同 cron session 内で継続

**並列化**:
- priority ranking (11 levels、詳細は本文書後述) で lane を sort
- 同 level 内は created_at 昇順 (FIFO)
- 並列度上限: `IDD_PLANNER_CONCURRENCY=5` (env)
- 各 lane に独立 planner pi session を spawn (GLM 5.3 xhigh)
- 各 lane に git worktree を切る (`idd/IDD-042`)

**Planner 出力 (`_docs/intent/<Area>/<slug>/`)**:
- `decision.md` (DEC)
- `invariant.md` (INV)
- `qa.md` (QA)
- `reference.md` (reference)

**完了状態 2 種**:
- `s1_ready`: 下調べ完了、人間 GO 待ち
- `pending_question`: 情報不足で質問 batch を発した、人間回答待ち

**質問 batch** (S1 で最大 5 問/batch、選択肢 1-5 + その他):
- record: `pending-questions.jsonl` に append (batch_id, question_id 付き)
- 回答: `pending-answers.jsonl` に 1 質問ずつ append
- planner の resume 条件: batch 内の全 question に answer が集まったとき
- resume 方法: envelope (Web UI → LLM) で user prompt 前挿入

## S2: Executor Implementation

**目的**: 人間 GO 判定を受けた lane を executor が実装

**trigger**: 人間が Web UI で GO ボタン → `s1_go` event (ledger 直接書き込み、AI 非経由)

**executor**:
- 常駐 supervisor (pi-web-idd server 内 Node.js) が `s1_go` を検出
- executor pi session を spawn (opencode go v4flash、fallback: ollama cloud v4flash)
- 独立 git worktree で作業 (S1 で切ったやつを引き継ぎ)
- 並列度上限: `IDD_EXECUTOR_CONCURRENCY=3` (env、default)

**依存関係**: `depends_on: [IDD-XXX]` 満たさない lane は `blocked_by_dependency` で待機

**実装 loop**:
- QA 消化順に対応 → 変更 → test → commit
- 意味のある単位で commit (5 file / 100 行 目安)
- commit message は IDD 形式: `intent: DEC-042.1 — <要約>`

**失敗 handling**:
- モデル応答不能 → `s2_model_fallback` (ollama cloud に切替)
- test 失敗 → `s2_recovery_attempt` (自己修復 3 回まで、超えたら blocked)
- 情報不足 → `s2_blocked` → S1 質問機構流用

**完了**: `s2_result` (outcome: success / partial)、`executor-progress-IDD-XXX.json` 更新

## S3: Integration Check

**目的**: 並列 lane 同士 / upstream との conflict を検査・解決

**trigger**: `s2_result` (success/partial) → S3 queue 投入 (`s3_ready`)

**Integrator agent**:
- area 別、event trigger spawn
- GLM 5.3 xhigh
- executor から handoff (intent + diff + side_findings + 対立 lane info)
- `git merge-tree` で cascading check (upstream + queued s3_ok lanes)

**Integrator 3 態度** (conflict 検出時):
- **1: mechanical resolve**: 自動解消 commit、re-check
- **2: sub todo spawn**: 新 lane 起票 (parent_id + priority Level 1)、S2 loop で対応 → 完了後 re-check
- **3: user 判断**: `defer / reject / anyway_push` を人間に問う

**clean 時**: 人間 review (diff + QA + side_findings 提示) → `s3_ok / s3_reject / s3_defer`

**s3_reject の 3 分岐** (next_stage 指定):
- `s2_retry`: envelope で executor に feedback → 再実装
- `s1_rethink`: planner 再起動 (方針から見直し)
- `deferred`: 保留

**cascading check invalidation**: 前 lane の状態変化で後続 lane を再 check

## S4: Ship

**目的**: 実装を upstream に push、PR 化、review 対応、merge 検出、cleanup

**Phase A (非 AI 中心、Verifier のみ AI)**:

1. commit rewrite (area rule で機械的に prefix 変換 + body の IDD 参照除去)
2. branch rename
   - Meltly: `linear-axi` MCP or Linear API で `getIssue(APP-XXXX).branchName` 取得 (Linear チケット自動追従のため)
   - 個人 repo: area config の pattern (`{type}/{gh_issue_number}-{slug}` 等)
3. PR body 生成 (全 commit を AI 要約 + issue link + QA verified summary)
4. **VERIFY** (Verifier agent, GLM 5.3 medium, area 別, event trigger)
   - IDD leak check / semantic completeness / PR body ↔ commits alignment / style conformance
   - 3 態度: clean / mechanical fix / user 判断 (defer / proceed anyway / revise)
5. upstream push
6. PR/MR 作成

**Phase B (AI Responder)**:

- polling で PR 状態監視 (active 1 分 / idle 10 分 / 起動時 catch-up)
- event 検出: `s4_ci_failed` / `s4_review_comment_received` / `s4_merged`
- Responder spawn (area 別、event trigger、opencode go v4flash)

**Responder 3 態度**:
- **1: mechanical fix**: 軽微修正 commit + push (条件: 変更 line ≤30, file ≤3, INV/QA 影響なし)
- **2: sub todo spawn**: 新 lane 起票 → S2 loop (Integrator の態度 2 と同じ)
- **3: user 判断**: defer / reject / revise / sub_todo を人間に問う

**返答 comment 扱い**: 態度別で自動 post (態度 1: 修正 diff summary 付き / 態度 2: informational / 態度 3: 人間判定内容を反映)

**CI 失敗種類** (attrs.failure_type): `test / lint / format / build / type_check / security_scan / deployment / e2e / other` — 全て Responder 3 態度で共通処理、security_scan は default で態度 3

**merged → cleanup 7 手順**:
1. worktree 削除 (`git worktree remove`)
2. local branch 削除 (`git branch -D`)
3. executor/responder session 停止 (state: closed マーク)
4. intent 系 archive (`_docs/intent/` → `_docs/intent-archive/<merged-date>/`)
5. pending questions/answers を closed マーク (append-only なので物理削除しない)
6. `lane_close` event 発火 (attrs: merged_pr_url, total_commits, duration)
7. `depends_on` 解放 (blocked lane を pickup 可能に)

## priority ranking (11 levels)

lane の実行順序 (S1 planner spawn 順、S2 executor pickup 順に適用):

1. 人間が明示的に「優先しろ」と割り込み指示したもの
2. Linear priority = Urgent
3. Linear `"高"` label
4. Linear priority = High
5. GitHub `P0` label
6. Linear `"中"` label
7. Linear priority = Medium
8. GitHub `P1` label
9. GitHub `P2` label
10. Linear priority label 無し & (priority = Low or No priority)
11. GitHub priority label 無し

**判定ルール**: 1 lane が複数条件該当時は最も高い level (小さい数字) を採用。同 level 内は `created_at` 昇順 (FIFO)。
