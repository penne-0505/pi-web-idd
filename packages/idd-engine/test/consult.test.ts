import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { laneCost } from "@idd/core";

import { openConversations, sweepEphemeralBranches } from "../src/server/conversations.ts";
import { readCostLines } from "../src/server/conversation-events.ts";
import { consultCopiesDir, consultCopyPath } from "../src/server/consult-copy.ts";
import { reconcileConsults } from "../src/server/consult.ts";
import { ephemeralDir, ephemeralRecordPath, ephemeralSessionFile, readEphemeralRecord } from "../src/server/ephemeral.ts";
import { createFetchHandler } from "../src/server.ts";
import { matchRoute, routes } from "../src/routes.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";
import { FAKE_PI } from "./helpers/pi-stand-in.ts";

/*
 * The consult tests. A real lane ledger, a real git worktree and a real child pi (a stand-in) are laid out in a
 * temp state, and every check goes through the engine's own fetch handler, so the doors, the copy and the branch
 * are exercised together. Nothing here touches the resident engine or a real model.
 */

const ENV_KEYS = [
  "IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_MODES_FILE", "IDD_REPOS_FILE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR",
  "IDD_CONVERSATION_IDLE_MS", "IDD_EPHEMERAL_RETENTION_MS", "IDD_EPHEMERAL_SWEEP_MS", "IDD_CONSULT_GIT_TIMEOUT_MS",
  "IDD_AGENT_TOKEN", "FAKE_PI_LOG", "FAKE_PI_COST", "FAKE_PI_MS", "FAKE_PI_TEXT",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

afterEach(async () => {
  for (const conv of openConversations()) await conv.close();
  await new Promise((r) => setTimeout(r, 30));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key] as string;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  root: string; state: string; main: string; lane: string; fake: string; log: string;
  handler: (req: Request) => Promise<Response>;
}

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
}

function jsonl(path: string, rows: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function fixture(opts: { typed?: boolean } = {}): Fixture {
  const root = tmpDir("idd-consult-");
  roots.push(root);
  const state = join(root, "state");
  const main = join(root, "main");
  const lane = join(root, "lane");
  const userAgent = join(root, "user-agent");
  for (const dir of [state, main, userAgent, join(root, "chat"), join(root, "ideas")]) mkdirSync(dir, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "base.txt"), "base\n");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "base");
  git(main, "worktree", "add", "-q", "-b", "lane-branch", lane);
  // the lane's working tree: a tracked change, an untracked document and an ignored file
  writeFileSync(join(lane, "base.txt"), "changed\n");
  mkdirSync(join(lane, "_docs", "intent", "IddCore", "idd-077"), { recursive: true });
  mkdirSync(join(lane, "_docs", "qa", "IddCore", "idd-077"), { recursive: true });
  writeFileSync(join(lane, "_docs", "intent", "IddCore", "idd-077", "decision.md"), "# decision (uncommitted)\n");
  writeFileSync(join(lane, "_docs", "qa", "IddCore", "idd-077", "qa.md"), "# qa (uncommitted)\n");
  writeFileSync(join(lane, "untracked.txt"), "untracked\n");
  writeFileSync(join(lane, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(lane, "ignored.txt"), "ignored\n");
  const fake = join(root, "pi");
  writeFileSync(fake, FAKE_PI);
  execFileSync("chmod", ["755", fake]);
  writeFileSync(join(root, "roles.yaml"), [
    "defaults:",
    "  title_context_turns: 3",
    "models:",
    "  openrouter-z-ai-glm-5.3:",
    "    model: openrouter/z-ai/glm-5.3",
    "roles:",
    "  chat: { model: openrouter-z-ai-glm-5.3, thinking: high, tools: [read, bash, edit, write, grep, find, ls] }",
  ].join("\n") + "\n");
  const types = opts.typed
    ? `    types:\n      chat: { label: チャット }\n      idea: { label: アイデア, dir: ${join(root, "ideas")} }\n`
    : "";
  const chatWorkspace = join(root, "chat");
  const modesYaml = opts.typed
    ? `modes:\n  chat:\n    role: chat\n    workspace: ${chatWorkspace}\n${types}`
    : `modes:\n  chat: { role: chat, workspace: ${chatWorkspace} }\n`;
  writeFileSync(join(root, "modes.yaml"), modesYaml);
  writeFileSync(join(root, "repos.yaml"), "repos: {}\n");
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_MODES_FILE: join(root, "modes.yaml"),
    IDD_REPOS_FILE: join(root, "repos.yaml"), IDD_PI_BIN: fake, IDD_PI_USER_AGENT_DIR: userAgent,
    IDD_CONVERSATION_IDLE_MS: "600000", IDD_EPHEMERAL_RETENTION_MS: String(7 * 24 * 60 * 60 * 1000),
    FAKE_PI_LOG: join(root, "pi.log"),
  });
  return { root, state, main, lane, fake, log: join(root, "pi.log"), handler: createFetchHandler() };
}

