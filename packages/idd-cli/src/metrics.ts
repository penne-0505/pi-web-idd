import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { agentBaseUrl } from "../../idd-core/src/agent/token.ts";
import { formatMetricsTable, renderMetricsSurvey, surveyPath, type MetricsView } from "../../idd-core/src/metrics/index.ts";

/**
 * `idd metrics [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json] [--survey] [--out PATH]` — the period's numbers,
 * read from the engine's door.
 *
 * The engine is the one that reads the costs: a lane's spend includes its planner and executor sessions, which only
 * the engine's runner can read, and a process without one would report every lane as free (the budget's reader is
 * the one reader of a lane's money). The door writes nothing, so running this as often as a person likes leaves no
 * trace; the weekly table is written by the person who runs it, never by the engine or the tick.
 */

const FLAGS = ["--since", "--until", "--out"] as const;

/** the flags of one run, as they were written */
export interface MetricsArgs {
  since?: string;
  until?: string;
  out?: string;
  json: boolean;
  survey: boolean;
}

function parse(args: string[]): MetricsArgs {
  const out: MetricsArgs = { json: args.includes("--json"), survey: args.includes("--survey") };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const flag of FLAGS) {
      const key = flag.slice(2) as "since" | "until" | "out";
      if (arg === flag) {
        const value = args[i + 1];
        if (value && !value.startsWith("--")) { out[key] = value; i += 1; }
      } else if (arg.startsWith(`${flag}=`)) {
        out[key] = arg.slice(flag.length + 1);
      }
    }
  }
  return out;
}

export interface MetricsCommandDeps {
  fetch?: typeof fetch;
  baseUrl?: () => string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** where the survey goes when it is written to a file (the repo root); the cwd by default */
  root?: string;
}

export async function runMetricsCommand(args: string[], deps: MetricsCommandDeps = {}): Promise<number> {
  const doFetch = deps.fetch ?? fetch;
  const out = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const base = deps.baseUrl ?? agentBaseUrl;
  const parsed = parse(args);
  const query = new URLSearchParams();
  if (parsed.since) query.set("since", parsed.since);
  if (parsed.until) query.set("until", parsed.until);
  const suffix = query.toString() ? `?${query}` : "";
  let view: MetricsView & { error?: string };
  try {
    const res = await doFetch(`${base()}/api/idd/metrics${suffix}`, { headers: { "Cache-Control": "no-store" } });
    view = (await res.json()) as MetricsView & { error?: string };
    if (!res.ok) {
      err(`指標を読めません: ${view.error ?? res.status}\n`);
      return 1;
    }
  } catch (cause) {
    err(`engine に繋がりません（落ちているかもしれません）: ${String(cause)}\n`);
    return 1;
  }
  if (parsed.json) {
    out(`${JSON.stringify(view, null, 2)}\n`);
    return 0;
  }
  if (parsed.survey) {
    const doc = renderMetricsSurvey(view, { ...(parsed.until ? { day: parsed.until } : {}) });
    if (!parsed.out) {
      out(doc.endsWith("\n") ? doc : `${doc}\n`);
      return 0;
    }
    const path = resolve(deps.root ?? process.cwd(), parsed.out);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, doc.endsWith("\n") ? doc : `${doc}\n`, "utf8");
    } catch (cause) {
      err(`週の表を書けませんでした: ${path}: ${String(cause)}\n`);
      return 1;
    }
    out(`${path}\n`);
    return 0;
  }
  for (const line of formatMetricsTable(view)) out(`${line}\n`);
  out(`\n週の表にするには: idd metrics --survey${parsed.since ? ` --since ${parsed.since}` : ""} --out ${surveyPath(parsed.until ?? view.until)}\n`);
  return 0;
}
