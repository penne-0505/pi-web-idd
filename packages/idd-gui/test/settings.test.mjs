/**
 * The settings sheet's four wired sections and the three that say they cannot be handled yet. The tests drive
 * the same store the screen drives (`SettingsStore` with a fetch stand-in), build the view model the components
 * read, and render the components to static markup: a skill, a space or a storage row must be the engine's own
 * answer, the prototype's sample values and the rows with no door must not appear, and a save must carry only
 * the fields the person changed (AC-001 … AC-005).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fakeFetch, settle } from "./fake.mjs";
import { h, load, render } from "./helpers.mjs";

const { SettingsStore } = await load("./src/settings/store.ts");
const { settingsVals, spacePatch, spaceSaveTargetOf, editorPinnedTo, newSpaceInput, bytesLabel } = await load("./src/settings/viewmodel.ts");
const { DEFAULT_APPEARANCE, applyAppearance, arrowKeysAllowed, parseAppearance, readAppearance, saveAppearance } = await load("./src/settings/appearance.ts");
const { SettingsSkills } = await load("./src/components/settings/SettingsSkills.tsx");
const { SettingsSpaces } = await load("./src/components/settings/SettingsSpaces.tsx");
const { SettingsStorage } = await load("./src/components/settings/SettingsStorage.tsx");
const { SettingsAppearance } = await load("./src/components/settings/SettingsAppearance.tsx");
const { SettingsProviders } = await load("./src/components/settings/SettingsProviders.tsx");
const { SettingsLaneStages } = await load("./src/components/settings/SettingsLaneStages.tsx");
const { SettingsVoice } = await load("./src/components/settings/SettingsVoice.tsx");
const { SettingsHeader } = await load("./src/components/settings/SettingsHeader.tsx");

const PATH_A = "/home/penne/.agents/skills/engine-a";
const PATH_B = "/w/chat/.agents/skills/engine-b";

const candidate = (over = {}) => ({ path: PATH_A, name: "engine-a", description: "engine が返した説明", origin: "user", enabled: false, ...over });

const conversationBody = ({ settings = {}, candidates = [candidate()], running, path = "/state/pipeline/conversation-settings.json" } = {}) => ({
  ok: true,
  settings: { skills: [], webSearch: true, webSearchTools: ["web_search"], mcp: false, ...settings },
  candidates,
  path,
  ...(running ? { running } : {}),
});

const space = (over = {}) => ({ id: "p1", memory: "none", references: [], instruction: "", ...over });

const storageBody = (over = {}) => ({
  ok: true,
  measuredAt: "2026-10-18T03:00:00Z",
  cleanup: false,
  minFreeGb: 10,
  archive: { dir: "/mnt/ct1/archive", visible: true },
  filesystems: [
    { mount: "/", freeBytes: 20 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, belowThreshold: false, label: "state" },
    { mount: "/mnt/ct1", freeBytes: 5 * 1024 ** 3, totalBytes: 200 * 1024 ** 3, belowThreshold: true },
  ],
  places: [
    { place: "cron_runs", label: "cron の記録", bytes: 2 * 1024 ** 3, count: 9372, cleanup: true },
    { place: "run_records", label: "run の記録", bytes: 1024 ** 2, count: 2511, cleanup: false },
  ],
  candidates: [
    { place: "cron_runs", path: "/tmp/a", bytes: 1024, usedUpAt: "", dueAt: "", removal: "file", evidence: { kind: "none" } },
    { place: "cron_runs", path: "/tmp/b", bytes: 2048, usedUpAt: "", dueAt: "", removal: "file", evidence: { kind: "none" } },
    { place: "run_records", path: "/tmp/c", bytes: 1024, usedUpAt: "", dueAt: "", removal: "file", evidence: { kind: "none" } },
  ],
  kept: Array.from({ length: 10 }, (_, i) => ({ place: "cron_runs", path: `/tmp/keep-${i}`, reason: "lane が動いている", lane: "IDD-1" })),
  lastSweep: { at: "2026-10-17T00:00:00Z", lowSpace: false, removed: [{ place: "cron_runs", path: "/tmp/x", bytes: 10 }], failed: [] },
  heldLanes: ["IDD-9"],
  ...over,
});

const EMPTY_DRAFT = { id: "", name: "", memory: "none", references: "", instruction: "" };
const UI = { spaceOpen: null, spaceDraft: null, spaceTouched: [], spaceMode: null, newOpen: false, newDraft: { ...EMPTY_DRAFT }, newTouched: [] };
const EMPTY_STATE = {
  conversation: null,
  running: [],
  refusal: null,
  loading: false,
  connection: "ok",
  workspaces: [],
  mode: null,
  spaces: [],
  spacesFor: null,
  spaceRefusal: null,
  spaceLoading: false,
  storage: null,
  storageMeasuring: false,
  storageError: null,
};
const HANDLERS = {
  toggleSkill() {},
  setWebSearch() {},
  setMcp() {},
  chooseMode() {},
  openSpace() {},
  openNewSpace() {},
  closeSpace() {},
  setSpaceField() {},
  saveSpace() {},
  readStorage() {},
};

const flush = async () => {
  await settle();
  await settle();
  await settle();
};

/** the model the ported components read: the settings view model, plus the section's own flag */
const modelOf = (state = EMPTY_STATE, extra = {}) => ({ set: settingsVals(state, UI, HANDLERS), ap: { fontPx: 13, setFont() {}, reduceMotion: false, toggleMotion() {}, arrowKeys: true, toggleArrowKeys() {} }, ...extra });

