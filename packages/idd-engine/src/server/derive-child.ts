import { buildStateWithCosts } from "./state.ts";
import { buildWork } from "./work.ts";
import { recordingDerived } from "./derived.ts";
import { ensureAgentRunner } from "./agent-runner.ts";

/**
 * The derivation, run in this child so the engine's own event loop never waits for git or for a lane's worktree.
 * A whole derivation costs seconds (one `git` per ship lane, one per review lane's diff, one per closed lane's
 * DEC document, and the lanes' conversations for their spend), and running it in the engine's process stopped the
 * judgment door from answering at all (#172). Nothing here is shared with the engine: this process reads the same
 * state directory, and what it finds is handed back as plain values.
 *
 * The child stays up between derivations so the columns it has already parsed stay parsed; the engine asks for a
 * new derivation by writing a line to stdin. Only ever run as a child; imported by nothing.
 */

let busy = false;
let queued = false;
let stop = false;

function write(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function derive(): Promise<void> {
  const { deps, overlay } = recordingDerived();
  try {
    // the costs are read from the lanes' conversations through the same runner the engine installs
    await buildStateWithCosts({}, deps);
    buildWork({}, deps);
    write({ type: "derived", overlay });
  } catch (err) {
    write({ type: "derived-error", error: String(err).slice(0, 500) });
  }
}

function kick(): void {
  if (stop) return;
  if (busy) {
    queued = true;
    return;
  }
  busy = true;
  void derive().finally(() => {
    busy = false;
    if (queued) {
      queued = false;
      kick();
    }
  });
}

async function main(): Promise<void> {
  ensureAgentRunner();
  // the first derivation runs on its own: the engine starts answering as soon as this lands
  kick();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line.trim() === "refresh") kick();
  });
  // the engine going away takes this process with it: nothing here is worth keeping alive on its own
  process.stdin.on("end", () => {
    stop = true;
    process.exit(0);
  });
}

void main();
