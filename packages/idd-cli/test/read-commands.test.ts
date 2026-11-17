/**
 * The read list is one, and every read is a read. The tests check the shared gate (AC-004 leans on it too),
 * that a lane's detail answer is folded to its point instead of dumped (C-167-3), and that the six reads a
 * person and an agent share all answer (AC-005).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  READ_COMMAND_NAMES, docCandidates, formatCards, formatDocs, formatLand, formatLane, formatLanes, formatLedger, formatReviews,
  readCommandRefusal, runReadCommand,
} from "../src/read-commands.ts";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, deps: { stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) } };
}

const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("idd read: the one list and the gate", () => {
  test("the list holds the reads the tool may run", () => {
    expect([...READ_COMMAND_NAMES].sort()).toEqual(["cards", "delivered", "docs", "land", "lane", "lanes", "ledger", "reviews", "structure"]);
  });

  test("a name that is not a read is refused, so a write verb never squeezes in", () => {
    expect(readCommandRefusal(["decide", "IDD-1"])).toContain("読み取りの command ではありません");
    expect(readCommandRefusal(["out", "draft"])).toContain("読み取りの command ではありません");
    expect(readCommandRefusal([])).toContain("指定してください");
  });

  test("a writing or unknown flag is refused, and so is a flag missing its value", () => {
    expect(readCommandRefusal(["lane", "IDD-1", "--approve"])).toContain("知らない flag");
    expect(readCommandRefusal(["ledger", "--out", "x"])).toContain("知らない flag");
    expect(readCommandRefusal(["ledger", "--lane"])).toContain("値が必要");
  });

  test("a shell character in an argument is refused before anything runs", async () => {
    const c = capture();
    let called = false;
    const code = await runReadCommand(["lane", "IDD-1; rm -rf /"], { ...c.deps, fetch: (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch });
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(c.stderr.join("")).toContain("shell の文字");
    expect(readCommandRefusal(["lanes", "$(whoami)"])).toContain("shell の文字");
  });
});

describe("idd read: the engine's values are folded to lines", () => {
  const STATE = {
    lanes: [
      { iddId: "IDD-167", title: "通常の会話から指す", group: "impl", stageCurrent: 2, blockedBy: "実装中", source: { kind: "github", label: "penne-0505/pi-web-idd#169" } },
      { iddId: "IDD-165", title: "card の相談", group: "judge", stageCurrent: null, source: { kind: "github", label: "penne-0505/pi-web-idd#167" } },
    ],
    items: [
      { kind: "question", iddId: "IDD-165", laneTitle: "通常の会話", open: [{ question: "どこに置くか", options: [{ label: "A" }, { label: "B" }] }] },
      { kind: "go", iddId: "IDD-167", laneTitle: "通常の会話から指す", summary: { situation: "状況", action: "行動", outcome: "結果" } },
    ],
  };

  test("lanes are one line each with the stage and the Issue", () => {
    const lines = formatLanes(STATE);
    expect(lines[0]).toContain("lane 2 本");
    expect(lines[1]).toContain("IDD-167");
    expect(lines[1]).toContain("実装中");
    expect(lines[1]).toContain("penne-0505/pi-web-idd#169");
  });

  test("a lane's detail keeps the point and never dumps the whole answer", async () => {
    const detail = {
      iddId: "IDD-167", title: "通常の会話から指す", phaseLabel: "実装", branch: "feature/idd-167",
      contract: { decisions: [{ id: "C-167-1", text: "一覧は CLI に 1 つ" }], criteria: [{ id: "AC-001", text: "入力欄から指せる", state: "planned" }] },
      timeline: [{ time: "2026-10-17T11:00:00Z", title: "s1_go", kind: "mark" }],
      huge: "x".repeat(200000),
    };
    const c = capture();
    const code = await runReadCommand(["lane", "IDD-167"], { ...c.deps, baseUrl: () => "http://x", fetch: respond(detail) });
    expect(code).toBe(0);
    const text = c.stdout.join("");
    expect(text).toContain("AC-001");
    expect(text).toContain("C-167-1");
    expect(text).toContain("s1_go");
    expect(text.length).toBeLessThan(20000);
    expect(text).not.toContain("x".repeat(1000));
  });

  test("cards show a question's ask and options and a GO's three lines, and nothing else", () => {
    const text = formatCards(STATE).join("\n");
    expect(text).toContain("どこに置くか");
    expect(text).toContain("選択肢: A / B");
    expect(text).toContain("状況: 状況 / 行動: 行動 / 結果: 結果");
  });

  test("the ledger and the land records are the point lines, newest last", () => {
    const events = [
      { event: "s1_go", idd_id: "IDD-167", at: "2026-10-17T10:00:00Z" },
      { event: "s4_land_merged", idd_id: "IDD-153", at: "2026-10-17T11:00:00Z", attrs: { pr: 146 } },
    ];
    expect(formatLedger(events)[1]).toContain("s1_go");
    const land = formatLand(events);
    expect(land[0]).toContain("1 件");
    expect(land[1]).toContain("s4_land_merged");
    expect(land[1]).toContain("pr=146");
  });

  test("docs and reviews say where the records are and how they head", () => {
    expect(formatDocs("IDD-167", [{ kind: "plan", path: "/w/_docs/plan/a/idd-167/plan.md", headings: ["依頼", "意図"] }]).join("\n")).toContain("/w/_docs/plan/a/idd-167/plan.md");
    expect(formatReviews("IDD-153", [{ dir: "1-blind-r1-x", files: ["report.md"], heading: "査読" }]).join("\n")).toContain("1-blind-r1-x: 査読");
  });

  test("a document is looked for where its writer puts it: the area's last segment and the lowercase lane id", () => {
    // the area key is `owner/name`, so the raw key once built a path no writer makes and every read answered empty
    expect(docCandidates("plan", "pi-web-idd", "idd-167")).toEqual([
      "_docs/plan/pi-web-idd/idd-167/plan.md",
      "_docs/archives/plan/pi-web-idd/idd-167/plan.md",
    ]);
    expect(docCandidates("qa", "pi-web-idd", "idd-167")).toContain("_docs/qa/pi-web-idd/idd-167/qa.md");
    // a reference may be written beside the intent instead of under reference
    expect(docCandidates("reference", "pi-web-idd", "idd-167")).toContain("_docs/intent/pi-web-idd/idd-167/reference.md");
  });
});

describe("idd read: the reads answer end to end", () => {
  test("lanes and cards go through the door, and --json keeps the answer", async () => {
    const state = { lanes: [{ iddId: "IDD-1", title: "t", group: "impl" }], items: [] };
    const c = capture();
    expect(await runReadCommand(["lanes"], { ...c.deps, baseUrl: () => "http://x", fetch: respond(state) })).toBe(0);
    expect(c.stdout.join("")).toContain("IDD-1");

    const j = capture();
    expect(await runReadCommand(["cards", "--json"], { ...j.deps, baseUrl: () => "http://x", fetch: respond(state) })).toBe(0);
    expect(JSON.parse(j.stdout.join(""))).toEqual([]);
  });

  test("the ledger is read from the state's own file, never from the engine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idd-read-"));
    const saved = process.env.IDD_STATE_DIR;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "lifecycle-me.jsonl"), `${JSON.stringify({ event: "s1_go", idd_id: "IDD-1", at: "2026-10-17T10:00:00Z" })}\n`);
      process.env.IDD_STATE_DIR = dir;
      const c = capture();
      let called = false;
      const code = await runReadCommand(["ledger", "--lane", "IDD-1"], { ...c.deps, fetch: (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch });
      expect(code).toBe(0);
      expect(called).toBe(false);
      expect(c.stdout.join("")).toContain("s1_go");
    } finally {
      if (saved === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--lane narrows the JSON beside the lines, not only the printed lines", async () => {
    // the detail door's shape is over 100KB and the ledger only grew: a caller naming one lane must not get the others
    const dir = mkdtempSync(join(tmpdir(), "idd-read-"));
    const saved = process.env.IDD_STATE_DIR;
    try {
      mkdirSync(dir, { recursive: true });
      const rows = [
        { event: "s1_go", idd_id: "IDD-1", at: "2026-10-17T10:00:00Z" },
        { event: "s1_go", idd_id: "IDD-2", at: "2026-10-17T10:01:00Z" },
        { event: "s4_land_merged", idd_id: "IDD-1", at: "2026-10-17T11:00:00Z" },
        { event: "s4_land_merged", idd_id: "IDD-2", at: "2026-10-17T11:01:00Z" },
      ];
      writeFileSync(join(dir, "lifecycle-me.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
      process.env.IDD_STATE_DIR = dir;
      const lanesOf = (out: string[]) => (JSON.parse(out.join("")) as { idd_id: string }[]).map((e) => e.idd_id);

      const ledger = capture();
      expect(await runReadCommand(["ledger", "--lane", "IDD-1", "--json"], ledger.deps)).toBe(0);
      expect(lanesOf(ledger.stdout)).toEqual(["IDD-1", "IDD-1"]);

      const land = capture();
      expect(await runReadCommand(["land", "--lane", "IDD-1", "--json"], land.deps)).toBe(0);
      expect(lanesOf(land.stdout)).toEqual(["IDD-1"]);

      // without --lane the whole record is still the answer
      const all = capture();
      expect(await runReadCommand(["ledger", "--json"], all.deps)).toBe(0);
      expect(lanesOf(all.stdout)).toHaveLength(4);
    } finally {
      if (saved === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
