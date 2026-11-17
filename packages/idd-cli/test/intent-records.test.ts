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

/** a fake door on a free port: it records what it got and answers with the next scripted reply */
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

const TOKEN = "token-for-the-intent-test";

function jsonFile(body: unknown): string {
  const dir = tmpDir("idd-intent-cli-");
  const file = join(dir, "body.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
}

/** an outside write: no lane id, the token in the environment, the repo named on the command line */
function outside(url: string, state: string) {
  delete process.env.IDD_ID;
  delete process.env.IDD_SESSION_ID;
  process.env.IDD_AGENT_BASE_URL = url;
  process.env.IDD_AGENT_TOKEN = TOKEN;
  process.env.IDD_STATE_DIR = state;
}

describe("idd intent: the write verbs", () => {
  test("a write goes to /api/idd/intent with the token and its payload, and touches no state file", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true, id: "P-1", status: "active" } }]);
    try {
      const state = tmpDir("idd-intent-state-");
      outside(server.url, state);
      const file = jsonFile({ statement: "S", origin: "O" });
      const r = await capture(() => runLaneCommand("intent", ["raise", "purpose", "--file", file, "--session", "s1", "--repo", "me/app"]));
      expect(r.code).toBe(0);
      expect(server.received.length).toBe(1);
      expect(server.received[0].method).toBe("POST");
      expect(server.received[0].path).toBe("/api/idd/intent");
      expect(server.received[0].auth).toBe(`Bearer ${TOKEN}`);
      expect(server.received[0].body).toEqual({ action: "raise_purpose", session: "s1", repo: "me/app", payload: { statement: "S", origin: "O" } });
      expect(readdirSync(state)).toEqual([]);
      expect(JSON.parse(r.out)).toEqual({ ok: true, id: "P-1", status: "active" });
    } finally {
      await server.close();
    }
  });

  test("a body missing a required field is refused before anything is sent", async () => {
    const server = await fakeServer();
    try {
      outside(server.url, tmpDir("idd-intent-state-"));
      const noPurpose = jsonFile({ forms: { chosen: "A" }, place: [{ path: "a", kind: "file" }], why: "w", anchored: "x" });
      const r = await capture(() => runLaneCommand("intent", ["raise", "choice", "--file", noPurpose, "--session", "s1", "--repo", "me/app"]));
      expect(r.code).toBe(2);
      expect(r.err).toContain("purpose");
      const badPlace = jsonFile({ purpose: "P-1", forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "/abs", kind: "file" }], why: "w", anchored: "x" });
      const r2 = await capture(() => runLaneCommand("intent", ["raise", "choice", "--file", badPlace, "--session", "s1", "--repo", "me/app"]));
      expect(r2.code).toBe(2);
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("a refusal from the door fails the command and its reason is shown", async () => {
    const server = await fakeServer([{ status: 400, body: { ok: false, error: "Purpose P-9 はありません" } }]);
    try {
      outside(server.url, tmpDir("idd-intent-state-"));
      const r = await capture(() => runLaneCommand("intent", ["confirm", "P-9", "--session", "s1", "--repo", "me/app"]));
      expect(r.code).toBe(1);
      expect(r.err).toContain("P-9 はありません");
    } finally {
      await server.close();
    }
  });

  test("each write verb carries its own action name", async () => {
    const server = await fakeServer();
    try {
      outside(server.url, tmpDir("idd-intent-state-"));
      const choice = jsonFile({ purpose: "P-1", forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "a/b.ts", kind: "file" }], why: "w", anchored: "x" });
      const calls = [
        ["supersede", ["supersede", "C-1-1,C-1-2", "--grounds", "g", "--file", choice, "--session", "s1", "--repo", "me/app"]],
        ["reanchor", ["reanchor", "C-1-1", "--file", jsonFile({ place: [{ path: "x/", kind: "dir" }] }), "--session", "s1", "--repo", "me/app"]],
        ["confirm", ["confirm", "C-1-1", "--session", "s1", "--repo", "me/app"]],
        ["drop", ["drop", "C-1-1", "--grounds", "g", "--session", "s1", "--repo", "me/app"]],
        ["retire", ["retire", "P-1", "--grounds", "g", "--session", "s1", "--repo", "me/app"]],
        ["waive-applied", ["waive", "--kind", "applied", "--choice", "C-1-1", "--session", "s1", "--repo", "me/app"]],
        ["waive-none", ["waive", "--kind", "no-choice", "--reason", "r", "--session", "s1", "--repo", "me/app"]],
      ];
      for (const [name, argv] of calls) {
        const r = await capture(() => runLaneCommand("intent", argv as string[]));
        expect(r.code, name as string).toBe(0);
      }
      expect(server.received.map((x) => x.body.action)).toEqual([
        "supersede", "reanchor", "confirm_choice", "drop_choice", "retire_purpose", "waive", "waive",
      ]);
      expect((server.received[0].body.payload as Record<string, unknown>).ids).toEqual(["C-1-1", "C-1-2"]);
      expect((server.received[5].body.payload as Record<string, unknown>).choices).toEqual(["C-1-1"]);
      expect((server.received[6].body.payload as Record<string, unknown>).reason).toBe("r");
    } finally {
      await server.close();
    }
  });
});

