/**
 * How the engine's state reaches a screen, measured against a fixed ledger outside CI (#180).
 *
 *     bun run packages/idd-engine/bench/state-stream.ts [--seconds 30] [--streams 3] [--lanes 200] [--events 24] [--json]
 *
 * The screen used to read the state door on an interval, and the number of requests grew with how many screens were
 * open and how long they stayed open (#172). The measurement here is of the other shape: the stream is opened the way
 * a screen opens it, the script then sits still, then writes a ledger row the way the idd CLI does, and the numbers
 * are (a) how many pictures arrived while nothing happened, (b) how long a written row took to reach the screens,
 * (c) how fast the state door still answers with the streams open, and (d) whether those streams are counted against
 * the engine's own replacement.
 *
 * The engine is started in this process on a loopback port against a fixture state the script writes and removes, so
 * nothing under the repo's state is touched. The checks in config/repos.yaml do not include this script: it is a
 * measurement a person runs, not a gate.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFixtureConfig, writeStateFixture } from "./fixture.ts";

function flag(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = Number(args[i + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** one stream as a screen reads it: the frames it received, and the number it last held */
interface Reader {
  stop: () => void;
  frames: { seq: number; workSeq: number; bytes: number; at: number }[];
  lastSeq: number;
}

/**
 * Open the state stream the way the screen does, and cut its body into frames. `lastEventId` is left out: a screen
 * that just opened carries no number, and the engine answers it with the whole picture anyway.
 */
async function openStream(origin: string, path = "/api/idd/events"): Promise<Reader> {
  const controller = new AbortController();
  const reader: Reader = { stop: () => controller.abort(), frames: [], lastSeq: 0 };
  void (async () => {
    try {
      const res = await fetch(`${origin}${path}`, { signal: controller.signal, headers: { accept: "text/event-stream" }, cache: "no-store" });
      if (!res.ok || !res.body) return;
      const stream = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await stream.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf("\n\n");
        while (at >= 0) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          at = buffer.indexOf("\n\n");
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue; // a comment line (`: ping`) keeps the connection alive and carries nothing
          try {
            const parsed = JSON.parse(data) as { seq?: number; workSeq?: number };
            reader.frames.push({ seq: Number(parsed.seq ?? 0), workSeq: Number(parsed.workSeq ?? 0), bytes: data.length, at: performance.now() });
            reader.lastSeq = Number(parsed.seq ?? reader.lastSeq);
          } catch {
            // a half-written frame is not a picture
          }
        }
      }
    } catch {
      // the script's own stop aborts the read
    }
  })();
  return reader;
}

