# Project Task Management Rules

## 0. System Metadata

- **Current Max ID**: `Next ID No: 12` (タスク追加時にインクリメント必須)
- **ID Source of Truth**: このファイルの `Next ID No` 行が、全プロジェクトにおける唯一の ID 発番元である。

## 1. Task Lifecycle (State Machine)

タスクは以下の順序で単方向に遷移する。逆行は原則禁止とする。

### Phase 0: Inbox (Human Write-only)

- **Location**: `## Inbox` セクション
- **Description**: 人間がアイデアや依頼を書き殴る場所。フォーマット不問。ID 未付与。
- **Exit Condition**: LLM が内容を解析し、ID を付与して `Backlog` へ構造化移動する。

### Phase 1: Backlog (Structured)

- **Location**: `## Backlog` セクション
- **Status**: タスクとして認識済みだが、着手準備未完了。
- **Entry Criteria**:
  - ID が一意に採番されている。
  - 必須フィールドがすべて埋まっている。
- **Exit Condition**: `Ready` の要件を満たす。

### Phase 2: Ready (Actionable)

- **Location**: `## Ready` セクション
- **Status**: いつでも着手可能な状態。
- **Entry Criteria**:
  - `Size >= M` の場合、Plan が作成済みである。
  - `Risk >= Medium` の場合、QA 文書が `qa_status: planned` で作成済みである。
  - Dependencies が解決済み、または未解決理由が明確である。
  - Steps が具体的、または Plan / QA への進行管理ポインタとして機能している。
- **Exit Condition**: 作業者がタスクに着手する。

### Phase 3: In Progress

- **Location**: `## In Progress` セクション
- **Status**: 現在実行中。

### Phase 4: Completed

- **Location**: なし。完了タスクは `TODO.md` から削除する。
- **Exit Action**: Acceptance Criteria の達成と、QA round の verdict を確認後に削除する。
- **History**: 完了履歴の正典は QA round (`qa.md` / `maintenance.md`) である。`TODO.md` に Done / Archived セクションは作らない。

## 2. Schema & Validation

各タスクは以下のフィールドを必須とする。

| Field | Type | Constraint / Value Set |
| --- | --- | --- |
| **Title** | `String` | `[Category] Title` 形式。Category は後述の Enum 参照。 |
| **ID** | `String` | `<Area>-<Category>-<Number>` 形式。不変の一意キー。 |
| **Priority** | `Enum` | `P0` / `P1` / `P2` / `P3` |
| **Size** | `Enum` | `XS` / `S` / `M` / `L` / `XL` |
| **Risk** | `Enum` | `Low` / `Medium` / `High` / `Critical` |
| **Area** | `String` | タスクの論理領域。各 canonical path の `<Area>` と一致させる。 |
| **Dependencies** | `List<ID>` | 依存タスク ID の配列。なしは `[]`。 |
| **Goal** | `String` | 完了後に成り立つ状態を一文で書く。 |
| **Acceptance Criteria** | `Markdown` | `AC-001` 形式で、検証可能な条件を書く。 |
| **Steps** | `Markdown` | 進行管理用チェックリスト。 |
| **Description** | `Markdown` | Context / Notes を含める。 |
| **Plan** | `Path` | `None` または `_docs/plan/<Area>/<slug>/plan.md`。`Size >= M` で必須。 |
| **Intent** | `Path` | `None` または `_docs/intent/<Area>/<slug>/decision.md`。DEC を作ったら埋める。 |
| **QA** | `Path` | `_docs/qa/<Area>/<slug>/qa.md` または `_docs/qa/<Area>/maintenance.md`。`None` 不可。 |

推奨形式:

