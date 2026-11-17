import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runLaneCommand } from "../src/lane-commands.ts";
import { PROJECTION_MARK } from "../../idd-core/src/intent/projection.ts";
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

/** a clone on a feature branch, registered under me/app, with the base it merges against */
function fixture(base = "main") {
  const root = tmpDir("idd-intent-check-");
  const clone = join(root, "clone");
  mkdirSync(clone);
  git(clone, ["init", "--quiet", "-b", "main"]);
  writeFileSync(join(clone, "a.txt"), "1\n");
  git(clone, ["add", "-A"]);
  git(clone, ["commit", "--quiet", "-m", "base"]);
  git(clone, ["checkout", "--quiet", "-b", "feature"]);
  writeFileSync(join(clone, "a.txt"), "2\n");
  git(clone, ["add", "-A"]);
  git(clone, ["commit", "--quiet", "-m", "feature"]);
  const repos = join(root, "repos.yaml");
  writeFileSync(repos, JSON.stringify({ repos: { "me/app": { name: "app", upstream: clone, work: clone, public_base: base, remote: "" } } }));
  const state = join(root, "state");
  mkdirSync(state);
  return { root, clone, repos, state };
}

function asLane(f: ReturnType<typeof fixture>, url: string) {
  process.env.IDD_ID = "IDD-1";
  process.env.IDD_AGENT_BASE_URL = url;
  process.env.IDD_REPOS_FILE = f.repos;
  process.env.IDD_STATE_DIR = f.state;
  process.chdir(f.clone);
}

function asOutside(url: string) {
  delete process.env.IDD_ID;
  process.env.IDD_AGENT_BASE_URL = url;
  process.env.IDD_STATE_DIR = tmpDir("idd-intent-check-state-");
}

/** the fixture's clone, called as the outside: --repo decides the door and the tree is the caller's worktree */
function asOutsideIn(f: ReturnType<typeof fixture>, url: string) {
  delete process.env.IDD_ID;
  process.env.IDD_AGENT_BASE_URL = url;
  process.env.IDD_REPOS_FILE = f.repos;
  process.env.IDD_STATE_DIR = tmpDir("idd-intent-check-state-");
  process.chdir(f.clone);
}

const check = (body: Record<string, unknown>) => ({ status: 200, body: { ok: true, findings: [], choices: [], rounds: { enteredImplementation: true }, ...body } });

