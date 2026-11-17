import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * A pi child process in `--mode rpc`, spoken to over JSONL on stdin / stdout. The engine never loads pi's
 * SDK: this process boundary is what keeps the agent's runtime out of the engine's own process.
 *
 * Framing is LF only. `U+2028` / `U+2029` are valid inside JSON strings, so a reader that splits on them
 * (Node's `readline`, for one) would cut a record in two; the byte decoder below keeps multi-byte characters
 * whole across chunks and only the `\n` ends a record.
 */
export interface PiRpcRecord {
  type?: string;
  [key: string]: unknown;
}

export interface PiRpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface PiRpcOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** every stdout record that is not a command response */
  onEvent?: (record: PiRpcRecord) => void;
  /** called once, when the process is gone (a spawn failure counts) */
  onExit?: (exit: PiRpcExit) => void;
}

export interface RpcResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** one command's response, or a rejection when the process is gone or the command fails */
export class PiRpcCommandError extends Error {
  constructor(command: string, error: string) {
    super(`${command}: ${error}`);
    this.name = "PiRpcCommandError";
  }
}

/**
 * What a conversation's process layer needs of a child, whichever harness runs it. The pi child speaks pi's
 * `--mode rpc`; the Claude child translates the same command names onto Claude Code's stream-json input, so
 * `reduceConversation` and the mailbox stay one machine for both harnesses.
 */
export interface RpcChild {
  readonly isRunning: boolean;
  readonly pid: number | undefined;
  readonly stderrTail: string;
  start(): void;
  close(graceMs?: number): void;
  kill(signal?: NodeJS.Signals): void;
  waitForExit(): Promise<PiRpcExit>;
  command(type: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse>;
  call<T = unknown>(type: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  replyExtensionUi(id: string, body: Record<string, unknown>): void;
}

export class PiRpcProcess implements RpcChild {
  readonly bin: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, { command: string; resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
  private decoder = new TextDecoder("utf-8");
  private buffer = "";
  private seq = 0;
  private exited = false;
  private stderr = "";
  private lastExit: PiRpcExit | null = null;
  private exitWaiters: Array<(exit: PiRpcExit) => void> = [];

  constructor(private readonly opts: PiRpcOptions) {
    this.bin = opts.bin;
  }

  get pid(): number | undefined {
    return this.child?.pid ?? undefined;
  }

  get isRunning(): boolean {
    return this.child !== null && !this.exited;
  }

  /** start the child; throws only when spawn itself throws (a missing binary surfaces on `error`) */
  start(): void {
    if (this.child) return;
    const child = spawn(this.opts.bin, this.opts.args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    // stderr is diagnostics, never protocol data: keep the last lines for the failure event
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.on("error", (err) => this.finish({ code: null, signal: null, error: String(err) }));
    child.on("close", (code, signal) => this.finish({ code, signal }));
  }

  /** the last of what the child wrote to stderr, for a failure event */
  get stderrTail(): string {
    return this.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  }

  /** resolve once the process is gone; an already-gone process resolves at once */
  waitForExit(): Promise<PiRpcExit> {
    if (this.exited) return Promise.resolve(this.lastExit ?? { code: null, signal: null });
    return new Promise((resolve) => { this.exitWaiters.push(resolve); });
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) break;
      let line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let record: PiRpcRecord;
    try {
      record = JSON.parse(line) as PiRpcRecord;
    } catch {
      // pi prints a parse response for malformed input; stdout is protocol, so anything unreadable is a bug
      return;
    }
    if (record.type === "response" && typeof record.id === "string") {
      const entry = this.pending.get(record.id);
      if (entry) {
        this.pending.delete(record.id);
        entry.resolve({
          success: record.success === true,
          ...(record.data !== undefined ? { data: record.data } : {}),
          ...(typeof record.error === "string" ? { error: record.error } : {}),
        });
      }
      return;
    }
    this.opts.onEvent?.(record);
  }

  /** send one command and wait for its response (correlated by id, never by order) */
  command(type: string, fields: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<RpcResponse> {
    if (!this.child || this.exited) return Promise.reject(new PiRpcCommandError(type, "pi の process が動いていません"));
    this.seq += 1;
    const id = `c${this.seq}`;
    const payload = `${JSON.stringify({ id, type, ...fields })}\n`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcCommandError(type, "応答が待ち時間を超えました"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        command: type,
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.child?.stdin.write(payload, (err) => {
          if (!err) return;
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          entry.reject(new PiRpcCommandError(type, String(err)));
        });
      } catch (err) {
        this.pending.delete(id);
        reject(new PiRpcCommandError(type, String(err)));
      }
    });
  }

  /** a command that must succeed; a refusal is an error carrying pi's own message */
  async call<T = unknown>(type: string, fields: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    const res = await this.command(type, fields, timeoutMs);
    if (!res.success) {
      // set_model rejects an unknown id here; the caller keeps the item queued and reports this
      throw new PiRpcCommandError(type, res.error ?? "失敗しました");
    }
    return res.data as T;
  }

  /** answer an extension dialog immediately: the engine has no way to put a question to a person */
  replyExtensionUi(id: string, body: Record<string, unknown>): void {
    if (!this.child || this.exited) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...body })}\n`);
    } catch { /* the child is gone */ }
  }

  private finish(exit: PiRpcExit): void {
    if (this.exited) return;
    this.exited = true;
    this.lastExit = exit;
    for (const [, entry] of this.pending) entry.reject(new PiRpcCommandError(entry.command, "pi の process が終わりました"));
    this.pending.clear();
    this.child = null;
    for (const waiter of this.exitWaiters) waiter(exit);
    this.exitWaiters = [];
    this.opts.onExit?.(exit);
  }

  /** close stdin for an orderly shutdown, then signal if it does not go */
  close(graceMs = 2000): void {
    const child = this.child;
    if (!child || this.exited) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
    }, graceMs);
    timer.unref?.();
    child.once("close", () => clearTimeout(timer));
  }

  /** force the child down; used when the orderly close ran out of grace */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (!this.child || this.exited) return;
    try { this.child.kill(signal); } catch { /* gone */ }
  }
}
