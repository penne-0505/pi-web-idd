// Deno版 QA document validator: npm / remote import 依存なし

import { loadScope, makeInScope } from "./scope.ts";

type YamlValue = string | number | boolean | YamlValue[];
type FrontMatter = Record<string, YamlValue>;

type FrontMatterParseResult = {
  attrs: FrontMatter | null;
  error: string | null;
};

type ValidationItem = {
  file: string;
  message: string;
};

type TodoTask = {
  fields: Record<string, string>;
};

type ParsedArgs = {
  roots: string[];
  fixtureMode: boolean;
};

type ValidateTestPlanParams = {
  file: string;
  src: string;
  attrs: FrontMatter;
  area: string;
  slug: string;
  errors: ValidationItem[];
  warnings: ValidationItem[];
};

type ValidateVerificationParams = {
  file: string;
  src: string;
  attrs: FrontMatter;
  area: string;
  slug: string;
  errors: ValidationItem[];
};

type EffectiveQaMatchParams = {
  file: string;
  src: string;
  attrs: FrontMatter;
  fixtureMode: boolean;
  errors: ValidationItem[];
};

type Verdict = "PASS" | "PARTIAL" | "FAIL" | "BLOCKED";

// 未初期化 template では TODO.md が starter/ 側にあり root に無い。
// env 未設定なら展開後の既定 (root) を保つ。読み取り権限が無い場合も既定へ倒す。
const TODO_FILE = (() => {
  try {
    return Deno.env.get("DD_TODO_FILE")?.trim() || "TODO.md";
  } catch {
    return "TODO.md";
  }
})();
const QA_SCHEMAS = [2, 3, 4, 5] as const;
// qa_schema 5 = 統合 qa.md (Checks + 追記専用 Rounds、Intent Delta / R2 / Verdict)。
// Transferable Principles は撤去 (issue #17): 節があっても無視、無くても error にしない。
const UNIFIED_SCHEMA = 5;
const isWhyFirstSchema = (value: YamlValue | undefined): boolean =>
  QA_SCHEMAS.some((schema) => schema === value);
const RISKS = ["Low", "Medium", "High", "Critical"] as const;
const QA_STATUS_VALUES = [
  "planned",
  "in-progress",
  "verified",
  "partial",
  "failed",
  "blocked",
] as const;
const TEST_MATRIX_STATUS_VALUES = [
  "planned",
  "covered",
  "verified",
  "deferred",
  "not-applicable",
] as const;
const VERDICTS = ["PASS", "PARTIAL", "FAIL", "BLOCKED"] as const;
const VERDICT_STATUS: Record<Verdict, string> = {
  PASS: "verified",
  PARTIAL: "partial",
  FAIL: "failed",
  BLOCKED: "blocked",
};
const QA_PATH_RE =
  /^_docs\/qa\/([A-Za-z][A-Za-z0-9-]*)\/(?:([a-z0-9]+(?:-[a-z0-9]+)*)\/(test-plan|verification|qa)\.md|(maintenance)\.md)$/;
const qaKindOf = (match: RegExpMatchArray): string => match[4] ?? match[3];
const TODO_FIELD_RE = /^- \*\*([A-Za-z][A-Za-z ]*)\*\*:\s*(.*)$/;

const normalizePath = (path: string): string => {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
};

const walkFiles = async function* (
  dir: string,
  predicate: (path: string) => boolean = () => true,
): AsyncGenerator<string> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        yield* walkFiles(path, predicate);
      } else if (entry.isFile && predicate(path)) {
        yield normalizePath(path);
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
};

const exists = async (path: string): Promise<boolean> => {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
};

const fileOrDir = async (path: string): Promise<"file" | "dir"> => {
  const stat = await Deno.stat(path);
  return stat.isFile ? "file" : "dir";
};

const stripCodeBlocks = (src: string): string => {
  const output: string[] = [];
  let inFence = false;
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      output.push("");
      continue;
    }
    output.push(inFence ? "" : line);
  }
  return output.join("\n");
};

