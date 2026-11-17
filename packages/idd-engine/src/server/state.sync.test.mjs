import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");
const { inboxKey, inboxLaneId } = await import("../../../../lib/idd-ui/types.ts");
const { snoozeKey } = await import("../../../../lib/idd-ui/snooze.ts");

let dir;
afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_REPOS_FILE;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const REPO = "me/app";
const record = (over = {}) => ({
  id: "CF-0123456789ab", repo: REPO, unit: "project_body", subject: "PRJ-1", label: "PRJ-1 の本文",
  external: "外", base: "前回", propter: "propter", raisedAt: "2026-10-28T09:00:00Z", ...over,
});

/** the sync's own file of open conflicts, in the state directory, under the name the sync gives a repo */
function setup(list, { synced = true } = {}) {
  dir = mkdtempSync(join(tmpdir(), "idd-state-sync-"));
  process.env.IDD_STATE_DIR = dir;
  process.env.IDD_REPOS_FILE = join(dir, "repos.yaml");
  const entry = { upstream: join(dir, "u"), work: join(dir, "w"), public_base: "main", ...(synced ? { tracker_sync: { target: "github" } } : {}) };
  writeFileSync(join(dir, "repos.yaml"), JSON.stringify({ storage: { cleanup: false, min_free_gb: 0 }, repos: { [REPO]: entry } }));
  mkdirSync(join(dir, "sync"));
  writeFileSync(join(dir, "sync", "me_2f_app.conflicts.json"), typeof list === "string" ? list : JSON.stringify(list));
}

const cards = (state) => state.items.filter((i) => i.kind === "sync_conflict");

describe("the conflict card in the state", () => {
  it("is one card for each open conflict, with the three values, tied to no lane", () => {
    setup([record(), record({ id: "CF-ba9876543210", unit: "issue_project", subject: "me/app#1", label: "me/app#1 の所属", raisedAt: "2026-10-28T10:00:00Z" })]);
    const found = cards(buildState());
    assert.equal(found.length, 2);
    const [first] = found;
    assert.deepEqual([first.external, first.base, first.propter], ["外", "前回", "propter"]);
    assert.equal(first.repo, REPO);
    assert.equal(inboxLaneId(first), undefined);
    assert.notEqual(inboxKey(found[0]), inboxKey(found[1]), "two conflicts are two cards");
    assert.equal(snoozeKey(first), "sync_conflict:CF-0123456789ab");
  });

  it("is not there once the sync closed the conflict, and for a repo that reads no outside", () => {
    setup([]);
    assert.equal(cards(buildState()).length, 0);
    setup([record()], { synced: false });
    assert.equal(cards(buildState()).length, 0);
  });

  it("leaves a file that cannot be read out without stopping the state", () => {
    setup("{ not json");
    const state = buildState();
    assert.equal(cards(state).length, 0);
    assert.ok(Array.isArray(state.items));
  });
});
