import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { randomUUID } from "node:crypto";

import {
  deriveStage, esc, planReviewInputs, readBacklog, readLifecycle, readOpenQuestions, readProgress, readQuestionBatch,
  readSessions, unreadableColumnOf, renderMessage, section, readySummaryOf,
  type BacklogRecord, type LifecycleRecord, type PendingQuestionBatch, type SessionRecord,
} from "@idd/core";
import { conversationLane, knownSecrets, laneDir, redactSecrets } from "@idd/lane";

import { createConsultCopy, removeConsultCopyPath, sweepConsultCopies } from "./consult-copy.ts";
import {
  listEphemeralRecords, readSessionRecord, writeEphemeralRecord,
  type ConsultMark, type EphemeralRecord,
} from "./ephemeral.ts";
import { ConversationRefused } from "./refusal.ts";
import { createConsultConversation, conversationIfOpen } from "./conversations.ts";
import { resolveSessionFile } from "./session-file.ts";

/*
 * A consult: the person talks to a consultant that already holds the question's own ground, then answers the
 * question through the ordinary decide door. The consult is an ephemeral branch with no parent, so the lane
 * agent's words never enter its context; the envelope built here is the whole first context. The consultant runs
 * in a standalone copy of the lane's worktree, so it reads the uncommitted documents and cannot disturb the lane.
 *
 * One card has one consult: the record carries the card's key, and a second open returns the same id. The ledger
 * is the source of truth for the consult's life: a batch with no open question left, or a closed lane, closes the
 * consult, and a closed consult refuses further talk while keeping its record for the retention window.
 */

/** the tools a consult runs with: reading only, and bash for looking at the copy's own output */
export const CONSULT_TOOLS: readonly string[] = Object.freeze(["read", "grep", "find", "ls", "bash"]);

/** the mode and role a consult branch uses; the branch keeps the role's reading tools but not its writes */
const CONSULT_MODE = "chat";
const CONSULT_ROLE = "chat";

/** the kinds of card a consult can be opened for; other kinds are refused as unsupported */
const SUPPORTED_KINDS: readonly string[] = Object.freeze(["question"]);

export interface ConsultOpenInput {
  kind: string;
  iddId: string;
  batchId: string;
}

export interface ConsultOpenResult {
  id: string;
  created: boolean;
  mode: string;
  role: string;
  cwd: string;
  tools: string[];
}

/** the opens in flight, one per card, so two callers never cut two branches for one card */
const opening = new Map<string, Promise<ConsultOpenResult>>();

function keyOf(input: { kind: string; iddId: string; batchId: string }): string {
  return `${input.kind}\0${input.iddId}\0${input.batchId}`;
}

/**
 * Open the consult for one card, or answer the one already open for it. Every check happens before the branch
 * and the copy are made, so a refused open leaves nothing behind; two calls for one card share one branch.
 */
export function openConsult(input: ConsultOpenInput): Promise<ConsultOpenResult> {
  const key = keyOf(input);
  const inflight = opening.get(key);
  if (inflight) return inflight;
  const promise = openConsultUncached(input).finally(() => { opening.delete(key); });
  opening.set(key, promise);
  return promise;
}

/** the consult record for a card, preferring a live one over a closed one */
function consultFor(kind: string, iddId: string, batchId: string): EphemeralRecord | undefined {
  const matches = listEphemeralRecords().filter((rec) => rec.consult
    && rec.consult.kind === kind && rec.consult.iddId === iddId && rec.consult.batchId === batchId);
  return matches.find((rec) => !rec.consult?.closedAt) ?? matches[0];
}

