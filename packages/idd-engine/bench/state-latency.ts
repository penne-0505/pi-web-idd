/**
 * How fast the state door answers, measured against a fixed ledger outside CI (Issue #189 の 7).
 *
 *     bun run packages/idd-engine/bench/state-latency.ts [--runs 30] [--warmup 5] [--lanes 400] [--events 24] [--json]
 *
 * The engine is started in this process on a free loopback port against a fixture state the script writes and
 * removes, so the numbers do not move with the real ledger's size and nothing under the repo's state is touched. The
 * checks in config/repos.yaml do not include this script: it is a measurement a person runs, not a gate.
 */
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { landPath } from "@idd/core";

import { writeFixtureConfig, writeStateFixture } from "./fixture.ts";

function flag(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = Number(args[i + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** the percentage of the sorted samples (p50 = half of them) */
export function percentile(samples: number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const runs = flag(args, "runs", 30);
  const warmup = flag(args, "warmup", 5);
  const lanes = flag(args, "lanes", 400);
  const eventsPerLane = flag(args, "events", 24);
  const dir = mkdtempSync(join(tmpdir(), "idd-state-bench-"));
  // the state is set before anything is written: the fixture's records are placed through the state's own paths, and
  // a run that wrote them anywhere else would land in whatever state the shell pointed at
  process.env.IDD_STATE_DIR = dir;
  process.env.IDD_REPOS_FILE = join(dir, "repos.yaml");
  process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
  const summary = writeStateFixture(dir, { lanes, eventsPerLane });
  writeFixtureConfig(dir);
  // a guard rather than a hope: a fixture that would write outside the run's own place is not run at all
  const placed = landPath("IDD-001");
  if (!placed.startsWith(dir)) {
    throw new Error(`fixture の置き場が実行の場所の外を指しています: ${placed}`);
  }
  // the engine's own settings are not part of the measurement: an unset tailnet and no passkey keep it on loopback
  delete process.env.PI_WEB_ALLOWED_HOSTS;
  const port = flag(args, "port", 30191);
  // imported after the state is set: the doors read the state when they answer, not when they are loaded
  const { startEngine } = await import("../src/server.ts");
  let server: ReturnType<typeof startEngine> | undefined;
  try {
    server = startEngine({ port });
    const origin = `http://127.0.0.1:${server.port}`;
    const times: number[] = [];
    for (let i = 0; i < warmup + runs; i += 1) {
      const started = performance.now();
      const res = await fetch(`${origin}/api/idd/state`, { headers: { "Cache-Control": "no-store" } });
      await res.text();
      const ms = performance.now() - started;
      if (!res.ok) {
        process.stderr.write(`状態の口が ${res.status} を返しました\n`);
        return 1;
      }
      // the warm-up answers are paid once by the process's caches, not by the door
      if (i >= warmup) times.push(ms);
    }
    const result = {
      endpoint: "/api/idd/state",
      lanes: summary.lanes,
      events: summary.events,
      rounds: summary.rounds,
      runs,
      warmup,
      ms: {
        p50: Math.round(percentile(times, 50) * 10) / 10,
        p95: Math.round(percentile(times, 95) * 10) / 10,
        max: Math.round(Math.max(...times) * 10) / 10,
        min: Math.round(Math.min(...times) * 10) / 10,
      },
    };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`状態の口 ${result.endpoint}（lane ${result.lanes} 本・event ${result.events} 行・検査 ${result.rounds} 回の fixture、${runs} 回）\n`);
      process.stdout.write(`p50 ${result.ms.p50} ms / p95 ${result.ms.p95} ms / 最小 ${result.ms.min} ms / 最大 ${result.ms.max} ms\n`);
    }
    return 0;
  } finally {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`測れませんでした: ${String(err)}\n`);
    process.exitCode = 1;
  });
}
