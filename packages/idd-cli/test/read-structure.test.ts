import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLandRound, type LandRoundRecord } from "../../idd-core/src/overlay/land-run.ts";
import { formatStructure, runReadCommand, structureRounds } from "../src/read-commands.ts";

/** one landing round of a lane; `dup` is the mainline's duplicate count and the merge commit carries one more */
function round(id: string, lane: string, endedAt: string, mainTip: string, dup: number | null): LandRoundRecord {
  const base = {
    id, lane, status: "done" as const, started_at: endedAt, ended_at: endedAt, wall_seconds: 1,
    head: "h", mainTip, mergeCommit: `${mainTip}m`, signed: false, repo: "/r", checks: [], blocking: 0,
  };
  if (dup === null) return base;
  const counts = (n: number) => ({ "duplicate-tokens": n, "large-files": 4 });
  return { ...base, structure: { at: mainTip, source: "mainline", blocking: ["duplicate-tokens"], mainline: counts(dup), merged: counts(dup + 1) } };
}

/** the stdout of `idd read structure` with the given args, over rounds written into a state of its own */
async function readWith(rounds: LandRoundRecord[], args: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "idd-structure-"));
  const saved = process.env.IDD_STATE_DIR;
  process.env.IDD_STATE_DIR = dir;
  const out: string[] = [];
  try {
    for (const r of rounds) appendLandRound(r);
    await runReadCommand(["structure", ...args], { stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
    return out.join("");
  } finally {
    if (saved === undefined) delete process.env.IDD_STATE_DIR;
    else process.env.IDD_STATE_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

const ROUNDS = [
  round("r2", "IDD-2", "2026-10-27T12:00:00Z", "bbbbbbb1", 11),
  round("r1", "IDD-1", "2026-10-27T10:00:00Z", "aaaaaaa1", 10),
  round("r3", "IDD-1", "2026-10-27T13:00:00Z", "ccccccc1", null),
];

test("AC-006: the rounds that measured are listed in the order they ended, each with the tip it was compared at", async () => {
  const [head, ...rest] = (await readWith(ROUNDS, [])).trim().split("\n");
  expect(head).toContain("2 回");
  expect(rest.map((l) => l.slice(l.indexOf("IDD-")))).toEqual([
    "IDD-1 本流 aaaaaaa merge aaaaaaa: *duplicate-tokens 10→11 / large-files 4→4",
    "IDD-2 本流 bbbbbbb merge bbbbbbb: *duplicate-tokens 11→12 / large-files 4→4",
  ]);
});

test("AC-006: one lane's rounds come out as JSON with both sides, and a lane without any says so", async () => {
  const rows = JSON.parse(await readWith(ROUNDS, ["--lane", "IDD-2", "--json"])) as Array<{ lane: string; mainTip: string; mainline: Record<string, number>; merged: Record<string, number> }>;
  expect(rows.map((r) => [r.lane, r.mainTip, r.mainline["duplicate-tokens"], r.merged["duplicate-tokens"]])).toEqual([["IDD-2", "bbbbbbb1", 11, 12]]);
  expect(await readWith(ROUNDS, ["--lane", "IDD-9"])).toContain("IDD-9 の構造の数の記録はありません");
});

test("a round that could not count says so beside the counts it has", () => {
  const failed = round("r4", "IDD-3", "2026-10-27T14:00:00Z", "ddddddd1", 5);
  failed.structure!.merged = {};
  failed.structure!.failure = "取り込む側の数を測れませんでした:\nexit 3";
  const [line] = formatStructure(structureRounds([failed])).slice(1);
  expect(line).toContain("duplicate-tokens 5→?");
  expect(line).toContain("測れない数があります: 取り込む側の数を測れませんでした:");
});
