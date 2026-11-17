/**
 * The find field's own store: what the person typed, the title stage's candidates and the full-text answer the
 * engine gave. It is separate from `ChatStore` because the field sits over every screen, while the conversation
 * store belongs to the conversation screen's list and open body.
 *
 * Two rules shape the reads. The title stage reads the list door with no mode and the archive included, so it
 * holds exactly the conversations the full-text search scans (C-173-2): the engine's own values, never a copy.
 * And the full-text search door reads every record synchronously and stops the engine while it does, so it is
 * called only when a person asks for the body stage — typing never calls it (C-173-1).
 */

import type { ConversationListResult, SearchResponse, SearchResult } from "../engine/contract";
import { WORDS } from "../strings";
import type { FetchLike, Listener } from "../chat/store";

/** one conversation the title stage may offer: the engine's own id, name and mode */
export interface SearchCandidate {
  id: string;
  name: string;
  mode: string;
}

/** the full-text answer, kept with the word it belongs to so an edited word never shows a stale answer */
export interface SearchBody {
  query: string;
  results: SearchResult[];
  truncated: boolean;
  scannedSessions: number;
}

export interface ChatSearchState {
  open: boolean;
  query: string;
  candidates: SearchCandidate[];
  /** the candidate read is in flight */
  candidatesBusy: boolean;
  /** the last candidate read failed: the last picture stays and the field can say so */
  candidatesDown: boolean;
  body: SearchBody | null;
  bodyBusy: boolean;
  /** why the search door refused, or that it could not be reached */
  bodyError: string | null;
  /** the row the arrows moved to, within the stage on screen */
  active: number;
}

export const EMPTY_SEARCH: ChatSearchState = {
  open: false,
  query: "",
  candidates: [],
  candidatesBusy: false,
  candidatesDown: false,
  body: null,
  bodyBusy: false,
  bodyError: null,
  active: 0,
};

/** the conversations whose name holds the typed word; an empty word lists every candidate in the engine's order */
export function titleRows(state: ChatSearchState): SearchCandidate[] {
  const needle = state.query.trim().toLowerCase();
  if (!needle) return state.candidates;
  return state.candidates.filter((candidate) => candidate.name.toLowerCase().includes(needle));
}

/** the full-text answer on screen belongs to the word in the box */
export function bodyShown(state: ChatSearchState): SearchBody | null {
  if (!state.body) return null;
  return state.body.query === state.query.trim() ? state.body : null;
}

/** the title stage found nothing and the body was not asked: the prototype A4's empty state */
export function notFound(state: ChatSearchState): boolean {
  return state.query.trim() !== "" && !bodyShown(state) && !state.bodyBusy && !state.candidatesDown && titleRows(state).length === 0;
}

/** the ids of the rows the arrows move through, in the stage on screen */
export function rowIds(state: ChatSearchState): string[] {
  const body = bodyShown(state);
  if (body) return body.results.map((result) => result.sessionId);
  return titleRows(state).map((candidate) => candidate.id);
}

/** the id of the row the arrows left the choice on */
export function activeIdOf(state: ChatSearchState): string | null {
  return rowIds(state)[state.active] ?? null;
}

