/**
 * The door a conversation's agent puts an instruction proposal down through, and the read door for the instructions,
 * the open proposals and the ledger of what was delivered.
 *
 * The write door does one thing: it files a proposal. A proposal changes nothing in force and moves no lane's stage;
 * it waits for the user's answer on the Inbox card (the human decision door, `decide`). There is no approve and no
 * reject here, so an agent has no way to make its own proposal take effect. A lane's session proposes nothing. The
 * session a caller names is its own claim, so the door does not take it on the agent token (a file every agent can
 * read): the caller must present the credential this engine gave that conversation's own process
 * (`x-idd-session-token`), which no lane has. A lane that leaves its id out, or names another conversation, has no
 * credential that matches and is refused. The one exception is a session proposal (one conversation's own additions and
 * exclusions): it changes no instruction and only a signed approval applies it, so it needs no credential.
 */
import {
  activeInstructions, describeScope, formatLedgerEntry, openInstructionProposals, proposeInstruction, readInstructions, readLedger,
} from "@idd/core";
import { isSupervisedPipelineSession } from "@idd/lane";

import { json } from "../http.ts";
import { authorize } from "../server/agent-auth";
import { conversationCredentialMatches } from "../server/conversation-env.ts";
import { conversationMarksWorkspace } from "../server/conversations.ts";
import { markOf } from "../server/marks.ts";

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function POST(req: Request): Promise<Response> {
  if (!authorize(req)) return json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body: { action?: unknown; idd_id?: unknown; session?: unknown; payload?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON を読めません" }, { status: 400 });
  }
  if (asText(body.idd_id)) return json({ ok: false, error: "lane の session は方針の案を出せません。案を出せるのは会話の agent だけです" }, { status: 403 });
  if (asText(body.action) !== "propose") return json({ ok: false, error: "口が受ける action は propose だけです（承認と見送りは利用者の画面にだけあります）" }, { status: 400 });
  const payload = body.payload !== null && typeof body.payload === "object" && !Array.isArray(body.payload) ? (body.payload as Record<string, unknown>) : {};
  // A session exception names the conversation it is for and the instruction, and asks the user to approve it on a card.
  // It takes no conversation credential: the user's own terminal files one too, and the card says what it would do, so a
  // proposal from anywhere reaches the instructions of no conversation until the user signs it.
  if (payload.kind === "session") {
    const forSession = asText(payload.for_session);
    if (!forSession || isSupervisedPipelineSession(forSession) || !conversationMarksWorkspace(forSession)) {
      return json({ ok: false, error: "会話の session ではないので、会話の印の案を出せません" }, { status: 404 });
    }
    const filed = proposeInstruction({ kind: "session", target: payload.target, op: payload.op, forSession, session: forSession });
    if (!filed.ok) return json({ ok: false, error: filed.error }, { status: 400 });
    return json({ ok: true, id: filed.proposal.id, kind: filed.proposal.kind, effect: "pending", note: "案を出しました。利用者が Inbox の案の card で署名して承認するまで、その会話の方針は変わりません" }, { status: 200 });
  }
  const session = asText(body.session);
  if (!session) return json({ ok: false, error: "session を指定してください" }, { status: 400 });
  if (isSupervisedPipelineSession(session) || !conversationMarksWorkspace(session)) {
    return json({ ok: false, error: "会話の session ではないので、方針の案を出せません" }, { status: 403 });
  }
  if (!conversationCredentialMatches(session, req.headers.get("x-idd-session-token"))) {
    return json({ ok: false, error: "その会話の資格がありません。案を出せるのは、その会話の pi か Claude Code から起こした agent だけです（会話を開き直すと資格が入ります）" }, { status: 403 });
  }
  const result = proposeInstruction({ kind: payload.kind, target: payload.target, text: payload.text, reason: payload.reason, scope: payload.scope, session });
  if (!result.ok) return json({ ok: false, error: result.error }, { status: 400 });
  // the answer says what happened and what did not: nothing is in force yet
  return json({ ok: true, id: result.proposal.id, kind: result.proposal.kind, effect: "pending", note: "案を出しました。利用者が Inbox の案の card で承認するまで、どこにも効きません" }, { status: 200 });
}

/**
 * The read door. It asks for no token and writes nothing: `op=list` the instructions in force, `op=proposals` the open
 * proposals, `op=session` one conversation's own exceptions, `op=ledger` the delivered lines (filtered by `lane`, `session`, `instruction`, `stage`, `limit`).
 */
export function GET(req: Request): Response {
  const url = new URL(req.url);
  const op = asText(url.searchParams.get("op")) ?? "list";
  if (op === "list") {
    const read = readInstructions();
    return json({ ok: true, state: read.state, ...(read.reason ? { reason: read.reason } : {}), instructions: activeInstructions().map((i) => ({ ...i, scope_text: describeScope(i.scope) })) });
  }
  if (op === "proposals") return json({ ok: true, proposals: openInstructionProposals() });
  // one conversation's own additions and exclusions, so the CLI can change one id without resending the others
  if (op === "session") {
    const id = asText(url.searchParams.get("id"));
    const workspace = id ? conversationMarksWorkspace(id) : undefined;
    if (!id || !workspace) return json({ ok: false, error: "会話の session ではありません" }, { status: 404 });
    const mark = markOf(workspace, id);
    return json({ ok: true, session: id, add: mark.instructionAdd ?? [], exclude: mark.instructionExclude ?? [] });
  }
  if (op === "ledger") {
    // `Number(null)` is 0, so whether a limit was given is read apart from its value
    const rawLimit = asText(url.searchParams.get("limit"));
    const limit = rawLimit === undefined ? NaN : Number(rawLimit);
    const entries = readLedger({
      ...(asText(url.searchParams.get("lane")) ? { lane: asText(url.searchParams.get("lane")) as string } : {}),
      ...(asText(url.searchParams.get("session")) ? { session: asText(url.searchParams.get("session")) as string } : {}),
      ...(asText(url.searchParams.get("instruction")) ? { instruction: asText(url.searchParams.get("instruction")) as string } : {}),
      ...(asText(url.searchParams.get("stage")) ? { stage: asText(url.searchParams.get("stage")) as string } : {}),
      ...(Number.isInteger(limit) && limit >= 0 ? { limit } : {}),
    });
    return json({ ok: true, entries, lines: entries.map(formatLedgerEntry) });
  }
  return json({ ok: false, error: `知らない op: ${op}（list / proposals / ledger）` }, { status: 400 });
}
