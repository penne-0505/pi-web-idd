# Project の仕様

語は `principle.md` の 1 に従う。この文書は Project の形と扱いを決める。Purpose と Choice の欄は `records.md`、写しの形は `projections.md`、記録を書く時と順は `workflow.md` にある。

## 単位

Project は Issue より大きい作業のまとまりである。propter の単位は Purpose（なぜ）・Issue から立つ lane（完了の形 1 つ）・Choice（場所の判断）だった。Project は、その間にある「目標・完了の形・共有の決定・属す Issue」をまとめる。意味は Linear の Project にそろえる。単位・関係・状態の流れだけを取り、欄の名前と細部は追わない。

- Project は 1 つの active な Purpose を指す。Purpose の文は Project に写さない。読む側が Purpose から引く。
- 属す Issue は Project の側が Issue の参照で持つ。1 つの Issue は 1 つの Project にだけ属す。別の Project に属させると、前の所属は外れる。
- Project は lane ではない。lane は Issue から立ち、Project は lane の上で目的と決定を渡す。

## 正と写し

Project は Purpose・Choice と同じ正本（Harness の状態の追記の列）に置く。repo の `_docs/intent/<project>/PRJ-<n>.md` は状態から描いた写しで、手で直さない。直したものは検査が見つけ、次の描き直しで消える（`projections.md`）。

lane が書いた Project の行は、その lane が本流に着地するまで他の読み手に効かない。lane 自身は着地の前に自分の行を読む。Choice と同じ規則である。

## 欄

| 欄 | 内容 |
| --- | --- |
| name | Project の名前 |
| purpose | 指す Purpose の id。active でなければ検査が指す |
| done_when | 完了の形。利用者が何をできるかで書く |
| state | backlog / planned / started / paused / completed / canceled（Linear の status type の語） |
| body | 本文。自由な文で、milestone や update もここに節として書く |
| decisions | 決定の束（選んだ形・why・捨てた形）。id は `PD-<Project の番号>-<連番>` |
| issues | 属す Issue の参照 |

Issue の参照は `owner/name#N`（GitHub）か `APP-1234`（Linear）の形に正規化して持つ。URL・番号だけの形も受ける。backlog の行の `gh_issue_url` と `linear_issue_url` が同じ形に読めるので、まだ lane が無い Issue も、着地して閉じた後の Issue も、同じ参照から Project を引ける。

## 決定

場所がまだ無い決定は、Project の決定に置く。決定は why と捨てた形を持つ。捨てた形が無いときは no_why_not に理由を書く。Choice と同じ規則である。

コードが生まれて Place が決まったら、決定を Choice に移す。移す口は 1 つで、`idd project promote ID PD-n-m --file F.json` である。F.json には Place と anchored を書く。選んだ形・why・捨てた形は決定から写り、F.json に書いたものが優先する。移すと、Project の決定は本文を手放して移し先の Choice を指す。同じ決定の本文が Project と Choice の両方に残らない。

- 候補を出すのは計画役である。brief が Project の決定を渡すので、計画役は触る module を引く席で「この決定に Place が生えた」と分かる。この lane の context 文書（`_docs/context/<Area>/<slug>/context.md`）に決定の id と Place を書く。依頼の「重要なコンテクスト」は context 文書の所在だけを指す。
- 移すのは実装役である。計画役は口で直接立てない（`records.md` の「立てる口」）。
- 移し先の Choice が superseded か dropped になったら、記録の検査が Project の決定を、error ではなく注記として指す。Project の決定が指す先を付け替える操作が無く、error では解消できないためである。後継があれば検査の文に出る。指す先の読み替えは別の操作が要る。

## brief に載る範囲

Project に属す Issue の lane は、planner と executor（修正の巡を含む）の brief で、その Project の目的（Purpose の文）・完了の形・状態・決定・文書の所在を受け取る。

- 決定は上限つきで渡す。選んだ形と why を渡すのは先頭の 5 件で、残りは見出しだけにし、それも超えたら件数だけにする。全部は文書から読める。
- Choice に移した決定は渡さない。移し先の Choice が注入で届く。
- 本文は渡さない。brief は起動のたびに読まれ、写すと文書と食い違う。
- 属さない lane の brief は変わらない。
- 差分のレビュー役（blind）・final・confirm・地図の brief には、Project の本文も決定も渡さない。意図を知る読み手は実装者と同じ理由で見落とすので、意図の記録を渡さない（`workflow.md`）。判定（triage）は Purpose の文だけを受け取る。

## 完了の候補

属す Issue が 1 つ以上あり、そのすべてが閉じているとき、Project は完了の候補として `idd project list` と engine の読み口に出る。閉じていない Issue が 1 つでもあれば候補にならない。

- 閉じているは Issue の状態である。lane の着地で閉じた Issue・手で閉じた Issue・Linear で閉じた Issue のどれも数える。
- propter が自分で知るのは、着地が Issue の close を投稿したことだけである。それ以外の閉じ方は、人が `idd project issue-closed` で記録したときに数える。開き直したら `idd project issue-open` で記録する。記録は人（lane の外）だけが書く。
- ignore した Issue は開いたままである。閉じていなければ候補を止める。人が閉じて記録すれば数える。
- 候補は状態を変えない。Project を completed にするのは人の操作（`idd project complete`）だけである。候補でない Project は `--force` を付けたときだけ閉じられる。lane は completed と canceled にできない。

## 見せる面

人に見せる面は CLI（`idd project`）と engine の読み口（`GET /api/idd/intent` の `op=projects` と `op=project`）までである。新しい画面は GUI の段の範囲とする。

## やらないこと

- Linear の Project や GitHub の milestone との同期と書き出し。
- Cycle と Initiative。
- チームの規約の節（PR template・CONTRIBUTING など）。置き場は Project ではなく `config/repos.yaml` である。
