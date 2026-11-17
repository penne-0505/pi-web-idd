import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readBacklog, readLifecycle, readQuestionBatch, readSessions, requireReadableAnswerColumns, unreadableAnswerColumns } from "../ledger/read.ts";
import { closedLanes } from "../plan/ledger-reads.ts";
import { recordRoutingCost, routingCostRow } from "../plan/routing-cost.ts";
import { laneGateWaitMs, withLaneGate } from "../ledger/gate.ts";
import { heldBatches, holdBatch, resumeUnderWay, settledResume } from "../ledger/routing-hold.ts";
import { finishAnsweredBatches, recordAskedBatch, recordRoutedBatch, type RoutedAnswer } from "../ledger/write.ts";
import { pathsInText } from "../intent/decisions.ts";
import { lookupChoices } from "../intent/store.ts";
import { readRoutedDecisions, type RoutedDecision } from "../ledger/routed-answers.ts";
import type { PendingAnswerBasis, PendingQuestionBatch } from "../schema/records.ts";
import { getAgentRunner } from "./port.ts";

/**
 * The judgement a question is, as the judge names it: `settled` for a question the records decide, and the six a
 * person keeps (`_docs/standards/human-facing.md`, 人に回す基準). The set is closed. The judge reads the question; the
 * engine reads only this name, so no list of words in a question decides anything here. Only `settled` is answered.
 */
export const ROUTING_KINDS = ["settled", "scope", "priority", "visible", "irreversible", "against_decision", "signature"] as const;
export type RoutingKind = (typeof ROUTING_KINDS)[number];

export const EVIDENCE_SOURCES = ["choice", "issue", "norm"] as const;

/** the only place a norm may be quoted from: a norm outside it is not one the engine vouches for */
export const NORM_ROOT = "_docs/standards/";

export const CHOICE_FIELDS = ["chosen", "why", "anchored", "free"] as const;

/** one quote the judge gives for an answer; the engine finds the field itself and records it */
export interface RoutingEvidence {
  source: (typeof EVIDENCE_SOURCES)[number];
  /** a Choice's id, or a path under `_docs/standards/`; empty for the Issue */
  ref: string;
  quote: string;
}

export interface RoutingChoice {
  id: string;
  chosen: string;
  why: string;
  anchored: string;
  free: string;
}

/** what the engine hands the judge, and checks the judge's quotes against */
export interface RoutingMaterial {
  choices: RoutingChoice[];
  /** the Issue's text, cut to `MATERIAL_ISSUE_MAX` characters */
  issue: string;
  /** the lane's worktree: the judge reads the norms from here, and the engine checks a norm's quote against it */
  worktree: string;
}

export interface RouterVerdict {
  questionId: string;
  decider: "self" | "human";
  kind: RoutingKind;
  optionIndex?: number;
  reason: string;
  evidence: RoutingEvidence[];
}

/** the lane's side of one call: the batch and its material in, the judge's text and who answered out */
export interface RouteCall {
  lane: string;
  batch: PendingQuestionBatch;
  material: RoutingMaterial;
}
/** what the judge's run used, as pi reports it, summed over the run's turns; the engine records it as the lane's cost */
export interface RouteUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number } | number;
}
export interface RouteReply {
  text: string;
  role: string;
  model: string;
  usage?: RouteUsage;
}

/**
 * A judge run that ended without a usable result (it ran out of time or exited non-zero) but did spend something. It
 * carries what the run used so the lane's cost still counts it; every question of the batch is a person's all the same.
 */
export class RouteFailed extends Error {
  readonly partial?: RouteReply;
  constructor(message: string, partial?: RouteReply) {
    super(message);
    this.name = "RouteFailed";
    this.partial = partial;
  }
}

/** at most this many Choices go in the material, and each field is cut to this many characters */
const MATERIAL_CHOICES_MAX = 80;
const MATERIAL_FIELD_MAX = 1200;
const MATERIAL_ISSUE_MAX = 6000;
/**
 * The questions, the Issue and the Choices together stay under this many bytes as the judge's prompt shows them. The
 * prompt is one argument of the child's command line, which the kernel caps near 128 KB, and the norms and the rest of
 * the prompt need the room that is left.
 */
export const MATERIAL_BYTES_MAX = 80_000;
/** the extra bytes a Choice takes in the prompt over its own pretty-printed JSON (it sits two levels deeper) */
const CHOICE_INDENT_BYTES = 32;
/** a quote shorter than this proves nothing */
export const QUOTE_MIN = 12;
/** a norm larger than this is not read to check a quote against */
const FILE_MAX_BYTES = 1_000_000;

