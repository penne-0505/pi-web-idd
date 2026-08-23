# Quickstart

このテンプレートは、Codex / Claude Code / 汎用 coding agent が intent-driven development —「すべての変更が意図の宣言と検証記録を伴う」— で開発を進めるための土台です。最初のセットアップでは、プロジェクト固有情報に置き換えることと、agent が迷わない入口を残すことを優先してください。

## 0. 初期化

このリポジトリには `starter/` があります。これは**まだ初期化されていない**印です。

利用者向けの `AGENTS.md` / `CLAUDE.md` / `TODO.md` と agent 設定（`.claude/` / `.agents/` / `.codex/`）は `starter/` に畳まれています。これは、テンプレート自身を開発するときに、これらの規約が誤って開発者向けの指示として読まれ、テンプレートの改良履歴が出荷物へ混入するのを防ぐためです。展開するまで hook も skill も有効になりません。

最初に一度だけ、`starter/` の中身を repository root へ移動してください。dotfile を取りこぼしやすいので、まとめて移動します。

```bash
find starter -mindepth 1 -maxdepth 1 -exec mv -f {} . \; && rmdir starter
```

展開すると次の状態になります。

- root の `AGENTS.md` は router から利用者向けの規約へ置き換わる。
- `TODO.md` と agent 設定が root に現れ、hook と skill が有効になる。
- `starter/` ディレクトリは消える。

以降の節は、この展開が済んでいることを前提にしています。展開後、次が通ることを確認してください。

```bash
./scripts/check-docs.sh
```

このファイルと `README.md` は root に残り、展開の前後で内容は変わりません。

## 1. 最初に読むファイル

- [AGENTS.md](AGENTS.md)
- [TODO.md](TODO.md)
- [_docs/standards/workflow.md](_docs/standards/workflow.md) — どう働くか (憲法)
- [_docs/standards/document_contracts.md](_docs/standards/document_contracts.md) — 文書種別ごとの契約
- [_docs/standards/template_operations.md](_docs/standards/template_operations.md) — 導入・テンプレ更新

## 2. 初回セットアップ

1. [README.md](README.md) をプロジェクト名、目的、使用方法に合わせて書き換える。
2. [LICENSE.txt](LICENSE.txt) の著作者表示を確認し、必要に応じて更新する。
3. [AGENTS.md](AGENTS.md) をプロジェクト固有のコマンド、禁止事項、実行環境に合わせて調整する。
4. [TODO.md](TODO.md) の初期タスクを確認し、不要なテンプレート用タスクは完了後に削除する。
5. TODO の `Size` / `Risk` を確認する。`Size >= M` では Plan を、`Risk >= Medium` では実装前の `_docs/qa/<Area>/<slug>/qa.md` (`qa_status: planned`) を用意する。
6. すべての変更で、実装後に QA round (Intent Delta / verdict) を記録する。微小変更は `_docs/qa/<Area>/maintenance.md` へ数行の round を追記するだけでよい。
7. 一回限りの実装プロンプトを root に残さない。残す必要がある場合は `_meta/prompts/` 等に移し、非運用の履歴資料として明記する。
8. tagged release から開始する場合は `docs-template.lock.example.json` を `docs-template.lock.json` としてコピーし、採用 tag を解決した full SHA を記録する。
9. プロジェクトが自前の TypeScript / JavaScript toolchain を持つ場合、tsconfig・formatter・linter・bundler の対象から `scripts/` と `_meta/` を除外する。これらは Deno を対象とした配布物であり、既定の glob (`**/*.ts` など) が巻き込むと採用先の build が壊れる。詳細は [採用側 toolchain との境界](_docs/standards/template_operations.md) を参照。

### Agent lifecycle hooks

このテンプレートは Codex / Claude Code 向けの lifecycle hook を同梱しています。

- Codex: [.codex/hooks.json](.codex/hooks.json)
- Claude Code: [.claude/settings.json](.claude/settings.json)
- 共通 script: [scripts/agent-workflow-hook.ts](scripts/agent-workflow-hook.ts)

hook は Tier 2 の optional amplifier です。規範は Markdown (AGENTS.md / standards)、機械強制は Deno validator にあり、hook が無い環境でも同じ規範が成立します。docs の自動更新や Risk の確定は行いません。

