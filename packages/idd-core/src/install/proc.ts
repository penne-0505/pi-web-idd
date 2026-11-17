import { execFileSync, spawnSync } from "node:child_process";

/**
 * How the install / upgrade / migrate steps reach the machine. A test hands in its own runner to watch which
 * commands a step asks for (npm ci, next build, systemctl --user daemon-reload) without running them.
 */
export interface CommandRunner {
  /** run a command and throw when it fails */
  run(command: string, args: string[], opts?: { cwd?: string }): void;
  /** run a command and report its status and output instead of throwing */
  capture(command: string, args: string[], opts?: { cwd?: string }): { ok: boolean; stdout: string; stderr: string };
}

export const defaultRunner: CommandRunner = {
  run(command, args, opts) {
    execFileSync(command, args, { cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 1_800_000 });
  },
  capture(command, args, opts) {
    const res = spawnSync(command, args, { cwd: opts?.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 1_800_000 });
    return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? String(res.error ?? "") };
  },
};
