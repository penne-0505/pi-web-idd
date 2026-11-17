import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { executeLane, prepareLane, readLane } from "../src/runner.ts";
import { tmpDir } from "./helpers/tmp.ts";

const piRole = (extra = "") => `    model: m\n    tools: [read, bash]\n    report: review\n${extra}`;
const claudeRole = (extra = "") => `    harness: claude\n    model: opus\n    tools: [read, bash]\n    report: review\n${extra}`;

const usage = (n: string) => `echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"x"}],"usage":{"input":5,"output":7,"cost":${n}}}}'`;
const sessionOk = `mkdir -p "$SESS"; printf '%s\\n' '{"type":"message","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"ok"}]}}' > "$SESS/$SID.jsonl"`;
const sessionError = (why: string) => `mkdir -p "$SESS"; printf '%s\\n' '{"type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"${why}"}}' > "$SESS/$SID.jsonl"`;
const writeReport = `mkdir -p "@OUT@"; echo done > "@REPORT@.md"; echo '{}' > "@REPORT@.json"`;

/**
 * A lane whose two attempts differ only in what the fake pi does: `first` runs on the first invocation, and
 * the test replaces the `@LATER@` placeholder with what every later invocation does. The worktree is a fresh repo.
 */
function fixture(roles: string, first: string) {
  const root = tmpDir("idd-attempts-");
  const cfg = join(root, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, ".credentials.json"), "{}");
  const wt = join(root, "wt");
  mkdirSync(wt);
  execFileSync("git", ["init", "-q", wt]);
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: wt });
  writeFileSync(join(root, "roles.yaml"), `defaults:\n  claude_config_dir: ${cfg}\nmodels:\n  m:\n    model: x/y\n  z:\n    model: x/z\n${roles}`);
  writeFileSync(join(root, "repos.yaml"), "repos:\n");
  const agent = join(root, "agent");
  mkdirSync(agent);
  const noRoot = join(root, "no-lane-root");
  mkdirSync(noRoot);
  const out = join(root, "out");
  mkdirSync(out);
  const report = join(out, "report");
  const counter = join(root, "counter");
  const envlog = join(root, "env.log");
  const shell = (body: string) => `#!/bin/sh
case "$*" in *--list-models*) exit 0 ;; esac
SESS=""; SID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-dir) SESS="$2"; shift 2;;
    --session-id) SID="$2"; shift 2;;
    --session) SID="$2"; shift 2;;
    *) shift;;
  esac
done
N=$(cat "${counter}" 2>/dev/null || echo 0); N=$((N+1)); echo "$N" > "${counter}"
echo "PI_COUNT=$N" >> "${envlog}"
echo "PI_AGENT_DIR=\${PI_CODING_AGENT_DIR:-none}" >> "${envlog}"
echo "ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY:-none}" >> "${envlog}"
if [ "$N" = "1" ]; then
${body}
fi
@LATER@
`;
  const fakePi = join(root, "pi");
  writeFileSync(fakePi, shell(first).replaceAll("@OUT@", out).replaceAll("@REPORT@", report));
  chmodSync(fakePi, 0o755);
  const fakeClaude = join(root, "claude");
  const claudeEnvLog = join(root, "claude-env.log");
  writeFileSync(fakeClaude, `#!/bin/sh
echo "CLAUDE_CONFIG_DIR=\${CLAUDE_CONFIG_DIR:-none}" >> "${claudeEnvLog}"
echo "ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY:-none}" >> "${claudeEnvLog}"
echo "BASH_MAX_TIMEOUT_MS=\${BASH_MAX_TIMEOUT_MS:-none}" >> "${claudeEnvLog}"
echo "FORCE_PROMPT_CACHING_5M=\${FORCE_PROMPT_CACHING_5M:-none}" >> "${claudeEnvLog}"
${writeReport.replaceAll("@OUT@", out).replaceAll("@REPORT@", report)}
exit 0
`);
  chmodSync(fakeClaude, 0o755);
  Object.assign(process.env, {
    IDD_STATE_DIR: join(root, "state"), IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"),
    IDD_LANE_ROOT: noRoot, IDD_LANE_SCOPE: "off", IDD_PI_BIN: fakePi, IDD_PI_USER_AGENT_DIR: agent, IDD_CLAUDE_BIN: fakeClaude,
  });
  const specPath = join(root, "spec.yaml");
  writeFileSync(specPath, `role: deep\nworktree: ${wt}\nreport: ${report}\ntask: t\n`);
  return { root, wt, cfg, report, specPath, envlog, claudeEnvLog, reportCmd: writeReport.replaceAll("@OUT@", out).replaceAll("@REPORT@", report) };
}

