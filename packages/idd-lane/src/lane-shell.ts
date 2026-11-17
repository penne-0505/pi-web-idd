import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** where a lane's shell writes the calls it cut, one line each: time, limit in seconds, the command */
export const TOOL_TIMEOUT_LOG = "tool-timeouts.log";

/** the name of the shell in a pi lane's agent dir (its settings.json points shellPath at it) */
export const LANE_SHELL = "lane-bash";

/**
 * The reply's environment names the shared shell's limit in seconds (absent: run the call without a limit) and the
 * file a cut is written to. The names start with `IDD_` so the test entry drops them from a lane that runs the
 * tests: a test's pass must not depend on the lane's own limit (DEC-2847).
 */
export const TOOL_TIMEOUT_SECONDS_ENV = "IDD_TOOL_TIMEOUT_SECONDS";
export const TOOL_TIMEOUT_LOG_ENV = "IDD_TOOL_TIMEOUT_LOG";
/**
 * The reply's environment names the file the shared shell appends one byte to as it starts a call. A reply that used
 * bash and left no byte there did not go through the shell: an empty tool-timeouts.log cannot tell a call that was
 * never cut from one that never reached the shell.
 */
export const LANE_SHELL_PASS_ENV = "IDD_LANE_SHELL_PASS";

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** the notice, with the limit as the caller writes it (a literal number, or a shell expansion in the shared shell) */
function toolTimeoutNoticeOf(limitRef: string): string {
  return `idd-lane: このコマンドは lane の道具の呼び出しの上限（${limitRef} 秒）を超えたので打ち切りました。常駐する process（アプリ・サーバー・監視の script など）は起動せず、起動が要るときは timeout -k 10 N（N は秒）を付けて、決まった時間で終わる形で回してください。`;
}

/** what the agent reads in the tool result of a call that was cut */
export function toolTimeoutNotice(limitSeconds: number): string {
  return toolTimeoutNoticeOf(String(limitSeconds));
}

/** the notice for the shared shell, whose limit is only known when the call runs (`${limit}` expands in the script) */
function toolTimeoutNoticeFromEnv(): string {
  return `"${toolTimeoutNoticeOf("${limit}")}"`;
}

/**
 * The shell pi runs each bash tool call with. pi starts it as `<shell> -c <command>` in a process group of its own
 * (and kills that group when it aborts the call), and has no limit of its own unless the model asks for one. This
 * shell runs the command in the foreground and a watchdog beside it. At the limit, if the command is still running,
 * the watchdog stops the call: every process of the group, and every process under this shell by parent (a command
 * that made a group or a session of its own, as `timeout` without --foreground or setsid, is still the call's),
 * with SIGTERM, then SIGKILL after a grace, looking again for what they start meanwhile. Only when it stopped
 * something does the shell write the cut to the lane's log, tell the agent, and return 124; a command that ended
 * as the limit came keeps its own exit code. A process that detached (its own session, its parent gone, as adb's
 * server) is not stopped here; the supervisor settles those when the lane ends. Started outside a group of its
 * own, the shell cannot stop the command without stopping its caller's group too, and runs it without the limit.
 */
export function laneShellScript(limitSeconds: number, logPath: string): string {
  const limit = Math.max(1, Math.ceil(limitSeconds));
  return laneShellBody(`limit=${limit}\nlog=${quote(logPath)}`, quote(toolTimeoutNotice(limit)));
}

/**
 * The shared shell a pipeline role's agent dir points every pi at, for Issue-lane conversations and the engine's
 * chat alike. It reads the limit, the log and the pass marker from the reply's environment, so one file in the
 * shared role dir serves lanes of different repos at once, each with its own limit and its own record. Without a
 * limit in the environment it runs the call as pi's own shell would (the chat carries none).
 */
export function laneShellEnvScript(): string {
  return laneShellBody(
    [
      `mark=\${${LANE_SHELL_PASS_ENV}:-}`,
      `[ -n "$mark" ] && printf '\\n' >> "$mark" 2>/dev/null`,
      `limit=\${${TOOL_TIMEOUT_SECONDS_ENV}:-}`,
      `[ -n "$limit" ] || exec "$BASH" "$@"`,
      `log=\${${TOOL_TIMEOUT_LOG_ENV}:-}`,
    ].join("\n"),
    toolTimeoutNoticeFromEnv(),
  );
}

