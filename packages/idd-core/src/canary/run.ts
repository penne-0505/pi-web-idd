import { getAgentRunner, type AgentRunner, type CanaryRunAnswer, type CanaryRole } from "../agent/port.ts";
import { jstDay } from "../time.ts";
import {
  CANARY_OUTPUT_CHARS, canaryRecordPath, readCanaryRecord, writeCanaryRecord,
  type CanaryRoleRecord, type CanaryTaskRecord, type CanaryTokens,
} from "./record.ts";
import { canaryPrompt, canaryTasks, structureOf, type CanaryTask } from "./tasks.ts";

/**
 * The canary's stage: one pass asks a few of the pipeline's pi roles their day's questions, writes a record as each
 * role finishes, and returns inside a wall limit even when a model never answers. It moves no lane, so a failure here
 * is kept to this stage: the tick's other stages see nothing from it.
 *
 * A role is asked once a day. Its record is the mark of that: while the day's record holds every answer, no later
 * pass asks it again. A record with answers still missing is marked partial, and the day's later tries ask only what
 * is missing, at most `CANARY_MAX_ATTEMPTS` times. A pass that reaches its limit before a role starts leaves the role
 * for the next pass, so the day fills up over a few ticks instead of holding the lane lock for all of it.
 *
 * The day's tries are counted even when no record can be written: the count is kept in this engine as well as in the
 * record, so a disk that fills, a folder that turns into a file, or a record a run cannot replace still stops asking
 * after `CANARY_MAX_ATTEMPTS` tries and lets the day's other roles have their turn. The count is not a second place a
 * day's record lives: the record stays the one file under the day, and an engine that restarts counts the day's tries
 * again from the record it can read.
 *
 * The limit belongs to the tick, not to a pass: a caller hands every pass the same deadline, so a tick that runs
 * several passes after its first still gives the canary one wall.
 */

/** how long one tick's canary may take, however many passes that tick runs */
export const CANARY_PASS_MS = 60_000;
/** how long one question may take */
export const CANARY_RUN_MS = 60_000;
/** how many roles one pass asks */
export const CANARY_ROLES_PER_PASS = 2;
/** how many times a role whose answers did not come back is tried in its day */
export const CANARY_MAX_ATTEMPTS = 3;

export interface CanaryPassOptions {
  /** the instant the pass is read at (the JST day); now by default */
  now?: number;
  /** the wall one pass makes for itself, used when the caller hands no deadline */
  passMs?: number;
  runMs?: number;
  rolesPerPass?: number;
  /**
   * the instant the canary must end: a tick makes one for all of its passes and hands the same value to each, so the
   * tick's canary never runs a second wall. Left out, the pass makes its own from `passMs`.
   */
  deadline?: number;
  /** the runner to ask; the registered one by default (null: there is none) */
  runner?: AgentRunner | null;
}

export interface CanaryPassResult {
  /** the roles whose record this pass wrote */
  ran: string[];
  /** the roles this pass wrote a record after a failure: the model did not answer, or the record could not be written */
  failed: string[];
  /** the roles left for a later pass (the limit, the number a pass asks, or a record this pass could not write) */
  skipped: string[];
  errors: { role: string; error: string }[];
  /** why nothing ran, when nothing could be asked at all */
  reason?: string;
}

const EMPTY_TOKENS: CanaryTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * The tries this engine has counted today, by the record path the try belongs to. A record that cannot be written
 * leaves nothing to count from, so the count lives here as well; it is not a second record, only how far the day got.
 */
const triesToday = new Map<string, { day: string; attempts: number }>();

/** keep only today's counts: a day's tries are its own, and yesterday's are read from the records that were written */
function keepToday(day: string): void {
  for (const [path, held] of triesToday) {
    if (held.day !== day) triesToday.delete(path);
  }
}

/** the tries this role and model have had today: the day's record and this engine's own count, whichever is further */
function attemptsToday(day: string, role: string, model: string): number {
  keepToday(day);
  const held = triesToday.get(canaryRecordPath(day, role, model));
  const counted = held?.day === day ? held.attempts : 0;
  const onDisk = Number(readCanaryRecord(day, role, model)?.attempts ?? 0) || 0;
  return Math.max(counted, onDisk);
}

/**
 * Count this try before the role is asked. The count is written here first, so a record that cannot be written still
 * bounds the day's tries; on a written record the count and the record agree.
 */
function bumpedAttempts(day: string, role: string, model: string, fromDisk: number): number {
  const next = Math.max(attemptsToday(day, role, model), fromDisk) + 1;
  triesToday.set(canaryRecordPath(day, role, model), { day, attempts: next });
  return next;
}

