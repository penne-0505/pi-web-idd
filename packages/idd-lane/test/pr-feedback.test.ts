import { describe, expect, test } from "bun:test";

import { feedbackFrom, type RawPrFeedback } from "../src/pr.ts";

const c = (id: string, login: string, body: string, at = "2026-09-24T10:00:00Z") => ({ id, url: `https://github.com/o/r/pull/1#${id}`, author: { login }, createdAt: at, body });

function raw(over: Partial<RawPrFeedback> = {}): RawPrFeedback {
  return {
    author: { login: "penne" },
    headRefOid: "abc123",
    comments: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    ...over,
  };
}

describe("PR feedback for its author", () => {
  test("review bodies, comments and thread comments count, the PR author's own included (a solo repo's reviewer is its author)", () => {
    const fb = feedbackFrom(raw({
      reviews: { nodes: [{ ...c("R1", "rev", "全体として 1 点"), state: "CHANGES_REQUESTED" }, { ...c("R2", "rev", ""), state: "APPROVED" }, { ...c("R3", "penne", "自分のレビュー"), state: "COMMENTED" }] },
      comments: { nodes: [c("I1", "bot", "要約"), c("I2", "penne", "LGTM")] },
      reviewThreads: { nodes: [{ id: "T1", isResolved: false, path: "a.ts", line: 3, comments: { nodes: [c("C1", "penne", "ここが壊れる")] } }] },
    }), []);
    expect(fb.author).toBe("penne");
    expect(fb.items.map((i) => [i.id, i.kind])).toEqual([["R1", "review"], ["R3", "review"], ["I1", "comment"], ["I2", "comment"], ["C1", "thread"]]);
    expect(fb.items[4]).toMatchObject({ thread_id: "T1", path: "a.ts", line: 3, author: "penne" });
  });

  test("what the harness posted is never feedback, and a thread whose last word is its reply waits for the reviewer", () => {
    const ours = new Set([`https://github.com/o/r/pull/1#C3`, `https://github.com/o/r/pull/1#C5`, `https://github.com/o/r/pull/1#I9`]);
    const fb = feedbackFrom(raw({
      comments: { nodes: [c("I9", "penne", "> rev のレビュー\n\nテストを足しました"), c("I8", "penne", "手で書いた補足")] },
      reviewThreads: { nodes: [
        { id: "T1", isResolved: true, path: "a.ts", line: 1, comments: { nodes: [c("C1", "rev", "直して")] } },
        { id: "T2", isResolved: false, path: "b.ts", line: 2, comments: { nodes: [c("C2", "rev", "直して"), c("C3", "penne", "直しました")] } },
        { id: "T3", isResolved: false, path: "c.ts", line: 3, comments: { nodes: [c("C4", "rev", "直して"), c("C5", "penne", "直しました"), c("C6", "rev", "まだ残っています")] } },
      ] },
    }), [], ours);
    // the reviewer answered the harness's reply in T3: the reviewer's comments are there, the seen one is filtered by the caller
    expect(fb.items.map((i) => i.id)).toEqual(["I8", "C4", "C6"]);
  });

  test("a failed check is feedback, keyed by its name at the head, and passing or pending ones are not", () => {
    const fb = feedbackFrom(raw(), [
      { name: "test", bucket: "fail", link: "https://github.com/o/r/actions/runs/9/job/1" },
      { name: "lint", bucket: "pass" },
      { name: "build", bucket: "pending" },
      { name: "legacy", state: "FAILURE" },
    ]);
    expect(fb.items.map((i) => i.id)).toEqual(["ci:test@abc123", "ci:legacy@abc123"]);
    expect(fb.items[0].kind).toBe("ci");
  });
});
