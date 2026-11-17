/**
 * `idd approve CARD`: the terminal's way to pass one card's approval with the PIN.
 *
 * A card that can leave this machine or change the work side's mainline is signed by the screen with a passkey or a
 * PIN. The terminal does the PIN's half only: it asks the engine for the approval's own challenge, shows the content
 * the engine made that challenge over, types the PIN on the controlling terminal, derives the same key the screen
 * derives, and hands the proof to the same decision door the screen uses. Nothing leaves this machine from here: the
 * push, the pull request, the post and the landing stay in the engine's gate.
 *
 * What the person approves is the content the engine returned, not a copy this command built. The challenge is
 * `SHA-256(contentHash + nonce)`, so the content is written to the terminal the PIN is read from, in full and with the
 * characters a terminal would obey shown instead of obeyed, the challenge is rebuilt from the raw content, and a PIN
 * is asked for only when the two agree and the content reached the terminal. Nothing signed goes to stdout: the person
 * reads it on the terminal even when this command's output is sent elsewhere. The approval's payload is built by the
 * screen's own functions, so the terminal cannot drift from the card's defaults; reading another package's source by a
 * relative path is what this binary already does for the lane's modules.
 *
 * The PIN is read from `/dev/tty` with echo off, never from an argument, the environment, a file or piped stdin, and
 * it is stretched into a key in memory only. A process without a controlling terminal (a lane's shell) is refused
 * before the engine is asked anything, so only the person in front of the terminal can type it. One run approves one
 * card, and the next run asks for the PIN again.
 */
import { createHash, createPrivateKey, pbkdf2Sync, sign as ed25519Sign } from "node:crypto";
import { openSync, writeSync } from "node:fs";
import { ReadStream } from "node:tty";

import { agentBaseUrl, contentHash } from "../../idd-core/src/index.ts";

export const APPROVE_USAGE = "usage: idd approve CARD   # 署名の要る card を 1 枚、端末で PIN を入れて通す（card は IDD-xxx か OUT-xxx か、まとめた取り込みの batch:xxx）\n       idd approve batch:xxx --off=IDD-1,IDD-2   # まとめた取り込みから外す lane を指す";

/** the controlling terminal: content in full, one line at a time, echo off, never handed to another process */
export interface Terminal {
  /**
   * Write what is about to be signed to the terminal the PIN is read from, so the person reads it there whether or not
   * the command's own output is on a terminal or sent elsewhere.
   */
  show(text: string): { ok: true } | { ok: false; reason: string };
  /** ask the person for one line and read it */
  readSecret(prompt: string): Promise<{ ok: true; value: string } | { ok: false; reason: string }>;
  close(): void;
}

