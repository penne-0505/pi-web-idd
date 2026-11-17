import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GUI_BUILD_COMMAND, GUI_BUILD_RECORD_FILE, GUI_STAMP_FILE, guiBundleDir, readBundleCommit, runGuiBuild } from "../src/gui-build.ts";
import { tmpDir } from "./helpers/tmp.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI_PACKAGE = resolve(HERE, "..", "..", "idd-gui");

/** a checkout with a commit; `state` is outside it, as in the real repo */
function tempRepo() {
  const root = tmpDir("idd-gui-build-");
  const state = tmpDir("idd-gui-build-state-");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  writeFileSync(join(root, ".gitignore"), "packages/idd-gui/dist/\npackages/idd-gui/dist.next/\npackages/idd-gui/dist.old/\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, state, g, head };
}

/** the bundle on disk stamped with `commit`, as the build leaves it */
function stamped(root: string, commit: string) {
  const dist = guiBundleDir(root);
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<html></html>");
  writeFileSync(join(dist, GUI_STAMP_FILE), `${JSON.stringify({ commit })}\n`);
}

/** the build stood in for: every call is recorded, and the stand-in writes the stamp it is told to */
function fakeBuild(root: string, opts: { status?: number; stampWith?: string } = {}) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const run = (cmd: string, args: string[], o?: { cwd?: string }) => {
    calls.push({ cmd, args, cwd: o?.cwd });
    if ((opts.status ?? 0) === 0 && opts.stampWith) stamped(root, opts.stampWith);
    return { status: opts.status ?? 0 };
  };
  return { calls, run };
}

const env = (state: string): NodeJS.ProcessEnv => ({ IDD_STATE_DIR: state, PATH: process.env.PATH });

afterEach(() => {
  delete process.env.IDD_GUI_UNIT;
});

describe("the screen's build command", () => {
  test("builds the bundle when it is not the head's, and records it", async () => {
    const { root, state, head } = tempRepo();
    stamped(root, "a".repeat(40));
    const shell = fakeBuild(root, { stampWith: head });
    const record = await runGuiBuild({ root, env: env(state), run: shell.run });
    expect(record.outcome).toBe("built");
    expect(record.head).toBe(head);
    expect(shell.calls).toEqual([{ cmd: GUI_BUILD_COMMAND[0], args: [...GUI_BUILD_COMMAND.slice(1)], cwd: root }]);
    expect(readBundleCommit(guiBundleDir(root))).toBe(head);
    const written = JSON.parse(readFileSync(join(state, GUI_BUILD_RECORD_FILE), "utf8"));
    expect(written.outcome).toBe("built");
    // the build only runs the bundle's own script: no restart of any unit is asked for
    expect(shell.calls.every((c) => c.cmd !== "systemctl")).toBe(true);
    // nothing the build touched is left in the checkout (INV-2166)
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe("");
  });

  test("builds when there is no bundle at all", async () => {
    const { root, state, head } = tempRepo();
    const shell = fakeBuild(root, { stampWith: head });
    const record = await runGuiBuild({ root, env: env(state), run: shell.run });
    expect(record.outcome).toBe("built");
    expect(shell.calls.length).toBe(1);
  });

  test("records a failed build with its exit and log, and leaves the earlier bundle as it was", async () => {
    const { root, state } = tempRepo();
    const earlier = "a".repeat(40);
    stamped(root, earlier);
    const shell = fakeBuild(root, { status: 1 });
    const record = await runGuiBuild({ root, env: env(state), run: shell.run });
    expect(record.outcome).toBe("failed");
    expect(record.exitCode).toBe(1);
    expect(record.logPath).toBeTruthy();
    // the command does not touch the bundle: the engine judges it by its own stamp, which still names the earlier commit
    expect(readBundleCommit(guiBundleDir(root))).toBe(earlier);
    const written = JSON.parse(readFileSync(join(state, GUI_BUILD_RECORD_FILE), "utf8"));
    expect(written.outcome).toBe("failed");
    expect(written.exitCode).toBe(1);
  });

  test("skips the build when the bundle is already the head's", async () => {
    const { root, state, head } = tempRepo();
    stamped(root, head);
    const shell = fakeBuild(root);
    const record = await runGuiBuild({ root, env: env(state), run: shell.run });
    expect(record.outcome).toBe("no-change");
    expect(shell.calls.length).toBe(0);
  });
});

describe("the bundle's own build", () => {
  /** the build script copied into a checkout of its own, with a page that builds */
  function guiCheckout() {
    const { root, g, head } = tempRepo();
    const pkg = join(root, "packages", "idd-gui");
    mkdirSync(pkg, { recursive: true });
    copyFileSync(join(GUI_PACKAGE, "build.ts"), join(pkg, "build.ts"));
    writeFileSync(join(pkg, "index.html"), '<!doctype html><html><body><div id="root"></div><script type="module" src="./main.ts"></script></body></html>');
    writeFileSync(join(pkg, "main.ts"), 'document.getElementById("root")!.textContent = "screen";\n');
    g("add", "-A");
    g("commit", "-q", "-m", "gui");
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    void head;
    const build = () => spawnSync("bun", [join(pkg, "build.ts")], { cwd: root, encoding: "utf8" });
    return { root, pkg, commit, build, g };
  }

  test("writes the bundle whole with the commit it was built from, and leaves no half-built place", () => {
    const { root, pkg, commit, build } = guiCheckout();
    const res = build();
    expect(res.status).toBe(0);
    const dist = join(pkg, "dist");
    expect(existsSync(join(dist, "index.html"))).toBe(true);
    expect(readBundleCommit(dist)).toBe(commit);
    expect(existsSync(join(pkg, "dist.next"))).toBe(false);
    expect(existsSync(join(pkg, "dist.old"))).toBe(false);
    // a second build replaces the first one and still leaves one bundle
    expect(build().status).toBe(0);
    expect(readdirSync(dist).filter((n) => n.endsWith(".html")).length).toBe(1);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe("");
  });

  test("a build that fails leaves the earlier bundle in place, with its own stamp", () => {
    const { pkg, commit, build } = guiCheckout();
    expect(build().status).toBe(0);
    const before = readdirSync(join(pkg, "dist")).sort();
    writeFileSync(join(pkg, "main.ts"), 'import "./missing-module";\n');
    const res = build();
    expect(res.status).not.toBe(0);
    expect(readdirSync(join(pkg, "dist")).sort()).toEqual(before);
    expect(readBundleCommit(join(pkg, "dist"))).toBe(commit);
    expect(existsSync(join(pkg, "dist.next"))).toBe(false);
  });

  test("the stamp name the build writes is the one the engine and the command read", () => {
    const source = readFileSync(join(GUI_PACKAGE, "build.ts"), "utf8");
    expect(source).toContain(`const STAMP_FILE = "${GUI_STAMP_FILE}"`);
  });
});
