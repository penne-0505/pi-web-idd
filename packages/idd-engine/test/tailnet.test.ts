import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { engineStartupLines, startEngine, createFetchHandler } from "../src/server.ts";
import { isTailnetAddress, tailnetBindingAddresses, tailnetSecurityPolicy, tailnetSettingsFromEnvironment } from "../src/tailnet.ts";
import { isLoopbackRequest, rememberRequestConnection } from "../src/request-connection.ts";
import { GET as pendingGET, POST as pendingPOST } from "../src/routes/passkey-pending.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";
import { createRegistrationOptions, finishRegistration, listPendingRegistrations, passkeyCount } from "../../idd-core/src/passkey.ts";
import { softwareAuthenticator } from "../../idd-core/test/passkey-fixture.mjs";
import { SERVE_FORGED_LOCALHOST_HOST, SERVE_RECORD_HEADER_NAMES, SERVE_TAILNET_HOST, type ServeRequestFixture } from "./fixtures/serve-request.ts";

const ENV_KEYS = ["IDD_STATE_DIR", "IDD_TAILNET_ADDRESSES", "IDD_TAILNET_ORIGINS", "IDD_ENGINE_PORT"] as const;
let saved: Record<string, string | undefined> = {};
function saveEnv(): void {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
}
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function stateFixture(): string {
  saveEnv();
  const state = tmpDir("idd-tailnet-state-");
  process.env.IDD_STATE_DIR = state;
  return state;
}

/** the tailnet addresses this machine actually holds (an empty list on a machine with no tailscale up) */
function localTailnetAddresses(): string[] {
  const out: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && isTailnetAddress(address.address)) out.push(address.address);
    }
  }
  return out;
}

/** a tailnet address in range that this machine does not hold, so its bind must fail */
function foreignTailnetAddress(): string {
  const local = new Set(localTailnetAddresses());
  for (let i = 1; i < 250; i += 1) {
    const candidate = `100.64.0.${i}`;
    if (!local.has(candidate)) return candidate;
  }
  throw new Error("no free tailnet address in 100.64.0.0/24");
}

const LOCAL_PAGE = "http://localhost:30142";
const TAILNET_ORIGIN = "https://pc.example.ts.net:8443";
const TAILNET_RP_ID = "pc.example.ts.net";
const FIXTURE_POLICY = { restrictHosts: true, tailnetHosts: ["100.64.0.5", TAILNET_RP_ID], tailnetOrigins: [TAILNET_ORIGIN] };

