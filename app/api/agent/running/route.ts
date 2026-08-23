import { NextResponse } from "next/server";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// intent: DEC-529 — SSE 併用の polling snapshot（visible tab の即取得用）
export async function GET() {
  return NextResponse.json(
    { runningSessionIds: getRunningRpcSessionIds() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
