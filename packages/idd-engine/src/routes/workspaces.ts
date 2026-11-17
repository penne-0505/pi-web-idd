import { existsSync } from "node:fs";
import { join } from "node:path";

import { readModes, type SessionMode } from "@idd/lane";

import { json } from "../http.ts";
import {
  addBookmarkKind, bookmarkLabels, removeBookmarkKind, renameBookmarkKind,
} from "../server/marks.ts";
import { createSpace, listSpaces, readSpace, updateSpace, type MemoryHandling } from "../server/spaces.ts";
import { ConversationRefused } from "../server/refusal.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function failure(err: unknown): Response {
  if (err instanceof ConversationRefused) return json({ ok: false, error: err.message }, { status: err.status, headers: NO_STORE });
  return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 500, headers: NO_STORE });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const parsed = await req.json().catch(() => ({}));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/** the mode a workspace door names; the workspace comes from config, never from the caller */
function modeOrThrow(name: string): SessionMode {
  let modes: Record<string, SessionMode>;
  try {
    modes = readModes();
  } catch (err) {
    throw new ConversationRefused(String(err instanceof Error ? err.message : err), 400);
  }
  const mode = modes[name];
  if (!mode) throw new ConversationRefused(`config/modes.yaml に "${name}" がありません`, 404);
  return mode;
}

/** GET /api/conversations/workspaces — the configured workspaces, so the door has no session to open */
export function LIST(): Response {
  try {
    return json({ workspaces: Object.values(readModes()).map((mode) => ({ mode: mode.name, label: mode.label, workspace: mode.workspace })) }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

/** GET /api/conversations/workspaces/:mode — the dir and whether its norm documents are there */
export function GET(_req: Request, params: Record<string, string>): Response {
  try {
    const mode = modeOrThrow(params.mode);
    return json({
      ok: true,
      mode: mode.name,
      workspace: mode.workspace,
      hasAgents: existsSync(join(mode.workspace, "AGENTS.md")),
      hasClaude: existsSync(join(mode.workspace, "CLAUDE.md")),
    }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

/** GET /api/conversations/workspaces/:mode/spaces */
export function SPACES(_req: Request, params: Record<string, string>): Response {
  try {
    const mode = modeOrThrow(params.mode);
    return json({ ok: true, spaces: listSpaces(mode.workspace) }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

function spaceInput(b: Record<string, unknown>): { name?: string; memory?: MemoryHandling; references?: string[]; instruction?: string } {
  const input: { name?: string; memory?: MemoryHandling; references?: string[]; instruction?: string } = {};
  if (typeof b.name === "string") input.name = b.name;
  if (typeof b.memory === "string") input.memory = b.memory as MemoryHandling;
  if (Array.isArray(b.references)) input.references = b.references.filter((entry): entry is string => typeof entry === "string");
  if (typeof b.instruction === "string") input.instruction = b.instruction;
  return input;
}

/** POST /api/conversations/workspaces/:mode/spaces */
export async function SPACE_CREATE(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const mode = modeOrThrow(params.mode);
    const b = await body(req);
    const id = typeof b.id === "string" ? b.id : "";
    if (!id) return json({ ok: false, error: "id が必要です" }, { status: 400, headers: NO_STORE });
    const space = createSpace(mode.workspace, id, spaceInput(b));
    return json({ ok: true, space }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

/** GET /api/conversations/workspaces/:mode/spaces/:id — the definition, with the instruction */
export function SPACE_GET(_req: Request, params: Record<string, string>): Response {
  try {
    const mode = modeOrThrow(params.mode);
    const space = readSpace(mode.workspace, params.id);
    if (!space) throw new ConversationRefused(`スペースがありません: ${params.id}`, 404);
    return json({ ok: true, space }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

/** PATCH /api/conversations/workspaces/:mode/spaces/:id — replace only the fields sent */
export async function SPACE_PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const mode = modeOrThrow(params.mode);
    const b = await body(req);
    const space = updateSpace(mode.workspace, params.id, spaceInput(b));
    return json({ ok: true, space }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

/** GET /api/conversations/workspaces/:mode/bookmarks */
export function BOOKMARKS(_req: Request, params: Record<string, string>): Response {
  try {
    const mode = modeOrThrow(params.mode);
    return json({ ok: true, bookmarks: bookmarkLabels(mode.workspace) }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

/** POST /api/conversations/workspaces/:mode/bookmarks */
export async function BOOKMARK_CREATE(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const mode = modeOrThrow(params.mode);
    const b = await body(req);
    const id = typeof b.id === "string" ? b.id : "";
    if (!id) return json({ ok: false, error: "id が必要です" }, { status: 400, headers: NO_STORE });
    const kind = addBookmarkKind(mode.workspace, id, typeof b.label === "string" ? b.label : id);
    return json({ ok: true, bookmark: kind }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

/** PATCH /api/conversations/workspaces/:mode/bookmarks/:id — rename a kind */
export async function BOOKMARK_PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const mode = modeOrThrow(params.mode);
    const b = await body(req);
    const kind = renameBookmarkKind(mode.workspace, params.id, typeof b.label === "string" ? b.label : params.id);
    return json({ ok: true, bookmark: kind }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

/** DELETE /api/conversations/workspaces/:mode/bookmarks/:id — remove a kind and every mark that used it */
export function BOOKMARK_DELETE(_req: Request, params: Record<string, string>): Response {
  try {
    const mode = modeOrThrow(params.mode);
    removeBookmarkKind(mode.workspace, params.id);
    return json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}
