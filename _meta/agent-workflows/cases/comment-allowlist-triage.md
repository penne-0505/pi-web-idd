# Case: comment-allowlist-triage

## Scenario

agent が実装中に「この処理は一見冗長だが理由がある」と説明する散文コメントを書きたく
なっている。コメント allowlist の下では、散文は DEC に書くべき why か、捨ててよい how の
どちらかである。

## Initial State

- 実装 diff に、説明したくなる非自明な構造 (意図的な冗長性・省略・境界) が含まれる。
- 対象言語の comment 規則は `validate-comments` の検査対象である。

## Agent Task

書きたい散文を分解判定規則「コードを消して書き直したら失われる情報か？」にかけ、
why 成分は DEC に記録して `// intent: DEC-xxx — <因果の一行>` ポインタを置き、how 成分は
書かない。

## Expected Documents Touched

- `_docs/intent/<Area>/<slug>/decision.md` (why がある場合)
- 対象コード (ポインタコメントのみ)
- `_docs/qa/.../` の round (Intent Delta: `DEC-xxx 新設` または理由付き `None:`)

## Expected QA Behavior

- DEC を新設した場合、Intent Delta と R2 発動が連動する。

## Expected Decision / Invariant Behavior

- ポインタのダッシュ以降は DEC の What や値を繰り返さず、因果を一行で要約する。
- テストで落とせる条件はテストへ、テスト化できない判断はポインタへ (一条件一強制)。
- TODO コメントを書かない (作業台帳は `TODO.md` のみ)。
- doc comment は既定で禁止。API 文書を配布するプロジェクトのみ `docs-validators.json`
  で opt-out を宣言する。

## Expected TODO.md Behavior

- コメント起点で見つかった残作業は TODO タスクとして積む (コード内 TODO にしない)。

## Expected Validator Behavior

- `validate-comments` が散文コメント・TODO コメントを error にし、ポインタの参照先
  DEC の存在を確認する。
- pragma / shebang / license header は許可される。

## Failure Modes to Watch

- 散文を書けないので why をどこにも書かず捨てる (行き先は禁止ではなく移転である)。
- ポインタのダッシュ以降に What の言い換えを書く (因果になっていない)。
- allowlist を回避するために形式だけポインタ風の散文 (`// intent: 補間のため`) を書く。
- validator の除外設定 (`docs-validators.json`) を無断で広げて検査を逃れる。
