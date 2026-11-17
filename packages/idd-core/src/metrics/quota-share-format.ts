import type { MetricsQuotaShare, QuotaShareRow, QuotaWindowReading } from "./quota-share.ts";

/**
 * How the Claude subscription's share is written, for the terminal and for the week's table. The two weights are
 * written on the same line of every row, and what the share is not (a share of the window) is written in the section
 * itself, so a reader cannot take the recorded part for the window's.
 */

const num = (v: number, digits = 2): string => String(Math.round(v * 10 ** digits) / 10 ** digits);

const pct = (v: number): string => `${(Math.round(v * 1000) / 10).toFixed(1)}%`;

const jst = (iso: string): string => `${new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ")} JST`;

/** the share of a window's rise, in points of the window (0.02 → 0.68 is +66 points) */
const points = (v: number): string => `${v >= 0 ? "+" : ""}${Math.round(v * 100)} 点`;

/** the part of a row's tokens that is a cache read: what makes the two weights drift apart on the row */
const cacheReadPart = (row: QuotaShareRow): string => {
  const total = row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite;
  return total > 0 ? pct(row.tokens.cacheRead / total) : "—";
};

const tokensOf = (row: QuotaShareRow): string => `入 ${row.tokens.input} / 出 ${row.tokens.output} / cache 読 ${row.tokens.cacheRead}（${cacheReadPart(row)}）/ cache 書 ${row.tokens.cacheWrite}`;

/** what the section says before any number: the cut, the two weights, and that it is not a share of the window */
export const QUOTA_SHARE_NOTES: readonly string[] = [
  "按分は、期間に propter が記録した Claude（サブスク）の消費だけを分母にした割合で、枠そのものの何割かではない（枠には penne 自身の対話も入るが、記録には無い）。",
  "期間は消費の行の時刻（JST の日）で切る。lane を開いた日では切らないので、期間の前に開いた lane も、期間に消費があれば出る。",
  "値段の比は記録された額（API 換算）の割合、token 等倍は入力・出力・cache 読・cache 書を等しく 1 として数えた割合。枠の上限は公開されておらず、cache 読の重みでどちらの割合も変わるので、どちらが正とは決めず、同じ行に並べる。",
  "段は、消費を出した実行の記録（run を起こした台帳の event、会話の session）から決める。決められない消費は「段の記録なし」の 1 行にまとめ、役の名前からは決めない。lane に結べない消費も 1 行にまとめる。",
];

/** what the weekly table's "not checked" section says about the share */
export const QUOTA_SHARE_UNCHECKED: readonly string[] = [
  "- Claude の枠の按分は propter の記録だけの割合で、枠そのものの割合ではない。penne 自身の対話は枠に入るが記録に無く、窓の上昇には混ざる。cache 読の重みで割合が変わるので、2 つの重みを並べ、どちらが正とは決めていない。",
];

/** the window readings' notes: the rise is the window's own, and carries what is not propter's */
export const QUOTA_WINDOW_NOTES: readonly string[] = [
  "窓の上昇は、runs が残した観測（run の終わりの 1 点）から読んだ窓そのものの実測で、上の按分とは別の尺度。上昇には propter の外の消費（penne の対話など）も混ざり、上昇から誰が使ったかは出せない。上の按分とは掛け合わせない。",
  "窓の観測は、lane 側の設定置き場の run のものだけ。会話用の置き場は別の枠になりうるので含めない。",
  "窓は同じリセット時刻を持つ観測の集まりで、期間に入る観測だけで読む（窓の前半が期間の前なら、上昇はそこから先の分）。一番上がった窓を上昇幅で選ぶ。",
];

function windowLine(w: QuotaWindowReading): string {
  if (!w.observations) return `${w.label}: 観測なし`;
  if (!w.peak) return `${w.label}: 観測 ${w.observations} 件あるが、リセット時刻が無く窓に置けないので上昇は読めない`;
  const p = w.peak;
  return `${w.label}: 一番上がった窓 ${jst(p.start)} 〜 ${jst(p.end)}  ${num(p.from)} → ${num(p.to)}（${points(p.rise)}）  観測 ${p.observations} 件（${jst(p.first_at)} 〜 ${jst(p.last_at)}）${
    w.unplaced ? `  リセット時刻の無い観測 ${w.unplaced} 件は窓に置けない` : ""}`;
}

