/**
 * The exits of an idea document: which rows an approval covers, the signature's content, and running the rows in
 * order under that one signature.
 *
 * The document is agent-writable, so a row's own `状態` is not evidence that penne approved it. The only thing
 * that can start a row is the signature the run door carries. That is why the content is rebuilt from the
 * document at every gate — the head check, and again just before each Issue — and why the state and result the
 * engine itself writes between rows are left out of the signed content.
 *
 * What a run may touch is bounded twice: the freeze of gate 2 must still match, and a hand-side write must stay
 * inside the conversation's workspace or a place the document declares, never the state, the settings or the
 * document itself.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { approvalGateOpen, configPath, consumeNonce, ideaExitContent, stateDir, userConfigDir, verifyApprovalSignature } from "@idd/core";
import { createGhIssue, createGhRepo, expandHome } from "@idd/lane";

import { ConversationRefused } from "./refusal.ts";
import { assertWithinRoot, comparablePath, isWithin, resolveRealPath, samePath } from "./workspace.ts";
import {
  effectiveGate2, exitRowSigned, parseIdeaDocument, rowRunnable, setExitState, setIssueResult, summarizeExits, writeIdeaText,
  type ExitIssue, type ExitRow, type IdeaDocument,
} from "./idea-document.ts";

/** the part of a conversation a run needs: whether the agent is stopped, and the block during the run */
export interface ExitConversation {
  readonly canWriteDocument: boolean;
  beginExitRun(): void;
  endExitRun(): void;
}

export interface RunExitsInput {
  conversationId: string;
  documentPath: string;
  /** the conversation's workspace, the first root a hand-side row may write in */
  workspace: string;
  conversation: ExitConversation;
  /** named rows; omitted means every draft and failed row */
  rows?: string[];
  nonce?: string;
  assertion?: unknown;
}

export interface ExitOutcome {
  id: string;
  state: "実行済み" | "失敗" | "下書き" | "承認済み";
  result?: string;
  reason?: string;
  /** issues created or already made, for the row's answer */
  issues?: { id: string; number: number | null; url: string | null }[];
}

/** a result the engine could not write back after a side effect: the created Issues ride the answer */
class ExitWriteBackError extends Error {
  constructor(message: string, readonly issues: { id: string; number: number | null; url: string | null }[]) {
    super(message);
    this.name = "ExitWriteBackError";
  }
}

export interface RunExitsResult {
  stopped: boolean;
  outcomes: ExitOutcome[];
  /** the rows the run covered, in order */
  rows: string[];
}

/** the document's exits run one at a time; the key is the document, so a second run is refused whatever its nonce */
const running = new Set<string>();

/** the append-only record of signatures: what was signed, and what each run did */
export function ideaExitLogPath(): string {
  return join(stateDir(), "idea-exits.jsonl");
}

/** the last supported gate 2 approval's fingerprint, the freeze the signature is bound to */
export function gateFingerprint(document: IdeaDocument): string {
  return effectiveGate2(document.gates)?.fingerprint ?? "";
}

/** the rows a challenge covers: named rows, or every draft and failed row */
export function selectExitRows(document: IdeaDocument, ids?: readonly string[]): ExitRow[] {
  if (ids && ids.length) {
    const out: ExitRow[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      // a repeated name must not make the same row run twice: the second mention is the same row
      if (seen.has(id)) continue;
      seen.add(id);
      const row = document.exits.find((entry) => entry.id === id);
      if (!row) throw new ConversationRefused(`出口の行がありません: ${id}`, 400);
      if (!row.readable) throw new ConversationRefused(`読めない行は実行できません: ${id}（${row.reason ?? ""}）`, 400);
      if (row.state === "実行済み") throw new ConversationRefused(`実行済みの行は対象にできません: ${id}`, 409);
      if (row.state === "承認済み") throw new ConversationRefused(`実行が途切れた行は対象にできません。直してから実行してください: ${id}`, 409);
      out.push(row);
    }
    return out;
  }
  return document.exits.filter((row) => rowRunnable(row));
}

