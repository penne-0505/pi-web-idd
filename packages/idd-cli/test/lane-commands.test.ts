import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { blindFields, parseArgs, runLaneCommand, runLaneRedoCommand, runReviewMapCommand } from "../src/lane-commands.ts";
import { listOutbound, readOutbound } from "../../idd-lane/src/outbound.ts";
import { writeMappedBlindSpecs } from "../../idd-lane/src/review-runs.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

// the tests below point the state and roles at their own files; the other test files must not see them
const savedEnv = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_ROLES_FILE: process.env.IDD_ROLES_FILE, IDD_GH_BIN: process.env.IDD_GH_BIN, IDD_AGENT_BASE_URL: process.env.IDD_AGENT_BASE_URL };
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("parseArgs", () => {
  test("separates positionals, valued flags, boolean flags, and the -- tail", () => {
    const p = parseArgs(["--wt", "/w", "--run", "x y", "--dry-run", "--to", "abc", "--", "a.dart", "b.dart"]);
    expect(p.flags.wt).toBe("/w");
    expect(p.flags.run).toBe("x y");
    expect(p.flags["dry-run"]).toBe(true);
    expect(p.flags.to).toBe("abc");
    expect(p.rest).toEqual(["a.dart", "b.dart"]);
  });

  test("collects repeated list keys and accepts --k=v", () => {
    const p = parseArgs(["--findings", "a.json", "--findings=b.json", "5591"], ["findings"]);
    expect(p.flags.findings).toEqual(["a.json", "b.json"]);
    expect(p.positional).toEqual(["5591"]);
  });

  test("does not swallow the next token after a boolean flag", () => {
    const p = parseArgs(["--approve", "--body-file", "f.md"]);
    expect(p.flags.approve).toBe(true);
    expect(p.flags["body-file"]).toBe("f.md");
  });

  test("records valued flags that took no value, so a body starting with -- is never sent as the string true", () => {
    const p = parseArgs(["--recent", "--no-verify は使わない", "--recent=ok", "--force"], ["recent"]);
    expect(p.missing).toEqual(["recent", "no-verify は使わない"]);
    expect(p.flags.recent).toEqual(["true", "ok"]);
    expect(p.flags.force).toBe(true);
    expect(parseArgs(["--k=v"]).missing).toEqual([]);
  });
});

