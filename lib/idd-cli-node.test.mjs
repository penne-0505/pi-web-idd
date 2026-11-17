import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ROOT = process.cwd();

test("the Node CLI starts, and the default engine port is read without a workspace link", () => {
  // idd-lane reads idd-core by path, the way the CLI's own files cross packages: a bare package name
  // would need a workspace link that a plain Node checkout does not have
  const source = readFileSync(`${ROOT}/packages/idd-lane/src/tick-kick.ts`, "utf8");
  assert.doesNotMatch(source, /from "@idd\/core"/);
  assert.match(source, /from "\.\.\/\.\.\/idd-core\/src\/agent\/token\.ts"/);

  const out = execFileSync(process.execPath, ["--experimental-strip-types", "packages/idd-cli/bin/idd.ts", "help"], { cwd: ROOT, encoding: "utf8" });
  assert.match(out, /^usage:/m);
});
