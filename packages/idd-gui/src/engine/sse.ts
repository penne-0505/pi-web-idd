/**
 * The screen's own stream reader: a `fetch` body parsed as SSE, rather than `EventSource`, because the client must
 * hold the number the engine hands it even on an `id:`-only frame (which fires no event on `EventSource`), and
 * reconnect with that number so the gap is replayed instead of dropped.
 *
 * One reader serves both streams the screen follows (a conversation's events and the engine's state): the frames are
 * cut the same way, and a caller gives the opener only what it makes of a frame. A test drives it with a fetch of its
 * own, so no browser is needed to see the frames being cut.
 */

/** one complete SSE frame: its `id:` (the number a reconnect resumes from), if it had one, and its data lines */
export interface SseFrame {
  id: number | null;
  data: string;
}

export interface SseHandle {
  close(): void;
}

export interface SseResponse {
  ok: boolean;
  body: ReadableStream<Uint8Array> | null;
}

export type SseFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; cache: string }) => Promise<SseResponse>;

/** where the reader starts: no number means "hand me everything from now on" */
export type SseLastId = number | null;

/**
 * Cut one complete frame (up to a blank line) into its id and data lines. An `id:` with nothing after it is no
 * number: a frame that only moves the number reads as an empty one, never as the number 0.
 */
export function readSseFrame(frame: string): SseFrame {
  let id: number | null = null;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) {
      const raw = line.slice(3).trim();
      const n = Number(raw);
      id = raw !== "" && Number.isFinite(n) ? n : null;
    } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return { id, data: data.join("\n") };
}

/** the real fetch, kept narrow so the reader never takes a body it cannot read as frames */
const defaultFetch: SseFetch = async (url, init) => {
  const res = await fetch(url, init as RequestInit);
  return { ok: res.ok, body: res.body };
};

/**
 * The real opener: one loopback fetch, its body read as frames until it ends or the handle closes. `onFrame` is
 * called for every frame (an `id:`-only frame included, so the caller can keep the number), and `onGone` once when
 * the connection ends or is refused, whichever happened.
 */
export function openSse(
  path: string,
  lastEventId: SseLastId,
  onFrame: (frame: SseFrame) => void,
  onGone: () => void,
  fetcher: SseFetch = defaultFetch,
): SseHandle {
  const controller = new AbortController();
  const url = lastEventId === null ? path : `${path}${path.includes("?") ? "&" : "?"}lastEventId=${lastEventId}`;
  let closed = false;
  void (async () => {
    try {
      const res = await fetcher(url, { signal: controller.signal, headers: { accept: "text/event-stream" }, cache: "no-store" });
      if (!res.ok || !res.body) {
        if (!closed) onGone();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf("\n\n");
        while (at >= 0) {
          const frame = readSseFrame(buffer.slice(0, at));
          buffer = buffer.slice(at + 2);
          if (frame.id !== null || frame.data) onFrame(frame);
          if (closed) return;
          at = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // a closed or refused connection is the gone callback's business
    }
    if (!closed) onGone();
  })();
  return {
    close() {
      closed = true;
      controller.abort();
    },
  };
}
