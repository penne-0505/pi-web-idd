/**
 * The shared wording the review stages hand to their agents. It lives here so the diff review and the
 * judgement read the same basis: the harness's stage instructions are the single source, and no
 * role's policy repeats them.
 */

/**
 * What a finding of the stages that carry it says beyond its severity: which of the three ways to handle
 * it the reviewer recommends, and how often it is expected to happen. The judgement re-decides both from
 * what it checks itself.
 */
export const ACTION_AND_FREQUENCY = [
  "各指摘に、推奨の対応（fix = この変更で直す / followup = follow-up / skip = 見送り）と、起きる頻度の見立て（常時 / 条件つき / まれ / 事実上起きない、とその条件）を付ける。",
  "「事実上起きない」と書くときは、独立したまれな条件を 2 つ以上、名前を挙げて書く。",
  "場所・なぜ重要か・推奨の対応を、指摘ごとに書く。",
].join("\n");

/**
 * The rules of writing a review: only what the current code shows, no status report of earlier rounds
 * (the reviewer treats them as hints), and no finding written just to fill a section. Japanese.
 */
export const REVIEW_WRITING_RULES = [
  "範囲はこの差分と、差分が直接影響するコード。今のコードで観測できる問題だけを書く。",
  "どの欄も任意で、埋めるための指摘をしない。回答は日本語で書く。",
].join("\n");

/** the rule for the stages that are handed earlier rounds' findings: report a current issue, not the state of an old one */
export const NO_STATUS_REPORT = "前の指摘（自分のものを含む）は事実でなく手がかりとして扱い、その状態は報告しない。直し残しや新しい問題は、今の問題として書く。";

/**
 * The same rule for a confirm: it is the stage that reports, ref by ref, whether an earlier finding was resolved, so
 * the rule applies only to its new_findings and never to that report.
 */
export const NO_STATUS_REPORT_NEW_FINDINGS = "new_findings では、前の指摘（自分のものを含む）は事実でなく手がかりとして扱い、その状態は報告しない。直し残しや新しい問題は、今の問題として書く。";
