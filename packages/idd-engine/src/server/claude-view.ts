
import { laneRunIds } from "@idd/core";
import {
  CLAUDE_QUOTA_WINDOWS, conversationLane, conversationTranscript, knownSecrets, readClaudeQuota, readLane, readRoles, runTranscript,
} from "@idd/lane";
import type { LaneRecord, TranscriptTurn } from "@idd/lane";

import type { ClaudeQuotaView, ClaudeTranscriptView, CostView, TimelineEntry } from "../../../../lib/idd-ui/types.ts";
import { clockJst } from "./events-display";

/*
 * A Claude Code lane as the lane detail shows it, read from the lane's own record only (a conversation's
 * turns, a short stage's events), never from Claude Code's config dir. Its spend is the subscription's API
 * equivalent, shown apart from the budget, beside the windows' use.
 */

/** what the engine sent, in penne's words; a type not listed shows as it is */
const SENT_WORD: Record<string, string> = {
  s1_prep_start: "下調べの指示",
  s1_resume: "再開の指示",
  s1_revise: "直しの指示",
  s2_start: "実装の指示",
  s2_resume: "再開の指示",
  plan_review_findings: "計画の査読の指摘",
  review_fix: "レビューの指摘",
  question_batch_answered: "質問への回答",
  info_update: "追加の情報",
  priority_elevated: "最優先への変更",
  lane_deferred: "無視",
  lane_rejected: "差し戻し",
};

const STATUS_WORD: Record<TranscriptTurn["status"], string> = {
  running: "応答中",
  done: "済み",
  failed: "失敗",
  timeout: "時間切れ",
  stopped: "止めた",
  interrupted: "中断",
};

const RECENT = 5;
const usd = (n: number) => `$${n.toFixed(2)}`;

/** the callback token to hide, read without creating one (a detail is only read) */
function secrets(): string[] {
  try { return knownSecrets(); } catch { return []; }
}

function sentLabel(sent: TranscriptTurn["sent"]): string {
  const word = sent.type ? SENT_WORD[sent.type] ?? sent.type : "";
  if (word && sent.text) return `${word}「${sent.text}」`;
  return word || sent.text;
}

/**
 * A reply as a row of the course, its moves folded into one row under it (a single move stays inline). Each row
 * has a key of its own reply, so a poll that adds moves or drops old replies does not move what penne opened.
 */
function turnRows(t: TranscriptTurn, title: string, key: string): TimelineEntry[] {
  const warn = t.status === "failed" || t.status === "timeout" || t.status === "interrupted";
  const detail = [sentLabel(t.sent), STATUS_WORD[t.status], t.cost !== undefined ? `${usd(t.cost)}${t.costCarried ? "（前の応答の分を含む）" : ""}` : "", t.error ?? ""].filter(Boolean).join(" · ");
  const moves: TimelineEntry[] = [
    ...(t.omitted ? [{ time: "", title: `前の ${t.omitted} 件は省略`, kind: "agent" as const }] : []),
    ...t.entries.map((e) => ({
      time: "",
      title: e.kind === "tool" ? `${e.tool} ${e.body}`.trim() : e.body,
      kind: (e.kind === "error" ? "warn" : "agent") as TimelineEntry["kind"],
    })),
  ];
  const head: TimelineEntry = { key, time: clockJst(t.started_at), title, ...(detail ? { detail } : {}), kind: warn ? "warn" : "mark" };
  if (!moves.length) return [head];
  if (moves.length === 1) return [head, { ...moves[0], key: `${key}:moves` }];
  const lastMove = moves[moves.length - 1];
  return [head, { key: `${key}:moves`, time: "", title: lastMove.title, kind: "agent", folded: moves.length, items: moves }];
}

