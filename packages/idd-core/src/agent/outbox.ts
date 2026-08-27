// intent: DEC-606 — 記録と送信を分けたままにする。ここは「積まれたものを送る」側だけを持つ
// intent: DEC-659 — 送る手段は runtime 側の port に委ね、engine は未達の管理だけを行う

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { stateDir } from "../paths.ts";
import { readSessions } from "../ledger/read.ts";
import { getAgentRunner } from "./port.ts";

export interface OutboxRecord {
  envelope_id: string;
  idd_id: string;
  type: string;
  queued_at: string;
  delivered_at: string | null;
  session_id?: string;
  error?: string;
}

function outboxPath(): string {
  return join(stateDir(), "outbox.jsonl");
}

function readOutbox(): OutboxRecord[] {
  const path = outboxPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
    .flatMap((l) => {
      try { return [JSON.parse(l) as OutboxRecord]; } catch { return []; }
    });
}

export function pendingEnvelopes(): OutboxRecord[] {
  const latest = new Map<string, OutboxRecord>();
  for (const rec of readOutbox()) latest.set(rec.envelope_id, { ...latest.get(rec.envelope_id), ...rec });
  return [...latest.values()].filter((rec) => !rec.delivered_at)
    .sort((a, b) => a.queued_at.localeCompare(b.queued_at));
}

export interface UndeliveredCount {
  total: number;
  failed: number;
}

// intent: DEC-665 — 母数は delivered_at null 全件、error 付きは失敗分として別に数える
// intent-invariant: INV-009 — 件数は pendingEnvelopes() の単一実装から導き、呼び出し側で outbox.jsonl を再解釈しない
export function countUndelivered(iddId?: string): UndeliveredCount {
  const recs = pendingEnvelopes().filter((rec) => !iddId || rec.idd_id === iddId);
  return { total: recs.length, failed: recs.filter((rec) => rec.error).length };
}

async function patch(envelopeId: string, fields: Partial<OutboxRecord>): Promise<void> {
  const path = outboxPath();
  if (!existsSync(path)) return;
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 40 } });
  try {
    const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const next = lines.map((line) => {
      try {
        const rec = JSON.parse(line) as OutboxRecord;
        return rec.envelope_id === envelopeId ? JSON.stringify({ ...rec, ...fields }) : line;
      } catch {
        return line;
      }
    });
    writeFileSync(path, `${next.join("\n")}\n`, "utf8");
  } finally {
    await release();
  }
}

function envelopeBody(envelopeId: string): string | null {
  const path = join(stateDir(), "outbox", `${envelopeId}.xml`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// intent: DEC-659 — 宛先は lane の session 記録から引く (executor が居ればそちら)
export function sessionFor(iddId: string): { sessionId: string; cwd?: string } | null {
  const executor = readSessions("executor").filter((r) => r.idd_id === iddId).pop();
  if (executor?.executor_session_id) return { sessionId: executor.executor_session_id, cwd: executor.worktree_path };
  const planner = readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  if (planner?.planner_session_id) return { sessionId: planner.planner_session_id, cwd: planner.worktree_path };
  return null;
}

export interface DeliverResult {
  delivered: string[];
  skipped: { envelopeId: string; reason: string }[];
}

export async function deliverPending(): Promise<DeliverResult> {
  const runner = getAgentRunner();
  const result: DeliverResult = { delivered: [], skipped: [] };
  if (!runner) {
    for (const rec of pendingEnvelopes()) result.skipped.push({ envelopeId: rec.envelope_id, reason: "no runner" });
    return result;
  }

  for (const rec of pendingEnvelopes()) {
    const target = rec.session_id ? { sessionId: rec.session_id, cwd: sessionFor(rec.idd_id)?.cwd } : sessionFor(rec.idd_id);
    if (!target) {
      result.skipped.push({ envelopeId: rec.envelope_id, reason: "no session for lane" });
      continue;
    }
    const body = envelopeBody(rec.envelope_id);
    if (!body) {
      result.skipped.push({ envelopeId: rec.envelope_id, reason: "envelope body missing" });
      continue;
    }
    try {
      await runner.deliver(target.sessionId, body, { cwd: target.cwd });
      await patch(rec.envelope_id, { delivered_at: new Date().toISOString(), session_id: target.sessionId });
      result.delivered.push(rec.envelope_id);
    } catch (err) {
      await patch(rec.envelope_id, { error: String(err) });
      result.skipped.push({ envelopeId: rec.envelope_id, reason: String(err) });
    }
  }
  return result;
}
