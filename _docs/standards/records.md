# Intent Record の仕様

語は `principle.md` の 1 に従う。この文書は Intent Record の形を決める。正は Harness の状態にあり、repo に描く写しの形は `projections.md`、記録を書く時と順は `workflow.md` にある。

## 単位

Intent Record は **Purpose** と **Choice** の 2 種類からなる。Purpose は何を達成したいかであり、Choice はなぜこの形にしたかである。Choice は必ず 1 つの Purpose に連なる。連ならない Choice は残さない。

Issue より大きい作業のまとまりは **Project** で、同じ正本に置く。Project は 1 つの Purpose を指し、決定を持ち、決定は Place が決まったら Choice に移る。欄と扱いは `project.md` にある。

旧い形の DEC と INV は、移行で Choice に移した（`migration.md`）。DEC は Choice になり、INV は親の Choice の anchored に畳んだ。新しく DEC と INV を立てることはない。

## Purpose

| 欄 | 内容 |
|---|---|
| id | `P-<n>`。Harness が振る。自動で振る番号は `P-2` 以降で、`P-1` は概要の席（下） |
| statement | 何を達成したいか。「X をしたい。なぜなら Y だから。」の形で 1〜3 文。非目的は「Z はしたくない。なぜなら W だから。」 |
| name | 任意。一覧と card の 1 行に出す取っ手（15 字前後の名詞句）。lane の案には付けず、人が確かめるときに付ける |
| origin | 出どころ。idea の文書 / 人が書いた Issue / 先方のチームの Issue / 常設 / 計画役の案 / 移行時の割り当て |
| status | proposed / active / retired。proposed は lane が出した案で、人が確かめるまで Choice を連ねられない。retired には Grounds を添える |

### want の書き方

Purpose の want は、成果物を使う者（人か agent）が何をできるか・どうなるかで書く。want は statement の「X をしたい」の部分である。判定の問いは 2 つ: 「この文の主語は使う者か」「成果物の性質（一致する・無い・同じ）を述べていないか」。成果物の性質は want に書かず、Choice の守る形（`anchored`）に降ろす。

理由: want は Choice が連なる先である。後から変える agent は Choice の why を Purpose に照らして、その変更が許されるかを決める。want に成果物の性質を書くと want が判定条件になり、本当の目的は「なぜなら」の側に隠れる。すると手段を目的に反すると読む変更（本物の題に合わせて省略を足すなど）が正しくなる。

### 出どころと立ち方

| 出どころ | 立ち方 | 人の確認 |
|---|---|---|
| idea の文書 | 凍結した目的・ゴール・非ゴールがそのまま Purpose になる | 済み（idea のゲート） |
| 人が直接書いた Issue | 本文が Purpose の文。既存に当たるものを先に引き、無ければ本文から起こす | 不要 |
| レビューや Harness の検出から立った Issue | 計画役が既存の Purpose から選ぶ。無ければ案を書いて人に聞く | 新しく立てるときだけ |
| 先方のチームの Issue | チームの文が Purpose。origin は team | 不要 |
| 常設の Purpose（領域をまたぐ目的） | 人が一度書く。保守で生まれた Choice はここに連なる | 書くとき 1 回 |

概要の席（`P-1`）に座れるのは、人が `P-1` を名指して書いた文（`idd repo init --overview`、または `idd intent raise purpose --file` の JSON に `"id":"P-1"`）と、人が確かめた概要の案の文だけである。lane は id を名指せず、名指さない raise は `P-2` 以降を取るので、lane が立てた Purpose の案が概要になることはない。概要を持たない repo では、概要を人が書くまで写しは「概要の Purpose（P-1）がまだありません」を出し、blind には概要が渡らない。取り下げで席が空いた（`P-1` が active でも proposed でもない）ときは、`P-1` を purpose に持つ Choice の行が 1 本も無い場合に限り、人が `P-1` を名指して書き直せる。行は消さず、書き換えない。Choice が `P-1` を指していると、書き直しは断られる。結び付きが黙って新しい文に移るからである。

常設の Purpose のうち最上位のもの（`P-1`）が **概要** である。「この repo は何で、誰のための何か」を 1〜2 文で書く（例: 「IDD の開発フローを念頭に開発された並列実行性の高いエージェントハーネス」）。全 Choice は最終的にここに連なる。概要の statement を変える案は agent も出せる（`idd intent propose overview`）が、人の確認（card）を通してから効く。

