import { inboxLaneId, type HeldIssue, type IddState, type IgnoredIssueView, type InboxItem, type LaneRow, type LaneSection } from "../engine/contract";
import { listPasskeys, readPin, signApproval, signWithPin, type PasskeyDeps } from "../engine/passkey";
import { WORDS } from "../strings";
import { itemKey } from "./deck";
import { isIrreversible, type Intent } from "./keymap";
import { requestFor, unignoreRequest, type EngineRequest } from "./requests";

export interface Snapshot {
  source: string;
  items: InboxItem[];
  holds: HeldIssue[];
  ignores: IgnoredIssueView[];
  lanes: LaneRow[];
  sections: LaneSection[];
  /** the cards answered today, oldest first */
  answered: IddState["answered"];
  /** today's counts for the progress row: `done` answered, `open` still waiting */
  progress: IddState["progress"];
  /** the day's spend, when the door returned it */
  today: IddState["today"] | null;
  /** the notices the engine could not deliver */
  undelivered: IddState["undelivered"];
}

export interface StoreState {
  snapshot: Snapshot | null;
  /** "down" while the last read failed: the last snapshot stays, and no decision is sent */
  connection: "ok" | "down";
  attempt: number;
  /** why the engine refused a card, by card key, shown over that card */
  errors: Record<string, string>;
  /** the line left after a decision the engine cannot take back */
  receipt: string | null;
  /** cards already decided on: a stale state response must not bring one back */
  hidden: string[];
  /** the card the person brought to the front from the sidebar; the screen's own order, never the engine's */
  focused: string | null;
  /** true while a decision is with the engine: no further operation is taken until it answers and state is read */
  deciding: boolean;
  /** what the screen knows about this page's registered keys: 0 really means none, null means it could not be read */
  sign: { read: boolean; count: number | null; error: string | null; pin: boolean | null; pinError: string | null; digits: number };
  now: number;
}

export interface FetchResult {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  /** the answer's headers; the state door numbers its answer here, which is what the screen's floor is kept in */
  headers?: { get(name: string): string | null };
}

export type FetchLike = (path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<FetchResult>;

export type Listener = () => void;

function asItems(value: unknown): InboxItem[] {
  return Array.isArray(value) ? (value as InboxItem[]) : [];
}

function withoutKey(map: Record<string, string>, key: string): Record<string, string> {
  const next = { ...map };
  delete next[key];
  return next;
}

/**
 * The engine's warning that a decision went through but the message could not be handed to the lane's agent, or null.
 * Without it the person cannot tell that the answer never reached the lane (F-112-7).
 */
export function warningOf(body: Record<string, unknown> | null): string | null {
  return body && typeof body.warning === "string" && body.warning ? body.warning : null;
}

/** the line a decision leaves: its receipt and, when it went through, the engine's undelivered warning */
function receiptLine(receipt: string | null, body: Record<string, unknown> | null): string | null {
  const warning = warningOf(body);
  return [receipt, warning].filter(Boolean).join("。") || null;
}

/** the line a decision the engine cannot take back leaves on the screen, with the lane's name */
export function receiptFor(intent: Intent, item: InboxItem, body?: Record<string, unknown> | null): string | null {
  if (!isIrreversible(intent, item)) return null;
  const lane = inboxLaneId(item) ?? "";
  // an operation the screen has no words of its own for: the receipt says which one the engine's answer named was pressed
  if (intent.kind === "operate") return WORDS.card.receipt.operated(lane, WORDS.card.generic.op(intent.op));
  if (intent.kind === "ship_approve") {
    if (item.kind === "land-batch") return WORDS.card.receipt.batch(Array.isArray(intent.payload.lanes) ? intent.payload.lanes.length : 0);
    return WORDS.card.receipt.ship(lane);
  }
  if (intent.kind === "outbound_approve") {
    const url = body && typeof body.url === "string" ? body.url : null;
    // the engine's warning is added once, by `receiptLine`: repeating it here printed it twice (AC-005)
    return `${WORDS.card.receipt.post(lane)}${url ? ` · ${url}` : ""}`;
  }
  if (intent.kind === "outbound_discard") return WORDS.card.receipt.discard(lane);
  if (intent.kind === "stuck_ignore" || intent.kind === "duplicate_merge") {
    const base = intent.kind === "stuck_ignore" ? WORDS.card.receipt.ignore(lane) : WORDS.card.receipt.merge(lane);
    const fromIssue = item.source?.kind === "github" || item.source?.kind === "linear";
    return fromIssue ? `${base}。${WORDS.sidebar.issueAlso}` : base;
  }
  if (intent.kind === "stuck_accept") return WORDS.card.receipt.accept(lane);
  if (intent.kind === "proposal_approve" || intent.kind === "proposal_reject") {
    const id = item.kind === "proposal" ? item.proposalId : lane;
    return intent.kind === "proposal_approve" ? WORDS.card.receipt.approve(id) : WORDS.card.receipt.reject(id);
  }
  return WORDS.card.receipt.requeueDrop(lane);
}

/** the number the state door gave its answer, or 0 when the answer carried none (an engine that cannot number it) */
export function engineSeqOf(res: FetchResult): number {
  const raw = res.headers?.get("x-idd-seq") ?? "";
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) ? n : 0;
}

