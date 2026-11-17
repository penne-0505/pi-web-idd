# 旧い形からの移し方と、旧い形の記録の扱い

旧い形は、`decision.md` の DEC と INV、qa の Round の Intent Delta と R2 の欄、`TODO.md` の R2 task で意図を記録していた。新しい形（`records.md`）への移行は一度きりで、2026-10-14 に変換を実行した。この文書は、移した方法と、残っている旧い形の記録の扱いを決める。

## DEC → Choice

機械で移した欄:

| DEC | Choice |
|---|---|
| 見出しの題 | forms.chosen（人の見直し候補。What の説明になっているものが多い） |
| Why | why |
| Why not | forms.rejected |
| Change freedom | free |
| Anchors | place（path と symbols をそのまま。None は root に） |
| Source | origin |
| Revisit when | revisit |
| Superseded by | history の superseded と status |
| 作成日 | history の created |

人の確認が要ったもの:

- **purpose**。旧い DEC に Purpose は無かった。DEC を束ねて Purpose の一覧の案を起こし（2026-10-11）、人が**一覧だけ**を確かめた。各 DEC がどの Purpose に連なるかは機械の割り当てで、origin に「移行時の割り当て」と残した。
- **Choice は全件を unconfirmed で移し、人はまとめて見直さない（2026-10-12 決定）。** まとめて見直すのは「後からまとめない」の原則に反し、全件の通し見は払えない。かわりに、lane がその Place を触ったときに払う。注入で届いた unconfirmed の Choice を、計画役はその lane の中で「確認 / Supersede / 捨てる（Grounds: 移行時の記録で現物と合わない）」のどれかにする。Judge は unconfirmed の Choice との食い違いを must にしない。触られない unconfirmed の Choice は害を出さない。一定期間の後に archive へ落とす機構は未実装である。
- **Why not が無い DEC**。no_why_not に「移行: 元の DEC に Why not の欄が無い」を機械で入れた。触ったときに計画役が rejected を足すか確かめる。
- **visibility**。全部 private で移した。
- **Anchors の印の崩れ**（`・`区切り、`path:行`、backtick 無し）。変換のときに機械で path に直した。読めないものは root に置き、触ったときに直す。

ID は元の `DEC-…` をそのまま Choice の id にした。

## INV → anchored

INV は親の DEC の anchored に畳んだ。畳んだ INV は、anchored の中に `INV-<id>: <本文>` の行として残る。親の無い INV は、`INV-…` の id のまま Choice にした。新しい INV は立てない（`records.md` の「INV を立てない」）。

## qa の Round → 検証ログ

- 新しい形の lane（計画役の brief が state の形で始まった lane）は、qa.md に AC と Checks だけを書き、Round を書かない。検証ログは Harness が台帳から導く（`work.md` の「検証ログ」）。
- Round の Intent Delta の値は、Waive に読み替える（新設 → Choice の記録、applied → applied、None → no-choice）。R2 の欄は持たない（R2 は 2026-10-22 に仕組みごと外した。下の「R2 を外した」）。
- lane の外の手の変更は、引き続き qa の Round に書く。見出しの日付が 2026-10-23 以降の Round は、新しい欄（Commands・AC Coverage・Risk・Choice か Waive・Verdict）で書く（`document_contracts.md` の qa）。
- 過去の Round は書き換えない。

## TODO.md

- lane の follow-up は `TODO.md` に書かず、lane の台帳と場所に付いた指摘に持つ。
- open の task を「仕事にする / 場所に付いた指摘にする / 捨てる」の 3 束に分けて `TODO.md` を台帳でなくす移行は未実施である。それまで `TODO.md` は lane の外の手の仕事の台帳として使い、書式は repo の TODO の Schema 節に従う。
- task の `Intent` 欄は、新しい task では `None` と書く（Choice は状態にあり、文書の path を持たない）。旧い task の decision.md の path は書き換えない。
- 旧い形の R2 task（`<Area>-R2-<n>`）は新しく積まない。`validate-todo` は R2 の種別を受け付けない（pi-web-idd の `TODO.md` に R2 task は残っていない）。
- 自前の写しの検査から package の検査（`idd rules check`・`scripts/check-docs.sh`）へ移す repo は、移す前に `TODO.md` に残った R2 task を退役させる。中身が今も要る task は種別を替えて（`Doc` か `Chore`、ID は `Next ID No` から振り直す）通常の task に書き直し、要らない task は消す。残したまま移すと `validate-todo` が落ちる（例: daysai-flutter の `App-R2-8`・`App-R2-9`）。

## 旧い形の記録の扱い

旧い形の文書は**見える未完了**として扱う。

