# archive-flow

## Scenario

完了タスクの plan を archives へ移送する。archive 対象は plan のみであり、恒久文書
(intent / qa / guide / reference) は動かさない。

## Initial State

- `_docs/plan/<Area>/<slug>/plan.md` が存在し、対応タスクは verdict PASS で完了している。
- `_docs/intent/<Area>/<slug>/decision.md` と `_docs/qa/<Area>/<slug>/qa.md` が存在する。
- intent / qa の `references` が plan の live path を指している。

## Agent Task

plan を `git mv` で `_docs/archives/plan/<Area>/<slug>/plan.md` へ移送し、参照リンクを
archive 先へ更新する。

## Expected Documents Touched

- `_docs/archives/plan/<Area>/<slug>/plan.md` (移送先)
- `_docs/intent/<Area>/<slug>/decision.md` / `_docs/qa/<Area>/<slug>/qa.md` (references 更新)

## Expected QA Behavior

- intent / qa は移送しない。廃止が必要なら `status` で表す。
- 移送自体は微小変更であり、round は `_docs/qa/<Area>/maintenance.md` へ追記する
  (Intent Delta は理由付き `None:` か `applied:`)。

## Expected Decision / Invariant Behavior

- 移送は削除ではなく履歴保持のための移動である。`mv` / `git mv` のみを使う。
- `_docs/archives/` 配下に plan 以外のディレクトリを作らない。

## Expected TODO.md Behavior

- archive 移送を含む cleanup タスクが完了したら `TODO.md` から削除する。
- 残作業がある場合だけ Backlog に follow-up を追加する。

## Expected Validator Behavior

- `validate-doc-links` が更新後の references の存在を確認する (live path への
  リンク切れを検出する)。
- `validate-qa` が QA docs を archive 対象として扱わない。

## Failure Modes to Watch

- `rm` / `git rm` を使う。
- intent / qa / guide / reference を archive する。
- live path と archive path に同じ文書を重複させる。
- references を更新せず、リンク切れのまま残す。
- 存在しない `_docs/archives/draft/` や `_docs/archives/survey/` を作る。
