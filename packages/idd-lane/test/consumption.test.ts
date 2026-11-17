import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendConsumption, consumptionPath, filterConsumption, jstDayOf, readConsumption, summarizeConsumption } from "../src/consumption.ts";
import { tmpDir } from "./helpers/tmp.ts";

function state() {
  const root = tmpDir("idd-consumption-");
  process.env.IDD_STATE_DIR = join(root, "state");
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

const row = (over: Record<string, unknown>) => ({
  at: "2026-10-14T03:00:00.000Z", unit: "attempt" as const, cost: 0, contract: "openrouter", ...over,
});

describe("the consumption record", () => {
  test("rows are appended one write each and read back whole", () => {
    const root = state();
    try {
      appendConsumption(row({ lane: "L1", provider: "together", cost: 0.004, input: 10, output: 2, status: "failed", failure: "provider" }));
      appendConsumption(row({ lane: "L1", unit: "reply", cost: 0.01, input: 3, output: 1, status: "done" }));
      const rows = readConsumption();
      expect(rows.length).toBe(2);
      expect(rows[0]).toMatchObject({ unit: "attempt", provider: "together", failure: "provider" });
      expect(rows[1]).toMatchObject({ unit: "reply", status: "done" });
      // one line per row, so a reader never sees half a row
      expect(readFileSync(consumptionPath(), "utf8").trim().split("\n").length).toBe(2);
    } finally { delete process.env.IDD_STATE_DIR; }
  });

  test("a line that does not read is skipped, not fatal", () => {
    const root = state();
    try {
      appendConsumption(row({ lane: "L1", cost: 0.1 }));
      writeFileSync(consumptionPath(), `${readFileSync(consumptionPath(), "utf8")}{ not json\n`);
      expect(readConsumption().length).toBe(1);
    } finally { delete process.env.IDD_STATE_DIR; }
  });

  test("the summary splits by contract and provider and counts the failure kinds", () => {
    const summary = summarizeConsumption([
      row({ contract: "openrouter", provider: "together", cost: 0.004, input: 10, failure: "provider" }),
      row({ contract: "openrouter", provider: "together", cost: 0.006, output: 5 }),
      row({ contract: "openrouter", provider: "novita", cost: 0.02 }),
      row({ contract: "claude", harness: "claude", unit: "reply", cost: 0.5, failure: "timeout" }),
    ]);
    expect(summary.cost).toBeCloseTo(0.53, 6);
    expect(summary.units).toBe(4);
    expect(summary.buckets.map((b) => [b.contract, b.provider ?? null, b.attempts, b.replies])).toEqual([
      ["claude", null, 0, 1],
      ["openrouter", "novita", 1, 0],
      ["openrouter", "together", 2, 0],
    ]);
    expect(summary.buckets.find((b) => b.provider === "together")).toMatchObject({ input: 10, output: 5 });
    expect(summary.failures).toEqual({ provider: 1, timeout: 1 });
  });

  test("rows can be read for one lane and from one JST day on", () => {
    const rows = [
      row({ at: "2026-10-13T14:59:00.000Z", lane: "L1" }), // 2026-10-13 23:59 JST
      row({ at: "2026-10-13T15:00:00.000Z", lane: "L1" }), // 2026-10-14 00:00 JST
      row({ at: "2026-10-14T03:00:00.000Z", lane: "L2" }),
    ];
    expect(filterConsumption(rows, { lane: "L1" }).length).toBe(2);
    expect(filterConsumption(rows, { since: "2026-10-14" }).map((r) => r.lane)).toEqual(["L1", "L2"]);
    expect(jstDayOf("2026-10-13T15:00:00.000Z")).toBe("2026-10-14");
  });
});
