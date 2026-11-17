import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../bin/idd.ts");

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

interface LookupAnswer {
  choices?: unknown[];
  status?: number;
  /** never answer: the hook must give up at its own limit */
  hang?: boolean;
}

/** a stand-in for the engine's lookup door: it answers with the given Choices and records what it was asked */
async function lookupServer(answer: LookupAnswer = {}): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    if (answer.hang) return;
    const status = answer.status ?? 200;
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(status >= 400 ? { ok: false, error: "stand-in" } : { ok: true, choices: answer.choices ?? [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const choice = (id: string, status: string, path: string) => ({
  id,
  status,
  forms: { chosen: `chosen-${id}`, rejected: [] },
  place: [{ path, kind: "file" }],
  why: `why-${id}`,
  free: `free-${id}`,
});

/** a file Place that names the symbols an edit has to meet */
const symbolChoice = (id: string, status: string, path: string, symbols: string[]) => ({
  ...choice(id, status, path),
  place: [{ path, kind: "file", symbols }],
});

const dirChoice = (id: string, status: string, path: string) => ({ ...choice(id, status, path), place: [{ path, kind: "dir" }] });
const rootChoice = (id: string, status: string) => ({ ...choice(id, status, "/"), place: [{ path: "/", kind: "root" }] });

/** a git-worktree-shaped repo: `.git` is enough for the verb to find its root */
function tempRepo(): string {
  const dir = tempDir("idd-hook-repo-");
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "src"));
  return dir;
}

const bashPost = (command: string, cwd: string, session = "s1") => ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, cwd, session_id: session });
const bashPre = (command: string, cwd: string, session = "s1") => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd, session_id: session });

interface HookResult {
  code: number | null;
  out: string;
  err: string;
  ms: number;
}

/**
 * The verb in its own process, as the harness starts it (the hook is one process per tool call). Async on
 * purpose: a synchronous spawn would hold this process's event loop and the stand-in lookup server would never
 * answer.
 */
function hook(input: unknown, env: Record<string, string>): Promise<HookResult> {
  const started = Date.now();
  const child = spawn("bun", ["run", CLI, "intent", "hook"], {
    env: { ...process.env, IDD_STATE_DIR: tempDir("idd-hook-state-"), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
  child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  return new Promise<HookResult>((resolve) => {
    child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - started }));
  });
}

function rows(record: string): Record<string, unknown>[] {
  try {
    return readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const READ = { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "src/a.ts" }, session_id: "s1" };
const EDIT = { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "src/a.ts", old_string: "x", new_string: "y" }, session_id: "s1" };

