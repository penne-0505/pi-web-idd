import type { CanaryRow, MetricsFlaky, MetricsLane, MetricsView } from "./build.ts";
import { HANDS_NOT_CHECKED, HANDS_SURVEY_CONDITIONS, handsSections, handsSummaryLines, handsTotalRows, laneHandsParts } from "./hands-format.ts";
import type { MetricsLeak, MetricsLeakArea } from "./leaks.ts";
import type { NetFateRow, ReturnedMust } from "./net.ts";
import { QUOTA_SHARE_UNCHECKED, quotaShareLines, quotaShareSurveyLines } from "./quota-share-format.ts";

/**
 * How the period's numbers are written down: a table for a terminal, and a weekly table as the survey document a
 * person reads and commits (`_docs/survey/metrics/<YYYY-WW>/survey.md`). The document is written once and not edited
 * afterwards, so every week is a file of its own; the four sections and the sources of every row are the survey's
 * contract.
 *
 * Neither writer files anything: the flaky rows are candidates for an issue, and a person decides.
 */

const n = (v: number | undefined, digits = 2): string => (v === undefined ? "—" : String(Math.round(v * 10 ** digits) / 10 ** digits));

const min = (v: number | undefined): string => (v === undefined ? "—" : `${n(v, 1)} 分`);

/** a change of a count with its sign, so a fall reads as a fall and not as a gain */
const signed = (v: number): string => (v > 0 ? `+${v}` : String(v));

/** the eslint warnings of a lane and how much they changed over the mainline: `138（-3）`, absent when it has none */
const eslintCount = (lane: MetricsLane): string | undefined => {
  const warnings = lane.checks.eslint_warnings;
  if (warnings === undefined) return undefined;
  const inside = [
    lane.checks.eslint_delta ? signed(lane.checks.eslint_delta) : undefined,
    // a count taken over is the earlier tip's value, not this round's own (C-193-4)
    lane.checks.eslint_at ? `前回の本流 ${lane.checks.eslint_at.slice(0, 7)} の値` : undefined,
  ].filter(Boolean).join(" / ");
  return `${warnings}${inside ? `（${inside}）` : ""}`;
};

/** one lane's row of the terminal table */
function laneLine(lane: MetricsLane): string {
  const g = lane.granularity;
  return [
    lane.iddId,
    lane.settings_key ? lane.settings_key.slice(0, 8) : "記録なし",
    `$${n(lane.cost.budget)}`,
    lane.cost.subscription ? `サブスク $${n(lane.cost.subscription)}` : "",
    `段 ${min(lane.time.stage)}`,
    `関所 ${min(lane.time.gate)}`,
    `待ち ${min(lane.time.wait)}`,
    lane.checks.rounds ? `検査 ${lane.checks.rounds} 回 ${n(lane.checks.wall_seconds, 1)} 秒${lane.checks.cpu_seconds !== undefined ? ` / CPU ${n(lane.checks.cpu_seconds, 1)} 秒` : ""}` : "",
    lane.checks.typecheck_failures ? `tsc 失敗 ${lane.checks.typecheck_failures}` : "",
    lane.checks.eslint_warnings !== undefined ? `警告 ${eslintCount(lane)}` : "",
    lane.landed_lines !== undefined ? `${lane.landed_lines} 行` : "",
    g.proposed || g.split || g.fix_sent || g.escalated || g.signed ? `粒度 提案 ${g.proposed} / 分割 ${g.split} / 修正 ${g.fix_sent} / 段上げ ${g.escalated} / 署名 ${g.signed}` : "",
    lane.sent_back ? `差し戻し ${lane.sent_back}` : "",
    ...laneHandsParts(lane),
  ].filter(Boolean).join("  ");
}

/** what the canary's row marks: the shape that failed, and the two numbers a change is read from */
function canaryMarks(row: CanaryRow): string[] {
  const names: string[] = [];
  if (row.marks.structure) names.push("構造");
  if (row.marks.chars) names.push("長さ");
  if (row.marks.total_ms) names.push("所要時間");
  return names;
}

