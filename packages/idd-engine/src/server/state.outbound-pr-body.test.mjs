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
  dir = mkdtempSync(join(tmpdir(), "idd-state-prbody-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "repos.yaml"), "repos:\n  me/app:\n    upstream: /u/app\n    work: /w/app\n");
  process.env.IDD_REPOS_FILE = join(dir, "repos.yaml");
});

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_REPOS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("the outbound card of a PR body update", () => {
  it("carries the PR's text as it was when the card was made, beside the proposed text", async () => {
    await createOutbound({
      kind: "gh-pr-body",
      target: { repo: "me/app", pr: 12, baseTitle: "feat: 変更", baseBody: "古い本文\n" },
      title: "feat: 変更",
      body: "新しい本文\n",
    });
    const [item] = buildState().items.filter((i) => i.kind === "outbound");
    assert.equal(item.outKind, "gh-pr-body");
    assert.equal(item.baseBody, "古い本文\n");
    assert.equal(item.baseTitle, "feat: 変更");
    assert.equal(item.proposed, "新しい本文\n");
    assert.match(item.targetLabel, /me\/app#12/);
  });
});
