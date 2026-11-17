/**
 * The slice of pi's extension API this command uses, declared here so the engine's own sources never read pi's SDK.
 * The engine starts pi as a child and only sends it the command; the module below runs inside pi, not here.
 */
interface CommandPi {
  registerCommand(name: string, options: { description?: string; handler: (args: string) => Promise<void> | void }): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean }): void;
}

/**
 * The one command the engine's conversations rely on: it appends an invisible context message without starting
 * a turn. The engine reads the conversation's operations file at delivery time and sends the whole instruction
 * as this command's argument; the command writes it into pi's own record as a hidden `custom_message`, so the
 * history stays pi's and a later switch can tell which type's instruction is already there.
 *
 * The command adds no tool and does not touch the system prompt. `details` carries the type and the kind, and
 * the engine reads them back when it decides whether a conversation's instruction is missing or stale.
 */
export const CONVERSATION_TYPE_CUSTOM_TYPE = "idd.conversation-type";
export const CONVERSATION_TYPE_COMMAND = "idd-context";

interface InstructionPayload {
  content?: unknown;
  type?: unknown;
  kind?: unknown;
}

/** the command the engine sends; everything else is a user's own use of the extension */
export const CONVERSATION_TYPE_COMMAND_TEXT = `/${CONVERSATION_TYPE_COMMAND}`;

export default function registerConversationType(pi: CommandPi): void {
  pi.registerCommand(CONVERSATION_TYPE_COMMAND, {
    description: "Add a hidden context message for the conversation's type",
    handler: async (args: string) => {
      let parsed: InstructionPayload | undefined;
      try {
        parsed = JSON.parse(args) as InstructionPayload;
      } catch {
        return;
      }
      if (!parsed || typeof parsed.content !== "string") return;
      pi.sendMessage({
        customType: CONVERSATION_TYPE_CUSTOM_TYPE,
        content: parsed.content,
        display: false,
        details: { type: parsed.type, kind: parsed.kind },
      }, { triggerTurn: false });
    },
  });
}
