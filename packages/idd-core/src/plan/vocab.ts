/**
 * Words of the records workflow that should not reach a public PR or Issue. Finding one is a warning,
 * not a gate: some projects use a word such as "lane" in their own sense and allow it per repo.
 * No Node imports here, so the cards can use the same list.
 */

/** what joins a prefix of the records to its number: a hyphen of any kind (ASCII, Unicode, full-width) or an underscore */
const JOIN = "[-_\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]";
/** the kinds of a TODO ID (`IddCore-Enhance-69`), as the TODO validator takes them */
const TODO_KINDS = "Feat|Enhance|Bug|Refactor|Perf|Doc|Test|Chore|R2";
/**
 * An ID of the records in any of the forms the repo writes it: a Choice (`C-184-1`, `C-<session>-<n>`); DEC / INV
 * as a bare number (`DEC-001`), a lane (`DEC-088-1`) or a hand-written area name (`DEC-IddCore-2`), the forms the
 * migrated Choices keep; IDD, QA, AC and Q as before; a TODO ID with or without a lane (`IddCore-Enhance-69`,
 * `IddCore-Bug-088-1`). A word that is not one of those is not an ID (so `Dec-2025` and `QA-friendly` are not,
 * and `Q3` is a quarter). A Purpose's ID is found too, as a warning only (`PURPOSE_ID`).
 */
const DEC_INV_ID = `(?:DEC|INV)${JOIN}?(?:\\d+(?:${JOIN}\\d+)?|[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*${JOIN}\\d+)`;
const TODO_ID = `[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*-(?:${TODO_KINDS})-\\d+(?:-\\d+)?`;
/**
 * A Choice's ID as the intent door mints it (`store.ts` `nextChoiceId`): `C-<key>-<n>` with ASCII hyphens, the key a
 * lane's number or a session's id. The two keys are told apart because only the lane's is a shape no other word has:
 * `C-184-1` stops a commit message like any ID of the records, while a session's key is any name, so its shape
 * (`C-claude-desktop-supervisor-20261018-8`: lowercase, two parts or more) is only a warning. `C-API-2`, `C-3` (a PR
 * feedback's ref) and a word that only contains such a shape (`x-C-184-1`, `C-184-1a`) are none of them.
 */
const CHOICE_EDGE_BEFORE = "(?<![A-Za-z0-9_./-])";
const CHOICE_EDGE_AFTER = "(?![A-Za-z0-9_-])";
const CHOICE_LANE_ID = `${CHOICE_EDGE_BEFORE}C-\\d+-\\d+${CHOICE_EDGE_AFTER}`;
const CHOICE_SESSION_ID = `${CHOICE_EDGE_BEFORE}C-[a-z][a-z0-9_.]*(?:-[a-z0-9_.]+)+-\\d+${CHOICE_EDGE_AFTER}`;
const RECORD_ID = `(?:(?<![A-Za-z0-9_])(?:${DEC_INV_ID}|IDD${JOIN}?\\d+|(?:QA|AC|Q)${JOIN}\\d+|${TODO_ID})|${CHOICE_LANE_ID})`;
/**
 * A Purpose's ID (`P-12`). Found in text meant for the public side, but only as a warning: the same shape is a
 * plain name elsewhere (the P-256 curve of a passkey), so it never stops a commit message on its own.
 */
const PURPOSE_ID = `(?<![A-Za-z0-9_])P${JOIN}\\d+(?![A-Za-z0-9_-])`;
const RECORD_IDS = new RegExp(`${RECORD_ID}|${CHOICE_SESSION_ID}|${PURPOSE_ID}`, "g");
/** the words of the workflow, in any case; the longer ones first where one starts with another (`Intent Delta`, `intent`) */
const WORDS = /本[ \u3000]*lane|記録側|\bIntent\s+Delta\b|\b(?:IDD|lane|overlay|intent|records?|planner|executor|triage|R2|Anchors|Waive[sd]?)\b/gi;
/** the two names of the intent records, as names: capitalized (the lowercase words are the plain English ones) */
const RECORD_NAMES = /\b(?:Choice|Purpose)s?\b/g;

