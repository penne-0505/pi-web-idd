import { agentBaseUrl } from "../../idd-core/src/agent/token.ts";
import type { StartOrderLane, StartOrderResult } from "../../idd-core/src/ledger/start-order.ts";

export const ORDER_USAGE = "usage: idd order [--json] | idd order move IDD-xxx (--to N | --before IDD-yyy | --after IDD-yyy | --first | --last) | idd order urgent IDD-xxx | idd order unurgent IDD-xxx";

/** the table `idd order` prints when --json is not asked for: position, the urgent mark, the lane and what it waits for */
export function formatOrder(lanes: StartOrderLane[]): string[] {
  if (!lanes.length) return ["開いている lane はありません"];
  const idWidth = Math.max(...lanes.map((l) => l.idd_id.length));
  const areaWidth = Math.max(...lanes.map((l) => l.area.length));
  return lanes.map((l) => {
    const mark = l.urgent ? "急" : "  ";
    const awaiting = l.awaiting === "planner" ? "計画役待ち" : l.awaiting === "executor" ? "実装役待ち" : "";
    return `${String(l.position).padStart(3)} ${mark} ${l.idd_id.padEnd(idWidth)} ${l.area.padEnd(areaWidth)} ${l.title}${awaiting ? `（${awaiting}）` : ""}`;
  });
}

export interface OrderCommandDeps {
  fetch?: typeof fetch;
  baseUrl?: () => string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/**
 * `idd order` and its verbs. The CLI wraps the engine's door and never reads or writes a state file: the reader
 * asks `GET`, every write verb asks `POST`. A malformed command is answered with the usage and a send that never
 * happens; a refusal from the engine, and an engine that cannot be reached, both end non-zero.
 */
export async function runOrderCommand(args: string[], deps: OrderCommandDeps = {}): Promise<number> {
  const doFetch = deps.fetch ?? fetch;
  const out = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const base = deps.baseUrl ?? agentBaseUrl;
  const json = args.includes("--json");
  const usage = (): number => { err(`${ORDER_USAGE}\n`); return 2; };

  const present = (data: StartOrderResult & { error?: string }): number => {
    if (!data.ok) { err(`${data.error ?? "並びを読めません"}\n`); return 1; }
    if (json) out(`${JSON.stringify(data, null, 2)}\n`);
    else for (const line of formatOrder(data.lanes)) out(`${line}\n`);
    return 0;
  };

  const [sub, id, ...rest] = args;
  const read = async (): Promise<number> => {
    try {
      const res = await doFetch(`${base()}/api/idd/order`, { headers: { "Cache-Control": "no-store" } });
      return present(await res.json() as StartOrderResult & { error?: string });
    } catch (cause) {
      err(`engine に繋がりません（落ちているかもしれません）: ${String(cause)}\n`);
      return 1;
    }
  };
  const write = async (body: Record<string, unknown>): Promise<number> => {
    try {
      const res = await doFetch(`${base()}/api/idd/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return present(await res.json() as StartOrderResult & { error?: string });
    } catch (cause) {
      err(`engine に繋がりません（落ちているかもしれません）: ${String(cause)}\n`);
      return 1;
    }
  };

  if (sub === undefined || sub === "--json") {
    if (args.some((a) => a.startsWith("--") && a !== "--json")) return usage();
    return read();
  }
  if (sub === "move") {
    if (!id || id.startsWith("--")) return usage();
    let before: string | undefined;
    let after: string | undefined;
    let position: number | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      const flag = rest[i];
      if (flag === "--json") continue;
      if (flag === "--first") { position = 1; continue; }
      if (flag === "--last") { position = Number.MAX_SAFE_INTEGER; continue; }
      if (flag === "--to") {
        const value = rest[i + 1];
        if (!value || !/^\d+$/.test(value) || Number(value) < 1) return usage();
        position = Number(value);
        i += 1;
        continue;
      }
      if (flag === "--before" || flag === "--after") {
        const value = rest[i + 1];
        if (!value || value.startsWith("--")) return usage();
        if (flag === "--before") before = value; else after = value;
        i += 1;
        continue;
      }
      return usage();
    }
    if ([before !== undefined, after !== undefined, position !== undefined].filter(Boolean).length !== 1) return usage();
    return write({
      action: "move",
      idd_id: id,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(position !== undefined ? { position } : {}),
    });
  }
  if (sub === "urgent" || sub === "unurgent") {
    if (!id || id.startsWith("--")) return usage();
    if (rest.some((a) => a !== "--json")) return usage();
    return write({ action: sub, idd_id: id });
  }
  return usage();
}
