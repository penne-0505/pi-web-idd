/** Web の Response を返す小さな道具。engine は Next の外で動くので NextResponse を使わない。 */

import { createHash } from "node:crypto";

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

/** 答えの中身の印。同じ中身なら同じ印、違えば違う印になる */
export function etagOf(body: string): string {
  return `"${createHash("sha1").update(body).digest("hex")}"`;
}

/** `If-None-Match` が印に当たるか（`*` と弱い印も見る） */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const value = part.trim();
    return value === "*" || value === etag || value === `W/${etag}`;
  });
}

/**
 * 中身が変わっていなければ本文を返さない JSON の答え。poll が残る間も、変わっていない答えの転送と解析が消える。
 * 印は答えの中身から作るので、同じ中身なら別の process が作っても同じ印になる。
 */
export function jsonUnlessSame(req: Request | undefined, data: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify(data);
  const etag = etagOf(body);
  const headers = new Headers(init.headers);
  headers.set("etag", etag);
  if (matchesEtag(req?.headers.get("if-none-match") ?? null, etag)) return new Response(null, { status: 304, headers });
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(body, { ...init, headers });
}

/** Set-Cookie を 1 つ足した Response を返す（`NextResponse` の `cookies.set` の代わり） */
export function setCookie(res: Response, name: string, value: string, opts: { httpOnly?: boolean; sameSite?: "Strict" | "Lax" | "None"; path?: string } = {}): Response {
  const parts = [`${name}=${value}`, `Path=${opts.path ?? "/"}`];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite ?? "Strict"}`);
  const headers = new Headers(res.headers);
  headers.append("set-cookie", parts.join("; "));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