/** one compared value: the value, and how it stands against the period before it */
function compared(value: number, before: number | undefined, ratio: number | undefined, unit: (v: number) => string, mark: boolean): string {
  const shown = unit(value);
  if (before === undefined) return shown;
  const change = ratio === undefined ? "×—" : `×${n(ratio, 2)}`;
  return `${mark ? "!" : ""}${shown}（前週 ${unit(before)}・${change}）`;
}

const charsValue = (v: number): string => `${Math.round(v)} 文字`;
const msValue = (v: number): string => `${n(v / 1000, 1)} 秒`;

/** one canary row of the terminal table: the role, the question and the three numbers, with the marks in front */
function canaryLine(row: CanaryRow): string {
  const before = row.previous;
  return [
    `${canaryMarks(row).length ? "!" : " "}${row.role}`,
    row.model,
    row.task,
    `構造 ${row.marks.structure ? "!fail" : row.current.structure}`,
    `長さ ${compared(row.current.chars, before?.chars, row.ratio.chars, charsValue, row.marks.chars)}`,
    `所要時間 ${compared(row.current.total_ms, before?.total_ms, row.ratio.total_ms, msValue, row.marks.total_ms)}`,
    `$${n(row.current.usd, 5)}`,
    ...(row.current.error ? [`失敗 ${row.current.error}`] : []),
  ].join("  ");
}

/** a count with its share of the group, `3（37.5%）`; no share without a group */
const share = (count: number, total: number): string => (total ? `${count}（${(Math.round((count / total) * 1000) / 10).toFixed(1)}%）` : String(count));

/** one group's four fates as cells, in the order the table reads them */
const fateCells = (row: NetFateRow): string[] => [row.total, row.accepted, row.followup, row.skip, row.rejected].map((v, i) => (i === 0 ? String(v) : share(v, row.total)));

/** a leak's row, or a returned must's row, on one line: the lane first, so a fenced line never starts with a fence */
const returnedLine = (r: ReturnedMust): string =>
  `${r.lane}  ${r.previous} → ${r.via.map((v) => `${v} → `).join("")}${r.returned}${r.returns > 1 ? `（${r.returns} 回）` : ""}  ${r.path}`.replace(/[\r\n]+/g, " ");

const leakLine = (l: MetricsLeak): string =>
  `${l.lane}  merge ${l.merge.slice(0, 12)}  fix ${l.fix.slice(0, 12)}  ${l.date}  ${{ revert: "revert", fix: "fix", named: "名指し" }[l.kind]}${l.issues.length ? `  ${l.issues.map((i) => `#${i}`).join(" ")}` : ""}  ${l.files.join(", ")}`.replace(/[\r\n]+/g, " ");

/** the public side lanes whose landing was not found on the mainline: said apart from the rows, never folded into none */
const unresolvedLine = (n: number): string => `着地を解けなかった公開 lane: ${n} 件（PR の head が本流に merge で入っていない。漏れの有無は分からない）`;

/** the leaks of one repo as lines; an unreadable repo says so instead of showing none */
const leakLines = (area: MetricsLeakArea): string[] => (area.rows === null ? ["読めない"] : area.rows.map(leakLine));

