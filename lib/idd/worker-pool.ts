// intent: DEC-007 — role-aware pi session registry。pi-web の rpc-manager (AgentSessionWrapper) の上に薄く載る addon layer、実 session 起動/prompt 送信は既存 API に委譲する

export type WorkerRole = "planner" | "executor";
export type WorkerStatus = "idle" | "busy" | "starting" | "error";

export interface WorkerTaskRef {
  linearIssueId: string;
  startedAt: string;
}

export interface WorkerDescriptor {
  id: string;
  role: WorkerRole;
  status: WorkerStatus;
  model: string;
  currentTask?: WorkerTaskRef;
  updatedAt: string;
}

export class WorkerPool {
  private readonly workers = new Map<string, WorkerDescriptor>();

  register(w: WorkerDescriptor): void {
    this.workers.set(w.id, { ...w });
  }

  unregister(id: string): void {
    this.workers.delete(id);
  }

  get(id: string): WorkerDescriptor | undefined {
    const w = this.workers.get(id);
    return w ? { ...w } : undefined;
  }

  update(id: string, patch: Partial<Omit<WorkerDescriptor, "id">>): WorkerDescriptor | undefined {
    const cur = this.workers.get(id);
    if (!cur) return undefined;
    const next: WorkerDescriptor = {
      ...cur,
      ...patch,
      id: cur.id,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.workers.set(id, next);
    return { ...next };
  }

  list(): WorkerDescriptor[] {
    return Array.from(this.workers.values()).map((w) => ({ ...w }));
  }

  listByRole(role: WorkerRole): WorkerDescriptor[] {
    return this.list().filter((w) => w.role === role);
  }

  // intent: DEC-007 — 空き worker の picker は最小実装 (idle かつ role match の最初の 1 件)。task queue や priority 判定は callee 側で必要になったら足す
  pickIdle(role: WorkerRole): WorkerDescriptor | undefined {
    for (const w of this.workers.values()) {
      if (w.role === role && w.status === "idle") return { ...w };
    }
    return undefined;
  }

  clear(): void {
    this.workers.clear();
  }
}

declare global {
  // intent: DEC-007 — globalThis 経由で Next.js hot-reload を跨ぐ (pi-web の __piSessions と同型)
  // eslint-disable-next-line no-var
  var __iddWorkerPool: WorkerPool | undefined;
}

export function getWorkerPool(): WorkerPool {
  if (!globalThis.__iddWorkerPool) {
    globalThis.__iddWorkerPool = new WorkerPool();
  }
  return globalThis.__iddWorkerPool;
}
