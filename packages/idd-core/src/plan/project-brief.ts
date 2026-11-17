import { CLI_NAME, esc } from "../agent/message.ts";
import { foldRows, intentColumnPath, intentProjectName, laneStates, readRows } from "../intent/store.ts";
import type { ProjectView } from "../intent/project.ts";
import { projectOfLane } from "../intent/project-store.ts";
import { readLifecycle } from "../ledger/read.ts";
import type { BacklogRecord } from "../schema/records.ts";

/**
 * What the brief of a lane that belongs to a Project carries of it: the Project's aim (its Purpose and what finishing
 * looks like), its state, its decisions with a cap, and where the whole document is read. The free text of the
 * document is not copied here: the brief is read at every start, and a copy would stand beside the document the next
 * time it changes. Only the planner's and the executor's briefs (and the executor's fix rounds, which are the same
 * brief) call this; the blind, final, confirm and map briefs carry no record of intent, and the judge's brief keeps
 * receiving the Purpose's sentence alone.
 */

/** how many decisions are handed over with their reason; the rest are a heading each, so the document stays the place to read them */
export const PROJECT_DECISIONS_FULL = 5;
/** how many headings follow before the rest is a count */
export const PROJECT_DECISIONS_HEADINGS = 30;
/** a reason longer than this is cut, and says where the whole is read */
export const PROJECT_WHY_LIMIT = 1200;

function cut(textValue: string, limit: number): string {
  const flat = textValue.trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…（全文は \`${CLI_NAME} project show\`）` : flat;
}

/**
 * The lines of the `<project>` element for one Project, indented to sit inside the brief's `<lane>`. `purpose` is the
 * Purpose's statement read from the state for this reader; the Project holds only its id.
 */
export function projectBriefLines(project: ProjectView, input: { purposeStatement: string; document: string; role: "planner" | "executor" }): string[] {
  const open = project.decisions.filter((d) => !d.movedTo);
  const moved = project.decisions.length - open.length;
  const full = open.slice(0, PROJECT_DECISIONS_FULL);
  const headings = open.slice(PROJECT_DECISIONS_FULL, PROJECT_DECISIONS_FULL + PROJECT_DECISIONS_HEADINGS);
  const rest = open.length - full.length - headings.length;
  const lines = [
    `    <project id="${esc(project.id)}" state="${esc(project.state)}">`,
    `      <name>${esc(project.name)}</name>`,
    `      <purpose id="${esc(project.purpose)}">${esc(input.purposeStatement)}</purpose>`,
    `      <done-when>${esc(project.doneWhen)}</done-when>`,
    `      <document>${esc(`${input.document}（着地までは \`${CLI_NAME} project show ${project.id}\`）。本文はここに写さない`)}</document>`,
    `      <decisions count="${project.decisions.length}" shown="${full.length}">`,
    ...(project.decisions.length
      ? []
      : [`        ${esc("この Project に決定はまだ無い。")}`]),
    ...full.map((d) => [
      `        <decision id="${esc(d.id)}">`,
      `          <chosen>${esc(d.chosen)}</chosen>`,
      `          <why>${esc(cut(d.why ?? "", PROJECT_WHY_LIMIT))}</why>`,
      "        </decision>",
    ].join("\n")),
    ...headings.map((d) => `        <decision id="${esc(d.id)}"><chosen>${esc(d.chosen)}</chosen></decision>`),
    ...(rest > 0 ? [`        ${esc(`ほか ${rest} 件は見出しも省いた。文書から全部読める。`)}`] : []),
    ...(moved ? [`        ${esc(`${moved} 件は Choice に移した。移し先の Choice を読む。`)}`] : []),
    "      </decisions>",
    `      <how>${esc(input.role === "planner"
      ? `決定に Place が生えた（この変更で触る module が決まる）なら、この lane の context 文書に決定の ID と Place を書く（依頼の「重要なコンテクスト」は context 文書の所在だけを指す）。移すのは実装役で、\`${CLI_NAME} project promote\` で行う。`
      : `決定に Place が生えたなら、\`${CLI_NAME} project promote ${project.id} <決定の ID> --file F.json\` で Choice に移す（F.json は Place と anchored。決定の選んだ形・why・捨てた形は写される）。`)}</how>`,
    "    </project>",
  ];
  return lines;
}

/**
 * The `<project>` lines for a lane, or an empty list when the lane's Issue belongs to no Project (or the lane has no
 * Issue): a lane outside every Project gets the brief it always got. The Project is read from the lane's own side, so
 * a Project the lane wrote before it landed is already here.
 */
export function projectBriefFor(rec: BacklogRecord, role: "planner" | "executor"): string[] {
  const project = projectOfLane(rec.area, rec);
  if (!project) return [];
  const rows = readRows(intentColumnPath(rec.area));
  const folded = foldRows(rows, rec.idd_id, laneStates(readLifecycle()));
  const purpose = folded.purposes.find((p) => p.id === project.purpose);
  return projectBriefLines(project, {
    purposeStatement: purpose?.statement ?? "（この Purpose は状態にありません）",
    document: `_docs/intent/${intentProjectName(rec.area)}/${project.id}.md`,
    role,
  });
}
