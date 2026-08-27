---
title: 拡張 IDD UI の表示・操作の設計判断
status: active
intent_schema: 3
created_at: 2026-08-27
updated_at: 2026-08-27
references: []
related_issues: []
related_prs: []
---

<!-- Canonical path: _docs/intent/IddUi/components/decision.md -->

# 拡張 IDD UI の表示・操作の設計判断

## Context

`_meta/extended-idd-design/ui-findings.md` が wireframe と実装フェーズで確定した表示規約を持つ（後半が優先）。本文書はそれをコードに落とすときの判断を、コード側の anchor 付きで記録する。

全体を貫く原則は 2 つ。**UI の chrome を読ませない**（単語 / 値 / 単語 + 視覚要素の粒度で止め、どうしても読ませたいものは ⓘ に退避する）。**余白は暗黙的グルーピングであり装飾ではない**（群の中 4-8 / 情報ブロック間 12 / 情報 → 操作 24 / 別の面 48）。個々の DEC はこの 2 つの適用例が多い。

view / state 層の判断は `_docs/intent/IddUi/lib/decision.md`。

## Decisions

### DEC-620: 判断キューは一覧ではなく札束にする（1 画面 = 1 判断）

- **What**: Inbox は card を縦に並べず重ねる。前面の 1 枚だけが判断可能で、背後は最大 2 枚ぶんの厚みとして見える。残りは左の列に判断の種類だけを並べる。
- **Why**: card を縦に並べると、スクロールするたびに lane / project をまたぐ context switch が起きる。朝の判断は「今処理してほしいこと」に集中できる形が要る。厚みを最大 2 枚に留めるのは、枚数を数える対象ではなく「まだある / これで最後」の 2 値として見せるため。
- **Change freedom**: 厚みの枚数、器の寸法、めくる手段は自由。「前面の 1 枚だけが判断可能」だけが不変。
- **Why not**（一覧 + 折り畳み）: 畳んでも視界には残るため、context switch の頻度は下がらない。
- **Anchors**: `components/idd/InboxDeck.tsx`、`components/idd/InboxPanel.tsx`

### DEC-621: 軸は縦に統一する。次は下から、判断済みは手前へ抜ける

- **What**: 残りの列・背後の札・めくる操作をすべて縦方向に揃える。次の札は下から入り、前の札は上から入る。判断が済んだ札は手前（拡大）へ抜ける。矢印キーは上下左右とも受ける。
- **Why**: 軸が 2 つあると（重なりは下方向なのに操作は左右など）、どちらが進行方向か読めなくなる。判断済みを下へ落とすと下から来る次の札と衝突するため、抜ける向きだけ奥行きに逃がす。
- **Change freedom**: 距離・速さ・キーの割当は自由。「軸が 1 つであること」「入る向きと抜ける向きが衝突しないこと」だけが不変。
- **Anchors**: `components/idd/InboxDeck.tsx`、`app/globals.css`

### DEC-622: 残りの札は種類だけを、距離に応じた減衰で示す

- **What**: 左の列は判断の種類アイコンのみ。大きさと濃度が前面からの距離で指数減衰する（`17 + 17 × 0.55^d`、下限へ漸近）。題名は tip に退避する。
- **Why**: 必要なのは「次は質問か、差分確認か」であって「あと何枚か」ではない。減衰なら遠い札どうしの差が潰れ、20 件並んでも列が破綻せず前面付近だけが解像度を持つ。題名を出すと前面の札から目が逸れ、避けたかった context switch が起きる。
- **Change freedom**: 減衰率、下限、tip の内容は自由。「種類だけを示す」「距離が視覚量として出る」だけが不変。
- **Anchors**: `components/idd/InboxDeck.tsx`

### DEC-623: 記録中は焦点を動かさない

- **What**: 判断の記録中は、キー・ホイール・めくりボタン・目印の列をすべて無効にする。
- **Why**: 失敗は押した札の中に出る（DEC-627）。記録中にめくれると結果が視界から外れ、申告が届かない。
- **Change freedom**: 無効化の見せ方は自由。「記録が返るまで前面の札が変わらない」だけが不変。
- **Anchors**: `components/idd/InboxDeck.tsx`

### DEC-624: card の器を外から決め、上（識別 + 主題）/ 中（流れる）/ 下（操作）の 3 面に分ける

