import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { engineStaleView, openConversationsView, readStaleness, reloadWaitSinceValue, rememberEngineStart, resetStaleness, waitingRequestsView } from "../src/server/staleness.ts";
import {
  beginRequest, checkNow, closeAndReload, endRequest, intakeHold, isReloading, reloadRefusal, requestCount,
  resetReload, setCloseConversations, setConversationProvider, setParentPid, setReloadRunner, setStartupCheck,
} from "../src/server/reload.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

const ENV_KEYS = ["IDD_RELOAD", "IDD_ENGINE_UNIT", "IDD_RELOAD_QUIET_MS", "IDD_RELOAD_INTERVAL_MS", "IDD_RELOAD_WINDOW_MS", "IDD_RELOAD_RETRY_MS", "IDD_STATE_DIR", "IDD_ROLES_FILE"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetStaleness();
  resetReload();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetStaleness();
  resetReload();
});

/** a checkout the engine started on, then advanced under it: the engine is behind by one shared-code commit */
function staleCheckout() {
  const repo = tmpDir("idd-reload-repo-");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  const write = (path: string, text: string) => {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  const commit = (message: string) => {
    g("add", "-A");
    g("commit", "-q", "-m", message);
  };
  write("packages/a.ts", "a");
  commit("base");
  rememberEngineStart({ root: repo });
  write("packages/a.ts", "b");
  commit("change the engine's code");
  readStaleness({ root: repo });
  return { repo, write, commit, g };
}

/** systemd and the build command stood in for: the calls are recorded, no real process is asked */
function fakeShell(opts: { mainPid?: number | null; restartStatus?: number } = {}) {
  const calls: string[][] = [];
  const mainPid = opts.mainPid === undefined ? process.pid : opts.mainPid;
  const runner = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (args.includes("--value")) {
      return mainPid === null ? { status: 1, stdout: "", stderr: "cannot" } : { status: 0, stdout: `${mainPid}\n`, stderr: "" };
    }
    return { status: opts.restartStatus ?? 0, stdout: "", stderr: opts.restartStatus ? "boom" : "" };
  };
  return { calls, runner, restarts: () => calls.filter((c) => c.includes("restart")).length };
}

/** a stand-in for the parent pid: fixed, so the test's real parent never decides the outcome by accident */
const FIXED_PARENT_PID = 424242;

function quietEngine(shell: ReturnType<typeof fakeShell>) {
  setReloadRunner(shell.runner);
  setParentPid(() => FIXED_PARENT_PID);
  setConversationProvider(() => []);
  setStartupCheck(() => ({ ok: true }));
}

