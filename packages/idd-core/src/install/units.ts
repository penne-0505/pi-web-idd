import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CommandRunner } from "./proc.ts";
import { MANAGED_MARKER, isManaged, systemctlBinary } from "./records.ts";

/** the two units and the timer `idd install` writes into ~/.config/systemd/user */
export interface UnitFile {
  name: string;
  body: string;
}

export interface UnitContext {
  /** the checkout the units run from (install's own checkout) */
  checkout: string;
  /** the PATH copied from the shell `idd install` ran in, so the user's node / bun / claude are visible */
  path: string;
  /** the state and the pi the units start their processes with, as absolute paths; unset leaves the checkout's own defaults */
  stateDir?: string;
  piBin?: string;
  /** the checkout sits on a release tag (a run clone): only then does the engine never ask to replace itself */
  onTag?: boolean;
  /** the engine's port (30144 by default); the screen is served on it under /gui, so there is no port of its own */
  enginePort?: number;
}

/** one word of an ExecStart line: systemd's `%` and `$` doubled, and quoted when it holds a space or a quote */
function word(text: string): string {
  const doubled = text.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  if (!/[\s"'\\;]/.test(doubled)) return doubled;
  return `"${doubled.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * What the process starts under. systemd lets an EnvironmentFile (and the user manager's own environment) win over
 * `Environment=`, so a value that must hold is set by `env` at ExecStart, after every file was read. bin/idd and
 * bin/idd-engine read gateway.env again but keep what the environment already has.
 */
function launch(ctx: UnitContext, ...extra: string[]): string {
  const assign = [...(ctx.stateDir ? [`IDD_STATE_DIR=${ctx.stateDir}`] : []), ...(ctx.piBin ? [`IDD_PI_BIN=${ctx.piBin}`] : []), ...extra];
  return assign.length ? `${["/usr/bin/env", ...assign.map(word)].join(" ")} ` : "";
}

const header = (description: string) => `${MANAGED_MARKER}\n[Unit]\nDescription=${description}\n`;

/** the engine: state, tick, supervisor and the HTTP API (localhost only) */
function engineUnit(ctx: UnitContext, enginePort: number): UnitFile {
  return {
    name: "idd-engine.service",
    body: [
      header("propter engine (state, tick, supervisor, HTTP API and the screen under /gui; localhost-only)"),
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      `WorkingDirectory=${ctx.checkout}`,
      `Environment=PATH=${ctx.path}`,
      `Environment=IDD_ENGINE_PORT=${enginePort}`,
      `Environment=IDD_AGENT_BASE_URL=http://127.0.0.1:${enginePort}`,
      "EnvironmentFile=-%h/.config/idd/gateway.env",
      // a checkout on a tag only moves by `idd upgrade`, which a person runs: its engine never asks to replace itself,
      // whatever gateway.env says. A development checkout keeps the replacement it always had.
      `ExecStart=${launch(ctx, ...(ctx.onTag ? ["IDD_RELOAD=off"] : []))}${ctx.checkout}/bin/idd-engine`,
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  };
}

/** one tick pass (intake + advance lanes); the timer starts it */
function tickService(ctx: UnitContext): UnitFile {
  return {
    name: "idd-tick.service",
    body: [
      header("propter tick (intake + advance lanes)"),
      "After=idd-engine.service",
      "",
      "[Service]",
      "Type=oneshot",
      `WorkingDirectory=${ctx.checkout}`,
      `Environment=PATH=${ctx.path}`,
      `ExecStart=${launch(ctx)}${ctx.checkout}/bin/idd tick`,
      "TimeoutStartSec=20min",
      "Nice=10",
      "",
    ].join("\n"),
  };
}

function tickTimer(): UnitFile {
  return {
    name: "idd-tick.timer",
    body: [
      header("Run the propter tick every 15 minutes"),
      "",
      "[Timer]",
      "OnCalendar=*:00,15,30,45",
      "RandomizedDelaySec=60",
      "Persistent=false",
      "Unit=idd-tick.service",
      "",
      "[Install]",
      "WantedBy=timers.target",
      "",
    ].join("\n"),
  };
}

/** the three files install writes; the port is the one the running engine uses today */
export function renderUnits(ctx: UnitContext): UnitFile[] {
  return [engineUnit(ctx, ctx.enginePort ?? 30144), tickService(ctx), tickTimer()];
}

/** the commands that bring the installed units up; install never enables or starts them by itself */
export function unitStartCommands(): string[] {
  return [
    "systemctl --user enable --now idd-engine.service",
    "systemctl --user enable --now idd-tick.timer",
  ];
}

export interface UnitPlacement {
  placed: string[];
  skipped: { path: string; reason: string; existing?: string; proposed?: string }[];
  /** at least one file was new or changed, so `systemctl --user daemon-reload` is owed */
  wrote: boolean;
}

/**
 * Write the three units, rewriting the ones install wrote before and leaving a hand-written one alone with
 * its difference. Shared by `idd install` and the unit step of `idd upgrade --here`.
 */
export function placeUnits(opts: UnitContext & { home: string; unitDir: string }): UnitPlacement {
  mkdirSync(opts.unitDir, { recursive: true });
  const out: UnitPlacement = { placed: [], skipped: [], wrote: false };
  for (const unit of renderUnits(opts)) {
    const target = join(opts.unitDir, unit.name);
    const present = existsSync(target);
    if (present && !isManaged(readFileSync(target, "utf8"))) {
      out.skipped.push({ path: target, reason: "目印の無い unit があるので書き換えませんでした", existing: readFileSync(target, "utf8"), proposed: unit.body });
      continue;
    }
    const changed = !present || readFileSync(target, "utf8") !== unit.body;
    writeFileSync(target, unit.body);
    out.wrote = out.wrote || changed;
    out.placed.push(target);
  }
  return out;
}

/** the unit the previous screen (a Next app on 30142) ran under; it runs on the checkout's node_modules, which a later `npm ci` replaces */
export const LEGACY_WEB_UNIT = "idd-web.service";

/** whether the old screen's unit is there and whether `idd install` wrote it (a hand-written one is never ours to remove) */
export function legacyWebUnitKind(unitDir: string): "none" | "managed" | "hand-written" {
  const target = join(unitDir, LEGACY_WEB_UNIT);
  if (!existsSync(target)) return "none";
  return isManaged(readFileSync(target, "utf8")) ? "managed" : "hand-written";
}

export interface LegacyWebRetirement {
  /** the unit file was removed, so `systemctl --user daemon-reload` is owed */
  retired: boolean;
  steps: string[];
  errors: string[];
}

/**
 * Stop, disable and remove the old screen's unit when `idd install` wrote it: the engine serves the screen now, and a
 * unit left on the checkout's old dependencies fails at its next start. A hand-written unit is left as it is. The file is
 * removed only after the stop and the disable succeeded, so a failure leaves a unit that can still be stopped by hand.
 */
export function retireLegacyWebUnit(unitDir: string, runner: CommandRunner): LegacyWebRetirement {
  const out: LegacyWebRetirement = { retired: false, steps: [], errors: [] };
  const kind = legacyWebUnitKind(unitDir);
  if (kind === "none") return out;
  if (kind === "hand-written") {
    out.steps.push(`手書きの ${LEGACY_WEB_UNIT} は止めも消しもしませんでした（画面は engine の /gui が配ります。不要なら自分で止めて消してください）`);
    return out;
  }
  for (const verb of ["stop", "disable"]) {
    try {
      runner.run(systemctlBinary(), ["--user", verb, LEGACY_WEB_UNIT]);
    } catch (err) {
      out.errors.push(`systemctl --user ${verb} ${LEGACY_WEB_UNIT} に失敗しました。unit は残しています: ${err instanceof Error ? err.message : String(err)}`);
      return out;
    }
  }
  rmSync(join(unitDir, LEGACY_WEB_UNIT), { force: true });
  out.retired = true;
  out.steps.push(`旧画面の ${LEGACY_WEB_UNIT} を止めて無効にし、unit を外しました（画面は engine の /gui が配ります）`);
  return out;
}

/** what the old screen's build left at the checkout's root; once the screen is gone nothing reads either */
export const LEGACY_WEB_OUTPUTS = [".next", "next-env.d.ts"] as const;

/** whether a `git status --porcelain` line is one of the old screen's build outputs seen as untracked (a dir is one line, not its files) */
export function isLegacyWebOutputStatus(line: string): boolean {
  return line.trimEnd() === "?? .next/" || line.trimEnd() === "?? next-env.d.ts";
}

export interface LegacyWebOutputs {
  /** the outputs that are there now */
  present: string[];
  /** why they must stay (the screen or its unit is still here, or git cannot say they are untracked); null when they may go */
  heldBy: string | null;
  /** `heldBy` is about the tree holding the screen (a `next` dependency, a `next.config.*`), which a move to another tag can change */
  byTree: boolean;
}

/** how the old screen's presence is read out of a tree: the root's names (null when unreadable) and its `package.json` */
interface ScreenTree {
  /** the root's `package.json`: its text, or why there is none to read */
  packageJson(): { text: string } | "absent" | "unreadable";
  rootNames(): string[] | null;
}

/** a checkout's working tree, as the files on disk */
function workingTree(checkout: string): ScreenTree {
  return {
    packageJson() {
      const file = join(checkout, "package.json");
      if (!existsSync(file)) return "absent";
      try { return { text: readFileSync(file, "utf8") }; } catch { return "unreadable"; }
    },
    rootNames() {
      try { return readdirSync(checkout); } catch { return null; }
    },
  };
}

/** a release tag's tree, as git holds it: what a move to that tag would leave at the root */
function tagTree(checkout: string, tag: string, runner: CommandRunner): ScreenTree {
  const listed = runner.capture("git", ["ls-tree", "--name-only", `refs/tags/${tag}^{tree}`], { cwd: checkout });
  const names = listed.ok ? listed.stdout.split("\n").map((n) => n.trim()).filter(Boolean) : null;
  return {
    packageJson() {
      if (names === null) return "unreadable";
      if (!names.includes("package.json")) return "absent";
      const text = runner.capture("git", ["show", `refs/tags/${tag}^{tree}:package.json`], { cwd: checkout });
      return text.ok ? { text: text.stdout } : "unreadable";
    },
    rootNames: () => names,
  };
}

/** whether `package.json`'s text names `next` in any of its dependency tables; null when it is not JSON */
function dependsOnNext(text: string): boolean | null {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((table) => {
      const deps = pkg[table];
      return typeof deps === "object" && deps !== null && "next" in deps;
    });
  } catch {
    return null;
  }
}

