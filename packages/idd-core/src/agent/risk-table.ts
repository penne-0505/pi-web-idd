import { RISK_KEYS, RISK_LABELS, type RiskKey } from "../config/risk-paths.ts";

/** one row of the planner's table: whether the lane touches this kind of harm, and one plain line of why */
export interface RiskTableRow {
  kind: RiskKey;
  touches: boolean;
  reason: string;
}

/** the kinds every report must answer, in the card's order */
export const RISK_TABLE_KINDS = RISK_KEYS;

const isRiskKey = (key: string): key is RiskKey => (RISK_KEYS as readonly string[]).includes(key);

/** the table's shape, as the planner writes it: a list of rows, or an object keyed by kind */
const rowOf = (kind: RiskKey, value: unknown, where: string): RiskTableRow | { error: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: `${where}: 触れる / 触れない と根拠を書いてください（例 {"touches": false, "reason": "..."}）` };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.touches !== "boolean") return { error: `${where}.touches: true か false で書いてください` };
  if (typeof v.reason !== "string" || !v.reason.trim()) return { error: `${where}.reason: 根拠を 1 文で書いてください（「触れない」の行にも要ります）` };
  return { kind, touches: v.touches, reason: v.reason.trim().replace(/\s+/g, " ") };
};

/**
 * The planner's six-kind table, normalized into the fixed kind order, or an error message naming what is missing and
 * how to fix it. An array of rows and an object keyed by kind are both read; anything that does not answer all six
 * kinds with a reason is refused (a table nobody answered in full is the same as no table).
 */
export function normalizeRiskTable(raw: unknown): { table: RiskTableRow[] } | { error: string } {
  if (raw === undefined || raw === null) {
    return { error: `該当表がありません。${RISK_KEYS.join(" / ")} の 6 種類それぞれに、触れる / 触れない と根拠 1 文を付けて送ってください` };
  }
  const rows = new Map<RiskKey, RiskTableRow>();
  if (Array.isArray(raw)) {
    for (const [i, item] of raw.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `risk_table[${i}]: 種類ごとの行で書いてください` };
      const kind = (item as Record<string, unknown>).kind;
      if (typeof kind !== "string" || !isRiskKey(kind)) {
        return { error: `risk_table[${i}].kind: 未知の種類です（${typeof kind === "string" ? kind : String(kind)}。使える種類: ${RISK_KEYS.join(", ")}）` };
      }
      if (rows.has(kind)) return { error: `risk_table: ${kind} が 2 回あります。種類ごとに 1 行にしてください` };
      const row = rowOf(kind, item, `risk_table[${i}]`);
      if ("error" in row) return row;
      rows.set(kind, row);
    }
  } else if (typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!isRiskKey(key)) return { error: `risk_table.${key}: 未知の種類です（使える種類: ${RISK_KEYS.join(", ")}）` };
      const row = rowOf(key, value, `risk_table.${key}`);
      if ("error" in row) return row;
      rows.set(key, row);
    }
  } else {
    return { error: "該当表は、種類ごとの行の一覧か、種類をキーにした表で送ってください" };
  }
  const missing = RISK_KEYS.filter((k) => !rows.has(k));
  if (missing.length) {
    return { error: `該当表に ${missing.join(" / ")} がありません。${RISK_KEYS.join(" / ")} の 6 種類すべてに答えてください` };
  }
  return { table: RISK_KEYS.map((k) => rows.get(k) as RiskTableRow) };
}

/** the row's display name: the kind's fixed order carries through the declaration, the table and the card */
export function riskRowLabel(row: RiskTableRow): string {
  return `${RISK_LABELS[row.kind]}（${row.kind}）`;
}

/** the last ready's table, or undefined when that ready came without one (an older ready must not read as all-clear) */
export function readyRiskTableOf(events: { event: string; attrs?: Record<string, unknown> }[]): RiskTableRow[] | undefined {
  const last = [...events].reverse().find((e) => e.event === "s1_ready");
  const raw = last?.attrs?.risk_table;
  const parsed = normalizeRiskTable(raw);
  return "table" in parsed ? parsed.table : undefined;
}

/** whether any row says the lane touches a kind of harm */
export function riskTableTouches(table: RiskTableRow[] | undefined): boolean {
  return !!table?.some((r) => r.touches);
}