計画役は、Purpose を「立てる」より先に「引く」（`idd intent purposes`、全文は `idd intent show <id>`）。合うものが無いときだけ案を出す（`idd intent raise purpose --file`）。案は proposed で立ち、GO の画面に並ぶ。GO がその確認を兼ねる。浅い lane は GO が自動だが、lane が立てた proposed の Purpose があるときは自動を止めて人に回す（`workflow.md` の「深さ」）。

### 先方のチームの Issue の Purpose は、チームの文と理由のまま立てる

先方のチームの Issue から Purpose を立てるときは、チームが書いた目的と理由を statement に写し、言い換えて自分の案にしない。origin は `team` である（`team / <Issue の識別子>` のように Issue を指す参照は続けてよい）。報告者の名前・機種・Slack の名前のような個人の識別子は、statement にも origin にも写さない。理由（なぜなら）がチームの文に無いときは、補わずに人に聞く。

理由: origin は「誰が言ったか」ではなく出どころの種類を指す欄である。そこに報告者や機種を写すと、後から読む人は出どころを推測する。statement から理由が抜けると、Choice の why を照らす先が無くなり、変える agent は守るべきものを推測で決める。この 2 つは機械では測れないので、記録の検査はこの規則を見ない（origin と statement が空でないことだけを見る）。計画役にはこの節を規約の束で渡す。

## Choice

| 欄 | 内容 | 必須 |
|---|---|---|
| id | `C-<lane か session の鍵>-<連番>`（下の「ID」） | Harness が振る |
| purpose | 連なる Purpose の id。active でなければならない | 必須 |
| forms.chosen | 選んだ形。捨てた形と並べて比べられる粒度の名詞句。題の欄は無い | 必須 |
| forms.rejected | 捨てた形の一覧。各項は form と、それが Purpose を満たさない理由（fails_because） | 1 つ以上。無ければ no_why_not |
| no_why_not | 捨てた形が思い当たらない理由。forms.rejected が空のときに要る | 条件つき |
| place | Reason が結び付く範囲の一覧（下の「Place」） | 1 つ以上 |
| why | 選んだ形が Purpose を満たす因果。出所（回答、指摘、AC の文面）だけを why にしない | 必須 |
| anchored | 守るべき性質。実装方式が変わっても破れない結果を文で | 必須 |
| free | why を保つ限り変えてよい方式・値・構造 | 任意。無ければ「why を保つ限り自由」 |
| revisit | 再検討してよくなる条件や証拠 | 任意 |
| question | 答えた質問の id。答えがこの Choice を決めたとき | 任意 |
| verification | この Choice の振る舞いが壊れたら赤くなるテストの名前か AC の id | 任意 |
| visibility | private / public。本文に無ければ repo の設定（`config/repos.yaml` の `intent.visibility_default`、既定 private）を取る。public は export まで候補である（`projections.md`） | Harness が入れる |
| origin | agent か human（答えた質問の id）、移行の出どころ | Harness が入れる |
| history | created / re-anchored / superseded の記録。各項は日時、誰が、Supersede なら Grounds と後継の id | Harness が入れる |
| status | active / unconfirmed / superseded / dropped。unconfirmed は移行で機械が移した Choice。dropped は unconfirmed を捨てたもの（Grounds を history に残し、本文は消さず、引く口には出さない）。捨てられるのは unconfirmed だけ | Harness が入れる |

agent が自分で書く欄は purpose、forms、no_why_not、place、why、anchored と、任意の free / revisit / question / verification である。取っ手（一覧、注入の 1 行目、card の表示）は forms.chosen と place から Harness が作る。

### 立てる口

Choice を立てる経路は Harness の口（CLI か decide API）だけである。写しの markdown を直接編集する経路は誰にも無い（`projections.md`）。

- **lane の計画役**: 口で直接立てず、計画の報告（`idd report plan` の intent-impact）の `choices` に草案として乗せる。触る Place の既存の Choice への処置は同じ報告の `existing` に 1 件ずつ書く。草案は GO の後に Harness が列に書く。GO の前に列には書かない。
- **lane の実装役**: 変更の中で口から立てる（`idd intent raise choice --file F.json`）。lane の id は環境から読まれる。
- **chat のセッションと人**: 同じ口を `--session <id>` で使う。
- **root の Choice**: lane からは直接変えない。`idd intent propose root-supersede|root-reanchor` で案を出し、人の確認（card）を通してから効く。全 lane の前提が変わるためである。

lane が書いた行は、その lane が本流に着地した時に全体に効く。着地の前は、その lane だけが読む。

## Place

