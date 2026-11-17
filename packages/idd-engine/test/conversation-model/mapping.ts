/**
 * The one projection from the implementation's state onto the reference model, plus the differences a DEC
 * allows the implementation to keep. Nothing else may read the implementation's states when comparing.
 */
import type { ConversationMachine, QueueItem } from "../../src/server/conversations.ts";
import type { RefItem, RefPhase } from "./reference.ts";

export interface Projection {
  phase: RefPhase;
  /** the items not handed to pi, in the reference's counting */
  queue: RefItem[];
}

function toRef(item: QueueItem): RefItem {
  return {
    id: item.id,
    text: item.text,
    ...(item.model ? { model: item.model } : {}),
    ...(item.effort ? { effort: item.effort } : {}),
  };
}

/**
 * DEC-2523. The rows are the implementation's state values; anything else throws, so a state value added
 * without a row stops the matching instead of being read two ways.
 */
export function mapImplementation(machine: ConversationMachine): Projection {
  const state = machine.state;
  const tail = machine.queue.map(toRef);
  switch (state.phase) {
    case "closed":
      return { phase: "Closed", queue: tail };
    case "opening":
      return { phase: "Opening", queue: tail };
    case "idle":
      return { phase: "Idle", queue: tail };
    case "delivering":
      return { phase: "Idle", queue: tail };
    case "running":
      return { phase: "Running", queue: tail };
    case "closing":
      return { phase: "Closing", queue: tail };
    case "sending":
      if (state.awaiting === "model" || state.awaiting === "effort") {
        return { phase: "Idle", queue: [toRef(state.item), ...tail] };
      }
      if (state.awaiting === "prompt") return { phase: "Running", queue: tail };
      throw new Error(`写像の表に無い sending の await: ${String(state.awaiting)}`);
    case "stopping":
      if (state.awaiting === "model" || state.awaiting === "effort") {
        return { phase: "Idle", queue: state.item ? [toRef(state.item), ...tail] : tail };
      }
      return { phase: "Stopping", queue: tail };
    default: {
      const unreachable: never = state;
      throw new Error(`写像の表に無い状態: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * DEC-2524. The implementation may differ from the reference only where an existing DEC decided the
 * behaviour. Each difference is named and carries the DEC that allows it; anything not listed is a failure.
 * `guards` keeps the sequence generator away from the exact operation the difference covers.
 */
export interface ApprovedDifference {
  name: string;
  /** the DEC that decided the implementation's behaviour */
  reference: string;
  description: string;
}

export const APPROVED_DIFFERENCES: readonly ApprovedDifference[] = Object.freeze([
  {
    name: "切替を待つ項目の編集と取り消し",
    reference: "IDD-062 の DEC-2288",
    description: "`prompt` を書く前でも、Sending に入った項目の編集と取り消しを 409 で断る",
  },
  {
    name: "切替の応答待ちの Idle の割り込み",
    reference: "IDD-062 の DEC-2283",
    description: "切替の応答待ちの Idle の割り込みをキューに積む",
  },
]);

/** the difference names, for the QA record and the test that proves one of them is load-bearing */
export const APPROVED_DIFFERENCE_NAMES: readonly string[] = Object.freeze(APPROVED_DIFFERENCES.map((d) => d.name));
