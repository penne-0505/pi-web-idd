// intent: DEC-660 — agent 用の書き込み口は token でだけ開く (dev server は LAN に出ている)

import { checkAgentToken } from "@idd/core";

export function authorize(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  return checkAgentToken(bearer ?? req.headers.get("x-idd-token"));
}
