import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { chosenLabels, labelChoices, labelSummary } = await jiti.import("./review-labels.ts");

const rules = {
  comment: { remove: ["awaiting review"], add: ["feedback"] },
  "request-changes": { remove: ["awaiting review"], add: ["feedback", "changes"] },
};

test("the card shows the labels of the kind penne picked, all checked at first", () => {
  const off = new Set();
  assert.deepEqual(labelChoices(rules, "comment", off).map((c) => [c.op, c.label, c.checked]), [["remove", "awaiting review", true], ["add", "feedback", true]]);
  assert.deepEqual(labelChoices(rules, "request-changes", off).map((c) => c.label), ["awaiting review", "feedback", "changes"]);
  assert.deepEqual(labelChoices(rules, "approve", off), []);
  assert.deepEqual(labelChoices(undefined, "comment", off), []);
});

test("an unchecked label is not swapped, and unchecking it for one kind leaves the other kinds alone", () => {
  const off = new Set(["request-changes:add:changes"]);
  assert.deepEqual(chosenLabels(labelChoices(rules, "request-changes", off)), { remove: ["awaiting review"], add: ["feedback"] });
  assert.deepEqual(chosenLabels(labelChoices(rules, "comment", off)), { remove: ["awaiting review"], add: ["feedback"] });
  const none = new Set(["comment:remove:awaiting review", "comment:add:feedback"]);
  assert.deepEqual(chosenLabels(labelChoices(rules, "comment", none)), { remove: [], add: [] });
});

test("the confirmation says which labels change, and nothing when none does", () => {
  assert.equal(labelSummary({ remove: ["awaiting review"], add: ["feedback"] }), "ラベル: awaiting review を外す、feedback を付ける");
  assert.equal(labelSummary({ remove: [], add: ["approved"] }), "ラベル: approved を付ける");
  assert.equal(labelSummary({ remove: [], add: [] }), null);
});
