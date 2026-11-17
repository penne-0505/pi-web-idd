import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { githubAreas, redoLane, type LinearIntakeDeps } from "../../idd-core/src/index.ts";
import { requestTick, type TickKick } from "../../idd-lane/src/tick-kick.ts";
import { normalizeQuestions } from "../../idd-core/src/agent/questions.ts";
import { normalizeGranularity } from "../../idd-core/src/plan/granularity.ts";
import { normalizeRiskTable } from "../../idd-core/src/agent/risk-table.ts";
import { runIntentCommand } from "./intent-commands.ts";
import { runInstructionCommand } from "./instruction-commands.ts";
import { auditAnchors, decisionIndex } from "../../idd-core/src/intent/decisions.ts";
import { normalizeIntentImpact, normalizePlanRecords, isPlanRecordsShape, planRecordsRefusal } from "../../idd-core/src/agent/intent-impact.ts";
import { isDepth, isHarm, isSize, DEPTH_FLOOR_RULE, type Depth, type Size } from "../../idd-core/src/plan/depth.ts";
import { agentBaseUrl, inboxCardUrl } from "../../idd-core/src/agent/token.ts";
import {
  addWorktree, expandHome, fetchPrContext, laneStatus, laneTail, listWorktrees, mergeFindings, moveWorktree,
  prStatus, readFindings, readLaneRepos, readRoles, removeWorktree, renderDraft, repoByName, repoForPath,
  runGate, runLane, runProbe, runRiskMap, runWaitRun, saveProbe, sendLane, splitComments, stopLane,
  createOutbound, listOutbound, readOutbound, requestingLane, OUTBOUND_KINDS, fromWork, publicWritingContext, findRepoByGithub, AI_MARKER,
  type LaneRepo, type MappedBlindSpecs, type OutboundKind,
} from "../../idd-lane/src/index.ts";

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
  rest: string[];
  /** keys whose value was not taken (the next token was absent or began with `--`), so `flags[key]` is `true` */
  missing: string[];
}

const BOOL_FLAGS = new Set(["no-rewrite", "public", "all", "wait", "no-wait", "dry-run", "force", "skip-setup", "stop-on-fail", "include-duplicates", "approve", "comment", "request-changes", "lane", "json"]);

/** tiny argv parser: --k v, --k=v, boolean flags, repeated list keys, `--` ends flags */
export function parseArgs(argv: string[], listKeys: string[] = []): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const rest: string[] = [];
  const missing = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") { rest.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let val: string | boolean = eq > 0 ? a.slice(eq + 1) : true;
    if (val === true && !BOOL_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) { val = argv[i + 1]; i += 1; }
    // a valued flag that took nothing would otherwise be sent as the string "true"; remember it instead
    if (val === true && !BOOL_FLAGS.has(key)) missing.add(key);
    if (listKeys.includes(key)) flags[key] = [...((flags[key] as string[] | undefined) ?? []), String(val)];
    else flags[key] = val;
  }
  return { positional, flags, rest, missing: [...missing] };
}

const str = (v: string | boolean | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: string | boolean | string[] | undefined): number | undefined => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

