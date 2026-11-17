import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runLaneCommand } from "../src/lane-commands.ts";
import { PROJECTION_MARK, type ProjectionFile } from "../../idd-core/src/intent/projection.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

const ORIGINAL_CWD = process.cwd();
const savedEnv = {
  IDD_ID: process.env.IDD_ID,
  IDD_AGENT_BASE_URL: process.env.IDD_AGENT_BASE_URL,
  IDD_AGENT_TOKEN: process.env.IDD_AGENT_TOKEN,
  IDD_STATE_DIR: process.env.IDD_STATE_DIR,
  IDD_REPOS_FILE: process.env.IDD_REPOS_FILE,
};
afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Received {
  method: string;
  path: string;
  auth?: string;
}

/** a fake door on a free port: it records what it got and answers with the next scripted reply */
async function fakeServer(replies: { status: number; body: unknown }[] = []) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    received.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization });
    req.resume();
    req.on("end", () => {
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

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** a clone registered under me/app, with a base it merges against */
function fixture() {
  const root = tmpDir("idd-intent-draw-");
  const clone = join(root, "clone");
  mkdirSync(clone);
  git(clone, ["init", "--quiet", "-b", "main"]);
  writeFileSync(join(clone, "a.txt"), "1\n");
  git(clone, ["add", "-A"]);
  git(clone, ["commit", "--quiet", "-m", "base"]);
  const repos = join(root, "repos.yaml");
  writeFileSync(repos, JSON.stringify({ repos: { "me/app": { name: "app", upstream: clone, work: clone, public_base: "main", remote: "" } } }));
  return { root, clone, repos };
}

function asLane(f: ReturnType<typeof fixture>, url: string, state = tmpDir("idd-intent-draw-state-")) {
  process.env.IDD_ID = "IDD-1";
  process.env.IDD_AGENT_BASE_URL = url;
  process.env.IDD_REPOS_FILE = f.repos;
  process.env.IDD_STATE_DIR = state;
  process.chdir(f.clone);
  return state;
}

function asOutside(url: string, state = tmpDir("idd-intent-draw-state-")) {
  delete process.env.IDD_ID;
  process.env.IDD_AGENT_BASE_URL = url;
  process.env.IDD_REPOS_FILE = tmpDir("idd-intent-draw-repos-");
  process.env.IDD_STATE_DIR = state;
  return state;
}

/** the same fixture, called as the outside: the cwd's repo decides the door and the tree is the caller's worktree */
function asOutsideIn(f: ReturnType<typeof fixture>, url: string, state = tmpDir("idd-intent-draw-state-")) {
  delete process.env.IDD_ID;
  process.env.IDD_AGENT_BASE_URL = url;
  process.env.IDD_REPOS_FILE = f.repos;
  process.env.IDD_STATE_DIR = state;
  process.chdir(f.clone);
  return state;
}

const P1 = { name: "P-1.md", content: `${PROJECTION_MARK}\n# P-1: 目的\n- origin: 常設\n- status: active\n\n## C-1-1: 形\n- Why: why\n` };
const OVERVIEW = { name: "overview.md", content: `${PROJECTION_MARK}\n## 概要\n目的\n\n## 組まれ方\n\n## Purpose\n- [P-1](P-1.md): 目的 — origin: 常設 / 有効な Choice: 1 件\n` };

const projection = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: { ok: true, repo: "me/app", project: "app", dir: "_docs/intent/app/", projections: ["A"], files: [P1, OVERVIEW], ...over },
});

const place = (f: ReturnType<typeof fixture>) => join(f.clone, "_docs", "intent", "app");
const markFile = (path: string, body: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, body); };

/** every file under a directory, path -> content */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, prefix: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) out[rel] = readFileSync(full, "utf8");
      else out[rel] = `<${st.isSymbolicLink() ? "symlink" : "other"}>`;
    }
  };
  try { walk(dir, ""); } catch { /* missing */ }
  return out;
}

