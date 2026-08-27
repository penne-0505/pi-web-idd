// intent: DEC-601 — 最新 event から現在の状態を決める。events.md の対応表がここの正本

import type { LifecycleRecord } from "../schema/records.ts";

export type LaneGroup = "judge" | "prep" | "impl" | "waiting" | "closed";
export type DecisionKind = "duplicate" | "question" | "go" | "review" | "ship";

export function deriveStage(events: LifecycleRecord[]): {
  group: LaneGroup;
  stageDone: number;
  stageCurrent: number | null;
  blockedBy?: string;
  decision?: DecisionKind;
} {
  const names = events.map((e) => e.event);
  const last = names[names.length - 1] ?? "";
  const has = (n: string) => names.includes(n);
  const lastOf = (n: string) => [...events].reverse().find((e) => e.event === n);

  if (has("lane_close")) return { group: "closed", stageDone: 5, stageCurrent: null };
  if (has("s1_defer") || has("s3_defer")) return { group: "closed", stageDone: 2, stageCurrent: null };
  if (has("s4_merged")) return { group: "closed", stageDone: 5, stageCurrent: null };
  if (last === "blocked_by_dependency") {
    const dep = lastOf("blocked_by_dependency")?.attrs?.depends_on;
    return { group: "waiting", stageDone: 2, stageCurrent: 2, blockedBy: Array.isArray(dep) ? String(dep[0]) : undefined };
  }
  if (has("s4_submit_started")) {
    if (has("s4_verify_user_judgment_requested") && !has("s4_verify_clean")) {
      return { group: "judge", stageDone: 4, stageCurrent: 4, decision: "ship" };
    }
    return { group: "impl", stageDone: 4, stageCurrent: 4 };
  }
  if (has("s3_ready")) {
    if (!has("s3_ok")) return { group: "judge", stageDone: 3, stageCurrent: 3, decision: "review" };
    return { group: "impl", stageDone: 4, stageCurrent: 4 };
  }
  if (has("s2_start")) return { group: "impl", stageDone: 2, stageCurrent: 2 };
  if (has("s1_go")) return { group: "impl", stageDone: 2, stageCurrent: 2 };
  if (has("s1_ready")) return { group: "judge", stageDone: 2, stageCurrent: null, decision: "go" };
  if (has("question_batch_asked")) return { group: "judge", stageDone: 1, stageCurrent: 1, decision: "question" };
  if (has("lane_open")) return { group: "prep", stageDone: 1, stageCurrent: 1 };
  return { group: "prep", stageDone: 0, stageCurrent: 0 };
}

export function elapsedLabel(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "昨日" : `${d}d`;
}
