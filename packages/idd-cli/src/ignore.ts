import { ignoreByRef, listIgnored, type LinearIntakeDeps } from "../../idd-core/src/index.ts";
import { requestTick, type TickKick } from "../../idd-lane/src/tick-kick.ts";

const USAGE = "usage: idd ignore <ref> | idd unignore <ref> | idd ignores   （ref は #12・owner/name#12・APP-1234。lane の IDD-xxx も受けます）";

/** `s1_defer` / `lane_abort` put an Issue on the list in records written before `ignore` was the one operation */
const isLaneStop = (by: string): boolean => by === "s1_defer" || by === "lane_abort";

export interface CommandOutput {
  code: number;
  stdout: string[];
  stderr: string[];
}

/**
 * `idd ignore` / `idd unignore` / `idd ignores`: the Issues intake leaves out. The list is IDD's own: nothing is
 * written to GitHub or Linear. An ignore of an Issue whose lane is open closes that lane (its sessions and runs are
 * stopped by the next tick, since this process has no runtime). The CLI itself asks for no tick: `bin/idd.ts` does
 * after this returns. Undefined for another command.
 */
export async function runIgnoreCommand(command: string, args: string[], deps: LinearIntakeDeps = {}): Promise<CommandOutput | undefined> {
  if (command === "ignores") {
    const list = listIgnored();
    if (!list.length) return { code: 0, stdout: ["無視リストは空です"], stderr: [] };
    const lines = list.map((i) => `${i.ref} ${i.title}${i.area ? ` (${i.area})` : ""} — ${i.by === "ignore" && i.lane ? `${i.lane} を ignore して載った` : isLaneStop(i.by) && i.lane ? `${i.lane} の中止で載った` : "penne が載せた"}（${i.at}）`);
    return { code: 0, stdout: [...lines, `${list.length} 件`], stderr: [] };
  }
  if (command !== "ignore" && command !== "unignore") return undefined;
  const token = args.find((a) => !a.startsWith("--"));
  if (!token) return { code: 2, stdout: [], stderr: [USAGE] };
  const res = await ignoreByRef(command, token, deps);
  if (!res.ok) return { code: 1, stdout: [], stderr: [res.error] };
  const name = res.target ? `${res.target.ref} ${res.target.title}` : res.lane ?? token;
  if (command === "unignore") {
    if (!res.target) return { code: 1, stdout: [], stderr: [`${token} は無視リストにありません`] };
    // a Linear Issue stays Todo when its lane closes: intake takes it in again only once it changed on Linear after that
    const when = res.target.source === "linear"
      ? "次の取り込みで取り込みます。lane を閉じた（中止した）後の Linear の起票は、Linear で更新されるまで戻りません"
      : "次の取り込みで取り込みます";
    return { code: 0, stdout: [`${name} を無視リストから外しました（${when}）`], stderr: [] };
  }
  // a lane with no Issue has nothing to put on the list: the close is all this did
  if (!res.target) {
    return { code: 0, stdout: [`${name} を閉じました（起票が無いので、無視リストには載せていません）`], stderr: res.warning ? [res.warning] : [] };
  }
  const listed = res.changed
    ? `${name} を無視リストに載せました（次の取り込みから外れます。GitHub・Linear には何も書いていません）`
    : `${name} はすでに無視リストにあります`;
  return {
    code: 0,
    stdout: [res.lane ? `${res.lane} を閉じました` : null, listed].filter((l): l is string => l !== null),
    stderr: res.warning ? [res.warning] : [],
  };
}

/** what the CLI's ignore entry hands in: where the tick is asked for, and what an Issue is read with */
export type IgnoreCliDeps = LinearIntakeDeps & { tick?: () => TickKick };

/**
 * `idd ignore` / `idd unignore` / `idd ignores` as `bin/idd.ts` runs them: the command's own lines, and the tick a
 * write asks for. An ignore that closed a lane leaves work the tick does: the sessions and runs of that lane are
 * stopped by its pass (this process has no runtime), and its worktree is retired there; an unignore lets intake take
 * the Issue in on that pass. Reading the list records nothing, so it asks for no tick. The tick is best effort: the
 * write is already recorded, and the timer's own tick finds it.
 */
export async function runIgnoreCli(command: string, args: string[], deps: IgnoreCliDeps = {}): Promise<number | undefined> {
  const res = await runIgnoreCommand(command, args, deps);
  if (!res) return undefined;
  for (const line of res.stdout) process.stdout.write(`${line}\n`);
  for (const line of res.stderr) process.stderr.write(`${line}\n`);
  if (res.code !== 0 || command === "ignores") return res.code;
  try {
    const kick = (deps.tick ?? requestTick)();
    if (kick.outcome === "failed") process.stderr.write(`次の tick を頼めませんでした: ${kick.detail ?? ""}\n`);
  } catch (err) {
    process.stderr.write(`次の tick を頼めませんでした: ${String(err)}\n`);
  }
  return 0;
}
