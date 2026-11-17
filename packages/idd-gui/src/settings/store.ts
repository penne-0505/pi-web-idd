/**
 * The settings sheet's reads and presses. Four sections reach the engine — Skills · MCP · Search, Spaces,
 * Storage — and one of them (Storage) only looks (C-171-3). Every value the sheet draws comes from a response
 * here; a row is only ever the engine's answer (DEC-103-1), and a section with no door answers nothing rather
 * than an invented row.
 *
 * The conversation settings are one file for every conversation, and a PATCH replaces the whole `skills` list.
 * Two presses landing close together would therefore lose the first if each were built from the page's last
 * render, so the presses are queued and drained one at a time: each is built from the answer the one before it
 * received, and a press the engine refuses leaves the engine's own value standing.
 */
import type { ConversationSettings, MemoryHandling, Space, SkillCandidate, StorageView } from "../engine/contract";
import { approvePending, disablePin, listPasskeys, listPending, readPin, registerPasskey, setPin, type PasskeyDeps } from "../engine/passkey";
import { EMPTY_PASSKEYS, type PasskeyKeyRow, type PasskeyResult, type PasskeysState } from "./passkeys";

export interface FetchResult {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

export type FetchLike = (path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<FetchResult>;
export type Listener = () => void;

const JSON_HEADERS = { "content-type": "application/json" };

export interface WorkspaceRow {
  mode: string;
  label: string;
  workspace: string;
}

/** the `/api/conversation-settings` answer, as the sheet reads it */
export interface ConversationView {
  settings: ConversationSettings;
  candidates: SkillCandidate[];
  path: string;
}

export interface SettingsStoreState {
  /** the conversation settings, or null before the first read answers */
  conversation: ConversationView | null;
  /** the conversations whose running pi still uses the old settings, from the last accepted write */
  running: string[];
  /** the engine's own refusal of the last press, cleared by the next accepted one */
  refusal: string | null;
  /** whether a conversation-settings read or write is in flight */
  loading: boolean;
  connection: "ok" | "down";
  workspaces: WorkspaceRow[];
  mode: string | null;
  spaces: Space[];
  /** the mode the space list belongs to, so an answer for a workspace the sheet left is dropped */
  spacesFor: string | null;
  spaceRefusal: string | null;
  spaceLoading: boolean;
  storage: StorageView | null;
  /** the storage door is measuring: the sheet shows that it is measuring and invents no number */
  storageMeasuring: boolean;
  storageError: string | null;
  /** the passkeys section: the engine's keys, the registrations that wait for approval, the PIN, and the last answer */
  passkeys: PasskeysState;
  /**
   * Bumped whenever the engine accepted a change to the keys or the PIN. The Inbox reads this: a key registered or a
   * PIN set in the sheet has to reach the Inbox's signing without a page reload (AC-006, F-189-1, F-189-9, F-189-16).
   */
  passkeysRevision: number;
}

const EMPTY: SettingsStoreState = {
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
  passkeys: { ...EMPTY_PASSKEYS },
  passkeysRevision: 0,
};

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** the response's `error`, or a line of our own when the engine gave none */
function errorOf(body: unknown, fallback: string): string {
  const o = objectOf(body);
  const message = o && typeof o.error === "string" ? o.error : "";
  return message || fallback;
}

function parseSettings(value: unknown): ConversationSettings | null {
  const o = objectOf(value);
  if (!o) return null;
  return {
    skills: list<string>(o.skills).filter((entry) => typeof entry === "string"),
    webSearch: typeof o.webSearch === "boolean" ? o.webSearch : false,
    webSearchTools: list<string>(o.webSearchTools).filter((entry) => typeof entry === "string"),
    mcp: typeof o.mcp === "boolean" ? o.mcp : false,
  };
}

function parseCandidate(value: unknown): SkillCandidate | null {
  const o = objectOf(value);
  if (!o || typeof o.path !== "string") return null;
  const origin = o.origin === "workspace" || o.origin === "repo" ? o.origin : "user";
  return {
    path: o.path,
    name: typeof o.name === "string" ? o.name : o.path,
    description: typeof o.description === "string" ? o.description : "",
    origin,
  };
}

function parseSpace(value: unknown): Space | null {
  const o = objectOf(value);
  if (!o || typeof o.id !== "string") return null;
  const memory: MemoryHandling = o.memory === "space" || o.memory === "shared" ? o.memory : "none";
  return {
    id: o.id,
    ...(typeof o.name === "string" && o.name ? { name: o.name } : {}),
    memory,
    references: list<string>(o.references).filter((entry) => typeof entry === "string"),
    instruction: typeof o.instruction === "string" ? o.instruction : "",
  };
}

/** the shape a new or edited space is sent in; the sheet only fills the fields it has a value for */
export interface SpaceInput {
  id?: string;
  name?: string;
  memory?: MemoryHandling;
  references?: string[];
  instruction?: string;
}

type SettingsOp = { kind: "skill"; path: string } | { kind: "webSearch"; value: boolean } | { kind: "mcp"; value: boolean };

/** one field's next value, built from the answer the last press received */
function patchFor(current: ConversationSettings, op: SettingsOp): Record<string, unknown> | null {
  if (op.kind === "skill") {
    const on = current.skills.includes(op.path);
    const next = on ? current.skills.filter((path) => path !== op.path) : [...current.skills, op.path];
    return { skills: next };
  }
  if (op.kind === "webSearch") {
    if (current.webSearch === op.value) return null;
    return { webSearch: op.value };
  }
  if (current.mcp === op.value) return null;
  return { mcp: op.value };
}

export class SettingsStore {
  private listeners = new Set<Listener>();
  private settingsSeq = 0;
  private spacesSeq = 0;
  private storageSeq = 0;
  private passkeysSeq = 0;
  /**
   * One signature-asking operation of the passkeys section at a time, decided here and not by what the screen drew
   * (F-189-2): registering a key, approving a pending one, and setting or clearing the PIN all wait for the browser's
   * one signature prompt, and two of them at once would interleave on the state file.
   */
  private passkeyInFlight = false;
  private pending: SettingsOp[] = [];
  private draining = false;

  state: SettingsStoreState = { ...EMPTY };

  constructor(private readonly fetchFn: FetchLike, private readonly passkeyDeps: PasskeyDeps = {}) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private patch(next: Partial<SettingsStoreState>): void {
    this.state = { ...this.state, ...next };
    this.emit();
  }

  // ---- the conversation settings (Skills · MCP · Search) ----

  /** the current values and the skills a conversation may turn on; the section reads this when it shows */
  readSettings(): Promise<void> {
    const mine = ++this.settingsSeq;
    this.patch({ loading: true });
    return this.fetchFn("/api/conversation-settings")
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return this.settingsFailed(mine);
        const body = objectOf(await res.json().catch(() => null));
        if (!body) return this.settingsFailed(mine);
        const settings = parseSettings(body.settings);
        if (!settings) return this.settingsFailed(mine);
        if (mine !== this.settingsSeq) return;
        this.patch({
          conversation: {
            settings,
            candidates: list<unknown>(body.candidates).map(parseCandidate).filter((c): c is SkillCandidate => c !== null),
            path: typeof body.path === "string" ? body.path : "",
          },
          connection: "ok",
          loading: false,
        });
      })
      .catch(() => this.settingsFailed(mine));
  }