export interface ApproveDeps {
  fetch?: typeof fetch;
  baseUrl?: () => string;
  /** the controlling terminal; swapped in the tests so no test opens the person's own terminal */
  openTerminal?: () => { ok: true; terminal: Terminal } | { ok: false; error: string };
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

interface ChallengeAnswer {
  ok?: boolean;
  error?: string;
  required?: boolean;
  registered?: number;
  nonce?: string;
  challenge?: string;
  expiresAt?: string;
  content?: Record<string, unknown>;
}

interface PinStatusAnswer {
  ok?: boolean;
  error?: string;
  configured?: boolean;
  lockedUntil?: string | null;
  digits?: number;
  salt?: string;
  kdf?: { name?: string; hash?: string; iterations?: number };
}

/** what the card would send, as the screen's own builders return it */
interface ApprovalView {
  ready: boolean;
  why: string | null;
  sign: boolean;
  primary?: "approve" | "check" | "none";
  payload: Record<string, unknown>;
  confirmRows: { label: string; value: string }[];
}

/** the screen's builders, read from this checkout the way the CLI reads the lane's modules */
interface ScreenApprovalModule {
  buildShipApproval(item: unknown, draft: unknown): ApprovalView;
  shipDraftFor(item: unknown): unknown;
  buildOutboundApproval(item: unknown, draft: unknown): ApprovalView;
  outboundDraftFor(item: unknown): unknown;
  buildBatchApproval(item: unknown, draft: { off: ReadonlySet<string> }): ApprovalView;
}

let screenModule: Promise<ScreenApprovalModule> | undefined;

/**
 * The payload of an approval is what the card would send, so it is built by the screen's own functions and never by a
 * copy here: a second copy would drift from the card the person is looking at. Those functions are the screen's
 * (they read other packages through the checker the screen is built with), so they are taken when this command runs.
 */
async function screenApproval(): Promise<ScreenApprovalModule> {
  screenModule ??= import("../../idd-gui/src/inbox/approval.ts") as Promise<unknown> as Promise<ScreenApprovalModule>;
  return screenModule;
}

interface DecideAnswer {
  ok?: boolean;
  error?: string;
  prUrl?: string;
  [key: string]: unknown;
}

/** how long the PIN prompt waits: the challenge it would sign is good for five minutes */
const PIN_WAIT_MS = 4 * 60_000;

/** the digits a PIN has unless the engine's record says otherwise */
const PIN_DIGITS = 6;

/** the DER prefix of an Ed25519 private key, so the seed the PIN stretches can be imported as PKCS#8 */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Open the controlling terminal. `/dev/tty` is the terminal the process was started from, not stdin: a pipeline or a
 * lane's shell has no such device, and opening it there fails, which is the refusal the PIN needs. The stream owns
 * the file descriptor and closes it on `destroy`, so a closed terminal leaves no open handle behind (this binary ends
 * by itself, and a forgotten handle would keep it alive).
 */
export function openControllingTerminal(): { ok: true; terminal: Terminal } | { ok: false; error: string } {
  let fd: number;
  try {
    // read and write: the prompt goes to the terminal itself, so it is still shown when the command's output is sent elsewhere
    fd = openSync("/dev/tty", "r+");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    return {
      ok: false,
      error: `制御端末がありません（/dev/tty: ${code}）。PIN は端末の前の人が打つもので、引数・環境変数・ファイル・パイプの標準入力からは受け取りません。端末から実行してください`,
    };
  }
  const stream = new ReadStream(fd);
  stream.setEncoding("utf8");
  let raw = false;
  // a process that ends while the terminal is raw would leave the person's terminal without echo: put it back
  const restore = () => {
    if (!raw) return;
    try { stream.setRawMode(false); } catch { /* a terminal that is already gone needs nothing */ }
    raw = false;
  };
  process.once("exit", restore);
  return {
    ok: true,
    terminal: {
      show(text: string) {
        const buffer = Buffer.from(text, "utf8");
        try {
          // a write on a terminal can come back short: keep going until every byte of the content is there
          let offset = 0;
          while (offset < buffer.length) {
            const written = writeSync(fd, buffer, offset, buffer.length - offset);
            if (written <= 0) return { ok: false, reason: "端末へ書き切れませんでした" };
            offset += written;
          }
          return { ok: true };
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? "unknown";
          return { ok: false, reason: `端末へ書けませんでした（${code}）` };
        }
      },
      readSecret(prompt: string) {
        return new Promise((resolve) => {
          let value = "";
          let settled = false;
          const finish = (result: { ok: true; value: string } | { ok: false; reason: string }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stream.off("data", onData);
            restore();
            try { writeSync(fd, "\n"); } catch { /* a terminal that is already gone needs nothing */ }
            stream.pause();
            resolve(result);
          };
          // raw mode is what keeps the typed characters off the screen: echo off, one byte at a time
          try {
            stream.setRawMode(true);
            raw = true;
            writeSync(fd, prompt);
          } catch {
            resolve({ ok: false, reason: "端末から PIN を読めませんでした（この端末では echo を止められません）" });
            return;
          }
          const timer = setTimeout(() => finish({ ok: false, reason: "PIN の入力がありませんでした（時間切れ）。もう一度 idd approve からやり直してください" }), PIN_WAIT_MS);
          timer.unref?.();
          const onData = (chunk: string) => {
            for (const ch of chunk) {
              if (ch === "\r" || ch === "\n") { finish({ ok: true, value }); return; }
              // a raw terminal sends Ctrl-C and Ctrl-D as bytes: they cancel without a signal
              if (ch === "\u0003" || ch === "\u0004") { finish({ ok: false, reason: "PIN の入力を取りやめました" }); return; }
              if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; }
              if (ch < " ") continue;
              value += ch;
            }
          };
          stream.on("data", onData);
          stream.resume();
        });
      },
      close() {
        restore();
        process.off("exit", restore);
        stream.pause();
        stream.destroy();
      },
    },
  };
}

