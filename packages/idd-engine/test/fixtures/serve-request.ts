/**
 * The shape of a request `tailscale serve` delivers, taken from the record in
 * `_docs/reference/pi-web-idd/idd-061/reference.md` ("実物の serve の記録"). The tailnet name, IP and login are
 * replaced values: the record is committed, so it must not carry a real device's name or a person's login.
 *
 * Two shapes matter. The client normally sends the tailnet Host, which serve passes through as it is. A client can
 * also forge `Host: localhost`, which serve forwards unchanged to the loopback listener, so the request arrives
 * looking exactly like the local screen's own except for the headers serve adds. Those headers cannot be taken off
 * by the client, and `X-Forwarded-For` / `X-Forwarded-Proto` / `Tailscale-*` are overwritten by serve even when
 * the client sends its own values.
 */

/** the replaced values: a tailnet name's form, a tailnet IP, and a login name */
export const SERVE_PLACEHOLDERS = { host: "pc.example.ts.net", ip: "100.64.0.9", login: "user@example.com" } as const;

export interface ServeRequestFixture {
  /** the Host header serve delivered (the client's own, since serve rewrites it) */
  host: string;
  /** every header the record saw besides Host, with the values replaced where they name a device or a person */
  headers: Record<string, string>;
}

/** the headers serve adds, the same in both shapes: the names come from the record, the values are placeholders */
const SERVE_HEADERS: Record<string, string> = {
  "X-Forwarded-For": SERVE_PLACEHOLDERS.ip,
  "X-Forwarded-Host": SERVE_PLACEHOLDERS.host,
  "X-Forwarded-Proto": "https",
  "Tailscale-User-Login": SERVE_PLACEHOLDERS.login,
  "Tailscale-User-Name": "Example User",
  "Tailscale-User-Profile-Pic": "https://example.com/profile.png",
  "Tailscale-Headers-Info": "https://tailscale.com/s/serve-headers",
  "Accept-Encoding": "gzip",
  "User-Agent": "curl/8.7.1",
  Accept: "*/*",
};

/** the client sends the tailnet Host, so Host and X-Forwarded-Host both name the tailnet */
export const SERVE_TAILNET_HOST: ServeRequestFixture = {
  host: `${SERVE_PLACEHOLDERS.host}:8443`,
  headers: { ...SERVE_HEADERS },
};

/** the client forges `Host: localhost`; serve forwards it and copies it into X-Forwarded-Host */
export const SERVE_FORGED_LOCALHOST_HOST: ServeRequestFixture = {
  host: "localhost",
  headers: { ...SERVE_HEADERS, "X-Forwarded-Host": "localhost" },
};

/** every header name the record saw (Host included), so a test can prove the fixture follows the record */
export const SERVE_RECORD_HEADER_NAMES = ["Host", ...Object.keys(SERVE_HEADERS)] as const;
