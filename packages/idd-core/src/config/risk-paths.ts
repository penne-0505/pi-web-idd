/**
 * The six kinds of harm a lane's Risk High is about (workflow.md `Risk 分類`): who a request is from, whether the
 * request is allowed, money, the reach of a process or token, changes that cannot be undone, and secrets.
 * The key is fixed: the repo's declaration, the planner's table and the GO card all read it in this order.
 */
export const RISK_KEYS = ["auth", "authz", "billing", "permission", "data_loss", "secret"] as const;

export type RiskKey = (typeof RISK_KEYS)[number];

/** the display name of each kind, in the declaration's order */
export const RISK_LABELS: Record<RiskKey, string> = {
  auth: "認証",
  authz: "認可",
  billing: "課金",
  permission: "権限",
  data_loss: "データ損失",
  secret: "secret の扱い",
};

/** a repo's declaration: kind -> path prefixes, repo-root relative; a kind with no path is not a key */
export type RiskPaths = Partial<Record<RiskKey, string[]>>;

const isRiskKey = (key: string): key is RiskKey => (RISK_KEYS as readonly string[]).includes(key);

/**
 * config/repos.yaml's `risk_paths`: the repo's own dangerous paths, by kind. An unknown kind and a value that is
 * not a list of non-empty strings are config errors (a misspelt kind would otherwise silently declare nothing).
 * An empty declaration and a missing field both come back as undefined, which is "no declaration".
 */
export function parseRiskPaths(where: string, raw: unknown): RiskPaths | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: 種類ごとのパスの一覧で書いてください`);
  const out: RiskPaths = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRiskKey(key)) throw new Error(`${where}.${key}: 未知の種類です（使える種類: ${RISK_KEYS.join(", ")}）`);
    if (!Array.isArray(value) || value.some((p) => typeof p !== "string" || !p.trim())) {
      throw new Error(`${where}.${key}: パスの一覧（空でない文字列）で書いてください`);
    }
    const paths = (value as string[]).map((p) => p.trim()).filter(Boolean);
    if (paths.length) out[key] = paths;
  }
  return Object.keys(out).length ? out : undefined;
}

/** whether any path in the declaration is a prefix of the given repo-relative path (forward match, no separators) */
export function riskPathsMatching(declared: RiskPaths | undefined, path: string): RiskKey[] {
  if (!declared) return [];
  const p = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return RISK_KEYS.filter((key) => (declared[key] ?? []).some((prefix) => prefix && p.startsWith(prefix)));
}
