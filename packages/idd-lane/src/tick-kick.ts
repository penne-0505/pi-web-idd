import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// the default engine port lives with the CLI's API helpers; the path is used instead of the package name so the
// Node CLI resolves it without workspace links (idd-lane's own files are read across packages by path)
import { DEFAULT_ENGINE_PORT } from "../../idd-core/src/agent/token.ts";
import { resolveStateDir } from "../../idd-core/src/install/pointers.ts";
import { repoRoot, systemctlBinary, systemdRunBinary } from "./paths.ts";

/** the request a tick looks for after each pass; the engine's name for it (runTick in @idd/core) */
export const TICK_AGAIN_FILE = "tick.again";

/** how long the kick waits, so lanes that finish close together share one tick */
export const TICK_KICK_DELAY_SECONDS = 30;

export type TickKick = { outcome: "scheduled" | "coalesced" | "off" | "failed"; unit?: string; detail?: string };

/** how a systemd command is run; a test stands in for systemd-run and systemctl with it */
export type KickRunner = (cmd: string, args: string[]) => { status: number | null; stdout?: string; stderr?: string; error?: Error };

/** one transient unit per state: a process working on other records (a test, a dev server) never takes the name */
export function tickKickUnit(state: string): string {
  return `idd-tick-kick-${createHash("sha256").update(resolve(state)).digest("hex").slice(0, 8)}`;
}

/** the base URL the CLI would send to, from the environment the kick is asked from; none leaves the CLI's default */
function baseUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.IDD_AGENT_BASE_URL?.trim();
  if (explicit) return explicit;
  // the API's destination is the engine now (the CLI's default too), so the timer names it even when the env is bare
  const port = env.IDD_ENGINE_PORT?.trim() || env.PORT?.trim() || DEFAULT_ENGINE_PORT;
  return `http://127.0.0.1:${port}`;
}

/**
 * A transient timer of the user's systemd that runs `idd tick --no-intake` once, shortly after. It belongs to the
 * user's manager, not to the process that asked for it: the lane's scope, and the UI's service, can end first.
 * The tick itself runs where every tick runs (the CLI sends it to the server). --collect lets a failed tick
 * (the server down) give the name back. The unit gets no environment of its own, so PATH (bun) and the server
 * are passed along; --for-state makes a server keeping another state do nothing.
 */
export function tickKickLaunch(opts: { state: string; root: string; env: NodeJS.ProcessEnv; delaySeconds?: number; unit?: string }): { cmd: string; args: string[] } {
  const url = baseUrl(opts.env);
  return {
    cmd: systemdRunBinary(),
    args: [
      "--user", "--quiet", "--collect", `--unit=${opts.unit ?? tickKickUnit(opts.state)}`,
      `--on-active=${opts.delaySeconds ?? TICK_KICK_DELAY_SECONDS}s`, "--timer-property=AccuracySec=1s",
      `--working-directory=${opts.root}`, "--property=Nice=10",
      ...(opts.env.PATH ? [`--setenv=PATH=${opts.env.PATH}`] : []),
      `--setenv=IDD_STATE_DIR=${opts.state}`,
      `--setenv=IDD_AGENT_BASE_URL=${url}`,
      join(opts.root, "bin", "idd"), "tick", "--no-intake", "--for-state", opts.state,
    ],
  };
}

const runCommand: KickRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) };
};

type KickOptions = { env?: NodeJS.ProcessEnv; run?: KickRunner; delaySeconds?: number };

/** a test fixes the clock and the process id to put two bookings in the same millisecond on purpose */
type FollowUpOptions = KickOptions & { now?: number; pid?: number };

function kickOff(env: NodeJS.ProcessEnv): boolean {
  return env.IDD_TICK_KICK === "off" || env.IDD_LANE_SCOPE === "off";
}

function stateOf(env: NodeJS.ProcessEnv, root: string): string {
  return resolveStateDir({ checkout: root, env });
}

