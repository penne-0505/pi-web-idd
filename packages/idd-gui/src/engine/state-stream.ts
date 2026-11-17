/**
 * The screen's one connection to the engine's state: a numbered stream the engine pushes when the picture moves.
 *
 * Nothing here asks for the picture on a clock. The screen used to read the state and Work doors every few seconds,
 * and the number of requests grew with how many screens were open and how long they stayed open, so a slow answer
 * made them stack and the engine stopped answering (#172). With the stream, an idle screen asks for nothing at all,
 * and a change arrives as soon as the engine finds it.
 *
 * A break of any kind — the peer's close, the tab coming back, a refusal while the engine is replaced — is retried
 * from the last number seen, once a second, for as long as the screen is up. The engine answers a reconnect with the
 * whole picture whatever number it is given, so the first frame after a reconnect is taken as it stands: the screen
 * never stays on the values from before the break, whichever engine is answering now.
 */

import type { StateFrameView } from "./contract";
import { openSse } from "./sse";

/** a frame as the screen takes it: whether it was the first one after a (re)connection */
export interface StateDelivery {
  frame: StateFrameView;
  /** true for the first frame of a connection: the whole picture, whatever number the screen held before */
  resync: boolean;
}

export type StateFrameOpen = (
  path: string,
  lastEventId: number | null,
  onFrame: (frame: StateFrameView) => void,
  onGone: () => void,
) => { close(): void };

export interface StateStreamTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: StateStreamTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** the door every screen follows; the whole Inbox and Work picture rides the one stream */
export const STATE_STREAM_PATH = "/api/idd/events";

/** how long the stream waits before trying a broken connection again */
export const STATE_RECONNECT_MS = 1_000;

export class StateStream {
  private handle: { close(): void } | null = null;
  private retry: unknown = null;
  private lastSeq: number | null = null;
  private onDelivery: ((delivery: StateDelivery) => void) | null = null;
  private running = false;
  private live = false;

  constructor(
    private readonly open: StateFrameOpen,
    private readonly retryMs: number = STATE_RECONNECT_MS,
    private readonly timers: StateStreamTimers = defaultTimers,
    private readonly path: string = STATE_STREAM_PATH,
  ) {}

  /** start following; the returned function stops it and its retry loop */
  start(onDelivery: (delivery: StateDelivery) => void): () => void {
    if (this.running) return () => this.stop();
    this.running = true;
    this.onDelivery = onDelivery;
    this.openNow();
    return () => this.stop();
  }

  stop(): void {
    this.running = false;
    this.onDelivery = null;
    this.live = false;
    if (this.retry !== null) {
      this.timers.clear(this.retry);
      this.retry = null;
    }
    this.handle?.close();
    this.handle = null;
  }

  /** whether a connection is open right now (a cut is not: the retry is what brings it back) */
  get connected(): boolean {
    return this.live;
  }

  /** the number the next connection resumes from */
  get lastEventId(): number | null {
    return this.lastSeq;
  }

  /**
   * A tab that comes back, or a network that does: try now rather than at the retry's own hour. A connection that is
   * already open is left alone — the engine keeps it open in the background too, so nothing was missed.
   */
  reconnectIfGone(): void {
    if (!this.running || this.live) return;
    if (this.retry !== null) {
      this.timers.clear(this.retry);
      this.retry = null;
    }
    this.openNow();
  }

  private openNow(): void {
    if (!this.running) return;
    this.handle?.close();
    this.handle = this.open(
      this.path,
      this.lastSeq,
      (frame) => {
        if (!this.running) return;
        // the first frame of a connection is the whole picture: it is taken as it stands, not compared with the
        // numbers the screen held before the break (the engine replaced may have numbered its own answers)
        const resync = !this.live;
        this.live = true;
        if (typeof frame?.seq === "number") this.lastSeq = frame.seq;
        this.onDelivery?.({ frame, resync });
      },
      () => {
        // the connection ended or was refused (a replacement refuses everything while it is on its way): try again
        this.live = false;
        this.handle = null;
        this.schedule();
      },
    );
  }

  private schedule(): void {
    if (!this.running || this.retry !== null) return;
    this.retry = this.timers.set(() => {
      this.retry = null;
      this.openNow();
    }, this.retryMs);
  }
}

/** the open the browser uses: the shared reader, narrowed to the state door's frames */
export const browserStateStream: StateFrameOpen = (path, lastEventId, onFrame, onGone) =>
  openSse(path, lastEventId, (frame) => {
    if (!frame.data) return;
    try {
      onFrame(JSON.parse(frame.data) as StateFrameView);
    } catch {
      // a frame the parse cannot read (a ping, a half-written line) is not a picture to show
    }
  }, onGone);
