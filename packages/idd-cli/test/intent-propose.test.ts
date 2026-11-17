import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runLaneCommand } from "../src/lane-commands.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

const savedEnv = {
  IDD_ID: process.env.IDD_ID,
  IDD_SESSION_ID: process.env.IDD_SESSION_ID,
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

interface Received {
  method: string;
  path: string;
  auth?: string;
  body: Record<string, unknown>;
}

async function fakeServer(replies: { status: number; body: unknown }[] = []) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      received.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
      const reply = replies.shift() ?? { status: 200, body: { ok: true } };
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    received,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
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

function jsonFile(body: unknown): string {
  const dir = tmpDir("idd-intent-propose-");
  const file = join(dir, "body.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
}

/** an outside call: no lane id, the token in the environment, the repo named on the command line */
function outside(url: string, state: string) {
  delete process.env.IDD_ID;
  delete process.env.IDD_SESSION_ID;
  process.env.IDD_AGENT_BASE_URL = url;
  process.env.IDD_AGENT_TOKEN = "token-for-the-propose-test";
  process.env.IDD_STATE_DIR = state;
}

describe("idd intent propose: the four kinds reach the door's payload", () => {
  test("AC-013: each kind is mapped to the door's action and body, and nothing is written to the state", async () => {
    const server = await fakeServer([
      { status: 200, body: { ok: true, id: "PROP-1", kind: "overview" } },
      { status: 200, body: { ok: true, id: "PROP-2", kind: "root_supersede" } },
      { status: 200, body: { ok: true, id: "PROP-3", kind: "root_reanchor" } },
      { status: 200, body: { ok: true, id: "PROP-4", kind: "harm_example" } },
    ]);
    try {
      const state = tmpDir("idd-intent-propose-state-");
      outside(server.url, state);
      const choice = { purpose: "P-1", forms: { chosen: "A2", rejected: [] }, place: [{ path: "a/b.ts", kind: "file" }], why: "w", anchored: "x", no_why_not: "無い" };
      const calls: [string[], unknown][] = [
        [["overview"], { statement: "新しい概要" }],
        [["root-supersede"], { ids: ["C-1-1"], grounds: "g", choice }],
        [["root-reanchor"], { id: "C-1-1", anchored: "x2" }],
        [["harm"], { statement: "戻せない", harm: 2 }],
      ];
      for (const [kind, body] of calls) {
        const r = await capture(() => runLaneCommand("intent", ["propose", ...kind, "--reason", "r", "--file", jsonFile(body), "--session", "s1", "--repo", "me/app"]));
        expect(r.code, kind[0]).toBe(0);
      }
      expect(server.received.length).toBe(4);
      expect(server.received.map((x) => x.body.action)).toEqual(["propose", "propose", "propose", "propose"]);
      expect(server.received.map((x) => (x.body.payload as Record<string, unknown>).kind)).toEqual(["overview", "root_supersede", "root_reanchor", "harm_example"]);
      expect(server.received.map((x) => (x.body.payload as Record<string, unknown>).reason)).toEqual(["r", "r", "r", "r"]);
      expect(((server.received[1].body.payload as Record<string, unknown>).body as Record<string, unknown>).ids).toEqual(["C-1-1"]);
      expect(readdirSync(state)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("AC-013: a file that cannot be read or is not JSON exits 2 before anything is sent", async () => {
    const server = await fakeServer();
    try {
      outside(server.url, tmpDir("idd-intent-propose-state-"));
      const missing = await capture(() => runLaneCommand("intent", ["propose", "overview", "--reason", "r", "--file", "/nonexistent/body.json", "--session", "s1", "--repo", "me/app"]));
      expect(missing.code).toBe(2);
      expect(missing.err).toContain("JSON");
      const notJson = join(tmpDir("idd-intent-propose-"), "body.json");
      writeFileSync(notJson, "{ nope");
      const bad = await capture(() => runLaneCommand("intent", ["propose", "overview", "--reason", "r", "--file", notJson, "--session", "s1", "--repo", "me/app"]));
      expect(bad.code).toBe(2);
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("AC-013: a kind outside the four, or a missing reason, is refused before anything is sent", async () => {
    const server = await fakeServer();
    try {
      outside(server.url, tmpDir("idd-intent-propose-state-"));
      const body = jsonFile({ statement: "S" });
      expect((await capture(() => runLaneCommand("intent", ["propose", "wat", "--reason", "r", "--file", body, "--session", "s1", "--repo", "me/app"]))).code).toBe(2);
      expect((await capture(() => runLaneCommand("intent", ["propose", "overview", "--file", body, "--session", "s1", "--repo", "me/app"]))).code).toBe(2);
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("idd intent risk: the read verb", () => {
  test("AC-040: it reads op=risk with the repo and writes nothing", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true, risk_paths: { authz: ["lib/authz/"] }, harm_examples: [{ id: "H-1", statement: "戻せない", harm: 2, alwaysMust: false }] } }]);
    try {
      const state = tmpDir("idd-intent-risk-state-");
      outside(server.url, state);
      const r = await capture(() => runLaneCommand("intent", ["risk", "--repo", "me/app"]));
      expect(r.code).toBe(0);
      expect(server.received.length).toBe(1);
      expect(server.received[0].method).toBe("GET");
      const url = new URL(server.received[0].path, "http://x");
      expect(url.searchParams.get("op")).toBe("risk");
      expect(url.searchParams.get("repo")).toBe("me/app");
      expect(url.searchParams.get("lane")).toBeNull();
      expect(JSON.parse(r.out)).toEqual({ ok: true, risk_paths: { authz: ["lib/authz/"] }, harm_examples: [{ id: "H-1", statement: "戻せない", harm: 2, alwaysMust: false }] });
      expect(readdirSync(state)).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
