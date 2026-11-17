/**
 * Proposals to add, change or retire an instruction. An agent in a conversation may put a proposal down; nothing
 * about it reaches a run or a conversation until the user approves it on the Inbox card. The door that proposes
 * writes only this file (never the instructions, never a lane's stage), and the two that decide (approve and
 * reject) are called only from the human decision door. A lane's session proposes nothing.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  REVIEW_THRESHOLD, activeInstructions, checkReason, checkText, instructionsDir, isInstructionId, quarantine, readJson, recordApplied, writeInstructions,
  warnOnce, writeJsonAtomic, InstructionStoreError, type Instruction,
} from "./store.ts";
import { applyPartialScope, normalizePartialScope, normalizeScope, type PartialScope, type Scope } from "./scope.ts";

/**
 * `add` / `change` / `retire` change the instructions; `session` changes one conversation's own list of additions and
 * exclusions (its marks), which the engine writes once the user has signed the approval.
 */
export const PROPOSAL_KINDS = ["add", "change", "retire", "session"] as const;
export type InstructionProposalKind = (typeof PROPOSAL_KINDS)[number];

/** what a session proposal does to the conversation's list: add the instruction, leave it out, or drop either */
export const SESSION_OPS = ["add", "exclude", "clear"] as const;
export type SessionOp = (typeof SESSION_OPS)[number];

export interface InstructionProposal {
  id: string;
  kind: InstructionProposalKind;
  /** change / retire: the instruction it is about */
  target?: string;
  /** add / change: the new content (a change carries only the fields it changes) */
  text?: string;
  reason?: string;
  /** an add names all three axes; a change names the ones it changes, and the others keep the instruction's value */
  scope?: PartialScope;
  /** session: what is done to the conversation's list */
  op?: SessionOp;
  /** session: the conversation whose list it is */
  for_session?: string;
  proposed_at: string;
  /** the conversation the proposal is about or came from */
  session: string;
}

interface ProposalsFile {
  version: 1;
  next: number;
  proposals: InstructionProposal[];
}

/** open proposals past this many are refused: a stuck agent must not bury the Inbox */
export const OPEN_LIMIT = 20;

const PROPOSAL_ID = /^INP-\d+$/;

export function proposalsPath(): string {
  return join(instructionsDir(), "proposals.json");
}

/** the decisions the user took on proposals: appended, never rewritten */
export function decisionsPath(): string {
  return join(instructionsDir(), "decisions.jsonl");
}

function emptyProposals(): ProposalsFile {
  return { version: 1, next: 1, proposals: [] };
}

function parseProposals(value: unknown): ProposalsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("最上位が表ではありません");
  const source = value as { proposals?: unknown; next?: unknown };
  if (!Array.isArray(source.proposals)) throw new Error("proposals の一覧がありません");
  const proposals: InstructionProposal[] = [];
  for (const raw of source.proposals) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== "string" || !PROPOSAL_ID.test(p.id)) continue;
    if (!(PROPOSAL_KINDS as readonly string[]).includes(String(p.kind))) continue;
    const scope = p.scope === undefined ? undefined : p.kind === "change" ? normalizePartialScope(p.scope) : normalizeScope(p.scope);
    if (scope && !scope.ok) continue;
    proposals.push({
      id: p.id,
      kind: p.kind as InstructionProposalKind,
      ...(typeof p.target === "string" ? { target: p.target } : {}),
      ...(typeof p.text === "string" ? { text: p.text } : {}),
      ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      ...(scope?.ok ? { scope: scope.scope } : {}),
      ...((SESSION_OPS as readonly string[]).includes(String(p.op)) ? { op: p.op as SessionOp } : {}),
      ...(typeof p.for_session === "string" ? { for_session: p.for_session } : {}),
      proposed_at: typeof p.proposed_at === "string" ? p.proposed_at : "",
      session: typeof p.session === "string" ? p.session : "",
    });
  }
  const highest = proposals.reduce((max, p) => Math.max(max, Number(p.id.slice(4))), 0);
  const next = typeof source.next === "number" && Number.isInteger(source.next) ? Math.max(source.next, highest + 1) : highest + 1;
  return { version: 1, next, proposals };
}

