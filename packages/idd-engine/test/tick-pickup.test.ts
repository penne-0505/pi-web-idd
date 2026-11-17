import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { TICK_AGAIN_FILE, TICK_AGAIN_INTAKE_FILE, TICK_HOLD_FILE } from "@idd/core";
import { pickUpLeftTick } from "../src/server/tick-kick.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

/** a booking that records how many times it was asked */
function counter() {
  let booked = 0;
  return { booked: () => booked, book: () => { booked += 1; return { outcome: "scheduled" as const }; } };
}

describe("picking up a tick request left while the engine was down", () => {
  test("books one tick when the request is in the state", () => {
    const state = tmpDir("idd-tick-pickup-");
    writeFileSync(join(state, TICK_AGAIN_FILE), new Date().toISOString());
    const c = counter();
    const kick = pickUpLeftTick({ state, book: c.book });
    expect(c.booked()).toBe(1);
    expect(kick?.outcome).toBe("scheduled");
  });

  test("books one tick when only the intake request is left", () => {
    const state = tmpDir("idd-tick-pickup-");
    writeFileSync(join(state, TICK_AGAIN_INTAKE_FILE), JSON.stringify({ all: true }));
    const c = counter();
    pickUpLeftTick({ state, book: c.book });
    expect(c.booked()).toBe(1);
  });

  test("books one tick when the held request of a replacement is left", () => {
    const state = tmpDir("idd-tick-pickup-");
    writeFileSync(join(state, TICK_HOLD_FILE), JSON.stringify({ reason: "engine を入れ替えています", ask: { all: true } }));
    const c = counter();
    pickUpLeftTick({ state, book: c.book });
    expect(c.booked()).toBe(1);
  });

  test("books nothing when no request is left", () => {
    const state = tmpDir("idd-tick-pickup-");
    const c = counter();
    const kick = pickUpLeftTick({ state, book: c.book });
    expect(c.booked()).toBe(0);
    expect(kick).toBeNull();
  });

  test("a failing booking is a warning, never a failed start", () => {
    const state = tmpDir("idd-tick-pickup-");
    writeFileSync(join(state, TICK_AGAIN_FILE), new Date().toISOString());
    expect(() => pickUpLeftTick({ state, book: () => { throw new Error("no systemd"); } })).not.toThrow();
  });
});