function errorOf(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const message = (body as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return `${WORDS.chat.refused} (${status})`;
}

export class ChatSearch {
  state: ChatSearchState = { ...EMPTY_SEARCH };
  private listeners = new Set<Listener>();
  private candidateSeq = 0;
  private bodySeq = 0;
  private readonly fetchFn: FetchLike;

  constructor(fetchFn: FetchLike) {
    this.fetchFn = fetchFn;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private patch(next: Partial<ChatSearchState>): void {
    this.state = { ...this.state, ...next };
    this.emit();
  }

  /** open the field and read the title stage's candidates again, so a conversation made since the last open is there */
  open(): void {
    this.patch({ open: true, active: 0 });
    void this.readCandidates();
  }

  /** leave the field and forget the word and the answer: the next open starts fresh (the prototype's own state) */
  close(): void {
    this.patch({ open: false, query: "", body: null, bodyBusy: false, bodyError: null, active: 0 });
  }

  /** typing never calls the search door: the body answer and its refusal belong to the old word (C-173-1) */
  setQuery(text: string): void {
    this.patch({ query: text, active: 0, body: null, bodyBusy: false, bodyError: null });
  }

  /**
   * The title stage's candidates: the list door with no mode and the archive included, which is the same
   * conversation set the full-text search scans (C-173-2). A later read never replaces an older one's answer.
   */
  readCandidates(): Promise<void> {
    const mine = ++this.candidateSeq;
    this.patch({ candidatesBusy: true, candidatesDown: false });
    return this.fetchFn("/api/conversations?group=none&archive=include")
      .then(async (res) => {
        if (mine !== this.candidateSeq) return;
        if (res.status < 200 || res.status >= 300) {
          this.patch({ candidatesBusy: false, candidatesDown: true });
          return;
        }
        let body: ConversationListResult | null = null;
        try {
          const parsed = await res.json();
          if (!parsed || typeof parsed !== "object") throw new Error("not an object");
          body = parsed as ConversationListResult;
        } catch {
          if (mine === this.candidateSeq) this.patch({ candidatesBusy: false, candidatesDown: true });
          return;
        }
        if (mine !== this.candidateSeq) return;
        const conversations = Array.isArray(body.conversations) ? body.conversations : [];
        const candidates: SearchCandidate[] = [];
        for (const summary of conversations) {
          if (!summary || typeof summary.id !== "string") continue;
          // an unnamed conversation has no title to match: the full-text search reaches it by its name alone too
          if (typeof summary.name !== "string" || !summary.name) continue;
          candidates.push({ id: summary.id, name: summary.name, mode: typeof summary.mode === "string" ? summary.mode : "" });
        }
        this.patch({ candidates, candidatesBusy: false, candidatesDown: false });
      })
      .catch(() => {
        if (mine === this.candidateSeq) this.patch({ candidatesBusy: false, candidatesDown: true });
      });
  }

  /** the name the field holds for a conversation, so the screen it opens can show its title (C-173-4) */
  nameFor(id: string): string | null {
    for (const candidate of this.state.candidates) if (candidate.id === id) return candidate.name;
    // the body stage's rows are not in the title candidates: their own name rides in the answer
    const body = bodyShown(this.state);
    if (body) for (const result of body.results) if (result.sessionId === id && result.name) return result.name;
    return null;
  }

  /** ask the search door once for the typed word; the stage's own press is what calls this */
  searchBody(): Promise<void> {
    const query = this.state.query.trim();
    if (!query || this.state.bodyBusy) return Promise.resolve();
    const mine = ++this.bodySeq;
    this.patch({ bodyBusy: true, bodyError: null });
    return this.fetchFn(`/api/conversation-search?q=${encodeURIComponent(query)}`)
      .then(async (res) => {
        if (mine !== this.bodySeq) return;
        let body: (SearchResponse & { ok?: boolean; error?: string }) | null = null;
        try {
          const parsed = await res.json();
          if (parsed && typeof parsed === "object") body = parsed as SearchResponse & { ok?: boolean; error?: string };
        } catch {
          /* the refusal below is the same for a body that cannot be read */
        }
        if (mine !== this.bodySeq) return;
        if (res.status < 200 || res.status >= 300 || !body || body.ok === false) {
          this.patch({ bodyBusy: false, bodyError: errorOf(body, res.status) });
          return;
        }
        this.patch({
          bodyBusy: false,
          bodyError: null,
          active: 0,
          body: {
            query,
            results: Array.isArray(body.results) ? body.results : [],
            truncated: body.truncated === true,
            scannedSessions: typeof body.scannedSessions === "number" ? body.scannedSessions : 0,
          },
        });
      })
      .catch(() => {
        if (mine === this.bodySeq) this.patch({ bodyBusy: false, bodyError: WORDS.errors.unreachable });
      });
  }

  /** the ids of the rows the arrows move through, in the stage on screen */
  rowIds(): string[] {
    return rowIds(this.state);
  }

  /** move the chosen row by one, clamped to the rows on screen */
  moveActive(delta: number): void {
    const count = rowIds(this.state).length;
    if (!count) {
      if (this.state.active !== 0) this.patch({ active: 0 });
      return;
    }
    const next = Math.min(Math.max(this.state.active + delta, 0), count - 1);
    if (next !== this.state.active) this.patch({ active: next });
  }

  /** the id of the row the arrows left the choice on */
  activeId(): string | null {
    return activeIdOf(this.state);
  }
}