function rowLine(row: QuotaShareRow): string {
  return `${row.label}${row.title ? `  ${row.title}` : ""}  値段の比 ${pct(row.share.price)} / token 等倍 ${pct(row.share.tokens)}  $${num(row.tokens.usd, 3)}  ${row.units} 件  ${tokensOf(row)}`;
}

const CUTS = [
  { key: "lanes", name: "lane ごと" },
  { key: "roles", name: "役と model の組ごと" },
  { key: "stages", name: "段ごと" },
] as const;

/** the sum of one weight over a cut's rows: a cut that has rows adds up to 100% under both */
const sumOf = (rows: QuotaShareRow[], weight: "price" | "tokens"): number => rows.reduce((a, r) => a + r.share[weight], 0);

/** the terminal table's section */
export function quotaShareLines(quota: MetricsQuotaShare): string[] {
  const out: string[] = ["Claude サブスクの按分（記録から出した割合。枠そのものの割合ではない）:"];
  for (const note of QUOTA_SHARE_NOTES) out.push(`  ${note}`);
  if (!quota.rows) {
    out.push("  この期間に propter が記録した Claude の消費の行はありません（0% ではなく、割る消費が無い）。");
  } else {
    out.push(`  分母: ${quota.rows} 件 / $${num(quota.total.usd, 3)} / token 入 ${quota.total.input} 出 ${quota.total.output} cache 読 ${quota.total.cacheRead} cache 書 ${quota.total.cacheWrite}`);
    for (const cut of CUTS) {
      const rows = quota.cuts[cut.key];
      out.push(`  ${cut.name}:`);
      for (const row of rows) out.push(`    ${rowLine(row)}`);
      out.push(`    合計  値段の比 ${pct(sumOf(rows, "price"))} / token 等倍 ${pct(sumOf(rows, "tokens"))}`);
    }
  }
  out.push("");
  out.push("Claude の窓の実測（按分とは別の尺度。propter の外の消費も混ざる）:");
  if (!quota.windows) out.push("  窓の観測は読まれていません。");
  else for (const w of quota.windows.windows) out.push(`  ${windowLine(w)}`);
  for (const note of QUOTA_WINDOW_NOTES) out.push(`  ${note}`);
  return out;
}

/** the weekly table's sections: one table per cut with both weights, and the windows' rise as a section of its own */
export function quotaShareSurveyLines(quota: MetricsQuotaShare): string[] {
  const out: string[] = ["### Claude サブスクの按分（記録から出した割合）", ""];
  for (const note of QUOTA_SHARE_NOTES) out.push(`- ${note}`);
  out.push("");
  if (!quota.rows) {
    out.push("この期間に propter が記録した Claude の消費の行はありません（0% ではなく、割る消費が無い）。");
  } else {
    out.push(`分母は ${quota.rows} 件・$${num(quota.total.usd, 3)}。`);
    for (const cut of CUTS) {
      const rows = quota.cuts[cut.key];
      out.push("");
      out.push(`${cut.name}:`);
      out.push("");
      out.push("| 行 | 値段の比 | token 等倍 | USD | 件数 | 入力 | 出力 | cache 読 | cache 読の割合 | cache 書 |");
      out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const r of rows) {
        out.push(`| ${r.label.replace(/\|/g, "\\|")} | ${pct(r.share.price)} | ${pct(r.share.tokens)} | $${num(r.tokens.usd, 3)} | ${r.units} | ${r.tokens.input} | ${r.tokens.output} | ${r.tokens.cacheRead} | ${cacheReadPart(r)} | ${r.tokens.cacheWrite} |`);
      }
      out.push(`| 合計 | ${pct(sumOf(rows, "price"))} | ${pct(sumOf(rows, "tokens"))} | | | | | | | |`);
    }
  }
  out.push("");
  out.push("出典は `state/pipeline/consumption.jsonl` の contract が claude の行と、台帳の run を起こした event、会話の session の記録。");
  out.push("");
  out.push("### Claude の窓の実測（按分とは別の尺度）");
  out.push("");
  for (const note of QUOTA_WINDOW_NOTES) out.push(`- ${note}`);
  out.push("");
  if (!quota.windows) out.push("窓の観測は読まれていません。");
  else for (const w of quota.windows.windows) out.push(`- ${windowLine(w)}`);
  out.push("");
  out.push("出典は、期間の Claude の行が名指す run の記録（`state/lanes/<run>/lane.json`）の観測。");
  return out;
}