```markdown
### <ID>: [<Category>] <Title>

- **Title**: [<Category>] <Title>
- **ID**: <Area>-<Category>-<Number>
- **Priority**: P0 | P1 | P2 | P3
- **Size**: XS | S | M | L | XL
- **Risk**: Low | Medium | High | Critical
- **Area**: <Area>
- **Dependencies**: []
- **Goal**: <one sentence>
- **Acceptance Criteria**:
  - AC-001:
  - AC-002:
- **Steps**:
  1. [ ] Step 1
  2. [ ] Step 2
- **Description**:
  - Context:
  - Notes:
- **Plan**: None | _docs/plan/<Area>/<slug>/plan.md
- **Intent**: None | _docs/intent/<Area>/<slug>/decision.md
- **QA**: _docs/qa/<Area>/<slug>/qa.md | _docs/qa/<Area>/maintenance.md
```

## 3. Required Depth

すべてのタスクは完了時に Intent Delta の宣言と QA round を持つ (常時 ON ループ)。省略できるのは
深さであって、存在ではない。詳細は `_docs/standards/workflow.md` を参照。

| Condition | Requirement |
| --- | --- |
| すべてのタスク | 完了時に QA round (Intent Delta / verdict を含む)。微小変更は `maintenance.md` へ追記。 |
| `Size >= M` | Plan が必須。QA は専用の `qa.md` を作る。 |
| `Risk >= Medium` | `qa.md` を実装前に `qa_status: planned` で作る。 |
| `Risk High / Critical` | rollback / recovery / security / data safety の確認と、完了前の verdict が必須。 |
| DEC 新設 / `Size >= M` / `Risk High` | R2 再構成テストが発動する。`R2: PENDING` を round に書き、R2 タスクを積む。 |
| `Category Bug` | Acceptance Criteria に再発防止条件を含め、regression test または no-test rationale を残す。 |
| `Category Refactor` | behavior-preservation checks を残す。 |
| Agent workflow / validator / CI / Skill / documentation rule 変更 | 自動的に `Risk High` (パスベース下限)。agent misbehavior checks を含める。 |

## 4. Completion Rules

タスクを `TODO.md` から削除できるのは、以下を満たす場合のみ。

1. Steps が完了している。
2. Acceptance Criteria が満たされている。
3. QA round が記録され、Intent Delta が宣言されている (DEC 新設 / applied / 理由付き None)。
4. verdict が `PASS` である。`PARTIAL` の場合は、残リスクと follow-up TODO が明記されている。
5. `FAIL` / `BLOCKED` の場合は完了扱いにしない。
6. R2 発動タスクは、`R2: PENDING` の記録と R2 タスクの追加が済んでいる。
7. Plan があれば `_docs/archives/plan/` へ移送し、参照を更新している。

## 5. Canonical Document Paths

```text
_docs/plan/<Area>/<slug>/plan.md
_docs/intent/<Area>/<slug>/decision.md
_docs/qa/<Area>/<slug>/qa.md
_docs/qa/<Area>/maintenance.md
_docs/guide/<Area>/<slug>/usage.md
_docs/reference/<Area>/<slug>/reference.md
_docs/archives/plan/<Area>/<slug>/plan.md
```

`<Area>` はタスクの `Area` と一致させる。`<slug>` は機能・変更単位の kebab-case 名にする。`intent` / `qa` / `guide` / `reference` は archive 対象にしない。

## 6. Defined Enums

### Categories (Title & ID)

- `Feat` (New Feature)
- `Enhance` (Improvement)
- `Bug` (Fix)
- `Refactor` (Code Structuring)
- `Perf` (Performance)
- `Doc` (Documentation)
- `Test` (Testing)
- `Chore` (Maintenance/Misc)
- `R2` (Reconstruction Test)

### Priorities

- `P0`: Critical / immediate
- `P1`: High
- `P2`: Medium
- `P3`: Low

### Sizes

- `XS`: 0.5 day 未満
- `S`: 1 day 程度
- `M`: 2-3 days 程度
- `L`: 1 week 程度
- `XL`: 2 weeks 以上

### Risk

Risk の詳細とパスベースの自動下限は `_docs/standards/workflow.md` を参照する。