async function readSettingsStore(body = conversationBody()) {
  const f = fakeFetch();
  const store = new SettingsStore(f.fetchFn);
  const read = store.readSettings();
  f.of("/api/conversation-settings").at(-1).respond(200, body);
  await read;
  return { f, store };
}

async function spacesStore() {
  const f = fakeFetch();
  const store = new SettingsStore(f.fetchFn);
  const read = store.readWorkspaces();
  f.of("/api/conversations/workspaces").at(-1).respond(200, { workspaces: [{ mode: "chat", label: "Chat", workspace: "/w/chat" }] });
  await flush();
  f.of("/api/conversations/workspaces/chat/spaces").at(-1).respond(200, { ok: true, spaces: [space({ name: "Engine Space", instruction: "engine の指示" })] });
  await flush();
  void read;
  return { f, store };
}

/** two workspaces with a space of the same id each, so a save's answer can be told apart by its name */
async function twoWorkspaceStore() {
  const f = fakeFetch();
  const store = new SettingsStore(f.fetchFn);
  const read = store.readWorkspaces();
  f.of("/api/conversations/workspaces").at(-1).respond(200, { workspaces: [{ mode: "chat", label: "Chat", workspace: "/w/chat" }, { mode: "work", label: "Work", workspace: "/w/work" }] });
  await flush();
  f.of("/api/conversations/workspaces/chat/spaces").at(-1).respond(200, { ok: true, spaces: [space({ id: "p1", name: "Chat の p1" })] });
  await flush();
  void read;
  return { f, store };
}

/** leave the chat list for work's while a chat save is still in flight */
async function switchToWork(f, store) {
  const read = store.selectMode("work");
  f.of("/api/conversations/workspaces/work/spaces").at(-1).respond(200, { ok: true, spaces: [space({ id: "p1", name: "Work の p1" })] });
  await flush();
  void read;
}

// ---------------------------------------------------------------- AC-001: skills · web search · MCP

test("AC-001: the section reads the engine's switches and a press sends the skill list", async () => {
  const { f, store } = await readSettingsStore();
  assert.equal(store.state.conversation.settings.webSearch, true);
  assert.equal(store.state.conversation.settings.mcp, false);
  assert.deepEqual(store.state.conversation.candidates.map((c) => c.name), ["engine-a"]);

  store.toggleSkill(PATH_A);
  await flush();
  const patch = f.calls.filter((call) => call.init?.method === "PATCH").at(-1);
  assert.equal(patch.path, "/api/conversation-settings");
  assert.deepEqual(patch.body, { skills: [PATH_A] });
  patch.respond(200, conversationBody({ settings: { skills: [PATH_A] } }));
  await flush();
  assert.deepEqual(store.state.conversation.settings.skills, [PATH_A]);
  assert.equal(store.state.refusal, null);
});

