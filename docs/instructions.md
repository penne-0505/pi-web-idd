# 利用者の方針（instruction）の約束

方針は、利用者が自分で決めた「今後も守ってほしい判断の好み」である。レビューは blocker だけを挙げる、PR 本文は短く書く、のように、1 文と理由 1 行で書く。方針は 1 か所に持ち、当てはまる lane の役と会話にだけ届く。全部の役に渡すと、関係ない段の brief が膨らみ、当てはまらない指示に agent が引きずられるからである。

方針は Purpose や Choice の置き換えではない。設計の理由は記録に、利用者の好みは方針に置く。チームの規約もここへ写さない。規約の正はチームの repo にあり、写すと正本が 2 つになる。

## 置き場

方針の正本は、利用者の dir の 1 ファイルである。engine の state にも repo の `_docs/` にも写しは無い。engine を移しても repo を替えても、同じ方針が効く。

```
~/.config/idd/instructions/
  instructions.json   正本。方針の一覧
  instructions.md     正本から作る読める写し。確かめるために読む。直さない
  proposals.json      利用者の答えを待っている案
  decisions.jsonl     案に利用者が答えた記録（追記だけ）
```

dir は `IDD_INSTRUCTIONS_DIR` で替えられる。テストは入口が空の dir を渡すので、実物を読み書きしない。

正本が無い・読めない・壊れているとき、lane と会話は方針が無いものとして進む。書く口は、壊れた正本を空で上書きしない。壊れたファイルは `instructions.json.broken-<時刻>` へ退避し、その書き込みは断る。同じ操作をやり直すと、退避の後の空の状態から通る。

## 1 件の書き方

1 件は、方針の 1 文、理由の 1 行、範囲の 3 つで成る。

- 方針は 1 文で、改行を含めず、200 文字までである。文を分けたいときは別々の案にする。
- 理由は 1 行で、120 文字までである。
- 範囲は、repo・場面・場所の 3 つを書く。どれも `all`（全部）が書ける。

自動の差し込みは、3 つすべてに当てはまるときだけ行う。1 つでも外れたら届けない。当てはめは集合の照合で、同じ入力に同じ結果を返す。model は当てはめを決めない。

| 場面（id） | 当てはまる段 |
| --- | --- |
| 計画（`plan`） | 計画役 |
| 実装（`implement`） | 実装役、修正の巡の実装役、直し方の整理役（`fix_plan`） |
| レビュー（`review`） | 計画の査読（`plan_review`）、blind、最後のレビュー（`final`）、確かめ（`confirm`・`feedback_confirm`・`device`）、地図（`map`） |
| 判定（`triage`） | 指摘の判定（`triage`・`feedback`・`feedback_leftovers`） |
| PR 本文と commit message（`pr`） | PR の下書き、commit message の下書き |
| 返信・投稿の下書き（`reply`） | レビュー本文・返信・Issue・説明文の清書 |
| 会話（`chat`） | 会話（ephemeral の枝を除く） |

場所は `lane`（lane の段）か `conversation`（会話）で、会話の mode（chat / idea）ではない。会話の場面は `chat` だけなので、レビューの場面を会話にだけ当てるような、重ならない範囲は宣言の時点で断る。

repo は `owner/name` で書く。lane の repo は登録の GitHub の repo で、会話の repo は cwd が属する登録 repo の clone・worktree である。cwd が登録 repo の外にある会話は repo を持たず、repo を範囲にした方針は当たらない。`all` の方針はどの会話にも当たる。

blind は実装者の Purpose と Choice を渡されない。方針は実装者が書いた枠組みではなく利用者の恒久の好みなので、レビューの場面の方針は blind にも最後のレビューにも届く。

## 足す・変える・引退させる

方針の追加・変更・引退は、案を出すだけでは効かない。