async function getJson<T>(fetchFn: typeof fetch, url: string): Promise<{ status: number; body: T }> {
  const res = await fetchFn(url, { headers: { Accept: "application/json" } });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

async function postJson<T>(fetchFn: typeof fetch, url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const answer = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body: answer };
}

/** the challenge the engine made from this content and nonce: what a signer rebuilds to see the two are one thing */
export function challengeFor(content: unknown, nonce: string): string {
  return createHash("sha256").update(`${contentHash(content)}.${nonce}`).digest("base64url");
}

/** the RP ID a terminal names: none on loopback (the engine's own local one), the host on a tailnet address */
export function rpIdForBase(baseUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const loopback = bare === "localhost" || bare.endsWith(".localhost") || bare === "::1" || /^127\.\d+\.\d+\.\d+$/.test(bare);
  return loopback ? undefined : bare;
}

/** the proof over this challenge text, made with the key the PIN derives: the screen's derivation, done here */
export function pinProofFor(pin: string, salt: string, iterations: number, challenge: string): string {
  const seed = pbkdf2Sync(pin, Buffer.from(salt, "base64url"), iterations, 32, "sha256");
  try {
    const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
    return ed25519Sign(null, Buffer.from(challenge, "utf8"), key).toString("base64url");
  } finally {
    // the stretched key is worth the PIN: nothing keeps it past this signature
    seed.fill(0);
  }
}

// ---------------------------------------------------------------- showing what is signed

const KIND_LABEL: Record<string, string> = {
  ship: "提出（push・PR の作成）",
  land: "取り込み（work 側の本流へ merge）",
  "local-complete": "ローカル完了（記録の回収。push も PR も作りません）",
  outbound: "投稿（外への書き込み）",
  "land-batch": "まとめた取り込み（work 側の本流へ lane を重ねて merge）",
};

/**
 * The characters a terminal would obey, shown instead of obeyed: a control character in a commit message or a PR body
 * could otherwise move the cursor over the lines around it and make the person read something other than what is
 * signed. The raw value still goes to the challenge and the decision; only what is written to the terminal changes.
 */
const VISIBLE_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

export function terminalText(value: unknown): string {
  let out = "";
  for (const ch of String(value ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    // the escape itself first, so "\\x1b" in the content cannot be read as an escape this function wrote
    if (ch === "\\") { out += "\\\\"; continue; }
    const named = VISIBLE_ESCAPES[ch];
    if (named) { out += named; continue; }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) { out += `\\x${code.toString(16).padStart(2, "0")}`; continue; }
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) { out += `\\u${code.toString(16).padStart(4, "0")}`; continue; }
    out += ch;
  }
  return out;
}

function pushText(lines: string[], label: string, text: unknown): void {
  lines.push(`${terminalText(label)}:`);
  for (const line of String(text ?? "").split("\n")) lines.push(`  ${terminalText(line)}`);
}

function pushValue(lines: string[], label: string, value: unknown): void {
  lines.push(`${terminalText(label)}: ${value === null || value === undefined || value === "" ? "（なし）" : terminalText(value)}`);
}

/**
 * The content, field by field, with every text in full. A field this does not know is printed as its own JSON line
 * rather than left out: what is shown has to be what the challenge covers, all of it.
 */
