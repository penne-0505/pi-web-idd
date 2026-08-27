// intent: DEC-688 — 衝突確認の起動口。判断そのものは Inbox の差分確認 card で行う

import { NextResponse } from "next/server";
import { lanesAwaitingCheck, runCheck } from "@idd/core";

export async function GET() {
  return NextResponse.json({ waiting: lanesAwaitingCheck().map((r) => ({ iddId: r.idd_id, title: r.title })) });
}

export async function POST() {
  try {
    return NextResponse.json({ ok: true, results: await runCheck() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
