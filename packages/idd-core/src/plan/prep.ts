
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { QUESTIONS_JSON_SHAPE, REPORT_QUESTIONS_USAGE } from "../agent/questions.ts";
import { CLI_NAME, callbackSection, esc, renderMessage, rules, section } from "../agent/message.ts";
import { getAgentRunner, type QuotaFallback, type SpawnResult } from "../agent/port.ts";
import { areaBriefChecks, readAreas } from "../config/areas.ts";
import { granularityStageOn, pipelineConcurrency } from "../config/pipeline.ts";
import { stagePick } from "../ledger/pick.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { inStartOrder } from "../ledger/start-order.ts";
import { fallbackAttrs, quotaWaitOf, recordQuotaFallbacks, recordQuotaWait } from "./quota-wait.ts";
import { areaSegment, slugOf } from "../intent/parse.ts";
import { stateDir } from "../paths.ts";
import type { BacklogRecord } from "../schema/records.ts";
import type { LaneWorktree } from "../worktree/ensure.ts";
import { ensureWorktreeStep } from "../worktree/prepare.ts";
import { standardsPath } from "../rules/rules.ts";
import { instructionsSection } from "../instruction/brief.ts";
import { recordInjection } from "../instruction/ledger.ts";
import { pickForStage, repoOfArea, type Picked } from "../instruction/store.ts";
import { PLANNER_HOST_RULES, PLANNER_RECORD_RULES, PLANNER_RECORD_RULES_V2, PLANNER_WRITING_RULES, PLANNER_WRITING_RULES_V2, WORK_INSTRUCTION_RULE, CONTEXT_DOC_RULE, PLANNER_FINDINGS_RULE, GRANULARITY_RULE, granularityReportLines, standardsPlaceRule, checksSection, laneNormBullets, normsLines, purposeSection, questionRules, PLANNER_EXISTING_DEC_RULE, PLANNER_IMPACT_RULE, PLANNER_IMPACT_RULE_V2, type BriefCheck, type BriefRun } from "./prompt-text.ts";
import { lookupChoices, showRecord } from "../intent/store.ts";
import { driveStartSteps, skippedOf, startRunning } from "./start-step.ts";
import { disposesOf, reanchorCandidateNote } from "../agent/intent-impact.ts";
import { decisionIndex, decisionIndexLine, pathsInText } from "../intent/decisions.ts";
import { findingsForPaths } from "./place-findings.ts";
import { overlapSection, overlapsForLane } from "./overlap.ts";
import { projectBriefFor } from "./project-brief.ts";
import { readWorkRows, workColumnPath } from "./work-records.ts";
import { normText } from "./harness-norms.ts";
import { DEPTH_FLOOR_RULE } from "./depth.ts";
import { RECORDS_SHAPE_STATE, type RecordShape } from "./record-shape.ts";

/** config/roles.yaml pipeline.planner.concurrency (engine-owned cap, DEC-671); 1 when undeclared */
export function plannerConcurrency(): number {
  return pipelineConcurrency("planner");
}

export function lanesAwaitingPrep(): BacklogRecord[] {
  const events = readLifecycle();
  const byLane = new Map<string, typeof events>();
  for (const e of events) {
    const list = byLane.get(e.idd_id) ?? [];
    list.push(e);
    byLane.set(e.idd_id, list);
  }
  const started = new Set(readSessions("planner").map((r) => r.idd_id));

  return inStartOrder(readBacklog()
    .filter((rec) => {
      const laneEvents = byLane.get(rec.idd_id) ?? [];
      // the stage asks its own question, at the moment it asks it (C-199-2)
      return stagePick("prep", laneEvents, { hasSession: started.has(rec.idd_id) }).pick;
    }));
}

export function runningPlanners(): number {
  return startRunning("planner", readSessions("planner").map((rec) => ({ idd_id: rec.idd_id })));
}

