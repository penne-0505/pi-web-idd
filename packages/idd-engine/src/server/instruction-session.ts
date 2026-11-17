/**
 * Apply an approved session proposal: add an instruction to one conversation's own list, leave it out, or drop either.
 * The marks file is the only thing written, and only the decision door calls this, after the user's signature over the
 * proposal. The conversation's marks route does not take these two lists: a request an agent can send must not be
 * able to change what it is told.
 */
import { type InstructionProposal, type SessionApplyResult } from "@idd/core";

import { conversationMarksWorkspace } from "./conversations.ts";
import { markOf, setSessionMark } from "./marks.ts";

export function applySessionException(proposal: InstructionProposal): SessionApplyResult {
  const session = proposal.for_session ?? "";
  const target = proposal.target ?? "";
  const workspace = conversationMarksWorkspace(session);
  if (!workspace) return { ok: false, error: `その会話はもうありません: ${session}` };
  const mark = markOf(workspace, session);
  const add = (mark.instructionAdd ?? []).filter((id) => id !== target);
  const exclude = (mark.instructionExclude ?? []).filter((id) => id !== target);
  if (proposal.op === "add") add.push(target);
  else if (proposal.op === "exclude") exclude.push(target);
  try {
    setSessionMark(workspace, session, { instructionAdd: add.length ? add : null, instructionExclude: exclude.length ? exclude : null });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}
