import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
const savedCwd = process.cwd();
afterEach(() => {
  process.chdir(savedCwd);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const TOKEN = "token-for-the-convert-test";
const BT = "`";

interface Received {
  method: string;
  path: string;
  auth?: string;
  body: Record<string, unknown>;
}

/** a fake door: the read op answers a state, each POST takes the next scripted reply */
async function fakeDoor(opts: { state?: unknown; posts?: { status: number; body: unknown }[] } = {}) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      received.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(opts.state ?? { ok: true, purposes: [], choices: [] }));
        return;
      }
      const reply = opts.posts?.shift() ?? { status: 200, body: { ok: true } };
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    received,
    url: `http://127.0.0.1:${port}`,
    posts: () => received.filter((r) => r.method === "POST"),
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

function outside(url: string, state: string) {
  delete process.env.IDD_ID;
  delete process.env.IDD_SESSION_ID;
  process.env.IDD_AGENT_BASE_URL = url;
  process.env.IDD_AGENT_TOKEN = TOKEN;
  process.env.IDD_STATE_DIR = state;
}

const field = (name: string, body: string) => `- **${name}**: ${body}`;
const dec = (id: string, title: string) => [`### ${id}: ${title}`, "", field("What", "W"), field("Why", "Y"), field("Anchors", `${BT}a.ts${BT}`), ""].join("\n");

/** a cwd with the decision document the verb reads, plus the two tables it is handed */
function fixture(ids: string[], opts: { assignment?: Record<string, string>; purposes?: unknown[]; review?: unknown } = {}) {
  const assignment = opts.assignment ?? {};
  const purposes = opts.purposes ?? [{ id: "P-1", name: "名", statement: "S", origin: "O" }];
  const review = opts.review;
  const root = tmpDir("idd-convert-");
  mkdirSync(join(root, "_docs/intent/demo/idd-001"), { recursive: true });
  writeFileSync(join(root, "_docs/intent/demo/idd-001/decision.md"), ["---", "created_at: 2026-01-02", "---", "", "# 記録", "", "## Decisions", "", ...ids.map((id) => dec(id, id)), ""].join("\n"));
  const purposesFile = join(root, "purposes.json");
  const assignmentFile = join(root, "assignment.json");
  writeFileSync(purposesFile, JSON.stringify(purposes));
  writeFileSync(assignmentFile, JSON.stringify(assignment));
  let reviewFile: string | undefined;
  if (review) { reviewFile = join(root, "review.json"); writeFileSync(reviewFile, JSON.stringify(review)); }
  process.chdir(root);
  return { root, purposesFile, assignmentFile, reviewFile };
}

describe("idd intent convert: the dry run", () => {
  test("AC-012 / DEC-100-1: a dry run sends no POST, prints the counts and the unreadable ids, and touches no state file", async () => {
    const door = await fakeDoor();
    try {
      const state = tmpDir("idd-convert-state-");
      outside(door.url, state);
      const f = fixture(["DEC-1001"], { assignment: { "DEC-1001": "P-1" } });
      const r = await capture(() => runLaneCommand("intent", ["convert", "--purposes", f.purposesFile, "--assignment", f.assignmentFile, "--repo", "me/app", "--dry-run"]));
      expect(r.code).toBe(0);
      expect(door.posts().length).toBe(0);
      const body = JSON.parse(r.out);
      expect(body.blocked).toBe(false);
      expect(body.report.decs).toBe(1);
      expect(body.report.purposes).toBe(1);
      expect(body.report.choices).toEqual({ unconfirmed: 1, active: 0, dropped: 0 });
      expect(Array.isArray(body.report.anchors_unreadable)).toBe(true);
      expect(body.ops.length).toBe(2);
      expect(readdirSync(state)).toEqual([]);
    } finally {
      await door.close();
    }
  });

  test("AC-008: a dry run with an unsettled record exits non-zero and still shows the plan", async () => {
    const door = await fakeDoor();
    try {
      const state = tmpDir("idd-convert-state-");
      outside(door.url, state);
      const f = fixture(["DEC-1001", "DEC-1002"], { assignment: { "DEC-1001": "P-1" } });
      const r = await capture(() => runLaneCommand("intent", ["convert", "--purposes", f.purposesFile, "--assignment", f.assignmentFile, "--repo", "me/app", "--dry-run"]));
      expect(r.code).not.toBe(0);
      const body = JSON.parse(r.out);
      expect(body.blocked).toBe(true);
      expect(body.blockers.some((b: { reason: string; ids: string[] }) => b.reason === "missing_assignment" && b.ids.includes("DEC-1002"))).toBe(true);
      expect(door.posts().length).toBe(0);
    } finally {
      await door.close();
    }
  });
});

