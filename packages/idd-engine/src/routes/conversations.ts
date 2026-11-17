
import { json } from "../http.ts";
import { validateAgentImages } from "../../../../lib/image-attachments.ts";
import {
  ConversationRefused, conversationMarksWorkspace, createConversation, createEphemeralFork, listConversations, openConversation,
  promoteConversationById, removeConversationById, type Conversation, type PiImage,
} from "../server/conversations.ts";
import { setSessionMark, type SessionMarkPatch } from "../server/marks.ts";
import { hasSpace } from "../server/spaces.ts";
import { buildState } from "../server/state.ts";
import { buildMentionBlock, parseMentions } from "../server/mentions.ts";
import type { ConversationEvent } from "../server/conversation-events.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** the pi commands this bridging door lets through; everything else is refused (DEC-1803) */
export const ALLOWED_PI_COMMANDS: readonly string[] = Object.freeze([
  "compact", "fork", "set_session_name", "get_session_stats", "get_last_assistant_text", "get_commands", "get_fork_messages",
]);

/** the operations that have a dedicated door of their own: this door never carries them */
const CORE_OPERATIONS = new Set(["prompt", "steer", "follow_up", "abort", "set_model", "set_thinking_level", "clear_queue"]);

function parseImages(value: unknown): PiImage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const images: PiImage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const image = entry as { data?: unknown; mimeType?: unknown };
    if (typeof image.data !== "string" || typeof image.mimeType !== "string") continue;
    images.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return images.length ? images : undefined;
}

/**
 * The body's `images`, checked before `parseImages` may drop a broken item (DEC-118-6). `undefined` and `null`
 * mean there is nothing to check; anything else has to be an array of images in the shape the doors accept.
 * The new screen sends `{ data, mimeType }` where pi wants `type: "image"`, so only a missing `type` is filled
 * in; a broken `data` or `mimeType` is refused, never repaired.
 */
function imageFieldError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return "images must be an array";
  const normalized = value.map((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry) && (entry as { type?: unknown }).type === undefined
      ? { ...(entry as Record<string, unknown>), type: "image" }
      : entry
  ));
  return validateAgentImages(normalized);
}

/** the 400 the image check owes, or null when the body passed it */
function refusedImages(value: unknown): Response | null {
  const error = imageFieldError(value);
  return error ? json({ ok: false, error }, { status: 400, headers: NO_STORE }) : null;
}

function failure(err: unknown): Response {
  if (err instanceof ConversationRefused) return json({ ok: false, error: err.message, ...err.body }, { status: err.status, headers: NO_STORE });
  return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 500, headers: NO_STORE });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const parsed = await req.json().catch(() => ({}));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

async function withConversation(id: string, fn: (conv: Conversation) => Promise<Response> | Response): Promise<Response> {
  try {
    const conv = await openConversation(id);
    return await fn(conv);
  } catch (err) {
    return failure(err);
  }
}

