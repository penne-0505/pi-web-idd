import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runLaneCommand } from "../src/lane-commands.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

// the tests below point the state and roles at their own files; the other test files must not see them
const savedEnv = {
  IDD_ID: process.env.IDD_ID,
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
  path: string;
  auth?: string;
  body: Record<string, unknown>;
}

/** a fake report API on a free port: it records what it got and answers with the next scripted reply */
async function fakeServer(replies: { status: number; body: unknown }[] = []) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      received.push({ path: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
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

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
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

const LANE = "IDD-035";
const TOKEN = "token-for-the-test";

function setEnv(url: string, opts: { lane?: string | null; token?: string | null } = {}) {
  process.env.IDD_AGENT_BASE_URL = url;
  if (opts.lane === null) delete process.env.IDD_ID; else process.env.IDD_ID = opts.lane ?? LANE;
  if (opts.token === null) delete process.env.IDD_AGENT_TOKEN; else process.env.IDD_AGENT_TOKEN = opts.token ?? TOKEN;
}

const question = (overrides: Record<string, unknown> = {}) => ({
  question_id: "q1",
  question: "どちらにしますか",
  context: "c",
  options: [{ index: 1, label: "A", recommendation: "recommended", rationale: "確かめた。" }, { index: 2, label: "B" }],
  ...overrides,
});

function questionsFile(questions: unknown): string {
  const dir = tmpDir("idd-report-");
  const file = join(dir, "questions.json");
  writeFileSync(file, JSON.stringify({ questions }));
  return file;
}

/** a six-kind report table, all rows not touching, written where the CLI can read it */
function riskFile(touches = false): string {
  const dir = tmpDir("idd-report-");
  const file = join(dir, "risk-table.json");
  const kinds = ["auth", "authz", "billing", "permission", "data_loss", "secret"];
  writeFileSync(file, JSON.stringify(kinds.map((kind) => ({ kind, touches, reason: "x" }))));
  return file;
}

/** an impact report with no decisions, written where the CLI can read it */
function impactFile(body = { paths: [], decisions: [] }): string {
  const dir = tmpDir("idd-report-");
  const file = join(dir, "intent-impact.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
}

/** a findings-disposition report, written where the CLI can read it */
function findingsFile(body: unknown): string {
  const dir = tmpDir("idd-report-");
  const file = join(dir, "findings.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
}

/** the required plan flags, so a test can add one more on top */
function planFlags(): string[] {
  return ["plan", "--dec-count", "0", "--inv-count", "0", "--qa-count", "0", "--reference-count", "0", "--size", "S", "--harm", "0", "--depth", "shallow", "--situation", "s", "--action", "a", "--outcome", "o", "--risk-table", riskFile(), "--intent-impact", impactFile()];
}

describe("idd report: the four verbs", () => {
  test("questions goes to the questions API with the environment lane and token", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const file = questionsFile([question()]);
      const r = await capture(() => runLaneCommand("report", ["questions", "--file", file]));
      expect(r.code).toBe(0);
      expect(server.received.length).toBe(1);
      expect(server.received[0].path).toBe("/api/idd/agent/questions");
      expect(server.received[0].auth).toBe(`Bearer ${TOKEN}`);
      expect(server.received[0].body.idd_id).toBe(LANE);
      expect(typeof server.received[0].body.batch_id).toBe("string");
      expect((server.received[0].body.questions as unknown[]).length).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("plan, progress and result each go to the API of the same name", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const plan = await capture(() => runLaneCommand("report", ["plan", "--dec-count", "2", "--inv-count", "1", "--qa-count", "3", "--reference-count", "4", "--size", "S", "--harm", "0", "--depth", "shallow", "--situation", "s", "--action", "a", "--outcome", "o", "--risk-table", riskFile(), "--intent-impact", impactFile()]));
      const progress = await capture(() => runLaneCommand("report", ["progress", "--current-step", "implementing", "--ac", "AC-001=verified", "--recent", "did a thing"]));
      const result = await capture(() => runLaneCommand("report", ["result", "--outcome", "success", "--changed-file", "a.ts", "--commit-count", "1", "--verified", "AC-001", "--unverified", "AC-002", "--side-finding", "noticed"]));
      expect([plan.code, progress.code, result.code]).toEqual([0, 0, 0]);
      expect(server.received.map((r) => r.path)).toEqual([
        "/api/idd/agent/ready",
        "/api/idd/agent/progress",
        "/api/idd/agent/result",
      ]);
      for (const r of server.received) {
        expect(r.auth).toBe(`Bearer ${TOKEN}`);
        expect(r.body.idd_id).toBe(LANE);
      }
    } finally {
      await server.close();
    }
  });

  test("everything the API takes arrives under its field names", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      await capture(() => runLaneCommand("report", ["plan", "--dec-count", "2", "--inv-count", "1", "--qa-count", "3", "--reference-count", "4", "--size", "S", "--harm", "0", "--depth", "shallow", "--situation", "s", "--action", "a", "--outcome", "o", "--risk-table", riskFile(), "--intent-impact", impactFile()]));
      await capture(() => runLaneCommand("report", ["progress", "--current-step", "implementing", "--ac", "AC-001=verified", "--ac", "AC-002=in_progress", "--recent", "x", "--recent", "y"]));
      await capture(() => runLaneCommand("report", ["result", "--outcome", "partial", "--changed-file", "a.ts", "--changed-file", "b.ts", "--commit-count", "2", "--verified", "AC-001", "--unverified", "AC-002", "--side-finding", "f"]));
      const [ready, progress, result] = server.received.map((r) => r.body);
      expect(ready.summary).toEqual({ situation: "s", action: "a", outcome: "o" });
      expect((ready.risk_table as unknown[]).length).toBe(6);
      expect([ready.dec_count, ready.inv_count, ready.qa_count, ready.reference_count]).toEqual([2, 1, 3, 4]);
      expect(progress.qa_status).toEqual([{ qa_id: "AC-001", status: "verified" }, { qa_id: "AC-002", status: "in_progress" }]);
      expect(progress.recent_activity).toEqual(["x", "y"]);
      expect(result.outcome).toBe("partial");
      expect(result.changed_files).toEqual(["a.ts", "b.ts"]);
      expect(result.commit_count).toBe(2);
      expect(result.qa_verified).toEqual(["AC-001"]);
      expect(result.qa_unverified).toEqual(["AC-002"]);
      expect(result.side_findings).toEqual(["f"]);
    } finally {
      await server.close();
    }
  });

  test("a plan's --findings FILE and --findings=FILE reach the API as findings", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const dispositions = [{ id: "F-1", action: "fix" }];
      const file = findingsFile(dispositions);
      const spaced = await capture(() => runLaneCommand("report", [...planFlags(), "--findings", file]));
      const joined = await capture(() => runLaneCommand("report", [...planFlags(), `--findings=${file}`]));
      expect([spaced.code, joined.code]).toEqual([0, 0]);
      expect(server.received.length).toBe(2);
      expect(server.received[0].body.findings).toEqual(dispositions);
      expect(server.received[1].body.findings).toEqual(dispositions);
    } finally {
      await server.close();
    }
  });

  test("a plan with a malformed --findings FILE is refused before anything is sent", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const r = await capture(() => runLaneCommand("report", [...planFlags(), "--findings", join(tmpDir("idd-report-"), "missing.json")]));
      expect(r.code).toBe(2);
      expect(server.received.length).toBe(0);
      expect(r.err).toContain("指摘の処置の JSON");
    } finally {
      await server.close();
    }
  });

  test("a missing lane or token sends nothing and fails", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url, { lane: null });
      const noLane = await capture(() => runLaneCommand("report", ["plan", "--dec-count", "0", "--inv-count", "0", "--qa-count", "0", "--reference-count", "0", "--size", "S", "--harm", "0", "--depth", "shallow", "--situation", "s", "--action", "a", "--outcome", "o", "--risk-table", riskFile(), "--intent-impact", impactFile()]));
      setEnv(server.url, { token: null });
      const noToken = await capture(() => runLaneCommand("report", ["progress", "--current-step", "s"]));
      expect([noLane.code, noToken.code]).toEqual([2, 2]);
      expect(server.received.length).toBe(0);
      expect(noLane.err).toContain("IDD_ID");
      expect(noToken.err).toContain("IDD_AGENT_TOKEN");
    } finally {
      await server.close();
    }
  });

  test("the lane cannot be changed from an argument", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const r = await capture(() => runLaneCommand("report", ["progress", "--lane", "IDD-999", "--current-step", "s"]));
      expect(r.code).toBe(2);
      expect(server.received.length).toBe(0);
      expect(r.err).toContain("環境変数");
    } finally {
      await server.close();
    }
  });

  test("questions comes back at once without waiting for an answer (AC-004) and tells the agent to end its turn (AC-005)", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true } }]);
    try {
      setEnv(server.url);
      const file = questionsFile([question()]);
      const started = Date.now();
      const r = await capture(() => runLaneCommand("report", ["questions", "--file", file]));
      expect(r.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(r.out).toContain("turn を終えてください");
      expect(r.out).toContain("次の message で届きます");
      // the leading block is JSON with the batch id; the guidance line follows it. The ask tool reads only that block.
      const lines = r.out.split("\n");
      const start = lines.findIndex((l) => l.trim() === "{");
      const end = lines.findIndex((l) => l === "}");
      expect(start).toBe(0);
      expect(end).toBeGreaterThan(start);
      const parsed = JSON.parse(lines.slice(start, end + 1).join("\n")) as { batch_id?: string };
      expect(typeof parsed.batch_id).toBe("string");
      expect(lines[end + 1]).toContain("turn を終えてください");
    } finally {
      await server.close();
    }
  });
});

