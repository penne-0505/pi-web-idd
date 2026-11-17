import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildLaneDetail, buildState } = await import("./state.ts");

const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
let dir;
const saved = process.env.IDD_INTENT_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-state-intent-"));
  process.env.IDD_STATE_DIR = dir;
  process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
  writeFileSync(process.env.IDD_ROLES_FILE, "roles:\n  r: { model: x/y }\npipeline:\n");
  writeFileSync(join(dir, "backlog.jsonl"), jsonl([{ idd_id: "IDD-1", parent_id: null, created_at: "2026-10-01T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "GO の lane", area: "Demo" }]));
  writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl([
    { idd_id: "IDD-1", event: "lane_open", at: "2026-10-05T01:00:00Z", attrs: {} },
    { idd_id: "IDD-1", event: "s1_ready", at: "2026-10-05T02:00:00Z", attrs: {} },
    { idd_id: "IDD-1", event: "s1_plan_review_done", at: "2026-10-05T03:00:00Z", attrs: { must: 0, should: 0, nit: 0 } },
  ]));
  const intent = join(dir, "intent", "Demo", "idd-1");
  mkdirSync(intent, { recursive: true });
  writeFileSync(join(intent, "decision.md"), [
    "## Decisions",
    "",
    "### DEC-1: 題",
    "",
    "- **What**: 方針",
    "- **Why**: 一行目の理由",
    "  続きの行",
    "- **Source**: 質問 Q-1",
    "",
    "### DEC-2: 出どころ無し",
    "",
    "- **Why**: 別の理由",
    "",
  ].join("\n"));
  process.env.IDD_INTENT_DIR = join(dir, "intent");
});

afterEach(() => {
  if (saved === undefined) delete process.env.IDD_INTENT_DIR;
  else process.env.IDD_INTENT_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("the decisions the API returns", () => {
  it("AC-001 / AC-002: the GO card and the lane detail both carry the Why and Source as written", async () => {
    const expected = [
      { id: "DEC-1", text: "題", why: "一行目の理由\n  続きの行", source: "質問 Q-1" },
      { id: "DEC-2", text: "出どころ無し", why: "別の理由", source: "" },
    ];
    const card = buildState().items.find((i) => i.kind === "go");
    assert.deepEqual(card.decisions, expected);

    const detail = await buildLaneDetail("IDD-1");
    assert.deepEqual(detail.contract.decisions, expected);
  });

  it("AC-002: a lane without decisions gets an empty list on both", async () => {
    rmSync(join(dir, "intent"), { recursive: true, force: true });
    const card = buildState().items.find((i) => i.kind === "go");
    assert.deepEqual(card.decisions, []);
    const detail = await buildLaneDetail("IDD-1");
    assert.deepEqual(detail.contract.decisions, []);
  });

  it("AC-024 / INV-119-5: a v2 lane's GO card and lane detail show the same Choice heading", async () => {
    const draft = {
      purpose: "P-1",
      forms: { chosen: "保存の前に確認を挟む", rejected: [{ form: "確認を省く", fails_because: "取り消せない削除が残る" }] },
      place: [{ path: "src/save.ts", kind: "file" }],
      why: "取り消せない削除を防ぐため。",
      anchored: "削除は確認を通ってから起きる。",
    };
    // the ready's mark and the drafts it carried: the GO card reads the plan report's drafts
    writeFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl([
      { idd_id: "IDD-1", event: "lane_open", at: "2026-10-05T01:00:00Z", attrs: {} },
      { idd_id: "IDD-1", event: "s1_ready", at: "2026-10-05T02:00:00Z", attrs: { records_shape: "state", plan_records: { choices: [draft], existing: [] } } },
      { idd_id: "IDD-1", event: "s1_plan_review_done", at: "2026-10-05T03:00:00Z", attrs: { must: 0, should: 0, nit: 0 } },
    ]));
    const card = buildState().items.find((i) => i.kind === "go");
    assert.equal(card.decisions[0].text, "保存の前に確認を挟む");
    assert.match(card.decisions[0].id, /（予定）/);
    const before = await buildLaneDetail("IDD-1");
    assert.equal(before.contract.decisions[0].text, "保存の前に確認を挟む");

    // after the GO the same Choice is written to the column: the lane detail reads that, and the heading matches
    appendFileSync(join(dir, "intent-Demo.jsonl"), jsonl([
      { event: "choice_raised", at: "2026-10-05T04:00:00Z", repo: "Demo", by: { lane: "IDD-1" }, id: "C-1-1", status: "active", ...draft },
    ]));
    appendFileSync(join(dir, "lifecycle-Demo.jsonl"), jsonl([
      { idd_id: "IDD-1", event: "s1_go", at: "2026-10-05T04:00:00Z", attrs: {} },
    ]));
    const detail = await buildLaneDetail("IDD-1");
    assert.equal(detail.contract.decisions[0].id, "C-1-1");
    assert.equal(detail.contract.decisions[0].text, card.decisions[0].text);
    assert.equal(detail.contract.decisions[0].text, "保存の前に確認を挟む");
  });
});
