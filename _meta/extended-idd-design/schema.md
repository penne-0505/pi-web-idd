# State file schema

pi-web-idd の `state/` ディレクトリに配置される全 state file の schema。全て append-only な JSON Lines 形式 (cron-run summary は 1 ファイル 1 record の JSON)。

## `state/backlog.jsonl`

全 lane の metadata。source of truth。

```json
{
  "idd_id": "IDD-042",
  "parent_id": null,
  "created_at": "2026-08-25T05:30:00+09:00",
  "linear_issue_url": "https://linear.app/dayseum/issue/APP-1712",
  "gh_issue_url": null,
  "pull_req_url": null,
  "source_type": "linear",
  "context": "meltly",
  "title": "ダークモード対応 (可視性 QA を含む)",
  "area": "dayseum-app",
  "priority_snapshot": {
    "linear_label": "高",
    "linear_priority": "High",
    "gh_label": null
  }
}
```

- `idd_id`: primary ID (`IDD-` + 連番)、不変
- `parent_id`: fractal 用。独立 lane は `null`、sub_todo は親の idd_id
- `linear_issue_url` / `gh_issue_url` / `pull_req_url`: URL のみ (ID は helper で parse)、無い場合は null
- `pull_req_url` は intake 時点で常に null (S4 Phase A で埋まる)
- `source_type`: `"linear" | "github"`
- `context`: `"meltly" | "personal"` (Meltly = Dayseum なので `"dayseum"` は含めない)
- `title`: source 側 title の intake 時点 snapshot (source 更新に追随しない)
- `area`: repo または論理領域 (`"dayseum-app"`, `"medo"` 等)
- `priority_snapshot`: intake 時点の priority 情報 snapshot

## `state/lifecycle-<repo>.jsonl`

各 repo ごとの lifecycle event 履歴。1 repo 1 file (`lifecycle-dayseum-app.jsonl`, `lifecycle-medo.jsonl` 等)。

```json
{
  "event": "s1_ready",
  "idd_id": "IDD-042",
  "at": "2026-08-25T05:52:34+09:00",
  "attrs": {
    "planner_session_id": "pi-session-abc123",
    "dec_count": 3,
    "inv_count": 2,
    "qa_count": 4,
    "reference_count": 6
  }
}
```

**status の派生**: `deriveStage(events)` で lifecycle event 履歴から現在の UI status (`backlog / prep / execute / review / ship / done / deferred / archived`) を計算。backlog record 自体には status を持たせない。

## `state/pending-reviews.jsonl` (S0)

重複疑いで保留された候補。backlog に入る前段階。

```json
{
  "review_id": "REV-007",
  "detected_at": "2026-08-25T05:31:14+09:00",
  "candidate": {
    "source_type": "linear",
    "linear_issue_url": "https://linear.app/dayseum/issue/APP-1712",
    "title": "ダークモード対応",
    "context": "meltly",
    "area": "dayseum-app"
  },
  "suspected_duplicate_of": ["IDD-020"],
  "detection_method": "semantic",
  "detection_reason": "APP-1712 は既存の IDD-020 (ダークモード基礎対応) と 87% 意味類似。両者とも SettingsPanel のトグル追加を扱っている"
}
```

- `review_id`: `REV-` + 連番 (backlog 未 append なので IDD- 割り振らない)
- `detection_method`: `"url" | "semantic"`
- 判定結果は `pending_review_resolved` event に記録 (`attrs.outcome: "merge" | "anyway_go" | "delete"`)

## `state/pending-questions.jsonl` (S1, S2)

Planner / Executor が投げる質問 batch。

```json
{
  "idd_id": "IDD-042",
  "batch_id": "B-001",
  "asked_at": "2026-08-25T05:34:12+09:00",
  "questions": [
    {
      "question_id": "Q-001",
      "question": "ダークモードのトグルはどこに配置しますか?",
      "context": "既存の設定パネル (SettingsPanel.tsx) は 3 tab 構成で...",
      "options": [
        { "index": 1, "label": "既存の設定パネル内に追加する", "description": "4 tab 目になるが、設定関連が一箇所にまとまる" },
        { "index": 2, "label": "header の右上に独立配置する", "description": "常時表示で切り替えは速いが、視覚密度が上がる" },
        { "index": 3, "label": "既存パネルを再構成してから追加する", "description": "手間はかかるが情報設計としては根本改善" }
      ]
    }
  ]
}
```

