import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONTEXT_FILES_RECORD } from "../src/context-files.ts";
import { deliveredRun, diffDelivered, resolveRun, textDiff, NOT_RECORDED_CLAUDE, NOT_RECORDED_PI, NOT_RECORDED_PI_ADDENDUM, NOT_RECORDED_PI_COPIED, NOT_SHOWN_PI } from "../src/delivered.ts";
import {
  ADDENDUM, ADDENDUM_TEXT, AGENTS, DOTENV_BODY, INJECT, KEY_VALUE, PREAMBLE, REPLY, REQUEST_1, REQUEST_2, THINKING,
  claudeConversation, claudeOneOff, msg, piConversation, piOneOff, put, restoreStateDir, runDir, stateRoot, text, toolExchange, worktreeDir, type PiOptions,
} from "./helpers/delivered-fixture.ts";

restoreStateDir();

const read = (id: string) => deliveredRun(id)!;
/** a fresh state with the pi conversation `run-pi` in it, read back */
const piRun = (opts?: PiOptions) => {
  piConversation(stateRoot(), "run-pi", opts);
  return read("run-pi");
};
const shown = (run: ReturnType<typeof read>) => JSON.stringify(run);
/** the lines that are the system prompt's own parts: the context files and the package's norms */
const handed = (lines: ReturnType<typeof read>["lines"]) => lines.filter((l) => l.kind === "context-file" || l.kind === "addendum");
/** the turns log of a two-reply conversation, with the log's word on whether each reply reached the model */
const putReached = (dir: string, ...flags: boolean[]) =>
  put(dir, "turns.jsonl", flags.map((ok, i) => `${JSON.stringify({ n: i + 1, message: `m${i + 1}.md`, status: ok ? "done" : "failed", reached: ok })}\n`).join(""));

describe("what a pi conversation was handed, in the order it was handed", () => {
  test("the request is the text as sent, each reply's own, and the second reply's envelope comes after the first's work", () => {
    const lines = piRun({ second: REQUEST_2 }).lines;
    const requests = lines.filter((l) => l.kind === "request");
    expect(requests.map((l) => [l.turn, l.heading, l.text])).toEqual([[1, "s1_prep_start", REQUEST_1], [2, "plan_review_findings", REQUEST_2]]);
    expect(lines.indexOf(requests[1])).toBeGreaterThan(lines.findIndex((l) => l.kind === "tool-result"));
  });

  test("the opened file's result comes with the tool's name and path, and the hook's block follows it as its own line", () => {
    const lines = piRun().lines;
    const at = lines.findIndex((l) => l.heading === "read src/a.ts");
    expect(lines.slice(at, at + 2)).toMatchObject([{ kind: "tool-result", turn: 1, text: "export const a = 1;\n" }, { kind: "inject", heading: "Choice src/a.ts", text: INJECT }]);
  });

  test("the system prompt gives its context file and the package's addendum, and not the model's words or pi's fixed opening", () => {
    const run = piRun();
    const given = handed(run.lines);
    expect(given.map((l) => [l.kind, l.heading, l.text])).toEqual([["context-file", "/wt/AGENTS.md", `\n${AGENTS}`], ["addendum", "パッケージの規約", ADDENDUM_TEXT]]);
    for (const left of [THINKING, REPLY, PREAMBLE, "<tools>", "<skills>", "<cwd>"]) expect(shown(run)).not.toContain(left);
    expect(run.notes).toEqual([NOT_SHOWN_PI]);
  });

  test("a stream that has the system prompt only at a message's end, or as one string, still gives its context file and addendum", () => {
    const root = stateRoot();
    const sections = { addendum: ADDENDUM, project_context: `<project_context>\n<project_instructions path="/wt/AGENTS.md">\n${AGENTS}</project_instructions>\n</project_context>` };
    piOneOff(root, "run-end", [msg("system", { content: "", sections }, "message_end")]);
    piOneOff(root, "run-whole", [msg("system", { content: `${PREAMBLE}\n${sections.project_context}\n${ADDENDUM}` })]);
    for (const id of ["run-end", "run-whole"]) {
      const run = read(id);
      expect([id, handed(run.lines).map((l) => l.heading), run.notes]).toEqual([id, ["/wt/AGENTS.md", "パッケージの規約"], [NOT_SHOWN_PI]]);
    }
  });

  test("a pi run whose stream has no system prompt says it is not recorded, and does not say the fixed part was left out", () => {
    piOneOff(stateRoot(), "run-old", []);
    expect(read("run-old").notes).toEqual([NOT_RECORDED_PI]);
  });

  test("a system prompt that comes again with a later reply adds nothing", () => {
    const root = stateRoot();
    const dir = piConversation(root, "run-pi", { second: REQUEST_2 });
    const system = readFileSync(join(dir, "turns", "1.jsonl"), "utf8").split("\n").filter((l) => l.includes('"role":"system"'));
    put(dir, "turns/2.jsonl", `${system.join("\n")}\n${readFileSync(join(dir, "turns", "2.jsonl"), "utf8")}`);
    const kinds = read("run-pi").lines.map((l) => l.kind);
    expect(kinds.filter((k) => k === "context-file" || k === "addendum")).toEqual(["context-file", "addendum"]);
  });
});

