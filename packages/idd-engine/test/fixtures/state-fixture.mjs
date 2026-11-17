import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";

// What the tests of `buildState` share: a state directory made for each test and the files of one lane in it.

export const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
export const NOW = new Date("2026-10-05T12:00:00Z"); // 2026-10-05 21:00 JST
/** 2026-10-05 H:00 UTC = 2026-10-05 (H+9) JST */
export const at = (h) => `2026-10-05T${String(h).padStart(2, "0")}:00:00Z`;

export const backlogRow = (id, title) => ({ idd_id: id, parent_id: null, created_at: "2026-10-01T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title, area: "Demo" });

/** a state directory (with a roles file) made before each test and removed after it; the path is `.dir` */
export function stateDirPerTest(prefix) {
  const state = { dir: "" };
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), prefix));
    process.env.IDD_STATE_DIR = state.dir;
    writeFileSync(join(state.dir, "roles.yaml"), "roles:\n  r: { model: x/y }\npipeline:\n");
    process.env.IDD_ROLES_FILE = join(state.dir, "roles.yaml");
  });
  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
  });
  return state;
}

/** the lane `id` in the state directory: its backlog row and its events (`[event, attrs]`), one hour apart from 01:00 */
export function putLane(dir, id, title, events) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "backlog.jsonl"), jsonl([backlogRow(id, title)]));
  writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl(events.map(([event, attrs = {}], i) => ({ idd_id: id, event, at: at(1 + i), attrs }))));
}