const stripInlineComment = (value: string): string => {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && value[i - 1] !== "\\") {
      quote = quote === ch ? null : quote ?? ch;
    }
    if (ch === "#" && quote === null) return value.slice(0, i).trim();
  }
  return value.trim();
};

const splitInlineArray = (value: string): string[] => {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of value) {
    if ((ch === '"' || ch === "'") && current.at(-1) !== "\\") {
      quote = quote === ch ? null : quote ?? ch;
    }
    if (ch === "," && quote === null) {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") items.push(current.trim());
  return items;
};

const parseScalar = (raw: string): YamlValue => {
  const value = stripInlineComment(raw);
  if (value === "") return "";
  if (value === "[]") return [];
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return splitInlineArray(inner).map(parseScalar);
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
};

const parseFrontMatter = (src: string): FrontMatterParseResult => {
  const lines = src.split(/\r?\n/);
  if (lines[0] !== "---") return { attrs: null, error: "missing front matter" };
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end === -1) return { attrs: null, error: "front matter is not closed" };

  const attrs: FrontMatter = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/);
    if (!match) {
      return { attrs: null, error: `unsupported front matter line: ${line}` };
    }
    const [, key, rest = ""] = match;
    if (rest.trim() !== "") {
      attrs[key] = parseScalar(rest);
      continue;
    }
    const values: YamlValue[] = [];
    let cursor = i + 1;
    while (cursor < end) {
      const item = lines[cursor].match(/^\s+-\s+(.*)$/);
      if (!item) break;
      values.push(parseScalar(item[1]));
      cursor += 1;
    }
    if (values.length > 0) {
      attrs[key] = values;
      i = cursor - 1;
    } else {
      attrs[key] = "";
    }
  }
  return { attrs, error: null };
};

const normalizeInlineCode = (value: string | undefined): string => {
  const trimmed = (value ?? "").trim();
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const sectionContent = (src: string, heading: string): string | null => {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) =>
    index > start && /^##\s+/.test(line)
  );
  return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");
};

