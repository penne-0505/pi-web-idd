/**
 * The conversation's read-only door and who gets it. The tool's range is the CLI's list, so the tests check the
 * refusals it inherits (AC-004), that a read answers with the CLI's lines, and that only a chat mode's own
 * conversation is started with the tool (AC-003, AC-006).
 */
import { describe, expect, test } from "bun:test";

import { conversationPiArgs, usesPropterRead } from "../src/server/conversations.ts";
import { PROPTER_READ_TOOL_NAME, runPropterRead } from "../src/server/pi-extensions/propter-read.ts";
import registerPropterRead from "../src/server/pi-extensions/propter-read.ts";
import type { ModeStartPlan } from "@idd/lane";

const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

function plan(): ModeStartPlan {
  return {
    mode: { name: "chat", label: "会話", role: "chat", workspace: "/w", cwd: "/w", memory: "/w/memory" },
    role: { name: "chat", tools: ["read", "bash"], model: "openrouter/x", thinking: "high" } as unknown as ModeStartPlan["role"],
    cwd: "/w",
    toolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    initialModel: { provider: "openrouter", modelId: "x" },
    thinkingLevel: "high" as ModeStartPlan["thinkingLevel"],
    agentDir: "/a",
  };
}

describe("the conversation's read-only tool is only a chat mode's own", () => {
  test("a chat conversation gets the extension and the tool name in --tools", () => {
    const args = conversationPiArgs(plan(), "s1", null, undefined, undefined, { propterRead: true });
    expect(args.filter((a) => a === "--extension").length).toBe(2);
    expect(args.some((a) => a.endsWith("propter-read.ts"))).toBe(true);
    const tools = args[args.indexOf("--tools") + 1].split(",");
    expect(tools).toContain(PROPTER_READ_TOOL_NAME);
    // the role's own list is untouched (DEC-2010): the tool rides in --tools alone, never in the mode's tools
    expect(tools.slice(0, 7)).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  });

  test("a conversation that does not ask carries neither the extension nor the name", () => {
    const args = conversationPiArgs(plan(), "s1", null, undefined, undefined, {});
    expect(args.filter((a) => a === "--extension").length).toBe(1);
    expect(args.some((a) => a.endsWith("propter-read.ts"))).toBe(false);
    expect(args[args.indexOf("--tools") + 1]).not.toContain(PROPTER_READ_TOOL_NAME);
  });

  test("a consultation or a BTW branch is ephemeral, so no branch gets it; another mode does not either", () => {
    expect(usesPropterRead("chat", false)).toBe(true);
    expect(usesPropterRead("chat", true)).toBe(false);
    expect(usesPropterRead("idea", false)).toBe(false);
  });
});

describe("the read-only tool runs only the CLI's reads", () => {
  test("a write verb or an unknown name is refused and nothing runs", async () => {
    let called = false;
    const deps = { fetch: (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch, baseUrl: () => "http://x" };
    for (const bad of ["decide", "out", "intent", "report", "order"]) {
      const result = await runPropterRead({ command: bad, args: ["IDD-1"] }, deps);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("読み取りの command ではありません");
    }
    expect(called).toBe(false);
  });

  test("a writing flag and a shell character are refused before anything runs", async () => {
    let called = false;
    const deps = { fetch: (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch, baseUrl: () => "http://x" };
    const flag = await runPropterRead({ command: "lane", args: ["IDD-1", "--approve"] }, deps);
    expect(flag.isError).toBe(true);
    expect(flag.text).toContain("知らない flag");
    const shell = await runPropterRead({ command: "lanes", args: ["; rm -rf /"] }, deps);
    expect(shell.isError).toBe(true);
    expect(shell.text).toContain("shell の文字");
    const piped = await runPropterRead({ command: "ledger", args: ["--lane", "IDD-1|cat"] }, deps);
    expect(piped.isError).toBe(true);
    expect(called).toBe(false);
  });

  test("a read answers with the CLI's lines, never a stack trace", async () => {
    const deps = { fetch: respond({ lanes: [{ iddId: "IDD-167", title: "通常の会話", group: "impl" }], items: [] }), baseUrl: () => "http://x" };
    const result = await runPropterRead({ command: "lanes" }, deps);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("IDD-167");
  });
});

describe("the extension registers the tool pi's --tools names", () => {
  test("registerTool is called with the name and a command parameter, and execute refuses a write verb", async () => {
    const tools: { name: string; parameters: { required?: string[]; properties?: Record<string, unknown> }; execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }[] = [];
    registerPropterRead({ registerTool: (tool) => tools.push(tool as unknown as typeof tools[number]) });
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe(PROPTER_READ_TOOL_NAME);
    expect(tools[0].parameters.required).toContain("command");
    const result = await tools[0].execute("c1", { command: "decide", args: ["IDD-1"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("読み取りの command ではありません");
  });
});
