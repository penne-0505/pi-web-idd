// Counts the prompt-cache rewrites of the Claude Code runs in the lane state, by role and cache hold.
// usage: bun packages/idd-lane/bin/cache-rewrites.ts [LANE_STATE_DIR]
// A rewrite is a request from the second on that read less than half of what the request before it had written;
// the earlier definition (a read below half of the request's context) is printed beside it. The same message is
// written to several lines of a stream, so a request is counted once by its message id.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { cacheReport, claudeRequests, orderedTurnFiles, type CacheRunInput } from "../src/cache-rewrites.ts";
import { laneStateDir } from "../src/paths.ts";
import type { CacheTtl } from "../src/roles.ts";
import { cacheTtlOf, type LaneRecord } from "../src/runner.ts";

function linesOf(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim()) : [];
}

/** a lane's requests: a run's events.jsonl, or a conversation's replies read turn by turn */
function requestsOf(dir: string, rec: LaneRecord): string[] {
  if (rec.mode === "conversation") {
    const turns = join(dir, "turns");
    if (!existsSync(turns)) return [];
    return orderedTurnFiles(readdirSync(turns)).flatMap((f) => linesOf(join(turns, f)));
  }
  return linesOf(join(dir, "events.jsonl"));
}

function ttlOf(rec: LaneRecord): CacheTtl {
  try { return cacheTtlOf(rec); } catch { return rec.cache_ttl ?? (rec.mode === "conversation" ? "1h" : "5m"); }
}

function main(): number {
  const root = process.argv[2] ?? laneStateDir();
  if (!existsSync(root)) {
    process.stderr.write(`lane の state がありません: ${root}\n`);
    return 2;
  }
  const runs: CacheRunInput[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const p = join(dir, "lane.json");
    if (!existsSync(p)) continue;
    let rec: LaneRecord;
    try { rec = JSON.parse(readFileSync(p, "utf8")) as LaneRecord; } catch { continue; }
    if (rec.role_preset?.harness !== "claude") continue;
    runs.push({ role: rec.role ?? "(role なし)", ttl: ttlOf(rec), requests: claudeRequests(requestsOf(dir, rec)) });
  }
  const rows = cacheReport(runs);
  const total = rows.reduce((a, r) => ({ runs: a.runs + r.runs, requests: a.requests + r.requests, rewrites: a.rewrites + r.rewrites, rewriteTokens: a.rewriteTokens + r.rewriteTokens, overGap: a.overGap + r.overGap, contextRewrites: a.contextRewrites + r.contextRewrites, writeTokens: a.writeTokens + r.writeTokens }), { runs: 0, requests: 0, rewrites: 0, rewriteTokens: 0, overGap: 0, contextRewrites: 0, writeTokens: 0 });
  process.stdout.write(`# ${root} の Claude Code の run（role と保持ごと）\n`);
  process.stdout.write("role\tttl\truns\trequests\trewrites\trewrite_tokens\tover_5min\tcontext_rewrites\twrite_tokens\n");
  for (const r of rows) {
    process.stdout.write(`${r.role}\t${r.ttl}\t${r.runs}\t${r.requests}\t${r.rewrites}\t${r.rewriteTokens}\t${r.overGap}\t${r.contextRewrites}\t${r.writeTokens}\n`);
  }
  process.stdout.write(`合計\t-\t${total.runs}\t${total.requests}\t${total.rewrites}\t${total.rewriteTokens}\t${total.overGap}\t${total.contextRewrites}\t${total.writeTokens}\n`);
  process.stdout.write("rewrites: 2 回目以降の要求で、前の要求が cache に載せた分の半分未満しか読めていないもの。over_5min: 要求の間が 5 分を超えた回数。context_rewrites: cache_read が要求の文脈の半分未満（TODO の定義）。\n");
  return 0;
}

process.exit(main());
