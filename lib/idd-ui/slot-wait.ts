import type { LaneSection, LaneSlotWait, SlotWaitCount } from "./types";

/** what the engine reports per capped stage (SlotWait of @idd/core), as far as the screen reads it */
export interface SlotWaitSource {
  slot: string;
  cap: number;
  running: number;
  lanes: { id: string; waitedMinutes: number }[];
}

/** the stage's word where it is shown beside the group's own count */
export const SLOT_LABEL: Record<string, string> = {
  planner: "下調べ",
  plan_review: "plan 査読",
  executor: "実装",
  review_blind: "レビュー",
  risk_map: "地図",
  triage: "判定",
  confirm: "確認",
  review_lane: "PR レビュー",
  review_lane_map: "PR レビューの地図",
};

/** the group a stage's lanes are listed under, and the stage the group's own count is */
const SLOT_GROUP: Record<string, "prep" | "impl"> = {
  planner: "prep",
  plan_review: "prep",
  executor: "impl",
  review_blind: "impl",
  risk_map: "impl",
  triage: "impl",
  confirm: "impl",
  review_lane: "impl",
  review_lane_map: "impl",
};
const PRIMARY: Record<"prep" | "impl", string> = { prep: "planner", impl: "executor" };

export function minutesLabel(min: number): string {
  const m = Math.max(0, Math.floor(min));
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 時間 ${rest} 分` : `${h} 時間`;
}

export function waitCountLabel(w: SlotWaitCount): string {
  return `上限待ち ${w.count} 件（最長 ${minutesLabel(w.longestMin)}）`;
}

/** the stage is named in the words: a lane shown under one stage's count may wait for another stage's cap */
export function laneSlotWaitLabel(w: LaneSlotWait): string {
  return `${w.label}の上限待ち（${w.cap}、${minutesLabel(w.minutes)}）`;
}

/** the blind rounds start by the copies they cut, not by the lanes: said where their count is shown */
const COPY_HINT = "起動の判定は複製（copy）の数で数える: 上限 × role の数まで";
const SLOT_HINT: Record<string, string> = { review_blind: COPY_HINT, review_lane: COPY_HINT };

function countOf(w: SlotWaitSource): SlotWaitCount | undefined {
  if (!w.lanes.length) return undefined;
  return { count: w.lanes.length, longestMin: Math.max(...w.lanes.map((l) => l.waitedMinutes)) };
}

/** a working group's count against its own stage's cap, its waits, and the other stages under it that hold lanes back */
export function sectionSlots(waits: SlotWaitSource[], group: "prep" | "impl"): Pick<LaneSection, "running" | "cap" | "wait" | "stages"> {
  const primary = waits.find((w) => w.slot === PRIMARY[group]);
  const wait = primary ? countOf(primary) : undefined;
  const stages = waits
    .filter((w) => w.slot !== PRIMARY[group] && SLOT_GROUP[w.slot] === group)
    .flatMap((w) => {
      const c = countOf(w);
      return c ? [{ label: SLOT_LABEL[w.slot] ?? w.slot, running: w.running, cap: w.cap, wait: c, ...(SLOT_HINT[w.slot] ? { hint: SLOT_HINT[w.slot] } : {}) }] : [];
    });
  return {
    ...(primary ? { running: primary.running, cap: primary.cap } : {}),
    ...(wait ? { wait } : {}),
    ...(stages.length ? { stages } : {}),
  };
}

/** the stage the lane waits for by its cap, if it does */
export function laneSlotWait(waits: SlotWaitSource[], id: string): LaneSlotWait | undefined {
  for (const w of waits) {
    const lane = w.lanes.find((l) => l.id === id);
    if (lane) return { label: SLOT_LABEL[w.slot] ?? w.slot, cap: w.cap, minutes: lane.waitedMinutes };
  }
  return undefined;
}
