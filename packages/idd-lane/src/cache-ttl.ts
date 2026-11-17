import { DEFAULT_CONVERSATION_CACHE_TTL, DEFAULT_RUN_CACHE_TTL, type CacheTtl } from "./roles.ts";
import { repoForPath } from "./repos.ts";

/**
 * The prompt cache hold of a run: the role's own first, then the repo the worktree belongs to (config/repos.yaml),
 * then the run kind's default. A conversation waits for a person and keeps its cache an hour; every other run pays
 * no premium and holds it five minutes. The same order as the tool call limit. This is the one place the order is
 * written, so a caller that only builds a brief (idd-core, spec.ts) takes the answer from here rather than copying it.
 */
export function resolveCacheTtl(role: Pick<{ cacheTtl?: CacheTtl }, "cacheTtl"> | undefined, worktree: string | undefined, conversation = false): CacheTtl {
  if (role?.cacheTtl !== undefined) return role.cacheTtl;
  if (worktree) {
    try {
      const repo = repoForPath(worktree);
      if (repo?.cacheTtl !== undefined) return repo.cacheTtl;
    } catch { /* no registry: the run kind's default */ }
  }
  return conversation ? DEFAULT_CONVERSATION_CACHE_TTL : DEFAULT_RUN_CACHE_TTL;
}
