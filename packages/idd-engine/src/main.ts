import { setStaleHoldProvider } from "@idd/core";
import { repoRoot } from "@idd/lane";
import { ensureIddOnPath } from "./idd-path.ts";
import { ensureAgentRunner } from "./server/agent-runner.ts";
import { captureSttKey } from "./server/transcriptions.ts";
import { startEngine, engineStartupLines } from "./server.ts";
import { startEphemeralSweeper } from "./server/conversations.ts";
import { pickUpLeftTick } from "./server/tick-kick.ts";
import { intakeHold, startReloadWatcher } from "./server/reload.ts";
import { refreshAndRequestGuiBuild } from "./server/gui-build.ts";
import { onWatchTick, rememberEngineStart, startCodeWatch } from "./server/staleness.ts";
import { reconcileConsults } from "./server/consult.ts";
import { startDerivedService } from "./server/derived-service.ts";
import { startStateEvents } from "./server/state-events.ts";

// the engine's own process is the one that writes under the state: the idd CLI for the agents it starts,
// and the agent runner that opens a conversation lane outside this process
ensureIddOnPath({ root: repoRoot() });
ensureAgentRunner();
// take the speech-to-text key out of the environment before any child (an agent, a lane) can inherit it
captureSttKey();

// the stages hold their intake and their planner starts while a replacement of this process is on its way: the
// engine owns that judgment, so it is put in before the process serves anything
setStaleHoldProvider(() => intakeHold());

const server = startEngine();
// old branches are swept from the engine's start, never as a side effect of importing a module. The consult
// reconciler rides the same pass, so a batch answered while the engine was down is closed on the first sweep
startEphemeralSweeper(() => reconcileConsults());
// remember the checkout this process loaded, then watch it: the state door answers whether the engine is behind it
rememberEngineStart({ root: repoRoot() });
// the screen's build is watched on the same tick: ask the running screen its commit and rebuild when it is behind
onWatchTick(() => { void refreshAndRequestGuiBuild(); });
startCodeWatch({ root: repoRoot() });
// the state and Work doors answer from what the last derivation found; the derivation itself (one `git` per ship
// lane, one per review lane's diff, the closed lanes' documents, the lanes' spend) runs in its own process and is
// asked for again when the ledger moves and every 30 seconds even when it does not
startDerivedService();
// the screens hear the state and Work pictures from here: the columns, the derivation above and the clock are looked
// at every second, and a change is handed to every open screen instead of being asked for by each of them
startStateEvents();
// replace this process with the checkout's code once it is quiet enough, and only when the unit started this
// process (its main process, or that process's direct child)
startReloadWatcher();
// a tick request left in the state while the engine was down: book one now, not up to 15 minutes from now
pickUpLeftTick();
for (const line of engineStartupLines(server)) process.stdout.write(`${line}\n`);
