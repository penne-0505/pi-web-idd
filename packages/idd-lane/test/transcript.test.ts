import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeStreamEntries, readClaudeStream, redactSecrets } from "../src/claude-stream.ts";
import { conversationTranscript, runTranscript } from "../src/transcript.ts";
import { laneTail } from "../src/runner.ts";

const TOKEN = "Zk3pQ9vT2mX8aL5nR1wE7yU4oI6sD0fG";
const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const assistant = (content: unknown[]) => ({ type: "assistant", message: { content } });

const saved = process.env.IDD_STATE_DIR;
const roots: string[] = [];

afterEach(() => {
  if (saved === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = saved;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "idd-transcript-"));
  roots.push(root);
  process.env.IDD_STATE_DIR = root;
  return root;
}

function lane(root: string, id: string, rec: Record<string, unknown>): string {
  const dir = join(root, "lanes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lane.json"), JSON.stringify({ id, role: "planner-claude", model: "opus", worktree: "/wt/lane", spec: "", report: "", started_at: "2026-09-25T01:00:00.000Z", ...rec }));
  return dir;
}

describe("what a Claude Code stream says, one line per move", () => {
  test("the text Claude wrote and the tools it called, the thinking and the tool results left out", () => {
    const entries = claudeStreamEntries(jsonl([
      { type: "system", subtype: "init", session_id: "s" },
      assistant([{ type: "thinking", thinking: "内心の推論" }, { type: "text", text: "まず  構成を\n見ます" }]),
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/wt/lane/lib/a.ts" } }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test\n  --silent", description: "run" } }]),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ファイルの中身" }] } },
      assistant([{ type: "tool_use", id: "t3", name: "Grep", input: { pattern: "laneTail", path: "/wt/lane/packages" } }]),
      { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
      { type: "result", subtype: "success", is_error: false, result: "できました" },
    ]), { cwd: "/wt/lane" });
    expect(entries).toEqual([
      { kind: "text", body: "まず 構成を 見ます" },
      { kind: "tool", tool: "Read", body: "lib/a.ts" },
      { kind: "tool", tool: "Bash", body: "npm test --silent" },
      { kind: "tool", tool: "Grep", body: "laneTail · packages" },
    ]);
    expect(JSON.stringify(entries)).not.toContain("内心");
    expect(JSON.stringify(entries)).not.toContain("ファイルの中身");
  });

  test("a reply that ended in an error says so", () => {
    const entries = claudeStreamEntries(jsonl([{ type: "result", subtype: "error_max_turns", is_error: true, result: "" }]));
    expect(entries).toEqual([{ kind: "error", body: "error_max_turns" }]);
  });

  test("the callback token never reaches the screen, in a command or in text", () => {
    const entries = claudeStreamEntries(jsonl([
      assistant([{ type: "tool_use", name: "Bash", input: { command: `curl -s -H "Authorization: Bearer ${TOKEN}" http://127.0.0.1:30142/api/idd/agent/ready` } }]),
      assistant([{ type: "text", text: `token は ${TOKEN} です` }]),
    ]), { secrets: [TOKEN] });
    const all = JSON.stringify(entries);
    expect(all).not.toContain(TOKEN);
    expect(entries[0].body).toContain("Bearer …");
    expect(entries[1].body).toBe("token は … です");
    expect(redactSecrets(`<token>${TOKEN}</token>`)).toBe("<token>…</token>");
  });

  test("a long stream is kept as its last moves and their total, not every move", () => {
    const root = stateRoot();
    const p = join(root, "long.jsonl");
    writeFileSync(p, jsonl(Array.from({ length: 500 }, (_, i) => assistant([{ type: "text", text: `m${i}` }]))));
    const read = readClaudeStream(p, { keep: 80 });
    expect(read.total).toBe(500);
    expect(read.entries.length).toBe(80);
    expect(read.entries[79].body).toBe("m499");
    // read again from the cache: still only the tail
    expect(readClaudeStream(p, { keep: 80 }).entries.length).toBe(80);
  });

  test("a half-written last line (a reply still running) is skipped", () => {
    const text = `${JSON.stringify(assistant([{ type: "text", text: "途中" }]))}\n{"type":"assist`;
    expect(claudeStreamEntries(text)).toEqual([{ kind: "text", body: "途中" }]);
  });
});