test("AC-001: two presses in a row keep the first switch", async () => {
  const candidates = [candidate(), candidate({ path: PATH_B, name: "engine-b", origin: "workspace" })];
  const { f, store } = await readSettingsStore(conversationBody({ candidates }));

  store.toggleSkill(PATH_A);
  store.toggleSkill(PATH_B);
  await flush();
  const patches = () => f.calls.filter((call) => call.init?.method === "PATCH");
  assert.equal(patches().length, 1, "the second press waits for the first answer");
  assert.deepEqual(patches()[0].body, { skills: [PATH_A] });

  patches()[0].respond(200, conversationBody({ settings: { skills: [PATH_A] }, candidates }));
  await flush();
  assert.equal(patches().length, 2);
  assert.deepEqual(patches()[1].body, { skills: [PATH_A, PATH_B] });

  patches()[1].respond(200, conversationBody({ settings: { skills: [PATH_A, PATH_B] }, candidates }));
  await flush();
  assert.deepEqual(store.state.conversation.settings.skills, [PATH_A, PATH_B]);
});

test("AC-001: a refused press keeps the engine's value and shows the refusal", async () => {
  const { f, store } = await readSettingsStore();
  store.toggleSkill(PATH_A);
  await flush();
  f.calls.filter((call) => call.init?.method === "PATCH").at(-1).respond(400, { ok: false, error: "候補に無い skill は ON にできません" });
  await flush();
  assert.deepEqual(store.state.conversation.settings.skills, [], "the row goes back to the engine's value");
  assert.match(store.state.refusal, /候補に無い skill/);
  const html = render(h(SettingsSkills, { m: modelOf(store.state, { secSkills: true }) }));
  assert.match(html, /候補に無い skill/);
});

test("AC-001: the running conversations the write names are shown", async () => {
  const { f, store } = await readSettingsStore();
  store.setMcp(true);
  await flush();
  f.calls.filter((call) => call.init?.method === "PATCH").at(-1).respond(200, conversationBody({ settings: { mcp: true }, running: ["s1", "s2"] }));
  await flush();
  assert.deepEqual(store.state.running, ["s1", "s2"]);
  const html = render(h(SettingsSkills, { m: modelOf(store.state, { secSkills: true }) }));
  assert.match(html, /動いている会話 2 件/);
});

test("AC-001 / AC-005: the section draws the engine's skills and no prototype sample", async () => {
  const { store } = await readSettingsStore(conversationBody({ settings: { skills: [PATH_A] } }));
  const html = render(h(SettingsSkills, { m: modelOf(store.state, { secSkills: true }) }));
  assert.match(html, /engine-a/);
  assert.match(html, /engine が返した説明/);
  assert.match(html, /あなたの skills/);
  assert.match(html, /Web search/);
  assert.match(html, /MCP/);
  for (const sample of ["ja-style", "diagram", "idd-review", "release", "File access scope", "12 個の道具", "~/.propter/skills"]) {
    assert.equal(html.includes(sample), false, `${sample} must not be drawn`);
  }
});

// ---------------------------------------------------------------- AC-002: spaces

test("AC-002: a workspace's spaces are listed and a new one is made with the fields filled", async () => {
  const { f, store } = await spacesStore();
  assert.equal(store.state.mode, "chat");
  assert.deepEqual(store.state.spaces.map((p) => p.id), ["p1"]);

  const created = store.createSpace("chat", newSpaceInput({ id: "p2", name: "Second", memory: "space", references: "/a\n/b\n", instruction: "x" }));
  const call = f.of("/api/conversations/workspaces/chat/spaces").filter((entry) => entry.init?.method === "POST").at(-1);
  assert.deepEqual(call.body, { id: "p2", name: "Second", memory: "space", references: ["/a", "/b"], instruction: "x" });
  call.respond(200, { ok: true, space: space({ id: "p2", name: "Second", memory: "space", references: ["/a", "/b"], instruction: "x" }) });
  assert.equal(await created, true);
});

