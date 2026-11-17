/**
 * The second conversation the screen follows beside the main one: a BTW branch cut off the open conversation, or
 * the consultation a card's question is asking. Both are conversations of their own with the same doors — the
 * record and the stream at `/api/conversations/:id`, `/messages` to send, `/promote` to raise them into the
 * mode's list (DEC-1846) — so one class drives both, and only the door that opens them differs.
 *
 * This class holds a `ChatStore` for the side, remembers which thing that side belongs to, and opens it once per
 * thing: a card's consult is the same consult on the second ask (DEC-9022), while the panel moving to another card
 * starts over rather than showing the last card's talk under the new card's name. A new thing gets a fresh store,
 * so an answer that comes back for the thing the frame left is written to the store nobody reads any more and
 * never lands on the next thing's frame. Nothing here invents a value: a refusal is kept as the side's own error
 * and the frame shows it.
 *
 * An open is with the engine for a while, and the thing the side belongs to can change in that window. Each open
 * carries a token; `clear`, `detach` and a request for another key bump it, so an open that comes back late cannot
 * select the conversation the frame has already left, and a request that arrives while one is in flight is not
 * dropped: the same key waits for the open already under way, another key takes the frame from it and opens
 * itself. A send is bound to the thing it began in the same way: while one is opening or with the engine, a second
 * press joins it rather than sending the same words twice, and if the thing is gone by the time the engine answers,
 * the words reach nothing and the answer is drawn nowhere.
 */

import { WORDS } from "../strings";
import { ChatStore, type ChatOpen, type EventStreamOpen, type FetchLike, type Listener } from "./store";

/** what opens the side conversation: a door of its own, answering the id to follow or why it refuses */
export type SideOpener = () => Promise<{ id: string | null; error: string | null }>;

/** what the frame draws of the side conversation */
export interface SideState {
  /** the conversation the side follows, or null while none is open */
  id: string | null;
  /** the side's own open state, as the main conversation's is read */
  open: ChatOpen | null;
  /** why the side could not be opened; the frame shows it in place of the talk */
  error: string | null;
  /** an open is with the engine */
  opening: boolean;
  /** a promote is with the engine */
  promoting: boolean;
  /** why the promote was refused, shown on the 会話として残す control */
  promoteError: string | null;
  /** the side was raised into the mode's list; a second promote is not offered */
  promoted: boolean;
}

/** what a send into the side came to: the engine took the words, or it did not and why */
export interface SideSendResult {
  ok: boolean;
  error: string | null;
}

export class SideChat {
  private store: ChatStore;
  private readonly listeners = new Set<Listener>();
  private unsubscribeStore: () => void = () => {};
  private readonly fetchFn: FetchLike;
  private readonly streams: EventStreamOpen;
  private readonly clock: (() => number) | undefined;
  /** what this side belongs to: a card's key or a parent conversation's; a new key starts over */
  private key: string | null = null;
  private opening = false;
  private openError: string | null = null;
  private promoting = false;
  private promoteError: string | null = null;
  private promoted = false;
  /** the opener the last `ensure` was given, so a send that arrives first can still open the side */
  private opener: SideOpener | null = null;
  /** which open owns the frame: a `clear`, a `detach` or a request for another key makes an open in flight stale */
  private token = 0;
  /** the open under way, so a request for the same key waits for it instead of cutting a second branch */
  private inFlight: Promise<void> | null = null;
  /** the send under way, so the presses made while the side opens or answers reach the send door once */
  private sendInFlight: Promise<SideSendResult> | null = null;

  constructor(fetchFn: FetchLike, streams: EventStreamOpen, clock?: () => number) {
    this.fetchFn = fetchFn;
    this.streams = streams;
    this.clock = clock;
    this.store = this.newStore();
  }

  private newStore(): ChatStore {
    const store = new ChatStore(this.fetchFn, this.streams, this.clock);
    this.unsubscribeStore = store.subscribe(() => this.emit());
    return store;
  }

  /** drop the store of the thing that is gone; the next thing starts with one of its own */
  private renew(): void {
    this.unsubscribeStore();
    this.store = this.newStore();
  }