/** wait until every stream has a frame numbered above `after`, and answer how long it took */
async function waitForChange(streams: Reader[], after: number[], limitMs = 10_000): Promise<number[] | null> {
  const started = performance.now();
  for (;;) {
    if (streams.every((stream, i) => stream.lastSeq > after[i])) {
      return streams.map((stream) => Math.round((stream.frames.find((frame) => frame.seq > 0)?.at ?? started) - started));
    }
    if (performance.now() - started > limitMs) return null;
    await sleep(20);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const seconds = flag(args, "seconds", 30);
  const streamsWanted = flag(args, "streams", 3);
  const lanes = flag(args, "lanes", 200);
  const eventsPerLane = flag(args, "events", 24);
  const dir = mkdtempSync(join(tmpdir(), "idd-state-stream-"));
  // the state is set before anything is written: the fixture's records are placed through the state's own paths
  process.env.IDD_STATE_DIR = dir;
  process.env.IDD_REPOS_FILE = join(dir, "repos.yaml");
  process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
  const summary = writeStateFixture(dir, { lanes, eventsPerLane });
  writeFixtureConfig(dir);
  delete process.env.PI_WEB_ALLOWED_HOSTS;
  const port = flag(args, "port", 30192);

  // imported after the state is set: the doors read the state when they answer, not when they are loaded
  const { startEngine } = await import("../src/server.ts");
  const { startDerivedService, stopDerivedService, derivedOverlay } = await import("../src/server/derived-service.ts");
  const { startStateEvents, stopStateEvents } = await import("../src/server/state-events.ts");
  const { requestCount } = await import("../src/server/reload.ts");
  let server: ReturnType<typeof startEngine> | undefined;
  const readers: Reader[] = [];
  try {
    server = startEngine({ port });
    const origin = `http://127.0.0.1:${server.port}`;
    // the watch starts from a landed derivation, as the engine's own entry starts it
    startDerivedService();
    startStateEvents();
    const deadline = Date.now() + 90_000;
    while (!derivedOverlay().at && Date.now() < deadline) await sleep(100);
    if (!derivedOverlay().at) {
      process.stderr.write("導き直しが届かず、状態の stream を測れません\n");
      return 1;
    }
    // let the first picture be built so the idle wait measures a screen that is already up
    await sleep(500);

    for (let i = 0; i < streamsWanted; i += 1) readers.push(await openStream(origin));
    await sleep(1_000);
    const firstPictures = readers.map((reader) => reader.frames.length);
    const before = readers.map((reader) => reader.lastSeq);

    // (a) nothing happens: how many pictures arrive on their own
    const idleFrom = readers.map((reader) => reader.frames.length);
    await sleep(seconds * 1_000);
    const idleFrames = readers.map((reader, i) => reader.frames.length - idleFrom[i]);

    // (b) another process writes a ledger row: how long it takes to reach the screens
    const beforeWrite = readers.map((reader) => reader.lastSeq);
    const ledger = join(dir, "lifecycle-Demo-one.jsonl");
    appendFileSync(ledger, `${JSON.stringify({ idd_id: "IDD-001", event: "s2_ready", at: new Date().toISOString(), attrs: { by: "bench" } })}\n`);
    const wrote = performance.now();
    const reached = await waitForChange(readers, beforeWrite);
    const writeToScreen = reached ? Math.round(performance.now() - wrote) : null;

    // (c) the state door with the streams open
    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      const res = await fetch(`${origin}/api/idd/state`, { headers: { "Cache-Control": "no-store" } });
      await res.text();
      times.push(performance.now() - started);
    }
    // (d) the streams are not counted against the engine's own replacement
    const counted = requestCount();

    const result = {
      streams: readers.length,
      fixture: { lanes: summary.lanes, events: summary.events },
      firstPictures,
      idleSeconds: seconds,
      idleFrames,
      writeToScreenMs: writeToScreen,
      stateDoorMs: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10,
      countedRequests: counted,
      frameBytes: readers.map((reader) => reader.frames.at(-1)?.bytes ?? 0),
      heldBefore: before,
    };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`状態の stream（lane ${result.fixture.lanes} 本・event ${result.fixture.events} 行の fixture、stream ${result.streams} 本）\n`);
      process.stdout.write(`開いた直後に届いた絵 ${firstPictures.join(" / ")} 枚、frame ${result.frameBytes.join(" / ")} バイト\n`);
      process.stdout.write(`${seconds} 秒何も起きない間に届いた絵 ${idleFrames.join(" / ")} 枚（1 分に 1 枚までは、lane の経過の表記が変わる分）\n`);
      process.stdout.write(`別の process が台帳に 1 行書いてから画面に届くまで ${writeToScreen === null ? "届きませんでした" : `${writeToScreen} ms`}\n`);
      process.stdout.write(`stream を ${result.streams} 本開いたままの状態の口 ${result.stateDoorMs} ms、数えている要求 ${counted} 件\n`);
    }
    return writeToScreen === null ? 1 : 0;
  } finally {
    for (const reader of readers) reader.stop();
    stopStateEvents();
    stopDerivedService();
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`測れませんでした: ${String(err)}\n`);
    process.exitCode = 1;
  });
}
