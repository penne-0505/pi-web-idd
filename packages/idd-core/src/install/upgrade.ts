import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { spawnSync } from "node:child_process";

import { checkoutRoot } from "../config/files.ts";
import { installSkills, type SkillInstallResult } from "../rules/rules.ts";
import { GUI_BUILD_COMMAND, guiBundleDir, guiBundleNeedsBuild } from "./gui-bundle.ts";
import { defaultRunner, type CommandRunner } from "./proc.ts";
import { checkoutVersion, headCommit, isManaged, readInstallRecord, systemctlBinary, systemdUserDir, writeInstallRecord, type InstallRecord } from "./records.ts";
import { runMigrate, type MigrateResult, type Migration } from "./migrate.ts";
import { LEGACY_WEB_UNIT, clearLegacyWebOutputs, isLegacyWebOutputStatus, legacyWebUnitKind, placeUnits, readLegacyWebOutputs, retireLegacyWebUnit } from "./units.ts";

const NO_POINTERS = "install の記録に state と pi の指し先がありません。unit を描き直すと値が消えて lane が見えなくなるので、idd install --state-dir <絶対 path> --pi-bin <絶対 path> を回してから upgrade してください";

/** what the stop says when the unit already carries a pointer the record does not have */
const LOST_POINTERS = (names: string[]) => `install の記録に ${names.join(" と ")} の指し先がありません。今の unit はその値を持っているので、描き直すと値が消えて lane が見えなくなります。idd install --state-dir <絶対 path> --pi-bin <絶対 path> を回してから upgrade してください`;

const SHALLOW_FLOOR = "shallow clone なので、指し先を焼いた commit（戻れる下限）を決められません。git fetch --unshallow の後に idd install を回し直してから upgrade してください";

/** the units whose work would break if the checkout's node_modules were replaced under them */
const LIVE_UNITS = ["idd-engine.service", "idd-tick.timer"];

export interface UpgradeOptions {
  home?: string;
  checkout?: string;
  /** the release tag to move to; the newest `v*` tag when not given */
  to?: string;
  /** do not fetch or check out: run only the stages after the checkout (the new version calls this) */
  here?: boolean;
  /**
   * run npm ci and the screen's bundle build even when node_modules and a bundle are present. The tag-changing upgrade passes this
   * to the new version's process: its code no longer matches the previous version's dependencies and build.
   */
  reinstall?: boolean;
  runner?: CommandRunner;
  migrations?: Migration[];
  /** how the new version's `bin/idd upgrade --here` is started (a test watches the call) */
  spawnStage?: (bin: string, args: string[]) => { ok: boolean; code: number; stdout: string; stderr: string };
  /** how the skills are placed; a test hands in its own */
  placeSkills?: (home: string) => SkillInstallResult;
  now?: () => Date;
}

export interface UpgradeResult {
  ok: boolean;
  checkout: string;
  from?: string;
  to?: string;
  blocked?: "dirty" | "not-a-tag" | "running-units" | "no-tag" | "no-pointers" | "below-floor";
  /** the live units that stopped the run */
  units?: string[];
  /** what to run to stop them (upgrade never stops a resident unit by itself) */
  stopCommands?: string[];
  steps: string[];
  errors: string[];
  migrations?: MigrateResult;
  /** the run moved the checkout and handed the later stages to the new version's process */
  handedToNewVersion?: boolean;
  /** the new version's process exited non-zero */
  stageExit?: number;
  /** the commands that bring the units back after the run */
  restartCommands?: string[];
}

const defaultSpawnStage = (bin: string, args: string[]) => {
  const res = spawnSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 1_800_000 });
  return { ok: res.status === 0, code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? String(res.error ?? "") };
};

