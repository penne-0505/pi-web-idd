import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ledgerPath, ledgerStateDir } from "../../idd-core/src/instruction/ledger.ts";
import { stateDir } from "../../idd-core/src/paths.ts";
import { GUI_BUILD_RECORD_FILE, runGuiBuild } from "../src/gui-build.ts";
import { laneStateDir, piBinary, repoRoot } from "../src/paths.ts";
import { requestTick } from "../src/tick-kick.ts";
import { waitRunRoot } from "../src/wait-run.ts";
import { tmpDir } from "./helpers/tmp.ts";

/**
 * Every entrance that decides where the state and the pi are, when the environment names neither: each reads the
 * install record's value through the one resolver. A new entrance that decides for itself would land on the
 * checkout's own `state/` here and fail.
 */

const NAMES = ["IDD_STATE_DIR", "IDD_PI_BIN", "HOME"] as const;
const saved: Record<string, string | undefined> = {};

let home: string;
let recordedState: string;
let recordedPi: string;

function writeRecord(checkout: string): void {
  mkdirSync(join(home, ".config", "idd"), { recursive: true });
  writeFileSync(join(home, ".config", "idd", "install.json"), `${JSON.stringify({ schema: 1, checkout, version: "v0", installed_at: "", state_dir: recordedState, pi_bin: recordedPi }, null, 2)}\n`);
}

beforeEach(() => {
  for (const n of NAMES) saved[n] = process.env[n];
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_PI_BIN;
  home = tmpDir("idd-pointers-home-");
  process.env.HOME = home;
  recordedState = tmpDir("idd-pointers-state-");
  recordedPi = join(tmpDir("idd-pointers-pi-"), "pi");
});

afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n];
  }
});

describe("with no value in the environment, every entrance uses the install record's state and pi", () => {
  test("stateDir, the ledger, the lane state and the wait-run root", () => {
    writeRecord(repoRoot());
    expect(stateDir()).toBe(recordedState);
    expect(ledgerStateDir()).toBe(recordedState);
    expect(ledgerPath().startsWith(`${recordedState}/`)).toBe(true);
    expect(laneStateDir()).toBe(join(recordedState, "lanes"));
    expect(waitRunRoot()).toBe(join(recordedState, "wait-run"));
  });

  test("the pi a process starts", () => {
    writeRecord(repoRoot());
    expect(piBinary()).toBe(recordedPi);
  });

  test("the GUI build record", async () => {
    writeRecord(repoRoot());
    // the build is stood in for, so the test reads where the record goes and builds nothing
    const record = await runGuiBuild({ root: repoRoot(), env: { HOME: home }, run: () => ({ status: 0 }), now: () => new Date(0) });
    expect(["built", "no-change"]).toContain(record.outcome);
    expect(existsSync(join(recordedState, GUI_BUILD_RECORD_FILE))).toBe(true);
  });

  test("the tick request books the recorded state and writes its request there", () => {
    writeRecord(repoRoot());
    const calls: string[][] = [];
    const kick = requestTick({ env: { HOME: home }, run: (_cmd, args) => { calls.push(args); return { status: 0, stdout: "", stderr: "" }; } });
    expect(kick.outcome).not.toBe("failed");
    const launch = calls.find((args) => args.some((a) => a.startsWith("--setenv=IDD_STATE_DIR=")));
    expect(launch).toContain(`--setenv=IDD_STATE_DIR=${recordedState}`);
    expect(launch).toContain(recordedState);
    expect(readdirOf(recordedState).length).toBeGreaterThan(0);
  });
});

describe("a value the environment was given wins over the record", () => {
  test("state and pi", () => {
    writeRecord(repoRoot());
    const given = tmpDir("idd-pointers-given-");
    process.env.IDD_STATE_DIR = given;
    process.env.IDD_PI_BIN = "/given/pi";
    expect(stateDir()).toBe(given);
    expect(ledgerStateDir()).toBe(given);
    expect(laneStateDir()).toBe(join(given, "lanes"));
    expect(waitRunRoot()).toBe(join(given, "wait-run"));
    expect(piBinary()).toBe("/given/pi");
  });
});

describe("a record for another checkout is not borrowed", () => {
  test("every entrance keeps its own default", () => {
    writeRecord(tmpDir("idd-pointers-elsewhere-"));
    expect(stateDir()).toBe(join(repoRoot(), "state"));
    expect(laneStateDir()).toBe(join(repoRoot(), "state", "lanes"));
    expect(piBinary()).not.toBe(recordedPi);
    expect(waitRunRoot().startsWith(recordedState)).toBe(false);
  });
});

function readdirOf(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