- **What**: 札束の中では card の高さを外から固定し（`clamp(400px, 60vh, 700px)`）、識別と主題を上に、操作を下に固定して、間だけをスクロールさせる。仕分けは部品側の目印（`__head` / `__hud`）で行い、card の書き方は変えない。
- **Why**: 高さを中身で決めると、めくるたびに枠も操作も動く。判断のあいだ常に要るのは「何の判断か」と「何を押せるか」で、読み進める対象は根拠・現物・操作対象だけ。余りの高さは情報 → 操作という既にある最大の切れ目に乗るので、群の内側を割らない。
- **Change freedom**: 器の寸法、面の見せ方、目印の実装は自由。「上下が固定で中だけが流れる」だけが不変。
- **Why not**（操作を marginTop:auto で底に貼る）: 余白が入力欄と確定ボタンの間に落ち、最も密着すべき群を割る。
- **Anchors**: `components/idd/primitives.tsx`（Card / CardFrame）、`components/idd/cards/parts.tsx`（Actions）

### DEC-625: 主題は識別に属する

- **What**: card の主題（質問 card なら質問文）は情報ブロックではなく識別側に置き、上の固定面に載せる。
- **Why**: 質問文が流れる側にあると、選択肢を選ぶ頃には何を聞かれているかが画面から消える。5 種の card のうち質問だけが主題を情報ブロックに持っていて非対称だった。
- **Change freedom**: 主題の見せ方は自由。「主題が判断のあいだ消えない」だけが不変。
- **Anchors**: `components/idd/cards/parts.tsx`（Subject）、`components/idd/cards/index.tsx`

### DEC-626: 自前の枠を持つブロックは自分の器と内側スクロールを持つ

- **What**: 差分と PR プレビューは高さの上限（220px）と内側スクロールを持ち、card 側のスクロールに巻き込まれない。差分の pane 見出しは sticky。
- **Why**: 枠を持つブロックが行の途中で切られると、枠の下辺が消えて次のブロックに貼り付いて見える（「詰まっている」の正体）。加えて、行数によって card 全体の高さが変わるのも防げる。
- **Change freedom**: 上限の値、スクロールの見せ方は自由。「枠が閉じたまま保たれる」だけが不変。
- **Anchors**: `components/idd/cards/parts.tsx`（DiffView）、`components/idd/cards/index.tsx`（ShipCard）

### DEC-627: 楽観更新しない。記録中 / 成功 / 失敗を札の上で示す

- **What**: 押下から記録が返るまで札を沈めて操作を止め、上辺を線が走る。成功したら札が抜けてから list から消す。失敗したら札を queue に残し、操作面のすぐ上に短く揺れて申告する。
- **Why**: 記録が唯一の履歴である以上（lib DEC-605）、記録できていない判断を済んだように見せてはいけない。失敗を画面上部の帯に出すと、押した場所と結果が離れて繋がらない。
- **Change freedom**: 見せ方と時間は自由。「記録できるまで queue から消さない」「結果が押した場所の近くに出る」だけが不変。
- **Anchors**: `components/idd/InboxTab.tsx`、`components/idd/InboxDeck.tsx`

### DEC-628: undo は持たず、取り返しのつかない判断にだけ確認を挟む

- **What**: undo を実装しない。代わりに提出 / 承認 / 起票の取り消し / lane の中止の 4 つにだけ確認を 1 段挟む。確認は popup ではなく操作面をその場で差し替える形で、外に出るものを値で列挙し（repo / branch / PR 作成 / commit 数）、確定とやめるの 2 択に絞る。Escape でやめる。
- **Why**: 押下の実害は event ではなく副作用にあり、append-only な打ち消し event では起動した executor も push した branch も戻らない。popup にすると別の面に見え、「最終確認」の重さが判断そのものを歪める。「本当によいですか」は情報がゼロなので、代わりに外に出るものを見せて照合させる。GO と差し戻しは中止で取り返せるため対象外（無操作と同じ操作を置かないのと同じ理由）。
- **Change freedom**: 対象の 4 つ、値の選び方、確認の見た目は自由。「取り返しのつかない押下にだけ挟む」「別の面に飛ばさない」だけが不変。
- **Revisit when**: 実運用で押し間違えが観測されたら、outbox 配信前の窓に限って undo を設計する。
- **Anchors**: `components/idd/primitives.tsx`（ConfirmGate）、`components/idd/cards/index.tsx`、`components/idd/LaneDetail.tsx`

