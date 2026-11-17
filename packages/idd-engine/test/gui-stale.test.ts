import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { guiStaleView, readStaleness, rememberEngineStart, resetStaleness } from "../src/server/staleness.ts";
import { guiBuildUnit, guiServing, refreshGuiStale, requestGuiBuild, resetGuiBuild, setGuiRunner } from "../src/server/gui-build.ts";
import { GUI_BUILD_RECORD_FILE, GUI_STAMP_FILE } from "@idd/lane";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

const ENV_KEYS = ["IDD_GUI_BUILD", "IDD_GUI_UNIT", "IDD_LANE_ROOT", "IDD_STATE_DIR", "IDD_GUI_BUILD_RUNNING_MS"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetStaleness();
  resetGuiBuild();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetStaleness();
  resetGuiBuild();
});

/** a checkout the engine started on, then advanced; `write` makes the next commit */
function checkout() {
  const repo = tmpDir("idd-gui-stale-repo-");
  const state = tmpDir("idd-gui-stale-state-");
  process.env.IDD_LANE_ROOT = repo;
  process.env.IDD_STATE_DIR = state;
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  const write = (path: string, text: string) => {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    g("add", "-A");
    g("commit", "-q", "-m", path);
  };
  write("README.md", "base");
  rememberEngineStart({ root: repo });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  return { repo, state, write, base, head: () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() };
}

/** a bundle on disk, outside the checkout (so a commit in the checkout never picks it up), stamped with a commit or with none */
function bundle(commit: string | null) {
  const dist = tmpDir("idd-gui-stale-dist-");
  if (commit) writeFileSync(join(dist, GUI_STAMP_FILE), `${JSON.stringify({ commit })}\n`);
  return dist;
}

/** systemd-run stood in for: the calls are recorded */
function fakeSystemdRun() {
  const calls: string[][] = [];
  return { calls, runner: (_cmd: string, args: string[]) => { calls.push(args); return { status: 0, stdout: "", stderr: "" }; } };
}

