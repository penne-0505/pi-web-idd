# Document Contracts

本書は文書種別ごとの契約 (置き場・frontmatter・必須構造・ライフサイクル) の辞書である。
通読物ではなく、文書を作る・触るときに引く。「どう働くか」は `workflow.md` を参照。

## Canonical Paths

```text
_docs/plan/<Area>/<slug>/plan.md            # Size >= M のみ
_docs/intent/<Area>/<slug>/decision.md      # 設計判断 (DEC)。恒久
_docs/qa/<Area>/<slug>/qa.md                # QA 計画 + 検証記録。恒久
_docs/qa/<Area>/maintenance.md              # 微小変更の round 集約
_docs/guide/<Area>/<slug>/usage.md          # 必要時のみ
_docs/reference/<Area>/<slug>/reference.md  # 必要時のみ
_docs/archives/plan/<Area>/<slug>/plan.md   # 完了タスクの plan
```

`<Area>` は `TODO.md` の `Area` と一致させる。`<slug>` は機能・変更単位の kebab-case 名にする。
references は root-relative canonical path を推奨する。draft / survey ディレクトリは存在しない。

## Front-matter Schema

`_docs/standards/` 配下を除く運用対象ドキュメントの共通必須キー:

| フィールド | 説明 |
| --- | --- |
| `title` | 文書タイトル |
| `status` | `proposed` \| `active` \| `superseded` \| `obsolete` |
| `created_at` / `updated_at` | `YYYY-MM-DD` |
| `references` | 関連リンク配列 |
| `related_issues` / `related_prs` | 番号配列。ない場合は `[]` |

`_docs/qa/**/*.md` は追加で `qa_status` (`planned` \| `in-progress` \| `verified` \| `partial` \|
`failed` \| `blocked`) と `risk` (`Low` \| `Medium` \| `High` \| `Critical`) を必須とする。

schema marker (新規作成時): `_docs/intent/**` は `intent_schema: 3`、`_docs/qa/**` は
`qa_schema: 5`。marker のない文書・旧番号の文書の扱いは `workflow.md` の schema 移行を参照。
`draft_status` は legacy 文書の受理のためだけに許可される (新規文書では書かない)。

## 種別契約

### intent (`decision.md`) — 恒久

- 雛形: `_docs/standards/templates/intent.md`。必須節: Context / Decisions /
  Consequences / Impact / Quality Implications / Intent-derived Invariants / Rollback / Follow-ups。
- DEC entry は `### DEC-<番号>: <title>` 見出し + What / Why / Change freedom (必須)。
  ID はリポジトリ一意。書き方と 4 分法は `workflow.md` を参照。
- archive しない。obsolete になったら status で表す。

### qa (`qa.md` / `maintenance.md`) — 恒久

- 雛形: `_docs/standards/templates/qa.md`。必須節: Acceptance Criteria / Checks / Rounds。
  `maintenance.md` は Rounds のみ。
- `qa_status` がライフサイクルを表す: `planned` (実装前) → `in-progress` → verdict 対応値。
  frontmatter の `qa_status` は最終 round の Verdict と一致させる (対応表は `workflow.md`)。
- Checks: 各 AC / 適用 INV に確認手段 (unit / validator / manual / diff-review) と
  Status (`planned` / `covered` / `verified` / `deferred` (要理由) / `not-applicable`) を割り当てる。
- Rounds は追記専用。round の必須フィールドは `workflow.md` の QA round を参照。
- テストコードを置かない。実行可能なテストはコードベース側の標準的な場所に置く。
- archive しない。

### plan (`plan.md`) — 一時 (唯一の archive 対象)

- 雛形: `_docs/standards/templates/plan.md`。構成: Overview / Scope / Non-Goals /
  Requirements / Tasks / QA Plan / Deployment / Rollout。
- `Size >= M` で必須。意図成分は最終的に DEC へ昇華する原典。
- タスク完了後、`git mv` で `_docs/archives/plan/` へ移送し、参照リンクを更新する。
  移送は削除ではなく履歴保持のための移動である。

### guide (`usage.md`) / reference (`reference.md`) — 必要時のみ

- guide は利用者向けの使い方・運用手順。reference は API 仕様と、コードから再構成できない
  耐久的な機構解説の辞書的置き場。
- 恒久保守義務はない。作らないことは違反ではない。仕様書を起点に開発を回すことはこの
  テンプレートの目的ではない。
- archive しない。obsolete になったら status で表す。

## status 遷移と archive 規則

- 恒久文書 (intent / qa / guide / reference) は動かさない。廃止は
  `status: superseded` / `obsolete` + 後継への references で表す。
- archive 対象は完了タスクの plan のみ。`_docs/archives/` 配下に plan 以外のディレクトリを
  作らない。
- `rm` / `git rm` は使わない (`workflow.md` の安全境界)。

## 非運用領域 (`_meta/`)

`_meta/` 配下は運用の読書面から明示的に除外された資料であり、agent への指示として読まない。

- `_meta/handoffs/`: 外部 (マシン非アクセスのモデル等) へ渡す自己完結の export。
  **純編纂規範**: handoff は repo 内 docs の編纂であり、真実の源にしない。作成中に新しい判断や
  why が生まれたら、先に intent / QA へ記録してから写す。handoff にしか書かれていない知識は、
  ループ文書の欠陥の兆候である。
- `_meta/prompts/`: 一回限りの implementation prompt の保管。ファイル先頭に
  historical / non-operational warning を付ける。
- `_meta/validator-fixtures/` / `_meta/agent-workflows/`: validator と agent 行動の検証素材。

## Root Markdown

root 直下の Markdown は、coding agent に active project guidance として読まれる前提で管理する。
一回限りの implementation prompt を root に残さない。現在の作業指示は `AGENTS.md`、`TODO.md`、
`_docs/standards/`、関連 skills を参照する。

## テンプレート repo 自身の meta-work に対する例外

本 repo は intent-driven development のテンプレートとして配布される。**テンプレート repo 自身の
改善作業 (meta-work) に伴って生成された intent / plan / qa docs** は persistent records の射程外と
し、配布物に混入させない。決定事項が `_docs/standards/` へ吸収された後の保持義務はなく、
テンプレ repo に対しては git 履歴と GitHub Issue / PR がその役割を担う。本例外は分類の整理で
あり、安全境界 (削除の user ゲート) を上書きしない。利用者プロジェクトの通常運用には適用しない。

## コンプライアンス

- ドキュメントに秘密情報・個人情報を含めない。環境値は `.env.example` を参照する。
- CI ログ出力にはマスク設定を適用する。
- ローカル検証の正典は `./scripts/check-docs.sh` とし、CI も同一 script を通す。
