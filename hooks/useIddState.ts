"use client";

// intent: 拡張 IDD の state を 1 本の endpoint から取る。state file がまだ無い環境では
// fixture に落として UI を動かし続ける (どちらで動いているかは source で判別できる)。

import { useCallback, useEffect, useState } from "react";
import { MOCK_CRON, MOCK_INBOX, MOCK_LANES, MOCK_SECTIONS } from "@/lib/idd-ui/fixtures";
import type { CronRun, InboxItem, LaneRow, LaneSection } from "@/lib/idd-ui/types";

/* ── mock 表示の切替 ──────────────────────────────────────────
   state file が薄いうちは fixture で見たい。localStorage に持ち、
   同じ page 内の複数 hook (sidebar と Inbox) が同時に切り替わるようにする。 */

const MOCK_KEY = "idd-mock-view";
const listeners = new Set<() => void>();

export function isIddMock(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(MOCK_KEY) === "1"; } catch { return false; }
}

export function setIddMock(on: boolean) {
  try { window.localStorage.setItem(MOCK_KEY, on ? "1" : "0"); } catch { /* 保存できなくても切替は効かせる */ }
  listeners.forEach((fn) => fn());
}

export interface IddStateView {
  source: "state" | "empty" | "mock" | "loading";
  cron: CronRun;
  sections: LaneSection[];
  lanes: LaneRow[];
  items: InboxItem[];
  refresh: () => void;
}

const MOCK: Omit<IddStateView, "refresh" | "source"> = {
  cron: MOCK_CRON,
  sections: MOCK_SECTIONS,
  lanes: MOCK_LANES,
  items: MOCK_INBOX,
};

export function useIddState(pollMs = 15000): IddStateView {
  const [state, setState] = useState<Omit<IddStateView, "refresh">>({ source: "loading", ...MOCK });
  const [mock, setMock] = useState(false);

  useEffect(() => {
    setMock(isIddMock());
    const fn = () => setMock(isIddMock());
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const load = useCallback(async () => {
    if (isIddMock()) {
      setState({ source: "mock", ...MOCK });
      return;
    }
    try {
      const res = await fetch("/api/idd/state", { cache: "no-store" });
      const data = await res.json();
      if (data?.source === "state") {
        setState({
          source: "state",
          cron: data.cron ?? MOCK_CRON,
          sections: data.sections ?? [],
          lanes: data.lanes ?? [],
          items: data.items ?? [],
        });
      } else {
        // state file がまだ無い。fixture で動かす
        setState({ source: "mock", ...MOCK });
      }
    } catch {
      setState({ source: "mock", ...MOCK });
    }
  }, []);

  useEffect(() => {
    void load();
    if (!pollMs || mock) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs, mock]);

  return { ...state, refresh: load };
}