test("AC-002: an edit sends only the fields the person changed", async () => {
  const { f, store } = await spacesStore();
  const draft = { id: "p1", name: "Renamed", memory: "none", references: "/a", instruction: "engine の指示" };
  assert.deepEqual(spacePatch(draft, ["name"]), { name: "Renamed" });
  assert.equal(spacePatch(draft, []), null, "nothing touched means no request");
  // the fields the sheet read but the person did not change are not sent
  const patch = spacePatch(draft, ["name", "memory"]);
  assert.deepEqual(Object.keys(patch).sort(), ["memory", "name"]);
  assert.equal("instruction" in patch, false);
  assert.equal("references" in patch, false);

  void store.updateSpace("chat", "p1", patch);
  const call = f.of("/api/conversations/workspaces/chat/spaces/p1").filter((entry) => entry.init?.method === "PATCH").at(-1);
  assert.deepEqual(call.body, { name: "Renamed", memory: "none" });
});

test("AC-002: a refused space shows the engine's own line", async () => {
  const { f, store } = await spacesStore();
  const done = store.createSpace("chat", { id: "bad id" });
  f.of("/api/conversations/workspaces/chat/spaces").filter((entry) => entry.init?.method === "POST").at(-1).respond(400, { ok: false, error: "スペースの id の形が不正です" });
  assert.equal(await done, false);
  assert.match(store.state.spaceRefusal, /id の形/);
  const html = render(h(SettingsSpaces, { m: modelOf(store.state, { secSpaces: true }) }));
  assert.match(html, /id の形/);
});

test("AC-002 / AC-005: the section draws the conversation's spaces and no repo row", async () => {
  const { store } = await spacesStore();
  const html = render(h(SettingsSpaces, { m: modelOf(store.state, { secSpaces: true }) }));
  assert.match(html, /Engine Space/);
  assert.match(html, /Chat/);
  assert.match(html, /＋ スペースを作る/);
  for (const sample of ["Worktree path", "Base branch", "Merge strategy", "Max concurrent lanes", "penne-0505/propter", "＋ Add folder"]) {
    assert.equal(html.includes(sample), false, `${sample} must not be drawn`);
  }
});

test("AC-002 / F-171-1: an editor opened in one workspace is not drawn or saved for another", () => {
  const chat = {
    ...EMPTY_STATE,
    mode: "chat",
    spacesFor: "chat",
    spaces: [space({ name: "Engine Space", instruction: "engine の指示" })],
    workspaces: [
      { mode: "chat", label: "Chat", workspace: "/w/chat" },
      { mode: "work", label: "Work", workspace: "/w/work" },
    ],
  };
  const ui = {
    ...UI,
    spaceMode: "chat",
    spaceOpen: "p1",
    spaceDraft: { id: "p1", name: "Renamed", memory: "none", references: "", instruction: "engine の指示" },
    spaceTouched: ["name"],
  };
  // the workspace it was opened in: the editor is drawn and the changed field is saved there
  assert.equal(settingsVals(chat, ui, HANDLERS).spaces.editor.name, "Renamed");
  assert.equal(settingsVals(chat, ui, HANDLERS).spaces.rows[0].open, true);
  assert.deepEqual(spaceSaveTargetOf(ui, chat), { mode: "chat", id: "p1", input: { name: "Renamed" } });

  // leaving the workspace leaves the editor out of the sheet: the same id in the other workspace is untouched
  const work = { ...chat, mode: "work", spacesFor: "work", spaces: [space({ name: "Work の p1" })] };
  assert.equal(settingsVals(work, ui, HANDLERS).spaces.editor, null);
  assert.equal(settingsVals(work, ui, HANDLERS).spaces.rows[0].open, false);
  assert.equal(spaceSaveTargetOf(ui, work), null, "no draft lands on the other workspace's p1");

  // a new space is pinned the same way
  const fresh = { ...UI, spaceMode: "chat", newOpen: true, newDraft: { ...EMPTY_DRAFT, id: "p2" }, newTouched: ["id"] };
  assert.deepEqual(spaceSaveTargetOf(fresh, chat), { mode: "chat", id: null, input: { id: "p2" } });
  assert.equal(spaceSaveTargetOf(fresh, work), null);
  assert.equal(spaceSaveTargetOf({ ...fresh, spaceMode: null }, chat), null, "an editor with no workspace saves nowhere");

  // a save's answer closes the editor it was sent from; an answer pinned to another workspace closes nothing
  assert.equal(editorPinnedTo(ui, "chat"), true);
  assert.equal(editorPinnedTo(ui, "work"), false);
  assert.equal(editorPinnedTo({ ...fresh, spaceMode: "work" }, "work"), true);
});