/** why the tree still holds the old screen (a `next` dependency, a root `next.config.*`, or that it cannot be told); null when it does not */
function screenHeldBy(tree: ScreenTree): string | null {
  const pkg = tree.packageJson();
  const next = pkg === "absent" ? false : pkg === "unreadable" ? null : dependsOnNext(pkg.text);
  if (next === null) return "package.json を読めないので、旧画面が残っているか分かりません";
  if (next) return "package.json が next に依存していて、旧画面がまだこの checkout にあります";
  const names = tree.rootNames();
  if (names === null) return "checkout の root を読めないので、next.config.* が残っているか分かりません";
  const config = names.find((name) => name.startsWith("next.config."));
  return config ? `root に ${config} があり、旧画面がまだこの checkout にあります` : null;
}

/**
 * Read what the old screen left in the checkout and whether it may be removed. It may when the tree no longer holds the screen
 * (no `next` dependency, no root `next.config.*`) and its unit is gone, or is one `idd install` wrote that the caller is about to
 * retire (`unitMayGo`): a hand-written unit still starts `node_modules/next` directly, so a `package.json` without `next` does not
 * show the screen has stopped. The tree is the checkout's own, or the release tag's it is about to move to (`tag`): a checkout whose
 * `package.json` still names `next` loses nothing when the tag it moves to does not. What git tracks is never removed.
 */
