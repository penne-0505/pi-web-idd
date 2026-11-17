import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { holdPipes, IGNORE_SIGTERM_AND_STAY } from "../../../idd-lane/test/helpers/oneshot-scripts.ts";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { parseTitleOutput, runPiOnce, setOneShotLimits } = await import("./conversation-title.ts");

// the one-shot every title and card-text run goes through: how it ends, as the callers read it
let dir;
let savedBin;
const role = { name: "titler", model: "x/y", thinking: "low", budgetMinutes: 1 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-title-oneshot-"));
  savedBin = process.env.IDD_PI_BIN;
});

afterEach(() => {
  setOneShotLimits(null);
  if (savedBin === undefined) delete process.env.IDD_PI_BIN;
  else process.env.IDD_PI_BIN = savedBin;
  rmSync(dir, { recursive: true, force: true });
});

/** a stand-in pi that runs `body` as a node script */
function standIn(body) {
  const file = join(dir, "pi");
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  process.env.IDD_PI_BIN = file;
}

const line = (text) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 3, output: 1, cost: { total: 0.01 } } } });

describe("the title one-shot", () => {
  it("a child that ignores SIGTERM ends as a failure inside the limit", async () => {
    standIn(`console.error("stuck here"); ${IGNORE_SIGTERM_AND_STAY}`);
    setOneShotLimits({ timeoutMs: 300, graceMs: 200 });
    const started = Date.now();
    await assert.rejects(runPiOnce(role, [], dir, "タイトルの生成"), /タイトルの生成が時間切れ.*: stuck here/s);
    assert.ok(Date.now() - started < 4_000);
  });

  it("a child that exits normally gives its stdout, and the title and usage are read from it", async () => {
    standIn(`console.log(${JSON.stringify(line("題名"))}); process.exit(0);`);
    const parsed = parseTitleOutput(await runPiOnce(role, [], dir, "タイトルの生成"));
    assert.equal(parsed.text, "題名");
    assert.equal(parsed.usage.input, 3);
  });

  it("a child that answered and exited gives its stdout while a grandchild holds the pipes open", async () => {
    standIn(`${holdPipes()}
console.log(${JSON.stringify(line("孫がいる題名"))}); process.exit(0);`);
    setOneShotLimits({ timeoutMs: 20_000, graceMs: 200, drainMs: 200 });
    const started = Date.now();
    assert.equal(parseTitleOutput(await runPiOnce(role, [], dir, "タイトルの生成")).text, "孫がいる題名");
    assert.ok(Date.now() - started < 3_000);
  });

  it("a child the clock ended after it had written an answer is a failure, not the partial answer", async () => {
    standIn(`console.log(${JSON.stringify(line("途中の題名"))}); ${IGNORE_SIGTERM_AND_STAY}`);
    setOneShotLimits({ timeoutMs: 300, graceMs: 200 });
    await assert.rejects(runPiOnce(role, [], dir, "タイトルの生成"), /時間切れ/);
  });

  it("a child that exits with an error fails with the exit and the tail of its stderr, as before", async () => {
    standIn(`console.error("boom"); process.exit(2);`);
    await assert.rejects(runPiOnce(role, [], dir, "card の文の生成"), /card の文の生成が exit 2 で終わりました: boom/);
  });

  it("a child that cannot be started fails", async () => {
    process.env.IDD_PI_BIN = join(dir, "no-such-pi");
    await assert.rejects(runPiOnce(role, [], dir, "タイトルの生成"));
  });
});
