import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");
const { createOutbound, readOutbound } = await import("@idd/lane");

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-state-title-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "repos.yaml"), "repos:\n  o/r:\n    upstream: /u/r\n    work: /w/r\n");
  process.env.IDD_REPOS_FILE = join(dir, "repos.yaml");
});

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_REPOS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

const rewriterWith = (text) => async () => ({ text, role: "rewriter", model: "m" });

/** rewrite the saved record in place, so an old record's field and an empty one can be made on purpose */
function patch(id, fields) {
  writeFileSync(join(dir, "outbound", `${id}.json`), JSON.stringify({ ...readOutbound(id), ...fields }));
}

describe("the outbound card's title", () => {
  it("starts from the rewrite's title, and falls back to the draft's when there is none or it is empty", async () => {
    const rewritten = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "下書きの題 A", body: "下書きの本文" }, rewriterWith("清書の題\n\n清書の本文"));
    const whole = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "下書きの題 B", body: "下書きの本文" }, rewriterWith("清書: 本文"));
    // an old record: the field is not there at all
    const old = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "下書きの題 C", body: "下書きの本文", noRewrite: true });
    patch(old.id, { rewritten: "清書の本文" });
    // a record whose rewrite came back with an empty title
    const empty = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "下書きの題 D", body: "下書きの本文", noRewrite: true });
    patch(empty.id, { rewrittenTitle: "", rewritten: "清書の本文" });
    // penne changed the title on the card and approved
    const fixed = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "下書きの題 E", body: "下書きの本文" }, rewriterWith("清書の題\n\n清書の本文"));
    patch(fixed.id, { final: { title: "確定した題", body: "確定した本文" } });

    const items = buildState().items.filter((i) => i.kind === "outbound");
    const titleOf = (id) => items.find((i) => i.iddId === id)?.title;
    assert.equal(titleOf(rewritten.id), "清書の題");
    assert.equal(titleOf(whole.id), "下書きの題 B");
    assert.equal(titleOf(old.id), "下書きの題 C");
    assert.equal(titleOf(empty.id), "下書きの題 D");
    assert.equal(titleOf(fixed.id), "確定した題");
  });

  it("keeps the rewrite's title out of the body the card shows", async () => {
    const rec = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "下書きの題", body: "下書きの本文" }, rewriterWith("清書の題\n\n清書の本文"));
    const [item] = buildState().items.filter((i) => i.kind === "outbound");
    assert.equal(item.title, "清書の題");
    assert.equal(item.proposed, "清書の本文");
    assert.equal(item.proposed.includes("清書の題"), false);
  });
});
