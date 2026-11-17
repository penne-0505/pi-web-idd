import assert from "node:assert/strict";
import test from "node:test";

import { h, load, render } from "./helpers.mjs";
import { fakeFetch, fakeStreams, settle } from "./fake.mjs";

const { ChatStore } = await load("./src/chat/store.ts");
const { WORDS } = await load("./src/strings.ts");
const { conversationSettingsVals: settingsVals } = await load("./src/chat/settings.ts");
const { ContextPopover, ConversationSettings } = await load("./src/components/chat/ContextPopover.tsx");

const SKILL_A = "/skills/alpha";
const SKILL_B = "/c/.agents/skills/beta";
const SKILL_OTHER = "/elsewhere/.agents/skills/other";

const CANDIDATE_A = { path: SKILL_A, name: "alpha", description: "a skill", origin: "user" };
const CANDIDATE_B = { path: SKILL_B, name: "beta", description: "b skill", origin: "workspace" };

/** the settings door's answer, in the engine's own shape */
function settingsBody({ skills = [SKILL_A], webSearch = true, mcp = false, candidates = [CANDIDATE_A, CANDIDATE_B] } = {}) {
  return {
    ok: true,
    settings: { skills, webSearch, webSearchTools: ["web_search"], mcp },
    candidates: candidates.map((candidate) => ({ ...candidate, enabled: skills.includes(candidate.path) })),
    path: "/state/pipeline/conversation-settings.json",
  };
}

function openBody(extra = {}) {
  return { ok: true, entries: [], leafId: null, queue: [], streaming: false, cwd: "/c", features: { webSearch: false, mcp: false, skills: [] }, ...extra };
}

const settingsRoute = (cwd) => `/api/conversation-settings?cwd=${encodeURIComponent(cwd)}`;

test("AC-001: the rows come from the settings door, and a press sends the whole skill list with the cwd", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);
  const p = store.select("c1");
  f.last().respond(200, openBody({ cwd: "/c", features: { webSearch: false, mcp: false, skills: [SKILL_A] } }));
  await p;
  await settle();

  // the settings read carries the conversation's cwd, so the repo's own skills are candidates too
  const read = f.of(settingsRoute("/c"))[0];
  assert.ok(read, "the settings door is asked with the open conversation's cwd");
  read.respond(200, settingsBody());
  await settle();

  const bare = { setSkill: () => {}, setFeature: () => {} };
  const view = settingsVals(store.state, bare);
  const rows = view.groups.flatMap((group) => group.rows);
  assert.deepEqual(rows.map((row) => row.path).sort(), [SKILL_A, SKILL_B].sort());
  assert.equal(rows.find((row) => row.path === SKILL_A).on, true);
  assert.equal(rows.find((row) => row.path === SKILL_B).on, false);
  assert.equal(rows.find((row) => row.path === SKILL_B).effective, false);
  assert.equal(view.path, "/state/pipeline/conversation-settings.json");

  // a press reaches the settings door with the full list and the cwd; the row moves to the engine's answer
  const change = store.setSkill(SKILL_B, true);
  const patch = f.calls[f.calls.length - 1];
  assert.equal(patch.path, "/api/conversation-settings");
  assert.equal(patch.init?.method, "PATCH");
  assert.deepEqual(patch.body, { skills: [SKILL_A, SKILL_B], cwd: "/c" });
  patch.respond(200, { ...settingsBody({ skills: [SKILL_A, SKILL_B] }), effectiveSkills: [SKILL_A, SKILL_B] });
  await change;
  assert.deepEqual(store.state.settings.values.skills, [SKILL_A, SKILL_B]);

  // the two switches that are not skills use the same door, and carry only their own field
  const feature = store.setFeature("webSearch", false);
  const featurePatch = f.calls[f.calls.length - 1];
  assert.deepEqual(featurePatch.body, { webSearch: false, cwd: "/c" });
  featurePatch.respond(200, settingsBody({ webSearch: false }));
  await feature;
  assert.equal(store.state.settings.values.webSearch, false);
  assert.equal(f.calls.some((call) => call.path.endsWith("/command")), false);
});

