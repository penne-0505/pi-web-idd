# Document Contracts

本書は文書種別ごとの契約（置き場・frontmatter・必須の構造・寿命）の辞書である。通読物ではなく、文書を作る・触るときに引く。「どう働くか」は `workflow.md`、記録の中身は `records.md` と `work.md` を参照。

## Canonical Paths

```text
_docs/plan/<Area>/<slug>/plan.md            # 依頼。work_instruction: plan の repo だけ
_docs/context/<Area>/<slug>/context.md      # lane の重要なコンテクスト。恒久
_docs/intent/<project>/P-<n>.md             # 状態から描いた写し（Purpose ごとの 1 枚）。手で直さない
_docs/intent/<project>/overview.md          # 写しの概要・組まれ方・Purpose の一覧
_docs/intent/<project>/index.md             # 写しの Place の索引
_docs/qa/<Area>/<slug>/qa.md                # AC と Checks（lane の外の手の変更は Round も）。恒久
_docs/qa/<Area>/maintenance.md              # lane の外の小さな手の変更の Round の集約
_docs/survey/<Area>/<slug>/survey.md        # 参照するための事実。必要時のみ、恒久
_docs/guide/<Area>/<slug>/usage.md          # 必要時のみ
_docs/reference/<Area>/<slug>/reference.md  # 必要時のみ
_docs/archives/plan/<Area>/<slug>/plan.md   # 完了タスクの plan
_docs/archives/intent/<Area>/<slug>/decision.md  # 旧い形の decision.md（移行で移した。同じ相対 path）
```

`<Area>` は `TODO.md` の `Area` と一致させる。lane の記録では repo の鍵（`config/repos.yaml` の `owner/name`）の name の部分（例: `pi-web-idd`）を Area に使い、`<slug>` は lane の id を小文字にしたもの（例: `idd-197`）である。`<slug>` は機能・変更単位の kebab-case 名にする。`<project>` は repo の登録名（`config/repos.yaml` の `name`）で、`<Area>` とは別の語である。references は root からの相対の canonical path を推奨する。draft のディレクトリは存在しない。

Intent Record（Purpose と Choice）の正は Harness の状態にあり、`_docs/intent/` は写しである（`projections.md`）。`_docs/intent/` に手で文書を足さない。

## Front-matter Schema

`_docs/standards/` 配下と `_docs/intent/` の写しを除く運用対象の文書の共通の必須の鍵:

| フィールド | 説明 |
| --- | --- |
| `title` | 文書タイトル |
| `status` | `proposed` \| `active` \| `superseded` \| `obsolete` |
| `created_at` / `updated_at` | `YYYY-MM-DD` |
| `references` | 関連リンク配列 |
| `related_issues` / `related_prs` | 番号配列。ない場合は `[]` |

`_docs/qa/**/*.md` は追加で `qa_status`（`planned` \| `in-progress` \| `verified` \| `partial` \| `failed` \| `blocked`）と `risk`（`Low` \| `Medium` \| `High` \| `Critical`）を必須とする。

schema marker（新規作成時）: `_docs/qa/**` は `qa_schema: 5`。旧い形の `decision.md` は `intent_schema: 4` を持つ（新しくは作らない）。marker のない文書・旧番号の文書の扱いは `migration.md` の「旧い形の記録の扱い」を参照。`draft_status` は legacy 文書の受理のためだけに許可される（新規文書では書かない）。

## 種別契約

### qa（`qa.md` / `maintenance.md`）— 恒久

- 雛形: `_docs/standards/templates/qa.md`。必須の節: Acceptance Criteria / Checks / Rounds。`maintenance.md` は Rounds のみ。
- Acceptance Criteria の節は、AC の番号を持たない全体の行（列挙では満たせない 1 文と、実装役以外の判定者）を床の AC の前に置く。全体の行は AC として読まれず、Checks の表は床の行だけを持つ。全体は実装役の自己申告で満たしたとしない。
- Checks: 各 AC に確認手段（unit / validator / manual / diff-review）と Status（`planned` / `covered` / `verified` / `deferred`（要理由）/ `not-applicable`）を割り当てる。INV の行は書かない（`records.md` の「INV を立てない」）。
- **lane の qa.md**: 計画役が AC と Checks を書く。lane は Round を書かない（検証ログは Harness が持つ。`work.md`）。Rounds の見出しは検査が必須にするので置き、中身は空のままにする。実装役は AC と Checks を書き換えず、status と evidence を報告で送る。`qa_status` は `planned` のまま残る。
- **lane の外の手の変更**: 実施のたびに Round を 1 つ追記する。小さな変更は slug を切らず `_docs/qa/<Area>/maintenance.md` に、`Risk >= Medium` や `Size >= M` の変更は slug の qa.md に書く。Round の欄（見出しの日付が 2026-10-23 以降の Round。検査の切り替えの日は `scripts/validate-qa.ts` の `NEW_ROUND_FORM_FROM`）:
  - **Commands**: 実行したコマンドと結果。実行していないコマンドを書かない。
  - **AC Coverage**: AC の充足と、何を確かめたか。
  - **Risk**: この Round の変更だけの Risk（`Low` / `Medium` / `High` / `Critical` で始める）。frontmatter の `risk:` は qa の全体の重さで、`maintenance.md` のように重さの違う変更が並ぶ qa でも、Round ごとの重さはこの欄で読む。repo が `risk_paths` に宣言したパスに触れた Round は `High` 以上にする（`workflow.md` の「自動下限」）。
  - **Choice**: この変更で口から記録した Choice（`<id> raise` / `reanchor` / `supersede` / `confirm` / `drop`）か、口を使えないときに監督役に渡した案（`案: <案を置いた場所か件数>`。欄の頭に `案:` を置く）。無ければ欄を書かない。
  - **Waive**: Choice を書かない理由。`applied: <id>[、<id>…]（補足）` か `no-choice: <理由>`（`records.md` の「Waive」）。Choice の欄があり、変更がその記録で説明しきれるときは書かなくてよい。
  - **Verdict**: `PASS` / `PARTIAL` / `FAIL` / `BLOCKED`。`PARTIAL` / `FAIL` / `BLOCKED` では残る危険と次の手を書く。
  - Risk High / Critical の手の変更は、変更した役とは別の役の独立したレビューの指摘と処置を AC Coverage に書く（`workflow.md` の「lane の外の手の変更」）。
