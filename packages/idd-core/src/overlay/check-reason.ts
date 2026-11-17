/**
 * What a check's record says about itself, read once for every place that names a check: the screens' cards, the
 * engine's state and the landing's refusal. No Node imports here, so the cards can use the same functions.
 */

/**
 * What a failed check found when the same check was run at the public base (the tip of the public side the head's tree
 * is built on, without the records): whether the lane made the failure or found it there. Written by the submit's
 * checks (`check-base.ts`) on a required public check that failed at the head. Only a check that names its failures
 * (`failure_id_pattern`) is compared, by the failures each run named; any other is `unknown` and holds.
 */
export interface CheckBaseline {
  /** the public base commit the check was run at; absent when no run there was made */
  commit?: string;
  /** new: the lane made it fail (or added failures); preexisting: the base fails on the same; unknown: not compared */
  verdict: "new" | "preexisting" | "unknown";
  /** the failures the head names that the base does not */
  added?: string[];
  /** how many failures the head shares with the base */
  shared?: number;
  /** why it was not compared (unknown) */
  reason?: string;
}

/** what the readers need of a check; `GateCheck` fits without importing it */
export interface CheckLike {
  name: string;
  status: string;
  severity: string;
  detail?: string;
  baseline?: CheckBaseline;
}

/** a failed check that fails on the same failures at the public base: it is shown, and it does not hold the signature */
export function failingAtBase(check: CheckLike): boolean {
  return check.status === "fail" && check.baseline?.verdict === "preexisting";
}

/**
 * Whether the check holds the signature: blocking, neither passed nor not applicable, and not a failure the public
 * base has as well. The one reading `blockingCount` (the record's count) and `blockingFailures` (the card) share.
 */
export function holdsSignature(check: CheckLike): boolean {
  return check.severity === "blocking" && check.status !== "pass" && check.status !== "not-applicable" && !failingAtBase(check);
}

/** how many failure names one phrase lists before it counts the rest */
const IDS_LISTED = 3;

/**
 * What the comparison with the public base found, as a phrase for the card and the hold's reason; empty when the
 * check was not compared.
 */
export function baselinePhrase(baseline: CheckBaseline | undefined): string {
  if (!baseline) return "";
  const at = baseline.commit ? `公開 base の先端 ${baseline.commit.slice(0, 9)}` : "公開 base";
  if (baseline.verdict === "unknown") return baseline.commit ? `${at} と比べられない（${baseline.reason ?? "理由不明"}）` : (baseline.reason ?? "公開 base と比べていない");
  if (baseline.verdict === "preexisting") return `元から落ちている（${at} でも同じ ${baseline.shared ?? 0} 件が落ちる）`;
  const added = baseline.added ?? [];
  if (!added.length) return `この lane で新しく落ちた（${at} では通る）`;
  const shown = added.slice(0, IDS_LISTED).join("、");
  const rest = added.length > IDS_LISTED ? ` ほか ${added.length - IDS_LISTED} 件` : "";
  const shared = baseline.shared ? `。${at} でも落ちる ${baseline.shared} 件は除く` : "";
  return `この lane で新しく落ちた ${added.length} 件（${shown}${rest}${shared}）`;
}

/**
 * The line of a failed check's output that says why, read from the tail a record keeps. A record keeps only the
 * last 1,500 characters of a check's output, so its first line can be cut. The intent checker's findings are
 * `<weight> <rule> <id>: <reason>` lines and its count line (`error N 件、…`) also starts with `error`, so an
 * `error` finding line is looked for first and the count line only stands in when no finding line survived the
 * cut. Output with neither (the docs checker's `check-docs: FAILED: …`) is read from its last non-empty line.
 * Never empty: with no line at all the status stands in.
 */