describe("idd intent check: what it cannot see fails it", () => {
  test("the door is not reachable: a non-zero code and the reason on stderr", async () => {
    asOutside("http://127.0.0.1:1");
    const r = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
    expect(r.code).not.toBe(0);
    expect(r.err.length).toBeGreaterThan(0);
  });

  test("no repo can be decided and no --repo is given: a non-zero code", async () => {
    asOutside("http://127.0.0.1:1");
    delete process.env.IDD_REPOS_FILE;
    process.chdir(tmpDir("idd-intent-check-nowhere-"));
    const r = await capture(() => runLaneCommand("intent", ["check"]));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("repo");
  });

  test("a lane whose base cannot be found: a non-zero code and the touched Places are named as unseen", async () => {
    const f = fixture("no-such-branch");
    const server = await fakeServer();
    try {
      asLane(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["check"]));
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("触った Place");
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("the door refuses: a non-zero code", async () => {
    const server = await fakeServer([{ status: 400, body: { ok: false, error: "unknown lane: IDD-9" } }]);
    try {
      asOutside(server.url);
      const r = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("unknown lane");
    } finally {
      await server.close();
    }
  });
});

describe("idd intent check: the exit code, the output and where the tree is read", () => {
  test("nothing to report ends in 0", async () => {
    const f = fixture();
    const server = await fakeServer([check({})]);
    try {
      asLane(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["check"]));
      expect(r.code).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("an error ends in 0 以外 and its line names the rule, the record and the reason", async () => {
    const f = fixture();
    const server = await fakeServer([check({ findings: [{ weight: "error", rule: "required", id: "C-1-1", reason: "必須の欄 why が空です" }] })]);
    try {
      asLane(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["check"]));
      expect(r.code).toBe(1);
      expect(r.out).toContain("required");
      expect(r.out).toContain("C-1-1");
      expect(r.out).toContain("why");
    } finally {
      await server.close();
    }
  });

  test("notes and marks alone end in 0 and are still shown", async () => {
    const f = fixture();
    const server = await fakeServer([check({
      findings: [
        { weight: "note", rule: "required", id: "C-out-1", reason: "必須の欄 why が空です" },
        { weight: "mark", rule: "symbols", id: "C-1-1", reason: "gone が見つかりません" },
      ],
    })]);
    try {
      asLane(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["check"]));
      expect(r.code).toBe(0);
      expect(r.out).toContain("note");
      expect(r.out).toContain("mark");
    } finally {
      await server.close();
    }
  });

  test("--json carries the same findings and the counts", async () => {
    const f = fixture();
    const server = await fakeServer([check({ findings: [{ weight: "error", rule: "required", id: "C-1-1", reason: "必須の欄 why が空です" }] })]);
    try {
      asLane(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["check", "--json"]));
      expect(r.code).toBe(1);
      const body = JSON.parse(r.out);
      expect(body.ok).toBe(true);
      expect(body.counts.error).toBe(1);
      expect(body.findings.length).toBe(1);
      expect(body.checked).toEqual({ rounds: true, touched: true, projection: false });
    } finally {
      await server.close();
    }
  });

  test("a Place is judged in the caller's worktree, not by the door", async () => {
    const f = fixture();
    const server = await fakeServer([check({ choices: [{ id: "C-1-1", status: "active", place: [{ path: "nope/x.ts", kind: "file" }], mine: true }] })]);
    try {
      asLane(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["check"]));
      expect(r.code).toBe(1);
      expect(r.out).toContain("place");
      expect(r.out).toContain("C-1-1");
      // the module is what has to stand; the file is the mark
      expect(r.out).toContain("nope/");
      const url = new URL(server.received[0].path, "http://x");
      expect(url.searchParams.get("op")).toBe("check");
      expect(url.searchParams.get("lane")).toBe("IDD-1");
      expect(server.received[0].auth).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  test("a lane refuses --repo and --view-lane; the outside refuses --view-lane and uses --repo or the cwd's repo", async () => {
    const f = fixture();
    const server = await fakeServer([check({}), check({}), check({})]);
    try {
      asLane(f, server.url);
      for (const flag of [["--repo", "me/app"], ["--view-lane", "IDD-1"]]) {
        const r = await capture(() => runLaneCommand("intent", ["check", ...flag]));
        expect(r.code, flag[0]).toBe(2);
      }
      expect(server.received.length).toBe(0);

      const lane = await capture(() => runLaneCommand("intent", ["check"]));
      expect(lane.code).toBe(0);

      // the outside: --view-lane is not honored, and --repo or the cwd's repo decides the door's repo
      delete process.env.IDD_ID;
      const refused = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app", "--view-lane", "IDD-1"]));
      expect(refused.code).toBe(2);
      const byRepo = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
      expect(byRepo.code).toBe(0);
      expect(byRepo.out).toContain("巡と触った Place は見ていない");
      const byCwd = await capture(() => runLaneCommand("intent", ["check"]));
      expect(byCwd.code).toBe(0);

      const checks = server.received.filter((x) => new URL(x.path, "http://x").searchParams.get("op") === "check");
      const named = new URL(checks[1].path, "http://x");
      expect(named.searchParams.get("repo")).toBe("me/app");
      expect(named.searchParams.get("lane")).toBeNull();
      const cwdRepo = new URL(checks[2].path, "http://x");
      expect(cwdRepo.searchParams.get("repo")).toBe("me/app");
    } finally {
      await server.close();
    }
  });

  test("AC-003: an unconfirmed Choice on a Place the lane touched is a note, and the check still reports it", async () => {
    const f = fixture();
    const server = await fakeServer([
      check({ choices: [{ id: "C-1-1", status: "unconfirmed", place: [{ path: "a.txt", kind: "file" }], mine: true }] }),
      proj({ projections: [] }),
    ]);
    try {
      asLane(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["check"]));
      expect(r.code).toBe(0);
      expect(r.out).toContain("touched");
      expect(r.out).toContain("C-1-1");
    } finally {
      await server.close();
    }
  });

  test("AC-017: a file Place moved into the archive is not a defect; other missing paths still are", async () => {
    const f = fixture();
    const choices = [
      { id: "C-1-1", status: "active", place: [{ path: "_docs/intent/app/one/decision.md", kind: "file" }], mine: true },
      { id: "C-1-2", status: "active", place: [{ path: "_docs/intent/app/none/decision.md", kind: "file" }], mine: true },
      { id: "C-1-3", status: "active", place: [{ path: "_docs/qa/app/one/qa.md", kind: "file" }], mine: true },
    ];
    const server = await fakeServer([check({ choices }), proj({ projections: [] })]);
    try {
      asLane(f, server.url);
      mkdirSync(join(f.clone, "_docs", "archives", "intent", "app", "one"), { recursive: true });
      writeFileSync(join(f.clone, "_docs", "archives", "intent", "app", "one", "decision.md"), "# moved\n");
      const r = await capture(() => runLaneCommand("intent", ["check"]));
      expect(r.code).toBe(1);
      expect(r.out).not.toContain("_docs/intent/app/one/");
      expect(r.out).toContain("_docs/intent/app/none/");
      expect(r.out).toContain("_docs/qa/app/one/");
    } finally {
      await server.close();
    }
  });

  test("the check writes nothing: the worktree status and the state dir are unchanged", async () => {
    const f = fixture();
    const server = await fakeServer([check({})]);
    try {
      asLane(f, server.url);
      const status = git(f.clone, ["status", "--porcelain"]);
      const state = readdirSync(f.state);
      await capture(() => runLaneCommand("intent", ["check"]));
      expect(git(f.clone, ["status", "--porcelain"])).toBe(status);
      expect(readdirSync(f.state)).toEqual(state);
    } finally {
      await server.close();
    }
  });
});

// ---- Issue IDD-106: the projection rules of the check ----

const proj = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: { ok: true, repo: "me/app", project: "app", dir: "_docs/intent/app/", projections: ["A"], files: [], ...over },
});

