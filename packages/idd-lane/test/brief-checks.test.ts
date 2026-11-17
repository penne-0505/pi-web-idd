import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseRoles } from "../src/roles.ts";
import { parseSpec, renderBrief } from "../src/spec.ts";
import { laneDir, prepareLane } from "../src/runner.ts";
import { tmpDir } from "./helpers/tmp.ts";

const ENV_KEYS = ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_REPOS_FILE", "IDD_LANE_ROOT", "IDD_LANE_SCOPE"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const roots: string[] = [];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const CLAUDE = `roles:
  b:
    harness: claude
    model: opus
    tools: [read, bash]
    report: review
    require_clean: false
`;
const PI = `models:
  x-y:
    model: x/y
roles:
  b:
    model: x-y
    tools: [read, bash]
    report: review
    require_clean: false
`;

const specOf = (dir: string, checks: string) =>
  parseSpec(`role: b\nworktree: ${dir}\nstage: blind\nreport: r\n${checks}`, dir);

describe("a 5-minute run's brief lists the repo's checks to wrap (AC-008 / DEC-2605)", () => {
  const dir = tmpDir("idd-brief-checks-");
  const role = parseRoles(CLAUDE).roles.b;
  const spec = specOf(dir, "checks:\n  - { name: typecheck, command: \"SECRET_CMD\", timeout_minutes: 10 }\n  - { name: lint, command: \"OTHER_CMD\", timeout_minutes: 4 }\n");

  test("each check is listed by name with its limit, not by its command", () => {
    const brief = renderBrief(spec, role, { cacheTtl: "5m" });
    expect(brief).toContain("idd wait-run --check typecheck");
    expect(brief).toContain("idd wait-run --check lint");
    expect(brief).toContain('name="typecheck" timeout_minutes="10"');
    expect(brief).toContain('name="lint" timeout_minutes="4"');
    // the check command strings never travel into the brief: they stay in config/repos.yaml
    expect(brief).not.toContain("SECRET_CMD");
    expect(brief).not.toContain("OTHER_CMD");
  });

  test("the list says it is not an order to run everything, gives the wrapping forms, and says to put files back", () => {
    const brief = renderBrief(spec, role, { cacheTtl: "5m" });
    expect(brief).toContain("全部を回す指示ではない");
    expect(brief).toContain("回すときはこの形を使い");
    expect(brief).toContain("idd wait-run -- &lt;command&gt;");
    expect(brief).toContain("元へ戻す");
    // the host rule the reviewer keeps is still in the same brief
    expect(brief).toContain("主張に必要な範囲に絞って回す");
  });

  test("a repo with no checks gets no empty list", () => {
    const empty = renderBrief(specOf(dir, ""), role, { cacheTtl: "5m" });
    expect(empty).not.toContain("<checks>");
  });
});

describe("only a Claude Code run that holds the cache 5 minutes wraps its checks (AC-011 / DEC-2607 / INV-1844)", () => {
  const dir = tmpDir("idd-brief-checks2-");
  const checks = "checks:\n  - { name: typecheck, timeout_minutes: 10 }\n";
  const withChecks = specOf(dir, checks);
  const withoutChecks = specOf(dir, "");

  test("a 1-hour claude run keeps the brief it had before the checks were in the spec", () => {
    const role = parseRoles(CLAUDE).roles.b;
    const brief = renderBrief(withChecks, role, { cacheTtl: "1h" });
    expect(brief).not.toContain("<checks>");
    expect(brief).toBe(renderBrief(withoutChecks, role, { cacheTtl: "1h" }));
  });

  test("a pi run keeps the same brief whether the hold is 5 minutes or 1 hour", () => {
    const role = parseRoles(PI).roles.b;
    const a = renderBrief(withChecks, role, { cacheTtl: "5m" });
    const b = renderBrief(withChecks, role, { cacheTtl: "1h" });
    expect(a).not.toContain("<checks>");
    expect(a).toBe(b);
    expect(a).toBe(renderBrief(withoutChecks, role));
  });
});

describe("the lane's preparation builds the brief with the hold it resolved (AC-008)", () => {
  test("a claude 5-minute lane on a repo with checks gets the wrapped list in its written brief", () => {
    const root = tmpDir("idd-brief-prep-");
    roots.push(root);
    const wt = join(root, "wt"); mkdirSync(wt);
    execFileSync("git", ["init", "-q", wt]);
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: wt });
    const cfg = join(root, "cfg"); mkdirSync(cfg); writeFileSync(join(cfg, ".credentials.json"), "{}");
    writeFileSync(join(root, "roles.yaml"), [
      "defaults:",
      `  claude_config_dir: ${cfg}`,
      "  tool_timeout_minutes: off",
      "roles:",
      "  c:",
      "    harness: claude",
      "    model: opus",
      "    tools: [read, bash]",
      "    report: free",
      "    require_clean: false",
      "    cache_ttl: 5m",
    ].join("\n") + "\n");
    writeFileSync(join(root, "repos.yaml"), [
      "repos:",
      "  me/app:",
      `    upstream: ${wt}`,
      `    work: ${join(root, "work")}`,
      "    checks:",
      "      - { name: typecheck, command: \"true\", timeout_minutes: 10 }",
    ].join("\n") + "\n");
    mkdirSync(join(root, "fake-root"));
    Object.assign(process.env, {
      IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"),
      IDD_LANE_ROOT: join(root, "fake-root"), IDD_LANE_SCOPE: "off",
    });
    const specPath = join(root, "spec.yaml");
    writeFileSync(specPath, `role: c\nworktree: ${wt}\nstage: blind\nreport: ${join(root, "out", "report")}\nchecks:\n  - { name: typecheck, timeout_minutes: 10 }\ntask: t\n`);
    const { rec } = prepareLane(specPath, { dryRun: true });
    const brief = readFileSync(join(laneDir(rec.id), "brief.md"), "utf8");
    expect(rec.cache_ttl).toBe("5m");
    expect(brief).toContain("idd wait-run --check typecheck");
    expect(brief).toContain('timeout_minutes="10"');
    expect(brief).toContain("全部を回す指示ではない");
  });
});