/** the signature content for the given rows; `numbers` holds the Issue numbers at signing time, and `reverted` names the ones this run wrote itself */
export function buildIdeaExitContent(document: IdeaDocument, rows: readonly ExitRow[], numbers?: Map<string, number | null>, reverted?: Map<string, number>): Record<string, unknown> {
  return ideaExitContent({
    document: document.path,
    fingerprint: gateFingerprint(document),
    places: [...document.places],
    rows: rows.map((row) => signedRow(row, numbers, reverted)),
  });
}

/**
 * The signature covers the Issue numbers the document held at signing time. A run writes a newly made Issue's
 * number into the document, so a later re-check would otherwise compare against a value the signature never had.
 * Only the write the run itself made is put back (`reverted`); any other change stays and fails the gate.
 */
function signedRow(row: ExitRow, numbers?: Map<string, number | null>, reverted?: Map<string, number>): Record<string, unknown> {
  const base = exitRowSigned(row);
  if (!Array.isArray(base.issues)) return base;
  base.issues = (base.issues as Record<string, unknown>[]).map((issue) => {
    const id = String(issue.id);
    const current = issue.number ?? null;
    const written = reverted?.get(id);
    if (written !== undefined && current === written) return { ...issue, number: numbers?.get(id) ?? null };
    return { ...issue, number: current };
  });
  return base;
}

/** the rows a challenge covers, with the summary the approval card shows */
export function approvalTarget(document: IdeaDocument, ids?: readonly string[]): { rows: ExitRow[]; summary: ReturnType<typeof summarizeExits> } {
  if (!document.frozenIntact) {
    throw new ConversationRefused("ゲート 2 の凍結を確かめられません。4 点を変えたならゲート 2 をやり直してください", 409);
  }
  const rows = selectExitRows(document, ids);
  if (!rows.length) throw new ConversationRefused("実行できる出口の行がありません", 409);
  return { rows, summary: summarizeExits(rows) };
}

/**
 * A declared place is usable only when its real path is not home (nor a parent of home) and not inside the state
 * or settings. A symlink may carry the declared text somewhere else, so the check resolves the place first; a
 * place still inside the workspace or a normal directory is returned as it was written, for display.
 */
export function validatePlaces(document: IdeaDocument): { safe: string[]; errors: string[] } {
  const home = comparablePath(homedir());
  const forbidden = [stateDir(), userConfigDir()].map((root) => comparablePath(root));
  const safe: string[] = [];
  const errors: string[] = [];
  for (const raw of document.places) {
    const expanded = expandHome(raw);
    if (!isAbsolute(expanded)) { errors.push(`置き場が絶対パスではありません: ${raw}`); continue; }
    let real: string;
    try { real = resolveRealPath(expanded, "置き場"); }
    catch { errors.push(`置き場の実体を確かめられません: ${raw}`); continue; }
    if (containsHome(real, home)) { errors.push(`置き場に home そのものや祖先は使えません: ${raw}`); continue; }
    if (forbidden.some((root) => isWithin(root, real))) {
      errors.push(`置き場に state や設定の置き場は使えません: ${raw}`);
      continue;
    }
    safe.push(expanded);
  }
  return { safe, errors };
}