- Rounds は追記専用である。過去の Round を結果に合わせて書き換えない。Intent Delta と R2 の欄を持つ旧い Round はそのまま残す（`migration.md`）。
- `qa_status` がライフサイクルを表す: `planned`（実装前）→ `in-progress` → Verdict に対応する値。slug の qa.md の frontmatter の `qa_status` は最終 Round の Verdict と一致させる（PASS → `verified`、PARTIAL → `partial`、FAIL → `failed`、BLOCKED → `blocked`）。`maintenance.md` は `in-progress` のままでよい。
- テストコードを置かない。実行可能なテストはコードベース側の標準的な場所に置く。
- archive しない。

### survey（`survey.md`）— 恒久

- 雛形: `_docs/standards/templates/survey.md`。必須の節は `## 問い`・`## 条件`・`## 結果`・`## 確かめていないこと` の 4 つで、この順に並べる。`## 結果` の各項には、その事実の出典（`path:行`・コマンド・URL）を付ける。
- 責務は、参照するための事実だけを持つこと。判断（why）は Choice、使い方は guide に書く。
- 参照は一方向で、Choice など → survey である。survey から `_docs/intent/`・`_docs/qa/`・`_docs/plan/`・`_docs/archives/plan/`・`_docs/guide/`・`_docs/reference/` を指さない。本文に Choice・DEC・INV・AC の ID も書かない。他の survey・コード・`_meta/`・外部の URL を指すことは許す。
- 書いた後に本文を直さない。事実が古くなったら新しい survey を書き、古いほうの status を `superseded` にする。追記もしない。
- frontmatter は共通の鍵だけを使い、survey 専用の鍵を足さない。
- archive しない。廃止は status で表す。

### plan（`plan.md`）— 一時（archive の対象）

- 雛形: `_docs/standards/templates/plan.md`。構成: 依頼 / 意図 / 重要なコンテクスト / 裁量 / 完了の形 / 戻す条件。欄と入場条件の正は `_docs/standards/brief.md`。
- `config/repos.yaml` の `work_instruction: plan` を書いた repo で、計画役が実装役への依頼として書く。書かない repo の lane は記録（Choice の草案と qa.md）だけを書く。
- 6 欄の依頼を持ち、意図は Choice に置く。`how`（順序・手順・関数の分割・テストの構成）は書かない。
- 触る場所は backquote の path で始まる箇条書きか表で書く（本流の進みの読み取りが触る場所として拾う）。frontmatter は雛形から変えない（frontmatter の検査が読むため）。
- 「重要なコンテクスト」欄は、lane のコンテクストの文書（`_docs/context/<Area>/<slug>/context.md`）の所在だけを指す。事実はその文書に書き、欄には写さない。
- ハーネスが提出の前に `git mv` で `_docs/archives/plan/` へ移す。lane の記録（`qa.md`・`reference.md`・`context.md`、旧い形の lane の `decision.md`）は plan を参照しない（恒久の記録が使い捨ての依頼を指さないため）。それでも残った参照は、ハーネスが移動と同じ commit で、移した後の path に書き換える。移せない lane は提出に進めず、理由が lane の履歴に残る。

### context（`context.md`）— 恒久

- 雛形: `_docs/standards/templates/context.md`。lane ごとに 1 本。plan.md の「重要なコンテクスト」欄が指す所在で、欄と入場条件の正は `_docs/standards/brief.md`。
- 計画役が下調べで知った事実を書き、実装役が実装中に知った事実を追記する。追記専用で、前の巡の事実を書き換えない。
- 読むのは最初の実装役・修正の巡の実装役・整理役・計画の査読である。差分のレビュー役（blind）・絵を見る役と判定には渡さない。
- `overlay.manifest` で公開面から外す。
- archive しない。plan.md を archive へ移した後も worktree に残る。文書から `_docs/plan/` の plan.md を参照しない。