async function recordSession(rec: {
  iddId: string;
  sessionId: string;
  worktree: string;
  branch: string;
  model?: string;
  harness?: string;
  /** the intent-record shape this planner was briefed under (the state shape after the switch) */
  recordsShape?: RecordShape;
  /** the slot's role was refused for Claude's windows and the session runs its fallback */
  fallbacks?: QuotaFallback[];
}): Promise<void> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "planner-sessions.jsonl");
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 40 } });
  try {
    appendFileSync(path, `${JSON.stringify({
      idd_id: rec.iddId,
      planner_session_id: rec.sessionId,
      started_at: new Date().toISOString(),
      worktree_path: rec.worktree,
      branch: rec.branch,
      model: rec.model,
      ...(rec.harness ? { harness: rec.harness } : {}),
      ...(rec.recordsShape ? { records_shape: rec.recordsShape } : {}),
      ...fallbackAttrs(rec.fallbacks),
    })}\n`, "utf8");
  } finally {
    await release();
  }
}

/** the template a deliverable is written from: a copy in the worktree, else the package's own standards */
function templatePath(worktree: string | undefined, name: string): string {
  const rel = `_docs/standards/templates/${name}`;
  if (worktree && existsSync(join(worktree, rel))) return rel;
  return join(standardsPath(), "templates", name);
}

/**
 * The standards as one path the planner can open: the worktree's own copy when it has one, else the package's. A
 * repo whose copy is missing or older would leave `_docs/standards/...` in the rules pointing nowhere (F-124-9).
 */
function standardsPlace(worktree: string | undefined): string {
  const rel = join("_docs", "standards");
  return worktree && existsSync(join(worktree, rel)) ? rel : standardsPath();
}

/**
 * The checks the planner is told to pass: its own work is the records, so only the records-scope checks. With a
 * 5-minute claude run they are listed as `idd wait-run --check <name>` lines (a long records check would otherwise
 * let the cache expire); otherwise the escaped JSON is handed over as before.
 */
function recordsChecks(area: string): string {
  const checks = (readAreas().areas[area]?.checks ?? []).filter((c) => c.scope === "records");
  return esc(JSON.stringify(checks));
}

/** one line of the `<open-findings>` block: id, path and range, severity, where it came from, the claim */
function findingLine(f: { id: string; path: string; lines: [number, number] | null; severity: string; claim: string; lane: string; fixLane?: string }): string {
  const at = f.lines ? `${f.path}:${f.lines[0]}${f.lines[1] !== f.lines[0] ? `-${f.lines[1]}` : ""}` : f.path;
  return `${f.id} (${f.severity}) ${at} from ${f.lane}${f.fixLane ? `，${f.fixLane} が「直す」と申告` : ""}: ${f.claim}`;
}

/** the first sentence of a why, for a candidate line (the full text is read from the record itself) */
function firstSentence(text: string): string {
  const cut = text.split(/。|\n/)[0] ?? text;
  return cut ? `${cut}。` : "";
}