describe("the context files copied when pi was started", () => {
  test("a run whose stream has no system prompt still gives its context files, from the copy, and says what is still not recorded", () => {
    const dir = piOneOff(stateRoot(), "run-copy", []);
    put(dir, CONTEXT_FILES_RECORD, JSON.stringify([{ files: [{ path: "/wt/AGENTS.override.md", content: AGENTS }, { path: "/wt/.env", content: `API_KEY=${KEY_VALUE}\n` }] }]));
    const run = read("run-copy");
    expect(run.lines.filter((l) => l.kind === "context-file").map((l) => [l.heading, l.text])).toEqual([["/wt/AGENTS.override.md", AGENTS], ["/wt/.env", `API_KEY=${KEY_VALUE}\n`]]);
    expect(run.notes).toEqual([NOT_RECORDED_PI_ADDENDUM]);
  });

  test("a copy and a system prompt that also has the file give it once, from the copy, with the addendum from the stream", () => {
    const dir = piConversation(stateRoot(), "run-pi");
    put(dir, CONTEXT_FILES_RECORD, JSON.stringify([{ turn: 1, files: [{ path: "/wt/AGENTS.md", content: AGENTS }] }]));
    const run = read("run-pi");
    expect(handed(run.lines).map((l) => [l.kind, l.text])).toEqual([["context-file", AGENTS], ["addendum", ADDENDUM_TEXT]]);
    expect(run.notes).toEqual([NOT_SHOWN_PI]);
  });

  test("a copy's addendum is given from the copy once, and a record without the system prompt names the copy as the source", () => {
    const dir = piOneOff(stateRoot(), "run-copy", []);
    put(dir, CONTEXT_FILES_RECORD, JSON.stringify([{ files: [], addendum: ADDENDUM_TEXT }]));
    const run = read("run-copy");
    expect([run.lines.filter((l) => l.kind === "addendum").map((l) => l.text), run.notes]).toEqual([[ADDENDUM_TEXT], [NOT_RECORDED_PI_COPIED]]);
    const conv = piConversation(stateRoot(), "run-pi");
    put(conv, CONTEXT_FILES_RECORD, JSON.stringify([{ turn: 1, files: [], addendum: "copied norms" }]));
    expect(read("run-pi").lines.filter((l) => l.kind === "addendum").map((l) => l.text)).toEqual(["copied norms"]);
  });

  test("a reply whose own copy was skipped (the same rules again) is read with the earlier copy, after a reply that never got there", () => {
    const dir = piConversation(stateRoot(), "run-pi", { second: REQUEST_2 });
    putReached(dir, false, true);
    put(dir, CONTEXT_FILES_RECORD, JSON.stringify([{ turn: 1, files: [{ path: "/wt/AGENTS.md", content: AGENTS }], addendum: "norms" }]));
    const lines = read("run-pi").lines;
    expect(handed(lines).map((l) => [l.kind, l.turn])).toEqual([["context-file", undefined], ["addendum", undefined]]);
    expect(lines.findIndex((l) => l.kind === "context-file")).toBeLessThan(lines.findIndex((l) => l.heading === "plan_review_findings"));
  });

  test("a conversation's copy comes before the reply it was made for, and a later copy gives only what changed", () => {
    const dir = piConversation(stateRoot(), "run-pi", { second: REQUEST_2 });
    const agents = { path: "/wt/AGENTS.md", content: AGENTS };
    put(dir, CONTEXT_FILES_RECORD, JSON.stringify([{ turn: 1, files: [agents] }, { turn: 2, files: [agents, { path: "/wt/CLAUDE.md", content: "second rule" }] }]));
    const lines = read("run-pi").lines;
    const at = (heading: string) => lines.findIndex((l) => l.heading === heading);
    expect([at("/wt/AGENTS.md") < at("s1_prep_start"), at("/wt/CLAUDE.md") > at("read src/a.ts"), at("/wt/CLAUDE.md") < at("plan_review_findings")]).toEqual([true, true, true]);
    expect(lines.filter((l) => l.heading === "/wt/AGENTS.md")).toHaveLength(1);
  });
});

