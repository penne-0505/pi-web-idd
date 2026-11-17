# 機械の検査と Judge の判定

機械は有無と形を見る。質は Judge が見る。

## 機械が見るもの

### 状態に対して（`idd intent check`）

engine が状態の規則を当て、CLI が worktree の規則を当てる。lane の中で回すと、その lane の記録を自分のものとして見る。

| 規則 | 見るもの |
| --- | --- |
| required | Purpose の statement・origin、Choice の purpose・forms.chosen・place・why・anchored がある |
| purpose | Choice の purpose が実在し、active である |
| rejected | forms.rejected が 1 つ以上あるか、no_why_not の理由がある |
| successor | superseded の Choice が後継の id を持ち、後継が実在する |
| id-duplicate / id-shape | ID が repo の中で一意で、`P-<n>`、`C-<鍵>-<n>`、移行した `DEC-…` / `INV-…` のどれかの形である |
| round | lane の巡（結果の報告まで）ごとに、その lane の Choice の記録（立てる・Re-anchor・Supersede）か Waive がある。無言の省略は error |
| place | Choice の module が tree にある。file の印・symbols・verification の検証物が立たなくなったものには保守の印（error ではない）を付ける。rename は着地で追従する |
| touched | lane が触った Place に unconfirmed の Choice が残っていない（v2 の lane では error） |
| projection | 描き直した結果と tree の写しが一致する。一致しなければ「写しが直されている」として報告する |

AC の verified は evidence があるときだけ確認済みに数える（`work.md`）。これは検査の error ではなく、数え方である。

未実装: 公開 docs（B）の写しに対する「IDD と propter の語が出ていない・private の Choice が出ていない」の検査（B を描く機構が無いため）。chat のセッションからの変更の「1 変更ごとの宣言」の検査（巡の規則は lane だけに当たる）。

### repo の文書に対して（`scripts/check-docs.sh`）

| validator | 見るもの |
| --- | --- |
| validate-frontmatter | 運用対象の文書の frontmatter の必須の鍵と値 |
| validate-todo | `TODO.md` の task の書式、ID、文書の path |
| validate-doc-links | Markdown のリンクと frontmatter の references の実在、archive の置き場 |
| validate-qa | qa の必須の節、Round の欄（Commands・AC Coverage・Risk・Choice か Waive・Verdict）、`qa_status` と最後の Verdict の一致 |
| validate-survey | survey の節の順と、参照の向き |
| validate-comments | コードに統治用のポインタが無い |
| validate-overlay-records | 記録が公開側へ出ない（manifest の除外に当たる） |
| validate-intent-delta | code や作業の流れに関わるパスの差分に、qa の文書の変更が伴うか。repo が `risk_paths` に宣言したパス（既定は持たない）に当たる差分の qa が、frontmatter の `risk:` か足した Round の `Risk` で High 以上か |

旧い形の記録（DEC の decision.md、Intent Delta と R2 の欄を持つ Round）は、今も受け入れて検査する（`migration.md` の「旧い形の記録の扱い」）。

repo の risk の宣言（`workflow.md` の「repo の risk の宣言」）による Risk の引き上げは、ここでも機械が行う。

## Judge が見るもの

- forms.chosen が形の名詞句であり、実装の説明（What / How）になっていない。
- why が因果であり、出所の言い換えではない。
- forms.rejected が、Changer が手を伸ばしそうな形を含み、形骸の 1 行になっていない。
- anchored が「実装方式が変わっても破れない結果」であり、現在値の固定や比較条件になっていない。INV の番号を振っていない（`records.md` の「INV を立てない」）。
- free が why を保つ範囲として読める。
- Choice が Purpose に連なっているか。連ならないものは立てない。
- Waive の no-choice の理由と、Choice の no_why_not の理由が妥当か。
- 応急処置の Choice が、残す範囲・本来の直し方・今そうしない理由を持ち、原因による解決と呼んでいない（`records.md` の「旧い形を残す変更」）。
- 差分が迂回・橋渡し・旧い形の残りを足していないか。足していて Choice の記録が無いものは、`solving.md` の P 番号（P1・P4・P7）を理由に差し戻す。

計画の査読は立てる時に、Judge は変えた後の判定の中で、同じ基準で見る。記録の質のためだけの run は置かず、この 2 つの中に畳む（変えた後に見る役だった守られたかの確かめ（R2）は 2026-10-22 に外した）。

規約（`_docs/standards/`）を改訂する差分のレビューでは、規約が主張する機械の検査（validator が error / warning にすると書かれた内容）が実装に実在するかの突き合わせを観点に含める。理由: 正しい文書を通す見本も、実装済みの検査の fixture も「主張されたが実装されていない検査」を原理的に捕捉できず、この食い違いはレビューにしか割り当てられないため。

## 検査しないもの

項の数、文字数、出所の語の有無、Why not の件数の多さは検査しない。これらを機械の検査にすると、形を満たすための記述が増え、Reason の質が下がる。質の判定は Judge に置く。