### intent の写し（`_docs/intent/<project>/`）— 描き直し

- Harness が状態から描く。手で直さない・足さない。形は `projections.md`。
- frontmatter を持たない。1 行目の印が写しであることを示す。

### 旧い形の intent（`decision.md`）— 読むだけ

- 旧い形の DEC と INV の文書。移行で Choice に移し、文書は `_docs/archives/intent/` に、`_docs/intent/` と同じ相対 path のまま移した。新しく作らず、移した後は動かさない。
- 旧い形の lane（docs の形で計画された lane）は 2026-10-22 に退役した（`migration.md`）。decision.md を書く段は無く、雛形も持たない。

### guide（`usage.md`）/ reference（`reference.md`）— 必要時のみ

- guide は利用者向けの使い方・運用手順。reference は API 仕様と、コードから再構成できない耐久的な機構の解説の辞書的な置き場。lane の reference は、計画役が下調べで確かめた事実を出典つきで書く。
- 恒久保守の義務はない。作らないことは違反ではない。仕様書を起点に開発を回すことはこのテンプレートの目的ではない。
- archive しない。obsolete になったら status で表す。

## status 遷移と archive 規則

- 恒久文書（qa / context / survey / guide / reference）は動かさない。廃止は `status: superseded` / `obsolete` と後継への references で表す。
- archive の対象は完了タスクの plan と、旧い形の decision.md。`_docs/archives/` 配下にそれ以外の種類のディレクトリを作らない。`_docs/archives/intent/` の文書は `_docs/intent/` と同じ相対 path に置く。
- `rm` / `git rm` は使わない（`workflow.md` の安全境界）。

## 非運用領域（`_meta/`）

`_meta/` は作業場であり、運用の読書面から明示的に除外された資料である。agent への指示として読まない。成熟したものは記録の該当する種別へ移す（`why` は Choice、確かめた事実は survey、使い方は guide）。**判断の正本は Choice であり、`_meta/` の資料はその補助である。** `_meta/` にしかない判断は、ループの欠陥の兆候である。

`_meta/validator-fixtures/` と `_meta/agent-workflows/` は検証の素材であり、成熟しても移さない例外とする。`_meta/scratch/` は commit されない手元の一時置き場である。`_meta/prompt-catalog/` は Harness が lane に渡す文面の目録で、文面を変えるときは同じ変更で目録も直す。

以下は現存する置き場の説明である。

- `_meta/handoffs/`: 外部（マシン非アクセスのモデル等）へ渡す自己完結の export。**純編纂規範**: handoff は repo 内の記録の編纂であり、真実の源にしない。作成中に新しい判断や why が生まれたら、先に Choice や qa に記録してから写す。handoff にしか書かれていない知識は、ループの欠陥の兆候である。
- `_meta/prompts/`: 一回限りの implementation prompt の保管。ファイル先頭に historical / non-operational warning を付ける。
- `_meta/validator-fixtures/` / `_meta/agent-workflows/`: validator と agent の行動の検証素材。

## Root Markdown

root 直下の Markdown は、coding agent に active project guidance として読まれる前提で管理する。一回限りの implementation prompt を root に残さない。現在の作業指示は `AGENTS.md`、`TODO.md`、`_docs/standards/`、関連 skills を参照する。

## 配る範囲の定義

この repo は規約・雛形・validator・starter を kit として公開側から配る。kit は次のもので成る。

- 規約と雛形: `_docs/standards/`（`templates/` を含む）
- validator と検査の runner: `scripts/` のうち、下に挙げるものを除いたすべて
- validator の実行環境: `deno.json`
- starter: `starter/`（`AGENTS.md`・`TODO.md`・`.claude/`・`.codex/`）
- skills の正本: `skills/propter-*`
- template の版の記録の雛形: `docs-template.lock.example.json`

kit に入れないものは次のとおりである。

- validator の自己テストとその素材: `scripts/test-validators.ts`・`scripts/test-agent-workflow-smoke.ts`・`_meta/validator-fixtures/`・`_meta/agent-workflows/`
- 前身の template の道具: `QUICKSTART.md`・`scripts/create-template-archive.sh`
- この workspace の検査設定と CI: `docs-validators.json`・`.github/workflows/docs-ci.yml`

この repo 自身の記録（`_docs/` の `standards/` 以外と root の `TODO.md`）は overlay に残し、kit に入れない。

何を外すかの唯一の情報源は `overlay.manifest` である。上の一覧は読み手のための説明であり、除外の判断は manifest にだけ置く。採用先の repo はこの節の対象ではない。採用先が自分の記録をどう扱うかは、採用先の `overlay.manifest` が決める。

## コンプライアンス

- ドキュメントに秘密情報・個人情報を含めない。環境値は `.env.example` を参照する。
- CI ログ出力にはマスク設定を適用する。
- ローカル検証の正典は `./scripts/check-docs.sh` とし、CI も同一 script を通す。Intent Record の検査は `idd intent check` である。