describe("a tool's result is shown as the model got it", () => {
  test("every tool's result comes whole: a file read (a `.env` too), a shell's output and a grep, with the command or the path in the heading", () => {
    const root = stateRoot();
    const wt = worktreeDir(root, "wt-a");
    const rows = [
      ...toolExchange({ id: "e", name: "read", arguments: { path: ".env" } }, DOTENV_BODY),
      ...toolExchange({ id: "s", name: "read", arguments: { path: "scratch.txt" } }, `token: Bearer ${KEY_VALUE}`),
      ...toolExchange({ id: "b", name: "bash", arguments: { command: `curl -H "Authorization: Bearer ${KEY_VALUE}" https://x.test` } }, `ok ${KEY_VALUE}`),
      ...toolExchange({ id: "g", name: "grep", arguments: { pattern: "api_key", path: "config" } }, `config/app.yaml:1:api_key: ${KEY_VALUE}`),
    ];
    piOneOff(root, "run-a", rows, wt);
    const lines = read("run-a").lines.filter((l) => l.kind === "tool-result");
    expect(lines.map((l) => [l.heading.split(" ").slice(0, 2).join(" "), l.text.includes(KEY_VALUE)])).toEqual([["read .env", true], ["read scratch.txt", true], ["bash curl", true], ["grep config", true]]);
    expect(lines[0].text).toBe(DOTENV_BODY);
    expect(lines[2].heading).toContain(KEY_VALUE);
  });

  test("a path in a heading is relative to the worktree, and one outside it, or a command, stays as it was written", () => {
    const root = stateRoot();
    const wt = worktreeDir(root, "wt-a");
    const paths = [join(wt, "src/a.ts"), "config/../src/a.ts", "./src/a.ts", "/etc/hosts", "../nowhere.txt", wt];
    piOneOff(root, "run-a", paths.flatMap((p, i) => toolExchange({ id: `r${i}`, name: "read", arguments: { path: p } }, "x")), wt);
    expect(read("run-a").lines.filter((l) => l.kind === "tool-result").map((l) => l.heading)).toEqual(["read src/a.ts", "read src/a.ts", "read src/a.ts", "read /etc/hosts", "read ../nowhere.txt", "read ."]);
  });
});

describe("the same file in two worktrees is one line", () => {
  test("the key is the path from the worktree, so another worktree's result for it matches and shows its difference", () => {
    const root = stateRoot();
    piConversation(root, "run-a", { idd: "IDD-1", worktree: worktreeDir(root, "one") });
    piConversation(root, "run-b", { idd: "IDD-2", worktree: worktreeDir(root, "two"), fileResult: "export const a = 2;\n" });
    const [a, b] = [read("run-a"), read("run-b")];
    const key = (r: typeof a) => r.lines.find((l) => l.heading === "read src/a.ts")?.key;
    expect([key(a), key(b)]).toEqual(["tool-result:read src/a.ts", "tool-result:read src/a.ts"]);
    const rows = diffDelivered(a.lines, b.lines);
    expect(rows.filter((r) => r.mark !== "same").map((r) => [r.mark, r.a?.heading])).toEqual([["changed", "read src/a.ts"]]);
  });
});