/** a request built by hand, with the listener address recorded the way `createFetchHandler` records it */
function directRequest(init: { host?: string; url?: string; method?: string; body?: unknown; listener?: string | null } = {}): Request {
  const headers = new Headers();
  if (init.host) headers.set("host", init.host);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const req = new Request(init.url ?? `${LOCAL_PAGE}/api/idd/passkey/register`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (init.listener !== null) rememberRequestConnection(req, init.listener ?? "127.0.0.1");
  return req;
}

/** a request built from a recorded serve shape; serve delivers it to the loopback listener */
function serveRequest(fixture: ServeRequestFixture, init: { method?: string; body?: unknown; origin?: string; url?: string; listener?: string } = {}): Request {
  const headers = new Headers({ host: fixture.host });
  for (const [name, value] of Object.entries(fixture.headers)) headers.set(name, value);
  if (init.origin) headers.set("origin", init.origin);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const req = new Request(init.url ?? `${LOCAL_PAGE}/api/idd/passkey/register`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  rememberRequestConnection(req, init.listener ?? "127.0.0.1");
  return req;
}

/** register a first key from the local screen, straight through the module (no listening route needed) */
async function registerLocalKey(): Promise<ReturnType<typeof softwareAuthenticator>> {
  const auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions("localhost");
  const done = await finishRegistration({ nonce, response: auth.registration({ challenge: String(options.challenge), origin: LOCAL_PAGE, rpId: "localhost" }), name: "local", localScreen: true });
  if (!done.ok) throw new Error(done.error);
  return auth;
}

/** run the whole registration flow for one serve shape and return its finish answer */
async function serveRegistration(handler: (req: Request) => Promise<Response>, shape: { fixture: ServeRequestFixture; rpId: string; declaredOrigin: string; requestOrigin?: string }): Promise<Response> {
  const auth = softwareAuthenticator();
  const started = await handler(serveRequest(shape.fixture, { body: { step: "options", rpId: shape.rpId }, origin: shape.requestOrigin })).then((res) => res.json()) as { nonce: string; options: { challenge: string } };
  return handler(serveRequest(shape.fixture, { body: { step: "finish", nonce: started.nonce, response: auth.registration({ challenge: String(started.options.challenge), origin: shape.declaredOrigin, rpId: shape.rpId }), name: "phone" }, origin: shape.requestOrigin }));
}

/**
 * The two serve shapes as a registration sees them. The tailnet shape sends its own Origin; the forged `Host:
 * localhost` shape sends none, so the RP ID match falls back to the forged Host while the authenticator still
 * declares the loopback origin.
 */
const SERVE_SHAPES = [
  { fixture: SERVE_TAILNET_HOST, rpId: TAILNET_RP_ID, declaredOrigin: TAILNET_ORIGIN, requestOrigin: TAILNET_ORIGIN },
  { fixture: SERVE_FORGED_LOCALHOST_HOST, rpId: "localhost", declaredOrigin: LOCAL_PAGE, requestOrigin: undefined },
] as const;

describe("the tailnet settings", () => {
  test("with no settings, only loopback is bound", async () => {
    stateFixture();
    const server = startEngine({ port: 0, tailnet: tailnetSettingsFromEnvironment({}) });
    try {
      expect(server.listening).toEqual(["127.0.0.1"]);
      expect(server.failures).toEqual([]);
      expect(server.retryScheduled).toBe(false);
      const res = await fetch(`http://127.0.0.1:${server.port}/api/idd/state`);
      expect(res.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("two configured addresses are added after loopback", () => {
    const settings = tailnetSettingsFromEnvironment({ IDD_TAILNET_ADDRESSES: "100.64.0.5, fd7a:115c:a1e0::42" });
    expect(tailnetBindingAddresses(settings)).toEqual(["127.0.0.1", "100.64.0.5", "fd7a:115c:a1e0::42"]);
    expect(settings.rejected).toEqual([]);
  });

  test("a value outside the tailnet range is refused with its reason", () => {
    const values = ["0.0.0.0", "::", "192.168.1.5", "8.8.8.8", "100.128.0.1", "fd00::1", "pc.example.ts.net"];
    const settings = tailnetSettingsFromEnvironment({ IDD_TAILNET_ADDRESSES: values.join(",") });
    expect(settings.addresses).toEqual([]);
    expect(settings.rejected.map((r) => r.value)).toEqual(values);
    for (const rejected of settings.rejected) expect(rejected.reason).toContain("tailnet");
    // the range's own boundaries are taken
    expect(isTailnetAddress("100.64.0.1")).toBe(true);
    expect(isTailnetAddress("100.127.255.254")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailnetAddress("100.64.0.0")).toBe(true);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
  });

  test("only an https origin with a name host is taken, and its host joins the accepted Hosts", () => {
    const settings = tailnetSettingsFromEnvironment({
      IDD_TAILNET_ORIGINS: "https://pc.example.ts.net:8443,http://pc.example.ts.net,https://100.65.29.99",
    });
    expect(settings.origins).toEqual(["https://pc.example.ts.net:8443"]);
    expect(settings.rejected.map((r) => r.value)).toEqual(["http://pc.example.ts.net", "https://100.65.29.99"]);
    const policy = tailnetSecurityPolicy(tailnetSettingsFromEnvironment({ IDD_TAILNET_ADDRESSES: "100.64.0.5", IDD_TAILNET_ORIGINS: "https://pc.example.ts.net" }));
    expect(policy).toEqual({ restrictHosts: true, tailnetHosts: ["100.64.0.5", "pc.example.ts.net"], tailnetOrigins: ["https://pc.example.ts.net"] });
  });
});

describe("the local-screen judgment", () => {
  test("a relay header anywhere makes the request not local, whatever its value", () => {
    const names = ["X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded", "Via", "X-Real-IP", "Tailscale-User-Login", "Tailscale-Headers-Info"];
    for (const name of names) {
      for (const value of ["100.64.0.9", "127.0.0.1", ""]) {
        const req = new Request(LOCAL_PAGE, { headers: { host: "localhost:30142", [name]: value } });
        rememberRequestConnection(req, "127.0.0.1");
        expect(isLoopbackRequest(req)).toBe(false);
      }
    }
  });

  test("a loopback request with no relay header is local; a tailnet listener never is", () => {
    for (const host of ["localhost:30142", "127.0.0.1:30142", "[::1]:30142"]) {
      const req = new Request(LOCAL_PAGE, { headers: { host } });
      rememberRequestConnection(req, "127.0.0.1");
      expect(isLoopbackRequest(req)).toBe(true);
    }
    // a tailnet listener is not local even when the Host claims loopback and no relay header is present
    const onTailnet = new Request(LOCAL_PAGE, { headers: { host: "localhost:30142" } });
    rememberRequestConnection(onTailnet, "100.64.0.5");
    expect(isLoopbackRequest(onTailnet)).toBe(false);
  });

  test("both recorded serve shapes are not local, including the forged `Host: localhost`", () => {
    for (const fixture of [SERVE_TAILNET_HOST, SERVE_FORGED_LOCALHOST_HOST]) {
      expect(isLoopbackRequest(serveRequest(fixture, { method: "GET" }))).toBe(false);
    }
  });

  test("the fixture carries the header names the record saw, with replaced values", () => {
    const required = ["X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Tailscale-User-Login", "Tailscale-User-Name", "Tailscale-User-Profile-Pic", "Tailscale-Headers-Info"];
    for (const fixture of [SERVE_TAILNET_HOST, SERVE_FORGED_LOCALHOST_HOST]) {
      expect(Object.keys(fixture.headers)).toEqual(expect.arrayContaining(required));
      expect(fixture.host.length).toBeGreaterThan(0);
      expect(fixture.headers["X-Forwarded-For"]).toBe("100.64.0.9");
    }
    expect([...SERVE_RECORD_HEADER_NAMES]).toEqual(expect.arrayContaining(["Host", ...required]));
    expect(SERVE_TAILNET_HOST.host).toContain("pc.example.ts.net");
    expect(SERVE_FORGED_LOCALHOST_HOST.host).toBe("localhost");
  });
});

describe("the passkey registration over the listeners", () => {
  const PAGE = "http://localhost:30142";
  const policy = { restrictHosts: true, tailnetHosts: ["100.64.0.5", "pc.example.ts.net"], tailnetOrigins: ["https://pc.example.ts.net:8443"] };
  const register = (handler: (req: Request) => Promise<Response>, body: unknown) => handler(new Request(`${PAGE}/api/idd/passkey/register`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:30142", origin: PAGE },
    body: JSON.stringify(body),
  }));

  test("a registration the tailnet listener accepted stays pending even when it declares a localhost origin and no key exists", async () => {
    stateFixture();
    process.env.IDD_TAILNET_ORIGINS = "https://pc.example.ts.net:8443";
    // the third argument is the address of the listener that accepted the request: a tailnet one, not loopback
    const handler = createFetchHandler([], policy, "100.64.0.5");
    const started = await (await register(handler, { step: "options", rpId: "localhost" })).json() as { nonce: string; options: { challenge: string } };
    const auth = softwareAuthenticator();
    const response = auth.registration({ challenge: started.options.challenge, origin: PAGE, rpId: "localhost" });
    const finished = await register(handler, { step: "finish", nonce: started.nonce, response, name: "phone" });
    const body = await finished.json() as { pending?: boolean; needsProof?: boolean };
    expect(finished.status).toBe(400);
    expect(body.pending).toBe(true);
    expect(body.needsProof).toBe(true);
    expect(passkeyCount()).toBe(0);
    expect(listPendingRegistrations().length).toBe(1);
  });

  test("the loopback listener still takes the first key on its own", async () => {
    stateFixture();
    process.env.IDD_TAILNET_ORIGINS = "https://pc.example.ts.net:8443";
    const handler = createFetchHandler([], policy, "127.0.0.1");
    const started = await (await register(handler, { step: "options", rpId: "localhost" })).json() as { nonce: string; options: { challenge: string } };
    const auth = softwareAuthenticator();
    const response = auth.registration({ challenge: started.options.challenge, origin: PAGE, rpId: "localhost" });
    const finished = await register(handler, { step: "finish", nonce: started.nonce, response, name: "local" });
    const body = await finished.json() as { ok?: boolean };
    expect(finished.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(passkeyCount()).toBe(1);
  });

  test("a registration `tailscale serve` forwarded to the loopback listener stays pending", async () => {
    stateFixture();
    process.env.IDD_TAILNET_ORIGINS = "https://pc.example.ts.net:8443";
    // serve terminates the tailnet's HTTPS and forwards to the loopback engine, naming the tailnet Host and
    // Origin: the loopback socket alone must not make that registration local
    const handler = createFetchHandler([], policy, "127.0.0.1");
    const tailnet = "https://pc.example.ts.net:8443";
    const ask = (body: unknown) => handler(new Request("http://localhost:30142/api/idd/passkey/register", {
      method: "POST",
      headers: { "content-type": "application/json", host: "pc.example.ts.net", origin: tailnet },
      body: JSON.stringify(body),
    }));
    const started = await (await ask({ step: "options", rpId: "pc.example.ts.net" })).json() as { nonce: string; options: { challenge: string } };
    const auth = softwareAuthenticator();
    const response = auth.registration({ challenge: started.options.challenge, origin: tailnet, rpId: "pc.example.ts.net" });
    const finished = await ask({ step: "finish", nonce: started.nonce, response, name: "phone" });
    const body = await finished.json() as { pending?: boolean };
    expect(finished.status).toBe(400);
    expect(body.pending).toBe(true);
    expect(passkeyCount()).toBe(0);
  });

  test("either serve shape stays pending with no key and with a registered key", async () => {
    stateFixture();
    process.env.IDD_TAILNET_ORIGINS = TAILNET_ORIGIN;
    const handler = createFetchHandler([], FIXTURE_POLICY, "127.0.0.1");

    for (const shape of SERVE_SHAPES) {
      const withNoKey = await serveRegistration(handler, shape);
      expect(withNoKey.status).toBe(400);
      expect((await withNoKey.json() as { pending?: boolean }).pending).toBe(true);
      expect(passkeyCount()).toBe(0);
    }

    await registerLocalKey();

    for (const shape of SERVE_SHAPES) {
      const withKey = await serveRegistration(handler, shape);
      expect(withKey.status).toBe(400);
      expect((await withKey.json() as { pending?: boolean }).pending).toBe(true);
      expect(passkeyCount()).toBe(1);
    }
    expect(listPendingRegistrations().length).toBe(4);
  });

  test("the pending list is refused to both serve shapes, to a tailnet listener, and read by the local screen", async () => {
    stateFixture();
    process.env.IDD_TAILNET_ORIGINS = TAILNET_ORIGIN;
    const handler = createFetchHandler([], FIXTURE_POLICY, "127.0.0.1");
    await serveRegistration(handler, SERVE_SHAPES[0]);
    const pending = listPendingRegistrations();
    expect(pending.length).toBe(1);

    for (const req of [
      serveRequest(SERVE_FORGED_LOCALHOST_HOST, { method: "GET", url: `${LOCAL_PAGE}/api/idd/passkey/pending` }),
      serveRequest(SERVE_TAILNET_HOST, { method: "GET", url: `${LOCAL_PAGE}/api/idd/passkey/pending` }),
      directRequest({ host: "localhost:30142", url: `${LOCAL_PAGE}/api/idd/passkey/pending`, listener: "100.64.0.5" }),
    ]) {
      const res = await pendingGET(req);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(pending[0].id);
      expect(text).not.toContain(pending[0].challenge);
    }

    const local = await pendingGET(directRequest({ host: "localhost:30142", url: `${LOCAL_PAGE}/api/idd/passkey/pending` }));
    expect(local.status).toBe(200);
    expect((await local.json() as { pending: unknown[] }).pending.length).toBe(1);
  });

  test("the approval door refuses both serve shapes and only the local screen approves", async () => {
    stateFixture();
    process.env.IDD_TAILNET_ORIGINS = TAILNET_ORIGIN;
    const handler = createFetchHandler([], FIXTURE_POLICY, "127.0.0.1");
    const local = await registerLocalKey();
    await serveRegistration(handler, SERVE_SHAPES[0]);
    const pending = listPendingRegistrations();
    expect(pending.length).toBe(1);
    const assertion = local.assertion({ challenge: pending[0].challenge, origin: LOCAL_PAGE, rpId: "localhost" });
    const body = { id: pending[0].id, assertion };

    for (const fixture of [SERVE_FORGED_LOCALHOST_HOST, SERVE_TAILNET_HOST]) {
      const res = await pendingPOST(serveRequest(fixture, { body, url: `${LOCAL_PAGE}/api/idd/passkey/pending/approve` }));
      expect(res.status).toBe(403);
    }
    expect(passkeyCount()).toBe(1);
    expect(listPendingRegistrations().length).toBe(1);

    const approved = await pendingPOST(directRequest({ host: "localhost:30142", url: `${LOCAL_PAGE}/api/idd/passkey/pending/approve`, body }));
    expect(approved.status).toBe(200);
    expect(passkeyCount()).toBe(2);
    expect(listPendingRegistrations().length).toBe(0);
  });
});

describe("the engine's tailnet listeners", () => {
  test("a machine-held tailnet address is served alongside loopback", async () => {
    stateFixture();
    await registerLocalKey();
    const address = localTailnetAddresses()[0];
    if (!address) {
      // the machine's tailscale is down: the check is the manual one in the lane's qa
      return;
    }
    const server = startEngine({ port: 0, tailnet: tailnetSettingsFromEnvironment({ IDD_TAILNET_ADDRESSES: address }) });
    try {
      expect(server.listening).toContain("127.0.0.1");
      expect(server.listening).toContain(address);
      const loopback = await fetch(`http://127.0.0.1:${server.port}/api/idd/state`);
      expect(loopback.status).toBe(200);
      const tailnet = await fetch(`http://${address.includes(":") ? `[${address}]` : address}:${server.port}/api/idd/state`);
      expect(tailnet.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("a failed tailnet bind leaves loopback answering and is retried", async () => {
    stateFixture();
    await registerLocalKey();
    const address = foreignTailnetAddress();
    const server = startEngine({ port: 0, retryDelayMs: 60_000, tailnet: tailnetSettingsFromEnvironment({ IDD_TAILNET_ADDRESSES: address }) });
    try {
      expect(server.listening).toEqual(["127.0.0.1"]);
      expect(server.failures.map((f) => f.address)).toEqual([address]);
      expect(server.failures[0].reason.length).toBeGreaterThan(0);
      expect(server.retryScheduled).toBe(true);
      const res = await fetch(`http://127.0.0.1:${server.port}/api/idd/state`);
      expect(res.status).toBe(200);
      // the retry attempts the bind again
      const before = server.bindAttempts[address] ?? 0;
      server.retry();
      expect(server.bindAttempts[address]).toBe(before + 1);
    } finally {
      server.stop(true);
    }
  });

  test("the startup output lists each listening address and no failed one as listening", async () => {
    stateFixture();
    await registerLocalKey();
    const address = foreignTailnetAddress();
    const server = startEngine({ port: 0, retryDelayMs: 60_000, tailnet: tailnetSettingsFromEnvironment({ IDD_TAILNET_ADDRESSES: address, IDD_TAILNET_ORIGINS: "https://pc.example.ts.net" }) });
    try {
      const lines = engineStartupLines(server);
      const listening = lines.filter((line) => line.includes("listening on"));
      expect(listening.length).toBe(1);
      expect(listening[0]).toContain(`http://127.0.0.1:${server.port}`);
      expect(listening.some((line) => line.includes(address))).toBe(false);
      expect(lines.some((line) => line.includes("could not listen on") && line.includes(address))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("with no registered key the tailnet address is held off on every retry path", async () => {
    stateFixture();
    const address = foreignTailnetAddress();
    const server = startEngine({ port: 0, retryDelayMs: 40, passkeyCount: () => 0, tailnet: tailnetSettingsFromEnvironment({ IDD_TAILNET_ADDRESSES: address }) });
    try {
      expect(server.listening).toEqual(["127.0.0.1"]);
      expect(server.failures.map((f) => f.address)).toEqual([address]);
      expect(server.failures[0].reason).toContain("待ち受けを控え");
      expect(server.retryScheduled).toBe(true);

      const lines = engineStartupLines(server);
      expect(lines.some((line) => line.includes(address) && line.includes("待ち受けを控え"))).toBe(true);
      expect(lines.some((line) => line.includes("listening on") && line.includes(address))).toBe(false);

      const res = await fetch(`http://127.0.0.1:${server.port}/api/idd/state`);
      expect(res.status).toBe(200);

      // the scheduled retry and a manual one both re-read the count and keep the address off
      await new Promise((resolve) => setTimeout(resolve, 140));
      expect(server.listening).toEqual(["127.0.0.1"]);
      expect(server.bindAttempts[address] ?? 0).toBeGreaterThan(1);
      server.retry();
      expect(server.listening).toEqual(["127.0.0.1"]);
    } finally {
      server.stop(true);
    }
  });

  test("an unreadable key record holds the tailnet bind off and leaves loopback answering", async () => {
    const state = stateFixture();
    mkdirSync(join(state, "passkey"), { recursive: true });
    writeFileSync(join(state, "passkey", "state.json"), "{ broken");
    const address = foreignTailnetAddress();
    const server = startEngine({ port: 0, retryDelayMs: 60_000, tailnet: tailnetSettingsFromEnvironment({ IDD_TAILNET_ADDRESSES: address }) });
    try {
      expect(server.listening).toEqual(["127.0.0.1"]);
      expect(server.failures[0].reason).toContain("記録を読めない");
      server.retry();
      expect(server.listening).toEqual(["127.0.0.1"]);
      expect((await fetch(`http://127.0.0.1:${server.port}/api/idd/state`)).status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("registering the first key after startup starts the tailnet listen without a restart", async () => {
    stateFixture();
    const address = localTailnetAddresses()[0];
    if (!address) {
      // no tailnet on this machine: the manual check in the lane's qa covers the bind
      return;
    }
    const settings = tailnetSettingsFromEnvironment({ IDD_TAILNET_ADDRESSES: address });
    const server = startEngine({ port: 0, retryDelayMs: 60_000, tailnet: settings });
    try {
      expect(server.listening).toEqual(["127.0.0.1"]);
      // register the first key through a request the loopback listener accepted
      const handler = createFetchHandler([], tailnetSecurityPolicy(settings), "127.0.0.1");
      const auth = softwareAuthenticator();
      const page = `http://localhost:${server.port}`;
      const started = await handler(directRequest({ host: `localhost:${server.port}`, url: `${page}/api/idd/passkey/register`, body: { step: "options", rpId: "localhost" } })).then((res) => res.json()) as { nonce: string; options: { challenge: string } };
      const finished = await handler(directRequest({ host: `localhost:${server.port}`, url: `${page}/api/idd/passkey/register`, body: { step: "finish", nonce: started.nonce, response: auth.registration({ challenge: String(started.options.challenge), origin: page, rpId: "localhost" }), name: "local" } }));
      expect(finished.status).toBe(200);
      expect(passkeyCount()).toBe(1);

      server.retry();
      expect(server.listening).toContain(address);
      const res = await fetch(`http://${address.includes(":") ? `[${address}]` : address}:${server.port}/api/idd/state`);
      expect(res.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("a request that came through a relay is marked, and the engine then treats it as not local", async () => {
    stateFixture();
    process.env.IDD_TAILNET_ORIGINS = TAILNET_ORIGIN;
    const server = startEngine({ port: 0, tailnet: tailnetSettingsFromEnvironment({}) });
    const register = `http://127.0.0.1:${server.port}/api/idd/passkey/register`;
    // the one header a relay adds: its name is what the engine reads (REQUEST_RELAY_HEADER_NAMES), the value is not
    const post = (body: unknown, relayed: boolean) => fetch(register, {
      method: "POST",
      headers: { "content-type": "application/json", ...(relayed ? { via: "1.1 relay" } : {}) },
      body: JSON.stringify(body),
    });
    try {
      // a browser request `tailscale serve` forwarded: it carries a relay header the client cannot fake away
      const started = await (await post({ step: "options", rpId: "localhost" }, true)).json() as { nonce: string; options: { challenge: string } };
      const auth = softwareAuthenticator();
      const finished = await post({ step: "finish", nonce: started.nonce, response: auth.registration({ challenge: String(started.options.challenge), origin: LOCAL_PAGE, rpId: "localhost" }), name: "phone" }, true);
      expect(finished.status).toBe(400);
      expect((await finished.json() as { pending?: boolean }).pending).toBe(true);
      expect(passkeyCount()).toBe(0);

      // a request from the machine's own screen carries no relay header, so it still registers
      const localStarted = await (await post({ step: "options", rpId: "localhost" }, false)).json() as { nonce: string; options: { challenge: string } };
      const localAuth = softwareAuthenticator();
      const localFinish = await post({ step: "finish", nonce: localStarted.nonce, response: localAuth.registration({ challenge: String(localStarted.options.challenge), origin: LOCAL_PAGE, rpId: "localhost" }), name: "local" }, false);
      expect(localFinish.status).toBe(200);
      expect(passkeyCount()).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
