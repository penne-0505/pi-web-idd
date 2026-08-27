# Area 別 config schema

pi-web-idd は複数の area (repo) を横断的に扱う。area ごとに慣習が違う (Meltly と個人 repo)、config で吸収する。

## config 配置

`config/areas.json` (仮) に集約。

## 完全 schema

```json
{
  "areas": {
    "dayseum-app": {
      "context": "meltly",
      "source_type_priority": "linear",
      "linked_repo": "dayseum/app",
      "branch_name_source": "linear_api",
      "commit_message_rewrite": {
        "strip_prefix": "intent: ",
        "prefix_pattern": "^DEC-\\d+(\\.\\d+)? — ",
        "add_prefix_default": "chore: ",
        "body_strip_patterns": ["INV-\\d+", "QA-\\d+", "DEC-\\d+(\\.\\d+)?"]
      },
      "pr_body_config": {
        "include_issue_link": true,
        "include_qa_summary": true,
        "summary_source": "all_commits_ai"
      },
      "intake_filter": {
        "linear_labels": ["skill/app-frontend", "skill/backend"],
        "linear_statuses": ["Todo", "Backlog"]
      }
    },
    "penne-0505/medo": {
      "context": "personal",
      "source_type_priority": "github",
      "linked_repo": "penne-0505/medo",
      "branch_name_source": "config",
      "branch_name_pattern": "{type}/{gh_issue_number}-{slug}",
      "commit_message_rewrite": {
        "strip_prefix": "intent: ",
        "prefix_pattern": "^DEC-\\d+(\\.\\d+)? — ",
        "prefix_replace_map": {},
        "add_prefix_default": "chore: ",
        "body_strip_patterns": ["INV-\\d+", "QA-\\d+", "DEC-\\d+(\\.\\d+)?"]
      },
      "pr_body_config": {
        "include_issue_link": true,
        "include_qa_summary": true,
        "summary_source": "all_commits_ai"
      },
      "intake_filter": {
        "github_labels": ["idd-ready"]
      }
    }
  }
}
```

## Field 説明

### 共通 field

- **`context`**: `"meltly" | "personal"` — ビジネス分類
- **`source_type_priority`**: `"linear" | "github"` — 主要 source (どちらから起票が来るか)
- **`linked_repo`**: git remote repo 名

### branch_name

- **`branch_name_source`**: `"linear_api" | "config"`
  - `"linear_api"`: Linear の「Copy git branch name」相当を API で取得 (Meltly の Linear チケット自動追従のため必須)
  - `"config"`: 下記 pattern で生成
- **`branch_name_pattern`** (source=config の時のみ): template string
  - 利用可能変数: `{type}`, `{gh_issue_number}`, `{linear_id_lower}`, `{slug}`, `{idd_id}`
  - 例: `"{type}/{gh_issue_number}-{slug}"`

### commit_message_rewrite

commit の subject と body に対する機械的 rewrite rule (Phase A で適用)。

- **`strip_prefix`**: subject の先頭からこの文字列を削除 (例: `"intent: "`)
- **`prefix_pattern`**: 上記 strip の後、subject 先頭がこの regex にマッチしたら削除 (例: `"^DEC-\\d+(\\.\\d+)? — "`)
- **`prefix_replace_map`** (optional): 残った subject が特定 prefix で始まっていれば置換 (通常は空)
- **`add_prefix_default`**: 上記でマッチしなかった subject に付与する default prefix (例: `"chore: "`)
- **`body_strip_patterns`**: commit body からこれらの regex にマッチする部分を削除 (IDD 参照除去)

**注意**: body の「意味を保つ書き換え」は行わない。情報欠落を許容する (詳細は本文書後述)。

### pr_body_config

PR 本文生成の設定。

- **`include_issue_link`**: bool — Linear/GitHub issue へのリンクを PR body に含める
- **`include_qa_summary`**: bool — QA verified 一覧を PR body に含める
- **`summary_source`**: `"all_commits_ai" | "template_only"`
  - `"all_commits_ai"`: 全 commit の message を AI が要約して PR body の主要部分にする (**Meltly 山下さん指摘の推奨方針**)
  - `"template_only"`: template 埋め込みのみ (AI 要約なし、非推奨)

### intake_filter

S0 intake で pickup する条件。

- **Linear source** (`context: "meltly"`):
  - `linear_labels`: 対象 label の allowlist (例: `["skill/app-frontend", "skill/backend"]`)
  - `linear_statuses`: 対象 status の allowlist (例: `["Todo", "Backlog"]`)
- **GitHub source** (`context: "personal"`):
  - `github_labels`: 対象 label の allowlist (例: `["idd-ready"]`)

**allowlist 明示列挙**: prefix 部分一致 (`skill/*`) ではなく完全列挙にする。将来 label が増えた時に自動 pickup で事故らないため。

## 追加ルール

**area の追加時**:
- config に entry 追加
- fetch 対象 repo に必要な label / branch 命名 convention を確認
- pattern テスト (実際の pickup が想定通りか確認)

**Meltly (Linear-linked area) 特有の考慮**:
- `branch_name_source: "linear_api"` 必須 (Linear チケット自動追従を維持するため)
- 「Copy git branch name」形式に合わせないと、PR merge 時に Linear チケットが auto close されない (山下さん指摘)
- Linear の担当振り分け label (`skill/*`) を intake filter に使う (IDD 内部語彙 `idd:ready` を Linear に持ち込まない原則の適用)

**個人 repo 特有の考慮**:
- Linear 連携が無い前提
- GitHub の `idd-ready` label を intake マーカーとして使用
- Meltly 所有の GitHub repo は明示的に allowlist から除外 (allowlist なので自動的に除外される)
