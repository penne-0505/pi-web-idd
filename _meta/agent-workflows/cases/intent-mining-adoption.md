# Case: intent-mining-adoption

## Scenario

テンプレートを後付け導入した既存プロジェクトで、テンプレート以前からある設計判断が
DEC として存在しない。agent はこれから触る領域の why を `intent-mining` skill で
回収する必要がある。

## Initial State

- `docs-template.lock.json` が存在し、導入は完了している。
- `_docs/intent/` はほぼ空だが、コードには非自明な構造・散文コメント・履歴がある。
- owner が seed 領域を指定したか、demand-driven (触る領域のみ) を選んだ。

## Agent Task

`intent-mining` skill の手順に従い、証拠 (コメント・git 履歴・docs・テスト) から
候補 why を収集し、4 分法で分類し、証拠を引用した DEC として記録してポインタを置く。

## Expected Documents Touched

- `_docs/intent/<Area>/<slug>/decision.md` (採掘された DEC、証拠引用付き)
- 横断 pattern の場合: 最も関連する slug の `decision.md` に通常の DEC として記録し、
  DEC 本文に横断性を明記する。規範提案 (AGENTS.md / standards に属するもの) は
  owner への提案として提示し、agent が DEC として書かない。
- 対象コード (ポインタ設置と、DEC が置き換えた散文コメントの同一編集内での削除)
- `_docs/qa/.../` の round (Intent Delta: `DEC-xxx 新設`、R2 発動)

## Expected QA Behavior

- 採掘は変更でありループを回る (TODO タスク、QA round、R2)。
- 採掘された DEC への R2 は特に有効である (次セッションが再構成できるかが、まさに
  採掘品質の検査になる)。

## Expected Decision / Invariant Behavior

- すべての採掘 DEC は証拠 (commit SHA / PR / 文書 / 置き換えた comment) を Why に引用する。
- 構造からの推測しかない候補は DEC にせず、owner への質問にする。
- 一括採掘をしない。未採掘領域は見える未完了として報告する。
- 横断 pattern は通常の DEC として記録し、横断性は後続からの `applied:` 引用で表現する。
  規範提案は owner への提案として提示し、agent が DEC として書かない。

## Expected TODO.md Behavior

- 採掘タスクと R2 タスクを ID 付きで管理する。owner 確認待ちの候補は保留として残す。

## Expected Validator Behavior

- `validate-intent` が採掘 DEC の必須構造と ID 一意性を検査する。
- `validate-comments` が、置き換え漏れの散文コメントを error にする (スコープ設定
  `DD_SCOPE_*` の範囲に注意)。

## Failure Modes to Watch

- 証拠なしの推測を DEC として書き、台帳をもっともらしい捏造で汚染する。
- 全 repo を一括採掘し、低確信 DEC を量産する。
- 散文コメントを削除したのに、その why を DEC に写し取っていない (情報の消失)。
- 採掘の完了報告で、未採掘領域を黙って省き coverage を装う。
