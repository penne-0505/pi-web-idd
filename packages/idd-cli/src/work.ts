import { agentBaseUrl } from "../../idd-core/src/agent/token.ts";
import type { WorkFindingsView, WorkRecordView } from "../../../lib/idd-ui/work-types.ts";

export interface WorkCommandDeps {
  fetch?: typeof fetch;
  baseUrl?: () => string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/** `work record IDD-xxx`: the lane's AC states, log and findings as a table */
export function formatWorkRecord(view: WorkRecordView): string[] {
  const lines: string[] = [`${view.lane} の記録`];
  lines.push("受け入れ条件:");
  for (const a of view.acceptance) lines.push(`  ${a.id} [${a.status}] ${a.statement}${a.evidence ? ` — ${a.evidence}` : ""}`);
  if (!view.acceptance.length) lines.push("  （なし）");
  lines.push("検証ログ:");
  for (const e of view.log) {
    lines.push(`  ${e.at.slice(0, 16).replace("T", " ")} ${e.stage} ${e.verdict} (${e.who})${e.commands.length ? ` — ${e.commands.join(" / ")}` : ""}`);
    if (e.next) lines.push(`    次: ${e.next}`);
  }
  if (!view.log.length) lines.push("  （なし）");
  lines.push(`出した指摘: ${view.findings.placed.length} 件`);
  for (const f of view.findings.placed) lines.push(`  ${findingLine(f)}`);
  lines.push(`渡った指摘: ${view.findings.delivered.length} 件`);
  for (const f of view.findings.delivered) lines.push(`  ${findingLine(f)}`);
  lines.push(`処置: ${view.findings.disposals.length} 件`);
  for (const d of view.findings.disposals) lines.push(`  ${d.id} ${d.action}${d.reason ? ` — ${d.reason}` : ""}`);
  return lines;
}

function findingLine(f: WorkFindingsView["findings"][number]): string {
  const at = f.lines ? `${f.path}:${f.lines[0]}${f.lines[1] !== f.lines[0] ? `-${f.lines[1]}` : ""}` : f.path;
  return `${f.id} [${f.severity}/${f.status}] ${at} from ${f.lane}: ${f.claim}${f.fixLane ? `（${f.fixLane} が直すと申告）` : ""}`;
}

/** `work findings PATH...`: the open findings of the paths as a table */
export function formatWorkFindings(view: WorkFindingsView): string[] {
  if (!view.findings.length) return [`${view.repo} の ${view.paths.join(", ") || "（path なし）"} に open な指摘はありません`];
  return view.findings.map((f) => findingLine(f));
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

/** the positional arguments, minus the flags and their values */
function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (valueFlags.includes(a.slice(2))) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

const USAGE = "usage: idd work record IDD-xxx [--json]\n       idd work findings PATH... [--repo R] [--view-lane ID] [--json]\n       idd work consumption [--since YYYY-MM-DD] [--lane ID] [--json]\n";

/** what the consumption door answers: the rows and their summary by contract and provider */
interface ConsumptionSummaryView {
  cost: number;
  units: number;
  buckets: { contract: string; provider?: string; cost: number; input: number; output: number; units: number; attempts: number; replies: number }[];
  failures: Record<string, number>;
}

/** `work consumption`: what each contract used, and how the units ended */
export function formatWorkConsumption(view: ConsumptionSummaryView): string[] {
  const usd = (n: number) => `$${n.toFixed(4)}`;
  if (!view.units) return ["消費の記録はまだありません"];
  const lines = [`合計 ${usd(view.cost)} / ${view.units} 件`];
  for (const b of view.buckets) {
    lines.push(`  ${b.contract}${b.provider ? `（${b.provider}）` : ""}: ${usd(b.cost)} / in ${b.input} out ${b.output} / 試行 ${b.attempts} 応答 ${b.replies}`);
  }
  const failures = Object.entries(view.failures);
  if (failures.length) lines.push(`  失敗: ${failures.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  return lines;
}

/**
 * `idd work record` / `idd work findings`: the engine's read-only work records and place findings. The state is
 * never written; a caller without the engine gets one line that says so, not a stack trace.
 */
export async function runWorkCommand(args: string[], deps: WorkCommandDeps = {}): Promise<number> {
  const doFetch = deps.fetch ?? fetch;
  const out = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const base = deps.baseUrl ?? agentBaseUrl;
  const sub = args[0];
  const rest = args.slice(1);
  if (sub !== "record" && sub !== "findings" && sub !== "consumption") {
    err(USAGE);
    return 2;
  }
  try {
    if (sub === "consumption") {
      const url = new URL(`${base()}/api/idd/work/consumption`);
      const since = flag(rest, "since");
      if (since) url.searchParams.set("since", since);
      const laneId = flag(rest, "lane");
      if (laneId) url.searchParams.set("lane", laneId);
      const res = await doFetch(url.toString(), { headers: { "Cache-Control": "no-store" } });
      const data = (await res.json()) as { rows: unknown[]; summary: ConsumptionSummaryView; error?: string };
      if (!res.ok) { err(`消費を読めません: ${data.error ?? res.status}\n`); return 1; }
      if (rest.includes("--json")) out(`${JSON.stringify(data, null, 2)}\n`);
      else for (const line of formatWorkConsumption(data.summary)) out(`${line}\n`);
      return 0;
    }
    if (sub === "record") {
      const id = positionals(rest, [])[0];
      if (!id) { err(USAGE); return 2; }
      const res = await doFetch(`${base()}/api/idd/work/lanes/${encodeURIComponent(id)}/record`, { headers: { "Cache-Control": "no-store" } });
      const data = (await res.json()) as WorkRecordView & { error?: string };
      if (!res.ok) { err(`記録を読めません: ${data.error ?? res.status}\n`); return 1; }
      if (rest.includes("--json")) out(`${JSON.stringify(data, null, 2)}\n`);
      else for (const line of formatWorkRecord(data)) out(`${line}\n`);
      return 0;
    }
    const paths = positionals(rest, ["repo", "view-lane"]);
    if (!paths.length) { err(USAGE); return 2; }
    const url = new URL(`${base()}/api/idd/work/findings`);
    url.searchParams.set("repo", flag(rest, "repo") ?? "");
    for (const p of paths) url.searchParams.append("path", p);
    const viewLane = flag(rest, "view-lane");
    if (viewLane) url.searchParams.set("view_lane", viewLane);
    const res = await doFetch(url.toString(), { headers: { "Cache-Control": "no-store" } });
    const data = (await res.json()) as WorkFindingsView & { error?: string };
    if (!res.ok) { err(`指摘を読めません: ${data.error ?? res.status}\n`); return 1; }
    if (rest.includes("--json")) out(`${JSON.stringify(data, null, 2)}\n`);
    else for (const line of formatWorkFindings(data)) out(`${line}\n`);
    return 0;
  } catch (cause) {
    err(`engine に繋がりません（落ちているかもしれません）: ${String(cause)}\n`);
    return 1;
  }
}
