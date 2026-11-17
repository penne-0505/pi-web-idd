import type { MetricsLane, MetricsView } from "./build.ts";
import type { HandSide, MetricsHands, MetricsPlanReview, MetricsSilent } from "./hands.ts";

/**
 * How the hands, the silent stops and the plan review are written: the terminal table's lines and the weekly table's
 * sections. Both read the counts `hands.ts` made, so a total, a lane's row and the weekly table cannot disagree.
 */

const minutes = (v: number): string => `${Math.round(v * 10) / 10} 分`;

/** the hands on one line: inside, outside, the answers to questions, and the kinds no table names */
const counts = (h: MetricsHands): string => `内 ${h.inside} / 外 ${h.outside} / 回答 ${h.answer} / 未分類 ${h.unclassified}`;

/** the kinds of one side, most counted first: `s2_review_resumed:continue 34 / s1_revise_requested 5`; empty when there are none */
const kindsOf = (h: MetricsHands, side: HandSide): string => h.kinds.filter((k) => k.side === side).map((k) => `${k.kind} ${k.count}`).join(" / ");

/** the silent minutes with the stops behind them and how many of those the stall watch recorded */
const silentText = (s: MetricsSilent): string => `${minutes(s.minutes)}（${s.spans} 本・うち見張りの記録 ${s.from_watch} 本）`;

/** each round's must in the order they ran; a round that failed has none and reads `失敗` */
const mustText = (p: MetricsPlanReview): string => p.must.map((m) => (m === null ? "失敗" : String(m))).join(" → ");

/** the plan review's rounds with each round's must in the order they ran: `3 回（must 6 → 失敗 → 0）` */
const reviewText = (p: MetricsPlanReview): string => (p.rounds ? `${p.rounds} 回（must ${mustText(p)}）` : "—");

/** what a lane's row of the terminal table says about its hands, its stops and its plan review */
export function laneHandsParts(lane: MetricsLane): string[] {
  const outside = kindsOf(lane.hands, "outside");
  return [
    `手 ${counts(lane.hands)}`,
    outside && `外の内訳 ${outside}`,
    lane.silent.minutes && `止まり ${silentText(lane.silent)}`,
    lane.plan_review.rounds && `計画の査読 ${reviewText(lane.plan_review)}`,
  ].filter((part): part is string => Boolean(part));
}

const NOT_COUNTED = "worktree への file の複製・サービスの停止・hotfix の commit・状態の手直しは台帳に残らず、人の手に入れていません。本流への直接 commit は直接 commit の欄が数えます";

/** the terminal table's lines for the period: the counts, the kinds behind each side, and what is not counted */
export function handsSummaryLines(view: MetricsView): string[] {
  const h = view.totals.hands;
  const sides = [["内", "inside"], ["外", "outside"], ["未分類", "unclassified"]] as const;
  return [
    `人の手（台帳に残ったものだけ）: ${counts(h)}  止まり ${silentText(view.totals.silent)}`,
    ...sides.filter(([, side]) => kindsOf(h, side)).map(([name, side]) => `  ${name}の内訳: ${kindsOf(h, side)}`),
    `  数えない手: ${NOT_COUNTED}`,
  ];
}

/** the weekly table's conditions: what is a hand, what is a stop */
export const HANDS_SURVEY_CONDITIONS: string[] = [
  "- 人の手は、台帳に残った行だけを数える。内は系が人に残す承認（GO・提出前確認の承認・push の承認・署名（署名必須化より前の、署名の属性を持たない承認も含む）・予算の延長・粒度の案への答え）、外はそれ以外の人の手（差し戻し・計画からのやり直し・停止への答え・伝言・再開・提出前確認からの差し戻し・手で直す・取り込み待ちの card の片付け・見送りと無視で lane を閉じる）、回答は質問への人の答え。宣言に無い種類で人の印（`at_by: user` など）のある行は未分類として別に出す。Purpose と Choice の確認は GO の 1 回に同乗し、単独の手には数えない。内と外の線は 1 か所の宣言から引き、期間の合計・lane の行・この表は同じ読みから出る。",
  "- 止まりは、行と行の間が lane が開いたときの見張りの設定の分（設定が無いか 0 のときは既定の 45 分）以上で、段の切り方が関所にも待ちにも入れない区間から、lane の session か run が動いていたと読める時間を除いた残り。残りが設定の分以上なら、残りの全体を足す（設定の分は引かない）。見張りが止まりとして記録した区間（`lane_stall_detected`・`lane_stall_instructed`・`lane_stalled`）は、`since`（無ければ見張りが直前に書いた差し戻しの手前の行）から記録の時刻までで、行間から来た区間と重なる分は 1 度だけ数える。本数は重なりをまとめた後の数で、うち見張りの記録を含む数を別に出す。",
];