const hasSubstantiveContent = (content: string | null): boolean => {
  if (!content) return false;
  const withoutEmptyTables = stripCodeBlocks(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (line === "") return false;
      if (/^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line)) {
        return false;
      }
      if (/^\|\s*\|\s*\|/.test(line)) return false;
      if (
        /^\|\s*(Command \/ Test|Checklist Item|ID)\s*\|\s*(Result|Reason)\s*\|/i
          .test(line)
      ) {
        return false;
      }
      return true;
    })
    .join("\n");
  const cleaned = withoutEmptyTables
    .replace(/\|/g, " ")
    .replace(/[-:#`]/g, " ")
    .replace(/\b(None|N\/A|なし|未実施|command|result summary)\b/gi, " ")
    .trim();
  return /[A-Za-z0-9一-龠ぁ-んァ-ン]/.test(cleaned);
};

const referencesInclude = (attrs: FrontMatter, path: string): boolean =>
  Array.isArray(attrs.references) && attrs.references.includes(path);

const add = (
  items: ValidationItem[],
  file: string,
  message: string,
): void => {
  items.push({ file, message });
};

const validateFrontMatter = (
  file: string,
  attrs: FrontMatter,
  errors: ValidationItem[],
): void => {
  for (
    const key of [
      "title",
      "status",
      "qa_status",
      "risk",
      "created_at",
      "updated_at",
      "references",
      "related_issues",
      "related_prs",
    ] as const
  ) {
    if (!(key in attrs)) {
      add(errors, file, `missing front matter field: ${key}`);
    }
  }
  if ("qa_schema" in attrs && !isWhyFirstSchema(attrs.qa_schema)) {
    add(errors, file, `qa_schema must be one of ${QA_SCHEMAS.join(", ")}`);
  }
  if (
    typeof attrs.qa_status === "string" &&
    attrs.qa_status &&
    !(QA_STATUS_VALUES as readonly string[]).includes(attrs.qa_status)
  ) {
    add(
      errors,
      file,
      `qa_status must be one of ${QA_STATUS_VALUES.join(", ")}`,
    );
  }
  if (
    typeof attrs.risk === "string" &&
    attrs.risk &&
    !(RISKS as readonly string[]).includes(attrs.risk)
  ) {
    add(errors, file, `risk must be one of ${RISKS.join(", ")}`);
  }
  if (!Array.isArray(attrs.references)) {
    add(errors, file, "references must be an array");
  }
};

type ValidateUnifiedQaParams = {
  file: string;
  src: string;
  attrs: FrontMatter;
  errors: ValidationItem[];
  warnings: ValidationItem[];
};

const validateUnifiedQa = (
  { file, src, attrs, errors, warnings }: ValidateUnifiedQaParams,
): void => {
  if (attrs.qa_schema !== UNIFIED_SCHEMA) {
    add(
      warnings,
      file,
      `legacy qa.md: migrate to the unified qa.md (qa_schema: ${UNIFIED_SCHEMA}) when its meaning next changes`,
    );
  }

  const isMaintenance = file.endsWith("maintenance.md") ||
    (typeof attrs.fixture_path === "string" &&
      attrs.fixture_path.endsWith("maintenance.md"));
  const requiredHeadings = isMaintenance
    ? ["Rounds"]
    : ["Acceptance Criteria", "Checks", "Rounds"];
  for (const heading of requiredHeadings) {
    if (sectionContent(src, heading) === null) {
      add(
        errors,
        file,
        `qa_schema ${UNIFIED_SCHEMA} missing heading: ${heading}`,
      );
    }
  }

  const rounds = sectionContent(src, "Rounds") ?? "";
  const roundBlocks = rounds.split(/^###\s+Round\b.*$/m).slice(1);
  if (roundBlocks.length === 0) {
    if (attrs.qa_status !== "planned" && attrs.qa_status !== "in-progress") {
      add(
        errors,
        file,
        "qa_status beyond in-progress requires at least one Round",
      );
    }
    return;
  }

  const roundHeadings = [...rounds.matchAll(/^###\s+Round\b.*$/gm)].map((
    match,
  ) => match[0]);
  let lastVerdict: string | null = null;
  for (const [index, block] of roundBlocks.entries()) {
    const label = `Round ${index + 1}`;
    const delta = block.match(/\*\*Intent Delta\*\*:\s*(.+)$/m)?.[1]?.trim();
    const createsDec = delta !== undefined && /新設/.test(delta);
    if (!delta) {
      add(errors, file, `${label}: missing Intent Delta`);
    } else if (
      !/DEC-\d+/.test(delta) && !/^None:\s*\S/.test(delta)
    ) {
      add(
        errors,
        file,
        `${label}: Intent Delta must reference a DEC or be "None: <reason>"`,
      );
    }
    if (isMaintenance && createsDec) {
      add(
        errors,
        file,
        `${label}: DEC-creating rounds belong in a dedicated qa.md, not maintenance.md`,
      );
    }
    const r2 = block.match(/\*\*R2\*\*:\s*(.+)$/m)?.[1]?.trim();
    if (!r2) {
      add(
        errors,
        file,
        `${label}: missing R2 (write 非発動 when the trigger conditions do not apply)`,
      );
    } else {
      const highRisk = attrs.risk === "High" || attrs.risk === "Critical";
      if (/非発動/.test(r2) && (createsDec || highRisk)) {
        add(
          errors,
          file,
          `${label}: R2 must not be 非発動 when the round creates a DEC or risk is High/Critical`,
        );
      }
      if (/PENDING/.test(r2)) {
        const dateMatch = roundHeadings[index]?.match(/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          const age = (Date.now() - new Date(dateMatch[1]).getTime()) /
            (24 * 60 * 60 * 1000);
          if (age > 30) {
            add(
              warnings,
              file,
              `${label}: R2 has been PENDING for ${
                Math.floor(age)
              } days — the reconstruction task may be stalled`,
            );
          }
        }
      }
    }
    const verdict = block.match(/\*\*Verdict\*\*:\s*(\S+)/m)?.[1];
    if (!verdict || !(VERDICTS as readonly string[]).includes(verdict)) {
      add(
        errors,
        file,
        `${label}: Verdict must be one of ${VERDICTS.join(", ")}`,
      );
    } else {
      lastVerdict = verdict;
    }
  }

  if (
    !isMaintenance && lastVerdict &&
    typeof attrs.qa_status === "string" &&
    attrs.qa_status !== VERDICT_STATUS[lastVerdict as Verdict]
  ) {
    add(
      errors,
      file,
      `qa_status must match the last round verdict (${lastVerdict} -> ${
        VERDICT_STATUS[lastVerdict as Verdict]
      })`,
    );
  }
};

const validateTestMatrix = (
  file: string,
  src: string,
  errors: ValidationItem[],
  warnings: ValidationItem[],
): void => {
  const matrix = sectionContent(src, "Test Matrix");
  if (matrix === null) return;
  const rows = matrix
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && /AC-|INV-/.test(line));

  if (!rows.some((row) => /\bAC-\d{3}\b/.test(row))) {
    add(errors, file, "Test Matrix must include at least one AC- row");
  }

  for (const row of rows) {
    const cells = row.split("|").map((cell) => cell.trim()).filter(Boolean);
    const status = cells.at(-1);
    if (
      status &&
      !(TEST_MATRIX_STATUS_VALUES as readonly string[]).includes(status)
    ) {
      add(
        errors,
        file,
        `Test Matrix status must be one of ${
          TEST_MATRIX_STATUS_VALUES.join(", ")
        }`,
      );
    }
    if (status === "deferred") {
      add(warnings, file, "deferred Test Matrix rows must document a reason");
    }
  }
};

const validateTestPlan = async ({
  file,
  src,
  attrs,
  area,
  slug,
  errors,
  warnings,
}: ValidateTestPlanParams): Promise<void> => {
  const usesWhyFirstSchema = isWhyFirstSchema(attrs.qa_schema);

  if (
    typeof attrs.qa_status === "string" &&
    !["planned", "in-progress"].includes(attrs.qa_status)
  ) {
    add(
      errors,
      file,
      "test-plan qa_status must be planned or in-progress",
    );
  }

  const requiredHeadings = [
    "Source of Intent",
    ...(usesWhyFirstSchema ? ["Decision Review Scope"] : []),
    "Quality Goal",
    "Acceptance Criteria",
    "Intent-derived Invariants",
    "Risk Assessment",
    "Test Strategy",
    "Test Matrix",
    "Manual QA Checklist",
    "Regression Checklist",
    "Out of Scope",
    "Open Questions",
  ];
  for (const heading of requiredHeadings) {
    if (sectionContent(src, heading) === null) {
      add(errors, file, `missing heading: ${heading}`);
    }
  }

  const intentPath = `_docs/intent/${area}/${slug}/decision.md`;
  const planPath = `_docs/plan/${area}/${slug}/plan.md`;
  if (!referencesInclude(attrs, intentPath)) {
    add(errors, file, `references must include ${intentPath}`);
  }
  if (await exists(planPath) && !referencesInclude(attrs, planPath)) {
    add(errors, file, `references must include existing plan ${planPath}`);
  }

  const ac = sectionContent(src, "Acceptance Criteria") ?? "";
  if (!/\bAC-\d{3}\b/.test(ac)) {
    add(errors, file, "Acceptance Criteria must include AC-001 style IDs");
  }

  if (
    usesWhyFirstSchema &&
    !sectionHasId(src, "Decision Review Scope", "DEC")
  ) {
    add(errors, file, "Decision Review Scope must include DEC-001 style IDs");
  }

  const invariants = sectionContent(src, "Intent-derived Invariants") ?? "";
  if (
    usesWhyFirstSchema &&
    !isExplicitNone(invariants) &&
    !/\bINV-\d{3}\b/.test(invariants)
  ) {
    add(
      errors,
      file,
      "Intent-derived Invariants must be None or include INV-001 style IDs",
    );
  } else if (!usesWhyFirstSchema && !/\bINV-\d{3}\b/.test(invariants)) {
    add(
      errors,
      file,
      "Intent-derived Invariants must include INV-001 style IDs",
    );
  }
  validateTestMatrix(file, src, errors, warnings);

  if (
    typeof attrs.risk === "string" &&
    ["High", "Critical"].includes(attrs.risk)
  ) {
    const highRisk = sectionContent(src, "High-risk Checklist");
    if (highRisk === null) {
      add(errors, file, "Risk High/Critical requires High-risk Checklist");
    } else {
      for (const term of ["rollback", "recovery", "data safety", "security"]) {
        if (!new RegExp(term, "i").test(highRisk)) {
          add(errors, file, `High-risk Checklist must mention ${term}`);
        }
      }
    }
  }
};

const sectionHasId = (src: string, heading: string, prefix: string): boolean =>
  new RegExp(`\\b${prefix}-\\d{3}\\b`).test(sectionContent(src, heading) ?? "");

const isNoneLike = (content: string): boolean => {
  const cleaned = stripCodeBlocks(content ?? "")
    .replace(/\|/g, " ")
    .replace(/[-:#`]/g, " ")
    .trim();
  return cleaned === "" || /^(None|N\/A|なし)$/i.test(cleaned);
};

const isExplicitNone = (content: string): boolean => {
  const cleaned = stripCodeBlocks(content ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  return /^(?:[-*]\s*)?(None|N\/A|なし)$/i.test(cleaned);
};

const validateVerification = ({
  file,
  src,
  attrs,
  area,
  slug,
  errors,
}: ValidateVerificationParams): void => {
  const usesWhyFirstSchema = isWhyFirstSchema(attrs.qa_schema);
  const requiredHeadings = [
    "Summary",
    "Verification Verdict",
    "Commands Run",
    "Automated Test Results",
    "Manual QA Results",
    "Acceptance Criteria Coverage",
    ...(usesWhyFirstSchema ? ["Decision Conformance"] : []),
    "Invariant Coverage",
    "Deferred / Not Covered",
    "Residual Risks",
    "Follow-up TODOs",
  ];
  for (const heading of requiredHeadings) {
    if (sectionContent(src, heading) === null) {
      add(errors, file, `missing heading: ${heading}`);
    }
  }

  const testPlanPath = `_docs/qa/${area}/${slug}/test-plan.md`;
  const intentPath = `_docs/intent/${area}/${slug}/decision.md`;
  if (!referencesInclude(attrs, testPlanPath)) {
    add(errors, file, `references must include ${testPlanPath}`);
  }
  if (!referencesInclude(attrs, intentPath)) {
    add(errors, file, `references must include ${intentPath}`);
  }

  const verdictSection = sectionContent(src, "Verification Verdict") ?? src;
  const verdict = verdictSection.match(
    /\bVerdict:\s*(PASS|PARTIAL|FAIL|BLOCKED)\b/,
  )
    ?.[1] as Verdict | undefined;
  if (!verdict || !(VERDICTS as readonly string[]).includes(verdict)) {
    add(errors, file, `Verdict must be one of ${VERDICTS.join(", ")}`);
  } else {
    const expectedStatus = VERDICT_STATUS[verdict];
    if (attrs.qa_status !== expectedStatus) {
      add(
        errors,
        file,
        `qa_status "${attrs.qa_status}" does not match Verdict "${verdict}"; expected "${expectedStatus}"`,
      );
    }
  }
  if (
    typeof attrs.qa_status === "string" &&
    !["verified", "partial", "failed", "blocked"].includes(attrs.qa_status)
  ) {
    add(
      errors,
      file,
      "verification qa_status must be verified, partial, failed, or blocked",
    );
  }

  const residual = sectionContent(src, "Residual Risks") ?? "";
  const followUps = sectionContent(src, "Follow-up TODOs") ?? "";
  if (verdict === "PASS" && !isNoneLike(residual)) {
    add(
      errors,
      file,
      "PASS verification must have empty or None residual risks",
    );
  }
  if (
    verdict &&
    (["PARTIAL", "FAIL", "BLOCKED"] as readonly string[]).includes(verdict) &&
    !hasSubstantiveContent(residual) &&
    !hasSubstantiveContent(followUps)
  ) {
    add(
      errors,
      file,
      "PARTIAL/FAIL/BLOCKED requires residual risks or follow-up TODOs",
    );
  }

  if (!sectionHasId(src, "Acceptance Criteria Coverage", "AC")) {
    add(errors, file, "Acceptance Criteria Coverage must include AC- IDs");
  }

  if (
    usesWhyFirstSchema &&
    !sectionHasId(src, "Decision Conformance", "DEC")
  ) {
    add(errors, file, "Decision Conformance must include DEC- IDs");
  }

  const invariantCoverage = sectionContent(src, "Invariant Coverage") ?? "";
  if (
    usesWhyFirstSchema &&
    !isExplicitNone(invariantCoverage) &&
    !sectionHasId(src, "Invariant Coverage", "INV")
  ) {
    add(errors, file, "Invariant Coverage must be None or include INV- IDs");
  } else if (
    !usesWhyFirstSchema &&
    !sectionHasId(src, "Invariant Coverage", "INV")
  ) {
    add(errors, file, "Invariant Coverage must include INV- IDs");
  }
  if (
    !hasSubstantiveContent(sectionContent(src, "Commands Run")) &&
    !hasSubstantiveContent(sectionContent(src, "Manual QA Results"))
  ) {
    add(
      errors,
      file,
      "Commands Run or Manual QA Results must contain substantive evidence",
    );
  }
};

const parseTodoTasks = (src: string): TodoTask[] => {
  const stripped = stripCodeBlocks(src);
  const tasks: TodoTask[] = [];
  let current: TodoTask | null = null;
  let currentField: string | null = null;
  const flush = (): void => {
    if (current) tasks.push(current);
    current = null;
    currentField = null;
  };

  for (const line of stripped.split(/\r?\n/)) {
    const field = line.match(TODO_FIELD_RE);
    if (field?.[1] === "Title") {
      flush();
      current = { fields: { Title: field[2].trim() } };
      currentField = "Title";
      continue;
    }
    if (!current) continue;
    if (field) {
      current.fields[field[1].trim()] = field[2].trim();
      currentField = field[1].trim();
      continue;
    }
    if (currentField && (/^\s+/.test(line) || line.trim() === "")) {
      current.fields[currentField] = `${
        current.fields[currentField] ?? ""
      }\n${line}`.trimEnd();
    }
  }
  flush();
  return tasks;
};

const validateTodoConsistency = async (
  errors: ValidationItem[],
): Promise<void> => {
  const tasks = parseTodoTasks(await Deno.readTextFile(TODO_FILE));
  for (const task of tasks) {
    const label = task.fields.ID ?? task.fields.Title ?? "(unknown task)";
    const risk = task.fields.Risk;
    const intent = normalizeInlineCode(task.fields.Intent);

    for (const field of ["QA", "Verification"] as const) {
      const path = normalizeInlineCode(task.fields[field]);
      if (!path || path === "None") continue;
      const pathMatch = path.match(QA_PATH_RE);
      if (!pathMatch) {
        add(errors, TODO_FILE, `${label}: ${field} path is not canonical`);
        continue;
      }
      if (!await exists(path)) continue;
      if (qaKindOf(pathMatch) === "maintenance") continue;
      const src = await Deno.readTextFile(path);
      const { attrs, error } = parseFrontMatter(src);
      if (error || !attrs) {
        add(errors, path, error ?? "missing front matter");
        continue;
      }
      if (intent !== "None" && !referencesInclude(attrs, intent)) {
        add(
          errors,
          path,
          `${field} references must include TODO Intent ${intent}`,
        );
      }
      if (risk && attrs.risk !== risk) {
        add(errors, path, `${field} risk must match TODO Risk ${risk}`);
      }
    }
  }
};

const report = (
  prefix: string,
  items: ValidationItem[],
  logger: (message: string) => void,
): void => {
  const grouped = new Map<string, string[]>();
  for (const item of items) {
    if (!grouped.has(item.file)) grouped.set(item.file, []);
    grouped.get(item.file)!.push(item.message);
  }
  for (const [file, messages] of grouped) {
    logger(`${prefix}: ${file}`);
    for (const message of messages) logger(`  - ${message}`);
  }
};

const parseArgs = (args: string[]): ParsedArgs => {
  if (args.length === 0) return { roots: ["_docs/qa"], fixtureMode: false };
  if (args[0] === "--fixture") {
    return { roots: args.slice(1), fixtureMode: true };
  }
  return { roots: args, fixtureMode: false };
};

const collectMarkdownFiles = async function* (
  roots: string[],
): AsyncGenerator<string> {
  for (const root of roots) {
    const kind = await fileOrDir(root);
    if (kind === "file") {
      if (root.endsWith(".md")) yield normalizePath(root);
      continue;
    }
    yield* walkFiles(root, (path) => path.endsWith(".md"));
  }
};

const effectiveQaMatch = ({
  file,
  src,
  attrs,
  fixtureMode,
  errors,
}: EffectiveQaMatchParams): RegExpMatchArray | null => {
  const effectivePath = fixtureMode && typeof attrs.fixture_path === "string"
    ? normalizePath(attrs.fixture_path)
    : file;
  if (
    effectivePath.includes("_docs/archives/qa/") ||
    /(^|\/)archives\/qa\//.test(effectivePath)
  ) {
    add(errors, file, "QA docs must not be placed under archives/qa");
    return null;
  }
  const match = effectivePath.match(QA_PATH_RE);
  if (match) return match;
  if (!fixtureMode) {
    add(
      errors,
      file,
      "QA path must match _docs/qa/<Area>/<slug>/qa.md, _docs/qa/<Area>/maintenance.md, or a legacy test-plan.md / verification.md path",
    );
    return null;
  }

  const kind = sectionContent(src, "Verification Verdict") === null
    ? "test-plan"
    : "verification";
  return [effectivePath, "Fixture", "fixture", kind] as RegExpMatchArray;
};

const run = async (): Promise<void> => {
  const errors: ValidationItem[] = [];
  const warnings: ValidationItem[] = [];
  const { roots, fixtureMode } = parseArgs(Deno.args);
  const inScope = makeInScope(await loadScope());

  if (roots.length === 0) {
    add(errors, "(args)", "--fixture requires at least one path");
  }

  for await (const file of collectMarkdownFiles(roots)) {
    if (!inScope(file)) continue;
    const src = await Deno.readTextFile(file);
    const { attrs, error } = parseFrontMatter(src);
    if (error || !attrs) {
      add(errors, file, error ?? "missing front matter");
      continue;
    }

    const match = effectiveQaMatch({ file, src, attrs, fixtureMode, errors });
    if (!match) continue;
    const [, area, slug] = match;
    const kind = qaKindOf(match);

    validateFrontMatter(file, attrs, errors);
    if (kind === "qa" || kind === "maintenance") {
      validateUnifiedQa({ file, src, attrs, errors, warnings });
    } else if (kind === "test-plan") {
      add(
        warnings,
        file,
        "legacy test-plan.md: migrate to the unified qa.md (qa_schema: 5) when its meaning next changes",
      );
      await validateTestPlan({
        file,
        src,
        attrs,
        area,
        slug,
        errors,
        warnings,
      });
    } else {
      add(
        warnings,
        file,
        "legacy verification.md: migrate to the unified qa.md (qa_schema: 5) when its meaning next changes",
      );
      validateVerification({ file, src, attrs, area, slug, errors });
    }
  }

  if (!fixtureMode) {
    await validateTodoConsistency(errors);
  }

  report("WARN", warnings, console.warn);
  if (errors.length) {
    report("ERROR", errors, console.error);
    Deno.exit(1);
  }
};

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  Deno.exit(1);
});