export function plannerBrief(rec: BacklogRecord, _block?: { dec: number; inv: number }, worktree?: string, run?: BriefRun, shape: RecordShape = "docs", instructions?: readonly Picked[]): string {
  const v2 = shape === "state";
  // the instructions of the plan scene for this repo; the delivery passes the list it records, a preview reads them itself
  const instruction = instructionsSection(instructions ?? pickForStage("plan", repoOfArea(rec.area)));
  const config = readAreas().areas[rec.area];
  const area = config;
  const slug = slugOf(rec);
  const seg = areaSegment(rec.area);
  const plannedPath = (dir: string, p: string) => `_docs/${dir}/${seg}/${slug}/${p}`;
  // only a Claude Code run that holds the cache 5 minutes needs its long checks wrapped; a pi or 1-hour run does not
  const wrappedChecks = run?.harness === "claude" && run.cacheTtl === "5m" ? checksSection(areaBriefChecks(rec.area, "records") as BriefCheck[]) : null;
  // only the repo's setting decides this: no other stage re-reads it (DEC-2647)
  const planWanted = config?.work_instruction === "plan";
  // the granularity stage is stopped unless roles.yaml turns it on: a stopped stage asks nothing of the planner, so
  // none of its three places (the rule, the report's callback, the ready's reason flag) goes into the brief
  const granularityWanted = v2 && granularityStageOn();
  // the existing DECs of the files the Issue names: the planner's first pull, before its survey names more
  const issuePaths = pathsInText(`${rec.title}\n${rec.context}`, worktree);
  const sourceRoot = worktree ?? process.cwd();
  const existing = decisionIndex({
    source: { root: sourceRoot },
    root: sourceRoot,
    paths: issuePaths,
    excludeDocs: [plannedPath("intent", "decision.md")],
  });
  const existingLines = v2 ? [] : (existing.count
    ? existing.candidates.map((c) => `      ${esc(decisionIndexLine(c))}`)
    : ["      " + esc(issuePaths.length
      ? "該当する既存の DEC は無い。Anchors を grep して自分で探してもよい。"
      : "Issue の文面からファイルを特定できなかった。下調べの後に `idd intent decisions <path>...` で引く。")]);
  // v2: the Choices the Issue's paths pull, and the Purposes they serve (the planner's first pull, before its survey).
  // The list is the Choices the paths meet as their own subject (a file mark, or a dir's own Place): another file of
  // the same module is shown by the injection as a heading, and a planner pulls it by id when it matters
  const choiceCandidates = v2 ? lookupChoices({ repo: rec.area, actor: { lane: rec.idd_id }, paths: issuePaths }).filter(disposesOf) : [];
  const existingChoiceLines = v2
    ? (choiceCandidates.length
      ? choiceCandidates.map((c) => `      ${esc(`${c.id}${c.status === "unconfirmed" ? " [unconfirmed]" : ""} ${c.forms?.chosen ?? ""}: ${firstSentence(c.why)}${reanchorCandidateNote(c)}`)}`)
      : [`      ${esc(issuePaths.length
        ? "該当する既存の Choice は無い。`idd intent lookup <path>...` で引き直してもよい。"
        : "Issue の文面からファイルを特定できなかった。下調べの後に `idd intent lookup <path>...` で引く。")}`])
    : [];
  const candidatePurposeLines = v2
    ? [...new Set(choiceCandidates.map((c) => c.purpose))].flatMap((id) => {
      if (!id) return [];
      const found = showRecord({ repo: rec.area, actor: { lane: rec.idd_id }, id });
      if (!found.ok || found.kind !== "purpose") return [];
      return [`      ${esc(`${id} ${(found.record as { statement: string }).statement}`)}`];
    }) : [];
  // the number every identifier this lane writes takes as its prefix, taken from the lane's own id
  const laneNumber = /^IDD-(\d+)$/.exec(rec.idd_id)?.[1] ?? rec.idd_id;
  // the open place findings of the files the Issue names, which the planner must dispose of in its report
  const openFindings = findingsForPaths({
    rows: readWorkRows(workColumnPath(rec.area)),
    events: readLifecycle(),
    paths: issuePaths,
    viewLane: rec.idd_id,
  });
  const findingLines = openFindings.length
    ? openFindings.map((f) => `      ${esc(findingLine(f))}`)
    : [`      ${esc(issuePaths.length ? "触る見込みのファイルに open な指摘は無い。" : "Issue の文面からファイルを特定できなかった。下調べの後に `idd work findings <path>...` で引く。")}`];
  // the open lanes that declared a place this lane's Issue names: told, never waited on (the plan decides what to do)
  const overlaps = overlapsForLane(rec, readBacklog(), readLifecycle());
  const laneLines = v2
    ? [`    <lane-number>${esc(laneNumber)}</lane-number>`,
      `    ${esc(`Choice の ID は意図の記録の口が振る（\`C-${laneNumber}-<連番>\`）。草案は報告に乗せるので、ここで ID を書かない。`)}`]
    : [
      `    <lane-number>${esc(laneNumber)}</lane-number>`,
      `    ${esc(`DEC と INV の ID は \`DEC-${laneNumber}-<連番>\`・\`INV-${laneNumber}-<連番>\` で書く。連番はこの lane の中で 1 から数える。すでに番号だけの形で書いた ID は書き換えない。`)}`,
    ];

  return renderMessage([
    section("norms", [
      "  <norms>",
      ...normsLines(`あなたはこのlaneの"planning"を担う。`, [
        "作業ディレクトリは対象repoのworktreeで、このlane専用である。段同士のbridgeはハーネスが行うため、あなたの管轄外である。",
      ], laneNormBullets(shape)).map((l) => `    ${esc(l)}`),
      "  </norms>",
    ].join("\n")),
    purposeSection(),
    section("task", [
      "  <task>",
      `    ${esc(v2
        ? "この lane の下調べを行い、Issue を実装できる Choice の草案と AC に昇華する。実装はしない（成果物の文書以外のコードを変更しない）。"
        : "この lane の下調べを行い、Issue を実装できる契約と実装意図（DEC / AC / INV）に昇華する。実装はしない（成果物の文書以外のコードを変更しない）。")}`,
      "  </task>",
    ].join("\n")),
    section("completion", [
      "  <completion>",
      "    成果物が完成し、記録検査（configured-checks の scope: records）が通っていること。",
      "  </completion>",
    ].join("\n")),
    section("deliverables", [
      "  <deliverables>",
      // the old shape's decision.md has no template any more (2026-10-22): only a retired docs-shape lane names it
      ...(v2 ? [] : [`    <decision path="${esc(plannedPath("intent", "decision.md"))}"/>`]),
      `    <qa path="${esc(plannedPath("qa", "qa.md"))}" template="${esc(templatePath(worktree, "qa.md"))}"/>`,
      `    <reference path="${esc(plannedPath("reference", "reference.md"))}" template="${esc(templatePath(worktree, "reference.md"))}"/>`,
      ...(planWanted ? [`    <context path="${esc(plannedPath("context", "context.md"))}" template="${esc(templatePath(worktree, "context.md"))}"/>`] : []),
      ...(planWanted ? [`    <plan path="${esc(plannedPath("plan", "plan.md"))}" template="${esc(templatePath(worktree, "plan.md"))}"/>`] : []),
      ...(v2 ? ["    qa.md には AC と Checks を書く。Rounds は雛形どおり見出しだけを置き、Round は書かない（検証の記録は Harness が持つ）。"] : []),
      "  </deliverables>",
    ].join("\n")),
    rules("record-rules", (v2
      ? [...PLANNER_RECORD_RULES_V2, PLANNER_FINDINGS_RULE, standardsPlaceRule(standardsPlace(worktree)), normText("todo-source", "state"), ...(planWanted ? [WORK_INSTRUCTION_RULE, CONTEXT_DOC_RULE] : [])]
      : [...PLANNER_RECORD_RULES, PLANNER_EXISTING_DEC_RULE, PLANNER_FINDINGS_RULE, standardsPlaceRule(standardsPlace(worktree)), normText("todo-source"), ...(planWanted ? [WORK_INSTRUCTION_RULE, CONTEXT_DOC_RULE] : [])]).map(esc)),
    ...(granularityWanted ? [rules("granularity", GRANULARITY_RULE.map(esc))] : []),
    rules("writing-rules", (v2 ? PLANNER_WRITING_RULES_V2 : PLANNER_WRITING_RULES).map(esc)),
    rules("question-rules", questionRules().map(esc)),
    rules("host-rules", PLANNER_HOST_RULES.map(esc)),
    ...(instruction ? [instruction] : []),
    callbackSection([
      `    報告は\`${CLI_NAME}\`のCLIで送る。laneのidとtokenはハーネスが渡すので、引数では指定しない。`,      `    <questions>${esc(REPORT_QUESTIONS_USAGE)} — 読む JSON は ${esc(QUESTIONS_JSON_SHAPE)}</questions>`,
      ...(granularityWanted
        ? ["    <granularity>", ...granularityReportLines().map((l) => `      ${esc(l)}`), "    </granularity>"]
        : []),
      "    <plan>",
      `      下調べ完了時に 1 回送る: ${CLI_NAME} report plan${v2 ? "" : " --dec-count N --inv-count N"} --qa-count N --reference-count N --size S|M|L --harm 0-3 --depth shallow|standard|deep --situation "..." --action "..." --outcome "..." --risk-table risk-table.json --intent-impact intent-impact.json${granularityWanted ? " [--granularity-reason \"...\"]" : ""}`
