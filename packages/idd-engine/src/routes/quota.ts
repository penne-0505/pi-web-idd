import { json } from "../http.ts";
import { claudeQuotaView } from "../server/claude-view.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/quota — the providers whose quota this engine can read. Claude's windows come from the last
 * observation a Claude Code lane recorded, with the time it was observed; a provider with no reading door
 * is not listed. Nothing here talks to the network.
 */
export function GET(): Response {
  try {
    const claude = claudeQuotaView();
    const providers = claude ? [{ provider: "claude", ...claude }] : [];
    return json({ ok: true, providers }, { headers: NO_STORE });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, { status: 500, headers: NO_STORE });
  }
}
