import { describe, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG = resolve(import.meta.dir, "../../../../config");

/** a config file this checkout ships; roles.yaml and modes.yaml are overlay files, so a stripped copy and the public checkout do not have them */
export const shippedConfig = (file: string): string => resolve(CONFIG, file);

/**
 * the paths of the named overlay files this checkout does not have; the machine's ~/.config/idd is never asked.
 * `*.example.yaml` is tracked in every checkout, so one that is gone is a defect and is not counted here: its test runs and fails.
 */
export function missingShipped(...files: string[]): string[] {
  return files
    .filter((file) => !file.includes(".example."))
    .map(shippedConfig)
    .filter((path) => !existsSync(path));
}

const reason = (missing: string[]): string => `(skipped: ${missing.join(", ")} を読めません)`;

/**
 * A test that reads the named shipped config files itself. Where one is missing it is skipped, and the skipped name
 * carries the path that could not be read, so the run says "not checked" rather than failing or checking a stand-in.
 */
export function shippedConfigTest(files: string[], name: string, fn: () => void | Promise<void>): void {
  const missing = missingShipped(...files);
  if (missing.length === 0) test(name, fn);
  else test.skip(`${name} ${reason(missing)}`, fn);
}

/** the same for a block of tests that all read the named shipped config files */
export function shippedConfigDescribe(files: string[], name: string, fn: () => void): void {
  const missing = missingShipped(...files);
  if (missing.length === 0) describe(name, fn);
  else describe.skip(`${name} ${reason(missing)}`, fn);
}