- `Low`: 局所的で失敗影響が小さい変更。
- `Medium`: 機能挙動、ワークフロー、validator、ドキュメント規約、agent skill に影響する変更。
- `High`: 互換性、データ損失、認証、権限、セキュリティ、課金、外部 API、CI/CD、migration に関わる変更。
- `Critical`: 本番障害、secret 漏洩、重大なデータ破壊、ユーザー影響の大きい破壊的変更につながり得る変更。

## 7. Operational Workflows (for LLM)

### Create Task from Inbox

1. `Next ID No` を読み取り、割り当て予定の ID を決定する。
2. `Next ID No` をインクリメントしてファイルを更新する。
3. Inbox の内容を解析し、最適な `Area` / `Category` / `Risk` を決定する。
4. ID を生成し、Acceptance Criteria を `AC-001` 形式で書く。
5. 深さ条件に従い、Plan / Intent / QA を埋める (QA は `None` 不可)。
6. タスクを `Backlog` の末尾に追加し、元の Inbox 行を削除する。

### Promote to Ready

1. `Size >= M` なら Plan が存在することを確認する。
2. `Risk >= Medium` なら `qa.md` が `qa_status: planned` で存在し、Checks が主要 AC を確認手段へ
   割り当てていることを確認する。
3. Dependencies が解決済みか確認する。
4. 全てクリアした場合のみ `Ready` セクションへ移動する。

### Complete Task

1. Steps と Acceptance Criteria を確認する。
2. QA round を記録する (Intent Delta / verdict 必須)。R1 review を行い、発動条件を満たすなら
   `R2: PENDING` と R2 タスクを積む。
3. verdict が `PASS`、または許容済み `PARTIAL` であることを確認する。
4. `FAIL` / `BLOCKED` の場合は、タスクを残すか follow-up を追加する。
5. 完了可能な場合のみ `TODO.md` から削除する。

### R2 Task

R2 タスクを拾った agent は、対象 diff とリポジトリ内の docs だけを読んで
`_docs/standards/workflow.md` の固定設問 4 つに答え、結果と gap を該当 QA 文書の
round に追記する。gap があれば DEC 修繕タスクを積む。

## 8. Task Definition Examples

### Case A: 微小タスク (XS + Low)

```markdown
### Docs-Chore-10: [Chore] Update project display name

- **Title**: [Chore] Update project display name
- **ID**: Docs-Chore-10
- **Priority**: P2
- **Size**: XS
- **Risk**: Low
- **Area**: Docs
- **Dependencies**: []
- **Goal**: README と Quickstart の表示名がプロジェクト名に置き換わっている。
- **Acceptance Criteria**:
  - AC-001: README の旧テンプレート名が新しいプロジェクト名に置き換わっている。
- **Steps**:
  1. [ ] README.md と QUICKSTART.md を更新する
- **Description**:
  - Context: 新規プロジェクト作成直後の軽量カスタマイズ。
  - Notes: 完了時に maintenance.md へ round を 1 つ追記する (Intent Delta: None 想定)。
- **Plan**: None
- **Intent**: None
- **QA**: _docs/qa/Docs/maintenance.md
```

### Case B: Size M + Medium Risk Task

```markdown
### Core-Enhance-11: [Enhance] Add onboarding command

- **Title**: [Enhance] Add onboarding command
- **ID**: Core-Enhance-11
- **Priority**: P1
- **Size**: M
- **Risk**: Medium
- **Area**: Core
- **Dependencies**: []
- **Goal**: 新規メンバーが onboarding command で初期診断を実行できる。
- **Acceptance Criteria**:
  - AC-001: command が環境診断を実行し、結果を標準出力に表示する。
  - AC-002: 採用した設計判断が DEC として記録され、該当箇所にポインタコメントが置かれている。
- **Steps**:
  1. [ ] Plan の Scope / Non-Goals を確認する
  2. [ ] qa.md の Checks に従って実装と検証を進める
- **Description**:
  - Context: ユーザー向け workflow が増えるため Medium risk とする。
  - Notes: Size M のため R2 が発動する。
- **Plan**: _docs/plan/Core/onboarding-command/plan.md
- **Intent**: _docs/intent/Core/onboarding-command/decision.md
- **QA**: _docs/qa/Core/onboarding-command/qa.md
```

