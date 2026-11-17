import type { CardOperation, InboxItem, OperationCondition } from "../engine/contract";

/**
 * The operations the engine answered for a card, as the screen reads them. The screen derives no operation from a
 * field of the card: an operation the answer does not name does not exist here, and one it holds is not pressable
 * (C-265-1). A card without an answer (an engine that does not send one) has no operation.
 */
export function operationsOf(item: InboxItem): CardOperation[] {
  return item.decision?.operations ?? [];
}

/** the engine's operation of this id on the card, if it named one */
export function operationOf(item: InboxItem, ...ids: string[]): CardOperation | undefined {
  const all = operationsOf(item);
  for (const id of ids) {
    const found = all.find((op) => op.id === id);
    if (found) return found;
  }
  return undefined;
}

/** whether the engine says the operation is signed (by a passkey or by a passkey or the PIN) */
export function isSigned(op: CardOperation | undefined): boolean {
  return Boolean(op) && op!.signature !== "none";
}

/** the conditions of an operation the screen shows against the input */
export function conditionsOf(op: CardOperation | undefined): OperationCondition[] {
  return op?.conditions ?? [];
}

/** the Purposes the engine's answer names for a GO: the only ones its press confirms (DEC-112-1) */
export function confirmedPurposes(op: CardOperation | undefined): NonNullable<CardOperation["confirms"]>["purposes"] {
  return op?.confirms?.purposes ?? [];
}
