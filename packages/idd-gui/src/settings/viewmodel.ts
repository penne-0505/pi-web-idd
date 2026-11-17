/**
 * The settings sheet's view model. Every value here is read from one engine answer (DEC-103-1): a skill row is
 * the candidate the engine listed, a space row is the definition the engine returned, a storage row is what
 * the storage door measured. The sheet invents no row for a door it does not have (C-171-2), and the storage
 * section carries no press that removes anything (C-171-3).
 */
import type { Candidate, Kept, MemoryHandling, PlaceUsage, Space, SkillCandidate, StorageView } from "../engine/contract";
import { WORDS } from "../strings";
import { passkeysVals, type PasskeysView } from "./passkeys";
import type { SettingsStoreState, SpaceInput } from "./store";

export interface SkillRow {
  key: string;
  name: string;
  description: string;
  on: boolean;
  press: () => void;
}

export interface SkillGroup {
  key: string;
  title: string;
  rows: SkillRow[];
}

export interface SpaceRow {
  id: string;
  title: string;
  subtitle: string;
  open: boolean;
  press: () => void;
}

export interface MemoryOption {
  value: MemoryHandling;
  label: string;
  active: boolean;
  press: () => void;
}

export interface EditorView {
  /** the id being edited; an empty string means a new space */
  editing: string;
  title: string;
  idValue: string;
  idEditable: boolean;
  name: string;
  references: string;
  instruction: string;
  memory: MemoryHandling;
  memoryOptions: MemoryOption[];
  dirty: boolean;
  save: () => void;
  close: () => void;
}

export interface FsRow {
  key: string;
  label: string;
  free: string;
  total: string;
  below: boolean;
  threshold: string;
}

export interface PlaceRow {
  key: string;
  label: string;
  bytes: string;
  count: number;
  cleanup: string | null;
  note: string | null;
}

export interface CandidateRow {
  key: string;
  label: string;
  count: number;
  bytes: string;
}

export interface KeptRow {
  key: string;
  label: string;
  path: string;
  reason: string;
  lane: string | null;
}

/** what the Spaces section's own inputs hold while they are open */
export interface SpaceDraft {
  id: string;
  name: string;
  memory: MemoryHandling;
  references: string;
  instruction: string;
}

export type SpaceField = "id" | "name" | "memory" | "references" | "instruction";

export interface SettingsUi {
  /** the id whose editor is open, or null */
  spaceOpen: string | null;
  spaceDraft: SpaceDraft | null;
  /** the fields the person actually changed, so a save sends no field they did not touch (C-171-4) */
  spaceTouched: SpaceField[];
  /** the workspace the open editor was seeded from: it is drawn and saved for this mode alone (F-171-1) */
  spaceMode: string | null;
  newOpen: boolean;
  newDraft: SpaceDraft;
  newTouched: SpaceField[];
}

export interface SettingsHandlers {
  toggleSkill(path: string): void;
  setWebSearch(value: boolean): void;
  setMcp(value: boolean): void;
  chooseMode(mode: string): void;
  openSpace(id: string): void;
  openNewSpace(): void;
  closeSpace(): void;
  setSpaceField(field: SpaceField, value: string): void;
  saveSpace(): void;
  readStorage(): void;
  registerPasskey(): void;
  approvePending(id: string): void;
  /** set or change the PIN on a registered key's signature (C-182-1) */
  setPin(pin: string): void;
  /** turn the PIN off on a registered key's signature */
  disablePin(): void;
}

export interface SkillsView {
  loaded: boolean;
  error: string | null;
  groups: SkillGroup[];
  empty: boolean;
  webSearch: boolean;
  mcp: boolean;
  pressWebSearch: () => void;
  pressMcp: () => void;
  runningNote: string | null;
}

export interface SpacesView {
  loaded: boolean;
  error: string | null;
  modes: Array<{ mode: string; label: string; active: boolean; press: () => void }>;
  rows: SpaceRow[];
  empty: boolean;
  editor: EditorView | null;
  addLabel: string;
  workspace: string;
  openNew: () => void;
  busy: boolean;
  setField: (field: SpaceField, value: string) => void;
}

export interface StorageView2 {
  measuring: boolean;
  error: string | null;
  loaded: boolean;
  filesystems: FsRow[];
  places: PlaceRow[];
  candidates: CandidateRow[];
  candidatesTotal: string;
  kept: KeptRow[];
  keptMore: number;
  keptTotal: number;
  lastSweep: string;
  cleanup: string;
  held: string | null;
  archive: string | null;
  measuredAt: string;
  read: () => void;
  readLabel: string;
}