function tokensOf(answer: CanaryRunAnswer): CanaryTokens {
  const t = answer.tokens ?? {};
  return {
    input: Number(t.input ?? 0) || 0,
    output: Number(t.output ?? 0) || 0,
    cacheRead: Number(t.cacheRead ?? 0) || 0,
    cacheWrite: Number(t.cacheWrite ?? 0) || 0,
  };
}

/** a question that was not asked: the record says so instead of judging a shape that was never written */
function notAsked(task: CanaryTask, error: string): CanaryTaskRecord {
  return {
    id: task.id,
    kind: task.kind,
    structure: "none",
    output: "",
    chars: 0,
    total_ms: 0,
    usd: 0,
    tokens: { ...EMPTY_TOKENS },
    error,
  };
}

/**
 * A promise with a wall limit. The timer is cleared either way, and a promise that never settles is left behind
 * rather than waited on: the pass has to end even when the thing it asked does not.
 */
function withLimit<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | { timedOut: true }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, Math.max(1, ms));
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ value });
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function prepareRole(
  runner: AgentRunner,
  roleName: string,
  modelName: string | undefined,
  deadline: number,
  runMs: number,
): Promise<string | null> {
  if (!runner.canaryPrepare) return null;
  // the preparation waits inside what is left of the tick's wall, and never past it
  const budget = Math.max(1, Math.min(runMs, deadline - Date.now()));
  try {
    const ready = await withLimit(runner.canaryPrepare({ role: roleName, ...(modelName ? { modelName } : {}) }), budget);
    return "timedOut" in ready ? "この tick の時間の上限で、用意が終わりませんでした" : null;
  } catch (err) {
    return String(err instanceof Error ? err.message : err).slice(0, 400);
  }
}

/**
 * The roles the day still wants, in a stable order: a role with no record, and a role whose answers did not all come
 * back, while the day has tries left for it. A role whose tries ran out counts as done even when no record was ever
 * written, so a day that cannot be recorded moves on to its other roles instead of asking the first ones forever.
 */
