import { isIP } from "node:net";

function normalizeHostname(value: string): string {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return unbracketed.toLowerCase().replace(/\.$/, "");
}

function hostnameFromAuthority(value: string): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function normalizeConfiguredHostname(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return isIP(trimmed) ? normalizeHostname(trimmed) : hostnameFromAuthority(trimmed);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function configuredHostnamesFromEnvironment(): string[] {
  return [
    process.env.PI_WEB_HOSTNAME,
    ...(process.env.PI_WEB_ALLOWED_HOSTS?.split(",") ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
}

/**
 * What an entry point accepts beyond the defaults. The Next entry calls the guard with no policy (its judgment
 * does not change). The engine's entry passes a policy built from its tailnet settings: it accepts loopback and
 * the configured hosts only, and it takes an HTTPS origin that `tailscale serve` terminated as same-origin.
 */
export interface ApiRequestPolicy {
  /** the tailnet addresses and the configured origin hosts the entry accepts besides loopback */
  tailnetHosts?: readonly string[];
  /** the configured HTTPS origins the entry accepts even though the request reached it over http */
  tailnetOrigins?: readonly string[];
  /** an IP Host that is neither loopback nor a configured tailnet address is refused (the engine) */
  restrictHosts?: boolean;
}

function normalizeHostList(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => normalizeConfiguredHostname(value))
    .filter((value): value is string => value !== null);
}

/** a configured origin the engine may take: https, and a hostname rather than an IP address */
function acceptableTailnetOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    if (isIP(parsed.hostname) !== 0) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isLoopbackAddress(hostname: string): boolean {
  if (hostname === "::1") return true;
  return isIP(hostname) === 4 && hostname.split(".")[0] === "127";
}

function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getRequestOrigin(request: Request): string | null {
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host");
  return host ? canonicalOrigin(`${requestUrl.protocol}//${host}`) : null;
}

function isUserInitiatedSessionExportNavigation(request: Request): boolean {
  if (
    request.method !== "GET"
    || request.headers.get("sec-fetch-mode") !== "navigate"
    || request.headers.get("sec-fetch-dest") !== "document"
    || request.headers.get("sec-fetch-user") !== "?1"
  ) {
    return false;
  }

  try {
    return /^\/api\/sessions\/[^/]+\/export$/.test(new URL(request.url).pathname);
  } catch {
    return false;
  }
}


export function isApiRequestHostAllowed(
  request: Request,
  configuredHostnames = configuredHostnamesFromEnvironment(),
  policy?: ApiRequestPolicy,
): boolean {
  const host = request.headers.get("host");
  const hostname = host ? hostnameFromAuthority(host) : null;
  if (!hostname) return false;
  if (isLoopbackHostname(hostname)) return true;

  const tailnetHosts = normalizeHostList(policy?.tailnetHosts);
  const allowedHostnames = [...configuredHostnames, ...(policy?.tailnetHosts ?? [])]
    .map((value) => normalizeConfiguredHostname(value))
    .filter((value): value is string => value !== null);

  if (isIP(hostname)) {
    if (!policy?.restrictHosts) return true;
    // the engine accepts only its own loopback and the addresses its settings name; a stray LAN or public IP is refused
    return isLoopbackAddress(hostname) || tailnetHosts.includes(hostname);
  }

  return allowedHostnames.includes(hostname);
}


export function isApiRequestOriginAllowed(request: Request, policy?: ApiRequestPolicy): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (!origin) return true;

  const canonical = canonicalOrigin(origin);
  if (canonical === null) return false;
  // an HTTPS origin `tailscale serve` terminated reaches the engine over http, so the request's own scheme cannot
  // rebuild it; an origin the settings name exactly is taken (https and a name host, never http or an IP)
  const configured = (policy?.tailnetOrigins ?? [])
    .map((value) => acceptableTailnetOrigin(value))
    .filter((value): value is string => value !== null);
  if (configured.includes(canonical)) return true;

  const requestOrigin = getRequestOrigin(request);
  return requestOrigin !== null && canonical === requestOrigin;
}

export function shouldCheckApiRequestOrigin(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}

export function isApiRequestAllowed(
  request: Request,
  configuredHostnames = configuredHostnamesFromEnvironment(),
  policy?: ApiRequestPolicy,
): boolean {
  if (!isApiRequestHostAllowed(request, configuredHostnames, policy)) return false;
  if (isUserInitiatedSessionExportNavigation(request)) return true;
  return !shouldCheckApiRequestOrigin(request) || isApiRequestOriginAllowed(request, policy);
}

export function hasJsonContentType(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json"
    || Boolean(mediaType?.startsWith("application/") && mediaType.endsWith("+json"));
}
