import { NextResponse } from "next/server";
import { join } from "node:path";

import { readAllLanes } from "@/lib/idd/ledger-io";

export const dynamic = "force-dynamic";

// intent: DEC-005 — MSYNC_ROOT は Meltly sync-tools のルート (~/dev/00_meltly/sync-tools)、その配下 state/ が ledger の場所
function resolveStateDir(): { ok: true; dir: string } | { ok: false; error: string } {
  const root = process.env.MSYNC_ROOT?.trim();
  if (!root) {
    return {
      ok: false,
      error: "MSYNC_ROOT env var is unset — point it at your sync-tools directory (e.g. ~/dev/00_meltly/sync-tools)",
    };
  }
  return { ok: true, dir: join(root, "state") };
}

export async function GET(req: Request) {
  const state = resolveStateDir();
  if (!state.ok) {
    return NextResponse.json(
      { error: state.error, lanes: [] },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const includeRetired = new URL(req.url).searchParams.get("includeRetired") === "1";
    const lanes = await readAllLanes(state.dir, { includeRetired });
    return NextResponse.json(
      { lanes, stateDir: state.dir, includeRetired },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error), lanes: [] },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
