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

- すべての変更は同じ順を踏む: `触る Place の Choice を知る → 出口を選ぶ → 変える → Choice を記録するか Waive を宣言する`。
  省略できるのは深さであって、順ではない。詳細は [workflow standard](_docs/standards/workflow.md) に従う。
- 意図の記録は Purpose と Choice の 2 単位で、Harness の口（`idd intent`）から書く。形は [records](_docs/standards/records.md) に従う。
- Choice を書かない変更は Waive を宣言する: `applied`（既存の Choice の適用）か理由付きの `no-choice`。無言の省略は禁止。
- lane の外の手の変更は qa の Round（Commands・AC Coverage・Risk・Choice か Waive・Verdict）を記録する。
  `Size >= M` は Plan を、`Risk >= Medium` は実装前の QA (`qa_status: planned`) を要求する。
- ターンは負債を持って終われるが、タスクは負債を持って閉じられない。ターン終端で未対応の
  ドキュメントがあれば、作業を始めずに一言だけ現状を伝え、本筋の次の指示が来たときに処理する。

## コードコメント

- コードのコメントは上段（公開側 AGENTS.md）の規約に従う。
- コードに統治用のポインタを置かない。意図とコードの対応は Choice の place に、
  AC とテストの対応は qa.md の Checks に書く。INV の番号は作らず、守る性質は Choice の anchored に書く。
  分解判定規則: 「コードを消して書き直したら失われる情報か？」

## ドキュメント

- 文書の置き場・frontmatter・ライフサイクルは [document contracts](_docs/standards/document_contracts.md) に従う。
- 完了履歴の正典は検証の記録（lane は Harness の検証ログ、手の変更は `_docs/qa/.../qa.md` / `maintenance.md` の Round）。TODO に Done セクションを作らない。
- 久しぶりの再開、handoff 探索、現状把握、docs が形骸化していないかの確認では `propter-docs-inventory` skill を使う。
- upstream template を推奨 release tag へ更新する場合は `propter-docs-template-migration` skill を使い、
  moving branch tip ではなく tag と full SHA を固定し、`docs-template.lock.json` を互換移行の検証後に更新する。
- 既存プロジェクトへの後付け導入で、テンプレート以前からある設計判断を Choice として回収する場合は
  `propter-intent-mining` skill を使う。証拠なしの推測を Choice として書かない。
- 作業の前には `propter-prep` skill、完了前には `propter-close` skill を使う。skill は手順のみを持ち、規範の正典は standards にある。
- 安全性・権限・secret・外部入力の扱いは [workflow standard](_docs/standards/workflow.md) の安全境界に従う。
- root 直下の Markdown は active project guidance として扱われる。一回限りの実装プロンプトや
  外部向け handoff は `_meta/` 配下に置き、非運用の資料として明記する。

## 検証

- ローカル検証の正典は `./scripts/check-docs.sh`。skills を積極活用して実装準備とドキュメント更新を行う。
- hooks は optional な増幅であり、規範の代替ではない。hook が無い環境でも同じ規範に従う。