1. 会話で方針を言う。会話の agent は、起動時の system prompt で案の出し方を知っている。agent は `idd instruction propose add|change|retire` で案を出す。`change` は書いた項目だけを変える案で、範囲の `--repo`・`--scene`・`--place` は書いた軸だけが変わり、書かなかった軸は今の値のまま残る（`all` にはならない）。
2. 案は、新しい画面の Inbox に案の card として出る。card は、今の方針と案、理由、効く時点を並べる。
3. 利用者が card で承認すると、正本に効く。承認は passkey の署名つきで、署名は案の中身（方針・理由・範囲）に掛かる。見送るときは理由を 1 行書き、署名は案の中身と理由に掛かる。

agent が呼べる口は案を出すことだけで、承認と見送りの口は利用者の画面にだけある。decide の口は agent からも届くので、承認も見送りも agent が作れない passkey の署名を求める（見送りは未読の案の本文と範囲を消すので、署名が無ければ案を開いたままにする）。案を出す口は、会話の pi に engine が渡した資格（`IDD_SESSION_TOKEN`）も求めるので、lane の session は id を省いても、会話の名を借りても案を出せない。agent が自分で「レビューは blocker だけ」のような都合のよい方針を足せると、以後の自分の判定が軽くなるからである。

件数が 8 件に達していると、追加の案の card に見直しの促しが出る。要らない方針があれば先に引退させる。促しは断りではなく、そのまま承認もできる。

## いつから効くか

承認した方針は、その後に始まる lane の役の run と、その後に pi か Claude Code を起こす会話から効く。動いている応答の途中には差し込まない。

- 役の run は、brief の `<instructions>` の節に方針と理由が入る。agent に別のファイルを読ませない。
- 会話は、起動のたびに system prompt の追記へ方針を組み直す。開き直すたびにその時点の方針が入り、圧縮でも消えない。
- ephemeral の枝（相談と by the way）には渡さない。

## session ごとの追加と除外

会話の session は、当てはまる方針の追加と除外をその session だけに持てる。追加は範囲の照合の外の例外で、その session にだけ効く。他の session と正本は変わらない。

```
idd instruction session SESSION                          # その session の追加と除外を見る
idd instruction session SESSION --add INS-2              # 範囲の外でも、この会話に足す案を出す
idd instruction session SESSION --exclude INS-1          # 範囲に当たっても、この会話から外す案を出す
idd instruction session SESSION --clear INS-1,INS-2      # 追加と除外をやめる案を出す
```

追加と除外は、方針の案と同じく、案のまま変わらない。会話の印の口は agent の誰でも呼べて、その会話の agent が受ける方針を決めるので、この 2 つの一覧を直接は書き換えさせない。案は Inbox の案の card に出て、利用者が passkey で署名して承認したときに、会話の印のファイル（workspace の `.propter/sessions.json`）へ入る。案を出す口は会話の資格を求めない（利用者の端末にはそれが無い）。案は card が対象の会話と操作を並べ、署名が無ければ何も変わらない。

印は engine を起こし直しても消えない。その会話の pi を次に起こしたときから効く。

## 差し込んだ記録を読む

方針を差し込むたびに、本文・範囲・宛先（lane の段か会話の session）・時刻が追記だけの台帳（engine の state の `instruction-ledger.jsonl`）に残る。宛先は、lane の run なら段（と run の id）、PR の本文・commit message・返信を書く一幕物の writer ならそれを頼んだ lane と段（lane の外から頼んだ下書きは、lane を推測で付けず、段と repo だけ）、会話なら session である。`--lane-id` と `--stage` は writer の項にも届く。台帳は、run が実際に始まったときと、会話の pi が実際に起きたときだけ書く。brief を組んだだけの下見や、起動に失敗した run は書かない。前の項は書き換えない。

```
idd instruction ledger --lane-id IDD-208            # ある lane に差し込んだ項
idd instruction ledger --session SESSION            # ある会話に差し込んだ項
idd instruction ledger --instruction INS-1 --stage blind --limit 20
idd instruction list                                # 今効いている方針
idd instruction proposals                           # 答えを待っている案
```

台帳の置き場は `IDD_STATE_DIR`、無ければ checkout の `state/` の下の 1 つで、どの cwd から呼んでも変わらない。`--limit 0` は空を返し、`--limit` を付けない照会だけが全件を返す。

台帳には差し込んだ時点の本文が残る。正本を直した後でも、そのとき何が届いたかを読める。
