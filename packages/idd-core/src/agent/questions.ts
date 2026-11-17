/**
 * The shape of the questions an agent (planner / executor) asks through `POST /api/idd/agent/questions`.
 * Each option may carry how strongly the agent recommends it and why, so penne can answer
 * without re-deriving the trade-offs. Options without them (the older form) are still accepted.
 */

export const RECOMMENDATIONS = ["recommended", "acceptable", "not_recommended"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

/** the words the UI shows for each level */
export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  recommended: "推奨",
  acceptable: "可",
  not_recommended: "非推奨",
};

// agents sometimes answer in the words they read in the brief rather than the key.
// A Map, so names every object carries ("__proto__", "constructor") are never read as a level.
const ALIASES = new Map<string, Recommendation>([
  ["recommended", "recommended"],
  ["recommend", "recommended"],
  ["推奨", "recommended"],
  ["acceptable", "acceptable"],
  ["ok", "acceptable"],
  ["可", "acceptable"],
  ["not_recommended", "not_recommended"],
  ["not-recommended", "not_recommended"],
  ["discouraged", "not_recommended"],
  ["非推奨", "not_recommended"],
]);

/** the longest a choice's label may be, counted in characters (code points); the briefs say the same number */
export const OPTION_LABEL_MAX = 40;

export interface AskedOption {
  index: number;
  label: string;
  description?: string;
  recommendation?: Recommendation;
  rationale?: string;
}

export interface AskedQuestion {
  question_id: string;
  question: string;
  context?: string;
  options: AskedOption[];
}

/** the CLI verb the briefs show for asking; the lane and token come from the environment, not the arguments */
export const REPORT_QUESTIONS_USAGE = "idd report questions --file questions.json";

/** the JSON the questions verb reads: one batch, 1-5 questions, 1-5 options each */
export const QUESTIONS_JSON_SHAPE =
  `{"questions":[{"question_id","question","context","options":[{"index","label","description","recommendation":"recommended|acceptable|not_recommended","rationale"}]}]}`;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function normalizeOption(raw: unknown, where: string): AskedOption | string {
  if (!raw || typeof raw !== "object") return `${where}: option must be an object`;
  const o = raw as Record<string, unknown>;
  const label = str(o.label);
  if (!label) return `${where}: label is required`;
  const labelLength = Array.from(label).length;
  if (labelLength > OPTION_LABEL_MAX) return `${where}: label は ${OPTION_LABEL_MAX} 文字までです（${labelLength} 文字）`;
  if (typeof o.index !== "number" || !Number.isFinite(o.index)) return `${where}: index must be a number`;
  const option: AskedOption = { index: o.index, label };
  const description = str(o.description);
  if (description) option.description = description;

  const rationale = str(o.rationale);
  if (o.recommendation !== undefined && o.recommendation !== null) {
    const key = typeof o.recommendation === "string" ? o.recommendation.trim().toLowerCase() : "";
    const level = ALIASES.get(key);
    if (!level) return `${where}: recommendation must be one of ${RECOMMENDATIONS.join(" / ")}`;
    if (!rationale) return `${where}: rationale is required with a recommendation`;
    option.recommendation = level;
  }
  if (rationale) option.rationale = rationale;
  return option;
}

/** validate the agent's payload; the stored batch keeps only the known fields */
export function normalizeQuestions(raw: unknown): { ok: true; questions: AskedQuestion[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "questions must not be empty" };
  const questions: AskedQuestion[] = [];
  for (const [qi, item] of raw.entries()) {
    const where = `questions[${qi}]`;
    if (!item || typeof item !== "object") return { ok: false, error: `${where}: question must be an object` };
    const q = item as Record<string, unknown>;
    const questionId = str(q.question_id);
    const question = str(q.question);
    if (!questionId) return { ok: false, error: `${where}: question_id is required` };
    // an answer is looked up by (lane, batch, question_id), so two questions with one id cannot each have their own
    // answer: one answer would settle both and the batch would close with a question unanswered
    const earlier = questions.findIndex((x) => x.question_id === questionId);
    if (earlier >= 0) return { ok: false, error: `${where}: question_id「${questionId}」は questions[${earlier}] と重なっています。質問ごとに別の id を付けて聞き直してください` };
    if (!question) return { ok: false, error: `${where}: question is required` };
    if (!Array.isArray(q.options)) return { ok: false, error: `${where}: options must be an array` };
    const options: AskedOption[] = [];
    for (const [oi, rawOption] of q.options.entries()) {
      const option = normalizeOption(rawOption, `${where}.options[${oi}]`);
      if (typeof option === "string") return { ok: false, error: option };
      options.push(option);
    }
    // the card fills the chip of the recommended option: two of them would say nothing
    if (options.filter((o) => o.recommendation === "recommended").length > 1) {
      return { ok: false, error: `${where}: at most 1 option may be recommended` };
    }
    const context = typeof q.context === "string" ? q.context : undefined;
    questions.push({ question_id: questionId, question, ...(context !== undefined ? { context } : {}), options });
  }
  return { ok: true, questions };
}
