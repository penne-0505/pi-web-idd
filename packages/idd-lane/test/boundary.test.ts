import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { laneHoldToken } from "../../idd-core/src/agent/token.ts";
import { HOLD_SENTENCE, planHold, WAIT_SENTENCE } from "../src/boundary.ts";
import { listOutbound } from "../src/outbound.ts";
import { tmpDir } from "./helpers/tmp.ts";

/**
 * The table of what a lane's agent may hand over (planHold) is checked from the argv alone, and the door that acts on
 * it (`idd hold run`, `idd hold status`) is run for real against a stand-in engine and a stand-in gh. The shim's side
 * is in shim.test.ts.
 */

const files: Record<string, string> = { "body.md": "from a file\n" };
const read = (path: string) => {
  if (!(path in files)) throw new Error(`ENOENT ${path}`);
  return files[path];
};
const plan = (tool: "gh" | "git", ...args: string[]) => planHold(tool, args, read);

describe("the table", () => {
  test("a push is one thing whatever the words around it, and a push that is not 'this lane's branch as it is' is not taken", () => {
    for (const args of [["push"], ["push", "origin", "main"], ["-C", ".", "push"], ["-c", "a=b", "push", "origin", "idd/IDD-1"], ["--git-dir=.git", "push"]]) {
      expect(plan("git", ...args), args.join(" ")).toEqual({ op: "push" });
    }
    for (const flag of ["--force", "-f", "--force-with-lease", "--force-with-lease=x:y", "--delete", "-d", "--mirror", "--prune", "--tags", "--all"]) {
      expect(plan("git", "push", flag, "origin").op, flag).toBe("refuse");
    }
    for (const refspec of ["HEAD:main", "+main", ":gone"]) expect(plan("git", "push", "origin", refspec).op, refspec).toBe("refuse");
    for (const args of [["status"], ["-C", ".", "log"], ["fetch"], ["commit", "-m", "x"]]) expect(plan("git", ...args).op, args.join(" ")).toBe("pass");
  });

  test("a push that writes nothing (a dry run, help) is the real git's to answer, not a request", () => {
    for (const args of [["push", "--dry-run"], ["push", "-n", "origin"], ["push", "origin", "--dry-run", "--force"], ["push", "-un", "origin"], ["push", "--dry", "origin"], ["push", "--help"], ["push", "-h"], ["--help", "push"], ["-C", ".", "push", "-n"], ["push", "--dry-run", "--no-dry-run", "--dry-run"]]) {
      expect(plan("git", ...args).op, args.join(" ")).toBe("pass");
    }
    // a dry run that is undone, and a word that only looks like one (the value of -o), are the push they are
    for (const args of [["push", "--dry-run", "--no-dry-run"], ["push", "-n", "--no-dry-run", "origin"], ["push", "-o", "-n"], ["push", "-o", "--help"], ["push", "-on"], ["push", "--push-option", "-n"], ["push", "origin", "--", "-n"]]) {
      expect(plan("git", ...args).op, args.join(" ")).toBe("push");
    }
  });

  test("gh pr create keeps the title and the body, from flags or a file, and says back what it left out", () => {
    expect(plan("gh", "pr", "create", "--title", "T", "--body", "B")).toEqual({ op: "pr-create", title: "T", body: "B", ignored: [] });
    expect(plan("gh", "pr", "create", "-t", "T", "-b", "B")).toEqual({ op: "pr-create", title: "T", body: "B", ignored: [] });
    expect(plan("gh", "pr", "create", "--title=T", "--body=B")).toEqual({ op: "pr-create", title: "T", body: "B", ignored: [] });
    expect(plan("gh", "pr", "create", "--title", "T", "--body-file", "body.md")).toEqual({ op: "pr-create", title: "T", body: "from a file\n", ignored: [] });
    const left = plan("gh", "pr", "create", "--title", "T", "--body", "B", "--base", "main", "--draft", "--label", "x");
    expect(left).toEqual({ op: "pr-create", title: "T", body: "B", ignored: ["--base", "--draft", "--label"] });
    expect(plan("gh", "pr", "create", "--fill")).toEqual({ op: "pr-create", ignored: ["--fill"] });
    expect(plan("gh", "pr", "create", "--body", "B").op).toBe("refuse");
    expect(plan("gh", "pr", "create", "--title", "T", "--body-file", "missing.md").op).toBe("refuse");
  });

  test("gh pr edit takes a title and a body and nothing else", () => {
    expect(plan("gh", "pr", "edit", "12", "--title", "T", "--body", "B")).toEqual({ op: "pr-edit", pr: "12", title: "T", body: "B" });
    expect(plan("gh", "pr", "edit", "--repo", "o/n", "12", "--body-file", "body.md")).toEqual({ op: "pr-edit", repo: "o/n", pr: "12", body: "from a file\n" });
    for (const args of [["12", "--add-label", "x"], ["12", "--base", "other"], ["12", "--add-reviewer", "x"], ["12"]]) {
      expect(plan("gh", "pr", "edit", ...args).op, args.join(" ")).toBe("refuse");
    }
  });

  test("gh issue create needs a title, and labels are the agent's to name", () => {
    expect(plan("gh", "issue", "create", "--repo", "o/n", "--title", "T", "--body", "B", "--label", "a,b", "-l", "c")).toEqual({ op: "issue-create", repo: "o/n", title: "T", body: "B", labels: ["a", "b", "c"], ignored: [] });
    expect(plan("gh", "issue", "create", "--title", "T", "--assignee", "me")).toEqual({ op: "issue-create", title: "T", body: "", labels: [], ignored: ["--assignee"] });
    expect(plan("gh", "issue", "create", "--body", "B").op).toBe("refuse");
  });

  test("gh api takes the same operations in their REST and GraphQL shapes, and no other write", () => {
    expect(plan("gh", "api", "repos/o/n/issues", "-f", "title=T", "-f", "body=B", "-f", "labels[]=x")).toEqual({ op: "issue-create", repo: "o/n", title: "T", body: "B", labels: ["x"], ignored: [] });
    expect(plan("gh", "api", "-X", "POST", "repos/o/n/pulls", "-f", "title=T", "-f", "body=B", "-f", "head=h", "-f", "base=main")).toEqual({ op: "pr-create", title: "T", body: "B", ignored: ["head", "base"] });
    expect(plan("gh", "api", "repos/o/n/pulls", "-F", "title=T", "--field", "head=h")).toEqual({ op: "pr-create", title: "T", body: "", ignored: ["head"] });
    expect(plan("gh", "api", "repos/o/n/issues", "-f", "title=T", "-f", "assignees[]=me", "-F", "milestone=1", "--field", "labels=x")).toEqual({ op: "issue-create", repo: "o/n", title: "T", body: "", labels: ["x"], ignored: ["assignees[]", "milestone"] });
    expect(plan("gh", "api", "repos/o/n/pulls/3/comments/5/replies", "-f", "body=ok", "-f", "side=LEFT").op).toBe("refuse");
    expect(plan("gh", "api", "--method", "PATCH", "repos/o/n/pulls/3", "-f", "body=B")).toEqual({ op: "pr-edit", repo: "o/n", pr: "3", body: "B" });
    expect(plan("gh", "api", "repos/o/n/pulls/3/comments/5/replies", "-f", "body=ok")).toEqual({ op: "thread-reply", repo: "o/n", pr: 3, commentId: "5", body: "ok" });
    expect(plan("gh", "api", "graphql", "-f", "query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}", "-f", "t=PRRT_x")).toEqual({ op: "thread-act", threadId: "PRRT_x", resolve: true });
    expect(plan("gh", "api", "graphql", "-f", "query=mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{url}}}", "-f", "t=PRRT_x", "-f", "b=done")).toEqual({ op: "thread-act", threadId: "PRRT_x", body: "done", resolve: false });
    expect(plan("gh", "api", "graphql", "-f", 'query=mutation{resolveReviewThread(input:{threadId:"PRRT_y"}){thread{id}}}')).toEqual({ op: "thread-act", threadId: "PRRT_y", resolve: true });
    const refused = [
      ["repos/o/n/pulls/3/merge", "-X", "PUT", "-f", "merge_method=squash"],
      ["repos/o/n/pulls/3", "-X", "PATCH", "-f", "state=closed"],
      ["repos/o/n/pulls/3", "-X", "PATCH", "-f", "body=B", "-f", "state=closed"],
      ["repos/o/n/issues/1", "-X", "PATCH", "-f", "state=closed"],
      ["repos/o/n/git/refs/heads/x", "-X", "DELETE"],
      ["repos/o/n", "-X", "DELETE"],
      ["repos/o/n/issues", "-f", "body=no title"],
      ["repos/o/n/issues", "--input", "body.json"],
      ["repos/o/n/issues", "-X", "GET", "-f", "q=x"],
      ["graphql", "-f", "query=mutation{deleteRef(input:{refId:\"x\"}){clientMutationId}}"],
      ["graphql", "-f", "query={viewer{login}}"],
      ["graphql", "-f", "query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}"],
      ["user/repos", "-f", "name=x"],
    ];
    for (const args of refused) expect(plan("gh", "api", ...args).op, args.join(" ")).toBe("refuse");
  });

  test("a typed gh api field that names a file holds what the file says, and one that cannot be read is not taken", () => {
    // -F reads the file; -f is the text as typed; a path is never signed in place of what the file says
    expect(plan("gh", "api", "repos/o/n/issues", "-f", "title=T", "-F", "body=@body.md")).toEqual({ op: "issue-create", repo: "o/n", title: "T", body: "from a file\n", labels: [], ignored: [] });
    expect(plan("gh", "api", "repos/o/n/pulls", "-F", "title=T", "--field", "body=@body.md")).toEqual({ op: "pr-create", title: "T", body: "from a file\n", ignored: [] });
    expect(plan("gh", "api", "repos/o/n/pulls/3/comments/5/replies", "-F", "body=@body.md")).toEqual({ op: "thread-reply", repo: "o/n", pr: 3, commentId: "5", body: "from a file\n" });
    expect(plan("gh", "api", "--method", "PATCH", "repos/o/n/pulls/3", "-F", "body=@body.md")).toEqual({ op: "pr-edit", repo: "o/n", pr: "3", body: "from a file\n" });
    expect(plan("gh", "api", "repos/o/n/issues", "-f", "title=T", "-f", "body=@body.md")).toMatchObject({ op: "issue-create", body: "@body.md" });
    for (const args of [["repos/o/n/issues", "-f", "title=T", "-F", "body=@missing.md"], ["repos/o/n/pulls", "-F", "title=@missing.md"]]) {
      const got = plan("gh", "api", ...args);
      expect(got.op, args.join(" ")).toBe("refuse");
      expect(got.op === "refuse" ? got.reason : "").toContain("missing.md");
    }
  });

  test("a check that looks for what the hold has not made yet is a follow-up", () => {
    for (const args of [["pr", "checks"], ["pr", "checks", "12", "--watch"], ["pr", "status"], ["run", "list"], ["run", "view", "1"], ["run", "watch", "1"]]) {
      expect(plan("gh", ...args).op, args.join(" ")).toBe("follow-up");
    }
    for (const args of [["pr", "view", "1"], ["issue", "view", "1"], ["run", "download", "1"]]) expect(plan("gh", ...args).op, args.join(" ")).toBe("refuse");
  });
});

