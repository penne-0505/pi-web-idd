import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatWorkConsumption, formatWorkFindings, formatWorkRecord, runWorkCommand } from "../src/work.ts";
import type { WorkFindingsView, WorkRecordView } from "../../../lib/idd-ui/work-types.ts";

const RECORD: WorkRecordView = {
  lane: "IDD-105",
  acceptance: [{ id: "AC-001", statement: "追記で残る", status: "verified", evidence: "ran it" }],
  log: [{ at: "2026-10-13T02:00:00Z", stage: "実装", commands: ["AC-001: ran it"], acceptance: { done: 1, total: 1, open: [] }, verdict: "PASS", who: "executor" }],
  findings: {
    placed: [{ id: "F-105-1", lane: "IDD-105", path: "src/a.ts", lines: [3, 5], commit: "H1", severity: "should", claim: "穴がある", status: "open" }],
    delivered: [],
    disposals: [{ id: "F-105-1", action: "fix" }],
  },
};

const FINDINGS: WorkFindingsView = {
  repo: "me/app",
  paths: ["src/a.ts"],
  findings: [{ id: "F-105-1", lane: "IDD-105", path: "src/a.ts", lines: [3, 5], commit: "H1", severity: "should", claim: "穴がある", status: "open" }],
};

const CONSUMPTION = {
  rows: [],
  summary: {
    cost: 0.504,
    units: 2,
    buckets: [
      { contract: "claude", cost: 0.5, input: 30, output: 5, units: 1, attempts: 0, replies: 1 },
      { contract: "openrouter", provider: "together", cost: 0.004, input: 10, output: 2, units: 1, attempts: 1, replies: 0 },
    ],
    failures: { provider: 1 },
  },
};

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, deps: { stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) } };
}

const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("idd work", () => {
  test("record prints a table and --json prints the door's answer (AC-037)", async () => {
    const c = capture();
    const code = await runWorkCommand(["record", "IDD-105"], { ...c.deps, baseUrl: () => "http://x", fetch: respond(RECORD) });
    expect(code).toBe(0);
    expect(c.stdout.join("")).toContain("AC-001");
    expect(c.stdout.join("")).toContain("F-105-1");

    const j = capture();
    await runWorkCommand(["record", "IDD-105", "--json"], { ...j.deps, baseUrl: () => "http://x", fetch: respond(RECORD) });
    expect(JSON.parse(j.stdout.join(""))).toEqual(RECORD);
  });

  test("findings sends the paths and the repo, and prints a table or the raw answer (AC-037)", async () => {
    let seen = "";
    const c = capture();
    const code = await runWorkCommand(["findings", "src/a.ts", "--repo", "me/app"], {
      ...c.deps,
      baseUrl: () => "http://x",
      fetch: (async (url: string) => { seen = String(url); return new Response(JSON.stringify(FINDINGS), { status: 200 }); }) as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    expect(seen).toContain("repo=me%2Fapp");
    expect(seen).toContain("path=src%2Fa.ts");
    expect(c.stdout.join("")).toContain("F-105-1");

    const j = capture();
    await runWorkCommand(["findings", "src/a.ts", "--repo", "me/app", "--json"], { ...j.deps, baseUrl: () => "http://x", fetch: respond(FINDINGS) });
    expect(JSON.parse(j.stdout.join(""))).toEqual(FINDINGS);
  });

  test("consumption sends the filters and prints the totals by contract, or the raw answer", async () => {
    let seen = "";
    const c = capture();
    const code = await runWorkCommand(["consumption", "--since", "2026-10-14", "--lane", "L1"], {
      ...c.deps,
      baseUrl: () => "http://x",
      fetch: (async (url: string) => { seen = String(url); return new Response(JSON.stringify(CONSUMPTION), { status: 200 }); }) as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    expect(seen).toContain("since=2026-10-14");
    expect(seen).toContain("lane=L1");
    expect(c.stdout.join("")).toContain("$0.5000");
    expect(c.stdout.join("")).toContain("openrouter（together）");
    expect(c.stdout.join("")).toContain("失敗: provider 1");

    const j = capture();
    await runWorkCommand(["consumption", "--json"], { ...j.deps, baseUrl: () => "http://x", fetch: respond(CONSUMPTION) });
    expect(JSON.parse(j.stdout.join(""))).toEqual(CONSUMPTION);
  });

  test("a down engine is one line, and nothing is written into the state (AC-035)", async () => {
    const state = mkdtempSync(join(tmpdir(), "idd-work-state-"));
    process.env.IDD_STATE_DIR = state;
    try {
      const c = capture();
      const code = await runWorkCommand(["record", "IDD-105"], {
        ...c.deps,
        baseUrl: () => "http://x",
        fetch: (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch,
      });
      expect(code).toBe(1);
      expect(c.stderr.join("")).toContain("engine に繋がりません");
      expect(readdirSync(state)).toEqual([]);
    } finally {
      delete process.env.IDD_STATE_DIR;
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("the table formatters name the finding and its place", () => {
    expect(formatWorkRecord(RECORD).join("\n")).toContain("src/a.ts:3-5");
    expect(formatWorkFindings(FINDINGS)[0]).toContain("穴がある");
    expect(formatWorkFindings({ repo: "me/app", paths: ["z.ts"], findings: [] })[0]).toContain("open な指摘はありません");
    expect(formatWorkConsumption({ cost: 0, units: 0, buckets: [], failures: {} })[0]).toContain("まだありません");
  });

  test("a wrong verb is the usage and exit 2", async () => {
    const c = capture();
    expect(await runWorkCommand(["nope"], c.deps)).toBe(2);
  });
});
