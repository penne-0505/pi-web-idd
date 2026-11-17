import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { configEnvVar, checkoutRoot } from "../config/files.ts";
import { installSkills, type SkillInstallResult } from "../rules/rules.ts";
import { GUI_BUILD_COMMAND, guiBundleDir, guiBundleNeedsBuild } from "./gui-bundle.ts";
import { defaultRunner, type CommandRunner } from "./proc.ts";
import { MANAGED_MARKER, checkoutVersion, headCommit, installDir, installRecordPath, isManaged, localBinDir, pointersOrigin, readInstallRecord, systemctlBinary, systemdUserDir, writeInstallRecord, type InstallRecord } from "./records.ts";
import { clearLegacyWebOutputs, readCarriedPointers, renderUnits, placeUnits, retireLegacyWebUnit, unitStartCommands, type UnitContext } from "./units.ts";

/** single-quoted for sh, so $ ` \\ in the path stay literal */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

const CONFIG_NAMES = ["roles", "repos", "modes"] as const;
const PREREQUISITES = ["git", "node", "bun", "deno"] as const;

export interface InstallOptions {
  home?: string;
  checkout?: string;
  runner?: CommandRunner;
  /** how the skills are placed; a test hands in its own (the real one writes into the home) */
  placeSkills?: (home: string) => SkillInstallResult;
  now?: () => Date;
  /** the PATH the units copy; the installing shell's PATH when not given */
  path?: string;
  /** the state and the pi the units and the wrapper carry (absolute); the install record's value when not given */
  stateDir?: string;
  piBin?: string;
}

export interface SkippedPlacement {
  path: string;
  reason: string;
  /** what is there now, and what install would have written (for a unit or the wrapper) */
  existing?: string;
  proposed?: string;
}

export interface InstallResult {
  ok: boolean;
  home: string;
  checkout: string;
  configDir: string;
  version: string;
  prerequisites: { name: string; found: boolean }[];
  placed: string[];
  skipped: SkippedPlacement[];
  skills?: SkillInstallResult;
  steps: string[];
  commands: string[];
  errors: string[];
}

/**
 * `idd install`: prepare this machine for the propter checkout the command runs from. Creates ~/.config/idd
 * (mode 700) and puts the example settings, the skills, the units and a `~/.local/bin/idd` wrapper there.
 * Nothing already present is silently overwritten: a key file, a setting, a hand-written unit and an
 * unmarked wrapper are left as they are and the reason is reported.
 */
