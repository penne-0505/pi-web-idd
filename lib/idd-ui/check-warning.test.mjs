import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { checkReason, nonBlockingFailures } = await jiti.import("./check-warning.ts");

test("a reason is read from a finding line, the count line, or the last line", () => {
  assert.equal(checkReason("error round IDD-153: 巡に Choice がありません\n写しは見ていない\nerror 1 件、注記 0 件、印 0 件\n", "fail"), "error round IDD-153: 巡に Choice がありません");
  assert.equal(checkReason("cPath が見つかりません\nmark symbols DEC-1: x が見つかりません\nerror 276 件、注記 0 件、印 155 件\n巡と触った Place は見ていない\n", "fail"), "error 276 件、注記 0 件、印 155 件");
  assert.equal(checkReason("PASS a\ncheck-docs: FAILED: doc-links\n", "fail"), "check-docs: FAILED: doc-links");
});

test("a reason is never empty, and only failed non-blocking checks are warnings", () => {
  assert.equal(checkReason(undefined, "fail"), "fail");
  assert.deepEqual(nonBlockingFailures([
    { name: "typecheck", status: "fail", severity: "blocking", detail: "error x" },
    { name: "docs", status: "pass", severity: "non-blocking" },
    { name: "intent", status: "skipped", severity: "non-blocking" },
    { name: "lint", status: "fail", severity: "non-blocking", detail: "check-docs: FAILED: doc-links" },
  ]), [{ name: "lint", reason: "check-docs: FAILED: doc-links" }]);
  assert.deepEqual(nonBlockingFailures(undefined), []);
});