/**
 * The record names a repo whose public text is English (`public_language: en`) writes as plain words: a sentence
 * that starts with "Choice" or names a "Purpose" is ordinary English there, and warning about it on every card
 * teaches penne to ignore the warning. The IDs stay found whatever the language.
 */
export const ENGLISH_PLAIN_RECORD_NAMES = ["Choice", "Choices", "Purpose", "Purposes"];

/** the words a repo allows in its public text: its own list, and the record names when it writes in English */
export function publicVocabularyAllow(area: { public_vocabulary_allow?: string[]; public_language?: string } | null | undefined): string[] {
  const own = area?.public_vocabulary_allow ?? [];
  return /^en\b/i.test(area?.public_language ?? "") ? [...own, ...ENGLISH_PLAIN_RECORD_NAMES] : own;
}

/** the TODO IDs (`IddCore-Enhance-70`, `IddCore-Bug-088-1`) a text names, in the order it names them */
export function todoIds(text: string): string[] {
  return [...text.matchAll(new RegExp(TODO_ID, "g"))].map((m) => m[0]);
}

export function internalTerms(text: string, allow: string[] = []): string[] {
  const allowed = new Set(allow.map((w) => w.toLowerCase()));
  const ids = [...text.matchAll(RECORD_IDS)].map((m) => ({ at: m.index, end: m.index + m[0].length, term: m[0] }));
  // a word inside an ID (`IDD` of `IDD-12`, `R2` of `Core-R2-3`) is that ID, not a word of its own
  const words = [...text.matchAll(WORDS), ...text.matchAll(RECORD_NAMES)].map((m) => ({ at: m.index, end: m.index + m[0].length, term: m[0] }))
    .filter((w) => !ids.some((i) => w.at < i.end && i.at < w.end));
  const found: string[] = [];
  for (const { term } of [...ids, ...words].sort((a, b) => a.at - b.at)) {
    if (allowed.has(term.toLowerCase()) || found.includes(term)) continue;
    found.push(term);
  }
  return found;
}

/**
 * The commit message as the pushed commit carries it and as its approval is recorded: the same text for both, with
 * the blank lines and spaces around it dropped. The card names the commit by its first line (`commitSubject`).
 */
export function approvedCommitMessage(message: string | undefined): string {
  return (message ?? "").trim();
}

/** the first line of the commit message as it goes out */
export function commitSubject(message: string | undefined): string {
  return approvedCommitMessage(message).split("\n")[0]?.trim() ?? "";
}

/**
 * The words of the records a commit message cannot go out with (`stopsCommit`): an ID of the records (`RECORD_ID`:
 * a prefix and its number, or a TODO ID) and a name of the workflow (`IDD`, `Intent Delta`, `本 lane`, `記録側`),
 * which no repo's own commit uses. A plain English word (`overlay`, `record`, `intent`, `lane`, and `R2`, which is
 * also Cloudflare R2) is also a word of the repos' own commits ("IllustCrop overlay"), so it is only a warning, shown
 * on the card. `IDD` stops only as the name is written: `idd` (a package name such as `idd-core`) is a warning.
 */
const COMMIT_STOP_ID = new RegExp(`^${RECORD_ID}$`);
const COMMIT_STOP_WORD = /^(?:intent\s+delta|本[ \u3000]*lane|記録側)$/i;
const stopsCommit = (term: string) => COMMIT_STOP_ID.test(term) || term === "IDD" || COMMIT_STOP_WORD.test(term);

/** the words of the records in a commit message the repo does not allow: those that stop its approval, and the warnings */
export function commitVocabulary(message: string, allow: string[] = []): { blocking: string[]; warning: string[] } {
  const terms = internalTerms(message, allow);
  return { blocking: terms.filter(stopsCommit), warning: terms.filter((t) => !stopsCommit(t)) };
}

