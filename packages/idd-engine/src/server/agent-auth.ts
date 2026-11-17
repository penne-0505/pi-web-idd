
import { checkAgentToken } from "@idd/core";

export function authorize(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  return checkAgentToken(bearer ?? req.headers.get("x-idd-token"));
}
