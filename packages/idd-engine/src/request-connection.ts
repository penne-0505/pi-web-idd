import { isIP } from "node:net";

/**
 * Which listener accepted a request. `Bun.serve` gives the fetch handler no way to see the local socket, so each
 * listener's own handler records its address here: the passkey's "手元の画面" judgment needs to know whether the
 * request arrived on the loopback listener or on a tailnet one. `tailscale serve` forwards the tailnet's HTTPS to
 * the loopback listener, so the address a request was accepted on is not enough by itself — the Host is read too.
 */
const connections = new WeakMap<Request, string>();

/** record the address of the listener that accepted this request (called by `createFetchHandler`) */
export function rememberRequestConnection(req: Request, listenerAddress: string): void {
  connections.set(req, listenerAddress);
}

/** the address of the listener that accepted this request, or null when the handler did not record one */
export function requestListenerAddress(req: Request): string | null {
  return connections.get(req) ?? null;
}

function unbracket(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function normalizeHostname(value: string): string {
  return unbracket(value).toLowerCase().replace(/\.$/, "");
}

function hostnameOf(value: string): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

/** the hostname the request's Host header names; the engine's own proxy always sends one */
export function requestHost(req: Request): string | null {
  const host = req.headers.get("host");
  if (host) return hostnameOf(`http://${host}`);
  // a handler called directly in a test builds the Request with no Host header: its URL still names the host
  try {
    return normalizeHostname(new URL(req.url).hostname);
  } catch {
    return null;
  }
}

/** the hostname the request's Origin header names, when the request carries one */
export function requestOriginHost(req: Request): string | null {
  const origin = req.headers.get("origin");
  return origin ? hostnameOf(origin) : null;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1") return true;
  return isIP(hostname) === 4 && hostname.startsWith("127.");
}

function isLoopbackAddress(address: string): boolean {
  const bare = unbracket(address);
  if (bare === "::1" || bare === "localhost") return true;
  return isIP(bare) === 4 && bare.startsWith("127.");
}

/**
 * The header names a relay in front of the engine adds. `tailscale serve` always sets `X-Forwarded-For`,
 * `X-Forwarded-Proto` and at least one `Tailscale-*`; other reverse proxies set the rest. A client can forge its
 * own `Host`, but it cannot take these off a relayed request, so their presence — never their value — is what
 * tells a relayed request apart. Names are compared in lower case (`Request` lower-cases its header names).
 */
export const REQUEST_RELAY_HEADER_NAMES = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "via", "x-real-ip"] as const;

/** whether the request carries any header a relay would add; a `Tailscale-*` name counts, whatever its value */
export function requestHasRelayHeader(req: Request): boolean {
  for (const name of req.headers.keys()) {
    const lower = name.toLowerCase();
    if (lower.startsWith("tailscale-")) return true;
    if ((REQUEST_RELAY_HEADER_NAMES as readonly string[]).includes(lower)) return true;
  }
  return false;
}

/**
 * Whether the request is one the local screen sent. Three things are read: the address of the listener that
 * accepted it, the host its Host header names, and whether a relay added a header. A request on a tailnet
 * listener is never local, whatever Host it carries — a tailnet client can claim `localhost` in its header, and
 * the Host on its own must not open the first key. `tailscale serve` reaches the engine on the loopback listener
 * while naming the tailnet host, so the host must name loopback as well. A relay always adds one of
 * `REQUEST_RELAY_HEADER_NAMES`, so a request carrying any of them is not local even when its listener and Host
 * both say loopback — the client cannot forge its way past this by faking the Host. With no listener recorded
 * (the route tests call the handler directly), the Host and the relay headers decide.
 */
export function isLoopbackRequest(req: Request): boolean {
  if (requestHasRelayHeader(req)) return false;
  if (!isLoopbackHostname(requestHost(req) ?? "")) return false;
  const listener = requestListenerAddress(req);
  return listener === null || isLoopbackAddress(listener);
}
