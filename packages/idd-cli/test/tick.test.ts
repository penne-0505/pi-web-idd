import { describe, expect, test } from "bun:test";

import { commandAsksForTick, tickBody } from "../src/tick.ts";

describe("tickBody", () => {
  test("takes in Issues unless --no-intake is given", () => {
    expect(tickBody([])).toEqual({ intake: true });
    expect(tickBody(["--no-intake"])).toEqual({ intake: false });
  });

  test("any other argument (--help included) is refused, so a typo never runs a tick that takes in Issues", () => {
    expect(() => tickBody(["--help"])).toThrow(/idd tick \[--no-intake\] \[--for-state DIR\]/);
    expect(() => tickBody(["--no-intak"])).toThrow(/--no-intak/);
    expect(() => tickBody(["--no-intake", "extra"])).toThrow(/extra/);
  });

  test("--for-state names the state the tick is for, and the server does nothing when its own is another", () => {
    expect(tickBody(["--no-intake", "--for-state", "/s/state"])).toEqual({ intake: false, for_state: "/s/state" });
    expect(tickBody(["--for-state", "/s/state", "--no-intake"])).toEqual({ intake: false, for_state: "/s/state" });
    expect(() => tickBody(["--no-intake", "--for-state"])).toThrow(/--for-state/);
    expect(() => tickBody(["--for-state", "--no-intake"])).toThrow(/--for-state/);
  });
});

describe("commandAsksForTick", () => {
  test("the commands that write what the next tick acts on ask for it; reading and proposing do not", () => {
    // accept-receive takes a lane's public branch in, as the UI's import with a lane does
    for (const c of ["import", "accept-receive", "reclaim", "intake"]) expect(commandAsksForTick(c)).toBe(true);
    // an ignore closes a lane, and a redo closes one and opens another: both leave the tick work to do
    expect(commandAsksForTick("ignore")).toBe(true);
    expect(commandAsksForTick("lane", "redo")).toBe(true);
    expect(commandAsksForTick("review", "open")).toBe(true);
    expect(commandAsksForTick("review", "resume")).toBe(true);
    // ship and export only send penne to the submit card: they write nothing the tick acts on
    for (const c of ["ship", "propose", "export", "sync", "tick", "review-import", "propose-import", "receive", "adopt", "review-receive"]) expect(commandAsksForTick(c)).toBe(false);
    for (const s of ["list", "show", "close", "map"]) expect(commandAsksForTick("review", s)).toBe(false);
    for (const s of ["run", "status", "tail", "send", "stop", "roles"]) expect(commandAsksForTick("lane", s)).toBe(false);
  });
});
