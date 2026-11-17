import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GET } from "../src/routes/metrics.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

const ROOT = tmpDir("canary-metrics-");
const SAVED = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE };

/** a state of its own, with a canary record for the period and the period before it */
function setup() {
  const state = join(ROOT, "state");
  const dir = join(state, "pipeline", "canary");
  mkdirSync(dir, { recursive: true });
  const repos = join(ROOT, "repos.yaml");
  writeFileSync(repos, JSON.stringify({ repos: {} }));
  process.env.IDD_STATE_DIR = state;
  process.env.IDD_REPOS_FILE = repos;
  const task = (chars, total_ms, structure = "ok") => ({ id: "json-items", kind: "json", structure, output: "x", chars, total_ms, usd: 0.0002, tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } });
  const record = (day, tasks) => ({ role: "executor", model: "ollama-cloud/deepseek-v4.1-flash", thinking: "high", day, at: `${day}T03:00:00+09:00`, tasks });
  mkdirSync(join(dir, "2026-10-06"), { recursive: true });
  writeFileSync(join(dir, "2026-10-06", "executor.json"), JSON.stringify(record("2026-10-06", [task(100, 1000)])));
  mkdirSync(join(dir, "2026-10-13"), { recursive: true });
  writeFileSync(join(dir, "2026-10-13", "executor.json"), JSON.stringify(record("2026-10-13", [task(300, 1000, "fail")])));
  return { state };
}

afterAll(() => {
  // the files of this test run in one process: the state this test points at must not outlive it
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

describe("the metrics door", () => {
  test("it hands the canary's records of the period and the period before to the reading", async () => {
    setup();
    const res = await GET(new Request("http://127.0.0.1/api/idd/metrics?since=2026-10-12&until=2026-10-18"));
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.canary.previous).toEqual({ since: "2026-10-05", until: "2026-10-11" });
    expect(view.canary.rows).toHaveLength(1);
    const row = view.canary.rows[0];
    expect(row.task).toBe("json-items");
    expect(row.marks).toEqual({ structure: true, chars: true, total_ms: false });
    expect(row.current.chars).toBe(300);
    expect(row.previous.chars).toBe(100);
    // the canary's cost stays out of the lanes' wallet
    expect(view.totals.cost.budget).toBe(0);
  }, 30_000);

  test("the period left unsaid is the seven days that end on the last day asked for", async () => {
    setup();
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const dayOffset = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86400_000).toISOString().slice(0, 10);
    const res = await GET(new Request("http://127.0.0.1/api/idd/metrics"));
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.until).toBe(today);
    expect(view.since).toBe(dayOffset(6));
    // the week before is the same seven days in front of the period
    expect(view.canary.previous).toEqual({ since: dayOffset(13), until: dayOffset(7) });
  }, 30_000);

  test("a week that ends on a Sunday starts on the ISO week's Monday, and the week before is the seven days in front", async () => {
    setup();
    const res = await GET(new Request("http://127.0.0.1/api/idd/metrics?until=2026-10-11"));
    expect(res.status).toBe(200);
    const view = await res.json();
    // 2026-10-11 is a Sunday: the week is Monday 10-05 to Sunday 10-11, and the week before is the seven days in front
    expect(view.until).toBe("2026-10-11");
    expect(view.since).toBe("2026-10-05");
    expect(view.canary.previous).toEqual({ since: "2026-09-28", until: "2026-10-04" });
  }, 30_000);
});
