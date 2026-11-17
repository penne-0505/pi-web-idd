import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { RolePreset } from "./roles.ts";

/**
 * The price of a model, and the window a call goes through. The call target in the file is the call target that
 * runs: nothing here rewrites it, and nothing here knows a whole-window switch. What is left is the price, because
 * a model whose price is unknown would run at a cost of 0 and the lane budget would never stop it.
 */

/** $ per million tokens, the unit pi's models.json takes */
export interface ModelCost { input: number; output: number; cacheRead: number; cacheWrite: number }

const PRICE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The gateway's list price of a model, from its public model list (no key needed), cached for a day.
 * A model pi's catalog does not know would otherwise run at a cost of 0, and the lane budget would never stop it.
 */
export function vercelPrice(modelId: string, cacheFile: string, fetchList: () => string | null = fetchModelList): ModelCost | null {
  type List = { data?: { id: string; pricing?: Record<string, string> }[] };
  const cached = (): List | null => {
    try { return existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, "utf8")) as List) : null; } catch { return null; }
  };
  let fresh = false;
  try { fresh = existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < PRICE_TTL_MS; } catch { fresh = false; }
  let data: List | null = fresh ? cached() : null;
  if (!data) {
    const body = fetchList();
    try {
      if (body === null) throw new Error("unreachable");
      data = JSON.parse(body) as List;
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, body);
    } catch {
      // list prices change rarely; an old list is better than none
      data = cached();
    }
  }
  const p = data?.data?.find((m) => m.id === modelId)?.pricing;
  if (!p) return null;
  const perM = (v: string | undefined) => (v === undefined ? 0 : Number(v) * 1_000_000);
  return { input: perM(p.input), output: perM(p.output), cacheRead: perM(p.input_cache_read), cacheWrite: perM(p.input_cache_write ?? p.input) };
}

function fetchModelList(): string | null {
  const r = spawnSync("curl", ["-sf", "--max-time", "20", "https://ai-gateway.vercel.sh/v1/models"], { encoding: "utf8", timeout: 30_000 });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

/** A model pi's catalog does not know runs only with a price: at a cost of 0 the lane budget would never stop it. */
export function requirePrice(role: RolePreset, cost: ModelCost | null): ModelCost {
  if (cost) return cost;
  const why = role.model.startsWith("vercel-ai-gateway/")
    ? "Vercel の一覧に無いか、一覧を取れず手元の写しも無い"
    : "pi の目録にも ~/.pi/agent/models.json にも価格つきで載っていない";
  throw new Error(`role ${role.name}: ${role.model} の価格が分からない（${why}）。費用 0 で記録され予算が効かなくなるので起動しない`);
}