/** the `errors` the child's result JSON carries on stdout (it prints that JSON last) */
function childErrors(stdout: string): string[] {
  const text = stdout.trim();
  if (!text) return [];
  const fromText = (t: string): string[] | null => {
    try {
      const parsed = JSON.parse(t) as { errors?: unknown };
      return Array.isArray(parsed?.errors) ? parsed.errors.map((e) => String(e)) : null;
    } catch {
      return null;
    }
  };
  const whole = fromText(text);
  if (whole) return whole;
  for (const line of text.split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue;
    const found = fromText(line.trim());
    if (found) return found;
  }
  return [];
}

/**
 * Why the new version's process failed, as the parent can show it: the `errors` of its result JSON first (it
 * prints that on stdout), then its error stream. Never empty: the raw stdout is shown when neither says anything.
 */
function childFailureDetail(child: { stdout: string; stderr: string }): string {
  const parts = [...childErrors(child.stdout)];
  const stderr = child.stderr.trim();
  if (stderr) parts.push(stderr.slice(-300));
  if (!parts.length && child.stdout.trim()) parts.push(child.stdout.trim().slice(-300));
  return parts.join(" | ");
}

/**
 * The pointers the installed units already carry on their ExecStart lines, by the name they are set under.
 * Only units `idd install` wrote count: a hand-written unit is never redrawn, so it loses nothing.
 */
