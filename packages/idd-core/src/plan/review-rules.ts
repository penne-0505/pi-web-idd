/**
 * The rules the reviewing and judging stages share, written once. The severity a finding gets, the verdict a
 * judgement reaches, and the action it recommends are the same words whichever stage reads them; a stage that
 * weighs a different thing (the plan review reads the planner's documents) gets its own
 * definition here rather than a copy inside its stage module.
 */

/** how a diff review, a confirm and a PR-feedback judgement weigh a finding */
export const SEVERITY_RULES = [
  "重要度は「頻度 / 現実性」（常時 / 条件つき / まれ）と「害」（クラッシュ・データ破損 / 退行 / 不整合）で決める。ラベル種類・フィールドを網羅するためだけのニッチな指摘は不要。",
  "- must: マージを止める問題。",
  "  - 通常の使い方で明らかに壊れる or 退行する。受け入れ条件を満たさない。",
  "  - 少し条件が必要だが、データの不可逆的変更 / 削除や決済の失敗、認証・認可の明らかな失敗など、生じる害がクリティカル。",
  "- should: 進行は妨げないが follow-up するべき問題。",
  "  - 条件つきで壊れる。",
  "  - 壊れたときにテストでは検出できない。",
  "  - ほとんど遭遇することはないが、生じる害がクリティカル。",
  "  - 動作はするが長期的視点において望ましくない状態・問題。",
  "- nit: 軽微 or 好みによる問題。formatter や linter で拾えるものは nit にもしない。",
  "指摘は「本質 1 文 + 根拠」で行う。提案は任意だが必要なら 1 行で行う。推測によって補われる箇所は「推測だが」と明示する。",
].join("\n");

/** the window a judgement weighs above the severity: a settlement / permission / integrity window is not a nit */
export const SEVERITY_RULES_WINDOW = "- 決済・課金・権限・データの整合に関わる窓（取得の失敗中や途中の状態のまま、決済・送信・保存・削除に進める、画面に出ていないものが処理に含まれる、等）は、再現していなくても should 以上にする。再現できたもの、または再現の手順がコードから一意に読めるものは must にする。この窓は、想定の操作と状態で impact を書き、再現していないことを理由に nit にしない。";

/**
 * The AC the plan review sends back to the planner, written once: the request's severity table and the task of a lane
 * with no plan both take this clause, so the weight does not differ by whether a plan is there. An AC is the
 * executor's fixed condition of done, so a lack in its form is one the executor cannot fill. The bar is the three
 * conditions of `_docs/standards/work.md`'s acceptance-criteria section, which the review's task carries as the
 * original; the clause names that section and never lists the conditions again, so the standard stays their one
 * source. No count of sentences or lines stands in for it. This root is every lane's; an old-form (docs) lane is
 * given the root alone, because it has no Choice to put a defence in.
 */
export const AC_FORM_MUST_ROOT = "qa.md の AC が、この task にある `_docs/standards/work.md` の「受け入れ条件（AC）」の節の 3 条件のいずれかを満たさない。AC は実装役が書き換えず、完了の判定が読む文で、条件を外れた AC は別の作り方の正しい実装を落とすか、Purpose と結び付かない完了を決めるからである。";

/** where a lane with Choices sends the fix: to the placement rule of the same section, not to one more sentence in an AC */
export const AC_FORM_MUST_PLACEMENT = "直し先は AC の文を増やすことではなく、その節の置き場の規則で防ぎの置き場を選び直すことである。";

/** the clause of a lane with Choices (a v2 / state lane): the root and where the fix goes */
export const AC_FORM_MUST_CLAUSE = AC_FORM_MUST_ROOT + AC_FORM_MUST_PLACEMENT;

/** the clause the lane's records shape takes: an old-form (docs) lane gets the root only */
export function acFormMustClause(shape: "docs" | "state"): string {
  return shape === "state" ? AC_FORM_MUST_CLAUSE : AC_FORM_MUST_ROOT;
}

/**
 * How a plan review weighs a finding: it reads a request (the 6 fields of `_docs/standards/brief.md`) as being
 * there or not, and sends the plan back to the planner only for a gap the executor's seat cannot see. `how` in the
 * plan and a rule with no why are the executor's to fill in from the original and the Choices, so they do not send
 * the plan back.
 */
export function planReviewSeverityRules(shape: "docs" | "state"): string {
  return [
    "指摘は「本質 1 文 + 根拠」で行う。推測によって補われる箇所は「推測だが」と明示する。",
    "- must: planner に差し戻す。実装役の席から見えない情報の欠けで、実装役も GO の人も補えない。",
    "  - 原物があるとき、その所在と読み方が無い、または要約で代えている。",
    "  - 完了の形に全体 1 文が無い、または判定者が実装役以外でない。",
    "  - 完了の形の全体 1 文が成果物の性質（prototype と一致する・絵が同じ・無い）である。",
    "  - 戻す条件に入力・手段の不足が無い。",
    "  - 意図に出典が無い。",
    `  - ${acFormMustClause(shape)}`,
    "- should: planner には差し戻さない。GO の判定者に伝え follow-up する。実装役が原物と Choice から補える。",
    "  - how（順序・手順・関数の分割・テストの構成）が混ざっている。",
    "  - 守ることに why が無い、または取り返しがつかないものに絞られていない。",
    "- nit: 軽微 or 好みによる問題。",
  ].join("\n");
}

