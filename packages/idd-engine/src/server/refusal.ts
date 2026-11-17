/**
 * The refusal a conversation door answers with: the message is the caller's, the status the HTTP code.
 * It lives apart from `conversations.ts` so the modules the conversation server builds on (paths, marks,
 * projects) can refuse without importing the server that imports them.
 */
export class ConversationRefused extends Error {
  constructor(message: string, readonly status = 404, readonly body: Record<string, unknown> = {}) {
    super(message);
    this.name = "ConversationRefused";
  }
}
