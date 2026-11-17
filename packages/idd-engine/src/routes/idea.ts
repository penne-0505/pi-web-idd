/**
 * The idea document's doors: what the screen reads, the gate approvals, the exit approval target and the one
 * signature that runs the exits.
 *
 * The status door reads the document straight from the conversation's records, so a poll neither wakes pi nor
 * changes anything. The gate and exit doors act on the conversation itself: a gate record ends with a notice to
 * the agent through the ordinary queue, and an exit run holds the conversation for its length.
 */
import { readFileSync } from "node:fs";

import { passkeyCount } from "@idd/core";

import { json } from "../http.ts";
import { ConversationRefused } from "../server/refusal.ts";
import { ideaDocumentPath, ideaDocumentTarget, openConversation, type Conversation, type IdeaDocumentTarget } from "../server/conversations.ts";
import {
  addGateRecord, exitRowStatus, gateDate, ideaFourPointHash, parseIdeaDocument, setFrontmatterFields, stageAfterGate, writeIdeaText,
  type ExitEffect, type ExitOperation, type ExitState, type FileChange, type IdeaDocument, type IdeaStage, type SectionMark, type SectionState,
} from "../server/idea-document.ts";
import { gateEntryIds, gateNotice } from "../server/idea-gate-anchors.ts";
import { approvalTarget, buildIdeaExitContent, runIdeaExits, validatePlaces } from "../server/idea-exits.ts";
import { challengeBody, resolveRequestedRpId } from "./passkey-challenge.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** one section as the status door reports it: the agent's mark, the shown state, and the reason a mark did not read */
export interface IdeaSectionStatus {
  name: string;
  mark: SectionMark | null;
  state: SectionState;
  reason?: string;
}

/** one gate record as the status door reports it, with where it sits on the branch and the stage it stands at */
export interface IdeaGateStatus {
  gate: 1 | 2;
  date: string | null;
  action: "approve" | "redo";
  reason?: string;
  fingerprint?: string;
  /** the branch entry the record first appeared at, or null when it is not on this branch */
  entryId: string | null;
  /** the stage the first records up to this one support (探索 · ゲート1 · 凍結) */
  stage: IdeaStage;
}

/** one exit Issue as the status door reports it */
export interface IdeaExitIssueStatus {
  id: string;
  title: string;
  depends: string[];
  labels: string[];
  body: string;
  number: number | null;
  result: string;
}

/** one exit row as the status door reports it: the five shared fields, the operation's own content, and the reason */
export interface IdeaExitRowStatus {
  id: string;
  title: string;
  effect: ExitEffect;
  operation: ExitOperation;
  target: string;
  reversibility: string;
  state: ExitState;
  result: string;
  readable: boolean;
  reason?: string;
  /** the row the engine left 承認済み: a run that stopped before it could finish */
  interrupted?: boolean;
  issues?: IdeaExitIssueStatus[];
  repo?: { visibility: "public" | "private" | null; description: string };
  file?: { change: FileChange | null; content: string | null; before: string | null; after: string | null };
}

/** one reason a part of the document did not read */
export interface IdeaUnreadableStatus {
  where: string;
  reason: string;
}

/** the whole document as the status door reports it, with a gate record's position and stage on each row */
export interface IdeaDocumentStatus {
  path: string;
  slug: string | null;
  status: string | null;
  target: string | null;
  createdAt: string | null;
  frozenAt: string | null;
  stage: IdeaStage;
  frozen: boolean;
  frozenIntact: boolean;
  sections: IdeaSectionStatus[];
  undecided: string[];
  gates: IdeaGateStatus[];
  exits: IdeaExitRowStatus[];
  places: string[];
  exitsReadable: boolean;
  unreadable: IdeaUnreadableStatus[];
}

/** GET /api/conversations/:id/idea */
export interface IdeaStatusResponse {
  ok: boolean;
  document: IdeaDocumentStatus | null;
  reason?: string;
  error?: string;
}

/** POST /api/conversations/:id/idea/gates */
export interface IdeaGateResponse {
  ok: boolean;
  gate?: 1 | 2;
  action?: "approve" | "redo";
  document?: IdeaDocumentStatus;
  error?: string;
}