describe("a reply the model never got", () => {
  test("a turn the log says did not reach the model gives no request, and says so; a row with no word on it is read as before", () => {
    const dir = piConversation(stateRoot(), "run-pi", { second: REQUEST_2 });
    expect(read("run-pi").lines.filter((l) => l.kind === "request")).toHaveLength(2);
    putReached(dir, true, false);
    const run = read("run-pi");
    expect(run.lines.filter((l) => l.kind === "request").map((l) => l.turn)).toEqual([1]);
    expect(shown(run)).not.toContain("2 回目の封筒");
    expect(run.notes.join("\n")).toContain("turn 2 はモデルに届かなかった");
  });
});

describe("what a Claude run was handed", () => {
  test("the request comes from the file it was sent from, the hook's session-start text and the tool results from the stream", () => {
    claudeConversation(stateRoot(), "run-claude");
    const run = read("run-claude");
    const [head, ...rest] = run.lines;
    expect(rest.map((l) => `${l.kind}:${l.heading}`)).toEqual(["session-start:案内", "tool-result:Read .env", "tool-result:Read src/a.ts"]);
    expect({ head: `${head.kind}:${head.heading}`, request: head.text, start: rest[0].text, notes: run.notes }).toEqual({ head: "request:s2_start", request: REQUEST_1, start: "session 開始の案内の文", notes: [NOT_RECORDED_CLAUDE] });
    for (const left of [THINKING, REPLY]) expect(shown(run)).not.toContain(left);
  });

  test("a one-off run's request is its brief", () => {
    claudeOneOff(stateRoot(), "run-one", "IDD-9");
    const run = read("run-one");
    expect([run.conversation, run.lines[0].kind, run.lines[0].text.startsWith("brief of one run")]).toEqual([false, "request", true]);
  });
});

describe("finding a run", () => {
  test("a run's id, or a lane and a role, name it; the newest run of the pair wins, and a one-off run is found by the lane its spec names", () => {
    const root = stateRoot();
    piConversation(root, "20261111-010000-planner-x");
    piConversation(root, "20261111-020000-planner-x");
    piConversation(root, "20261111-030000-planner-x", { idd: "IDD-8" });
    claudeOneOff(root, "20261111-040000-reviewer", "IDD-9");
    const found = ["20261111-010000-planner-x", "IDD-9/planner-x", "IDD-8/planner-x", "IDD-9/reviewer", "IDD-9/executor", "no-such-run", "../escape", ".", "..", ".x"].map(resolveRun);
    expect(found).toEqual(["20261111-010000-planner-x", "20261111-020000-planner-x", "20261111-030000-planner-x", "20261111-040000-reviewer", null, null, null, null, null, null]);
  });

  test("a reference to the directory above the runs reads nothing, even where a record is laid out there", () => {
    const root = stateRoot();
    piConversation(root, "run-pi");
    put(root, "brief.md", "zq-outside");
    put(root, "lane.json", JSON.stringify({ id: "up", role: "planner-x", worktree: "/wt", started_at: "2026-11-11T01:00:00.000Z" }));
    put(root, "turns/1.jsonl", "{}\n");
    for (const id of [".", "..", ".x"]) expect([id, deliveredRun(id), resolveRun(id)]).toEqual([id, null, null]);
  });

  test("reading on a machine with no run writes nothing, not even the state's directories", () => {
    const empty = join(stateRoot(), "nowhere");
    process.env.IDD_STATE_DIR = empty;
    const answers = [resolveRun("IDD-9/planner-x"), resolveRun("run-1"), deliveredRun("run-1")];
    expect({ answers, made: existsSync(empty) }).toEqual({ answers: [null, null, null], made: false });
  });
});

