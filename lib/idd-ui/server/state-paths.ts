// intent: state / intent の置き場所だけを持つ。state.ts と lane-work.ts の双方から参照されるため独立させる。

import { join } from "node:path";

export function stateDir(): string {
  return process.env.IDD_STATE_DIR?.trim() || join(process.cwd(), "state");
}

export function intentRoot(): string {
  return process.env.IDD_INTENT_DIR?.trim() || join(process.cwd(), "_docs", "intent");
}