- `SessionStart`: intent-driven workflow の想起 context を再注入します。
- `PreToolUse`: 恒久削除 (`rm` / `git rm` と代表的な迂回路)・秘密ファイル操作・恒久記録の archive 移動をブロックします。ブロック文には禁止理由と次の行動が書かれています。
- `Stop`: ループ関連ファイルに未コミット変更があるときだけ、「ドキュメントは実態に追いついていますか？」と一言だけ確認します。対応済み・該当なしなら無視して終了できます。未対応があっても作業は始めず、一言伝えて本筋の次の指示で処理します。

初回利用時は各 agent の `/hooks` で内容を確認し、信頼してください。不要な場合は、hook 設定を無効化または削除してから使います。

### Documentation inventory

久しぶりの再開、handoff 探索、または docs が形だけになっていないか確認したい場合は、`docs-inventory` skill を使います。`docs-inventory` は read-only の棚卸しであり、archive や TODO 削除は行いません。整理を実行する場合は、棚卸し結果を確認してから作業タスクとして切り出します。

### 既存プロジェクトへ後付け導入する場合

既存 docs を一斉に検証対象にしないため、段階的導入スコープを設定します。

1. 導入時点の commit SHA または tag を baseline として控える。
2. CI の環境変数に `DD_SCOPE_BASE: <baseline commit>` を設定する。これで、導入以降に**追加された** docs だけが検証対象になり、既存 docs には手を入れずに済む。
3. 既存 docs を編集した時点で検証対象にしたい場合だけ、`DD_SCOPE_DIFF_FILTER=ACMR` を追加する。
4. `actions/checkout` で `fetch-depth: 0` を設定し、baseline commit を参照できるようにする。
5. スコープ対応 validator の実行に `--allow-env`（git 使用時はさらに `--allow-run=git`）を付与する。`scripts/check-docs.sh` は設定済み。
6. `TODO.md` は段階導入でも常に全体が検証対象である点に注意する。

テンプレート以前から存在する設計判断（既存コード・仕様書・履歴に眠る why）を DEC として回収するには、[`intent-mining`](.agents/skills/intent-mining/SKILL.md) skill を使います。一括採掘ではなく、触る領域から証拠付きで段階的に掘り起こします。

詳細は [段階的導入スコープ](_docs/standards/template_operations.md) を参照してください。

### Template の継続更新

導入後の project へ新しい template release を統合する場合は、moving `main` ではなく推奨 tag を更新単位にします。

1. `docs-template.lock.json` から、前回取り込んだ tag と full SHA (`B`) を確認する。
2. 取り込む推奨 tag (`U`) を full SHA へ解決し、tag の付け替えがないことを確認する。
3. [`docs-template-migration`](.agents/skills/docs-template-migration/SKILL.md) skill を使い、`B -> U` の upstream 差分と、`B` から現在の project までのカスタマイズを three-way inventory にする。
4. `U` の配布ファイルを reconciliation し、compatibility checks が成功した後に、lock を最後の migration write として `U` の tag と full SHA へ更新する。closure verification では更新後の lock を確認する。
5. strict schema migration を延期した場合は、lock ではなく migration verification に状態と follow-up を残す。

`v1.0.0` より前に導入された project は lock と local migration skill を持たない場合があります。その場合は project 固有ルールを安全境界とし、対象 `U` に含まれる skill を外部入力として先にレビューします。repository history、導入記録、upstream と一致する blob から最後に採用した template commit `B` を復元し、owner 確認後に移行します。`v1.0.0` を中継する必要はなく、`v1.0.0` 以降の任意の推奨 tag へ直接移行できます。`B` を推測でしか決められない場合は、書き込み前に停止します。

`DD_SCOPE_BASE` は導入先 repository 内で validator の対象を絞る値です。upstream template revision を示す `docs-template.lock.json` とは用途が異なります。詳細は [template revision provenance](_docs/standards/template_operations.md) を参照してください。

## 3. Agent に渡す初回プロンプト例

### Codex

