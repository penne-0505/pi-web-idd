# 仕事の記録（運用記録）

Intent Record 以外の、Harness が仕事を回すために持つ記録。Reason の代わりにしない。文書の置き場と frontmatter は `document_contracts.md` にあり、ここでは記録の中身を決める。

## 仕事の単位

1 件の仕事は、Issue を取り込んだ lane である。lane の行（state の backlog）と、段の進みの台帳（lifecycle）が持つ。状態は起票済み / 計画中 / GO 待ち / 実装中 / レビュー中 / 提出待ち / 済み / 見送りに読める。思いつきは idea 側で、仕事にはならない。

- 画面の方針（datamodel の 12 欄の WorkItem）は GUI の線で作り直している途中で、この文書の外にある。仕事の単位に連なる Purpose の id の欄は未実装で、今は lane の Choice が Purpose に連なる。
- lane の外の手の仕事（hotfix、記録の整理など）は、repo の `TODO.md` の task で持つ。`TODO.md` の書式は repo の TODO の Schema 節に従う。

## 受け入れ条件（AC）

この変更で Purpose が満たされたと言える条件。task の側の記録であり、Reason ではない。lane の qa.md の Acceptance Criteria の節に置く。

| 欄 | 内容 |
|---|---|
| id | `AC-<3 桁>`（qa.md の中で一意） |
| 本文 | 満たすべき条件を 1 文で |
| check | unit / validator / manual / diff-review のどれで確かめるか（qa.md の Checks） |
| status | planned / covered / verified / deferred（理由つき）/ not-applicable |
| evidence | verified にするときの証拠。テストの名前か、実行した命令と結果 |

- 計画役が Issue と Purpose から書く。依頼を書く lane では、依頼の完了の形（`brief.md`）の床から展開する（今は計画役が qa.md に書く。Harness が床から機械で展開する形は未実装）。計画役は床に無い AC を足して表を膨らませない。
- 実装役は報告（`idd report progress` / `idd report result`）で status と evidence を送る。status と evidence は Harness の状態（work の列）に溜まり、qa.md の AC と Checks は書き換えない。evidence の無い verified は確認済みに数えない。
- 主な経路の AC 未達は Purpose 未達として must、まれな分岐の AC 未達は should（`workflow.md` の「判定の基準」）。
- 完了の報告は、`solving.md` の R5 のとおり、残した旧い形と互換の分岐を列挙し、その一つひとつが記録された応急処置か、`config/repos.yaml` の `contracts` に宣言された契約を守る互換かを AC と evidence で示す。どちらでもないものが残っていれば完了ではない。報告の欄は足さない。旧い形を置き換える変更では、旧い形を消した確認（旧い経路を指す名前や分岐が残っていないことを調べた命令と結果）を、その AC の evidence に含める。残した旧い形があれば、応急処置として記録した Choice の id（docs 形式の lane は、後続の Issue の案を出した旨と、その案を書いた `side_findings` の足跡）を報告に書く（`records.md` の「旧い形を残す変更」）。
- 全体の行（列挙では満たせない 1 文と、実装役以外の判定者）は AC の番号を持たず、床の AC の前に置く。全体は実装役の自己申告で満たしたとしない。

1 lane に 3〜6 行が目安で、10 行を超えるなら責務が複数混ざっているので、粒度（`granularity.md`）を疑う。AC の文は次の 3 つを満たす（2026-10-15）。

- 境界で観測できる振る舞い（出力・記録・応答）で書く。関数名や内部の構造を主語にしない。
- 別のテストの書き方をした 2 つの実装が両方満たせる。満たせないならテストの写しなので AC にしない。**テストを見れば自明なこと（断り方の文言、終了コード、JSON の欄、冪等の確かめ方、文字列の有無）は AC に書かない。** Choice が code の写しを持たないのと同じ理由である。
- 失敗したら Purpose が満たされないと言える。リファクタで壊れる AC は AC ではない。

evidence は多対多でよい。1 つの AC に複数のテスト名、1 つのテストが複数の AC の証拠になる。1 AC = 1 テスト名の対応を求めない。AC に無い端の事例を実装役が自分のテストに足すのは Free で、AC の網羅をテストの上限にしない。

### 害の防ぎの置き場

害を見つけてその防ぎを決めるときは、防ぎの性質で置き場を選ぶ。AC の文を足すのは、防ぎが境界で外から観測できる状態のときだけである。

- 外から観測できる状態（出力・記録・応答）は、AC に状態の文で書く。
- 実装方式が変わっても破れない結果は、Choice の anchored に書く。
- why を保つ範囲の選択（作り方・分け方・順序）は、Choice の free か実装役の裁量に置く。

how や内部の構造を AC に足すと、別の作り方をした正しい実装が落ちる。AC は実装役が書き換えない完了の条件なので、防ぎを AC の文へ足し続けて 1 行を膨らませない。

## 検証ログ

