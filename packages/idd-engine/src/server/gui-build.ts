import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot, systemdRunBinary } from "@idd/lane";
import { stateDir } from "@idd/core";
import { engineStaleView, guiBundleVerdict, guiBuildFailureValue, guiBuildingValue, guiStaleForCommit, guiStaleView, setGuiBuildCommit, setGuiBuildFailure, setGuiBuilding, setGuiRunningCommit, setGuiStale, type GuiBundleVerdict } from "./staleness.ts";
import { GUI_BUILD_RECORD_FILE, readBundleCommit } from "@idd/lane";

/**
 * Watching the screen's bundle and asking for a new one.
 *
 * The engine serves the bundle in `packages/idd-gui/dist` itself, so it reads that bundle's own stamp (the commit it
 * was built from) and compares it with the commit it runs and with the checkout's head. A bundle that is not the
 * engine's commit is not served (`guiServing`); a bundle behind the head is rebuilt. The rebuild is asked for through a
 * systemd transient unit: it never runs inside the engine's process, where the engine's own replacement would cut it
 * and where it would count as an in-flight request and hold the replacement back. A new bundle is read from disk on
 * the next request, so nothing restarts.
 */

export type GuiRunner = (cmd: string, args: string[], timeoutMs?: number) => { status: number | null; stdout?: string; stderr?: string; error?: Error };

const defaultRunner: GuiRunner = (cmd, args, timeoutMs = 10_000) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error } : {}) };
};

let runner: GuiRunner = defaultRunner;

/** put a stand-in in for systemd (a test) */
export function setGuiRunner(next: GuiRunner): void {
  runner = next;
}

export function guiBuildOff(): boolean {
  return process.env.IDD_GUI_BUILD?.trim().toLowerCase() === "off";
}

/** the transient unit's name: one per state, so a second ask while one waits is coalesced by systemd */
export function guiBuildUnit(state: string): string {
  return `idd-gui-build-${createHash("sha256").update(state).digest("hex").slice(0, 8)}`;
}