describe("a conversation lane's replies, read back from its own record", () => {
  test("each reply: what was sent, what Claude did, how it ended and what it cost; the running one last", () => {
    const root = stateRoot();
    const dir = lane(root, "L1", { mode: "conversation", status: "running", role_preset: { harness: "claude" } });
    for (const d of ["turns", "sent", "inflight"]) mkdirSync(join(dir, d));
    writeFileSync(join(dir, "sent", "001-a.md"), `<idd-system-message>\n  <type>s1_prep_start</type>\n  <callback><token>${TOKEN}</token></callback>\n</idd-system-message>`);
    writeFileSync(join(dir, "sent", "002-b.md"), "<idd-system-message>\n  <type>s1_revise</type>\n  <instruction>AC を &lt;観測できる&gt; 形に</instruction>\n</idd-system-message>");
    writeFileSync(join(dir, "inflight", "003-c.md"), "テストも見てください");
    writeFileSync(join(dir, "turns.jsonl"), jsonl([
      { n: 1, message: "001-a.md", resume: false, started_at: "2026-09-25T01:00:00.000Z", ended_at: "2026-09-25T01:05:00.000Z", status: "done", reached: true, reported_cost: 0.2 },
      { n: 2, message: "002-b.md", resume: true, started_at: "2026-09-25T01:10:00.000Z", ended_at: "2026-09-25T01:12:00.000Z", status: "failed", reached: true, reported_cost: 0.5, error: "exit 1" },
    ]));
    writeFileSync(join(dir, "turns", "1.jsonl"), jsonl([assistant([{ type: "tool_use", name: "Read", input: { file_path: "/wt/lane/a.md" } }]), assistant([{ type: "text", text: "下調べ完了" }])]));
    writeFileSync(join(dir, "turns", "2.jsonl"), jsonl([assistant([{ type: "text", text: "直します" }])]));
    writeFileSync(join(dir, "inflight.json"), JSON.stringify({ n: 3, message: "003-c.md", resume: true, started_at: "2026-09-25T01:20:00.000Z" }));
    writeFileSync(join(dir, "turns", "3.jsonl"), jsonl([assistant([{ type: "tool_use", name: "Bash", input: { command: "npm test" } }])]));
    // the supervisor feeding it holds the conversation's lock
    writeFileSync(join(dir, "conversation.lock"), JSON.stringify({ pid: process.pid, start: null, nonce: "n" }));

    const turns = conversationTranscript("L1");
    expect(turns.map((t) => [t.n, t.status])).toEqual([[1, "done"], [2, "failed"], [3, "running"]]);
    expect(turns[0].sent).toEqual({ type: "s1_prep_start", text: "" });
    expect(turns[1].sent).toEqual({ type: "s1_revise", text: "AC を <観測できる> 形に" });
    expect(turns[2].sent).toEqual({ text: "テストも見てください" });
    expect(turns[0].entries).toEqual([{ kind: "tool", tool: "Read", body: "a.md" }, { kind: "text", body: "下調べ完了" }]);
    // --resume reports the conversation's running total, so a reply's own cost is the step
    expect(turns[0].cost).toBe(0.2);
    expect(turns[1].cost).toBe(0.3);
    expect(turns[1].error).toBe("exit 1");
    expect(turns[2].cost).toBeUndefined();
    expect(turns[2].ended_at).toBeUndefined();
    expect(turns[2].entries).toEqual([{ kind: "tool", tool: "Bash", body: "npm test" }]);
    expect(JSON.stringify(turns)).not.toContain(TOKEN);
  });

  test("a reply a dead supervisor left half done is not shown as running", () => {
    const root = stateRoot();
    const dir = lane(root, "L4", { mode: "conversation", status: "running" });
    mkdirSync(join(dir, "turns"));
    writeFileSync(join(dir, "inflight.json"), JSON.stringify({ n: 1, message: "001-a.md", resume: false, started_at: "2026-09-25T01:20:00.000Z" }));
    writeFileSync(join(dir, "turns", "1.jsonl"), jsonl([assistant([{ type: "text", text: "途中" }])]));
    const [turn] = conversationTranscript("L4");
    expect(turn.status).toBe("interrupted");
    expect(turn.entries).toEqual([{ kind: "text", body: "途中" }]);
  });

  test("a long reply keeps its last moves and counts the ones left out; only the last replies are kept", () => {
    const root = stateRoot();
    const dir = lane(root, "L2", { mode: "conversation", status: "idle" });
    mkdirSync(join(dir, "turns"));
    const rows = [];
    for (let n = 1; n <= 4; n += 1) {
      rows.push({ n, message: `m${n}.md`, resume: n > 1, started_at: `2026-09-25T0${n}:00:00.000Z`, ended_at: `2026-09-25T0${n}:01:00.000Z`, status: "done", reached: true });
      writeFileSync(join(dir, "turns", `${n}.jsonl`), jsonl(Array.from({ length: 10 }, (_, i) => assistant([{ type: "text", text: `r${n}-${i}` }]))));
    }
    writeFileSync(join(dir, "turns.jsonl"), jsonl(rows));
    const turns = conversationTranscript("L2", { maxTurns: 2, maxEntries: 3 });
    expect(turns.map((t) => t.n)).toEqual([3, 4]);
    expect(turns[1].entries.map((e) => e.body)).toEqual(["r4-7", "r4-8", "r4-9"]);
    expect(turns[1].omitted).toBe(7);
    // a message file that is gone still leaves the reply
    expect(turns[1].sent).toEqual({ text: "" });
  });

  test("a reply after one that reported no cost says its cost may carry that one's", () => {
    const root = stateRoot();
    const dir = lane(root, "L5", { mode: "conversation", status: "idle" });
    mkdirSync(join(dir, "turns"));
    const t = (n: number, extra: Record<string, unknown>) => ({ n, message: `m${n}.md`, resume: n > 1, started_at: `2026-09-25T0${n}:00:00.000Z`, ended_at: `2026-09-25T0${n}:01:00.000Z`, reached: true, ...extra });
    writeFileSync(join(dir, "turns.jsonl"), jsonl([t(1, { status: "done", reported_cost: 0.2 }), t(2, { status: "failed", error: "exit 1" }), t(3, { status: "done", reported_cost: 0.9 })]));
    const turns = conversationTranscript("L5");
    expect(turns.map((x) => [x.n, x.cost, x.costCarried])).toEqual([[1, 0.2, undefined], [2, undefined, undefined], [3, 0.7, true]]);
  });

  test("a lane with no replies yet has none", () => {
    const root = stateRoot();
    lane(root, "L3", { mode: "conversation", status: "idle" });
    expect(conversationTranscript("L3")).toEqual([]);
  });
});

