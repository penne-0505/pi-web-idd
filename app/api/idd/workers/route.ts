// intent: DEC-007 — worker pool の read 用 GET endpoint、UI dashboard の worker pool 表示に使う

import { NextResponse } from "next/server";

import { getWorkerPool } from "@/lib/idd/worker-pool";

export const dynamic = "force-dynamic";

export async function GET() {
  const pool = getWorkerPool();
  const workers = pool.list();
  return NextResponse.json(
    { workers, count: workers.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}