### DEC-629: 重複確認は「関係」を形で示す

- **What**: 新規 / 既存 のラベルを置かず、来たものを破線の枠、既存を実線 + 地 + stage bar で描き、間に合流の記号と類似度を置く。2 つの題名の共通部分（2 文字以上の最長一致）に下線を引く。
- **Why**: この card の主題は 1 件の起票ではなく 2 件の関係。ラベルは読まないと分からないが、破線 = まだ実体がない / stage bar がある = 実在して進んでいる、は見れば分かる。題名の照合を読み手にさせず UI 側で済ませる。類似度は関係の属性なので 2 枚の間に置く。
- **Change freedom**: 一致の取り方、記号、下線の描き方は自由。「関係が形で見える」「照合を読み手にさせない」だけが不変。
- **Anchors**: `components/idd/cards/parts.tsx`（DuplicatePair / Marked）

### DEC-630: 判断根拠は文章ではなく共通する具体物の列で出す

- **What**: 重複判定の理由（自由文）は ⓘ の tip に退避し、両者に共通して現れた具体物（ファイル名 / 記号 / area）を `shared[]` として列で出す。
- **Why**: 文章は読ませる。値の並びなら件数がそのまま重なりの強さになり、見るだけで済む。planner 側の出力仕様に影響するため handoff に追記済み。
- **Change freedom**: 何を具体物とするかは自由。「根拠が値の列で出る」だけが不変。
- **Anchors**: `components/idd/cards/parts.tsx`（SharedItems）、`lib/idd-ui/types.ts`

### DEC-631: sidebar は 1 行 1 入口。群ごとに重みを単調に落とす

- **What**: lane 行の視線の入口を題名 1 つに絞り、内部 ID と外部参照は行から外す。題名の重みを群ごとに単調に落とし（判断待ち 600 → 実装中 500 → 待機中 muted → 終端 dim）、従の行は濃度で追従させる。判断の種類アイコンは右端、判断待ちの行だけ左端に 3px の縦線。
- **Why**: 右端に複数の値が縦に並ぶと、題名を読む視線と右端を拾う視線が往復して疲れる。全行が同じ太さだと群で分けた意味が視覚に出ない。アイコンを題名の前に置くと、アイコンの無い行と開始位置がずれて縦の線が折れる。
- **Change freedom**: 重みの値、印の形は自由。「1 行 1 入口」「群ごとに単調に落ちる」「題名の左端が揃う」だけが不変。
- **Anchors**: `components/idd/LaneList.tsx`

### DEC-632: lane detail は契約 / 現物 / 経過の 3 primitive で、進捗を別に持たない

- **What**: lane detail は「経過 → 契約（やること・満たすべき条件）→ 参照 → agent → 現物（触っているファイル・stream・話しかける入力）」の順で並べる。進捗という独立した表示は持たない。
- **Why**: 進捗とは「契約のどこまで満たしたか」でしかなく、別に持つと二重の正本になる。並び順は粒度が単調に細かくなる形にした。lane を開く動機は「どうなっているか」なので経過が先、最も細かい現物が最後で、話しかける入力はその現物の直下に来る。
- **Change freedom**: 各 primitive の見せ方は自由。「進捗を別に持たない」「粒度が単調」だけが不変。
- **Anchors**: `components/idd/LaneDetail.tsx`、`components/idd/LaneDetailParts.tsx`

### DEC-633: 既存 pi-web shell への追加点を 3 箇所に限る

- **What**: sidebar 上部の `Sessions ⇄ Lanes` 切替、main の上に置く薄いタブ帯（Inbox 常設 + lane タブ）、lane 行から lane タブを開く導線。既存の session 一覧・chat・file タブには手を入れない。`?view=` / `?sidebar=` で各面へ直接入れる。
- **Why**: Workspace DEC-001（upstream 追従なし）により改変は自由だが、追加点を絞るほど既存機能の回帰を疑う範囲が小さくなる。URL で各面に入れるのは、出先の端末から判断キューへ 1 手で入るため。
- **Change freedom**: タブ帯の見た目、URL の形は自由。「既存 UI への追加点を数箇所に閉じる」だけが不変。
- **Anchors**: `components/idd/MainTabs.tsx`、`components/AppShell.tsx`、`components/SessionSidebar.tsx`

### DEC-634: mobile では器を持たず素直に流す

