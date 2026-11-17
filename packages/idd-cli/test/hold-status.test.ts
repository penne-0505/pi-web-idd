import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../bin/idd.ts");

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** a lane with one push held at 01:00:00.500 UTC and the given lifecycle rows, read back through `idd hold status` */
function statusOf(events: { event: string; at: string }[], laneEnv: Record<string, string> = { IDD_ID: "IDD-1" }): { state: string; detail: string } {
  const state = mkdtempSync(join(tmpdir(), "idd-cli-hold-status-"));
  temps.push(state);
  writeFileSync(join(state, "boundary-holds.jsonl"), `${JSON.stringify({ id: "h1", idd_id: "IDD-1", kind: "push", at: "2026-10-27T01:00:00.500Z" })}\n`);
  const rows = [
    { event: "s1_go", at: "2026-10-27T09:00:00+09:00" },
    { event: "s2_start", at: "2026-10-27T09:01:00+09:00" },
    ...events,
  ];
  writeFileSync(join(state, "lifecycle-demo.jsonl"), rows.map((r) => JSON.stringify({ ...r, idd_id: "IDD-1", attrs: {} })).join("\n") + "\n");
  const r = spawnSync("bun", ["run", CLI, "hold", "status"], {
    encoding: "utf8",
    env: { ...process.env, IDD_STATE_DIR: state, IDD_ID: "", IDD_RUN_LANE: "", ...laneEnv, IDD_LANE_SCOPE: "off" },
  });
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { holds: { state: string; detail: string }[] }).holds[0]!;
}

describe("idd hold status", () => {
  // 09:30+09:00 is 00:30Z, before the hold; compared as text it reads after "01:00" and would look like the push
  test("a push event from before the hold, written with an offset, is not the hold's completion", () => {
    const hold = statusOf([{ event: "s4_pushed", at: "2026-10-27T09:30:00+09:00" }]);
    expect(hold.state).not.toBe("done");
  });

  test("a push event after the hold, in any offset, is its completion", () => {
    const hold = statusOf([{ event: "s4_pushed", at: "2026-10-27T10:05:00+09:00" }]);
    expect(hold.state).toBe("done");
  });

  test("a stage run, which has IDD_RUN_LANE and no IDD_ID, reads its own lane's holds", () => {
    const hold = statusOf([{ event: "s4_pushed", at: "2026-10-27T10:05:00+09:00" }], { IDD_RUN_LANE: "IDD-1" });
    expect(hold.state).toBe("done");
  });
});