const clearEnv = () => { for (const k of ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_REPOS_FILE", "IDD_LANE_ROOT", "IDD_LANE_SCOPE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR", "IDD_CLAUDE_BIN"]) delete process.env[k]; };

// the second attempt runs whenever the first did not, and each attempt's own body decides its exit

describe("a run that fails mid-way moves to the next candidate", () => {
  test("a provider fault moves the run to the fallback, which finishes it under the same id", async () => {
    const roles = `roles:\n  deep:\n${piRole("    fallback: api\n")}  api:\n    model: z\n    tools: [read, bash]\n    report: review\n`;
    const fx = fixture(roles, `${usage("0.10")}\n${sessionError("upstream provider blew up")}\nexit 1`);
    try {
      const later = `if [ "$N" != "1" ]; then ${usage("0.03")}; ${sessionOk}; ${fx.reportCmd}; exit 0; fi`;
      writeFileSync(join(fx.root, "pi"), readFileSync(join(fx.root, "pi"), "utf8").replace("@LATER@", later));
      const { rec } = prepareLane(fx.specPath);
      expect(rec.role).toBe("deep");
      expect(rec.pending?.map((c) => c.role.name)).toEqual(["api"]);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("done");
      expect(done.role).toBe("api");
      expect(done.model).toBe("x/z");
      expect(done.attempts?.map((a) => [a.role, a.status, a.failure ?? null, a.usage?.cost ?? null])).toEqual([
        ["deep", "failed", "provider", 0.1],
        ["api", "done", null, 0.03],
      ]);
      // the run's cost is the sum of its attempts, and the session points at the last one
      expect(done.usage?.cost).toBeCloseTo(0.13, 6);
      expect(done.session_file).toMatch(/\/session\//);
      expect(existsSync(join(fx.root, "state", "lanes", done.id, "events-1.jsonl"))).toBe(true);
      expect(done.fallbacks?.[0]).toMatchObject({ role: "deep", fallback: "api", kind: "provider" });
      // one consumption row per attempt, and their sum is exactly the run's cost
      const rows = readFileSync(join(fx.root, "state", "pipeline", "consumption.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(rows.map((r) => [r.unit, r.role, r.failure ?? null, r.cost])).toEqual([["attempt", "deep", "provider", 0.1], ["attempt", "api", null, 0.03]]);
      expect(rows.reduce((a, r) => a + r.cost, 0)).toBeCloseTo(done.usage.cost, 6);
    } finally { clearEnv(); }
  });

  test("a require_clean attempt that rewrote an untracked record is not followed by the fallback", async () => {
    const roles = `roles:\n  deep:\n${piRole("    fallback: api\n    require_clean: true\n")}  api:\n    model: z\n    tools: [read, bash]\n    report: review\n`;
    const fx = fixture(roles, `echo changed > record.md\n${sessionError("upstream provider blew up")}\nexit 1`);
    try {
      const later = `if [ "$N" != "1" ]; then ${sessionOk}; ${fx.reportCmd}; exit 0; fi`;
      writeFileSync(join(fx.root, "pi"), readFileSync(join(fx.root, "pi"), "utf8").replace("@LATER@", later));
      // `git status` reads the same before and after this rewrite, so only the content check can see it
      writeFileSync(join(fx.wt, "record.md"), "an uncommitted record\n");
      const { rec } = prepareLane(fx.specPath);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("failed");
      expect(done.role).toBe("deep");
      expect(done.fallbacks).toBeUndefined();
      expect(done.attempts?.map((a) => a.role)).toEqual(["deep"]);
      expect(done.error).toContain("未追跡ファイルの一覧か中身");
      expect(done.error).toContain("次の候補へ進まない");
    } finally { clearEnv(); }
  });

  test("an attempt that wrote its deliverable stays done even when the last reply ended in a provider error", async () => {
    const roles = `roles:\n  deep:\n${piRole("    fallback: api\n")}  api:\n    model: z\n    tools: [read, bash]\n    report: review\n`;
    const fx = fixture(roles, `${usage("0.10")}\n${writeReport}\n${sessionError("upstream provider blew up")}\nexit 0`);
    try {
      const later = `if [ "$N" != "1" ]; then ${fx.reportCmd}; exit 0; fi`;
      writeFileSync(join(fx.root, "pi"), readFileSync(join(fx.root, "pi"), "utf8").replace("@LATER@", later));
      const { rec } = prepareLane(fx.specPath);
      const done = await executeLane(rec.id);
      // the deliverable is complete, so the last reply's provider error is not a failure of the attempt
      expect(done.status).toBe("done");
      expect(done.role).toBe("deep");
      expect(done.attempts?.map((a) => [a.role, a.status, a.failure ?? null])).toEqual([["deep", "done", null]]);
      expect(done.fallbacks).toBeUndefined();
      // no second attempt ran, and the finished deliverable was not moved aside
      expect(existsSync(`${fx.report}.md`)).toBe(true);
      expect(existsSync(`${fx.report}.attempt-1.md`)).toBe(false);
      const rows = readFileSync(join(fx.root, "state", "pipeline", "consumption.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(rows.map((r) => [r.unit, r.status, r.failure ?? null])).toEqual([["attempt", "done", null]]);
    } finally { clearEnv(); }
  });

  test("the next attempt runs on its own candidate's budget, not the one before it", async () => {
    const roles = `roles:\n  deep:\n${piRole("    fallback: api\n    budget_minutes: 3\n")}  api:\n    model: z\n    tools: [read, bash]\n    report: review\n    budget_minutes: 7\n`;
    const fx = fixture(roles, `${usage("0.10")}\n${sessionError("upstream provider blew up")}\nexit 1`);
    try {
      const later = `if [ "$N" != "1" ]; then ${usage("0.03")}; ${sessionOk}; ${fx.reportCmd}; exit 0; fi`;
      writeFileSync(join(fx.root, "pi"), readFileSync(join(fx.root, "pi"), "utf8").replace("@LATER@", later));
      const { rec } = prepareLane(fx.specPath);
      expect(rec.budget_minutes).toBe(3);
      const done = await executeLane(rec.id);
      expect(done.role).toBe("api");
      expect(done.budget_minutes).toBe(7);
    } finally { clearEnv(); }
  });

  test("an API balance that ran out (402) is read as a quota fault", async () => {
    const roles = `roles:\n  deep:\n${piRole("    fallback: api\n")}  api:\n    model: z\n    tools: [read, bash]\n    report: review\n`;
    const fx = fixture(roles, `${usage("0.10")}\n${sessionError("HTTP 402 payment required: insufficient_quota")}\nexit 1`);
    try {
      const later = `if [ "$N" != "1" ]; then ${fx.reportCmd}; exit 0; fi`;
      writeFileSync(join(fx.root, "pi"), readFileSync(join(fx.root, "pi"), "utf8").replace("@LATER@", later));
      const { rec } = prepareLane(fx.specPath);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("done");
      expect(done.attempts?.[0].failure).toBe("quota");
      expect(done.fallbacks?.[0].kind).toBe("quota");
    } finally { clearEnv(); }
  });

  test("a failure kind the role does not allow, and a run that may not change roles, end the run", async () => {
    const roles = `roles:\n  deep:\n${piRole("    fallback: api\n    fallback_on: [quota]\n")}  api:\n    model: z\n    tools: [read, bash]\n    report: review\n`;
    const fx = fixture(roles, `${usage("0.10")}\n${sessionError("upstream provider blew up")}\nexit 1`);
    try {
      const later = `if [ "$N" != "1" ]; then ${fx.reportCmd}; exit 0; fi`;
      writeFileSync(join(fx.root, "pi"), readFileSync(join(fx.root, "pi"), "utf8").replace("@LATER@", later));
      const { rec } = prepareLane(fx.specPath);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("failed");
      expect(done.attempts?.length).toBe(1);
      expect(done.fallbacks).toBeUndefined();
    } finally { clearEnv(); }

    const roles2 = `roles:\n  deep:\n${piRole("    fallback: api\n")}  api:\n    model: z\n    tools: [read, bash]\n    report: review\n`;
    const fx2 = fixture(roles2, `${usage("0.10")}\n${sessionError("upstream provider blew up")}\nexit 1`);
    try {
      const later = `if [ "$N" != "1" ]; then ${fx2.reportCmd}; exit 0; fi`;
      writeFileSync(join(fx2.root, "pi"), readFileSync(join(fx2.root, "pi"), "utf8").replace("@LATER@", later));
      const { rec } = prepareLane(fx2.specPath, { noFallback: true });
      const done = await executeLane(rec.id);
      expect(done.status).toBe("failed");
      expect(done.attempts?.length).toBe(1);
      expect(done.no_fallback).toBe(true);
    } finally { clearEnv(); }
  });

  test("an attempt that changed the worktree is not built on: the run ends where it failed", async () => {
    const roles = `roles:\n  deep:\n${piRole("    fallback: api\n")}  api:\n    model: z\n    tools: [read, bash]\n    report: review\n`;
    const fx = fixture(roles, `${usage("0.10")}\necho half-written > "$(pwd)/half.txt"\n${sessionError("upstream provider blew up")}\nexit 1`);
    try {
      const later = `if [ "$N" != "1" ]; then ${fx.reportCmd}; exit 0; fi`;
      writeFileSync(join(fx.root, "pi"), readFileSync(join(fx.root, "pi"), "utf8").replace("@LATER@", later));
      const { rec } = prepareLane(fx.specPath);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("failed");
      expect(done.attempts?.length).toBe(1);
      expect(done.error).toMatch(/worktree を変えたので次の候補へ進まない/);
    } finally { clearEnv(); }
  });

  test("a leftover deliverable of the failed attempt does not make the next attempt done, and is kept", async () => {
    const roles = `roles:\n  deep:\n${piRole("    fallback: api\n")}  api:\n    model: z\n    tools: [read, bash]\n    report: review\n`;
    const fx = fixture(roles, `${writeReport}\n${sessionError("upstream provider blew up")}\nexit 1`);
    try {
      // the second attempt exits 0 without writing anything: it must not read as done
      const later = `if [ "$N" != "1" ]; then exit 0; fi`;
      writeFileSync(join(fx.root, "pi"), readFileSync(join(fx.root, "pi"), "utf8").replace("@LATER@", later));
      const { rec } = prepareLane(fx.specPath);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("failed");
      expect(done.error).toMatch(/成果物なし/);
      expect(existsSync(`${fx.report}.attempt-1.md`)).toBe(true);
      expect(existsSync(`${fx.report}.attempt-1.json`)).toBe(true);
      expect(existsSync(`${fx.report}.md`)).toBe(false);
    } finally { clearEnv(); }
  });

  test("a consumption row that cannot be written is noted and the run still ends on its deliverable", async () => {
    const roles = `roles:\n  deep:\n${piRole()}`;
    const fx = fixture(roles, `${usage("0.10")}\n${sessionOk}\n${writeReport}\nexit 0`);
    try {
      // a directory stands where the append-only record's file would be, so every row write fails
      mkdirSync(join(fx.root, "state", "pipeline", "consumption.jsonl"), { recursive: true });
      const { rec } = prepareLane(fx.specPath);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("done");
      expect(existsSync(`${fx.report}.md`)).toBe(true);
      expect(readFileSync(join(fx.root, "state", "lanes", done.id, "supervisor.log"), "utf8")).toContain("試行の行を書けませんでした");
    } finally { clearEnv(); }
  });

  test("a Claude candidate runs in the lane's own config dir without the API key, with its own limits", async () => {
    const roles = `roles:\n  deep:\n${piRole("    fallback: c\n")}  c:\n${claudeRole()}`;
    const fx = fixture(roles, `${sessionError("upstream provider blew up")}\nexit 1`);
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "must-not-reach";
    try {
      const later = `if [ "$N" != "1" ]; then exit 1; fi`;
      writeFileSync(join(fx.root, "pi"), readFileSync(join(fx.root, "pi"), "utf8").replace("@LATER@", later));
      const { rec } = prepareLane(fx.specPath);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("done");
      expect(done.role).toBe("c");
      const piLog = readFileSync(fx.envlog, "utf8");
      expect(piLog).toContain(`PI_AGENT_DIR=` + join(fx.root, "state", "lanes", rec.id, "agent"));
      const claudeLog = readFileSync(fx.claudeEnvLog, "utf8");
      expect(claudeLog).toContain(`CLAUDE_CONFIG_DIR=${fx.cfg}`);
      expect(claudeLog).toMatch(/ANTHROPIC_API_KEY=none/);
      expect(claudeLog).toMatch(/BASH_MAX_TIMEOUT_MS=\d+/);
      expect(claudeLog).toMatch(/FORCE_PROMPT_CACHING_5M=1/);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
      clearEnv();
    }
  });
});

describe("a lane that never switches keeps its one attempt", () => {
  test("a provider failure with no fallback ends the run as it did before", async () => {
    const roles = `roles:\n  deep:\n${piRole()}`;
    const fx = fixture(roles, `${usage("0.10")}\n${sessionError("upstream provider blew up")}\nexit 1`);
    try {
      const { rec } = prepareLane(fx.specPath);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("failed");
      expect(done.attempts?.length).toBe(1);
      expect(done.attempts?.[0].failure).toBe("provider");
      expect(readLane(done.id).status).toBe("failed");
    } finally { clearEnv(); }
  });
});
