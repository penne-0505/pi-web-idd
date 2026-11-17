/**
 * The one place a message to an agent is put together. Every brief, follow-up and one-shot generator (the PR /
 * commit drafts and the rewrites) sends a single `<propter-system-message>` built here, so the outer frame, the
 * order of its sections and the closing line cannot drift between the kinds of message.
 *
 * The sections are placed in a fixed order (norms -> task -> completion / deliverables -> rules -> callback ->
 * context -> the closing line), whatever order they are handed in; a follow-up leaves out the sections it has
 * none of. Values are escaped by the caller, because a section may carry XML of its own (`<lane>`, `<inputs>`).
 */

/** the CLI the briefs name. Renaming it (Workspace-Chore-79) changes this one constant. */
export const CLI_NAME = "idd";

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** the line every message ends with, right before its closing tag */
export const CLOSING_LINE = "以上のコンテクストで task を行う。";

/**
 * The name of the section that holds propter's philosophy of recording intent. It is never `purpose`: that word
 * names the lane's own Purposes, which a v2 brief hands over in its contract, so an agent reading both must not
 * have to guess which one a section called `purpose` holds. One name, used by every brief that carries the text.
 */
export const INTENT_WHY_SECTION = "intent-why" as const;

export type SectionKind = "norms" | typeof INTENT_WHY_SECTION | "task" | "completion" | "deliverables" | "rule" | "callback" | "context";

const ORDER: Record<SectionKind, number> = {
  norms: 0,
  // the philosophy stands outside the norms: a brief that must not carry it (a blind) simply leaves the section out
  [INTENT_WHY_SECTION]: 1,
  task: 2,
  completion: 3,
  deliverables: 4,
  rule: 5,
  callback: 6,
  context: 7,
};

export interface MessageSection {
  kind: SectionKind;
  /** the section as XML, including its own tags (e.g. `  <task>…</task>`) */
  xml: string;
}

export function section(kind: SectionKind, xml: string): MessageSection {
  return { kind, xml };
}

/** a rules section (`<writing-rules>` …) */
export function rules(name: string, lines: string[], indent = 2): MessageSection {
  const pad = " ".repeat(indent);
  const pad2 = " ".repeat(indent + 2);
  return section("rule", [
    `${pad}<${name}>`,
    ...lines.map((l) => (l ? `${pad2}${l}` : "")),
    `${pad}</${name}>`,
  ].join("\n"));
}

/** the message frame: sections in the fixed order, then the closing line and the closing tag */
export function renderMessage(sections: MessageSection[]): string {
  const ordered = [...sections].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  return [
    "<propter-system-message>",
    ...ordered.map((s) => s.xml),
    `  ${CLOSING_LINE}`,
    "</propter-system-message>",
  ].join("\n");
}

/** a `<callback>` section; the lines are already escaped and indented by the caller relative to its own indent */
export function callbackSection(lines: string[]): MessageSection {
  return section("callback", ["  <callback>", ...lines, "  </callback>"].join("\n"));
}