```text
AGENTS.md、TODO.md、_docs/standards/workflow.md を読んで、このリポジトリの intent-driven development ルールを把握してください。まず TODO.md の Backlog を確認し、最初に着手すべき小さなタスクを提案してください。
```

```text
prepを実行して、対象タスクの深さ (Plan / qa.md) を整え、影響するDECのWhyとChange freedomを確認してください。
```

```text
実装後、closeを実行してQA roundを記録し、Intent Deltaとverdictを出してください。
```

```text
docs-inventoryを実行して、TODO、intent、QA、legacy文書の棚卸しをしてください。自動整理はせず、次に判断すべき点を1-3件に絞ってください。
```

```text
docs-template-migrationを実行して、docs-template.lock.jsonのBと推奨tag Uをfull SHAで固定し、project固有変更を保全するthree-way migration計画を作ってください。互換移行とstrict schema移行は別に判定してください。
```

### Claude Code

```text
Read AGENTS.md, TODO.md, and _docs/standards/workflow.md first. Follow the workflow standard and document contracts. Do not delete files with rm or git rm. Start by reviewing the initial TODO items and propose the first safe change.
```

### Generic Agent

```text
Use TODO.md as the task source of truth. Every change must end with a QA round declaring an Intent Delta (new DEC / applied: DEC-xxx / None: <reason>). Size >= M requires a Plan; Risk >= Medium requires qa.md created before implementation. Keep intent and QA documents permanent, archive only completed Plans, use pointer-only code comments, and remove completed tasks from TODO.md only with a PASS verdict.
```

## 4. 最初に完了すべき TODO

- `Docs-Chore-1`: [AGENTS.md](AGENTS.md) の確認とプロジェクト固有化
- `Docs-Chore-2`: [README.md](README.md) のプロジェクト固有化
- `Docs-Chore-3`: [LICENSE.txt](LICENSE.txt) の著作者表示確認
- `Workflow-Chore-7`: 既存プロジェクトへ後付け導入する場合のみ、導入スコープ（`DD_SCOPE_BASE`）を設定（新規プロジェクトでは不要）
- `Workflow-Chore-11`: 採用した template release tag と full SHA を `docs-template.lock.json` に記録

完了したタスクは [TODO.md](TODO.md) から削除します。Done / Archived セクションは作りません。

## 5. 検証コマンド

```bash
deno fmt --check scripts/*.ts
deno run --allow-read --allow-env --allow-run=git scripts/validate-frontmatter.ts
deno run --allow-read scripts/validate-todo.ts
deno run --allow-read --allow-env --allow-run=git scripts/validate-doc-links.ts
deno run --allow-read --allow-env --allow-run=git scripts/validate-intent.ts
deno run --allow-read --allow-env --allow-run=git scripts/validate-qa.ts
deno run --allow-read --allow-env --allow-run=git scripts/validate-comments.ts
deno run --allow-read --allow-env --allow-run=git scripts/validate-intent-delta.ts
deno run --allow-read --allow-write --allow-env --allow-run scripts/test-validators.ts
deno run --allow-read --allow-run=git scripts/test-agent-workflow-hook.ts
deno run --allow-read scripts/test-agent-workflow-smoke.ts
```

`--allow-env` / `--allow-run=git` は段階的導入スコープ（`DD_SCOPE_BASE`）向けの権限です。スコープ未設定なら全走査の従来挙動になります。まとめて実行する場合:

```bash
./scripts/check-docs.sh
```

`./scripts/check-docs.sh` は Deno validator を通します。**Deno があれば十分**で、CI も同一 script を通すため、手元で pass すれば CI も同じ結果になります。

ただしこの script が検証するのは docs 規約と validator 自身の健全性だけです。プロジェクト自身の build / typecheck / lint / test は別の gate であり、`check-docs.sh` の PASS からは導けません。template release を統合したあとは両方を走らせてください（[採用側 toolchain との境界](_docs/standards/template_operations.md)）。

## 6. 配布用 ZIP

テンプレートを配布する場合は、`.git` や `.jj` などの VCS メタデータを含めないでください。GitHub 標準アーカイブ、または次のコマンドを使います。

```bash
scripts/create-template-archive.sh intent_driven_dev_template.zip
```
