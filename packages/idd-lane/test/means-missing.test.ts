import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectMissingMeans, repoRelativePath } from "../src/means-missing.ts";
import { tmpDir } from "./helpers/tmp.ts";

/** the lanes root of a fresh state dir, and a lane record written under it */
function stateWithLane(lane: Record<string, unknown>): { state: string; laneId: string } {
  const state = tmpDir("idd-means-");
  process.env.IDD_STATE_DIR = state;
  const laneId = String(lane.id);
  const dir = join(state, "lanes", laneId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lane.json"), JSON.stringify(lane));
  return { state, laneId };
}

function withEvents(state: string, laneId: string, lines: unknown[]): void {
  writeFileSync(join(state, "lanes", laneId, "events.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
}

function withTurn(state: string, laneId: string, n: number, lines: unknown[]): void {
  const dir = join(state, "lanes", laneId, "turns");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${n}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
}

/** a pi read of a file: the call, then the tool's own answer */
const piRead = (call: string, path: string, text: string) => [
  { type: "tool_execution_start", toolCallId: call, toolName: "read", args: { path } },
  { type: "tool_execution_end", toolCallId: call, result: { content: [{ type: "text", text }] } },
];

const IMAGE_NOTE = "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]";

describe("detectMissingMeans", () => {
  test("a stage run's image read refusal is a detection with the run, role and repo path", () => {
    const wt = tmpDir("idd-means-wt-");
    const { state, laneId } = stateWithLane({ id: "20261014-094711-blind-reviewer-02", role: "blind-reviewer-02", worktree: wt, mode: "conversation" });
    withEvents(state, laneId, piRead("c1", join(wt, "_docs/qa/idd-130/compare/proto.png"), IMAGE_NOTE));
    const found = detectMissingMeans({ ids: [laneId] });
    expect(found).toEqual([
      { run: laneId, role: "blind-reviewer-02", call: "c1", path: "_docs/qa/idd-130/compare/proto.png", marker: "image", tool: "read", note: "[Current model does not support images. The image will be omitted from this request.]" },
    ]);
  });

  test("a conversation's reply is read through its session id, and every turn is looked at", () => {
    const wt = tmpDir("idd-means-wt-");
    const { state, laneId } = stateWithLane({ id: "lane-of-conversation", role: "executor", worktree: wt, mode: "conversation" });
    // the session → lane index the engine writes for a conversation
    const index = join(state, "pipeline", "conversations");
    mkdirSync(index, { recursive: true });
    writeFileSync(join(index, "sess-1"), laneId);
    withTurn(state, laneId, 1, [{ type: "turn_end" }]);
    withTurn(state, laneId, 2, piRead("c9", "compare/a.png", IMAGE_NOTE));
    const found = detectMissingMeans({ ids: ["sess-1"] });
    expect(found.map((m) => m.path)).toEqual(["compare/a.png"]);
    expect(found[0].run).toBe(laneId);
  });

  test("a document quoting the mark is no detection, and neither is a successful image read", () => {
    const wt = tmpDir("idd-means-wt-");
    const { state, laneId } = stateWithLane({ id: "lane-doc", role: "planner", worktree: wt });
    withEvents(state, laneId, [
      ...piRead("c1", "8-brief.md", "# brief\n\n`does not support images` など → 場所に付いた指摘"),
      { type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "cat 8-brief.md" } },
      { type: "tool_execution_end", toolCallId: "c2", result: { content: [{ type: "text", text: "8-brief.md: ... does not support images ..." }] } },
      ...piRead("c3", "ok.png", "Read image file [image/png]"),
    ]);
    expect(detectMissingMeans({ ids: [laneId] })).toEqual([]);
  });

  test("a configured mark works next to the built-in one", () => {
    const wt = tmpDir("idd-means-wt-");
    const { state, laneId } = stateWithLane({ id: "lane-config", role: "executor", worktree: wt });
    withEvents(state, laneId, [
      ...piRead("c1", "compare/a.png", IMAGE_NOTE),
      { type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "run" } },
      { type: "tool_execution_end", toolCallId: "c2", result: { content: [{ type: "text", text: "bash: run: command not found" }] } },
    ]);
    const found = detectMissingMeans({ ids: [laneId], markers: [{ id: "no-terminal", tool: "bash", prefix: "bash: " }] });
    expect(found.map((m) => m.marker).sort()).toEqual(["image", "no-terminal"]);
    expect(detectMissingMeans({ ids: [laneId] }).map((m) => m.marker)).toEqual(["image"]);
  });

  test("a tool result outside the run's work area is reported with no path", () => {
    const wt = tmpDir("idd-means-wt-");
    const { state, laneId } = stateWithLane({ id: "lane-outside", role: "executor", worktree: wt });
    withEvents(state, laneId, piRead("c1", "/tmp/committed-chat-proto.png", IMAGE_NOTE));
    const found = detectMissingMeans({ ids: [laneId] });
    expect(found).toHaveLength(1);
    expect(found[0].path).toBeUndefined();
  });

  test("a run id that names no lane is left alone", () => {
    const state = tmpDir("idd-means-");
    process.env.IDD_STATE_DIR = state;
    expect(detectMissingMeans({ ids: ["no-such-lane"] })).toEqual([]);
  });

  test("a Claude Code tool use and result are read too", () => {
    const wt = tmpDir("idd-means-wt-");
    const { state, laneId } = stateWithLane({ id: "lane-claude", role: "reviewer", worktree: wt });
    withEvents(state, laneId, [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: join(wt, "shot.png") } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: IMAGE_NOTE }] }] } },
    ]);
    const found = detectMissingMeans({ ids: [laneId] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ call: "t1", tool: "Read", path: "shot.png", marker: "image" });
  });
});

describe("repoRelativePath", () => {
  const wt = "/work/IDD-117";
  test("an absolute path inside the work area becomes the repository's path", () => {
    expect(repoRelativePath("/work/IDD-117/lib/a.ts", wt)).toBe("lib/a.ts");
  });
  test("a relative path is read from the work area", () => {
    expect(repoRelativePath("_docs/qa/a.png", wt)).toBe("_docs/qa/a.png");
  });
  test("a path outside the work area, and the work area itself, carry no repo path", () => {
    expect(repoRelativePath("/tmp/a.png", wt)).toBeUndefined();
    expect(repoRelativePath("../elsewhere/a.ts", wt)).toBeUndefined();
    expect(repoRelativePath(wt, wt)).toBeUndefined();
  });
});