const cut = (s: string, n: number): string => (Array.from(s).length > n ? `${Array.from(s).slice(0, n - 1).join("")}…` : s);
/** the bytes a value takes in the judge's prompt: pretty-printed, one line per row, indented, with `&` `<` `>` escaped */
export function renderedBytes(v: unknown): number {
  return JSON.stringify(v, null, 1).split("\n").reduce((n, l) => n + 5 + Buffer.byteLength(l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), "utf8"), 0);
}
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Whether the lane is still before its first GO. Only then does the mechanism answer, because such an answer passes the
 * GO card and a person can still turn it back. Once the lane has been given its GO (whether or not an executor session
 * has started yet) a question is a person's. The planner's ask is read here before the batch is on record, and read
 * again as the result is written.
 */
export function inPlanning(iddId: string, lifecycle = readLifecycle()): boolean {
  return !lifecycle.some((e) => e.idd_id === iddId && e.event === "s1_go");
}

/** the worktree the lane's planner works in, when it is there to be read */
function planningWorktree(iddId: string): string | null {
  const worktree = readSessions("planner").filter((s) => s.idd_id === iddId).pop()?.worktree_path;
  return worktree && existsSync(worktree) ? worktree : null;
}

/** the Choices and the Issue a lane's questions are judged against; null when the lane has no worktree */
export function buildRoutingMaterial(iddId: string, batch: PendingQuestionBatch): RoutingMaterial | null {
  const rec = readBacklog().find((b) => b.idd_id === iddId);
  const worktree = planningWorktree(iddId);
  if (!rec || !worktree) return null;
  const asked = batch.questions.flatMap((q) => [q.question, q.context, ...q.options.flatMap((o) => [o.label, o.description ?? ""])]).join("\n");
  const paths = pathsInText(`${rec.title}\n${rec.context}\n${asked}`, worktree);
  const issue = cut(rec.context, MATERIAL_ISSUE_MAX);
  // the prompt goes on the child's command line, which has a hard size limit: the questions and the Issue come first,
  // and the Choices fill what is left, the closest first. A Choice cut off here is not in the material, so no quote can
  // rest on it. Questions that alone fill the budget are left to a person.
  const left = MATERIAL_BYTES_MAX - renderedBytes(batch.questions) - renderedBytes(issue);
  if (left <= 0) return null;
  const choices: RoutingChoice[] = [];
  // a question that names no path still meets the root Choices of its repo (they hold every path), so it is looked up
  // against a stand-in path only a root Place can hold
  const found = lookupChoices({ repo: rec.area, actor: { lane: iddId }, paths: paths.length ? paths : ["."] });
  // only a confirmed (active) Choice is a decision that is settled: an unconfirmed draft is not a basis for an answer
  const active = found.filter((x) => x.status === "active");
  // a root Choice binds the whole repo, so the judge must read all of them: a batch they cannot all fit in is a person's
  const isRoot = (c: (typeof active)[number]) => c.matched.some((m) => m.kind === "root");
  const ordered = [...active.filter(isRoot), ...active.filter((c) => !isRoot(c) && (paths.length > 0))];
  const required = active.filter(isRoot).length;
  if (required > MATERIAL_CHOICES_MAX) return null;
  let bytes = 0;
  for (const [i, c] of ordered.slice(0, MATERIAL_CHOICES_MAX).entries()) {
    const choice = {
      id: c.id,
      chosen: cut(c.forms.chosen, MATERIAL_FIELD_MAX),
      why: cut(c.why, MATERIAL_FIELD_MAX),
      anchored: cut(c.anchored, MATERIAL_FIELD_MAX),
      free: cut(c.free, MATERIAL_FIELD_MAX),
    };
    bytes += renderedBytes(choice) + CHOICE_INDENT_BYTES;
    if (bytes > left) {
      if (i < required) return null;
      break;
    }
    choices.push(choice);
  }
  return { choices, issue, worktree };
}