/** the count and breakdown the approval shows */
export interface IdeaExitSummary {
  total: number;
  outbound: number;
  local: number;
  irreversible: number;
  interrupted: number;
}

/** POST /api/conversations/:id/idea/exits/challenge */
export interface IdeaChallengeResponse {
  ok: boolean;
  required?: boolean;
  registered?: number;
  nonce?: string;
  challenge?: string;
  expiresAt?: string;
  rpId?: string;
  allowCredentials?: { id: string }[];
  summary?: IdeaExitSummary;
  rows?: IdeaExitRowStatus[];
  error?: string;
}

/** one row's outcome after a run */
export interface IdeaRunOutcome {
  id: string;
  state: string;
  result?: string;
  reason?: string;
  issues?: { id: string; number: number | null; url: string | null }[];
}

/** POST /api/conversations/:id/idea/exits/run */
export interface IdeaRunResponse {
  ok: boolean;
  stopped?: boolean;
  outcomes?: IdeaRunOutcome[];
  rows?: string[];
  error?: string;
}

function failure(err: unknown): Response {
  if (err instanceof ConversationRefused) return json({ ok: false, error: err.message, ...err.body }, { status: err.status, headers: NO_STORE });
  return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 500, headers: NO_STORE });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const parsed = await req.json().catch(() => ({}));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/** the whole status the screen draws, with each gate record's position and stage and the places' own reasons */
async function statusOf(document: IdeaDocument, target: IdeaDocumentTarget): Promise<IdeaDocumentStatus> {
  const places = validatePlaces(document);
  let entryIds: (string | null)[];
  try { entryIds = await gateEntryIds(target.sessionId, document.path, target.cwd, document.gates); }
  catch { entryIds = document.gates.map(() => null); }
  return {
    path: document.path,
    slug: document.slug,
    status: document.status,
    target: document.target,
    createdAt: document.createdAt,
    frozenAt: document.frozenAt,
    stage: document.stage,
    frozen: document.frozen,
    frozenIntact: document.frozenIntact,
    sections: document.sections.map((section) => ({
      name: section.name,
      mark: section.mark,
      state: section.state,
      ...(section.reason ? { reason: section.reason } : {}),
    })),
    undecided: [...document.undecided],
    gates: document.gates.map((gate, index) => ({
      gate: gate.gate,
      date: gate.date,
      action: gate.action,
      ...(gate.reason ? { reason: gate.reason } : {}),
      ...(gate.fingerprint ? { fingerprint: gate.fingerprint } : {}),
      entryId: entryIds[index] ?? null,
      stage: stageAfterGate(document.gates, index),
    })),
    exits: document.exits.map((row) => exitRowStatus(row) as unknown as IdeaExitRowStatus),
    places: places.safe,
    exitsReadable: document.exitsReadable,
    unreadable: [...document.unreadable, ...places.errors.map((reason) => ({ where: "置き場", reason }))],
  };
}