export interface SettingsView {
  skills: SkillsView;
  spaces: SpacesView;
  storage: StorageView2;
  passkeys: PasskeysView;
}

/** one path a line, so a reference list is read and written the way the engine's frontmatter holds it */
export function referenceLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The fields a save sends for a space that already exists: only the ones the person changed. A field the
 * sheet did not touch is left out, so the engine's own value (the instruction, the references) is never
 * overwritten by a page that never read or changed it (C-171-4). No touched field means no request.
 */
export function spacePatch(draft: SpaceDraft, touched: SpaceField[]): SpaceInput | null {
  const patch: SpaceInput = {};
  for (const field of touched) {
    if (field === "name") patch.name = draft.name;
    else if (field === "memory") patch.memory = draft.memory;
    else if (field === "references") patch.references = referenceLines(draft.references);
    else if (field === "instruction") patch.instruction = draft.instruction;
  }
  return Object.keys(patch).length ? patch : null;
}

/** a new space's input: the id always, and every field the person filled */
export function newSpaceInput(draft: SpaceDraft): SpaceInput {
  const input: SpaceInput = { id: draft.id.trim() };
  if (draft.name.trim()) input.name = draft.name;
  if (draft.memory !== "none") input.memory = draft.memory;
  const references = referenceLines(draft.references);
  if (references.length) input.references = references;
  if (draft.instruction.trim()) input.instruction = draft.instruction;
  return input;
}

/**
 * Whether the open editor belongs to the workspace the sheet is showing. An editor is seeded from one
 * workspace's list, so it is drawn and saved for that mode alone: while another workspace is shown it is not
 * the editor of any row there (F-171-1).
 */
export function editorBelongsToMode(ui: SettingsUi, state: SettingsStoreState): boolean {
  return state.mode !== null && ui.spaceMode === state.mode;
}

/**
 * Whether the editor now open is the one a save was sent from. The editor is pinned to the mode it was opened
 * in, so an answer that lands after a workspace switch closes that editor and never the one the sheet has since
 * opened for another workspace (F-1).
 */
export function editorPinnedTo(ui: SettingsUi, mode: string): boolean {
  return ui.spaceMode === mode;
}

/** where one space save must go: the mode it is pinned to, and the id and input it carries */
export interface SpaceSaveTarget {
  mode: string;
  /** the id being edited, or null when the editor makes a new one */
  id: string | null;
  input: SpaceInput;
}

/**
 * Where a space save must go. The editor belongs to the workspace whose list it was seeded from, so a save is
 * sent to that mode alone: switching workspaces mid-edit never carries one workspace's draft onto another
 * workspace's space of the same id (F-171-1). Nothing to send means no request.
 */
export function spaceSaveTargetOf(ui: SettingsUi, state: SettingsStoreState): SpaceSaveTarget | null {
  if (!editorBelongsToMode(ui, state)) return null;
  const mode = state.mode as string;
  if (ui.newOpen) return { mode, id: null, input: newSpaceInput(ui.newDraft) };
  if (!ui.spaceOpen || !ui.spaceDraft) return null;
  const patch = spacePatch(ui.spaceDraft, ui.spaceTouched);
  return patch ? { mode, id: ui.spaceOpen, input: patch } : null;
}

/** a size in the sheet's own words; a byte count the engine did not return stays empty (DEC-103-2) */
export function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** the origin groups in the order the engine lists them, so the sheet draws the engine's own places */
const ORIGINS: Array<{ key: SkillCandidate["origin"]; title: string }> = [
  { key: "user", title: WORDS.settings.skills.origin.user },
  { key: "workspace", title: WORDS.settings.skills.origin.workspace },
  { key: "repo", title: WORDS.settings.skills.origin.repo },
];

export function skillGroups(candidates: SkillCandidate[], enabled: string[], handlers: SettingsHandlers): SkillGroup[] {
  const groups: SkillGroup[] = [];
  for (const origin of ORIGINS) {
    const rows = candidates
      .filter((candidate) => candidate.origin === origin.key)
      .map((candidate) => ({
        key: candidate.path,
        name: candidate.name,
        description: candidate.description,
        on: enabled.includes(candidate.path),
        press: () => handlers.toggleSkill(candidate.path),
      }));
    if (rows.length) groups.push({ key: origin.key, title: origin.title, rows });
  }
  return groups;
}

