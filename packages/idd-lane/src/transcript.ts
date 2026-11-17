import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readClaudeStream, redactSecrets, type ClaudeStreamEntry } from "./claude-stream.ts";
import { conversationLockHeld, conversationTurns, messageType, type ConversationTurn } from "./conversation.ts";
import { laneDir, laneRunAlive, readLane, type LaneRecord } from "./runner.ts";

/*
 * A Claude Code lane read back as a conversation, from the lane's own record only: a conversation lane's
 * replies (turns.jsonl and turns/<n>.jsonl, the one being written last) and a short stage's single run
 * (events.jsonl). Claude Code's own config dir is never read.
 */

export interface TranscriptTurn {
  n: number;
  started_at: string;
  ended_at?: string;
  /** running: a supervisor is feeding this reply now; interrupted: one left it half done */
  status: ConversationTurn["status"] | "running" | "interrupted";
  /** what was sent: the envelope's type, and the one line of it a person wrote (an instruction, a reason) */
  sent: { type?: string; text: string };
  entries: ClaudeStreamEntry[];
  /** moves left out from the start of a long reply */
  omitted: number;
  /** this reply's API-equivalent cost */
  cost?: number;
  /** replies before this one reported no cost, so its cost may carry theirs */
  costCarried?: boolean;
  error?: string;
}

export interface TranscriptOptions {
  maxTurns?: number;
  maxEntries?: number;
  /** values to take out wherever they appear (the callback token) */
  secrets?: string[];
}

const MAX_TURNS = 30;
const MAX_ENTRIES = 80;
const SENT_MAX = 160;

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** the body of a message the lane was sent, from the place it is in now (a reader of the raw body uses this too, so the places are named once) */
export function messageText(dir: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return "";
  for (const d of ["sent", "inflight", "queue"]) {
    const p = join(dir, d, name);
    if (existsSync(p)) {
      try { return readFileSync(p, "utf8"); } catch { return ""; }
    }
  }
  return "";
}

/**
 * What was sent: the kind recorded at delivery (an old envelope's `<type>` for messages sent before the kind was
 * kept outside), and the one line a person wrote. A message with a recorded kind but no person's line shows no
 * text; an envelope with no recorded kind is still read for its `<type>`, never shown as raw XML.
 */
function sentOf(dir: string, laneId: string, name: string, secrets: string[]): TranscriptTurn["sent"] {
  const raw = messageText(dir, name);
  const flat = (s: string) => {
    const one = redactSecrets(s, secrets).replace(/\s+/g, " ").trim();
    return one.length > SENT_MAX ? `${one.slice(0, SENT_MAX - 1)}…` : one;
  };
  const recorded = messageType(laneId, name);
  const isEnvelope = raw.trimStart().startsWith("<propter-system-message") || raw.trimStart().startsWith("<idd-system-message");
  if (isEnvelope) {
    const type = recorded ?? raw.match(/<type>([^<]*)<\/type>/)?.[1]?.trim();
    // the words a person wrote; the older envelope's `description` is the message of EN-08's older form
    const note = raw.match(/<(instruction|message|user-note|situation|description|reason)>([\s\S]*?)<\/\1>/)?.[2] ?? "";
    return { ...(type ? { type } : {}), text: flat(unescapeXml(note)) };
  }
  return { ...(recorded ? { type: recorded } : {}), text: flat(raw) };
}

function lastEntries(path: string, read: { cwd?: string; secrets: string[] }, max: number): { entries: ClaudeStreamEntry[]; omitted: number } {
  const tail = readClaudeStream(path, { ...read, keep: max });
  return { entries: tail.entries, omitted: tail.total - tail.entries.length };
}

const cents = (n: number) => Number(n.toFixed(6));

/**
 * Each reply's own cost: --resume reports the conversation's total so far, so a reply's cost is the step. A
 * reply that reported nothing (it failed) leaves its spend in the next step, which is marked as carrying it.
 */
