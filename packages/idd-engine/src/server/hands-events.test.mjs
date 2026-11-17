import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { EVENT_META } = await jiti.import("./events-display.ts");
const { HAND_EVENTS } = await jiti.import("../../../idd-core/src/metrics/hands.ts");

// the person's events the timeline shows that the hands table leaves to its mark-based reading, and why
const KNOWN_LEFT_OUT = {
  // read through the mark `elevated_by: user`, so they fall under "unclassified" by design
  priority_elevated: "unclassified by its mark",
  priority_reset: "unclassified by its mark",
  // no writer remains in the code; an old row of it has no side to be counted under
  s4_r2_overridden: "no writer",
};

test("every event the timeline calls a person's is counted as a hand or left out here on purpose", () => {
  const people = Object.entries(EVENT_META).filter(([, m]) => m.kind === "user").map(([e]) => e);
  const missing = people.filter((e) => !HAND_EVENTS.includes(e) && !(e in KNOWN_LEFT_OUT)).sort();
  assert.deepEqual(missing, [], "declare the event in metrics/hands.ts, or name it in KNOWN_LEFT_OUT with the reason");
  const stale = Object.keys(KNOWN_LEFT_OUT).filter((e) => HAND_EVENTS.includes(e) || EVENT_META[e]?.kind !== "user");
  assert.deepEqual(stale, [], "an event left out here is now declared, or no longer a person's");
});
