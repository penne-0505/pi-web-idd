import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = join(import.meta.dir, "../bin/idd.ts");

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...a], { cwd, encoding: "utf8" }).trim();

/**
 * A state of two lanes that both have a worktree. IDD-1 is at the submit stage (its card would show);
 * IDD-2 is at S3 with a submit view but no submit stage (its card would not show).
 */
function setupState(): { state: string; ghLog: string } {
  const state = mkdtempSync(join(tmpdir(), "idd-cli-outbound-"));
  temps.push(state);
  const wt = mkdtempSync(join(tmpdir(), "idd-cli-outbound-wt-"));
  temps.push(wt);
  git(wt, "init", "-q", "-b", "main");
  writeFileSync(join(wt, "a.txt"), "a\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "chore: base");

  writeFileSync(join(state, "repos.yaml"), "repos:\n  demo:\n    github: test/project\n    upstream: /nonexistent/up\n    work: /nonexistent/work\n    public_base: main\n");
  writeFileSync(join(state, "backlog.jsonl"), [
    { idd_id: "IDD-1", area: "demo", title: "feat: submit" },
    { idd_id: "IDD-2", area: "demo", title: "feat: s3" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(state, "executor-sessions.jsonl"), [
    { idd_id: "IDD-1", worktree_path: wt, branch: "idd/IDD-1", executor_session_id: "s1" },
    { idd_id: "IDD-2", worktree_path: wt, branch: "idd/IDD-2", executor_session_id: "s2" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const at = new Date().toISOString();
  const events: [string, string][] = [
    ["IDD-1", "s1_go"], ["IDD-1", "s2_start"], ["IDD-1", "s2_result"], ["IDD-1", "s3_ready"], ["IDD-1", "s3_ok"], ["IDD-1", "s4_submit_started"],
    ["IDD-2", "s1_go"], ["IDD-2", "s2_start"], ["IDD-2", "s2_result"], ["IDD-2", "s3_ready"], ["IDD-2", "s3_ok"],
  ];
  writeFileSync(join(state, "lifecycle-demo.jsonl"), events.map(([idd_id, event]) => JSON.stringify({ event, idd_id, at, attrs: {} })).join("\n") + "\n");

  // a gh that records every call: export and ship must not call it at all
  const ghLog = join(state, "gh.log");
  const gh = join(state, "gh");
  writeFileSync(gh, `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(ghLog)}, process.argv.slice(2).join(" ") + "\\n");\n`, { mode: 0o755 });
  chmodSync(gh, 0o755);
  return { state, ghLog };
}

/** the CLI in its own process, on this state; the gh logger is on PATH through IDD_GH_BIN */
function idd(args: string[], state: string, gh: string, extraEnv: Record<string, string> = {}): { code: number | null; out: string; err: string } {
  const r = spawnSync("bun", ["run", CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      IDD_STATE_DIR: state,
      IDD_REPOS_FILE: join(state, "repos.yaml"),
      IDD_GH_BIN: gh,
      IDD_AGENT_BASE_URL: "http://127.0.0.1:30142",
      IDD_LANE_SCOPE: "off",
      ...extraEnv,
    },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("idd export / idd ship / idd local-complete", () => {
  test("return the submit card's URL, do nothing, and call no gh", () => {
    const { state, ghLog } = setupState();
    const gh = join(state, "gh");
    for (const command of ["export", "ship", "local-complete"]) {
      const res = idd(command === "local-complete" ? [command, "IDD-1", "token"] : [command, "IDD-1"], state, gh);
      expect(res.code).toBe(1);
      const body = JSON.parse(res.out) as { ok: boolean; url: string; card?: string; error: string };
      expect(body.ok).toBe(false);
      expect(body.url).toContain("view=inbox");
      expect(body.url).toContain("card=IDD-1");
      expect(body.card).toBe("IDD-1");
      if (command === "local-complete") expect(body.error).toContain("ローカル完了");
    }
    expect(existsSync(ghLog)).toBe(false);
  });

  test("name no card while the lane is not at the submit stage, and say so", () => {
    const { state, ghLog } = setupState();
    const gh = join(state, "gh");
    const res = idd(["export", "IDD-2"], state, gh);
    expect(res.code).toBe(1);
    const body = JSON.parse(res.out) as { ok: boolean; url: string; card?: string; note?: string };
    expect(body.ok).toBe(false);
    expect(body.url).toContain("view=inbox");
    expect(body.url).not.toContain("card=");
    expect(body.card).toBeUndefined();
    expect(body.note).toContain("カードはまだありません");
    expect(existsSync(ghLog)).toBe(false);
  });
});

/** the names that write out of the machine; the CLI source must neither import nor call them */
const OUTWARD_WRITERS = [
  "postReview", "editPrText", "replyToThread", "commentOnPr", "approveOutbound", "postOutboundNow",
  "runShip", "exportLane", "exportUnderWorkLock", "completeLocal", "approveLand",
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

describe("the CLI source does not write out of the machine", () => {
  test("no call and no import of the outward writers, aliases included", () => {
    const root = resolve(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const file of walk(root)) {
      if (!/\.(ts|tsx)$/.test(file) || /\.test\./.test(file)) continue;
      const src = readFileSync(file, "utf8");
      // an alias would hide a call: count the imported name, not just the local one
      for (const match of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
        for (const spec of match[1].split(",")) {
          const [original, alias] = spec.split(/\s+as\s+/).map((s) => s.trim());
          if (original && OUTWARD_WRITERS.includes(original)) offenders.push(`${file}: imports ${original}${alias && alias !== original ? ` as ${alias}` : ""}`);
        }
      }
      for (const name of OUTWARD_WRITERS) {
        if (new RegExp(`\\b${name}\\s*\\(`).test(src)) offenders.push(`${file}: calls ${name}(`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * A state whose repos.yaml holds three repos that take GitHub Issues in and one that does not:
 * test/intake (two labels), test/english (public_language en, one label), test/nolabels (no label
 * condition), and test/project (no issue_lane section, so the engine never takes its Issues in).
 */
function setupLaneState(): { state: string; gh: string; ghLog: string } {
  const state = mkdtempSync(join(tmpdir(), "idd-cli-lane-"));
  temps.push(state);
  writeFileSync(join(state, "repos.yaml"), [
    "repos:",
    "  test/project:",
    "    upstream: /nonexistent/up",
    "    work: /nonexistent/work",
    "    public_base: main",
    "  test/intake:",
    "    upstream: /nonexistent/up",
    "    work: /nonexistent/work",
    "    public_base: main",
    "    issue_lane:",
    "      source_type_priority: github",
    "      intake_filter: { github_labels: [idd-ready, lane] }",
    "  test/english:",
    "    upstream: /nonexistent/up",
    "    work: /nonexistent/work",
    "    public_base: main",
    "    public_language: en",
    "    issue_lane:",
    "      source_type_priority: github",
    "      intake_filter: { github_labels: [idd-ready] }",
    "  test/nolabels:",
    "    upstream: /nonexistent/up",
    "    work: /nonexistent/work",
    "    public_base: main",
    "    issue_lane:",
    "      source_type_priority: github",
    "",
  ].join("\n"));
  const ghLog = join(state, "gh.log");
  const gh = join(state, "gh");
  writeFileSync(gh, `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(ghLog)}, process.argv.slice(2).join(" ") + "\\n");\n`, { mode: 0o755 });
  chmodSync(gh, 0o755);
  return { state, gh, ghLog };
}

interface RecordedOutbound { target?: { labels?: string[] }; source?: string; created_at?: string }

function outboundRecords(state: string): RecordedOutbound[] {
  const dir = join(state, "outbound");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as RecordedOutbound)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
}

describe("idd out draft --lane and idd out targets", () => {
  test("AC-007: --lane adds the destination's intake labels and does not repeat an explicit one", () => {
    const { state, gh } = setupLaneState();
    const body = join(state, "body.md");
    writeFileSync(body, "body\n");
    const first = idd(["out", "draft", "--kind", "gh-issue", "--repo", "test/intake", "--title", "T", "--body-file", body, "--source", "chat handoff", "--lane", "--no-rewrite"], state, gh);
    expect(first.code).toBe(0);
    const records = outboundRecords(state);
    expect(records.length).toBe(1);
    expect(records[0].target?.labels).toEqual(["idd-ready", "lane"]);
    expect(records[0].source).toBe("chat handoff");
    // a --label that is already an intake label stays one label
    const second = idd(["out", "draft", "--kind", "gh-issue", "--repo", "test/intake", "--title", "T", "--body-file", body, "--lane", "--label", "lane", "--no-rewrite"], state, gh);
    expect(second.code).toBe(0);
    expect(outboundRecords(state)[1].target?.labels).toEqual(["idd-ready", "lane"]);
  });

  test("AC-007: a repo with no label condition is a valid destination and gets no labels", () => {
    const { state, gh } = setupLaneState();
    const body = join(state, "body.md");
    writeFileSync(body, "body\n");
    const res = idd(["out", "draft", "--kind", "gh-issue", "--repo", "test/nolabels", "--title", "T", "--body-file", body, "--lane", "--no-rewrite"], state, gh);
    expect(res.code).toBe(0);
    expect(outboundRecords(state)[0].target?.labels).toBeUndefined();
  });

  test("AC-008: --lane refuses a repo that does not take GitHub Issues in and writes no record", () => {
    const { state, gh } = setupLaneState();
    const body = join(state, "body.md");
    writeFileSync(body, "body\n");
    for (const repo of ["test/project", "test/unknown"]) {
      const res = idd(["out", "draft", "--kind", "gh-issue", "--repo", repo, "--title", "T", "--body-file", body, "--lane", "--no-rewrite"], state, gh);
      expect(res.code).not.toBe(0);
      expect(res.err).toContain(repo);
      expect(res.err).not.toContain("at ");
    }
    expect(outboundRecords(state).length).toBe(0);
  });

  test("AC-008: a broken repos.yaml refuses --lane with a reason and writes no record", () => {
    const { state, gh } = setupLaneState();
    const broken = join(state, "broken.yaml");
    writeFileSync(broken, "repos:\n  test/intake:\n    upstream: /x\n");
    const body = join(state, "body.md");
    writeFileSync(body, "body\n");
    const res = idd(["out", "draft", "--kind", "gh-issue", "--repo", "test/intake", "--title", "T", "--body-file", body, "--lane", "--no-rewrite"], state, gh, { IDD_REPOS_FILE: broken });
    expect(res.code).not.toBe(0);
    expect(res.err.length).toBeGreaterThan(0);
    expect(res.err).not.toContain("at ");
    expect(outboundRecords(state).length).toBe(0);
  });

  test("AC-009: without --lane the labels stay as they were, and a broken registry stops the draft rather than drafting it without the repo's rules", () => {
    const { state, gh } = setupLaneState();
    const broken = join(state, "broken.yaml");
    writeFileSync(broken, "repos:\n  test/intake:\n    upstream: /x\n");
    const body = join(state, "body.md");
    writeFileSync(body, "body\n");
    // no --lane: no labels at all, even for a repo that takes Issues in
    const plain = idd(["out", "draft", "--kind", "gh-issue", "--repo", "test/intake", "--title", "T", "--body-file", body, "--no-rewrite"], state, gh);
    expect(plain.code).toBe(0);
    expect(outboundRecords(state)[0].target?.labels).toBeUndefined();
    // --label only: that value alone
    const explicit = idd(["out", "draft", "--kind", "gh-issue", "--repo", "test/intake", "--title", "T", "--body-file", body, "--label", "manual", "--no-rewrite"], state, gh);
    expect(explicit.code).toBe(0);
    expect(outboundRecords(state)[1].target?.labels).toEqual(["manual"]);
    // a broken registry is a wrong setting, not the lack of one: the Issue is not drafted without the repo's pointers
    const refused = idd(["out", "draft", "--kind", "gh-issue", "--repo", "test/intake", "--title", "T", "--body-file", body, "--no-rewrite"], state, gh, { IDD_REPOS_FILE: broken });
    expect(refused.code).not.toBe(0);
    expect(refused.err).not.toContain("at ");
    expect(outboundRecords(state).length).toBe(2);
    // a repo the registry does not know is still drafted (without pointers)
    const unknown = idd(["out", "draft", "--kind", "gh-issue", "--repo", "nobody/none", "--title", "T", "--body-file", body, "--no-rewrite"], state, gh);
    expect(unknown.code).toBe(0);
    expect(outboundRecords(state).length).toBe(3);
  });

  test("AC-013: idd out targets lists only intake repos with labels and language, calls no gh and writes nothing", () => {
    const { state, gh, ghLog } = setupLaneState();
    const res = idd(["out", "targets"], state, gh);
    expect(res.code).toBe(0);
    const rows = JSON.parse(res.out) as { repo: string; labels: string[]; language: string }[];
    expect(rows.map((r) => r.repo).sort()).toEqual(["test/english", "test/intake", "test/nolabels"]);
    const intake = rows.find((r) => r.repo === "test/intake");
    expect(intake?.labels).toEqual(["idd-ready", "lane"]);
    expect(intake?.language).toBe("日本語");
    expect(rows.find((r) => r.repo === "test/english")?.language).toBe("en");
    expect(rows.find((r) => r.repo === "test/nolabels")?.labels).toEqual([]);
    expect(existsSync(ghLog)).toBe(false);
    expect(existsSync(join(state, "outbound"))).toBe(false);
  });
});

describe("idd out draft names the lane that asked as the ledger's destination", () => {
  /** a state with a writer stand-in for pi and one instruction that reaches every scene, so a started rewrite leaves a ledger line */
  function writerState() {
    const { state, gh } = setupLaneState();
    const cfg = join(state, "cfg");
    mkdirSync(cfg);
    writeFileSync(join(cfg, ".credentials.json"), "{}");
    writeFileSync(join(state, "roles.yaml"), `defaults:\n  claude_config_dir: ${cfg}\nmodels:\n  m:\n    model: x/y\nroles:\n  rewriter:\n    model: m\n    tools: []\n    report: review\n`);
    const pi = join(state, "pi");
    writeFileSync(pi, "#!/bin/sh\ncase \"$*\" in *--list-models*) exit 0 ;; esac\necho 書き直した本文\n", { mode: 0o755 });
    const instructions = join(state, "instructions");
    mkdirSync(instructions);
    writeFileSync(join(instructions, "instructions.json"), JSON.stringify({
      version: 1,
      next: 2,
      instructions: [{ id: "INS-1", text: "短く書く。", reason: "読まれないから", scope: { repos: "all", scenes: "all", places: "all" }, created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z" }],
    }));
    const agent = join(state, "agent");
    mkdirSync(agent);
    const env = { IDD_ROLES_FILE: join(state, "roles.yaml"), IDD_PI_BIN: pi, IDD_PI_USER_AGENT_DIR: agent, IDD_INSTRUCTIONS_DIR: instructions };
    const ledger = () => {
      const file = join(state, "instruction-ledger.jsonl");
      return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { to: Record<string, unknown> }) : [];
    };
    return { state, gh, env, ledger };
  }

  test("a draft asked for inside a lane is written for that lane's writer, and one asked for outside names no lane", () => {
    const { state, gh, env, ledger } = writerState();
    const args = ["out", "draft", "--kind", "gh-issue", "--repo", "test/intake", "--title", "T", "--body", "本文"];
    const inside = idd(args, state, gh, { ...env, IDD_ID: "IDD-9" });
    expect(inside.code).toBe(0);
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0].to).toMatchObject({ kind: "writer", stage: "reply_draft", lane: "IDD-9" });
    // a stage run has no IDD_ID, only the lane its spec named
    const stage = idd(args, state, gh, { ...env, IDD_ID: "", IDD_RUN_LANE: "IDD-10" });
    expect(stage.code).toBe(0);
    expect(ledger()).toHaveLength(2);
    expect(ledger()[1].to).toMatchObject({ kind: "writer", stage: "reply_draft", lane: "IDD-10" });
    const outside = idd(args, state, gh, { ...env, IDD_ID: "", IDD_RUN_LANE: "" });
    expect(outside.code).toBe(0);
    expect(ledger()).toHaveLength(3);
    expect(ledger()[2].to).toMatchObject({ kind: "writer", stage: "reply_draft" });
    expect(ledger()[2].to.lane).toBeUndefined();
  });
});
