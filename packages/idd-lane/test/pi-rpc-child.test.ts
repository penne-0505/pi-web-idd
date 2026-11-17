import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runPiRpcReply } from "../src/pi-rpc-child.ts";
import { tmpDir } from "./helpers/tmp.ts";

/** a pi stand-in that exits at once, before it could ever read its stdin */
function deadPi(): { bin: string; cwd: string; eventsPath: string; stderrPath: string } {
  const root = tmpDir("idd-rpc-");
  const bin = join(root, "pi");
  writeFileSync(bin, "#!/bin/sh\nexit 3;\n");
  chmodSync(bin, 0o755);
  return { bin, cwd: root, eventsPath: join(root, "events.jsonl"), stderrPath: join(root, "stderr.log") };
}

describe("a pi that goes before reading its stdin", () => {
  test("does not take the supervisor down, and the reply closes as the child's exit", async () => {
    const fx = deadPi();
    // larger than the pipe holds: the prompt is still waiting to be written when pi goes, so the write fails
    const message = "x".repeat(8_388_608);
    const reply = await runPiRpcReply({
      bin: fx.bin, args: [], cwd: fx.cwd, env: process.env, message,
      eventsPath: fx.eventsPath, stderrPath: fx.stderrPath,
      budgetMs: 10_000, floorMs: 200, stopping: () => false, onAsk: () => {},
    });
    expect(reply).toMatchObject({ exit: 3, ended: "exit", reached: false });
  });
});