export function contentLines(content: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const shown = new Set<string>();
  const take = (key: string): unknown => { shown.add(key); return content[key]; };
  const kind = String(take("kind") ?? "");
  lines.push(`種類: ${terminalText(KIND_LABEL[kind] ?? kind)}`);

  if (kind === "ship") {
    pushValue(lines, "lane", take("iddId"));
    pushValue(lines, "宛先の repo", take("repo"));
    pushValue(lines, "lane の branch", take("branch"));
    pushValue(lines, "PR の base", take("base"));
    pushValue(lines, "公開する tree", take("publicTree"));
    pushText(lines, "commit message", take("commitMessage"));
    const pr = take("pr") as { title?: unknown; body?: unknown } | null;
    if (pr) {
      pushValue(lines, "PR の題", pr.title);
      pushText(lines, "PR の本文", pr.body);
    } else {
      lines.push("PR: 作りません（既にある PR への push、または push の記録だけ）");
    }
  } else if (kind === "land") {
    pushValue(lines, "lane", take("iddId"));
    pushValue(lines, "宛先の repo", take("repo"));
    pushValue(lines, "work 側の本流の branch", take("workBase"));
    pushValue(lines, "lane の head", take("head"));
    const close = take("close") as { repo?: unknown; issue?: unknown; comment?: unknown } | null;
    if (close) {
      pushValue(lines, "閉じる Issue", `${String(close.repo ?? "")}#${String(close.issue ?? "")}`);
      pushText(lines, "close に添える一言", close.comment);
    } else {
      lines.push("閉じる Issue: なし");
    }
  } else if (kind === "land-batch") {
    pushValue(lines, "宛先の repo", take("repo"));
    pushValue(lines, "work 側の本流の branch", take("workBase"));
    const batched = (take("lanes") ?? []) as { iddId?: unknown; head?: unknown; close?: { repo?: unknown; issue?: unknown; comment?: unknown } | null }[];
    lines.push(`取り込む lane（この順に重ねます）: ${batched.length} 本`);
    for (const lane of batched) {
      pushValue(lines, "  lane", lane.iddId);
      pushValue(lines, "  lane の head", lane.head);
      if (lane.close) {
        pushValue(lines, "  閉じる Issue", `${String(lane.close.repo ?? "")}#${String(lane.close.issue ?? "")}`);
        pushText(lines, "  close に添える一言", lane.close.comment);
      } else {
        lines.push("  閉じる Issue: なし");
      }
    }
  } else if (kind === "local-complete") {
    pushValue(lines, "lane", take("iddId"));
    pushValue(lines, "宛先の repo", take("repo"));
    pushValue(lines, "work 側の本流の branch", take("workBase"));
    pushValue(lines, "lane の head", take("head"));
  } else if (kind === "outbound") {
    const target = (take("target") ?? {}) as Record<string, unknown>;
    pushValue(lines, "投稿の ID", take("id"));
    pushValue(lines, "投稿の種類", take("outKind"));
    lines.push("宛先:");
    for (const [key, value] of Object.entries(target)) {
      if (value === null || value === undefined) continue;
      lines.push(`  ${terminalText(key)}: ${terminalText(Array.isArray(value) ? value.join(", ") : value)}`);
    }
    pushValue(lines, "題", take("title"));
    pushText(lines, "本文", take("body"));
    const parts = take("parts") as Record<string, unknown>[] | null;
    for (const part of parts ?? []) {
      lines.push(`返信 ${terminalText(part.ref)}（thread: ${terminalText(part.thread_id ?? "なし")} / 返信先の comment: ${terminalText(part.comment_id ?? "なし")} / ラベル: ${terminalText(part.label ?? "なし")} / ${part.resolve === true ? "Resolve する" : "開いたまま"}）:`);
      if (part.quote !== null && part.quote !== undefined) pushText(lines, "  引用", part.quote);
      pushText(lines, "  本文", part.body);
    }
    const labels = take("labels") as { remove?: unknown[]; add?: unknown[] } | null;
    if (labels) {
      pushValue(lines, "外すラベル", (labels.remove ?? []).join(", "));
      pushValue(lines, "付けるラベル", (labels.add ?? []).join(", "));
    }
  }

  for (const key of Object.keys(content)) {
    if (!shown.has(key)) lines.push(`${terminalText(key)}: ${terminalText(JSON.stringify(content[key]))}`);
  }
  return lines;
}

/** a sha as a heading names it: the first seven characters, or that the record has none */
function shortSha(value: unknown): string {
  const sha = String(value ?? "").trim();
  return sha ? sha.slice(0, 7) : "なし";
}

/**
 * The result of every check the record holds, in the record's own order and in full: a handed-over line comes first
 * with the mark saying which mainline tip it was taken at, and nothing is dropped by name or cut by length. A result
 * the person cannot read here is one they sign without having seen.
 */