describe("idd review map", () => {
  const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...a], { cwd, encoding: "utf8" }).trim();

  async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
    const w = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    let out = "";
    let err = "";
    process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
    try {
      return { code: await fn(), out, err };
    } finally {
      process.stdout.write = w;
      process.stderr.write = e;
    }
  }

  /** a state dir with a roles file of this text, and a repo whose base commits `baseFiles` and whose head adds `headFiles` */
  function mapFixture(names: { state: string; wt: string }, roles: string, baseFiles: Record<string, string>, headFiles: Record<string, string>) {
    const state = tmpDir(names.state);
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, roles);
    const wt = tmpDir(names.wt);
    git(wt, "init", "-q");
    const commit = (files: Record<string, string>, msg: string) => {
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(wt, rel)), { recursive: true });
        writeFileSync(join(wt, rel), text);
      }
      git(wt, "add", "-A"); git(wt, "commit", "-q", "-m", msg);
      return git(wt, "rev-parse", "HEAD");
    };
    return { state, wt, base: commit(baseFiles, "base"), head: commit(headFiles, "head") };
  }

  test("writes the map's spec without running it on --dry-run, and says whether the pipeline would map the diff", async () => {
    const { state, wt, base, head } = mapFixture(
      { state: "idd-cli-map-", wt: "idd-cli-map-wt-" },
      "models:\n  x-m:\n    model: x/m\n  x-b:\n    model: x/b\nroles:\n  m: { model: x-m, report: map }\n  b: { model: x-b, report: review }\npipeline:\n  review_blind: { roles: [b], concurrency: 2 }\n  risk_map: { role: m, min_lines: 5 }\n",
      { "a.txt": "a\n" },
      { "lib/b.txt": "1\n2\n3\n4\n5\n6\n" },
    );
    const out = join(state, "map-out");
    const r = await capture(() => runReviewMapCommand(["--wt", wt, "--base", base, "--head", head, "--out", out, "--dry-run"]));
    expect(r.code).toBe(0);
    const res = JSON.parse(r.out) as Record<string, unknown>;
    expect(res.spec).toBe(join(out, "map.yaml"));
    expect(existsSync(join(out, "map.yaml"))).toBe(true);
    expect(res.diff_lines).toBe(6);
    expect(res.min_lines).toBe(5);
    expect(res.pipeline_would_map).toBe(true);
    expect(res.lane).toBeUndefined();
    expect(readFileSync(join(out, "map.yaml"), "utf8")).toContain("role: m");
    expect(existsSync(join(state, "lanes", "risk-map"))).toBe(false);
  });

  test("says the pipeline would not map the diff while review_blind is not declared", async () => {
    const { state, wt, base, head } = mapFixture(
      { state: "idd-cli-map-nb-", wt: "idd-cli-map-nb-wt-" },
      "models:\n  x-m:\n    model: x/m\nroles:\n  m: { model: x-m, report: map }\npipeline:\n  risk_map: { role: m, min_lines: 1 }\n",
      { "a.txt": "a\n" },
      { "a.txt": "a\nb\nc\n" },
    );
    const r = await capture(() => runReviewMapCommand(["--wt", wt, "--base", base, "--head", head, "--out", join(state, "o"), "--dry-run"]));
    expect(r.code).toBe(0);
    const res = JSON.parse(r.out) as Record<string, unknown>;
    expect(res.pipeline_would_map).toBe(false);
    expect(String(res.map_skip_reason)).toMatch(/review_blind/);
  });

  test("names the copies the blind specs point at, and the command that removes them with their records", () => {
    const { state, wt, base, head } = mapFixture(
      { state: "idd-cli-map-cp-", wt: "idd it's-map-cp-wt-" },
      "models:\n  x-b:\n    model: x/b\nroles:\n  b: { model: x-b, report: review }\npipeline:\n  review_blind: { roles: [b], concurrency: 2 }\n",
      { "overlay.manifest": "overlay.manifest\n_docs/plan/\n", "_docs/plan/p.md": "plan\n" },
      { "a.txt": "a\n" },
    );
    const blind = writeMappedBlindSpecs({ worktree: wt, base, head, out: join(state, "o") }, []);
    const fields = blindFields(blind, false) as { blind_specs: { worktree: string }[]; blind_copies: { root: string; remove: string }; next: string };
    const worktrees = fields.blind_specs.map((b) => b.worktree);
    expect(worktrees.length).toBeGreaterThan(0);
    for (const w of worktrees) { expect(existsSync(w)).toBe(true); expect(w.startsWith(`${fields.blind_copies.root}/`)).toBe(true); }
    // the output no longer says the specs share a worktree
    expect(fields.next).not.toContain("同じ worktree");
    expect(fields.next).toContain("blind_copies.remove");
    execFileSync("sh", ["-c", fields.blind_copies.remove]);
    for (const w of worktrees) expect(existsSync(w)).toBe(false);
    expect(existsSync(fields.blind_copies.root)).toBe(false);
    expect(existsSync(wt)).toBe(true);
    // a repo with no manifest rows has no copy to name
    const plain = blindFields({ specs: [{ label: "", role: "b", specPath: "/s", report: "/r", worktree: wt }], copyRoot: null }, false);
    expect(plain.blind_copies).toBeUndefined();
    expect(String(plain.next)).toContain("map をかけた worktree");
  });

  test("asks for the worktree and both revisions", async () => {
    const r = await capture(() => runReviewMapCommand(["--wt", "/x"]));
    expect(r.code).toBe(2);
    expect(r.err).toContain("idd review map");
  });
});

/** the CLI in its own capture, with stdout and stderr apart */
async function captureCli(fn: () => Promise<number | undefined>): Promise<{ code: number | undefined; out: string; err: string }> {
  const w = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try {
    return { code: await fn(), out, err };
  } finally {
    process.stdout.write = w;
    process.stderr.write = e;
  }
}

/** a gh that logs its calls and answers the PR read the draft is made from */
function fakePrGh(head: string, title: string): { log: () => string[][] } {
  const dir = tmpDir("idd-cli-prpost-gh-");
  const logFile = join(dir, "calls.jsonl");
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "pr" && args[1] === "view") { console.log(JSON.stringify({ headRefOid: ${JSON.stringify(head)}, state: "OPEN", title: ${JSON.stringify(title)}, url: "https://github.com/o/r/pull/1" })); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
  process.env.IDD_GH_BIN = bin;
  return { log: () => { try { return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]); } catch { return []; } } };
}