export function readLegacyWebOutputs(checkout: string, unitDir: string, runner: CommandRunner, opts: { unitMayGo?: boolean; tag?: string } = {}): LegacyWebOutputs {
  const present = LEGACY_WEB_OUTPUTS.filter((name) => {
    try { lstatSync(join(checkout, name)); return true; } catch { return false; }
  });
  if (present.length === 0) return { present, heldBy: null, byTree: false };
  const screen = screenHeldBy(opts.tag ? tagTree(checkout, opts.tag, runner) : workingTree(checkout));
  if (screen) return { present, heldBy: screen, byTree: true };
  const held = (heldBy: string): LegacyWebOutputs => ({ present, heldBy, byTree: false });
  const unit = legacyWebUnitKind(unitDir);
  if (unit === "hand-written") return held(`手書きの ${LEGACY_WEB_UNIT} が残っていて、その画面は node_modules の next を直接起こします`);
  if (unit === "managed" && !opts.unitMayGo) return held(`旧画面の ${LEGACY_WEB_UNIT} がまだ残っています`);
  const tracked = runner.capture("git", ["ls-files", "--", ...present], { cwd: checkout });
  if (!tracked.ok) return held("git が追跡しているか確かめられませんでした");
  if (tracked.stdout.trim()) return held("git が追跡している file があります");
  return { present, heldBy: null, byTree: false };
}