describe("a short stage's run on Claude Code", () => {
  test("is one reply: the run's title, its stream and its API-equivalent cost", () => {
    const root = stateRoot();
    const dir = lane(root, "R1", { role: "blind-reviewer-opus", title: "#7 blind", status: "done", ended_at: "2026-09-25T01:09:00.000Z", usage: { input: 1, output: 2, cost: 0.61 }, role_preset: { harness: "claude" } });
    writeFileSync(join(dir, "events.jsonl"), jsonl([assistant([{ type: "tool_use", name: "Read", input: { file_path: "/wt/lane/pay.ts" } }])]));
    const t = runTranscript("R1");
    expect(t).toEqual({ n: 1, started_at: "2026-09-25T01:00:00.000Z", ended_at: "2026-09-25T01:09:00.000Z", status: "done", sent: { text: "#7 blind" }, entries: [{ kind: "tool", tool: "Read", body: "pay.ts" }], omitted: 0, cost: 0.61 });
  });

  test("a run whose supervisor and process are gone is not running, though its record still says so", () => {
    const root = stateRoot();
    const dead = spawnSync("true").pid as number;
    lane(root, "R3", { title: "R3", status: "running", supervisor_pid: dead, pid: dead, role_preset: { harness: "claude" } });
    expect(runTranscript("R3")?.status).toBe("interrupted");
    // a record with no process yet counts as starting only for a short while
    lane(root, "R4", { title: "R4", status: "running", started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), role_preset: { harness: "claude" } });
    expect(runTranscript("R4")?.status).toBe("interrupted");
    lane(root, "R5", { title: "R5", status: "running", started_at: new Date().toISOString(), role_preset: { harness: "claude" } });
    expect(runTranscript("R5")?.status).toBe("running");
  });

  test("a run still going has no end yet", () => {
    const root = stateRoot();
    lane(root, "R2", { title: "R2", status: "running", supervisor_pid: process.pid, role_preset: { harness: "claude" } });
    const t = runTranscript("R2");
    expect(t?.status).toBe("running");
    expect(t?.ended_at).toBeUndefined();
  });

  test("an unknown run is none", () => {
    stateRoot();
    expect(runTranscript("nope")).toBeNull();
  });
});

