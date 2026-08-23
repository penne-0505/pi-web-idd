# Intent Driven Development Template

> This README is available in English and Japanese. English speakers, please scroll down.

## 概要

このリポジトリは intent-driven development *(意図駆動開発)* のテンプレートです。

コーディングエージェントによる開発の最大の問題は一貫性の欠如であり、その原因は意図
(why / why not) の不足です。このテンプレートは、実装の意図を記録・参照・検証することを
開発サイクルの中心に置きます。ドキュメントは意図を運ぶ媒体であり、想定読者は毎回
コンテクストが分離された状態で作業を始める coding agent です。

- **すべての変更**が最小ループを回ります: `TODO (AC) → 実装 → Intent Delta の宣言 → QA round の記録`。省略できるのは深さであって、存在ではありません。
- 設計判断はリポジトリ一意の ID を持つ `DEC` として `_docs/intent/` に記録され、コードからは `// intent: DEC-xxx — <理由>` のポインタコメントだけで到達します。散文コメントは validator が禁止します。
- QA は計画と検証記録が一体の `qa.md` 一種類で、微小変更は Area ごとの集約ファイルに数行の round を追記するだけです。
- 品質は機械 (validator が構造を強制) と agent review (R1 妥当性 / R2 再構成テスト) が担い、人間は標準の改訂だけを行います。

人がサイクルを回すことも出来ますが、基本的には**Claude Codeなどのコーディングエージェント**が、この規則に従って自律的な開発を行うために設計されました。

**詳細については [workflow standard](_docs/standards/workflow.md) と [document contracts](_docs/standards/document_contracts.md) を参照してください。**

初めて使う場合は、まず [Quickstart](QUICKSTART.md) を読んでください。

## 使用方法

1. このリポジトリをフォークまたはクローンします。
2. **`starter/` を展開します。** 利用者向けの `AGENTS.md` / `CLAUDE.md` / `TODO.md` と agent 設定は `starter/` に畳まれており、展開するまで有効になりません。手順は [Quickstart](QUICKSTART.md) の「0. 初期化」にあります。
3. プロジェクトに合わせてドキュメントと設定ファイルを編集します。
4. 開発を開始します。

配布用 ZIP を作る場合は、`.git` / `.jj` などの VCS メタデータを含めないために、GitHub 標準アーカイブまたは `scripts/create-template-archive.sh` を使用してください。

ローカルでドキュメント検証をまとめて実行する場合は、`scripts/check-docs.sh` を使います。CI も同一 script を通します。

既存プロジェクトへ後付け導入する場合は、`DD_SCOPE_BASE` に導入時点の commit を設定して、既定では「導入以降に追加した docs だけ」を検証対象に絞れます。設定方法は [Quickstart](QUICKSTART.md) と [template_operations.md](_docs/standards/template_operations.md) を参照してください。

導入後も template の更新を取り込む場合は、推奨 release tag とその full SHA を `docs-template.lock.json` に記録し、[`docs-template-migration`](.agents/skills/docs-template-migration/SKILL.md) skill で既存のカスタマイズを保全しながら three-way migration を行います。

Codex / Claude Code 向けの lifecycle hook を同梱しています。hook は optional な増幅であり、規範の代替ではありません（規範は Markdown 層に、機械強制は Deno validator にあります）。SessionStart はワークフローの想起、PreToolUse は恒久削除・秘密ファイル操作の安全ブロック、Stop はループ関連の未コミット変更があるときの一言想起のみを行います。利用時は各 agent の `/hooks` で内容を確認して信頼してください。

久しぶりの再開や handoff 探索では、`docs-inventory` skill が TODO、intent、QA、legacy 文書の棚卸しを行います。

## カスタマイズ

使用に当たっては、以下のファイルをプロジェクトに合わせてカスタマイズしてください。

- **AGENTS.md**: プロジェクト固有の実行コマンド、安全基準に合わせて確認・編集してください。
- **README.md**: このREADME自体も、プロジェクトに合わせて編集してください。
- **LICENSE.txt**: 特に著作者の表示を編集してください。
- **docs-validators.json** (任意): ライブラリとして API doc comment を配布する場合の opt-out など、validator の設定を宣言できます。

## ライセンス

このリポジトリは [MITライセンス](LICENSE.txt) の下でライセンスされています。

---

## Summary

This repository is a template for intent-driven development.

The core failure mode of agent-driven coding is loss of consistency, and its cause is missing
intent (the why / why not behind implementations). This template puts recording, referencing,
and verifying intent at the center of the development cycle. Documents are the medium that
carries intent; the primary reader is a coding agent that starts every session with a fresh
context.

- **Every change** runs the minimal loop: `TODO (AC) → implement → declare the Intent Delta → record a QA round`. Only depth varies; presence does not.
- Design decisions are recorded as `DEC` entries with repository-unique IDs under `_docs/intent/`, reachable from code exclusively through pointer comments (`// intent: DEC-xxx — <reason>`). Prose comments are rejected by a validator.
- QA planning and verification live in one `qa.md` per feature; small changes append a few-line round to a per-area rolling file.
- Quality is held by machines (validators enforce structure) and agent review (R1 validity / R2 reconstruction test); humans only revise the standards.

While humans can run the cycle, it is primarily designed **for coding agents like Claude Code** to autonomously develop according to these rules.

**For details, see the [workflow standard](_docs/standards/workflow.md) and the [document contracts](_docs/standards/document_contracts.md).**

If this is your first time using the template, start with the [Quickstart](QUICKSTART.md).

## Usage

1. Fork or clone this repository.
2. **Expand `starter/`.** The consumer-facing `AGENTS.md` / `CLAUDE.md` / `TODO.md` and the agent configuration live under `starter/` and stay inactive until you expand them. See "0. 初期化" in the [Quickstart](QUICKSTART.md).
3. Edit the documentation and configuration files to suit your project.
4. Start development.

Use `scripts/check-docs.sh` to run the local documentation validators together; CI runs the same script.

When adopting this template in an existing project, set `DD_SCOPE_BASE` to the adoption commit so that, by default, only docs added after adoption are validated. To keep an adopted project current with later template releases, record the recommended release tag and its full SHA in `docs-template.lock.json`, then use the [`docs-template-migration`](.agents/skills/docs-template-migration/SKILL.md) skill.

Lifecycle hooks for Codex and Claude Code are included as optional amplifiers, never as the norm itself (norms live in Markdown, machine enforcement in Deno validators): SessionStart reinjects the workflow, PreToolUse blocks permanent deletion and credential-file access, and Stop asks a single ignorable question when loop-relevant uncommitted changes exist. Review and trust them through each agent's `/hooks` UI before use.

## License

This repository is licensed under the [MIT License](LICENSE.txt).
