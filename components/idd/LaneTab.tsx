"use client";

// intent: lane タブ 1 枚。API から取り、まだ state file が無い環境では fixture に落ちる。

import { useEffect, useState } from "react";
import { MOCK_LANE_DETAIL } from "@/lib/idd-ui/fixtures";
import type { LaneDetailView } from "@/lib/idd-ui/types";
import { LaneDetail, LaneDetailPlaceholder } from "./LaneDetail";
import type { DecideHandler } from "./cards";

export function LaneTab({ iddId, onDecide }: { iddId: string; onDecide: DecideHandler }) {
  const [lane, setLane] = useState<LaneDetailView | null>(MOCK_LANE_DETAIL[iddId] ?? null);

  useEffect(() => {
    let cancelled = false;
    setLane(MOCK_LANE_DETAIL[iddId] ?? null);
    (async () => {
      try {
        const res = await fetch(`/api/idd/lane/${encodeURIComponent(iddId)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.iddId) setLane(data as LaneDetailView);
      } catch {
        // state file が無い間は fixture のまま
      }
    })();
    return () => { cancelled = true; };
  }, [iddId]);

  if (!lane) return <LaneDetailPlaceholder iddId={iddId} />;
  return <LaneDetail lane={lane} onDecide={onDecide} />;
}