段ごとの検証の記録。1 項は、日時、段（計画 / 実装 / レビュー / 検査 / 取り込み）、実行した命令と結果、AC の進み、Verdict、誰が。PARTIAL / FAIL / BLOCKED には残る危険と次の手を書く。過去の項を結果に合わせて書き換えない。

| Verdict | 意味 |
| --- | --- |
| `PASS` | AC が確かめられ、完了扱いにできる |
| `PARTIAL` | 一部未確認だが、残る危険と次の手が明示され、限定的に完了扱いにできる |
| `FAIL` | 必須の条件を満たしていない。完了にできない |
| `BLOCKED` | 外の要因で検証できない。完了にできない |

- **lane**: Harness が台帳（lifecycle と work の列）から導いて持ち、repo には commit しない。Work 画面の詳細で読む。lane は qa.md に Round を書かない。旧い形の qa の Round の後継で、Intent Delta と R2 の欄は持たない（Choice の記録か Waive が代わる。R2 は 2026-10-22 に外した）。
- **lane の外の手の変更**: 台帳に段が無いので、qa の Round として repo に書く（`_docs/qa/<Area>/maintenance.md` か slug の qa.md）。欄は Commands・AC Coverage・Risk・Choice か Waive・Verdict で、形は `document_contracts.md` の qa にある。

## 場所に付いた指摘

Judge が「仕事にしない。場所に付ける」と判定した should と、「事実上起きない」の指摘。Harness の状態（work の列）に持ち、`TODO.md` には書かない。

| 欄 | 内容 |
|---|---|
| place | path と行の範囲 |
| severity | should / nit |
| claim | 本質 1 文と根拠 |
| from | 出た lane と巡 |
| status | open / dropped |

次にその Place を触る lane の計画役に渡る（`<open-findings>`。引き直しは `idd work findings <path>...`）。計画役はその lane で「直す」（fix）か「直さない」（drop。理由が要る）のどちらかにする義務を持ち、処置の無い計画の報告は engine が断る。「直す」と申告しただけでは閉じず、指す行が本流で書き換わったときに閉じる。行が全部無くなった指摘は dropped になる。放置は認めない。

## 作業指示と確かめた事実

- **作業指示**（plan）: 計画役が実装役に渡す依頼。中身の形は `brief.md`（依頼 / 意図 / 重要なコンテクスト / 裁量 / 完了の形 / 戻す条件。how は書かない）。実装役と計画の査読が読む。取り込みの前に archive へ移す。恒久の記録から指さない。
- **lane のコンテクスト**（context）: 知らないと実装役が間違った方向に進む事実を 1 本の文書に持つ（`brief.md` の「重要なコンテクスト」）。計画役が書き、実装役が追記する。lane の恒久の記録で、archive へ移さない。
- **確かめた事実**（reference / survey）: ある時点で測って確かめたこと。出典（path:行、命令、URL）を付ける。why を書かない。古くなったら新しく書き、古い方を superseded にする。Choice の why が事実を根拠にするときは、その事実を引く。

## 概要と害の例

- **概要**: 「この repo は何で、誰のための何か」の 1〜2 文。最上位の常設 Purpose（`P-1`）の statement そのもので、別の入れ物を持たない（`records.md` の「Purpose」）。差分のレビュー役（blind と最後のレビュー）に渡す（ドメインの読み違いを防ぎ、特定の指摘への先入観にはならない）。計画役と実装役は写しの overview.md で読める。
- **組まれ方**: root の Choice（例: 4 層で依存は下向きだけ、状態は engine が持ち `_docs/intent/` は写し）。overview.md の 2 節目。差分のレビュー役には渡さない。組まれ方への違反を見ていた守られたかの確かめ（R2）は 2026-10-22 に外したので、今は組まれ方を受け取って見る役が無い。計画役と実装役に作業の最初に渡す機構も未実装である。
- **害の例**: その repo で何が害で、どの重さかの具体例（例: lane の失敗が tick を止めて他の lane を巻き込む → 害 3。一覧の表示が崩れるだけ → 害 1）と、頻度に関わらず must にする条件。2 か所から読む。人が `config/repos.yaml` の `harm_examples` に書いたものと、Judge の案を人が card で取り込んだもの（Harness の状態）。engine は宣言の YAML に書き戻さない。repo の risk の宣言（`workflow.md` の「repo の risk の宣言」）と同じ口（`idd intent risk`）から読める。Judge にだけ渡す。

3 つとも「agent が案を出し、人の確認で効く」。概要は Purpose の規則（`idd intent propose overview`）、組まれ方は root の Choice の規則（`idd intent propose root-supersede|root-reanchor`）、害の例は案（`idd intent propose harm`）を人が card で取り込む。Judge が自分で書き足すことは認めない（測られる側が物差しを動かすことになる）。確認は 3 つとも card で行い、Work 画面には置かない（Work は見る場所で、そこで操作しないと影響が出るものを置かない）。
