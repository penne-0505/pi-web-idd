import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildLaneDetail } = await import("./state.ts");
const { git, put, commit, event, setup, child } = await import("../../../idd-core/test/stacked-fixture.mjs");

describe("a child whose parent lane ended", () => {
  it("lists no changed files and says the parent ended when nothing of the parent is left to measure from", async () => {
    const f = setup();
    // the inbox orders lanes by when they were taken in
    writeFileSync(join(f.state, "backlog.jsonl"), ["IDD-1", "IDD-2", "IDD-3"].map((id) => JSON.stringify({ idd_id: id, area: "demo", title: `feat: ${id}`, created_at: "2026-09-26T00:00:00Z" })).join("\n") + "\n");
    put(join(f.parent.path, "app.txt"), "parent draft\n"); commit(f.parent.path);
    const lane = await child(f);
    put(join(lane.path, "child.txt"), "child\n"); commit(lane.path);
    writeFileSync(join(f.state, "executor-progress-IDD-2.json"), JSON.stringify({ idd_id: "IDD-2", updated_at: "2026-09-26T00:00:00Z", current_step: "", qa_status: [], recent_activity: [] }));
    event(f, "IDD-1", "lane_close", { outcome: "aborted" });
    assert.deepEqual((await buildLaneDetail("IDD-2")).work.files.map((x) => x.path), ["child.txt"]);
    git(f.work, "worktree", "remove", "--force", f.parent.path); git(f.work, "branch", "-D", "idd/IDD-1");
    const view = await buildLaneDetail("IDD-2");
    assert.deepEqual(view.work.files, []);
    assert.match(view.work.note ?? "", /IDD-1.*終わ/);
  });
});