describe("idd intent: who the call is", () => {
  test("supersede points at a standing successor with --by, and refuses both or neither", async () => {
    const server = await fakeServer();
    try {
      outside(server.url, tmpDir("idd-intent-state-"));
      const by = await capture(() => runLaneCommand("intent", ["supersede", "C-1-1,C-1-2", "--grounds", "g", "--by", "C-2-1", "--session", "s1", "--repo", "me/app"]));
      expect(by.code).toBe(0);
      expect(server.received[0].body.payload).toEqual({ ids: ["C-1-1", "C-1-2"], grounds: "g", by: "C-2-1" });
      const file = jsonFile({ purpose: "P-1", forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "a/b.ts", kind: "file" }], why: "w", anchored: "x" });
      for (const argv of [
        ["supersede", "C-1-1", "--grounds", "g", "--file", file, "--by", "C-2-1", "--session", "s1", "--repo", "me/app"],
        ["supersede", "C-1-1", "--grounds", "g", "--session", "s1", "--repo", "me/app"],
      ]) {
        const r = await capture(() => runLaneCommand("intent", argv as string[]));
        expect(r.code).toBe(2);
      }
      expect(server.received.length).toBe(1, "a refused successor never reaches the door");
    } finally {
      await server.close();
    }
  });

  test("a lane names its own id and cannot take lane or repo flags", async () => {
    const server = await fakeServer();
    try {
      process.env.IDD_ID = "IDD-099";
      process.env.IDD_AGENT_TOKEN = TOKEN;
      process.env.IDD_AGENT_BASE_URL = server.url;
      process.env.IDD_STATE_DIR = tmpDir("idd-intent-state-");
      const file = jsonFile({ statement: "S", origin: "O" });
      for (const flag of [["--view-lane", "IDD-1"], ["--session", "s1"], ["--repo", "me/app"], ["--token", "x"]]) {
        const r = await capture(() => runLaneCommand("intent", ["raise", "purpose", "--file", file, ...flag]));
        expect(r.code, flag[0]).toBe(2);
      }
      expect(server.received.length).toBe(0);
      const ok = await capture(() => runLaneCommand("intent", ["raise", "purpose", "--file", file]));
      expect(ok.code).toBe(0);
      expect(server.received[0].body).toEqual({ action: "raise_purpose", idd_id: "IDD-099", payload: { statement: "S", origin: "O" } });
    } finally {
      await server.close();
    }
  });

  test("a lane's read names the lane as the viewer and needs no token", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true, choices: [] } }]);
    try {
      process.env.IDD_ID = "IDD-099";
      delete process.env.IDD_AGENT_TOKEN;
      process.env.IDD_AGENT_BASE_URL = server.url;
      process.env.IDD_STATE_DIR = tmpDir("idd-intent-state-");
      const r = await capture(() => runLaneCommand("intent", ["lookup", "a/b/c.ts"]));
      expect(r.code).toBe(0);
      const url = new URL(server.received[0].path, "http://x");
      expect(url.searchParams.get("op")).toBe("lookup");
      expect(url.searchParams.get("lane")).toBe("IDD-099");
      expect(url.searchParams.get("repo")).toBeNull();
      expect(server.received[0].auth).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  test("outside, --view-lane is a value that reaches the read door", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true, choices: [] } }]);
    try {
      delete process.env.IDD_ID;
      delete process.env.IDD_AGENT_TOKEN;
      process.env.IDD_AGENT_BASE_URL = server.url;
      process.env.IDD_STATE_DIR = tmpDir("idd-intent-state-");
      const r = await capture(() => runLaneCommand("intent", ["lookup", "a/b/c.ts", "--repo", "me/app", "--view-lane", "IDD-099"]));
      expect(r.code).toBe(0);
      const url = new URL(server.received[0].path, "http://x");
      expect(url.searchParams.get("repo")).toBe("me/app");
      expect(url.searchParams.get("lane")).toBe("IDD-099");
      expect(url.searchParams.getAll("path")).toEqual(["a/b/c.ts"]);
    } finally {
      await server.close();
    }
  });

  test("an outside write with no session is refused, and `idd intent list` stays an unknown verb", async () => {
    const server = await fakeServer();
    try {
      outside(server.url, tmpDir("idd-intent-state-"));
      const file = jsonFile({ statement: "S", origin: "O" });
      const noSession = await capture(() => runLaneCommand("intent", ["raise", "purpose", "--file", file, "--repo", "me/app"]));
      expect(noSession.code).toBe(2);
      expect(noSession.err).toContain("--session");
      const list = await capture(() => runLaneCommand("intent", ["list"]));
      expect(list.code).toBe(2);
      expect(list.err).toContain("idd intent decisions");
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("idd intent: the visibility default belongs to the store", () => {
  test("AC-022: a choice body without a visibility is sent without one", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true, id: "C-s1-1", status: "active" } }]);
    try {
      outside(server.url, tmpDir("idd-intent-state-"));
      const file = jsonFile({ purpose: "P-1", forms: { chosen: "A", rejected: [{ form: "B", fails_because: "x" }] }, place: [{ path: "a/b.ts", kind: "file" }], why: "w", anchored: "x" });
      const r = await capture(() => runLaneCommand("intent", ["raise", "choice", "--file", file, "--session", "s1", "--repo", "me/app"]));
      expect(r.code).toBe(0);
      const payload = server.received[0].body.payload as Record<string, unknown>;
      expect("visibility" in payload).toBe(false);
    } finally {
      await server.close();
    }
  });
});