export function runInstall(opts: InstallOptions = {}): InstallResult {
  const home = opts.home ?? process.env.HOME ?? "";
  const checkout = opts.checkout ?? checkoutRoot();
  const runner = opts.runner ?? defaultRunner;
  const now = opts.now ?? (() => new Date());
  const configDir = installDir(home);
  const result: InstallResult = { ok: false, home, checkout, configDir, version: "", prerequisites: [], placed: [], skipped: [], steps: [], commands: [], errors: [] };

  if (!home || !isAbsolute(home)) {
    result.errors.push(`HOME が絶対パスではありません: ${JSON.stringify(home)}`);
    return result;
  }
  if (!existsSync(checkout)) {
    result.errors.push(`checkout がありません: ${checkout}`);
    return result;
  }

  // 0. where the state and the pi are: what was passed, else what the record holds. A checkout on a release tag (a run
  // clone) moves by `idd upgrade`, so it needs both from here; nothing is written until they are known.
  const previous = readInstallRecord(home);
  const given: [string, string | undefined][] = [["--state-dir", opts.stateDir], ["--pi-bin", opts.piBin]];
  for (const [flag, value] of given) {
    if (value !== undefined && !isAbsolute(value)) {
      result.errors.push(`${flag} は絶対 path で渡してください: ${JSON.stringify(value)}`);
      return result;
    }
  }
  // The record can lack them while a unit written before the record held them already runs on them (an install made
  // before this mechanism): then those values stay, so a bare re-install does not move the running state.
  const unitDir = systemdUserDir(home);
  const binDir = localBinDir(home);
  const wrapper = join(binDir, "idd");
  const carried = readCarriedPointers(unitDir, wrapper);
  const carriedValue = (name: "IDD_STATE_DIR" | "IDD_PI_BIN", flag: string): string | undefined => {
    const seen = carried.filter((c) => c.name === name);
    const values = [...new Set(seen.map((c) => c.value))];
    if (values.length > 1) result.errors.push(`既存の unit・入口の ${name} が食い違っています（${values.map((v) => `${v}: ${seen.filter((c) => c.value === v).map((c) => c.source).join("・")}`).join(" / ")}）。どれが正しいか決めて ${flag} で渡してください。何も書いていません`);
    return values.length === 1 ? values[0] : undefined;
  };
  const stateDir = opts.stateDir ?? previous?.state_dir ?? carriedValue("IDD_STATE_DIR", "--state-dir");
  const piBin = opts.piBin ?? previous?.pi_bin ?? carriedValue("IDD_PI_BIN", "--pi-bin");
  // bin/pointers.sh reads these two out of install.json line by line, so a path it cannot read back is refused here
  for (const [flag, value] of [["state", stateDir], ["pi", piBin]] as const) {
    if (value && /["\\\n\r]/.test(value)) result.errors.push(`${flag} の path に引用符・backslash・改行は使えません（入口の shell が記録から読み戻せません）: ${JSON.stringify(value)}。何も書いていません`);
  }
  if (result.errors.length) return result;
  const here = checkoutVersion(checkout, runner);
  if (here.tag && (!stateDir || !piBin)) {
    const missing = [...(stateDir ? [] : ["--state-dir"]), ...(piBin ? [] : ["--pi-bin"])];
    result.errors.push(`tag の上の checkout には state と pi の両方の指し先が要ります（足りない: ${missing.join("・")}）。unit と入口は書いていません`);
    return result;
  }
  const units: UnitContext = { checkout, path: opts.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...(stateDir ? { stateDir } : {}), ...(piBin ? { piBin } : {}), ...(here.tag ? { onTag: true } : {}) };

  // 1. the tools the checkout and the units need; a missing one is reported, not fatal (the user may install it)
  result.prerequisites = PREREQUISITES.map((name) => {
    const found = runner.capture("/bin/sh", ["-c", `command -v ${name}`]).ok;
    return { name, found };
  });
  for (const p of result.prerequisites) if (!p.found) result.steps.push(`前の道具がありません: ${p.name}`);

  // 2. the machine's place
  const existed = existsSync(configDir);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (!existed) chmodSync(configDir, 0o700);
  result.steps.push(`設定の置き場: ${configDir}${existed ? "（既にあります）" : "（作りました）"}`);

  // 3. the example settings, only where the read order finds nothing: an env override or a checkout config wins
  for (const name of CONFIG_NAMES) {
    const target = join(configDir, `${name}.yaml`);
    if (existsSync(target)) {
      result.skipped.push({ path: target, reason: "既にあるので置きませんでした" });
      continue;
    }
    if (process.env[configEnvVar(name)]?.trim()) {
      result.skipped.push({ path: target, reason: `${configEnvVar(name)} が指す先があるので置きませんでした` });
      continue;
    }
    if (existsSync(join(checkout, "config", `${name}.yaml`))) {
      result.skipped.push({ path: target, reason: `checkout の config/${name}.yaml を読むので置きませんでした` });
      continue;
    }
    const example = join(checkout, "config", `${name}.example.yaml`);
    if (!existsSync(example)) {
      result.errors.push(`例がありません: ${example}`);
      continue;
    }
    cpSync(example, target);
    result.placed.push(target);
    result.steps.push(`設定の例を置きました: ${target}`);
  }

  // 4. the skills the sessions read
  const place = opts.placeSkills ?? ((h: string) => installSkills(h));
  const skills = place(home);
  result.skills = skills;
  if (skills.ok) {
    result.placed.push(...skills.installed);
    result.steps.push(`skills を置きました: ${skills.installed.length} 本`);
  } else {
    result.skipped.push({ path: skills.agents || join(home, ".agents", "skills"), reason: skills.error ?? "skills を置けませんでした" });
  }

  // 5. the wrapper: an absolute exec, not a symlink (bin/idd decides its checkout from its own place)
  const pointerLines = [["IDD_STATE_DIR", stateDir], ["IDD_PI_BIN", piBin]].flatMap(([name, value]) => (value ? [`if [ -z "\${${name}:-}" ]; then export ${name}=${shellQuote(value)}; fi\n`] : []));
  const wrapperBody = `#!/usr/bin/env bash\n${MANAGED_MARKER}\n# install した checkout の CLI を起こす。symlink にしないのは、bin/idd が自分の置き場から checkout を決めるため。\n# state と pi の指し先は install の記録の写し。渡された環境の値があればそれが先。\nset -euo pipefail\n${pointerLines.join("")}exec "${join(checkout, "bin", "idd")}" "$@"\n`;
  mkdirSync(binDir, { recursive: true });
  if (existsSync(wrapper) && !isManaged(readFileSync(wrapper, "utf8"))) {
    result.skipped.push({ path: wrapper, reason: "目印の無い idd があるので置きませんでした", existing: readFileSync(wrapper, "utf8"), proposed: wrapperBody });
  } else {
    writeFileSync(wrapper, wrapperBody);
    chmodSync(wrapper, 0o755);
    result.placed.push(wrapper);
    result.steps.push(`wrapper を置きました: ${wrapper}`);
  }

  // 6. the units; a hand-written unit is left alone and its difference is reported
  const placement = placeUnits({ ...units, home, unitDir });
  for (const target of placement.placed) result.placed.push(target);
  for (const skip of placement.skipped) result.skipped.push(skip);
  for (const u of renderUnits(units)) {
    const target = join(unitDir, u.name);
    if (placement.placed.includes(target)) result.steps.push(`unit を書きました: ${u.name}`);
  }
  // the old screen's unit runs on this checkout's dependencies; it is stopped and removed before they can be replaced
  const legacy = retireLegacyWebUnit(unitDir, runner);
  result.steps.push(...legacy.steps);
  result.errors.push(...legacy.errors);
  // what that screen built is read by nothing once it is gone, and left in place it keeps the checkout dirty for the next intake
  const leftover = clearLegacyWebOutputs(checkout, unitDir, runner);
  result.steps.push(...leftover.steps);
  result.errors.push(...leftover.errors);
  if (placement.wrote || legacy.retired) {
    try {
      runner.run(systemctlBinary(), ["--user", "daemon-reload"]);
    } catch (err) {
      result.errors.push(`systemctl --user daemon-reload に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 7. install.json: install's own record; the migration record stays in migrations.json
  const { version } = here;
  result.version = version;
  // the commit that first carried the pointers mechanism is the floor `idd upgrade --to` does not go below. It is not
  // this checkout's HEAD: that would refuse a rollback to the previous tag, which already carries the pointers.
  // A record made from another checkout may name a commit this one cannot reach; that floor would refuse every tag
  // here and a re-install could not clear it, so it is kept only where this checkout's HEAD descends from it.
  const wantsFloor = Boolean(stateDir || piBin || previous?.pointers_commit);
  const head = wantsFloor ? headCommit(checkout, runner) : null;
  const reachable = previous?.pointers_commit && head
    ? runner.capture("git", ["merge-base", "--is-ancestor", previous.pointers_commit, head], { cwd: checkout }).ok
    : false;
  const pointersCommit = reachable ? previous?.pointers_commit : (wantsFloor ? pointersOrigin(checkout, runner) : null);
  const record: InstallRecord = {
    schema: 1,
    checkout,
    version,
    installed_at: previous?.installed_at ?? now().toISOString(),
    updated_at: now().toISOString(),
    ...(stateDir ? { state_dir: stateDir } : {}),
    ...(piBin ? { pi_bin: piBin } : {}),
    ...(pointersCommit ? { pointers_commit: pointersCommit } : {}),
  };
  writeInstallRecord(record, home);
  result.steps.push(`install.json を書きました: ${installRecordPath(home)}`);

  // 8. the dependencies and the UI build, each on its own condition: a clone that ran `npm ci` still needs the screen's bundle
  if (!existsSync(join(checkout, "node_modules"))) {
    try {
      runner.run("npm", ["ci"], { cwd: checkout });
      result.steps.push("依存を入れました: npm ci");
    } catch (err) {
      result.errors.push(`npm ci に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // the engine serves only a bundle stamped with its own commit, so a stamp that is not the head's is built again too
  if (guiBundleNeedsBuild(guiBundleDir(checkout), headCommit(checkout, runner))) {
    const [cmd, ...args] = GUI_BUILD_COMMAND;
    try {
      runner.run(cmd, args, { cwd: checkout });
      result.steps.push(`画面の bundle を build しました: ${GUI_BUILD_COMMAND.join(" ")}`);
    } catch (err) {
      result.errors.push(`${GUI_BUILD_COMMAND.join(" ")} に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  result.commands = unitStartCommands();
  result.ok = result.errors.length === 0;
  return result;
}
