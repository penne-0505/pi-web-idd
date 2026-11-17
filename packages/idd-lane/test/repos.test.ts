import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fromWork, parseLaneRepos, repoByName, repoForPath, riskPathsLookup } from "../src/repos.ts";
import { parseRepos } from "../../idd-core/src/config/areas.ts";
import { SHIPPED_REPOS, shippedReposTest } from "./helpers/repos.ts";
import { tmpDir } from "./helpers/tmp.ts";

const YAML = `repos:
  Org/app:
    name: app
    upstream: /u/app
    work: /w/app
    public_base: develop
    work_base: main
    review_root: /cache/review-wt
    checks:
      - { name: test, command: "npm test", timeout_minutes: 5 }
  me/tool:
    upstream: /u/tool
    work: /w/tool
    review_root: /cache/review-wt/tool
`;

describe("repos registry", () => {
  test("one entry per project with both clones; short name or GitHub name both resolve", () => {
    const r = parseLaneRepos(YAML);
    expect(Object.keys(r).sort()).toEqual(["app", "tool"]);
    expect(r.app.clone).toBe("/u/app");
    expect(r.app.base).toBe("develop");
    expect(r.app.lanesRoot).toBe("/w/app-lanes");
    expect(repoByName("Org/app", r).name).toBe("app");
    expect(() => parseLaneRepos("repos:\n  x/y: { upstream: /u }")).toThrow(/2 つの clone/);
  });

  test("a check's scope is records only when the registry says so; no scope and an unknown one read as public", () => {
    const text = `repos:\n  me/app:\n    upstream: /u\n    work: /w\n    checks:\n      - { name: a, command: x, scope: records }\n      - { name: b, command: x, scope: public }\n      - { name: c, command: x }\n      - { name: d, command: x, scope: elsewhere }\n`;
    expect(parseLaneRepos(text).app.checks.map((c) => [c.name, c.scope])).toEqual([["a", "records"], ["b", "public"], ["c", "public"], ["d", "public"]]);
  });

  test("paths resolve to the repo with the longest matching root", () => {
    const r = parseLaneRepos(YAML);
    expect(repoForPath("/cache/review-wt/tool/pr-1", r)?.name).toBe("tool");
    expect(repoForPath("/cache/review-wt/pr-9", r)?.name).toBe("app");
    expect(repoForPath("/w/app-lanes/IDD-1", r)?.name).toBe("app");
    expect(repoForPath("/elsewhere", r)).toBeNull();
  });

  shippedReposTest("the shipped config/repos.yaml reads the same declaration on the lane and core readers", () => {
    const text = readFileSync(SHIPPED_REPOS, "utf8");
    const lane = parseLaneRepos(text)["pi-web-idd"];
    const core = parseRepos(text).riskPaths?.["penne-0505/pi-web-idd"];
    expect(lane.riskPaths).toBeDefined();
    expect(lane.riskPaths).toEqual(core);
    for (const kind of ["auth", "authz", "data_loss", "secret"]) expect(lane.riskPaths[kind].length).toBeGreaterThan(0);
    expect(lane.riskPaths.billing).toBeUndefined();
    // the workflow's own paths are a declaration of this repo, not a validator default (2026-10-22)
    for (const path of ["scripts/", ".github/", "_docs/standards/", ".claude/", ".codex/", ".agents/", "skills/propter-", "AGENTS.md", "CLAUDE.md"]) {
      expect(lane.riskPaths.permission).toContain(path);
    }
  });

  shippedReposTest("the shipped repo blocks the land on typecheck, lint and the three test groups (AC-008 / AC-009 / INV-2084)", () => {
    const text = readFileSync(SHIPPED_REPOS, "utf8");
    const repos = parseLaneRepos(text);
    const checks = repos["pi-web-idd"].checks;
    const byName = new Map(checks.map((c) => [c.name, c]));
    for (const name of ["typecheck", "lint", "test:core", "test", "test:lane"]) {
      const check = byName.get(name);
      expect(check, name).toBeDefined();
      expect(check!.required, name).toBe(true);
    }
    for (const name of ["test:core", "test", "test:lane"]) expect(byName.get(name)!.timeoutMinutes, name).toBeGreaterThan(0);
    // another repo's checks are not touched by this lane
    expect(repos["daysai-flutter"].checks.map((c) => c.name)).toEqual(["format", "l10n", "codegen", "analyze", "test"]);
  });

  test("a copy from the work clone uses the work clone and its base, with no fetch", () => {
    const w = fromWork(parseLaneRepos(YAML).app);
    expect([w.clone, w.remote, w.base]).toEqual(["/w/app", "", "main"]);
  });

  test("risk_paths is read by kind, and a kind with no path is left out", () => {
    const r = parseLaneRepos(`repos:
  Org/app:
    name: app
    upstream: /u/app
    work: /w/app
    risk_paths:
      auth: [src/auth/, src/passkey.ts]
      data_loss: [src/migrations/]
`);
    expect(r.app.riskPaths).toEqual({ auth: ["src/auth/", "src/passkey.ts"], data_loss: ["src/migrations/"] });
  });

  test("a missing and an empty risk_paths both mean no declaration", () => {
    const r = parseLaneRepos(`${YAML}  me/empty:\n    upstream: /u/e\n    work: /w/e\n    risk_paths: {}\n`);
    expect(r.app.riskPaths).toBeUndefined();
    expect(r.empty.riskPaths).toBeUndefined();
  });

  test("an unknown kind and a value that is not a list of strings are config errors naming the repo", () => {
    const bad = (body: string) => `repos:\n  Org/app:\n    upstream: /u/app\n    work: /w/app\n    risk_paths:\n${body}`;
    expect(() => parseLaneRepos(bad("      biling: [x]\n"))).toThrow(/Org\/app\.risk_paths\.biling/);
    expect(() => parseLaneRepos(bad("      auth: src/auth.ts\n"))).toThrow(/Org\/app\.risk_paths\.auth/);
    expect(() => parseLaneRepos(bad("      auth: [1]\n"))).toThrow(/Org\/app\.risk_paths\.auth/);
  });
});