### Case C: Agent Workflow / Validator / Skill Task

```markdown
### Workflow-Chore-12: [Chore] Tighten TODO validator

- **Title**: [Chore] Tighten TODO validator
- **ID**: Workflow-Chore-12
- **Priority**: P1
- **Size**: M
- **Risk**: High
- **Area**: Workflow
- **Dependencies**: []
- **Goal**: TODO validator が新 schema と QA 必須条件を検出できる。
- **Acceptance Criteria**:
  - AC-001: validator が Risk / QA 欠落を error として検出する。
  - AC-002: agent misbehavior checks が QA round に残っている。
- **Steps**:
  1. [ ] Plan / Intent / QA を読む
  2. [ ] validator を更新する
- **Description**:
  - Context: scripts/ に触れるためパスベース下限により Risk High。R2 が発動する。
  - Notes: `validate-todo` と `validate-qa` の両方を実行する。
- **Plan**: _docs/plan/Workflow/todo-validator/plan.md
- **Intent**: _docs/intent/Workflow/todo-validator/decision.md
- **QA**: _docs/qa/Workflow/todo-validator/qa.md
```

---

## Inbox

-

---

## Backlog

### Docs-Chore-1: [Chore] Review and customize AGENTS.md

- **Title**: [Chore] Review and customize AGENTS.md
- **ID**: Docs-Chore-1
- **Priority**: P2
- **Size**: XS
- **Risk**: Low
- **Area**: Docs
- **Dependencies**: []
- **Goal**: `AGENTS.md` がプロジェクトのニーズに応じて必要に応じて編集されている。
- **Acceptance Criteria**:
  - AC-001: `AGENTS.md` の禁止事項、実行環境、推奨コマンドがプロジェクト実態に合っている。
  - AC-002: 外部入力、secret、破壊的操作の扱いがプロジェクトの安全基準と矛盾していない。
- **Steps**:
  1. [ ] `AGENTS.md` を開き、既存の内容を確認する
  2. [ ] 必要に応じてプロジェクト固有のコマンドや禁止事項を追記する
  3. [ ] 変更後にリンクと安全基準の整合性を確認する
- **Description**:
  - Context: 新規プロジェクト作成直後に agent 向け入口を調整する。
  - Notes: 完了時に maintenance.md へ round を追記する。
- **Plan**: None
- **Intent**: None
- **QA**: _docs/qa/Docs/maintenance.md

### Docs-Chore-2: [Chore] Customize README.md for project

- **Title**: [Chore] Customize README.md for project
- **ID**: Docs-Chore-2
- **Priority**: P0
- **Size**: S
- **Risk**: Low
- **Area**: Docs
- **Dependencies**: []
- **Goal**: `README.md` がプロジェクトの概要、目的、使用方法に合わせて編集されている。
- **Acceptance Criteria**:
  - AC-001: README の概要、使用方法、カスタマイズ案内がプロジェクト固有の内容になっている。
  - AC-002: テンプレート由来の不要な説明が残っていない。
- **Steps**:
  1. [ ] 現在の `README.md` を確認する
  2. [ ] プロジェクト名、概要、説明をプロジェクトに合わせて書き換える
  3. [ ] 使用方法セクションを編集する
  4. [ ] 不要なテンプレート固有の記述を削除または修正する
- **Description**:
  - Context: テンプレートから実プロジェクトへ移行するための初期作業。
  - Notes: 完了時に maintenance.md へ round を追記する。
- **Plan**: None
- **Intent**: None
- **QA**: _docs/qa/Docs/maintenance.md

### Docs-Chore-3: [Chore] Update LICENSE.txt author attribution