function pendingRoles(roles: readonly CanaryRole[], day: string): CanaryRole[] {
  const seen = new Set<string>();
  const pending: CanaryRole[] = [];
  for (const role of [...roles].sort((a, b) => a.role.localeCompare(b.role) || modelKeyOf(a).localeCompare(modelKeyOf(b)))) {
    const model = modelKeyOf(role);
    const key = `${role.role}\u0000${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const record = readCanaryRecord(day, role.role, model);
    if (record && !record.partial) continue;
    if (attemptsToday(day, role.role, model) >= CANARY_MAX_ATTEMPTS) continue;
    pending.push(role);
  }
  return pending;
}

/** the record's key for a role: the model definition's name, or the call target when there is no definition */
function modelKeyOf(role: CanaryRole): string {
  return role.modelName ?? role.model;
}

/** the answers the day already has: a retry asks only the questions still missing and keeps what came back */
function answeredOf(previous: CanaryRoleRecord | null): Map<string, CanaryTaskRecord> {
  const kept = new Map<string, CanaryTaskRecord>();
  for (const task of previous?.tasks ?? []) {
    if (task.error === undefined) kept.set(task.id, task);
  }
  return kept;
}

/**
 * One role's day: its dir readied once, then every question still missing. The preparation is not part of a
 * question's `total_ms`; it waits inside what is left of the tick's wall, and a role whose dir cannot be readied
 * keeps the answers it already had and records the rest as not asked.
 */
async function askRole(
  runner: AgentRunner,
  role: CanaryRole,
  deadline: number,
  runMs: number,
  kept: ReadonlyMap<string, CanaryTaskRecord>,
  readied: boolean,
): Promise<{ tasks: CanaryTaskRecord[]; prepared: boolean }> {
  let prepared = readied;
  if (!prepared && runner.canaryPrepare) {
    const unprepared = await prepareRole(runner, role.role, role.modelName, deadline, runMs);
    if (unprepared !== null) {
      return {
        prepared: false,
        tasks: canaryTasks().map((task) => kept.get(task.id) ?? notAsked(task, `role の agent dir を用意できませんでした: ${unprepared}`)),
      };
    }
    prepared = true;
  }
  const tasks: CanaryTaskRecord[] = [];
  for (const task of canaryTasks()) {
    const answered = kept.get(task.id);
    if (answered) {
      tasks.push(answered);
      continue;
    }
    const now = Date.now();
    if (now >= deadline) {
      tasks.push(notAsked(task, "この tick の時間の上限で、回していません"));
      continue;
    }
    // the question's own limit, and what is left of the tick's wall, whichever ends first
    const budget = Math.max(1, Math.min(runMs, deadline - now));
    const started = Date.now();
    try {
      const answer = await withLimit(
        runner.canaryRun!({
          role: role.role,
          model: role.model,
          ...(role.modelName ? { modelName: role.modelName } : {}),
          thinking: role.thinking,
          task: { id: task.id, kind: task.kind, prompt: canaryPrompt(task) },
          timeoutMs: budget,
        }),
        Math.min(budget + 2_000, Math.max(1, deadline - started)),
      );
      const total_ms = Date.now() - started;
      if ("timedOut" in answer) {
        tasks.push({ ...notAsked(task, "時間の上限までに応答がありませんでした"), total_ms });
        continue;
      }
      const text = typeof answer.value.text === "string" ? answer.value.text : "";
      const shape = structureOf(task, text);
      tasks.push({
        id: task.id,
        kind: task.kind,
        structure: shape.verdict,
        ...(shape.detail ? { structure_detail: shape.detail } : {}),
        output: text.length > CANARY_OUTPUT_CHARS ? text.slice(0, CANARY_OUTPUT_CHARS) : text,
        chars: text.length,
        total_ms,
        usd: Number(answer.value.usd ?? 0) || 0,
        tokens: tokensOf(answer.value),
      });
    } catch (err) {
      tasks.push({ ...notAsked(task, String(err instanceof Error ? err.message : err).slice(0, 400)), total_ms: Date.now() - started });
    }
  }
  return { tasks, prepared };
}

/**
 * One pass of the canary. Never throws: a role it could not ask, a record it could not write, and a runtime that
 * cannot name its roles all come back in the result, so the caller's other stages run as they would have.
 */
export async function runCanary(opts: CanaryPassOptions = {}): Promise<CanaryPassResult> {
  const result: CanaryPassResult = { ran: [], failed: [], skipped: [], errors: [] };
  try {
    const now = opts.now ?? Date.now();
    const runMs = Math.max(1_000, opts.runMs ?? CANARY_RUN_MS);
    const perPass = Math.max(1, opts.rolesPerPass ?? CANARY_ROLES_PER_PASS);
    // a tick hands every pass the deadline it made once; a caller on its own gets a wall of its own
    const passMs = Math.max(1_000, opts.passMs ?? CANARY_PASS_MS);
    const deadline = opts.deadline ?? Date.now() + passMs;
    const day = jstDay(now);
    if (!day) {
      result.reason = "今日の日付を読めませんでした";
      return result;
    }
    const runner = opts.runner === undefined ? getAgentRunner() : opts.runner;
    if (!runner?.canaryRoles || !runner.canaryRun) {
      result.reason = "canary を回す runner がありません";
      return result;
    }
    let roles: CanaryRole[];
    try {
      roles = runner.canaryRoles();
    } catch (err) {
      result.errors.push({ role: "", error: String(err instanceof Error ? err.message : err).slice(0, 400) });
      result.reason = "role の一覧を読めませんでした";
      return result;
    }
    const pending = pendingRoles(Array.isArray(roles) ? roles : [], day);
    if (!pending.length) {
      result.reason = "今日の role はすべて記録済みです";
      return result;
    }
    // the tick's wall is spent: ask nothing and leave every role to the next tick of the day
    if (Date.now() >= deadline) {
      result.skipped.push(...pending.map((role) => role.role));
      result.reason = "この tick の canary の時間の上限を使い切りました";
      return result;
    }
    let asked = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const role = pending[index];
      if (asked >= perPass || Date.now() >= deadline) {
        result.skipped.push(role.role);
        continue;
      }
      asked += 1;
      const previous = readCanaryRecord(day, role.role, modelKeyOf(role));
      // counted before the question: the try is spent even if the day's record cannot be written afterwards
      const attempts = bumpedAttempts(day, role.role, modelKeyOf(role), Number(previous?.attempts ?? 0) || 0);
      const { tasks, prepared } = await askRole(
        runner, role, deadline, runMs, answeredOf(previous), previous?.prepared === true,
      );
      const partial = tasks.some((t) => t.error !== undefined);
      const record: CanaryRoleRecord = {
        role: role.role,
        model: role.model,
        ...(role.modelName ? { model_name: role.modelName } : {}),
        thinking: role.thinking,
        day,
        at: new Date().toISOString(),
        attempts,
        ...(partial ? { partial: true } : {}),
        ...(prepared ? { prepared: true } : {}),
        tasks,
      };
      try {
        writeCanaryRecord(record);
      } catch (err) {
        const error = String(err instanceof Error ? err.message : err).slice(0, 400);
        result.failed.push(role.role);
        result.errors.push({ role: role.role, error: `記録を書けませんでした: ${error}` });
        // a record that cannot be written will not be written for the roles after this one either: stop asking in
        // this pass, so the failure costs no more questions than it already has, and let the next pass pick up there
        for (const left of pending.slice(index + 1)) result.skipped.push(left.role);
        break;
      }
      if (partial) result.failed.push(role.role);
      else result.ran.push(role.role);
    }
  } catch (err) {
    result.errors.push({ role: "", error: String(err instanceof Error ? err.message : err).slice(0, 400) });
  }
  return result;
}
