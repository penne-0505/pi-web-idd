import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createRegistrationOptions, finishRegistration, landPath, notePinFailure, readPinState, savePin, verifyPinProof } from "../../idd-core/src/index.ts";
import { inheritMarkOf } from "../../idd-core/src/overlay/land.ts";
import { softwareAuthenticator } from "../../idd-core/test/passkey-fixture.mjs";
import { GET as pinGET } from "../../idd-engine/src/routes/passkey-pin.ts";
import { POST as challengePOST } from "../../idd-engine/src/routes/passkey-challenge.ts";
import { sends, shipReservation } from "../../../lib/idd-ui/cards/ship-text.ts";
import { challengeFor, checkLines, contentLines, pinProofFor, runApproveCommand, rpIdForBase, terminalText, type ApproveDeps, type Terminal } from "../src/approve.ts";

const CLI = join(import.meta.dir, "../bin/idd.ts");
const APPROVE_SOURCE = join(import.meta.dir, "../src/approve.ts");
const ITERATIONS = 600_000;
const SALT = Buffer.from("0123456789abcdef", "utf8").toString("base64url");
const PIN = "918273";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), "idd-approve-"));
  temps.push(dir);
  process.env.IDD_STATE_DIR = dir;
  return dir;
}

/** a checked landing in the state: the card and the challenge route both read this record */
function seedLand(extra: Record<string, unknown> = {}): void {
  const path = landPath("IDD-1");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    iddId: "IDD-1", branch: "idd/IDD-1", head: "abc1234def", workBase: "work-main", repo: "test/project",
    mainTip: "def5678abc", checks: [], blocking: 0, token: "t", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    configKey: "k", status: "prepared",
    close: { repo: "test/project", issue: 184, comment: "PIN で端末から 1 枚通せるようにした" },
    ...extra,
  }));
}

/** the card the screen would draw for that landing */
function landItem(): Record<string, unknown> {
  return {
    kind: "ship", iddId: "IDD-1", title: "端末の承認", head: "abc1234def",
    branch: { from: "idd/IDD-1", to: "work-main", repo: "test/project" },
    pr: { title: "題", body: [{ text: "本文" }], commits: ["feat: x"] },
    checks: [{ label: "commit がある", ok: true }, { label: "満たすべき条件がすべて確認済み", ok: true }],
    land: {
      iddId: "IDD-1", branch: "idd/IDD-1", head: "abc1234def", workBase: "work-main", repo: "test/project",
      mainTip: "9876543cba", mergeCommit: "7777777", blocking: 0, token: "t", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      checks: [
        // a result taken over from an earlier tip: the mark names that tip, and the detail stays whole after it
        { name: "typecheck", status: "pass", severity: "blocking", detail: `${inheritMarkOf("0123456abcdef", "fedcba987654")}\ntsc --noEmit: 0 error` },
        // a check that failed without holding the signature: shown as it is, not folded away
        { name: "moonbit", status: "fail", severity: "non-blocking", detail: "moon fmt の差分があります: packages/foo" },
      ],
      close: { repo: "test/project", issue: 184, comment: "PIN で端末から 1 枚通せるようにした" },
    },
  };
}

/** a posting in the state: its record is what the challenge route rebuilds the content from */
function seedOutbound(): void {
  const dir = join(process.env.IDD_STATE_DIR ?? "", "outbound");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "OUT-1.json"), JSON.stringify({
    id: "OUT-1", kind: "gh-issue", target: { repo: "test/project" }, title: "題", draft: "本文",
    status: "ready", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }));
}

function outboundItem(): Record<string, unknown> {
  return { kind: "outbound", iddId: "OUT-1", outKind: "gh-issue", targetLabel: "GitHub Issue · test/project", title: "題", draft: "本文", proposed: "本文" };
}

/** a registered passkey (a challenge is issued only when one is), and a PIN whose public half the screen would send */
async function seedKeys(): Promise<void> {
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions();
  const done = await finishRegistration({
    nonce,
    response: auth.registration({ challenge: String(options.challenge), origin: "http://localhost:30142", rpId: "localhost" }),
    name: "test",
    localScreen: true,
  });
  expect(done.ok).toBe(true);
  const key = await screenKey(PIN);
  savePin({ publicKey: key.publicKey, salt: SALT, iterations: ITERATIONS });
}