,
      "      --size は変更の大きさ（S / M / L）、--harm はこの変更が触れる経路の害の等級の最大（0〜3）、--depth は計画役が決めた深さ（shallow / standard / deep）である。",
      `      ${DEPTH_FLOOR_RULE}`,
      "      申告が機械の読める下限より浅い報告・3 つの欄の無い報告は engine が断る。下限より深い申告はそのまま受ける。",
      "      summary の 3 行（situation / action / outcome）は、コードを読んでいない人がこの lane の目的を掴める説明にする。repo の言語に関わらず日本語で書く。",
      "      - situation: 今の状況と、何に困っているか。",
      "      - action: この lane では何をするか。",
      "      - outcome: 完了したときどのような変化が期待されるか。",
      "      - 各行 1 文、60 文字前後。",
      "      - 関数名・フィールド名など、コード由来の具体語は使わない。少し抽象化 / 一般化するなどして、概念として理解できるようにする。",
      "      - 例: situation「購入の途中で残高が増えているように見える。失敗しても戻らない。」/ action「残高を増やすのは、購入が確定した後にする。」/ outcome「失敗した購入でも、残高が狂わなくなる。」",
      "      risk-table.json は、後から直せない 6 種類の害（認証 `auth`・認可 `authz`・課金 `billing`・権限 `permission`・データ損失 `data_loss`・secret の扱い `secret`）それぞれへの該当（触れる / 触れない）と根拠 1 文の表。定義と線引きは repo の `_docs/standards/workflow.md` の Risk 分類にある。",
      '      形: [{"kind":"auth","touches":false,"reason":"..."}, ...] の 6 行（種類のキーは上の 6 つ、順不同）。',
      "      1 つでも「触れる」があるなら、qa.md の frontmatter を `risk: High`（以上）にしてから送る。種類が欠けた報告・根拠が空の行・触れるのに High 未満の qa は engine が断る。",
      ...(v2 ? PLANNER_IMPACT_RULE_V2 : PLANNER_IMPACT_RULE).map((l) => `      ${l}`),
      ...(granularityWanted ? ["      `--granularity-reason` には、1 本と決めた理由を 1 文で書く。粒度の案を出した lane で省くと、engine が報告を断る。"] : []),
      "    </plan>",
    ]),
    section("context", [
      "  <lane>",
      `    <title>${esc(rec.title)}</title>`,
      `    <repo>${esc(area?.linked_repo ?? rec.area)}</repo>`,
      `    <source-url>${esc(rec.gh_issue_url ?? rec.linear_issue_url ?? "")}</source-url>`,
      `    <issue-context>${esc(rec.context)}</issue-context>`,
      ...laneLines,
      ...overlapSection(overlaps, "planner", esc),
      ...(v2 ? [
        `    <existing-choices count="${choiceCandidates.length}">`,
        ...existingChoiceLines,
        "    </existing-choices>",
        `    <candidate-purposes count="${candidatePurposeLines.length}">`,
        ...(candidatePurposeLines.length ? candidatePurposeLines : [`      ${esc("この一覧の Choice が連なる Purpose は無い。")}`]),
        "    </candidate-purposes>",
      ] : [
        `    <existing-decisions count="${existing.count}">`,
        ...existingLines,
        "    </existing-decisions>",
      ]),
      `    <open-findings count="${openFindings.length}">`,
      ...findingLines,
      "    </open-findings>",
      // the Project the lane's Issue belongs to: its aim and decisions, so the Issue's text need not carry them (whatever the record shape)
      ...projectBriefFor(rec, "planner"),
      "  </lane>",
      ...(wrappedChecks ? [] : [`  <configured-checks>${recordsChecks(rec.area)}</configured-checks>`]),
    ].join("\n")),
    ...(wrappedChecks ? [wrappedChecks] : []),
  ]);
}

