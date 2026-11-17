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

/** the CLI in its own process, on a state and a registry of its own; it never asks for a tick */
function idd(args: string[], repos = "repos: {}\n"): { code: number | null; out: string } {
  const state = mkdtempSync(join(tmpdir(), "idd-cli-sync-"));
  temps.push(state);
  writeFileSync(join(state, "repos.yaml"), repos);
  const r = spawnSync("bun", ["run", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, IDD_STATE_DIR: state, IDD_REPOS_FILE: join(state, "repos.yaml"), IDD_ROLES_FILE: join(state, "roles.yaml"), IDD_LANE_SCOPE: "off", IDD_AGENT_BASE_URL: "http://127.0.0.1:9" },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("the R2 commands", () => {
  test("are gone: `idd r2` and `idd r2-record` answer with the usage, as any unknown command does", () => {
    for (const args of [["r2", "--wt", "x", "--base", "a", "--head", "b"], ["r2-record", "IDD-404"]]) {
      const res = idd(args);
      expect(res.code).toBe(2);
      expect(res.out).toContain("usage:");
      expect(res.out).not.toContain("r2-record LANE");
    }
  });
});

describe("idd sync", () => {
  test("a repo that is not registered is named as missing, with the keys and short names there are", () => {
    const res = idd(["sync", "nope"], "repos:\n  penne-0505/waydroid_mpris:\n    name: waydroid_mpris\n    upstream: /nonexistent/u\n    work: /nonexistent/w\n");
    expect(res.code).toBe(1);
    expect(res.out).toContain('repo \\"nope\\" はありません');
    expect(res.out).toContain("penne-0505/waydroid_mpris（waydroid_mpris）");
  });
});