/** the ledger a lane needs for a consult: the backlog row, the open batch and the planner's session */
function addLane(fx: Fixture, opts: { iddId?: string; worktree?: string; answered?: boolean; batchId?: string; questions?: number } = {}): string {
  const iddId = opts.iddId ?? "IDD-077";
  const batchId = opts.batchId ?? "b-1";
  const now = new Date().toISOString();
  jsonl(join(fx.state, "backlog.jsonl"), [{
    idd_id: iddId, parent_id: null, created_at: now, linear_issue_url: null,
    gh_issue_url: "https://github.com/penne-0505/pi-web-idd/issues/83", pull_req_url: null,
    source_type: "github", context: "ISSUE-CONTEXT-MARKER", title: "相談の題", area: "IddCore", priority_snapshot: {},
  }]);
  jsonl(join(fx.state, "lifecycle-IddCore.jsonl"), [
    { event: "lane_open", idd_id: iddId, at: "2026-10-05T00:00:00.000Z", attrs: {} },
    { event: "question_batch_asked", idd_id: iddId, at: "2026-10-05T00:01:00.000Z", attrs: { batch_id: batchId, question_ids: ["Q-001", "Q-002"] } },
  ]);
  const count = opts.questions ?? 2;
  const questions = Array.from({ length: count }, (_, i) => ({
    question_id: `Q-00${i + 1}`,
    question: `QUESTION-${i + 1}-MARKER`,
    context: `CONTEXT-${i + 1}-MARKER`,
    options: [
      { index: 1, label: `LABEL-${i + 1}-A`, description: `DESC-${i + 1}-A`, recommendation: "recommended", rationale: `RATIONALE-${i + 1}-A` },
      { index: 2, label: `LABEL-${i + 1}-B` },
    ],
  }));
  jsonl(join(fx.state, "pending-questions.jsonl"), [{ idd_id: iddId, batch_id: batchId, asked_at: now, questions }]);
  if (opts.answered) {
    jsonl(join(fx.state, "pending-answers.jsonl"), questions.map((q) => ({
      idd_id: iddId, batch_id: batchId, question_id: q.question_id, answered_at: now,
      selection: { index: 1, label: "A" }, reason: null, notes: null,
    })));
  }
  jsonl(join(fx.state, "planner-sessions.jsonl"), [{
    idd_id: iddId, planner_session_id: "planner-sess-1", started_at: now,
    worktree_path: opts.worktree ?? fx.lane, branch: "lane-branch", harness: "pi",
  }]);
  return iddId;
}

/** write every answer for a batch, so the reconcile sees the card as done */
function answerAll(fx: Fixture, iddId = "IDD-077", batchId = "b-1"): void {
  jsonl(join(fx.state, "pending-answers.jsonl"), ["Q-001", "Q-002"].map((questionId) => ({
    idd_id: iddId, batch_id: batchId, question_id: questionId, answered_at: new Date().toISOString(),
    selection: { index: 1, label: "A" }, reason: null, notes: null,
  })));
}

/** place a pi record under the chat agent dir so `resolveSessionFile` finds it */
function placePiSession(fx: Fixture, sessionId: string, entries: unknown[]): string {
  const dir = join(fx.state, "pipeline", "agent", "chat", "sessions", "x");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  const lines = [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: fx.lane })];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