function readProposals(): ProposalsFile {
  const read = readJson(proposalsPath());
  if (read.state === "missing") return emptyProposals();
  if (read.state !== "ok") {
    warnOnce(`proposals:${read.state}:${read.reason}`, `${proposalsPath()} を読めないので、案なしで進めます: ${read.reason}`);
    return emptyProposals();
  }
  try {
    return parseProposals(read.value);
  } catch (err) {
    warnOnce(`proposals:broken:${String(err)}`, `${proposalsPath()} を読めないので、案なしで進めます: ${String(err)}`);
    return emptyProposals();
  }
}

/** the file a write may change; one that is broken is moved aside, and one that cannot be read refuses the write */
function proposalsForWrite(): ProposalsFile {
  const path = proposalsPath();
  const read = readJson(path);
  if (read.state === "missing") return emptyProposals();
  if (read.state === "unreadable") throw new InstructionStoreError(`案のファイルを読めません: ${read.reason}`);
  if (read.state === "ok") {
    try {
      return parseProposals(read.value);
    } catch { /* broken as a table: moved aside below */ }
  }
  const dest = quarantine(path);
  throw new InstructionStoreError(`案のファイルが壊れていたので ${dest} に退避しました。もう一度お試しください`);
}

/** the proposals waiting for the user's decision, oldest first */
export function openInstructionProposals(): InstructionProposal[] {
  return readProposals().proposals;
}

export function findInstructionProposal(id: string): InstructionProposal | undefined {
  return readProposals().proposals.find((p) => p.id === id);
}

export type ProposeResult = { ok: true; proposal: InstructionProposal } | { ok: false; error: string };

export interface ProposeInput {
  kind: unknown;
  target?: unknown;
  text?: unknown;
  reason?: unknown;
  scope?: unknown;
  /** session: add / exclude / clear, and the conversation whose list it is */
  op?: unknown;
  forSession?: unknown;
  session: string;
}

/**
 * Put a proposal down. It changes nothing in force: the instructions file is read only to check a change or a retire
 * names an instruction that exists. An add carries all of text, reason and scope; a change carries the target and at
 * least one field.
 */