function recordCheckLines(lines: string[], checks: unknown): void {
  const rows = Array.isArray(checks) ? (checks as { name?: unknown; status?: unknown; severity?: unknown; detail?: unknown }[]) : [];
  if (!rows.length) {
    lines.push("  （検査の結果が記録にありません）");
    return;
  }
  for (const check of rows) {
    lines.push(`  ${terminalText(check.name)}: ${terminalText(check.status)}（${terminalText(check.severity)}）`);
    if (check.detail === null || check.detail === undefined || String(check.detail) === "") continue;
    for (const line of String(check.detail).split("\n")) lines.push(`    ${terminalText(line)}`);
  }
}

/**
 * The checks the card carries: they are not in the signature, but the person is asked to read them too. The landing's
 * record and the submit's record are both read here, with the checks the engine actually ran for this card: the
 * card's own rows alone do not say which check ran against which mainline tip.
 */
export function checkLines(item: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const checks = Array.isArray(item.checks) ? (item.checks as { label?: unknown; ok?: unknown }[]) : [];
  if (checks.length) {
    lines.push("card の検査:");
    for (const check of checks) lines.push(`  ${check.ok === true ? "○" : "×"} ${terminalText(check.label)}`);
  }
  const warnings = Array.isArray(item.checkWarnings) ? (item.checkWarnings as { name?: unknown; reason?: unknown }[]) : [];
  for (const warning of warnings) lines.push(`止めない検査の警告: ${terminalText(warning.name)}${warning.reason ? ` — ${terminalText(warning.reason)}` : ""}`);
  const blocked = item.blocked && typeof item.blocked === "object" ? (item.blocked as { reasons?: unknown[] }).reasons : undefined;
  for (const reason of Array.isArray(blocked) ? blocked : []) lines.push(`止まっている理由: ${terminalText(reason)}`);
  // the landing: the mainline tip and the merge commit the results were run at, then each check as the record keeps it
  const land = item.land && typeof item.land === "object" ? (item.land as Record<string, unknown>) : undefined;
  if (land) {
    lines.push(`実行した検査（本流 ${shortSha(land.mainTip)} / merge ${shortSha(land.mergeCommit)}）:`);
    recordCheckLines(lines, land.checks);
  }
  // the submit: the checks the export ran, with the same shape and the same full detail
  const proposal = item.proposal && typeof item.proposal === "object" ? (item.proposal as Record<string, unknown>) : undefined;
  if (proposal) {
    lines.push("提出の検査:");
    recordCheckLines(lines, proposal.checks);
  }
  return lines;
}

// ---------------------------------------------------------------- the command

/** the card this name points at, or why it cannot be approved from here */
function findCard(items: Record<string, unknown>[], card: string):
  | { ok: true; item: Record<string, unknown>; kind: "ship" | "outbound" | "land-batch" }
  | { ok: false; error: string } {
  const signable = (item: Record<string, unknown>) => item.kind === "ship" || item.kind === "outbound" || item.kind === "land-batch";
  const found = items.find((item) => String(item.iddId ?? "") === card && signable(item));
  if (found) return { ok: true, item: found, kind: found.kind as "ship" | "outbound" | "land-batch" };
  const open = items.filter(signable).map((item) => `${String(item.iddId ?? "")}（${String(item.kind)}）`);
  return {
    ok: false,
    error: `card がありません: ${card}${open.length ? `。承認できる card: ${open.join(", ")}` : "（開いている card はありません）"}`,
  };
}

/**
 * One card, end to end: the card's own payload, the engine's challenge over it, the content in full, the PIN, the
 * proof, and the same decision the screen sends. The PIN and the key it derives live no longer than this function's
 * locals: they are not written down, not put in the environment, and not handed to another process.
 */