Place は module と root の 2 つの形を持つ。

| 形 | 書き方 | 届け方 |
|---|---|---|
| module | file の親の dir。末尾に `/` を付ける（repo の root 直下は `/`）。印として、書いたときに相手にした file（`file`）と、関数・クラス・定数の名前（`symbols`）を添えてよい | file の印がある Choice は、その file を開いた・変えた瞬間に本文が差し込まれる。同じ module の別の file では見出しの 1 行だけが届く。file の印の無い module の Choice（dir 自体の Choice）は、その下の file を作る・変える瞬間に届き、開くだけでは届かない。symbols があれば edit の当たりを絞る |
| root | `/`。全体にかかる | 差し込まない。組まれ方として扱う（`workflow.md` の「誰が何を読むか」） |

- module を正本にするのは、file の rename・分割・移動の後も module が残り、Choice が統治する code に届き続けるためである。印が立たなくなった Choice は保守の印が付くだけで、欠陥ではない。印が多い Choice の一覧行には「Re-anchor の候補」と付く。
- 旧い形の `file` と `dir` は今も受け付け、それが指す module として読む（`file` は親の dir の module と file の印、`dir` はその dir の module）。
- 「無いこと」の Choice（例: このサービスにキャッシュ層を置かない）は、置くなら置く module（dir）に付ける。それも決まらないなら root。file の印を付けない。
- symbols を必須にしない。
- import の検出（触った file が使う module の Choice を届けること）は行わない。

## 旧い形を残す変更

旧い形を残した変更（橋渡し・迂回・互換の分岐を残す、症状だけを消す、など）は、応急処置として Choice に記録する（`solving.md` の P7・R9）。記録の種類は増やさず、Waive の種類も足さない。応急処置は「今は契約を満たすが原因は残る」変更で、守るのは契約と不変条件だけという原則（P5）と並べて読める。

| 欄 | 応急処置での書き方 |
|---|---|
| forms.chosen | 残す形の名詞句。「〜の解決」「〜の修正」と呼ばず、応急処置であることが読める語にする |
| forms.rejected | 本来の直し方と、今それを取らない理由（fails_because） |
| place | 旧い形を残した範囲 |
| why | 今そうしない理由。残さない場合の害と、残した場合に原因が残ることの因果 |
| anchored | 残す範囲の境界（広げない）と、残しても守る契約・不変条件 |
| revisit | 本来の直し方を起こした後続の Issue。その Issue が閉じたとき、この Choice を Supersede する |

- 後続の Issue は `idd out draft --kind gh-issue` で案として起こす。外への投稿は人の署名が要るので、投稿は人が承認したときだけ起きる（役は投稿しない）。案を出す時は、巡の途中でも提出の前でもよい。
- 案の本文への R9 の記録は、記録の形が docs の lane の記録先である。形が state の lane は R9 の記録を Choice に持ち、revisit が案を指せばよい（案の本文に重ねて求めない）。
- 記録の無い応急処置は、計画の査読・差分のレビュー・判定が `solving.md` の P 番号を理由に差し戻す。「Choice は立てたが、残す範囲・本来の直し方・今そうしない理由が読めない」ものも同じである。
- 台帳の古い記録を読む分岐は契約側（P5）で、応急処置ではない。

## 書かないもの、立てる判定

- What と How の言い換え、確かめた事実、作業指示は Intent Record に書かない。事実は reference / survey へ、作業指示は plan へ（`work.md`）。
- Choice を立てる判定は「Why not が書けるか」である。Changer が手を伸ばしそうな別の形が一つも無いなら、それは選択ではなく What の言い換えか Free であり、立てない。Choice が 0 個の変更があってよい。
- 1 つの Choice は 1 つの選択を持つ。複数の選択を 1 つに畳まない。

知識の分け方:

| 種類 | 例 | 行き先 |
| --- | --- | --- |
| why の成分 | 「LINEAR を保つのは base sampling を byte-identical にするため」 | Choice の why / free |
| 判断の履歴 | 日付・置き換え・付け替えの経緯 | Choice の history（Harness が入れる）/ revisit |
| 確かめた事実 | 「compaction は 6 本で 1 回も起きていない」など、ある時点で測って確かめた事実 | `_docs/survey/` か lane の reference |
| 純粋な how | 「mip も再生成する」などコードの言い換え | 記録しない（agent はコードから再構成できる） |
| 耐久的な機構の解説 | 繰り返し参照される仕様的な説明（稀） | `_docs/reference/` |