describe("idd intent draw: where the text goes", () => {
  test("AC-006: a lane never draws into its worktree: it refuses without --out and writes nothing", async () => {
    const f = fixture();
    const server = await fakeServer([projection()]);
    try {
      const state = asLane(f, server.url);
      const before = snapshot(f.clone);
      const r = await capture(() => runLaneCommand("intent", ["draw"]));
      expect(r.code).not.toBe(0);
      expect(r.err.length).toBeGreaterThan(0);
      expect(server.received.length).toBe(0);
      expect(snapshot(f.clone)).toEqual(before);
      expect(readdirSync(state)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("AC-006: a lane's --out draws the lane's own text, and the worktree is untouched", async () => {
    const f = fixture();
    const out = tmpDir("idd-intent-draw-lane-out-");
    const server = await fakeServer([projection()]);
    try {
      const state = asLane(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--out", out]));
      expect(r.code).toBe(0);
      expect(readFileSync(join(out, "P-1.md"), "utf8")).toBe(P1.content);
      expect(readFileSync(join(out, "overview.md"), "utf8")).toBe(OVERVIEW.content);
      expect(git(f.clone, ["status", "--porcelain", "-uall"])).toBe("");
      expect(readdirSync(state)).toEqual([]);
      // the door was asked as the lane, so the text is the lane's own view
      const url = new URL(server.received[0].path, "http://x");
      expect(url.searchParams.get("lane")).toBe("IDD-1");
    } finally {
      await server.close();
    }
  });

  test("AC-011: the outside draws the door's text under the worktree root, from a subdirectory too, with no token", async () => {
    const f = fixture();
    const server = await fakeServer([projection()]);
    try {
      const state = asOutsideIn(f, server.url);
      const sub = join(f.clone, "sub", "dir");
      mkdirSync(sub, { recursive: true });
      process.chdir(sub);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
      expect(r.code).toBe(0);
      expect(server.received.length).toBe(1);
      expect(server.received[0].method).toBe("GET");
      expect(server.received[0].auth).toBeUndefined();
      const url = new URL(server.received[0].path, "http://x");
      expect(url.searchParams.get("op")).toBe("projection");
      expect(url.searchParams.get("repo")).toBe("me/app");
      expect(readFileSync(join(place(f), "P-1.md"), "utf8")).toBe(P1.content);
      expect(readFileSync(join(f.clone, "_docs", "intent", "app", "overview.md"), "utf8")).toBe(OVERVIEW.content);
      expect(readdirSync(state)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("AC-011: a lane refuses --repo, --view-lane, --session and --token", async () => {
    const f = fixture();
    const server = await fakeServer([projection(), projection(), projection(), projection()]);
    try {
      asLane(f, server.url);
      for (const flag of [["--repo", "me/app"], ["--view-lane", "IDD-1"], ["--session", "s1"], ["--token", "x"]]) {
        const r = await capture(() => runLaneCommand("intent", ["draw", ...flag]));
        expect(r.code, flag[0]).toBe(2);
      }
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("AC-011: an unreachable door fails without touching the tree", async () => {
    const f = fixture();
    asOutside("http://127.0.0.1:1");
    const before = snapshot(f.clone);
    const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
    expect(r.code).not.toBe(0);
    expect(snapshot(f.clone)).toEqual(before);
  });

  test("AC-012: a hand-edited projection is drawn back, and an unchanged file is not rewritten", async () => {
    const f = fixture();
    const first = await fakeServer([projection(), projection()]);
    try {
      asOutsideIn(f, first.url);
      expect((await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]))).code).toBe(0);
    } finally {
      await first.close();
    }
    const p1 = join(place(f), "P-1.md");
    const overview = join(place(f), "overview.md");
    const untouched = statSync(overview).mtimeMs;
    writeFileSync(p1, `${PROJECTION_MARK}\n# 手で直した\n`);
    const second = await fakeServer([projection()]);
    try {
      asOutsideIn(f, second.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
      expect(r.code).toBe(0);
      expect(readFileSync(p1, "utf8")).toBe(P1.content);
      expect(readFileSync(overview, "utf8")).toBe(OVERVIEW.content);
      expect(statSync(overview).mtimeMs).toBe(untouched);
      expect(r.out).toContain("書いた 1 件");
      expect(r.out).toContain("変わらなかった 1 件");
    } finally {
      await second.close();
    }
  });
});

describe("idd intent draw: what it will not touch", () => {
  test("AC-013: an unmarked file at a name to be drawn refuses the whole drawing", async () => {
    const f = fixture();
    const dir = place(f);
    markFile(join(dir, "overview.md"), "人が書いた概要\n");
    const server = await fakeServer([projection()]);
    try {
      asOutsideIn(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
      expect(r.code).toBe(2);
      expect(r.err).toContain("overview.md");
      expect(readFileSync(join(dir, "overview.md"), "utf8")).toBe("人が書いた概要\n");
      expect(readdirSync(dir)).toEqual(["overview.md"]);
    } finally {
      await server.close();
    }
  });

  test("AC-013: an unmarked extra file and a nested document are left alone", async () => {
    const f = fixture();
    const dir = place(f);
    markFile(join(dir, "notes.md"), "人のメモ\n");
    markFile(join(dir, "idd-099", "decision.md"), "古い記録\n");
    const server = await fakeServer([projection()]);
    try {
      asOutsideIn(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
      expect(r.code).toBe(0);
      expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("人のメモ\n");
      expect(readFileSync(join(dir, "idd-099", "decision.md"), "utf8")).toBe("古い記録\n");
      expect(readFileSync(join(dir, "P-1.md"), "utf8")).toBe(P1.content);
    } finally {
      await server.close();
    }
  });

  test("AC-014: a leftover marked projection is removed and reported; a nested one is not", async () => {
    const f = fixture();
    const dir = place(f);
    markFile(join(dir, "P-99.md"), `${PROJECTION_MARK}\n古い写し\n`);
    markFile(join(dir, "nested", "P-98.md"), `${PROJECTION_MARK}\n下の写し\n`);
    const server = await fakeServer([projection()]);
    try {
      asOutsideIn(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
      expect(r.code).toBe(0);
      expect(() => readFileSync(join(dir, "P-99.md"), "utf8")).toThrow();
      expect(readFileSync(join(dir, "nested", "P-98.md"), "utf8")).toContain("下の写し");
      expect(r.out).toContain("消した 1 件");
      expect(r.out).toContain("P-99.md");
    } finally {
      await server.close();
    }
  });

  test("AC-015: without A the drawing refuses, and --out draws anyway", async () => {
    const f = fixture();
    const empty = projection({ projections: [] });
    const noOut = await fakeServer([empty]);
    try {
      asOutsideIn(f, noOut.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("写しを描かない");
      expect(() => readdirSync(place(f))).toThrow();
    } finally {
      await noOut.close();
    }
    const out = tmpDir("idd-intent-draw-out-");
    const withOut = await fakeServer([empty]);
    try {
      asLane(f, withOut.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--out", out]));
      expect(r.code).toBe(0);
      expect(readFileSync(join(out, "P-1.md"), "utf8")).toBe(P1.content);
      expect(readFileSync(join(out, "overview.md"), "utf8")).toBe(OVERVIEW.content);
    } finally {
      await withOut.close();
    }
    // an unmarked file of the same name under --out refuses
    const out2 = tmpDir("idd-intent-draw-out2-");
    writeFileSync(join(out2, "P-1.md"), "人が書いた\n");
    const clash = await fakeServer([projection()]);
    try {
      asLane(f, clash.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--out", out2]));
      expect(r.code).toBe(2);
      expect(readFileSync(join(out2, "P-1.md"), "utf8")).toBe("人が書いた\n");
      expect(readdirSync(out2)).toEqual(["P-1.md"]);
    } finally {
      await clash.close();
    }
  });

  test("AC-016: another repo is refused without --out, and the unregistered cwd too", async () => {
    const f = fixture();
    const server = await fakeServer([projection({ repo: "me/other", project: "other" }), projection({ repo: "me/other", project: "other" })]);
    try {
      delete process.env.IDD_ID;
      process.env.IDD_AGENT_BASE_URL = server.url;
      process.env.IDD_REPOS_FILE = f.repos;
      process.env.IDD_STATE_DIR = tmpDir("idd-intent-draw-state-");
      process.chdir(f.clone);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/other"]));
      expect(r.code).toBe(2);
      expect(r.err).toContain("me/app");
      expect(git(f.clone, ["status", "--porcelain", "-uall"])).toBe("");
      expect(() => readdirSync(join(f.clone, "_docs"))).toThrow();

      // with --out the repo is not looked at
      const out = tmpDir("idd-intent-draw-other-");
      const byRepo = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/other", "--out", out]));
      expect(byRepo.code).toBe(0);
      expect(readFileSync(join(out, "P-1.md"), "utf8")).toBe(P1.content);
    } finally {
      await server.close();
    }

    // cwd outside any registered repo, no --out: refused
    const nowhere = tmpDir("idd-intent-draw-nowhere-");
    delete process.env.IDD_ID;
    process.env.IDD_REPOS_FILE = f.repos;
    process.env.IDD_AGENT_BASE_URL = "http://127.0.0.1:1";
    process.chdir(nowhere);
    const unregistered = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
    expect(unregistered.code).not.toBe(0);
  });

  test("AC-020: a kind that cannot be drawn fails the drawing after A was written", async () => {
    const f = fixture();
    const server = await fakeServer([projection({ projections: ["A", "B"] })]);
    try {
      asOutsideIn(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
      expect(r.code).toBe(1);
      expect(r.err).toContain("B");
      expect(readFileSync(join(place(f), "P-1.md"), "utf8")).toBe(P1.content);
    } finally {
      await server.close();
    }
  });
});

describe("idd intent draw: symlinks", () => {
  test("AC-027: a symlink at a name to be drawn refuses, and the outside file keeps its bytes", async () => {
    const f = fixture();
    const outside = join(f.root, "outside.md");
    writeFileSync(outside, `${PROJECTION_MARK}\n外のファイル\n`);
    const dir = place(f);
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "overview.md"));
    const server = await fakeServer([projection()]);
    try {
      asOutsideIn(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
      expect(r.code).toBe(2);
      expect(r.err).toContain("overview.md");
      expect(readFileSync(outside, "utf8")).toBe(`${PROJECTION_MARK}\n外のファイル\n`);
      expect(readdirSync(dir)).toEqual(["overview.md"]);
    } finally {
      await server.close();
    }
  });

  test("AC-027: a symlink on the way to the place refuses, and the outside directory stays empty", async () => {
    const f = fixture();
    const outside = join(f.root, "outside-dir");
    mkdirSync(outside);
    mkdirSync(join(f.clone, "_docs", "intent"), { recursive: true });
    symlinkSync(outside, join(f.clone, "_docs", "intent", "app"));
    const server = await fakeServer([projection()]);
    try {
      asOutsideIn(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
      expect(r.code).toBe(2);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      await server.close();
    }

    // the same for `_docs/intent` itself
    const f2 = fixture();
    const outside2 = join(f2.root, "outside-intent");
    mkdirSync(outside2);
    mkdirSync(join(f2.clone, "_docs"), { recursive: true });
    symlinkSync(outside2, join(f2.clone, "_docs", "intent"));
    const server2 = await fakeServer([projection()]);
    try {
      asOutsideIn(f2, server2.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
      expect(r.code).toBe(2);
      expect(readdirSync(outside2)).toEqual([]);
    } finally {
      await server2.close();
    }
  });

  test("AC-027: a leftover symlink is not removed, and its target stays", async () => {
    const f = fixture();
    const outside = join(f.root, "outside-leftover.md");
    writeFileSync(outside, `${PROJECTION_MARK}\n外の余り\n`);
    const dir = place(f);
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "P-99.md"));
    const server = await fakeServer([projection()]);
    try {
      asOutsideIn(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
      expect(r.code).toBe(0);
      expect(lstatSync(join(dir, "P-99.md")).isSymbolicLink()).toBe(true);
      expect(readFileSync(outside, "utf8")).toContain("外の余り");
    } finally {
      await server.close();
    }
  });

  test("AC-027: a name with a separator or .. from the door refuses before anything is written", async () => {
    for (const name of ["../x.md", "a/b.md", "a\\b.md"]) {
      const f = fixture();
      const server = await fakeServer([projection({ files: [{ name, content: "x\n" }] })]);
      try {
        asOutsideIn(f, server.url);
        const r = await capture(() => runLaneCommand("intent", ["draw", "--repo", "me/app"]));
        expect(r.code, name).toBe(2);
        expect(() => readdirSync(place(f))).toThrow();
      } finally {
        await server.close();
      }
    }
  });
});