- **What**: compact（mobile）では札束の器を使わず、中身なりの高さで縦に流す。差分は unified、操作は縦積み。
- **Why**: 操作が縦に積まれると器の大部分を食い、中の情報が 0 まで潰れる。画面ごと縦にスクロールする前提の方が素直。
- **Change freedom**: 閾値と落とし方は自由。「狭い画面で器が中身を潰さない」だけが不変。
- **Anchors**: `components/idd/InboxPanel.tsx`、`components/idd/InboxDeck.tsx`

### DEC-635: 取り込みの結果は判断ではないので、見出し行の端へ逃がす

- **What**: 朝の cron の結果は札束の上に積まず、見出し行の右端に 1 行で出す。失敗した日だけ枠と件数を持ち、最初から開いた状態で出す。
- **Why**: 判断のたびに結果報告が視界に入るのは、1 画面 1 判断（DEC-620）に反する。ただし畳まれた失敗は失敗として届かないので、失敗の日だけは開いておく。
- **Change freedom**: 置き場所と開き方は自由。「平常時は判断の視界に入らない」「失敗が畳まれたまま埋もれない」だけが不変。
- **Anchors**: `components/idd/InboxPanel.tsx`

### DEC-636: 選択は枠、hover は地。channel を分ける

- **What**: 選択状態は枠の濃度のみで示し（0.84 → 0.6）、文字と地は動かさない。hover は地（背景）だけを動かす。タッチでは hover を無効化する。
- **Why**: 同じ channel を使うと「触れている」と「選ばれている」が混ざる。太字への切り替えは字幅が変わるため使わない。指では hover がタップ後に残り、選ばれて見える。
- **Change freedom**: 濃度の値は自由。「選択 = 枠 / hover = 地」だけが不変。
- **Anchors**: `components/idd/primitives.tsx`（OptionRow）、`app/globals.css`

### DEC-637: 固定ラベルの操作はアイコン付きボタン、主と対は同寸

- **What**: 中身が毎回変わるもの（agent 生成の選択肢）はリスト、固定ラベルの操作はアイコン付きボタン。主（塗り）と対になる操作（線）は同寸。判断ではない操作（移動・問い合わせ）はアイコンのみでラベルは title に退避する。無操作と結果が同じ操作は置かない。
- **Why**: 一瞥で何をするものか分かる形にする。持ち越しが既定なので「後で」「保留」を置くと、押しても何も起きないボタンになる。
- **Change freedom**: 寸法、アイコンの絵柄は自由。「固定ラベル = ボタン / 可変内容 = リスト」「無操作と同じ操作を置かない」だけが不変。
- **Anchors**: `components/idd/primitives.tsx`（ActionButton / IconButton / SegmentedPair）

### DEC-638: 状態は語ではなく形で示す

- **What**: stage は 5 目盛りの bar（止まっている lane は現在地が破線）、条件は 3 状態の marker（済みは沈め、進行中と未着手を立てる）、phase は塗りの chip、外部参照は ↗ を必ず持つ chip。
- **Why**: `s3_ok` のような内部語彙も、「実装中」のような語の宣言も、読ませる表示になる。形と濃度なら見るだけで済む。
- **Change freedom**: 目盛りの数、marker の形は自由。「状態を語の宣言で表さない」だけが不変。
- **Anchors**: `components/idd/primitives.tsx`（StageBar / CriterionMark / Chip / RefChip）

### DEC-639: fixture 表示の切替を UI に持つ

- **What**: タブ帯の右端に `mock` トグルを置き、`localStorage` に持つ。同じ画面の sidebar と Inbox が同時に切り替わる。
- **Why**: 実 lane が 1 本しかない間、5 種の card と 5 群の sidebar を同時に確認する手段が他にない（lib DEC-603）。開発用の scaffold であることを名前で明示する。
- **Change freedom**: 置き場所と持ち方は自由。「実データと fixture の区別が UI 上で付く」だけが不変。
- **Revisit when**: 実 lane が 10 本規模になったら削除する。
- **Anchors**: `components/idd/MainTabs.tsx`、`hooks/useIddState.ts`

### DEC-640: 札の外でのホイールはめくる操作に割り当てる

