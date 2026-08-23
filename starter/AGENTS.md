# 原則

このプロジェクトは intent-driven development で運用される。実装の「なぜ」(intent) を記録し、
参照し、検証することが最優先である。ドキュメントは intent を運ぶ媒体であり、読者は
コンテクストを持たない coding agent である。

- 日本語で会話する。
- 日付確認には`date`コマンドを使用する。
- tool や shell command を優先して使用する。
- **徹底的に現状実装・ドキュメントを参照、分析してから実装を行う。**
- **`git rm`や`rm`などの恒久削除は禁止**（ユーザーに提案し、実行は待つ）。ただし、完了タスクの plan の archive 移送に限り `mv` / `git mv` は許可。

## ループ

- すべての変更は最小ループを回る: `TODO (AC) → 実装 → Intent Delta の宣言 → QA round の記録`。
  省略できるのは深さであって、存在ではない。詳細は [workflow standard](_docs/standards/workflow.md) に従う。
- Intent Delta は三値: DEC 新設 / `applied: DEC-xxx` / 理由付き `None:`。無言の省略は禁止。
- `Size >= M` は Plan を、`Risk >= Medium` は実装前の QA (`qa_status: planned`) を要求する。
- DEC 新設 / `Size >= M` / `Risk High` では R2 再構成テストが発動する。`R2: PENDING` を QA round に
  書き、R2 タスクを TODO に積む。
- ターンは負債を持って終われるが、タスクは負債を持って閉じられない。ターン終端で未対応の
  ドキュメントがあれば、作業を始めずに一言だけ現状を伝え、本筋の次の指示が来たときに処理する。

## コードコメント

- コード内のコメントは allowlist のみ: intent ポインタ、`// Covers AC-xxx / INV-xxx`、shebang、
  pragma、license header。散文コメント・TODO コメントは禁止。
- 設計判断を体現するコードには `// intent: DEC-00X — <因果の一行>` でポインタを残す。
  strict invariant を体現する場合だけ `// intent-invariant: INV-00X — <破れない結果>` を使う。
- 書きたい散文があるなら、それは DEC に書くべき why か、書かなくてよい how である。
  分解判定規則: 「コードを消して書き直したら失われる情報か？」

## ドキュメント

- 文書の置き場・frontmatter・ライフサイクルは [document contracts](_docs/standards/document_contracts.md) に従う。
- 完了履歴の正典は QA round (`_docs/qa/.../qa.md` / `maintenance.md`)。TODO に Done セクションを作らない。
- 久しぶりの再開、handoff 探索、現状把握、docs が形骸化していないかの確認では `docs-inventory` skill を使う。
- upstream template を推奨 release tag へ更新する場合は `docs-template-migration` skill を使い、
  moving branch tip ではなく tag と full SHA を固定し、`docs-template.lock.json` を互換移行の検証後に更新する。
- 既存プロジェクトへの後付け導入で、テンプレート以前からある設計判断を DEC として回収する場合は
  `intent-mining` skill を使う。証拠なしの推測を DEC として書かない。
- 作業の前には `prep` skill、完了前には `close` skill を使う。skill は手順のみを持ち、規範の正典は standards にある。
- 安全性・権限・secret・外部入力の扱いは [workflow standard](_docs/standards/workflow.md) の安全境界に従う。
- root 直下の Markdown は active project guidance として扱われる。一回限りの実装プロンプトや
  外部向け handoff は `_meta/` 配下に置き、非運用の資料として明記する。

## 検証

- ローカル検証の正典は `./scripts/check-docs.sh`。skills を積極活用して実装準備とドキュメント更新を行う。
- hooks は optional な増幅であり、規範の代替ではない。hook が無い環境でも同じ規範に従う。
