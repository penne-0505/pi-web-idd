import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");
const { GET: stateGet } = await import("../routes/state.ts");
const { setOpenConversations, setReloadWaitSince, setWaitingRequests } = await import("./staleness.ts");

let dir;
const ENV_KEYS = ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_RELOAD_WAIT_MS"];
let saved = {};

function setup() {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), "idd-reload-card-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "roles.yaml"), "roles:\n  r: { model: x/y }\n");
  process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
  process.env.IDD_RELOAD_WAIT_MS = "50";
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  setOpenConversations(() => []);
  setReloadWaitSince(null);
  setWaitingRequests([]);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("the reload card in the inbox", () => {
  it("appears once the wait for open conversations passes its limit, with the list and a fresh appearance", async () => {
    setup();
    const open = [
      { sessionId: "s1", title: "最初の会話", mode: "chat" },
      { sessionId: "s2", title: "二つ目", mode: "idea" },
    ];
    setOpenConversations(() => open);
    const since = Date.now() - 100;
    setReloadWaitSince(since);

    const state = buildState();
    const cards = state.items.filter((i) => i.kind === "reload");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].iddId, "engine-reload");
    assert.equal(cards[0].open.length, 2);
    assert.equal(cards[0].open[0].title, "最初の会話");
    // a card put off or put to sleep does not carry over to the next wait: appearedAt is when the limit was passed
    assert.equal(cards[0].appearedAt, new Date(since + 50).toISOString());
    // the empty backlog's answer is still a state, or the screen would drop the card
    assert.equal(state.source, "state");

    const res = await stateGet();
    const body = await res.json();
    assert.equal(body.items.filter((i) => i.kind === "reload").length, 1);
    assert.equal(body.source, "state");
  });

  it("is not there before the limit, and is gone once the conversations close", () => {
    setup();
    setOpenConversations(() => [{ sessionId: "s1", title: "会話" }]);
    // the wait has only just begun. The limit is far off here: buildState reads the state synchronously, and a slow
    // read must not turn "the wait has just begun" into "the limit has passed"
    process.env.IDD_RELOAD_WAIT_MS = "600000";
    setReloadWaitSince(Date.now());
    assert.equal(buildState().items.some((i) => i.kind === "reload"), false);
    // the wait has passed its limit, but nothing is open any more
    process.env.IDD_RELOAD_WAIT_MS = "50";
    setReloadWaitSince(Date.now() - 100);
    setOpenConversations(() => []);
    const state = buildState();
    assert.equal(state.items.some((i) => i.kind === "reload"), false);
    assert.equal(state.source, "empty");
  });

  it("appears once the oldest request passes the limit, listing the requests with no action", () => {
    setup();
    const oldest = new Date(Date.now() - 100).toISOString();
    setWaitingRequests([
      { method: "POST", path: "/api/idd/tick", startedAt: oldest, sending: false },
      { method: "GET", path: "/api/idd/state", startedAt: new Date(Date.parse(oldest) + 10).toISOString(), sending: true },
    ]);
    const state = buildState();
    const cards = state.items.filter((i) => i.kind === "reload");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].waiting, "requests");
    assert.equal(cards[0].requests.length, 2);
    assert.equal(cards[0].requests[0].method, "POST");
    assert.equal(cards[0].requests[0].sending, false);
    assert.equal(cards[0].requests[1].sending, true);
    assert.equal(cards[0].open.length, 0);
    // appearedAt is measured from the oldest request, so a run of short ones cannot make the card drift
    assert.equal(cards[0].appearedAt, new Date(Date.parse(oldest) + 50).toISOString());
    assert.equal(state.source, "state");
  });

  it("is not there before the oldest request passes the limit, and is gone when nothing is left", () => {
    setup();
    // the oldest request is 10 ms old, and the limit is far off: the synchronous read of the state may take longer
    // than the limit itself, and the request is still before it whatever the read costs
    process.env.IDD_RELOAD_WAIT_MS = "600000";
    setWaitingRequests([{ method: "POST", path: "/api/idd/tick", startedAt: new Date(Date.now() - 10).toISOString(), sending: false }]);
    assert.equal(buildState().items.some((i) => i.kind === "reload"), false);
    process.env.IDD_RELOAD_WAIT_MS = "50";
    setWaitingRequests([]);
    const state = buildState();
    assert.equal(state.items.some((i) => i.kind === "reload"), false);
    assert.equal(state.source, "empty");
  });
});
