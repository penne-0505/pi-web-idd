import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { executeLane, prepareLane } from "../src/runner.ts";
import { parseSpec, renderBrief, specInstructions } from "../src/spec.ts";
import type { RolePreset } from "../src/roles.ts";
import { readLedger } from "../../idd-core/src/instruction/ledger.ts";
import { tmpDir } from "./helpers/tmp.ts";

const ALL = { repos: "all", scenes: "all", places: "all" };

function writeInstructions(dir: string, instructions: { id: string; text: string; reason: string; scope: unknown }[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instructions.json"), JSON.stringify({
    version: 1,
    next: instructions.length + 1,
    instructions: instructions.map((i) => ({ ...i, created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z" })),
  }));
}

/** a worktree that is a git repo, a registry that names it as `me/app`, and an instruction dir of its own */
function fixture() {
  const root = tmpDir("idd-instruction-brief-");
  const wt = join(root, "wt");
  mkdirSync(wt);
  execFileSync("git", ["init", "-q", wt]);
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: wt });
  writeFileSync(join(root, "repos.yaml"), `repos:\n  me/app:\n    upstream: ${wt}\n    work: ${join(root, "work")}\n`);
  const instructions = join(root, "instructions");
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const saved = { ...process.env };
  Object.assign(process.env, { IDD_REPOS_FILE: join(root, "repos.yaml"), IDD_INSTRUCTIONS_DIR: instructions, IDD_STATE_DIR: state });
  const restore = () => {
    for (const k of ["IDD_REPOS_FILE", "IDD_INSTRUCTIONS_DIR", "IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_LANE_ROOT", "IDD_LANE_SCOPE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  };
  return { root, wt, instructions, state, restore };
}

const role = (): RolePreset => ({ name: "blind-reviewer", harness: "pi", model: "x/y", thinking: "off", tools: ["read"], policy: [], report: "review", budgetMinutes: 5, maxResumes: 0, requireClean: false } as unknown as RolePreset);

function specFor(wt: string, extra: string): ReturnType<typeof parseSpec> {
  mkdirSync(join(wt, "out"), { recursive: true });
  return parseSpec(`role: blind-reviewer\nworktree: ${wt}\nreport: ${join(wt, "out", "report")}\ntask: t\n${extra}\n`, wt);
}

describe("the review scene reaches every review brief, and only those", () => {
  test("a review-scene instruction is in the plan review, blind, last review, confirmation and device briefs, and not in the others", () => {
    const fx = fixture();
    try {
      writeInstructions(fx.instructions, [{ id: "INS-1", text: "レビューは blocker だけを挙げる。", reason: "嘘の指摘で巡が増えるから", scope: { repos: "all", scenes: ["review"], places: "all" } }]);
      const reviewStages: [string, string][] = [
        ["plan review", "inject_stage: plan_review"],
        ["blind", "stage: blind"],
        ["final", "stage: final"],
        ["confirm", "stage: confirm"],
        ["feedback confirm", "stage: feedback_confirm"],
        ["device", "stage: device"],
      ];
      for (const [name, line] of reviewStages) {
        const brief = renderBrief(specFor(fx.wt, line), role());
        expect(brief, name).toContain("<instructions>");
        expect(brief, name).toContain("レビューは blocker だけを挙げる。（理由: 嘘の指摘で巡が増えるから）");
      }
      for (const line of ["stage: triage", "stage: fix_plan", ""]) {
        expect(renderBrief(specFor(fx.wt, line), role()), line || "ad hoc").not.toContain("<instructions>");
      }
    } finally { fx.restore(); }
  });

  test("the repo range is read from the worktree's registered repo: another repo's instruction stays out", () => {
    const fx = fixture();
    try {
      writeInstructions(fx.instructions, [
        { id: "INS-1", text: "この repo のレビューは短く書く。", reason: "読まれないから", scope: { repos: ["me/app"], scenes: ["review"], places: "all" } },
        { id: "INS-2", text: "別の repo のレビューは長く書く。", reason: "別の事情", scope: { repos: ["me/other"], scenes: ["review"], places: "all" } },
        { id: "INS-3", text: "会話では丁寧に答える。", reason: "雑に読まれるから", scope: { repos: "all", scenes: ["chat"], places: ["conversation"] } },
      ]);
      const spec = specFor(fx.wt, "stage: blind");
      expect(specInstructions(spec).map((p) => p.id)).toEqual(["INS-1"]);
      const brief = renderBrief(spec, role());
      expect(brief).toContain("この repo のレビューは短く書く。");
      expect(brief).not.toContain("別の repo のレビューは長く書く。");
      expect(brief).not.toContain("会話では丁寧に答える。");
    } finally { fx.restore(); }
  });

  test("with no instruction file the brief is what it was", () => {
    const fx = fixture();
    try {
      const brief = renderBrief(specFor(fx.wt, "stage: blind"), role());
      expect(brief).not.toContain("<instructions>");
    } finally { fx.restore(); }
  });
});

/** the lane fixture the supervisor runs: a fake pi that writes its deliverable (or none at all, when the binary is missing) */
function laneFixture(piPresent: boolean) {
  const fx = fixture();
  const cfg = join(fx.root, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, ".credentials.json"), "{}");
  writeFileSync(join(fx.root, "roles.yaml"), `defaults:\n  claude_config_dir: ${cfg}\nmodels:\n  m:\n    model: x/y\nroles:\n  blind-reviewer:\n    model: m\n    tools: [read, bash]\n    report: review\n`);
  const agent = join(fx.root, "agent");
  mkdirSync(agent);
  const out = join(fx.root, "out");
  mkdirSync(out);
  const report = join(out, "report");
  const fakePi = join(fx.root, "pi");
  if (piPresent) {
    writeFileSync(fakePi, `#!/bin/sh\ncase "$*" in *--list-models*) exit 0 ;; esac\nSESS=""; SID=""\nwhile [ $# -gt 0 ]; do case "$1" in --session-dir) SESS="$2"; shift 2;; --session-id|--session) SID="$2"; shift 2;; *) shift;; esac; done\nmkdir -p "$SESS"; printf '%s\\n' '{"type":"message","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"ok"}]}}' > "$SESS/$SID.jsonl"\necho done > "${report}.md"; echo '{}' > "${report}.json"\nexit 0\n`);
    chmodSync(fakePi, 0o755);
  }
  const noRoot = join(fx.root, "no-lane-root");
  mkdirSync(noRoot);
  Object.assign(process.env, {
    IDD_ROLES_FILE: join(fx.root, "roles.yaml"), IDD_LANE_ROOT: noRoot, IDD_LANE_SCOPE: "off",
    IDD_PI_BIN: fakePi, IDD_PI_USER_AGENT_DIR: agent,
  });
  const specPath = join(fx.root, "spec.yaml");
  writeFileSync(specPath, `role: blind-reviewer\nworktree: ${fx.wt}\nreport: ${report}\ntask: t\nstage: blind\nlane: IDD-9\n`);
  writeInstructions(fx.instructions, [{ id: "INS-1", text: "レビューは blocker だけを挙げる。", reason: "嘘の指摘で巡が増えるから", scope: ALL }]);
  return { ...fx, specPath };
}

describe("the ledger of a run's instructions", () => {
  test("a run that started writes its lines (text, scope, lane, stage, time); preparing the brief alone writes none", async () => {
    const fx = laneFixture(true);
    try {
      const { rec } = prepareLane(fx.specPath);
      // the brief is built and the lane is prepared: nothing has started, so the ledger is still empty
      expect(readLedger()).toEqual([]);
      expect(readFileSync(join(fx.state, "lanes", rec.id, "brief.md"), "utf8")).toContain("レビューは blocker だけを挙げる。");
      const done = await executeLane(rec.id);
      expect(done.status).toBe("done");
      const lines = readLedger({ lane: "IDD-9" });
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatchObject({ instruction: "INS-1", text: "レビューは blocker だけを挙げる。", reason: "嘘の指摘で巡が増えるから", via: "scope", scope: ALL });
      expect(lines[0].to).toMatchObject({ kind: "lane", stage: "blind", scene: "review", lane: "IDD-9", run: rec.id });
      expect(Number.isNaN(Date.parse(lines[0].at))).toBe(false);
    } finally { fx.restore(); }
  });

  test("an instruction approved after the lane was prepared reaches the run that starts then, in its brief and its ledger line", async () => {
    const fx = laneFixture(true);
    try {
      const { rec } = prepareLane(fx.specPath);
      writeInstructions(fx.instructions, [
        { id: "INS-1", text: "レビューは blocker だけを挙げる。", reason: "嘘の指摘で巡が増えるから", scope: ALL },
        { id: "INS-2", text: "指摘には直し方を添える。", reason: "実装役が迷うから", scope: ALL },
      ]);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("done");
      expect(readFileSync(join(fx.state, "lanes", rec.id, "brief.md"), "utf8")).toContain("指摘には直し方を添える。");
      expect(readLedger({ lane: "IDD-9" }).map((l) => l.instruction)).toEqual(["INS-1", "INS-2"]);
    } finally { fx.restore(); }
  });

  test("an instruction retired after the lane was prepared does not reach the run", async () => {
    const fx = laneFixture(true);
    try {
      const { rec } = prepareLane(fx.specPath);
      writeInstructions(fx.instructions, []);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("done");
      expect(readFileSync(join(fx.state, "lanes", rec.id, "brief.md"), "utf8")).not.toContain("レビューは blocker だけを挙げる。");
      expect(readLedger()).toEqual([]);
    } finally { fx.restore(); }
  });

  test("a run whose harness could not be started leaves no line", async () => {
    const fx = laneFixture(false);
    try {
      const { rec } = prepareLane(fx.specPath);
      const done = await executeLane(rec.id);
      expect(done.status).toBe("failed");
      expect(done.spawn_error).toBeTruthy();
      expect(readLedger()).toEqual([]);
      expect(existsSync(join(fx.state, "instruction-ledger.jsonl"))).toBe(false);
    } finally { fx.restore(); }
  });
});