const ED25519_PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * The screen's own derivation, step for step (PBKDF2-SHA-256, then the Ed25519 seed as PKCS#8), so the test says the
 * terminal's key is the screen's key rather than one this test invented.
 */
async function screenKey(pin: string, challenge?: string): Promise<{ publicKey: string; signature?: string }> {
  const subtle = crypto.subtle;
  const base = await subtle.importKey("raw", bufferOf(new TextEncoder().encode(pin)), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bufferOf(new Uint8Array(Buffer.from(SALT, "base64url"))), iterations: ITERATIONS }, base, 256);
  const seed = new Uint8Array(bits);
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
  const key = await subtle.importKey("pkcs8", bufferOf(pkcs8), { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await subtle.exportKey("jwk", key)) as { x?: string };
  const signature = challenge === undefined
    ? undefined
    : Buffer.from(new Uint8Array(await subtle.sign({ name: "Ed25519" }, key, bufferOf(new TextEncoder().encode(challenge))))).toString("base64url");
  seed.fill(0);
  return { publicKey: String(jwk.x ?? ""), ...(signature ? { signature } : {}) };
}

interface Call { method: string; path: string; body?: Record<string, unknown> }

/**
 * The engine's doors this command uses, as a fetch. The state and the decision are the test's; the challenge and the
 * PIN status are the engine's own handlers on this test's state directory. The decision checks the proof with the
 * engine's verification over the content the challenge handed out, which is where a wrong PIN is counted.
 */
/**
 * The engine's answer on a card, as its state sends it: the terminal builds the approval from the same operations the
 * screen does (the reservation and the conditions come from the one function the engine's answer is made with).
 */
function answered(item: Record<string, unknown>): Record<string, unknown> {
  if (item.kind === "ship") {
    const reservation = shipReservation(item as Parameters<typeof shipReservation>[0], [], Date.now());
    const land = item.land as { token?: string } | undefined;
    return {
      ...item,
      decision: {
        waiting: "ship",
        material: [],
        operations: [{
          id: "approve", door: "decide", action: "s4_verify_clean", payload: { iddId: item.iddId, token: land?.token },
          input: { kind: "draft" }, sends: sends(reservation.kind), variant: reservation.kind, conditions: reservation.conditions,
          ...(reservation.hold ? { hold: { reason: reservation.hold.why, ...(reservation.hold.blocking?.length ? { blocking: reservation.hold.blocking } : {}) } } : {}),
          signature: "passkey_or_pin", irreversible: true,
        }],
      },
    };
  }
  return {
    ...item,
    decision: {
      waiting: String(item.kind),
      material: [],
      operations: [{ id: "approve", door: "decide", action: "outbound_approve", payload: { iddId: item.iddId }, input: { kind: "draft" }, conditions: [{ id: "post_title" }], signature: "passkey_or_pin", irreversible: true }],
    },
  };
}