export async function runApproveCommand(argv: readonly string[], deps: ApproveDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const rest = argv.filter((a) => a !== "--");
  // the lanes taken off a batch card: `--off=IDD-1,IDD-2` (the screen takes them off with a switch on each row)
  const off = new Set(rest.filter((a) => a.startsWith("--off=")).flatMap((a) => a.slice("--off=".length).split(",")).map((x) => x.trim()).filter(Boolean));
  const args = rest.filter((a) => !a.startsWith("--off="));
  const flags = args.filter((a) => a.startsWith("-"));
  if (flags.length) {
    err(`idd approve に知らない指定です: ${flags.join(" ")}\n${APPROVE_USAGE}\n`);
    return 2;
  }
  if (!args.length) {
    err(`${APPROVE_USAGE}\n`);
    return 2;
  }
  // one run, one card: a second name would be a second signature from one PIN
  if (args.length > 1) {
    err(`1 回の起動で承認できる card は 1 枚だけです: ${args.join(" ")}\n`);
    return 2;
  }
  const card = args[0];
  // the terminal comes first: without one there is no PIN to read, so the engine is asked nothing at all
  const opened = (deps.openTerminal ?? openControllingTerminal)();
  if (!opened.ok) {
    err(`${opened.error}\n`);
    return 1;
  }
  try {
    return await approveOne(card, opened.terminal, deps, out, err, off);
  } catch (error) {
    err(`承認できませんでした: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    opened.terminal.close();
  }
}

async function approveOne(
  card: string,
  terminal: Terminal,
  deps: ApproveDeps,
  out: (s: string) => void,
  err: (s: string) => void,
  off: ReadonlySet<string> = new Set(),
): Promise<number> {
  const fetchFn = deps.fetch ?? fetch;
  const base = (deps.baseUrl ?? agentBaseUrl)().replace(/\/+$/, "");
  const fail = (message: string): number => { err(`${message}\n`); return 1; };

  // the card, and the payload the screen would send for it
  let state: { status: number; body: { items?: Record<string, unknown>[]; error?: string } };
  try {
    state = await getJson(fetchFn, `${base}/api/idd/state`);
  } catch (error) {
    return fail(`engine に届きません（${base}）: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (state.status !== 200 || state.body.error) return fail(`状態を読めません: ${String(state.body.error ?? `HTTP ${state.status}`)}`);
  const found = findCard(state.body.items ?? [], card);
  if (!found.ok) return fail(found.error);
  const item = found.item;
  let screen: ScreenApprovalModule;
  try {
    screen = await screenApproval();
  } catch (error) {
    return fail(`card の中身を組む関数を読めませんでした（${error instanceof Error ? error.message : String(error)}）。この command は bin/idd から（bun で）実行してください`);
  }
  if (off.size && found.kind !== "land-batch") return fail("--off はまとめた取り込みの card にだけ付けられます");
  const built = found.kind === "ship"
    ? { view: screen.buildShipApproval(item, screen.shipDraftFor(item)), action: "s4_verify_clean" }
    : found.kind === "land-batch"
      ? { view: screen.buildBatchApproval(item, { off }), action: "land_batch_approve" }
      : { view: screen.buildOutboundApproval(item, screen.outboundDraftFor(item)), action: "outbound_approve" };
  const view = built.view;
  if (!view.ready) {
    // the engine would refuse the decision too; saying it here keeps a PIN from being typed for nothing
    const hint = view.primary === "check" ? `（検査は \`idd propose ${card}\` で回せます）` : "";
    return fail(`${card} は今は承認できません: ${view.why ?? "理由が分かりません"}${hint}`);
  }
  if (!view.sign) return fail(`${card} は承認ではなく検査を待っています${view.why ? `: ${view.why}` : ""}`);
  const action = built.action;
  const payload = view.payload;

  // the PIN has to be there and not stopped before a challenge is made: nothing is asked of the engine otherwise
  let pins: { status: number; body: PinStatusAnswer };
  try {
    pins = await getJson<PinStatusAnswer>(fetchFn, `${base}/api/idd/passkey/pin`);
  } catch (error) {
    return fail(`engine に届きません（${base}）: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (pins.status !== 200 || pins.body.ok !== true) return fail(`PIN の記録を読めません: ${String(pins.body.error ?? `HTTP ${pins.status}`)}`);
  const iterations = Number(pins.body.kdf?.iterations ?? 0);
  if (!pins.body.configured || !pins.body.salt || !iterations) return fail("PIN が設定されていません。設定の Passkeys で設定してください");
  if (pins.body.lockedUntil && Date.parse(pins.body.lockedUntil) > Date.now()) {
    return fail(`PIN は失敗が続いたため ${pins.body.lockedUntil} まで止まっています。passkey で署名してください`);
  }
  const digits = Number.isInteger(pins.body.digits) && Number(pins.body.digits) > 0 ? Number(pins.body.digits) : PIN_DIGITS;

  // the engine makes the challenge over the approval's own content; the answer carries that content back
  const rpId = rpIdForBase(base);
  let challenge: { status: number; body: ChallengeAnswer };
  try {
    challenge = await postJson<ChallengeAnswer>(fetchFn, `${base}/api/idd/passkey/challenge`, { action, payload, ...(rpId ? { rpId } : {}) });
  } catch (error) {
    return fail(`engine に届きません（${base}）: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (challenge.status !== 200 || !challenge.body.ok) {
    return fail(`challenge を作れません: ${String(challenge.body.error ?? `HTTP ${challenge.status}`)}`);
  }
  if (!challenge.body.required) {
    // nothing leaves this machine for this approval, so there is nothing to sign: the screen sends it as it stands too
    out(`${view.confirmRows.map((row) => `${row.label}: ${row.value}`).join("\n")}\n外へ書かない承認なので、署名はいりません。そのまま通します\n`);
    const sent = await postJson<DecideAnswer>(fetchFn, `${base}/api/idd/decide`, { action, payload });
    return report(sent.status, sent.body, card, out, err);
  }
  if (!challenge.body.registered) {
    return fail("passkey がまだ登録されていません。PIN は passkey の下に置くので、まず画面で passkey を登録してください");
  }
  const nonce = String(challenge.body.nonce ?? "");
  const content = challenge.body.content;
  if (!nonce || !content || typeof content !== "object") return fail("engine が署名する中身を返しませんでした。承認をやり直してください");
  // the content shown and the challenge are one thing, or nothing is shown and no PIN is asked for
  const rebuilt = challengeFor(content, nonce);
  if (rebuilt !== String(challenge.body.challenge ?? "")) {
    return fail("engine が掛けた中身と challenge が合いません。PIN は聞かずに中止しました。もう一度 idd approve からやり直してください");
  }

  // what is signed goes to the terminal the PIN is read from, not to the command's own output: a person who runs this
  // with its output sent elsewhere still reads the content before typing the PIN, and a terminal that cannot take it
  // stops the approval before the PIN is asked for
  const block = [
    `card ${terminalText(card)} の承認`,
    ...contentLines(content),
    ...checkLines(item),
    `署名の期限: ${terminalText(challenge.body.expiresAt ?? "")}`,
  ].map((line) => `  ${line}\n`).join("");
  const shown = terminal.show(block);
  if (!shown.ok) return fail(`署名する中身を端末に出せませんでした（${shown.reason}）。PIN は聞かずに中止しました`);

  const answer = await terminal.readSecret(`PIN（${digits} 桁）: `);
  if (!answer.ok) return fail(answer.reason);
  // the shape is checked here; a wrong PIN is the engine's to count, so a mistyped one costs a failure there
  if (!new RegExp(`^\\d{${digits}}$`).test(answer.value)) {
    return fail(`PIN は ${digits} 桁の数字です。もう一度 idd approve からやり直してください`);
  }
  const signature = pinProofFor(answer.value, String(pins.body.salt), iterations, rebuilt);
  answer.value = "";

  let sent: { status: number; body: DecideAnswer };
  try {
    sent = await postJson<DecideAnswer>(fetchFn, `${base}/api/idd/decide`, { action, payload: { ...payload, nonce, pinProof: { signature } } });
  } catch (error) {
    return fail(`engine に届きません（${base}）。承認が通ったか分かりません: ${error instanceof Error ? error.message : String(error)}`);
  }
  return report(sent.status, sent.body, card, out, err);
}

/** the engine's answer, said plainly: only its success means the card went through */
function report(status: number, body: DecideAnswer, card: string, out: (s: string) => void, err: (s: string) => void): number {
  if (status !== 200 || body.ok !== true) {
    err(`${card} を通せませんでした: ${String(body.error ?? `HTTP ${status}`)}\n`);
    return 1;
  }
  out(`${card} を通しました${body.prUrl ? `: ${String(body.prUrl)}` : ""}\n`);
  out(`${JSON.stringify(body, null, 2)}\n`);
  return 0;
}