export function proposeInstruction(input: ProposeInput, now: Date = new Date()): ProposeResult {
  if (!input.session.trim()) return { ok: false, error: "会話の session が分かりません" };
  const kind = String(input.kind ?? "");
  if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) return { ok: false, error: `案の種類は ${PROPOSAL_KINDS.join(" / ")} です` };
  const body: Omit<InstructionProposal, "id" | "proposed_at" | "session" | "kind"> = {};
  if (kind === "session") {
    if (!isInstructionId(input.target)) return { ok: false, error: "対象の方針（id: INS-<連番>）が必要です" };
    if (!(SESSION_OPS as readonly string[]).includes(String(input.op))) return { ok: false, error: `会話の印の操作は ${SESSION_OPS.join(" / ")} です` };
    if (typeof input.forSession !== "string" || !input.forSession.trim()) return { ok: false, error: "対象の会話の session が必要です" };
    // adding or leaving out an instruction that is not in force would mark nothing; clearing one that was retired is fine
    if (input.op !== "clear" && !activeInstructions().some((i) => i.id === input.target)) return { ok: false, error: `その方針はありません: ${String(input.target)}` };
    body.target = input.target;
    body.op = input.op as SessionOp;
    body.for_session = input.forSession.trim();
  } else if (kind !== "add") {
    if (!isInstructionId(input.target)) return { ok: false, error: "対象の方針（id: INS-<連番>）が必要です" };
    if (!activeInstructions().some((i) => i.id === input.target)) return { ok: false, error: `その方針はありません: ${String(input.target)}` };
    body.target = input.target;
  }
  if (kind === "add" || kind === "change") {
    const hasText = input.text !== undefined;
    const hasReason = input.reason !== undefined;
    const hasScope = input.scope !== undefined;
    if (kind === "add" && !(hasText && hasReason && hasScope)) return { ok: false, error: "追加には text・reason・scope（repo・場面・場所の範囲）が要ります" };
    if (kind === "change" && !(hasText || hasReason || hasScope)) return { ok: false, error: "変更には text・reason・scope のどれかが要ります" };
    if (hasText) {
      const text = checkText(input.text);
      if (!text.ok) return text;
      body.text = text.text;
    }
    if (hasReason) {
      const reason = checkReason(input.reason);
      if (!reason.ok) return reason;
      body.reason = reason.reason;
    }
    if (hasScope) {
      // an add declares the whole scope; a change declares the axes it changes and leaves the rest as the instruction has them
      const scope = kind === "change" ? normalizePartialScope(input.scope) : normalizeScope(input.scope);
      if (!scope.ok) return scope;
      if (kind === "change") {
        const current = activeInstructions().find((i) => i.id === input.target);
        const meets = current ? applyPartialScope(current.scope, scope.scope as PartialScope) : { ok: true as const };
        if (!meets.ok) return meets;
      }
      body.scope = scope.scope;
    }
  }
  try {
    const file = proposalsForWrite();
    if (file.proposals.length >= OPEN_LIMIT) return { ok: false, error: `未処理の案が ${OPEN_LIMIT} 件あります。利用者が片づけるまで新しい案は出せません` };
    const proposal: InstructionProposal = {
      id: `INP-${file.next}`,
      kind: kind as InstructionProposalKind,
      ...body,
      proposed_at: now.toISOString(),
      session: input.session.trim(),
    };
    file.next += 1;
    file.proposals.push(proposal);
    writeJsonAtomic(proposalsPath(), file);
    return { ok: true, proposal };
  } catch (err) {
    if (err instanceof InstructionStoreError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * The note an add proposal's card carries once the list is long: how many instructions are in force and that the
 * user may retire the ones no longer wanted. The proposal is not refused: the user keeps the one wanted most.
 */
export function reviewNotice(proposal: InstructionProposal, inForce: number = activeInstructions().length): string | null {
  if (proposal.kind !== "add" || inForce < REVIEW_THRESHOLD) return null;
  return `方針は今 ${inForce} 件あります。件数が増えると、当てはまる段の brief が膨らみます。要らない方針があれば先に引退させてください。この案はそのまま承認もできます`;
}

function logDecision(entry: Record<string, unknown>): void {
  try {
    mkdirSync(instructionsDir(), { recursive: true });
    appendFileSync(decisionsPath(), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    warnOnce(`decisions:${String(err)}`, `案の判断の記録を書けませんでした: ${String(err)}`);
  }
}

/** drop one proposal from the open file */
function removeProposal(id: string): void {
  const file = proposalsForWrite();
  file.proposals = file.proposals.filter((p) => p.id !== id);
  writeJsonAtomic(proposalsPath(), file);
}

export type ApproveResult =
  | { ok: true; proposal: InstructionProposal; instruction?: Instruction; retired?: Instruction; replayed?: true }
  | { ok: false; error: string };

/**
 * Approve a proposal: the only call that changes the instructions in force. It runs from the human decision door
 * alone. The change lands in the instructions file (and its readable copy) first, together with a note of which
 * proposal made it, and the proposal leaves the open file after. A proposal left behind by a failure between the two is
 * approved again by the same call: the note is found, the change is not made a second time, and only the proposal is
 * cleared away.
 */
export function approveInstructionProposal(id: string, now: Date = new Date()): ApproveResult {
  const proposal = findInstructionProposal(id);
  if (!proposal) return { ok: false, error: `その案はありません: ${id}` };
  if (proposal.kind === "session") return { ok: false, error: "会話の印の案です。方針の正本は変わりません" };
  const stamp = now.toISOString();
  try {
    const applied = writeInstructions((file): { instruction?: Instruction; retired?: Instruction; replayed?: true; instructionId?: string } => {
      const before = file.applied?.[proposal.id];
      if (before && before.proposed_at === proposal.proposed_at) {
        // an earlier approval already made this change: show what it made as it stands now, and change nothing
        const made = file.instructions.find((i) => i.id === before.instruction);
        return { replayed: true, instructionId: before.instruction, ...(made ? { instruction: made } : {}) };
      }
      if (proposal.kind === "add") {
        const instruction: Instruction = {
          id: `INS-${file.next}`,
          text: proposal.text ?? "",
          reason: proposal.reason ?? "",
          scope: proposal.scope as Scope,
          created_at: stamp,
          updated_at: stamp,
        };
        file.next += 1;
        file.instructions.push(instruction);
        recordApplied(file, proposal.id, { proposed_at: proposal.proposed_at, instruction: instruction.id });
        return { instruction };
      }
      const at = file.instructions.findIndex((i) => i.id === proposal.target);
      if (at < 0) throw new InstructionStoreError(`対象の方針がもうありません: ${proposal.target ?? ""}`);
      const current = file.instructions[at] as Instruction;
      if (proposal.kind === "retire") {
        file.instructions.splice(at, 1);
        recordApplied(file, proposal.id, { proposed_at: proposal.proposed_at, instruction: current.id });
        return { retired: current };
      }
      // the axes the change names replace the instruction's; the ones it leaves out keep its value
      const scope = proposal.scope === undefined ? { ok: true as const, scope: current.scope } : applyPartialScope(current.scope, proposal.scope);
      if (!scope.ok) throw new InstructionStoreError(`変えた後の範囲が成り立ちません: ${scope.error}`);
      const changed: Instruction = {
        ...current,
        ...(proposal.text !== undefined ? { text: proposal.text } : {}),
        ...(proposal.reason !== undefined ? { reason: proposal.reason } : {}),
        scope: scope.scope,
        updated_at: stamp,
      };
      file.instructions[at] = changed;
      recordApplied(file, proposal.id, { proposed_at: proposal.proposed_at, instruction: changed.id });
      return { instruction: changed };
    });
    removeProposal(id);
    const touched = applied.instructionId ?? applied.instruction?.id ?? applied.retired?.id;
    logDecision({ at: stamp, proposal: id, kind: proposal.kind, decision: "approved", ...(touched ? { instruction: touched } : {}), ...(applied.replayed ? { replayed: true } : {}) });
    return { ok: true, proposal, ...(applied.instruction ? { instruction: applied.instruction } : {}), ...(applied.retired ? { retired: applied.retired } : {}), ...(applied.replayed ? { replayed: true as const } : {}) };
  } catch (err) {
    if (err instanceof InstructionStoreError) return { ok: false, error: err.message };
    throw err;
  }
}

export type SessionApplyResult = { ok: true } | { ok: false; error: string };

/**
 * Approve a session proposal: the conversation's own list is the engine's to write (the marks live in the workspace),
 * so the caller applies it and this clears the proposal and keeps the decision. Applying the same operation twice
 * leaves the list as it was, so a retry after a failure between the two is safe. The instructions are not touched.
 */
export function approveSessionProposal(id: string, apply: (proposal: InstructionProposal) => SessionApplyResult, now: Date = new Date()): ApproveResult {
  const proposal = findInstructionProposal(id);
  if (!proposal) return { ok: false, error: `その案はありません: ${id}` };
  if (proposal.kind !== "session") return { ok: false, error: "会話の印の案ではありません" };
  const applied = apply(proposal);
  if (!applied.ok) return applied;
  try {
    removeProposal(id);
  } catch (err) {
    if (err instanceof InstructionStoreError) return { ok: false, error: err.message };
    throw err;
  }
  logDecision({ at: now.toISOString(), proposal: id, kind: proposal.kind, decision: "approved", ...(proposal.target ? { instruction: proposal.target } : {}), session: proposal.for_session ?? "", op: proposal.op ?? "" });
  return { ok: true, proposal };
}

export type RejectResult = { ok: true; proposal: InstructionProposal } | { ok: false; error: string };

/** Pass on a proposal: it leaves the open file and the instructions are left as they are. The reason is kept */
export function rejectInstructionProposal(id: string, reason: unknown, now: Date = new Date()): RejectResult {
  const proposal = findInstructionProposal(id);
  if (!proposal) return { ok: false, error: `その案はありません: ${id}` };
  if (typeof reason !== "string" || !reason.trim()) return { ok: false, error: "見送る理由が要ります" };
  try {
    removeProposal(id);
  } catch (err) {
    if (err instanceof InstructionStoreError) return { ok: false, error: err.message };
    throw err;
  }
  logDecision({ at: now.toISOString(), proposal: id, kind: proposal.kind, decision: "rejected", reason: reason.trim() });
  return { ok: true, proposal };
}
