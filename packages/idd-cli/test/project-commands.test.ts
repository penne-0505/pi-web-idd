import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { formatProjectLine, formatProjectList, runProjectCommand } from "../src/project-commands.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

const savedEnv = {
  IDD_ID: process.env.IDD_ID,
  IDD_SESSION_ID: process.env.IDD_SESSION_ID,
  IDD_AGENT_TOKEN: process.env.IDD_AGENT_TOKEN,
  IDD_AGENT_BASE_URL: process.env.IDD_AGENT_BASE_URL,
};
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Received { method: string; path: string; body: Record<string, unknown> }

/** a fake door: it records what it got and answers with the reply scripted for the request's path, else a bare ok */
async function fakeServer(replies: Record<string, unknown> = {}) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      received.push({ method: req.method ?? "", path: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
      const key = Object.keys(replies).find((k) => (req.url ?? "").includes(k));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(key ? replies[key] : { ok: true }));
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

function outside(url: string) {
  delete process.env.IDD_ID;
  delete process.env.IDD_SESSION_ID;
  process.env.IDD_AGENT_BASE_URL = url;
  process.env.IDD_AGENT_TOKEN = "token-for-the-project-test";
}

/** run `body` against a fake door that answers a bare ok, with the environment pointed at it; the door is closed after */
async function withDoor(body: (server: Awaited<ReturnType<typeof fakeServer>>) => Promise<void>): Promise<void> {
  const server = await fakeServer();
  try {
    outside(server.url);
    await body(server);
  } finally {
    await server.close();
  }
}

const jsonFile = (body: unknown): string => {
  const file = join(tmpDir("idd-project-cli-"), "body.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
};

const view = (over: Record<string, unknown> = {}) => ({
  id: "PRJ-1", name: "まとまり", purpose: "P-1", doneWhen: "d", state: "started", body: "", decisions: [], issues: ["me/app#1", "me/app#2"],
  issueStatuses: [{ issue: "me/app#1", closed: true, via: "landing", lane: "IDD-1" }, { issue: "me/app#2", closed: false }],
  closedCount: 1, completionCandidate: false, document: "_docs/intent/app/PRJ-1.md", ...over,
});

describe("idd project: the reads", () => {
  test("list prints one line a Project with the closed count and marks a candidate", async () => {
    const server = await fakeServer({ "op=projects": { ok: true, projects: [view(), view({ id: "PRJ-2", name: "終わり", closedCount: 2, completionCandidate: true })] } });
    try {
      outside(server.url);
      const r = await capture(() => runProjectCommand(["list", "--repo", "me/app"]));
      expect(r.code).toBe(0);
      expect(r.out).toContain("Project 2 件");
      expect(r.out).toContain("PRJ-1 [started] まとまり — Issue 1/2 閉\n");
      expect(r.out).toContain("PRJ-2 [started] 終わり — Issue 2/2 閉 ★完了の候補");
      expect(server.received[0].path).toContain("op=projects");
      expect(server.received[0].path).toContain("repo=me%2Fapp");
      expect(server.received[0].method).toBe("GET");
    } finally {
      await server.close();
    }
  });

  test("show prints how each Issue is closed, and --json prints the door's answer as it came", async () => {
    const answer = { ok: true, project: view() };
    const server = await fakeServer({ "op=project&": answer });
    try {
      outside(server.url);
      const text = await capture(() => runProjectCommand(["show", "PRJ-1", "--repo", "me/app"]));
      expect(text.out).toContain("me/app#1 閉（着地 IDD-1）");
      expect(text.out).toContain("me/app#2 開");
      expect(text.out).toContain("文書: _docs/intent/app/PRJ-1.md");
      const json = await capture(() => runProjectCommand(["show", "PRJ-1", "--repo", "me/app", "--json"]));
      expect(JSON.parse(json.out)).toEqual(answer);
    } finally {
      await server.close();
    }
  });

  test("the formatting is a function of the view", () => {
    expect(formatProjectList([])).toEqual(["Project はありません。"]);
    expect(formatProjectLine(view({ issues: [], issueStatuses: [], closedCount: 0 }) as never)).toBe("PRJ-1 [started] まとまり — Issue なし");
  });
});

describe("idd project: the writes", () => {
  test("each write verb sends its own action to the intent door and nothing else", async () => {
    const server = await fakeServer();
    try {
      outside(server.url);
      const where = ["--session", "s1", "--repo", "me/app"];
      const calls: [string, string[]][] = [
        ["project_raise", ["new", "--file", jsonFile({ name: "n", purpose: "P-1", done_when: "d" }), ...where]],
        ["project_update", ["set", "PRJ-1", "--name", "改め", "--state", "paused", ...where]],
        ["project_decide", ["decide", "PRJ-1", "--file", jsonFile({ chosen: "c", why: "w", rejected: [{ form: "f", fails_because: "x" }] }), ...where]],
        ["project_promote", ["promote", "PRJ-1", "PD-1-1", "--file", jsonFile({ place: [{ path: "a/b.ts", kind: "file" }], anchored: "a" }), ...where]],
        ["project_attach", ["attach", "PRJ-1", "#234", "APP-5", ...where]],
        ["project_detach", ["detach", "PRJ-1", "#234", ...where]],
        ["project_update", ["cancel", "PRJ-1", ...where]],
      ];
      for (const [action, argv] of calls) {
        const r = await capture(() => runProjectCommand(argv));
        expect(r.code, argv[0]).toBe(0);
        expect(server.received.at(-1)?.method).toBe("POST");
        expect(server.received.at(-1)?.path).toBe("/api/idd/intent");
        expect(server.received.at(-1)?.body.action).toBe(action);
      }
      expect(server.received[1].body.payload).toEqual({ id: "PRJ-1", patch: { name: "改め", state: "paused" } });
      expect(server.received[4].body.payload).toEqual({ id: "PRJ-1", issues: ["#234", "APP-5"] });
      expect((server.received[3].body.payload as { decision: string }).decision).toBe("PD-1-1");
      expect(server.received[6].body.payload).toEqual({ id: "PRJ-1", patch: { state: "canceled" } });
    } finally {
      await server.close();
    }
  });

  test("an ill-shaped body is refused before anything is sent", async () => {
    const server = await fakeServer();
    try {
      outside(server.url);
      const where = ["--session", "s1", "--repo", "me/app"];
      const noDone = await capture(() => runProjectCommand(["new", "--file", jsonFile({ name: "n", purpose: "P-1" }), ...where]));
      expect(noDone.code).toBe(2);
      expect(noDone.err).toContain("done_when");
      const noReason = await capture(() => runProjectCommand(["decide", "PRJ-1", "--file", jsonFile({ chosen: "c", why: "w" }), ...where]));
      expect(noReason.code).toBe(2);
      const noIssue = await capture(() => runProjectCommand(["attach", "PRJ-1", ...where]));
      expect(noIssue.code).toBe(2);
      const empty = await capture(() => runProjectCommand(["set", "PRJ-1", ...where]));
      expect(empty.code).toBe(2);
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("issue-closed and issue-open record one fact per Issue", async () => {
    const server = await fakeServer();
    try {
      outside(server.url);
      const r = await capture(() => runProjectCommand(["issue-closed", "#1", "APP-2", "--session", "s1", "--repo", "me/app"]));
      expect(r.code).toBe(0);
      expect(server.received.map((x) => [x.body.action, x.body.payload])).toEqual([
        ["project_issue_state", { issue: "#1", closed: true }],
        ["project_issue_state", { issue: "APP-2", closed: true }],
      ]);
      const open = await capture(() => runProjectCommand(["issue-open", "#1", "--session", "s1", "--repo", "me/app"]));
      expect(open.code).toBe(0);
      expect(server.received.at(-1)?.body.payload).toEqual({ issue: "#1", closed: false });
    } finally {
      await server.close();
    }
  });

  test("sync asks the engine's one door to read the outside now, and carries nothing to write", () => withDoor(async (server) => {
    const r = await capture(() => runProjectCommand(["sync", "--session", "s1", "--repo", "me/app"]));
    expect(r.code).toBe(0);
    expect(server.received.map((x) => [x.body.action, x.body.payload])).toEqual([["project_sync", {}]]);
  }));

  test("complete closes a candidate, and refuses any other Project unless --force", async () => {
    const notYet = await fakeServer({ "op=project&": { ok: true, project: view() } });
    try {
      outside(notYet.url);
      const where = ["--session", "s1", "--repo", "me/app"];
      const refused = await capture(() => runProjectCommand(["complete", "PRJ-1", ...where]));
      expect(refused.code).toBe(2);
      expect(refused.err).toContain("完了の候補ではありません");
      expect(notYet.received.every((x) => x.method === "GET")).toBe(true);
      const forced = await capture(() => runProjectCommand(["complete", "PRJ-1", "--force", ...where]));
      expect(forced.code).toBe(0);
      expect(notYet.received.at(-1)?.body.payload).toEqual({ id: "PRJ-1", patch: { state: "completed" } });
    } finally {
      await notYet.close();
    }
    const ready = await fakeServer({ "op=project&": { ok: true, project: view({ completionCandidate: true, closedCount: 2 }) } });
    try {
      outside(ready.url);
      const done = await capture(() => runProjectCommand(["complete", "PRJ-1", "--session", "s1", "--repo", "me/app"]));
      expect(done.code).toBe(0);
      expect(ready.received.at(-1)?.body.action).toBe("project_update");
    } finally {
      await ready.close();
    }
  });

  test("a lane names itself from the environment and cannot be told otherwise", async () => {
    const server = await fakeServer();
    try {
      outside(server.url);
      process.env.IDD_ID = "IDD-7";
      const named = await capture(() => runProjectCommand(["attach", "PRJ-1", "#1", "--repo", "me/app"]));
      expect(named.code).toBe(2);
      expect(named.err).toContain("lane の呼び出しでは");
      const ok = await capture(() => runProjectCommand(["attach", "PRJ-1", "#1"]));
      expect(ok.code).toBe(0);
      expect(server.received[0].body.idd_id).toBe("IDD-7");
      expect(server.received[0].body.session).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