/**
 * The inbox's state and its calls to the engine. The rules that matter live here. A picture is applied only when the
 * engine derived it after the one already shown, which the engine's own number says (so an answer built before a
 * judgment the screen already sent cannot resurrect that card), and a card the engine took a judgment for stays
 * hidden until the read the screen itself asks after that judgment says where the engine put it. A decision counts
 * as done only once the engine's answer says so.
 *
 * The picture arrives on the engine's stream, not on a clock: `apply` takes a frame, and `read` is used only after a
 * decision (to take in the judgment's effect and the number it was derived at) and when the person asks to try again.
 */
export class InboxStore {
  private listeners = new Set<Listener>();
  private seq = 0;
  private lastApplied = 0;
  /** the engine number of the newest picture shown: anything numbered at or below it was derived earlier */
  private applied = 0;
  /** the engine number of the picture on the screen now; a resync may show a picture numbered below `applied` */
  private shown = 0;
  /** the engine number at which a hidden card was last seen left out of the picture */
  private hiddenAt = new Map<string, number>();
  /**
   * For a hidden card the engine may still hold, the number of reads issued when it was judged. Some judgments leave
   * the card in the picture (put off until later, brought back, a batch with questions still open), so only a read
   * asked for after the judgment can say where the engine put it.
   */
  private awaiting = new Map<string, number>();

  state: StoreState = { snapshot: null, connection: "ok", attempt: 0, errors: {}, receipt: null, hidden: [], focused: null, deciding: false, sign: { read: false, count: null, error: null, pin: null, pinError: null, digits: 6 }, now: 0 };

  constructor(private readonly fetchFn: FetchLike, private readonly clock: () => number = () => Date.now(), private readonly signDeps: PasskeyDeps = {}) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private patch(next: Partial<StoreState>): void {
    this.state = { ...this.state, ...next, now: this.clock() };
    this.emit();
  }