  private settingsFailed(mine: number): void {
    if (mine !== this.settingsSeq) return;
    this.patch({ connection: "down", loading: false });
  }

  /** a skill's switch: the press reaches the engine the moment the queue lets it (AC-001) */
  toggleSkill(path: string): void {
    this.enqueue({ kind: "skill", path });
  }

  setWebSearch(value: boolean): void {
    this.enqueue({ kind: "webSearch", value });
  }

  setMcp(value: boolean): void {
    this.enqueue({ kind: "mcp", value });
  }

  private enqueue(op: SettingsOp): void {
    this.pending.push(op);
    void this.drain();
  }

  /** presses leave one at a time: each is built from the answer the press before it received */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length) {
        const op = this.pending.shift() as SettingsOp;
        const current = this.state.conversation;
        if (!current) continue;
        const patch = patchFor(current.settings, op);
        if (!patch) continue;
        this.patch({ loading: true });
        try {
          const res = await this.fetchFn("/api/conversation-settings", {
            method: "PATCH",
            headers: JSON_HEADERS,
            body: JSON.stringify(patch),
          });
          const body = objectOf(await res.json().catch(() => null));
          if (res.status < 200 || res.status >= 300) {
            this.patch({ refusal: errorOf(body, "engine が受け付けませんでした"), connection: res.status >= 500 ? "down" : this.state.connection, loading: false });
            continue;
          }
          const settings = body ? parseSettings(body.settings) : null;
          if (!body || !settings) {
            this.patch({ refusal: "engine の応答を読めませんでした", loading: false });
            continue;
          }
          this.patch({
            conversation: {
              settings,
              candidates: list<unknown>(body.candidates).map(parseCandidate).filter((c): c is SkillCandidate => c !== null),
              path: typeof body.path === "string" ? body.path : current.path,
            },
            running: list<string>(body.running).filter((id) => typeof id === "string"),
            refusal: null,
            connection: "ok",
            loading: false,
          });
        } catch {
          this.patch({ refusal: "engine に届きませんでした", connection: "down", loading: false });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  // ---- the conversation spaces ----

  /** the configured workspaces, so the Spaces section can choose one without opening a conversation */
  readWorkspaces(): Promise<void> {
    return this.fetchFn("/api/conversations/workspaces")
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return;
        const body = objectOf(await res.json().catch(() => null));
        if (!body) return;
        const workspaces = list<Record<string, unknown>>(body.workspaces)
          .filter((entry) => entry && typeof entry.mode === "string")
          .map((entry) => ({
            mode: entry.mode as string,
            label: typeof entry.label === "string" ? entry.label : (entry.mode as string),
            workspace: typeof entry.workspace === "string" ? entry.workspace : "",
          }));
        this.patch({ workspaces });
        if (!this.state.mode && workspaces.length) void this.selectMode(workspaces[0].mode);
      })
      .catch(() => undefined);
  }

  selectMode(mode: string): Promise<void> {
    this.patch({ mode, spaces: [], spacesFor: null, spaceRefusal: null });
    return this.readSpaces(mode);
  }

  /** one workspace's conversation spaces; an answer for a workspace the sheet left is dropped */
  readSpaces(mode: string): Promise<void> {
    const mine = ++this.spacesSeq;
    this.patch({ spaceLoading: true });
    return this.fetchFn(`/api/conversations/workspaces/${encodeURIComponent(mode)}/spaces`)
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return this.spacesFailed(mine, mode);
        const body = objectOf(await res.json().catch(() => null));
        if (!body) return this.spacesFailed(mine, mode);
        if (mine !== this.spacesSeq || this.state.mode !== mode) return;
        this.patch({
          spaces: list<unknown>(body.spaces).map(parseSpace).filter((p): p is Space => p !== null),
          spacesFor: mode,
          spaceLoading: false,
        });
      })
      .catch(() => this.spacesFailed(mine, mode));
  }

  private spacesFailed(mine: number, mode: string): void {
    if (mine !== this.spacesSeq || this.state.mode !== mode) return;
    this.patch({ spaceLoading: false, spaceRefusal: "スペースを読めませんでした" });
  }

  /** make one: the id and the fields the sheet filled; the engine writes the user's own dir (AC-002) */
  createSpace(mode: string, input: SpaceInput): Promise<boolean> {
    return this.sendSpace(mode, "POST", `/api/conversations/workspaces/${encodeURIComponent(mode)}/spaces`, input);
  }

  /** change one: only the fields the press actually changed are sent (C-171-4) */
  updateSpace(mode: string, id: string, patch: SpaceInput): Promise<boolean> {
    return this.sendSpace(mode, "PATCH", `/api/conversations/workspaces/${encodeURIComponent(mode)}/spaces/${encodeURIComponent(id)}`, patch);
  }

  /**
   * Send one create or edit and land its answer in the workspace it was saved to. The editor that sent it is
   * pinned to that workspace, but the answer can come back after the sheet has left for another one: the space
   * must not join the shown list then, and no re-read of the workspace that was left may invalidate the list of
   * the one now shown (F-1). The save's own loading and refusal belong to the shown workspace too.
   */
  private async sendSpace(mode: string, method: "POST" | "PATCH", path: string, input: SpaceInput): Promise<boolean> {
    const shown = () => this.state.mode === mode;
    if (shown()) this.patch({ spaceLoading: true, spaceRefusal: null });
    try {
      const res = await this.fetchFn(path, { method, headers: JSON_HEADERS, body: JSON.stringify(input) });
      const body = objectOf(await res.json().catch(() => null));
      if (res.status < 200 || res.status >= 300) {
        if (shown()) this.patch({ spaceLoading: false, spaceRefusal: errorOf(body, "engine が受け付けませんでした") });
        return false;
      }
      const space = body ? parseSpace(body.space) : null;
      if (!space) {
        if (shown()) this.patch({ spaceLoading: false, spaceRefusal: "engine の応答を読めませんでした" });
        return false;
      }
      if (!shown()) return true;
      const known = this.state.spaces.filter((entry) => entry.id !== space.id);
      this.patch({ spaces: [...known, space].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), spaceLoading: false, spaceRefusal: null });
      // the list a workspace returned is the ground; a create appends and an update replaces in place
      void this.readSpaces(mode);
      return true;
    } catch {
      if (shown()) this.patch({ spaceLoading: false, spaceRefusal: "engine に届きませんでした" });
      return false;
    }
  }

  // ---- storage: read only (C-171-3) ----

  /**
   * The free space, the sizes and the next candidates. The door runs the sweep's own judgment and deletes
   * nothing; on a first read it can take minutes, so the sheet shows that it is measuring and no number
   * appears until the answer does (C-171-3, DEC-103-2).
   */
  readStorage(): Promise<void> {
    const mine = ++this.storageSeq;
    this.patch({ storageMeasuring: true, storageError: null });
    return this.fetchFn("/api/idd/storage")
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return this.storageFailed(mine);
        const body = objectOf(await res.json().catch(() => null));
        if (!body || !Array.isArray(body.filesystems) || !Array.isArray(body.places)) return this.storageFailed(mine);
        if (mine !== this.storageSeq) return;
        this.patch({ storage: body as unknown as StorageView, storageMeasuring: false, storageError: null });
      })
      .catch(() => this.storageFailed(mine));
  }

  private storageFailed(mine: number): void {
    if (mine !== this.storageSeq) return;
    this.patch({ storageMeasuring: false, storageError: "storage を測れませんでした" });
  }

  // ---- passkeys: the registered keys, registration, and the pending approvals (C-172-1, C-172-2) ----

  /** the deps the passkey doors are called with: the sheet's own fetch, plus whatever a test injects */
  private passkey(over: PasskeyDeps = {}): PasskeyDeps {
    return { ...this.passkeyDeps, fetcher: this.fetchFn, ...over };
  }

  /**
   * Read both lists: the keys this engine has registered and the registrations that wait for approval. A list that
   * could not be read is kept as unreadable with the engine's reason, never as an empty one: zero keys is exactly
   * the answer that sends penne to register, and the tailnet screen cannot read the pending list at all.
   */
  readPasskeys(): Promise<void> {
    const mine = ++this.passkeysSeq;
    return Promise.all([listPasskeys(this.passkey()), listPending(this.passkey())])
      .then(([keys, pending]) => {
        if (mine !== this.passkeysSeq) return;
        const registered: PasskeyKeyRow[] | null = keys.readable
          ? (keys.registered ?? []).map((key) => ({ id: key.id, name: key.name ?? key.id, createdAt: key.createdAt ?? "" }))
          : null;
        this.patch({
          passkeys: {
            ...this.state.passkeys,
            keys: registered,
            keysError: keys.readable ? null : (keys.error ?? "鍵の一覧を読めませんでした"),
            pending: pending.readable ? (pending.pending ?? []) : null,
            pendingError: pending.readable ? null : (pending.error ?? "保留の一覧を読めませんでした"),
          },
        });
      })
      .catch(() => this.passkeysFailed(mine));
  }

  private passkeysFailed(mine: number): void {
    if (mine !== this.passkeysSeq) return;
    this.patch({
      passkeys: {
        ...this.state.passkeys,
        keys: null,
        keysError: "鍵の一覧を読めませんでした",
        pending: null,
        pendingError: "保留の一覧を読めませんでした",
      },
    });
  }

  /**
   * Read the PIN's state: whether one is set, when it was set, and whether it is stopped. A read that fails is kept
   * as its reason, never as "no PIN": an unreadable record is not a PIN that can be set without the passkey.
   */
  readPin(): Promise<void> {
    return readPin(this.passkey())
      .then((answer) => {
        this.patch({
          passkeys: {
            ...this.state.passkeys,
            pin: {
              ...this.state.passkeys.pin,
              configured: answer.readable ? answer.configured : null,
              error: answer.readable ? null : (answer.error ?? "PIN の記録を読めませんでした"),
              lockedUntil: answer.lockedUntil,
              digits: answer.digits,
            },
          },
        });
      })
      .catch(() => {
        this.patch({ passkeys: { ...this.state.passkeys, pin: { ...this.state.passkeys.pin, configured: null, error: "PIN の記録を読めませんでした" } } });
      });
  }

  /** one change the engine accepted: the Inbox reads this to stop asking for what is no longer true (AC-006) */
  private bumpPasskeys(): void {
    this.patch({ passkeysRevision: this.state.passkeysRevision + 1 });
  }

  /**
   * Register one key. The engine decides what happens: it stores the first key of the local screen on its own, and
   * asks for an already registered key's signature once one exists. A page that cannot make that signature leaves
   * the key pending, and the section says so instead of showing it among the registered keys.
   */
  registerPasskey(name?: string): Promise<boolean> {
    if (this.passkeyInFlight) return Promise.resolve(false);
    this.passkeyInFlight = true;
    this.patch({ passkeys: { ...this.state.passkeys, registering: true, result: null } });
    return registerPasskey(name, this.passkey())
      .then((answer) => {
        const result: PasskeyResult = answer.ok
          ? { kind: "registered" }
          : answer.pending
            ? { kind: "pending", detail: answer.error ?? undefined }
            : { kind: "failed", detail: answer.error ?? undefined };
        this.patch({ passkeys: { ...this.state.passkeys, registering: false, result } });
        // the lists are read again whatever the answer: a pending key belongs in the pending list, not here
        return this.readPasskeys().then(() => answer.ok);
      })
      .then((ok) => {
        if (ok) this.bumpPasskeys();
        return ok;
      })
      .catch(() => {
        const result: PasskeyResult = { kind: "failed", detail: "engine に届きませんでした" };
        this.patch({ passkeys: { ...this.state.passkeys, registering: false, result } });
        return false;
      })
      .finally(() => {
        this.passkeyInFlight = false;
      });
  }

  /**
   * Approve one pending registration with this page's own key. The challenge signed is the one the shown row was
   * read with, and the id sent is the same row's: a row that left the list or whose deadline passed since the read
   * signs nothing, so no signature is ever asked for a registration penne is not looking at (C-172-2).
   */
  approvePending(id: string): Promise<boolean> {
    if (this.passkeyInFlight) return Promise.resolve(false);
    const row = (this.state.passkeys.pending ?? []).find((entry) => entry.id === id);
    if (!row || !row.challenge) {
      this.patch({ passkeys: { ...this.state.passkeys, result: { kind: "failed", detail: "一覧に無い保留です。読み直してください" } } });
      return this.readPasskeys().then(() => false);
    }
    const deadline = Date.parse(row.expiresAt);
    if (!Number.isNaN(deadline) && deadline < Date.now()) {
      this.patch({ passkeys: { ...this.state.passkeys, result: { kind: "failed", detail: "この保留の期限は切れています" } } });
      return this.readPasskeys().then(() => false);
    }
    this.passkeyInFlight = true;
    this.patch({ passkeys: { ...this.state.passkeys, approving: id, result: null } });
    // every registered key is named as a candidate; the browser offers only the ones bound to this page's host
    const candidates = (this.state.passkeys.keys ?? []).map((key) => key.id)
    return approvePending(id, row.challenge, candidates, this.passkey())
      .then((answer) => {
        const result: PasskeyResult = answer.ok
          ? { kind: "approved", name: row.name }
          : { kind: "failed", detail: answer.error ?? undefined };
        this.patch({ passkeys: { ...this.state.passkeys, approving: null, result } });
        return this.readPasskeys().then(() => answer.ok);
      })
      .then((ok) => {
        if (ok) this.bumpPasskeys();
        return ok;
      })
      .catch(() => {
        this.patch({ passkeys: { ...this.state.passkeys, approving: null, result: { kind: "failed", detail: "engine に届きませんでした" } } });
        return false;
      })
      .finally(() => {
        this.passkeyInFlight = false;
      });
  }

  /**
   * Set or change the PIN. The PIN is stretched in the browser and only its public half is sent; the engine keeps it
   * only after a registered passkey has signed over exactly that key, its salt and its strength (C-182-1).
   */
  setPin(pin: string): Promise<boolean> {
    if (this.passkeyInFlight) return Promise.resolve(false);
    this.passkeyInFlight = true;
    this.patch({ passkeys: { ...this.state.passkeys, pin: { ...this.state.passkeys.pin, setting: true }, result: null } });
    return setPin(pin, this.passkey())
      .then((answer) => this.pinSettled(answer.ok, answer.error, "pin-set"))
      .catch(() => this.pinSettled(false, "engine に届きませんでした", "pin-set"))
      .finally(() => {
        this.passkeyInFlight = false;
      });
  }

  /** Turn the PIN off on a registered key's signature: after it, a card can only be signed with the passkey */
  disablePin(): Promise<boolean> {
    if (this.passkeyInFlight) return Promise.resolve(false);
    this.passkeyInFlight = true;
    this.patch({ passkeys: { ...this.state.passkeys, pin: { ...this.state.passkeys.pin, setting: true }, result: null } });
    return disablePin(this.passkey())
      .then((answer) => this.pinSettled(answer.ok, answer.error, "pin-cleared"))
      .catch(() => this.pinSettled(false, "engine に届きませんでした", "pin-cleared"))
      .finally(() => {
        this.passkeyInFlight = false;
      });
  }

  /**
   * Land one PIN operation's answer, read the PIN again, and tell the Inbox the means changed when it did (AC-006).
   * The operation's own kind is the notice only when the engine accepted it: a set the engine refused leaves the
   * PIN as it was, so saying it was set would send penne into the confirm stage believing a means it does not have.
   * The PIN is read again either way, so the row shows the engine's own value after a refusal too.
   */
  private pinSettled(ok: boolean, detail: string | undefined, op: "pin-set" | "pin-cleared"): Promise<boolean> {
    const result: PasskeyResult = ok ? { kind: op, ...(detail ? { detail } : {}) } : { kind: "failed", ...(detail ? { detail } : {}) };
    this.patch({ passkeys: { ...this.state.passkeys, pin: { ...this.state.passkeys.pin, setting: false }, result } });
    return this.readPin().then(() => {
      if (ok) this.bumpPasskeys();
      return ok;
    });
  }
}