export interface PrepResult {
  started: { iddId: string; sessionId: string; worktree: string }[];
  skipped: { iddId: string; reason: string; wait?: boolean }[];
  capacity: number;
}

export async function runPrep(opts: { hold?: string } = {}): Promise<PrepResult> {
  const cap = plannerConcurrency();
  const result: PrepResult = { started: [], skipped: [], capacity: Math.max(0, cap - runningPlanners()) };
  const events = readLifecycle();
  const sessions = readSessions("planner").map((rec) => ({ idd_id: rec.idd_id }));
  const runner = getAgentRunner();
  // a lane's readings are kept here: the helper's answers are values, and the fold decides when they are read
  let worktree: LaneWorktree | null | undefined;
  let spawned: SpawnResult | undefined;
  let wait: ReturnType<typeof quotaWaitOf>;

  for (const rec of lanesAwaitingPrep()) {
    worktree = undefined;
    spawned = undefined;
    wait = null;
    const outcome = await driveStartSteps("start_prep", events, {
      lane: rec.idd_id,
      area: rec.area,
      limit: cap,
      started: result.started.length,
      // the engine is being replaced with code this process has not loaded: the start waits for the replacement
      hold: opts.hold ?? "",
      runner: Boolean(runner?.spawn),
      sessions,
    }, {
      write: async () => { /* the planner has no start record of its own */ },
      call: async (step) => {
        switch (step.helper) {
          case "ensure_worktree": {
            const made = await ensureWorktreeStep(rec.area, rec.idd_id);
            worktree = made.worktree;
            return made.answer;
          }
          case "spawn": {
            try {
              if (!runner?.spawn) throw new Error("no runner");
              const answer = await runner.spawn({ role: "planner", cwd: worktree!.path, laneId: rec.idd_id });
              spawned = answer;
              return {
                sessionId: answer.sessionId,
                ...(answer.model ? { model: answer.model } : {}),
                ...(answer.harness ? { harness: answer.harness } : {}),
                ...(answer.cacheTtl ? { cacheTtl: answer.cacheTtl } : {}),
                ...(fallbackAttrs(answer.fallbacks).fallbacks ? { fallbacks: fallbackAttrs(answer.fallbacks).fallbacks } : {}),
              };
            } catch (err) {
              // a planner on Claude Code over the subscription's windows waits: the lane stays queued for the next tick
              wait = quotaWaitOf(err);
              return { error: String(err), ...(wait ? { quota: { reason: wait.reason } } : {}) };
            }
          }
          case "record_session": {
            try {
              await recordSession({
                iddId: rec.idd_id,
                sessionId: spawned!.sessionId,
                worktree: worktree!.path,
                branch: worktree!.branch,
                ...(spawned!.model ? { model: spawned!.model } : {}),
                ...(spawned!.harness ? { harness: spawned!.harness } : {}),
                recordsShape: RECORDS_SHAPE_STATE,
                ...(spawned!.fallbacks?.length ? { fallbacks: spawned!.fallbacks } : {}),
              });
              return { ok: true };
            } catch (err) {
              return { error: String(err) };
            }
          }
          case "record_quota_fallbacks": {
            try {
              // the planner has no start event: the line comes after the session is recorded
              await recordQuotaFallbacks(rec.idd_id, "planner", spawned?.fallbacks);
              return { ok: true };
            } catch (err) {
              return { error: String(err) };
            }
          }
          case "record_quota_wait": {
            if (wait) await recordQuotaWait(rec.idd_id, events.filter((e) => e.idd_id === rec.idd_id), "planner", wait);
            return { ok: true };
          }
          case "deliver": {
            try {
              const picked = pickForStage("plan", repoOfArea(rec.area));
              await runner!.deliver(spawned!.sessionId, plannerBrief(rec, undefined, worktree!.path, { ...(spawned!.harness ? { harness: spawned!.harness } : {}), ...(spawned!.cacheTtl ? { cacheTtl: spawned!.cacheTtl } : {}) }, RECORDS_SHAPE_STATE, picked), { cwd: worktree!.path, type: "s1_prep_start" });
              // the run has started: the ledger is written only now, so a delivery that failed leaves no line
              recordInjection(picked, { kind: "lane", stage: "plan", scene: "plan", lane: rec.idd_id, run: spawned!.sessionId });
              return { ok: true };
            } catch (err) {
              wait = quotaWaitOf(err);
              return { error: String(err), ...(wait ? { quota: { reason: wait.reason } } : {}) };
            }
          }
          default: return { error: `知らない helper: ${String(step.helper)}` };
        }
      },
    });
    if (outcome.action === "started") {
      result.started.push({ iddId: rec.idd_id, sessionId: spawned!.sessionId, worktree: worktree!.path });
    } else if (outcome.action === "skipped") {
      result.skipped.push(skippedOf(rec.idd_id, outcome));
    }
  }
  return result;
}

export type LaneActivity = "live" | "stalled" | "unstarted";

export function laneActivity(iddId: string, group: string, liveSessionIds: Set<string>): LaneActivity {
  if (group !== "prep" && group !== "impl") return "live";
  const kind = group === "impl" ? "executor" : "planner";
  const rec = readSessions(kind).filter((r) => r.idd_id === iddId).pop();
  const sessionId = kind === "executor" ? rec?.executor_session_id : rec?.planner_session_id;
  if (!sessionId) return "unstarted";
  return liveSessionIds.has(sessionId) ? "live" : "stalled";
}
