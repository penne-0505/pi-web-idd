import { describe, expect, test } from "bun:test";

import { formatStorage, runStorageCommand } from "../src/storage.ts";
import type { StorageView } from "../../idd-core/src/storage/api.ts";

const VIEW: StorageView = {
  ok: true,
  measuredAt: "2026-10-06T00:00:00.000Z",
  cleanup: false,
  minFreeGb: 10,
  archive: null,
  filesystems: [{ mount: "/", freeBytes: 13 * 1024 ** 3, totalBytes: 252 * 1024 ** 3, belowThreshold: false }],
  places: [{ place: "run_records", label: "役の実行の記録", bytes: 6.2 * 1024 ** 3, count: 1188, cleanup: false }],
  candidates: [{ place: "run_records", path: "/state/lanes/x", bytes: 1024, usedUpAt: "2026-09-20T12:00:00Z", dueAt: "2026-09-27T12:00:00Z", removal: "contents-then-evidence", evidence: { kind: "lane-json", path: "/state/lanes/x/lane.json" }, lane: "IDD-1" }],
  kept: [{ place: "run_records", path: "/state/lanes/y", reason: "属する lane が閉じていません", lane: "IDD-2" }],
  lastSweep: null,
  heldLanes: [],
};

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, deps: { stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) } };
}

describe("idd storage", () => {
  test("prints the places, the free space, the candidates and the reasons (AC-026)", async () => {
    const c = capture();
    const code = await runStorageCommand([], {
      ...c.deps,
      baseUrl: () => "http://127.0.0.1:0",
      fetch: (async () => new Response(JSON.stringify(VIEW), { status: 200 })) as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    const text = c.stdout.join("");
    expect(text).toContain("役の実行の記録");
    expect(text).toContain("/state/lanes/x");
    expect(text).toContain("IDD-1");
    expect(text).toContain("次に消す候補: 1 件");
    expect(text).toContain("属する lane が閉じていません");
  });

  test("--json prints the same view as JSON", async () => {
    const c = capture();
    const code = await runStorageCommand(["--json"], {
      ...c.deps,
      baseUrl: () => "http://127.0.0.1:0",
      fetch: (async () => new Response(JSON.stringify(VIEW), { status: 200 })) as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(""));
    expect(parsed.candidates[0].path).toBe("/state/lanes/x");
  });

  test("a reachable engine that answers with an error says so", async () => {
    const c = capture();
    const code = await runStorageCommand([], {
      ...c.deps,
      baseUrl: () => "http://127.0.0.1:0",
      fetch: (async () => new Response(JSON.stringify({ error: "設定を読めません" }), { status: 500 })) as unknown as typeof fetch,
    });
    expect(code).toBe(1);
    expect(c.stderr.join("")).toContain("設定を読めません");
  });

  test("an engine that is down gives the wording, not a stack trace", async () => {
    const c = capture();
    const code = await runStorageCommand([], {
      ...c.deps,
      baseUrl: () => "http://127.0.0.1:0",
      fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(code).toBe(1);
    expect(c.stderr.join("")).toContain("engine に繋がりません");
  });

  test("formatStorage names a place that is off and one without a cleanup flag", () => {
    const lines = formatStorage({
      ...VIEW,
      cleanup: true,
      places: [
        { place: "run_records", label: "役の実行の記録", bytes: 0, count: 0, cleanup: false },
        { place: "manual_copies", label: "手動のレビュー用の複製", bytes: 0, count: 1, cleanup: null },
      ],
    }).join("\n");
    expect(lines).toContain("役の実行の記録: 0.0G / 0 個 [OFF]");
    expect(lines).toContain("手動のレビュー用の複製: 0.0G / 1 個 [既存]");
  });
});