describe("asking for a rebuild of the screen's bundle", () => {
  test("asks once for the head when the engine was replaced and the bundle is from before it", () => {
    const { repo, write, base } = checkout();
    write("packages/idd-gui/src/main.tsx", "x");
    // the engine is replaced: it starts on the new head, and the bundle on disk is still the earlier commit's
    rememberEngineStart({ root: repo });
    readStaleness({ root: repo });
    const dist = bundle(base);
    const sys = fakeSystemdRun();
    setGuiRunner(sys.runner);
    refreshGuiStale({ dist });
    expect(guiStaleView().stale).toBe(true);
    expect(guiServing(dist).ok).toBe(false);
    expect(requestGuiBuild()).toBe(true);
    expect(sys.calls.length).toBe(1);
    expect(sys.calls[0]).toContain("gui-build");
    expect(sys.calls[0].some((a) => a.includes(guiBuildUnit(process.env.IDD_STATE_DIR!)))).toBe(true);
    // the same head is not asked again
    expect(requestGuiBuild()).toBe(false);
    expect(sys.calls.length).toBe(1);
  });

  test("asks when the bundle carries no commit, and serves nothing from it", () => {
    const { repo } = checkout();
    readStaleness({ root: repo });
    const dist = bundle(null);
    const sys = fakeSystemdRun();
    setGuiRunner(sys.runner);
    refreshGuiStale({ dist });
    expect(guiServing(dist).ok).toBe(false);
    expect(requestGuiBuild()).toBe(true);
    expect(sys.calls.length).toBe(1);
  });

  test("asks when only the screen's own code changed, since the engine keeps running and the old bundle is still its own", () => {
    const { repo, write, base } = checkout();
    write("packages/idd-gui/src/main.tsx", "x");
    readStaleness({ root: repo });
    const dist = bundle(base);
    const sys = fakeSystemdRun();
    setGuiRunner(sys.runner);
    refreshGuiStale({ dist });
    // the bundle is the engine's commit, so it is still served while the new one is built
    expect(guiServing(dist).ok).toBe(true);
    expect(requestGuiBuild()).toBe(true);
    expect(sys.calls.length).toBe(1);
  });

  test("does not ask while the engine's own replacement is pending: a bundle built now would be newer than the engine and refused", () => {
    const { repo, write, base } = checkout();
    write("packages/idd-engine/src/server/state.ts", "x");
    write("packages/idd-gui/src/main.tsx", "x");
    readStaleness({ root: repo });
    const dist = bundle(base);
    const sys = fakeSystemdRun();
    setGuiRunner(sys.runner);
    refreshGuiStale({ dist });
    expect(requestGuiBuild()).toBe(false);
    expect(sys.calls.length).toBe(0);
  });

  test("does not ask while the bundle is the head's, or when nothing the screen reads changed", () => {
    const { repo, write, base } = checkout();
    write("_docs/x.md", "x");
    readStaleness({ root: repo });
    const sys = fakeSystemdRun();
    setGuiRunner(sys.runner);
    const old = bundle(base);
    refreshGuiStale({ dist: old });
    expect(guiStaleView().stale).toBe(false);
    expect(requestGuiBuild()).toBe(false);

    write("packages/idd-gui/src/main.tsx", "y");
    rememberEngineStart({ root: repo });
    const head = readStaleness({ root: repo })!.head!;
    const fresh = bundle(head);
    refreshGuiStale({ dist: fresh });
    expect(guiStaleView().stale).toBe(false);
    expect(guiServing(fresh).ok).toBe(true);
    expect(requestGuiBuild()).toBe(false);
    expect(sys.calls.length).toBe(0);
  });

  test("does not ask when the automatic build is turned off", () => {
    const { repo, write, base } = checkout();
    write("packages/idd-gui/src/main.tsx", "x");
    readStaleness({ root: repo });
    const sys = fakeSystemdRun();
    setGuiRunner(sys.runner);
    process.env.IDD_GUI_BUILD = "off";
    refreshGuiStale({ dist: bundle(base) });
    expect(requestGuiBuild()).toBe(false);
    expect(sys.calls.length).toBe(0);
  });

  test("does not show a build as running forever when the build that wrote the record was cut off", () => {
    const { repo, write, base } = checkout();
    write("packages/idd-gui/src/main.tsx", "x");
    readStaleness({ root: repo });
    process.env.IDD_GUI_BUILD_RUNNING_MS = "1000";
    writeFileSync(join(process.env.IDD_STATE_DIR!, GUI_BUILD_RECORD_FILE), JSON.stringify({ startedAt: new Date(Date.now() - 60 * 60_000).toISOString(), outcome: "running" }));
    refreshGuiStale({ dist: bundle(base) });
    const gui = guiStaleView();
    expect(gui.building).toBeUndefined();
    expect(gui.failed?.kind).toBe("interrupted");
  });

  test("a failed rebuild leaves the earlier bundle unserved when the engine was replaced, and the refusal says so", () => {
    const { repo, write, base } = checkout();
    write("packages/idd-gui/src/main.tsx", "x");
    rememberEngineStart({ root: repo });
    readStaleness({ root: repo });
    writeFileSync(join(process.env.IDD_STATE_DIR!, GUI_BUILD_RECORD_FILE), JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), outcome: "failed", exitCode: 2 }));
    const dist = bundle(base);
    refreshGuiStale({ dist });
    expect(guiStaleView().failed?.kind).toBe("build");
    const serving = guiServing(dist);
    expect(serving.ok).toBe(false);
    if (!serving.ok) expect(serving.reason).toContain("直近の作り直しに失敗しました（終了 2");
  });

  test("a failed rebuild stops serving the earlier bundle even though it carries the engine's own stamp", () => {
    const { repo, write, base } = checkout();
    // only the screen's code moved: the engine keeps running, and the bundle on disk is still the engine's commit
    write("packages/idd-gui/src/main.tsx", "x");
    readStaleness({ root: repo });
    const dist = bundle(base);
    refreshGuiStale({ dist });
    expect(guiServing(dist).ok).toBe(true);
    writeFileSync(join(process.env.IDD_STATE_DIR!, GUI_BUILD_RECORD_FILE), JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), outcome: "failed", exitCode: 3 }));
    refreshGuiStale({ dist });
    const serving = guiServing(dist);
    expect(serving.ok).toBe(false);
    if (!serving.ok) expect(serving.reason).toContain("直近の作り直しに失敗しました（終了 3");
    // a rebuild that succeeds later makes the head's bundle served again, with no wait for the next tick
    const fresh = bundle(readStaleness({ root: repo })!.head!);
    expect(guiServing(fresh).ok).toBe(true);
  });

  test("shows no failure once the bundle is the head's again", () => {
    const { repo, write } = checkout();
    write("packages/idd-gui/src/main.tsx", "x");
    rememberEngineStart({ root: repo });
    const head = readStaleness({ root: repo })!.head!;
    writeFileSync(join(process.env.IDD_STATE_DIR!, GUI_BUILD_RECORD_FILE), JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), outcome: "failed", exitCode: 1 }));
    refreshGuiStale({ dist: bundle(head) });
    expect(guiStaleView().stale).toBe(false);
    expect(guiStaleView().failed).toBeUndefined();
  });
});