describe("idd report: shape before sending", () => {
  test("a malformed questions file is refused and nothing is sent", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const noOptions = questionsFile([{ question_id: "q1", question: "Q" }]);
      const emptyOptions = questionsFile([question({ options: [] })]);
      const tooMany = questionsFile(Array.from({ length: 6 }, (_, i) => question({ question_id: `q${i}` })));
      for (const file of [noOptions, emptyOptions, tooMany]) {
        const r = await capture(() => runLaneCommand("report", ["questions", "--file", file]));
        expect(r.code).toBe(2);
      }
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("a questions file with a label over the limit is refused before sending", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const long = questionsFile([question({ options: [{ index: 1, label: "あ".repeat(41) }] })]);
      const r = await capture(() => runLaneCommand("report", ["questions", "--file", long]));
      expect(r.code).toBe(2);
      expect(r.err).toContain("40 文字まで");
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("a value that starts with -- is sent through the = form, and the space form is refused", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const eq = await capture(() => runLaneCommand("report", ["progress", "--current-step", "s", "--recent=--no-verify は使わない"]));
      expect(eq.code).toBe(0);
      expect(server.received[0].body.recent_activity).toEqual(["--no-verify は使わない"]);
      const space = await capture(() => runLaneCommand("report", ["result", "--outcome", "success", "--side-finding", "--no-verify は使わない"]));
      expect(space.code).toBe(2);
      expect(space.err).toContain("--flag=値");
      // nothing was sent for the refused one
      expect(server.received.length).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("a bad outcome, a missing summary line and a non-numeric count are refused", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const badOutcome = await capture(() => runLaneCommand("report", ["result", "--outcome", "great"]));
      const badSummary = await capture(() => runLaneCommand("report", ["plan", "--dec-count", "0", "--inv-count", "0", "--qa-count", "0", "--reference-count", "0", "--situation", "s", "--action", "a"]));
      const badCount = await capture(() => runLaneCommand("report", ["plan", "--dec-count", "two", "--inv-count", "0", "--qa-count", "0", "--reference-count", "0", "--size", "S", "--harm", "0", "--depth", "shallow", "--situation", "s", "--action", "a", "--outcome", "o", "--risk-table", riskFile(), "--intent-impact", impactFile()]));
      const badStatus = await capture(() => runLaneCommand("report", ["progress", "--current-step", "s", "--ac", "AC-001=done"]));
      expect([badOutcome.code, badSummary.code, badCount.code, badStatus.code]).toEqual([2, 2, 2, 2]);
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("a plan without a risk table, or with a malformed one, is refused before anything is sent", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const base = ["plan", "--dec-count", "0", "--inv-count", "0", "--qa-count", "0", "--reference-count", "0", "--situation", "s", "--action", "a", "--outcome", "o"];
      const none = await capture(() => runLaneCommand("report", base));
      expect(none.code).toBe(2);
      expect(none.err).toContain("--risk-table");
      const dir = tmpDir("idd-report-");
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{ not json");
      const unreadable = await capture(() => runLaneCommand("report", [...base, "--risk-table", bad]));
      expect(unreadable.code).toBe(2);
      expect(unreadable.err).toContain("該当表");
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("a plan without an impact report, or with a malformed one, is refused before anything is sent", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const base = ["plan", "--dec-count", "0", "--inv-count", "0", "--qa-count", "0", "--reference-count", "0", "--situation", "s", "--action", "a", "--outcome", "o", "--risk-table", riskFile()];
      const none = await capture(() => runLaneCommand("report", base));
      expect(none.code).toBe(2);
      expect(none.err).toContain("--intent-impact");
      expect(none.err).toContain("idd intent decisions");
      const notArray = await capture(() => runLaneCommand("report", [...base, "--intent-impact", impactFile({ paths: [], decisions: "none" })]));
      expect(notArray.code).toBe(2);
      const badEffect = await capture(() => runLaneCommand("report", [...base, "--intent-impact", impactFile({ paths: [], decisions: [{ id: "DEC-758", effect: "maybe", reason: "x" }] })]));
      expect(badEffect.code).toBe(2);
      const unknown = await capture(() => runLaneCommand("report", [...base, "--intent-impact", impactFile({ paths: [], decisions: [{ id: "DEC-999999", effect: "keep", reason: "x" }] })]));
      expect(unknown.code).toBe(2);
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("a valid impact report is sent under its own field", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const r = await capture(() => runLaneCommand("report", ["plan", "--dec-count", "0", "--inv-count", "0", "--qa-count", "0", "--reference-count", "0", "--size", "S", "--harm", "0", "--depth", "shallow", "--situation", "s", "--action", "a", "--outcome", "o", "--risk-table", riskFile(), "--intent-impact", impactFile({ paths: ["src/x.ts"], decisions: [{ id: "DEC-758", effect: "keep", reason: "Why を保つ。" }] })]));
      expect(r.code).toBe(0);
      expect(server.received[0].body.intent_impact).toEqual({ paths: ["src/x.ts"], decisions: [{ id: "DEC-758", effect: "keep", reason: "Why を保つ。" }] });
    } finally {
      await server.close();
    }
  });

  test("a v2 report without counts is sent under the same field, and a malformed one is refused first (AC-008 / AC-013)", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const draft = {
        purpose: "P-1",
        forms: { chosen: "確認を挟む", rejected: [{ form: "省く", fails_because: "取り消せない削除が残る" }] },
        place: [{ path: "src/x.ts", kind: "file" }],
        why: "取り消せない削除を防ぐため。",
        anchored: "削除は確認を通る。",
      };
      const body = { paths: ["src/x.ts"], choices: [draft], existing: [] };
      const r = await capture(() => runLaneCommand("report", ["plan", "--qa-count", "0", "--reference-count", "0", "--size", "S", "--harm", "0", "--depth", "shallow", "--situation", "s", "--action", "a", "--outcome", "o", "--risk-table", riskFile(), "--intent-impact", impactFile(body)]));
      expect(r.code).toBe(0);
      // the Place is read as its module with the file as the mark, and sent in that shape
      expect(server.received[0].body.intent_impact).toEqual({ ...body, choices: [{ ...draft, place: [{ path: "src/", kind: "module", file: "src/x.ts" }] }] });
      // a draft with no forms is refused before anything is sent
      const bad = await capture(() => runLaneCommand("report", ["plan", "--qa-count", "0", "--reference-count", "0", "--size", "S", "--harm", "0", "--depth", "shallow", "--situation", "s", "--action", "a", "--outcome", "o", "--risk-table", riskFile(), "--intent-impact", impactFile({ paths: [], choices: [{ purpose: "P-1" }], existing: [] })]));
      expect(bad.code).toBe(2);
      expect(server.received.length).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("a refusal from the API fails the command and its reason is shown", async () => {
    const server = await fakeServer([{ status: 400, body: { ok: false, error: "unknown lane: IDD-035" } }]);
    try {
      setEnv(server.url);
      const r = await capture(() => runLaneCommand("report", ["progress", "--current-step", "s"]));
      expect(r.code).toBe(1);
      expect(r.err).toContain("unknown lane: IDD-035");
    } finally {
      await server.close();
    }
  });

  test("the report path writes nothing to state", async () => {
    const server = await fakeServer();
    const state = tmpDir("idd-report-state-");
    process.env.IDD_STATE_DIR = state;
    // restored by afterEach
    try {
      setEnv(server.url);
      const file = questionsFile([question()]);
      await capture(() => runLaneCommand("report", ["questions", "--file", file]));
      await capture(() => runLaneCommand("report", ["plan", "--dec-count", "0", "--inv-count", "0", "--qa-count", "0", "--reference-count", "0", "--size", "S", "--harm", "0", "--depth", "shallow", "--situation", "s", "--action", "a", "--outcome", "o", "--risk-table", riskFile(), "--intent-impact", impactFile()]));
      await capture(() => runLaneCommand("report", ["progress", "--current-step", "s", "--ac", "AC-001=todo"]));
      await capture(() => runLaneCommand("report", ["result", "--outcome", "success"]));
      expect(readdirSync(state)).toEqual([]);
    } finally {
      delete process.env.IDD_STATE_DIR;
      await server.close();
    }
  });

  test("a warning from the API is shown without failing the report", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true, warning: "summary を捨てました" } }]);
    try {
      setEnv(server.url);
      const r = await capture(() => runLaneCommand("report", ["plan", "--dec-count", "0", "--inv-count", "0", "--qa-count", "0", "--reference-count", "0", "--size", "S", "--harm", "0", "--depth", "shallow", "--situation", "s", "--action", "a", "--outcome", "o", "--risk-table", riskFile(), "--intent-impact", impactFile()]));
      expect(r.code).toBe(0);
      expect(r.err).toContain("summary を捨てました");
    } finally {
      await server.close();
    }
  });
});

describe("idd report: evidence (AC-011)", () => {
  test("progress and result carry --evidence to the intake under the field names", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const progress = await capture(() => runLaneCommand("report", ["progress", "--current-step", "s", "--ac", "AC-001=verified", "--evidence", "AC-001=npm run test:core: 12 passed"]));
      const result = await capture(() => runLaneCommand("report", ["result", "--outcome", "success", "--verified", "AC-001", "--evidence", "AC-001=npm run test:core: 12 passed"]));
      expect([progress.code, result.code]).toEqual([0, 0]);
      expect(server.received[0].body.qa_status).toEqual([{ qa_id: "AC-001", status: "verified", evidence: "npm run test:core: 12 passed" }]);
      expect(server.received[1].body.qa_evidence).toEqual({ "AC-001": "npm run test:core: 12 passed" });
    } finally {
      await server.close();
    }
  });

  test("a malformed --evidence, or one for an AC not reported, is refused before sending", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const noEq = await capture(() => runLaneCommand("report", ["progress", "--current-step", "s", "--ac", "AC-001=verified", "--evidence", "AC-001"]));
      const noAc = await capture(() => runLaneCommand("report", ["progress", "--current-step", "s", "--ac", "AC-001=verified", "--evidence", "AC-002=x"]));
      const noVerified = await capture(() => runLaneCommand("report", ["result", "--outcome", "success", "--verified", "AC-001", "--evidence", "AC-002=x"]));
      expect([noEq.code, noAc.code, noVerified.code]).toEqual([2, 2, 2]);
      expect(server.received.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("the covered, deferred and not-applicable words are accepted", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const r = await capture(() => runLaneCommand("report", ["progress", "--current-step", "s", "--ac", "AC-001=covered", "--ac", "AC-002=deferred", "--ac", "AC-003=not-applicable", "--ac", "AC-004=planned"]));
      expect(r.code).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("idd report granularity: the lane's slicing, before the request", () => {
  const granularityFile = (body: unknown): string => {
    const dir = tmpDir("idd-report-");
    const file = join(dir, "granularity.json");
    writeFileSync(file, JSON.stringify(body));
    return file;
  };

  test("a split goes to the granularity API, and the planner is told to end its turn", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const file = granularityFile({ kind: "split", reason: "責務が 2 つ。", children: [{ title: "a", whole: "1 つ判定できる。", places: ["src/a.ts"] }] });
      const r = await capture(() => runLaneCommand("report", ["granularity", "--file", file]));
      expect(r.code).toBe(0);
      expect(server.received.length).toBe(1);
      expect(server.received[0].path).toBe("/api/idd/agent/granularity");
      expect(server.received[0].auth).toBe(`Bearer ${TOKEN}`);
      expect(server.received[0].body.idd_id).toBe(LANE);
      expect((server.received[0].body.proposal as Record<string, unknown>).kind).toBe("split");
      expect(r.out).toContain("turn を終えて");
    } finally {
      await server.close();
    }
  });

  test("a single judgement sends the same report and lets the planner go on", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const file = granularityFile({ kind: "single", reason: "責務が 1 つ。" });
      const r = await capture(() => runLaneCommand("report", ["granularity", "--file", file]));
      expect(r.code).toBe(0);
      expect(server.received.length).toBe(1);
      expect(r.out).not.toContain("turn を終えて");
    } finally {
      await server.close();
    }
  });

  test("a proposal the stopped stage records only is answered with the request to write the plan on", async () => {
    const server = await fakeServer([{ status: 200, body: { ok: true, stage: "off" } }]);
    try {
      setEnv(server.url);
      const file = granularityFile({ kind: "split", reason: "責務が 2 つ。", children: [{ title: "a", whole: "1 つ判定できる。", places: ["src/a.ts"] }] });
      const r = await capture(() => runLaneCommand("report", ["granularity", "--file", file]));
      expect(r.code).toBe(0);
      expect(server.received.length).toBe(1);
      // no answer is coming: ending the turn here would leave the planner waiting on a person nobody asked
      expect(r.out).not.toContain("turn を終えて");
      expect(r.out).toContain("書き進めて");
      expect(r.out).toContain("止まっています");
    } finally {
      await server.close();
    }
  });

  test("a malformed proposal is refused before anything is sent", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const r = await capture(() => runLaneCommand("report", ["granularity", "--file", granularityFile({ kind: "split", reason: "r", children: [] })]));
      expect(r.code).toBe(2);
      expect(server.received.length).toBe(0);
      expect(r.err).toContain("粒度の案の形");
    } finally {
      await server.close();
    }
  });

  test("a plan carries the 1本 reason under --granularity-reason", async () => {
    const server = await fakeServer();
    try {
      setEnv(server.url);
      const r = await capture(() => runLaneCommand("report", [...planFlags(), "--granularity-reason", "人が 1 本と決めた。"]));
      expect(r.code).toBe(0);
      expect(server.received[0].body.granularity_reason).toBe("人が 1 本と決めた。");
    } finally {
      await server.close();
    }
  });
});
