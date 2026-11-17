/**
 * The ledger of what was put into a run or a conversation: one line per instruction per delivery, appended and never
 * rewritten. A line keeps the instruction's text and scope as they were then, so a later edit of the instruction
 * does not change what was read to be delivered; it names where it went (a lane's stage, or a conversation's
 * session) and when. The caller writes it once the run has really started, never for a brief that was only built.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../paths.ts";
import type { Picked } from "./store.ts";
import { warnOnce } from "./store.ts";
import type { Scene, Scope } from "./scope.ts";

export const LEDGER_FILE = "instruction-ledger.jsonl";

/** The state the ledger lives in: the same one `stateDir()` answers, so the ledger and the outbox of one call never part. */
export function ledgerStateDir(): string {
  return stateDir();
}

export function ledgerPath(): string {
  return join(ledgerStateDir(), LEDGER_FILE);
}

/** where a delivery went */
export type LedgerTarget =
  | { kind: "lane"; stage: string; scene: Scene; /** the Issue lane the run belongs to, when it has one */ lane?: string; /** the run's own id, when the harness gave one */ run?: string }
  /** a one-shot writer (a PR text, a commit message, a reply): it has no run of its own, so it names the lane it wrote for */
  | { kind: "writer"; stage: string; scene: Scene; /** the lane the draft is for, when the caller has one */ lane?: string; /** the repo the draft is for */ repo?: string }
  | { kind: "conversation"; session: string; scene: Scene };

export interface LedgerEntry {
  at: string;
  instruction: string;
  text: string;
  reason: string;
  scope: Scope;
  via: "scope" | "session";
  to: LedgerTarget;
}

/**
 * Append one line per picked instruction. It never throws: a ledger that cannot be written is said once and the run
 * goes on, because the instruction was already delivered and the run must not fail for the record of it.
 */
export function recordInjection(picked: readonly Picked[], to: LedgerTarget, now: Date = new Date()): void {
  if (!picked.length) return;
  const at = now.toISOString();
  const lines = picked.map((p) => JSON.stringify({ at, instruction: p.id, text: p.text, reason: p.reason, scope: p.scope, via: p.via, to } satisfies LedgerEntry));
  try {
    const path = ledgerPath();
    mkdirSync(ledgerStateDir(), { recursive: true });
    appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
  } catch (err) {
    warnOnce(`ledger:${String(err)}`, `台帳に追記できませんでした: ${String(err)}`);
  }
}

export interface LedgerFilter {
  lane?: string;
  session?: string;
  instruction?: string;
  stage?: string;
  /** the newest N entries that match */
  limit?: number;
}

/** read the ledger in the order it was written; a line that is not an entry is skipped */
export function readLedger(filter: LedgerFilter = {}): LedgerEntry[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(line) as LedgerEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry.instruction !== "string" || !entry.to || typeof entry.to !== "object") continue;
    if (filter.instruction && entry.instruction !== filter.instruction) continue;
    if (filter.lane && !((entry.to.kind === "lane" || entry.to.kind === "writer") && entry.to.lane === filter.lane)) continue;
    if (filter.session && !(entry.to.kind === "conversation" && entry.to.session === filter.session)) continue;
    if (filter.stage && !((entry.to.kind === "lane" || entry.to.kind === "writer") && entry.to.stage === filter.stage)) continue;
    out.push(entry);
  }
  // 0 is "no entries"; only a limit that was not given reads all of them
  return filter.limit !== undefined && filter.limit >= 0 ? out.slice(Math.max(0, out.length - filter.limit)) : out;
}

/** one entry as a line a person reads */
export function formatLedgerEntry(e: LedgerEntry): string {
  const where = e.to.kind === "conversation"
    ? `会話 ${e.to.session}`
    : e.to.lane
      ? `lane ${e.to.lane} の ${e.to.stage}`
      : `${e.to.stage}${e.to.kind === "writer" && e.to.repo ? `（${e.to.repo}）` : ""}`;
  return `${e.at} ${e.instruction} → ${where}（${e.via === "session" ? "session の追加" : "範囲の照合"}）: ${e.text}（理由: ${e.reason}）`;
}