test("AC-001: a refused change shows the engine's reason and leaves the rows on the engine's values", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);
  const p = store.select("c1");
  f.last().respond(200, openBody({ cwd: "/c" }));
  await p;
  await settle();
  f.of(settingsRoute("/c"))[0].respond(200, settingsBody());
  await settle();

  const change = store.setSkill("/arbitrary", true);
  const patch = f.calls[f.calls.length - 1];
  patch.respond(400, { ok: false, error: "候補に無い skill は ON にできません: /arbitrary" });
  await change;
  assert.equal(store.state.settings.error, "候補に無い skill は ON にできません: /arbitrary");
  assert.deepEqual(store.state.settings.values.skills, [SKILL_A], "the refusal leaves the engine's own list");
  assert.equal(store.state.settings.busy, false);
});

test("AC-002: the switch is the settings value, and the effective value is drawn apart from it", () => {
  const state = {
    settings: settingsValsState([SKILL_A], true, false, [CANDIDATE_A, CANDIDATE_B]),
    open: { features: { webSearch: true, mcp: false, skills: [SKILL_A] } },
  };
  const handlers = { setSkill: () => {}, setFeature: () => {} };
  const view = settingsVals(state, handlers);
  const rows = view.groups.flatMap((group) => group.rows);
  const alpha = rows.find((row) => row.path === SKILL_A);
  assert.equal(alpha.on, true, "the switch is the settings value");
  assert.equal(alpha.effective, true, "and the effective value is its own field");
  assert.equal(alpha.differs, false);
  const webSearch = view.features.find((feature) => feature.key === "webSearch");
  assert.equal(webSearch.on, true);
  assert.equal(webSearch.effective, true);
  assert.equal(webSearch.differs, false);

  // the settings are ahead of the running pi: the switch and the effective value disagree, and the next one is named
  const behind = settingsVals({ ...state, open: { features: { webSearch: false, mcp: false, skills: [] } } }, handlers);
  const changed = behind.groups.flatMap((group) => group.rows).find((row) => row.path === SKILL_A);
  assert.equal(changed.on, true);
  assert.equal(changed.effective, false);
  assert.equal(changed.next, true);
  assert.equal(changed.differs, true);
  const ws = behind.features.find((feature) => feature.key === "webSearch");
  assert.equal(ws.on, true);
  assert.equal(ws.effective, false);
  assert.equal(ws.differs, true);

  // an open door that said nothing about its pi is drawn as unknown, never as off
  const unknown = settingsVals({ ...state, open: { features: null } }, handlers);
  assert.equal(unknown.effectiveKnown, false);
  assert.equal(unknown.groups.flatMap((group) => group.rows).find((row) => row.path === SKILL_A).effective, null);
});

test("AC-002: a Claude Code conversation never claims the settings reach its next start", () => {
  const state = {
    settings: settingsValsState([SKILL_A], true, false, [CANDIDATE_A, CANDIDATE_B]),
    open: { harness: "claude", features: { webSearch: false, mcp: false, skills: [] } },
  };
  const handlers = { setSkill: () => {}, setFeature: () => {} };
  const view = settingsVals(state, handlers);
  assert.equal(view.featuresApply, false, "the open door said Claude Code: the settings never reach its start");
  assert.equal(view.scopeNote, WORDS.chat.settings.scopeOtherConversations);
  const html = render(h(ConversationSettings, { view }));
  assert.match(html, /data-skill="\/skills\/alpha" data-on="on" data-effective="off" data-applies="off"/);
  assert.match(html, /data-feature="webSearch" data-on="on" data-effective="off" data-applies="off"/);
  assert.ok(!html.includes("今 OFF"), "no now value is drawn for a start that never reads the settings");
  assert.ok(!html.includes("次の pi から ON") && !html.includes("次の pi から OFF"), "and no next-pi value either");
  assert.match(html, /この会話（Claude Code）には渡りません/);

  // a pi conversation, and an open door that did not name a harness, keep the values they drew before
  for (const harness of ["pi", undefined]) {
    const open = { ...state.open, harness };
    const drawn = settingsVals({ ...state, open }, handlers);
    assert.equal(drawn.featuresApply, harness === "pi" ? true : null);
    assert.equal(drawn.scopeNote, WORDS.chat.settings.scope);
    const piHtml = render(h(ConversationSettings, { view: drawn }));
    assert.match(piHtml, /\u4eca OFF \u00b7 \u6b21\u306e pi \u304b\u3089 ON/);
    assert.match(piHtml, new RegExp(`data-skill="/skills/alpha" data-on="on" data-effective="off" data-applies="${harness === "pi" ? "on" : "unknown"}"`));
    assert.ok(!piHtml.includes(WORDS.chat.settings.notReceived));
  }
});

