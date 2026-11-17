import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import registerIntentInject, { ASK_NEXT_MESSAGE, ASK_SEND_UNKNOWN, CLI_TIMEOUT_MS, askSendTimeoutMs, type PiIntentApi } from "../src/pi-extensions/intent-inject.ts";

interface Call {
  command: string;
  args: string[];
  input: Record<string, unknown> | null;
  /** the limit the bridge handed `pi.exec`, when it named one */
  timeout?: number;
}

/** what `pi.exec` answered, and the inputs the bridge handed the CLI */
interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/**
 * A stand-in for pi's extension API: it records the handlers and the tool the extension registers, and it can be
 * told what `pi.exec` answers. The CLI's input file is read back here, so the test sees exactly what the bridge
 * asked the verb to judge.
 */
class FakePi implements PiIntentApi {
  handlers = new Map<string, ((event: never) => unknown)[]>();
  tools: { name: string; promptSnippet?: string; promptGuidelines?: string[]; execute: (...a: never[]) => unknown }[] = [];
  calls: Call[] = [];
  answer: (input: Record<string, unknown>, call: Call) => ExecResult | Promise<ExecResult> = () => ({ stdout: "", stderr: "", code: 0, killed: false });

  on(event: string, handler: (event: never) => unknown): unknown {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return () => {};
  }

  registerTool(tool: never): void {
    this.tools.push(tool);
  }

  async exec(command: string, args: string[], options?: { timeout?: number; cwd?: string }): Promise<ExecResult> {
    const at = args.indexOf("--input") >= 0 ? args.indexOf("--input") : args.indexOf("--file");
    const input = at >= 0 ? (JSON.parse(readFileSync(args[at + 1], "utf8")) as Record<string, unknown>) : null;
    const call: Call = { command, args, input, ...(typeof options?.timeout === "number" ? { timeout: options.timeout } : {}) };
    this.calls.push(call);
    return await this.answer(input ?? {}, call);
  }

  /** send one event to the extension's handlers and return the first non-undefined answer */
  async fire(event: string, payload: Record<string, unknown>): Promise<unknown> {
    let answer: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      const out = await (handler as unknown as (e: unknown) => unknown)(payload);
      if (out !== undefined) answer = out;
    }
    return answer;
  }
}

const saved = { cli: process.env.IDD_INTENT_CLI, session: process.env.PI_SESSION_ID, ask: process.env.IDD_ASK, retry: process.env.IDD_REPORT_RETRY_MS, interval: process.env.IDD_REPORT_RETRY_INTERVAL_MS };
afterEach(() => {
  if (saved.cli === undefined) delete process.env.IDD_INTENT_CLI; else process.env.IDD_INTENT_CLI = saved.cli;
  if (saved.session === undefined) delete process.env.PI_SESSION_ID; else process.env.PI_SESSION_ID = saved.session;
  if (saved.ask === undefined) delete process.env.IDD_ASK; else process.env.IDD_ASK = saved.ask;
  if (saved.retry === undefined) delete process.env.IDD_REPORT_RETRY_MS; else process.env.IDD_REPORT_RETRY_MS = saved.retry;
  if (saved.interval === undefined) delete process.env.IDD_REPORT_RETRY_INTERVAL_MS; else process.env.IDD_REPORT_RETRY_INTERVAL_MS = saved.interval;
});

function bridge(pi = new FakePi()): FakePi {
  process.env.IDD_INTENT_CLI = "/fake/idd";
  process.env.PI_SESSION_ID = "pi-session-1";
  delete process.env.IDD_ASK;
  registerIntentInject(pi);
  return pi;
}

/** a bridge with the supervisor's mark: the one place the `ask` tool appears */
function askBridge(pi = new FakePi()): FakePi {
  process.env.IDD_INTENT_CLI = "/fake/idd";
  process.env.PI_SESSION_ID = "pi-session-1";
  process.env.IDD_ASK = "1";
  registerIntentInject(pi);
  return pi;
}

const READ_RESULT = { type: "tool_result", toolName: "read", toolCallId: "c1", input: { path: "src/a.ts" }, content: [{ type: "text", text: "FILE BODY" }], isError: false };
const EDIT_CALL = { type: "tool_call", toolName: "edit", toolCallId: "c2", input: { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] } };
const EDIT_RESULT = { type: "tool_result", toolName: "edit", toolCallId: "c2", input: { path: "src/a.ts" }, content: [{ type: "text", text: "EDIT OK" }], isError: false };