/** POST /api/conversations — create a conversation for a mode */
export async function CREATE(req: Request): Promise<Response> {
  try {
    const b = await body(req);
    const mode = typeof b.mode === "string" ? b.mode.trim() : "";
    if (!mode) return json({ ok: false, error: "mode が必要です" }, { status: 400, headers: NO_STORE });
    const workdir = typeof b.workdir === "string" ? b.workdir : undefined;
    const space = typeof b.space === "string" && b.space.trim() ? b.space.trim() : undefined;
    const type = typeof b.type === "string" && b.type.trim() ? b.type.trim() : undefined;
    const conv = await createConversation(mode, {
      ...(workdir !== undefined ? { workdir } : {}),
      ...(space !== undefined ? { space } : {}),
      ...(type !== undefined ? { type } : {}),
    });
    return json({
      ok: true,
      id: conv.sessionId,
      mode: conv.mode.name,
      cwd: conv.cwd,
      workspace: conv.mode.workspace,
      workdir: conv.workdir,
      ...(conv.spaceId() ? { space: conv.spaceId() } : {}),
      ...(conv.wantType ? { type: conv.wantType } : {}),
      model: conv.modelString() ?? conv.role.model,
      effort: conv.effortString() ?? conv.role.thinking,
    }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

/** GET /api/conversations — pi's own records, without starting pi; sorting / grouping ride in the query */
export async function LIST(req: Request): Promise<Response> {
  try {
    const params = new URL(req.url).searchParams;
    const result = await listConversations({
      ...(params.has("sort") ? { sort: params.get("sort") as string } : {}),
      ...(params.has("direction") ? { direction: params.get("direction") as string } : {}),
      ...(params.has("group") ? { group: params.get("group") as string } : {}),
      ...(params.has("archive") ? { archive: params.get("archive") as string } : {}),
      ...(params.has("mode") ? { mode: params.get("mode") as string } : {}),
      ...(params.has("space") ? { space: params.get("space") as string } : {}),
    });
    return json(result, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

/** GET /api/conversations/:id — the history as pi's entries, plus the live state */
export function OPEN(_req: Request, params: Record<string, string>): Promise<Response> {
  return withConversation(params.id, async (conv) => {
    const state = await conv.openState();
    return json({ ok: true, ...state }, { headers: NO_STORE });
  });
}

/** GET /api/conversations/:id/events — the numbered SSE stream */
export function EVENTS(req: Request, params: Record<string, string>): Promise<Response> {
  return (async () => {
    let conv: Conversation;
    try {
      conv = await openConversation(params.id);
    } catch (err) {
      return failure(err);
    }
    const url = new URL(req.url);
    const headerId = req.headers.get("last-event-id");
    const lastId = Number(headerId ?? url.searchParams.get("lastEventId") ?? "0") || 0;
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let unwatch: (() => void) | null = null;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      unwatch?.();
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (chunk: string) => {
          if (done) return;
          try { controller.enqueue(encoder.encode(chunk)); } catch { /* the client went away */ }
        };
        // every frame carries the event's own number as its SSE id, the same value the `lastEventId` query
        // takes, so a browser's automatic reconnect (which sends the last id as `Last-Event-ID`) resumes
        // exactly where a query-based client does
        const frame = (id: number, event: ConversationEvent | { type: "reset"; reason?: string }) => {
          write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        const { reset, events } = conv.log.since(lastId);
        if (reset) {
          // the gap cannot be filled: ask the client to reopen instead of showing a broken stream. The id is
          // the number the log holds now, so a browser does not reconnect forever with a stale one.
          frame(conv.log.lastSeq, { type: "reset", reason: "the engine no longer holds the events after this id" });
        } else {
          for (const event of events) frame(event.seq, event);
        }
        // after the replayed frames, hand the client the number it now holds: an `id:`-only frame updates
        // EventSource's Last-Event-ID and fires no event, so a connection that drops before the first live
        // event still reconnects without a gap. It comes after the replay so it never skips an unread event.
        write(`id: ${conv.log.lastSeq}\n\n`);
        unsubscribe = conv.log.subscribe((event) => frame(event.seq, event));
        heartbeat = setInterval(() => {
          if (done) return;
          try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { cleanup(); }
        }, 15_000);
        heartbeat.unref?.();
        unwatch = conv.watchClose(() => {
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        });
        req.signal?.addEventListener("abort", () => {
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
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
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  })();
}

/** POST /api/conversations/:id/messages — queue a message and feed it when nothing is running */
export function SEND(req: Request, params: Record<string, string>): Promise<Response> {
  return (async () => {
    const b = await body(req);
    const refused = refusedImages(b.images);
    if (refused) return refused;
    const parsedMentions = parseMentions(b.mentions);
    if (parsedMentions.error) return json({ ok: false, error: parsedMentions.error }, { status: 400, headers: NO_STORE });
    let text = typeof b.text === "string" ? b.text : "";
    // the mention block is built from the engine's own state, before the conversation is opened (C-167-4/5):
    // a lane or a card the state does not hold is refused here, so nothing is sent on a stale pick
    if (parsedMentions.refs.length) {
      try {
        const built = buildMentionBlock(parsedMentions.refs, buildState({}));
        if (built.error) return json({ ok: false, error: built.error }, { status: 400, headers: NO_STORE });
        text = text.trim() ? `${text}\n\n${built.block}` : built.block;
      } catch (err) {
        return failure(err);
      }
    }
    const images = parseImages(b.images);
    if (!text.trim() && !images) return json({ ok: false, error: "text か images が必要です" }, { status: 400, headers: NO_STORE });
    const model = typeof b.model === "string" && b.model ? b.model : undefined;
    const effort = typeof b.effort === "string" && b.effort ? b.effort : undefined;
    return withConversation(params.id, (conv) => {
      const item = conv.send(text, { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(images ? { images } : {}) });
      return json({ ok: true, item, streaming: conv.isStreaming, queue: conv.queueItems }, { headers: NO_STORE });
    });
  })();
}

/** POST /api/conversations/:id/steer — a separate door that goes to pi's steer */
export function STEER(req: Request, params: Record<string, string>): Promise<Response> {
  return (async () => {
    const b = await body(req);
    const refused = refusedImages(b.images);
    if (refused) return refused;
    const text = typeof b.text === "string" ? b.text : "";
    const images = parseImages(b.images);
    if (!text.trim() && !images) return json({ ok: false, error: "text か images が必要です" }, { status: 400, headers: NO_STORE });
    return withConversation(params.id, async (conv) => {
      await conv.steer(text, images);
      return json({ ok: true, streaming: conv.isStreaming }, { headers: NO_STORE });
    });
  })();
}

/**
 * POST /api/conversations/:id/command — the bridging door for the existing GUI: it hands one of the allowed
 * pi commands to this conversation's pi. New GUIs use the dedicated doors; this one goes away with the old
 * GUI (see `_docs/reference/pi-web-idd/idd-050/reference.md`).
 */
export function COMMAND(req: Request, params: Record<string, string>): Promise<Response> {
  return (async () => {
    const b = await body(req);
    const type = typeof b.type === "string" ? b.type : "";
    if (!type) return json({ ok: false, error: "type が必要です" }, { status: 400, headers: NO_STORE });
    if (CORE_OPERATIONS.has(type)) {
      return json({ ok: false, error: `${type} は専用の口を使ってください`, code: "core_operation" }, { status: 400, headers: NO_STORE });
    }
    if (!ALLOWED_PI_COMMANDS.includes(type)) {
      return json({ ok: false, error: `この口では ${type} を通せません`, code: "command_not_allowed" }, { status: 400, headers: NO_STORE });
    }
    const { type: _type, ...fields } = b;
    void _type;
    return withConversation(params.id, async (conv) => {
      const result = await conv.runCommand(type, fields);
      return json({ ok: true, data: result.data ?? null, ...(result.newSessionId ? { newSessionId: result.newSessionId } : {}) }, { headers: NO_STORE });
    });
  })();
}

/** POST /api/conversations/:id/stop — stop the run and leave the queue */
export function STOP(_req: Request, params: Record<string, string>): Promise<Response> {
  return withConversation(params.id, async (conv) => json({ ok: true, ...(await conv.stop()), queue: conv.queueItems }, { headers: NO_STORE }));
}

/** POST /api/conversations/:id/model — change the model / effort without sending */
export function MODEL(req: Request, params: Record<string, string>): Promise<Response> {
  return (async () => {
    const b = await body(req);
    const model = typeof b.model === "string" && b.model ? b.model : null;
    const effort = typeof b.effort === "string" && b.effort ? b.effort : null;
    return withConversation(params.id, async (conv) => {
      const applied = await conv.setModelEffort({ ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      return json({ ok: true, ...applied }, { headers: NO_STORE });
    });
  })();
}

/** PATCH /api/conversations/:id/queue/:itemId — edit an item before it is sent */
export function EDIT_QUEUE(req: Request, params: Record<string, string>): Promise<Response> {
  return (async () => {
    const b = await body(req);
    // `images: null` is the existing patch that takes the images off a queued item, so it is never checked
    if (b.images !== null) {
      const refused = refusedImages(b.images);
      if (refused) return refused;
    }
    return withConversation(params.id, (conv) => {
      const item = conv.editQueueItem(params.itemId, {
        ...(typeof b.text === "string" ? { text: b.text } : {}),
        ...(b.model === null ? { model: null } : typeof b.model === "string" ? { model: b.model } : {}),
        ...(b.effort === null ? { effort: null } : typeof b.effort === "string" ? { effort: b.effort } : {}),
        ...(b.images === null ? { images: null } : parseImages(b.images) ? { images: parseImages(b.images) as PiImage[] } : {}),
      });
      return json({ ok: true, item }, { headers: NO_STORE });
    });
  })();
}

/** DELETE /api/conversations/:id/queue/:itemId — take an item out before it is sent */
export function DELETE_QUEUE(_req: Request, params: Record<string, string>): Promise<Response> {
  return withConversation(params.id, (conv) => json({ ok: true, item: conv.cancelQueueItem(params.itemId) }, { headers: NO_STORE }));
}

/** POST /api/conversations/:id/queue/:itemId/steer — turn a queued item into a steering message */
export function STEER_QUEUE(_req: Request, params: Record<string, string>): Promise<Response> {
  return withConversation(params.id, async (conv) => json({ ok: true, item: await conv.steerQueueItem(params.itemId) }, { headers: NO_STORE }));
}

/** POST /api/conversations/:id/title — regenerate the name from the current branch's last turns */
export function TITLE(_req: Request, params: Record<string, string>): Promise<Response> {
  return withConversation(params.id, async (conv) => {
    const result = await conv.retitle();
    return json({ ok: true, ...result }, { headers: NO_STORE });
  });
}

/** GET /api/conversations/:id/context — pi's own context figures for this session */
export function CONTEXT(_req: Request, params: Record<string, string>): Promise<Response> {
  return withConversation(params.id, async (conv) => json({ ok: true, contextUsage: await conv.contextUsage() }, { headers: NO_STORE }));
}

/** GET /api/conversations/:id/models — the models this conversation's pi will accept (DEC-118-1) */
export function MODELS(_req: Request, params: Record<string, string>): Promise<Response> {
  return withConversation(params.id, async (conv) => {
    const result = await conv.modelCandidates();
    return json({ ok: true, models: result.models, current: result.current }, { headers: NO_STORE });
  });
}

/** POST /api/conversations/:id/type — change the type without respawning pi or starting a run */
export function TYPE(req: Request, params: Record<string, string>): Promise<Response> {
  return (async () => {
    const b = await body(req);
    const type = typeof b.type === "string" ? b.type.trim() : "";
    if (!type) return json({ ok: false, error: "type が必要です" }, { status: 400, headers: NO_STORE });
    return withConversation(params.id, async (conv) => {
      const result = await conv.setType(type);
      return json({ ok: true, ...result }, { headers: NO_STORE });
    });
  })();
}

/** POST /api/conversations/:id/close — stop pi; the session's record stays */
export function CLOSE(_req: Request, params: Record<string, string>): Promise<Response> {
  return withConversation(params.id, async (conv) => {
    await conv.close();
    return json({ ok: true }, { headers: NO_STORE });
  });
}

/** POST /api/conversations/:id/ephemeral — cut an ephemeral branch at an entry and start its pi */
export async function FORK(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const b = await body(req);
    const at = typeof b.at === "string" ? b.at.trim() : "";
    if (!at) return json({ ok: false, error: "at が必要です" }, { status: 400, headers: NO_STORE });
    const envelope = typeof b.envelope === "string" ? b.envelope : undefined;
    const role = typeof b.role === "string" && b.role.trim() ? b.role.trim() : undefined;
    const cwd = typeof b.cwd === "string" && b.cwd.trim() ? b.cwd.trim() : undefined;
    const tools = Array.isArray(b.tools) ? b.tools.filter((tool): tool is string => typeof tool === "string") : undefined;
    const result = await createEphemeralFork(params.id, {
      at,
      ...(envelope !== undefined ? { envelope } : {}),
      ...(role ? { role } : {}),
      ...(cwd ? { cwd } : {}),
      ...(tools ? { tools } : {}),
    });
    return json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

/** POST /api/conversations/:id/promote — raise an ephemeral branch into a mode's own session */
export function PROMOTE(req: Request, params: Record<string, string>): Promise<Response> {
  return (async () => {
    const b = await body(req);
    const mode = typeof b.mode === "string" && b.mode.trim() ? b.mode.trim() : undefined;
    try {
      const result = await promoteConversationById(params.id, { ...(mode ? { mode } : {}) });
      return json({ ok: true, ...result }, { headers: NO_STORE });
    } catch (err) {
      return failure(err);
    }
  })();
}

/** DELETE /api/conversations/:id — close and remove pi's record and spawn record */
export function REMOVE(_req: Request, params: Record<string, string>): Promise<Response> {
  return (async () => {
    try {
      await removeConversationById(params.id);
      return json({ ok: true }, { headers: NO_STORE });
    } catch (err) {
      return failure(err);
    }
  })();
}

/**
 * PATCH /api/conversations/:id/marks — change one session's pin / archive / bookmarks / space. It never
 * starts pi, so a session whose cwd is gone can still be marked.
 */
export async function MARKS(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const workspace = conversationMarksWorkspace(params.id);
    if (!workspace) throw new ConversationRefused("mode の session ではありません", 404);
    const b = await body(req);
    const patch: SessionMarkPatch = {};
    if (b.pinned === null) patch.pinned = null;
    else if (typeof b.pinned === "boolean") patch.pinned = b.pinned;
    if (b.archived === null) patch.archived = null;
    else if (typeof b.archived === "boolean") patch.archived = b.archived;
    if (b.bookmarks === null) patch.bookmarks = null;
    else if (Array.isArray(b.bookmarks)) patch.bookmarks = b.bookmarks.filter((entry): entry is string => typeof entry === "string");
    if (b.space === null) patch.space = null;
    else if (typeof b.space === "string") {
      if (!hasSpace(workspace, b.space)) throw new ConversationRefused(`スペースがありません: ${b.space}`, 400);
      patch.space = b.space;
    }
    // A session's instruction additions and exclusions are not changed here: this route is open to every agent on the
    // machine, and what the list says is what the agent is told. They change by a proposal the user signs on the Inbox.
    if (b.instructionAdd !== undefined || b.instructionExclude !== undefined) {
      throw new ConversationRefused("会話の方針の追加と除外は、この口では変えられません。`idd instruction session` で案を出し、Inbox の案の card で署名してください", 403);
    }
    const mark = setSessionMark(workspace, params.id, patch);
    return json({ ok: true, mark }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}