test("AC-004: a skill on for another cwd is listed apart and kept in the full list a change sends", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);
  const p = store.select("c1");
  f.last().respond(200, openBody({ cwd: "/c" }));
  await p;
  await settle();
  f.of(settingsRoute("/c"))[0].respond(200, settingsBody({ skills: [SKILL_OTHER] }));
  await settle();

  const handlers = { setSkill: () => {}, setFeature: () => {} };
  const view = settingsVals(store.state, handlers);
  assert.deepEqual(view.groups.map((group) => group.origin), ["user", "workspace", "other"]);
  const foreign = view.groups.find((group) => group.origin === "other").rows[0];
  assert.equal(foreign.path, SKILL_OTHER);
  assert.equal(foreign.on, true);
  assert.equal(foreign.next, false, "this cwd's next pi is never handed another place's skill");
  assert.equal(foreign.foreign, true);

  // turning one of this cwd's own skills on keeps the other cwd's skill in the list it sends
  const change = store.setSkill(SKILL_A, true);
  const patch = f.calls[f.calls.length - 1];
  assert.deepEqual(patch.body, { skills: [SKILL_OTHER, SKILL_A], cwd: "/c" });
  patch.respond(200, settingsBody({ skills: [SKILL_OTHER, SKILL_A], candidates: [CANDIDATE_A, CANDIDATE_B] }));
  await change;
  assert.deepEqual(store.state.settings.values.skills, [SKILL_OTHER, SKILL_A]);
});

test("AC-005: a settings answer for a conversation the screen left changes nothing of the next one", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);

  const p1 = store.select("c1");
  f.last().respond(200, openBody({ cwd: "/c1" }));
  await p1;
  await settle();
  const c1Settings = f.of(settingsRoute("/c1"))[0];
  assert.ok(c1Settings);

  const p2 = store.select("c2");
  f.last().respond(200, openBody({ cwd: "/c2" }));
  await p2;
  await settle();
  const c2Settings = f.of(settingsRoute("/c2"))[0];
  assert.ok(c2Settings);

  // c1's settings land after the screen moved on: they are dropped
  c1Settings.respond(200, settingsBody({ skills: ["/skills/one"] }));
  await settle();
  assert.equal((store.state.settings?.values.skills ?? []).includes("/skills/one"), false);
  // and c2's own answer is the one that lands
  c2Settings.respond(200, settingsBody({ skills: ["/skills/two"] }));
  await settle();
  assert.deepEqual(store.state.settings.values.skills, ["/skills/two"]);
  assert.equal(store.state.selectedId, "c2");
});

test("AC-005: a model answer for a conversation the screen left never lands on the next one", async () => {
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);

  const p1 = store.select("c1");
  f.last().respond(200, openBody({ cwd: "/c1" }));
  await p1;
  await settle();
  f.of(settingsRoute("/c1"))[0].respond(200, settingsBody());
  await settle();

  const model = store.setModel("anthropic/opus");
  const modelCall = f.calls[f.calls.length - 1];
  assert.equal(modelCall.path, "/api/conversations/c1/model");

  const p2 = store.select("c2");
  f.last().respond(200, openBody({ cwd: "/c2", model: "openai/gpt-5" }));
  await p2;
  await settle();
  const c2Settings = f.of(settingsRoute("/c2"))[0];
  if (c2Settings) c2Settings.respond(200, settingsBody());

  // the model answer arrives after the screen moved: it must not write c1's model onto c2
  modelCall.respond(200, { ok: true, model: "anthropic/opus" });
  await model;
  await settle();
  assert.equal(store.state.selectedId, "c2");
  assert.notEqual(store.state.open.model, "anthropic/opus");
  assert.equal(store.state.open.model, "openai/gpt-5");
});

