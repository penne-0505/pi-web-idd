import { describe, expect, test } from "bun:test";

import { formatForecast, runForecastCommand } from "../src/forecast.ts";
import type { ForecastView } from "../../idd-core/src/plan/forecast.ts";

const stat = (median: number, p75: number): { median: number; p75: number; threshold: number; samples: number; basis: "repo" } =>
  ({ median, p75, threshold: Math.max(2 * p75, 10), samples: 20, basis: "repo" });

const VIEW: ForecastView = {
  ok: true,
  generatedAt: "2026-10-13T08:20:00.000Z",
  usual: [{
    area: "penne-0505/pi-web-idd",
    lanes: 20,
    stages: {
      plan: stat(9.9, 15.5),
      plan_review: stat(25.2, 33.7),
      impl: stat(38.9, 69.9),
      review: stat(16.1, 19.7),
      fix: stat(33.5, 45.6),
      checks: stat(2, 2.5),
      land: stat(0.4, 7.2),
    },
  }],
  lanes: [
    {
      iddId: "IDD-104", area: "penne-0505/pi-web-idd",
      now: { kind: "stage", stage: "plan", since: "2026-10-13T08:01:00.000Z", elapsedMin: 19 },
      anomaly: false,
      eta: { at: "2026-10-13T08:45:00.000Z", stopsAt: "go", remaining: [{ stage: "plan", minutes: 0 }, { stage: "plan_review", minutes: 25 }] },
    },
    {
      iddId: "IDD-105", area: "penne-0505/pi-web-idd",
      now: { kind: "wait", wait: "order", since: "2026-10-13T06:00:00.000Z", elapsedMin: 140 },
      anomaly: false,
      eta: { at: null, stopsAt: null, via: { lane: "IDD-101", stopsAt: "sign" }, remaining: [{ stage: "review", minutes: 16 }, { stage: "checks", minutes: 2 }] },
    },
    {
      iddId: "IDD-106", area: "penne-0505/pi-web-idd",
      now: { kind: "gate", gate: "question", since: "2026-10-13T07:00:00.000Z", elapsedMin: 80 },
      anomaly: false,
      eta: { at: null, stopsAt: "question", remaining: [] },
    },
  ],
};

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, deps: { stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) } };
}

describe("idd forecast", () => {
  test("prints one line per lane with the stage, the elapsed time, the finish or whose hands it is in, and the red mark (AC-028)", async () => {
    const c = capture();
    const code = await runForecastCommand([], {
      ...c.deps,
      baseUrl: () => "http://127.0.0.1:0",
      fetch: (async () => new Response(JSON.stringify({ ...VIEW, lanes: VIEW.lanes.map((l) => l.iddId === "IDD-104" ? { ...l, anomaly: true } : l) }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    const lines = c.stdout.join("").trim().split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("IDD-104");
    expect(lines[0]).toContain("計画");
    expect(lines[0]).toContain("19分");
    expect(lines[0]).toContain("終わる頃");
    expect(lines[0]).toContain("朱");
    expect(lines[1]).toContain("相手しだい");
    expect(lines[1]).toContain("IDD-101");
    expect(lines[2]).toContain("質問待ち");
    expect(lines[2]).toContain("時刻は出せない");
  });

  test("a lane id narrows the table to that lane, and --json prints the response as it is (AC-028)", async () => {
    const one = capture();
    expect(await runForecastCommand(["IDD-105"], { ...one.deps, baseUrl: () => "http://127.0.0.1:0", fetch: (async () => new Response(JSON.stringify(VIEW), { status: 200 })) as unknown as typeof fetch })).toBe(0);
    const lines = one.stdout.join("").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("IDD-105");

    const json = capture();
    expect(await runForecastCommand(["--json"], { ...json.deps, baseUrl: () => "http://127.0.0.1:0", fetch: (async () => new Response(JSON.stringify(VIEW), { status: 200 })) as unknown as typeof fetch })).toBe(0);
    const parsed = JSON.parse(json.stdout.join(""));
    expect(parsed.lanes[0].iddId).toBe("IDD-104");
    expect(parsed.usual[0].stages.checks.threshold).toBe(10);
  });

  test("formatForecast names a lane with no forecast", () => {
    expect(formatForecast(VIEW, "IDD-999").join("\n")).toContain("IDD-999 の見込みはありません");
  });

  test("an engine that is down gives the wording, not a stack trace (AC-029)", async () => {
    const c = capture();
    const code = await runForecastCommand([], {
      ...c.deps,
      baseUrl: () => "http://127.0.0.1:0",
      fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(code).toBe(1);
    expect(c.stderr.join("")).toContain("engine に繋がりません");
  });
});
