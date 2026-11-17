import type { CommitConvention } from "../plan/vocab.ts";
import { describeSection, type SectionRef } from "./conventions.ts";
import { rejectUnknownFields } from "./table.ts";

const FIELDS = ["types", "scope", "source"];

/**
 * config/repos.yaml's `commit_convention`: the form of the repo's commit message (the types it starts with, whether
 * `type(scope):` is allowed) and where the repo says so. The submit card judges the one message that goes out by it.
 * An unknown field and a value of the wrong type are config errors, never a silent default: a misspelt field would
 * otherwise leave the check judging nothing while the card reads as if it judged. No `source` is a config error too,
 * since a declaration that does not say where it comes from cannot be checked against its origin. A repo that writes
 * nothing has no declaration, and its card does not show the line (a line nothing judged is not a pass).
 * A repo that points at the section of its commit rule (`conventions.commit`, `pointed`) says where the form comes
 * from there, so `source` is left out: writing both would name the same rule in two places, and one of them would
 * go stale. The source on the card is then the pointer itself.
 */
export function parseCommitConvention(where: string, raw: unknown, pointed?: SectionRef): CommitConvention | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: 表で書いてください`);
  const o = raw as Record<string, unknown>;
  rejectUnknownFields(where, o, FIELDS);
  if (!Array.isArray(o.types) || !o.types.length || o.types.some((t) => typeof t !== "string" || !/^[A-Za-z][\w-]*$/.test(t))) {
    throw new Error(`${where}.types: type の一覧（英数字と - _ だけの文字列、1 つ以上）で書いてください`);
  }
  if (o.scope !== undefined && typeof o.scope !== "boolean") throw new Error(`${where}.scope: true か false で書いてください（既定は false）`);
  if (pointed) {
    if (o.source !== undefined) throw new Error(`${where}.source: 同じ規約を conventions.commit でも指しています。どちらか 1 つにしてください（conventions.commit の指す所が出どころになります）`);
    return { types: [...new Set(o.types as string[])], scope: o.scope === true, source: describeSection(pointed) };
  }
  if (typeof o.source !== "string" || !o.source.trim()) throw new Error(`${where}.source: この形を書いている所（ファイルと節）を書いてください`);
  return { types: [...new Set(o.types as string[])], scope: o.scope === true, source: o.source.trim() };
}