/** the body both shells share: the setup defines `limit` and `log`, and a call is cut only when it stopped one */
function laneShellBody(setup: string, notice: string): string {
  return `#!/usr/bin/env bash
${setup}
notice=${notice}

read -r __stat 2>/dev/null < /proc/$$/stat || exec "$BASH" "$@"
read -r -a __f <<< "\${__stat##*) }"
[ "\${__f[2]}" = "$$" ] || exec "$BASH" "$@"
leader=$$

# every live process: its parent and its group (fields after the command name: state ppid pgrp)
__scan() {
  local f line p
  local -a rest
  declare -gA __pp=() __pg=()
  __all=()
  for f in /proc/[0-9]*/stat; do
    read -r line 2>/dev/null < "$f" || continue
    read -r -a rest <<< "\${line##*) }"
    [ "\${rest[0]}" = Z ] && continue
    p=\${line%% *}
    __pp[$p]=\${rest[1]}
    __pg[$p]=\${rest[2]}
    __all+=("$p")
  done
}

# the call's processes: the group, and the tree under this shell, but the shell and the watchdog.
# __running says whether the command itself (this shell's child other than the watchdog) is still there
__targets() {
  __scan
  local p q
  local -A in=()
  local -a queue=("$leader")
  __running=0
  for p in "\${__all[@]}"; do [ "\${__pg[$p]}" = "$leader" ] && in[$p]=1; done
  while [ \${#queue[@]} -gt 0 ]; do
    q=\${queue[0]}
    queue=("\${queue[@]:1}")
    for p in "\${__all[@]}"; do
      [ "\${__pp[$p]}" = "$q" ] || continue
      [ "$p" = "$BASHPID" ] && continue
      [ "$q" = "$leader" ] && __running=1
      in[$p]=1
      queue+=("$p")
    done
  done
  unset "in[$leader]" "in[$BASHPID]"
  __pids=("\${!in[@]}")
}

__watch() {
  local s i p
  local -A victims=()
  local -a alive
  trap 'kill "$s" 2>/dev/null; exit 0' TERM
  sleep "$limit" & s=$!
  wait "$s"
  trap '' TERM
  __targets
  # the command ended as the limit came: nothing was cut
  [ "$__running" = 1 ] || exit 0
  for ((i = 0; i < 50; i++)); do
    for p in "\${__pids[@]}"; do
      [ -n "\${victims[$p]:-}" ] && continue
      victims[$p]=1
      kill -TERM "$p" 2>/dev/null
    done
    sleep 0.1
    __targets
    alive=()
    for p in "\${!victims[@]}"; do [ -n "\${__pp[$p]:-}" ] && alive+=("$p"); done
    [ \${#alive[@]} -eq 0 ] && [ \${#__pids[@]} -eq 0 ] && break
  done
  [ \${#alive[@]} -gt 0 ] && kill -KILL "\${alive[@]}" 2>/dev/null
  [ \${#__pids[@]} -gt 0 ] && kill -KILL "\${__pids[@]}" 2>/dev/null
  exit 124
}

__watch &
dog=$!
"$BASH" "$@"
status=$?
kill -TERM "$dog" 2>/dev/null
wait "$dog"
if [ $? -eq 124 ]; then
  cmd=\${*: -1}
  cmd=\${cmd//$'\\n'/ }
  cmd=\${cmd//$'\\t'/ }
  printf '%s\\t%s\\t%s\\n' "$(date -Iseconds)" "$limit" "\${cmd:0:300}" >> "$log" 2>/dev/null
  printf '\\n%s\\n' "$notice" >&2
  exit 124
fi
exit "$status"
`;
}

let shellSeq = 0;

/**
 * Write a shell into dir and return its path. Written aside and renamed: bash reads a running script a little at a
 * time, and the shared role dir's shell must never be rewritten in place under a call that is reading it.
 */
function writeShellFile(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, LANE_SHELL);
  const tmp = `${p}.${process.pid}-${shellSeq += 1}.tmp`;
  writeFileSync(tmp, content);
  chmodSync(tmp, 0o755);
  renameSync(tmp, p);
  return p;
}

/** write the lane's shell into dir (the lane's agent dir) and return its path */
export function writeLaneShell(dir: string, limitSeconds: number, logPath: string): string {
  return writeShellFile(dir, laneShellScript(limitSeconds, logPath));
}

/** write the shared, environment-driven shell into dir (the role's agent dir) and return its path */
export function writeLaneShellEnv(dir: string): string {
  return writeShellFile(dir, laneShellEnvScript());
}
