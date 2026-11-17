import { isIP } from "node:net";

import type { ApiRequestPolicy } from "../../../lib/request-security.ts";

/**
 * The engine's tailnet settings: the loopback address it always listens on, the tailnet addresses to add, and the
 * HTTPS origins `tailscale serve` terminates for it. The settings reach the process through its environment, so
 * the entry point's env file (`~/.config/idd/gateway.env`) carries them past `idd install`, and a plain `bun`
 * launch gets the same values. This module also decides what an address or origin may be, so a typo cannot move
 * the listen to the LAN, the whole of the network, or a name the tailnet does not own.
 */

/** the loopback address the engine always listens on, whatever the settings say */
export const LOOPBACK_HOST = "127.0.0.1";

/** the address Tailscale hands a device; a listener anywhere else would drop the tailnet's own layer */
const TAILNET_IPV4 = "100.64.0.0/10";
const TAILNET_IPV6_PREFIX = [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0] as const;

export interface RejectedSetting {
  value: string;
  reason: string;
}

export interface TailnetSettings {
  /** the address the engine always listens on, first in `bindingAddresses` */
  loopback: string;
  /** the tailnet addresses to listen on, in the order they were written */
  addresses: string[];
  /** the configured HTTPS origins (an origin whose host is an accepted Host, and the exact origin for a request) */
  origins: string[];
  /** the written values that were refused, with the reason, so the output can say why */
  rejected: RejectedSetting[];
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    out = (out << 8) | octet;
  }
  return out >>> 0;
}

function ipv6Bytes(value: string): number[] | null {
  const bare = value.split("%", 1)[0];
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string): string[] => (half ? half.split(":") : []);
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (halves.length === 2 && head.length + tail.length > 8) return null;
  const all = halves.length === 2 ? [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (all.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

/** whether an address is inside the tailnet's own IP space */
export function isTailnetAddress(value: string): boolean {
  if (isIP(value) === 4) {
    const int = ipv4ToInt(value);
    // 100.64.0.0/10: 100.64.x.x through 100.127.x.x
    return int !== null && (int & 0xffc00000) === 0x64400000;
  }
  if (isIP(value) === 6) {
    const bytes = ipv6Bytes(value);
    if (!bytes) return false;
    // fd7a:115c:a1e0::/48
    return TAILNET_IPV6_PREFIX.every((byte, index) => bytes[index] === byte);
  }
  return false;
}

/** a tailnet name's origin: https, and a hostname that is not an IP (WebAuthn needs a name, not an address) */
function originOf(value: string): { origin: string; hostname: string } | { reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { reason: "URL として読めません" };
  }
  if (parsed.protocol !== "https:") return { reason: "https の origin だけを受けます" };
  if (!parsed.hostname || isIP(parsed.hostname) !== 0) return { reason: "IP でない host の origin だけを受けます" };
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return { reason: "origin だけを書いてください（path は付けられません）" };
  return { origin: parsed.origin, hostname: parsed.hostname.toLowerCase() };
}

function splitSetting(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** the settings the engine's environment carries; a missing variable means today's loopback-only behavior */
export function tailnetSettingsFromEnvironment(env: Record<string, string | undefined> = process.env): TailnetSettings {
  const addresses: string[] = [];
  const origins: string[] = [];
  const rejected: RejectedSetting[] = [];

  for (const value of splitSetting(env.IDD_TAILNET_ADDRESSES)) {
    if (isTailnetAddress(value)) addresses.push(value);
    else rejected.push({ value, reason: `${value} は tailnet の範囲（${TAILNET_IPV4}・fd7a:115c:a1e0::/48）のアドレスではありません` });
  }
  for (const value of splitSetting(env.IDD_TAILNET_ORIGINS)) {
    const parsed = originOf(value);
    if ("reason" in parsed) rejected.push({ value, reason: `${value} は受けられません: ${parsed.reason}` });
    else origins.push(parsed.origin);
  }

  return { loopback: LOOPBACK_HOST, addresses, origins, rejected };
}

/** every address the engine listens on: loopback first, then the accepted tailnet addresses */
export function tailnetBindingAddresses(settings: TailnetSettings): string[] {
  return [settings.loopback, ...settings.addresses];
}

/** the hosts and origins the guard accepts, derived from the one settings value (DEC-2164・DEC-2165) */
export function tailnetSecurityPolicy(settings: TailnetSettings): ApiRequestPolicy {
  const hosts = [...settings.addresses];
  for (const origin of settings.origins) {
    try {
      hosts.push(new URL(origin).hostname);
    } catch {
      // an origin only reaches this list after `originOf` accepted it, so this cannot happen
    }
  }
  return { restrictHosts: true, tailnetHosts: hosts, tailnetOrigins: [...settings.origins] };
}