/** the terminal table: the totals, the groups, the lanes, the canary, the flaky candidates and the direct commits */
export function formatMetricsTable(view: MetricsView): string[] {
  const out: string[] = [];
  out.push(`期間 ${view.since} 〜 ${view.until}: lane ${view.totals.lanes} 本`);
  out.push(
    `費用 予算 $${n(view.totals.cost.budget)} / サブスク換算 $${n(view.totals.cost.subscription)}` +
    (view.totals.cost.per_1000_lines !== undefined ? ` / 1,000 行あたり $${n(view.totals.cost.per_1000_lines)}（${view.totals.landed_lines} 行）` : "") +
    `  時間 段 ${min(view.totals.time.stage)} / 関所 ${min(view.totals.time.gate)} / 待ち ${min(view.totals.time.wait)}`,
  );
  out.push(
    `検査 ${view.totals.checks.rounds} 回（wall ${n(view.totals.checks.wall_seconds, 1)} 秒 / CPU ${n(view.totals.checks.cpu_seconds, 1)} 秒）` +
    `  tsc の失敗 ${view.totals.checks.typecheck_failures} 回  差し戻し ${view.totals.sent_back}`,
  );
  const g = view.totals.granularity;
  out.push(`粒度 提案 ${g.proposed} / 分割 ${g.split} / 修正の巡 ${g.fix_sent} / 段上げ ${g.escalated} / 署名 ${g.signed}`, ...handsSummaryLines(view));
  if (view.direct_commits.length) {
    out.push(`本流への直接 commit: ${view.direct_commits.map((d) => `${d.area} ${d.commits === null ? "読めない" : `${d.commits} 本`}`).join(" / ")}`);
  }
  out.push("");
  out.push("設定の群:");
  for (const group of view.groups) {
    out.push(
      `  ${group.settings_key === "none" ? "記録なし" : group.settings_key.slice(0, 8)}  ${group.lanes.length} 本` +
      `  予算 $${n(group.cost.budget)}${group.cost.per_1000_lines !== undefined ? `（1,000 行 $${n(group.cost.per_1000_lines)}）` : ""}` +
      `  平均 段 ${min(group.time_mean.stage)} / 関所 ${min(group.time_mean.gate)} / 待ち ${min(group.time_mean.wait)}`,
    );
  }
  out.push("");
  out.push("lane:");
  for (const lane of view.lanes) out.push(`  ${laneLine(lane)}`);
  const roles = view.lanes.filter((l) => l.cost.roles.length);
  if (roles.length) {
    out.push("");
    out.push("role 別（USD / token）:");
    for (const lane of roles) {
      out.push(`  ${lane.iddId}: ${lane.cost.roles.map((r) => `${r.role}${r.model ? ` (${r.model})` : ""} $${n(r.usd, 3)}（入 ${r.tokens.input} / 出 ${r.tokens.output} / cache 読 ${r.tokens.cacheRead} / cache 書 ${r.tokens.cacheWrite}）`).join(" / ")}`);
    }
  }
  out.push("");
  out.push(...quotaShareLines(view.quota), "");
  out.push(`canary（role の model の観測。印は前週 ${view.canary.previous.since} 〜 ${view.canary.previous.until} の同じ role・同じ課題との差。費用は値を出すだけで印を付けません）:`);
  if (!view.canary.rows.length) out.push("  この期間の記録はありません。");
  else for (const row of view.canary.rows) out.push(`  ${canaryLine(row)}`);
  out.push("");
  out.push(`網（判断の時刻が期間のもの）: 判断 ${view.net.judgements} 回  人に上げた ${view.net.escalated} 件（下の 4 つには入れません）`);
  if (!view.net.fates.length) out.push("  この期間に判断された指摘はありません。");
  for (const row of view.net.fates) {
    const [total, ...fates] = fateCells(row);
    out.push(`  ${row.role}  ${row.weight}  分母 ${total}: ${["受理", "後回し", "見送り", "棄却"].map((name, i) => `${name} ${fates[i]}`).join(" / ")}`);
  }
  out.push(`修正の後に戻った must: ${view.net.returned.length} 件`);
  for (const r of view.net.returned) out.push(`  ${returnedLine(r)}`);
  out.push("着地の後に直された漏れ:");
  for (const area of view.net.leaks) {
    out.push(`  ${area.repo}: ${area.rows === null ? "読めない" : `${area.rows.length} 件`}`);
    for (const l of leakLines(area)) if (area.rows !== null) out.push(`    ${l}`);
    if (area.rows !== null && area.unresolved) out.push(`    ${unresolvedLine(area.unresolved)}`);
  }
  if (view.flaky.length) {
    out.push("");
    out.push("揺れた検査（起票の候補。ここからは起票しません）:");
    for (const f of view.flaky) out.push(`  ${f.lane}  ${f.check}${f.test ? `  ${f.test}` : ""}  ${f.count} 回`);
  }
  return out;
}

