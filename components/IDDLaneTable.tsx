"use client";

// intent: DEC-002 — IDD 追加 component、pi-web 既存に触れず additive
// intent: DEC-006 — button 押下 = 1 承認 = 1 lifecycle event、ledger 書き込みは POST /api/idd/lifecycle 経由

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { LaneWithRepo } from "@/lib/idd/ledger-io";

interface Props {
  lanes: LaneWithRepo[];
  emptyMessage?: string;
}

interface ButtonSpec {
  label: string;
  event: string;
  attrs: (lane: LaneWithRepo) => Record<string, unknown>;
  variant?: "primary" | "danger" | "muted";
  confirm?: string;
}

// intent: DEC-006 — button 集合は stage state の関数、UI batch 化しない (1 押下 = 1 event)
function buttonsForStage(stage: string): ButtonSpec[] {
  if (stage.startsWith("s1-ready")) {
    return [
      { label: "GO", event: "s1_go", attrs: () => ({ user_decision: "go" }), variant: "primary" },
      { label: "defer", event: "s1_defer", attrs: () => ({}), variant: "muted" },
    ];
  }
  if (stage === "s2-blocked") {
    return [
      { label: "abort → S1", event: "s2_result", attrs: () => ({ result: "failure", narrative: "user aborted from S1 button" }), variant: "danger", confirm: "この lane を中止して S1 に戻しますか？" },
    ];
  }
  if (stage === "s3-ready") {
    return [
      { label: "OK", event: "s3_ok", attrs: () => ({}), variant: "primary" },
      { label: "reject", event: "s3_reject", attrs: () => ({ reason: "manual reject from dashboard" }), variant: "danger", confirm: "この差分を reject して S2 に戻しますか？" },
    ];
  }
  if (stage === "s2-failed" || stage === "s0-failed") {
    return [
      { label: "close", event: "lane_close", attrs: () => ({ close_reason: "delete" }), variant: "danger", confirm: "この lane を削除しますか？（retire として記録）" },
    ];
  }
  return [];
}

export function IDDLaneTable({ lanes, emptyMessage = "(no lanes)" }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function submit(lane: LaneWithRepo, spec: ButtonSpec) {
    if (spec.confirm && !window.confirm(spec.confirm)) return;
    setBusyId(lane.linearIssueId);
    setError(null);
    try {
      const attrs = { linear_issue_id: lane.linearIssueId, ...spec.attrs(lane) };
      const res = await fetch("/api/idd/lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: spec.event, repo: lane.repo, attrs }),
      });
      const body = await res.json();
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      startTransition(() => router.refresh());
    } catch (exc) {
      setError(`${lane.linearIssueId}: ${(exc as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  if (lanes.length === 0) {
    return <p style={{ color: "var(--text-muted)", padding: "1rem 0" }}>{emptyMessage}</p>;
  }

  return (
    <>
      {error && (
        <div style={{
          background: "var(--user-bg)", border: "1px solid var(--border)",
          color: "var(--text)", padding: "0.75rem 1rem", marginBottom: "1rem",
          borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: "0.85rem",
        }}>{error}</div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: "0.9rem" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left", color: "var(--text-muted)" }}>
            <th style={{ padding: "0.5rem" }}>Linear</th>
            <th style={{ padding: "0.5rem" }}>Repo</th>
            <th style={{ padding: "0.5rem" }}>Stage</th>
            <th style={{ padding: "0.5rem" }}>Worker</th>
            <th style={{ padding: "0.5rem" }}>Worktree</th>
            <th style={{ padding: "0.5rem" }}>Since</th>
            <th style={{ padding: "0.5rem" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {lanes.map((lane) => {
            const buttons = buttonsForStage(lane.stage);
            const rowBusy = busyId === lane.linearIssueId || pending;
            return (
              <tr key={`${lane.repo}:${lane.linearIssueId}`} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "0.5rem" }}>{lane.linearIssueId}</td>
                <td style={{ padding: "0.5rem", color: "var(--text-muted)" }}>{lane.repo}</td>
                <td style={{ padding: "0.5rem" }}>{lane.stage}</td>
                <td style={{ padding: "0.5rem", color: "var(--text-muted)" }}>{lane.worker ?? "-"}</td>
                <td style={{ padding: "0.5rem", color: "var(--text-dim)" }}>{lane.worktree ?? "-"}</td>
                <td style={{ padding: "0.5rem", color: "var(--text-muted)" }}>{lane.since.slice(11, 16)}</td>
                <td style={{ padding: "0.5rem" }}>
                  {buttons.length === 0 ? (
                    <span style={{ color: "var(--text-dim)" }}>—</span>
                  ) : (
                    buttons.map((b) => (
                      <button
                        key={b.event + b.label}
                        onClick={() => submit(lane, b)}
                        disabled={rowBusy}
                        style={{
                          marginRight: 4, padding: "0.25rem 0.6rem", borderRadius: 3,
                          border: "1px solid var(--border)", cursor: rowBusy ? "wait" : "pointer",
                          background: b.variant === "primary" ? "var(--accent)"
                                     : b.variant === "danger" ? "var(--user-bg)"
                                     : "var(--bg-panel)",
                          color: b.variant === "primary" ? "#fff" : "var(--text)",
                          fontFamily: "inherit", fontSize: "0.8rem",
                        }}
                      >{b.label}</button>
                    ))
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