function memoryLabel(memory: MemoryHandling): string {
  if (memory === "space") return WORDS.settings.spaces.memorySpace;
  if (memory === "shared") return WORDS.settings.spaces.memoryShared;
  return WORDS.settings.spaces.memoryNone;
}

function spaceSubtitle(space: Space): string {
  const parts = [memoryLabel(space.memory)];
  if (space.references.length) parts.push(WORDS.settings.spaces.referenceCount(space.references.length));
  if (!space.instruction.trim()) parts.push(WORDS.settings.spaces.noInstruction);
  return parts.join(" · ");
}

function memoryOptions(value: MemoryHandling, handlers: SettingsHandlers): MemoryOption[] {
  const values: MemoryHandling[] = ["none", "space", "shared"];
  return values.map((entry) => ({
    value: entry,
    label: memoryLabel(entry),
    active: entry === value,
    press: () => handlers.setSpaceField("memory", entry),
  }));
}

const MEMORY_VALUES: MemoryHandling[] = ["none", "space", "shared"];

/** the editor for one space: a new one carries every field, an edit only the ones the person changed */
export function editorView(state: SettingsStoreState, ui: SettingsUi, handlers: SettingsHandlers): EditorView | null {
  // an editor belongs to the workspace it was opened in: under another workspace it is not drawn, so its draft
  // is never read as that workspace's space (F-171-1)
  if (!editorBelongsToMode(ui, state)) return null;
  const editing = ui.spaceOpen;
  const draft = editing === null ? (ui.newOpen ? ui.newDraft : null) : ui.spaceDraft;
  if (!draft) return null;
  const dirty = editing === null ? true : ui.spaceTouched.length > 0;
  return {
    editing: editing ?? "",
    title: editing === null ? WORDS.settings.spaces.add : editing,
    idValue: draft.id,
    idEditable: editing === null,
    name: draft.name,
    references: draft.references,
    instruction: draft.instruction,
    memory: draft.memory,
    memoryOptions: memoryOptions(draft.memory, handlers),
    dirty,
    save: () => handlers.saveSpace(),
    close: () => handlers.closeSpace(),
  };
}

export function settingsVals(state: SettingsStoreState, ui: SettingsUi, handlers: SettingsHandlers): SettingsView {
  const settings = state.conversation?.settings ?? null;
  const candidates = state.conversation?.candidates ?? [];
  const groups = settings ? skillGroups(candidates, settings.skills, handlers) : [];

  const skills: SkillsView = {
    loaded: state.conversation !== null,
    error: state.refusal ?? (state.connection === "down" ? WORDS.errors.unreachable : null),
    groups,
    empty: state.conversation !== null && groups.length === 0,
    webSearch: settings?.webSearch ?? false,
    mcp: settings?.mcp ?? false,
    pressWebSearch: () => handlers.setWebSearch(!(settings?.webSearch ?? false)),
    pressMcp: () => handlers.setMcp(!(settings?.mcp ?? false)),
    runningNote: state.running.length ? WORDS.settings.skills.running(state.running.length) : null,
  };

  const spaces: SpacesView = {
    loaded: state.spacesFor === state.mode,
    error: state.spaceRefusal,
    modes: state.workspaces.map((workspace) => ({
      mode: workspace.mode,
      label: workspace.label,
      active: workspace.mode === state.mode,
      press: () => handlers.chooseMode(workspace.mode),
    })),
    rows: state.spaces.map((space) => ({
      id: space.id,
      title: space.name ?? space.id,
      subtitle: spaceSubtitle(space),
      open: editorBelongsToMode(ui, state) && ui.spaceOpen === space.id,
      press: () => handlers.openSpace(space.id),
    })),
    empty: state.spacesFor === state.mode && state.spaces.length === 0,
    editor: editorView(state, ui, handlers),
    addLabel: WORDS.settings.spaces.add,
    workspace: state.workspaces.find((workspace) => workspace.mode === state.mode)?.workspace ?? "",
    openNew: () => handlers.openNewSpace(),
    busy: state.spaceLoading,
    setField: (field, value) => handlers.setSpaceField(field, value),
  };

  const storage: StorageView2 = storageView(state, handlers);

  // the keys and the pending approvals are the engine's lists, read again after every press (C-172-1, C-172-2)
  const passkeys: PasskeysView = passkeysVals(state.passkeys, handlers);

  return { skills, spaces, storage, passkeys };
}

