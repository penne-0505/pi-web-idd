import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");
const { createOutbound } = await import("@idd/lane");

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-state-labels-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "repos.yaml"), [
    "repos:",
    "  me/app:",
    "    upstream: /u/app",
    "    work: /w/app",
    "    review_labels:",
    "      comment: { remove: [awaiting review], add: [feedback] }",
    "  me/plain:",
    "    upstream: /u/plain",
    "    work: /w/plain",
    "",
  ].join("\n"));
  process.env.IDD_REPOS_FILE = join(dir, "repos.yaml");
});

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_REPOS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("the outbound card of a PR review", () => {
  it("carries the repo's label swaps for every kind of review, and none for a repo without them", async () => {
    for (const repo of ["me/app", "me/plain"]) {
      await createOutbound({ kind: "gh-pr-review", target: { repo, pr: 1, expectHead: "abc1234" }, title: `${repo} のレビュー`, body: "本文", noRewrite: true });
    }
    await createOutbound({ kind: "gh-issue", target: { repo: "me/app" }, title: "Issue", body: "本文", noRewrite: true });
    const items = buildState().items.filter((i) => i.kind === "outbound");
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i.labelRules]));
    assert.deepEqual(byTitle["me/app のレビュー"], { comment: { remove: ["awaiting review"], add: ["feedback"] } });
    assert.deepEqual(byTitle["me/plain のレビュー"], {});
    assert.equal(byTitle.Issue, undefined);
  });

  it("shows no labels rather than failing the inbox when the registry cannot be read", async () => {
    writeFileSync(join(dir, "repos.yaml"), "repos:\n  me/app:\n    upstream: /u\n    work: /w\n    review_labels:\n      approved: { add: [x] }\n");
    await createOutbound({ kind: "gh-pr-review", target: { repo: "me/app", pr: 1, expectHead: "abc1234" }, title: "レビュー", body: "本文", noRewrite: true });
    const [item] = buildState().items.filter((i) => i.kind === "outbound");
    assert.deepEqual(item.labelRules, {});
  });
});
