import type { ConsumptionSummary, ForecastView, LaneDetailView, WorkDecisionsView, WorkRecordView } from "../engine/contract";
import type { WorkDetailSource, WorkSnapshot } from "./viewmodel";

export interface FetchResult {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

export type FetchLike = (path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<FetchResult>;
export type Listener = () => void;

export interface WorkStoreState {
  snapshot: WorkSnapshot | null;
  /** `/api/idd/forecast`: read beside the Work column, so the finish, the usual length and the anomaly can be drawn (C-130-1) */
  forecast: ForecastView | null;
  /** `/api/idd/work/consumption?since=…`: today's spend, read beside the Work column so the sidebar's 今日 draws the engine's number */
  consumption: ConsumptionSummary | null;
  /** "down" while the last Work read failed: the last picture stays and the band is shown (DEC-9191) */
  connection: "ok" | "down";
  attempt: number;
  detail: WorkDetailSource | null;
  /** the lane the detail belongs to */
  detailFor: string | null;
  now: number;
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const JST_OFFSET_MS = 9 * 3600 * 1000;

/** the JST day an instant falls on, the cut the consumption door filters its rows by */
export function jstDay(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** whether a row's detail and DECs are read: only an Issue lane has them (AC-030) */
export function needsDetail(kind: string): boolean {
  return kind === "issue";
}

/**
 * The id whose own views the screen reads for a selection, or null when it must not read further (AC-030).
 *
 * A live row carries its kind; a finished row does not, so the engine's own source ref decides: `pr` is someone
 * else's review lane, any other ref is a finished Issue lane. A finished lane is still an Issue lane, so its
 * detail, DECs and record are read the same way as a running one. A hold row and a review lane keep only what
 * the Work column returned.
 */
export function detailToRead(snapshot: WorkSnapshot | null, id: string | null | undefined): string | null {
  if (!snapshot || !id) return null;
  const lane = snapshot.lanes.find((l) => l.id === id);
  if (lane) return needsDetail(lane.kind) ? id : null;
  const done = snapshot.done.find((d) => d.id === id);
  if (!done) return null;
  return done.ref?.kind === "pr" ? null : id;
}

/** the row a selection names, as the Work column returned it: a live row or a closed one (a hold row has no detail) */
function rowOf(snapshot: WorkSnapshot | null, id: string): unknown {
  if (!snapshot) return undefined;
  return snapshot.lanes.find((l) => l.id === id) ?? snapshot.done.find((d) => d.id === id);
}

/**
 * The Work screen's reads. Only GETs: the screen looks and never sends a card's judgement (DEC-103-4, INV-103-4).
 * An answer that is not a success is never applied, so the last picture stays and the connection band shows. A
 * detail failure is kept beside the detail and does not turn the whole screen down.
 *
 * The forecast is read beside the Work column: it is the only door that returns the finish, the usual length and
 * the anomaly (C-130-1). While it cannot be read there is no value to draw, so the places stay empty (DEC-103-2).
 */
export class WorkStore {
  private listeners = new Set<Listener>();
  private seq = 0;
  private lastApplied = 0;
  private forecastSeq = 0;
  private consumptionSeq = 0;
  private detailSeq = 0;
  /** the engine's number for the Work picture: the doors are read when it moves and never on a clock */
  private workSeq: number | null = null;
  /** the selected row as it was when its detail was last read: a row that moved is read again (F-130-10) */
  private detailRow: string | null = null;

  state: WorkStoreState = { snapshot: null, forecast: null, consumption: null, connection: "ok", attempt: 0, detail: null, detailFor: null, now: 0 };

  constructor(private readonly fetchFn: FetchLike, private readonly clock: () => number = () => Date.now()) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private patch(next: Partial<WorkStoreState>): void {
    this.state = { ...this.state, ...next, now: this.clock() };
    this.emit();
  }

  /** the Work picture's number the screen last followed (a test reads it to see that a still picture reads nothing) */
  get pictureSeq(): number | null {
    return this.workSeq;
  }

  /**
   * The engine's number for the Work picture, from the stream. The Work column, the forecast and today's spend are
   * read when this number moves: the number moves only when the engine found the Work answer's own content changed,
   * so a screen that is looking at nothing new asks for nothing.
   */
  followPicture(workSeq: number): void {
    const n = Number(workSeq);
    if (!Number.isFinite(n) || n <= 0) return;
    if (this.workSeq !== null && n <= this.workSeq) return;
    this.workSeq = n;
    void this.read();
  }

  /** read the Work column, the forecast and today's consumption together; an older response never replaces a newer one */
  read(): Promise<void> {
    return Promise.all([this.readWork(), this.readForecast(), this.readConsumption()]).then(() => undefined);
  }

  private readWork(): Promise<void> {
    const mine = ++this.seq;
    return this.fetchFn("/api/idd/work")
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return this.fail(mine);
        let body: Record<string, unknown>;
        try {
          const parsed = await res.json();
          if (!parsed || typeof parsed !== "object") throw new Error("not an object");
          body = parsed as Record<string, unknown>;
        } catch {
          return this.fail(mine);
        }
        if (mine <= this.lastApplied) return;
        this.lastApplied = mine;
        this.patch({
          snapshot: {
            now: typeof body.now === "string" ? body.now : new Date(this.clock()).toISOString(),
            repos: list<WorkSnapshot["repos"][number]>(body.repos),
            lanes: list<WorkSnapshot["lanes"][number]>(body.lanes),
            done: list<WorkSnapshot["done"][number]>(body.done),
            holds: list<WorkSnapshot["holds"][number]>(body.holds),
          },
          connection: "ok",
          attempt: 0,
        });
      })
      .catch(() => this.fail(mine));
  }

  private readForecast(): Promise<void> {
    const mine = ++this.forecastSeq;
    return this.fetchFn("/api/idd/forecast")
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return this.clearForecast(mine);
        try {
          const parsed = await res.json();
          if (!parsed || typeof parsed !== "object") throw new Error("not an object");
          if (mine !== this.forecastSeq) return;
          this.patch({ forecast: parsed as ForecastView });
        } catch {
          this.clearForecast(mine);
        }
      })
      .catch(() => this.clearForecast(mine));
  }

