// intent: DEC-609 — 根の解決だけを分けて state.ts と lane-work.ts の循環を避ける

import { join } from "node:path";

export function stateDir(): string {
  return process.env.IDD_STATE_DIR?.trim() || join(process.cwd(), "state");
}

export function intentRoot(): string {
  return process.env.IDD_INTENT_DIR?.trim() || join(process.cwd(), "_docs", "intent");
}