/** the pid of this test process's parent's parent, from /proc, so the stand-in is a real ancestor */
function realGrandparentPid(): number {
  const stat = readFileSync(`/proc/${process.ppid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}

describe("the reload's judgment", () => {
  test("names the oldest request and its wait in the hold, and publishes the requests for the card", async () => {
    staleCheckout();
    const shell = fakeShell();
    quietEngine(shell);
    beginRequest(new Request("http://127.0.0.1:30144/api/idd/tick", { method: "POST" }));
    // a second request that started a little later: the oldest is the one named
    await new Promise((r) => setTimeout(r, 20));
    beginRequest(new Request("http://127.0.0.1:30144/api/idd/state"));
    const held = await checkNow(Date.now() + 12 * 60_000 + 5_000);
    expect(held.action).toBe("hold");
    expect(held.reason).toContain("処理中の要求 2 件");
    expect(held.reason).toContain("POST /api/idd/tick");
    expect(held.reason).toContain("12 分");
    expect(engineStaleView().hold ?? "").toContain("POST /api/idd/tick");
    // the published requests are what the card lists, oldest first and marked as still running
    const views = waitingRequestsView();
    expect(views.length).toBe(2);
    expect(views[0].method).toBe("POST");
    expect(views[0].path).toBe("/api/idd/tick");
    expect(views[0].sending).toBe(false);
    expect(views[1].path).toBe("/api/idd/state");
  });

  test("keeps the hold to the count when the oldest request carries no destination", async () => {
    staleCheckout();
    const shell = fakeShell();
    quietEngine(shell);
    beginRequest();
    const held = await checkNow(Date.now() + 12 * 60_000 + 5_000);
    expect(held.action).toBe("hold");
    expect(held.reason).toContain("処理中の要求 1 件");
    expect(held.reason).not.toContain("最も古いもの");
    // nothing to list: a count without a destination never reaches the card
    expect(waitingRequestsView()).toEqual([]);
    endRequest();
  });

  test("publishes no waiting requests when the engine is not behind its checkout", async () => {
    const { repo } = staleCheckout();
    const shell = fakeShell();
    quietEngine(shell);
    // the start moved forward to the head: the engine is no longer stale, though a request is still running
    rememberEngineStart({ root: repo });
    readStaleness({ root: repo });
    beginRequest(new Request("http://127.0.0.1:30144/api/idd/tick", { method: "POST" }));
    const out = await checkNow();
    expect(out.action).toBe("fresh");
    expect(waitingRequestsView()).toEqual([]);
    endRequest();
  });

  test("asks systemd for the restart when stale, quiet, and the unit's main process", async () => {
    staleCheckout();
    const shell = fakeShell();
    quietEngine(shell);
    const outcome = await checkNow();
    expect(outcome.action).toBe("reload");
    expect(shell.restarts()).toBe(1);
    expect(isReloading()).toBe(true);
    // a request that arrives after the ask is refused before it is handled, with the mark the CLI retries on
    expect(beginRequest()).toBe(false);
    const res = reloadRefusal();
    expect(res.status).toBe(503);
    expect((await res.json()).reloading).toBe(true);
  });

  test("does not ask while conversations are open, and asks once they close", async () => {
    staleCheckout();
    const shell = fakeShell();
    setReloadRunner(shell.runner);
    setStartupCheck(() => ({ ok: true }));
    let open = [{ sessionId: "s1", title: "会話", mode: "chat" }];
    setConversationProvider(() => open);
    const held = await checkNow();
    expect(held.action).toBe("hold");
    expect(held.reason).toContain("開いている会話");
    expect(shell.restarts()).toBe(0);
    // the wait's start is remembered for the card, and the list is published for it
    expect(reloadWaitSinceValue()).toBeGreaterThan(0);
    expect(openConversationsView()).toEqual([{ sessionId: "s1", title: "会話", mode: "chat" }]);
    // nothing closes a conversation by itself (INV-2161)
    open = [];
    const done = await checkNow();
    expect(done.action).toBe("reload");
    expect(shell.restarts()).toBe(1);
    expect(reloadWaitSinceValue()).toBeNull();
  });

  test("does not ask while a request is being answered, and asks after it", async () => {
    staleCheckout();
    const shell = fakeShell();
    quietEngine(shell);
    expect(beginRequest()).toBe(true);
    const held = await checkNow();
    expect(held.action).toBe("hold");
    expect(held.reason).toContain("処理中の要求");
    expect(shell.restarts()).toBe(0);
    endRequest();
    const after = await checkNow();
    expect(after.action).toBe("reload");
  });

  test("asks systemd for the restart when the unit's main process is this process's parent", async () => {
    staleCheckout();
    const shell = fakeShell({ mainPid: FIXED_PARENT_PID });
    quietEngine(shell);
    const outcome = await checkNow();
    expect(outcome.action).toBe("reload");
    expect(shell.restarts()).toBe(1);
    expect(isReloading()).toBe(true);
  });

  test("never asks when the unit's main process is a further ancestor, not the direct parent", async () => {
    staleCheckout();
    const grandparent = realGrandparentPid();
    const shell = fakeShell({ mainPid: grandparent });
    setReloadRunner(shell.runner);
    setParentPid(() => process.ppid);
    setConversationProvider(() => []);
    setStartupCheck(() => ({ ok: true }));
    const held = await checkNow();
    expect(held.action).toBe("hold");
    expect(held.reason).toContain("主 process");
    expect(shell.restarts()).toBe(0);
    // the hold's reason names the engine, its parent, and the main process, so the next such hold is readable
    const reason = engineStaleView().hold ?? "";
    expect(reason).toContain(String(process.pid));
    expect(reason).toContain(String(process.ppid));
    expect(reason).toContain(String(grandparent));
    // the engine keeps serving
    expect(beginRequest()).toBe(true);
    endRequest();
  });

  test("never asks for the restart when this is not the unit's main process", async () => {
    staleCheckout();
    const shell = fakeShell({ mainPid: 987654 });
    quietEngine(shell);
    const held = await checkNow();
    expect(held.action).toBe("hold");
    expect(held.reason).toContain("主 process");
    expect(shell.restarts()).toBe(0);
    // the engine keeps serving, and the state still says it is behind (INV-2163)
    expect(beginRequest()).toBe(true);
    endRequest();
    expect(engineStaleView().stale).toBe(true);
    expect(engineStaleView().hold).toContain("主 process");
  });

  test("never asks when the unit's main process cannot be read", async () => {
    staleCheckout();
    const shell = fakeShell({ mainPid: null });
    quietEngine(shell);
    const held = await checkNow();
    expect(held.action).toBe("hold");
    expect(held.reason).toContain("確かめられない");
    expect(shell.restarts()).toBe(0);
  });

  test("does not ask for code that cannot start, and checks a head only once", async () => {
    const { write, commit, repo } = staleCheckout();
    const shell = fakeShell();
    setReloadRunner(shell.runner);
    setConversationProvider(() => []);
    let checks = 0;
    setStartupCheck(() => {
      checks += 1;
      return { ok: false, detail: "cannot import" };
    });
    const held = await checkNow();
    expect(held.action).toBe("hold");
    expect(held.reason).toContain("起動の確かめ");
    expect(shell.restarts()).toBe(0);
    await checkNow();
    expect(checks).toBe(1);
    // the head moved: the new commit is checked on its own
    write("packages/a.ts", "c");
    commit("another change");
    readStaleness({ root: repo });
    await checkNow();
    expect(checks).toBe(2);
  });

  test("keeps serving when the restart cannot be asked for", async () => {
    staleCheckout();
    const shell = fakeShell({ restartStatus: 1 });
    quietEngine(shell);
    const held = await checkNow();
    expect(held.action).toBe("hold");
    expect(held.reason).toContain("再起動を頼めませんでした");
    expect(isReloading()).toBe(false);
    expect(beginRequest()).toBe(true);
    endRequest();
  });

  test("drops the reloading window and keeps serving when the restart never comes", async () => {
    staleCheckout();
    process.env.IDD_RELOAD_WINDOW_MS = "20";
    process.env.IDD_RELOAD_RETRY_MS = "5000";
    const shell = fakeShell();
    quietEngine(shell);
    expect((await checkNow()).action).toBe("reload");
    expect(isReloading()).toBe(true);
    expect(beginRequest()).toBe(false);
    // the process should have been replaced within the window; since it is still here, requests must be taken again
    await new Promise((r) => setTimeout(r, 60));
    expect(isReloading()).toBe(false);
    expect(beginRequest()).toBe(true);
    endRequest();
    // and the failure is on the state, so the screen shows why the engine is still old
    const held = await checkNow();
    expect(held.action).toBe("hold");
    expect(engineStaleView().hold ?? "").toContain("入れ替えが来ませんでした");
    // while the retry's clock runs, the restart is not asked for again
    expect(shell.restarts()).toBe(1);
  });

  test("asks for the restart again after a restart that never came, once the retry's clock has passed", async () => {
    staleCheckout();
    process.env.IDD_RELOAD_WINDOW_MS = "20";
    process.env.IDD_RELOAD_RETRY_MS = "150";
    const shell = fakeShell();
    quietEngine(shell);
    expect((await checkNow()).action).toBe("reload");
    await new Promise((r) => setTimeout(r, 50));
    expect(isReloading()).toBe(false);
    expect((await checkNow()).action).toBe("hold");
    expect(shell.restarts()).toBe(1);
    await new Promise((r) => setTimeout(r, 250));
    expect((await checkNow()).action).toBe("reload");
    expect(shell.restarts()).toBe(2);
  });

  test("asks even while a lane's agent is running: the judgment reads conversations, not lanes", async () => {
    const state = tmpDir("idd-reload-state-");
    process.env.IDD_STATE_DIR = state;
    writeFileSync(join(state, "roles.yaml"), "models:\n  x-y:\n    model: x/y\nroles:\n  r: { model: x-y }\n");
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    const lane = JSON.stringify({ idd_id: "IDD-1", parent_id: null, created_at: "2026-10-05T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "T", area: "Demo" });
    writeFileSync(join(state, "backlog.jsonl"), `${lane}\n`);
    writeFileSync(join(state, "lifecycle-Demo.jsonl"), `${JSON.stringify({ idd_id: "IDD-1", event: "s2_start", at: "2026-10-05T00:00:00Z", attrs: {} })}\n`);
    writeFileSync(join(state, "executor-sessions.jsonl"), `${JSON.stringify({ idd_id: "IDD-1", executor_session_id: "E1", worktree_path: join(state, "none") })}\n`);
    const { buildState } = await import("../src/server/state.ts");
    // a lane is actively working, but no conversation is open: that must not hold the restart back
    expect(buildState({ liveSessions: new Set(["E1"]) }).lanes[0]?.activity).toBe("live");

    staleCheckout();
    const shell = fakeShell();
    quietEngine(shell);
    const outcome = await checkNow();
    expect(outcome.action).toBe("reload");
    expect(shell.restarts()).toBe(1);
  });
});

describe("the close-and-reload door", () => {
  test("closes the open conversations and then asks for the restart", async () => {
    staleCheckout();
    const shell = fakeShell();
    setReloadRunner(shell.runner);
    setStartupCheck(() => ({ ok: true }));
    let open = [{ sessionId: "s1", title: "会話", mode: "chat" }];
    setConversationProvider(() => open);
    setCloseConversations(async () => {
      open = [];
      return ["s1"];
    });
    const { closed } = await closeAndReload();
    expect(closed).toEqual(["s1"]);
    expect(shell.restarts()).toBe(1);
  });

  test("does not ask until the request that asked for it is answered", async () => {
    staleCheckout();
    const shell = fakeShell();
    quietEngine(shell);
    setCloseConversations(async () => ["s1"]);
    // a request is in flight (the door's own, through the server): the restart waits for the answer to be sent
    expect(beginRequest()).toBe(true);
    await closeAndReload();
    expect(shell.restarts()).toBe(0);
    endRequest();
    expect(requestCount()).toBe(0);
    const after = await checkNow();
    expect(after.action).toBe("reload");
    expect(shell.restarts()).toBe(1);
  });
});

describe("holding the intake and the planners while a replacement is on its way", () => {
  test("holds when the checkout is ahead by an engine-effective change and the unit's engine can be replaced", () => {
    staleCheckout();
    const shell = fakeShell();
    quietEngine(shell);
    const held = intakeHold();
    expect(held.hold).toBe(true);
    expect(held.reason ?? "").toContain("入れ替え");
  });

  test("holds while an open conversation waits, and the wait has no time limit", async () => {
    staleCheckout();
    const shell = fakeShell();
    setReloadRunner(shell.runner);
    setStartupCheck(() => ({ ok: true }));
    setConversationProvider(() => [{ sessionId: "s1", title: "会話" }]);
    expect((await checkNow()).action).toBe("hold");
    expect(intakeHold().hold).toBe(true);
    // hours later the conversation still waits: the hold is not lifted by time
    expect(intakeHold(Date.now() + 3 * 60 * 60_000).hold).toBe(true);
  });

  test("does not hold when the automatic replacement is off", async () => {
    staleCheckout();
    process.env.IDD_RELOAD = "off";
    const shell = fakeShell();
    quietEngine(shell);
    expect((await checkNow()).reason ?? "").toContain("IDD_RELOAD=off");
    expect(intakeHold().hold).toBe(false);
  });

  test("does not hold when this engine is not one the unit started", () => {
    staleCheckout();
    const shell = fakeShell({ mainPid: 987654 });
    quietEngine(shell);
    expect(intakeHold().hold).toBe(false);
  });

  test("does not hold when the new head's code failed its startup check", async () => {
    staleCheckout();
    const shell = fakeShell();
    setReloadRunner(shell.runner);
    setParentPid(() => FIXED_PARENT_PID);
    setConversationProvider(() => []);
    setStartupCheck(() => ({ ok: false, detail: "cannot import" }));
    // a head not checked yet counts as coming; the judgment makes the check and it does not
    expect(intakeHold().hold).toBe(true);
    await checkNow();
    expect(intakeHold().hold).toBe(false);
  });

  test("does not hold when the start commit cannot be read", () => {
    // a place that is not a git checkout: the start's commit cannot be read, so nothing is replaced or held
    const notARepo = tmpDir("idd-reload-norepo-");
    rememberEngineStart({ root: notARepo });
    expect(engineStaleView().unknown).toBe(true);
    expect(intakeHold().hold).toBe(false);
  });

  test("does not hold once a restart it asked for never came", async () => {
    staleCheckout();
    process.env.IDD_RELOAD_WINDOW_MS = "20";
    process.env.IDD_RELOAD_RETRY_MS = "5000";
    const shell = fakeShell();
    quietEngine(shell);
    expect((await checkNow()).action).toBe("reload");
    await new Promise((r) => setTimeout(r, 60));
    expect(intakeHold().hold).toBe(false);
  });

  test("does not hold when the restart could not be asked for at this head", async () => {
    staleCheckout();
    const shell = fakeShell({ restartStatus: 1 });
    quietEngine(shell);
    expect((await checkNow()).action).toBe("hold");
    expect(intakeHold().hold).toBe(false);
  });

  test("does not hold when the head only changed paths the engine never reads again", () => {
    const repo = tmpDir("idd-reload-docs-");
    const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    };
    write("_docs/qa/x.md", "a");
    g("add", "-A");
    g("commit", "-q", "-m", "base");
    rememberEngineStart({ root: repo });
    write("_docs/qa/x.md", "b");
    g("add", "-A");
    g("commit", "-q", "-m", "records only");
    readStaleness({ root: repo });
    const shell = fakeShell();
    quietEngine(shell);
    expect(engineStaleView().stale).toBe(false);
    expect(intakeHold().hold).toBe(false);
  });
});