function placeLabels(view: StorageView): Map<string, string> {
  const labels = new Map<string, string>();
  for (const place of view.places) labels.set(place.place, place.label);
  return labels;
}

function candidateAggregate(candidates: Candidate[], labels: Map<string, string>): CandidateRow[] {
  const byPlace = new Map<string, { count: number; bytes: number }>();
  for (const candidate of candidates) {
    const entry = byPlace.get(candidate.place) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += candidate.bytes;
    byPlace.set(candidate.place, entry);
  }
  const rows: CandidateRow[] = [];
  for (const [place, entry] of byPlace) {
    rows.push({ key: place, label: labels.get(place) ?? place, count: entry.count, bytes: bytesLabel(entry.bytes) });
  }
  return rows.sort((a, b) => b.count - a.count);
}

/** the kept list is capped: a section that drew 231 rows would hide the storage it measured */
const KEPT_ROWS = 8;

function keptRows(kept: Kept[], labels: Map<string, string>): KeptRow[] {
  return kept.slice(0, KEPT_ROWS).map((entry, index) => ({
    key: `${entry.place}:${entry.path}:${index}`,
    label: labels.get(entry.place) ?? entry.place,
    path: entry.path,
    reason: entry.reason,
    lane: entry.lane ?? null,
  }));
}

function sweepLine(view: StorageView): string {
  if (!view.lastSweep) return WORDS.settings.storage.none;
  const parts = [view.lastSweep.at, WORDS.settings.storage.removed(view.lastSweep.removed.length)];
  if (view.lastSweep.failed.length) parts.push(WORDS.settings.storage.failed(view.lastSweep.failed.length));
  return parts.filter(Boolean).join(" · ");
}

function storageView(state: SettingsStoreState, handlers: SettingsHandlers): StorageView2 {
  const view = state.storage;
  if (!view) {
    return {
      measuring: state.storageMeasuring,
      error: state.storageError,
      loaded: false,
      filesystems: [],
      places: [],
      candidates: [],
      candidatesTotal: "",
      kept: [],
      keptMore: 0,
      keptTotal: 0,
      lastSweep: "",
      cleanup: "",
      held: null,
      archive: null,
      measuredAt: "",
      read: () => handlers.readStorage(),
      readLabel: WORDS.settings.storage.read,
    };
  }
  const labels = placeLabels(view);
  const places: PlaceRow[] = [...view.places]
    .sort((a, b) => b.bytes - a.bytes)
    .map((place: PlaceUsage) => ({
      key: place.place,
      label: place.label,
      bytes: bytesLabel(place.bytes),
      count: place.count,
      cleanup: place.cleanup === null ? null : place.cleanup ? WORDS.settings.skills.on : WORDS.settings.skills.off,
      note: place.note ?? null,
    }));
  const candidates = candidateAggregate(view.candidates, labels);
  const totalBytes = view.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  return {
    measuring: state.storageMeasuring,
    error: state.storageError,
    loaded: true,
    filesystems: view.filesystems.map((fs) => ({
      key: fs.mount,
      label: fs.label ?? fs.mount,
      free: bytesLabel(fs.freeBytes),
      total: bytesLabel(fs.totalBytes),
      below: fs.belowThreshold,
      threshold: WORDS.settings.storage.threshold(view.minFreeGb),
    })),
    places,
    candidates,
    candidatesTotal: `${view.candidates.length} 件 · ${bytesLabel(totalBytes)}`,
    kept: keptRows(view.kept, labels),
    keptMore: Math.max(0, view.kept.length - KEPT_ROWS),
    keptTotal: view.kept.length,
    lastSweep: sweepLine(view),
    cleanup: view.cleanup ? WORDS.settings.storage.cleanupOn : WORDS.settings.storage.cleanupOff,
    held: view.heldLanes.length ? WORDS.settings.storage.heldLanes(view.heldLanes.length) : null,
    archive: view.archive && !view.archive.visible ? WORDS.settings.storage.archiveHidden(view.archive.dir) : null,
    measuredAt: WORDS.settings.storage.measuredAt(view.measuredAt),
    read: () => handlers.readStorage(),
    readLabel: WORDS.settings.storage.readAgain,
  };
}

export { MEMORY_VALUES };