export interface LegacyWebOutputClearing {
  steps: string[];
  errors: string[];
}

/**
 * Remove the old screen's build output once the screen is confirmed gone: `idd install` and `idd upgrade` call it right after
 * the unit step, so a checkout does not stay dirty on files nothing reads. It says what it removed, or why it left them.
 */
export function clearLegacyWebOutputs(checkout: string, unitDir: string, runner: CommandRunner): LegacyWebOutputClearing {
  const out: LegacyWebOutputClearing = { steps: [], errors: [] };
  const { present, heldBy } = readLegacyWebOutputs(checkout, unitDir, runner);
  if (present.length === 0) return out;
  if (heldBy) {
    out.steps.push(`旧画面の build 出力（${present.join("・")}）は消しませんでした: ${heldBy}`);
    return out;
  }
  for (const name of present) {
    try {
      rmSync(join(checkout, name), { recursive: true, force: true });
    } catch (err) {
      out.errors.push(`旧画面の build 出力 ${name} を消せませんでした: ${err instanceof Error ? err.message : String(err)}`);
      return out;
    }
  }
  out.steps.push(`旧画面の build 出力を消しました: ${present.join("・")}（画面は engine の /gui が配ります）`);
  return out;
}

export interface CarriedPointer {
  /** the file the value was read from */
  source: string;
  name: "IDD_STATE_DIR" | "IDD_PI_BIN";
  value: string;
}

/** the words of an ExecStart line as systemd reads them: double quotes group, `\` escapes inside them, `%%` and `$$` are one character */
function execWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let open = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === "\\" && i + 1 < line.length) {
      current += line[++i];
    } else if (ch === '"') {
      quoted = !quoted;
      open = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (open || current) words.push(current);
      current = "";
      open = false;
    } else {
      current += ch;
    }
  }
  if (open || current) words.push(current);
  return words.map((w) => w.replace(/%%/g, "%").replace(/\$\$/g, "$"));
}

/**
 * The state and the pi that the units and the wrapper `idd install` wrote earlier carry, as absolute paths.
 * Only files with the install mark count: a hand-written unit or wrapper is never redrawn, so what it holds is not ours to keep.
 */
export function readCarriedPointers(unitDir: string, wrapper: string): CarriedPointer[] {
  const found: CarriedPointer[] = [];
  const add = (source: string, name: CarriedPointer["name"], value: string) => {
    if (value.startsWith("/")) found.push({ source, name, value });
  };
  for (const unit of ["idd-engine.service", "idd-tick.service"]) {
    const target = join(unitDir, unit);
    if (!existsSync(target)) continue;
    const text = readFileSync(target, "utf8");
    if (!isManaged(text)) continue;
    for (const line of text.split("\n")) {
      if (!line.startsWith("ExecStart=")) continue;
      for (const w of execWords(line.slice("ExecStart=".length))) {
        for (const name of ["IDD_STATE_DIR", "IDD_PI_BIN"] as const) if (w.startsWith(`${name}=`)) add(target, name, w.slice(name.length + 1));
      }
    }
  }
  if (existsSync(wrapper)) {
    const text = readFileSync(wrapper, "utf8");
    if (isManaged(text)) {
      // the wrapper single-quotes the value, a quote in it written as '\''
      for (const m of text.matchAll(/export (IDD_STATE_DIR|IDD_PI_BIN)='((?:[^']|'\\'')*)'/g)) {
        add(wrapper, m[1] as CarriedPointer["name"], m[2].replace(/'\\''/g, "'"));
      }
    }
  }
  return found;
}
