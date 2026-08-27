// intent: 拡張 IDD の UI が 1 回で必要とするものをまとめて返す。
// state file が無い環境では source: "empty" を返し、UI 側が mock に落ちる。

import { NextResponse } from "next/server";
import { buildState } from "@/lib/idd-ui/server/state";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(buildState(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { source: "empty", error: String(error), cron: null, sections: [], lanes: [], items: [] },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
