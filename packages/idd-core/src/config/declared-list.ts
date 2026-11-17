/**
 * The reading both a repo's `increments` and `generated_files` lists start with: a list of tables that use only the
 * fields the reader knows, and an optional limit in minutes. The messages are the config errors the operator sees, so
 * the two lists fail in the same words.
 */

/** each table of a declared list read by `read` (undefined when nothing is declared); a non-list, a non-table and an unknown field throw */
export function declaredList<T>(where: string, raw: unknown, fields: readonly string[], read: (o: Record<string, unknown>, i: number) => T): T[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${where}: 一覧で書いてください`);
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${where}[${i}]: 表で書いてください`);
    const o = item as Record<string, unknown>;
    const unknown = Object.keys(o).filter((k) => !fields.includes(k));
    if (unknown.length) throw new Error(`${where}[${i}]: 知らない欄 ${unknown.join(", ")}（使える欄: ${fields.join(", ")}）`);
    return read(o, i);
  });
}

/** the `timeout_minutes` of one table: a positive number, or the default when it is not written */
export function declaredMinutes(where: string, i: number, o: Record<string, unknown>, fallback: number): number {
  const minutes = o.timeout_minutes;
  if (minutes === undefined || minutes === null) return fallback;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) throw new Error(`${where}[${i}].timeout_minutes: 正の数（分）で書いてください`);
  return minutes;
}