describe("idd lane tail", () => {
  test("reads a Claude Code run's stream, not only pi's", () => {
    const root = stateRoot();
    const dir = lane(root, "T1", { status: "done", role_preset: { harness: "claude" } });
    writeFileSync(join(dir, "events.jsonl"), jsonl([
      assistant([{ type: "tool_use", name: "Bash", input: { command: `curl -H "Authorization: Bearer ${TOKEN}" x` } }]),
      assistant([{ type: "text", text: "見終わりました" }]),
    ]));
    const out = laneTail("T1");
    expect(out).toContain("[tool] Bash curl");
    expect(out).toContain("[assistant] 見終わりました");
    expect(out).not.toContain(TOKEN);
  });

  test("reads a conversation lane's replies in order", () => {
    const root = stateRoot();
    const dir = lane(root, "T2", { mode: "conversation", status: "idle" });
    mkdirSync(join(dir, "turns"));
    writeFileSync(join(dir, "turns", "2.jsonl"), jsonl([assistant([{ type: "text", text: "二つ目" }])]));
    writeFileSync(join(dir, "turns", "10.jsonl"), jsonl([assistant([{ type: "text", text: "十個目" }])]));
    writeFileSync(join(dir, "turns", "1.jsonl"), jsonl([assistant([{ type: "text", text: "一つ目" }])]));
    expect(laneTail("T2")).toBe("[assistant] 一つ目\n[assistant] 二つ目\n[assistant] 十個目");
  });

  test("hides the callback token wherever it appears, read from the env or from the state's token file", () => {
    const root = stateRoot();
    const dir = lane(root, "T4", { status: "done", role_preset: { harness: "claude" } });
    writeFileSync(join(dir, "events.jsonl"), jsonl([
      assistant([{ type: "tool_use", name: "Bash", input: { command: `T=${TOKEN}; curl -H "Authorization: Bearer $T" x` } }]),
      { type: "tool_execution_start", toolName: "bash", args: { command: `echo ${TOKEN}` } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `token ${TOKEN}` }] } },
    ]));
    const savedToken = process.env.IDD_AGENT_TOKEN;
    try {
      process.env.IDD_AGENT_TOKEN = TOKEN;
      expect(laneTail("T4")).not.toContain(TOKEN);
      delete process.env.IDD_AGENT_TOKEN;
      writeFileSync(join(root, "agent-token"), `${TOKEN}\n`);
      const out = laneTail("T4");
      expect(out).not.toContain(TOKEN);
      expect(out).toContain("T=…");
    } finally {
      if (savedToken === undefined) delete process.env.IDD_AGENT_TOKEN;
      else process.env.IDD_AGENT_TOKEN = savedToken;
    }
  });

  test("a pi run reads as before", () => {
    const root = stateRoot();
    const dir = lane(root, "T3", { status: "done" });
    writeFileSync(join(dir, "events.jsonl"), jsonl([
      { type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ]));
    expect(laneTail("T3")).toBe('[tool] read {"path":"a.ts"}\n[assistant] ok');
  });
});
