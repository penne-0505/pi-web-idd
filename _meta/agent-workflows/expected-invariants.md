# Expected Invariants

全ケース共通の不変条件。規範の正典は `_docs/standards/` であり、本書は golden case を
採点するときの短縮参照にすぎない。矛盾があれば standards が勝つ。

## ループ

- すべての変更は `TODO (AC) → 実装 → Intent Delta の宣言 → QA round の記録` を回る。
  省略できるのは深さであって、存在ではない。
- Intent Delta は三値 (`DEC-xxx 新設` / `applied: DEC-xxx` / 理由付き `None:`)。
  裸の `None`・無言の省略は不可。
- QA round は Commands / AC Coverage / Intent Delta / R2 / Verdict を持ち、追記専用である。
- DEC 新設 / `Size >= M` / `Risk High` のいずれかで R2 (再構成テスト) が発動する。
  普遍形は `R2: PENDING` + TODO への R2 タスク積み。非該当なら「非発動」と書く。
- ターンは負債を持って終われるが、タスクは負債を持って閉じられない。verdict の
  揃っていないタスクを TODO から消さない。

## Documentation Paths

- Plan は `_docs/plan/<Area>/<slug>/plan.md` (`Size >= M` のみ)。
- QA は `_docs/qa/<Area>/<slug>/qa.md` の単一文書 (計画 + 検証記録)。微小変更の round は
  `_docs/qa/<Area>/maintenance.md` へ集約する。
- intent は `_docs/intent/<Area>/<slug>/decision.md`。横断性のある判断も通常の DEC として
  記録し、横断性は後続からの `applied:` 引用で表現する。
- `<Area>` は `TODO.md` の `Area` と一致する。`<slug>` は kebab-case。
- 新規文書の schema marker: intent は `intent_schema: 3`、QA は `qa_schema: 5`。
  旧 schema 文書は「見える未完了」であり、意味を変更する編集の際に移行する。
- archive 対象は完了タスクの plan のみ (`_docs/archives/plan/`)。intent / qa / guide /
  reference は archive せず、廃止は `status` で表す。draft / survey ディレクトリは存在しない。

## DEC / INV

- DEC は repo 一意の ID を持ち、What / Why / Change freedom を必須とする。
- 知識の 4 分法: why → DEC、判断履歴 → DEC の更新、純粋な how → 記録しない、
  耐久的な機構解説 → reference。分解判定規則は「コードを消して書き直したら失われる情報か？」。
- INV は optional であり、0 件でも正常。現在の実装機構や契約でない exact 値を INV にしない。
- 新設 DEC を書く前に既存 DEC を grep する (意味的重複の予防は実装前参照のみ)。

## コメント

- コード内コメントは allowlist のみ: `// intent: DEC-xxx — <因果>`、
  `// intent-invariant: INV-xxx`、`// Covers AC-xxx`、shebang、pragma、license header。
- 散文コメント・TODO コメントは禁止。書きたい散文は DEC に書く why か、捨ててよい how。

## TODO.md

- 完了タスクは削除する。Done / Archived セクションを作らない。完了履歴の正典は QA round。
- `QA` フィールドは `None` にできない (qa.md か maintenance.md のどちらかを指す)。
- `Size >= M` は Plan 必須。`Risk >= Medium` は実装前 QA (`qa_status: planned`) 必須。
- workflow-sensitive paths (`scripts/` `.github/` `_docs/standards/` `.claude/` `.codex/`
  `.agents/` `AGENTS.md` `CLAUDE.md`) に触れる変更は申告に関わらず `Risk High` として扱う。
- Bug 修正は regression test か no-test rationale を、Refactor は behavior-preservation
  checks を、agent workflow 変更は misbehavior checks を要求する。
- FAIL / BLOCKED の verdict を持つタスクを TODO から消さない。

## Safety

- `rm` / `git rm` は使わない。完了タスクの plan の archive 移送に限り `mv` / `git mv` を使える。
- secret や `.env` 実値を diff / log に出さない。
- root 直下の一回限り prompt を active guidance として扱わない。
- template 更新は moving branch tip ではなく推奨 release tag + full SHA を固定する。
  lock (`docs-template.lock.json`) の前進は互換移行の検証後、closure verification で確認する。
- pre-`v1.0.0` repository は中継移行なしで任意の推奨 tag へ直接 bootstrap できる。
- compatibility migration と strict schema migration は別々に報告する。

## Validation

- ローカル検証の正典は `./scripts/check-docs.sh` (validator の個別列挙はしない。列挙は
  wrapper との drift 源になるため)。
- validator は presence と機械判定可能な整合のみを検査する。`None:` 理由の妥当性、R2 の
  中身などの意味判定を validator に追加しない (質は R1 / R2 / user review の領分)。
- validator fixtures は valid / invalid の両例を持つ。
