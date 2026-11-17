/// <reference types="bun" />
import { DEFAULT_ENGINE_PORT, passkeyCount } from "@idd/core";
import { isApiRequestAllowed, type ApiRequestPolicy } from "../../../lib/request-security.ts";
import { json } from "./http.ts";
import { rememberRequestConnection } from "./request-connection.ts";
import { matchRoute, routes, type Route } from "./routes.ts";
import { beginTrackedRequest, reloadRefusal, trackResponse } from "./server/reload.ts";
import { tailnetBindingAddresses, tailnetSecurityPolicy, tailnetSettingsFromEnvironment, type RejectedSetting, type TailnetSettings } from "./tailnet.ts";

export interface EngineServerOptions {
  port?: number;
  hostname?: string;
  /** tests add a route of their own (a slow one for the idle check) */
  extraRoutes?: readonly Route[];
  /** the tailnet settings to use; default is what the environment carries */
  tailnet?: TailnetSettings;
  /** how long a failed tailnet bind waits before it is tried again (tests shorten it) */
  retryDelayMs?: number;
  /** how the engine reads the number of registered keys; a test whose machine holds no tailnet address puts its own reader in */
  passkeyCount?: () => number;
}

export interface EngineServer {
  /** the port every listener shares */
  port: number;
  /** the addresses listening now, loopback first */
  listening: string[];
  /** the settings that were refused, with the reason */
  rejected: RejectedSetting[];
  /** the tailnet addresses whose bind failed, with the reason */
  failures: { address: string; reason: string }[];
  /** how many bind attempts each tailnet address has had */
  bindAttempts: Record<string, number>;
  /** whether a retry of the failed addresses is scheduled */
  retryScheduled: boolean;
  /** bind the failed addresses once now (the timer uses it; tests call it directly) */
  retry(): void;
  stop(closeActive?: boolean): void;
}