/**
 * How the Issue lane's judgement (triage) weighs a finding: the harm grade and the frequency it happens at, in one
 * table. Written here rather than folded into SEVERITY_RULES so the diff reviewers (which read their own bar) and the
 * judgement do not have to agree on words neither uses; and so no repo's own example of harm leaks into the engine's
 * text (a repo's examples reach the judgement as an input).
 */
export const JUDGE_SEVERITY_RULES = [
  "must: マージを止める問題。should: 場所に付ける問題。nit: 好み。formatter や linter で拾えるものは nit にもしない。",
  "重さは、害の等級と、起きる頻度の表で決める。",
  "害: 3 = データの不可逆な破損 / 決済 / 認証・認可の失敗。2 = 退行 / 通常の使い方で壊れる。1 = 不整合 / 長期的に望ましくない。",
  "頻度: 常時 = 何もしなくても起きる。条件つき = 普通の使い方の 1 条件。まれ = 普通の使い方の外の 1 条件。事実上起きない = 独立したまれな条件が 2 つ以上、または前提としない環境。",
  "表: 害 3 は 常時 must / 条件つき must / まれ should / 事実上起きない 記録だけ。害 2 は must / should / should / 記録だけ。害 1 は should / should / nit / nit。",
  "「事実上起きない」と判定するときは、独立したまれな条件を 2 つ以上、名前を挙げて書く。",
  "認証・認可・secret の指摘は、頻度を条件つきより下に置かない。",
  "頻度に関わらず must にするのは、主な経路で受け入れ条件を満たさない指摘と、既存の active な Choice の Why と逆向きの実装。まれな分岐でだけ満たさない受け入れ条件は should。",
  "未確認（移行）の Choice との食い違いは should を超えない。",
  "よくある過大評価（これらを must にしない。表に当てて決める）:",
  "- 独立したまれな条件が重なる経路。例: 記録の書き込みと、その失敗の回復の書き込みの両方が失敗したときだけ起きる。書き込みの失敗が 2 か所で独立に起きる条件は、2 つ数えて「事実上起きない」にする。",
  "- 失敗への備えが失敗する経路。例: 失敗を握りつぶす分岐の、さらにその後始末が失敗する。備えが働く前の失敗と同じ頻度で起きると読まず、条件を重ねて数える。",
  "- 前提としない環境でだけ起きる経路。例: ディスクが満杯、git の index の破損、手で編んだ台帳。条件に名前を挙げて「事実上起きない」にする。",
  "- 時刻の境目（日付の切り替わり・締めの時刻）の短い窓でだけ起きる経路。窓が数秒〜数分なら普通の使い方の外の 1 条件として「まれ」に数え、そこに別のまれな条件（2 つの処理が同時に走る、など）が重なれば「事実上起きない」にする。境目の前後でいつも起きる（窓が無い）なら、この例に当てない。",
  "- 害が表示・文面・欄の互換にとどまる指摘。害 1 なので、頻度が常時でも should を超えない。",
  "qa.md の AC の節にある番号の無い全体の行を、実装役の報告（evidence を含む）だけを根拠に満たしたとしない。作った本人の自己申告で完了を決めない。",
].join("\n");

/** the judgement's verdict rules (the review loop, PR feedback and review lanes read the same words) */
export const VERDICT_RULES = [
  "- accept: 実在し、この差分とその直接の影響の範囲にある。まれでも実在する穴は棄却せず、受理して action を followup か skip にする。",
  "- reject: 誤り・既に満たしている・範囲の外にあるものだけ。理由を確かめた事実で書く。範囲の外の既存の問題は reject にして followup を true にする。",
  "- escalate: 仕様の判断が要り、指示から決められない。人間に聞く理由を書く。",
  "修正の往復:",
  "- history の各項目の ref（例: 2-final/F-1）は、その判定の巡・種類と ref。今回の指摘が、history のどれかと同じ箇所・同じ性質で逆向きの要求（前の巡で「A にせよ」と直させた所に「A をやめよ」）なら、修正の往復。accept にも reject にもせず、verdict を escalate にして reverts を書く（prior_ref に history の ref、prior に前の巡の要求の立場、current に今回の要求の立場を 1 文ずつ。どちらも空にしない）。どちらの立場を取るかはユーザーが決める。",
  "- reverts は escalate にした往復にだけ書く。同じ箇所でも、前の巡と同じ向きで修正が足りないもの、別の性質の問題は往復ではなく、いつもどおり判定する。",
  "- history にユーザーの決定があれば、それを仕様の境目として判定に使い、同じ往復をユーザーに聞き直さない。決定に反する要求は reject にして、理由に決定を引く。",
].join("\n");

