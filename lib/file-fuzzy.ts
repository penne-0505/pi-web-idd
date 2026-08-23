// intent: DEC-204 — pi TUI の @ file autocomplete 挙動を chat input で鏡写しにする

export interface AtQueryMatch {
  start: number;
  query: string;
  quoted: boolean;
}

export interface FileIndexEntry {
  path: string;
  isDir: boolean;
}

// intent: DEC-205 — @ trigger を行頭 or whitespace 直後に限定し email 誤検出を避け、quoted form (@"...") で space 含みパスの drill-down を維持する
export function extractAtQuery(textBeforeCursor: string): AtQueryMatch | null {
  const quoted = /(?:^|\s)@"([^"\n]*)$/.exec(textBeforeCursor);
  if (quoted) {
    return {
      start: textBeforeCursor.length - (quoted[1].length + 2),
      query: quoted[1],
      quoted: true,
    };
  }
  const plain = /(?:^|\s)@([^\s"]*)$/.exec(textBeforeCursor);
  if (plain) {
    return {
      start: textBeforeCursor.length - (plain[1].length + 1),
      query: plain[1],
      quoted: false,
    };
  }
  return null;
}

function pathDepth(p: string): number {
  let depth = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "/") depth++;
  }
  return depth;
}

// intent: DEC-206 — index API が返す flat file list から directory entry を派生し、shallow-first alphabetical を empty @ query の既定順にする
export function buildEntriesFromFiles(files: string[]): FileIndexEntry[] {
  const dirs = new Set<string>();
  for (const f of files) {
    let idx = f.indexOf("/");
    while (idx !== -1) {
      dirs.add(f.slice(0, idx));
      idx = f.indexOf("/", idx + 1);
    }
  }
  const entries: FileIndexEntry[] = [];
  for (const d of dirs) entries.push({ path: d, isDir: true });
  for (const f of files) {
    if (!f) continue;
    entries.push({ path: f, isDir: false });
  }
  entries.sort((a, b) => pathDepth(a.path) - pathDepth(b.path) || a.path.localeCompare(b.path));
  return entries;
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

// intent: DEC-207 — TUI scoreEntry ladder (exact/prefix/substring/path-substring + dir bonus) に subsequence fallback を足し、"/" 入り query は relative path 全体で採点することで "@src/" 挿入後の drill-down を成立させる
function scoreEntry(entry: FileIndexEntry, lowerQuery: string): number {
  const lowerPath = entry.path.toLowerCase();
  let score = 0;
  if (lowerQuery.includes("/")) {
    if (lowerPath === lowerQuery) score = 100;
    else if (lowerPath.startsWith(lowerQuery)) score = 80;
    else if (lowerPath.includes(lowerQuery)) score = 50;
    else if (isSubsequence(lowerQuery, lowerPath)) score = 10;
  } else {
    const slash = lowerPath.lastIndexOf("/");
    const lowerName = slash === -1 ? lowerPath : lowerPath.slice(slash + 1);
    if (lowerName === lowerQuery) score = 100;
    else if (lowerName.startsWith(lowerQuery)) score = 80;
    else if (lowerName.includes(lowerQuery)) score = 50;
    else if (lowerPath.includes(lowerQuery)) score = 30;
    else if (isSubsequence(lowerQuery, lowerPath)) score = 10;
  }
  if (entry.isDir && score > 0) score += 10;
  return score;
}

export const AT_RESULT_LIMIT = 20;

export function filterFileEntries(
  entries: FileIndexEntry[],
  query: string,
  limit: number = AT_RESULT_LIMIT,
): FileIndexEntry[] {
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) return entries.slice(0, limit);

  const scored: Array<{ entry: FileIndexEntry; score: number }> = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, lowerQuery);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) =>
    b.score - a.score
    || pathDepth(a.entry.path) - pathDepth(b.entry.path)
    || a.entry.path.localeCompare(b.entry.path));
  return scored.slice(0, limit).map((s) => s.entry);
}

export interface AtInsertion {
  text: string;
  cursorOffset: number;
}

// intent: DEC-208 — 候補確定時の @token 挿入形は file/directory/quoted で切り替え、directory は menu を閉じずに drill-down を維持する
export function buildAtInsertText(entryPath: string, isDir: boolean, forceQuotes = false): AtInsertion {
  const p = isDir ? `${entryPath}/` : entryPath;
  const needsQuotes = forceQuotes || p.includes(" ");
  if (isDir) {
    const text = needsQuotes ? `@"${p}"` : `@${p}`;
    return { text, cursorOffset: needsQuotes ? text.length - 1 : text.length };
  }
  const text = needsQuotes ? `@"${p}" ` : `@${p} `;
  return { text, cursorOffset: text.length };
}

// intent: DEC-208 — one-shot mention は drill-down を伴わないため directory も trailing "/" 付きで closed 挿入
export function buildAtMentionText(entryPath: string, isDir: boolean): string {
  const p = isDir ? `${entryPath}/` : entryPath;
  return p.includes(" ") ? `@"${p}" ` : `@${p} `;
}

export function buildFileLineMentionText(entryPath: string, startLine: number, endLine: number): string {
  const firstLine = Math.max(1, Math.min(startLine, endLine));
  const lastLine = Math.max(1, Math.max(startLine, endLine));
  const pathMention = entryPath.includes(" ") ? `@"${entryPath}"` : `@${entryPath}`;
  const lineSuffix = firstLine === lastLine ? `:${firstLine}` : `:${firstLine}-${lastLine}`;
  return `${pathMention}${lineSuffix} `;
}

export function buildFileAtMentionsText(entryPaths: string[]): string {
  return entryPaths.map((entryPath) => buildAtMentionText(entryPath, false)).join("");
}
