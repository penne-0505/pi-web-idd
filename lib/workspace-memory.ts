// intent: DEC-217 — workspace 切替後に「その場所で最後に開いた session」に戻れるよう localStorage で覚える (best-effort、失敗しても機能は落とさない)

const STORAGE_KEY = "pi-web:last-open-by-workspace";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readMap(storage: StorageLike): Record<string, string | undefined> {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, string | undefined>
      : {};
  } catch {
    return {};
  }
}

export function getLastOpenSession(
  workspaceKey: string,
  storage: StorageLike | null = getBrowserStorage(),
): string | null {
  if (!storage) return null;
  try {
    const id = readMap(storage)[workspaceKey];
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function setLastOpenSession(
  workspaceKey: string,
  sessionId: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const map = readMap(storage);
    map[workspaceKey] = sessionId;
    storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // intent: DEC-217 — storage 失敗は best-effort 方針で無視
  }
}

export function clearLastOpen(
  workspaceKey: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const map = readMap(storage);
    if (!(workspaceKey in map)) return;
    delete map[workspaceKey];
    // intent: DEC-219 — 覚える対象がゼロなら key ごと消して localStorage をクリーンに保つ
    if (Object.keys(map).length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // intent: DEC-217 — storage 失敗は best-effort 方針で無視
  }
}

// intent: DEC-218 — workspace identity は projectKey → projectRoot → cwd の順で決め、Windows path 差異や同一 repo の worktree 群を 1 slot にまとめる
export function workspaceKeyOf(session: {
  cwd: string;
  projectRoot?: string | null;
  projectKey?: string | null;
}): string {
  return session.projectKey ?? session.projectRoot ?? session.cwd;
}