/** the PR-feedback judgement's verdict rules: a reviewer's request is fixed whatever its severity, or answered */
export const VERDICT_RULES_FEEDBACK = [
  "- accept: 指摘が正しく、この PR の責務の内にある。対応するかは action で決める。",
  "- reject: 誤り、または既に満たしている。理由は、レビュアーにそのまま返せる確かめた事実で書く（どのファイル・どの挙動を確かめたか）。「起きにくい」は根拠を添える。この PR の責務の外で別の Issue で扱うべきものは reject にして followup を true にする。",
  "- escalate: 仕様の判断が要り、指示から決められない。ユーザーに聞く理由を書く。",
  "修正の往復:",
  "- history の各項目の ref（例: 2-final/F-1）は、その判定の巡・種類と ref。今回の指摘が、history のどれかと同じ箇所・同じ性質で逆向きの要求（前の巡で「A にせよ」と直させた所に「A をやめよ」）なら、修正の往復。accept にも reject にもせず、verdict を escalate にして reverts を書く（prior_ref に history の ref、prior に前の巡の要求の立場、current に今回の要求の立場を 1 文ずつ。どちらも空にしない）。どちらの立場を取るかはユーザーが決める。",
  "- reverts は escalate にした往復にだけ書く。同じ箇所でも、前の巡と同じ向きで修正が足りないもの、別の性質の問題は往復ではなく、いつもどおり判定する。",
  "- history にユーザーの決定があれば、それを仕様の境目として判定に使い、同じ往復をユーザーに聞き直さない。決定に反する要求は reject にして、理由に決定を引く。",
].join("\n");

/** the judgement's action rules on the review loop: a must is fixed, and a should is placed by default */
export const ACTION_RULES = [
  "accept の must / should だけが修正に回る。nit は残件として記録されるだけで、修正には回らない。",
  "must の action は必ず fix。",
  "should の action は既定で followup（場所に付けて、この変更では直さない）。fix にしてよいのは、この変更の意図の中で小さく直せ、害の表で should 以上に当たる指摘だけ。同じファイルや関数に must があるかは理由にしない。",
  "- 意図の中で小さく直せる: 依頼と Choice の範囲の中にあり、新しい判断・契約・設計を足さずに 1 段落で直せる。意図の外へ広がる直しと、別の lane の領分に入る直しは followup。",
  "- fix を勧める should の数には上限がある。上限を超える回は、人に境目を聞く。",
  "「記録だけ」の指摘は、直さずに場所に付ける。",
  "fix にする should には、起きる害を impact に 1 文で書く。",
].join("\n");

/** the PR-feedback judgement's action rules: a reviewer's request is fixed whatever its severity, or answered */
export const FEEDBACK_ACTION_RULES = [
  "accept した指摘ごとに、対応価値とこの PR で直すかを action で決める。",
  "- must: fix。",
  "- should: この PR の範囲で小さく直せるなら fix。そうでなければ followup（別の Issue として起票し、返信でそう伝える）。",
  "- nit: 既定は skip（対応しない。返信で理由を伝える）。must / should と同じファイルを直すついでに済むものだけ fix。",
  "- 対応価値が無いもの（好みの問題、既に同等の手当てがある、直しても利用者に差が出ない、など）は severity によらず skip にし、reason にレビュアーへそのまま返せる理由を書く。",
  "- fix だけが修正に回る。followup と skip は返信と記録になる。nit 2 件の往復で PR が閉じない状況を作らないことを、直すことより優先する。",
].join("\n");

/**
 * The review lane's action rules: an accept decides both whether to tell the author (report) and whether the change
 * is asked of them here (action). Only the musts and the shoulds the judge chose to report reach the review body.
 */
export const REVIEW_ACTION_RULES = [
  "accept した指摘ごとに、作者に伝える価値（report）と、この PR で直してもらうか（action）を決める。",
  "- must: report は true、action は fix。レビューで「変更の要求」になり、必ず作者に伝わる。",
  "- should: 伝えるのは、impact が具体的に書け、根拠の箇所を示せるものだけ。この PR の範囲で直せるなら action は fix。直す場所がこの PR の外にあるなら followup（別の Issue の候補として記録し、作者には伝えない）。作者が読んでも判断できないものは report を false にする（記録には残る）。",
  "- nit: report は false、action は skip。記録に残るだけ。",
  "- 伝える価値が無いもの（好みの問題、既に同等の手当てがある、直しても利用者に差が出ない、など）は severity によらず report を false にする。",
  "- 作者への往復を増やさないことを、伝えることより優先する。must と、report にした should だけがレビュー本文に載る。",
].join("\n");
