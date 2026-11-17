const USAGE = "usage: idd tick [--no-intake] [--for-state DIR]";

/**
 * The tick request from the CLI arguments. Anything but --no-intake and --for-state DIR is refused: an unknown
 * flag must not run a tick that takes in Issues. --for-state is what a kick from a finished lane sends, so that a
 * server keeping another state does nothing.
 */
export function tickBody(args: string[]): { intake: boolean; for_state?: string } {
  const unknown: string[] = [];
  let forState: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--no-intake") continue;
    if (a === "--for-state") {
      const dir = args[i + 1];
      if (!dir || dir.startsWith("--")) throw new Error(`--for-state に state の置き場がありません。${USAGE}`);
      forState = dir;
      i += 1;
      continue;
    }
    unknown.push(a);
  }
  if (unknown.length) throw new Error(`知らない引数: ${unknown.join(" ")}。${USAGE}`);
  return { intake: !args.includes("--no-intake"), ...(forState !== undefined ? { for_state: forState } : {}) };
}

/**
 * The CLI commands that write a record the next tick acts on: an import or a lane's public branch taken in
 * (accept-receive; the tick's close records the merges), a reclaim (the lane is retired by it), Issues taken in
 * (their planners start on it), an ignore or a redo (the tick stops what still runs for the lane and retires its
 * worktree), and a review lane opened or resumed (its stages run on it). The CLI's ship pushes nothing and makes
 * no PR (it sends penne to the submit card), so it writes nothing for the tick.
 */
const ASKS_FOR_TICK = new Set(["import", "accept-receive", "reclaim", "intake", "ignore", "lane redo", "review open", "review resume"]);

export function commandAsksForTick(command: string, sub?: string): boolean {
  return ASKS_FOR_TICK.has(sub ? `${command} ${sub}` : command);
}