export function checkReason(detail: string | undefined, status: string): string {
  const lines = (detail ?? "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
  const finding = lines.find((line) => line.startsWith("error ") && !/^error\s+\d+\s*件/.test(line));
  if (finding) return finding;
  const count = lines.find((line) => /^error\s+\d+\s*件/.test(line));
  if (count) return count;
  return lines.length ? lines[lines.length - 1] : status;
}

/** one check that holds the signature, with the line of its output that says why */
export interface BlockingFailure {
  name: string;
  status: string;
  reason: string;
}

/**
 * The checks that hold the signature, in the record's own order: `blocking` and neither passed nor not applicable,
 * and not failing on the same failures at the public base (`holdsSignature`, the same reading as `blockingCount`). A check
 * compared with the base says what the comparison found before its own reason. A check that did not run (`skipped`:
 * no command, a failed preparation, no `timeout(1)`) holds it as much as a failed one, so it is named too. Decided by
 * severity, status and the base's comparison only, never by the check's name.
 */
export function blockingFailures(checks: readonly CheckLike[] | undefined | null): BlockingFailure[] {
  return (checks ?? [])
    .filter(holdsSignature)
    .map((check) => {
      const reason = checkReason(check.detail, check.status);
      const phrase = baselinePhrase(check.baseline);
      return { name: check.name, status: check.status, reason: phrase ? `${phrase}: ${reason}` : reason };
    });
}

/** the longest a reason is carried into one line of a sentence */
const REASON_LIMIT = 160;
/** how many checks one sentence names before it counts the rest */
const NAMED_LIMIT = 3;

/** one blocking check as a phrase: its name, and why it holds the signature */
export function blockingPhrase(failure: BlockingFailure): string {
  const reason = failure.reason.length > REASON_LIMIT ? `${failure.reason.slice(0, REASON_LIMIT)}…` : failure.reason;
  const said = failure.status === "skipped" ? (reason === "skipped" ? "未実行" : `未実行: ${reason}`) : reason;
  return `${failure.name}（${said}）`;
}

/**
 * Why the signature is held by checks, as one sentence that names them. A record of the older shape that kept only
 * the count (`count` and no checks to read) can still say how many; a record with its checks never says only a count.
 */
export function blockingWhy(count: number, checks: readonly CheckLike[] | undefined | null): string {
  const failures = blockingFailures(checks);
  if (!failures.length) return `止める検査が ${count} 件あります`;
  const named = failures.slice(0, NAMED_LIMIT).map(blockingPhrase).join("、");
  const rest = failures.length - NAMED_LIMIT;
  return `止めている検査: ${named}${rest > 0 ? ` ほか ${rest} 件` : ""}`;
}

/** how many checks that moved a reason names before it counts the rest */
const CHANGES_LISTED = 5;

/** a check of the same head compared with the one before it: when that was, and what moved */
export interface CheckChange { at?: string; changed: boolean; changes: string[] }

/**
 * Whether the checks found the same as the check of the same head before them: compared by each check's name, severity
 * and status (the time a check took, and the tail of its output, differ between runs that found the same). Not a verdict
 * on the lane; it is what the card says so that a check run again that changed nothing does not read as nothing
 * happening. A submit record and a land record are compared by this one rule.
 */
export function compareChecks(before: { checks: readonly CheckLike[]; checkedAt?: string }, now: readonly CheckLike[]): CheckChange {
  const was = new Map(before.checks.map((c) => [c.name, `${c.severity}:${c.status}`]));
  const is = new Map(now.map((c) => [c.name, `${c.severity}:${c.status}`]));
  const changes: string[] = [];
  for (const name of new Set([...was.keys(), ...is.keys()])) {
    const a = was.get(name), b = is.get(name);
    if (a !== b) changes.push(`${name}: ${a?.split(":")[1] ?? "なし"} → ${b?.split(":")[1] ?? "なし"}`);
  }
  return { ...(before.checkedAt ? { at: before.checkedAt } : {}), changed: changes.length > 0, changes: changes.slice(0, CHANGES_LISTED) };
}
