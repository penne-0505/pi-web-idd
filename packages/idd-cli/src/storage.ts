import { agentBaseUrl } from "../../idd-core/src/agent/token.ts";
import type { StorageView } from "../../idd-core/src/storage/api.ts";

const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)}G`;

/** the table `idd storage` prints when --json is not asked for */
export function formatStorage(view: StorageView): string[] {
  const out: string[] = [];
  out.push(`片づけ: ${view.cleanup ? "ON" : "OFF"}   しきい値: ${view.minFreeGb}G   測った時刻: ${view.measuredAt}`);
  for (const fs of view.filesystems) {
    out.push(`空き ${fs.mount}: ${gb(fs.freeBytes)} / ${gb(fs.totalBytes)}${fs.belowThreshold ? "（しきい値未満）" : ""}`);
  }
  if (view.archive) out.push(`保存先: ${view.archive.dir}${view.archive.visible ? "" : "（見えません）"}`);
  out.push("置き場:");
  for (const p of view.places) {
    const flag = p.cleanup === null ? "既存" : p.cleanup ? "ON" : "OFF";
    out.push(`  ${p.label}: ${gb(p.bytes)} / ${p.count} 個 [${flag}]${p.note ? ` ${p.note}` : ""}`);
  }
  out.push(`次に消す候補: ${view.candidates.length} 件`);
  for (const c of view.candidates.slice(0, 40)) {
    out.push(`  ${gb(c.bytes)}  ${c.path}${c.lane ? `（${c.lane}）` : ""}  消す時刻 ${c.dueAt.slice(0, 16).replace("T", " ")}`);
  }
  if (view.candidates.length > 40) out.push(`  （ほか ${view.candidates.length - 40} 件）`);
  if (view.kept.length) {
    out.push(`残したもの: ${view.kept.length} 件`);
    for (const k of view.kept.slice(0, 40)) out.push(`  ${k.path}${k.lane ? `（${k.lane}）` : ""}: ${k.reason}`);
    if (view.kept.length > 40) out.push(`  （ほか ${view.kept.length - 40} 件）`);
  }
  if (view.lastSweep) {
    out.push(`最後の片づけ: ${view.lastSweep.at} に ${view.lastSweep.removed.length} 件（${gb(view.lastSweep.removed.reduce((n, r) => n + r.bytes, 0))}）`);
  }
  return out;
}

export interface StorageCommandDeps {
  fetch?: typeof fetch;
  baseUrl?: () => string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/**
 * `idd storage [--json]`: the engine's read-only view of the places and the next candidates. A caller without the
 * engine gets a line that says so, not a stack trace (the other read verbs' handling).
 */
export async function runStorageCommand(args: string[], deps: StorageCommandDeps = {}): Promise<number> {
  const doFetch = deps.fetch ?? fetch;
  const out = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const base = deps.baseUrl ?? agentBaseUrl;
  try {
    const res = await doFetch(`${base()}/api/idd/storage`, { headers: { "Cache-Control": "no-store" } });
    const data = (await res.json()) as StorageView & { error?: string };
    if (!res.ok) {
      err(`storage を読めません: ${data.error ?? res.status}\n`);
      return 1;
    }
    if (args.includes("--json")) out(`${JSON.stringify(data, null, 2)}\n`);
    else for (const line of formatStorage(data)) out(`${line}\n`);
    return 0;
  } catch (cause) {
    err(`engine に繋がりません（落ちているかもしれません）: ${String(cause)}\n`);
    return 1;
  }
}