function fakeEngine(opts: { items: () => Record<string, unknown>[]; host?: string; decide?: (body: Record<string, unknown>) => Promise<Record<string, unknown>> }) {
  const calls: Call[] = [];
  const issued = new Map<string, unknown>();
  const host = opts.host ?? "http://127.0.0.1:30144";
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method: init?.method ?? "GET", path, ...(body ? { body } : {}) });
    if (path === "/api/idd/state") return reply({ items: opts.items().map(answered) });
    if (path === "/api/idd/passkey/pin") return pinGET();
    if (path === "/api/idd/passkey/challenge") {
      const res = await challengePOST(new Request(`${host}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      const answer = (await res.clone().json()) as { nonce?: string; content?: unknown };
      if (answer.nonce && answer.content !== undefined) issued.set(answer.nonce, answer.content);
      return res;
    }
    if (path === "/api/idd/decide") {
      if (opts.decide) return reply(await opts.decide(body ?? {}));
      const payload = (body?.payload ?? {}) as Record<string, unknown>;
      const checked = await verifyPinProof({ nonce: String(payload.nonce ?? ""), proof: payload.pinProof, content: issued.get(String(payload.nonce ?? "")) });
      return checked.ok ? reply({ ok: true }) : reply({ ok: false, error: checked.reason }, 400);
    }
    return reply({ ok: false, error: `unexpected ${path}` }, 404);
  };
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

interface FakeTerminal { terminal: Terminal; prompts: string[]; shown: string[]; writes: string[]; closed: () => boolean }

/**
 * A stand-in for the controlling terminal. `writes` is every block given to `show`; `shown` is what the terminal had
 * received when the PIN was asked for, so a test can say the person read the content there before typing it.
 */
function fakeTerminal(answers: string[], showFails?: string): FakeTerminal {
  const prompts: string[] = [];
  const shown: string[] = [];
  const writes: string[] = [];
  let buffer = "";
  let closed = false;
  return {
    terminal: {
      show(text: string) {
        if (showFails) return { ok: false as const, reason: showFails };
        writes.push(text);
        buffer += text;
        return { ok: true as const };
      },
      async readSecret(prompt: string) {
        prompts.push(prompt);
        shown.push(buffer);
        const answer = answers.shift();
        return answer === undefined ? { ok: false, reason: "PIN の入力がありませんでした" } : { ok: true, value: answer };
      },
      close() { closed = true; },
    },
    prompts,
    shown,
    writes,
    closed: () => closed,
  };
}

/** run the command with the fakes; the terminal sees exactly the text that was written before it asked */
async function approve(argv: string[], deps: { fetchFn: typeof fetch; baseUrl?: string; answer?: string[]; noTty?: string; showFails?: string }) {
  const out: string[] = [];
  const err: string[] = [];
  const term = fakeTerminal(deps.answer ?? [PIN], deps.showFails);
  const full: ApproveDeps = {
    fetch: deps.fetchFn,
    baseUrl: () => deps.baseUrl ?? "http://127.0.0.1:30144",
    openTerminal: () => (deps.noTty ? { ok: false as const, error: deps.noTty } : { ok: true as const, terminal: term.terminal }),
    stdout: (s: string) => { out.push(s); },
    stderr: (s: string) => { err.push(s); },
  };
  const code = await runApproveCommand(argv, full);
  return { code, out: out.join(""), err: err.join(""), term };
}

describe("idd approve: the terminal's PIN approval", () => {
  test("shows the engine's content in full before the PIN, and sends only the proof", async () => {
    const state = tempState();
    seedLand();
    await seedKeys();
    const engine = fakeEngine({ items: () => [landItem()] });
    const run = await approve(["IDD-1"], { fetchFn: engine.fetchFn });
    expect(run.code).toBe(0);
    expect(run.err).toBe("");
    // the content the engine made the challenge over, in full, before the terminal was asked for a PIN
    const before = run.term.shown[0] ?? "";
    expect(before).toContain("種類: 取り込み");
    expect(before).toContain("work 側の本流の branch: work-main");
    expect(before).toContain("lane の head: abc1234def");
    expect(before).toContain("PIN で端末から 1 枚通せるようにした");
    // the card's checks are shown too: they are not signed, but they are read before the proof
    expect(before).toContain("○ commit がある");
    // and the checks the landing ran, under the tip and merge they were run at: a handed-over result says which
    // earlier mainline tip it came from, so the person can tell it apart from one just run
    expect(before).toContain("実行した検査（本流 9876543 / merge 7777777）:");
    expect(before).toContain("typecheck: pass（blocking）");
    expect(before).toContain(inheritMarkOf("0123456abcdef", "fedcba987654"));
    expect(before).toContain("tsc --noEmit: 0 error");
    expect(before).toContain("moonbit: fail（non-blocking）");
    expect(before).toContain("moon fmt の差分があります: packages/foo");
    expect(run.term.prompts).toHaveLength(1);
    expect(run.term.closed()).toBe(true);
    // the content is the terminal's, not the command's own output: redirecting stdout cannot hide what is signed
    expect(run.out).not.toContain("種類: 取り込み");
    expect(run.out).not.toContain("work 側の本流の branch");
    expect(run.err).not.toContain("work 側の本流の branch");
    // the decision carries the card's own payload plus the nonce and the signature, and nothing else
    const decide = engine.calls.find((c) => c.path === "/api/idd/decide");
    const payload = (decide?.body?.payload ?? {}) as Record<string, unknown>;
    expect(Object.keys(payload.pinProof as object)).toEqual(["signature"]);
    expect(typeof payload.nonce).toBe("string");
    expect(Object.keys(payload).sort()).toEqual(["iddId", "nonce", "pinProof", "token"]);
    // the PIN is nowhere: not in what the command printed, not in what it sent, not in what the engine kept
    expect(run.out).not.toContain(PIN);
    expect(run.err).not.toContain(PIN);
    expect(JSON.stringify(engine.calls.map((c) => ({ path: c.path, body: c.body }))).replace(String(payload.pinProof && (payload.pinProof as { signature: string }).signature), "")).not.toContain(PIN);
    const record = readPinState();
    expect(record.ok).toBe(true);
    expect(Object.keys(record.ok && record.pin ? record.pin : {}).sort()).toEqual(["createdAt", "failures", "kdf", "publicKey", "salt", "updatedAt"]);
    expect(state).toBeString();
  });

  test("the terminal's key is the screen's key", async () => {
    tempState();
    const screen = await screenKey(PIN, "the challenge text");
    expect(pinProofFor(PIN, SALT, ITERATIONS, "the challenge text")).toBe(String(screen.signature));
    // another PIN does not make the screen's key
    expect(pinProofFor("111111", SALT, ITERATIONS, "the challenge text")).not.toBe(String(screen.signature));
  });

  test("a wrong PIN is a failure in the PIN's record, and the card does not go through", async () => {
    tempState();
    seedLand();
    await seedKeys();
    const engine = fakeEngine({ items: () => [landItem()] });
    const run = await approve(["IDD-1"], { fetchFn: engine.fetchFn, answer: ["000000"] });
    expect(run.code).toBe(1);
    expect(run.err).toContain("PIN が違います");
    const record = readPinState();
    expect(record.ok && record.pin ? record.pin.failures.count : -1).toBe(1);
  });

  test("a stopped PIN is refused with its reason before any challenge is asked", async () => {
    tempState();
    seedLand();
    await seedKeys();
    for (let i = 0; i < 5; i += 1) notePinFailure();
    const engine = fakeEngine({ items: () => [landItem()] });
    const run = await approve(["IDD-1"], { fetchFn: engine.fetchFn });
    expect(run.code).toBe(1);
    expect(run.err).toContain("止まっています");
    expect(run.term.prompts).toEqual([]);
    expect(engine.calls.map((c) => c.path)).not.toContain("/api/idd/passkey/challenge");
  });

  test("no controlling terminal: nothing is asked of the engine and no PIN is read", async () => {
    tempState();
    const engine = fakeEngine({ items: () => [landItem()] });
    const run = await approve(["IDD-1"], { fetchFn: engine.fetchFn, noTty: "制御端末がありません（/dev/tty: ENXIO）" });
    expect(run.code).toBe(1);
    expect(run.err).toContain("制御端末がありません");
    expect(engine.calls).toEqual([]);
  });

  test("the real command refuses without a controlling terminal, before it reaches for the engine", () => {
    const state = tempState();
    // a port nothing listens on: reaching it would say so, so the terminal's refusal proves nothing was sent
    const res = spawnSync("setsid", ["-w", "bun", "run", CLI, "approve", "IDD-1"], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, IDD_STATE_DIR: state, IDD_AGENT_BASE_URL: "http://127.0.0.1:65532" },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("制御端末がありません");
    expect(res.stderr).not.toContain("engine に届きません");
  });

  test("the typed PIN is not echoed on the terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idd-approve-tty-"));
    temps.push(dir);
    const harness = join(dir, "harness.ts");
    writeFileSync(harness, [
      `import { execFileSync } from "node:child_process";`,
      `import { openControllingTerminal } from ${JSON.stringify(APPROVE_SOURCE)};`,
      `const opened = openControllingTerminal();`,
      `if (!opened.ok) { console.log("NO_TTY"); process.exit(3); }`,
      // the content goes to the terminal itself, so it is on the same screen the PIN is typed on
      `const shown = opened.terminal.show("SIGNED_CONTENT\\n");`,
      `if (!shown.ok) { console.log("SHOW_FAILED"); process.exit(4); }`,
      // while the prompt waits, the terminal's own settings are read from the terminal
      `setTimeout(() => {`,
      `  try {`,
      `    const words = execFileSync("bash", ["-c", "stty -a < /dev/tty"], { encoding: "utf8" }).split(/\\s+/).filter((w) => /^-?(echo|icanon)$/.test(w));`,
      `    console.log("stty:" + words.join(" "));`,
      `  } catch { console.log("stty:ERR"); }`,
      `}, 400);`,
      `const answer = await opened.terminal.readSecret("PIN: ");`,
      `opened.terminal.close();`,
      `console.log("RESULT=" + (answer.ok ? answer.value : "ERR:" + answer.reason));`,
    ].join("\n"));
    const res = await runInPty(["bun", "run", harness], `${PIN}\n`);
    expect(res.code).toBe(0);
    const before = res.out.split("RESULT=")[0] ?? "";
    // the content reached the real terminal before the PIN was asked for
    expect(before).toContain("SIGNED_CONTENT");
    // while the prompt waited the terminal had echo off, and the typed digits never came back through the pty
    expect(before).toContain("-echo");
    expect(before).not.toContain(PIN);
    expect(res.out).toContain(`RESULT=${PIN}`);
  });

  test("a challenge whose content does not rebuild it stops before the PIN", async () => {
    tempState();
    seedLand();
    await seedKeys();
    const engine = fakeEngine({ items: () => [landItem()], decide: async () => ({ ok: true }) });
    const tampering: typeof fetch = async (input, init) => {
      const res = await engine.fetchFn(input as RequestInfo, init);
      if (!String(input).endsWith("/api/idd/passkey/challenge")) return res;
      const answer = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...answer, content: { ...(answer.content as object), head: "other" } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const run = await approve(["IDD-1"], { fetchFn: tampering });
    expect(run.code).toBe(1);
    expect(run.err).toContain("challenge が合いません");
    expect(run.term.prompts).toEqual([]);
    expect(engine.calls.map((c) => c.path)).not.toContain("/api/idd/decide");
  });

  test("one card a run: a second name is refused, and the next run asks for the PIN again", async () => {
    tempState();
    seedLand();
    await seedKeys();
    const engine = fakeEngine({ items: () => [landItem()] });
    const two = await approve(["IDD-1", "OUT-1"], { fetchFn: engine.fetchFn });
    expect(two.code).toBe(2);
    expect(engine.calls).toEqual([]);
    const first = await approve(["IDD-1"], { fetchFn: engine.fetchFn });
    const second = await approve(["IDD-1"], { fetchFn: engine.fetchFn });
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.term.prompts).toHaveLength(1);
    expect(second.term.prompts).toHaveLength(1);
    const nonces = engine.calls
      .filter((c) => c.path === "/api/idd/decide")
      .map((c) => String((c.body?.payload as Record<string, unknown>)?.nonce ?? ""));
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
    // a name that is not an open card is refused before anything is sent
    const missing = await approve(["IDD-404"], { fetchFn: engine.fetchFn });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("card がありません");
  });

  test("loopback needs no RP ID, a configured tailnet host names its own, and an unknown host is refused", async () => {
    tempState();
    seedLand();
    await seedKeys();
    // the local address: the engine's own local RP ID answers it
    const loopback = fakeEngine({ items: () => [landItem()], host: "http://127.0.0.1:30144" });
    expect((await approve(["IDD-1"], { fetchFn: loopback.fetchFn })).code).toBe(0);
    expect(loopback.calls.find((c) => c.path === "/api/idd/passkey/challenge")?.body?.rpId).toBeUndefined();
    // the local names are the same page, so none of them is named
    expect(rpIdForBase("http://127.0.0.1:30144")).toBeUndefined();
    expect(rpIdForBase("http://localhost:30142")).toBeUndefined();
    expect(rpIdForBase("http://[::1]:30144")).toBeUndefined();

    // a tailnet address the settings name: the terminal names its host, and the engine accepts the request's host
    process.env.IDD_TAILNET_ORIGINS = "https://myhost.example.ts.net";
    try {
      const tailnet = fakeEngine({ items: () => [landItem()], host: "https://myhost.example.ts.net" });
      expect((await approve(["IDD-1"], { fetchFn: tailnet.fetchFn, baseUrl: "https://myhost.example.ts.net" })).code).toBe(0);
      expect(tailnet.calls.find((c) => c.path === "/api/idd/passkey/challenge")?.body?.rpId).toBe("myhost.example.ts.net");
      expect(rpIdForBase("https://myhost.example.ts.net")).toBe("myhost.example.ts.net");

      // an address the settings do not name: the engine refuses the RP ID before a challenge exists
      const unknown = fakeEngine({ items: () => [landItem()], host: "https://evil.example.com" });
      const refused = await approve(["IDD-1"], { fetchFn: unknown.fetchFn, baseUrl: "https://evil.example.com" });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("RP ID");
      expect(refused.term.prompts).toEqual([]);
      expect(unknown.calls.map((c) => c.path)).not.toContain("/api/idd/decide");
    } finally {
      delete process.env.IDD_TAILNET_ORIGINS;
    }
  });

  test("an approval that writes nothing outside goes through without a PIN", async () => {
    tempState();
    seedLand();
    await seedKeys();
    const engine = fakeEngine({ items: () => [landItem()], decide: async () => ({ ok: true }) });
    // the engine says this approval writes nothing: the answer carries no challenge
    const noProof: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/api/idd/passkey/challenge")) {
        return new Response(JSON.stringify({ ok: true, required: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return engine.fetchFn(input as RequestInfo, init);
    };
    const run = await approve(["IDD-1"], { fetchFn: noProof });
    expect(run.code).toBe(0);
    expect(run.term.prompts).toEqual([]);
    const decide = engine.calls.find((c) => c.path === "/api/idd/decide");
    expect((decide?.body?.payload as Record<string, unknown>).nonce).toBeUndefined();
  });

  test("a posting card shows its whole text and sends its own action", async () => {
    tempState();
    seedOutbound();
    await seedKeys();
    const engine = fakeEngine({ items: () => [outboundItem()] });
    const run = await approve(["OUT-1"], { fetchFn: engine.fetchFn });
    expect(run.code).toBe(0);
    const before = run.term.shown[0] ?? "";
    expect(before).toContain("本文:");
    expect(before).toContain("repo: test/project");
    const decide = engine.calls.find((c) => c.path === "/api/idd/decide");
    expect(decide?.body?.action).toBe("outbound_approve");
  });

  test("a card that is not ready is refused with the card's own reason and no PIN", async () => {
    tempState();
    seedLand({ blocking: 2 });
    await seedKeys();
    const blocked = { ...landItem(), land: { ...(landItem().land as object), blocking: 2 } };
    const engine = fakeEngine({ items: () => [blocked] });
    const run = await approve(["IDD-1"], { fetchFn: engine.fetchFn });
    expect(run.code).toBe(1);
    expect(run.err).toContain("止める検査が 2 件");
    expect(run.term.prompts).toEqual([]);
    expect(engine.calls.map((c) => c.path)).not.toContain("/api/idd/passkey/challenge");
  });

  test("terminalText shows the characters a terminal would obey", () => {
    // escapes stay readable and unambiguous: the escape itself is doubled, so content cannot write one this made
    expect(terminalText("a\\b")).toBe("a\\\\b");
    expect(terminalText("\\x1b[2K")).toBe("\\\\x1b[2K");
    expect(terminalText("line\r\ttab\nnext")).toBe("line\\r\\ttab\\nnext");
    expect(terminalText("\u001b[2K\u0007")).toBe("\\x1b[2K\\x07");
    expect(terminalText("\u007f\u0085")).toBe("\\x7f\\x85");
    // the bidi controls that reorder what a person reads are shown too
    expect(terminalText("a\u202eb\u2066c\u2069")).toBe("a\\u202eb\\u2066c\\u2069");
    expect(terminalText(null)).toBe("");
  });

  test("the content lines carry control characters only in their visible form, and keep the text", () => {
    const content = {
      kind: "ship", iddId: "IDD-1", repo: "r", branch: "b", base: "main", publicTree: "t",
      commitMessage: "feat: a\u001b[2K\r\nbody",
      pr: { title: "題\u202e", body: "本文\u001b[31m" },
    };
    const shown = contentLines(content).join("\n");
    // the raw controls cannot reach the terminal: every one of them is spelled out (the join's own line breaks aside)
    expect(shown).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(shown).toContain("feat: a\\x1b[2K\\r");
    expect(shown).toContain("本文\\x1b[31m");
    expect(shown).toContain("題\\u202e");
    // and the content itself is unchanged: what is signed is still what the engine made
    expect(content.commitMessage).toBe("feat: a\u001b[2K\r\nbody");
  });

  test("a terminal that cannot take the content is refused before the PIN", async () => {
    tempState();
    seedLand();
    await seedKeys();
    const engine = fakeEngine({ items: () => [landItem()] });
    const run = await approve(["IDD-1"], { fetchFn: engine.fetchFn, showFails: "書けませんものでした（EIO）" });
    expect(run.code).toBe(1);
    expect(run.err).toContain("端末に出せませんでした");
    expect(run.term.prompts).toEqual([]);
    expect(engine.calls.map((c) => c.path)).not.toContain("/api/idd/decide");
  });

  test("a card whose text carries control characters is signed with the raw text and shown without them", async () => {
    tempState();
    seedLand({ close: { repo: "test/project", issue: 184, comment: "一行目\u001b[2K\r二行目\u202e" } });
    await seedKeys();
    const item = {
      ...landItem(),
      checks: [{ label: "commit がある\u001b[2K", ok: true }, { label: "満たすべき条件がすべて確認済み", ok: true }],
      // a check's own detail is a place content arrives from too: it is shown the same visible way
      land: { ...(landItem().land as object), checks: [{ name: "lint", status: "fail", severity: "non-blocking", detail: "警告\u001b[31m: 1 件" }] },
    };
    const engine = fakeEngine({ items: () => [item] });
    const run = await approve(["IDD-1"], { fetchFn: engine.fetchFn });
    // the engine verified the proof over the content it made, so the signature is over the raw text
    expect(run.code).toBe(0);
    const shown = run.term.shown[0] ?? "";
    expect(shown).toContain("一行目\\x1b[2K\\r二行目\\u202e");
    expect(shown).toContain("○ commit がある\\x1b[2K");
    expect(shown).toContain("警告\\x1b[31m: 1 件");
    // no raw control character (the block's own line breaks excepted) reaches the terminal
    expect(shown).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(run.out).not.toContain("一行目");
    expect(engine.calls.map((c) => c.path)).toContain("/api/idd/decide");
  });

  test("the submit's own checks are shown with their whole detail", () => {
    // a submit card (no landing) carries the checks the export ran; the terminal shows them the same way
    const shown = checkLines({
      kind: "ship", iddId: "IDD-2",
      proposal: {
        mode: "new-pr", blocking: 0, token: "t", head: "abc1234def",
        checks: [
          { name: "typecheck", status: "pass", severity: "blocking", detail: "tsc --noEmit: 0 error" },
          { name: "lint", status: "fail", severity: "non-blocking", detail: "1 warning\nsecond line" },
        ],
      },
    }).join("\n");
    expect(shown).toContain("提出の検査:");
    expect(shown).toContain("  typecheck: pass（blocking）");
    expect(shown).toContain("    tsc --noEmit: 0 error");
    expect(shown).toContain("  lint: fail（non-blocking）");
    expect(shown).toContain("    1 warning");
    expect(shown).toContain("    second line");
  });

  test("contentLines never leaves a field out, and the challenge is the engine's own", () => {
    const lines = contentLines({ kind: "land", iddId: "IDD-1", repo: "r", workBase: "w", head: "h", close: null, extra: "見える" });
    expect(lines.join("\n")).toContain('extra: "見える"');
    // the same content hashes the same whatever the order its fields arrive in
    expect(challengeFor({ kind: "land", iddId: "IDD-1" }, "n")).toBe(challengeFor({ iddId: "IDD-1", kind: "land" }, "n"));
    expect(challengeFor({ kind: "land", iddId: "IDD-1" }, "n")).not.toBe(challengeFor({ kind: "land", iddId: "IDD-1" }, "m"));
  });
});

/**
 * Run a command on a pseudo terminal: the pty is what makes `/dev/tty` open, and what would show the typed digits if
 * echo were left on. The answer is written once the harness has read the terminal's settings, which happens only
 * while the prompt waits with echo off.
 */
function runInPty(argv: string[], answer: string): Promise<{ code: number | null; out: string }> {
  const quoted = argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  return new Promise((resolve) => {
    const child = spawn("script", ["-qec", quoted, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let written = false;
    const write = () => {
      if (written) return;
      written = true;
      try { child.stdin.write(answer); child.stdin.end(); } catch { /* the child may already be gone */ }
    };
    child.stdout.on("data", (d) => {
      out += String(d);
      // the harness reads the terminal's settings during the wait: from here on, the prompt is what awaits input
      if (!written && out.includes("stty:")) setTimeout(write, 100);
    });
    child.stderr.on("data", (d) => { out += String(d); });
    const giveUp = setTimeout(write, 5_000);
    const stop = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => {
      clearTimeout(giveUp);
      clearTimeout(stop);
      resolve({ code, out });
    });
  });
}