  /** ask the engine for the state; the response is applied only when it is newer than what is already shown */
  read(): Promise<void> {
    const mine = ++this.seq;
    return this.fetchFn("/api/idd/state")
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) {
          this.failRead(mine);
          return;
        }
        let body: Record<string, unknown>;
        try {
          const parsed = await res.json();
          if (!parsed || typeof parsed !== "object") throw new Error("not an object");
          body = parsed as Record<string, unknown>;
        } catch {
          // a 2xx whose body is not JSON is as unusable as a failure: never apply it
          this.failRead(mine);
          return;
        }
        if (mine <= this.lastApplied) return;
        const seq = engineSeqOf(res);
        this.lastApplied = mine;
        // the engine numbers its answers when it derives them: an answer numbered at or below the picture already
        // shown was built before it, whatever order the responses arrive in, so it never replaces the picture
        if (seq > 0 && seq <= this.applied) {
          // it can still say where the engine put a judged card: this is a read the screen asked for after the
          // judgment, and the picture on the screen was derived no earlier than it answers at
          this.settlePlacement(mine);
          return;
        }
        this.show(body, seq, mine);
      })
      .catch(() => this.failRead(mine));
  }

  /**
   * Take a picture the engine pushed. The whole state rides one frame, so the screen shows it as it stands; a frame
   * numbered at or below the picture already shown is one the engine derived earlier, and is left out.
   */
  apply(frame: { seq: number; state: unknown }, opts: { resync?: boolean } = {}): void {
    const body = frame?.state;
    if (!body || typeof body !== "object") return;
    const seq = Number(frame.seq);
    if (!Number.isFinite(seq) || seq <= 0) return;
    if (!opts.resync && seq <= this.applied) return;
    // a frame is a picture the screen did not ask for: it cannot say where a judgment was put
    this.show(body as Record<string, unknown>, seq, null);
  }

  /**
   * Show one picture: the fields the engine gave, with the cards already decided on kept out of it. `trustedRead` is
   * the number of the read this picture answers, or null for a frame the screen did not ask for.
   */
  private show(body: Record<string, unknown>, seq: number, trustedRead: number | null): void {
    const items = asItems(body.items);
    const present = new Set(items.map(itemKey));
    const progress = body.progress && typeof body.progress === "object" ? (body.progress as IddState["progress"]) : { done: 0, open: items.length };
    if (seq > 0) {
      this.applied = Math.max(this.applied, seq);
      this.shown = seq;
    }
    this.patch({
      snapshot: {
        source: typeof body.source === "string" ? body.source : "state",
        items,
        holds: Array.isArray(body.holds) ? (body.holds as HeldIssue[]) : [],
        ignores: Array.isArray(body.ignores) ? (body.ignores as IgnoredIssueView[]) : [],
        lanes: Array.isArray(body.lanes) ? (body.lanes as LaneRow[]) : [],
        sections: Array.isArray(body.sections) ? (body.sections as LaneSection[]) : [],
        answered: Array.isArray(body.answered) ? (body.answered as IddState["answered"]) : [],
        progress: { done: Number(progress.done) || 0, open: Number(progress.open) || 0 },
        today: body.today && typeof body.today === "object" ? (body.today as IddState["today"]) : null,
        undelivered: body.undelivered && typeof body.undelivered === "object" ? (body.undelivered as IddState["undelivered"]) : { total: 0, failed: 0 },
      },
      connection: "ok",
      attempt: 0,
      hidden: this.hiddenOf(present, seq, trustedRead),
      focused: this.state.focused && present.has(this.state.focused) ? this.state.focused : null,
    });
  }

  /**
   * Decide where the judged cards went, without taking in a picture. A read asked for after a judgment can come back
   * numbered at or below the picture the stream already put on the screen (the engine numbers both when it derives
   * them), so it cannot replace the picture; it can still say where the engine put a card, because the picture on the
   * screen was derived after the judgment was written. Only the cards' places are settled: what is on the screen stays.
   */
  private settlePlacement(readSeq: number): void {
    const snapshot = this.state.snapshot;
    if (!snapshot) return;
    const present = new Set(snapshot.items.map(itemKey));
    const hidden = this.hiddenOf(present, this.shown, readSeq);
    if (hidden.length === this.state.hidden.length && hidden.every((key, at) => key === this.state.hidden[at])) return;
    this.patch({ hidden });
  }

  /**
   * The cards the engine has taken a judgment for. While the engine still holds the card (put off, brought back, a
   * batch with questions open) no picture can say so by itself, so the one that decides is the read the screen asks
   * after the judgment: the engine writes the judgment before it answers, so that read sees it. It arrives through
   * `show` when it is newer than the picture on the screen and through `settlePlacement` when it is not. A picture derived
   * before that read — a frame from the stream, a read asked for earlier — is one the engine derived before it took
   * the judgment, and cannot bring the card back. Once the engine has let the card go (a picture without it), the
   * old rule returns: a later picture that shows the card again is a new card, and only then is it shown.
   */
  private hiddenOf(present: Set<string>, seq: number, trustedRead: number | null): string[] {
    const kept: string[] = [];
    for (const key of this.state.hidden) {
      const seenAt = this.hiddenAt.get(key);
      if (!present.has(key)) {
        if (seq > 0) this.hiddenAt.set(key, Math.max(seenAt ?? 0, seq));
        this.awaiting.delete(key);
        kept.push(key);
        continue;
      }
      const judgedAt = this.awaiting.get(key);
      if (judgedAt !== undefined) {
        if (trustedRead !== null && judgedAt < trustedRead) {
          this.awaiting.delete(key);
          this.hiddenAt.delete(key);
          continue;
        }
        kept.push(key);
        continue;
      }
      if (seenAt !== undefined && (seq <= 0 || seq > seenAt)) {
        this.hiddenAt.delete(key);
        continue;
      }
      kept.push(key);
    }
    return kept;
  }

  private failRead(mine: number): void {
    // a failure older than the last applied read says nothing about the state now
    if (mine <= this.lastApplied) return;
    this.patch({ connection: "down", attempt: this.state.attempt + 1 });
  }

  private markDown(): void {
    this.patch({ connection: "down", attempt: this.state.attempt + 1 });
  }

  private send(req: Pick<EngineRequest, "method" | "path" | "body">): Promise<{ ok: boolean; body: Record<string, unknown> | null; reached: boolean }> {
    return this.fetchFn(req.path, { method: req.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body) })
      .then(async (res) => {
        let body: Record<string, unknown> | null = null;
        try {
          const parsed = await res.json();
          if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
        } catch {
          body = null;
        }
        const ok = res.status >= 200 && res.status < 300 && body !== null && body.ok !== false;
        return { ok, body, reached: true };
      })
      .catch(() => ({ ok: false, body: null, reached: false }));
  }

  /** the engine's refusal, or that it could not be reached, set over the card that asked */
  private failDecision(key: string, body: Record<string, unknown> | null, reached: boolean): void {
    const reason = body && typeof body.error === "string" && body.error ? body.error : null;
    const text = reason ? `${WORDS.errors.rejectedPrefix}: ${reason}` : WORDS.errors.unreachable;
    this.state = { ...this.state, errors: { ...this.state.errors, [key]: text }, connection: reached ? this.state.connection : "down", attempt: reached ? this.state.attempt : this.state.attempt + 1, now: this.clock() };
    this.emit();
  }

  /**
   * Send a decision; only the engine's success makes the card done. One decision is with the engine at a time:
   * while one is in flight a further call is dropped, so a repeated key or a second press cannot send the same
   * card twice or reach the card that comes next. The gate opens again once the engine has answered and the state
   * coming after it has been read, so the next operation acts on the card the screen now shows.
   */
  /** bring a card in the deck to the front, in the screen alone: the engine's order and snoozes are not touched */
  focus(item: InboxItem): void {
    this.patch({ focused: itemKey(item) });
  }

  decide(intent: Intent, item: InboxItem): Promise<void> {
    const key = itemKey(item);
    if (this.state.hidden.includes(key)) return Promise.resolve();
    const req = requestFor(intent, item);
    if (!req) return Promise.resolve();
    // the engine's answer says whether the operation is signed: a signed one asks for its signature over the content it
    // names before it is sent, and a plain one goes as it is (C-265-2)
    if (req.signature !== "none") return this.signAndSend(intent, item, String(req.body.action ?? ""), (req.body.payload ?? {}) as Record<string, unknown>);
    if (this.state.deciding) return Promise.resolve();
    if (this.state.connection === "down") {
      this.failDecision(key, { error: null }, false);
      return Promise.resolve();
    }
    this.patch({ deciding: true });
    return this.send(req)
      .then((out) => {
        if (!out.ok) {
          this.failDecision(key, out.body, out.reached);
          return;
        }
        // the decision went through: the card stays hidden until the read asked for here says where it was put
        const receipt = receiptFor(intent, item);
        // the check leaves the card in place: it only re-reads the engine's state
        const keep = req.keepsCard === true;
        if (!keep) this.awaiting.set(key, this.seq);
        this.state = {
          ...this.state,
          hidden: keep ? this.state.hidden : [...new Set([...this.state.hidden, key])],
          errors: withoutKey(this.state.errors, key),
          receipt: receiptLine(receipt, out.body) ?? this.state.receipt,
          now: this.clock(),
        };
        this.emit();
        return this.read();
      })
      .finally(() => this.patch({ deciding: false }));
  }

  /**
   * Send an approval the engine says is signed: ask the engine whether this approval needs a signature, make it, and
   * post the decision with it. The payload is the one frozen when the confirm opened (or the operation's own, for an
   * answer the card itself shows in full), so the challenge and the decision carry the same content; a challenge that
   * says no signature is needed posts the same payload without one. A cancelled or refused signature leaves the card
   * where it was, with the reason over it.
   */
  approve(intent: Extract<Intent, { kind: "ship_approve" | "outbound_approve" }>, item: InboxItem): Promise<void> {
    return this.signAndSend(intent, item, intent.action, intent.payload);
  }

  private signAndSend(intent: Intent, item: InboxItem, action: string, payload: Record<string, unknown>): Promise<void> {
    const key = itemKey(item);
    if (this.state.hidden.includes(key)) return Promise.resolve();
    if (this.state.deciding) return Promise.resolve();
    if (this.state.connection === "down") {
      this.failDecision(key, { error: null }, false);
      return Promise.resolve();
    }
    this.patch({ deciding: true });
    return signApproval(action, payload, { ...this.signDeps, fetcher: this.fetchFn })
      .then((signed) => {
        if (!signed.ok) {
          if (signed.needsRegistration) this.patch({ sign: { ...this.state.sign, read: true, count: 0, error: null } });
          this.failDecision(key, { error: signed.error ?? WORDS.sign.cannot }, true);
          return;
        }
        return this.postSigned(intent, item, action, { ...payload, ...(signed.approval ?? {}) });
      })
      .catch(() => this.failDecision(key, null, false))
      .finally(() => this.patch({ deciding: false }));
  }

  /**
   * Send the same approval signed with the PIN instead of the passkey. The PIN is handed to the derivation and the
   * signature is what leaves: the challenge is the passkey's own, made over the content the confirm stage showed, so
   * a PIN signs this one card and no other (C-182-2, C-182-6). A wrong PIN or a stopped one leaves the card where it
   * was, with the engine's reason over it; the PIN itself is never sent or kept.
   */
  approveWithPin(intent: Extract<Intent, { kind: "ship_approve" | "outbound_approve" }>, item: InboxItem, pin: string): Promise<void> {
    const key = itemKey(item);
    if (this.state.hidden.includes(key)) return Promise.resolve();
    if (this.state.deciding) return Promise.resolve();
    if (this.state.connection === "down") {
      this.failDecision(key, { error: null }, false);
      return Promise.resolve();
    }
    this.patch({ deciding: true });
    return signWithPin(intent.action, intent.payload, pin, { ...this.signDeps, fetcher: this.fetchFn })
      .then((signed) => {
        if (!signed.ok) {
          if (signed.needsRegistration) this.patch({ sign: { ...this.state.sign, read: true, count: 0, error: null } });
          this.failDecision(key, { error: signed.error ?? WORDS.sign.cannot }, true);
          return;
        }
        return this.postApproval(intent, item, { ...intent.payload, ...(signed.approval ?? {}) });
      })
      .catch(() => this.failDecision(key, null, false))
      .finally(() => this.patch({ deciding: false }));
  }

  /** post one signed approval and take in where the engine put the card; only the engine's success makes it done */
  private postApproval(intent: Extract<Intent, { kind: "ship_approve" | "outbound_approve" }>, item: InboxItem, body: Record<string, unknown>): Promise<void> {
    return this.postSigned(intent, item, intent.action, body);
  }

  private postSigned(intent: Intent, item: InboxItem, action: string, body: Record<string, unknown>): Promise<void> {
    const key = itemKey(item);
    return this.send({ method: "POST", path: "/api/idd/decide", body: { action, payload: body } }).then((out) => {
      if (!out.ok) {
        this.failDecision(key, out.body, out.reached);
        return;
      }
      const receipt = receiptFor(intent, item, out.body);
      this.awaiting.set(key, this.seq);
      this.state = {
        ...this.state,
        hidden: [...new Set([...this.state.hidden, key])],
        errors: withoutKey(this.state.errors, key),
        receipt: receiptLine(receipt, out.body) ?? this.state.receipt,
        now: this.clock(),
      };
      this.emit();
      return this.read();
    });
  }

  /**
   * Read the keys registered for this page's host. A read that fails is kept as unreadable (null), never as zero:
   * the screen must not send a penne who has a key to register one.
   */
  readPasskeys(): Promise<void> {
    return listPasskeys({ ...this.signDeps, fetcher: this.fetchFn }).then((list) => {
      this.patch({ sign: { ...this.state.sign, read: true, count: list.readable ? (list.registered?.length ?? 0) : null, error: list.error ?? null } });
    });
  }

  /**
   * Read whether a PIN is set, which the confirm stage offers as the other way to sign one card. A record that cannot
   * be read is kept with its reason: it is not a screen with no PIN, and the stage must not offer a PIN it cannot
   * verify (C-182-5).
   */
  readPin(): Promise<void> {
    return readPin({ ...this.signDeps, fetcher: this.fetchFn }).then((answer) => {
      this.patch({
        sign: {
          ...this.state.sign,
          pin: answer.readable ? answer.configured : null,
          pinError: answer.readable ? null : (answer.error ?? "PIN の記録を読めませんでした"),
          digits: answer.digits,
        },
      });
    });
  }

  /** bring a put-off or sleeping card back to the front */
  wake(item: InboxItem): Promise<void> {
    const key = itemKey(item);
    if (this.state.connection === "down") {
      this.failDecision(key, { error: null }, false);
      return Promise.resolve();
    }
    return this.send({ method: "POST", path: "/api/idd/snooze", body: { key, wake: true } }).then((out) => {
      if (!out.ok) {
        this.failDecision(key, out.body, out.reached);
        return;
      }
      this.awaiting.set(key, this.seq);
      this.patch({ hidden: [...new Set([...this.state.hidden, key])] });
      return this.read();
    });
  }

  /** take an ignored Issue off the ignore list */
  unignore(ref: string): Promise<void> {
    if (this.state.connection === "down") {
      this.failDecision(`ignore:${ref}`, { error: null }, false);
      return Promise.resolve();
    }
    return this.send(unignoreRequest(ref)).then((out) => {
      if (!out.ok) {
        this.failDecision(`ignore:${ref}`, out.body, out.reached);
        return;
      }
      return this.read();
    });
  }

  /** drop the line left by an irreversible decision (after it has been read) */
  clearReceipt(): void {
    if (this.state.receipt === null) return;
    this.patch({ receipt: null });
  }

  /** note a connection failure from outside the store (the poller's own read) */
  markOffline(): void {
    this.markDown();
  }
}