- **Title**: [Chore] Update LICENSE.txt author attribution
- **ID**: Docs-Chore-3
- **Priority**: P2
- **Size**: XS
- **Risk**: Low
- **Area**: Docs
- **Dependencies**: []
- **Goal**: `LICENSE.txt` の著作者名が正しいものに編集されている。
- **Acceptance Criteria**:
  - AC-001: `LICENSE.txt` の著作者表示がプロジェクトの権利者に更新されている。
  - AC-002: README のライセンスリンクが `LICENSE.txt` を参照している。
- **Steps**:
  1. [ ] `LICENSE.txt` を開き、著作者名を確認する
  2. [ ] 正しい著作者名に編集する
  3. [ ] README のライセンスリンクを確認する
- **Description**:
  - Context: OSS 配布前に著作者表示をプロジェクトに合わせる。
  - Notes: 完了時に maintenance.md へ round を追記する。
- **Plan**: None
- **Intent**: None
- **QA**: _docs/qa/Docs/maintenance.md

### Workflow-Chore-7: [Chore] Set incremental adoption scope

- **Title**: [Chore] Set incremental adoption scope
- **ID**: Workflow-Chore-7
- **Priority**: P2
- **Size**: XS
- **Risk**: Low
- **Area**: Workflow
- **Dependencies**: []
- **Goal**: 既存プロジェクトへ後付け導入する場合に、導入以降に追加した docs だけが検証対象になるよう導入スコープが設定されている。
- **Acceptance Criteria**:
  - AC-001: 既存プロジェクトへ導入する場合、CI に `DD_SCOPE_BASE: <導入時点の commit SHA または tag>` が設定されている。
  - AC-002: `actions/checkout` が `fetch-depth: 0` に設定され、baseline commit を参照できる。
- **Steps**:
  1. [ ] 導入時点の commit SHA / tag を baseline として決める
  2. [ ] CI 環境変数に `DD_SCOPE_BASE` を設定する
  3. [ ] `actions/checkout` を `fetch-depth: 0` にする
- **Description**:
  - Context: 新規プロジェクトでは不要。既存プロジェクトへ後付け導入する場合のみ着手する条件付きタスク。導入しない場合はこのタスクを削除してよい。
  - Notes: 手順は QUICKSTART「既存プロジェクトへ後付け導入する場合」と `_docs/standards/template_operations.md` の段階的導入スコープを参照。完了時に maintenance.md へ round を追記する。
- **Plan**: None
- **Intent**: None
- **QA**: _docs/qa/Workflow/maintenance.md

### Workflow-Chore-11: [Chore] Record template revision provenance

- **Title**: [Chore] Record template revision provenance
- **ID**: Workflow-Chore-11
- **Priority**: P1
- **Size**: XS
- **Risk**: Low
- **Area**: Workflow
- **Dependencies**: []
- **Goal**: 採用した template release の tag と full SHA が、後続 migration で再利用できる形で記録されている。
- **Acceptance Criteria**:
  - AC-001: `docs-template.lock.example.json` から `docs-template.lock.json` が作成され、採用した release tag とその tag が解決する full 40-character commit SHA を記録している。
  - AC-002: lock の `source` が実際の upstream template repository を指し、moving branch tip を revision として使用していない。
- **Steps**:
  1. [ ] 採用した template release tag を確認する
  2. [ ] tag が解決する full commit SHA を確認する
  3. [ ] 雛形を `docs-template.lock.json` へコピーして source / tag / commit を記録する
  4. [ ] tag と full SHA の対応を再確認する
- **Description**:
  - Context: downstream project が template の推奨更新を three-way migration で継続的に取り込むための provenance lock。
  - Notes: `DD_SCOPE_BASE` は project 内の validator scope であり、この lock の代替ではない。完了時に maintenance.md へ round を追記する。
- **Plan**: None
- **Intent**: None
- **QA**: _docs/qa/Workflow/maintenance.md

---

## Ready

---

## In Progress