function schedule(opts: KickOptions, state: string, root: string, unit: string): TickKick {
  const env = opts.env ?? process.env;
  const launch = tickKickLaunch({ state, root, env, unit, ...(opts.delaySeconds !== undefined ? { delaySeconds: opts.delaySeconds } : {}) });
  const r = (opts.run ?? runCommand)(launch.cmd, launch.args);
  if (r.status === 0 && !r.error) return { outcome: "scheduled", unit };
  const stderr = r.stderr?.trim() ?? "";
  if (/already loaded|already exists/i.test(stderr)) return { outcome: "coalesced", unit };
  return { outcome: "failed", unit, detail: r.error ? String(r.error) : `exit ${r.status}${stderr ? `: ${stderr}` : ""}` };
}

/**
 * How many follow-ups this process has booked. The clock alone cannot name them: a tight loop books two within
 * the same millisecond, and the pid cannot separate two bookings of one process either. This count can, and it
 * does so without looking at the time, so a test that fixes the clock still gets two different names.
 */
let followUpCount = 0;

/**
 * The follow-up's whole name from the parts it is made of. Exported so a test can hold the count still and show
 * that the pid, not just this process's count, separates two processes booking in the same millisecond.
 */
export function followUpName(state: string, parts: { now: number; pid: number; count: number }): string {
  return `${tickKickUnit(state)}-f${parts.now.toString(36)}-${parts.pid.toString(36)}-${parts.count.toString(36)}`;
}

/**
 * Book one more tick under a name no kick holds, for a request still there when the lock was let go (a tick past
 * its last pass, or a GO that held the lock meanwhile). The fixed name may be the running tick's own unit, which
 * systemd keeps until that tick's CLI exits, so it cannot be used here. `followUpName` starts from the kick's own
 * name, then carries the time, the pid, and this process's count: the count separates two bookings of one process,
 * the pid separates two processes booking in the same millisecond, and the time stays as a backstop for a process
 * whose pid is reused after a restart and whose count has started over. `now` and `pid` let a test fix both.
 */
export function bookFollowUpTick(opts: FollowUpOptions = {}): TickKick {
  const env = opts.env ?? process.env;
  if (kickOff(env)) return { outcome: "off" };
  const root = repoRoot();
  const state = stateOf(env, root);
  followUpCount += 1;
  return schedule(opts, state, root, followUpName(state, { now: opts.now ?? Date.now(), pid: opts.pid ?? process.pid, count: followUpCount }));
}

/**
 * Ask for a tick without the intake, after a lane's result (or penne's decision) is recorded. The request is left in
 * the state first: a tick that is running when it lands makes another pass for it, and one that starts later removes
 * it. Then the kick is scheduled; systemd refuses a second unit of the same name while one waits or its tick runs.
 * A waiting one reads this result when it starts, which is the debounce. A running one may already be past the point
 * where it looks for requests, so a follow-up is booked under a name of its own. Off with IDD_TICK_KICK=off, and
 * where lanes run without systemd (IDD_LANE_SCOPE=off, as the tests do).
 */
export function requestTick(opts: KickOptions = {}): TickKick {
  const env = opts.env ?? process.env;
  if (kickOff(env)) return { outcome: "off" };
  const root = repoRoot();
  const state = stateOf(env, root);
  if (!existsSync(state)) mkdirSync(state, { recursive: true });
  writeFileSync(join(state, TICK_AGAIN_FILE), new Date().toISOString());
  const unit = tickKickUnit(state);
  const kick = schedule(opts, state, root, unit);
  if (kick.outcome !== "coalesced") return kick;
  const sub = (opts.run ?? runCommand)(systemctlBinary(), ["--user", "show", "-p", "SubState", "--value", `${unit}.timer`]);
  if (sub.status === 0 && sub.stdout?.trim() === "waiting") return kick;
  return bookFollowUpTick(opts);
}
