// qa の Round の欄の読み方。validate-qa（欄の検査）と validate-intent-delta（足した Round の Risk）が同じ読み方を使う。
// 欄は頭に固定して読む: 文の途中の語や ID を欄の値に数えない。

/** one field of a round, read on its own line: `[ \t]*` keeps an empty field from reading the next line */
export const roundField = (
  block: string,
  name: string,
): string | undefined =>
  block.match(new RegExp(`\\*\\*${name}\\*\\*:[ \\t]*(.*)$`, "m"))?.[1]
    ?.trim();

/**
 * The Risk a round declares: one of the four words at the head of the field, followed by a space, a bracket or the
 * end of the field (`High（理由）`), so `Highではない` is no Risk.
 */
export const roundRiskWord = (block: string): string | undefined =>
  roundField(block, "Risk")?.match(
    /^(Low|Medium|High|Critical)(?=$|[\s（(])/,
  )?.[1];

/** the date a round heading carries, as YYYY-MM-DD: `2026-10-25` and `2026/10/25` are one date */
export const roundHeadingDate = (heading: string): string | null => {
  const m = heading.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