// ---- the door, run for real ----

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface Door {
  /** the engine's requests, as it received them */
  requests: { path: string; auth: string | null; body: Record<string, unknown> }[];
  /** what the stand-in gh was asked, one line per call */
  gh: string;
  state: string;
  env: NodeJS.ProcessEnv;
  engine: ReturnType<typeof Bun.serve>;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => { for (const s of servers.splice(0)) s.stop(true); });

const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
case "$*" in
  *"--json headRefOid"*) echo '{"headRefOid":"abc123def"}' ;;
  *"--json title,body"*) echo '{"title":"Old title","body":"Old body"}' ;;
  *"--json body"*) echo '{"body":"Old body"}' ;;
  *"api repos/o/n/pulls/comments/5"*) echo '{"body":"please fix this","user":{"login":"rev"},"html_url":"https://github.com/o/n/pull/3#r5"}' ;;
  *"api graphql"*) echo '{"data":{"node":{"path":"a.ts","pullRequest":{"number":3,"headRefOid":"def456","repository":{"nameWithOwner":"o/n"}},"comments":{"nodes":[{"body":"fix this","url":"https://github.com/o/n/pull/3#r9","author":{"login":"rev"}}]}}}}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`;

function makeDoor(answer: { status: number; body: Record<string, unknown> } = { status: 200, body: { ok: true, id: "HOLD-1" } }, lanes: string[] = ["IDD-1", "IDD-2"]): Door {
  const root = tmpDir("idd-hold-");
  const state = join(root, "state");
  const bin = join(root, "bin");
  for (const d of [state, bin]) Bun.spawnSync(["mkdir", "-p", d]);
  const gh = join(root, "gh.log");
  writeFileSync(gh, "");
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(state, "backlog.jsonl"), lanes.map((id) => JSON.stringify({ idd_id: id, area: "me/app", title: `Lane ${id}`, context: "", created_at: "2026-10-26T00:00:00Z" })).join("\n") + "\n");
  const requests: Door["requests"] = [];
  const engine = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json() as Record<string, unknown> });
      return Response.json(answer.body, { status: answer.status });
    },
  });
  servers.push(engine);
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME,
    IDD_STATE_DIR: state,
    IDD_ID: "IDD-1",
    IDD_AGENT_TOKEN: "lane-token",
    IDD_HOLD_TOKEN: laneHoldToken("IDD-1", "lane-token"),
    IDD_AGENT_BASE_URL: `http://127.0.0.1:${engine.port}`,
    IDD_LANE_REAL_PATH: `${bin}:${process.env.PATH ?? ""}`,
    IDD_GH_BIN: join(bin, "gh"),
    FAKE_GH_LOG: gh,
    IDD_REPORT_RETRY_MS: "300",
    IDD_REPORT_RETRY_INTERVAL_MS: "50",
  };
  return { requests, gh, state, env, engine };
}

