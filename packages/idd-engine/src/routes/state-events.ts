import { currentStateFrame, subscribeStateFrames } from "../server/state-events";
import type { StateFrameView } from "../server/state-events";

/** how often a stream sends a line that keeps the connection from being read as dead */
const PING_MS = 15_000;

/**
 * GET /api/idd/events — the state and Work pictures as they move.
 *
 * A screen connects once and is handed the whole picture at once, then only what changes after it. The number a
 * screen carries (`Last-Event-ID`, or `lastEventId` for a client that reads the body itself) is not used to decide
 * what to send: the picture can always be overwritten with the current values, so a screen whose engine was
 * replaced is handed the picture as it stands instead of the difference it asked for — the difference no longer
 * exists in that process, and sending nothing would leave the screen showing the state before the replacement.
 *
 * The answer's content type is `text/event-stream`: the replacement judgment does not count such a response, so a
 * screen holding this stream open never keeps the engine's own replacement from coming (P-8).
 */
export function EVENTS(req: Request): Promise<Response> {
  return (async () => {
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (chunk: string): void => {
          if (done) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            cleanup();
          }
        };
        const frame = (next: StateFrameView): void => {
          write(`id: ${next.seq}\ndata: ${JSON.stringify(next)}\n\n`);
        };
        // subscribe before the first picture is built: a change that lands while it is being built is sent rather
        // than quietly missed (a picture built after it already contains it, and the screen applies both)
        unsubscribe = subscribeStateFrames((next) => frame(next));
        void currentStateFrame().then(frame, (error) => {
          write(`data: ${JSON.stringify({ type: "error", error: String(error) })}\n\n`);
        });
        heartbeat = setInterval(() => {
          if (done) return;
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            cleanup();
          }
        }, PING_MS);
        (heartbeat as { unref?: () => void }).unref?.();
        req.signal?.addEventListener("abort", () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  })();
}
