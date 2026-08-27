// intent: DEC-632 — lane detail の 3 primitive (契約 / 現物 / 経過) を 1 回で返す

import { NextResponse } from "next/server";
import { buildLaneDetail } from "@/lib/idd-ui/server/state";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const lane = buildLaneDetail(id);
    if (!lane) return NextResponse.json({ error: "not found", iddId: id }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json(lane, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error), iddId: id }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
