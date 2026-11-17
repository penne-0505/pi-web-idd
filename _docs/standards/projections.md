# 写しの形式

正は Harness の状態にある。写しは Harness が状態から決定論で描く。手で直さない。直したものは次の描き直しで消える。写しは Changer が編集しない面にだけ描く。記録の形は `records.md` にある。

## 種類と置き場

| 種類 | 描く面 | 既定 | 実装 |
|---|---|---|---|
| A. overlay の markdown | work の tree の `_docs/intent/` | ON | 描く |
| B. 公開 docs | upstream の `docs/intent/`。export のときに描き、import のときに剥がす | OFF | 未実装（設定で選べるが描かない） |
| C. コードコメント | upstream の code。export のときに描き、import のときに剥がす | OFF（定義だけ置く） | 未実装（設定で選べるが描かない） |

全 repo は work と upstream の 2 層である（propter 自身も含む。今 1 層に見えるのは 2 層の体制を作っている途中だから）。B と C は常に「export で描き、import で剥がす」の 1 形式。B の既定が OFF なのは、理由を描いた docs は伝わりやすく書いても独特の書き方になり、先方の読み手にとって望まれるとは限らないため。ON にするのは repo ごとに人が決める。

## A: overlay の markdown

```text
_docs/intent/<project>/P-<n>.md     Purpose 1 つと、連なる Choice 全部
_docs/intent/<project>/PRJ-<n>.md   Project 1 つ（欄・本文・決定・属す Issue。形は `project.md`）
_docs/intent/<project>/overview.md  概要（P-1 の statement）・組まれ方（root の Choice）・Purpose の一覧（Project があれば Project の一覧も）
_docs/intent/<project>/index.md     Place → Choice の逆引き
```

`<project>` は repo の登録名（`config/repos.yaml` の `name`）である。

- **いつ描くか**: lane の取り込み（本流への merge commit を作るとき）に、Harness が状態から描き直して同じ commit に入れる。写しどうしの衝突は描き直しで解き、lane を差し戻さない。手元で描くときは `idd intent draw`。
- 各ファイルの 1 行目に「状態から描いた写し」の印を置く。印のあるファイルが描き直した結果と違えば、記録の検査（`idd intent check` の projection の規則）が「写しが直されている」と報告する。
- Purpose のファイルは、`# <P-id>: <statement>`、name・origin・status、続いて Choice の節。Choice の節は `## <id>: <forms.chosen>` の見出しに、欄をこの順で: Place、Why、Why not（箇条書き。form と理由。無ければ no_why_not の理由）、Anchored、Free、Revisit、origin と visibility、history。What の説明が入る場所を作らない。superseded と dropped の Choice は末尾に移し、見出しに superseded と後継の id を添える。
- Project のファイルは、`# <PRJ-id>: <name>`、Purpose・state・done when、続いて「本文」「決定」「Issue」の節。本文は改行を保ち、`#` で始まる行はエスケープする。Choice に移した決定は、見出しに移し先を添え、移し先の status と「本文は移し先にある」の 1 行だけを置く。Project が無い repo には描かない。
- index.md は module ごとに、その module を Place に持つ有効な Choice の id と forms.chosen を並べ、file の印があれば添える。
- overview.md は上から概要（最上位の常設 Purpose の statement）、組まれ方（root の Choice）、Purpose の一覧の 3 節。Project が 1 つ以上あるときだけ、末尾に Project の一覧の節が付く。
- 旧い形の `decision.md` は移行で `_docs/archives/intent/` に移した。`_docs/intent/` に手で文書を足さない。

## B: 公開 docs（未実装）

visibility が public の Purpose と、その下の public な Choice だけを描く。ID は残す。origin と history は落とし、Place は path だけにする。欄の名前は「選んだ形」「理由」「捨てた形」「守るもの」「変えてよい範囲」とし、IDD と propter の語（Choice、Waive、Place など）を出さない。

- 置き場は常に専用のファイル `docs/intent/<purpose-slug>.md`。README には描かない（印を置くことになるため）。読み手が辿れるように README に素の 1 行（「設計上の判断と理由は docs/intent/ にあります」など）を足すかは repo の設定で、普通の文なので印は要らない。
- 剥がすときは C と同じく、描いた本文と現物を照合する。ファイルが一致すれば消し、1 行が一致すれば消す。upstream で直されていれば報告し、人が決める。
- public は export の前までは候補である。export のときに、public の Purpose と Choice の一覧を人に見せ、承認されたものだけを描く。Issue の本文や PR の本文と同じ、対外境界の人のゲート。

## C: コードコメント（未実装、当面 OFF）

- public で、Place が file の印と symbols を持つ Choice だけ。symbol の直前に、その言語の普通の doc comment として描く。行の頭は `Why:`、`Why not:`、`Free:`。道具の名前、ID、印を出さない。
- Harness は描いた本文を状態に持ち、import のときに同じ本文を探して消す。本文が直されていれば「写しが直されている」と報告し、人が Choice を直すか捨てるかを決める。
- B を先に作る。コメントが欲しい repo が出たら着手する。

## Waive の trailer（未実装）

Harness の口に届かない環境（upstream の clone での直接の修正など）のための代替として決めた形である。普段の Waive は口で宣言し、trailer は書かない。

```text
Waive: applied C-094-1
Waive: no-choice 依存の版上げだけで分岐は無い
```

次に Harness が読んだとき、trailer を状態に backfill する、という形で決めたが、読み取りと backfill は未実装である。それまでは、lane の外の手の変更は qa の Round の Waive 欄に書く（`document_contracts.md` の qa）。trailer は upstream には出さない。export で commit を作り直すときも squash の message に載せない。

## repo ごとの設定

`config/repos.yaml` の repo の `intent` に、描く写しの種類（`projections`: A / B / C の一覧。既定は `[A]`。空の一覧は何も描かない）と、本文に visibility の無い Choice が取る値（`visibility_default`: private / public、既定 private）を持つ。B の README への 1 行の有無の設定は未実装である。
