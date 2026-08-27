// intent: DEC-609 — 根の解決だけを分けて循環 import を避ける
// intent: DEC-650 — engine が知ってよい外界は state dir と intent root だけ

import { join } from "node:path";

export function stateDir(): string {
  return process.env.IDD_STATE_DIR?.trim() || join(process.cwd(), "state");
}

export function intentRoot(): string {
  return process.env.IDD_INTENT_DIR?.trim() || join(process.cwd(), "_docs", "intent");
}