describe("repoForPath with a shared review root", () => {
  test("a review copy belongs to the clone it was cut from, not to whichever repo shares its review root", () => {
    const root = tmpDir("idd-shared-root-");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=a@b", "-c", "user.name=a", ...args], { stdio: "ignore" });
    for (const n of ["flutter", "web"]) {
      execFileSync("git", ["init", "-q", join(root, n)]);
      git(join(root, n), "commit", "-q", "--allow-empty", "-m", "init");
    }
    const shared = join(root, "review-wt");
    git(join(root, "web"), "worktree", "add", "-q", join(shared, "REV-web"));
    const repos = parseLaneRepos([
      "repos:",
      `  o/flutter: { name: flutter, upstream: ${join(root, "flutter")}, work: ${join(root, "flutter")}, review_root: ${shared} }`,
      `  o/web: { name: web, upstream: ${join(root, "web")}, work: ${join(root, "web")}, review_root: ${shared} }`,
    ].join("\n"));
    expect(repoForPath(join(shared, "REV-web"), repos)?.name).toBe("web");
    expect(repoForPath(join(root, "flutter"), repos)?.name).toBe("flutter");
  });
});

describe("the lookup of a repo's dangerous paths tells a missing declaration from a failed lookup", () => {
  function registry(text: string): { file: string; root: string } {
    const root = tmpDir("idd-risk-lookup-");
    for (const d of ["a", "b"]) mkdirSync(join(root, d), { recursive: true });
    const file = join(root, "repos.yaml");
    writeFileSync(file, text);
    return { file, root };
  }
  const repos = (root: string) => `repos:\n  o/a:\n    name: a\n    upstream: ${root}/ua\n    work: ${root}/a\n    risk_paths: { permission: [scripts/] }\n  o/b:\n    name: b\n    upstream: ${root}/ub\n    work: ${root}/b\n`;

  test("a declared repo, a repo with none, a path outside the registry, and no registry at all", () => {
    const { file, root } = registry("");
    writeFileSync(file, repos(root));
    expect(riskPathsLookup(join(root, "a"), { registry: file })).toEqual({ kind: "declared", repo: "a", value: JSON.stringify({ permission: ["scripts/"] }) });
    expect(riskPathsLookup(join(root, "b"), { registry: file })).toEqual({ kind: "none", repo: "b" });
    expect(riskPathsLookup("/elsewhere", { registry: file }).kind).toBe("unregistered");
    expect(riskPathsLookup(join(root, "a"), { registry: join(root, "missing.yaml") }).kind).toBe("unregistered");
  });

  test("a registry that cannot be read is broken, not quietly empty", () => {
    const { file, root } = registry("repos: [\n");
    const found = riskPathsLookup(join(root, "a"), { registry: file });
    expect(found.kind).toBe("broken");
  });

  test("on CI the run's repository names the repo for a path inside its checkout only", () => {
    const { file, root } = registry("");
    writeFileSync(file, repos(root));
    const ws = tmpDir("idd-risk-ws-");
    expect(riskPathsLookup(ws, { registry: file, github: "o/a", workspace: ws }).kind).toBe("declared");
    expect(riskPathsLookup(join(ws, "sub"), { registry: file, github: "O/A", workspace: ws }).kind).toBe("declared");
    // a copy outside the checkout (the starter expanded next to it) is not the run's repository
    expect(riskPathsLookup(tmpDir("idd-risk-other-"), { registry: file, github: "o/a", workspace: ws }).kind).toBe("unregistered");
  });
});

