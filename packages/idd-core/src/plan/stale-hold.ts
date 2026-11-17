/**
 * Whether the engine is behind its checkout with a replacement on the way, told by the engine to the core stages.
 *
 * The stages that build a planner's brief (the intake, the planner starts, the stall watch) hold while it says so:
 * the running engine keeps the module it loaded, so a planner started after a landing would be briefed by the old
 * code. The engine owns the judgment (it reads git, systemd and its own reload state), so core never imports the
 * engine: the engine's entry puts its own answer in here, and the default holds nothing.
 */

/** the engine's answer: whether to hold, and the reason a result shows */
export interface StaleHold {
  hold: boolean;
  reason?: string;
}

let provider: () => StaleHold = () => ({ hold: false });

/** put the engine's judgment in (the engine's entry), or a stand-in (a test); null restores the default */
export function setStaleHoldProvider(next: (() => StaleHold) | null): void {
  provider = next ?? (() => ({ hold: false }));
}

/** the engine's answer now; a provider that throws reads as no hold, so a broken judgment never stops the stages */
export function staleHold(): StaleHold {
  try {
    const answer = provider();
    return answer && answer.hold ? answer : { hold: false };
  } catch {
    return { hold: false };
  }
}
