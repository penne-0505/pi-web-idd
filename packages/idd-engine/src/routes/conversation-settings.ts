import { json } from "../http.ts";
import { openConversations } from "../server/conversations.ts";
import {
  conversationSettingsPath, enabledSkillPaths, listedSkillCandidates, newSkillsOutsideCandidates, readConversationSettings, skillCandidates,
  writeConversationSettings, type ConversationSettings, type SkillCandidate,
} from "../server/conversation-settings.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

async function body(req: Request): Promise<Record<string, unknown>> {
  const parsed = await req.json().catch(() => ({}));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/** a candidate as the screen sees it: where it is, what it says, where it came from, and whether it is on */
function candidateView(candidate: SkillCandidate, settings: ConversationSettings): SkillCandidate & { enabled: boolean } {
  return { ...candidate, enabled: settings.skills.includes(candidate.path) };
}

/** the conversations whose pi is running now and therefore still runs under the old settings */
function runningConversations(): string[] {
  return openConversations().filter((c) => !c.isClosed && !c.isEphemeral && c.isPiRunning).map((c) => c.sessionId);
}

function candidatesFor(cwd: string | undefined) {
  return cwd ? skillCandidates(cwd) : listedSkillCandidates();
}

function view(settings: ConversationSettings, cwd: string | undefined) {
  return {
    settings: { skills: settings.skills, webSearch: settings.webSearch, webSearchTools: settings.webSearchTools, mcp: settings.mcp },
    candidates: candidatesFor(cwd).map((candidate) => candidateView(candidate, settings)),
    path: conversationSettingsPath(),
  };
}

/** GET /api/conversation-settings — the current values and the skills a conversation may turn on */
export function GET(req: Request): Response {
  try {
    const url = new URL(req.url);
    const cwd = url.searchParams.get("cwd")?.trim() || undefined;
    return json({ ok: true, ...view(readConversationSettings(), cwd) }, { headers: NO_STORE });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 500, headers: NO_STORE });
  }
}

/**
 * PATCH /api/conversation-settings — turn skills / web search / MCP on or off. Only a skill that this change
 * newly turns on has to be a candidate right now, so the door cannot be used to point pi at an arbitrary
 * directory while still allowing a change from one cwd to keep another cwd's skills on. The response names the
 * conversations whose running pi still uses the old values.
 */
export async function PATCH(req: Request): Promise<Response> {
  try {
    const b = await body(req);
    const cwd = typeof b.cwd === "string" && b.cwd.trim() ? b.cwd.trim() : undefined;
    const current = readConversationSettings();
    const next: ConversationSettings = { ...current };

    if (b.skills !== undefined) {
      if (!Array.isArray(b.skills) || b.skills.some((s) => typeof s !== "string")) {
        return json({ ok: false, error: "skills は path の配列にしてください" }, { status: 400, headers: NO_STORE });
      }
      // only the paths this change newly turns on are checked against the cwd's candidates; a skill that is
      // already on stays on without being a candidate for this cwd (C-174-2)
      const requested = (b.skills as string[]).map((s) => s.trim()).filter(Boolean);
      const outside = newSkillsOutsideCandidates(requested, current, cwd);
      if (outside.length) {
        return json({ ok: false, error: `候補に無い skill は ON にできません: ${outside[0]}` }, { status: 400, headers: NO_STORE });
      }
      next.skills = requested;
    }
    if (b.webSearch !== undefined) {
      if (typeof b.webSearch !== "boolean") return json({ ok: false, error: "webSearch は真偽値にしてください" }, { status: 400, headers: NO_STORE });
      next.webSearch = b.webSearch;
    }
    if (b.mcp !== undefined) {
      if (typeof b.mcp !== "boolean") return json({ ok: false, error: "mcp は真偽値にしてください" }, { status: 400, headers: NO_STORE });
      next.mcp = b.mcp;
    }

    writeConversationSettings(next);
    // the skills that survive the candidate check for a cwd are what a conversation there would get
    return json({ ok: true, ...view(next, cwd), running: runningConversations(), effectiveSkills: cwd ? enabledSkillPaths(next, cwd) : [] }, { headers: NO_STORE });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 500, headers: NO_STORE });
  }
}
