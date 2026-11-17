import { afterEach, beforeEach } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tmpDir } from "./tmp.ts";

/**
 * For a test file that starts reviews: the pi it runs is a stub that lists no models and exits 0, so the role
 * checks do not spawn the real `pi --list-models` for every role. IDD_PI_BIN is put back afterwards; bun runs the
 * files of one group in one process, so a value left behind would reach the files that set their own.
 */
export function isolatePi(): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.IDD_PI_BIN;
    const bin = join(tmpDir("idd-fake-pi-"), "pi");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    process.env.IDD_PI_BIN = bin;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.IDD_PI_BIN;
    else process.env.IDD_PI_BIN = saved;
  });
}