/** the weekly table's rows for the totals table */
export function handsTotalRows(view: MetricsView): string[] {
  const h = view.totals.hands;
  const rows: [string, string, string][] = [
    ["人の手: 内（承認）", String(h.inside), "台帳の承認の行（GO・提出前確認・push・署名・予算の延長・粒度の案への答え）"],
    ["人の手: 外", String(h.outside), "台帳の承認以外の人の行（種類ごとは下）"],
    ["人の手: 質問への回答", String(h.answer), "台帳の `question_batch_answered`（人が答えたもの）"],
    ["人の手: 未分類", String(h.unclassified), "宣言に無い種類で人の印のある行"],
    ["止まり", silentText(view.totals.silent), "台帳の行間と見張りの記録、session と run の記録"],
  ];
  return rows.map(([name, value, source]) => `| ${name} | ${value} | ${source} |`);
}

/** the weekly table's two sections: a lane's hands, stops and plan review, and the outside kinds of the period */
export function handsSections(view: MetricsView): string[] {
  const laneRows = view.lanes.map((l) => {
    const cells = [l.iddId, l.hands.inside, l.hands.outside, l.hands.answer, l.hands.unclassified, kindsOf(l.hands, "outside") || "—", minutes(l.silent.minutes), l.silent.spans, l.silent.from_watch, `${l.plan_review.rounds} 回`, mustText(l.plan_review) || "—"];
    return `| ${cells.join(" | ")} |`;
  });
  const outside = view.totals.hands.kinds.filter((k) => k.side === "outside" || k.side === "unclassified");
  const kindRows = outside.map((k) => `| ${k.side === "outside" ? "外" : "未分類"} | \`${k.kind}\` | ${k.count} |`);
  return [
    "### 人の手と止まり（lane ごと）",
    "",
    "| lane | 内 | 外 | 回答 | 未分類 | 外の内訳（多い順） | 止まり | 止まりの本数 | うち見張りの記録 | 計画の査読 | 巡ごとの must |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...laneRows,
    "",
    "### 関所の外の手の種類（期間の合計、多い順）",
    "",
    "| 側 | 種類 | 回数 |",
    "| --- | --- | --- |",
    ...(kindRows.length ? kindRows : ["| — | — | — |"]),
    "",
  ];
}

/** what the weekly table has not checked about the hands and the stops */
export const HANDS_NOT_CHECKED: string[] = [
  "- 数える手は台帳の行に残ったものだけ。worktree への file の複製・サービスの停止・hotfix の commit・状態の手直しは、lane の外の操作で台帳に行を書く主体が無いので、人の手として数えていない。本流への直接 commit は、直接 commit の欄が別に数えていて、人の手には足していない。",
  "- 人の手の種類は、event ごとに決めた印で読む。印の無い種類は、その event を人が書くと宣言して読む。印の無い新しい種類の人の手は、宣言が無いと未分類にも出ない。",
  "- 質問への回答は、問いが導けたかどうかを台帳から読めないので、内と外に分けず別に数える。",
  "- 止まりの session は開始の記録しかないので、終わりを次の session の開始（無ければ lane の閉じか台帳の最後の行）で切る。run は記録が 7 日で消え、消えた run は動いていたと読まずに止まりに残す。run が終わりを書かずに落ちた記録は、lane の終わりまで動いていたと読む。",
];
