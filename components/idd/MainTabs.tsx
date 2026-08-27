"use client";

// intent: DEC-633 — 既存 shell への追加点その 1: main に何を出すかのタブ帯
// intent: DEC-639 — fixture 表示の切替を UI に持つ

import { FS } from "@/lib/idd-ui/scale";
import { isIddMock, setIddMock } from "@/hooks/useIddState";
import { useEffect, useState } from "react";

export type MainView = string;

export function laneView(iddId: string): MainView {
  return `lane:${iddId}`;
}

export function laneIdOf(view: MainView): string | null {
  return view.startsWith("lane:") ? view.slice(5) : null;
}

function MockToggle() {
  const [on, setOn] = useState(false);
  useEffect(() => { setOn(isIddMock()); }, []);
  return (
    <button
      onClick={() => { const next = !on; setOn(next); setIddMock(next); }}
      title={on ? "fixture を表示している (押すと実 state に戻る)" : "実 state を表示している (押すと fixture)"}
      style={{
        alignSelf: "center", marginRight: 10, marginLeft: 8,
        display: "inline-flex", alignItems: "center", gap: 6,
        height: 26, padding: "0 10px", borderRadius: 4,
        background: on ? "var(--accent)" : "var(--bg)",
        border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
        color: on ? "#fff" : "var(--text-muted)",
        fontSize: FS.xs, fontWeight: on ? 600 : 400, cursor: "pointer", flexShrink: 0,
      }}
    >
      mock
    </button>
  );
}

export function MainTabs({ active, inboxCount, laneTabs, onSelect, onCloseLane }: {
  active: MainView;
  inboxCount: number;
  laneTabs: { id: string; label: string }[];
  onSelect: (v: MainView) => void;
  onCloseLane: (iddId: string) => void;
}) {
  const tabStyle = (on: boolean): React.CSSProperties => ({
    display: "inline-flex", alignItems: "center", gap: 6,
    height: 36, padding: "0 10px 0 14px",
    background: on ? "var(--bg)" : "var(--bg-panel)",
    border: "none",
    borderRight: "1px solid var(--border)",
    borderBottom: on ? "none" : "1px solid var(--border)",
    color: on ? "var(--text)" : "var(--text-muted)",
    fontSize: FS.md, fontWeight: on ? 600 : 400,
    cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
  });

  return (
    <div
      style={{
        display: "flex", alignItems: "flex-end", flexShrink: 0,
        height: 36, background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        overflowX: "auto",
      }}
    >
      <button onClick={() => onSelect("inbox")} style={{ ...tabStyle(active === "inbox"), paddingRight: 14 }}>
        Inbox
        {inboxCount ? (
          <span
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              minWidth: 16, padding: "1px 5px", borderRadius: 3,
              background: "var(--accent)", color: "#fff", fontSize: FS.xs, fontWeight: 600,
            }}
          >
            {inboxCount}
          </span>
        ) : null}
      </button>

      <button onClick={() => onSelect("chat")} style={{ ...tabStyle(active === "chat"), paddingRight: 14 }}>
        Chat
      </button>

      {laneTabs.map((t) => {
        const view = laneView(t.id);
        const on = active === view;
        return (
          <div key={t.id} style={tabStyle(on)}>
            <button
              onClick={() => onSelect(view)}
              style={{ background: "none", border: "none", padding: 0, color: "inherit", font: "inherit", cursor: "pointer" }}
            >
              {t.label}
            </button>
            <button
              onClick={() => onCloseLane(t.id)}
              title={`${t.label} を閉じる`}
              aria-label={`${t.label} を閉じる`}
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 18, height: 18, padding: 0, borderRadius: 3,
                background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer",
              }}
            >
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}

      <span style={{ flex: 1, borderBottom: "1px solid var(--border)", alignSelf: "stretch" }} />
      <MockToggle />
    </div>
  );
}