async function openConsultUncached(input: ConsultOpenInput): Promise<ConsultOpenResult> {
  // the ledger may have moved since the last open: settle the records before deciding from them
  await reconcileConsults();
  if (!input.kind) throw new ConversationRefused("kind が必要です", 400);
  if (!input.iddId) throw new ConversationRefused("iddId が必要です", 400);
  if (!input.batchId) throw new ConversationRefused("batchId が必要です", 400);
  if (!SUPPORTED_KINDS.includes(input.kind)) throw new ConversationRefused(`この種類の card の相談はまだ開けません: ${input.kind}`, 400);

  // the lane's end is checked before the consult's record: reconcileConsults() closes a closed lane's consults, so the
  // record would refuse with "the consult is closed" when the reason is that the lane is closed
  const events = readLifecycle().filter((e) => e.idd_id === input.iddId);
  if (deriveStage(events).group === "closed") throw new ConversationRefused("この lane は閉じています", 409);

  const existing = consultFor(input.kind, input.iddId, input.batchId);
  if (existing) {
    if (existing.consult?.closedAt) throw new ConversationRefused("この card の相談は閉じています", 409);
    return {
      id: existing.sessionId, created: false, mode: existing.mode, role: existing.role,
      cwd: existing.cwd, tools: [...existing.tools],
    };
  }

  // a column that cannot be read says neither that the batch is there nor that it is answered: the card is refused as
  // unreadable, and not as answered or as missing
  let batch: PendingQuestionBatch | undefined;
  let stillOpen: boolean;
  try {
    batch = readQuestionBatch(input.iddId, input.batchId);
    stillOpen = readOpenQuestions().some((b) => b.idd_id === input.iddId && b.batch_id === input.batchId);
  } catch (error) {
    const column = unreadableColumnOf(error);
    if (!column) throw error;
    throw new ConversationRefused(`${column}を読めないので、相談を開けません。読めるようになってからもう一度開いてください`, 503);
  }
  if (!batch) throw new ConversationRefused(`質問の batch がありません: ${input.iddId}/${input.batchId}`, 404);
  if (!stillOpen) {
    throw new ConversationRefused("この質問にはもう答えています", 409);
  }
  const worktree = laneWorktreeOf(input.iddId);
  if (!worktree) throw new ConversationRefused("lane の worktree がありません", 409);

  const id = randomUUID();
  let copyPath: string;
  try {
    copyPath = await createConsultCopy({ id, from: worktree });
  } catch (error) {
    throw new ConversationRefused(`相談の複製を作れません: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
  const mark: ConsultMark = { kind: input.kind, iddId: input.iddId, batchId: input.batchId, copyPath };
  let envelope: string;
  try {
    envelope = redactEnvelope(buildConsultEnvelope({ batch, iddId: input.iddId, copyPath, worktree, events }));
  } catch (error) {
    removeConsultCopyPath(copyPath);
    throw new ConversationRefused(`相談の封筒を組めません: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
  try {
    await createConsultConversation({ id, envelope, cwd: copyPath, tools: [...CONSULT_TOOLS], consult: mark });
  } catch (error) {
    removeConsultCopyPath(copyPath);
    throw error;
  }
  return { id, created: true, mode: CONSULT_MODE, role: CONSULT_ROLE, cwd: copyPath, tools: [...CONSULT_TOOLS] };
}

/** the worktree the lane's planner ran in, then the executor's, the same order the report check uses */
export function laneWorktreeOf(iddId: string): string | undefined {
  const planner = readSessions("planner").filter((s) => s.idd_id === iddId).at(-1)?.worktree_path;
  const executor = readSessions("executor").filter((s) => s.idd_id === iddId).at(-1)?.worktree_path;
  const worktree = planner ?? executor;
  return worktree && existsSync(worktree) ? worktree : undefined;
}

// ---- closing: the ledger decides, the sweep carries it out ----

/** the lane's events, read once per reconcile so the closed check never re-reads the ledger per record */
function closedLanes(events: LifecycleRecord[]): Set<string> {
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const event of events) {
    const list = byLane.get(event.idd_id) ?? [];
    list.push(event);
    byLane.set(event.idd_id, list);
  }
  const closed = new Set<string>();
  for (const [iddId, lane] of byLane) if (deriveStage(lane).group === "closed") closed.add(iddId);
  return closed;
}

/**
 * Close every consult the ledger says is done: its question batch has no open question left, or its lane closed.
 * The pi is stopped, the copy is removed and the record is marked closed, but the branch record stays for the
 * retention window. Reading the ledger once per run is what keeps this cheap enough for the branch sweeper.
 */
export async function reconcileConsults(now = new Date()): Promise<string[]> {
  const records = listEphemeralRecords().filter((rec) => rec.consult && !rec.consult.closedAt);
  if (!records.length) return [];
  // a column that cannot be read says nothing of which cards are open: no consult is closed on it, and the next run
  // that can read the columns closes the ones that are done
  let openCards: Set<string>;
  try {
    openCards = new Set(readOpenQuestions().map((b) => `${b.idd_id}\0${b.batch_id}`));
  } catch (error) {
    if (!unreadableColumnOf(error)) throw error;
    return [];
  }
  const closed = closedLanes(readLifecycle());
  const done: string[] = [];
  for (const rec of records) {
    const mark = rec.consult as ConsultMark;
    const cardOpen = openCards.has(`${mark.iddId}\0${mark.batchId}`);
    if (cardOpen && !closed.has(mark.iddId)) continue;
    await closeConsult(rec, now);
    done.push(rec.sessionId);
  }
  return done;
}

/**
 * Settle the consults from the answer path without letting the housekeeping reach the caller. The answer is
 * already recorded, so a consult that will not close is a leftover the next reconcile picks up, never a
 * reason to fail the delivered answer or to take the engine's process down with an unhandled rejection.
 */
export function settleConsultsAfterAnswer(): void {
  void reconcileConsults().catch((error) => {
    console.warn(`[consult] 相談の後始末に失敗しました: ${String(error instanceof Error ? error.message : error).slice(0, 400)}`);
  });
}

/** stop an open consult and remove its copy; the record is kept with the closed mark */
async function closeConsult(rec: EphemeralRecord, now: Date): Promise<void> {
  const open = conversationIfOpen(rec.sessionId);
  if (open && !open.isClosed) {
    try { await open.close(); } catch { /* the record and the copy still go */ }
  }
  if (rec.consult?.copyPath) removeConsultCopyPath(rec.consult.copyPath);
  const stamp = now.toISOString();
  writeEphemeralRecord({ ...rec, updatedAt: stamp, consult: { ...(rec.consult as ConsultMark), closedAt: stamp } });
}

/** remove the copies of the records that are gone, keeping every copy a consult record still points at */
export function sweepConsultCopiesFor(records: EphemeralRecord[]): string[] {
  return sweepConsultCopies(new Set(records.filter((rec) => rec.consult).map((rec) => rec.sessionId)));
}

// ---- the envelope: the ledger and the tool arguments, never the agent's own words ----

export interface ConsultEnvelopeInput {
  batch: PendingQuestionBatch;
  iddId: string;
  /** the branch's working copy, so the envelope can say which contract files are already there */
  copyPath: string;
  /** the lane's worktree, so read paths can be shown relative to the tree the person sees */
  worktree: string;
  events: LifecycleRecord[];
}

const ROLE_STATEMENT = [
  "ユーザーがこの質問に答えるのを助ける。自分では答えを決めず、回答の下書きも作らず、聞かれたことを現物で確かめて説明する。",
  "ファイルを書き換えない。bash は読む用途だけに使う。回答はユーザーが card から送る。",
].join("\n");

/** the whole first context of a consult: how it should behave, and the ground the question stands on */
export function buildConsultEnvelope(input: ConsultEnvelopeInput): string {
  const backlog = readBacklog().find((rec) => rec.idd_id === input.iddId);
  const context = [
    questionsField(input.batch),
    contractField(input.iddId, input.copyPath),
    issueField(backlog, input.iddId),
    summaryField(input.events),
    readFilesField(input.worktree, input.iddId),
    reportsField(input.iddId, input.events),
  ].filter(Boolean).join("\n");
  return renderMessage([
    section("task", ["  <task>", ...ROLE_STATEMENT.split("\n").map((line) => `    ${line}`), "  </task>"].join("\n")),
    section("context", context),
  ]);
}

/** every question of the batch with its options, the exact material the person answered from */
function questionsField(batch: PendingQuestionBatch): string {
  const lines = [`  <questions batch-id="${esc(batch.batch_id)}">`];
  for (const question of batch.questions) {
    lines.push(`    <question id="${esc(question.question_id)}">`);
    lines.push(`      <text>${esc(question.question)}</text>`);
    if (question.context) lines.push(`      <context>${esc(question.context)}</context>`);
    lines.push("      <options>");
    for (const option of question.options) {
      lines.push(`        <option index="${option.index}"${option.recommendation ? ` recommendation="${esc(option.recommendation)}"` : ""}>`);
      lines.push(`          <label>${esc(option.label)}</label>`);
      if (option.description) lines.push(`          <description>${esc(option.description)}</description>`);
      if (option.rationale) lines.push(`          <rationale>${esc(option.rationale)}</rationale>`);
      lines.push("        </option>");
    }
    lines.push("      </options>");
    lines.push("    </question>");
  }
  lines.push("  </questions>");
  return lines.join("\n");
}

/** the contract's two paths, marked when the copy does not hold them yet */
function contractField(iddId: string, copyPath: string): string {
  const backlog = readBacklog().find((rec) => rec.idd_id === iddId);
  const paths = backlog ? planReviewInputs(backlog).slice(0, 2) : [];
  const lines = ["  <contract>"];
  for (const path of paths) {
    const there = existsSync(join(copyPath, path));
    lines.push(`    <file exists="${there ? "true" : "false"}">${esc(path)}</file>`);
    if (!there) lines.push(`    <missing>${esc(path)} はまだ無い</missing>`);
  }
  lines.push("  </contract>");
  return lines.join("\n");
}

function issueField(backlog: BacklogRecord | undefined, iddId: string): string {
  const url = backlog?.gh_issue_url ?? backlog?.linear_issue_url ?? "";
  return [
    "  <issue>",
    `    <title>${esc(backlog?.title ?? "")}</title>`,
    `    <url>${esc(url)}</url>`,
    `    <body>${esc(backlog?.context ?? "")}</body>`,
    `    <lane-id>${esc(iddId)}</lane-id>`,
    "  </issue>",
  ].join("\n");
}

function summaryField(events: LifecycleRecord[]): string {
  const summary = readySummaryOf(events);
  if (!summary) return '  <planner-summary missing="true">planner の summary はまだ無い</planner-summary>';
  return [
    "  <planner-summary>",
    `    <situation>${esc(summary.situation)}</situation>`,
    `    <action>${esc(summary.action)}</action>`,
    `    <outcome>${esc(summary.outcome)}</outcome>`,
    "  </planner-summary>",
  ].join("\n");
}

/** the files the agent that asked read, from the tool arguments alone; never its words or thinking */
function readFilesField(worktree: string, iddId: string): string {
  const agent = agentSessionOf(iddId);
  if (!agent.sessionId) return '  <read-files missing="true">読んだファイルはまだ分からない</read-files>';
  const raw = agent.harness === "claude"
    ? claudeReadFiles(agent.sessionId)
    : piReadFiles(agent.sessionId);
  const files = normalizeReadFiles(raw, worktree);
  if (!files.length) return '  <read-files missing="true">読んだファイルはまだ無い</read-files>';
  return ["  <read-files>", ...files.map((file) => `    <file>${esc(file)}</file>`), "  </read-files>"].join("\n");
}

/** the reports the ledger holds for the lane; a lane that has reported none says so */
function reportsField(iddId: string, events: LifecycleRecord[]): string {
  const lines = ["  <agent-reports>"];
  let any = false;
  const progress = readProgress(iddId);
  if (progress) {
    any = true;
    lines.push(`    <progress step="${esc(progress.current_step)}">`);
    for (const qa of progress.qa_status) lines.push(`      <qa id="${esc(qa.qa_id)}" status="${esc(qa.status)}" />`);
    for (const recent of progress.recent_activity) lines.push(`      <recent>${esc(recent)}</recent>`);
    lines.push("    </progress>");
  }
  const result = [...events].reverse().find((e) => e.event === "s2_result");
  if (result) {
    any = true;
    const attrs = result.attrs ?? {};
    lines.push(`    <result outcome="${esc(String(attrs.outcome ?? ""))}" commit-count="${esc(String(attrs.commit_count ?? ""))}">`);
    for (const file of asStringArray(attrs.changed_files)) lines.push(`      <changed-file>${esc(file)}</changed-file>`);
    for (const id of asStringArray(attrs.qa_verified)) lines.push(`      <qa-verified>${esc(id)}</qa-verified>`);
    for (const id of asStringArray(attrs.qa_unverified)) lines.push(`      <qa-unverified>${esc(id)}</qa-unverified>`);
    for (const note of asStringArray(attrs.side_findings)) lines.push(`      <side-finding>${esc(note)}</side-finding>`);
    lines.push("    </result>");
  }
  if (!any) lines.push('    <missing>台帳に残る報告はまだ無い</missing>');
  lines.push("  </agent-reports>");
  return lines.join("\n");
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** the session of the agent that asked: the last executor, then the planner, the order the answer goes back in */
function agentSessionOf(iddId: string): { sessionId?: string; harness?: string } {
  const planner = readSessions("planner").filter((s) => s.idd_id === iddId).at(-1);
  const executor = readSessions("executor").filter((s) => s.idd_id === iddId).at(-1);
  const rec: SessionRecord | undefined = executor ?? planner;
  if (!rec) return {};
  return { sessionId: rec.executor_session_id ?? rec.planner_session_id, harness: rec.harness };
}

/** the paths of the `read` tool calls in pi's record; the calls' arguments only, never a body or a result */
function piReadFiles(sessionId: string): string[] {
  const file = resolveSessionFile(sessionId);
  if (!file) return [];
  const out: string[] = [];
  for (const entry of readSessionRecord(file).entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const call = block as { type?: string; name?: string; arguments?: { path?: unknown } };
      if (call.type === "toolCall" && call.name === "read" && typeof call.arguments?.path === "string") out.push(call.arguments.path);
    }
  }
  return out;
}

/** the paths of the `Read` tool calls in a Claude Code lane's replies */
function claudeReadFiles(sessionId: string): string[] {
  const laneId = conversationLane(sessionId);
  if (!laneId) return [];
  const dir = join(laneDir(laneId), "turns");
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const numbered = names.filter((name) => /^\d+\.jsonl$/.test(name)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const out: string[] = [];
  for (const name of numbered) {
    let text: string;
    try { text = readFileSync(join(dir, name), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event: { type?: string; message?: { content?: unknown } };
      try { event = JSON.parse(line) as typeof event; } catch { continue; }
      if (event?.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
      for (const block of event.message.content as unknown[]) {
        if (!block || typeof block !== "object") continue;
        const call = block as { type?: string; name?: string; input?: { file_path?: unknown } };
        if (call.type === "tool_use" && call.name === "Read" && typeof call.input?.file_path === "string") out.push(call.input.file_path);
      }
    }
  }
  return out;
}

const READ_FILES_MAX = 200;

/** dedupe the paths, show the ones under the worktree relative to it, and cut the list at its cap */
function normalizeReadFiles(paths: string[], worktree: string): string[] {
  const root = resolve(worktree);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    const abs = resolve(root, path);
    let shown = path;
    if (isAbsolute(path) || abs === root || abs.startsWith(`${root}${sep}`)) {
      const rel = relative(root, abs);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) shown = rel;
    }
    if (seen.has(shown)) continue;
    seen.add(shown);
    out.push(shown);
    if (out.length >= READ_FILES_MAX) break;
  }
  return out;
}

// ---- the copy's secrets: the callback token never rides into a consultant's hands ----

/** take the callback token (and any known secret) out of the envelope before it is written */
export function redactEnvelope(envelope: string): string {
  let secrets: string[] = [];
  try { secrets = knownSecrets(); } catch { /* no token written yet */ }
  return redactSecrets(envelope, secrets);
}
