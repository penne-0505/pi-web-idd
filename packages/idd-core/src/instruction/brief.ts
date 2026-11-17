/**
 * How the instructions that apply are told to an agent: as a section of a run's brief (the one text every stage's
 * agent reads, whichever harness runs it), and as the text a conversation's system prompt carries at its start. Both
 * hold the instruction and its reason and nothing else, so the agent has no other file to open.
 */
import { CLI_NAME, esc, rules, type MessageSection } from "../agent/message.ts";
import { SCENES } from "./scope.ts";
import type { Picked } from "./store.ts";

/** the section's name in a brief */
export const INSTRUCTIONS_SECTION = "instructions";

const FRAMING = "利用者が自分で決めた恒久の方針。この場面に当てはまるものだけが届いている。利用者の判断の好みとして従う。規約・Choice・AC・計画の置き換えではない。";

function itemLine(p: Picked): string {
  return `- ${p.text}（理由: ${p.reason}）`;
}

/** the brief's section, or null when nothing applies (the brief is then what it was before this feature) */
export function instructionsSection(picked: readonly Picked[]): MessageSection | null {
  if (!picked.length) return null;
  return rules(INSTRUCTIONS_SECTION, [FRAMING, ...picked.map(itemLine)].map(esc));
}

/** what a conversation is told about proposing: the way in, and that nothing takes effect until the user approves */
export function proposeGuidance(): string {
  return [
    "利用者が自分の方針（今後も守ってほしい判断の好み）を言ったら、1 文と理由 1 行にまとめて案として出せる。",
    `出し方: \`${CLI_NAME} instruction propose add --text "<1 文>" --reason "<理由 1 行>" --repo <owner/name|all> --scene <${SCENES.join(",")}|all> --place <lane,conversation|all>\`。変更は \`propose change --id INS-n\`（書いた項目だけを変える。--repo・--scene・--place は書いた軸だけが変わり、書かなかった軸は今の値のまま）、引退は \`propose retire --id INS-n\`。`,
    "案は利用者が新しい画面の Inbox の案の card で承認するまで、どこにも効かない。承認と見送りは利用者だけができる。",
  ].join("\n");
}

/**
 * The text a conversation's system prompt carries: the instructions that apply to it, then how to propose one. The
 * guidance is there even when no instruction applies, since a conversation is where one is first said.
 */
export function conversationInstructionPrompt(picked: readonly Picked[]): string {
  const lines: string[] = [];
  if (picked.length) {
    lines.push(FRAMING.replace("この場面に当てはまるもの", "この会話に当てはまるもの"), ...picked.map(itemLine), "");
  }
  lines.push(proposeGuidance());
  return lines.join("\n");
}