  /** the conversation store this side follows; read it and drive it as the main conversation's is driven */
  get chat(): ChatStore {
    return this.store;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  get state(): SideState {
    return {
      id: this.chat.state.selectedId,
      open: this.chat.state.open,
      error: this.openError,
      opening: this.opening,
      promoting: this.promoting,
      promoteError: this.promoteError,
      promoted: this.promoted,
    };
  }

  /**
   * Follow the side conversation `key` names, opening it through `opener` when it is not the one already open.
   * A key already open is left alone: asking the same card again continues the same consult, and the same
   * conversation's BTW branch is not cut twice.
   */
  ensure(key: string, opener: SideOpener): Promise<void> {
    if (this.key === key && this.chat.state.selectedId && !this.openError) return Promise.resolve();
    if (this.inFlight) {
      // a request for the key already opening waits for it, so the same branch is not cut twice; another key takes
      // the frame, so the result still coming cannot select the side this request is replacing
      if (this.key === key) return this.inFlight;
      this.token += 1;
    }
    return this.open(key, opener);
  }

  private open(key: string, opener: SideOpener): Promise<void> {
    // a different thing starts over with a store of its own: an answer for the old one is written where nobody reads
    if (this.key !== key) {
      this.chat.clear();
      this.renew();
    }
    const token = ++this.token;
    this.key = key;
    this.opener = opener;
    this.openError = null;
    this.promoteError = null;
    this.promoted = false;
    this.opening = true;
    this.emit();
    const run = opener()
      .then((opened) => {
        if (token !== this.token) return undefined;
        if (opened.error) {
          this.openError = opened.error;
          return undefined;
        }
        if (!opened.id) return undefined;
        return this.chat.select(opened.id);
      })
      .catch(() => {
        if (token === this.token) this.openError = WORDS.errors.unreachable;
      })
      .then(() => {
        if (token !== this.token) return;
        this.opening = false;
        this.inFlight = null;
        this.emit();
      });
    this.inFlight = run;
    return run;
  }

  /**
   * Send `text` into the side conversation `key` names, opening it when it is not open yet. The first send is what
   * opens a BTW branch or a card's consult: an empty frame has no conversation to talk in, and the engine's open
   * door is the only one that makes one. The result says whether the engine took the words: a send that does not
   * come back ok was not taken, so the frame keeps the box and shows the reason.
   *
   * The send under way owns the door. A second press while the first is still opening or with the engine joins it,
   * so one batch of presses reaches the send door once; the next press after it settles sends again.
   */
  ask(key: string, opener: SideOpener, text: string): Promise<SideSendResult> {
    if (this.sendInFlight) return this.sendInFlight;
    const run = this.doSend(key, opener, text);
    this.sendInFlight = run;
    return run.then((result) => {
      if (this.sendInFlight === run) this.sendInFlight = null;
      return result;
    });
  }

  private async doSend(key: string, opener: SideOpener, text: string): Promise<SideSendResult> {
    await this.ensure(key, opener);
    const store = this.store;
    // the frame this send belongs to: a clear, a detach or another key makes this one stale
    const token = this.token;
    const id = store.state.selectedId;
    if (!id || this.key !== key) return { ok: false, error: this.openError };
    const attempt = store.send(text);
    // the store answers a caller with nothing: a send it did not take (the door busy) leaves `sending` as it was
    if (store.state.open?.sending !== true) return { ok: false, error: null };
    await attempt;
    // the thing the send began in is gone: the words reach nothing and the answer is drawn nowhere
    if (this.store !== store || this.token !== token || this.key !== key || store.state.selectedId !== id) {
      return { ok: false, error: null };
    }
    const notice = store.state.open?.notice ?? null;
    return notice ? { ok: false, error: notice } : { ok: true, error: null };
  }

  /** stop the run the side is answering with; the frame's box is not touched */
  stop(): Promise<void> {
    return this.chat.stop();
  }

  /** raise the side conversation into the mode's own list; only a press does this (DEC-1846) */
  promote(): Promise<boolean> {
    if (this.promoting || this.promoted) return Promise.resolve(false);
    this.promoting = true;
    this.promoteError = null;
    this.emit();
    return this.chat.promote()
      .then((result) => {
        if (!result.ok) this.promoteError = result.error;
        else this.promoted = true;
        return result.ok;
      })
      .finally(() => {
        this.promoting = false;
        this.emit();
      });
  }

  /** stop following the side and leave nothing behind; the caller opens the next thing through `ensure` */
  clear(): void {
    // the open and the send in flight belong to the thing that is gone: they must not touch the side after this
    this.token += 1;
    this.inFlight = null;
    this.opening = false;
    this.key = null;
    this.opener = null;
    this.openError = null;
    this.promoteError = null;
    this.promoting = false;
    this.promoted = false;
    this.sendInFlight = null;
    this.chat.clear();
    this.renew();
    this.emit();
  }

  /**
   * Leave the screen that draws this side: stop the flow and the reconnect loop, keep the selection and the box.
   * An open or a send in flight belongs to the screen that is gone.
   */
  detach(): void {
    this.token += 1;
    this.inFlight = null;
    this.opening = false;
    this.sendInFlight = null;
    this.chat.detach();
    this.emit();
  }

  /** return to the screen: read the same side conversation again and follow its flow */
  resume(): void {
    const id = this.chat.state.selectedId;
    if (id) void this.chat.select(id);
  }
}

/**
 * Cut a BTW branch off one conversation at the head pi reports. The branch is kept out of the list until it is
 * raised (DEC-1846), so what comes back is an ordinary conversation id to open. `at` must be a point pi forks at
 * (DEC-1842); the engine refuses the others and the reason is what the frame shows.
 */
export async function openBranchAt(fetchFn: FetchLike, parentId: string, at: string | null): Promise<{ id: string | null; error: string | null }> {
  if (!at) return { id: null, error: WORDS.chat.branch.noPoint };
  try {
    const res = await fetchFn(`/api/conversations/${encodeURIComponent(parentId)}/ephemeral`, { method: "POST", body: JSON.stringify({ at }) });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status < 200 || res.status >= 300 || !body || body.ok === false || typeof body.id !== "string") {
      return { id: null, error: refusal(body, res.status) };
    }
    return { id: body.id, error: null };
  } catch {
    return { id: null, error: WORDS.errors.unreachable };
  }
}

/**
 * Open the consult for one card, or answer the one already open for it (DEC-9022). The card's own key rides in
 * the body, so the engine decides which consult that is and a second ask returns the same id.
 */
export async function openConsult(fetchFn: FetchLike, target: { kind: string; iddId: string; batchId: string }): Promise<{ id: string | null; error: string | null }> {
  try {
    const res = await fetchFn("/api/idd/consult", { method: "POST", body: JSON.stringify(target) });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status < 200 || res.status >= 300 || !body || body.ok === false || typeof body.id !== "string") {
      return { id: null, error: refusal(body, res.status) };
    }
    return { id: body.id, error: null };
  } catch {
    return { id: null, error: WORDS.errors.unreachable };
  }
}

/** the engine's own words for a refusal, or the generic line when it sent none */
function refusal(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const message = (body as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return `${WORDS.chat.refused} (${status})`;
}
