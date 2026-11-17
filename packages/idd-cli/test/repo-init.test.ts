import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

const IDD_TS = join(import.meta.dir, "..", "bin", "idd.ts");
const TOKEN = "token-for-the-repo-init-test";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** a repo with a bare remote, its clone as the upstream, and a registry file that is empty; without the entrance the repo declares no check */
function fixture(entrance = true) {
  const root = tmpDir("idd-repo-init-");
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "--initial-branch=main");
  writeFileSync(join(seed, entrance ? "package.json" : "README.md"), entrance ? JSON.stringify({ scripts: { test: "node --test" } }) : "# app\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  const bare = join(root, "remote.git");
  git(root, "clone", "-q", "--bare", seed, bare);
  const upstream = join(root, "upstream");
  git(root, "clone", "-q", bare, upstream);
  const repos = join(root, "repos.yaml");
  writeFileSync(repos, "repos:\n");
  // a gh that knows the label, so the run asks no network
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '[{\"name\":\"idd-ready\"}]'\n");
  chmodSync(join(bin, "gh"), 0o755);
  const gitconfig = join(root, "gitconfig");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    IDD_REPOS_FILE: repos,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    IDD_AGENT_TOKEN: TOKEN,
    IDD_REPORT_RETRY_MS: "50",
    IDD_REPORT_RETRY_INTERVAL_MS: "10",
  } as NodeJS.ProcessEnv;
  delete env.IDD_ID;
  delete env.IDD_SESSION_ID;
  return { root, upstream, work: join(root, "work"), repos, env };
}

interface Piped { code: number | null; stdout: string; stderr: string }

