/**
 * `idd instruction`: the user's instructions as the CLI sees them. A conversation's agent proposes (`propose`); the
 * user reads the instructions, the open proposals and the ledger of what was delivered, and proposes one conversation's
 * own additions and exclusions (`session`). There is no verb that approves or rejects a proposal: that is the user's
 * signed answer on the Inbox card, and a CLI an agent can call must not have it.
 */
import { agentBaseUrl } from "../../idd-core/src/agent/token.ts";
import { readAgentToken } from "../../idd-lane/src/agent-token.ts";
import { PLACES, SCENES } from "../../idd-core/src/instruction/scope.ts";
import { postJsonWithRetry, parseArgs } from "./lane-commands.ts";

type Parsed = ReturnType<typeof parseArgs>;

const str = (v: string | boolean | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);

export const INSTRUCTION_USAGE = [
  "usage:",
  "  idd instruction list [--json]                    # 効いている方針（読み取り。token は要らない）",
  "  idd instruction proposals [--json]               # 利用者の答えを待っている案",
  `  idd instruction propose add --text T --reason R --repo owner/name[,..]|all --scene ${SCENES.join(",")}|all --place ${PLACES.join(",")}|all [--session ID]`,
  "  idd instruction propose change --id INS-n [--text T] [--reason R] [--repo ..] [--scene ..] [--place ..] [--session ID]   # 書いた項目だけを変える。--repo・--scene・--place のうち書かなかった軸は今の値のまま（all にはならない）",
  "  idd instruction propose retire --id INS-n [--session ID]   # 案を出すだけ。承認は利用者が Inbox の案の card で行うまで何にも効かない。lane の session は出せない",
  "  idd instruction ledger [--lane-id IDD-n] [--session ID] [--instruction INS-n] [--stage S] [--limit N] [--json]   # 差し込んだ本文・範囲・宛先・時刻",
  "  idd instruction session SESSION [--add INS-n,..] [--exclude INS-n,..] [--clear INS-n,..]   # その会話だけの追加と除外の案（利用者が Inbox で署名すると、次にその会話の pi を起こしたときから効く）",
].join("\n");

