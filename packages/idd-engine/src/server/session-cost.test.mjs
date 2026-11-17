import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { ensureAgentRunner } = await import("./agent-runner.ts");
const { getAgentRunner } = await import("@idd/core");

const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
let dir;
const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-session-cost-"));
  process.env.IDD_STATE_DIR = dir;
  process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
  writeFileSync(process.env.IDD_ROLES_FILE, "roles:\n  r: { model: x/y }\npipeline:\n");
  ensureAgentRunner();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("the runner's session cost reading", () => {
  it("AC-007: splits a pi session's replies by the JST day each was written", () => {
    const agent = join(dir, "agent");
    const sessions = join(agent, "sessions", "--wt--");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "2026-10-05_S1.jsonl"), jsonl([
      { type: "message", timestamp: "2026-10-05T14:00:00Z", message: { role: "assistant", usage: { cost: { total: 0.1 } } } },
      { type: "message", timestamp: "2026-10-05T15:00:00Z", message: { role: "assistant", usage: { cost: { total: 0.2 } } } },
      { type: "message", timestamp: "2026-10-05T15:30:00Z", message: { role: "user" } },
    ]));
    process.env.PI_CODING_AGENT_DIR = agent;
    const runner = getAgentRunner();
    const reading = runner.sessionDailyCost("S1");
    assert.deepEqual(reading.daily, [
      { day: "2026-10-05", cost: 0.1 },
      { day: "2026-10-06", cost: 0.2 },
    ]);
    assert.equal(reading.cost, 0.30000000000000004);
    assert.match(runner.sessionRecordFingerprint("S1"), /^\d/);
  });

  it("AC-007: splits a Claude conversation's reported totals by the day each reply ended", () => {
    const lane = join(dir, "lanes", "L1");
    mkdirSync(lane, { recursive: true });
    mkdirSync(join(dir, "pipeline", "conversations"), { recursive: true });
    writeFileSync(join(dir, "pipeline", "conversations", "S2"), "L1");
    writeFileSync(join(lane, "lane.json"), JSON.stringify({ id: "L1", role_preset: { harness: "claude" } }));
    writeFileSync(join(lane, "turns.jsonl"), jsonl([
      { n: 1, started_at: "2026-10-05T14:00:00Z", ended_at: "2026-10-05T14:30:00Z", status: "done", reached: true, reported_cost: 0.2 },
      { n: 2, started_at: "2026-10-05T15:00:00Z", ended_at: "2026-10-05T15:30:00Z", status: "done", reached: true, reported_cost: 0.5 },
    ]));
    const reading = getAgentRunner().sessionDailyCost("S2");
    assert.deepEqual(reading.daily, [
      { day: "2026-10-05", cost: 0.2 },
      { day: "2026-10-06", cost: 0.3 },
    ]);
    assert.equal(reading.cost, 0.5);
    assert.match(getAgentRunner().sessionRecordFingerprint("S2"), /^\d/);
  });

  it("AC-008: a taken-over pi session with no session file is read from its turn log, not treated as absent", () => {
    const lane = join(dir, "lanes", "L3");
    mkdirSync(lane, { recursive: true });
    mkdirSync(join(dir, "pipeline", "conversations"), { recursive: true });
    writeFileSync(join(dir, "pipeline", "conversations", "S3"), "L3");
    writeFileSync(join(lane, "lane.json"), JSON.stringify({ id: "L3", worktree: dir, role_preset: { name: "r", harness: "pi" } }));
    writeFileSync(join(lane, "turns.jsonl"), jsonl([
      { n: 1, started_at: "2026-10-05T14:00:00Z", ended_at: "2026-10-05T14:30:00Z", status: "done", reached: true, usage: { input: 1, output: 1, cost: 0.4 } },
    ]));
    const runner = getAgentRunner();
    assert.match(runner.sessionRecordFingerprint("S3"), /^\d/);
    assert.deepEqual(runner.sessionDailyCost("S3").daily, [{ day: "2026-10-05", cost: 0.4 }]);
  });
});