/** how long a "running" record may stand before it is taken as a build that was cut off mid-way */
export function guiBuildRunningLimitMs(): number {
  const raw = Number(process.env.IDD_GUI_BUILD_RUNNING_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000;
}

/** the build's result as the command left it under the state; absent or unreadable means "nothing to show" */
function readBuildRecord(): void {
  // what is shown must be about a bundle that is still behind: once it is the head's, nothing is wrong
  if (!guiStaleView().stale) {
    setGuiBuilding(false);
    setGuiBuildFailure(null);
    return;
  }
  try {
    const rec = JSON.parse(readFileSync(join(stateDir(), GUI_BUILD_RECORD_FILE), "utf8")) as {
      outcome?: string; exitCode?: number; finishedAt?: string; startedAt?: string;
    };
    if (rec.outcome === "running") {
      const started = Date.parse(rec.startedAt ?? "");
      if (Number.isFinite(started) && Date.now() - started > guiBuildRunningLimitMs()) {
        // the build that wrote this record was cut off before it finished: no build is running now, and the record
        // must not show "build 中" forever. The bundle it was replacing is still the one on disk.
        setGuiBuilding(false);
        setGuiBuildFailure({ code: -1, at: rec.startedAt ?? new Date().toISOString(), kind: "interrupted" });
        return;
      }
      setGuiBuilding(true);
      setGuiBuildFailure(null);
      return;
    }
    setGuiBuilding(false);
    const at = rec.finishedAt ?? rec.startedAt ?? new Date().toISOString();
    if (rec.outcome === "failed") setGuiBuildFailure({ code: rec.exitCode ?? -1, at, kind: "build" });
    else setGuiBuildFailure(null);
  } catch {
    setGuiBuilding(false);
    setGuiBuildFailure(null);
  }
}

/**
 * Whether the screen may be served from `dist`: the commit its stamp names is the engine's (see `guiBundleVerdict`),
 * and no rebuild of a bundle that is behind the head has failed. A bundle left over from before a failed rebuild keeps
 * the engine's stamp, so the stamp alone would serve it as if nothing had gone wrong; the failure is judged first and
 * the bundle is refused until a rebuild succeeds. A refusal says why, and says what the last rebuild did.
 */
export function guiServing(dist: string): GuiBundleVerdict {
  const bundle = readBundleCommit(dist);
  const verdict = guiBundleVerdict(bundle);
  const failed = guiBuildFailureValue();
  // the failure counts only while this bundle is still behind the head: a bundle built since then answers the head
  const failedBehind = failed !== null && guiStaleForCommit(bundle);
  if (verdict.ok && !failedBehind) return verdict;
  const detail = guiBuildingValue()
    ? "作り直しています"
    : failed?.kind === "build"
      ? `直近の作り直しに失敗しました（終了 ${failed.code}、log は state の gui-build.log）`
      : failed?.kind === "interrupted"
        ? "直近の作り直しは途中で止まりました"
        : "";
  const base = verdict.ok ? "bundle は head より古く、作り直しが済んでいません" : verdict.reason;
  return { ok: false, reason: detail ? `${base}。${detail}` : base };
}

/**
 * Read the bundle's commit and judge whether the screen is behind the head or cannot be served. Called from the watch
 * tick, never from `startEngine`.
 */
export function refreshGuiStale(opts: { dist?: string } = {}): void {
  const bundle = readBundleCommit(opts.dist ?? defaultDist());
  // what is served is the bundle itself, so the commit the screen "runs" is the bundle's
  setGuiBuildCommit(bundle);
  setGuiRunningCommit(bundle);
  setGuiStale(!guiBundleVerdict(bundle).ok || guiStaleForCommit(bundle));
  readBuildRecord();
}

function defaultDist(): string {
  return join(repoRoot(), "packages", "idd-gui", "dist");
}

let askedHead: string | null = null;

/** the commit a build was last asked for (a test reads it) */
export function askedGuiBuildHead(): string | null {
  return askedHead;
}

/** forget what was asked (a test between cases) */
export function resetGuiBuild(): void {
  askedHead = null;
  runner = defaultRunner;
}

/**
 * Ask for a build when the bundle is behind and this head has not been asked for yet. While the engine itself is
 * behind (its own replacement is pending) no build is asked for: the bundle would then be newer than the engine and
 * be refused, so the new bundle is built after the engine is replaced. The ask is a systemd transient unit running the
 * CLI's `gui-build`; a failure is silent here (the state still shows the screen as stale) and the same head is not
 * asked again until it moves.
 */
export function requestGuiBuild(): boolean {
  if (guiBuildOff()) return false;
  if (!guiStaleView().stale) return false;
  const view = engineStaleView();
  if (view.stale) return false;
  const head = view.head ?? view.startCommit ?? null;
  if (!head || askedHead === head) return false;
  const root = repoRoot();
  const state = stateDir();
  const args = [
    "--user", "--quiet", "--collect", `--unit=${guiBuildUnit(state)}`,
    `--working-directory=${root}`,
    ...(process.env.PATH ? [`--setenv=PATH=${process.env.PATH}`] : []),
    `--setenv=IDD_STATE_DIR=${state}`,
    join(root, "bin", "idd"), "gui-build",
  ];
  let r: ReturnType<GuiRunner>;
  try {
    r = runner(systemdRunBinary(), args);
  } catch {
    return false;
  }
  if (r.status === 0 && !r.error) {
    askedHead = head;
    return true;
  }
  return false;
}

let refreshing = false;

/** the watch tick's work: refresh the judgment, then ask for a build if it is needed */
export async function refreshAndRequestGuiBuild(opts: { dist?: string } = {}): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    refreshGuiStale(opts);
    requestGuiBuild();
  } finally {
    refreshing = false;
  }
}
