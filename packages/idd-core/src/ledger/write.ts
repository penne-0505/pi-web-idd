// intent: DEC-605 — 1 押下 = 1 append。lock 下で書き、失敗を成功として返さない
// intent: DEC-606 — envelope は outbox に積むまで。送信は別 layer
// intent: DEC-611 — handoff に無い event 名は暫定で置き、決まり次第 rename する

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { stateDir } from "../paths.ts";
import { readBacklog } from "./read.ts";

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function appendJsonl(path: string, record: unknown): Promise<void> {
  ensureDir(join(path, ".."));
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 20, maxTimeout: 200 } });
  try {
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  } finally {
    await release();
  }
}

function nowIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

// intent: DEC-658 — area は repo 名を含みうるので、file 名に写すときだけ平坦化する (正本は backlog の area)
function fileSafeArea(area: string): string {
  return area.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function laneArea(iddId: string): string {
  const area = readBacklog().find((b) => b.idd_id === iddId)?.area;
  return area ? fileSafeArea(area) : "default";
}

export async function appendLifecycle(event: string, iddId: string, attrs: Record<string, unknown> = {}): Promise<string> {
  const path = join(stateDir(), `lifecycle-${laneArea(iddId)}.jsonl`);
  await appendJsonl(path, { event, idd_id: iddId, at: nowIso(), attrs });
  return path;
}

export async function appendAnswer(rec: {
  iddId: string;
  batchId: string;
  questionId: string;
  selection: { index?: number; label: string };
  reason?: string;
  notes?: string;
}): Promise<string> {
  const path = join(stateDir(), "pending-answers.jsonl");
  await appendJsonl(path, {
    idd_id: rec.iddId,
    batch_id: rec.batchId,
    question_id: rec.questionId,
    answered_at: nowIso(),
    selection: rec.selection,
    reason: rec.reason ?? null,
    notes: rec.notes ?? null,
  });
  return path;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildEnvelope(type: string, iddId: string, body: string): string {
  return [
    "<idd-system-message>",
    `  <sent-at>${nowIso()}</sent-at>`,
    `  <type>${esc(type)}</type>`,
    `  <idd-id>${esc(iddId)}</idd-id>`,
    body,
    "</idd-system-message>",
  ].join("\n");
}

export function questionAnsweredEnvelope(iddId: string, batchId: string, pairs: {
  questionId: string;
  question: string;
  context?: string;
  options: { index: number; label: string; description?: string }[];
  selection: { index?: number; label: string };
  reason?: string;
  notes?: string;
}[]): string {
  const body = [
    `  <batch-id>${esc(batchId)}</batch-id>`,
    "  <qa-pairs>",
    ...pairs.map((p) => [
      "    <qa-pair>",
      `      <question-id>${esc(p.questionId)}</question-id>`,
      `      <question>${esc(p.question)}</question>`,
      p.context ? `      <context>${esc(p.context)}</context>` : "",
      "      <options>",
      ...p.options.map((o) => [
        "        <option>",
        `          <index>${o.index}</index>`,
        `          <label>${esc(o.label)}</label>`,
        o.description ? `          <description>${esc(o.description)}</description>` : "",
        "        </option>",
      ].filter(Boolean).join("\n")),
      "      </options>",
      "      <selection>",
      p.selection.index !== undefined ? `        <index>${p.selection.index}</index>` : "",
      `        <label>${esc(p.selection.label)}</label>`,
      "      </selection>",
      p.reason ? `      <reason>${esc(p.reason)}</reason>` : "",
      p.notes ? `      <notes>${esc(p.notes)}</notes>` : "",
      "    </qa-pair>",
    ].filter(Boolean).join("\n")),
    "  </qa-pairs>",
  ].filter(Boolean).join("\n");
  return buildEnvelope("question_batch_answered", iddId, body);
}

export async function queueEnvelope(iddId: string, type: string, xml: string): Promise<string> {
  const dir = join(stateDir(), "outbox");
  ensureDir(dir);
  const id = `${Date.now()}-${iddId}`;
  writeFileSync(join(dir, `${id}.xml`), xml, "utf8");
  await appendJsonl(join(stateDir(), "outbox.jsonl"), {
    envelope_id: id,
    idd_id: iddId,
    type,
    queued_at: nowIso(),
    delivered_at: null,
  });
  return id;
}

export interface DecideResult {
  ok: boolean;
  wrote: string[];
  envelopeId?: string;
  error?: string;
}

export async function applyDecision(action: string, payload: Record<string, unknown>): Promise<DecideResult> {
  const iddId = String(payload.iddId ?? payload.reviewId ?? "");
  if (!iddId) return { ok: false, wrote: [], error: "iddId が空" };
  const wrote: string[] = [];

  switch (action) {
    case "s1_go":
      wrote.push(await appendLifecycle("s1_go", iddId, { at_by: "user" }));
      return { ok: true, wrote };

    case "s1_defer": {
      wrote.push(await appendLifecycle("s1_defer", iddId, { reason: String(payload.reason ?? "") }));
      const id = await queueEnvelope(iddId, "lane_deferred",
        buildEnvelope("lane_deferred", iddId, `  <reason>${esc(String(payload.reason ?? ""))}</reason>`));
      return { ok: true, wrote, envelopeId: id };
    }

    case "merge":
    case "anyway_go":
    case "delete":
      wrote.push(await appendLifecycle("pending_review_resolved", iddId, { review_id: iddId, outcome: action }));
      return { ok: true, wrote };

    case "answer": {
      const batchId = String(payload.batchId ?? "");
      const questionId = String(payload.questionId ?? "Q-001");
      const selection = (payload.selection ?? { label: "その他" }) as { index?: number; label: string };
      wrote.push(await appendAnswer({
        iddId, batchId, questionId, selection,
        reason: payload.reason as string | undefined,
        notes: payload.notes as string | undefined,
      }));
      const id = await queueEnvelope(iddId, "question_batch_answered",
        questionAnsweredEnvelope(iddId, batchId, [{
          questionId,
          question: String(payload.question ?? ""),
          options: (payload.options as { index: number; label: string }[] | undefined) ?? [],
          selection,
          reason: payload.reason as string | undefined,
          notes: payload.notes as string | undefined,
        }]));
      return { ok: true, wrote, envelopeId: id };
    }

    case "s3_ok":
      wrote.push(await appendLifecycle("s3_ok", iddId, {
        reviewer_notes: String(payload.notes ?? ""),
        side_findings_promoted: payload.promoted ?? [],
      }));
      return { ok: true, wrote };

    case "s3_reject": {
      const nextStage = String(payload.nextStage ?? "s2_retry");
      const feedback = String(payload.feedback ?? "");
      wrote.push(await appendLifecycle("s3_reject", iddId, { reason: feedback, next_stage: nextStage, feedback }));
      const id = await queueEnvelope(iddId, "lane_rejected", buildEnvelope("lane_rejected", iddId, [
        `  <reject-reason>${esc(feedback)}</reject-reason>`,
        `  <next-stage>${esc(nextStage)}</next-stage>`,
        `  <feedback>${esc(feedback)}</feedback>`,
      ].join("\n")));
      return { ok: true, wrote, envelopeId: id };
    }

    case "s4_verify_clean":
      wrote.push(await appendLifecycle("s4_verify_clean", iddId, {}));
      return { ok: true, wrote };

    case "s4_revise":
    case "s4_sub_todo": {
      wrote.push(await appendLifecycle("s4_verify_user_judgment_answered", iddId, {
        outcome: action === "s4_revise" ? "revise" : "sub_todo",
        instruction: String(payload.instruction ?? ""),
      }));
      return { ok: true, wrote };
    }

    case "priority_elevated":
    case "priority_reset": {
      wrote.push(await appendLifecycle(action, iddId, { reason: String(payload.reason ?? ""), elevated_by: "user" }));
      if (action === "priority_elevated") {
        const id = await queueEnvelope(iddId, "priority_elevated",
          buildEnvelope("priority_elevated", iddId, `  <reason>${esc(String(payload.reason ?? ""))}</reason>`));
        return { ok: true, wrote, envelopeId: id };
      }
      return { ok: true, wrote };
    }

    case "speak": {
      wrote.push(await appendLifecycle("s2_interjection", iddId, { message: String(payload.message ?? "") }));
      const id = await queueEnvelope(iddId, "info_update",
        buildEnvelope("info_update", iddId, `  <description>${esc(String(payload.message ?? ""))}</description>`));
      return { ok: true, wrote, envelopeId: id };
    }

    default:
      return { ok: false, wrote: [], error: `未対応の action: ${action}` };
  }
}