/** whether `root` is home itself or a parent of home; a plain path compare, since home exists lexically */
function containsHome(root: string, home: string): boolean {
  const rel = relative(root, home);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/** the roots a hand-side row may write in: the workspace and the document's declared places */
function allowedRoots(workspace: string, document: IdeaDocument): string[] {
  const { safe } = validatePlaces(document);
  return [workspace, ...safe];
}

/** the state and settings a hand-side row may never write, whatever the document declares */
function forbiddenRoots(documentPath: string): string[] {
  // the settings files themselves, not their directories: an env override may point them at the same temp
  // root the workspace lives under, and that root must not become forbidden with them
  return [stateDir(), userConfigDir(), documentPath, configPath("repos"), configPath("roles"), configPath("modes")];
}

/** resolve a hand-side row's destination and refuse anything outside the workspace and the declared places */
function resolveWritePath(workspace: string, document: IdeaDocument, documentPath: string, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new ConversationRefused("書き込み先が空です", 400);
  const expanded = trimmed.startsWith("~") ? expandHome(trimmed) : trimmed;
  const abs = isAbsolute(expanded) ? expanded : resolve(workspace, expanded);
  // a link on the way must not carry the write out: compare the real destination, not the written text
  const real = resolveRealPath(abs, "書き込み先");
  for (const forbidden of forbiddenRoots(documentPath)) {
    if (samePath(real, forbidden) || isWithin(forbidden, real)) {
      throw new ConversationRefused(`state か設定の中へは書けません: ${raw}`, 409);
    }
  }
  let inside = false;
  for (const root of allowedRoots(workspace, document)) {
    try {
      assertWithinRoot(root, real, "置き場");
      inside = true;
      break;
    } catch { /* try the next root */ }
  }
  if (!inside) throw new ConversationRefused(`workspace と宣言した置き場の外へは書けません: ${raw}`, 403);
  return real;
}

/** apply one file row's change: create (only when absent), append, or one-place replace */
function applyFileChange(abs: string, row: ExitRow): void {
  const exists = existsSync(abs);
  if (row.change === "作成") {
    if (exists) throw new Error(`既にファイルがあります: ${abs}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, row.content ?? "");
    return;
  }
  if (!exists) throw new Error(`ファイルがありません: ${abs}`);
  if (!statSync(abs).isFile()) throw new Error(`ファイルではありません: ${abs}`);
  const current = readFileSync(abs, "utf8");
  if (row.change === "追記") {
    writeFileSync(abs, current + (row.content ?? ""));
    return;
  }
  const before = row.before ?? "";
  const after = row.after ?? "";
  if (!before) throw new Error("置換の前の文面が空です");
  const first = current.indexOf(before);
  if (first < 0) throw new Error("置換の前の文面がファイルにありません");
  if (current.indexOf(before, first + before.length) >= 0) throw new Error("置換の前の文面がファイルに 2 か所以上あります");
  writeFileSync(abs, current.slice(0, first) + after + current.slice(first + before.length));
}

/** the created Issue's number, only when the URL is that Issue of the signed repo */
function issueNumberFromUrl(url: string, repo: string): number | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "issues") return null;
  const [owner, name, , number] = parts;
  if (`${owner}/${name}`.toLowerCase() !== repo.trim().toLowerCase()) return null;
  return /^\d+$/.test(number) ? Number(number) : null;
}

/** the Issue numbers already written in the document, for the dependency notation */
function issueNumbersIn(document: IdeaDocument): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of document.exits) for (const issue of row.issues ?? []) if (issue.number !== null) out.set(issue.id, issue.number);
  return out;
}

/** replace the `{{id}}` notation with the dependency's number; only a declared dependency may be named */
function renderIssueBody(issue: ExitIssue, document: IdeaDocument): string {
  const numbers = issueNumbersIn(document);
  return issue.body.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_match, id: string) => {
    if (!issue.depends.includes(id)) throw new Error(`依存に挙げていない Issue を本文が指しています: ${id}`);
    const number = numbers.get(id);
    if (number === undefined) throw new Error(`依存先の Issue がまだ作られていません: ${id}`);
    return `#${number}`;
  });
}

function appendExitRecord(line: Record<string, unknown>): void {
  try {
    appendFileSync(ideaExitLogPath(), `${JSON.stringify(line)}\n`);
  } catch { /* the record is a trace; its write must not fail a run that already happened */ }
}

function readDocument(path: string): IdeaDocument {
  return parseIdeaDocument(readFileSync(path, "utf8"), path);
}

/**
 * Run the approved rows under one signature. The lock is taken before the first await, so two requests for the
 * same document cannot both run. The conversation is held for the whole run, so its agent cannot start writing
 * the same document while the engine writes results back between rows.
 */
export async function runIdeaExits(input: RunExitsInput): Promise<RunExitsResult> {
  const key = comparablePath(input.documentPath);
  if (running.has(key)) throw new ConversationRefused("この文書の出口を実行しています", 409);
  running.add(key);
  let blocked = false;
  const startedAt = new Date().toISOString();
  const signedNumbers = new Map<string, number | null>();
  // the Issue numbers this run wrote itself: they are put back to the signed values when re-checking the gate
  const engineNumbers = new Map<string, number>();
  let targetIds: string[] = [];
  const outcomes: ExitOutcome[] = [];
  let stopped = false;
  let reason: string | undefined;
  try {
    if (!input.conversation.canWriteDocument) throw new ConversationRefused("応答中は出口を実行できません", 409);
    input.conversation.beginExitRun();
    blocked = true;

    let document = readDocument(input.documentPath);
    const { rows } = approvalTarget(document, input.rows);
    targetIds = rows.map((row) => row.id);
    for (const row of rows) for (const issue of row.issues ?? []) signedNumbers.set(issue.id, issue.number);
    const content = buildIdeaExitContent(document, rows, signedNumbers);

    if (!input.nonce) throw new ConversationRefused("署名がありません。承認からやり直してください", 400);
    const signed = await verifyApprovalSignature({ nonce: input.nonce, assertion: input.assertion, content, compareContent: true });
    if (!signed.ok) throw new ConversationRefused(signed.reason, 403);

    /** the signed content, rebuilt from the document as it is now, with this run's own writes reverted */
    const currentContent = (): Record<string, unknown> => {
      const now = readDocument(input.documentPath);
      const rowsNow = targetIds.map((rid) => now.exits.find((row) => row.id === rid)).filter((row): row is ExitRow => Boolean(row));
      return buildIdeaExitContent(now, rowsNow, signedNumbers, engineNumbers);
    };

    for (const id of targetIds) {
      document = readDocument(input.documentPath);
      const fresh = document.exits.find((row) => row.id === id);
      if (!fresh || !fresh.readable) {
        stopped = true;
        reason = `実行の途中で行が読めなくなりました: ${id}`;
        break;
      }
      const gate = approvalGateOpen(input.nonce, currentContent());
      if (!gate.ok) {
        // a gate refusal is not a failed row: nothing of this row was run, so it stays a draft
        stopped = true;
        reason = gate.reason;
        break;
      }
      const mark = (state: "承認済み" | "実行済み" | "失敗", result?: string): void => {
        const text = setExitState(readFileSync(input.documentPath, "utf8"), id, state, result);
        writeIdeaText(input.documentPath, text);
      };
      // the row must be marked 承認済み before its side effect; if that write cannot land, the run must not go
      // on to answer success while the document still holds a draft
      try {
        mark("承認済み");
      } catch (error) {
        stopped = true;
        reason = `出口の行の状態を書けません: ${id}: ${error instanceof Error ? error.message : String(error)}`;
        outcomes.push({ id, state: "下書き", reason });
        break;
      }
      try {
        const outcome = await executeRow(fresh, {
          documentPath: input.documentPath,
          workspace: input.workspace,
          nonce: input.nonce,
          targetIds,
          signedNumbers,
          engineNumbers,
          recheckGate: () => approvalGateOpen(input.nonce, currentContent()),
        });
        outcomes.push(outcome);
        if (outcome.state === "実行済み") {
          try {
            const text = setExitState(readFileSync(input.documentPath, "utf8"), id, "実行済み", outcome.result ?? "");
            writeIdeaText(input.documentPath, text);
          } catch (error) {
            // the operation already happened but its result cannot be written: the row keeps its 承認済み mark,
            // and the answer still carries what the operation returned
            stopped = true;
            reason = error instanceof Error ? error.message : String(error);
            break;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ExitWriteBackError) {
          // a side effect happened and only the write-back failed: the row stays 承認済み and is not run again
          outcomes.push({ id, state: "承認済み", reason: message, issues: error.issues });
        } else {
          outcomes.push({ id, state: "失敗", reason: message });
          try {
            const text = setExitState(readFileSync(input.documentPath, "utf8"), id, "失敗", message);
            writeIdeaText(input.documentPath, text);
          } catch { /* the row keeps its 承認済み mark: the document cannot be written either way */ }
        }
        stopped = true;
        reason = message;
        break;
      }
    }
    return { stopped, outcomes, rows: targetIds };
  } finally {
    running.delete(key);
    if (blocked) input.conversation.endExitRun();
    consumeNonce(input.nonce);
    appendExitRecord({
      at: startedAt,
      conversation: input.conversationId,
      document: input.documentPath,
      rows: targetIds,
      stopped,
      ...(reason ? { reason } : {}),
      outcomes,
    });
  }
}

interface RowRunContext {
  documentPath: string;
  workspace: string;
  nonce: string;
  targetIds: string[];
  signedNumbers: Map<string, number | null>;
  engineNumbers: Map<string, number>;
  recheckGate: () => { ok: true } | { ok: false; reason: string };
}

/** run one row's operation, writing each Issue's result as soon as it is made */
async function executeRow(row: ExitRow, ctx: RowRunContext): Promise<ExitOutcome> {
  if (row.operation === "issues") {
    const created: { id: string; number: number | null; url: string | null }[] = [];
    for (const issue of row.issues ?? []) {
      if (issue.number !== null) {
        // already made (a retry, or a row that failed after some issues): never made twice
        created.push({ id: issue.id, number: issue.number, url: issueUrl(issue, row.target) });
        continue;
      }
      const gate = ctx.recheckGate();
      if (!gate.ok) throw new Error(gate.reason);
      const body = renderIssueBody(issue, readDocument(ctx.documentPath));
      const url = await createGhIssue({ repo: row.target, title: issue.title, body, labels: issue.labels });
      const number = issueNumberFromUrl(url, row.target);
      if (number === null) throw new Error(`Issue の番号を URL から読めません: ${url}`);
      // the Issue is made: it is recorded before the write-back, so a write that fails still answers with it
      created.push({ id: issue.id, number, url });
      try {
        const text = setIssueResult(readFileSync(ctx.documentPath, "utf8"), row.id, issue.id, `#${number} ${url}`);
        writeIdeaText(ctx.documentPath, text);
        ctx.engineNumbers.set(issue.id, number);
      } catch (error) {
        throw new ExitWriteBackError(error instanceof Error ? error.message : String(error), created);
      }
    }
    const made = created.filter((entry) => entry.number !== null);
    return {
      id: row.id,
      state: "実行済み",
      result: made.map((entry) => `#${entry.number}`).join(" "),
      issues: created,
    };
  }
  if (row.operation === "repo") {
    const gate = ctx.recheckGate();
    if (!gate.ok) throw new Error(gate.reason);
    const url = await createGhRepo({ name: row.target, visibility: row.visibility === "public" ? "public" : "private", description: row.description ?? "" });
    return { id: row.id, state: "実行済み", result: url };
  }
  const gate = ctx.recheckGate();
  if (!gate.ok) throw new Error(gate.reason);
  const document = readDocument(ctx.documentPath);
  const abs = resolveWritePath(ctx.workspace, document, ctx.documentPath, row.target);
  applyFileChange(abs, row);
  return { id: row.id, state: "実行済み", result: abs };
}

function issueUrl(issue: ExitIssue, repo: string): string | null {
  return issue.number !== null ? `https://github.com/${repo.trim()}/issues/${issue.number}` : null;
}
