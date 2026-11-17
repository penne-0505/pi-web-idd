import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { runLaneCommand } from "../src/lane-commands.ts";

const savedEnv = {
  IDD_ID: process.env.IDD_ID,
  IDD_SESSION_ID: process.env.IDD_SESSION_ID,
  IDD_SESSION_TOKEN: process.env.IDD_SESSION_TOKEN,
  IDD_AGENT_TOKEN: process.env.IDD_AGENT_TOKEN,
  IDD_AGENT_BASE_URL: process.env.IDD_AGENT_BASE_URL,
  IDD_STATE_DIR: process.env.IDD_STATE_DIR,
};
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Received { method: string; path: string; auth?: string; sessionToken?: string; body: Record<string, unknown> }

async function fakeServer(replies: { status: number; body: unknown }[] = []) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      received.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, sessionToken: req.headers["x-idd-session-token"] as string | undefined, body: raw ? JSON.parse(raw) : {} });
      const reply = replies.shift() ?? { status: 200, body: { ok: true } };
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { received, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function capture(fn: () => Promise<number | undefined>): Promise<{ code: number | undefined; out: string; err: string }> {
  const w = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try {
    return { code: await fn(), out, err };
  } finally {
    process.stdout.write = w;
    process.stderr.write = e;
  }
}

/** a conversation's agent: its own session and the credential the engine gave it in the environment, the token, no lane */
function conversation(url: string) {
  delete process.env.IDD_ID;
  process.env.IDD_SESSION_ID = "conv-1";
  process.env.IDD_SESSION_TOKEN = "credential-of-conv-1";
  process.env.IDD_AGENT_BASE_URL = url;
  process.env.IDD_AGENT_TOKEN = "token-for-the-instruction-test";
}

const run = (...argv: string[]) => capture(() => runLaneCommand("instruction", argv));

describe("idd instruction propose", () => {
  test("an add names its range and reaches the door as a proposal from the conversation's own session", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true, id: "INP-1", kind: "add", effect: "pending" } }]);
    try {
      conversation(server.url);
      const r = await run("propose", "add", "--text", "レビューは短く書く。", "--reason", "読まれないから", "--repo", "me/app,me/other", "--scene", "review,plan", "--place", "all");
      expect(r.code).toBe(0);
      expect(server.received).toHaveLength(1);
      expect(server.received[0]).toMatchObject({ method: "POST", path: "/api/idd/instruction", auth: "Bearer token-for-the-instruction-test", sessionToken: "credential-of-conv-1" });
      expect(server.received[0].body).toEqual({
        action: "propose", session: "conv-1",
        payload: { kind: "add", text: "レビューは短く書く。", reason: "読まれないから", scope: { repos: ["me/app", "me/other"], scenes: ["review", "plan"], places: "all" } },
      });
    } finally { await server.close(); }
  });

  test("without the conversation's own credential nothing is sent, even with the agent token and a session id", async () => {
    const server = await fakeServer();
    try {
      conversation(server.url);
      delete process.env.IDD_SESSION_TOKEN;
      const r = await run("propose", "retire", "--id", "INS-3", "--session", "someone-elses");
      expect(r.code).toBe(2);
      expect(r.err).toContain("会話の資格");
      expect(server.received).toHaveLength(0);
    } finally { await server.close(); }
  });

  test("an add without a declared range is refused before the door is called", async () => {
    const server = await fakeServer();
    try {
      conversation(server.url);
      const r = await run("propose", "add", "--text", "短く書く。", "--reason", "理由", "--repo", "all");
      expect(r.code).toBe(2);
      expect(r.err).toContain("範囲の宣言");
      expect(server.received).toHaveLength(0);
    } finally { await server.close(); }
  });

  test("a retire and a change name the instruction", async () => {
    const server = await fakeServer();
    try {
      conversation(server.url);
      expect((await run("propose", "retire", "--id", "INS-3")).code).toBe(0);
      expect((await run("propose", "change", "--id", "INS-3", "--text", "直した方針。")).code).toBe(0);
      expect(server.received.map((x) => x.body.payload)).toEqual([{ kind: "retire", target: "INS-3" }, { kind: "change", target: "INS-3", text: "直した方針。" }]);
    } finally { await server.close(); }
  });

  test("a change that names one axis of the range sends only that axis, so the others keep the instruction's value", async () => {
    const server = await fakeServer();
    try {
      conversation(server.url);
      expect((await run("propose", "change", "--id", "INS-3", "--scene", "review")).code).toBe(0);
      expect((await run("propose", "change", "--id", "INS-3", "--repo", "all", "--place", "lane")).code).toBe(0);
      expect(server.received.map((x) => x.body.payload)).toEqual([
        { kind: "change", target: "INS-3", scope: { scenes: ["review"] } },
        { kind: "change", target: "INS-3", scope: { repos: "all", places: ["lane"] } },
      ]);
    } finally { await server.close(); }
  });

  test("a lane's session proposes nothing: the CLI refuses before the door is called", async () => {
    const server = await fakeServer();
    try {
      conversation(server.url);
      process.env.IDD_ID = "IDD-9";
      const r = await run("propose", "add", "--text", "短く書く。", "--reason", "理由", "--repo", "all", "--scene", "all", "--place", "all");
      expect(r.code).toBe(2);
      expect(r.err).toContain("lane の session は方針の案を出せません");
      expect(server.received).toHaveLength(0);
    } finally { await server.close(); }
  });

  test("the door's refusal is printed and ends in a failure", async () => {
    const server = await fakeServer([{ status: 400, body: { ok: false, error: "方針は 1 文です" } }]);
    try {
      conversation(server.url);
      const r = await run("propose", "add", "--text", "一つ。二つ。", "--reason", "理由", "--repo", "all", "--scene", "all", "--place", "all");
      expect(r.code).toBe(1);
      expect(r.err).toContain("方針は 1 文です");
    } finally { await server.close(); }
  });

  test("there is no verb that approves or rejects a proposal", async () => {
    const server = await fakeServer();
    try {
      conversation(server.url);
      for (const verb of ["approve", "reject", "accept"]) {
        const r = await run(verb, "INP-1");
        expect(r.code).toBe(2);
      }
      expect(server.received).toHaveLength(0);
    } finally { await server.close(); }
  });
});

