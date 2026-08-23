// intent: DEC-005 — Meltly 側 sync-tools/state/ledger-<repo>.jsonl の read 層。1 行 1 event の append-only JSONL、malformed 行は Python 側 cmd_status と同じく silent skip

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type LaneState,
  type LifecycleEventRecord,
  foldLifecycleLedger,
  foldLifecycleLedgerFull,
  isLifecycleEvent,
} from "./lifecycle-schema";

export interface RepoLedger {
  repo: string;
  path: string;
  events: unknown[];
}

const LEDGER_PATTERN = /^ledger-([A-Za-z0-9_-]+)\.jsonl$/;

export async function listLedgerFiles(stateDir: string): Promise<Array<{ repo: string; path: string }>> {
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    return [];
  }
  const out: Array<{ repo: string; path: string }> = [];
  for (const name of entries) {
    const m = LEDGER_PATTERN.exec(name);
    if (m) out.push({ repo: m[1], path: join(stateDir, name) });
  }
  out.sort((a, b) => a.repo.localeCompare(b.repo));
  return out;
}

export async function readRepoLedger(path: string, repo: string): Promise<RepoLedger> {
  let text = "";
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return { repo, path, events: [] };
  }
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // intent: DEC-005 — malformed 行は Python 側 cmd_status と同じく silent skip (partial ledger でも読み進める)
      continue;
    }
  }
  return { repo, path, events };
}

export async function readAllLedgers(stateDir: string): Promise<RepoLedger[]> {
  const files = await listLedgerFiles(stateDir);
  return Promise.all(files.map(({ repo, path }) => readRepoLedger(path, repo)));
}

export interface LaneWithRepo extends LaneState {
  repo: string;
}

export async function readAllLanes(stateDir: string, opts: { includeRetired?: boolean } = {}): Promise<LaneWithRepo[]> {
  const ledgers = await readAllLedgers(stateDir);
  const fold = opts.includeRetired ? foldLifecycleLedgerFull : foldLifecycleLedger;
  const lanes: LaneWithRepo[] = [];
  for (const { repo, events } of ledgers) {
    const perRepo = fold(events);
    for (const lane of perRepo.values()) {
      lanes.push({ ...lane, repo });
    }
  }
  // intent: DEC-005 — 表示順は since (最終 event ts) の降順で active 優先、UI 側のデフォルト提示を揃える
  lanes.sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0));
  return lanes;
}

export function filterLifecycleEvents(events: readonly unknown[]): LifecycleEventRecord[] {
  const out: LifecycleEventRecord[] = [];
  for (const e of events) {
    if (isLifecycleEvent(e)) out.push(e);
  }
  return out;
}