/** the ISO week a JST day falls in, as `2026-W42` */
export function isoWeek(day: string): { week: string; slug: string } {
  const date = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((thursday.getTime() - first.getTime()) / 86400000) + 1) / 7);
  const label = `${year}-W${String(week).padStart(2, "0")}`;
  return { week: label, slug: `${year}-${String(week).padStart(2, "0")}` };
}

/** the survey's place: `_docs/survey/metrics/<year>-<week>/survey.md` (the validator's path for a survey) */
export function surveyPath(day: string): string {
  return `_docs/survey/metrics/${isoWeek(day).slug}/survey.md`;
}

/** one group's row of the weekly table */
export interface SurveyOptions {
  /** the day the week is read at (the ISO week of this day names the file); the period's last day by default */
  day?: string;
  /** where the document is written; a person commits it (the machine never writes it into the repo) */
  path?: string;
}

/**
 * The week's table as the survey document. Every row names the record it was read from, so a reader can go back to
 * the round, the event or the file; nothing is filed, and the flaky rows are the candidates a person may turn into
 * an issue.
 */
export function renderMetricsSurvey(view: MetricsView, opts: SurveyOptions = {}): string {
  const day = opts.day ?? view.until;
  const week = isoWeek(day);
  const path = opts.path ?? surveyPath(day);
  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: "週の指標 ${week.week}（${view.since} 〜 ${view.until}）"`);
  lines.push("status: active");
  lines.push(`created_at: ${view.until}`);
  lines.push(`updated_at: ${view.until}`);
  lines.push("references: []");
  lines.push("related_issues: []");
  lines.push("related_prs: []");
  lines.push("---");
  lines.push("");
  lines.push(`<!-- Canonical path: ${path} -->`);
  lines.push("");
  lines.push(`# 週の指標 ${week.week}`);
  lines.push("");
  lines.push("## 問い");
  lines.push("");
  lines.push("この週に本流へ入った lane は、どれだけの費用・時間・検査を使って、どのくらいの量を入れたか。lane が開いたときの pipeline の設定ごとに、同じ数字を比べられるか。");
  lines.push("");
  lines.push("## 条件");
  lines.push("");
  lines.push(`- 期間は JST の ${view.since} 〜 ${view.until}。期間に入るのは、この間に \`lane_open\` のあった lane。`);
  lines.push("- 費用は予算の判定と同じ読み手の値。予算が数える分と、Claude Code のサブスクの API 換算を分けて出す。");
  lines.push("- 時間は段・関所・待ちの 3 つに分ける（1 つの区間は 1 つにだけ入る）。段の切り方は見込みと同じ切り方。");
  lines.push("- 検査の回は、取り込みの検査の記録に追記された回のうち、外から止めていないもの。CPU 秒は回の cgroup（読めないときは process 自身）の差。");
  lines.push("- 1,000 行あたりの費用は、着地した merge commit が本流の先端から変えた行（追加 + 削除）で割った値。");
  lines.push("- 揺れた検査は、同じ head の回で落ちて、後の回で通ったもの。起票の候補として並べるだけで、ここからは起票しない。");
  lines.push("- 網の節の期間は、費用・時間の表の `lane_open` ではなく、判断（triage）の時刻と、漏れを直した commit の時刻で切る。古い lane の今週の巡は今週に入る。");
  lines.push("- 指摘の運命は 4 つに分ける。受理（must か、扱いが fix か読めないもの）・後回し（followup）・見送り（skip）・棄却（reject）で、4 つの和が組の分母になる。人に上げたもの（escalate）は重さも役も持たないので 4 つに混ぜず、件数だけを別に出す。訂正の後の重さと扱いで読む。");
  lines.push("- 役と重さは判断の event に残った値で読む。run の directory は 1 週間で消えるので使わない。役は同じ巡の `run_roles` に照らして決め、決められない指摘と指摘者の重さのない指摘は「記録なし」の群に入る。1 つの指摘を複数の役が見つけたときは、役ごとの行のそれぞれに入る（重さごとの合計は 1 指摘を 1 度だけ数える）。");
  lines.push("- 戻った must は、前の巡で受理された must と同じ path で claim の文字の組が近く（Dice 係数 0.45 以上）、間に修正の巡がある受理の must。同じ巡の同じ指摘は 1 件、同じ must が続けて戻った分は 1 行にまとめて回数を添える。");
  lines.push("- 漏れは、着地の merge が入れた行を、その後 7 日以内に本流へ直接入った commit（別の lane の merge ではない）が書き換えたもの。revert・hotfix・fix の型の commit か、その lane か Issue を名指す commit に限る。");
  lines.push(`- canary は pipeline の pi の role の model を、道具を渡さず role の thinking のまま、日ごとに同じ課題で 1 回ずつ回した値。比較の相手は期間の直前の同じ長さ（${view.canary.previous.since} 〜 ${view.canary.previous.until}）で、長さと所要時間は前週の同じ role・同じ課題の値と比べる。`, ...HANDS_SURVEY_CONDITIONS);
  lines.push("");
  lines.push("## 結果");
  lines.push("");
  lines.push("### 全体");
  lines.push("");
  lines.push("| 指標 | 値 | 出典 |");
  lines.push("| --- | --- | --- |");
  lines.push(`| lane | ${view.totals.lanes} 本 | 台帳の \`lane_open\` |`);
  lines.push(`| 費用（予算） | $${n(view.totals.cost.budget)} | 予算の読み手 |`);
  lines.push(`| 費用（サブスク換算） | $${n(view.totals.cost.subscription)} | 予算の読み手 |`);
  lines.push(`| 着地した行 | ${view.totals.landed_lines} 行 | 取り込みの検査の記録の \`diff_lines\` |`);
  lines.push(`| 1,000 行あたり | ${view.totals.cost.per_1000_lines === undefined ? "—" : `$${n(view.totals.cost.per_1000_lines)}`} | 上の 2 つ |`);
  lines.push(`| 段の時間 | ${min(view.totals.time.stage)} | 台帳の event を段の切り方で切った値 |`);
  lines.push(`| 関所の時間 | ${min(view.totals.time.gate)} | 同上 |`);
  lines.push(`| 待ちの時間 | ${min(view.totals.time.wait)} | 同上 |`);
  lines.push(`| 取り込みの検査 | ${view.totals.checks.rounds} 回 | 取り込みの検査の記録 |`);
  lines.push(`| 検査 1 回の wall | ${n(view.totals.checks.wall_seconds, 1)} 秒（合計） | 同上 |`);
  lines.push(`| 検査 1 回の CPU | ${n(view.totals.checks.cpu_seconds, 1)} 秒（合計） | 同上 |`);
  lines.push(`| tsc の落ちた回 | ${view.totals.checks.typecheck_failures} 回 | 同上の \`typecheck\` の行 |`);
  lines.push(`| eslint の警告 | ${eslintTotals(view)} | 同じ回の増分の検査の数 |`);
  lines.push(`| 直接 commit | ${view.direct_commits.map((d) => `${d.area} ${d.commits === null ? "読めない" : `${d.commits} 本`}`).join(" / ") || "—"} | 本流の first-parent の merge でない commit |`);
  lines.push(`| 差し戻し | ${view.totals.sent_back} 回 | 台帳の \`s4_verify_user_judgment_answered\`（revise） |`, ...handsTotalRows(view));
  lines.push(`| 粒度: 提案 | ${view.totals.granularity.proposed} | 台帳の \`s1_granularity_proposed\` |`);
  lines.push(`| 粒度: 分割 | ${view.totals.granularity.split} | 台帳の \`s1_granularity_answered\`（split） |`);
  lines.push(`| 粒度: 修正の巡 | ${view.totals.granularity.fix_sent} | 台帳の \`s2_fix_sent\` |`);
  lines.push(`| 粒度: 段上げ | ${view.totals.granularity.escalated} | 台帳の \`s2_review_escalated\` |`);
  lines.push(`| 粒度: 署名して着地 | ${view.totals.granularity.signed} | 台帳の \`s4_land_approved\`（signed） |`);
  lines.push("");
  lines.push("### 設定の群");
  lines.push("");
  lines.push("| 設定 | lane | 費用（予算） | サブスク換算 | 1,000 行あたり | 平均の段 | 平均の関所 | 平均の待ち | 検査の回 | 検査の wall | 検査の CPU |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const group of view.groups) {
    lines.push(
      `| ${group.settings_key === "none" ? "記録なし" : group.settings_key.slice(0, 8)} | ${group.lanes.length} 本 | $${n(group.cost.budget)} | $${n(group.cost.subscription)} | ${group.cost.per_1000_lines === undefined ? "—" : `$${n(group.cost.per_1000_lines)}`} | ${min(group.time_mean.stage)} | ${min(group.time_mean.gate)} | ${min(group.time_mean.wait)} | ${group.checks.rounds} | ${n(group.checks.wall_seconds, 1)} 秒 | ${n(group.checks.cpu_seconds, 1)} 秒 |`,
    );
  }
  lines.push("");
  lines.push("群の鍵は \`lane_open\` の pipeline の写しのハッシュ。写しの無い lane（この欄ができる前に開いた lane）は「記録なし」の群に入る。");
  lines.push("");
  lines.push("### lane ごと");
  lines.push("");
  lines.push("| lane | 設定 | 費用（予算） | サブスク換算 | 段 | 関所 | 待ち | 検査の回 | tsc の落ちた回 | eslint の警告 | 着地した行 | 粒度（提案 / 分割 / 修正 / 段上げ / 署名） | 差し戻し |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const lane of view.lanes) {
    const g = lane.granularity;
    lines.push(
      `| ${lane.iddId} | ${lane.settings_key ? lane.settings_key.slice(0, 8) : "記録なし"} | $${n(lane.cost.budget)} | $${n(lane.cost.subscription)} | ${min(lane.time.stage)} | ${min(lane.time.gate)} | ${min(lane.time.wait)} | ${lane.checks.rounds} | ${lane.checks.typecheck_failures} | ${eslintCount(lane) ?? "—"} | ${lane.landed_lines ?? "—"} | ${g.proposed} / ${g.split} / ${g.fix_sent} / ${g.escalated} / ${g.signed} | ${lane.sent_back} |`,
    );
  }
  lines.push("", ...handsSections(view));
  lines.push("### role 別の費用と token");
  lines.push("");
  lines.push("| lane | role | model | USD | 入力 | 出力 | cache 読 | cache 書 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  const roleLanes = view.lanes.filter((l) => l.cost.roles.length);
  if (!roleLanes.length) lines.push("| — | — | — | — | — | — | — | — |");
  for (const lane of roleLanes) {
    for (const role of lane.cost.roles) {
      lines.push(`| ${lane.iddId} | ${role.role} | ${role.model ?? "—"} | $${n(role.usd, 3)} | ${role.tokens.input} | ${role.tokens.output} | ${role.tokens.cacheRead} | ${role.tokens.cacheWrite} |`);
    }
  }
  lines.push("");
  lines.push(...quotaShareSurveyLines(view.quota), "");
  lines.push("### canary（role の model の観測）");
  lines.push("");
  lines.push("pipeline の pi の role の model を、日ごとに同じ課題で回した値です。印は、構造の判定が fail の値と、長さか所要時間が前週の同じ role・同じ課題の値から 2 倍以上変わった値です（前週の値が無い値には印を付けません）。所要時間は問いを投げてから runner が終わるまでの合計で、model の応答そのものでも role の agent dir の用意の時間でもありません。費用は値を出すだけで、印を付けません。");
  lines.push("");
  lines.push("| role | model | 課題 | 日 | 構造 | 長さ | 所要時間 | 費用 | 印 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  if (!view.canary.rows.length) lines.push("| — | — | — | — | — | — | — | — | — |");
  for (const row of view.canary.rows) {
    const before = row.previous;
    lines.push(
      `| ${row.role} | ${row.model} | ${row.task} | ${row.current.day} | ${row.marks.structure ? "!fail" : row.current.structure} | ${compared(row.current.chars, before?.chars, row.ratio.chars, charsValue, row.marks.chars)} | ${compared(row.current.total_ms, before?.total_ms, row.ratio.total_ms, msValue, row.marks.total_ms)} | $${n(row.current.usd, 5)} | ${canaryMarks(row).join(" / ") || "—"} |`,
    );
  }
  lines.push("");
  lines.push("記録は \`state/pipeline/canary/<日付>/\` の下に role ごとの file で残る。この表のために engine も tick も survey を書かない。");
  lines.push("");
  lines.push("### 網: 指摘の運命（レビュー役 × 指摘者の重さ）");
  lines.push("");
  lines.push(`期間内の判断は ${view.net.judgements} 回。人に上げた指摘は ${view.net.escalated} 件（4 つの運命には入れていない）。`);
  lines.push("");
  lines.push("| レビュー役 | 指摘者の重さ | 分母 | 受理 | 後回し | 見送り | 棄却 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  if (!view.net.fates.length) lines.push("| — | — | — | — | — | — | — |");
  for (const row of view.net.fates) lines.push(`| ${row.role} | ${row.weight} | ${fateCells(row).join(" | ")} |`);
  lines.push("");
  lines.push("重さごとの合計（1 つの指摘を 1 度だけ数える）:");
  lines.push("");
  lines.push("| 指摘者の重さ | 分母 | 受理 | 後回し | 見送り | 棄却 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  if (!view.net.weights.length) lines.push("| — | — | — | — | — | — |");
  for (const row of view.net.weights) lines.push(`| ${row.weight} | ${fateCells(row).join(" | ")} |`);
  lines.push("");
  lines.push("出典は台帳の `s2_triage_done`（accepted・rejected・escalated_claims）と、同じ巡の `s2_review_started` の `run_roles`、訂正の `s2_review_resumed`。");
  lines.push("");
  lines.push("### 網: 修正の後に戻った must");
  lines.push("");
  if (!view.net.returned.length) lines.push("この週に戻った must はありません。");
  else {
    lines.push("lane、前の巡の ref → 戻った巡の ref、path の順。path と ref は元のまま残すので、囲みの中に置く。");
    lines.push("");
    lines.push(...fenced(view.net.returned.map(returnedLine)));
  }
  lines.push("");
  lines.push("### 網: 着地の後に直された漏れ");
  lines.push("");
  lines.push("lane、着地の merge commit、直した commit、直した日、型、直した file の順。直した日が期間の漏れを、着地の週によらず並べる。");
  for (const area of view.net.leaks) {
    lines.push("");
    lines.push(`${area.repo}:`);
    lines.push("");
    if (area.rows === null) lines.push("読めない（対象 repo の work の clone か git を読めなかった。0 件ではない）。");
    else if (!area.rows.length) lines.push("この週に直された漏れはありません。");
    else lines.push(...fenced(leakLines(area)));
    if (area.rows !== null && area.unresolved) lines.push("", unresolvedLine(area.unresolved));
  }
  if (!view.net.leaks.length) {
    lines.push("");
    lines.push("読める work の clone を持つ repo の登録がありません。");
  }
  lines.push("");
  lines.push("### 揺れた検査（起票の候補）");
  lines.push("");
  if (!view.flaky.length) lines.push("この週の揺れはありません。");
  else {
    lines.push("テスト名は元のまま残す。survey の本文には台帳の ID を書けないので、名前を含む行は囲みの中に置く。");
    lines.push("");
    lines.push(...fenced(view.flaky.map(flakyLine)));
    lines.push("");
    lines.push("候補はここまで。起票は人が選んで行う。");
  }
  lines.push("");
  lines.push("## 確かめていないこと");
  lines.push("");
  lines.push("- 期間に入るのは \`lane_open\` が期間内の lane だけ。期間の前に開いて期間に閉じた lane の費用と時間は、この表に入らない。");
  lines.push("- 1,000 行あたりの行は、着地した merge commit の差分の行で、公開側（public_base）に限定していない。公開しない repo の lane では、着地した差分の全体がこの数になる。");
  lines.push("- role 別の token は consumption の行から引いた値。行の無い role、行より前の session の分は入らない。");
  lines.push(...QUOTA_SHARE_UNCHECKED);
  lines.push("- CPU 秒は、cgroup が読める環境では回の scope の差、読めない環境では検査の process 自身の使用時間。同じ cgroup で並走した別の検査の分は、前者では混ざりうる。");
  lines.push("- 揺れた検査は、同じ head で落ちて後の回で通ったものだけ。本流の先端が変わったために落ちた検査は、head が同じでも原因が別でありうる。");
  lines.push("- 網の数は、後回しの指摘が後で直ったかを追わない。後回しと見送りは、merge のときに直されずに残った数で、あとで直す予定かどうかは分けるが、直ったかは見ない。");
  lines.push("- 役を決められない指摘（run_roles の無い古い巡や、directory 名が役に当たらないもの）は「記録なし」の群に入り、判定の重さで埋めていない。");
  lines.push("- 漏れは、着地の行を後の直接 commit が書き換えた事実だけで数える。別の lane の merge で直された欠陥と、書き換えを伴わない不具合は入らない。公開側の lane の着地は、PR を出した head が本流に merge で入ったものだけを解き、squash などで head が残らないものは件数だけを添える。7 日は固定で、境の近くの直しは入るか入らないかが日の切り方で決まる。");
  lines.push("- 戻った must の claim の近さの閾値は固定で、境の近くの組は同じ指摘かどうかを読み違えうる。これは戻った must だけの条件で、漏れの判定には使わない。");
  lines.push("- 取り込みの検査の回ごとの記録は、この仕組みが入った後に終わった回から残る。それより前の回は lane ごとの最新の記録にしか残っておらず、この表の検査の欄には入らない。", ...HANDS_NOT_CHECKED);
  lines.push("- 週の表は人が \`idd metrics --survey\` で出して commit する。engine も tick もこの file を書かない。");
  lines.push("- canary の値は provider の model の応答から来る。model の id が同じまま重みが入れ替わっても、その日の値が動かなければ、この表には何も出ない。");
  lines.push("- canary の費用は canary の記録だけに残り、lane の費用・合計・1,000 行あたりには入らない。");
  lines.push("- canary の課題は repo の fixture に対する 4 問（code の読み 2・JSON の生成 1・直しの diff 1）。課題文を変えると前週と比べられないので、課題は記録に残した形のまま使う。");
  lines.push("");
  return lines.join("\n");
}

/**
 * A fenced block for text the survey must keep as it is: a test name may carry a ledger id or a link, which the
 * survey's rules do not read inside a fence. The fence is longer than any run of backticks in the lines, so a name
 * cannot end it early, and every line starts with the lane, so no line starts with a fence of its own.
 */
function fenced(rows: string[]): string[] {
  const longest = rows.reduce((widest, row) => {
    for (const run of row.match(/`+/g) ?? []) widest = Math.max(widest, run.length);
    return widest;
  }, 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence, ...rows, fence];
}

/** one flaky candidate on one line: a newline in a name must not become a line of its own */
function flakyLine(f: MetricsFlaky): string {
  return `${f.lane}  ${f.check}  ${f.test || "（テスト名なし）"}  ${f.count} 回`.replace(/[\r\n]+/g, " ");
}

/** the eslint warnings of the period: the newest count per lane, and how much it grew */
function eslintTotals(view: MetricsView): string {
  const withCount = view.lanes.filter((l) => l.checks.eslint_warnings !== undefined);
  if (!withCount.length) return "—";
  const newest = withCount.sort((a, b) => (b.opened_at > a.opened_at ? 1 : -1))[0];
  const grown = withCount.reduce((a, l) => a + Math.max(0, l.checks.eslint_delta ?? 0), 0);
  const source = newest.checks.eslint_at
    ? `${newest.iddId} の前回の本流 ${newest.checks.eslint_at.slice(0, 7)} の値`
    : `${newest.iddId} の最新の回`;
  return `${newest.checks.eslint_warnings}（${source}） / 増えた分の合計 ${grown}`;
}
