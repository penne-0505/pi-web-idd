import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { knownSecrets, redactSecrets } from "./claude-stream.ts";
import { busctlBinary } from "./paths.ts";

/**
 * Processes that others outside a lane may be using, even when a lane's agent started them: adb's server (one per
 * host, on port 5037), the Gradle and Kotlin build daemons a later build of the same user attaches to, and a device
 * (an Android emulator, a Waydroid session) someone may be looking at or using. Matched against the process's
 * command line, its arguments joined by spaces.
 */
export const DEFAULT_SHARED_DAEMONS: readonly string[] = Object.freeze([
  "\\badb\\b.*\\bfork-server\\b",
  "org\\.gradle\\.launcher\\.daemon\\.bootstrap\\.GradleDaemon",
  "org\\.jetbrains\\.kotlin\\.daemon\\.KotlinCompileDaemon",
  "(^|/)qemu-system-",
  "(^|/)emulator\\s(.*\\s)?(-avd\\b|@\\S)",
  "\\bwaydroid\\s+session\\b",
]);

export interface ScopeProcess {
  pid: number;
  ppid: number;
  cmdline: string;
}

export interface LeftoverPlan {
  /** a shared daemon, with what it started, to move out of the scope */
  keep: { root: ScopeProcess; pids: number[] }[];
  stop: ScopeProcess[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The cgroup of the scope this lane's supervisor was started in (`idd-lane-<id>.scope` for an ad-hoc lane,
 * `idd-lane-<id>-<ms>-<pid>.scope` for a conversation), from a /proc/<pid>/cgroup; null for any other cgroup, so
 * a supervisor started outside a scope (IDD_LANE_SCOPE=off, a test) or inside another lane's never cleans it.
 */
export function laneScopeCgroup(procCgroup: string, laneId: string): string | null {
  const line = procCgroup.split("\n").find((l) => l.startsWith("0::"));
  if (!line) return null;
  const path = line.slice(3).trim();
  const unit = path.split("/").pop() ?? "";
  const id = laneId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return new RegExp(`^idd-lane-${escapeRe(id)}(-\\d+-\\d+)?\\.scope$`).test(unit) ? path : null;
}

/** shared daemons and what they started are kept; the rest is stopped */
export function planLeftovers(procs: ScopeProcess[], patterns: readonly string[]): LeftoverPlan {
  const res = patterns.map((p) => new RegExp(p));
  const roots = procs.filter((p) => res.some((re) => re.test(p.cmdline)));
  const kept = new Set<number>();
  const keep: LeftoverPlan["keep"] = [];
  // a matching process under another one (qemu under the emulator's launcher) goes with it, not as a group of its own
  const isUnderRoot = (p: ScopeProcess): boolean => {
    const seen = new Set<number>();
    for (let cur = procs.find((x) => x.pid === p.ppid); cur && !seen.has(cur.pid); cur = procs.find((x) => x.pid === cur?.ppid)) {
      if (roots.includes(cur)) return true;
      seen.add(cur.pid);
    }
    return false;
  };
  for (const root of roots.filter((r) => !isUnderRoot(r))) {
    const pids = [root.pid];
    for (let i = 0; i < pids.length; i += 1) {
      for (const p of procs) if (p.ppid === pids[i] && !pids.includes(p.pid)) pids.push(p.pid);
    }
    for (const pid of pids) kept.add(pid);
    keep.push({ root, pids });
  }
  return { keep, stop: procs.filter((p) => !kept.has(p.pid)) };
}

/** busctl's call that starts a scope of its own for the given processes; systemd moves them into it, and collects it once they end */
export function rehomeArgs(unit: string, pids: number[], description: string): string[] {
  return [
    "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "StartTransientUnit",
    "ssa(sv)a(sa(sv))", unit, "fail", "3",
    "PIDs", "au", String(pids.length), ...pids.map(String),
    "Description", "s", description,
    "CollectMode", "s", "inactive-or-failed",
    "0",
  ];
}

export type LeftoverCommand = (cmd: string, args: string[]) => { status: number | null; stderr?: string; error?: Error };

const runCommand: LeftoverCommand = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 });
  return { status: r.status, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) };
};