function turnCosts(turns: ConversationTurn[]): Map<number, { cost: number; carried: boolean }> {
  const out = new Map<number, { cost: number; carried: boolean }>();
  let prev = 0;
  let unreported = false;
  for (const t of turns) {
    const c = t.reported_cost;
    if (typeof c !== "number" || !Number.isFinite(c)) { unreported = true; continue; }
    out.set(t.n, { cost: cents(c >= prev ? c - prev : c), carried: unreported && c >= prev });
    prev = c;
    unreported = false;
  }
  return out;
}

function readInflight(dir: string): { n: number; message: string; started_at: string } | null {
  try {
    const r = JSON.parse(readFileSync(join(dir, "inflight.json"), "utf8")) as { n?: unknown; message?: unknown; started_at?: unknown };
    return typeof r.n === "number" && typeof r.message === "string" && typeof r.started_at === "string" ? { n: r.n, message: r.message, started_at: r.started_at } : null;
  } catch {
    return null;
  }
}

function laneOrNull(laneId: string): LaneRecord | null {
  try { return readLane(laneId); } catch { return null; }
}

/** a conversation lane's last replies, oldest first; the reply being written, if any, is the last */
export function conversationTranscript(laneId: string, opts: TranscriptOptions = {}): TranscriptTurn[] {
  const dir = laneDir(laneId);
  const rec = laneOrNull(laneId);
  const secrets = opts.secrets ?? [];
  const read = { cwd: rec?.worktree, secrets };
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const turns = conversationTurns(laneId);
  const costs = turnCosts(turns);
  const out: TranscriptTurn[] = turns.map((t) => ({
    n: t.n,
    started_at: t.started_at,
    ended_at: t.ended_at,
    status: t.status,
    sent: sentOf(dir, laneId, t.message, secrets),
    ...lastEntries(join(dir, "turns", `${t.n}.jsonl`), read, maxEntries),
    ...(costs.has(t.n) ? { cost: costs.get(t.n)!.cost, ...(costs.get(t.n)!.carried ? { costCarried: true } : {}) } : {}),
    ...(t.error ? { error: redactSecrets(t.error, secrets).slice(0, 300) } : {}),
  }));
  const inflight = readInflight(dir);
  if (inflight && !turns.some((t) => t.n === inflight.n)) {
    out.push({
      n: inflight.n,
      started_at: inflight.started_at,
      status: conversationLockHeld(laneId) ? "running" : "interrupted",
      sent: sentOf(dir, laneId, inflight.message, secrets),
      ...lastEntries(join(dir, "turns", `${inflight.n}.jsonl`), read, maxEntries),
    });
  }
  return out.slice(-(opts.maxTurns ?? MAX_TURNS));
}

/** a short stage's run (a blind review, a triage) as the one reply it is */
export function runTranscript(laneId: string, opts: TranscriptOptions = {}): TranscriptTurn | null {
  const rec = laneOrNull(laneId);
  if (!rec) return null;
  const secrets = opts.secrets ?? [];
  const cost = rec.usage?.cost;
  return {
    n: 1,
    started_at: rec.started_at ?? "",
    ...(rec.status !== "running" && rec.ended_at ? { ended_at: rec.ended_at } : {}),
    // a run whose supervisor died keeps "running" in its record; it is not running
    status: rec.status === "running" ? (laneRunAlive(rec) ? "running" : "interrupted") : rec.status === "idle" || !rec.status ? "done" : rec.status,
    sent: { text: redactSecrets(rec.title ?? rec.role ?? laneId, secrets) },
    ...lastEntries(join(laneDir(laneId), "events.jsonl"), { cwd: rec.worktree, secrets }, opts.maxEntries ?? MAX_ENTRIES),
    ...(typeof cost === "number" && Number.isFinite(cost) ? { cost: cents(cost) } : {}),
    ...(rec.error ? { error: redactSecrets(rec.error, secrets).slice(0, 300) } : {}),
  };
}