融合した記述を分ける問い: **「コードを消して書き直したら失われる情報か？」** 失われるなら why（Choice へ）。コードから再導出できるなら how（記録しない）。

## INV を立てない

守る性質は Choice の anchored に文で書く。INV の番号を新しく作らない。anchored・why・free に `INV-…` の番号を振らない。

移行で親の Choice の anchored に畳まれた INV は、`INV-099-7: …` のような行として anchored の中に残っている。それを引くときは、その行を持つ Choice の id で指す（例: 「DEC-121-5 の anchored」）。親の無い INV は、`INV-…` の id のまま Choice として移した（`migration.md`）。その id は Choice の id として引いてよい。

理由: INV の番号は、DEC の下に INV を立てる旧い形の名残である。新しい番号を作ると、読み手は存在しない INV の記録を探し、Choice の単位が崩れる。

## Waive

Waive は変更に付き、Choice には付かない。変更ごとに、Intent Record を書かない理由を次のどちらかで宣言する。

| 種類 | 意味 | 口 |
|---|---|---|
| applied | 既存の Choice の適用で説明が閉じる | `idd intent waive --kind applied --choice <id>`（複数可） |
| no-choice | この変更に選択は無かった | `idd intent waive --kind no-choice --reason <理由>` |

- 「Choice は立てたが、捨てた形が思い当たらない」は Waive ではなく、その Choice の no_why_not 欄に理由を書く。
- 無言の省略は認めない。旧い形を残す変更は、Waive ではなく Choice で記録する（上の「旧い形を残す変更」）。lane の宣言の単位は巡で、巡（結果の報告まで）ごとに、その lane の Choice の記録（立てる・Re-anchor・Supersede）か Waive が 1 つ以上要る（`checks.md`）。chat のセッションからの変更は、同じ口へ 1 変更ごとに宣言する。
- lane の外で手で変え、口を使わなかった変更（hotfix など）は、qa の Round の **Waive** 欄と **Choice** 欄に同じ形で書く（`document_contracts.md` の qa）。
- 口に届かない環境（upstream の clone での直接の修正など）のための commit message の trailer（`projections.md` の「Waive の trailer」）は未実装である。

## Supersede と Re-anchor

- **Supersede**: Purpose が変わったとき。新しい Choice を立て（`idd intent supersede`、Grounds が要る）、古い Choice の history に superseded（Grounds つき、後継の id つき）を足し、status を superseded にする。古い本文は消さない。新しい Choice には、古い Choice のうち今も守る anchored を含める。
- **Re-anchor**: Purpose と Reason を保ったまま Anchored 部の形が変わったとき。同じ Choice の place と anchored を書き直し（`idd intent reanchor`）、history に re-anchored を足す。id は変えない。
- **unconfirmed の処置**: 確認（`idd intent confirm`）、捨てる（`idd intent drop --grounds`）、Supersede のどれか。捨てる Grounds は「移行時の記録で現物と合わない」で足りる。
- Free 部だけの変更は Intent Record を変えない。Waive の applied で足りる。

## ID

- Purpose は `P-<n>`。Choice は `C-<鍵>-<連番>`。鍵は lane なら `IDD-<n>` の数字（`C-184-1`）、chat のセッションならセッションの id（`C-claude-desktop-supervisor-20261018-8`）。repo の中で一意。Purpose の id は Harness が振る。例外は概要の席 `P-1` で、人が名指して書ける（上の「Purpose」）。Choice の id は Harness だけが振り、手書きの形は無い。
- 移行した Choice は、元の `DEC-<n>`・`DEC-<lane>-<n>`・`DEC-<Area>-<n>`、親の無い INV の `INV-…` を id のまま持つ。新しく立てるものは `C-` だけである。
- ID は丸ごと 1 語として読み、短い ID を長い ID の一部に当てない。

## コードとの結び付き

- 意図とコードの対応は Choice の place に書く。コードに統治用のポインタ（`// intent: DEC-xxx`・`// intent-invariant: INV-xxx`・`Covers AC-xxx` の形で、記録へ案内するコメント）を置かない。`validate-comments` の overlay の型は、この形だけを検査する。
- 散文のコメントや JSDoc の可否、その中で記録の ID に触れてよいかは、出力面（その repo のコード）の規約に従い、IDD の規範で上書きしない。
- 製品として IDD の記録を扱う parser・型・生成する文面の文字列は、ここで言う ID の記述ではない。
- コードの契約を自然言語で言い直しただけの文書は残さない。コードを読めばよいためである。