export interface SettleOptions {
  laneId: string;
  /** the shared daemons' patterns (roles.yaml defaults.shared_daemons) */
  patterns?: readonly string[];
  selfPid?: number;
  procRoot?: string;
  cgroupRoot?: string;
  run?: LeftoverCommand;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  /** how long the processes told to stop have before SIGKILL */
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** what to hide in the command lines written to the log (the brief's callback token) */
  secrets?: string[];
  /** false when the shared daemons cannot be known: nothing is stopped, what matches is still moved */
  stop?: boolean;
}

function readText(p: string): string | null {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

function members(cgroupRoot: string, cgroup: string): number[] {
  return (readText(join(cgroupRoot, cgroup, "cgroup.procs")) ?? "").split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

function describeProcess(procRoot: string, pid: number): ScopeProcess | null {
  const stat = readText(join(procRoot, String(pid), "stat"));
  const cmdline = readText(join(procRoot, String(pid), "cmdline"));
  if (stat === null || cmdline === null) return null;
  const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  return { pid, ppid: Number.isInteger(ppid) ? ppid : 0, cmdline: cmdline.split("\0").filter(Boolean).join(" ") };
}

/** how many times the cleanup looks at the scope again for processes that started while it was stopping others */
const SETTLE_ROUNDS = 4;

/**
 * What a lane's supervisor does with its scope once the lane is over: every process still in the scope was started
 * by the lane's agent and outlived it (a server or a script it left running, a call the budget cut). A shared daemon
 * is moved into a scope of its own, since stopping it would cut off its users outside the lane; when systemd
 * refuses the move, it stays where it is, never stopped. The rest is stopped: SIGTERM, and SIGKILL after the grace
 * for what is still in the scope. Processes that started meanwhile (a child forked on SIGTERM) are handled the same
 * way in a later round, up to a few rounds. Told not to stop (the lane's shared daemons cannot be known), it only
 * moves what matches and leaves the rest running. Returns what was done, a line each.
 */
export async function settleLeftovers(opts: SettleOptions): Promise<string[]> {
  const procRoot = opts.procRoot ?? "/proc";
  const cgroupRoot = opts.cgroupRoot ?? "/sys/fs/cgroup";
  const selfPid = opts.selfPid ?? process.pid;
  const cgroup = laneScopeCgroup(readText(join(procRoot, String(selfPid), "cgroup")) ?? "", opts.laneId);
  if (!cgroup) return [];
  const describeAll = () => members(cgroupRoot, cgroup).map((pid) => describeProcess(procRoot, pid)).filter((p): p is ScopeProcess => p !== null);
  // the supervisor and what it runs under in the scope (systemd-run's command may be a launcher of bun, as volta's)
  const first = describeAll();
  const handled = new Set<number>([selfPid]);
  for (let pid = selfPid, guard = 0; guard < 64; guard += 1) {
    const parent = first.find((p) => p.pid === pid)?.ppid ?? describeProcess(procRoot, pid)?.ppid;
    if (!parent || parent <= 1 || !first.some((p) => p.pid === parent)) break;
    handled.add(parent);
    pid = parent;
  }
  let secrets: string[] | undefined = opts.secrets;
  const show = (p: ScopeProcess) => `pid ${p.pid} ${redactSecrets(p.cmdline, (secrets ??= knownSecrets())).slice(0, 160)}`;
  const run = opts.run ?? runCommand;
  const kill = opts.kill ?? ((pid, sig) => process.kill(pid, sig));
  const signal = (pid: number, sig: NodeJS.Signals) => { try { kill(pid, sig); } catch { /* already gone */ } };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const lines: string[] = [];
  /** shared daemons left in the scope (a move refused): what they start later stays with them */
  const kept = new Set<number>();
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    const current = round === 0 ? first : describeAll();
    const underKept = (p: ScopeProcess): boolean => {
      const seen = new Set<number>();
      for (let cur: ScopeProcess | undefined = p; cur && !seen.has(cur.pid); cur = current.find((x) => x.pid === cur?.ppid)) {
        if (kept.has(cur.ppid)) return true;
        seen.add(cur.pid);
      }
      return false;
    };
    for (const p of current) if (!handled.has(p.pid) && underKept(p)) { kept.add(p.pid); handled.add(p.pid); }
    const procs = current.filter((p) => !handled.has(p.pid));
    if (!procs.length) break;
    const plan = planLeftovers(procs, opts.patterns ?? DEFAULT_SHARED_DAEMONS);
    for (const group of plan.keep) {
      // moved or not, a shared daemon is never looked at again: it is not stopped
      for (const pid of group.pids) handled.add(pid);
      const name = (group.root.cmdline.split(" ")[0].split("/").pop() ?? "process").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 32) || "process";
      const unit = `idd-kept-${name}-${group.root.pid}.scope`;
      const description = `idd lane ${opts.laneId} が残した共有の常駐 process（${name}）`;
      let r = run(busctlBinary(), rehomeArgs(unit, group.pids, description));
      if (r.status !== 0 || r.error) {
        // systemd refuses the whole start when one pid is gone: once more with the pids still in the scope
        const inScope = new Set(members(cgroupRoot, cgroup));
        const alive = group.pids.filter((pid) => inScope.has(pid));
        if (alive.length && alive.length < group.pids.length) r = run(busctlBinary(), rehomeArgs(unit, alive, description));
      }
      if (r.status !== 0 || r.error) for (const pid of group.pids) kept.add(pid);
      if (r.status === 0 && !r.error) lines.push(`[leftover] 共有の常駐 process を止めずに ${unit} へ移した: ${show(group.root)}${group.pids.length > 1 ? `（ほか ${group.pids.length - 1} 個）` : ""}`);
      else lines.push(`[leftover] 共有の常駐 process を ${unit} へ移せなかった（${r.error ? String(r.error) : `exit ${r.status}${r.stderr?.trim() ? `: ${r.stderr.trim()}` : ""}`}）。止めずに scope に残す: ${show(group.root)}`);
    }
    if (!plan.stop.length) continue;
    if (opts.stop === false) {
      for (const p of plan.stop) {
        handled.add(p.pid);
        lines.push(`[leftover] 共有の常駐 process の一覧を読めないので、止めずに残す: ${show(p)}`);
      }
      continue;
    }
    for (const p of plan.stop) {
      handled.add(p.pid);
      signal(p.pid, "SIGTERM");
    }
    const deadline = now() + (opts.graceMs ?? 5000);
    const stopping = new Set(plan.stop.map((p) => p.pid));
    const remaining = () => members(cgroupRoot, cgroup).filter((pid) => stopping.has(pid));
    while (remaining().length && now() < deadline) await sleep(100);
    const stubborn = new Set(remaining());
    // only what is still in this scope: a pid that left it may be someone else's by now
    for (const pid of stubborn) signal(pid, "SIGKILL");
    for (const p of plan.stop) lines.push(`[leftover] lane の終わりに残った process を止めた${stubborn.has(p.pid) ? "（SIGTERM で終わらず SIGKILL）" : ""}: ${show(p)}`);
  }
  return lines;
}