test("AC-002 / F-1: a save answered after a workspace switch does not join the shown list", async () => {
  const { f, store } = await twoWorkspaceStore();
  assert.equal(store.state.mode, "chat");

  // press save in chat, then leave for work before the answer comes
  const saving = store.updateSpace("chat", "p1", { name: "Renamed" });
  const saveCall = f.of("/api/conversations/workspaces/chat/spaces/p1").at(-1);
  await switchToWork(f, store);
  assert.deepEqual(store.state.spaces.map((p) => p.name), ["Work の p1"]);

  // chat's answer arrives now: it belongs to the workspace the sheet left
  saveCall.respond(200, { ok: true, space: space({ id: "p1", name: "Renamed" }) });
  assert.equal(await saving, true);
  await flush();
  assert.equal(store.state.mode, "work");
  assert.deepEqual(store.state.spaces.map((p) => p.name), ["Work の p1"], "chat's answer never joins work's list");
  assert.equal(store.state.spacesFor, "work");
  assert.equal(store.state.spaceRefusal, null);
  assert.equal(store.state.spaceLoading, false, "work is not left looking busy");
  assert.equal(f.of("/api/conversations/workspaces/chat/spaces").length, 1, "the workspace left is not read again");
});

test("AC-002 / F-1: a refusal answered after a switch stays out of the other workspace", async () => {
  const { f, store } = await twoWorkspaceStore();
  const saving = store.createSpace("chat", { id: "p2" });
  const saveCall = f.of("/api/conversations/workspaces/chat/spaces").filter((entry) => entry.init?.method === "POST").at(-1);
  await switchToWork(f, store);
  saveCall.respond(400, { ok: false, error: "スペースの id の形が不正です" });
  assert.equal(await saving, false);
  await flush();
  assert.equal(store.state.spaceRefusal, null, "chat's refusal is not drawn over work");
  assert.deepEqual(store.state.spaces.map((p) => p.name), ["Work の p1"]);
  assert.equal(store.state.spaceLoading, false);
});

// ---------------------------------------------------------------- AC-003: storage

test("AC-003: storage shows that it is measuring, then the engine's own numbers", async () => {
  const f = fakeFetch();
  const store = new SettingsStore(f.fetchFn);
  const read = store.readStorage();
  assert.equal(store.state.storageMeasuring, true, "no number is made up while the door is measuring");
  const htmlWhileMeasuring = render(h(SettingsStorage, { m: modelOf(store.state, { secConv: true }) }));
  assert.match(htmlWhileMeasuring, /測っています/);
  assert.equal(htmlWhileMeasuring.includes("20.0 GB"), false);

  f.of("/api/idd/storage").at(-1).respond(200, storageBody());
  await read;
  assert.equal(store.state.storageMeasuring, false);
  const view = settingsVals(store.state, UI, HANDLERS).storage;
  assert.equal(view.filesystems[0].free, "20.0 GB");
  assert.equal(view.filesystems[1].below, true);
  assert.deepEqual(view.candidates.map((c) => c.count), [2, 1]);
  assert.match(view.candidatesTotal, /3 件/);
  assert.equal(view.kept.length, 8, "the kept list is capped");
  assert.equal(view.keptMore, 2);
  assert.match(view.cleanup, /片づけは OFF/);
  assert.match(view.lastSweep, /1 件を消した/);
  assert.match(view.held, /1 本/);

  const html = render(h(SettingsStorage, { m: modelOf(store.state, { secConv: true }) }));
  assert.match(html, /20.0 GB/);
  assert.match(html, /cron の記録/);
  assert.match(html, /残したもの/);
  assert.match(html, /片づけは OFF/);
  assert.match(html, /測り直す/);
  for (const sample of ["Location", "FTS index", "Retention", "BTW after sending a card", "Export as Markdown", "Delete all conversations", "Rebuild"]) {
    assert.equal(html.includes(sample), false, `${sample} must not be drawn`);
  }
});

test("AC-003: the storage section carries no operation that removes or sweeps", () => {
  const names = Object.getOwnPropertyNames(SettingsStore.prototype);
  assert.deepEqual(names.filter((name) => /remove|delete|sweep|clean|purge|clear/i.test(name)), []);
  assert.ok(names.includes("readStorage"));
});