  private clearForecast(mine: number): void {
    if (mine !== this.forecastSeq) return;
    if (this.state.forecast === null) return;
    this.patch({ forecast: null });
  }

  /**
   * Today's spend, the one value the sidebar's 今日 shows. The door is asked for the JST day's rows, so the number
   * is the engine's own total and the screen never sums anything (DEC-103-1). What cannot be read leaves the value
   * empty rather than making one up (DEC-103-2).
   */
  private readConsumption(): Promise<void> {
    const mine = ++this.consumptionSeq;
    const since = jstDay(this.clock());
    return this.fetchFn(`/api/idd/work/consumption?since=${since}`)
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return this.clearConsumption(mine);
        try {
          const parsed = await res.json();
          if (!parsed || typeof parsed !== "object") throw new Error("not an object");
          const summary = (parsed as { summary?: unknown }).summary;
          if (!summary || typeof summary !== "object") throw new Error("no summary");
          if (mine !== this.consumptionSeq) return;
          this.patch({ consumption: summary as ConsumptionSummary });
        } catch {
          this.clearConsumption(mine);
        }
      })
      .catch(() => this.clearConsumption(mine));
  }

  private clearConsumption(mine: number): void {
    if (mine !== this.consumptionSeq) return;
    if (this.state.consumption === null) return;
    this.patch({ consumption: null });
  }

  private fail(mine: number): void {
    if (mine <= this.lastApplied) return;
    this.patch({ connection: "down", attempt: this.state.attempt + 1 });
  }

  /**
   * Follow the Work screen's selection: read the selected row's own views when it has them, and let them go when it
   * does not. The read is made when the selection changes, when the selected row itself moved (the lane advanced, or
   * a value in the row was replaced), and when the last read of it failed — a detail that could not be read is read
   * again at the next change instead of waiting for the person to select the row anew (F-130-10, F-130-15,
   * F-130-26, F-130-32). A picture that keeps the row as it is reads nothing, so the tabs do not flicker.
   */
  followSelection(snapshot: WorkSnapshot | null, id: string | null): void {
    const target = detailToRead(snapshot, id);
    if (!target) {
      this.detailRow = null;
      if (this.state.detailFor !== null || this.state.detail !== null) this.clearDetail();
      return;
    }
    const row = rowOf(snapshot, target);
    const rowKey = row === undefined ? null : JSON.stringify(row);
    const failed = this.state.detail?.error !== null && this.state.detail?.error !== undefined;
    const same = this.state.detailFor === target && !failed && (rowKey === null || rowKey === this.detailRow);
    if (same) return;
    this.detailRow = rowKey;
    void this.readDetail(target);
  }

  /**
   * Read one lane's own views: its detail, the DEC tab and the record behind the findings tab. An Issue lane alone
   * has these; a hold row and a review lane keep only what the Work column returned and never ask (AC-030).
   */
  readDetail(id: string): Promise<void> {
    const mine = ++this.detailSeq;
    this.patch({ detailFor: id, detail: { lane: null, decisions: null, record: null, error: null } });
    const enc = encodeURIComponent(id);
    return Promise.all([
      this.get(`/api/idd/lane/${enc}`),
      this.get(`/api/idd/work/lanes/${enc}/decisions`),
      this.get(`/api/idd/work/lanes/${enc}/record`),
    ])
      .then(([lane, decisions, record]) => {
        if (mine !== this.detailSeq || this.state.detailFor !== id) return;
        const error = lane.error ?? decisions.error ?? record.error;
        this.patch({
          detail: {
            lane: (lane.body as LaneDetailView | null) ?? null,
            decisions: (decisions.body as WorkDecisionsView | null) ?? null,
            record: (record.body as WorkRecordView | null) ?? null,
            error,
          },
        });
      })
      .catch(() => {
        if (mine !== this.detailSeq || this.state.detailFor !== id) return;
        this.patch({ detail: { lane: null, decisions: null, record: null, error: "detail" } });
      });
  }

  clearDetail(): void {
    this.detailSeq += 1;
    this.detailRow = null;
    this.patch({ detail: null, detailFor: null });
  }

  private get(path: string): Promise<{ body: unknown; error: string | null }> {
    return this.fetchFn(path)
      .then(async (res) => {
        if (res.status < 200 || res.status >= 300) return { body: null, error: res.status === 404 ? "not-found" : String(res.status) };
        try {
          return { body: await res.json(), error: null };
        } catch {
          return { body: null, error: "not-json" };
        }
      })
      .catch(() => ({ body: null, error: "unreachable" }));
  }
}
