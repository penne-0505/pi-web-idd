// intent: DEC-659 — pi session の所有者は runtime を持つ 1 プロセスだけ。engine は port しか持たない

export interface AgentRunner {
  // intent: DEC-662 — 稼働中は followUp で次の turn へ回し、割り込まない
  deliver(sessionId: string, text: string, opts?: { cwd?: string }): Promise<void>;
  spawn?(opts: { role: string; cwd: string; sessionId?: string }): Promise<{ sessionId: string }>;
}

let runner: AgentRunner | null = null;

export function setAgentRunner(next: AgentRunner | null): void {
  runner = next;
}

export function getAgentRunner(): AgentRunner | null {
  return runner;
}
