import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { landPath } from "@idd/core";
import { landRoundHistoryPath } from "@idd/core";

/**
 * The fixed ledger the state door is measured against (Issue #189 の 7): the same backlog, lifecycle, landing checks
 * and consumption every run, so the week-to-week difference of p50 / p95 is the code's and not the size of a ledger
 * that grows by itself. The rows are made from a seeded generator: the same seed gives the same files, byte for byte.
 *
 * It lives outside the state the engine writes, and the script that measures it removes it when the run ends.
 */

/** a small deterministic generator: the same seed and the same call order give the same numbers */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const BASE_MS = Date.parse("2026-09-01T00:00:00+09:00");

/** a moment `minutes` after the base, as an ISO string */
function at(minutes: number): string {
  return new Date(BASE_MS + minutes * 60_000).toISOString();
}

function jsonl(rows: unknown[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

export interface FixtureOptions {
  /** how many lanes the ledger holds */
  lanes?: number;
  /** how many events each lane's record holds (the record of a lane that went through the whole pipeline) */
  eventsPerLane?: number;
  seed?: number;
}

export interface FixtureSummary {
  dir: string;
  lanes: number;
  events: number;
  rounds: number;
}

const STAGES = [
  "lane_open", "s1_plan_review_started", "s1_plan_review_done", "s1_ready", "s1_go", "s2_start", "s2_result",
  "s2_review_started", "s2_review_converged", "s3_ready", "s3_ok", "s4_submit_started", "s4_land_approved", "lane_close",
];

/**
 * Write the fixture's ledger into `dir`. Only the files the state door and the metrics read are written: the backlog,
 * one lifecycle file per area, the landing records and rounds, and the consumption rows. A lane's events grow from
 * the stages above, so a bigger fixture is a longer record and not a fatter row.
 */
export function writeStateFixture(dir: string, opts: FixtureOptions = {}): FixtureSummary {
  const lanes = opts.lanes ?? 400;
  const eventsPerLane = opts.eventsPerLane ?? 24;
  const random = seeded(opts.seed ?? 424242);
  mkdirSync(dir, { recursive: true });
  const areas = ["Demo/one", "Demo/two"];
  const backlog: unknown[] = [];
  const lifecycle = new Map<string, unknown[]>(areas.map((a) => [a, []]));
  const consumption: unknown[] = [];
  let events = 0;
  let rounds = 0;
  for (let i = 1; i <= lanes; i += 1) {
    const iddId = `IDD-${String(i).padStart(3, "0")}`;
    const area = areas[i % areas.length];
    const openMinute = Math.floor(random() * 40) * 60 + i * 7;
    backlog.push({
      idd_id: iddId,
      parent_id: null,
      created_at: at(openMinute),
      linear_issue_url: null,
      gh_issue_url: `https://github.com/Demo/one/issues/${i}`,
      pull_req_url: null,
      source_type: "github",
      context: `lane ${i} の依頼`,
      title: `${iddId} の題名`,
      area,
    });
    const rows = lifecycle.get(area)!;
    const pipeline = {
      pipeline: { planner: { role: "planner", concurrency: 3 }, executor: { role: "executor", concurrency: 4 } },
      models: { planner: ["model-a"], executor: ["model-b"] },
      key: i % 4 === 0 ? "aaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbb",
    };
    let minute = openMinute;
    for (let k = 0; k < eventsPerLane; k += 1) {
      const event = k === 0 ? "lane_open" : STAGES[1 + ((k - 1) % (STAGES.length - 1))];
      minute += 1 + Math.floor(random() * 30);
      rows.push({
        idd_id: iddId,
        event,
        at: at(minute),
        attrs: {
          ...(event === "lane_open" ? { source_type: "github", area, pipeline } : {}),
          ...(event === "s1_ready" ? { dec_count: 1 } : {}),
          ...(event === "s4_land_approved" ? { head: `head-${i}`, signed: true } : {}),
        },
      });
      events += 1;
    }
    const closed = i % 3 === 0;
    if (closed) rows.push({ idd_id: iddId, event: "lane_close", at: at(minute + 90), attrs: { outcome: "local" } });
    // a landing record for the lanes that got to the submit card, and the rounds that checked them
    if (i % 5 === 0) {
      const path = landPath(iddId);
      mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      writeFileSync(path, JSON.stringify({
        iddId, branch: `idd/${iddId}`, head: `head-${i}`, workBase: "work-main", mainTip: `tip-${i}`,
        checks: [{ name: "typecheck", status: "pass", severity: "blocking" }], blocking: 0, token: "t",
        expiresAt: at(minute + 600), configKey: "cfg", status: "complete",
      }), "utf8");
      const roundPath = landRoundHistoryPath(iddId);
      mkdirSync(roundPath.slice(0, roundPath.lastIndexOf("/")), { recursive: true });
      const roundRows = [0, 1].map((n) => ({
        id: `${iddId}-r${n}`, lane: iddId, status: "done", started_at: at(minute + n * 10), ended_at: at(minute + n * 10 + 4),
        wall_seconds: 240, cpu_seconds: 120.5, cpu_source: "cgroup", head: `head-${i}`, mainTip: `tip-${i}`,
        mergeCommit: `merge-${i}-${n}`, signed: true, repo: "/tmp/fixture", diff_lines: 120,
        checks: [
          { name: "typecheck", status: "pass", severity: "blocking", ms: 30_000 },
          { name: "eslint-warnings", status: "pass", severity: "blocking", ms: 94_000, counts: { mainline: 141, merged: 141 } },
        ],
        blocking: 0,
      }));
      writeFileSync(roundPath, jsonl(roundRows), "utf8");
      rounds += roundRows.length;
      consumption.push({ at: at(minute + 5), unit: "attempt", lane: `${iddId}-r0`, idd_id: iddId, role: "executor", model: "model-b", input: 1200, output: 300, cost: 0.02 });
      consumption.push({ at: at(minute + 6), unit: "reply", lane: `${iddId}-chat`, idd_id: iddId, role: "planner", model: "model-a", input: 800, output: 200, cost: 0.01 });
    }
  }
  writeFileSync(join(dir, "backlog.jsonl"), jsonl(backlog), "utf8");
  for (const [area, rows] of lifecycle) writeFileSync(join(dir, `lifecycle-${area.replace("/", "-")}.jsonl`), jsonl(rows), "utf8");
  mkdirSync(join(dir, "pipeline"), { recursive: true });
  writeFileSync(join(dir, "pipeline", "consumption.jsonl"), jsonl(consumption), "utf8");
  return { dir, lanes, events, rounds };
}

/** the config the fixture's engine reads: the two areas, with a work branch each, and no checks */
export function writeFixtureConfig(dir: string): { repos: string; roles: string } {
  const repos = join(dir, "repos.yaml");
  const roles = join(dir, "roles.yaml");
  writeFileSync(repos, [
    "repos:",
    "  Demo/one:",
    "    name: one",
    "    upstream: /tmp/fixture-upstream-one",
    "    work: /tmp/fixture-work-one",
    "    public_base: main",
    "    work_base: main",
    "    remote: origin",
    "    copy: []",
    "    setup: []",
    "    checks: []",
    "  Demo/two:",
    "    name: two",
    "    upstream: /tmp/fixture-upstream-two",
    "    work: /tmp/fixture-work-two",
    "    public_base: main",
    "    work_base: main",
    "    remote: origin",
    "    copy: []",
    "    setup: []",
    "    checks: []",
    "",
  ].join("\n"), "utf8");
  writeFileSync(roles, "pipeline:\n  planner: { role: planner, concurrency: 3 }\n  executor: { role: executor, concurrency: 4 }\nroles:\n  planner: { model: model-a }\n  executor: { model: model-b }\n", "utf8");
  return { repos, roles };
}
