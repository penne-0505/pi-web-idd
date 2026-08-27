// intent: DEC-655 — 取り込みは判断ではないので、押下 = ledger 1 append の規約 (INV-003) の外側にある
// intent: DEC-657 — cron と UI の「今すぐ取り込む」は同じ engine の入口を叩く

import { NextResponse } from "next/server";
import { runIntake } from "@idd/core";

export async function POST() {
  try {
    const result = await runIntake();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