- `batch_id`: lane 内で連番 (`B-001`, ...)
- `question_id`: lane 内 global 連番 (batch を跨いでも重複しない)
- `options`: 最大 5、1-indexed の `index` 込み。「その他」は含めない (UI 側で自動追加)
- 依存関係のある質問は別 batch に分ける

## `state/pending-answers.jsonl` (S1, S2)

回答は 1 質問ずつ append。

```json
{
  "idd_id": "IDD-042",
  "batch_id": "B-001",
  "question_id": "Q-001",
  "answered_at": "2026-08-25T07:22:00+09:00",
  "selection": {
    "index": 3,
    "label": "既存パネルを再構成してから追加する"
  },
  "reason": "既存パネルの情報密度が理想と比べると微妙で、この機会に整理し直したいから",
  "notes": null
}
```

- `selection`: `{index, label}` (通常 option) or `{label: "その他"}` (index 無し)
- `reason`: 選択理由 (任意だが推奨。IDD の intent 記録性を保つ)
- `notes`: 追加補足。その他 選択時は実際の回答本文がここに入る
- planner の resume 条件: 対応する batch の全 question に answer が集まる (部分回答では resume しない)

## `state/planner-sessions.jsonl`

lane と planner pi session の対応。server 再起動時の resume 用。

```json
{
  "idd_id": "IDD-042",
  "planner_session_id": "pi-session-abc123",
  "started_at": "2026-08-25T05:32:00+09:00",
  "worktree_path": "../pi-web-idd-lanes/IDD-042",
  "branch": "idd/IDD-042",
  "model": "openrouter/z-ai/glm-5.3:xhigh"
}
```

## `state/executor-sessions.jsonl`

planner-sessions と同構造 (executor 版)。model は `opencode go v4flash`。

## `state/executor-progress-<IDD-ID>.json` (上書き更新)

executor の中間進捗 (1 lane 1 file)。lifecycle event の肥大化を避けるため event ではなく file で管理。

```json
{
  "idd_id": "IDD-042",
  "updated_at": "2026-08-25T14:32:00+09:00",
  "current_step": "implementing",
  "qa_status": [
    { "qa_id": "QA-1", "status": "verified", "verified_at": "2026-08-25T14:15:00+09:00" },
    { "qa_id": "QA-2", "status": "in_progress" },
    { "qa_id": "QA-3", "status": "not_started" }
  ],
  "recent_activity": [
    "ThemeProvider.tsx: system preference listener 追加",
    "theme.test.ts: 切替時間 3 秒以内の verify test 追加"
  ]
}
```

- `current_step`: `"reading_intent" | "implementing" | "testing" | "blocked" | "completed"`
- `recent_activity`: 最大 10 件、FIFO で古いのを捨てる
- append-only ではなく **上書き更新** (履歴は git log 側で追える)

## `state/cron-run-<timestamp>.json` (1 実行 1 file)

朝の cron 実行の完了サマリ。

```json
{
  "cron_run_id": "2026-08-25T05:30:00+09:00",
  "started_at": "2026-08-25T05:30:00+09:00",
  "completed_at": "2026-08-25T05:58:42+09:00",
  "intake_count": 10,
  "duplicates_detected": 2,
  "pending_review_ids": ["REV-007", "REV-008"],
  "backlog_added_ids": ["IDD-042", "IDD-043", "IDD-044"],
  "s1_ready_ids": ["IDD-042", "IDD-043"],
  "pending_question_ids": ["IDD-044"],
  "s1_failed_ids": [],
  "failure_details": []
}
```

朝起きたときの Web UI 通知はこれを元に生成。

## 派生ルール

**effective priority**:
1. backlog の `priority_snapshot` から 11 段階 (`stages.md` の priority ranking) のうち該当する level を計算
2. 最新の `priority_elevated` lifecycle event が発火中 (`priority_reset` で解除されていない) なら Level 1 に上書き
3. 複数条件該当時は最も小さい数字 (高優先) を採用
4. 同 level 内は `created_at` 昇順

**current status**: `deriveStage(events)` で lifecycle events から動的計算。record 自体には持たせない。

**未回答質問の抽出**: `pending-questions.jsonl` の全 (batch_id, question_id) から `pending-answers.jsonl` にある (batch_id, question_id) を LEFT JOIN で除外。

**未判定 pending_review の抽出**: `pending-reviews.jsonl` の全 review_id から `pending_review_resolved` event が発火した review_id を除外。