function hold(door: Door, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn("bash", [join(REPO, "bin", "idd"), "hold", ...args], { env: { ...door.env, ...extra }, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}

const ghCalls = (door: Door): string[] => readFileSync(door.gh, "utf8").split("\n").filter(Boolean);

describe("the door takes a push and a PR creation to the engine", () => {
  test("a push is recorded for the asking lane, and the answer says it is taken, not done, and a person's signature comes first", async () => {
    const door = makeDoor();
    const res = await hold(door, ["run", "git", "push", "origin", "main"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(HOLD_SENTENCE);
    expect(res.stdout).toContain("idd hold status");
    expect(res.stdout).not.toMatch(/https?:\/\/github|#\d+ を作|pull\/\d+/);
    expect(door.requests).toEqual([{ path: "/api/idd/agent/hold", auth: `Bearer ${laneHoldToken("IDD-1", "lane-token")}`, body: { idd_id: "IDD-1", kind: "push" } }]);
    expect(ghCalls(door)).toEqual([]);
  });

  test("a PR creation carries its title and body to the engine and says what it left out", async () => {
    const door = makeDoor();
    const res = await hold(door, ["run", "gh", "pr", "create", "--title", "T", "--body", "B", "--draft"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(HOLD_SENTENCE);
    expect(res.stdout).toContain("--draft は預かっていません");
    expect(door.requests[0].body).toEqual({ idd_id: "IDD-1", kind: "pr-create", title: "T", body: "B" });
    expect(ghCalls(door)).toEqual([]);
  });

  test("a hold that was not recorded is not a success: the engine refusing, and the engine not there", async () => {
    const refusing = makeDoor({ status: 400, body: { ok: false, error: "この lane はまだ実装の段に入っていません" } });
    const refused = await hold(refusing, ["run", "git", "push"]);
    expect(refused.code).toBe(86);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("預かりを記録できませんでした");
    expect(refused.stderr).toContain("実装の段に入っていません");
    expect(refused.stderr).not.toContain(HOLD_SENTENCE);

    const gone = makeDoor();
    gone.engine.stop(true);
    const unreachable = await hold(gone, ["run", "git", "push"]);
    expect(unreachable.code).toBe(86);
    expect(unreachable.stdout).toBe("");
    expect(unreachable.stderr).toContain("預かりを記録できませんでした");
    expect(unreachable.stderr).not.toContain(HOLD_SENTENCE);

    const tokenless = makeDoor();
    const none = await hold(tokenless, ["run", "git", "push"], { IDD_HOLD_TOKEN: "" });
    expect(none.code).toBe(86);
    expect(none.stderr).not.toContain(HOLD_SENTENCE);
    expect(tokenless.requests).toEqual([]);
  });

  test("a stage run, which has IDD_RUN_LANE and no IDD_ID, is recorded as its own lane; one outside the backlog is refused", async () => {
    const door = makeDoor();
    const stage = { IDD_ID: "", IDD_AGENT_TOKEN: "", IDD_RUN_LANE: "IDD-1" };
    const res = await hold(door, ["run", "git", "push"], stage);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain(HOLD_SENTENCE);
    expect(door.requests).toEqual([{ path: "/api/idd/agent/hold", auth: `Bearer ${laneHoldToken("IDD-1", "lane-token")}`, body: { idd_id: "IDD-1", kind: "push" } }]);
    const outside = makeDoor();
    const refused = await hold(outside, ["run", "git", "push"], { ...stage, IDD_RUN_LANE: "adhoc-20261027" });
    expect(refused.code).toBe(86);
    expect(refused.stderr).toContain("提出の段がない");
    expect(outside.requests).toEqual([]);
  });

  test("a lane with no submit stage is refused and told so, and nothing is sent", async () => {
    for (const env of [{ IDD_ID: "adhoc-20261026" }, { IDD_ID: "R-12" }, { IDD_ID: "" }]) {
      const door = makeDoor();
      for (const args of [["git", "push"], ["gh", "pr", "create", "--title", "T"], ["gh", "issue", "create", "--title", "T", "--repo", "o/n"], ["gh", "pr", "edit", "3", "--body", "B"]]) {
        const res = await hold(door, ["run", ...args], env);
        expect(res.code, `${JSON.stringify(env)} ${args.join(" ")}`).toBe(86);
        expect(res.stdout).toBe("");
        expect(res.stderr).toContain("提出の段がない");
        expect(res.stderr).not.toContain(HOLD_SENTENCE);
      }
      expect(door.requests).toEqual([]);
      expect(listOutboundIn(door)).toEqual([]);
    }
  });

  test("what the table does not take is refused with the way out, and what is not a boundary command is let through", async () => {
    const door = makeDoor();
    const refused = await hold(door, ["run", "gh", "api", "repos/o/n/pulls/3/merge", "-X", "PUT"]);
    expect(refused.code).toBe(86);
    expect(refused.stderr).toContain("報告に書いて人に渡してください");
    expect(refused.stderr).not.toContain(HOLD_SENTENCE);
    const force = await hold(door, ["run", "git", "push", "--force"]);
    expect(force.code).toBe(86);
    expect((await hold(door, ["run", "git", "status"])).code).toBe(87);
    // a dry run and help write nothing: the real git answers, and no hold is recorded
    for (const args of [["push", "--dry-run", "origin"], ["push", "-n"], ["push", "--help"]]) expect((await hold(door, ["run", "git", ...args])).code, args.join(" ")).toBe(87);
    expect(door.requests).toEqual([]);
    expect(ghCalls(door)).toEqual([]);
  });
});

/** the outbound records the door made, read in the door's own state */
function listOutboundIn(door: Door) {
  const saved = process.env.IDD_STATE_DIR;
  process.env.IDD_STATE_DIR = door.state;
  try {
    return existsSync(join(door.state, "outbound")) ? listOutbound() : [];
  } finally {
    if (saved === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved;
  }
}

describe("the door turns a post into a card draft and writes nothing outside", () => {
  test("gh issue create is a gh-issue draft with the agent's own title and body", async () => {
    const door = makeDoor();
    const res = await hold(door, ["run", "gh", "issue", "create", "--repo", "o/n", "--title", "Follow up", "--body", "Details", "--label", "idd-ready"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(HOLD_SENTENCE);
    const [rec] = listOutboundIn(door);
    expect(rec).toMatchObject({ kind: "gh-issue", status: "ready", title: "Follow up", draft: "Details", target: { repo: "o/n", labels: ["idd-ready"] }, source: "idd hold IDD-1" });
    expect(rec.rewritten).toBeUndefined();
    expect(res.stdout).toContain(rec.id);
    expect(ghCalls(door)).toEqual([]);
    expect(door.requests).toEqual([]);
  });

  test("gh pr edit is a gh-pr-body draft against the PR's text as it is now", async () => {
    const door = makeDoor();
    const res = await hold(door, ["run", "gh", "pr", "edit", "12", "--repo", "o/n", "--title", "New title", "--body", "New body"]);
    expect(res.code).toBe(0);
    const [rec] = listOutboundIn(door);
    expect(rec).toMatchObject({ kind: "gh-pr-body", status: "ready", title: "New title", draft: "New body", target: { repo: "o/n", pr: 12, baseTitle: "Old title", baseBody: "Old body" } });
    // a title alone leaves the body as GitHub has it
    const only = await hold(door, ["run", "gh", "pr", "edit", "12", "--repo", "o/n", "--title", "Only the title"]);
    expect(only.code, only.stderr).toBe(0);
    expect(listOutboundIn(door).at(-1)).toMatchObject({ title: "Only the title", draft: "Old body" });
    expect(ghCalls(door).every((c) => c.startsWith("pr view"))).toBe(true);
  });

  test("gh pr edit with a PR's URL is a draft against that URL's repository, never the lane's own", async () => {
    const door = makeDoor();
    const res = await hold(door, ["run", "gh", "pr", "edit", "https://github.com/other/place/pull/12", "--body", "New body"]);
    expect(res.code, res.stderr).toBe(0);
    expect(listOutboundIn(door)).toMatchObject([{ kind: "gh-pr-body", target: { repo: "other/place", pr: 12 } }]);
    expect(ghCalls(door)).toEqual(["pr view 12 --repo other/place --json title,body"]);
    // a --repo that names the same repository agrees; one that names another does not, and nothing is drafted
    const same = await hold(door, ["run", "gh", "pr", "edit", "https://github.com/other/place/pull/12/files", "-R", "Other/Place", "--body", "x"]);
    expect(same.code, same.stderr).toBe(0);
    const clash = await hold(door, ["run", "gh", "pr", "edit", "https://github.com/other/place/pull/12", "--repo", "o/n", "--body", "x"]);
    expect(clash.code).toBe(86);
    expect(clash.stderr).toContain("食い違います");
    expect(clash.stdout).toBe("");
    expect(listOutboundIn(door)).toHaveLength(2);
  });

  test("gh pr edit naming no PR is the lane's own PR in the repository it was made in, and another --repo is refused", async () => {
    const door = makeDoor();
    writeFileSync(join(door.state, "lifecycle-demo.jsonl"), `${JSON.stringify({ idd_id: "IDD-1", event: "s4_pr_created", at: "2026-10-27T10:00:00+09:00", attrs: { pr_url: "https://github.com/me/app/pull/7" } })}\n`);
    const clash = await hold(door, ["run", "gh", "pr", "edit", "--repo", "other/place", "--body", "x"]);
    expect(clash.code).toBe(86);
    expect(clash.stderr).toContain("PR の番号か URL を指定してください");
    expect(clash.stdout).toBe("");
    expect(listOutboundIn(door)).toEqual([]);
    expect(ghCalls(door)).toEqual([]);
    // the same repository (in any case) or none: the pair is the lane's own PR
    const same = await hold(door, ["run", "gh", "pr", "edit", "-R", "Me/App", "--body", "x"]);
    expect(same.code, same.stderr).toBe(0);
    const bare = await hold(door, ["run", "gh", "pr", "edit", "--body", "y"]);
    expect(bare.code, bare.stderr).toBe(0);
    expect(listOutboundIn(door)).toMatchObject([{ kind: "gh-pr-body", draft: "x", target: { repo: "me/app", pr: 7 } }, { kind: "gh-pr-body", draft: "y", target: { repo: "me/app", pr: 7 } }]);
  });

  test("a reply to a review comment, and to a thread, and the resolve of a thread, are gh-pr-replies drafts at the PR's head", async () => {
    const door = makeDoor();
    const reply = await hold(door, ["run", "gh", "api", "repos/o/n/pulls/3/comments/5/replies", "-f", "body=Fixed in the next commit"]);
    expect(reply.code, reply.stderr).toBe(0);
    const thread = await hold(door, ["run", "gh", "api", "graphql", "-f", "query=mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{url}}}", "-f", "t=PRRT_9", "-f", "b=Done"]);
    expect(thread.code).toBe(0);
    const resolve = await hold(door, ["run", "gh", "api", "graphql", "-f", "query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}", "-f", "t=PRRT_9"]);
    expect(resolve.code).toBe(0);
    const recs = listOutboundIn(door);
    expect(recs.map((r) => r.kind)).toEqual(["gh-pr-replies", "gh-pr-replies", "gh-pr-replies"]);
    expect(recs[0]).toMatchObject({ status: "ready", target: { repo: "o/n", pr: 3, expectHead: "abc123def" } });
    expect(recs[0].parts?.[0]).toMatchObject({ draft: "Fixed in the next commit", quote: "please fix this", label: "rev", resolve: false });
    // the REST comment id is kept, so the signed reply goes under that comment, not into the PR's conversation
    expect(recs[0].parts?.[0].comment_id).toBe("5");
    expect(recs[0].parts?.[0].thread_id).toBeUndefined();
    expect(recs[1]).toMatchObject({ target: { repo: "o/n", pr: 3, expectHead: "def456" } });
    expect(recs[1].parts?.[0]).toMatchObject({ thread_id: "PRRT_9", draft: "Done", resolve: false });
    expect(recs[2].parts?.[0]).toMatchObject({ thread_id: "PRRT_9", draft: "", resolve: true });
    expect(resolve.stdout).toContain("返信の本文をカードに書いたうえで");
    expect(ghCalls(door).every((c) => c.startsWith("pr view") || c.startsWith("api"))).toBe(true);
    expect(ghCalls(door).some((c) => c.includes("mutation"))).toBe(false);
  });

  test("a draft that cannot be made is not a success", async () => {
    const door = makeDoor();
    const res = await hold(door, ["run", "gh", "api", "repos/o/n/pulls/3/comments/7/replies", "-f", "body=x"]);
    expect(res.code).toBe(86);
    expect(res.stderr).toContain("預かりを記録できませんでした");
    expect(res.stdout).toBe("");
    expect(listOutboundIn(door)).toEqual([]);
  });
});

describe("the lane reads its own holds from one door, and a follow-up check waits", () => {
  test("status returns this lane's holds and drafts only, with where each stands", async () => {
    const door = makeDoor();
    writeFileSync(join(door.state, "boundary-holds.jsonl"), [
      { id: "HOLD-a", idd_id: "IDD-1", kind: "push", at: "2026-10-26T01:00:00.000Z" },
      { id: "HOLD-b", idd_id: "IDD-2", kind: "push", at: "2026-10-26T01:01:00.000Z" },
      { id: "HOLD-c", idd_id: "IDD-1", kind: "pr-create", at: "2026-10-26T01:02:00.000Z", title: "T", body: "B" },
    ].map((h) => JSON.stringify(h)).join("\n") + "\n");
    await hold(door, ["run", "gh", "issue", "create", "--repo", "o/n", "--title", "Mine"]);
    await hold(door, ["run", "gh", "issue", "create", "--repo", "o/n", "--title", "Theirs"], { IDD_ID: "IDD-2" });
    const res = await hold(door, ["status"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as { lane: string; holds: { id: string; kind: string; state: string; title?: string }[]; next: string };
    expect(out.lane).toBe("IDD-1");
    expect(out.holds.map((h) => h.kind).sort()).toEqual(["gh-issue", "pr-create", "push"]);
    expect(out.holds.map((h) => h.id)).not.toContain("HOLD-b");
    expect(out.holds.some((h) => h.title === "Theirs")).toBe(false);
    expect(out.holds.every((h) => h.state === "held" || h.state === "card_open")).toBe(true);
    expect(out.holds.find((h) => h.kind === "gh-issue")?.state).toBe("card_open");
    expect(out.next).toBe(WAIT_SENTENCE);
    // the lane is the environment's: there is no argument that names another
    const other = await hold(door, ["status", "IDD-2"], { IDD_ID: "IDD-1" });
    expect(JSON.parse(other.stdout).lane).toBe("IDD-1");
    const none = await hold(door, ["status"], { IDD_ID: "" });
    expect(none.code).not.toBe(0);
  });

  test("a follow-up check is not run once something is handed over, and says to wait; before that it is the real command's", async () => {
    const door = makeDoor();
    const before = await hold(door, ["run", "gh", "pr", "checks", "3"]);
    expect(before.code).toBe(87);
    await hold(door, ["run", "gh", "issue", "create", "--repo", "o/n", "--title", "Something"]);
    for (const args of [["pr", "checks", "3"], ["pr", "status"], ["run", "list"], ["run", "watch", "1"]]) {
      const res = await hold(door, ["run", "gh", ...args]);
      expect(res.code, args.join(" ")).toBe(86);
      expect(res.stderr, args.join(" ")).toContain(WAIT_SENTENCE);
      expect(res.stdout, args.join(" ")).toBe("");
    }
    // another lane that handed nothing over, and a lane that is not an Issue lane, read the real command
    expect((await hold(door, ["run", "gh", "pr", "checks", "3"], { IDD_ID: "IDD-2" })).code).toBe(87);
    expect((await hold(door, ["run", "gh", "pr", "checks", "3"], { IDD_ID: "R-9" })).code).toBe(87);
    expect(ghCalls(door).some((c) => c.startsWith("pr checks") || c.startsWith("run"))).toBe(false);
  });
});
