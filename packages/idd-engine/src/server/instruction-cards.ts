/**
 * The Inbox cards of the user's instruction proposals. A proposal is the only thing that can change the instructions,
 * and it takes effect only when the user answers its card: this file builds the card from the proposal and the
 * instruction it is about, and decides nothing.
 */
import {
  activeInstructions, describePartialScope, describeScope, instructionApprovalContent, openInstructionProposals, reviewNotice,
  type Instruction, type InstructionProposal,
} from "@idd/core";

import { INSTRUCTION_CARD_REPO, type ProposalItem } from "../../../../lib/idd-ui/types.ts";

const HANDLE_MAX = 40;

function cutHandle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return [...t].length > HANDLE_MAX ? `${[...t].slice(0, HANDLE_MAX - 1).join("")}…` : t;
}

function rowsOf(content: { text?: string; reason?: string; scope?: Instruction["scope"] }, prefix: string): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (content.text !== undefined) rows.push({ label: `${prefix}方針`, value: content.text });
  if (content.reason !== undefined) rows.push({ label: `${prefix}理由`, value: content.reason });
  if (content.scope !== undefined) rows.push({ label: `${prefix}範囲`, value: describeScope(content.scope) });
  return rows;
}

/** the rows of what an add or a change would leave: a change names the scope axes it changes and keeps the others as they are */
function afterRows(proposal: InstructionProposal, current: Instruction | undefined): { label: string; value: string }[] {
  const rows = rowsOf({ ...(proposal.text !== undefined ? { text: proposal.text } : {}), ...(proposal.reason !== undefined ? { reason: proposal.reason } : {}) }, "案の");
  if (proposal.scope === undefined) return rows;
  rows.push({ label: "案の範囲", value: proposal.kind === "change" ? describePartialScope(current?.scope, proposal.scope) : describeScope(proposal.scope as Instruction["scope"]) });
  return rows;
}

/** what the user's passkey signs to approve one proposal: the challenge door and the decision door build it the same way */
export function instructionApprovalContentOf(proposal: InstructionProposal, rejection?: { reason: string }): Record<string, unknown> {
  return instructionApprovalContent({
    ...(rejection ? { answer: "reject" as const, rejectReason: rejection.reason } : {}),
    proposal: proposal.id,
    proposalKind: proposal.kind,
    ...(proposal.target !== undefined ? { target: proposal.target } : {}),
    ...(proposal.text !== undefined ? { text: proposal.text } : {}),
    ...(proposal.reason !== undefined ? { reason: proposal.reason } : {}),
    ...(proposal.scope !== undefined ? { scope: proposal.scope } : {}),
    session: proposal.session,
    ...(proposal.op !== undefined ? { op: proposal.op } : {}),
    ...(proposal.for_session !== undefined ? { forSession: proposal.for_session } : {}),
  });
}

const SESSION_OP_WORDS: Record<string, string> = {
  add: "この会話にだけ足す（範囲に当たらなくても届く）",
  exclude: "この会話からだけ外す（範囲に当たっても届かない）",
  clear: "この会話の追加と除外をやめる（範囲の照合に戻る）",
};

/** the card of a session proposal: one conversation's own list, and nothing in force for any other */
function sessionProposalItem(proposal: InstructionProposal, inForce: readonly Instruction[]): ProposalItem {
  const current = proposal.target ? inForce.find((i) => i.id === proposal.target) : undefined;
  const op = proposal.op ?? "add";
  const verb = op === "add" ? "足す" : op === "exclude" ? "外す" : "やめる";
  return {
    kind: "proposal",
    proposalId: proposal.id,
    proposalKind: "instruction_session",
    repo: INSTRUCTION_CARD_REPO,
    handle: cutHandle(`会話 ${proposal.for_session ?? ""} だけ ${proposal.target ?? ""} を${verb}案`),
    reason: current ? `${current.text}（理由: ${current.reason}）` : "",
    before: current ? rowsOf(current, "今の") : [],
    after: [
      { label: "対象の会話", value: proposal.for_session ?? "" },
      { label: "案", value: SESSION_OP_WORDS[op] ?? op },
    ],
    from: { session: proposal.session, at: proposal.proposed_at },
    appearedAt: proposal.proposed_at,
    effect: "now",
  };
}

/** the card of one open instruction proposal */
export function instructionProposalItem(proposal: InstructionProposal, inForce: readonly Instruction[] = activeInstructions()): ProposalItem {
  if (proposal.kind === "session") return sessionProposalItem(proposal, inForce);
  const current = proposal.target ? inForce.find((i) => i.id === proposal.target) : undefined;
  const kind = proposal.kind === "add" ? "instruction_add" : proposal.kind === "change" ? "instruction_change" : "instruction_retire";
  const handlePrefix = proposal.kind === "add" ? "方針を足す案: " : proposal.kind === "change" ? `${proposal.target ?? ""} を変える案: ` : `${proposal.target ?? ""} を引退させる案: `;
  const handleText = proposal.text ?? current?.text ?? proposal.target ?? "";
  const notice = reviewNotice(proposal, inForce.length);
  return {
    kind: "proposal",
    proposalId: proposal.id,
    proposalKind: kind,
    repo: INSTRUCTION_CARD_REPO,
    handle: cutHandle(`${handlePrefix}${handleText}`),
    // an add and a change carry the reason the instruction is wanted; a retire carries the reason it was kept so far
    reason: proposal.reason ?? current?.reason ?? "",
    before: current ? rowsOf(current, "今の") : [],
    after: proposal.kind === "retire" ? [{ label: "案", value: "この方針を引退させる（どの役にも会話にも届かなくなる）" }] : afterRows(proposal, current),
    from: { session: proposal.session, at: proposal.proposed_at },
    appearedAt: proposal.proposed_at,
    effect: "now",
    ...(notice ? { notice } : {}),
  };
}

/** one card per open instruction proposal; a file that cannot be read gives none, and the other cards still come back */
export function instructionProposalItems(): ProposalItem[] {
  try {
    const inForce = activeInstructions();
    return openInstructionProposals().map((p) => instructionProposalItem(p, inForce));
  } catch (err) {
    console.warn(`[idd state] 方針の案を読めませんでした: ${String(err).slice(0, 200)}`);
    return [];
  }
}
