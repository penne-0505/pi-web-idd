// intent: DEC-697 — merge の観測口。merge 自体はここでは行わない

import { NextResponse } from "next/server";
import { lanesAwaitingMerge, runClose } from "@idd/core";

export async function GET() {
  return NextResponse.json({
    waiting: lanesAwaitingMerge().map((x) => ({ iddId: x.rec.idd_id, prUrl: x.prUrl })),
  });
}

export async function POST() {
  try {
    return NextResponse.json({ ok: true, results: await runClose() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