test("AC-005: a failed conversation door writes its notice only while its own conversation is on screen", async () => {
  const attempts = [
    ["model", (store) => store.setModel("anthropic/opus")],
    ["effort", (store) => store.setEffort("high")],
    ["type", (store) => store.setType("idea")],
    ["stop", (store) => store.stop()],
    ["editQueue", (store) => store.editQueue("q1", "changed")],
    ["cancelQueue", (store) => store.cancelQueue("q1")],
    ["steerQueue", (store) => store.steerQueue("q1")],
  ];
  for (const [name, attempt] of attempts) {
    const f = fakeFetch();
    const s = fakeStreams();
    const store = new ChatStore(f.fetchFn, s.open);
    const p1 = store.select("c1");
    f.last().respond(200, openBody({ cwd: "/c1", model: "m/c1", streaming: true }));
    await p1;
    await settle();
    f.of(settingsRoute("/c1"))[0].respond(200, settingsBody());
    await settle();

    const pending = attempt(store);
    const call = f.calls[f.calls.length - 1];

    const p2 = store.select("c2");
    f.last().respond(200, openBody({ cwd: "/c2", model: "openai/gpt-5", streaming: true }));
    await p2;
    await settle();
    const c2Settings = f.of(settingsRoute("/c2"))[0];
    if (c2Settings) c2Settings.respond(200, settingsBody());

    // the failure arrives after the screen moved: it says nothing about the conversation now shown
    call.reject();
    await pending;
    await settle();
    assert.equal(store.state.open.notice, null, `${name}: no notice lands on the conversation the screen moved to`);
    assert.equal(store.state.open.model, "openai/gpt-5", `${name}: the next conversation keeps the engine's model`);
    assert.equal(store.state.open.streaming, true, `${name}: the next conversation keeps the engine's streaming state`);
  }

  // the guard drops only the write onto another conversation: the same conversation still shows the failure
  const f = fakeFetch();
  const s = fakeStreams();
  const store = new ChatStore(f.fetchFn, s.open);
  const p = store.select("c1");
  f.last().respond(200, openBody({ cwd: "/c1" }));
  await p;
  await settle();
  f.of(settingsRoute("/c1"))[0].respond(200, settingsBody());
  await settle();
  const pending = store.setModel("anthropic/opus");
  f.calls[f.calls.length - 1].reject();
  await pending;
  assert.equal(store.state.open.notice, WORDS.errors.unreachable);
});

/** the state settingsVals reads, built from the engine's own shape */
function settingsValsState(skills, webSearch, mcp, candidates) {
  return {
    values: { skills, webSearch, mcp },
    candidates,
    path: "/state/pipeline/conversation-settings.json",
    loading: false,
    busy: false,
    error: null,
  };
}

test("AC-001 / AC-002: the popover draws a row per candidate and both values, never merging them", () => {
  const state = {
    settings: settingsValsState([SKILL_A], true, false, [CANDIDATE_A, CANDIDATE_B]),
    open: { features: { webSearch: false, mcp: false, skills: [] } },
  };
  const view = settingsVals(state, { setSkill: () => {}, setFeature: () => {} });
  const context = { open: () => {}, percent: 6, tokens: 12000, contextWindow: 200000, cost: 0.12, quota: [] };
  const popover = render(h(ContextPopover, { m: { chat: { input: { context } }, chatSettings: view } }));
  assert.match(popover, /data-part="context-button"/);
  const html = render(h(ConversationSettings, { view }));
  assert.match(html, /data-part="context-settings"/);
  assert.match(html, /data-skill="\/skills\/alpha" data-on="on" data-effective="off"/);
  assert.match(html, /data-skill="\/c\/\.agents\/skills\/beta" data-on="off" data-effective="off"/);
  assert.match(html, /data-feature="webSearch" data-on="on" data-effective="off"/);
  assert.match(html, /\u4eca OFF \u00b7 \u6b21\u306e pi \u304b\u3089 ON/);
  assert.match(html, /\u5207\u308a\u66ff\u3048\u306f\u5168\u4f1a\u8a71\u306e\u6b21\u306e pi \u304b\u3089\u52b9\u304d\u307e\u3059/);
  assert.match(html, /data-toggle="\/skills\/alpha"/);
});
