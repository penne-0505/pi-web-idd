# Case: intentional-omission-risk

## Scenario

`Size XS/S` かつ `Risk Low` に見える変更だが、意図的に非対応・制限・省略している挙動がある。
将来の作業者 (別コンテクストの agent) が「未実装なので直そう」と誤認する可能性がある。
Intent Delta の三値宣言が、この判断を無言の分岐から記録された主張に変える。

## Initial State

- `TODO.md` に小規模タスクがあり、`Plan: None`、`QA` は maintenance.md を指す。
- Description や周辺 docs に、意図的な非対応・制限・省略が潜んでいる。

## Agent Task

省略が「検討を要しない自明な分岐」なのか「将来誤修正されうる設計判断」なのかを判断し、
Intent Delta で宣言する。前者なら理由付き `None:`、後者なら `DEC-xxx 新設` として
Why と Change freedom を記録する。

## Expected Documents Touched

- 軽量で足りる場合: `_docs/qa/<Area>/maintenance.md` の round (理由付き `None:`)
- 設計判断として残す場合: `_docs/intent/<Area>/<slug>/decision.md` + コードへの
  `// intent: DEC-xxx` ポインタ

## Expected QA Behavior

- どちらの経路でも QA round は存在する。`None:` の理由は「検討したが判断はなかった」と
  いう反証可能な主張であり、review の対象になる。
- DEC 新設に切り替えた場合は R2 が発動する。

## Expected Decision / Invariant Behavior

- すべての小規模変更に DEC を要求しない。禁止されるのは無言の省略だけである。
- DEC 化する場合、`intent_schema: 3` で What / Why / Change freedom を書き、現在の
  省略方法そのものを INV にしない (同じ目的を満たす別実装まで禁止しない)。
- 省略を体現する箇所にポインタを置き、将来の agent が「欠落」と誤読しない経路を作る。

## Expected TODO.md Behavior

- `Size XS/S` かつ `Risk Low` なら Plan / slug 専用 qa.md を要求しない。
- DEC 新設時は R2 タスクを Backlog に積む。

## Expected Validator Behavior

- `validate-qa` が Intent Delta の presence と裸の `None` を検査する。理由の妥当性は
  判定しない (R1 / R2 の領分)。
- `validate-todo` に semantic な why-not field requirement を追加しない。

## Failure Modes to Watch

- 意図的な非対応を無言で通し、将来の agent が欠落として実装してしまう。
- 逆振れ: すべての小規模変更に DEC を要求し、台帳を薄い記録で埋める。
- 現在の省略方法そのものを INV にして、同じ目的を満たす別実装まで禁止する。
- `None:` の理由が「特になし」など、反証可能な主張になっていない。