test("bytesLabel reads a byte count in the sheet's own words", () => {
  assert.equal(bytesLabel(0), "0 B");
  assert.equal(bytesLabel(1024 ** 2), "1.0 MB");
  assert.equal(bytesLabel(3 * 1024 ** 3), "3.0 GB");
  assert.equal(bytesLabel(Number.NaN), "—");
});

// ---------------------------------------------------------------- AC-004: appearance

test("AC-004: the appearance value is read back and written to the frame", () => {
  assert.deepEqual(parseAppearance(null), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance('{"fontPx":15,"reduceMotion":true,"arrowKeys":false}'), { fontPx: 15, reduceMotion: true, arrowKeys: false });
  assert.deepEqual(parseAppearance("not json"), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance('{"fontPx":99}'), { fontPx: 16, reduceMotion: false, arrowKeys: true }, "a size outside the steps is clamped");

  const kept = new Map();
  const storage = { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value) };
  saveAppearance(storage, { fontPx: 15, reduceMotion: true, arrowKeys: false });
  assert.deepEqual(readAppearance(storage), { fontPx: 15, reduceMotion: true, arrowKeys: false }, "the same browser keeps the three rows");

  const props = {};
  const target = { style: { setProperty: (name, value) => { props[name] = value; } }, dataset: {} };
  applyAppearance(target, { fontPx: 16, reduceMotion: true, arrowKeys: true });
  assert.equal(props.zoom, String(16 / 13));
  assert.equal(props.width, `calc(100% / ${16 / 13})`);
  assert.equal(target.dataset.reduceMotion, "1");
  applyAppearance(target, { fontPx: 13, reduceMotion: false, arrowKeys: true });
  assert.equal(props.zoom, "1");
  assert.equal(target.dataset.reduceMotion, undefined, "a row that is turned off leaves nothing behind");
});

test("AC-004: with Arrow keys off the arrow presses send no card's judgement", () => {
  const off = { ...DEFAULT_APPEARANCE, arrowKeys: false };
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"]) assert.equal(arrowKeysAllowed(off, key), false, key);
  for (const key of ["Enter", "1", "Escape", "a"]) assert.equal(arrowKeysAllowed(off, key), true, key);
  assert.equal(arrowKeysAllowed(DEFAULT_APPEARANCE, "ArrowRight"), true);
});

test("AC-004: the section wires three rows and marks the rest as not handled", () => {
  const html = render(h(SettingsAppearance, { m: modelOf(EMPTY_STATE, { secView: true }) }));
  assert.match(html, /Reduce motion/);
  assert.match(html, /Arrow keys send cards/);
  assert.match(html, /13px/);
  assert.match(html, /Font size/);
  assert.equal((html.match(/data-appearance-toggle/g) ?? []).length, 2);
  assert.equal((html.match(/data-appearance-not-yet/g) ?? []).length, 3, "Theme の Dark・System、Density、Sidebar sort");
});

// ---------------------------------------------------------------- AC-005: the sections with no door

test("AC-005: providers, lane stages and voice say they cannot be handled, with no sample value", () => {
  const providers = render(h(SettingsProviders, { m: modelOf(EMPTY_STATE, { secProv: true }) }));
  assert.match(providers, /まだ扱えない/);
  for (const sample of ["Anthropic", "Opus 4.5", "GPT-5", "Add provider", "$40"]) assert.equal(providers.includes(sample), false, sample);

  const lanes = render(h(SettingsLaneStages, { m: modelOf(EMPTY_STATE, { secLanes: true }) }));
  assert.match(lanes, /まだ扱えない/);
  assert.equal(lanes.includes("lanes.toml"), false, "the button that opened lanes.toml is gone");

  const voice = render(h(SettingsVoice, { m: modelOf(EMPTY_STATE, { secVoice: true }) }));
  assert.match(voice, /まだ扱えない/);
  for (const sample of ["Push-to-talk", "Microphone", "Japanese"]) assert.equal(voice.includes(sample), false, sample);
});

test("AC-005: the header no longer offers to open lanes.toml", () => {
  const html = render(h(SettingsHeader, { m: { closeSettings() {}, secTitle: "Lane stages & roles", secLanes: true } }));
  assert.match(html, /Lane stages/);
  assert.equal(html.includes("lanes.toml"), false);
});
