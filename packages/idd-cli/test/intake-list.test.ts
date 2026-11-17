import { describe, expect, test } from "bun:test";

import { formatIntakeList } from "../src/intake-list.ts";

describe("formatIntakeList", () => {
  test("shows each lane-to-be with its repo, what is already in the backlog, the skipped Linear Issues and the failures", () => {
    const out = formatIntakeList({
      candidates: [
        { source: "github", area: "a/gh", ref: "#1", number: 1, title: "gh one", url: "https://github.com/a/gh/issues/1", alreadyInBacklog: "IDD-004" },
        { source: "linear", area: "Dayseum/daysai-flutter", ref: "APP-1", title: "app one", url: "https://linear.app/o/issue/APP-1", alreadyInBacklog: null },
      ],
      skipped: [{ ref: "WEB-5", title: "web five", reason: "チーム WEB に対応する repo がありません" }],
      failures: [{ area: "linear", reason: "Linear API: HTTP 401（鍵が無効か権限がありません）" }],
    });
    expect(out.stdout).toEqual([
      "[IDD-004] #1 gh one (a/gh)",
      "[new] APP-1 app one (Dayseum/daysai-flutter) — 優先度 なし、見積り なし",
      "[skip] WEB-5 web five — チーム WEB に対応する repo がありません",
      "2 件（新規 1 件）、飛ばした Linear の Issue 1 件",
    ]);
    expect(out.stderr).toEqual(["[fail] linear: Linear API: HTTP 401（鍵が無効か権限がありません）"]);
  });
});

describe("formatIntakeList with dependency waits", () => {
  test("shows a held Issue apart from the new ones, with its blockers, the ignored dependency and the count", () => {
    const out = formatIntakeList({
      candidates: [
        {
          source: "github", area: "a/gh", ref: "#1", number: 1, title: "blocked one",
          url: "https://github.com/a/gh/issues/1", alreadyInBacklog: null,
          hold: {
            reason: "開いた blocker があります（#3）",
            blockers: [{ ref: "#3", title: "blocker", url: "https://github.com/a/gh/issues/3", state: "open", scope: "a/gh", outOfScope: false }],
          },
        },
        { source: "github", area: "a/gh", ref: "#2", number: 2, title: "free one", url: "https://github.com/a/gh/issues/2", alreadyInBacklog: null },
      ],
      skipped: [],
      failures: [],
      ignoredBlockers: [
        { ref: "#2", title: "free one", blocker: { ref: "#9", title: "other repo", url: "https://github.com/b/else/issues/9", state: "open", scope: "b/else", outOfScope: true } },
      ],
    });
    expect(out.stdout).toEqual([
      "[依存待ち] #1 blocked one (a/gh) — 開いた blocker があります（#3） — blocker: #3(open)",
      "[new] #2 free one (a/gh)",
      "[範囲外] #2 の依存 #9（b/else）は追いません",
      "2 件（新規 1 件、依存待ち 1 件）",
    ]);
    expect(out.stderr).toEqual([]);
  });
});

describe("formatIntakeList with Linear estimates, priorities and unassigned Issues", () => {
  test("shows the facts on the Linear rows and an unassigned row apart from the count", () => {
    const out = formatIntakeList({
      candidates: [
        { source: "linear", area: "a/app", ref: "APP-1", title: "app one", url: "https://linear.app/o/issue/APP-1", alreadyInBacklog: null, estimate: 3, priority: 2 },
        {
          source: "linear", area: "a/app", ref: "APP-2", title: "app two", url: "https://linear.app/o/issue/APP-2", alreadyInBacklog: null,
          estimate: null, priority: 0,
          hold: {
            reason: "開いた blocker があります（APP-9）",
            blockers: [{ ref: "APP-9", title: "blocker", url: "https://linear.app/o/issue/APP-9", state: "open", scope: "APP", outOfScope: false }],
          },
        },
        { source: "github", area: "a/gh", ref: "#1", number: 1, title: "gh one", url: "https://github.com/a/gh/issues/1", alreadyInBacklog: null },
      ],
      skipped: [],
      failures: [],
      unassigned: [
        { area: "a/app", ref: "APP-3", title: "app three", url: "https://linear.app/o/issue/APP-3", estimate: 5, priority: 1 },
      ],
    });
    expect(out.stdout).toEqual([
      "[new] APP-1 app one (a/app) — 優先度 High、見積り 3",
      "[依存待ち] APP-2 app two (a/app) — 優先度 なし、見積り なし — 開いた blocker があります（APP-9） — blocker: APP-9(open)",
      "[new] #1 gh one (a/gh)",
      "[未アサイン] APP-3 app three (a/app) — 優先度 Urgent、見積り 5 — a/app は未アサインの Issue を取り込みません（設定で取り込めます）",
      "3 件（新規 2 件、依存待ち 1 件）、未アサイン 1 件（取り込みません）",
    ]);
    expect(out.stderr).toEqual([]);
  });
});
