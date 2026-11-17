/**
 * The entries of a config table, or undefined when the field is missing or null. Anything but a table is a config
 * error that says `how` the field is to be written.
 */
export function tableEntries(where: string, raw: unknown, how = "表で書いてください"): Array<[string, unknown]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: ${how}`);
  return Object.entries(raw as Record<string, unknown>);
}

/** a config error naming the fields of `table` that are not among `fields`: a misspelt field must not pass for a default */
export function rejectUnknownFields(where: string, table: Record<string, unknown>, fields: readonly string[]): void {
  const unknown = Object.keys(table).filter((k) => !fields.includes(k));
  if (unknown.length) throw new Error(`${where}: 知らない欄 ${unknown.join(", ")}（使える欄: ${fields.join(", ")}）`);
}