describe("idd instruction ledger and list", () => {
  test("the ledger is read through the engine, filtered by what was named, and printed a line each", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true, entries: [{ instruction: "INS-1" }], lines: ["2026-10-25T01:00:00.000Z INS-1 → lane IDD-1 の blind（範囲の照合）: 短く書く。（理由: 読まれないから）"] } }]);
    try {
      conversation(server.url);
      const r = await run("ledger", "--lane-id", "IDD-1", "--stage", "blind", "--limit", "5");
      expect(r.code).toBe(0);
      expect(server.received[0].method).toBe("GET");
      expect(server.received[0].path).toBe("/api/idd/instruction?op=ledger&lane=IDD-1&stage=blind&limit=5");
      expect(server.received[0].auth).toBeUndefined();
      expect(r.out).toContain("INS-1 → lane IDD-1 の blind");
    } finally { await server.close(); }
  });

  test("the list prints each instruction with its reason and range", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true, state: "ok", instructions: [{ id: "INS-1", text: "短く書く。", reason: "読まれないから", scope_text: "すべての repo / レビュー / どこでも" }] } }]);
    try {
      conversation(server.url);
      const r = await run("list");
      expect(r.code).toBe(0);
      expect(r.out).toContain("INS-1 短く書く。（理由: 読まれないから）[すべての repo / レビュー / どこでも]");
    } finally { await server.close(); }
  });
});

describe("idd instruction session", () => {
  test("an addition and an exclusion are filed as one proposal each, and nothing is sent to the marks door", async () => {
    const server = await fakeServer([
      { status: 200, body: { ok: true, session: "conv-1", add: ["INS-2"], exclude: [] } },
      { status: 200, body: { ok: true, id: "INP-1", kind: "session", effect: "pending" } },
      { status: 200, body: { ok: true, id: "INP-2", kind: "session", effect: "pending" } },
    ]);
    try {
      conversation(server.url);
      const r = await run("session", "conv-1", "--add", "INS-5", "--exclude", "INS-1");
      expect(r.code).toBe(0);
      expect(server.received[0].path).toBe("/api/idd/instruction?op=session&id=conv-1");
      expect(server.received.slice(1).map((x) => [x.method, x.path])).toEqual([["POST", "/api/idd/instruction"], ["POST", "/api/idd/instruction"]]);
      expect(server.received[1].body).toEqual({ action: "propose", payload: { kind: "session", op: "add", target: "INS-5", for_session: "conv-1" } });
      expect(server.received[2].body).toEqual({ action: "propose", payload: { kind: "session", op: "exclude", target: "INS-1", for_session: "conv-1" } });
      expect(server.received.some((x) => x.path.includes("/marks"))).toBe(false);
      expect(r.out).toContain("署名");
    } finally { await server.close(); }
  });

  test("clearing files a clear proposal for each id named", async () => {
    const server = await fakeServer([
      { status: 200, body: { ok: true, session: "conv-1", add: ["INS-2"], exclude: ["INS-1"] } },
      { status: 200, body: { ok: true, id: "INP-1" } },
      { status: 200, body: { ok: true, id: "INP-2" } },
    ]);
    try {
      conversation(server.url);
      expect((await run("session", "conv-1", "--clear", "INS-2,INS-1")).code).toBe(0);
      expect(server.received.slice(1).map((x) => (x.body as { payload: { op: string; target: string } }).payload)).toEqual([
        { kind: "session", op: "clear", target: "INS-2", for_session: "conv-1" },
        { kind: "session", op: "clear", target: "INS-1", for_session: "conv-1" },
      ]);
    } finally { await server.close(); }
  });

  test("naming no change shows what the session has and files nothing", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true, session: "conv-1", add: ["INS-2"], exclude: [] } }]);
    try {
      conversation(server.url);
      const r = await run("session", "conv-1");
      expect(r.code).toBe(0);
      expect(server.received).toHaveLength(1);
      expect(JSON.parse(r.out)).toEqual({ session: "conv-1", add: ["INS-2"], exclude: [] });
    } finally { await server.close(); }
  });
});