/** the text of a norm: a regular file under `_docs/standards/` inside the worktree, with no symlink on the way */
function normText(worktree: string, ref: string): string | null {
  const wanted = ref.replace(/^\.\//, "");
  if (!wanted.startsWith(NORM_ROOT) || isAbsolute(wanted)) return null;
  try {
    const root = realpathSync(worktree);
    const rel = relative(root, resolve(root, wanted));
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !rel.split(sep).join("/").startsWith(NORM_ROOT)) return null;
    let at = root;
    for (const part of rel.split(sep)) {
      at = join(at, part);
      if (lstatSync(at).isSymbolicLink()) return null;
    }
    const st = statSync(at);
    if (!st.isFile() || st.size > FILE_MAX_BYTES) return null;
    return readFileSync(at, "utf8");
  } catch {
    return null;
  }
}

/**
 * The basis the engine found for a quote, or null. A quote is found only as one continuous string of a single
 * field of a Choice the material holds, of the Issue's text, or of a norm under `_docs/standards/`: a quote that
 * runs over the edge of two fields, a Choice the material does not hold, and a norm elsewhere are in none of them.
 */
export function basisOf(e: RoutingEvidence, material: RoutingMaterial): PendingAnswerBasis | null {
  const quote = squash(e.quote);
  if (Array.from(quote).length < QUOTE_MIN) return null;
  const has = (text: string) => squash(text).includes(quote);
  if (e.source === "choice") {
    const c = material.choices.find((x) => x.id === e.ref);
    const field = c ? CHOICE_FIELDS.find((f) => has(c[f])) : undefined;
    return field ? { source: "choice", ref: e.ref, field, quote } : null;
  }
  if (e.source === "issue") return has(material.issue) ? { source: "issue", ref: "", quote } : null;
  const text = normText(material.worktree, e.ref);
  return text !== null && has(text) ? { source: "norm", ref: e.ref.replace(/^\.\//, ""), quote } : null;
}

/** whether the quote is in the material the evidence names; a quote the engine cannot find does not count */
export function evidenceHolds(e: RoutingEvidence, material: RoutingMaterial): boolean {
  return basisOf(e, material) !== null;
}

/** the judge's JSON out of its text (a code fence or a lead-in around it is allowed); null when it has none */
export function parseRouterOutput(text: string): RouterVerdict[] | null {
  const unfenced = text.trim().replace(/^```[\w-]*\n([\s\S]*?)\n```$/, "$1");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = raw && typeof raw === "object" ? (raw as { answers?: unknown }).answers : undefined;
  if (!Array.isArray(list)) return null;
  const out: RouterVerdict[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    if (typeof r.question_id !== "string" || (r.decider !== "self" && r.decider !== "human")) return null;
    if (typeof r.kind !== "string" || !(ROUTING_KINDS as readonly string[]).includes(r.kind)) return null;
    // a self verdict is the one that answers: its option and its evidence must be whole, and one that is not makes the
    // whole output no judgement of the batch, so no verdict of it answers. A human row may leave them out.
    if (r.decider === "self" && (typeof r.option_index !== "number" || !Array.isArray(r.evidence) || !r.evidence.length)) return null;
    if (r.evidence !== undefined && !Array.isArray(r.evidence)) return null;
    if (r.option_index !== undefined && typeof r.option_index !== "number") return null;
    if (r.reason !== undefined && typeof r.reason !== "string") return null;
    const evidence: RoutingEvidence[] = [];
    for (const e of (r.evidence as unknown[] | undefined) ?? []) {
      if (!e || typeof e !== "object") return null;
      const x = e as Record<string, unknown>;
      if (typeof x.source !== "string" || !(EVIDENCE_SOURCES as readonly string[]).includes(x.source) || typeof x.quote !== "string") return null;
      if (x.ref !== undefined && typeof x.ref !== "string") return null;
      evidence.push({ source: x.source as RoutingEvidence["source"], ref: typeof x.ref === "string" ? x.ref.trim() : "", quote: x.quote });
    }
    out.push({
      questionId: r.question_id,
      decider: r.decider,
      kind: r.kind as RoutingKind,
      ...(typeof r.option_index === "number" ? { optionIndex: r.option_index } : {}),
      reason: typeof r.reason === "string" ? r.reason.trim() : "",
      evidence,
    });
  }
  return out;
}

export type RoutingOutcome =
  | { questionId: string; answer: RoutedAnswer }
  | { questionId: string; person: string };

/**
 * What becomes of each question of the batch. The mechanism answers only a question the judge took (`self`) and named
 * `settled`, with an option the question has and quotes the engine found in the material; every other case is a
 * question for a person, with the reason. A verdict the judge did not give, or one that cannot be read, is a person's.
 */
export function judgeRouting(
  verdicts: RouterVerdict[] | null,
  batch: PendingQuestionBatch,
  material: RoutingMaterial,
  by: { role: string; model: string },
): RoutingOutcome[] {
  // an output that is not exactly one verdict per question of the batch is no judgement of this batch: no part of it answers
  const ids = new Set(batch.questions.map((q) => q.question_id));
  const given = verdicts?.map((v) => v.questionId) ?? [];
  const exact = given.length === ids.size && new Set(given).size === given.length && given.every((id) => ids.has(id));
  return batch.questions.map((q): RoutingOutcome => {
    const person = (why: string): RoutingOutcome => ({ questionId: q.question_id, person: why });
    if (!verdicts) return person("判定役の出力を読めなかった");
    if (!exact) return person("判定役の出力が batch の質問と 1 つずつ対応していない（欠け・重複・余分がある）");
    const v = verdicts.find((x) => x.questionId === q.question_id)!;
    if (v.decider === "human") return person(v.reason || "判定役が人に回した");
    if (v.kind !== "settled") return person("人が決める種類の判断なので人が決める");
    const option = q.options.find((o) => o.index === v.optionIndex);
    if (!option) return person("選んだ選択肢が質問にない");
    if (!v.evidence.length) return person("根拠が無い");
    const basis: PendingAnswerBasis[] = [];
    for (const e of v.evidence) {
      const found = basisOf(e, material);
      if (!found) return person(`引用を確かめられなかった（${e.source}: ${e.ref || "Issue"}）`);
      basis.push(found);
    }
    return {
      questionId: q.question_id,
      answer: {
        questionId: q.question_id,
        selection: { index: option.index, label: option.label },
        by,
        basis,
        reason: v.reason || "記録で答えが決まる",
      },
    };
  });
}

export type { RoutedDecision } from "../ledger/routed-answers.ts";

/**
 * The questions of a lane (or of one batch) the mechanism answered. A column that cannot be read is no empty answer: it
 * throws, so a caller that wants to show "not confirmed" reads `readRoutedDecisions` and gets the columns by name.
 */
export function routedDecisions(iddId: string, batchId?: string): RoutedDecision[] {
  const read = readRoutedDecisions(iddId, batchId);
  if (read.unreadable.length) throw new Error(`仕組みの答えの記録を読めません: ${read.unreadable.join("・")}`);
  return read.decisions;
}

const inflight = new Set<Promise<unknown>>();
/** the batches (`<idd>/<batch>`) handed to the judge whose result is not yet written: a resend of one is not run twice */
const pending = new Set<string>();
/** the batches whose result is being written now: the tick's re-close leaves them to the write */
const committing = new Set<string>();
/**
 * The tick's re-close running now, if any, and when it began. The tick does not wait for it, so a pass that outlasts
 * the tick (each batch may wait for the gate) would otherwise meet the next tick's pass, and the passes piling up fight
 * each other for the gate. It is kept apart from `inflight`, which also holds the judge's runs; the pass is in both.
 */
let reclosing: { startedAt: number } | null = null;
/**
 * A re-close was asked for while one ran. The calls are not dropped but folded into one pass after it: a batch the
 * running pass left to a write of its result (`committing`) may need its close finished, and the next timer's tick is
 * far off.
 */
let recloseAgain = false;
/** the running pass was already said to be long, so it is said once */
let recloseLongSaid = false;

/** how long a re-close may run before a call that meets it says so: it holds every later one back while it runs */
export const RECLOSE_LONG_MS = 10 * 60 * 1000;

/**
 * The routings started and not yet finished (the tests wait on them; nothing in the engine does). A re-close that
 * ends with a call left for it starts the next pass before it settles, so the set is read again until it is empty.
 */
export async function settleQuestionRouting(): Promise<unknown> {
  let settled: unknown = [];
  while (inflight.size) settled = await Promise.allSettled([...inflight]);
  return settled;
}

const allToPerson = (batch: PendingQuestionBatch, why: string): RoutingOutcome[] =>
  batch.questions.map((q) => ({ questionId: q.question_id, person: why }));

/**
 * Write what the judge decided, in one go: the answers the mechanism gives, then the batch's questions, then the close
 * when every question was answered. A lane that has ended or has no record gets nothing written, and a lane given its
 * GO while the judge read gets the whole batch as a person's. Nothing of the batch was on record before this, so no
 * reading has shown the planner's questions as waiting for the judge.
 */
async function commitRouted(batch: PendingQuestionBatch, outcomes: RoutingOutcome[]): Promise<void> {
  const key = `${batch.idd_id}/${batch.batch_id}`;
  committing.add(key);
  try {
    // the lane's state is read and the result written in one hold of the gate. The judge has already finished, so
    // nothing in here waits on it; a read made before the gate would let the lane be closed between the two.
    const done = await withLaneGate(async () => {
      const lifecycle = readLifecycle();
      if (!readBacklog().some((b) => b.idd_id === batch.idd_id) || closedLanes(lifecycle).has(batch.idd_id)) return null;
      const answers: RoutedAnswer[] = inPlanning(batch.idd_id, lifecycle) ? outcomes.flatMap((o) => ("answer" in o ? [o.answer] : [])) : [];
      return recordRoutedBatch(batch, answers);
    });
    if (done?.written.length) {
      try { getAgentRunner()?.kickTick?.(); } catch { /* the next timer's tick delivers it */ }
    }
  } finally {
    committing.delete(key);
  }
}

function recordCost(batch: PendingQuestionBatch, reply: RouteReply): void {
  try { recordRoutingCost(routingCostRow(batch, reply)); } catch (err) { console.warn(`[routing] 判定役の費用を書けませんでした: ${String(err).slice(0, 300)}`); }
}

/**
 * Whether the judge holds a batch of this lane whose result is not yet written. The answer is read from the hold file
 * and not from this process's set, so it holds across processes and after a restart. An automatic GO reads this so it
 * does not pass the lane as one with no question; the GO's write side reads the same hold (`goBlockedReason`).
 */
export function routingInFlight(iddId: string): boolean {
  return heldBatches(iddId).length > 0;
}

/** the judge reads the batch; whatever goes wrong, every question is a person's. The result is written by `commitRouted` */
async function routeAsked(batch: PendingQuestionBatch): Promise<void> {
  const runner = getAgentRunner();
  let outcomes: RoutingOutcome[];
  try {
    const material = buildRoutingMaterial(batch.idd_id, batch);
    if (!material || !runner?.routeQuestions) {
      outcomes = allToPerson(batch, "材料を作れなかった");
    } else {
      const reply = await runner.routeQuestions({ lane: batch.idd_id, batch, material });
      // what the run used is the lane's cost whether or not its result is written
      recordCost(batch, reply);
      outcomes = judgeRouting(parseRouterOutput(reply.text), batch, material, { role: reply.role, model: reply.model });
    }
  } catch (err) {
    // a run that failed after spending (time out, non-zero exit) still costs the lane what it used
    if (err instanceof RouteFailed && err.partial) recordCost(batch, err.partial);
    console.warn(`[routing] 質問の振り分けに失敗しました: ${batch.idd_id}/${batch.batch_id}: ${String(err).slice(0, 300)}`);
    outcomes = allToPerson(batch, "振り分けに失敗した");
  }
  await commitRouted(batch, outcomes);
}

/**
 * The planner's ask, before anything of it is on record. A batch the mechanism may answer (the judge is on, the lane is
 * before its GO, its worktree is there) is kept here and handed to the judge in the background; the caller answers the
 * planner at once and writes nothing, and the result is written whole when the judge is done: its time is the role's
 * own budget, and a judge that fails, runs out of time or gives a text off the shape writes the whole batch as a
 * person's. Returns whether the batch was taken; false means the caller writes it as it is. A batch the ledger already
 * holds, and a resend of one being judged, are not run twice. Throws `AnswerColumnUnreadable` when either column
 * cannot be read: whether the ledger holds the batch is not known, and the caller writes nothing.
 */
export async function routeOnAsk(batch: PendingQuestionBatch): Promise<boolean> {
  const key = `${batch.idd_id}/${batch.batch_id}`;
  if (pending.has(key)) return true;
  // either column unreadable: whether the ledger holds the batch, or an answer to it, is not known. A hold made now would
  // tell the planner its questions were taken while the write after the judge needs both columns, and nothing would land
  requireReadableAnswerColumns();
  if (readQuestionBatch(batch.idd_id, batch.batch_id)) return false;
  const runner = getAgentRunner();
  let on: unknown = null;
  try { on = runner?.questionRouting?.() ?? null; } catch { on = null; }
  if (!on || !runner?.routeQuestions) return false;
  // a resend while the hold is being made is not run twice
  pending.add(key);
  let held = false;
  try {
    // an automatic resume of this lane that is already being delivered is let finish and be recorded first, so a short
    // one does not send the batch to a person. One that outlasts the wait is not waited for further (C-263-1)
    await settledResume(batch.idd_id, laneGateWaitMs());
    // the hold is the one durable mark of this batch until its result is written: without it a process that dies in the
    // judge's run loses the questions the planner was just told were taken, and a GO could pass over them. It is made in
    // the same gate as a GO's check and write, so a GO either sees the hold and is refused, or is on record first and
    // the lane is no longer before its GO here. The gate holds only this check and the append; the judge runs outside.
    held = await withLaneGate(async () => {
      if (!inPlanning(batch.idd_id) || !planningWorktree(batch.idd_id)) return false;
      // a resume still under way here (it began after the wait, or outlasted it) would deliver after the hold and wake
      // the planner while the judge holds its questions: no hold is made, and the caller writes the batch as a person's.
      // There is no await from this check to the hold, as the resume has none from its check of the hold to its mark (C-263-1)
      if (resumeUnderWay(batch.idd_id)) return false;
      // a column that broke while this waited: no hold is made (it falls to the caller's write, which reports the column)
      requireReadableAnswerColumns();
      holdBatch(batch);
      return true;
    });
  } catch (err) {
    console.warn(`[routing] 振り分けの保留を書けませんでした: ${key}: ${String(err).slice(0, 300)}`);
  }
  if (!held) {
    pending.delete(key);
    return false;
  }
  const job: Promise<unknown> = routeAsked(batch)
    .catch(async (err) => {
      // the write itself failed: the questions must not be lost, so they go on record as they were asked
      console.warn(`[routing] 振り分けの結果を書けませんでした: ${key}: ${String(err).slice(0, 300)}`);
      // (a lane that has closed since is not written to: the check and the write are one hold of the gate)
      await withLaneGate(async () => {
        if (readQuestionBatch(batch.idd_id, batch.batch_id) || closedLanes(readLifecycle()).has(batch.idd_id)) return;
        await recordAskedBatch(batch);
      }).catch(() => undefined);
    })
    .finally(() => {
      pending.delete(key);
      inflight.delete(job);
    });
  inflight.add(job);
  return true;
}

/**
 * The tick's stage: a batch whose answers are all on record but whose close did not land is closed again, and a batch
 * the judge held whose process is gone is written as a person's (its judge, or the engine that ran it, died before the
 * result). It starts nothing for the judge and does not wait; a batch whose result is being written now, or whose judge
 * is running in this process, is left to that run. One pass runs at a time: the calls that come while it runs are
 * folded into one pass started when it ends.
 */
export function finishQuestionBatches(): void {
  if (reclosing) {
    recloseAgain = true;
    if (!recloseLongSaid && Date.now() - reclosing.startedAt > RECLOSE_LONG_MS) {
      recloseLongSaid = true;
      console.warn(`[tick] 質問の batch の閉じ直しが ${Math.round(RECLOSE_LONG_MS / 60_000)} 分を超えて終わっていません。終わるまで次の閉じ直しは始まりません`);
    }
    return;
  }
  startReclose();
}

function startReclose(): void {
  recloseAgain = false;
  recloseLongSaid = false;
  reclosing = { startedAt: Date.now() };
  const p: Promise<unknown> = recoverHeldBatches()
    .then(() => finishAnsweredBatches(committing))
    .catch((err) => console.warn(`[tick] 答えの付いた batch を閉じ直せませんでした: ${String(err).slice(0, 300)}`))
    .finally(() => {
      inflight.delete(p);
      reclosing = null;
      // started before this pass settles, so a wait on `inflight` meets the next one
      if (recloseAgain) startReclose();
    });
  inflight.add(p);
}

/** write a held batch no run of this process is judging as a person's: answers it already has stay, none is added */
async function recoverHeldBatches(): Promise<void> {
  // a held batch is not known to have landed or not while a column cannot be read, and writing it again would double its
  // row: the holds stay as they are and the pass that finds the columns readable recovers them
  if (!heldBatches().length || unreadableAnswerColumns().length) return;
  for (const batch of heldBatches()) {
    const key = `${batch.idd_id}/${batch.batch_id}`;
    if (pending.has(key) || committing.has(key)) continue;
    committing.add(key);
    try {
      await recordRoutedBatch(batch, []);
    } catch (err) {
      console.warn(`[tick] 振り分け中に止まった batch を書き戻せませんでした: ${key}: ${String(err).slice(0, 300)}`);
    } finally {
      committing.delete(key);
    }
  }
}
