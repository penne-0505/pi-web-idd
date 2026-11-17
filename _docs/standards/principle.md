# IDD と propter の原則

この文書は規約の土台である。語と事実、IDD の核、propter がすることを決める。ほかの規約の文書と読む順は `workflow.md` の「規約の構成」にある。3 の各項のうち、実装と食い違う所はその項に注記し、詳細はその節を持つ文書に書く。

## 1. 前提

### 語

- code
  - repo に入っていて、実行・検査する全てのファイル。設定、テスト、生成物を含む
- What
  - code が何であるか。構造、値、入出力。code により自明
- How
  - code がどう動くか。手順、仕組み。code により自明
- Changer
  - code を変える者。agent も人も含む
- Purpose
  - 何を達成したいか。人間の内発的な動機に根を持つ意図
- Choice
  - なぜこの形にしたか。人でも agent でも持てる意図。必ずいずれかの Purpose に連なる
- Reason
  - ある What / How がそれである理由。code により自明とは言えない。二つの側を持つ
  - Why
    - Reason の選んだ側。なぜこの形か
  - Why not
    - Reason の捨てた側。次の二つを含む
    - Changer が最も手を伸ばしそうな別の形と、それが Purpose を満たさない理由
    - 選択肢には存在したが採用しなかった別の形と、それが Purpose を満たさない理由
- Intent Record
  - Reason と、それを引くために付随するもの
- Place
  - code の中で Reason が結び付く範囲。ファイル、ディレクトリ、root（全体）の 3 段
  - 実装では、ファイルとディレクトリを module（ファイルの親の dir）に畳み、書いたときに相手にしたファイルを module の印として持つ。module と root の 2 つの形である（`records.md` の「Place」）
  - Anchored
    - Place の中で、Reason に裏付けられた実装部
  - Free
    - Place の中で、Reason の及ばない実装部
- Grounds
  - Changer が Purpose を変えるときに示す、新しい Purpose との関係
- Supersede
  - Purpose が変わったので、Grounds を示して Choice を置き換えること
- Re-anchor
  - Purpose と Reason は保ったまま、Anchored 部の形を変え、結び付けを書き直すこと
- Waive
  - code の変更時に、Reason の全部または一部（Why not）を書かないことを、理由つきで宣言すること
- Judge
  - Reason を渡された上で、指摘や変更が Purpose に沿うかを判定する役。agent が担う
- Independent Reviewer
  - Reason を渡されず、差分だけを読んで指摘する役。agent が担う
- Harness
  - ここでは、agent を動かし Intent Record を管理して届ける道具のこと。propter はその一つ

### 事実

- code が残すのは What と How だけである。
- Reason は、書き手の context が消えると一緒に失われる。人なら忘却、agent なら session の終わりである。書き手とは、その Place を以前に変えた者である。
- Purpose は、動機を持つ者（人間）の内側にあり、他者は推測できても知ることはできない。agent にとっても、人対人でも同じである。
- code だけを見ても、Anchored と Free は区別できない。
- Anchored と Free は二値ではなく勾配である。1 行、1 構文、1 関数のどの単位でも、Anchored らしさと Free らしさが同時に存在しうる。境界は行の範囲では決まらず、Reason から判断するしかない。

## 2. IDD の核

IDD（intent driven development）は、code には残らない Reason を主軸に行う開発手法である。専用の Harness が無くても、editor と git だけで実践できる。この節には、Harness 無しで守れる特徴だけを置く。

- **Reason は Place に結び付けて残す。** Reason が読まれるのは、その Place を開いたときである。Place を持たない Reason は読まれず、読まれない Intent Record は無いのと同じであるためである。全体にかかる Reason は root に結び付く。
- **Reason は Why と Why not の対で書く。** Why だけでは、何に対して選んだのかが分からない。Why not が無いと、Changer は同じ別案を再び試し、同じ失敗を繰り返す。Why not は書き手が迷った履歴だけではなく、読み手が試しそうな案を含む。Why not が一つも書けない Choice は、選択ではなく What の言い換えか Free であることを疑う。
- **Anchored と Free を分けて書く。** 区別が無いと、Changer は全部を守るか全部を壊すかしかできない。Anchored に印を付けることで、Free は自由に変えてよいと分かるためである。IDD は「変えるな」の台帳ではなく、変えてよい範囲を示すものである。
- **Choice は、必ず Purpose に連ねる。** 連ならない Choice は残さない。Purpose が変わったときに、どの Choice が変わるべきかを辿るためである。Choice は Purpose の実践として尊重されるが、Choice そのものが絶対なのではない。
- **Changer は、変える前に Reason を知り、出口を選ぶ。** Purpose が変わったなら Supersede する。Purpose を保ったまま Anchored 部の形を変えるなら Re-anchor する。Free 部だけを変えるなら、通常の変更として行う。人間のプログラマが「なぜこうなっているか」を考えながら直すのと同じことを、agent を含むすべての Changer が行う。境界に確証が無いときは Anchored 側に倒す。
- **書くのは、変える時である。** Reason が生まれる瞬間と変わる瞬間に書き、後からまとめて書かない。後からでは、その時の意図を確かには書けないためである。書かないときは、必ず Waive を宣言する。Waive は次の三つのいずれかである。
  - 既存の Reason の適用で説明が閉じる。
  - この変更に Choice は無かった（理由つき）。
  - Why not に当たる別の形が思い当たらない。
  無言の省略は検査できないが、宣言された Waive は後から確かめられるためである。
  実装では、前の二つを変更に付く Waive（applied と no-choice）として宣言し、三つ目は Choice の no_why_not の欄に理由を書く（`records.md` の「Waive」）。