describe("a run still being written", () => {
  test("a line cut in the middle is skipped and the lines before it are read", () => {
    const root = stateRoot();
    const dir = piConversation(root, "run-pi");
    const whole = readFileSync(join(dir, "turns", "1.jsonl"), "utf8");
    put(dir, "turns/1.jsonl", `${whole}{"type":"message_start","message":{"role":"toolResult","toolCallId":"c9","toolName":"read","content":[{"type":"te`);
    const headings = read("run-pi").lines.map((l) => l.heading);
    expect(headings).toContain("read src/a.ts");
    expect(headings.some((h) => h.includes("c9"))).toBe(false);
  });

  test("a reply that has only its inflight file still shows the request it took, and a run with no record yet has no lines", () => {
    const root = stateRoot();
    const dir = runDir(root, "run-live", { mode: "conversation", idd_id: "IDD-9", role_preset: { name: "planner-x", harness: "pi" } });
    put(dir, "inflight/m1.md", REQUEST_1);
    put(dir, "inflight.json", JSON.stringify({ n: 1, message: "m1.md", started_at: "2026-11-11T01:00:00.000Z" }));
    expect(read("run-live").lines).toMatchObject([{ kind: "request", turn: 1, text: REQUEST_1 }]);
    runDir(root, "run-new", { role_preset: { name: "planner-x", harness: "pi" } });
    expect(read("run-new").lines).toEqual([]);
  });
});

describe("what the model was handed is shown as it was", () => {
  test("a context file that is a `.env`, a key in a request and the hook's text come out literally, and nothing says anything was hidden", () => {
    const run = piRun({ request: `${REQUEST_1}\n<token>CALLBACK-TOKEN-1</token>`, contextPath: "/wt/.env.local", contextBody: `API_KEY=${KEY_VALUE}\n`, fileResult: `export GITHUB_TOKEN=${KEY_VALUE}\n` });
    const out = shown(run);
    expect([out.includes("CALLBACK-TOKEN-1"), out.split(KEY_VALUE).length - 1, out.includes("伏せた"), out.includes("redacted")]).toEqual([true, 3, false, false]);
  });
});

describe("two runs side by side", () => {
  test("the same record twice is all the same", () => {
    const lines = piRun({ second: REQUEST_2 }).lines;
    const rows = diffDelivered(lines, read("run-pi").lines);
    expect([rows.length, rows.every((r) => r.mark === "same")]).toEqual([lines.length, true]);
  });

  test("a changed line shows its text's difference, and a line one side has is only that side's, also across lanes", () => {
    const root = stateRoot();
    piConversation(root, "run-a", { idd: "IDD-1", request: `${REQUEST_1}\nA の 1 行` });
    piConversation(root, "run-b", { idd: "IDD-2", request: `${REQUEST_1}\nB の 1 行`, second: REQUEST_2 });
    const rows = diffDelivered(read("run-a").lines, read("run-b").lines);
    const changed = rows.filter((r) => r.mark === "changed");
    expect(changed.map((r) => r.a?.kind)).toEqual(["request"]);
    expect(changed[0].diff?.filter((d) => d.op !== " ").map((d) => `${d.op}${d.text}`)).toEqual(["-A の 1 行", "+B の 1 行"]);
    expect(rows.filter((r) => r.mark === "only-b").map((r) => r.b?.heading)).toEqual(["plan_review_findings"]);
    expect(rows.filter((r) => r.mark === "only-a")).toEqual([]);
  });

  test("the text difference keeps the lines that did not change", () => {
    const op = (o: " " | "-" | "+", t: string) => ({ op: o, text: t });
    expect(textDiff("a\nb\nc", "a\nB\nc")).toEqual([op(" ", "a"), op("-", "b"), op("+", "B"), op(" ", "c")]);
  });
});

describe("the messages a reader never sees twice", () => {
  test("an assistant message's end gives its tool calls to the result that follows, and only that", () => {
    const dir = runDir(stateRoot(), "run-one", { role_preset: { name: "x", harness: "pi" } });
    const call = { type: "toolCall", id: "z", name: "bash", arguments: { command: "ls -la" } };
    const rows = [msg("assistant", { content: [call] }, "message_end"), msg("toolResult", { toolCallId: "z", toolName: "bash", content: text("total 0") }), msg("toolResult", { toolCallId: "unknown", toolName: "grep", content: text("hit") })];
    put(dir, "events.jsonl", rows.map((r) => JSON.stringify(r)).join("\n"));
    expect(read("run-one").lines.map((l) => [l.heading, l.text])).toEqual([["bash ls -la", "total 0"], ["grep", "hit"]]);
  });
});