function out(v: unknown): void {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

function refuse(message: string): number {
  process.stderr.write(`${message}\n`);
  return 2;
}

/** `--repo a/b,c/d` or `all` as the scope's axis value */
function axisOf(value: string | undefined): string[] | "all" | undefined {
  if (value === undefined) return undefined;
  return value.trim() === "all" ? "all" : value.split(",").map((s) => s.trim()).filter(Boolean);
}

async function call(method: "GET" | "POST", path: string, body?: unknown, token?: string, sessionToken?: string): Promise<{ data: Record<string, unknown>; ok: boolean; error?: string }> {
  const posted = await postJsonWithRetry(`${agentBaseUrl()}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(sessionToken ? { "x-idd-session-token": sessionToken } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (posted.error !== undefined) return { data: {}, ok: false, error: `口を呼べませんでした: ${String(posted.error)}` };
  const { response, data } = posted;
  const ok = Boolean(response?.ok) && data.ok !== false;
  return { data, ok, ...(ok ? {} : { error: typeof data.error === "string" && data.error ? data.error : `API が断りました (HTTP ${response?.status ?? 0})` }) };
}

async function fileProposal(parsed: Parsed): Promise<number> {
  const kind = parsed.positional[0];
  if (!kind || !["add", "change", "retire"].includes(kind)) return refuse(INSTRUCTION_USAGE);
  // a lane's session proposes nothing: the CLI says so before it calls, and the door refuses a caller that names a lane
  if (process.env.IDD_ID?.trim()) return refuse("lane の session は方針の案を出せません。案を出せるのは会話の agent だけです");
  const flags = parsed.flags;
  const session = str(flags.session) ?? process.env.IDD_SESSION_ID?.trim();
  if (!session) return refuse("会話の session が分かりません。--session（か IDD_SESSION_ID）が要ります");
  const token = readAgentToken();
  if (!token) return refuse("agent token を読めませんでした");
  // the conversation's own credential, which the engine put in its pi's environment: the door checks it against the session named
  const sessionToken = process.env.IDD_SESSION_TOKEN?.trim();
  if (!sessionToken) return refuse("会話の資格（IDD_SESSION_TOKEN）がありません。案を出せるのは、その会話の中で動く agent だけです");
  const repos = axisOf(str(flags.repo));
  const scenes = axisOf(str(flags.scene));
  const places = axisOf(str(flags.place));
  // an add declares all three axes (checked below); a change names only the axes it changes, and the others keep the
  // instruction's value, so an axis left out is left out of the payload and never becomes "all"
  const scope = repos !== undefined || scenes !== undefined || places !== undefined
    ? { ...(repos !== undefined ? { repos } : {}), ...(scenes !== undefined ? { scenes } : {}), ...(places !== undefined ? { places } : {}) }
    : undefined;
  if (kind === "add" && (repos === undefined || scenes === undefined || places === undefined)) {
    return refuse("追加には範囲の宣言が要ります: --repo と --scene と --place（全部なら all）");
  }
  const payload = { kind, ...(str(flags.id) ? { target: str(flags.id) } : {}), ...(str(flags.text) !== undefined ? { text: str(flags.text) } : {}), ...(str(flags.reason) !== undefined ? { reason: str(flags.reason) } : {}), ...(scope && kind !== "retire" ? { scope } : {}) };
  const r = await call("POST", "/api/idd/instruction", { action: "propose", session, payload }, token, sessionToken);
  if (!r.ok) { process.stderr.write(`${r.error}\n`); return 1; }
  out(r.data);
  return 0;
}

async function ledger(parsed: Parsed): Promise<number> {
  const q = new URLSearchParams({ op: "ledger" });
  // `--lane` is a switch of `idd out draft` in the shared argument reader, so the lane's id has a flag of its own
  for (const [flag, key] of [["lane-id", "lane"], ["session", "session"], ["instruction", "instruction"], ["stage", "stage"], ["limit", "limit"]] as const) {
    const v = str(parsed.flags[flag]);
    if (v) q.set(key, v);
  }
  const r = await call("GET", `/api/idd/instruction?${q.toString()}`);
  if (!r.ok) { process.stderr.write(`${r.error}\n`); return 1; }
  if (parsed.flags.json) out(r.data.entries);
  else {
    const lines = (r.data.lines as string[] | undefined) ?? [];
    process.stdout.write(lines.length ? `${lines.join("\n")}\n` : "台帳に該当する項はありません。\n");
  }
  return 0;
}

async function list(parsed: Parsed, op: "list" | "proposals"): Promise<number> {
  const r = await call("GET", `/api/idd/instruction?op=${op}`);
  if (!r.ok) { process.stderr.write(`${r.error}\n`); return 1; }
  if (parsed.flags.json) { out(r.data); return 0; }
  if (op === "list") {
    const rows = (r.data.instructions as { id: string; text: string; reason: string; scope_text: string }[] | undefined) ?? [];
    if (r.data.state && r.data.state !== "ok" && r.data.state !== "missing") process.stdout.write(`方針のファイルを読めません（${String(r.data.state)}）。方針なしで進んでいます。\n`);
    process.stdout.write(rows.length ? `${rows.map((i) => `${i.id} ${i.text}（理由: ${i.reason}）[${i.scope_text}]`).join("\n")}\n` : "方針はまだありません。\n");
  } else {
    const rows = (r.data.proposals as { id: string; kind: string; target?: string; text?: string; session: string }[] | undefined) ?? [];
    process.stdout.write(rows.length ? `${rows.map((p) => `${p.id} ${p.kind}${p.target ? ` ${p.target}` : ""}${p.text ? `: ${p.text}` : ""}（会話 ${p.session}）`).join("\n")}\n` : "答えを待っている案はありません。\n");
  }
  return 0;
}

const idsOf = (v: string | boolean | string[] | undefined): string[] => (str(v) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * One conversation's own additions and exclusions. Reading shows the lists. Changing them files a proposal per
 * instruction, because a request an agent can send must not be able to change what the agent is told: the user signs
 * each one on the Inbox card, and it takes effect when that conversation's pi is next started.
 */
async function session(parsed: Parsed): Promise<number> {
  const id = parsed.positional[0];
  if (!id) return refuse(INSTRUCTION_USAGE);
  if (process.env.IDD_ID?.trim()) return refuse("lane の session は会話の方針を変える案を出せません");
  const current = await call("GET", `/api/idd/instruction?op=session&id=${encodeURIComponent(id)}`);
  if (!current.ok) { process.stderr.write(`${current.error}\n`); return 1; }
  const wanted = [
    ...idsOf(parsed.flags.add).map((target) => ({ op: "add", target })),
    ...idsOf(parsed.flags.exclude).map((target) => ({ op: "exclude", target })),
    ...idsOf(parsed.flags.clear).map((target) => ({ op: "clear", target })),
  ];
  if (!wanted.length) {
    out({ session: id, add: current.data.add ?? [], exclude: current.data.exclude ?? [] });
    return 0;
  }
  const token = readAgentToken();
  if (!token) return refuse("agent token を読めませんでした");
  const filed: unknown[] = [];
  for (const w of wanted) {
    const r = await call("POST", "/api/idd/instruction", { action: "propose", payload: { kind: "session", op: w.op, target: w.target, for_session: id } }, token);
    if (!r.ok) { process.stderr.write(`${w.op} ${w.target}: ${r.error}\n`); return 1; }
    filed.push({ op: w.op, target: w.target, proposal: r.data.id });
  }
  out({ session: id, proposals: filed, effect: "案を出しました。Inbox の案の card で署名して承認すると、その会話の pi を次に起こしたときから効きます" });
  return 0;
}

export async function runInstructionCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  const parsed = parseArgs(argv.slice(1));
  if (parsed.missing.length) return refuse(`値の付いていない flag があります: ${parsed.missing.map((f) => `--${f}`).join(" ")}`);
  switch (sub) {
    case "list": return await list(parsed, "list");
    case "proposals": return await list(parsed, "proposals");
    case "propose": return await fileProposal(parsed);
    case "ledger": return await ledger(parsed);
    case "session": return await session(parsed);
    default: return refuse(INSTRUCTION_USAGE);
  }
}