- **What**: card の外側でのホイールを 1 弾き 1 枚のめくりに割り当てる（閾値 90、400ms で蓄積をリセット）。card の内側では効かせない。
- **Why**: card の内側は card 自身のスクロール（差分・条件の続き）を持つため、同じ入力に 2 つの意味を与えない。閾値を置くのは、トラックパッドの慣性で数枚飛ばさないため。
- **Change freedom**: 閾値、リセット時間は自由。「札の中と外で意味が衝突しない」だけが不変。
- **Anchors**: `components/idd/InboxDeck.tsx`

### DEC-674: 契約が空の GO は止める。空欄ではなく、どこが空かを出す

- **What**: GO 待ちの card で「やること」「満たすべき条件」が両方空のとき、空の見出しを並べる代わりに「下調べの成果物が無い」と探した場所（`_docs/intent/<Area>/<slug>/`）を出し、GO ボタンを押せなくする。中止と問い合わせは残す。
- **Why**: 契約が空の GO は、executor に何も指示しないまま実装を始めさせる。空欄のまま押せる UI は「見落とした人間」の責任にするが、実際には planner が書いていないか slug がずれているかのどちらかで、原因は場所を出せば分かる。
- **Change freedom**: 見せ方は自由。「判断材料が無い判断を押させない」「なぜ無いかを追える情報を出す」の 2 点が不変。
- **Anchors**: `components/idd/cards/parts.tsx`（MissingContract）、`components/idd/cards/index.tsx`（GoCard）、`lib/idd-ui/server/state.ts`

### DEC-675: 畳んだ現状は開ける

- **What**: 質問 card の「▸ 現状 n」は押すと事実の表が開く。事実が無いときは押せない見た目にする。
- **Why**: 畳まれた記号（▸）は開くことを約束する。開かないなら、その記号を出してはいけない。context は planner が書く自由文で、判断の材料になりうるので捨てずに全文を持つ。
- **Change freedom**: 開き方、表の形は自由。「開ける記号は開く」だけが不変。
- **Anchors**: `components/idd/cards/parts.tsx`（CollapsedFacts）、`lib/idd-ui/server/state.ts`

### DEC-680: 畳める印を出すなら実際に畳める

- **What**: sidebar の section 見出しに `▾` を出すのは畳める section だけにし、押すと開閉する。「終端 (直近)」は既定で畳む。
- **Why**: `▸` / `▾` は開閉の約束であり、動かない印は嘘になる（質問 card の「現状」と同じ間違いを sidebar でもしていた）。終端は普段の判断に要らないので既定で畳み、追いたいときだけ開く。
- **Change freedom**: 既定の開閉、印の形は自由。「畳める印は畳める」だけが不変。
- **Anchors**: `components/idd/LaneList.tsx`

## Consequences / Impact

- 札束（DEC-620）により、一覧で全件を俯瞰する手段は sidebar の lane 一覧だけになる。Inbox 側に一覧表示は持たない。
- 器の固定（DEC-624）は desktop 前提で、狭い画面では器を外す分岐が要る（DEC-634）。
- 確認の緩衝材（DEC-628）は 4 箇所に固定されているため、新しい不可逆な操作を足すときは同時に確認対象へ加える必要がある。
- 内部 ID を sidebar から外した（DEC-631）ため、ID を参照したい場面では lane detail か tip を経由する。

## Quality Implications

- **DEC-627 が守る品質**: UI 上の「済んだ」と ledger の記録が一致する。破ると: 記録の無い判断が済んだものとして扱われる。
- **DEC-624 / DEC-626 が守る品質**: めくっても押す場所が動かず、枠が途中で切られない。破ると: 誤操作と「詰まって見える」表示が戻る。
- **DEC-628 が守る品質**: 取り返しのつかない操作の前に、外に出るものを確認する機会が必ずある。破ると: undo が無いまま誤 push が起きる。

## Intent-derived Invariants

- INV-004 (from DEC-628): 外部に副作用が出る押下（push / PR 作成 / 外部 issue の close / lane の中止）は、確認を 1 段挟まずに実行しない。

## Rollback / Follow-ups

- **Rollback**: `components/idd/` を削除し、`AppShell.tsx` / `SessionSidebar.tsx` の追加点（DEC-633 の 3 箇所）を戻せば、pi-web の既存 UI に復帰する。
- **Follow-ups**:
  - 実 lane が 10-20 本規模になったときの札束と sidebar の破綻を確認する
  - fixture 経路と `mock` トグルを削除する（DEC-639）
  - open-questions #17 / #18（planner 出力の長さ・質問 context の形）が決まったら、質問 card の表示を追随させる