describe("idd intent: the planner's two reads answer as text", () => {
  test("AC-003: purposes are one line each, id and want, and --json keeps the whole records answer", async () => {
    const purposes = [
      { id: "P-10", statement: "二つ目の目的の文。二文目。", status: "active" },
      { id: "P-2", statement: "一つ目の目的の文。二文目。", status: "active" },
    ];
    const server = await fakeServer([
      { status: 200, body: { ok: true, purposes } },
      { status: 200, body: { ok: true, purposes } },
    ]);
    try {
      outside(server.url, tmpDir("idd-intent-state-"));
      const text = await capture(() => runLaneCommand("intent", ["purposes", "--repo", "me/app"]));
      expect(text.code).toBe(0);
      const url = new URL(server.received[0].path, "http://x");
      expect(url.searchParams.get("op")).toBe("records");
      expect(url.searchParams.get("kind")).toBe("purposes");
      expect(url.searchParams.get("status")).toBe("active");
      const lines = text.out.trimEnd().split("\n");
      expect(lines[0]).toContain("2 件");
      // the id and the want (the statement's first sentence), ordered by the id's number
      expect(lines.slice(1)).toEqual(["P-2 一つ目の目的の文。", "P-10 二つ目の目的の文。"]);
      const json = await capture(() => runLaneCommand("intent", ["purposes", "--repo", "me/app", "--json"]));
      expect(JSON.parse(json.out)).toEqual({ ok: true, purposes });
    } finally {
      await server.close();
    }
  });

  test("AC-004: lookup puts the file and dir Choices whole, the module ones as headings, and counts the root", async () => {
    const hit = (kind: string, place: string, file?: string) => ({ path: "a/b/prompt.ts", place, kind, ...(file ? { file } : {}) });
    const choices = [
      { id: "C-1-1", purpose: "P-5", forms: { chosen: "file に当たる形" }, why: "WHY-FILE", free: "FREE-FILE", status: "unconfirmed", matched: [hit("file", "a/b/prompt.ts")] },
      { id: "C-1-2", purpose: "P-6", forms: { chosen: "dir に当たる形" }, why: "WHY-DIR", free: "FREE-DIR", status: "active", matched: [hit("dir", "a/b/")] },
      { id: "C-1-3", purpose: "P-7", forms: { chosen: "同じ module の形" }, why: "WHY-SIBLING", free: "FREE-SIBLING", status: "active", matched: [hit("module", "a/b/", "a/b/other.ts")] },
      { id: "DEC-9", purpose: "P-8", forms: { chosen: "root の形" }, why: "WHY-ROOT", free: "FREE-ROOT", status: "active", matched: [hit("root", "/")] },
    ];
    const server = await fakeServer([
      { status: 200, body: { ok: true, choices } },
      { status: 200, body: { ok: true, choices } },
    ]);
    try {
      outside(server.url, tmpDir("idd-intent-state-"));
      const text = await capture(() => runLaneCommand("intent", ["lookup", "a/b/prompt.ts", "--repo", "me/app"]));
      expect(text.code).toBe(0);
      // what disposing of a Choice needs, for the two the path is the subject of
      for (const part of ["C-1-1 [unconfirmed] file に当たる形", "当たり: a/b/prompt.ts（file の印）", "purpose: P-5", "why: WHY-FILE", "free: FREE-FILE"]) {
        expect(text.out).toContain(part);
      }
      expect(text.out).toContain("C-1-2 dir に当たる形");
      expect(text.out).toContain("当たり: a/b/prompt.ts（dir の Place）");
      // the same module's other Choices are headings, not bodies
      expect(text.out).toContain("同じ module（a/b/）の Choice");
      expect(text.out).toContain("- C-1-3 同じ module の形");
      expect(text.out).not.toContain("WHY-SIBLING");
      expect(text.out).not.toContain("WHY-ROOT");
      // the root's Choices are a count and the way to pull them
      expect(text.out).toContain("root の Choice 1 件");
      expect(text.out).toContain("--json");
      expect(text.out).toContain("idd intent propose root-supersede");
      // the full JSON is still what --json answers
      const json = await capture(() => runLaneCommand("intent", ["lookup", "a/b/prompt.ts", "--repo", "me/app", "--json"]));
      expect(JSON.parse(json.out)).toEqual({ ok: true, choices });
    } finally {
      await server.close();
    }
  });

  test("AC-004: an empty lookup says so and still names the --json way", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true, choices: [] } }]);
    try {
      outside(server.url, tmpDir("idd-intent-state-"));
      const r = await capture(() => runLaneCommand("intent", ["lookup", "a/b/prompt.ts", "--repo", "me/app"]));
      expect(r.code).toBe(0);
      expect(r.out).toContain("当たる Choice はありません");
    } finally {
      await server.close();
    }
  });
});