const projectionFile = (name: string, body: string) => ({ name, content: `${PROJECTION_MARK}\n${body}` });

/** every file under a directory, path -> content (a symlink is named, never followed) */
function snapshotDir(dir: string): Record<string, string> {
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
  try { walk(dir, ""); } catch { /* the place does not exist */ }
  return out;
}

describe("idd intent check: the projection rules", () => {
  test("AC-017: a hand-edited projection is a defect; the drawn text in the tree is not", async () => {
    const f = fixture();
    const content = projectionFile("P-1.md", "# P-1: S\n").content;
    const files = [projectionFile("P-1.md", "# P-1: S\n")];
    const server = await fakeServer([
      check({}), proj({ files }),
      check({}), proj({ files }),
    ]);
    try {
      asOutsideIn(f, server.url);
      const dir = join(f.clone, "_docs", "intent", "app");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "P-1.md"), `${PROJECTION_MARK}\n# 手で直した\n`);
      const bad = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
      expect(bad.code).toBe(1);
      expect(bad.out).toContain("写しが直されています");
      expect(bad.out).toContain("idd intent draw");

      writeFileSync(join(dir, "P-1.md"), content);
      const good = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
      expect(good.code).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("AC-005: the outside fails on a missing, an edited, a leftover and an unmarked projection", async () => {
    const f = fixture();
    const files = [
      projectionFile("P-1.md", "# P-1: S\n"),
      projectionFile("P-2.md", "# P-2: S\n"),
      projectionFile("overview.md", "## 概要\n"),
    ];
    const server = await fakeServer([check({}), proj({ files })]);
    try {
      asOutsideIn(f, server.url);
      const dir = join(f.clone, "_docs", "intent", "app");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "P-1.md"), "人が書いた\n"); // unmarked
      writeFileSync(join(dir, "P-2.md"), `${PROJECTION_MARK}\n# 手で直した\n`); // edited
      writeFileSync(join(dir, "P-99.md"), `${PROJECTION_MARK}\n余り\n`); // leftover
      const r = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
      expect(r.code).toBe(1);
      expect(r.out).toContain("写しがありません"); // overview.md
      expect(r.out).toContain("写しが直されています"); // P-2.md
      expect(r.out).toContain("描く一覧に無い写しが残っています"); // P-99.md
      expect(r.out).toContain("写しの場所に写しでないファイルがあります"); // P-1.md
    } finally {
      await server.close();
    }
  });

  test("AC-018: the projection rules write neither the tree nor the state", async () => {
    const f = fixture();
    const files = [projectionFile("P-1.md", "# P-1: S\n"), projectionFile("overview.md", "## 概要\n")];
    const server = await fakeServer([check({}), proj({ files })]);
    try {
      const state = asOutsideIn(f, server.url);
      const dir = join(f.clone, "_docs", "intent", "app");
      mkdirSync(join(dir, "nested"), { recursive: true });
      writeFileSync(join(dir, "P-1.md"), `${PROJECTION_MARK}\n手で直した\n`);
      writeFileSync(join(dir, "P-99.md"), `${PROJECTION_MARK}\n余り\n`);
      writeFileSync(join(dir, "nested", "P-98.md"), `${PROJECTION_MARK}\n下の写し\n`);
      const status = git(f.clone, ["status", "--porcelain", "-uall"]);
      const before = snapshotDir(dir);
      const stateBefore = snapshotDir(state);

      const r = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
      expect(r.code).toBe(1);
      expect(git(f.clone, ["status", "--porcelain", "-uall"])).toBe(status);
      expect(snapshotDir(dir)).toEqual(before);
      expect(snapshotDir(state)).toEqual(stateBefore);
    } finally {
      await server.close();
    }
  });

  test("AC-004: a lane-named check does not look at the projections, and says so", async () => {
    const f = fixture();
    const files = [projectionFile("P-1.md", "# P-1: S\n")];
    const server = await fakeServer([check({}), proj({ files }), check({}), proj({ files })]);
    try {
      asLane(f, server.url);
      const dir = join(f.clone, "_docs", "intent", "app");
      mkdirSync(dir, { recursive: true });
      // the lane's tree holds a hand-edited projection; a lane-named check must not report it
      writeFileSync(join(dir, "P-1.md"), `${PROJECTION_MARK}\n# 手で直した\n`);
      const r = await capture(() => runLaneCommand("intent", ["check"]));
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("写しが直されています");
      expect(r.out).toContain("写しは見ていない");

      const j = await capture(() => runLaneCommand("intent", ["check", "--json"]));
      const body = JSON.parse(j.out);
      expect(body.checked).toEqual({ rounds: true, touched: true, projection: false });
      expect(body.findings.some((x: { rule: string }) => x.rule === "projection" || x.rule === "projection-kind")).toBe(false);
      // the door was never asked for the drawing: only the state's own call went out
      expect(server.received.every((x) => new URL(x.path, "http://x").searchParams.get("op") === "check")).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("AC-019: with A off the outside sees no projection rules, and the output says so", async () => {
    const f = fixture();
    const server = await fakeServer([
      check({}), proj({ projections: [] }),
      check({}), proj({ projections: [] }),
    ]);
    try {
      asOutsideIn(f, server.url);
      const dir = join(f.clone, "_docs", "intent", "app");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "P-1.md"), `${PROJECTION_MARK}\n古い\n`);
      const r = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
      expect(r.code).toBe(0);
      expect(r.out).toContain("この repo は写しを描かない");
      expect(r.out).not.toContain("projection");

      const j = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app", "--json"]));
      expect(JSON.parse(j.out).checked).toEqual({ rounds: false, touched: false, projection: false });
    } finally {
      await server.close();
    }
  });

  test("AC-020: a kind that cannot be drawn is an error of the check", async () => {
    const f = fixture();
    const server = await fakeServer([check({}), proj({ projections: ["A", "C"] })]);
    try {
      asOutsideIn(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
      expect(r.code).toBe(1);
      expect(r.out).toContain("C");
      expect(r.out).toContain("projection-kind");
    } finally {
      await server.close();
    }
  });

  test("AC-027: a symlink at a name, or on the way to the place, is an error the outside file cannot pass", async () => {
    const f = fixture();
    const outside = join(f.root, "outside.md");
    writeFileSync(outside, `${PROJECTION_MARK}\n# P-1: S\n`);
    const server = await fakeServer([check({}), proj({ files: [projectionFile("P-1.md", "# P-1: S\n")] })]);
    try {
      asOutsideIn(f, server.url);
      const dir = join(f.clone, "_docs", "intent", "app");
      mkdirSync(dir, { recursive: true });
      symlinkSync(outside, join(dir, "P-1.md"));
      const r = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
      expect(r.code).toBe(1);
      expect(readFileSync(outside, "utf8")).toContain("# P-1: S");
    } finally {
      await server.close();
    }

    // the place itself is a symlink
    const f2 = fixture();
    const outsideDir = join(f2.root, "outside-dir");
    mkdirSync(outsideDir);
    const server2 = await fakeServer([check({}), proj({ files: [projectionFile("P-1.md", "# P-1: S\n")] })]);
    try {
      asOutsideIn(f2, server2.url);
      mkdirSync(join(f2.clone, "_docs", "intent"), { recursive: true });
      symlinkSync(outsideDir, join(f2.clone, "_docs", "intent", "app"));
      const r = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
      expect(r.code).toBe(1);
      expect(readdirSync(outsideDir)).toEqual([]);
    } finally {
      await server2.close();
    }
  });
});

describe("idd intent check: a bare test name is looked up in the caller's own tree", () => {
  test("AC-006: outside a lane, a test that stands in the tree is not marked missing either", async () => {
    const choices = [{ id: "C-1-1", status: "active", place: [{ path: "a.txt", kind: "file" }], mine: false, verification: ["foo.test.mjs"] }];
    const f = fixture();
    const server = await fakeServer([check({ choices }), proj({ projections: [] })]);
    try {
      asOutsideIn(f, server.url);
      mkdirSync(join(f.clone, "tests"), { recursive: true });
      writeFileSync(join(f.clone, "tests", "foo.test.mjs"), "// a test the tree holds\n");
      const stands = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
      expect(stands.code).toBe(0);
      expect(stands.out).not.toContain("検証物 foo.test.mjs が tree にありません");
    } finally {
      await server.close();
    }
  });

  test("AC-006: a name the tree does not hold is still marked", async () => {
    const choices = [{ id: "C-1-2", status: "active", place: [{ path: "a.txt", kind: "file" }], mine: false, verification: ["gone.test.mjs"] }];
    const f = fixture();
    const server = await fakeServer([check({ choices }), proj({ projections: [] })]);
    try {
      asOutsideIn(f, server.url);
      const r = await capture(() => runLaneCommand("intent", ["check", "--repo", "me/app"]));
      expect(r.out).toContain("検証物 gone.test.mjs が tree にありません");
    } finally {
      await server.close();
    }
  });
});