function out(v: unknown): void {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

const USAGE = `usage:
  idd lane redo IDD-xxx
  idd lane run SPEC.yaml [--no-wait] [--model provider/id] [--dry-run]
  idd lane status [ID]         idd lane tail ID [--lines N]
  idd lane send ID "text"      idd lane stop ID      idd lane redo IDD-xxx
  idd lane roles               # role 一覧と model の設定状況、est 別プロファイル
  idd wt add --repo NAME (--pr N | --rev REV) [--from work] [--suffix S] [--name N] [--skip-setup]
  idd wt move PATH (--pr N | --rev REV)     idd wt rm PATH [--force]     idd wt list --repo NAME
  idd probe --wt PATH --run "cmd" (--to REV -- files... | --patch FILE) [--name N] [--save DIR]
  idd gate --wt PATH [--only name,name] [--stop-on-fail]
  idd wait-run (--check NAME | -- <command>) [--timeout-minutes N]   # 前面のまま 4 分ごとに区切って待つ。同じ行を呼び直すと続きを待てる
  idd pr ctx --repo owner/name N --out DIR [--since ISO]
  idd pr post --repo owner/name N (--approve|--comment|--request-changes) --body-file F --expect-head SHA [--dry-run]   # レビューの下書きを送出カードに作る（投稿は受信箱のカードで penne が承認したときだけ）
  idd out draft --kind gh-issue --repo owner/name --title T (--body-file F | --body "...") [--label L]... [--source S] [--no-rewrite] [--lane]
  idd out targets               # 渡せる repo・取り込みのラベル・対外文書の言語を返す（読むだけ。何も書かず、gh も呼ばない）
  idd out draft --kind gh-repo --title name [--public] (--body-file F | --body "説明")   # 投稿は受信箱の送出カードで penne が承認したときだけ
  idd out draft --kind gh-pr-body --repo owner/name --pr N (--body-file F | --body "...") [--title T]   # 既存 PR の本文の更新の案（今の本文との差分をカードで見せる）
  idd out list [--all]          idd out show ID
  idd approve CARD              # 署名の要る card を 1 枚、端末で中身を読んで PIN を入れて通す（proof を decide に送るだけで、外へ書くのは engine）
  idd report merge --out FILE.md --findings a.json[,b.json] [--comments comments.json] [--intro "..."] [--include-duplicates]
  idd report questions --file questions.json        # 質問を送る（lane と token は環境変数 IDD_ID / IDD_AGENT_TOKEN）。送ったらすぐ戻る
  idd report granularity --file granularity.json    # 依頼の前に、この lane をどう切るかの案を送る（single / split / merge）
  idd report plan --dec-count N --inv-count N --qa-count N --reference-count N --size S|M|L --harm 0-3 --depth shallow|standard|deep --situation S --action A --outcome O --risk-table FILE --intent-impact FILE [--granularity-reason R] [--findings FILE]
  idd intent decisions PATH...   # そのパスを Anchors に持つ既存の DEC を引く（token は要らない）
  idd intent anchors             # 索引が読めない Anchors を一覧で出す（欄が無い・パスを 1 つも読めない・repo に無いパス）
  idd intent lookup PATH... [--repo R] [--view-lane ID] [--json]   # Place で引く（file と dir の Place に当たる Choice は本文、同じ module は見出し。既定は要点の文。--json で全文。token は要らない）
  idd intent purposes [--repo R] [--view-lane ID] [--json]   # active な Purpose を id と want の 1 行で並べる（token は要らない）
  idd intent show ID [--repo R] [--view-lane ID]          # 1 つの記録を ID で読む
  idd intent records [--kind purposes|choices|waives] [--status S] [--repo R] [--view-lane ID]
  idd intent risk [--repo R] [--json]              # risk_paths の宣言と承認済みの害の例を合わせて読む（token は要らない）
  idd intent check [--json] [--repo R]             # 状態と tree の規則を見る（IDD_ID があればその lane。lane は写しを見ない。token は要らない）
  idd intent draw [--out DIR] [--repo R]           # 状態から写し A を描く（lane は --out への下見だけ。lane の外は cwd の worktree。token は要らない）
  idd intent hook [--input F.json]                 # 道具の出来事を標準入力から読み、足す why を JSON で返す（ハーネスの橋。常に 0 で終わる）
  idd intent raise purpose|choice --file F.json [--session ID] [--repo R]   # 書く（IDD_ID があればその lane）
  idd intent propose overview|root-supersede|root-reanchor|harm --reason R --file F.json [--session ID] [--repo R]   # 案を出す（何も効かせない）
  idd intent supersede ID[,ID] --grounds G --file F.json   idd intent supersede ID[,ID] --grounds G --by SUCCESSOR   idd intent reanchor ID --file F.json
  idd intent confirm ID   idd intent drop ID --grounds G   idd intent retire ID --grounds G
  idd intent waive --kind applied --choice ID [--choice ID]... [--change REF] | --kind no-choice --reason R [--change REF]
  idd report progress --current-step S [--ac AC-001=verified]... [--evidence 'AC-001=...']... [--recent "..."]...
  idd report result --outcome success|partial|failed [--changed-file F]... [--commit-count N] [--verified AC-001]... [--evidence 'AC-001=...']... [--unverified AC-002]... [--side-finding "..."]...
`;

const INTENT_USAGE = [
  "usage:",
  "  # 読む（token は要らない）",
  "  idd intent decisions PATH...   # そのパスを Anchors に持つ既存の DEC（番号・題・Why の先頭の文・文書・当たったファイル）を JSON で出す",
  "  idd intent anchors             # 索引が読めない Anchors を JSON で出す（Anchors の欄が無い DEC・パスを 1 つも読めない DEC・今の repo に無いパス）",
  "  idd intent lookup PATH... [--repo R] [--view-lane ID] [--json]   # Place で引く（file と dir の Place に当たる Choice は本文・同じ module は見出し・root は件数。既定は要点の文、--json で今の JSON）",
  "  idd intent purposes [--repo R] [--view-lane ID] [--json]   # active な Purpose を id と want の 1 行で並べる（全文は `idd intent show <id>`）",
  "  idd intent show ID [--repo R] [--view-lane ID]          # 1 つの記録を ID で読む（superseded と dropped も読める）",
  "  idd intent records [--kind purposes|choices|waives] [--status S] [--repo R] [--view-lane ID]",
  "  idd intent risk [--repo R] [--json]   # risk_paths の宣言と承認済みの害の例を 1 つの応答で読む",
  "  idd intent check [--json] [--repo R]   # 状態と tree の規則を見る（IDD_ID があればその lane。lane は写しを見ない。token は要らない）",
  "  idd intent draw [--out DIR] [--repo R]   # 状態から写し A を描く（lane は worktree に描かず、--out への下見だけ。lane の外は cwd の worktree に描く。token は要らない）",
  "  idd intent hook [--input F.json]  # 道具の出来事を標準入力から読み、足す why を JSON で返す（ハーネスの橋。常に 0 で終わる）",
  "  # 書く（IDD_ID があればその lane。無ければ --session と token が要る）",
  "  idd intent raise purpose --file F.json [--session ID] [--repo R]",
  "  idd intent propose overview|root-supersede|root-reanchor|harm --reason R --file F.json [--session ID] [--repo R]",
  "  idd intent raise choice --file F.json [--session ID] [--repo R]",
  "  idd intent supersede ID[,ID] --grounds G --file F.json | --grounds G --by SUCCESSOR   # --file は新しい Choice を立てて置き換える。--by は既にある Choice を後継に指す（どちらか 1 つ）",
  "  idd intent reanchor ID --file F.json",
  "  idd intent confirm ID [--name N]",
  "  idd intent drop ID --grounds G",
  "  idd intent retire ID --grounds G",
  "  idd intent waive --kind applied --choice ID [--choice ID]... [--change REF]",
  "  idd intent waive --kind no-choice --reason R [--change REF]",
  "  # 移行（lane の外だけ。IDD_ID があると断る）",
  "  idd intent convert --purposes F.json --assignment F.json [--review F.json] [--dry-run] [--session ID] [--repo R]",
  "",
].join("\n");

const AC_STATUS = ["verified", "covered", "planned", "deferred", "not-applicable", "in_progress", "todo"] as const;
const RESULT_OUTCOMES = ["success", "partial", "failed"] as const;

interface ReportTarget {
  baseUrl: string;
  laneId: string;
  token: string;
}

/**
 * The lane and the token are read from the environment only: the harness sets IDD_ID and IDD_AGENT_TOKEN
 * around the agent, so an agent cannot report as another lane or carry the token on a command line.
 */
function reportTarget(flags: Record<string, string | boolean | string[]>): ReportTarget | { error: string } {
  for (const flag of ["lane", "idd", "token"]) {
    if (flags[flag] !== undefined) return { error: `lane と token は環境変数 (IDD_ID / IDD_AGENT_TOKEN) から読みます。--${flag} では替えられません` };
  }
  const laneId = process.env.IDD_ID?.trim();
  const token = process.env.IDD_AGENT_TOKEN?.trim();
  const missing = [!laneId ? "IDD_ID" : "", !token ? "IDD_AGENT_TOKEN" : ""].filter(Boolean);
  if (missing.length || !laneId || !token) return { error: `${missing.join(" と ")} がありません。報告は、ハーネスが渡す環境でだけ送れます` };
  return { baseUrl: agentBaseUrl(), laneId, token };
}

/**
 * A report the engine never received is safe to send again; one it received and then cut is not (it may already be
 * recorded, and sending again could double it). Only a connection that never landed can be told apart by its code.
 */
export function neverReached(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (err as { code?: string })?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ConnectionRefused") return true;
  // the message differs by runtime: undici (the CLI's plain Node) says ECONNREFUSED, bun says it cannot connect
  return /ECONNREFUSED|connection refused|unable to connect|connectionrefused/i.test(String((err as Error)?.message ?? err));
}

/** how long a report keeps trying while the engine is being replaced (a test shortens it) */
export function reportRetryMs(): number {
  const raw = Number(process.env.IDD_REPORT_RETRY_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** the wait between tries (a test shortens it) */
export function reportRetryIntervalMs(): number {
  const raw = Number(process.env.IDD_REPORT_RETRY_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3_000;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface JsonPost {
  response?: Response;
  data: Record<string, unknown>;
  /** the connection never reached the engine even after the tries */
  error?: unknown;
}

/**
 * POST and read a JSON answer, trying again while the engine is being replaced. A 503 with `reloading` means the
 * engine refused before handling anything; a connection that never landed is the same window's other face. Any
 * other failure (a request the engine received and cut) is returned as it is, never tried again.
 */
export async function postJsonWithRetry(url: string, init: RequestInit): Promise<JsonPost> {
  const deadline = Date.now() + reportRetryMs();
  const interval = reportRetryIntervalMs();
  for (;;) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      if (neverReached(err) && Date.now() < deadline) {
        await sleep(interval);
        continue;
      }
      return { data: {}, error: err };
    }
    const data = await response.json().catch(() => ({} as Record<string, unknown>));
    if (response.status === 503 && data.reloading === true && Date.now() < deadline) {
      await sleep(interval);
      continue;
    }
    return { response, data };
  }
}

/**
 * POST a report. A replacement of the engine (a landing's quiet restart) answers 503 with `reloading`, and the
 * engine's process is down for a few seconds before that; both are tried again for a bounded time, so a lane's
 * result is not lost to the window. A request the engine received and cut is not tried again.
 *
 * `stage` is the one field a caller reads past the outcome: a granularity proposal the stopped stage records only says
 * so here, so the CLI can tell the planner to go on instead of waiting for an answer nobody was asked for.
 */
export async function postReport(target: ReportTarget, path: string, body: unknown): Promise<{ ok: boolean; warning?: string; error?: string; stage?: string }> {
  const posted = await postJsonWithRetry(`${target.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.token}` },
    body: JSON.stringify(body),
  });
  if (posted.error !== undefined) return { ok: false, error: `報告を送れませんでした: ${String(posted.error)}` };
  const { response, data } = posted;
  if (!response?.ok || data.ok === false) {
    const reason = typeof data.error === "string" && data.error ? data.error : `API が断りました (HTTP ${response?.status ?? 0})`;
    return { ok: false, error: reason };
  }
  // a 200 whose body cannot be read is still a success: the record was written before the answer was sent
  return {
    ok: true,
    ...(typeof data.warning === "string" && data.warning ? { warning: data.warning } : {}),
    ...(typeof data.stage === "string" && data.stage ? { stage: data.stage } : {}),
  };
}

/** the failure goes to stderr and the success to stdout; a warning does not fail the report */
function reportDone(res: { ok: boolean; warning?: string; error?: string }, success: Record<string, unknown>): number {
  if (!res.ok) { process.stderr.write(`${res.error}\n`); return 1; }
  if (res.warning) process.stderr.write(`warning: ${res.warning}\n`);
  out({ ok: true, ...success });
  return 0;
}

function countFlag(flags: Record<string, string | boolean | string[]>, name: string): { value: number } | { error: string } {
  if (flags[name] === undefined) return { value: 0 };
  const parsed = num(flags[name]);
  return parsed === undefined ? { error: `--${name} は数を指定してください: ${String(flags[name])}` } : { value: parsed };
}

function stringList(flags: Record<string, string | boolean | string[]>, name: string): string[] {
  return (flags[name] as string[] | undefined) ?? [];
}

function readQuestionJson(flags: Record<string, string | boolean | string[]>): { json: unknown } | { error: string } {
  const file = str(flags.file);
  const inline = str(flags.json);
  let text: string;
  try {
    text = file ? readFileSync(resolve(expandHome(file)), "utf8") : inline ?? readFileSync(0, "utf8");
  } catch (err) {
    return { error: `質問の JSON を読めませんでした: ${String(err)}` };
  }
  try {
    return { json: JSON.parse(text) };
  } catch (err) {
    return { error: `質問の JSON を読めませんでした: ${String(err)}` };
  }
}

async function reportQuestions(target: ReportTarget, flags: Record<string, string | boolean | string[]>): Promise<number> {
  const read = readQuestionJson(flags);
  if ("error" in read) { process.stderr.write(`${read.error}\n`); return 2; }
  const raw = Array.isArray(read.json) ? read.json : (read.json as { questions?: unknown } | null)?.questions;
  const parsed = normalizeQuestions(raw);
  if (!parsed.ok) { process.stderr.write(`質問の形が正しくありません: ${parsed.error}\n`); return 2; }
  if (parsed.questions.length > 5) { process.stderr.write(`1 batch の質問は 1〜5 問です（${parsed.questions.length} 問）\n`); return 2; }
  for (const [i, q] of parsed.questions.entries()) {
    if (q.options.length < 1 || q.options.length > 5) { process.stderr.write(`questions[${i}] の選択肢は 1〜5 個です（${q.options.length} 個）\n`); return 2; }
  }
  const batchId = randomUUID();
  const res = await postReport(target, "/api/idd/agent/questions", { idd_id: target.laneId, batch_id: batchId, questions: parsed.questions });
  const code = reportDone(res, { batch_id: batchId, question_count: parsed.questions.length });
  if (code !== 0) return code;
  // the CLI does not wait for the answers: they arrive as the next message, so the agent ends its turn here
  process.stdout.write("ここで作業を止め、turn を終えてください。答えは次の message で届きます。\n");
  return 0;
}

/** the planner's granularity proposal, read from --file (or --json) as JSON */
function readGranularityJson(flags: Record<string, string | boolean | string[]>): { json: unknown } | { error: string } {
  const file = str(flags.file);
  const inline = str(flags.json);
  let text: string;
  try {
    text = file ? readFileSync(resolve(expandHome(file)), "utf8") : inline ?? readFileSync(0, "utf8");
  } catch (err) {
    return { error: `粒度の案の JSON を読めませんでした: ${String(err)}` };
  }
  try {
    return { json: JSON.parse(text) };
  } catch (err) {
    return { error: `粒度の案の JSON を読めませんでした: ${String(err)}` };
  }
}

/**
 * `idd report granularity`: the planner's judgement of how this lane is sliced, sent after the survey and before
 * the request. A split or a merge leaves the lane on a person's card, so the CLI tells the planner to end its turn
 * (the answer comes as the next message); a "single" judgement only leaves the reason in the record and the planner
 * goes on to write the request. When the stage is stopped (roles.yaml `pipeline.granularity`), the engine records the
 * proposal only and no answer is coming: telling the planner to end its turn would leave it waiting on a person who
 * was never asked, so it is told to go on with the request instead. The shape is checked here, before anything is
 * sent (DEC-1204).
 */
async function reportGranularity(target: ReportTarget, flags: Record<string, string | boolean | string[]>): Promise<number> {
  const read = readGranularityJson(flags);
  if ("error" in read) { process.stderr.write(`${read.error}\n`); return 2; }
  const parsed = normalizeGranularity(read.json);
  if (!parsed.ok) { process.stderr.write(`粒度の案の形が正しくありません: ${parsed.error}\n`); return 2; }
  const res = await postReport(target, "/api/idd/agent/granularity", { idd_id: target.laneId, proposal: parsed.proposal });
  const code = reportDone(res, { kind: parsed.proposal.kind, children: parsed.proposal.children?.length ?? 0 });
  if (code !== 0) return code;
  if (parsed.proposal.kind !== "single") {
    process.stdout.write(res.stage === "off"
      ? "粒度の段は止まっています（config/roles.yaml の pipeline.granularity）。案は lane の記録に残りました。turn を終えず、依頼（plan.md）を書き進めてください。\n"
      : "ここで作業を止め、turn を終えてください。人が card で答えると、答えが次の message で届きます。\n");
  }
  return 0;
}

/** the planner's six-kind table, read from --risk-table FILE (or --risk-json INLINE) as JSON */
function readRiskTableJson(flags: Record<string, string | boolean | string[]>): { json: unknown } | { error: string } {
  const file = str(flags["risk-table"]);
  const inline = str(flags["risk-json"]);
  if (!file && !inline) return { error: "該当表を --risk-table FILE（または --risk-json）で渡してください: 認証 / 認可 / 課金 / 権限 / データ損失 / secret の 6 種類それぞれに、触れる / 触れない と根拠 1 文" };
  let text: string;
  try {
    text = file ? readFileSync(resolve(expandHome(file)), "utf8") : inline as string;
  } catch (err) {
    return { error: `該当表の JSON を読めませんでした: ${String(err)}` };
  }
  try {
    return { json: JSON.parse(text) };
  } catch (err) {
    return { error: `該当表の JSON を読めませんでした: ${String(err)}` };
  }
}

/** the planner's report of the impact on existing intent, read from --intent-impact FILE (or --intent-impact-json INLINE) as JSON */
function readIntentImpactJson(flags: Record<string, string | boolean | string[]>): { json: unknown } | { error: string } {
  const file = str(flags["intent-impact"]);
  const inline = str(flags["intent-impact-json"]);
  if (!file && !inline) {
    return { error: "既存の意図への影響を --intent-impact FILE（または --intent-impact-json）で渡してください: 触る見込みのファイルを `idd intent decisions <path>...`（v2 の lane では `idd intent lookup <path>...`）に渡すと候補が引けます。関係する DEC / Choice が無いときは decisions または existing を空の一覧にします" };
  }
  let text: string;
  try {
    text = file ? readFileSync(resolve(expandHome(file)), "utf8") : inline as string;
  } catch (err) {
    return { error: `影響の報告の JSON を読めませんでした: ${String(err)}` };
  }
  try {
    return { json: JSON.parse(text) };
  } catch (err) {
    return { error: `影響の報告の JSON を読めませんでした: ${String(err)}` };
  }
}

/**
 * the planner's dispositions of the open findings, read from --findings FILE (or --findings-json INLINE) as JSON.
 * `findings` is `idd report merge`'s list key too, so it arrives here as an array; reading it as a scalar would
 * return undefined and drop the dispositions, leaving the plan refused with nothing to show the planner why.
 * A plan takes one file: more than one is refused rather than silently picking one.
 */
function readFindingsJson(flags: Record<string, string | boolean | string[]>): { json: unknown } | { error: string } {
  const files = stringList(flags, "findings");
  const inline = str(flags["findings-json"]);
  if (files.length > 1) {
    return { error: `--findings は 1 つだけ渡してください（処置は 1 つの JSON にまとめます）: ${files.join(", ")}` };
  }
  const file = files[0];
  if (!file && !inline) return { json: undefined };
  let text: string;
  try {
    text = file ? readFileSync(resolve(expandHome(file)), "utf8") : inline as string;
  } catch (err) {
    return { error: `指摘の処置の JSON を読めませんでした: ${String(err)}` };
  }
  try {
    return { json: JSON.parse(text) };
  } catch (err) {
    return { error: `指摘の処置の JSON を読めませんでした: ${String(err)}` };
  }
}

async function reportPlan(target: ReportTarget, flags: Record<string, string | boolean | string[]>): Promise<number> {
  const situation = str(flags.situation);
  const action = str(flags.action);
  const outcome = str(flags.outcome);
  if (!situation || !action || !outcome) {
    process.stderr.write("summary の 3 行をすべて指定してください: --situation / --action / --outcome\n");
    return 2;
  }
  // the depth's three fields; the shape is checked here and the floor by the engine
  const size = str(flags.size);
  const harm = num(flags.harm);
  const depth = str(flags.depth);
  const depthValue: { size: Size; harm: number; depth: Depth } = { size: size as Size, harm: harm as number, depth: depth as Depth };
  const counts: Record<string, number> = {};
  for (const [name, key] of [["dec-count", "dec_count"], ["inv-count", "inv_count"], ["qa-count", "qa_count"], ["reference-count", "reference_count"]] as const) {
    const parsed = countFlag(flags, name);
    if ("error" in parsed) { process.stderr.write(`${parsed.error}\n`); return 2; }
    counts[key] = parsed.value;
  }
  // the table's shape is checked here; the engine refuses a table that misses a kind or a reason, and a lane
  // that answers "触れる" without a High qa
  const risk = readRiskTableJson(flags);
  if ("error" in risk) { process.stderr.write(`${risk.error}\n`); return 2; }
  const normalized = normalizeRiskTable(risk.json);
  if ("error" in normalized) { process.stderr.write(`${normalized.error}\n`); return 2; }
  // the impact on existing intent is required: its shape, its id numbers and their reasons are checked here,
  // before anything is sent, so a planner is never refused after its ready was recorded. The JSON's own fields
  // tell the two record shapes apart (the engine tells them apart by the lane's mark and refuses a mismatch).
  const impactJson = readIntentImpactJson(flags);
  if ("error" in impactJson) { process.stderr.write(`${impactJson.error}\n`); return 2; }
  const cwd = process.cwd();
  let intentImpactPayload: Record<string, unknown>;
  if (isPlanRecordsShape(impactJson.json)) {
    const parsed = normalizePlanRecords(impactJson.json);
    if ("error" in parsed) { process.stderr.write(`${parsed.error}\n`); return 2; }
    intentImpactPayload = { paths: parsed.report.paths, choices: parsed.report.choices, existing: parsed.report.existing };
  } else {
    const impact = normalizeIntentImpact(impactJson.json, { source: { root: cwd }, root: cwd });
    if ("error" in impact) { process.stderr.write(`${impact.error}\n`); return 2; }
    intentImpactPayload = { paths: impact.report.paths, decisions: impact.report.rows.map(({ id, effect, reason }) => ({ id, effect, reason })) };
  }
  const findingsJson = readFindingsJson(flags);
  if ("error" in findingsJson) { process.stderr.write(`${findingsJson.error}\n`); return 2; }
  if (!isSize(size) || !isHarm(harm) || !isDepth(depth)) {
    process.stderr.write(`計画の報告に --size (S / M / L)・--harm (0〜3)・--depth (shallow / standard / deep) の 3 つが必要です。${DEPTH_FLOOR_RULE}\n`);
    return 2;
  }
  const res = await postReport(target, "/api/idd/agent/ready", {
    idd_id: target.laneId,
    dec_count: counts.dec_count,
    inv_count: counts.inv_count,
    qa_count: counts.qa_count,
    reference_count: counts.reference_count,
    size: depthValue.size,
    harm: depthValue.harm,
    depth: depthValue.depth,
    summary: { situation, action, outcome },
    risk_table: normalized.table,
    intent_impact: intentImpactPayload,
    ...(str(flags["granularity-reason"]) ? { granularity_reason: str(flags["granularity-reason"]) } : {}),
    ...(findingsJson.json !== undefined ? { findings: findingsJson.json } : {}),
  });
  return reportDone(res, { ...counts });
}

/** the `--evidence 'AC-001=...'` list, each read as `id=text`; a malformed one is a usage error */
function evidenceList(flags: Record<string, string | boolean | string[]>): { value: Map<string, string> } | { error: string } {
  const out = new Map<string, string>();
  for (const spec of stringList(flags, "evidence")) {
    const eq = spec.indexOf("=");
    const id = eq > 0 ? spec.slice(0, eq).trim() : "";
    const evidence = eq > 0 ? spec.slice(eq + 1).trim() : "";
    if (!id || !evidence) return { error: `--evidence は AC-001=<テストの名前か、実行した命令と結果> の形で指定してください: ${spec}` };
    out.set(id, evidence);
  }
  return { value: out };
}

async function reportProgress(target: ReportTarget, flags: Record<string, string | boolean | string[]>): Promise<number> {
  const currentStep = str(flags["current-step"]);
  if (!currentStep) { process.stderr.write("--current-step を指定してください\n"); return 2; }
  const evidence = evidenceList(flags);
  if ("error" in evidence) { process.stderr.write(`${evidence.error}\n`); return 2; }
  const qaStatus: { qa_id: string; status: string; evidence?: string }[] = [];
  for (const spec of stringList(flags, "ac")) {
    const eq = spec.indexOf("=");
    const qaId = eq > 0 ? spec.slice(0, eq).trim() : "";
    const status = eq > 0 ? spec.slice(eq + 1).trim() : "";
    if (!qaId || !(AC_STATUS as readonly string[]).includes(status)) {
      process.stderr.write(`--ac は AC-001=verified の形で、状態は ${AC_STATUS.join(" / ")} のいずれかにしてください: ${spec}\n`);
      return 2;
    }
    qaStatus.push({ qa_id: qaId, status, ...(evidence.value.has(qaId) ? { evidence: evidence.value.get(qaId) as string } : {}) });
  }
  for (const id of evidence.value.keys()) {
    if (!qaStatus.some((q) => q.qa_id === id)) {
      process.stderr.write(`--evidence の ${id} に対応する --ac がありません\n`);
      return 2;
    }
  }
  const recentActivity = stringList(flags, "recent");
  const res = await postReport(target, "/api/idd/agent/progress", {
    idd_id: target.laneId,
    current_step: currentStep,
    qa_status: qaStatus,
    recent_activity: recentActivity,
  });
  return reportDone(res, { current_step: currentStep, qa_status: qaStatus.length, recent_activity: recentActivity.length });
}

async function reportResult(target: ReportTarget, flags: Record<string, string | boolean | string[]>): Promise<number> {
  const outcome = str(flags.outcome);
  if (!outcome || !(RESULT_OUTCOMES as readonly string[]).includes(outcome)) {
    process.stderr.write(`--outcome は ${RESULT_OUTCOMES.join(" / ")} のいずれかにしてください\n`);
    return 2;
  }
  const commitCount = countFlag(flags, "commit-count");
  if ("error" in commitCount) { process.stderr.write(`${commitCount.error}\n`); return 2; }
  const evidence = evidenceList(flags);
  if ("error" in evidence) { process.stderr.write(`${evidence.error}\n`); return 2; }
  const changedFiles = stringList(flags, "changed-file");
  const qaVerified = stringList(flags, "verified");
  const qaUnverified = stringList(flags, "unverified");
  for (const id of evidence.value.keys()) {
    if (!qaVerified.includes(id)) {
      process.stderr.write(`--evidence の ${id} に対応する --verified がありません\n`);
      return 2;
    }
  }
  const sideFindings = stringList(flags, "side-finding");
  const res = await postReport(target, "/api/idd/agent/result", {
    idd_id: target.laneId,
    outcome,
    changed_files: changedFiles,
    commit_count: commitCount.value,
    qa_verified: qaVerified,
    qa_unverified: qaUnverified,
    ...(evidence.value.size ? { qa_evidence: Object.fromEntries(evidence.value) } : {}),
    side_findings: sideFindings,
  });
  return reportDone(res, { outcome, changed_files: changedFiles.length, commit_count: commitCount.value, qa_verified: qaVerified.length, qa_unverified: qaUnverified.length, side_findings: sideFindings.length });
}

/**
 * `idd wait-run`: run one long command with the call in the foreground, returning every slice so the agent's turn
 * ends and a 5-minute run's cache does not expire. `--check NAME` runs a repo check the way `idd gate` does (its
 * command, its limit, and IDD_CHANGED_FILES); `-- <command>` wraps a literal one. A bad or missing argument is the
 * usage and exit 2.
 */
async function runWaitRunCommand(argv: string[]): Promise<number> {
  const { positional, flags, rest, missing } = parseArgs(argv, []);
  if (missing.length) {
    process.stderr.write(`値の付いていない flag があります: ${missing.map((f) => `--${f}`).join(" ")}\n${USAGE}`);
    return 2;
  }
  const check = str(flags.check);
  const command = rest.join(" ").trim() || positional.join(" ").trim();
  if (check && command) {
    process.stderr.write(`--check と -- <command> は同時に使えません\n${USAGE}`);
    return 2;
  }
  if (!check && !command) {
    process.stderr.write(USAGE);
    return 2;
  }
  const timeout = num(flags["timeout-minutes"]);
  return await runWaitRun({
    ...(check ? { check } : { command }),
    ...(timeout !== undefined ? { timeoutMinutes: timeout } : {}),
  });
}

export async function runLaneCommand(command: string, argv: string[]): Promise<number | undefined> {
  if (!["lane", "wt", "probe", "gate", "wait-run", "pr", "report", "out", "intent", "instruction"].includes(command)) return undefined;
  if (command === "instruction") return await runInstructionCommand(argv);
  const sub = argv[0];
  const { positional, flags, missing } = parseArgs(argv.slice(1), ["findings", "label", "ac", "recent", "changed-file", "verified", "unverified", "evidence", "side-finding", "choice"]);

  if (command === "wait-run") return await runWaitRunCommand(argv);

  if (command === "intent") {
    if (sub === "decisions") {
      if (!positional.length) { process.stderr.write(INTENT_USAGE); return 2; }
      const root = process.cwd();
      const index = decisionIndex({ source: { root }, root, paths: positional });
      out({ count: index.count, dropped: index.dropped, candidates: index.candidates });
      return 0;
    }
    if (sub === "anchors") {
      const root = process.cwd();
      const audit = auditAnchors({ root }, root);
      out({ missing: audit.missing, unreadable: audit.unreadable, missing_paths: audit.missing_paths, counts: { missing: audit.missing.length, unreadable: audit.unreadable.length, missing_paths: audit.missing_paths.length } });
      return 0;
    }
    const handled = await runIntentCommand(sub, { positional, flags, missing });
    if (handled !== undefined) return handled;
    process.stderr.write(INTENT_USAGE); return 2;
  }

  if (command === "lane") {
    if (sub === "run") {
      const spec = positional[0];
      if (!spec) { process.stderr.write(USAGE); return 2; }
      const rec = await runLane(resolve(expandHome(spec)), { wait: !flags["no-wait"], ...(str(flags.model) ? { model: str(flags.model) } : {}), dryRun: Boolean(flags["dry-run"]) });
      out(rec);
      return rec.status === "done" || rec.status === "running" || Boolean(flags["dry-run"]) ? 0 : 1;
    }
    if (sub === "status") { out(laneStatus(positional[0])); return 0; }
    if (sub === "tail") { if (!positional[0]) return 2; process.stdout.write(`${laneTail(positional[0], num(flags.lines) ?? 20)}\n`); return 0; }
    if (sub === "send") {
      const [id, text] = positional;
      if (!id || !text) { process.stderr.write(USAGE); return 2; }
      const rec = await sendLane(id, text, { wait: !flags["no-wait"] });
      out(rec);
      return rec.status === "failed" ? 1 : 0;
    }
    if (sub === "stop") { if (!positional[0]) return 2; out(stopLane(positional[0])); return 0; }
    if (sub === "roles") {
      const roles = readRoles();
      out({
        models: Object.values(roles.models).map((m) => ({ model: m.name, call: m.model, ...(m.provider ? { provider: m.provider } : {}), ...(m.providers ? { providers: m.providers } : {}), ...(m.fallback ? { fallback: m.fallback } : {}) })),
        roles: Object.values(roles.roles).map((r) => ({ role: r.name, harness: r.harness, model: r.modelName ?? "(未設定)", call: r.model || "(未設定)", thinking: r.thinking, tools: r.tools, report: r.report, budget_minutes: r.budgetMinutes, max_resumes: r.maxResumes })),
        pipeline: Object.entries(roles.pipeline).map(([slot, s]) => ({ slot, roles: s.roles, models: s.models.map((m) => m.name), runs: s.runs.map((run) => ({ role: run.role, ...(run.model ? { model: run.model } : {}), thinking: run.thinking })) })),
        profiles: Object.values(roles.profiles),
      });
      return 0;
    }
    process.stderr.write(USAGE); return 2;
  }

  if (command === "wt") {
    const repos = readLaneRepos();
    if (sub === "add") {
      // --from work cuts the copy from the work clone (commits that exist only there, no fetch)
      const known = repoByName(str(flags.repo) ?? "", repos);
      const repo = str(flags.from) === "work" ? fromWork(known) : known;
      out(addWorktree(repo, { ...(num(flags.pr) !== undefined ? { pr: num(flags.pr) } : {}), ...(str(flags.rev) ? { rev: str(flags.rev) } : {}), ...(str(flags.suffix) ? { suffix: str(flags.suffix) } : {}), ...(str(flags.name) ? { name: str(flags.name) } : {}), skipSetup: Boolean(flags["skip-setup"]) }));
      return 0;
    }
    if (sub === "move") {
      const path = positional[0]; if (!path) return 2;
      const repo = repoForPath(path, repos); if (!repo) throw new Error("repo を特定できません");
      out(moveWorktree(repo, path, { ...(num(flags.pr) !== undefined ? { pr: num(flags.pr) } : {}), ...(str(flags.rev) ? { rev: str(flags.rev) } : {}) }));
      return 0;
    }
    if (sub === "rm") {
      const path = positional[0]; if (!path) return 2;
      const repo = repoForPath(path, repos); if (!repo) throw new Error("repo を特定できません");
      out(removeWorktree(repo, path, { force: Boolean(flags.force) }));
      return 0;
    }
    if (sub === "list") { out(listWorktrees(repoByName(str(flags.repo) ?? "", repos))); return 0; }
    process.stderr.write(USAGE); return 2;
  }

  if (command === "probe") {
    const { positional: p2, flags: f2, rest: r2 } = parseArgs(argv, []);
    void p2;
    const wt = str(f2.wt); const run = str(f2.run);
    if (!wt || !run) { process.stderr.write(USAGE); return 2; }
    const res = runProbe({ worktree: wt, run, ...(str(f2.to) ? { to: str(f2.to), files: r2 } : {}), ...(str(f2.patch) ? { patch: str(f2.patch) } : {}), ...(str(f2.name) ? { name: str(f2.name) } : {}), ...(num(f2["timeout-minutes"]) !== undefined ? { timeoutMinutes: num(f2["timeout-minutes"]) } : {}) });
    if (str(f2.save)) (res as unknown as { saved: string }).saved = saveProbe(res, resolve(expandHome(str(f2.save) as string)));
    out(res);
    return res.clean_after ? 0 : 1;
  }

  if (command === "gate") {
    const { flags: f2 } = parseArgs(argv, []);
    const wt = str(f2.wt); if (!wt) { process.stderr.write(USAGE); return 2; }
    const only = str(f2.only)?.split(",").map((s) => s.trim()).filter(Boolean);
    const res = runGate(wt, { ...(only?.length ? { only } : {}), stopOnFail: Boolean(f2["stop-on-fail"]) });
    out(res);
    return res.ok ? 0 : 1;
  }

  if (command === "pr") {
    const repo = str(flags.repo); const n = num(positional[0]);
    if (!repo || n === undefined) { process.stderr.write(USAGE); return 2; }
    if (sub === "ctx") {
      const dir = str(flags.out); if (!dir) return 2;
      out(fetchPrContext(repo, n, dir, { ...(str(flags.since) ? { since: str(flags.since) } : {}) }));
      return 0;
    }
    if (sub === "post") {
      const event: "approve" | "comment" | "request-changes" | null = flags.approve ? "approve" : flags.comment ? "comment" : flags["request-changes"] ? "request-changes" : null;
      const bodyFile = str(flags["body-file"]); const expect = str(flags["expect-head"]);
      if (!event || !bodyFile || !expect) { process.stderr.write(USAGE); return 2; }
      // the head is read before the draft is made, so a stale draft never reaches the card; the post checks it again
      const pr = prStatus(repo, n);
      if (!pr.head.startsWith(expect)) {
        process.stderr.write(`head が変わっています: 期待 ${expect} / 実際 ${pr.head.slice(0, 9)}。取り直してから下書きを作ってください\n`);
        return 1;
      }
      const body = readFileSync(resolve(expandHome(bodyFile)), "utf8");
      // refuse here what the card's post would refuse, so a card that cannot be posted never reaches the inbox
      if (!body.trim() && event !== "approve") { process.stderr.write("本文が空です（approve 以外のレビューには本文が要ります）\n"); return 1; }
      if (body.includes(AI_MARKER)) { process.stderr.write(`本文に AI マーカー（${AI_MARKER}）が残っています\n`); return 1; }
      const title = `#${n} ${pr.title}`;
      const target = { repo, pr: n, expectHead: expect, event };
      // nothing is posted here: the review goes out only when penne approves the card in the inbox
      if (flags["dry-run"]) {
        out({ ok: true, dry_run: true, target, title, draft: body, next: "受信箱の送出カードで penne が確認・承認すると投稿されます" });
        return 0;
      }
      const rec = await createOutbound({ kind: "gh-pr-review", target, title, body, noRewrite: true, source: `idd pr post ${repo}#${n}` });
      out({ ok: true, id: rec.id, status: rec.status, url: inboxCardUrl(rec.id), next: "受信箱の送出カードで penne が確認・承認すると投稿されます。レビューの種類とラベルはカードで選べます" });
      return 0;
    }
    process.stderr.write(USAGE); return 2;
  }

  // a repo in config/repos.yaml gives its language, templates, skills and labels; any other repo only its labels.
  // A repo that is not registered is drafted without a pointer; a registry that cannot be read throws: a wrong setting is
  // not the same as no setting, and the Issue is not drafted as if the repo pointed at nothing
  const issueContext = (repo: string): string => {
    const found = findRepoByGithub(repo);
    // no repo found means no pointer to read: the registry is not asked again for a pointer it just could not give
    return publicWritingContext(found?.clone ?? process.cwd(), { kind: "issue", repo, ...(found ? {} : { conventions: {} }), ...(found?.language ? { language: found.language } : {}) });
  };
  /**
   * The repos a chat handoff may be addressed to, and what each one asks of an Issue: the intake labels the
   * registry filters on, and the language of its public side. Read from the same registry the engine's intake
   * reads (githubAreas), so the CLI and the engine never disagree about which repos take GitHub Issues in.
   * Nothing is written and gh is not called. A broken registry is an error: a guessed answer would put a wrong
   * label on the card, or send an Issue where no lane would ever start.
   */
  const laneTargets = (): { targets: { repo: string; labels: string[]; language: string }[] } | { error: string } => {
    let areas: ReturnType<typeof githubAreas>;
    try {
      areas = githubAreas();
    } catch (err) {
      return { error: `取り込みの設定を読めませんでした: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!areas.length) return { targets: [] };
    let repos: Record<string, LaneRepo>;
    try {
      repos = readLaneRepos();
    } catch (err) {
      return { error: `取り込みの設定を読めませんでした: ${err instanceof Error ? err.message : String(err)}` };
    }
    return {
      targets: areas.map((a) => {
        const found = Object.values(repos).find((r) => r.github?.toLowerCase() === a.repo.toLowerCase());
        return { repo: a.repo, labels: a.labels, language: found?.language ?? "日本語" };
      }),
    };
  };
  /**
   * The intake labels of one destination repo. `--lane` refuses a repo the registry does not take GitHub Issues
   * from, before any draft exists: an Issue without every label is not taken in, and the labels are part of what
   * the card's signature covers. A repo with no label condition is a valid destination and gets no labels.
   */
  const laneLabels = (repo: string): { labels: string[] } | { error: string } => {
    const resolved = laneTargets();
    if ("error" in resolved) return resolved;
    const found = resolved.targets.find((t) => t.repo.toLowerCase() === repo.toLowerCase());
    if (!found) {
      const names = resolved.targets.map((t) => t.repo).join(", ") || "なし";
      return { error: `${repo || "(repo 未指定)"} は GitHub の Issue を取り込む repo として登録されていません。渡せる repo: ${names}` };
    }
    return { labels: found.labels };
  };
  if (command === "out") {
    // There is deliberately no approve here: approval is penne's, on the inbox card or from `idd approve CARD`, and
    // both send their proof to the engine's decision door. Nothing here posts, pushes or opens a card as approved.
    if (sub === "draft") {
      const kind = str(flags.kind) as OutboundKind | undefined;
      const title = str(flags.title);
      const bodyFile = str(flags["body-file"]);
      const body = bodyFile ? readFileSync(resolve(expandHome(bodyFile)), "utf8") : str(flags.body);
      // a PR body update keeps the PR's title unless one is given
      if (!kind || !OUTBOUND_KINDS.includes(kind) || (!title && kind !== "gh-pr-body") || body === undefined) { process.stderr.write(USAGE); return 2; }
      if (kind === "gh-pr-body" && (!str(flags.repo) || num(flags.pr) === undefined)) { process.stderr.write(USAGE); return 2; }
      const repo = str(flags.repo);
      const explicitLabels = (flags.label as string[] | undefined) ?? [];
      let labels = explicitLabels;
      // only --lane reads the registry: a call without it keeps working even when the registry is broken, so the
      // follow-up Issue path (which never asks for intake labels) is not tied to it
      if (kind === "gh-issue" && flags.lane) {
        const resolved = laneLabels(repo ?? "");
        if ("error" in resolved) { process.stderr.write(`${resolved.error}\n`); return 1; }
        labels = [...new Set([...resolved.labels, ...explicitLabels])];
      }
      const lane = requestingLane();
      let context: string | undefined;
      if (kind === "gh-issue" && repo) {
        try { context = issueContext(repo); } catch (err) { process.stderr.write(`repo の登録を読めません: ${err instanceof Error ? err.message : String(err)}\n`); return 1; }
      }
      const rec = await createOutbound({
        kind,
        title: title ?? "",
        body,
        target: kind === "gh-issue"
          ? { repo, ...(labels.length ? { labels } : {}) }
          : kind === "gh-pr-body"
            ? { repo, pr: num(flags.pr) }
            : { visibility: flags.public ? "public" : "private" },
        ...(str(flags.source) ? { source: str(flags.source) } : {}),
        noRewrite: Boolean(flags["no-rewrite"]),
        // the lane that asked is only the one the harness named in the environment (a conversation's IDD_ID, a stage
        // run's IDD_RUN_LANE); a call from outside has none
        ...(lane ? { lane } : {}),
        ...(context !== undefined ? { context } : {}),
      });
      out({ id: rec.id, status: rec.status, rewritten: Boolean(rec.rewritten), ...(rec.rewrite?.error ? { rewrite_error: rec.rewrite.error } : {}), url: inboxCardUrl(rec.id), next: "受信箱の送出カードで penne が確認・承認すると投稿されます" });
      return 0;
    }
    if (sub === "targets") {
      const resolved = laneTargets();
      if ("error" in resolved) { process.stderr.write(`${resolved.error}\n`); return 1; }
      out(resolved.targets);
      return 0;
    }
    if (sub === "list") {
      out((flags.all ? listOutbound() : listOutbound(["ready", "failed"])).map((r) => ({ id: r.id, kind: r.kind, title: r.title, status: r.status, ...(r.posted ? { url: r.posted.url } : {}), ...(r.error ? { error: r.error } : {}) })));
      return 0;
    }
    if (sub === "show") {
      const rec = positional[0] ? readOutbound(positional[0]) : null;
      if (!rec) { process.stderr.write(USAGE); return 2; }
      out(rec);
      return 0;
    }
    process.stderr.write(USAGE); return 2;
  }

  if (command === "report") {
    // a valued flag that took nothing would reach the API as "true": refuse before sending, and say how to
    // pass a value that starts with `--`
    if (missing.length) {
      process.stderr.write(`値の付いていない flag があります: ${missing.map((f) => `--${f}`).join(" ")}。値が -- で始まるときは --flag=値 の形で渡してください\n`);
      return 2;
    }
    if (sub === "questions" || sub === "plan" || sub === "progress" || sub === "result" || sub === "granularity") {
      const target = reportTarget(flags);
      if ("error" in target) { process.stderr.write(`${target.error}\n`); return 2; }
      if (sub === "questions") return await reportQuestions(target, flags);
      if (sub === "granularity") return await reportGranularity(target, flags);
      if (sub === "plan") return await reportPlan(target, flags);
      if (sub === "progress") return await reportProgress(target, flags);
      return await reportResult(target, flags);
    }
    if (sub !== "merge") { process.stderr.write(USAGE); return 2; }
    const files = ((flags.findings as string[] | undefined) ?? []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
    if (!files.length) { process.stderr.write(USAGE); return 2; }
    const lists = files.map((f) => readFindings(f, f.split("/").pop()?.replace(/\.json$/, "")));
    let existing: ReturnType<typeof splitComments> = [];
    if (str(flags.comments)) {
      const raw = JSON.parse(readFileSync(resolve(expandHome(str(flags.comments) as string)), "utf8")) as { author: string; body: string }[];
      existing = splitComments(raw);
    }
    const merged = mergeFindings(lists, existing);
    const draft = renderDraft(merged, { ...(str(flags.intro) ? { intro: str(flags.intro) } : {}), includeDuplicates: Boolean(flags["include-duplicates"]) });
    if (str(flags.out)) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(resolve(expandHome(str(flags.out) as string)), draft);
    } else process.stdout.write(draft);
    out({ by_severity: merged.by_severity, duplicates: merged.duplicates, total: merged.findings.length, ...(str(flags.out) ? { written: str(flags.out) } : {}) });
    return 0;
  }
  return undefined;
}

const LANE_REDO_USAGE = "usage: idd lane redo IDD-xxx   # lane を閉じ、同じ起票を読み直して新しい lane を開く（無視リストには入れない）";

/**
 * `idd lane redo IDD-xxx`: close the lane and open a new one from the same Issue, read again by name. It runs
 * before `idd lane`'s other verbs: those are idd-lane's own (`run`, `status`, `stop` ...) and would answer an
 * unknown verb with the usage. The write is followed by a tick, so the new lane's planner starts without waiting
 * for the timer; the tick is best effort, like the one after the other commands that record something.
 */
export async function runLaneRedoCommand(command: string, args: string[], deps: { redo?: typeof redoLane; tick?: () => TickKick } & LinearIntakeDeps = {}): Promise<number | undefined> {
  if (command !== "lane" || args[0] !== "redo") return undefined;
  const id = args.slice(1).find((a) => !a.startsWith("--"));
  if (!id) { process.stderr.write(`${LANE_REDO_USAGE}\n`); return 2; }
  const { redo = redoLane, tick = requestTick, ...intakeDeps } = deps;
  const res = await redo(id, intakeDeps);
  out({ ok: res.ok, ...(res.from ? { from: res.from } : {}), ...(res.iddId ? { idd_id: res.iddId } : {}), ...(res.stopped ? { stopped: res.stopped } : {}), ...(res.error ? { error: res.error } : {}) });
  if (!res.ok) return 1;
  try {
    const kick = tick();
    if (kick.outcome === "failed") process.stderr.write(`次の tick を頼めませんでした: ${kick.detail ?? ""}\n`);
  } catch (err) {
    process.stderr.write(`次の tick を頼めませんでした: ${String(err)}\n`);
  }
  return 0;
}

const REVIEW_MAP_USAGE = "usage: idd review map --wt PATH --base REV --head REV [--role risk-mapper] [--out DIR] [--title T] [--no-wait] [--dry-run]   # 地図の段だけを走らせ、経路ごとの blind の spec を書き出す（閾値によらず走る）\n";

/** the blind specs a map wrote, the copies they point at, and the one command that removes the copies with their records */
export function blindFields(blind: MappedBlindSpecs, hadRoutes: boolean): Record<string, unknown> {
  return {
    blind_specs: blind.specs.map((b) => ({ label: b.label, role: b.role, spec: b.specPath, worktree: b.worktree, report_json: `${b.report}.json` })),
    ...(hadRoutes && !blind.specs.length ? { blind_note: "pipeline.review_blind が未宣言なので、blind の spec は書いていない" } : {}),
    ...(blind.copyRoot ? { blind_copies: { root: blind.copyRoot, remove: `rm -rf '${blind.copyRoot.replace(/'/g, "'\\''")}'` } } : {}),
    ...(blind.specs.length ? { next: blind.copyRoot
      ? "blind_specs は記録を剥がした複製（blind_copies.root の下、spec ごとに 1 つ）を指す。idd lane run で走らせ、済んだら blind_copies.remove で複製と記録を消す"
      : "blind_specs は map をかけた worktree を指す（剥がす記録の行が無い repo）。同じ worktree を共有するので、idd lane run で 1 本ずつ走らせる" } : {}),
  };
}

/**
 * `idd review map`: the map stage alone, for comparing a mapped round with the usual one. Once the map is
 * done, the specs its blinds would get are written next to it, to run by hand with `idd lane run`.
 */
export async function runReviewMapCommand(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv, []);
  const wt = str(flags.wt); const base = str(flags.base); const head = str(flags.head);
  if (!wt || !base || !head) { process.stderr.write(REVIEW_MAP_USAGE); return 2; }
  const res = await runRiskMap(
    { worktree: wt, base, head, ...(str(flags.role) ? { role: str(flags.role) } : {}), ...(str(flags.out) ? { out: str(flags.out) } : {}), ...(str(flags.title) ? { title: str(flags.title) } : {}) },
    { wait: !flags["no-wait"], dryRun: Boolean(flags["dry-run"]) },
  );
  out({
    ...(res.lane ? { lane: res.lane.id, status: res.lane.status } : {}),
    spec: res.specPath,
    report_md: `${res.report}.md`,
    report_json: `${res.report}.json`,
    diff_lines: res.diffLines,
    min_lines: res.minLines,
    max_routes: res.maxRoutes,
    // what the tick would do with this diff: map it only when both slots are declared and the diff is large enough
    pipeline_would_map: res.skipReason === null,
    ...(res.skipReason ? { map_skip_reason: res.skipReason } : {}),
    ...(res.routes ? { routes: res.routes } : {}),
    ...(res.blind ? blindFields(res.blind, Boolean(res.routes?.length)) : {}),
    ...(res.lane?.usage ? { usage: res.lane.usage } : {}),
    ...(res.lane?.duration_ms !== undefined ? { duration_ms: res.lane.duration_ms } : {}),
    ...(res.lane?.error ? { error: res.lane.error } : {}),
  });
  if (!res.lane) return 0;
  return res.lane.status === "done" || res.lane.status === "running" ? 0 : 1;
}

export function laneUsage(): string {
  return USAGE;
}
