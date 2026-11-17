/**
 * Pieces of a stand-in `pi` script (node source) for the tests of the one-shot run, so that every caller's test builds
 * its stuck child and its grandchild the same way instead of writing the same lines again.
 */

/** a grandchild that inherits stdout/stderr and outlives the child, so `close` does not come until it ends */
export function holdPipes(ms = 4_000): string {
  return `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, ${ms})"], { stdio: ["ignore", "inherit", "inherit"] }).unref();`;
}

/** a child that ignores SIGTERM and never ends on its own */
export const IGNORE_SIGTERM_AND_STAY = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
