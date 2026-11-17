/**
 * The conversation screen's stream opener: the shared SSE reader with this stream's own meaning given to a frame.
 * An `id:`-only frame carries no event but still moves the number the reconnect must resume from, and a data frame is
 * one of the engine's conversation events. The store takes any opener of this shape, so a test drives it without a
 * browser.
 */

import { openSse } from "../engine/sse";
import type { StreamEvent } from "./fold";
import type { EventStreamHandle, EventStreamOpen } from "./store";

/** the real opener: one loopback fetch, its body read as frames until it ends or the handle closes */
export const browserEventStream: EventStreamOpen = (
  path: string,
  lastEventId: number | null,
  onEvent: (event: StreamEvent) => void,
  onGone: () => void,
  onId?: (id: number) => void,
): EventStreamHandle =>
  openSse(
    path,
    lastEventId,
    (frame) => {
      if (frame.id !== null) onId?.(frame.id);
      if (!frame.data) return;
      try {
        onEvent(JSON.parse(frame.data) as StreamEvent);
      } catch {
        // a half-written frame the parse cannot read is not something to show
      }
    },
    onGone,
  );