function run(args: string[], env: NodeJS.ProcessEnv): Promise<Piped> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [IDD_TS, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

/** a fake door that records the calls it got */
async function fakeDoor(reply: { status: number; body: unknown }, read?: { status: number; body: unknown }) {
  const received: { path: string; auth?: string; body: Record<string, unknown>; method?: string }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      received.push({ path: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {}, method: req.method });
      // a read of a record (GET) is answered apart from the write
      const answer = req.method === "GET" && read ? read : reply;
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { received, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const base = (f: ReturnType<typeof fixture>) => ["repo", "init", "--github", "me/app", "--upstream", f.upstream, "--work", f.work, "--existing", "--git-user-name", "Me", "--git-user-email", "me@example.com"];

describe("idd repo init: the dry run, the overview and the exit status", () => {
  test("AC-006: a dry run with nothing in the way succeeds, says it is a dry run, and changes nothing", async () => {
    const f = fixture();
    const r = await run([...base(f), "--dry-run", "--overview", "メモの CLI"], f.env);
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout);
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.blockers).toEqual([]);
    expect(existsSync(f.work)).toBe(false);
    expect(readFileSync(f.repos, "utf8")).toBe("repos:\n");
    expect(() => git(f.upstream, "config", "--local", "--get", "user.name")).toThrow();
  }, 60000);

  test("AC-006: a dry run with a reason to stop fails, in the answer and in the exit status", async () => {
    const f = fixture();
    const r = await run(["repo", "init", "--github", "me/app", "--upstream", f.upstream, "--work", f.work, "--existing", "--dry-run"], f.env);
    expect(r.code).toBe(1);
    const res = JSON.parse(r.stdout);
    expect(res.ok).toBe(false);
    expect(res.blockers.join(" ")).toContain("user.name");
  }, 60000);

  test("AC-004: the overview is raised as P-1 from outside any lane, after the registry is written", async () => {
    const f = fixture();
    const door = await fakeDoor({ status: 200, body: { ok: true, id: "P-1", status: "active" } });
    try {
      const r = await run([...base(f), "--overview", "メモを取る小さな CLI"], { ...f.env, IDD_AGENT_BASE_URL: door.url, IDD_SESSION_ID: "chat-1" });
      expect(r.stderr).not.toContain("Error");
      expect(r.code).toBe(0);
      const res = JSON.parse(r.stdout);
      expect(res.prerequisites.overview.state).toBe("raised");
      expect(door.received.length).toBe(1);
      expect(door.received[0].path).toBe("/api/idd/intent");
      expect(door.received[0].auth).toBe(`Bearer ${TOKEN}`);
      expect(door.received[0].body).toMatchObject({ action: "raise_purpose", session: "chat-1", repo: "me/app", payload: { id: "P-1", statement: "メモを取る小さな CLI" } });
      expect(door.received[0].body).not.toHaveProperty("idd_id");
      expect(readFileSync(f.repos, "utf8")).toContain("me/app");
    } finally {
      await door.close();
    }
  }, 60000);

  test("AC-004: a registration without an overview calls no door, and an unreachable door is reported with the way to write it later", async () => {
    const f = fixture();
    const door = await fakeDoor({ status: 200, body: { ok: true } });
    try {
      const none = await run([...base(f)], { ...f.env, IDD_AGENT_BASE_URL: door.url });
      expect(none.code).toBe(0);
      expect(JSON.parse(none.stdout).prerequisites.overview.state).toBe("none");
      expect(door.received.length).toBe(0);
    } finally {
      await door.close();
    }
    // a second repo, and a door that refuses: the registration stands, the result says what was not written
    const g = fixture();
    const refusing = await fakeDoor({ status: 400, body: { ok: false, error: "repo はありません" } });
    try {
      const r = await run([...base(g), "--overview", "概要"], { ...g.env, IDD_AGENT_BASE_URL: refusing.url });
      expect(r.code).toBe(0);
      const res = JSON.parse(r.stdout);
      expect(res.ok).toBe(true);
      expect(res.prerequisites.overview.state).toBe("unreachable");
      expect(res.prerequisites.overview.note).toContain("idd intent raise purpose --repo me/app");
      expect(res.warnings.join("\n")).toContain("repo はありません");
      expect(readFileSync(g.repos, "utf8")).toContain("me/app");
    } finally {
      await refusing.close();
    }
  }, 60000);

  test("AC-004: a repo that already has a P-1 keeps it, shows how the given text differs, and points at the proposal that replaces it", async () => {
    const f = fixture();
    const door = await fakeDoor({ status: 400, body: { ok: false, error: "ID P-1 は既にあります" } }, { status: 200, body: { ok: true, kind: "purpose", record: { id: "P-1", statement: "古い概要", status: "active" } } });
    try {
      const r = await run([...base(f), "--overview", "新しい概要"], { ...f.env, IDD_AGENT_BASE_URL: door.url });
      expect(r.code).toBe(0);
      const res = JSON.parse(r.stdout);
      expect(res.ok).toBe(true);
      expect(res.prerequisites.overview.state).toBe("kept");
      const note = res.prerequisites.overview.note as string;
      expect(note).toContain("置き換えていません");
      expect(note).toContain("古い概要");
      expect(note).toContain("新しい概要");
      expect(note).toContain("idd intent propose overview --repo me/app");
      expect(res.warnings.join("\n")).toContain("古い概要");
      // one write that was refused and one read; nothing else touched P-1
      expect(door.received.map((x) => x.method)).toEqual(["POST", "GET"]);
      expect(door.received[1].path).toContain("op=show");
      expect(readFileSync(f.repos, "utf8")).toContain("me/app");
    } finally {
      await door.close();
    }
  }, 60000);

  test("AC-004: a P-1 that already says the given text is kept without a difference to show", async () => {
    const f = fixture();
    const door = await fakeDoor({ status: 400, body: { ok: false, error: "ID P-1 は既にあります" } }, { status: 200, body: { ok: true, kind: "purpose", record: { id: "P-1", statement: "同じ  概要", status: "active" } } });
    try {
      const r = await run([...base(f), "--overview", "同じ 概要"], { ...f.env, IDD_AGENT_BASE_URL: door.url });
      expect(r.code).toBe(0);
      const res = JSON.parse(r.stdout);
      expect(res.prerequisites.overview.state).toBe("kept");
      expect(res.prerequisites.overview.note).toContain("同じ文");
      expect(res.warnings.join("\n")).not.toContain("渡された概要は書いていません");
    } finally {
      await door.close();
    }
  }, 60000);
});

describe("idd repo init: the list of checks and setup the user goes over", () => {
  /** one run with the expected exit code, and the JSON it printed when it printed one */
  const registered = async (f: ReturnType<typeof fixture>, args: string[], code = 0) => {
    const r = await run([...base(f), ...args], f.env);
    expect(r.code).toBe(code);
    return { ...r, out: r.stdout ? JSON.parse(r.stdout) : null };
  };
  const nothingWritten = (f: ReturnType<typeof fixture>) => {
    expect(existsSync(f.work)).toBe(false);
    expect(readFileSync(f.repos, "utf8")).toBe("repos:\n");
  };

  test("AC-001 AC-002 AC-004: the dry run writes the list, and the corrected list is what the registration declares", async () => {
    const f = fixture();
    const list = join(f.root, "list.yaml");
    await registered(f, ["--dry-run", "--checks-out", list]);
    nothingWritten(f);
    const written = readFileSync(list, "utf8");
    expect(written).toContain('command: "npm test"');
    expect(written).toContain('from: "package.json の scripts.test"');
    writeFileSync(list, written.replace('"npm test"', '"npm run unit"'));
    const { out } = await registered(f, ["--checks-file", list]);
    expect(out.prerequisites.publicChecks.state).toBe("confirmed");
    expect(out.prerequisites.publicChecks.unconfirmed).toBeUndefined();
    expect(out.warnings.join("\n")).not.toContain("確かめていません");
    expect(readFileSync(f.repos, "utf8")).toContain('"npm run unit"');
  }, 60000);

  test("AC-003: a registration without a list still goes through and says what was not confirmed", async () => {
    const { out } = await registered(fixture(), []);
    expect(out.prerequisites.publicChecks.unconfirmed.checks).toEqual(["test（npm test）"]);
    expect(out.warnings.join("\n")).toContain("確かめていません");
  }, 60000);

  test("a repo whose checks cannot be found stops with nothing written, and an empty list from its dry run takes the user's line", async () => {
    const f = fixture(false);
    const stopped = await registered(f, [], 1);
    expect(stopped.out.prerequisites.publicChecks.state).toBe("none");
    expect(stopped.out.blockers.join("\n")).toContain("公開側の検査を見つけられませんでした");
    nothingWritten(f);
    const list = join(f.root, "list.yaml");
    await registered(f, ["--dry-run", "--checks-out", list], 1);
    nothingWritten(f);
    writeFileSync(list, readFileSync(list, "utf8").replace(/^checks:$/m, "checks:\n  - name: test\n    command: python3 -m unittest\n    from: ci.sh"));
    const { out } = await registered(f, ["--checks-file", list]);
    expect(out.prerequisites.publicChecks.state).toBe("confirmed");
    expect(readFileSync(f.repos, "utf8")).toContain("python3 -m unittest");
  }, 60000);

  test("AC-005: a list that cannot be read stops the run with exit 1 and writes nothing", async () => {
    const f = fixture();
    const { out } = await registered(f, ["--checks-file", join(f.root, "nope.yaml")], 1);
    expect(out.blockers.join(" ")).toContain("file がありません");
    nothingWritten(f);
  }, 60000);

  test("a flag that takes a value but is followed by another flag is refused, not given the next flag's name", async () => {
    const f = fixture();
    for (const args of [["--checks-file", "--dry-run"], ["--check", "--dry-run"], ["--check", "--unknown-flag"], ["--overview"]]) {
      expect((await registered(f, args, 2)).stderr).toContain(args[0]);
    }
    nothingWritten(f);
  }, 60000);

  test("an empty value for --check or the list flags is refused, not read as none given", async () => {
    const f = fixture();
    for (const args of [["--checks-file", ""], ["--checks-out", "", "--dry-run"], ["--check", ""], ["--check", "  "]]) {
      expect((await registered(f, args, 2)).stderr).toContain(args[0]);
    }
    nothingWritten(f);
  }, 60000);
});
