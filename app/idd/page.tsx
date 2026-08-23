// intent: DEC-002 — IDD dashboard page、pi-web 既存 UI (/) は無改変、app/idd/* 経由でのみ提供

import { join } from "node:path";
import { readAllLanes } from "@/lib/idd/ledger-io";
import { getWorkerPool } from "@/lib/idd/worker-pool";
import { IDDLaneTable } from "@/components/IDDLaneTable";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ retired?: string }>;
}

export default async function IDDDashboardPage({ searchParams }: Props) {
  const params = await searchParams;
  const showRetired = params.retired === "1";

  const msyncRoot = process.env.MSYNC_ROOT?.trim();
  let lanes: Awaited<ReturnType<typeof readAllLanes>> = [];
  let error: string | null = null;

  if (!msyncRoot) {
    error = "MSYNC_ROOT env var is unset — set it in .env.local (e.g. MSYNC_ROOT=~/dev/00_meltly/sync-tools) and restart dev";
  } else {
    try {
      // intent: DEC-002 — retired の count を出すため常に full fetch し、表示側で分岐 (single fetch で active/retired 両方の集計が取れる)
      lanes = await readAllLanes(join(msyncRoot, "state"), { includeRetired: true });
    } catch (exc) {
      error = `failed to read ledgers: ${(exc as Error).message}`;
    }
  }

  const active = lanes.filter((l) => l.stage !== "lane-close");
  const retired = lanes.filter((l) => l.stage === "lane-close");
  const workers = getWorkerPool().list();

  return (
    <main style={{
      maxWidth: 1200, margin: "0 auto", padding: "2rem 1.5rem",
      color: "var(--text)", background: "var(--bg)", minHeight: "100vh",
      fontFamily: "system-ui, sans-serif",
    }}>
      <header style={{ marginBottom: "2rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.4rem", fontWeight: 600 }}>IDD Pipeline</h1>
        <p style={{ margin: "0.4rem 0 0", color: "var(--text-muted)", fontSize: "0.9rem" }}>
          Meltly ledger を fold した lane state と worker pool。button 押下は per-action 承認として ledger に記録される。
        </p>
      </header>

      {error && (
        <div style={{
          background: "var(--user-bg)", border: "1px solid var(--border)",
          padding: "0.75rem 1rem", marginBottom: "1.5rem", borderRadius: 4,
          fontFamily: "var(--font-mono)", fontSize: "0.85rem",
        }}>{error}</div>
      )}

      <section style={{ marginBottom: "2.5rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem", color: "var(--text)" }}>
          Active lanes ({active.length})
        </h2>
        <IDDLaneTable lanes={active} emptyMessage="(no active lanes — 全 Todo が消化済みか、fan-out がまだ走っていない)" />
      </section>

      <section style={{ marginBottom: "2.5rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem", color: "var(--text)" }}>
          Worker pool ({workers.length})
        </h2>
        {workers.length === 0 ? (
          <p style={{ color: "var(--text-muted)", padding: "0.5rem 0" }}>
            (no workers registered — DEC-004 の rpc-manager 連携はまだ未実装。fan-out や UI 起動 button から
            worker が register されるようになると値が入る)
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left", color: "var(--text-muted)" }}>
                <th style={{ padding: "0.5rem" }}>ID</th>
                <th style={{ padding: "0.5rem" }}>Role</th>
                <th style={{ padding: "0.5rem" }}>Status</th>
                <th style={{ padding: "0.5rem" }}>Model</th>
                <th style={{ padding: "0.5rem" }}>Task</th>
                <th style={{ padding: "0.5rem" }}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => (
                <tr key={w.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "0.5rem" }}>{w.id}</td>
                  <td style={{ padding: "0.5rem" }}>{w.role}</td>
                  <td style={{ padding: "0.5rem", color: w.status === "idle" ? "var(--text-muted)" : "var(--text)" }}>{w.status}</td>
                  <td style={{ padding: "0.5rem", color: "var(--text-muted)" }}>{w.model}</td>
                  <td style={{ padding: "0.5rem" }}>{w.currentTask?.linearIssueId ?? "-"}</td>
                  <td style={{ padding: "0.5rem", color: "var(--text-dim)" }}>{w.updatedAt.slice(11, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem", color: "var(--text)" }}>
          Retired lanes ({retired.length})
        </h2>
        <p style={{ marginBottom: "0.75rem" }}>
          <a
            href={showRetired ? "/idd" : "/idd?retired=1"}
            style={{ color: "var(--accent)", fontSize: "0.85rem" }}
          >
            {showRetired ? "hide retired" : "show retired"}
          </a>
        </p>
        {showRetired ? (
          <IDDLaneTable lanes={retired} emptyMessage="(no retired lanes yet)" />
        ) : (
          <p style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>({retired.length} hidden、上の link で開く)</p>
        )}
      </section>
    </main>
  );
}
