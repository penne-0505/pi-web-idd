import assert from "node:assert/strict";
import test from "node:test";

import { laneSlotWait, laneSlotWaitLabel, minutesLabel, sectionSlots, waitCountLabel } from "./slot-wait.ts";

const w = (slot, cap, running, lanes = []) => ({ slot, cap, running, lanes: lanes.map(([id, waitedMinutes]) => ({ id, since: "", waitedMinutes })) });

test("minutes read as minutes, and as hours once past one", () => {
  assert.equal(minutesLabel(0), "0 分");
  assert.equal(minutesLabel(59), "59 分");
  assert.equal(minutesLabel(60), "1 時間");
  assert.equal(minutesLabel(125), "2 時間 5 分");
});

test("a group's count is its own stage's, and its waits are the count and the longest", () => {
  const waits = [w("planner", 2, 2, [["IDD-3", 12], ["IDD-4", 42]]), w("plan_review", 3, 1), w("executor", 3, 1)];
  assert.deepEqual(sectionSlots(waits, "prep"), { running: 2, cap: 2, wait: { count: 2, longestMin: 42 } });
  assert.deepEqual(sectionSlots(waits, "impl"), { running: 1, cap: 3 });
});

test("the group's other stages are listed only while their cap holds a lane back", () => {
  const waits = [w("executor", 3, 3), w("review_blind", 2, 2, [["IDD-5", 7]]), w("triage", 3, 3), w("review_lane", 2, 2, [["REV-1", 3]]), w("plan_review", 3, 3, [["IDD-9", 1]])];
  assert.deepEqual(sectionSlots(waits, "impl"), {
    running: 3, cap: 3,
    stages: [
      { label: "レビュー", running: 2, cap: 2, wait: { count: 1, longestMin: 7 }, hint: "起動の判定は複製（copy）の数で数える: 上限 × role の数まで" },
      { label: "PR レビュー", running: 2, cap: 2, wait: { count: 1, longestMin: 3 }, hint: "起動の判定は複製（copy）の数で数える: 上限 × role の数まで" },
    ],
  });
  assert.deepEqual(sectionSlots(waits, "prep").stages, [{ label: "plan 査読", running: 3, cap: 3, wait: { count: 1, longestMin: 1 } }]);
});

test("a lane's wait names the stage and its cap; a lane not waiting has none", () => {
  const waits = [w("planner", 2, 2, [["IDD-3", 12]]), w("confirm", 3, 3, [["IDD-7", 4]])];
  assert.deepEqual(laneSlotWait(waits, "IDD-7"), { label: "確認", cap: 3, minutes: 4 });
  assert.equal(laneSlotWait(waits, "IDD-1"), undefined);
});

test("the words say 上限待ち and name the stage; 枠 is left to Claude's windows", () => {
  assert.equal(waitCountLabel({ count: 3, longestMin: 42 }), "上限待ち 3 件（最長 42 分）");
  assert.equal(laneSlotWaitLabel({ label: "判定", cap: 1, minutes: 20 }), "判定の上限待ち（1、20 分）");
});
