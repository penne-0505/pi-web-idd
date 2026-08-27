# 拡張 IDD — Intent-Driven Development pipeline

> この README は日本語と英語の 2 部構成です。English speakers, please scroll down.

## このリポジトリは何か

このリポジトリは、[pi coding agent](https://github.com/earendil-works/pi) のブラウザ UI である [pi-web](https://github.com/agegr/pi-web) v0.8.9 の固定派生に、**拡張 IDD (intent-driven development) の pipeline と判断 UI** を組み込んだものです。

拡張 IDD は「朝起きたら、判断待ちの作業レーンが N 件並んでいる」を実現する、AI 主導の開発 pipeline です。起票 (GitHub issue) を lane に取り込み、planner が下調べして契約 (DEC / INV / QA / reference) を生成し、**人間は GO / DEFER の判断だけ**を行い、executor が独立した git worktree で並列実装します。

- **S0 取り込み**: GitHub issue (label `idd-ready`) を backlog に追加
- **S1 下調べ**: planner が lane ごとに DEC / INV / QA / reference を生成
- **GO 判断**: 人間が Web UI で GO / DEFER を判定
- **S2 実装**: executor が独立 worktree で実装
- **S3 衝突確認**: 並列 lane 同士 / upstream との衝突を機械判定
- **S4 提出**: commit rewrite → 確認 → push / PR 化

構成:

| 場所 | 内容 |
| --- | --- |
| `packages/idd-core` | engine。state の読み書き、intake / plan / check / ship の各段階 |
| `packages/idd-cli` | CLI (`idd intake` / `idd tick`) |
| `components/idd` / `lib/idd-ui` | 判断 UI (Inbox / lane detail / card) |
| `app/api/idd/` | 判断 UI と engine を繋ぐ API |
| その他 | pi-web v0.8.9 の派生 shell (session 閲覧、モデル設定など) |

## 動かし方

### 開発サーバー

```bash
npm install
npm run dev
```

開発サーバーは [http://127.0.0.1:30141](http://127.0.0.1:30141) で起動します。ブラウザで開くと、判断待ちの lane が Inbox に並びます。

### 環境変数

| 変数 | 意味 | 既定値 |
| --- | --- | --- |
| `IDD_STATE_DIR` | state ファイル (backlog.jsonl / lifecycle / cron-run など) の置き場 | `<cwd>/state` |
| `IDD_INTENT_DIR` | intent (DEC) の root | `<cwd>/_docs/intent` |
| `IDD_AGENT_BASE_URL` | agent の書き戻し先 (envelope の配信先) | `http://127.0.0.1:$PORT` |
| `IDD_AGENT_TOKEN` | agent 用書き込み口の token | `<state>/agent-token` に自動生成 |

### CLI

```bash
bun run packages/idd-cli/bin/idd.ts intake   # S0 取り込み (server 不要、engine 直接)
bun run packages/idd-cli/bin/idd.ts tick     # S0 → S3 を一巡 (server 必須、POST /api/idd/tick)
```

## 全体の流れ (S0-S4)

### S0: 取り込み (Intake)

GitHub issue (area config の `intake_filter.github_labels`、既定 `idd-ready`) を拾い、`backlog.jsonl` に追加します。重複判定は URL 完全一致 (機械) のみ稼働しています。取り込みの結果は 1 実行 1 file の `cron-run-<timestamp>.json` に記録されます。

### S1: 下調べ (Planner Prep)

各 lane について planner が下調べし、`_docs/intent/<Area>/<slug>/` に `decision.md` (DEC) / `invariant.md` (INV) / `qa.md` (QA) / `reference.md` を生成します。各 lane に独立 planner pi session と git worktree を切り、並列度は `IDD_PLANNER_CONCURRENCY` (既定 5) で制限します。完了状態は `s1_ready` (人間 GO 待ち) と `pending_question` (質問 batch を発して回答待ち) の 2 種です。

### GO 判断

人間が Web UI で GO を押すと `s1_go` event が ledger に直接書き込まれます (AI 非経由)。GO を受けた lane だけが S2 に進みます。

### S2: 実装 (Executor)

executor pi session が独立 worktree で実装します。並列度は `IDD_EXECUTOR_CONCURRENCY` (既定 3) で制限します。完了すると `s2_result` (outcome: success / partial) が記録されます。

### S3: 衝突確認 (Integration Check)

`git merge-tree` で upstream と衝突するかだけを機械判定します (DEC-688)。clean なら人間が diff と QA を review して `s3_ok` / `s3_reject` / `s3_defer` を判定します。**衝突の解消は未実装**で、検出までです。

### S4: 提出 (Ship)

提出物 (commit rewrite / branch rename / PR body / checks) を lane の実物から機械的に組み立てます (DEC-690)。push と PR 作成は人間が押したときだけ行います (DEC-692)。merge は観測して記録するだけです (DEC-697)。

### 未実装のもの

| 項目 | 現状 |
| --- | --- |
| 意味類似の重複判定 | `DuplicateDetector` の口のみ。URL 完全一致のみ稼働 |
| cron 登録 | scheduler 不在。cron-run 記録は書く |
| verifier agent | 人間が兼ねる暫定 (DEC-693) |
| 衝突の解消 | 検出のみ |
| Linear 取り込み | config schema のみ。intake は GitHub のみ読む |

## 設計の正本と判断の記録

- **設計の正本**: [`_meta/extended-idd-design/`](_meta/extended-idd-design/README.md) — S0-S4 の全体フロー設計の引き継ぎ資料 (SSOT)
- **判断の記録**: [`_docs/intent/`](_docs/intent/) — 実装中の設計判断 (DEC) の記録

## 開発規約

このリポジトリ自身は intent-driven development の規約で開発されています。すべての変更は最小ループを回ります:

```text
TODO (AC) → 実装 → Intent Delta の宣言 → QA round の記録
```

- 設計判断はリポジトリ一意の ID を持つ `DEC` として `_docs/intent/` に記録され、コードからは `// intent: DEC-xxx — <理由>` のポインタコメントで到達します
- QA は計画と検証記録が一体の `qa.md` 一種類です
- 品質は機械 (validator が構造を強制) と agent review が担います
- ローカル検証は `./scripts/check-docs.sh` でまとめて実行します (CI も同一 script)

詳細は [_docs/standards/workflow.md](_docs/standards/workflow.md) (どう働くか) と [_docs/standards/document_contracts.md](_docs/standards/document_contracts.md) (文書種別ごとの契約) を参照してください。初めての場合は [QUICKSTART.md](QUICKSTART.md) から。

## ライセンス

このリポジトリは [MIT ライセンス](LICENSE.txt) の下でライセンスされています。

### 派生元

このリポジトリは [pi-web](https://github.com/agegr/pi-web) v0.8.9 の固定派生です (MIT)。上流の README と機能の説明は [pi-web のリポジトリ](https://github.com/agegr/pi-web) を参照してください。

---

# Extended IDD — Intent-Driven Development pipeline

> This README is available in English and Japanese. 日本語版は上を参照してください。

## What this repository is

This repository is a fixed fork of [pi-web](https://github.com/agegr/pi-web) v0.8.9, the browser UI for the [pi coding agent](https://github.com/earendil-works/pi), with the **extended IDD (intent-driven development) pipeline and decision UI** built in.

Extended IDD is an AI-driven development pipeline that realizes "wake up in the morning to N work lanes waiting for your judgment." Tickets (GitHub issues) are ingested into lanes, a planner researches each lane and produces a contract (DEC / INV / QA / reference), **humans only make GO / DEFER decisions**, and executors implement in parallel in separate git worktrees.

- **S0 Intake**: GitHub issues (label `idd-ready`) are added to the backlog
- **S1 Planner Prep**: a planner produces DEC / INV / QA / reference per lane
- **GO decision**: a human decides GO / DEFER in the web UI
- **S2 Implementation**: an executor implements in a separate worktree
- **S3 Integration Check**: conflicts against parallel lanes / upstream are detected mechanically
- **S4 Ship**: commit rewrite → review → push / PR

Layout:

| Location | Contents |
| --- | --- |
| `packages/idd-core` | Engine. State read/write and the intake / plan / check / ship stages |
| `packages/idd-cli` | CLI (`idd intake` / `idd tick`) |
| `components/idd` / `lib/idd-ui` | Decision UI (Inbox / lane detail / cards) |
| `app/api/idd/` | API connecting the decision UI to the engine |
| Everything else | The pi-web v0.8.9 shell (session browsing, model configuration, etc.) |

## Getting Started

### Development server

```bash
npm install
npm run dev
```

The development server runs at [http://127.0.0.1:30141](http://127.0.0.1:30141). Open it in a browser to see the lanes awaiting judgment in the Inbox.

### Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `IDD_STATE_DIR` | Where state files live (backlog.jsonl / lifecycle / cron-run, etc.) | `<cwd>/state` |
| `IDD_INTENT_DIR` | Root of the intent (DEC) records | `<cwd>/_docs/intent` |
| `IDD_AGENT_BASE_URL` | Where agents write back (envelope delivery target) | `http://127.0.0.1:$PORT` |
| `IDD_AGENT_TOKEN` | Token for agent write endpoints | Auto-generated at `<state>/agent-token` |

### CLI

```bash
bun run packages/idd-cli/bin/idd.ts intake   # S0 intake (no server needed, engine direct)
bun run packages/idd-cli/bin/idd.ts tick     # One pass through S0 → S3 (server required, POST /api/idd/tick)
```

## The pipeline (S0-S4)

### S0: Intake

GitHub issues (area config `intake_filter.github_labels`, default `idd-ready`) are picked up and appended to `backlog.jsonl`. Only exact-URL duplicate detection (mechanical) is active. Each run's result is recorded in a per-run `cron-run-<timestamp>.json` file.

### S1: Planner Prep

A planner researches each lane and produces `decision.md` (DEC) / `invariant.md` (INV) / `qa.md` (QA) / `reference.md` under `_docs/intent/<Area>/<slug>/`. Each lane gets its own planner pi session and git worktree; concurrency is capped by `IDD_PLANNER_CONCURRENCY` (default 5). A lane finishes in one of two states: `s1_ready` (waiting for a human GO) or `pending_question` (a question batch was sent, waiting for answers).

### GO decision

When a human presses GO in the web UI, an `s1_go` event is written directly to the ledger (not through AI). Only lanes with GO proceed to S2.

### S2: Implementation

An executor pi session implements in a separate worktree. Concurrency is capped by `IDD_EXECUTOR_CONCURRENCY` (default 3). Completion is recorded as `s2_result` (outcome: success / partial).

### S3: Integration Check

`git merge-tree` mechanically answers only whether the lane conflicts with upstream (DEC-688). If clean, a human reviews the diff and QA and decides `s3_ok` / `s3_reject` / `s3_defer`. **Conflict resolution is not implemented** — detection only.

### S4: Ship

The submission (commit rewrite / branch rename / PR body / checks) is assembled mechanically from the lane itself (DEC-690). Push and PR creation happen only when a human presses the button (DEC-692). Merges are observed and recorded, never performed (DEC-697).

### Not implemented

| Item | Current state |
| --- | --- |
| Semantic duplicate detection | Only the `DuplicateDetector` port exists; exact-URL matching is active |
| Cron registration | No scheduler; cron-run records are written |
| Verifier agent | A human stands in provisionally (DEC-693) |
| Conflict resolution | Detection only |
| Linear intake | Config schema only; intake reads GitHub only |

## Design source of truth and decision records

- **Design source of truth**: [`_meta/extended-idd-design/`](_meta/extended-idd-design/README.md) — the handoff document for the S0-S4 pipeline design (SSOT)
- **Decision records**: [`_docs/intent/`](_docs/intent/) — design decisions (DEC) made during implementation

## Development conventions

This repository itself is developed under the intent-driven development conventions. Every change runs the minimal loop:

```text
TODO (AC) → implement → declare the Intent Delta → record a QA round
```

- Design decisions are recorded as `DEC` entries with repository-unique IDs under `_docs/intent/`, reachable from code through pointer comments (`// intent: DEC-xxx — <reason>`)
- QA planning and verification live in a single `qa.md` per feature
- Quality is held by machines (validators enforce structure) and agent review
- Run the local documentation validators together with `./scripts/check-docs.sh`; CI runs the same script

See [_docs/standards/workflow.md](_docs/standards/workflow.md) (how it works) and [_docs/standards/document_contracts.md](_docs/standards/document_contracts.md) (per-document contracts). If this is your first time, start with [QUICKSTART.md](QUICKSTART.md).

## License

This repository is licensed under the [MIT License](LICENSE.txt).

### Upstream

This repository is a fixed fork of [pi-web](https://github.com/agegr/pi-web) v0.8.9 (MIT). See the [pi-web repository](https://github.com/agegr/pi-web) for the upstream README and feature documentation.
