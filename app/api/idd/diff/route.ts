// intent: DEC-703 — 差分は 1 ファイルずつ取りに来る。card 側が何ファイル目かを決める

import { NextResponse } from "next/server";
import { laneBase, laneDiff, readSessions } from "@idd/core";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const iddId = url.searchParams.get("idd") ?? "";
  const index = Number(url.searchParams.get("index") ?? 1);
  const session = readSessions("executor").filter((r) => r.idd_id === iddId).pop()
    ?? readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  if (!session?.worktree_path) return NextResponse.json({ error: "worktree なし" }, { status: 404 });
  const base = laneBase(session.worktree_path);
  if (!base) return NextResponse.json({ error: "基準が取れません" }, { status: 404 });
  const diff = laneDiff(session.worktree_path, base, { index });
  return NextResponse.json(diff ?? { error: "差分なし" }, { status: diff ? 200 : 404 });
}