function carriedPointers(home: string): string[] {
  const names = new Set<string>();
  for (const unit of ["idd-engine.service", "idd-tick.service"]) {
    const target = join(systemdUserDir(home), unit);
    if (!existsSync(target)) continue;
    const text = readFileSync(target, "utf8");
    if (!isManaged(text)) continue;
    for (const line of text.split("\n")) {
      if (!line.startsWith("ExecStart=")) continue;
      if (/(^|[\s"=])IDD_STATE_DIR=/.test(line)) names.add("IDD_STATE_DIR");
      if (/(^|[\s"=])IDD_PI_BIN=/.test(line)) names.add("IDD_PI_BIN");
    }
  }
  return [...names];
}

/**
 * The units that stop the run. The old screen's unit is one of them only when it is hand-written: one `idd install` wrote is
 * stopped and removed by the run itself, so it does not have to be stopped by hand first.
 */
function activeUnits(runner: CommandRunner, home: string): string[] {
  const ours = legacyWebUnitKind(systemdUserDir(home)) === "managed";
  return [...LIVE_UNITS, ...(ours ? [] : [LEGACY_WEB_UNIT])].filter((unit) => {
    const res = runner.capture(systemctlBinary(), ["--user", "is-active", unit]);
    const state = res.stdout.trim();
    return res.ok || state === "active" || state === "activating" || state === "reloading";
  });
}

/** stop, disable and remove the old screen's unit before the dependencies it runs on are replaced; false when that failed */
function retireLegacyWeb(home: string, runner: CommandRunner, result: UpgradeResult): boolean {
  const legacy = retireLegacyWebUnit(systemdUserDir(home), runner);
  result.steps.push(...legacy.steps);
  result.errors.push(...legacy.errors);
  if (legacy.errors.length) return false;
  if (legacy.retired) {
    try {
      runner.run(systemctlBinary(), ["--user", "daemon-reload"]);
    } catch (err) {
      result.errors.push(`systemctl --user daemon-reload に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  return true;
}

/** remove the build output the old screen left in the checkout's tree as it stands now; false when a removal failed */
function clearLegacyWeb(home: string, checkout: string, runner: CommandRunner, result: UpgradeResult): boolean {
  const leftover = clearLegacyWebOutputs(checkout, systemdUserDir(home), runner);
  result.steps.push(...leftover.steps);
  result.errors.push(...leftover.errors);
  return leftover.errors.length === 0;
}

/**
 * What the checkout's uncommitted work comes to. The old screen's build output alone is not work when it is about to be removed:
 * it is the leftover the next steps clear, and stopping on it would keep it from ever being cleared. It is read with git's own
 * untracked display (`normal`, a dir as one line) whatever the checkout's `status.showUntrackedFiles` says.
 * - `work`: something else is uncommitted, or the output must stay for a reason a tag change does not move
 * - `output-by-tree`: only the output, held because this tree still holds the old screen; the tag moved to may not
 * - `none`: nothing the move has to wait for
 * `why` is the reason the output stays when that alone is what stops the move.
 * The names of the output taken out of this reading are a stopgap, recorded in C-277-3.
 */
function uncommittedWork(home: string, checkout: string, runner: CommandRunner): { kind: "work" | "output-by-tree" | "none"; why?: string } {
  const lines = (runner.capture("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: checkout }).stdout ?? "").split("\n").filter((line) => line.trim());
  if (lines.length === 0) return { kind: "none" };
  if (!lines.every(isLegacyWebOutputStatus)) return { kind: "work" };
  const outputs = readLegacyWebOutputs(checkout, systemdUserDir(home), runner, { unitMayGo: true });
  if (!outputs.heldBy) return { kind: "none" };
  return outputs.byTree ? { kind: "output-by-tree" } : { kind: "work", why: outputs.heldBy };
}

/**
 * `idd upgrade [--to <tag>] [--here]`. Moves the installed checkout to a release tag and then runs the stages
 * after the checkout (dependencies, build, skills, units, migrations, install.json) in the new version's own
 * process, so a migration the new version adds is read by the new code. It stops with nothing changed when the
 * checkout has uncommitted work, HEAD is not on a tag (a development checkout), or a live unit would have its
 * node_modules replaced under it. `--here` skips the fetch and the checkout and runs only the stages.
 */
export function runUpgrade(opts: UpgradeOptions = {}): UpgradeResult {
  const home = opts.home ?? process.env.HOME ?? "";
  const runner = opts.runner ?? defaultRunner;
  const now = opts.now ?? (() => new Date());
  const record = readInstallRecord(home);
  const checkout = opts.checkout ?? record?.checkout ?? checkoutRoot();
  const result: UpgradeResult = { ok: false, checkout, steps: [], errors: [] };
  result.restartCommands = ["systemctl --user restart idd-engine.service", "systemctl --user start idd-tick.timer"];

  if (!home || !isAbsolute(home)) {
    result.errors.push(`HOME が絶対パスではありません: ${JSON.stringify(home)}`);
    return result;
  }

  // a live unit is checked before anything moves: npm ci would replace what it is running on
  const live = activeUnits(runner, home);
  if (live.length) {
    result.blocked = "running-units";
    result.units = live;
    result.stopCommands = live.map((unit) => `systemctl --user stop ${unit}`);
    result.steps.push(`動いている unit があります: ${live.join(", ")}`);
    return result;
  }

  if (!opts.here) {
    const uncommitted = uncommittedWork(home, checkout, runner);
    if (uncommitted.kind === "work") {
      result.blocked = "dirty";
      result.steps.push(`未 commit の変更があるので、tag を替えずに止まりました${uncommitted.why ? `（旧画面の build 出力を残す理由: ${uncommitted.why}）` : ""}`);
      return result;
    }
    const at = runner.capture("git", ["describe", "--tags", "--exact-match", "HEAD"], { cwd: checkout });
    if (!at.ok || !at.stdout.trim()) {
      result.blocked = "not-a-tag";
      result.steps.push("HEAD が tag の上にありません（開発の checkout）。tag を替えずに止まりました");
      return result;
    }
    result.from = at.stdout.trim();
    if (!record?.state_dir || !record.pi_bin) {
      result.blocked = "no-pointers";
      result.errors.push(NO_POINTERS);
      return result;
    }

    const fetched = runner.capture("git", ["fetch", "--tags"], { cwd: checkout });
    if (!fetched.ok) {
      result.errors.push(`tag を fetch できませんでした: ${fetched.stderr.slice(-300)}`);
      return result;
    }
    const target = opts.to ?? runner.capture("git", ["tag", "--list", "v*", "--sort=-v:refname"], { cwd: checkout }).stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0];
    if (!target) {
      result.blocked = "no-tag";
      result.errors.push("移る先の tag（v*）がありません");
      return result;
    }
    const to = runner.capture("git", ["rev-parse", "--verify", `refs/tags/${target}`], { cwd: checkout });
    if (!to.ok) {
      result.errors.push(`tag がありません: ${target}`);
      return result;
    }
    // the lowest version to move to is the commit that first carried the pointers: an older bin/idd decides the state
    // by itself and would drop to the run clone's own empty state. Answered by git's ancestry, not by a tag's number.
    if (!record.pointers_commit) {
      result.blocked = "below-floor";
      const shallow = runner.capture("git", ["rev-parse", "--is-shallow-repository"], { cwd: checkout });
      result.errors.push(shallow.ok && shallow.stdout.trim() === "true"
        ? SHALLOW_FLOOR
        : "install の記録に、指し先を焼いた commit がありません。idd install を回し直してから upgrade してください");
      return result;
    }
    const floor = runner.capture("git", ["merge-base", "--is-ancestor", record.pointers_commit, `refs/tags/${target}^{commit}`], { cwd: checkout });
    if (!floor.ok) {
      result.blocked = "below-floor";
      const why = floor.stderr.trim();
      result.errors.push(why
        ? `${target} が下限（${record.pointers_commit.slice(0, 9)}）より後か判定できませんでした: ${why.slice(-200)}`
        : `${target} は、state と pi の指し先を焼いた commit（${record.pointers_commit.slice(0, 9)}）を含まないので、戻れません。checkout は ${result.from} のままです`);
      return result;
    }
    // the build output alone stopped on the screen this tree still holds: it goes when the tag moved to does not hold it
    if (uncommitted.kind === "output-by-tree") {
      const gate = readLegacyWebOutputs(checkout, systemdUserDir(home), runner, { unitMayGo: true, tag: target });
      if (gate.heldBy) {
        result.blocked = "dirty";
        result.steps.push(`未 commit の変更があるので、tag を替えずに止まりました（旧画面の build 出力が ${target} でも残る理由: ${gate.heldBy}）`);
        return result;
      }
    }
    if (!retireLegacyWeb(home, runner, result)) return result;
    runner.run("git", ["checkout", "-q", target], { cwd: checkout });
    result.to = target;
    result.steps.push(`checkout を ${result.from} から ${target} に替えました`);
    // the tree is the new tag's now: what the old screen left is judged against it
    if (!clearLegacyWeb(home, checkout, runner, result)) return result;

    // the later stages belong to the new version: hand them to its own bin, which reads the new migration list.
    // The dependencies and the build are laid down again unless both the checkout and install.json already name the
    // target: a checkout that moves (including a rollback to an older tag) can leave the other version's artifacts
    // behind, and so can a retry whose install.json still names the old version. Neither case may be recorded as ok
    // on stale artifacts. `--here` on its own keeps the "build only when missing" guard.
    const bin = join(checkout, "bin", "idd");
    const spawn = opts.spawnStage ?? defaultSpawnStage;
    result.handedToNewVersion = true;
    const unchanged = result.from === target && record?.version === target;
    const child = spawn(bin, ["upgrade", "--here", ...(unchanged ? [] : ["--reinstall"])]);
    result.stageExit = child.code;
    if (!child.ok) {
      const detail = childFailureDetail(child);
      result.errors.push(`新しい版の upgrade --here が失敗しました（exit ${child.code}）${detail ? `: ${detail}` : ""}`);
      return result;
    }
    result.ok = true;
    result.steps.push("後の段を新しい版の process で回しました");
    return result;
  }

  // --here: the stages after the checkout, with this version's code
  const here = checkoutVersion(checkout, runner);
  result.from = here.version;
  // a unit is never redrawn from pointers the record does not have when that would drop what the unit carries:
  // a checkout on a tag needs both, a development checkout installed without them has nothing to lose
  if (here.tag && (!record?.state_dir || !record.pi_bin)) {
    result.blocked = "no-pointers";
    result.errors.push(NO_POINTERS);
    return result;
  }
  const lost = carriedPointers(home).filter((name) => !(name === "IDD_STATE_DIR" ? record?.state_dir : record?.pi_bin));
  if (lost.length) {
    result.blocked = "no-pointers";
    result.errors.push(LOST_POINTERS(lost));
    return result;
  }
  // the old screen's unit runs on this checkout's node_modules: it goes before `npm ci` replaces them
  if (!retireLegacyWeb(home, runner, result) || !clearLegacyWeb(home, checkout, runner, result)) return result;
  // after a tag change the new version's code must not run on the previous version's node_modules and bundle
  const reinstall = opts.reinstall === true;
  const needNpm = reinstall || !existsSync(join(checkout, "node_modules"));
  // a bundle is current when the commit it was built from is the checkout's head; the engine serves no other
  const needBuild = reinstall || guiBundleNeedsBuild(guiBundleDir(checkout), headCommit(checkout, runner));
  if (needNpm) {
    try {
      runner.run("npm", ["ci"], { cwd: checkout });
      result.steps.push(reinstall ? "依存を入れ直しました: npm ci" : "依存を入れました: npm ci");
    } catch (err) {
      result.errors.push(`npm ci に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }
  }
  if (needBuild) {
    const [cmd, ...args] = GUI_BUILD_COMMAND;
    const label = GUI_BUILD_COMMAND.join(" ");
    try {
      runner.run(cmd, args, { cwd: checkout });
      result.steps.push(reinstall ? `画面の bundle を build し直しました: ${label}` : `画面の bundle を build しました: ${label}`);
    } catch (err) {
      result.errors.push(`${label} に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }
  }
  const place = opts.placeSkills ?? ((h: string) => installSkills(h));
  // a skills failure does not stop the later stages, but the run ends not ok: the tag-changing parent reads only
  // this process's exit status, and a stale skill must not be recorded as a finished upgrade
  const skills = place(home);
  if (skills.ok) result.steps.push(`skills を置き直しました: ${skills.installed.length} 本`);
  else result.errors.push(`skills を置けませんでした: ${skills.error ?? ""}`);

  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const placement = placeUnits({ home, checkout, path, unitDir: systemdUserDir(home), ...(record?.state_dir ? { stateDir: record.state_dir } : {}), ...(record?.pi_bin ? { piBin: record.pi_bin } : {}), ...(here.tag ? { onTag: true } : {}) });
  for (const skip of placement.skipped) result.steps.push(`unit を書き換えませんでした: ${skip.path}（${skip.reason}）`);
  if (placement.wrote) {
    try {
      runner.run(systemctlBinary(), ["--user", "daemon-reload"]);
      result.steps.push("unit を描き直し、daemon-reload を回しました");
    } catch (err) {
      result.errors.push(`systemctl --user daemon-reload に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }
  }

  const migrations = runMigrate({ home, checkout, runner, now, ...(opts.migrations ? { migrations: opts.migrations } : {}) });
  result.migrations = migrations;
  result.steps.push(...migrations.steps);
  if (!migrations.ok) {
    result.errors.push(...migrations.errors);
    return result;
  }

  const { version } = checkoutVersion(checkout, runner);
  const previous = readInstallRecord(home);
  // the pointers and the floor are install's to decide; an upgrade carries them as they are
  const next: InstallRecord = {
    schema: 1,
    checkout,
    version,
    installed_at: previous?.installed_at ?? now().toISOString(),
    updated_at: now().toISOString(),
    ...(previous?.state_dir ? { state_dir: previous.state_dir } : {}),
    ...(previous?.pi_bin ? { pi_bin: previous.pi_bin } : {}),
    ...(previous?.pointers_commit ? { pointers_commit: previous.pointers_commit } : {}),
  };
  writeInstallRecord(next, home);
  result.to = version;
  result.steps.push(`install.json の版を ${version} にしました`);
  result.ok = result.errors.length === 0;
  return result;
}