/** GET /api/conversations/:id/idea — the document's status and its exits, read fresh */
export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const target = ideaDocumentTarget(params.id);
    const path = await ideaDocumentPath(target);
    if (!path) {
      return json({ ok: true, document: null, reason: "アイデア文書がありません" }, { headers: NO_STORE });
    }
    const document = parseIdeaDocument(readFileSync(path, "utf8"), path);
    return json({ ok: true, document: await statusOf(document, target) }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

function gateApproved(document: IdeaDocument, gate: 1 | 2): boolean {
  const last = [...document.gates].reverse().find((record) => record.gate === gate);
  return last?.action === "approve";
}


/**
 * POST /api/conversations/:id/idea/gates — approve a gate, or record a redo. The gate record is written first,
 * then one notice is left in the conversation, so the agent learns the record exists and does not write a second.
 */
export async function GATES(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const b = await body(req);
    const gate = b.gate === 1 || b.gate === 2 ? b.gate : null;
    const action = b.action === "approve" || b.action === "redo" ? b.action : null;
    if (!gate || !action) throw new ConversationRefused("gate（1 か 2）と action（approve か redo）が必要です", 400);
    const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : undefined;
    const conversation = await openConversation(params.id);
    const result = await writeGate(params.id, conversation, gate, action, reason);
    return json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

async function writeGate(sessionId: string, conversation: Conversation, gate: 1 | 2, action: "approve" | "redo", reason?: string): Promise<Record<string, unknown>> {
  const target = ideaDocumentTarget(sessionId);
  const path = await ideaDocumentPath(target);
  if (!path) throw new ConversationRefused("アイデア文書がありません", 404);
  // Resolving the path is the only await: the checks, the write and the notice run as one synchronous block, so
  // an exit run cannot start between the check and the write and the notice cannot be refused after the record
  // is already written. An exit run reads and writes the same document between rows; a gate record written here
  // would make the rows that follow disagree with the signed content, so the record waits until the run is done.
  if (conversation.isExitRunning) throw new ConversationRefused("出口を実行しています。終わるまでゲートを記録できません", 409);
  if (!conversation.canWriteDocument) throw new ConversationRefused("応答中はゲートを記録できません", 409);
  const before = parseIdeaDocument(readFileSync(path, "utf8"), path);
  if (gate === 2 && action === "approve" && !gateApproved(before, 1)) {
    throw new ConversationRefused("ゲート 1 の承認がありません", 409);
  }
  const fingerprint = gate === 2 && action === "approve" ? ideaFourPointHash(before) : undefined;
  let text = addGateRecord(readFileSync(path, "utf8"), { gate, action, ...(reason ? { reason } : {}), ...(fingerprint ? { fingerprint } : {}) });
  if (action === "approve" && gate === 1) text = setFrontmatterFields(text, { status: "ゲート1" });
  if (action === "approve" && gate === 2) text = setFrontmatterFields(text, { status: "凍結", frozen_at: gateDate() });
  if (action === "redo" && gate === 1) text = setFrontmatterFields(text, { status: "探索", frozen_at: null });
  if (action === "redo" && gate === 2) text = setFrontmatterFields(text, { status: "ゲート1", frozen_at: null });
  writeIdeaText(path, text);
  const document = parseIdeaDocument(readFileSync(path, "utf8"), path);
  conversation.send(gateNotice(gate, action, reason));
  return { gate, action, document: await statusOf(document, target) };
}

/**
 * POST /api/conversations/:id/idea/exits/challenge — the rows an approval would run, the count and breakdown, and
 * the challenge the page signs. With no passkey registered the answer asks for registration instead.
 */
export async function CHALLENGE(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const b = await body(req);
    const rp = resolveRequestedRpId(req, b.rpId);
    if (!rp.ok) return json({ ok: false, error: rp.error }, { status: 400, headers: NO_STORE });
    const registered = passkeyCount();
    const target = ideaDocumentTarget(params.id);
    const path = await ideaDocumentPath(target);
    if (!path) throw new ConversationRefused("アイデア文書がありません", 404);
    const document = parseIdeaDocument(readFileSync(path, "utf8"), path);
    const places = validatePlaces(document);
    if (places.errors.length) throw new ConversationRefused(`置き場の宣言を読めません: ${places.errors.join(" / ")}`, 409);
    const { rows, summary } = approvalTarget(document, stringList(b.rows));
    if (!registered) return json({ ok: true, required: true, registered: 0, summary, rows: rows.map(exitRowStatus) }, { headers: NO_STORE });
    const content = buildIdeaExitContent(document, rows);
    return json({
      ok: true,
      required: true,
      registered,
      ...challengeBody(content, rp.rpId),
      summary,
      rows: rows.map(exitRowStatus),
    }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

/**
 * POST /api/conversations/:id/idea/exits/run — run the approved rows under one signature. The lock, the
 * conversation hold and the signature's own gate live in `runIdeaExits`.
 */
export async function RUN(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const b = await body(req);
    const nonce = typeof b.nonce === "string" && b.nonce ? b.nonce : undefined;
    const conversation = await openConversation(params.id);
    const target = ideaDocumentTarget(params.id);
    const path = await ideaDocumentPath(target);
    if (!path) throw new ConversationRefused("アイデア文書がありません", 404);
    const result = await runIdeaExits({
      conversationId: params.id,
      documentPath: path,
      workspace: target.workspace,
      conversation,
      ...(stringList(b.rows) ? { rows: stringList(b.rows) as string[] } : {}),
      ...(nonce ? { nonce } : {}),
      ...(b.assertion !== undefined ? { assertion: b.assertion } : {}),
    });
    return json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}