/** place a Claude Code lane's reply stream so `conversationLane` + `turns/<n>.jsonl` find it */
function placeClaudeLane(fx: Fixture, sessionId: string, laneId: string, turns: unknown[][]): string {
  const dir = join(fx.state, "lanes", laneId, "turns");
  mkdirSync(dir, { recursive: true });
  turns.forEach((lines, i) => writeFileSync(join(dir, `${i + 1}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8"));
  const indexDir = join(fx.state, "pipeline", "conversations");
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(join(indexDir, sessionId), laneId, "utf8");
  return dir;
}

function api(fx: Fixture, method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { "content-type": "application/json", host: "127.0.0.1:30144" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fx.handler(new Request(`http://127.0.0.1:30144${path}`, init));
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return await res.json() as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}

interface Command { cmd: string; [k: string]: unknown }
const commands = (fx: Fixture): Command[] => existsSync(fx.log) ? readFileSync(fx.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Command) : [];
const starts = (fx: Fixture): Record<string, unknown>[] => existsSync(`${fx.log}.starts`) ? readFileSync(`${fx.log}.starts`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const exits = (fx: Fixture): Record<string, unknown>[] => existsSync(`${fx.log}.exits`) ? readFileSync(`${fx.log}.exits`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const count = (fx: Fixture, cmd: string): number => commands(fx).filter((c) => c.cmd === cmd).length;

const CONSULT = { kind: "question", iddId: "IDD-077", batchId: "b-1" };

async function openConsultDoor(fx: Fixture, body: Record<string, unknown> = CONSULT): Promise<{ res: Response; body: Record<string, unknown> }> {
  const res = await api(fx, "POST", "/api/idd/consult", body);
  return { res, body: await json<Record<string, unknown>>(res) };
}

function branchLines(id: string): Record<string, unknown>[] {
  const file = ephemeralSessionFile(id);
  if (!file) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function envelopeOf(id: string): string {
  const entry = branchLines(id).find((e) => e.type === "custom_message");
  return typeof entry?.content === "string" ? entry.content : "";
}

function laneSnapshot(fx: Fixture): Record<string, string> {
  return {
    status: git(fx.lane, "status", "--porcelain"),
    head: git(fx.lane, "rev-parse", "HEAD"),
    stash: git(fx.lane, "stash", "list"),
    worktrees: git(fx.lane, "worktree", "list"),
    base: readFileSync(join(fx.lane, "base.txt"), "utf8"),
  };
}

// ---- AC-001 / AC-002 / AC-019: the door and one consult per card ----

describe("opening a consult", () => {
  test("AC-001: the door is registered and answers an id that opens as a conversation", async () => {
    const fx = fixture();
    addLane(fx);
    expect(routes.some((r) => r.method === "POST" && r.pattern === "/api/idd/consult")).toBe(true);
    expect(matchRoute("/api/idd/consult", "/api/idd/consult")).toEqual({});
    const { res, body } = await openConsultDoor(fx);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
    expect(body.role).toBe("chat");
    expect(body.mode).toBe("chat");
    const id = body.id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const opened = await api(fx, "GET", `/api/conversations/${id}`);
    expect(opened.status).toBe(200);
    expect((await json<{ id: string }>(opened)).id).toBe(id);
  });

  test("AC-002: a second call for one card answers the same id, one record and one copy; after delete a new id", async () => {
    const fx = fixture();
    addLane(fx);
    const first = await openConsultDoor(fx);
    const id = first.body.id as string;
    const second = await openConsultDoor(fx);
    expect(second.body.id).toBe(id);
    expect(second.body.created).toBe(false);
    const [a, b] = await Promise.all([openConsultDoor(fx), openConsultDoor(fx)]);
    expect(a.body.id).toBe(id);
    expect(b.body.id).toBe(id);
    const records = readdirSync(ephemeralDir()).filter((n) => n.endsWith(".json"));
    expect(records.filter((n) => JSON.parse(readFileSync(join(ephemeralDir(), n), "utf8")).consult?.iddId === "IDD-077").length).toBe(1);
    expect(readdirSync(consultCopiesDir())).toEqual([id]);
    await api(fx, "DELETE", `/api/conversations/${id}`);
    await until(() => !existsSync(ephemeralRecordPath(id)));
    const again = await openConsultDoor(fx);
    expect(again.body.created).toBe(true);
    expect(again.body.id).not.toBe(id);
  });

  test("AC-019: neither an open nor a closed consult is in the conversation list", async () => {
    const fx = fixture();
    addLane(fx);
    const { body } = await openConsultDoor(fx);
    const id = body.id as string;
    const open = await json<{ conversations: { id: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(open.conversations.some((c) => c.id === id)).toBe(false);
    await reconcileConsults();
    const closed = await json<{ conversations: { id: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(closed.conversations.some((c) => c.id === id)).toBe(false);
  });
});

// ---- AC-003 / AC-024: the branch has no parent and no type instruction ----

describe("the branch's shape", () => {
  test("AC-003: the record is a header and the envelope only, and its pi runs in the branch dir on the chat role", async () => {
    const fx = fixture();
    addLane(fx);
    const piFile = placePiSession(fx, "planner-sess-1", []);
    const before = readFileSync(piFile, "utf8");
    const { body } = await openConsultDoor(fx);
    const id = body.id as string;
    const lines = branchLines(id);
    expect(lines.length).toBe(2);
    expect(lines[0].type).toBe("session");
    expect(lines[0].parentSession).toBeUndefined();
    expect(lines[1].type).toBe("custom_message");
    expect(String(lines[1].content)).toContain("<propter-system-message>");
    const start = starts(fx).at(-1) as Record<string, unknown>;
    expect(start.session).toBe(id);
    expect(start.sessionDir).toBe(ephemeralDir());
    expect(start.agentDir).toBe(join(fx.state, "pipeline", "agent", "chat"));
    expect(readFileSync(piFile, "utf8")).toBe(before);
  });

  test("AC-024: a typed chat mode delivers no type instruction and no space prompt before or after a reopen", async () => {
    const fx = fixture({ typed: true });
    addLane(fx);
    // a consult carries no memory: even with an index in the mode's workspace, its first context is the envelope only
    mkdirSync(join(fx.root, "chat", "memory"), { recursive: true });
    writeFileSync(join(fx.root, "chat", "memory", "MEMORY.md"), "consult must not see this\n");
    const { body } = await openConsultDoor(fx);
    const id = body.id as string;
    await until(() => starts(fx).length >= 1);
    await sleep(80);
    expect(count(fx, "type-prompt")).toBe(0);
    expect(commands(fx).some((c) => typeof c.message === "string" && c.message.startsWith("/idd-context"))).toBe(false);
    const argv = String((starts(fx).at(-1) as Record<string, unknown>).argv);
    expect(argv).not.toContain("--append-system-prompt");
    expect(argv).not.toContain(join(fx.root, "chat", "memory"));
    await api(fx, "POST", `/api/conversations/${id}/close`);
    await api(fx, "GET", `/api/conversations/${id}`);
    await sleep(80);
    expect(count(fx, "type-prompt")).toBe(0);
    // after a promotion the branch is a mode's session again, so the type instruction arrives
    await api(fx, "POST", `/api/conversations/${id}/promote`);
    await api(fx, "GET", `/api/conversations/${id}`);
    await until(() => count(fx, "type-prompt") >= 1);
  });
});

// ---- AC-004: the refusals ----

describe("refusing to open", () => {
  test("AC-004: an unsupported kind, a missing batch, an answered batch, a closed lane and a missing worktree are refused", async () => {
    const fx = fixture();
    addLane(fx);
    const other = await openConsultDoor(fx, { kind: "duplicate", iddId: "IDD-077", batchId: "b-1" });
    expect(other.res.status).toBeGreaterThanOrEqual(400);
    expect(other.res.status).toBeLessThan(500);
    const missing = await openConsultDoor(fx, { kind: "question", iddId: "IDD-077", batchId: "nope" });
    expect(missing.res.status).toBe(404);

    const fx2 = fixture();
    addLane(fx2, { answered: true });
    const answered = await openConsultDoor(fx2);
    expect(answered.res.status).toBeGreaterThanOrEqual(400);
    expect(answered.res.status).toBeLessThan(500);

    const fx3 = fixture();
    addLane(fx3);
    appendFileSync(join(fx3.state, "lifecycle-IddCore.jsonl"), `${JSON.stringify({ event: "lane_close", idd_id: "IDD-077", at: "2026-10-05T00:02:00.000Z", attrs: {} })}\n`);
    const closed = await openConsultDoor(fx3);
    expect(closed.res.status).toBeGreaterThanOrEqual(400);
    expect(closed.res.status).toBeLessThan(500);
    // the batch is unanswered, but its lane ended: the reason is the lane, not "already answered"
    expect(JSON.stringify(closed.body)).toContain("lane は閉じています");
    expect(JSON.stringify(closed.body)).not.toContain("もう答えています");

    const fx4 = fixture();
    addLane(fx4, { worktree: join(fx4.root, "gone") });
    const gone = await openConsultDoor(fx4);
    expect(gone.res.status).toBeGreaterThanOrEqual(400);
    expect(gone.res.status).toBeLessThan(500);

    for (const fx0 of [fx, fx2, fx3, fx4]) {
      expect(existsSync(ephemeralDir()) ? readdirSync(ephemeralDir()).filter((n) => n.endsWith(".json")) : []).toEqual([]);
      expect(existsSync(consultCopiesDir()) ? readdirSync(consultCopiesDir()) : []).toEqual([]);
      expect(starts(fx0).length).toBe(0);
    }
  });
});

// ---- AC-005 / AC-006 / AC-007: the copy ----

describe("the working copy", () => {
  test("AC-005 / AC-006 / AC-007: the branch runs in its own copy with the lane's uncommitted and untracked files", async () => {
    const fx = fixture();
    addLane(fx);
    const laneHead = git(fx.lane, "rev-parse", "HEAD").trim();
    const { body } = await openConsultDoor(fx);
    const id = body.id as string;
    const copy = consultCopyPath(id);
    const start = starts(fx).at(-1) as Record<string, unknown>;
    expect(start.cwd).toBe(copy);
    expect(copy).not.toBe(fx.lane);
    expect(copy.startsWith(consultCopiesDir())).toBe(true);
    expect(copy.endsWith(id)).toBe(true);
    // the tracked uncommitted change and the untracked document are there, the ignored file is not
    expect(readFileSync(join(copy, "base.txt"), "utf8")).toBe("changed\n");
    expect(existsSync(join(copy, "_docs", "intent", "IddCore", "idd-077", "decision.md"))).toBe(true);
    expect(existsSync(join(copy, "untracked.txt"))).toBe(true);
    expect(existsSync(join(copy, "ignored.txt"))).toBe(false);
    expect(git(copy, "log", "--format=%H", "-1").trim()).toBe(laneHead);
    // the tools are the reading ones only, and the read-only door onto propter's records is not one of them
    // (AC-006): a consultation is an ephemeral branch, so it is started without that extension
    expect(start.tools).toBe("read,grep,find,ls,bash");
    expect(String(start.tools)).not.toContain("edit");
    expect(String(start.tools)).not.toContain("write");
    expect(String(start.tools)).not.toContain("propter_read");
    expect(String(start.argv)).not.toContain("propter-read");
  });
});

// ---- AC-008 / INV-2121: the lane is never disturbed ----

describe("the lane is never disturbed", () => {
  test("AC-008: opening and closing leaves the lane's tree, HEAD, stash and worktrees alone; the copy's git stays in the copy", async () => {
    const fx = fixture();
    addLane(fx);
    const before = laneSnapshot(fx);
    const { body } = await openConsultDoor(fx);
    const id = body.id as string;
    expect(laneSnapshot(fx)).toEqual(before);
    // writing in the copy does not reach the lane
    writeFileSync(join(consultCopyPath(id), "base.txt"), "copy-only\n");
    expect(readFileSync(join(fx.lane, "base.txt"), "utf8")).toBe("changed\n");
    // the copy's own git operations cannot move the lane's refs, stash or worktree list
    git(consultCopyPath(id), "add", "base.txt");
    git(consultCopyPath(id), "commit", "-qm", "copy commit");
    git(consultCopyPath(id), "branch", "-f", "lane-branch", "HEAD");
    git(consultCopyPath(id), "stash", "push", "-m", "s");
    await api(fx, "POST", `/api/conversations/${id}/close`);
    expect(laneSnapshot(fx)).toEqual(before);
    expect(git(consultCopyPath(id), "remote").trim()).toBe("");
  });
});

// ---- AC-009..013: the envelope ----

describe("the envelope", () => {
  test("AC-009: every question and option rides in the envelope", async () => {
    const fx = fixture();
    addLane(fx);
    const { body } = await openConsultDoor(fx);
    const envelope = envelopeOf(body.id as string);
    expect(envelope.startsWith("<propter-system-message>")).toBe(true);
    for (const marker of ["QUESTION-1-MARKER", "QUESTION-2-MARKER", "CONTEXT-1-MARKER", "LABEL-1-A", "DESC-1-A", "RATIONALE-1-A", "recommendation=\"recommended\""]) {
      expect(envelope).toContain(marker);
    }
  });

  test("AC-010: the contract paths, the Issue and the planner summary ride in the envelope", async () => {
    const fx = fixture();
    addLane(fx);
    jsonl(join(fx.state, "lifecycle-IddCore.jsonl"), [
      { event: "lane_open", idd_id: "IDD-077", at: "2026-10-05T00:00:00.000Z", attrs: {} },
      { event: "question_batch_asked", idd_id: "IDD-077", at: "2026-10-05T00:01:00.000Z", attrs: { batch_id: "b-1", question_ids: ["Q-001", "Q-002"] } },
      { event: "s1_ready", idd_id: "IDD-077", at: "2026-10-05T00:02:00.000Z", attrs: { summary: { situation: "SITUATION-MARKER", action: "ACTION-MARKER", outcome: "OUTCOME-MARKER" } } },
    ]);
    const { body } = await openConsultDoor(fx);
    const envelope = envelopeOf(body.id as string);
    expect(envelope).toContain("_docs/intent/IddCore/idd-077/decision.md");
    expect(envelope).toContain("_docs/qa/IddCore/idd-077/qa.md");
    expect(envelope).toContain("相談の題");
    expect(envelope).toContain("https://github.com/penne-0505/pi-web-idd/issues/83");
    expect(envelope).toContain("ISSUE-CONTEXT-MARKER");
    expect(envelope).toContain("SITUATION-MARKER");
    expect(envelope).toContain("ACTION-MARKER");
    expect(envelope).toContain("OUTCOME-MARKER");

    // a lane that has not reported a summary says so
    const fx2 = fixture();
    addLane(fx2);
    const none = await openConsultDoor(fx2);
    expect(envelopeOf(none.body.id as string)).toContain("planner の summary はまだ無い");
  });

  test("AC-011: the files the asking agent read and the ledger's reports ride in the envelope", async () => {
    const fx = fixture();
    addLane(fx);
    placePiSession(fx, "planner-sess-1", [
      { type: "message", id: "a1", parentId: null, message: { role: "assistant", content: [
        { type: "text", text: "BODY-MARKER" },
        { type: "thinking", thinking: "THINK-MARKER" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "base.txt" } },
        { type: "toolCall", id: "c2", name: "read", arguments: { path: "base.txt" } },
        { type: "toolCall", id: "c3", name: "read", arguments: { path: "_docs/intent/IddCore/idd-077/decision.md" } },
        { type: "toolCall", id: "c4", name: "bash", arguments: { command: "BASH-ARG-MARKER" } },
      ] } },
      { type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "RESULT-MARKER" }] } },
    ]);
    writeFileSync(join(fx.state, "executor-progress-IDD-077.json"), JSON.stringify({
      idd_id: "IDD-077", updated_at: new Date().toISOString(), current_step: "STEP-MARKER",
      qa_status: [{ qa_id: "AC-001", status: "verified" }], recent_activity: ["RECENT-MARKER"],
    }));
    jsonl(join(fx.state, "lifecycle-IddCore.jsonl"), [
      { event: "lane_open", idd_id: "IDD-077", at: "2026-10-05T00:00:00.000Z", attrs: {} },
      { event: "question_batch_asked", idd_id: "IDD-077", at: "2026-10-05T00:01:00.000Z", attrs: { batch_id: "b-1", question_ids: ["Q-001", "Q-002"] } },
      { event: "s2_result", idd_id: "IDD-077", at: "2026-10-05T00:02:00.000Z", attrs: { outcome: "success", changed_files: ["CHANGED-MARKER"], commit_count: 2, qa_verified: ["AC-001"], qa_unverified: [], side_findings: ["SIDE-MARKER"] } },
    ]);
    const { body } = await openConsultDoor(fx);
    const envelope = envelopeOf(body.id as string);
    expect(envelope).toContain("base.txt");
    expect(envelope).toContain("_docs/intent/IddCore/idd-077/decision.md");
    expect(envelope.match(/base\.txt/g)?.length).toBe(1);
    expect(envelope).toContain("STEP-MARKER");
    expect(envelope).toContain("RECENT-MARKER");
    expect(envelope).toContain("CHANGED-MARKER");
    expect(envelope).toContain("SIDE-MARKER");
    // the agent's own words and its tool results never ride along
    expect(envelope).not.toContain("BODY-MARKER");
    expect(envelope).not.toContain("THINK-MARKER");
    expect(envelope).not.toContain("RESULT-MARKER");
    expect(envelope).not.toContain("BASH-ARG-MARKER");
  });

  test("AC-011: a Claude Code lane's Read paths are read from its turns", async () => {
    const fx = fixture();
    addLane(fx);
    jsonl(join(fx.state, "executor-sessions.jsonl"), [{
      idd_id: "IDD-077", executor_session_id: "claude-sess-1", started_at: new Date().toISOString(),
      worktree_path: fx.lane, branch: "lane-branch", harness: "claude",
    }]);
    placeClaudeLane(fx, "claude-sess-1", "lane-1", [[
      { type: "assistant", message: { content: [
        { type: "text", text: "CLAUDE-BODY-MARKER" },
        { type: "tool_use", name: "Read", input: { file_path: join(fx.lane, "base.txt") } },
        { type: "tool_use", name: "Read", input: { file_path: join(fx.lane, "_docs", "qa", "IddCore", "idd-077", "qa.md") } },
      ] } },
      { type: "result", is_error: false, result: "CLAUDE-RESULT-MARKER" },
    ]]);
    const { body } = await openConsultDoor(fx);
    const envelope = envelopeOf(body.id as string);
    expect(envelope).toContain("base.txt");
    expect(envelope).toContain("_docs/qa/IddCore/idd-077/qa.md");
    expect(envelope).not.toContain("CLAUDE-BODY-MARKER");
    expect(envelope).not.toContain("CLAUDE-RESULT-MARKER");
  });

  test("AC-012: no agent body, thinking, result or callback token is in the envelope or the branch record", async () => {
    process.env.IDD_AGENT_TOKEN = "TOKEN-MARKER-VALUE-123";
    const fx = fixture();
    addLane(fx);
    placePiSession(fx, "planner-sess-1", [
      { type: "message", id: "a1", parentId: null, message: { role: "assistant", content: [
        { type: "text", text: "BODY-MARKER" },
        { type: "thinking", thinking: "THINK-MARKER" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "base.txt" } },
      ] } },
    ]);
    const { body } = await openConsultDoor(fx);
    const id = body.id as string;
    const file = ephemeralSessionFile(id) as string;
    const record = readFileSync(file, "utf8");
    const envelope = envelopeOf(id);
    for (const marker of ["BODY-MARKER", "THINK-MARKER", "TOKEN-MARKER-VALUE-123"]) {
      expect(envelope).not.toContain(marker);
      expect(record).not.toContain(marker);
    }
  });

  test("AC-013: the role sentence says what the consultant must not do", async () => {
    const fx = fixture();
    addLane(fx);
    const { body } = await openConsultDoor(fx);
    const envelope = envelopeOf(body.id as string);
    expect(envelope).toContain("自分では答えを決めず");
    expect(envelope).toContain("回答の下書きも作らず");
    expect(envelope).toContain("現物で確かめて説明する");
    expect(envelope).toContain("ファイルを書き換えない");
  });
});

// ---- AC-014 / INV-2125: the ledger is not written ----

describe("the ledger is not touched", () => {
  test("AC-014: opening and closing leaves the question, answer and lifecycle bytes alone; decide still answers", async () => {
    const fx = fixture();
    addLane(fx);
    const paths = ["pending-questions.jsonl", "pending-answers.jsonl", "lifecycle-IddCore.jsonl"];
    const before = Object.fromEntries(paths.map((p) => [p, existsSync(join(fx.state, p)) ? readFileSync(join(fx.state, p), "utf8") : ""]));
    const { body } = await openConsultDoor(fx);
    await reconcileConsults();
    for (const p of paths) expect(existsSync(join(fx.state, p)) ? readFileSync(join(fx.state, p), "utf8") : "").toBe(before[p]);
    // a decide answer still goes through while a consult is open
    const { body: body2 } = await openConsultDoor(fx);
    const answer = await api(fx, "POST", "/api/idd/decide", { action: "answer", payload: { iddId: "IDD-077", batchId: "b-1", questionId: "Q-001", selection: { index: 1, label: "A" } } });
    expect(answer.status).toBe(200);
    expect((await json<{ ok: boolean }>(answer)).ok).toBe(true);
    expect(readFileSync(join(fx.state, "pending-answers.jsonl"), "utf8")).toContain("Q-001");
    expect(body2.id).toBe(body.id);
  });
});

// ---- AC-015 / AC-016 / INV-2123: closing from the ledger ----

describe("closing from the ledger", () => {
  test("AC-015: one answer keeps it open, the last closes it, and the decide door runs the reconcile", async () => {
    const fx = fixture();
    addLane(fx);
    const { body } = await openConsultDoor(fx);
    const id = body.id as string;
    const one = await api(fx, "POST", "/api/idd/decide", { action: "answer", payload: { iddId: "IDD-077", batchId: "b-1", questionId: "Q-001", selection: { index: 1, label: "A" } } });
    expect(one.status).toBe(200);
    await sleep(120);
    expect(readEphemeralRecord(id)?.consult?.closedAt).toBeUndefined();
    expect(existsSync(consultCopyPath(id))).toBe(true);
    const last = await api(fx, "POST", "/api/idd/decide", { action: "answer", payload: { iddId: "IDD-077", batchId: "b-1", questionId: "Q-002", selection: { index: 2, label: "B" } } });
    expect(last.status).toBe(200);
    await until(() => Boolean(readEphemeralRecord(id)?.consult?.closedAt));
    await until(() => exits(fx).some((e) => e.session === id));
    expect(existsSync(consultCopyPath(id))).toBe(false);
    expect(ephemeralSessionFile(id)).toBeDefined();
  });

  test("AC-016: a closed lane closes it, and a batch answered while the engine was down closes on the startup reconcile", async () => {
    const fx = fixture();
    addLane(fx);
    const { body } = await openConsultDoor(fx);
    const id = body.id as string;
    appendFileSync(join(fx.state, "lifecycle-IddCore.jsonl"), `${JSON.stringify({ event: "lane_close", idd_id: "IDD-077", at: "2026-10-05T00:03:00.000Z", attrs: {} })}\n`);
    await reconcileConsults();
    expect(readEphemeralRecord(id)?.consult?.closedAt).toBeDefined();

    // the engine was down when the batch was answered: the answers are on disk, the reconcile is the startup pass
    const fx2 = fixture();
    addLane(fx2);
    const opened = await openConsultDoor(fx2);
    const id2 = opened.body.id as string;
    await api(fx2, "POST", "/api/idd/decide", { action: "answer", payload: { iddId: "IDD-077", batchId: "b-1", questionId: "Q-001", selection: { index: 1, label: "A" } } });
    await api(fx2, "POST", "/api/idd/decide", { action: "answer", payload: { iddId: "IDD-077", batchId: "b-1", questionId: "Q-002", selection: { index: 2, label: "B" } } });
    await until(() => Boolean(readEphemeralRecord(id2)?.consult?.closedAt));
  });

  test("AC-005: a lane that closes after its consult opened is refused for the lane, not for the consult's record", async () => {
    const fx = fixture();
    addLane(fx);
    const first = await openConsultDoor(fx);
    expect(first.body.created).toBe(true);
    appendFileSync(join(fx.state, "lifecycle-IddCore.jsonl"), `${JSON.stringify({ event: "lane_close", idd_id: "IDD-077", at: "2026-10-05T00:03:00.000Z", attrs: {} })}\n`);
    await reconcileConsults();
    expect(readEphemeralRecord(first.body.id as string)?.consult?.closedAt).toBeDefined();
    const again = await openConsultDoor(fx);
    expect(again.res.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain("lane は閉じています");
    expect(JSON.stringify(again.body)).not.toContain("相談は閉じています");
    expect(JSON.stringify(again.body)).not.toContain("もう答えています");
  });

  test("AC-017 / INV-2123: a closed consult refuses talk, keeps its record, and still promotes and deletes", async () => {
    const fx = fixture();
    addLane(fx);
    const { body } = await openConsultDoor(fx);
    const id = body.id as string;
    answerAll(fx);
    await reconcileConsults();
    expect(readEphemeralRecord(id)?.consult?.closedAt).toBeDefined();
    const startsBefore = starts(fx).length;
    const opened = await api(fx, "GET", `/api/conversations/${id}`);
    expect(opened.status).toBeGreaterThanOrEqual(400);
    const sent = await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "hi" });
    expect(sent.status).toBeGreaterThanOrEqual(400);
    expect(starts(fx).length).toBe(startsBefore);
    expect(ephemeralSessionFile(id)).toBeDefined();
    const again = await openConsultDoor(fx);
    expect(again.res.status).toBeGreaterThanOrEqual(400);
    const promoted = await api(fx, "POST", `/api/conversations/${id}/promote`);
    expect(promoted.status).toBe(200);
    const list = await json<{ conversations: { id: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(list.conversations.some((c) => c.id === id)).toBe(true);
    const deleted = await api(fx, "DELETE", `/api/conversations/${id}`);
    expect(deleted.status).toBe(200);
  });
});

// ---- the answer path: a failing consult cleanup never fails the answer ----

describe("a failing cleanup", () => {
  test("an answer is delivered even when settling the consults rejects", async () => {
    const fx = fixture();
    addLane(fx);
    const opened = await openConsultDoor(fx);
    expect(opened.body.id).toBeDefined();
    // a second, malformed batch: the reconcile reads every batch and rejects on this one, while the answer's
    // own lookup still finds the good batch
    appendFileSync(join(fx.state, "pending-questions.jsonl"),
      `${JSON.stringify({ idd_id: "IDD-999", batch_id: "b-x", asked_at: new Date().toISOString(), questions: null })}\n`);
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => { warned.push(String(message)); };
    try {
      const res = await api(fx, "POST", "/api/idd/decide", { action: "answer", payload: { iddId: "IDD-077", batchId: "b-1", questionId: "Q-001", selection: { index: 1, label: "A" } } });
      expect(res.status).toBe(200);
      expect((await json<{ ok: boolean }>(res)).ok).toBe(true);
      await until(() => warned.some((message) => message.includes("相談の後始末")));
    } finally {
      console.warn = original;
    }
    // the answer is on the ledger and the engine's own door still answers
    expect(readFileSync(join(fx.state, "pending-answers.jsonl"), "utf8")).toContain("Q-001");
    expect((await api(fx, "GET", "/api/conversations")).status).toBe(200);
  });
});

// ---- AC-018: the copies are cleaned up ----

describe("cleaning up copies", () => {
  test("AC-018: close, delete, promote and the retention sweep each leave no copy; orphans go and a live one stays", async () => {
    const fx = fixture();
    addLane(fx);
    // close
    const a = await openConsultDoor(fx);
    answerAll(fx);
    await reconcileConsults();
    expect(existsSync(consultCopyPath(a.body.id as string))).toBe(false);
    // delete
    const fx2 = fixture();
    addLane(fx2);
    const b = await openConsultDoor(fx2);
    await api(fx2, "DELETE", `/api/conversations/${b.body.id as string}`);
    await until(() => !existsSync(consultCopyPath(b.body.id as string)));
    // promote
    const fx3 = fixture();
    addLane(fx3);
    const c = await openConsultDoor(fx3);
    answerAll(fx3);
    await reconcileConsults();
    await api(fx3, "POST", `/api/conversations/${c.body.id as string}/promote`);
    expect(existsSync(consultCopyPath(c.body.id as string))).toBe(false);
    // an orphan copy goes and a live consult's copy stays across a sweep
    const fx4 = fixture();
    addLane(fx4);
    const live = await openConsultDoor(fx4);
    mkdirSync(join(consultCopiesDir(), "orphan"), { recursive: true });
    await sweepEphemeralBranches();
    expect(existsSync(join(consultCopiesDir(), "orphan"))).toBe(false);
    expect(existsSync(consultCopyPath(live.body.id as string))).toBe(true);
    // the retention sweep removes a consult past its window, with its copy
    await api(fx4, "POST", `/api/conversations/${live.body.id as string}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === live.body.id));
    process.env.IDD_EPHEMERAL_RETENTION_MS = "1";
    const removed = await sweepEphemeralBranches(Date.now() + 100_000);
    expect(removed).toContain(live.body.id as string);
    expect(existsSync(consultCopyPath(live.body.id as string))).toBe(false);
    expect(existsSync(ephemeralRecordPath(live.body.id as string))).toBe(false);
  });
});

// ---- AC-020 / AC-021 / INV-2124: the cost ----

describe("the consult's cost", () => {
  test("AC-020 / AC-021: the cost line carries the consult's marks and the lane's cost does not change", async () => {
    const fx = fixture();
    addLane(fx);
    process.env.FAKE_PI_COST = "0.25";
    const events = readFileSync(join(fx.state, "lifecycle-IddCore.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const before = await laneCost("IDD-077", events);
    const { body } = await openConsultDoor(fx);
    const id = body.id as string;
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "hello" });
    await until(() => readCostLines().some((line) => line.sessionId === id));
    const line = readCostLines().find((l) => l.sessionId === id) as Record<string, unknown>;
    expect(line.consult).toBe(true);
    expect(line.consultKind).toBe("question");
    expect(line.iddId).toBe("IDD-077");
    expect(line.batchId).toBe("b-1");
    expect(Number(line.cost)).toBeGreaterThan(0);
    const after = await laneCost("IDD-077", events);
    expect(after).toEqual(before);
  });
});

// ---- AC-023: an explicit stop keeps the same id ----

describe("an explicit stop", () => {
  test("AC-023: the conversation close stops pi but keeps the record and copy, and the same card reopens it", async () => {
    const fx = fixture();
    addLane(fx);
    const { body } = await openConsultDoor(fx);
    const id = body.id as string;
    const closed = await api(fx, "POST", `/api/conversations/${id}/close`);
    expect(closed.status).toBe(200);
    await until(() => exits(fx).some((e) => e.session === id));
    expect(readEphemeralRecord(id)?.consult?.closedAt).toBeUndefined();
    expect(existsSync(consultCopyPath(id))).toBe(true);
    const again = await openConsultDoor(fx);
    expect(again.body.id).toBe(id);
    expect(again.body.created).toBe(false);
    const opened = await api(fx, "GET", `/api/conversations/${id}`);
    expect(opened.status).toBe(200);
    const sent = await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "hi" });
    expect(sent.status).toBe(200);
    await until(() => count(fx, "prompt") >= 1);
    await api(fx, "DELETE", `/api/conversations/${id}`);
    await until(() => !existsSync(consultCopyPath(id)));
    const fresh = await openConsultDoor(fx);
    expect(fresh.body.created).toBe(true);
    expect(fresh.body.id).not.toBe(id);
  });
});

// ---- the store's guard ----

describe("the copy store's guard", () => {
  test("a path outside the consult store is not removed", async () => {
    const { removeConsultCopyPath } = await import("../src/server/consult-copy.ts");
    const fx = fixture();
    const outside = join(fx.root, "keep");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "file.txt"), "keep\n");
    removeConsultCopyPath(outside);
    expect(existsSync(join(outside, "file.txt"))).toBe(true);
    expect(existsSync(consultCopiesDir()) ? readdirSync(consultCopiesDir()) : []).toEqual([]);
  });
});
