/**
 * The mention block is the point, and it comes from the engine's state. The tests pin what a mention adds
 * (AC-002): a lane's id/title/stage/Issue and a card's kind and ask only, five at most, and a name the state
 * does not hold refused.
 */
import { describe, expect, test } from "bun:test";

import { MAX_MENTIONS, buildMentionBlock, parseMentions } from "../src/server/mentions.ts";
import type { IddState } from "../src/server/state.ts";

const state = {
  lanes: [
    { iddId: "IDD-167", title: "通常の会話から指す", group: "impl", blockedBy: "実装中", source: { kind: "github", label: "penne-0505/pi-web-idd#169" } },
    { iddId: "IDD-165", title: "card の相談", group: "judge", source: { kind: "github", label: "penne-0505/pi-web-idd#167" } },
  ],
  items: [
    { kind: "question", iddId: "IDD-165", batchId: "b1", laneTitle: "card の相談", open: [{ question: "どこに置くか", facts: [{ label: "f", value: "v" }], options: [{ label: "A", rationale: "r" }, { label: "B" }] }] },
    { kind: "go", iddId: "IDD-167", laneTitle: "通常の会話から指す", summary: { situation: "状況", action: "行動", outcome: "結果" }, riskTable: [{ kind: "x" }] },
  ],
} as unknown as IddState;

describe("mentions are read off the send", () => {
  test("none is the empty list, and a bad shape is refused", () => {
    expect(parseMentions(undefined)).toEqual({ refs: [], error: null });
    expect(parseMentions(null)).toEqual({ refs: [], error: null });
    expect(parseMentions({ lane: "IDD-1" }).error).toBeTruthy();
    expect(parseMentions([{ kind: "go" }]).error).toContain("lane");
    expect(parseMentions(["IDD-1"]).error).toBeTruthy();
  });

  test("five passes and a sixth is refused", () => {
    const five = Array.from({ length: MAX_MENTIONS }, (_, i) => ({ lane: `IDD-${i}` }));
    expect(parseMentions(five).refs.length).toBe(5);
    expect(parseMentions([...five, { lane: "IDD-9" }]).error).toContain("5");
  });
});

describe("the block is the point, from the engine's values", () => {
  test("a lane mention carries its id, title, stage and Issue", () => {
    const built = buildMentionBlock([{ lane: "IDD-167" }], state);
    expect(built.error).toBeNull();
    expect(built.block).toContain("IDD-167「通常の会話から指す」");
    expect(built.block).toContain("段: 実装中");
    expect(built.block).toContain("penne-0505/pi-web-idd#169");
  });

  test("a question card adds only the ask and the option labels, never facts or rationales", () => {
    const built = buildMentionBlock([{ lane: "IDD-165", kind: "question", batchId: "b1" }], state);
    expect(built.block).toContain("質問: どこに置くか");
    expect(built.block).toContain("選択肢: A / B");
    expect(built.block).not.toContain("rationale");
    expect(built.block).not.toContain("facts");
  });

  test("a GO card carries its three lines and nothing else", () => {
    const built = buildMentionBlock([{ lane: "IDD-167", kind: "go" }], state);
    expect(built.block).toContain("GO: 状況 / 行動 / 結果");
    expect(built.block).not.toContain("riskTable");
  });

  test("a lane or card the state does not hold is refused", () => {
    expect(buildMentionBlock([{ lane: "IDD-999" }], state).error).toContain("lane がありません");
    expect(buildMentionBlock([{ lane: "IDD-165", kind: "ship" }], state).error).toContain("card がありません");
  });

  test("no mention builds no block, so a plain send is unchanged", () => {
    expect(buildMentionBlock([], state)).toEqual({ block: "", error: null });
  });
});