describe("idd intent hook", () => {
  test("AC-015: a read, an edit and a compaction leave one row each, and a call with nothing to add leaves none", async () => {
    const server = await lookupServer({ choices: [choice("DEC-1", "unconfirmed", "src/a.ts")] });
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-107", IDD_INTENT_STAGE: "executor", IDD_INTENT_ROLE: "executor" };
      expect((await hook(READ, env)).code).toBe(0);
      expect((await hook(EDIT, env)).code).toBe(0);
      expect((await hook({ hook_event_name: "Compact", session_id: "s1" }, env)).code).toBe(0);
      const written = rows(record);
      expect(written.length).toBe(3);
      const [read, edit, compact] = written;
      for (const row of [read, edit]) {
        expect(typeof row.at).toBe("string");
        expect(row.session).toBe("s1");
        expect(row.lane).toBe("IDD-107");
        expect(row.stage).toBe("executor");
        expect(row.role).toBe("executor");
        expect(Array.isArray(row.choices)).toBe(true);
        expect((row.choices as { id: string; form: string }[])[0].id).toBe("DEC-1");
        expect(["body", "line", "notice"]).toContain((row.choices as { form: string }[])[0].form);
      }
      expect(read.event).toBe("read");
      expect(edit.event).toBe("edit");
      expect(compact.event).toBe("compact");
      // nothing to add: the lookup answers no Choice, and no Choice row is written
      const empty = await lookupServer({ choices: [] });
      try {
        const other = join(tempDir("idd-hook-rec-"), "record.jsonl");
        const before = await hook(READ, { ...env, IDD_AGENT_BASE_URL: empty.url, IDD_INTENT_RECORD: other });
        expect(before.code).toBe(0);
        expect(rows(other).length).toBe(0);
        expect(before.out).toBe("");
      } finally {
        await empty.close();
      }
    } finally {
      await server.close();
    }
  });

  test("AC-016: a second process skips what the first handed over; another record starts fresh", async () => {
    const server = await lookupServer({ choices: [choice("DEC-1", "active", "src/a.ts")] });
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-107" };
      const first = await hook(READ, env);
      expect(first.out).toContain("why-DEC-1");
      const second = await hook(READ, env);
      expect(second.code).toBe(0);
      expect(second.out).toBe("");
      const third = await hook(READ, { ...env, IDD_INTENT_RECORD: join(tempDir("idd-hook-rec-"), "other.jsonl") });
      expect(third.out).toContain("why-DEC-1");
    } finally {
      await server.close();
    }
  });

  test("AC-017: a refused, a failed or an unanswered lookup adds nothing and still exits 0", async () => {
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    const refused = await lookupServer();
    const failed = await lookupServer({ status: 500 });
    const hanging = await lookupServer({ hang: true });
    try {
      for (const server of [refused, failed, hanging]) {
        const r = await hook(READ, { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-107" });
        expect(r.code).toBe(0);
        expect(r.out).not.toContain("propter-intent");
        expect(rows(record).length).toBe(0);
      }
      // the hanging one waits for its own limit, and no longer
      expect(hanging.seen.length).toBe(1);
      // not JSON on standard input
      const broken = await hook("not json at all", { IDD_AGENT_BASE_URL: refused.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-107" });
      expect(broken.code).toBe(0);
      expect(broken.out).toBe("");
      // an unusable base URL
      const unreachable = await hook(READ, { IDD_AGENT_BASE_URL: "http://127.0.0.1:9", IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-107" });
      expect(unreachable.code).toBe(0);
    } finally {
      await Promise.all([refused.close(), failed.close(), hanging.close()]);
    }
  }, 30_000);

  test("AC-025: a new session is told how to look a Choice up; a resume is not; a compact start writes the row first", async () => {
    const server = await lookupServer({ choices: [] });
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-107" };
      const start = await hook({ hook_event_name: "SessionStart", source: "startup", session_id: "s1" }, env);
      expect(start.out).toContain("idd intent lookup");
      expect(rows(record).length).toBe(0);
      const resume = await hook({ hook_event_name: "SessionStart", source: "resume", session_id: "s1" }, env);
      expect(resume.out).toBe("");
      const compact = await hook({ hook_event_name: "SessionStart", source: "compact", session_id: "s1" }, env);
      expect(compact.out).toContain("idd intent lookup");
      expect(rows(record).map((r) => r.event)).toEqual(["compact"]);
    } finally {
      await server.close();
    }
  });

  test("AC-026: the hook names the Issue lane it belongs to when it looks Choices up", async () => {
    const server = await lookupServer({ choices: [] });
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const r = await hook(READ, { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-107", IDD_INTENT_STAGE: "r2", IDD_INTENT_ROLE: "r2-reviewer" });
      expect(r.code).toBe(0);
      expect(server.seen.length).toBe(1);
      expect(server.seen[0]).toContain("lane=IDD-107");
      expect(server.seen[0]).toContain("path=src%2Fa.ts");
    } finally {
      await server.close();
    }
  });

  test("the plan and record modes let the pi bridge judge before the tool and record after it", async () => {
    const server = await lookupServer({ choices: [choice("DEC-1", "active", "src/a.ts")] });
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-107" };
      const plan = await hook({ ...EDIT, idd_mode: "plan", tool_input: { file_path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] } }, env);
      expect(plan.code).toBe(0);
      const judged = JSON.parse(plan.out) as { text: string | null; rows: { event: string }[] };
      expect(judged.text).toContain("DEC-1");
      expect(rows(record).length).toBe(0);
      const recordMode = await hook({ ...EDIT, idd_mode: "record", idd_rows: judged.rows }, env);
      expect(recordMode.code).toBe(0);
      expect(recordMode.out).toBe("");
      expect(rows(record).length).toBe(1);
      expect(rows(record)[0].event).toBe("edit");
    } finally {
      await server.close();
    }
  });
});

describe("idd intent hook — Bash", () => {
  test("AC-005: a Bash read adds the same body a Read does", async () => {
    const written = [choice("DEC-1", "active", "src/a.ts"), choice("DEC-2", "unconfirmed", "src/a.ts"), dirChoice("DEC-D", "active", "src/")];
    const server = await lookupServer({ choices: written });
    const root = tempRepo();
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115" };
      const bash = await hook(bashPost("cat src/a.ts", root), env);
      expect(bash.code).toBe(0);
      const bashText = (JSON.parse(bash.out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      for (const id of ["DEC-1", "DEC-2"]) {
        expect(bashText).toContain(id);
        expect(bashText).toContain(`why-${id}`);
        expect(bashText).toContain(`free-${id}`);
      }
      expect(bashText).toContain("DEC-2 [unconfirmed]");
      // a dir's own Choice of the same module is the heading, not a body: it carries no why in either route
      expect(bashText).toContain("同じ module（src/）の Choice");
      expect(bashText).toContain("- DEC-D chosen-DEC-D");
      expect(bashText).not.toContain("why-DEC-D");
      // the same file read through the Read tool, on a fresh record, is the same text line for line
      const other = join(tempDir("idd-hook-rec-"), "record.jsonl");
      const read = await hook({ ...READ, cwd: root }, { ...env, IDD_INTENT_RECORD: other });
      const readText = (JSON.parse(read.out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      expect(bashText).toBe(readText);
      expect(rows(record)[0].event).toBe("bash-read");
    } finally {
      await server.close();
    }
  });

  test("AC-006: Bash and Read share what has been opened, in either order", async () => {
    const shared = { ...choice("DEC-1", "active", "src/a.ts"), place: [{ path: "src/a.ts", kind: "file" }, { path: "src/b.ts", kind: "file" }] };
    const server = await lookupServer({ choices: [shared, choice("DEC-2", "active", "src/b.ts")] });
    const root = tempRepo();
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115" };
      expect((await hook(bashPost("cat src/a.ts", root), env)).out).toContain("why-DEC-1");
      // the Read afterwards adds nothing: Bash already opened it (a separate process, the same record)
      expect((await hook({ ...READ, cwd: root }, env)).out).toBe("");
      // a Choice handed over at a.ts is one id-and-chosen line in the next file
      const b = await hook({ ...READ, cwd: root, tool_input: { file_path: "src/b.ts" } }, env);
      expect(b.out).toContain("DEC-1");
      expect(b.out).not.toContain("why-DEC-1");
      expect(b.out).toContain("why-DEC-2");
      // the other order: Read first, then Bash adds nothing
      const other = join(tempDir("idd-hook-rec-"), "record.jsonl");
      expect((await hook({ ...READ, cwd: root }, { ...env, IDD_INTENT_RECORD: other })).out).toContain("why-DEC-1");
      expect((await hook(bashPost("cat src/a.ts", root), { ...env, IDD_INTENT_RECORD: other })).out).toBe("");
    } finally {
      await server.close();
    }
  });

  test("AC-007: one command's bodies share the limit, and one lookup answers all its paths", async () => {
    const a = Array.from({ length: 4 }, (_, i) => choice(`DEC-A${i + 1}`, "active", "src/a.ts"));
    const b = Array.from({ length: 4 }, (_, i) => choice(`DEC-B${i + 1}`, "active", "src/b.ts"));
    const server = await lookupServer({ choices: [...a, ...b] });
    const root = tempRepo();
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115" };
      const r = await hook(bashPost("cat src/a.ts src/b.ts", root), env);
      const text = (JSON.parse(r.out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      for (let i = 1; i <= 4; i += 1) {
        expect(text).toContain(`DEC-A${i}`);
        expect(text).toContain(`DEC-B${i}`);
      }
      expect((text.match(/  why:/g) ?? []).length).toBe(5);
      expect(server.seen.length).toBe(1);
      expect(server.seen[0]).toContain("path=src%2Fa.ts");
      expect(server.seen[0]).toContain("path=src%2Fb.ts");
    } finally {
      await server.close();
    }
  });

  test("AC-011: the first Bash write into the tree is denied, with the path and the Edit / Write route", async () => {
    const root = tempRepo();
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    const env = { IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115", IDD_INTENT_STAGE: "executor", IDD_INTENT_ROLE: "executor" };
    try {
      const r = await hook(bashPre("sed -i 's/a/b/' src/a.ts", root), { ...env, IDD_AGENT_BASE_URL: "http://127.0.0.1:9" });
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.out) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("src/a.ts");
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("Edit / Write");
      const written = rows(record);
      expect(written.length).toBe(1);
      expect(written[0]).toMatchObject({ event: "bash-write", tool: "Bash", path: "src/a.ts", blocked: true });
      expect(written[0].choices).toBeUndefined();
      expect(written[0].session).toBe("s1");
      expect(written[0].stage).toBe("executor");
    } finally {
      // nothing to close
    }
  });

  test("AC-012: the second write to the same path passes, another record blocks again", async () => {
    const server = await lookupServer({ choices: [] });
    const root = tempRepo();
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115" };
      const command = "sed -i 's/a/b/' src/a.ts";
      expect((await hook(bashPre(command, root), env)).out).toContain("deny");
      const second = await hook(bashPre(command, root), env);
      expect(second.code).toBe(0);
      expect(second.out).not.toContain("deny");
      expect(second.out).not.toContain("permissionDecision");
      const third = await hook(bashPre(command, root), env);
      expect(third.out).not.toContain("deny");
      // a record that has not seen the write blocks it again
      const other = join(tempDir("idd-hook-rec-"), "record.jsonl");
      expect((await hook(bashPre(command, root), { ...env, IDD_INTENT_RECORD: other })).out).toContain("deny");
    } finally {
      await server.close();
    }
  });

  test("AC-013: one deny covers several paths, and a later write with a new path is denied again", async () => {
    const server = await lookupServer({ choices: [] });
    const root = tempRepo();
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115" };
      const first = await hook(bashPre("sed -i 's/a/b/' src/a.ts src/b.ts", root), env);
      const reason = (JSON.parse(first.out) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;
      expect(reason).toContain("src/a.ts");
      expect(reason).toContain("src/b.ts");
      expect((await hook(bashPre("sed -i 's/a/b/' src/a.ts src/b.ts", root), env)).out).not.toContain("deny");
      const again = await hook(bashPre("sed -i 's/a/b/' src/b.ts src/c.ts", root), env);
      expect(again.out).toContain("deny");
      expect((JSON.parse(again.out) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason).toContain("src/c.ts");
    } finally {
      await server.close();
    }
  });

  test("AC-014: a write that is let through adds the file and dir Choices, never the root's", async () => {
    const server = await lookupServer({ choices: [symbolChoice("DEC-F", "active", "src/a.ts", ["f"]), dirChoice("DEC-D", "active", "src/"), rootChoice("DEC-R", "active")] });
    const root = tempRepo();
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115" };
      const command = "sed -i 's/a/b/' src/a.ts";
      await hook(bashPre(command, root), env);
      const passed = await hook(bashPre(command, root), env);
      const text = (JSON.parse(passed.out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      expect(text).toContain("DEC-F");
      expect(text).toContain("DEC-D");
      expect(text).not.toContain("DEC-R");
      const written = rows(record).filter((r) => r.event === "bash-write");
      const notice = written[written.length - 1];
      expect(notice.blocked).toBeUndefined();
      expect((notice.choices as { id: string; form: string }[])[0]).toMatchObject({ id: "DEC-F", form: "notice" });
      // an engine that does not answer adds no text, and the write still passes
      const other = join(tempDir("idd-hook-rec-"), "record.jsonl");
      await hook(bashPre(command, root), { ...env, IDD_INTENT_RECORD: other, IDD_AGENT_BASE_URL: "http://127.0.0.1:9" });
      const quiet = await hook(bashPre(command, root), { ...env, IDD_INTENT_RECORD: other, IDD_AGENT_BASE_URL: "http://127.0.0.1:9" });
      expect(quiet.code).toBe(0);
      expect(quiet.out).toBe("");
    } finally {
      await server.close();
    }
  });

  test("AC-015: a write outside the tree or into _meta/scratch is never denied", async () => {
    const server = await lookupServer({ choices: [] });
    const root = tempRepo();
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115" };
      for (const command of ["echo x > /tmp/out.log", "echo x > /dev/null", "echo x > ../outside.txt", "echo x > _meta/scratch/out.log", "npm test > _meta/scratch/a/b.log 2>&1"]) {
        const r = await hook(bashPre(command, root), env);
        expect(r.code).toBe(0);
        expect(r.out).not.toContain("deny");
      }
      expect(rows(record).filter((r) => r.event === "bash-write").length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("AC-016: a write whose path cannot be pinned down passes from the first time", async () => {
    const server = await lookupServer({ choices: [] });
    const root = tempRepo();
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115" };
      for (const command of ['echo x > "$OUT"', "echo x > src/*.ts", "echo x > $(mktemp)", "sed -i s/a/b/ $FILES", 'cd "$DIR" && echo x > a.ts', 'echo x > "a.ts']) {
        const r = await hook(bashPre(command, root), env);
        expect(r.code).toBe(0);
        expect(r.out).not.toContain("deny");
      }
      expect(rows(record).filter((r) => r.event === "bash-write").length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("AC-017: a `cd` moves the base, and a cwd below the root names files from the root", async () => {
    const server = await lookupServer({ choices: [symbolChoice("DEC-F", "active", "packages/x.ts", ["f"])] });
    const root = tempRepo();
    mkdirSync(join(root, "packages"));
    writeFileSync(join(root, "packages", "x.ts"), ["export function f(x: number): number {", "  return x + 1;", "}", "", "export function g(x: number): number {", "  return x * 2;", "}"].join("\n"));
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115" };
      // the write moves into packages/: the deny names the path from the root
      const deny = await hook(bashPre("cd packages && sed -i s/a/b/ x.ts", root), env);
      expect((JSON.parse(deny.out) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason).toContain("packages/x.ts");
      expect((await hook(bashPre("cd /tmp && echo x > out.txt", root), env)).out).not.toContain("deny");
      // a read from a cwd below the root is looked up as the root-relative path
      const sub = join(root, "packages");
      const read = await hook(bashPost("cat x.ts", sub), env);
      expect(read.out).toContain("DEC-F");
      expect(server.seen.some((u) => u.includes("path=packages%2Fx.ts"))).toBe(true);
      // a command that moves itself: the post-tool cwd is where it ended, so the start is stepped back from the cd
      const movedRecord = join(tempDir("idd-hook-rec-"), "record.jsonl");
      const moved = await hook(bashPost("cd packages && cat x.ts", sub), { ...env, IDD_INTENT_RECORD: movedRecord });
      expect(moved.out).toContain("DEC-F");
      expect((rows(movedRecord)[0].path)).toBe("packages/x.ts");
      // and a Read of the same file adds nothing, since Bash already opened it
      const readTool = await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(root, "packages", "x.ts") }, cwd: sub, session_id: "s1" }, env);
      expect(readTool.out).toBe("");
      // the content is read from the root: an edit outside f adds nothing, one inside f is a hit with a drawn symbol
      const outside = await hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "packages", "x.ts"), old_string: "return x * 2;" }, cwd: sub, session_id: "s1" }, env);
      expect(outside.out).toBe("");
      const inside = await hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "packages", "x.ts"), old_string: "return x + 1;" }, cwd: sub, session_id: "s1" }, env);
      expect(inside.out).toContain("DEC-F");
      const edits = rows(record).filter((r) => r.event === "edit");
      expect((edits[edits.length - 1].choices as { symbol_missing?: boolean }[])[0].symbol_missing).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  test("AC-018: a compaction makes the same path count as the first time again", async () => {
    const server = await lookupServer({ choices: [] });
    const root = tempRepo();
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115" };
      const command = "sed -i 's/a/b/' src/a.ts";
      expect((await hook(bashPre(command, root), env)).out).toContain("deny");
      expect((await hook({ hook_event_name: "Compact", session_id: "s1", cwd: root }, env)).code).toBe(0);
      expect((await hook(bashPre(command, root), env)).out).toContain("deny");
      expect((await hook(bashPre(command, root), env)).out).not.toContain("deny");
    } finally {
      await server.close();
    }
  });

  test("AC-019: when the blocked row cannot be written, the write is not blocked", async () => {
    const server = await lookupServer({ choices: [] });
    const root = tempRepo();
    const blocker = join(tempDir("idd-hook-rec-"), "blocker");
    writeFileSync(blocker, "not a directory\n");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: join(blocker, "record.jsonl"), IDD_INTENT_LANE: "IDD-115" };
      const r = await hook(bashPre("sed -i 's/a/b/' src/a.ts", root), env);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("deny");
    } finally {
      await server.close();
    }
  });

  test("AC-020: a failed Bash read exits 0 with nothing added, and a missing command is nothing", async () => {
    const root = tempRepo();
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    const refused = await lookupServer();
    const failed = await lookupServer({ status: 500 });
    const hanging = await lookupServer({ hang: true });
    try {
      for (const server of [refused, failed, hanging]) {
        const r = await hook(bashPost("cat src/a.ts", root), { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115" });
        expect(r.code).toBe(0);
        expect(r.out).not.toContain("propter-intent");
        expect(r.out).not.toContain("deny");
      }
      const noCommand = await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, cwd: root, session_id: "s1" }, { IDD_AGENT_BASE_URL: refused.url, IDD_INTENT_RECORD: record });
      expect(noCommand.code).toBe(0);
      expect(noCommand.out).toBe("");
      const notString = await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 5 }, cwd: root, session_id: "s1" }, { IDD_AGENT_BASE_URL: refused.url, IDD_INTENT_RECORD: record });
      expect(notString.code).toBe(0);
      expect(notString.out).toBe("");
    } finally {
      await Promise.all([refused.close(), failed.close(), hanging.close()]);
    }
  }, 30_000);

  test("AC-021: the record holds a bash-read row and bash-write rows for blocked and passed writes", async () => {
    const server = await lookupServer({ choices: [choice("DEC-A", "active", "src/a.ts")] });
    const root = tempRepo();
    const record = join(tempDir("idd-hook-rec-"), "record.jsonl");
    try {
      const env = { IDD_AGENT_BASE_URL: server.url, IDD_INTENT_RECORD: record, IDD_INTENT_LANE: "IDD-115", IDD_INTENT_STAGE: "executor", IDD_INTENT_ROLE: "executor" };
      await hook(bashPost("cat src/a.ts", root), env);
      await hook(bashPre("sed -i s/x/y/ src/a.ts", root), env);
      await hook(bashPre("sed -i s/x/y/ src/a.ts", root), env);
      await hook(bashPre("sed -i s/x/y/ src/b.ts", root), env);
      await hook(bashPre("sed -i s/x/y/ src/b.ts", root), env);
      await hook(bashPost("cat src/b.ts", root), env);
      const written = rows(record);
      const bashReads = written.filter((r) => r.event === "bash-read");
      const bashWrites = written.filter((r) => r.event === "bash-write");
      expect(bashReads.length).toBe(1);
      expect(bashWrites.length).toBe(4);
      for (const row of [...bashReads, ...bashWrites]) {
        expect(typeof row.at).toBe("string");
        expect(row.session).toBe("s1");
        expect(row.stage).toBe("executor");
        expect(row.role).toBe("executor");
        expect(row.tool).toBe("Bash");
        expect(typeof row.path).toBe("string");
      }
      expect(bashWrites.filter((r) => r.blocked === true).length).toBe(2);
      const passedA = bashWrites.find((r) => r.path === "src/a.ts" && r.blocked !== true);
      expect((passedA?.choices as { id: string }[])[0].id).toBe("DEC-A");
      const passedB = bashWrites.find((r) => r.path === "src/b.ts" && r.blocked !== true);
      expect(passedB?.choices).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