- 書き換えない記録: `_docs/qa/**` の過去の Round、`_docs/intent/**` の写し（手で直さない）、`_docs/archives/**`、`TODO.md` の履歴。旧い形の `decision.md` は `_docs/archives/intent/` に移した。
- 検査は旧い形を受け入れる。`validate-qa` は、Intent Delta と R2 の欄を持つ Round を 2026-10-22 までの日付なら旧い形として検査し（過去の Round の判定は今と変わらない）、2026-10-23 以降の日付の Round に旧い欄があれば error にする。日付の無い Round は、持っている欄の形で検査する。Harness が R2 の結果として書いた過去の Round（見出しに「Issue lane の S3 の R2 の結果」）も R2 の欄を持つので旧い形として読む。R2 の PENDING の滞留の警告は外した。
- `validate-intent` は旧い形の `decision.md`（`intent_schema` 2〜4）の検査で、validator の見本でだけ回る。
- 旧い形の lane（docs の形で計画された lane）は 2026-10-22 に退役した。開いている docs の形の lane は無く（台帳で確かめた）、新しい lane はすべて state の形で始まり、取り込み直した lane も state の形で計画し直す。docs の形の lane を読む code（記録の形の判定、decision.md の読み手）は、過去の lane の台帳を読むために残す。docs の形の lane だけに効いた自動の GO の止め（root か dir の DEC の Why を変える申告）は外した。
- 一斉の手での移行は要求しない。意味を変える編集を行う文書から、順に新しい形へ移す。日付による期限は設けない。

## R2 を外した

R2（修正の巡の後に、Changer 以外の役へ差分と記録だけを渡して why を再構成させる段）と、深さの表の「確かめ」の行は、2026-10-19 から止めていたものを 2026-10-22 に仕組みごと外した。

- 外したもの: 提出の準備の R2、その結果を qa に書く段と書き直し（`idd r2-record`）、R2 の結果で push と取り込みを止める関所と「それでも push する」、手で回す `idd r2`、`config/roles.yaml` の `pipeline.r2` と R2 の役、深さを持つ lane の確かめの巡、Harness が実装役に渡していた R2 の決まり（`R2: PENDING` と書く）、validator の R2 の滞留の警告。
- `pipeline.r2` を書いた設定は、読み込みで止まる（何を消せばよいかを言う）。
- 過去の lane の台帳に残る R2 の event（`s3_r2_started` など）と確かめの判定は、状態の導出が引き続き読む。R2 の結果は提出前確認の card に出さず、push と取り込みを止めない。過去の Round の R2 の欄は書き換えない。
- Risk High の手の変更の確かめは、変更した役とは別の役の独立したレビューと qa の Round で行う（`workflow.md` の「lane の外の手の変更」）。

## 深さのある review の宣言

`config/roles.yaml` の `pipeline` に、次の 2 つの宣言が要る。どちらも、深さのある review が走らせる段なので、無い設定では起動が止まる。

- `pipeline.spec_check`（仕様の照合）。無いと、深さを持つ回の起動が「`spec_check` がありません」と言って失敗する（F-223-12）。段の数は深さの表だけで決まるので、宣言を足しても本数は変わらず、宣言を消して 0 本にもできない。例は `config/roles.example.yaml` の `spec_check` と `spec-reviewer`。
- `pipeline.shape_judge`（形の判断、IDD-252）。無いと、深さ deep の計画の査読が「`shape_judge` がありません」と言って起動の前に止まる。巡が止まった card の側は、宣言が無くても lane を止めず、推奨の無い今までの答えで動く（走らなかった事実は記録に残る）。役 `shape-judge`（`report: shape`）の model は実装役と別の系統にする。例は `config/roles.example.yaml` の `shape_judge` と `shape-judge`。

既存の深さの挙動は変えない。標準と浅い lane の計画の査読は、形の判断を走らせない。

## 切り替えの記録

| 段 | 内容 | 状態 |
|---|---|---|
| 0 | 移行の道具（validator、写しを描く機構、DEC の変換）を lane で作り、変換と Purpose の束ね方は chat から直接行い、口を通して記録する | 済み（2026-10-14、変換を再実行して lane の記録も足した） |
| 1 | 新しい規約と validator を別の置き場で動かし、既存の記録を移した結果に対して検査が通ることを確かめる | 済み（`idd intent check`） |
| 2 | 写しを描き、`_docs/intent/` を Purpose ごとのファイルに置き換える。旧い decision.md は archive へ | 済み |
| 3 | brief の文面、skills、Harness の報告の口を新しい語に替える | 2026-10-22 の hotfix で残りを揃えた |
| 4 | 旧い規約を外し、取り込みを再開する | 2026-10-22 の hotfix で規約を新しい形に差し替えた（旧い形を受け入れる検査は残す） |
| 5 | 最初の数 lane は、Judge の判定の結果を人が見て、基準を直す | 続いている（守られたかの確かめ（R2）は 2026-10-22 に外した） |