/** IPv6 addresses need brackets in a URL: `http://[fd7a:...::1]:30144` */
function formatHost(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

/**
 * The engine's request handler: the Host / Origin guard first, then the route table. The guard is the one the
 * GUI's entry shares, but the engine passes its own policy: loopback and the configured tailnet only, and the
 * HTTPS origins `tailscale serve` terminated. A caller that passes no policy (the engine's tests) gets the
 * settings the environment carries.
 *
 * `listenerAddress` is the address the accepting `Bun.serve` listens on; the handler records it against the
 * request so the passkey's registration can tell a request the local screen sent from one a tailnet listener
 * accepted (see `request-connection`). A caller that passes none records nothing, and the Host decides.
 */
export function createFetchHandler(extraRoutes: readonly Route[] = [], policy?: ApiRequestPolicy, listenerAddress?: string): (req: Request) => Promise<Response> {
  const table: readonly Route[] = [...routes, ...extraRoutes];
  const resolved = policy ?? tailnetSecurityPolicy(tailnetSettingsFromEnvironment());
  return async (req: Request): Promise<Response> => {
    // the count and the "reloading" window are one per engine, not one per listener: a request on the tailnet must
    // be counted and refused the same way as one on loopback
    const record = beginTrackedRequest(req);
    if (!record) return reloadRefusal();
    if (listenerAddress !== undefined) rememberRequestConnection(req, listenerAddress);
    if (!isApiRequestAllowed(req, [], resolved)) return trackResponse(json({ error: "Untrusted API request" }, { status: 403 }), record);
    const { pathname } = new URL(req.url);
    for (const route of table) {
      if (route.method !== req.method) continue;
      const params = matchRoute(route.pattern, pathname);
      if (!params) continue;
      try {
        return trackResponse(await route.handler(req, params), record);
      } catch (err) {
        return trackResponse(json({ ok: false, error: String(err) }, { status: 500 }), record);
      }
    }
    return trackResponse(json({ error: "not found", path: pathname }, { status: 404 }), record);
  };
}

/**
 * The idle check is off (`idleTimeout: 0`): the tick and a decision wait for their work to answer, which can
 * take minutes, and Bun's default would cut the connection before the answer.
 *
 * Loopback is bound first and must succeed (the CLI, the agents' reports and the GUI's proxy all point at it).
 * A tailnet address waits until a key is registered: the first key is taken without a signature, so a tailnet
 * listener while none exists would open exactly the window the first-key rule guards. The count is read on every
 * bind attempt, so the retry that follows a key's registration starts the listener without a restart. A tailnet
 * address that fails to bind (the interface is not up yet, or the address is not this machine's) is reported and
 * retried the same way, and never stops the loopback listener.
 */
export function startEngine(opts: EngineServerOptions = {}): EngineServer {
  const settings = opts.tailnet ?? tailnetSettingsFromEnvironment();
  const port = opts.port ?? Number(process.env.IDD_ENGINE_PORT ?? DEFAULT_ENGINE_PORT);
  const loopbackHost = opts.hostname ?? settings.loopback;
  const securityPolicy = tailnetSecurityPolicy(settings);
  const countPasskeys = opts.passkeyCount ?? passkeyCount;
  // one handler per listener: each records its own address against the requests it accepts
  const handlerFor = (address: string) => createFetchHandler(opts.extraRoutes, securityPolicy, address);

  const listeners: { address: string; server: ReturnType<typeof Bun.serve> }[] = [];
  const failures = new Map<string, string>();
  const attempts: Record<string, number> = {};
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // loopback first: its port is the one every other listener shares, and a failure here is fatal
  const primary = Bun.serve({ hostname: loopbackHost, port, idleTimeout: 0, fetch: handlerFor(loopbackHost) });
  listeners.push({ address: loopbackHost, server: primary });
  const listeningPort = Number(primary.port);

  const bind = (address: string): void => {
    attempts[address] = (attempts[address] ?? 0) + 1;
    // read the count before the bind, not at startup: the retry after the first key's registration starts the
    // listener, and a record that cannot be read holds the bind off rather than being read as no keys at all
    let keys: number;
    try {
      keys = countPasskeys();
    } catch (error) {
      failures.set(address, `passkey の記録を読めないため待ち受けを控えます: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (keys < 1) {
      failures.set(address, "登録済みの passkey が 0 本のため待ち受けを控えます（最初の鍵は署名なしで登録できるため）");
      return;
    }
    try {
      listeners.push({ address, server: Bun.serve({ hostname: address, port: listeningPort, idleTimeout: 0, fetch: handlerFor(address) }) });
      failures.delete(address);
    } catch (error) {
      failures.set(address, error instanceof Error ? error.message : String(error));
    }
  };

  for (const address of tailnetBindingAddresses(settings).slice(1)) bind(address);

  const scheduleRetry = (): void => {
    if (stopped || retryTimer || failures.size === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      for (const address of [...failures.keys()]) bind(address);
      scheduleRetry();
    }, opts.retryDelayMs ?? 5_000);
    // the timer must not keep the process alive once its work is done
    retryTimer.unref?.();
  };
  scheduleRetry();

  return {
    get port(): number {
      return listeningPort;
    },
    get listening(): string[] {
      return listeners.map((listener) => listener.address);
    },
    rejected: settings.rejected,
    get failures(): { address: string; reason: string }[] {
      return [...failures.entries()].map(([address, reason]) => ({ address, reason }));
    },
    get bindAttempts(): Record<string, number> {
      return { ...attempts };
    },
    get retryScheduled(): boolean {
      return retryTimer !== null;
    },
    retry(): void {
      if (stopped) return;
      for (const address of [...failures.keys()]) bind(address);
      scheduleRetry();
    },
    stop(closeActive?: boolean): void {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      for (const listener of listeners) listener.server.stop(closeActive);
      listeners.length = 0;
    },
  };
}

/** one line per listening address, then one per rejected value and failed bind, for the engine's startup output */
export function engineStartupLines(server: EngineServer): string[] {
  const lines = server.listening.map((address) => `idd-engine: listening on http://${formatHost(address)}:${server.port}`);
  for (const rejected of server.rejected) lines.push(`idd-engine: refused ${rejected.value}: ${rejected.reason}`);
  for (const failure of server.failures) {
    lines.push(`idd-engine: could not listen on http://${formatHost(failure.address)}:${server.port}: ${failure.reason} (will retry)`);
  }
  return lines;
}