function view(label: string, turns: { turn: TranscriptTurn; title: string; key: string }[], live: boolean): ClaudeTranscriptView {
  // short stages run side by side: any of them running keeps the section running, the newest one gives the clock
  const writing = [...turns].reverse().find(({ turn }) => turn.status === "running")?.turn;
  return {
    label,
    running: live || Boolean(writing),
    ...(writing ? { runningSince: writing.started_at } : {}),
    timeline: turns.flatMap(({ turn, title, key }) => turnRows(turn, title, key)),
    // only a reply being written has current moves; a message still waiting for its supervisor has none yet
    recent: (writing?.entries ?? []).slice(-RECENT),
  };
}

/** a planner's or executor's conversation on Claude Code; null for a pi session */
export function conversationView(label: string, sessionId: string | undefined, live: Set<string>): ClaudeTranscriptView | null {
  if (!sessionId) return null;
  const laneId = conversationLane(sessionId);
  if (!laneId) return null;
  const turns = conversationTranscript(laneId, { secrets: secrets() });
  return view(label, turns.map((turn) => ({ turn, title: `応答 ${turn.n}`, key: `${laneId}:${turn.n}` })), live.has(sessionId));
}

/** the ad-hoc runs a lane's stages recorded, as the budget counts them */
export const runIdsOf = laneRunIds;

/** the lane's short stages that ran on Claude Code, one row each; null when none did */
export function claudeRunsView(ids: string[]): ClaudeTranscriptView | null {
  const s = secrets();
  const rows: { turn: TranscriptTurn; title: string; key: string }[] = [];
  for (const id of ids) {
    let rec: LaneRecord;
    try { rec = readLane(id); } catch { continue; }
    if (rec.role_preset?.harness !== "claude") continue;
    const turn = runTranscript(id, { secrets: s });
    const title = rec.role || id;
    // a run with no title of its own would say its role twice
    if (turn) rows.push({ turn: turn.sent.text === title ? { ...turn, sent: { ...turn.sent, text: "" } } : turn, title, key: id });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.turn.started_at.localeCompare(b.turn.started_at));
  return view("短い段", rows, false);
}

const WHEN_JST = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const WINDOW_LABEL: Record<string, string> = { five_hour: "5 時間の枠", seven_day: "週上限", seven_day_opus: "週上限（Opus）", seven_day_sonnet: "週上限（Sonnet）" };

/** the account's last observation of the windows; a window that has reset since is left out */
export function claudeQuotaView(now = Date.now(), configDirOverride?: string): ClaudeQuotaView | undefined {
  let configDir: string;
  try { configDir = configDirOverride ?? readRoles().defaults.claudeConfigDir; } catch { return undefined; }
  const obs = readClaudeQuota(configDir);
  if (!obs) return undefined;
  const seen = Date.parse(obs.observed_at);
  // a reset nobody reported is at most the window's own length after the observation
  const until = (name: string, resetsAt?: number) => (resetsAt !== undefined ? resetsAt * 1000 : seen + (CLAUDE_QUOTA_WINDOWS[name] ?? CLAUDE_QUOTA_WINDOWS.five_hour) * 1000);
  const windows = Object.entries(obs.windows)
    .filter(([name, w]) => until(name, w.resets_at) > now)
    .map(([name, w]) => ({ name, label: WINDOW_LABEL[name] ?? name, utilization: w.utilization, ...(w.resets_at !== undefined ? { resets: WHEN_JST.format(w.resets_at * 1000) } : {}) }));
  const rejected = obs.status === "rejected" && until(obs.rate_limit_type ?? "five_hour", obs.resets_at) > now;
  if (!windows.length && !rejected) return undefined;
  return { windows, observed: WHEN_JST.format(seen), ...(rejected ? { rejected: true } : {}) };
}

const PART_LABEL: Record<string, string> = { planner: "下調べ", executor: "実装" };
const round = (n: number) => Math.round(n * 1000) / 1000;

/** a spend as the detail shows it: the costly parts only, the sessions named in penne's words */
export function shownCost(cost: CostView): CostView {
  const shown = (parts: CostView["parts"]) => parts.filter((p) => p.cost > 0).map((p) => ({ label: PART_LABEL[p.label] ?? p.label, cost: round(p.cost) }));
  return { total: round(cost.total), parts: shown(cost.parts), subscription: shown(cost.subscription) };
}