describe("idd intent convert: the run", () => {
  test("AC-008: a blocked run sends nothing through the door and exits non-zero", async () => {
    const door = await fakeDoor();
    try {
      outside(door.url, tmpDir("idd-convert-state-"));
      const f = fixture(["DEC-1001"], { assignment: {} });
      const r = await capture(() => runLaneCommand("intent", ["convert", "--purposes", f.purposesFile, "--assignment", f.assignmentFile, "--repo", "me/app", "--session", "s1"]));
      expect(r.code).not.toBe(0);
      expect(door.posts().length).toBe(0);
      expect(door.received.length).toBe(1);
    } finally {
      await door.close();
    }
  });

  test("AC-018 / DEC-925: the run raises the Purpose first, then the Choice, with the token, session and repo", async () => {
    const door = await fakeDoor();
    try {
      outside(door.url, tmpDir("idd-convert-state-"));
      const f = fixture(["DEC-1001"], { assignment: { "DEC-1001": "P-1" } });
      const r = await capture(() => runLaneCommand("intent", ["convert", "--purposes", f.purposesFile, "--assignment", f.assignmentFile, "--repo", "me/app", "--session", "s1"]));
      expect(r.code, r.err).toBe(0);
      const posts = door.posts();
      expect(posts.map((p) => p.body.action)).toEqual(["raise_purpose", "raise_choice"]);
      for (const p of posts) {
        expect(p.auth).toBe(`Bearer ${TOKEN}`);
        expect(p.body.session).toBe("s1");
        expect(p.body.repo).toBe("me/app");
      }
      expect((posts[0].body.payload as Record<string, unknown>).id).toBe("P-1");
      expect((posts[1].body.payload as Record<string, unknown>).id).toBe("DEC-1001");
      expect(JSON.parse(r.out).sent).toBe(2);
    } finally {
      await door.close();
    }
  });

  test("AC-015 / DEC-100-5: a refusal mid-run stops there, sends no later request, and exits non-zero", async () => {
    const door = await fakeDoor({ posts: [{ status: 200, body: { ok: true } }, { status: 400, body: { ok: false, error: "ID DEC-1002 は既にあります" } }] });
    try {
      outside(door.url, tmpDir("idd-convert-state-"));
      const f = fixture(["DEC-1001", "DEC-1002"], { assignment: { "DEC-1001": "P-1", "DEC-1002": "P-1" } });
      const r = await capture(() => runLaneCommand("intent", ["convert", "--purposes", f.purposesFile, "--assignment", f.assignmentFile, "--repo", "me/app", "--session", "s1"]));
      expect(r.code).toBe(1);
      expect(door.posts().length).toBe(2);
      expect(r.err).toContain("送り済み 1 件");
    } finally {
      await door.close();
    }
  });

  test("AC-018 / DEC-100-7: a lane is refused before any file is read, and an unreadable input before any request", async () => {
    const door = await fakeDoor();
    try {
      process.env.IDD_ID = "IDD-100";
      delete process.env.IDD_SESSION_ID;
      process.env.IDD_AGENT_BASE_URL = door.url;
      process.env.IDD_AGENT_TOKEN = TOKEN;
      process.env.IDD_STATE_DIR = tmpDir("idd-convert-state-");
      const lane = await capture(() => runLaneCommand("intent", ["convert", "--purposes", "/no/such/file.json", "--assignment", "/no/such/file.json"]));
      expect(lane.code).toBe(2);
      expect(lane.err).toContain("lane");
      expect(door.received.length).toBe(0);

      outside(door.url, process.env.IDD_STATE_DIR as string);
      const f = fixture(["DEC-1001"], { assignment: { "DEC-1001": "P-1" } });
      const bad = await capture(() => runLaneCommand("intent", ["convert", "--purposes", join(f.root, "nope.json"), "--assignment", f.assignmentFile, "--repo", "me/app", "--session", "s1"]));
      expect(bad.code).toBe(2);
      expect(door.received.length).toBe(0);

      const noSession = await capture(() => runLaneCommand("intent", ["convert", "--purposes", f.purposesFile, "--assignment", f.assignmentFile, "--repo", "me/app"]));
      expect(noSession.code).toBe(2);
      expect(noSession.err).toContain("--session");
      expect(door.posts().length).toBe(0);
    } finally {
      await door.close();
    }
  });
});

describe("idd intent confirm: the name", () => {
  test("AC-017 / DEC-100-4: a Purpose confirm carries --name, and a Choice confirm does not", async () => {
    const door = await fakeDoor();
    try {
      outside(door.url, tmpDir("idd-convert-state-"));
      const p = await capture(() => runLaneCommand("intent", ["confirm", "P-1", "--name", "名前", "--session", "s1", "--repo", "me/app"]));
      expect(p.code).toBe(0);
      expect(door.received[0].body).toEqual({ action: "confirm_purpose", session: "s1", repo: "me/app", payload: { id: "P-1", name: "名前" } });
      const c = await capture(() => runLaneCommand("intent", ["confirm", "C-1-1", "--name", "無視", "--session", "s1", "--repo", "me/app"]));
      expect(c.code).toBe(0);
      expect(door.received[1].body).toEqual({ action: "confirm_choice", session: "s1", repo: "me/app", payload: { id: "C-1-1" } });
    } finally {
      await door.close();
    }
  });
});
