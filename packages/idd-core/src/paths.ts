
import { join } from "node:path";

import { checkoutRoot } from "./config/files.ts";
import { resolveStateDir } from "./install/pointers.ts";

/** the state every reader and writer of this process shares; the decision is `resolveStateDir`'s, not made here */
export function stateDir(): string {
  return resolveStateDir({ checkout: checkoutRoot() });
}

export function intentRoot(): string {
  return process.env.IDD_INTENT_DIR?.trim() || join(process.cwd(), "_docs", "intent");
}
