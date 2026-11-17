import { agentBaseUrl } from "../../idd-core/src/agent/token.ts";
import type { ForecastEta, ForecastLaneView, ForecastView } from "../../idd-core/src/plan/forecast.ts";
import type { GateKey, StageKey, WaitKey } from "../../idd-core/src/ledger/stage-spans.ts";

const STAGE_LABELS: Record<StageKey, string> = {
  plan: "計画",
  plan_review: "計画の査読",
  impl: "実装",
  review: "初回のレビュー",
  fix: "修正",
  checks: "検査",
  land: "取り込み",
};

const GATE_LABELS: Record<GateKey, string> = {
  question: "質問待ち",
  go: "GO 待ち",
  sign: "署名待ち",
  card: "要判断",
};

const WAIT_LABELS: Record<WaitKey, string> = {
  order: "順番待ち",
  dependency: "依存待ち",
  outside: "外待ち",
  quota: "枠待ち",
  slot: "上限待ち",
};

const STOP_LABELS: Record<GateKey | "end", string> = {
  question: "質問",
  go: "GO",
  sign: "署名",
  card: "要判断",
  end: "終わり",
};

const UNKNOWN_LABELS: Record<"fix_cap" | "dependency", string> = {
  fix_cap: "修正の巡が上限",
  dependency: "依存が解けない",
};

function nowLabel(lane: ForecastLaneView): string {
  const now = lane.now;
  if (now.kind === "stage") return now.stage ? STAGE_LABELS[now.stage] : "段";
  if (now.kind === "gate") return now.gate ? GATE_LABELS[now.gate] : "関所";
  return now.wait ? WAIT_LABELS[now.wait] : "待ち";
}

function etaLabel(eta: ForecastEta): string {
  if (eta.at) {
    const at = eta.at.slice(0, 16).replace("T", " ");
    return `終わる頃 ${at}（${eta.stopsAt ? STOP_LABELS[eta.stopsAt] : "?"} で止まる）`;
  }
  if (eta.unknown) return `分からない（${UNKNOWN_LABELS[eta.unknown]}）`;
  if (eta.via) return `相手しだい（${eta.via.lane} の ${eta.via.stopsAt ? STOP_LABELS[eta.via.stopsAt] : "待ち"}）`;
  return "時刻は出せない";
}

/** the table `idd forecast` prints when --json is not asked for: one line per lane */
export function formatForecast(view: ForecastView, laneId?: string): string[] {
  const lanes = laneId ? view.lanes.filter((l) => l.iddId === laneId) : view.lanes;
  if (!lanes.length) return [laneId ? `${laneId} の見込みはありません` : "見込みのある lane はありません"];
  return lanes.map((l) => `${l.iddId}  ${nowLabel(l)}  ${l.now.elapsedMin}分  ${etaLabel(l.eta)}${l.anomaly ? "  ●朱" : ""}`);
}

export interface ForecastCommandDeps {
  fetch?: typeof fetch;
  baseUrl?: () => string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/**
 * `idd forecast [IDD-xxx] [--json]`: the engine's read-only forecast of every open lane. A caller without the
 * engine gets a line that says so, not a stack trace (the other read verbs' handling).
 */
export async function runForecastCommand(args: string[], deps: ForecastCommandDeps = {}): Promise<number> {
  const doFetch = deps.fetch ?? fetch;
  const out = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const base = deps.baseUrl ?? agentBaseUrl;
  const laneId = args.find((a) => !a.startsWith("-"));
  try {
    const res = await doFetch(`${base()}/api/idd/forecast`, { headers: { "Cache-Control": "no-store" } });
    const data = (await res.json()) as ForecastView & { error?: string };
    if (!res.ok) {
      err(`見込みを読めません: ${data.error ?? res.status}\n`);
      return 1;
    }
    if (args.includes("--json")) out(`${JSON.stringify(data, null, 2)}\n`);
    else for (const line of formatForecast(data, laneId)) out(`${line}\n`);
    return 0;
  } catch (cause) {
    err(`engine に繋がりません（落ちているかもしれません）: ${String(cause)}\n`);
    return 1;
  }
}
