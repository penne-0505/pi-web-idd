// intent: DEC-692 — push と PR 作成の口。人間が「このまま出す」を押したときだけ通る

import { NextResponse } from "next/server";
import { buildSubmit, lanesAwaitingShip, runShip, startSubmit } from "@idd/core";

export async function GET() {
  const waiting = lanesAwaitingShip().map((rec) => buildSubmit(rec.idd_id)).filter(Boolean);
  return NextResponse.json({ waiting });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const iddId = String(body.idd_id ?? body.iddId ?? "");
    if (!iddId) return NextResponse.json({ ok: false, error: "idd_id が空" }, { status: 400 });
    if (body.dryRun) {
      const view = await startSubmit(iddId);
      return NextResponse.json({ ok: Boolean(view), view });
    }
    const result = await runShip(iddId);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