- **規定された共通の規則で書く。** 書き手が人でも agent でも、model が変わっても、同じ質で残り、機械で引けるためである。Reason の役割は本来コードコメントが担ってきたものであり、IDD はその役割を共通の規則にし、置き場を code の外に移したものである。
- **code から読めるものは書かない。** What と How の言い換えは読む負担を増やし、code が変わると陳腐化する。確かめた事実は Reason ではないので、別の置き場を持つ。

以下は IDD に似ているが、IDD ではない。

- 「変えるな」の台帳
- 仕様書を起点にする開発
- 決定事項の一覧
- 変更の履歴
- 意図の全てを書くこと

書くのは、code のみでは導けない Reason だけである。

## 3. propter がすること

propter は IDD を念頭に開発された agent Harness である。IDD の効能を最大化するために、次のことをする。どれも 2 の規則を上書きしない。

- **形式を定め、検査する。** Intent Record の欄、Place の書き方、Waive の形を決め、機械で検査する。agent の振る舞いに左右されずに質を揃え、Intent Record を機械で引けるようにするためである。機械が検査するのは有無と形だけで、中身の質は Judge が見る。
- **変更の瞬間に届ける。** Changer が Place を開いた瞬間・変えた瞬間に、その Place の Reason を agent の context に差し込む。root の Reason は、作業の最初に 1 回渡す。Changer が読みに行くのを待っていては読まれないためである。（実装の注記: 開いた瞬間・変えた瞬間の差し込みは実装済み。root の Choice を作業の最初に渡す機構は未実装で、今は概要の文を差分のレビュー役に渡すだけである。`workflow.md` の「誰が何を読むか」）
- **書くべき時に書かせる。** 変更ごとに Intent Record への影響を宣言させ、Anchored 部を変えたときは知らせ、Purpose を決められない問いが出たときは聞かせる。「書くのは変える時」という規律を、agent にも守らせるためである。
- **人の判断を、要る所だけに運ぶ。** Purpose は人にしか無い。agent が Purpose を決められない所で人に聞き、答えを Intent Record に残す。次に同じ問いが出る場面では、Harness がその答えを先に届ける。問いが減るのは答えが届くからであって、聞くのを控えるからではない。判断の重さと頻度の基準は Judge に持たせ、人は基準で決められない所だけを見る。人の判断は希少であり、Purpose の担い手だからである。
- **読み手を分ける。** Reason を知る読み手は Purpose に沿って判定できるが、同じ理由で盲目になりうる。Independent Reviewer を必ず一つ残し、その指摘を Judge が受ける。
- **守られたかを確かめる。** 差分と Intent Record だけから Reason を再構成できるか、変更が既存の Reason を壊していないかを、Changer 以外の agent に検証させる。Intent Record の十分性は、Changer 自身には測れないためである。（実装の注記: 確かめる役は R2 として実装していたが、2026-10-19 に止め、2026-10-22 に仕組みごと外した。今の propter はこれを持たず、毎巡のレビューと Judge の判定で代えている。`workflow.md` の「守られたかの確かめ（外した）」）
- **正は Harness の状態で持ち、repo には写しを描く。** 検査と索引は Harness の状態に対して行い、人と他の tool は写しを読む。写しは code の version と一緒に動き、propter が無くても読める。これにより 2 の「Harness 無しで実践できる」を担保する。
- **写しは 3 種類に限り、Changer が編集しない面にだけ描く。** 種類は、overlay の markdown、公開 docs（root の README を含む）、コードコメントの 3 つで、いずれも repo ごとに切替できる。Reason は公開の可否の印を持つ。propter 管理下の repo は work と upstream の 2 層であり、公開 docs とコードコメントは export のときに upstream へ描き、import のときに剥がす。work の tree に写しを置かないのは、code が Changer の編集面であり、そこに置いた写しは本文として直されて正と食い違うためである。work と upstream が同じ tree の repo では、overlay の markdown だけを描く。（実装の注記: 今描くのは overlay の markdown だけである。公開 docs とコードコメントは設定で選べるが、描く機構は未実装。`projections.md`）
- **運用の記録を持ってよい。** 作業の記録、指摘、概要、害の例など、Intent Record の形式に収まらないものを、Harness が管理しやすい形で持つ。ただし、それらは Reason の代替ではない。