describe("idd pr post", () => {
  test("makes a gh-pr-review draft from the written body and never posts", async () => {
    const state = tmpDir("idd-cli-prpost-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_AGENT_BASE_URL = "http://127.0.0.1:30142";
    const gh = fakePrGh("abc1234ffff", "例の PR");
    const bodyFile = join(state, "body.md");
    writeFileSync(bodyFile, "# 指摘\n\n- 直してください\n");
    const r = await captureCli(() => runLaneCommand("pr", ["post", "--repo", "o/r", "1", "--comment", "--body-file", bodyFile, "--expect-head", "abc1234"]));
    expect(r.code).toBe(0);
    const res = JSON.parse(r.out) as { ok: boolean; id: string; url: string };
    expect(res.ok).toBe(true);
    expect(res.url).toContain("view=inbox");
    expect(res.url).toContain(`card=${res.id}`);
    const rec = readOutbound(res.id);
    expect(rec?.kind).toBe("gh-pr-review");
    expect(rec?.target).toMatchObject({ repo: "o/r", pr: 1, expectHead: "abc1234", event: "comment" });
    expect(rec?.draft).toBe("# 指摘\n\n- 直してください\n");
    expect(rec?.rewritten).toBeUndefined();
    expect(rec?.rewrite).toBeUndefined();
    expect(rec?.title).toBe("#1 例の PR");
    // the only gh call is the read the draft was made from: no review, no edit, no comment
    const calls = gh.log().map((a) => a.slice(0, 2).join(" "));
    expect(calls).toEqual(["pr view"]);
  });

  test("refuses a draft when the head has moved, and makes no card", async () => {
    const state = tmpDir("idd-cli-prpost-moved-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_AGENT_BASE_URL = "http://127.0.0.1:30142";
    const gh = fakePrGh("abc1234ffff", "例の PR");
    const bodyFile = join(state, "body.md");
    writeFileSync(bodyFile, "本文\n");
    const r = await captureCli(() => runLaneCommand("pr", ["post", "--repo", "o/r", "1", "--comment", "--body-file", bodyFile, "--expect-head", "9999999"]));
    expect(r.code).toBe(1);
    expect(r.err).toContain("head が変わっています");
    expect(listOutbound()).toEqual([]);
    expect(gh.log().some((a) => a[0] === "pr" && ["review", "edit", "comment"].includes(a[1]))).toBe(false);
  });

  test("--dry-run checks the head and returns what would be made without making a card", async () => {
    const state = tmpDir("idd-cli-prpost-dry-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_AGENT_BASE_URL = "http://127.0.0.1:30142";
    fakePrGh("abc1234ffff", "例の PR");
    const bodyFile = join(state, "body.md");
    writeFileSync(bodyFile, "本文\n");
    const r = await captureCli(() => runLaneCommand("pr", ["post", "--repo", "o/r", "1", "--comment", "--body-file", bodyFile, "--expect-head", "abc1234", "--dry-run"]));
    expect(r.code).toBe(0);
    const res = JSON.parse(r.out) as { dry_run: boolean; draft: string; title: string };
    expect(res.dry_run).toBe(true);
    expect(res.draft).toBe("本文\n");
    expect(res.title).toBe("#1 例の PR");
    expect(listOutbound()).toEqual([]);
  });

  test("refuses a body the card's post would refuse, before making a card", async () => {
    const state = tmpDir("idd-cli-prpost-bad-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_AGENT_BASE_URL = "http://127.0.0.1:30142";
    fakePrGh("abc1234ffff", "例の PR");
    const empty = join(state, "empty.md");
    writeFileSync(empty, "\n");
    const marker = join(state, "marker.md");
    writeFileSync(marker, "本文\n🤖 AIが作成したPR本文です\n");

    // an empty body blocks a comment or a change request (and --dry-run reports the same before making a card)
    for (const args of [
      ["post", "--repo", "o/r", "1", "--comment", "--body-file", empty, "--expect-head", "abc1234"],
      ["post", "--repo", "o/r", "1", "--request-changes", "--body-file", empty, "--expect-head", "abc1234"],
      ["post", "--repo", "o/r", "1", "--comment", "--body-file", empty, "--expect-head", "abc1234", "--dry-run"],
    ]) {
      const r = await captureCli(() => runLaneCommand("pr", args));
      expect(r.code).toBe(1);
      expect(r.err).toContain("本文が空です");
      expect(listOutbound()).toEqual([]);
    }

    // the AI marker the post refuses is caught here too, so no unusable card reaches the inbox
    const bad = await captureCli(() => runLaneCommand("pr", ["post", "--repo", "o/r", "1", "--comment", "--body-file", marker, "--expect-head", "abc1234"]));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("AI マーカー");
    expect(listOutbound()).toEqual([]);

    // an approve may go without a body, as on the card's post
    const ok = await captureCli(() => runLaneCommand("pr", ["post", "--repo", "o/r", "1", "--approve", "--body-file", empty, "--expect-head", "abc1234"]));
    expect(ok.code).toBe(0);
    expect(listOutbound().length).toBe(1);
  });
});

describe("idd out draft --kind gh-pr-body", () => {
  test("queues a body update against the PR's text as it is now, keeping its title, and writes nothing to the PR", async () => {
    const state = tmpDir("idd-cli-prbody-");
    process.env.IDD_STATE_DIR = state;
    const log = join(state, "gh-calls.txt");
    const gh = join(state, "gh");
    writeFileSync(gh, `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[3] === "view") { console.log(JSON.stringify({ title: "feat: 今の題", body: "今の本文\\n" })); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
    process.env.IDD_GH_BIN = gh;
    const w = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
    let code: number | undefined;
    try {
      code = await runLaneCommand("out", ["draft", "--kind", "gh-pr-body", "--repo", "o/r", "--pr", "7", "--body", "新しい本文\n"]);
    } finally {
      process.stdout.write = w;
    }
    expect(code).toBe(0);
    const answer = JSON.parse(out) as { id: string; url: string };
    expect(answer.url).toContain("view=inbox");
    expect(answer.url).toContain(`card=${answer.id}`);
    const rec = readOutbound(String(answer.id));
    expect(rec?.kind).toBe("gh-pr-body");
    expect(rec?.title).toBe("feat: 今の題");
    expect(rec?.target).toMatchObject({ repo: "o/r", pr: 7, baseTitle: "feat: 今の題", baseBody: "今の本文\n" });
    expect(rec?.draft).toBe("新しい本文\n");
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["pr view 7 --repo o/r --json title,body"]);
  });
});

describe("idd lane redo", () => {
  const capture = async (fn: () => Promise<number | undefined>): Promise<{ code?: number; out: string; err: string }> => {
    const w = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    let out = "";
    let err = "";
    process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
    try {
      return { code: await fn(), out, err };
    } finally {
      process.stdout.write = w;
      process.stderr.write = e;
    }
  };

  test("calls the engine's redo with the lane's ID and asks for a tick, and stays out of the other lane verbs", async () => {
    const called: string[] = [];
    const kicks: number[] = [];
    const deps = {
      redo: async (iddId: string) => { called.push(iddId); return { ok: true, from: iddId, iddId: "IDD-002", wrote: [], stopped: { sessions: [], runs: [], failed: [] } }; },
      tick: () => { kicks.push(1); return { outcome: "off" as const }; },
    };
    const r = await capture(() => runLaneRedoCommand("lane", ["redo", "IDD-001"], deps));
    expect(r.code).toBe(0);
    expect(called).toEqual(["IDD-001"]);
    expect(kicks.length).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, from: "IDD-001", idd_id: "IDD-002" });
    // another command under `lane` is left to the lane verbs
    expect(await runLaneRedoCommand("lane", ["status"], deps)).toBeUndefined();
    expect(await runLaneRedoCommand("intake", ["redo"], deps)).toBeUndefined();
    // no lane ID: the usage, and nothing runs
    expect(await runLaneRedoCommand("lane", ["redo"], deps)).toBe(2);
  });

  test("a redo the engine refuses exits 1 with its reason, and asks for no tick", async () => {
    const kicks: number[] = [];
    const deps = { redo: async () => ({ ok: false, error: "起票を読み直せません: 閉じています" }), tick: () => { kicks.push(1); return { outcome: "off" as const }; } };
    const r = await capture(() => runLaneRedoCommand("lane", ["redo", "IDD-001"], deps));
    expect(r.code).toBe(1);
    expect(kicks).toEqual([]);
    expect(JSON.parse(r.out).error).toContain("起票を読み直せません");
    // and it does not fall through to the lane verbs' usage answer
    expect(await runLaneCommand("lane", ["redo", "IDD-001"])).toBe(2);
  });
});

describe("idd wait-run", () => {
  test("refuses a call with neither a check nor a command, and shows the usage", async () => {
    const none = await captureCli(() => runLaneCommand("wait-run", []));
    expect(none.code).toBe(2);
    expect(none.err).toContain("idd wait-run");
    const bare = await captureCli(() => runLaneCommand("wait-run", ["--check"]));
    expect(bare.code).toBe(2);
    expect(bare.err).toContain("--check");
  });

  test("runs a literal command and ends with its exit code", async () => {
    const state = tmpDir("idd-cli-wait-");
    process.env.IDD_STATE_DIR = state;
    const r = await captureCli(() => runLaneCommand("wait-run", ["--", "echo hi; exit 3"]));
    expect(r.code).toBe(3);
    expect(r.out).toContain("hi");
    expect(r.out).toContain("終了コード 3");
  });
});