describe("the pi injection bridge", () => {
  test("AC-018: a CLI that fails, throws or is cut leaves the tool result exactly as it was", async () => {
    for (const answer of [
      () => ({ stdout: "", stderr: "boom", code: 1, killed: false }),
      () => { throw new Error("spawn failed"); },
      () => ({ stdout: "", stderr: "", code: -1, killed: true }),
    ]) {
      const pi = bridge();
      pi.answer = answer;
      await pi.fire("tool_call", EDIT_CALL);
      const edited = await pi.fire("tool_result", EDIT_RESULT);
      expect(edited).toBeUndefined();
      const read = await pi.fire("tool_result", READ_RESULT);
      expect(read).toBeUndefined();
      // the handlers themselves never threw, and no handler asked pi to block
      expect(pi.handlers.get("tool_call")?.length).toBe(1);
    }
  });

  test("AC-018: the bridge appends the body to a read result and keeps what was there", async () => {
    const pi = bridge();
    pi.answer = (input) => (input.idd_mode === "record" ? { stdout: "", stderr: "", code: 0, killed: false } : { stdout: JSON.stringify({ text: "<propter-intent>DEC-1</propter-intent>", rows: [{ event: "read", path: "src/a.ts" }] }), stderr: "", code: 0, killed: false });
    const out = (await pi.fire("tool_result", READ_RESULT)) as { content: { type: string; text: string }[] };
    expect(out.content.length).toBe(2);
    expect(out.content[0].text).toBe("FILE BODY");
    expect(out.content[1].text).toContain("DEC-1");
  });

  test("AC-018: a failed read does not call the CLI, and a compaction calls it once with the compact input", async () => {
    const pi = bridge();
    pi.answer = () => ({ stdout: "", stderr: "", code: 0, killed: false });
    await pi.fire("tool_result", { ...READ_RESULT, isError: true });
    expect(pi.calls.length).toBe(0);
    await pi.fire("session_compact", { type: "session_compact" });
    expect(pi.calls.length).toBe(1);
    expect(pi.calls[0].input?.hook_event_name).toBe("Compact");
    expect(pi.calls[0].args).toContain("intent");
    // and the wait is bounded
    expect(CLI_TIMEOUT_MS).toBe(5000);
  });

  test("AC-024: the extension registers intent_lookup, which runs the read verb on its paths", async () => {
    const pi = bridge();
    const choices = [{ id: "DEC-1", place: { kind: "file" } }, { id: "DEC-2", place: { kind: "dir" } }, { id: "DEC-3", place: { kind: "root" } }];
    pi.answer = (_input, call) => {
      if (call.args.includes("lookup")) return { stdout: JSON.stringify({ ok: true, choices }), stderr: "", code: 0, killed: false };
      return { stdout: "", stderr: "", code: 0, killed: false };
    };
    const tool = pi.tools.find((t) => t.name === "intent_lookup");
    expect(tool).toBeDefined();
    expect(tool?.promptSnippet).toContain("intent_lookup");
    const result = (await tool?.execute("t1", { paths: ["src/a.ts", "src/b.ts"] }, undefined, undefined, { cwd: "/wt" })) as { content: { text: string }[] };
    const call = pi.calls.find((c) => c.args.includes("lookup"));
    expect(call?.command).toBe("/fake/idd");
    expect(call?.args).toEqual(["intent", "lookup", "src/a.ts", "src/b.ts"]);
    const parsed = JSON.parse(result.content[0].text) as { choices: { place: { kind: string } }[] };
    expect(parsed.choices.map((c) => c.place.kind)).toEqual(["file", "dir", "root"]);
  });

  test("AC-004: the tool hands back the answer the CLI printed, text as it stands", async () => {
    const pi = bridge();
    // the CLI's default answer is the要点の文: the tool passes the stdout along unchanged, so the agent reads
    // the same words a person at a terminal reads
    const text = "Choice 2 件（このうち 1 件は file か dir の Place に当たる。本文で出す）\n- C-1-1 形\n  why: W\n";
    pi.answer = () => ({ stdout: text, stderr: "", code: 0, killed: false });
    const tool = pi.tools.find((t) => t.name === "intent_lookup");
    const result = (await tool?.execute("t1", { paths: ["src/a.ts"] }, undefined, undefined, { cwd: "/wt" })) as { content: { type: string; text: string }[] };
    expect(result.content).toEqual([{ type: "text", text: text.trim() }]);
    // no --json is passed: the default answer is the one the agent gets
    expect(pi.calls[0].args).toEqual(["intent", "lookup", "src/a.ts"]);
  });

  test("AC-024: when the CLI fails the tool fails and pi goes on", async () => {
    const pi = bridge();
    pi.answer = () => ({ stdout: "", stderr: "no engine", code: 3, killed: false });
    const tool = pi.tools.find((t) => t.name === "intent_lookup");
    await expect(tool?.execute("t1", { paths: ["src/a.ts"] })).rejects.toThrow("no engine");
  });

  test("AC-030: an edit is judged before the tool and recorded only after its result", async () => {
    const pi = bridge();
    pi.answer = (input) => {
      if (input.idd_mode === "plan") {
        return { stdout: JSON.stringify({ text: "<propter-intent>hit</propter-intent>", rows: [{ event: "edit", path: "src/a.ts", choices: [{ id: "DEC-1", form: "notice", status: "active", body: true }] }] }), stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    };
    await pi.fire("tool_call", EDIT_CALL);
    // judged, but nothing recorded yet
    expect(pi.calls.map((c) => c.input?.idd_mode)).toEqual(["plan"]);
    const out = (await pi.fire("tool_result", EDIT_RESULT)) as { content: { text: string }[] };
    expect(out.content[1].text).toContain("hit");
    // the record call comes after the result, and carries the rows the judge produced
    const modes = pi.calls.map((c) => c.input?.idd_mode);
    expect(modes[modes.length - 1]).toBe("record");
    const record = pi.calls[pi.calls.length - 1].input as { idd_rows: { event: string }[] };
    expect(record.idd_rows[0].event).toBe("edit");
    // a tool_call whose result never arrives leaves no record at all
    const other = bridge();
    other.answer = pi.answer;
    await other.fire("tool_call", EDIT_CALL);
    expect(other.calls.map((c) => c.input?.idd_mode)).toEqual(["plan"]);
  });

  test("AC-030: a failed edit still gets the notice and a record row", async () => {
    const pi = bridge();
    pi.answer = (input) => (input.idd_mode === "plan"
      ? { stdout: JSON.stringify({ text: "NOTICE", rows: [{ event: "edit", path: "src/a.ts" }] }), stderr: "", code: 0, killed: false }
      : { stdout: "", stderr: "", code: 0, killed: false });
    await pi.fire("tool_call", EDIT_CALL);
    const out = (await pi.fire("tool_result", { ...EDIT_RESULT, isError: true })) as { content: { text: string }[] };
    expect(out.content.some((c) => c.text === "NOTICE")).toBe(true);
    expect(pi.calls.some((c) => c.input?.idd_mode === "record")).toBe(true);
  });

  test("INV-111-6: the ask tool is registered only with the supervisor's mark in the environment", () => {
    expect(bridge().tools.map((t) => t.name)).toEqual(["intent_lookup"]);
    expect(askBridge().tools.map((t) => t.name)).toEqual(["intent_lookup", "ask"]);
  });

  test("AC-004 / AC-024: ask sends the questions through the CLI, carries the batch id in the dialog's title, and returns the answer's body", async () => {
    const pi = askBridge();
    const stdout = `{\n  "ok": true,\n  "batch_id": "batch-7",\n  "question_count": 1\n}\nここで作業を止め、turn を終えてください。答えは次の message で届きます。\n`;
    pi.answer = () => ({ stdout, stderr: "", code: 0, killed: false });
    const tool = pi.tools.find((t) => t.name === "ask");
    expect(tool).toBeDefined();
    expect(tool?.promptGuidelines?.join("\n")).toContain("question_id");
    const asked: { title: string; placeholder?: string }[] = [];
    const ctx = { cwd: "/wt", hasUI: true, ui: { input: async (title: string, placeholder?: string) => { asked.push({ title, placeholder }); return '<answers batch-id="batch-7">body</answers>'; } } };
    const result = (await tool?.execute("t1", { questions: [{ question_id: "q1", question: "Q", options: [{ index: 1, label: "A", recommendation: "recommended", rationale: "r" }] }] }, undefined, undefined, ctx)) as { content: { text: string }[] };
    const call = pi.calls.find((c) => c.args.includes("questions"));
    expect(call?.command).toBe("/fake/idd");
    expect(call?.args.slice(0, 3)).toEqual(["report", "questions", "--file"]);
    expect((call?.input as { questions: unknown[] }).questions).toHaveLength(1);
    expect(asked[0].title).toBe(JSON.stringify({ idd: "ask", batch_id: "batch-7" }));
    expect(result.content[0].text).toContain('<answers batch-id="batch-7">');
    // the CLI's end-of-turn line is not shown to the agent: the tool waited, so the line would be wrong
    expect(result.content[0].text).not.toContain("turn を終えて");
  });

  test("AC-006: a question the CLI refuses comes back as the result, and no dialog goes out", async () => {
    const pi = askBridge();
    pi.answer = () => ({ stdout: "", stderr: "質問の形が正しくありません: questions[0]: options must be an array", code: 2, killed: false });
    const tool = pi.tools.find((t) => t.name === "ask");
    let asked = 0;
    const ctx = { hasUI: true, ui: { input: async () => { asked += 1; return "x"; } } };
    const result = (await tool?.execute("t1", { questions: [{ question_id: "q1", question: "Q", options: [] }] }, undefined, undefined, ctx)) as { content: { text: string }[] };
    expect(result.content[0].text).toContain("質問の形が正しくありません");
    expect(asked).toBe(0);
  });

  test("AC-017: an ask that cannot wait returns the guidance without failing, and the questions were sent", async () => {
    const pi = askBridge();
    const questions = [{ question_id: "q1", question: "Q", options: [{ index: 1, label: "A" }] }];
    const tool = pi.tools.find((t) => t.name === "ask");
    const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
    // the dialog is cancelled, as a stopping reply does
    pi.answer = () => ({ stdout: `{\n  "batch_id": "b1"\n}\n`, stderr: "", code: 0, killed: false });
    expect(textOf(await tool?.execute("t1", { questions }, undefined, undefined, { hasUI: true, ui: { input: async () => undefined } }))).toBe(ASK_NEXT_MESSAGE);
    // the harness has no UI to put the question to
    expect(textOf(await tool?.execute("t2", { questions }, undefined, undefined, { hasUI: false, ui: { input: async () => "x" } }))).toBe(ASK_NEXT_MESSAGE);
    // the CLI's stdout has no readable batch id
    pi.answer = () => ({ stdout: "not json\n", stderr: "", code: 0, killed: false });
    expect(textOf(await tool?.execute("t3", { questions }, undefined, undefined, { hasUI: true, ui: { input: async () => "x" } }))).toBe(ASK_NEXT_MESSAGE);
    expect(pi.calls.filter((c) => c.args.includes("questions")).length).toBe(3);
  });

  test("AC-018: the ask send waits out the CLI's replacement window, while a judging call keeps the short limit", async () => {
    process.env.IDD_REPORT_RETRY_MS = "20000";
    process.env.IDD_REPORT_RETRY_INTERVAL_MS = "1000";
    expect(askSendTimeoutMs()).toBeGreaterThan(20000);
    const pi = askBridge();
    const tool = pi.tools.find((t) => t.name === "ask");
    pi.answer = () => ({ stdout: `{\n  "batch_id": "b1"\n}\n`, stderr: "", code: 0, killed: false });
    await tool?.execute("t1", { questions: [{ question_id: "q1", question: "Q", options: [{ index: 1, label: "A" }] }] }, undefined, undefined, { hasUI: false, ui: { input: async () => "x" } });
    const call = pi.calls.find((c) => c.args.includes("questions"));
    expect(call?.timeout).toBe(askSendTimeoutMs());
    expect(call?.timeout).toBeGreaterThan(20000);
  });

  test("AC-019: an ask whose send call was cut does not say the answer is on its way", async () => {
    const pi = askBridge();
    const tool = pi.tools.find((t) => t.name === "ask");
    // pi's exec cuts a timed-out call with `killed: true` and code 0, so stdout reads as an empty success
    pi.answer = () => ({ stdout: "", stderr: "", code: 0, killed: true });
    let asked = 0;
    const ctx = { hasUI: true, ui: { input: async () => { asked += 1; return "x"; } } };
    const result = (await tool?.execute("t1", { questions: [{ question_id: "q1", question: "Q", options: [{ index: 1, label: "A" }] }] }, undefined, undefined, ctx)) as { content: { text: string }[] };
    expect(result.content[0].text).not.toBe(ASK_NEXT_MESSAGE);
    expect(result.content[0].text).toBe(ASK_SEND_UNKNOWN);
    expect(result.content[0].text).toContain("idd report questions");
    expect(asked).toBe(0, "no dialog goes out for a send that may not have landed");
  });
});
