"use client";

// intent: lane を掘る面。primitive は 契約 (何をやると決めたか) / 現物 (いまどうなっているか) / 経過。
// 進捗を別に持たない — 進捗とは「契約のどこまで満たしたか」でしかない。

import { useState } from "react";
import type { LaneDetailView } from "@/lib/idd-ui/types";
import { ActionButton, Chip, Icon, IconButton, LiveDot, RefChip } from "./primitives";
import { IdList, SectionHead } from "./LaneDetailParts";
import type { DecideHandler } from "./cards";
import { FS, SIZE } from "@/lib/idd-ui/scale";

export function LaneDetail({ lane, onDecide, onOpenIntent, onOpenWorktree, onSpeak }: {
  lane: LaneDetailView;
  onDecide: DecideHandler;
  onOpenIntent?: () => void;
  onOpenWorktree?: () => void;
  onSpeak?: (message: string) => void;
}) {
  const [message, setMessage] = useState("");

  return (
    <div className="idd" style={{ height: "100%", overflowY: "auto", background: "var(--bg)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 28, padding: 24, width: "100%", maxWidth: SIZE.readWidth, margin: "0 auto", boxSizing: "border-box" }}>

        {/* 識別 + lane 単位の操作 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Chip label={lane.phaseLabel} strong />
            {lane.priorityTop ? <Chip label="最優先" /> : null}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{lane.iddId}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1, fontSize: FS.xl, fontWeight: 600, color: "var(--text)" }}>{lane.title}</span>
            {lane.source ? <RefChip source={lane.source} /> : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{lane.branch}</span>
            <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>・</span>
            <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{lane.area}</span>
            <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>・</span>
            <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{lane.since}</span>
            <span style={{ flex: 1 }} />
            <ActionButton
              icon="up"
              label={lane.priorityTop ? "最優先を解除" : "最優先にする"}
              variant="quiet"
              onClick={() => onDecide(lane.priorityTop ? "priority_reset" : "priority_elevated", { iddId: lane.iddId })}
            />
            <ActionButton icon="abort" label="中止" variant="quiet" onClick={() => onDecide("lane_abort", { iddId: lane.iddId })} />
          </div>
        </div>

        {/* 契約 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <IdList
            label="やること (方針)"
            right={<button onClick={onOpenIntent} className="idd-link" style={{ background: "none", border: "none", padding: 0, fontSize: FS.xs, color: "var(--text-dim)", cursor: "pointer" }}>intent を全文で開く ↗</button>}
            items={lane.contract.decisions}
          />
          <IdList
            label="満たすべき条件"
            right={<span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>
              {lane.contract.criteria.filter((c) => c.state === "done").length} / {lane.contract.criteria.length} 確認済み
            </span>}
            items={lane.contract.criteria}
          />
          {lane.contract.invariants?.length ? (
            <IdList label="壊してはいけないもの" items={lane.contract.invariants} />
          ) : null}
        </div>

        {/* 現物 — 実装中なら触っているファイルと stream、GO 待ちなら下調べで見たもの */}
        {lane.work ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <SectionHead
              label="いま書かれているもの"
              icon={<LiveDot />}
              right={<button onClick={onOpenWorktree} className="idd-link" style={{ background: "none", border: "none", padding: 0, fontSize: FS.xs, color: "var(--text-dim)", cursor: "pointer" }}>worktree を開く ↗</button>}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {lane.work.files.map((f) => (
                <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 8px" }}>
                  <span style={{ flex: 1, fontSize: FS.sm, color: "var(--text)" }}>{f.path}</span>
                  <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{f.delta}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", padding: "8px 10px", borderRadius: 5, background: "var(--bg-panel)", border: "1px solid var(--border)" }}>
              {lane.work.stream.map((s, i) => (
                <div key={`${s.time}-${i}`} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "3px 0" }}>
                  <span style={{ width: 34, flexShrink: 0, fontSize: FS.xs, color: "var(--text-dim)" }}>{s.time}</span>
                  <span style={{ width: 28, flexShrink: 0, fontSize: FS.xs, fontWeight: 600, color: s.live ? "var(--text)" : "var(--text-muted)" }}>{s.kind}</span>
                  <span style={{ flex: 1, fontSize: FS.xs, fontWeight: s.live ? 600 : 400, color: s.live ? "var(--text)" : "var(--text-dim)" }}>{s.body}</span>
                </div>
              ))}
              {/* turn 境界で届く。envelope と同じ経路なので設計と矛盾しない */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="次の turn で伝える"
                  style={{
                    flex: 1, minHeight: 34, padding: "7px 10px", borderRadius: 4,
                    background: "var(--bg)", border: "1px solid var(--border)",
                    color: "var(--text)", fontSize: FS.sm, fontFamily: "inherit",
                  }}
                />
                <ActionButton
                  icon="go"
                  label="送る"
                  variant="primary"
                  disabled={!message.trim()}
                  onClick={() => { onSpeak?.(message); setMessage(""); }}
                />
              </div>
            </div>
          </div>
        ) : null}

        {lane.references?.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <SectionHead label="下調べで見たもの" right={<span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{lane.references.length} 件すべて ▾</span>} />
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {lane.references.map((r) => (
                <div key={r.path} style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 8px" }}>
                  <span style={{ width: 260, flexShrink: 0, fontSize: FS.sm, color: "var(--text)" }}>{r.path}</span>
                  <span style={{ flex: 1, fontSize: FS.sm, color: "var(--text-dim)" }}>{r.why}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 経過 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionHead label="経過" right={<span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>すべて表示 ▾</span>} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            {lane.timeline.map((e, i) => {
              const last = i === lane.timeline.length - 1;
              return (
                <div key={`${e.time}-${i}`} style={{ display: "flex", alignItems: "stretch", gap: 10, padding: "0 8px 0 4px", borderRadius: 4, background: last ? "var(--bg-panel)" : "transparent" }}>
                  <span style={{ width: 34, flexShrink: 0, paddingTop: 5, fontSize: FS.xs, color: "var(--text-dim)" }}>{e.time}</span>
                  <span style={{ position: "relative", width: 12, flexShrink: 0 }}>
                    <span style={{ position: "absolute", left: 5.5, top: 0, bottom: 0, width: 1, background: "var(--border)" }} />
                    <span
                      style={{
                        position: "absolute", left: e.kind === "user" ? 1 : 2, top: 8,
                        width: e.kind === "user" ? 10 : 8, height: e.kind === "user" ? 9 : 8,
                        borderRadius: e.kind === "warn" ? 1 : e.kind === "user" ? 0 : "50%",
                        clipPath: e.kind === "user" ? "polygon(50% 0, 100% 100%, 0 100%)" : undefined,
                        background: e.kind === "agent" ? "var(--bg)" : "var(--accent)",
                        border: e.kind === "agent" ? "1.5px solid var(--text-muted)" : undefined,
                      }}
                    />
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 1, padding: "5px 0 9px" }}>
                    <span style={{ fontSize: FS.sm, fontWeight: 600, color: "var(--text)" }}>{e.title}</span>
                    <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{e.detail}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* agent */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionHead label="この lane の agent" />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {lane.agents.map((a) => (
              <button
                key={a.sessionId}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 12px", borderRadius: 5,
                  background: "var(--bg)", border: "1px solid var(--border)", cursor: "pointer",
                }}
              >
                <span style={{ fontSize: FS.sm, fontWeight: 600, color: "var(--text)" }}>{a.role}</span>
                <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{a.sessionId}</span>
                <span style={{ fontSize: FS.xs, color: "var(--text-muted)" }}>{a.state}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 判断が待っているときだけ、末尾に出す */}
        {lane.pending === "go" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <ActionButton icon="go" label="GO" variant="primary" minWidth={92} onClick={() => onDecide("s1_go", { iddId: lane.iddId })} />
            <ActionButton icon="abort" label="中止" minWidth={92} onClick={() => onDecide("s1_defer", { iddId: lane.iddId })} />
            <span style={{ flex: 1 }} />
            <IconButton icon="chat" title="下調べの内容を聞く" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function LaneDetailPlaceholder({ iddId }: { iddId: string }) {
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-dim)", fontSize: FS.lg }}>
      <Icon name="warn" size={14} color="var(--text-dim)" />
      {iddId} の詳細はまだ読み込めません
    </div>
  );
}
