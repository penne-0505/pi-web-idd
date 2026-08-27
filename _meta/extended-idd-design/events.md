# Lifecycle event 一覧

拡張 IDD で扱う全 lifecycle event。すべて `state/lifecycle-<repo>.jsonl` に append される。record は共通 schema:

```json
{
  "event": "<event_name>",
  "idd_id": "IDD-042",
  "at": "<ISO 8601 timestamp with JST>",
  "attrs": { ... event-specific ... }
}
```

## Stage 別一覧

### S0: Intake (3 events)

- **`lane_open`** — backlog に record 追加 (attrs: `source_type`, `context`, `area`)
- **`pending_review_open`** — 重複疑いで pending review に投入 (attrs: `review_id`, `detection_method: "url" | "semantic"`)
- **`pending_review_resolved`** — 人間判定 (attrs: `review_id`, `outcome: "merge" | "anyway_go" | "delete"`)

### S1: Planner Prep (5 events)

- **`question_batch_asked`** — planner が質問 batch を発行 (attrs: `batch_id`, `question_ids: [...]`)
- **`question_batch_answered`** — batch 内全質問回答完了 (attrs: `batch_id`)
- **`s1_ready`** — 下調べ完了、人間 GO 待ち (attrs: `planner_session_id`, `dec_count`, `inv_count`, `qa_count`, `reference_count`)
- **`s1_go`** — 人間 GO 判定 (attrs: `at_by: "user"`)
- **`s1_defer`** — 人間 DEFER 判定 (attrs: `reason: string`)

### S2: Executor Implementation (6 events)

- **`s2_start`** — executor 起動 (attrs: `executor_session_id`, `model`, `started_from_worktree`, `started_from_commit`)
- **`blocked_by_dependency`** — depends_on 未満足で待機 (attrs: `depends_on: [...]`, `waiting_for: [...]`)
- **`s2_blocked`** — 情報不足等で blocked (attrs: `batch_id: string` — 質問 batch を発した場合)
- **`s2_model_fallback`** — モデル切替 (attrs: `from: "opencode go v4flash"`, `to: "ollama cloud v4flash"`, `reason: string`)
- **`s2_recovery_attempt`** — 自己修復試行 (attrs: `attempt_number: 1|2|3`, `failure_type: string`)
- **`s2_result`** — 実装完了 (attrs: `outcome: "success" | "partial" | "failed"`, `changed_files: [...]`, `commit_count`, `qa_verified: [...]`, `qa_unverified: [...]`, `side_findings: [...]`)

### S3: Integration Check (12 events)

- **`s3_ready`** — S3 queue 投入 (attrs: none)
- **`s3_check_in_progress`** — integration check 実行中 (attrs: `check_type: "merge_tree_only" | "cascading"`, `cascaded_lanes: [...]`)
- **`s3_check_clean`** — clean 判定 (attrs: none)
- **`s3_check_conflict`** — conflict 検出 (attrs: `conflict_files: [...]`, `conflict_type: "vs_upstream" | "vs_queued" | "mixed"`)
- **`s3_check_invalidated`** — cascading check 再実行 trigger (attrs: `reason: string`)
- **`s3_integrator_analysis`** — Integrator が conflict 分析開始 (attrs: `integrator_session_id`)
- **`s3_mechanical_resolve`** — Integrator 態度 1 (attrs: `resolved_files: [...]`)
- **`s3_sub_todo_spawned`** — Integrator 態度 2 (attrs: `sub_todo_id: "IDD-XXX"`)
- **`s3_user_judgment_requested`** — Integrator 態度 3 (attrs: `question_batch_id`)
- **`s3_ok`** — 人間 review 承認 (attrs: `reviewer_notes: string`, `side_findings_promoted: [...]`)
- **`s3_reject`** — 人間 review 却下 (attrs: `reason: string`, `next_stage: "s2_retry" | "s1_rethink" | "deferred"`, `feedback: string`)
- **`s3_defer`** — 人間 review 保留 (attrs: `reason: string`)

### S4: Ship (12 events + close)

**Phase A**:

- **`s4_submit_started`** — Phase A 開始 (attrs: none)
- **`s4_verify_started`** — Verifier 起動 (attrs: `verifier_session_id`)
- **`s4_verify_clean`** — Verifier 態度 1 or user "proceed anyway" (attrs: none)
- **`s4_verify_mechanical_fix`** — Verifier 態度 2 (attrs: `what_was_fixed: string`)
- **`s4_verify_user_judgment_requested`** — Verifier 態度 3 (attrs: `question_batch_id`)
- **`s4_pushed`** — upstream push 完了 (attrs: `pushed_branch: string`, `commit_shas: [...]`)
- **`s4_pr_created`** — PR/MR 作成 (attrs: `pr_url: string`, `pr_number: number`)

**Phase B**:

- **`s4_ci_failed`** — CI 失敗検出 (attrs: `failure_type: "test" | "lint" | "format" | "build" | "type_check" | "security_scan" | "deployment" | "e2e" | "other"`, `ci_log_excerpt: string`, `affected_files: [...]`)
- **`s4_review_comment_received`** — reviewer コメント受領 (attrs: `commenter: string`, `comment_body: string`, `comment_url: string`)
- **`s4_change_pushed`** — Responder 態度 1 で修正 push (attrs: `commit_hash: string`, `changed_files: [...]`)
- **`s4_response_posted`** — reviewer への返答 comment を post (attrs: `attitude: "mechanical" | "sub_todo" | "user"`, `comment_body: string`, `comment_url: string`)
- **`s4_merged`** — upstream で merge された (attrs: `merged_at: string`, `merged_by: string`)

**Close**:

- **`lane_close`** — lane 完全終了 (attrs: `merged_pr_url`, `total_commits`, `total_duration_hours`, `final_qa_verified: [...]`)

### 共通 (2 events)

- **`priority_elevated`** — Level 1 interrupt が立った (attrs: `reason: string`, `elevated_by: "user" | "system"`)
- **`priority_reset`** — interrupt 解除 (attrs: `reason: string`)

## 全 event 数

- S0: 3
- S1: 5
- S2: 6
- S3: 12
- S4: 13 (Phase A: 7, Phase B: 5, Close: 1)
- 共通: 2

**合計: 41 event types**

## 派生 status との対応 (`deriveStage` の実装ヒント)

UI status との対応 (最新 event を見て決定):

| UI status | 対応する event |
| --- | --- |
| `backlog` | `lane_open` (直後、`s1_ready` 未) |
| `pending_review` | `pending_review_open` (未 resolved) |
| `prep` | `s1_ready` (未 `s1_go`), `pending_question` 中 |
| `ready_to_go` | `s1_ready`, かつ pending_question 全解決済み |
| `execute` | `s1_go` 後、`s2_start` から `s2_result` の間 |
| `review` | `s3_ready` から `s3_ok` の間 |
| `ship` | `s3_ok` から `s4_merged` の間 |
| `done` | `s4_merged` 後 |
| `deferred` | `s1_defer` or `s3_defer` |
| `archived` | `lane_close` 後 |

## Event 命名規則

- prefix (`s0_`, `s1_`, `s2_`, `s3_`, `s4_`) で stage を示す
- prefix なし (`lane_*`, `question_*`, `pending_*`, `blocked_*`, `priority_*`) は複数 stage で使う共通 event
- 動詞は過去分詞 (`_ready`, `_answered`, `_resolved`) または名詞的 (`_start`, `_result`)