/**
 * Why penne cannot approve a push's commit message, or null: an empty one, or one with an ID of the records or a
 * name of the workflow the repo does not allow. Unlike the PR text (a warning), this is a gate: the card and the
 * approval refuse it. A plain English word does not stop it (`commitVocabulary`'s warnings).
 */
export function commitMessageProblem(message: string | undefined, allow: string[] = []): string | null {
  if (!(message ?? "").trim()) return "commit message が空です。書いてから承認してください";
  const terms = commitVocabulary(message ?? "", allow).blocking;
  if (terms.length) return `commit message に IDD の語彙が残っています（${terms.join(", ")}）。直してから承認してください`;
  return null;
}

/**
 * A repo's own form of a commit message, declared in its registration (`commit_convention`) beside where the repo
 * says so. The value is declared, not guessed from the history: a precedent is only read to tell the person when it
 * disagrees with the declaration.
 */
export interface CommitConvention {
  /** the types a message may start with (`feat`, `fix`, …) */
  types: string[];
  /** whether `type(scope): summary` is allowed besides `type: summary` */
  scope: boolean;
  /** where the repo says so (a file and its section): shown beside every verdict, so the declaration can be checked */
  source: string;
}

/** how many recent public commits are read as the precedent */
export const PRECEDENT_LIMIT = 20;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** the first line of a message against the declared form: `type: summary`, or `type(scope): summary` when allowed */
export function matchesCommitConvention(convention: CommitConvention, message: string | undefined): boolean {
  const types = convention.types.map(escapeRegExp).join("|");
  return new RegExp(`^(?:${types})${convention.scope ? "(?:\\([^)\\s][^)]*\\))?" : ""}: \\S`).test(commitSubject(message));
}

/** the form as a person reads it: `feat / fix のいずれか: 要約`, with `(scope) も可` for every type when allowed */
export function describeCommitConvention(convention: CommitConvention): string {
  return `${convention.types.join(" / ")} のいずれか: 要約${convention.scope ? "（(scope) も可）" : ""}`;
}

/**
 * The card's line on the commit message that goes out: whether its first line is in the repo's declared form, and
 * why. When the recent public commits (`precedents`, their subjects) do not follow the declaration, the line says so in
 * the same reason, whatever the verdict: the declaration is the repo's word and the team's practice is what happens, so
 * a person decides which is right, and the machine neither follows the precedent nor hides the difference. Not a gate:
 * the approval does not read this. A message that does not exist yet is not judged (never a pass).
 */
export function commitConventionCheck(
  convention: CommitConvention,
  message: string | undefined,
  precedents: readonly string[] = [],
): { ok: boolean; label: string; reason: string } {
  const form = `${describeCommitConvention(convention)}（${convention.source}）`;
  const read = precedents.filter((p) => !/^Merge /.test(p));
  const apart = read.filter((p) => !matchesCommitConvention(convention, p));
  const precedent = apart.length
    ? `直近の公開 commit ${read.length} 件のうち ${apart.length} 件は宣言の形に沿っていません（例: 「${apart[0]}」）。宣言と前例のどちらが今のやり方か確かめてください`
    : "";
  const reason = (head: string) => [head, precedent].filter(Boolean).join("。");
  if (!approvedCommitMessage(message)) {
    return { ok: false, label: "commit message の規約: まだ見ていない", reason: reason(`commit message ができると宣言の形に当てます。宣言: ${form}`) };
  }
  if (matchesCommitConvention(convention, message)) {
    return { ok: true, label: "commit message が規約に沿う", reason: reason(`宣言の形に沿っています: ${form}`) };
  }
  return { ok: false, label: "commit message が規約に沿わない", reason: reason(`1 行目「${commitSubject(message)}」は宣言の形に沿っていません: ${form}`) };
}
