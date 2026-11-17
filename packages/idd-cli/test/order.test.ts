import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { formatOrder, runOrderCommand } from "../src/order.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

const LANES = [
  { idd_id: "IDD-002", title: "second", area: "demo", position: 1, urgent: true, placed: true, awaiting: "planner" },
  { idd_id: "IDD-001", title: "first", area: "demo", position: 2, urgent: false, placed: true, awaiting: "executor" },
  { idd_id: "IDD-003", title: "third", area: "demo", position: 3, urgent: false, placed: false, awaiting: null },
];
const VIEW = { ok: true, lanes: LANES };

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, deps: { stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) } };
}

/** a fetch that records the requests and answers with the given response */
function recorder(response = { status: 200, body: VIEW }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return new Response(JSON.stringify(response.body), { status: response.status });
  }) as unknown as typeof fetch;
  return { calls, fn };
}

describe("idd order", () => {
  test("reads the order and prints the table (AC-016)", async () => {
    const c = capture();
    const r = recorder();
    const code = await runOrderCommand([], { ...c.deps, baseUrl: () => "http://127.0.0.1:0", fetch: r.fn });
    expect(code).toBe(0);
    expect(r.calls[0].url).toContain("/api/idd/order");
    const text = c.stdout.join("");
    expect(text).toContain("IDD-002");
    expect(text).toContain("急");
    expect(text).toContain("計画役待ち");
    expect(text).toContain("実装役待ち");
  });

  test("--json prints the response as it is (AC-016)", async () => {
    const c = capture();
    const r = recorder();
    const code = await runOrderCommand(["--json"], { ...c.deps, baseUrl: () => "http://127.0.0.1:0", fetch: r.fn });
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(""));
    expect(parsed.lanes[0].idd_id).toBe("IDD-002");
  });

  test("move, urgent and unurgent post the verb, and print the new table (AC-016)", async () => {
    for (const [args, body] of [
      [["move", "IDD-003", "--to", "1"], { action: "move", idd_id: "IDD-003", position: 1 }],
      [["move", "IDD-003", "--before", "IDD-001"], { action: "move", idd_id: "IDD-003", before: "IDD-001" }],
      [["move", "IDD-003", "--after", "IDD-001"], { action: "move", idd_id: "IDD-003", after: "IDD-001" }],
      [["move", "IDD-003", "--first"], { action: "move", idd_id: "IDD-003", position: 1 }],
      [["urgent", "IDD-001"], { action: "urgent", idd_id: "IDD-001" }],
      [["unurgent", "IDD-001"], { action: "unurgent", idd_id: "IDD-001" }],
    ]) {
      const c = capture();
      const r = recorder();
      const code = await runOrderCommand(args, { ...c.deps, baseUrl: () => "http://127.0.0.1:0", fetch: r.fn });
      expect(code).toBe(0);
      expect(r.calls.length).toBe(1);
      expect(r.calls[0].init?.method).toBe("POST");
      expect(JSON.parse(String(r.calls[0].init?.body))).toEqual(body);
      expect(c.stdout.join("")).toContain("IDD-002");
    }
    // --last sends a position past any list
    const c = capture();
    const r = recorder();
    await runOrderCommand(["move", "IDD-003", "--last"], { ...c.deps, baseUrl: () => "http://127.0.0.1:0", fetch: r.fn });
    const sent = JSON.parse(String(r.calls[0].init?.body));
    expect(sent.action).toBe("move");
    expect(sent.position).toBeGreaterThan(1000);
  });

  test("a malformed command is answered with the usage and nothing is sent (AC-016)", async () => {
    for (const args of [
      ["jump"],
      ["move"],
      ["move", "--to", "1"],
      ["move", "IDD-001"],
      ["move", "IDD-001", "--to", "0"],
      ["move", "IDD-001", "--to", "x"],
      ["move", "IDD-001", "--to", "1", "--before", "IDD-002"],
      ["move", "IDD-001", "--before"],
      ["urgent"],
    ]) {
      const c = capture();
      const r = recorder();
      const code = await runOrderCommand(args, { ...c.deps, baseUrl: () => "http://127.0.0.1:0", fetch: r.fn });
      expect(code).toBe(2);
      expect(r.calls.length).toBe(0);
      expect(c.stderr.join("")).toContain("usage: idd order");
    }
  });

  test("a refusal from the engine ends 1 with its reason (AC-016)", async () => {
    const c = capture();
    const r = recorder({ status: 400, body: { ok: false, error: "IDD-999 は backlog にありません" } });
    const code = await runOrderCommand(["urgent", "IDD-999"], { ...c.deps, baseUrl: () => "http://127.0.0.1:0", fetch: r.fn });
    expect(code).toBe(1);
    expect(c.stderr.join("")).toContain("IDD-999");
  });

  test("an engine that is down gives the wording, not a stack trace (AC-016)", async () => {
    const c = capture();
    const fn = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const code = await runOrderCommand([], { ...c.deps, baseUrl: () => "http://127.0.0.1:0", fetch: fn });
    expect(code).toBe(1);
    expect(c.stderr.join("")).toContain("engine に繋がりません");
  });

  test("the CLI touches no state directory (AC-016)", async () => {
    const dir = tmpDir("idd-cli-order-");
    const state = join(dir, "state");
    const saved = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = state;
    try {
      const c = capture();
      const r = recorder();
      expect(await runOrderCommand(["--json"], { ...c.deps, baseUrl: () => "http://127.0.0.1:0", fetch: r.fn })).toBe(0);
      expect(await runOrderCommand(["move", "IDD-003", "--to", "1"], { ...c.deps, baseUrl: () => "http://127.0.0.1:0", fetch: r.fn })).toBe(0);
      expect(existsSync(state)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.IDD_STATE_DIR;
      else process.env.IDD_STATE_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("formatOrder names an empty list", () => {
    expect(formatOrder([])).toEqual(["開いている lane はありません"]);
  });
});
